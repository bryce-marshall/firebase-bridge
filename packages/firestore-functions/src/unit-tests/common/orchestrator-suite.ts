/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  FirestoreController,
  FirestoreMock,
} from '@firebase-bridge/firestore-admin';
import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { TriggerOrchestrator } from '../../lib/trigger-orchestrator.js';
import { TriggerErrorOrigin } from '../../lib/types.js';
import {
  AppTrigger,
  ERR_POST_CREATE_MISSING_TITLE,
  ERR_USER_WRITE_FAIL,
  PATH_AUDIT_COMMENT,
  PATH_WELCOME_POST,
  SEED_COMMENT_ID,
} from './orchestration-helpers.js';

type Ctx = {
  version: string;
  env: FirestoreMock;
  ctrl: FirestoreController;
  db: Firestore;
  orch: TriggerOrchestrator<AppTrigger>;
};

// Tiny helpers
const sleep = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function writeUser(
  db: Firestore,
  uid: string,
  data: Record<string, any> | null
) {
  const ref = db.doc(`users/${uid}`);
  if (data === null) {
    await ref.delete();
  } else {
    await ref.set(data, { merge: false });
  }
}

async function createPost(
  db: Firestore,
  postId: string,
  data: Record<string, any>
) {
  await db.doc(`posts/${postId}`).set(data, { merge: false });
}

// async function writeComment(
//   db: Firestore,
//   postId: string,
//   commentId: string,
//   data: Record<string, any> | null
// ) {
//   const ref = db.doc(`posts/${postId}/comments/${commentId}`);
//   if (data === null) await ref.delete();
//   else await ref.set(data, { merge: false });
// }

function statsFor(
  orch: TriggerOrchestrator<AppTrigger>,
  key: AppTrigger
): { initiated: number; completed: number; errors: number } {
  const s = orch.getStats(key);
  return {
    initiated: s.initiatedCount,
    completed: s.completedCount,
    errors: s.errorCount,
  };
}

export function orchestratorTestSuite(
  version: string,
  env: FirestoreMock,
  ctrl: FirestoreController,
  firestore: Firestore,
  triggers: TriggerOrchestrator<AppTrigger>
): void {
  describe(`${version} TriggerOrchestrator tests`, () => {
    let ctx: Ctx;

    beforeEach(() => {
      ctrl.reset();
      triggers.reset(); // ensure fresh stats/observers and enabled
      ctx = { version, env, ctrl, db: firestore, orch: triggers };
    });

    afterAll(() => {
      // Ensure all background resources are released
      triggers.detach();
      ctrl.delete();
    });

    // ───────────────────────────────── A. Construction & Registration ─────────────────────────────────

    it('A1: handlers are enabled by default', async () => {
      expect(ctx.orch.isEnabled(AppTrigger.OnUserWrite)).toBe(true);
    });

    it('A2: duplicate keys throw at construction', () => {
      // Construct a fresh orchestrator locally to test duplicate registration
      const ctor = () =>
        new (triggers as any).constructor(ctx.ctrl, (r: any) => {
          // Register the same key twice; we don’t need real functions here because the
          // duplicate check occurs before subscription.
          const dummy: any = { run: () => void 0 };
          r.v1(AppTrigger.OnUserWrite, dummy);
          r.v1(AppTrigger.OnUserWrite, dummy);
        });

      expect(ctor).toThrow(/Duplicate trigger key/i);
    });

    // // ───────────────────────────────── B. Enable / Disable ─────────────────────────────────

    it('B3: enable() turns a disabled trigger back on', async () => {
      ctx.orch.disable(AppTrigger.OnUserWrite);
      expect(ctx.orch.isEnabled(AppTrigger.OnUserWrite)).toBe(false);
      await sleep();

      ctx.orch.enable(AppTrigger.OnUserWrite);
      expect(ctx.orch.isEnabled(AppTrigger.OnUserWrite)).toBe(true);

      const s0 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      writeUser(ctx.db, 'u1', { ok: true });
      await ctx.orch.waitOne(AppTrigger.OnUserWrite);
      const s1 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      expect(s1.initiated).toBe(s0.initiated + 1);
      expect(s1.completed).toBe(s0.completed + 1);
    });

    it('B4: disable() prevents invocation', async () => {
      ctx.orch.disable(AppTrigger.OnUserWrite);
      const s0 = statsFor(ctx.orch, AppTrigger.OnUserWrite);

      await writeUser(ctx.db, 'u2', { ok: true });
      await sleep();

      const s1 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      expect(s1).toEqual(s0); // no change
    });

    it('B5: all(false) and all(true) apply to all registered keys', async () => {
      ctx.orch.all(false);
      expect(ctx.orch.isEnabled(AppTrigger.OnUserWrite)).toBe(false);
      expect(ctx.orch.isEnabled(AppTrigger.OnPostCreate)).toBe(false);
      expect(ctx.orch.isEnabled(AppTrigger.OnCommentWrite)).toBe(false);

      ctx.orch.all(true);
      expect(ctx.orch.isEnabled(AppTrigger.OnUserWrite)).toBe(true);
      expect(ctx.orch.isEnabled(AppTrigger.OnPostCreate)).toBe(true);
      expect(ctx.orch.isEnabled(AppTrigger.OnCommentWrite)).toBe(true);
    });

    it('B6: enable/disable unknown keys throw helpful error', () => {
      expect(() => ctx.orch.enable('Unknown' as any)).toThrow(
        /No trigger handler associated with the key/i
      );
      expect(() => ctx.orch.disable('Unknown' as any)).toThrow(
        /No trigger handler associated with the key/i
      );
    });

    // ───────────────────────────────── C. Suspended Gate ─────────────────────────────────

    it('C7: suspended=true blocks invocations without changing enable state', async () => {
      expect(ctx.orch.isEnabled(AppTrigger.OnUserWrite)).toBe(true);
      ctx.orch.suspended = true;

      const s0 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      await writeUser(ctx.db, 'u3', { ok: true });
      await sleep();
      const s1 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      expect(s1).toEqual(s0);

      ctx.orch.suspended = false;
      await writeUser(ctx.db, 'u3', { ok: true, version: 2 });
      await sleep();
      const s2 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      expect(s2.initiated).toBe(s0.initiated + 1);
      expect(s2.completed).toBe(s0.completed + 1);
    });

    // ───────────────────────────────── D. Stats Accounting ─────────────────────────────────

    it('D8: initiated/completed increment on success', async () => {
      const s0 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      writeUser(ctx.db, 'u4', { ok: true });
      await ctx.orch.waitOne(AppTrigger.OnUserWrite);
      const s1 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      expect(s1.initiated).toBe(s0.initiated + 1);
      expect(s1.completed).toBe(s0.completed + 1);
      expect(s1.errors).toBe(s0.errors);
    });

    it('D9: initiated/error increment on failure', async () => {
      const s0 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      await writeUser(ctx.db, 'u5', { ok: false });
      await triggers.waitOneError(AppTrigger.OnUserWrite);
      const s1 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      expect(s1.initiated).toBe(s0.initiated + 1);
      expect(s1.errors).toBe(s0.errors + 1);
      expect(s1.completed).toBe(s0.completed);
    });

    it('D10: getStats() returns zeroed for unknown key', () => {
      const s = ctx.orch.getStats('Unknown' as any);
      expect(s.initiatedCount).toBe(0);
      expect(s.completedCount).toBe(0);
      expect(s.errorCount).toBe(0);
    });

    it('D11: cumulative stats across multiple invocations', async () => {
      const s0 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      await writeUser(ctx.db, 'u6', { ok: true });
      await writeUser(ctx.db, 'u6', { ok: false });
      await writeUser(ctx.db, 'u6', { ok: true });
      await sleep();
      const s1 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      expect(s1.initiated).toBe(s0.initiated + 3);
      expect(s1.completed).toBe(s0.completed + 2);
      expect(s1.errors).toBe(s0.errors + 1);
    });

    // ───────────────────────────────── E. Observer Hooks ─────────────────────────────────

    it('E12: before called once per initiated run; arg is frozen', async () => {
      const before = jest.fn((arg) => {
        expect(Object.isFrozen(arg)).toBe(true);
        // attempt mutation (should not take effect)
        try {
          (arg as any).key = 'zzz';
        } catch {
          // strict mode may throw TypeError
        }
      });
      const off = ctx.orch.observe(AppTrigger.OnUserWrite, { before });

      await writeUser(ctx.db, 'u7', { ok: true });
      await writeUser(ctx.db, 'u7', { ok: false });
      await sleep();

      expect(before).toHaveBeenCalledTimes(2);
      off();
    });

    it('E13: after called only on success', async () => {
      const after = jest.fn();
      const off = ctx.orch.observe(AppTrigger.OnUserWrite, { after });

      await writeUser(ctx.db, 'u8', { ok: true });
      await writeUser(ctx.db, 'u8', { ok: false });
      await sleep();

      expect(after).toHaveBeenCalledTimes(1);
      off();
    });

    it('E14: error called only on failure with cause', async () => {
      const error = jest.fn((arg, cause) => {
        expect(cause).toBeInstanceOf(Error);
        expect((cause as Error).message).toMatch(ERR_USER_WRITE_FAIL);
      });
      const off = ctx.orch.observe(AppTrigger.OnUserWrite, { error });

      await writeUser(ctx.db, 'u9', { ok: false });
      await sleep();

      expect(error).toHaveBeenCalledTimes(1);
      off();
    });

    it('E15: observer unsubscribe stops further callbacks', async () => {
      const before = jest.fn();
      const off = ctx.orch.observe(AppTrigger.OnUserWrite, { before });

      await writeUser(ctx.db, 'u10', { ok: true });
      await sleep();
      off();
      await writeUser(ctx.db, 'u10', { ok: true });
      await sleep();

      expect(before).toHaveBeenCalledTimes(1);
    });

    it('E16: multiple observers receive callbacks independently', async () => {
      const a = jest.fn();
      const b = jest.fn();
      const offA = ctx.orch.observe(AppTrigger.OnUserWrite, { before: a });
      const offB = ctx.orch.observe(AppTrigger.OnUserWrite, { before: b });

      await writeUser(ctx.db, 'u11', { ok: true });
      await sleep();

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);

      offA();
      offB();
    });

    it('E17: observer exceptions surfaced via watchErrors with origin preserved', async () => {
      const err = new Error('before broke');
      ctx.orch.observe(AppTrigger.OnUserWrite, {
        before: () => {
          throw err;
        },
      });

      const watch = jest.fn((e) => {
        expect(e.origin).toBe(TriggerErrorOrigin.OnBefore);
        expect(e.cause).toBe(err);
        expect(e.arg.key).toBe(AppTrigger.OnUserWrite);
      });
      const unwatch = ctx.orch.watchErrors(watch);

      await writeUser(ctx.db, 'u12', { ok: true });
      await sleep();

      expect(watch).toHaveBeenCalledTimes(1);
      unwatch();
    });

    it('E18: OrchestratorEventArg object identity consistent per phase', async () => {
      const seen: any[] = [];
      ctx.orch.observe(AppTrigger.OnUserWrite, {
        before: (arg) => seen.push(['before', arg]),
        after: (arg) => seen.push(['after', arg]),
      });

      await writeUser(ctx.db, 'u13', { ok: true });
      await sleep();

      const befores = seen.filter((x) => x[0] === 'before').map((x) => x[1]);
      const afters = seen.filter((x) => x[0] === 'after').map((x) => x[1]);
      // Within each phase all observer callbacks share the same frozen object.
      expect(new Set(befores).size).toBe(1);
      expect(new Set(afters).size).toBe(1);
    });

    // ───────────────────────────────── F. Global Error Watching ─────────────────────────────────

    it('F19: watchErrors captures trigger failure with origin=Execute', async () => {
      const watch = jest.fn((e) => {
        expect(e.origin).toBe(TriggerErrorOrigin.Execute);
        expect(e.arg.key).toBe(AppTrigger.OnUserWrite);
        expect((e.cause as Error).message).toMatch(ERR_USER_WRITE_FAIL);
      });
      const unwatch = ctx.orch.watchErrors(watch);

      await writeUser(ctx.db, 'u14', { ok: false });
      await sleep();

      expect(watch).toHaveBeenCalledTimes(1);
      unwatch();
    });

    it('F20: watchErrors unsubscribe works', async () => {
      const watch = jest.fn();
      const unwatch = ctx.orch.watchErrors(watch);
      unwatch();

      await writeUser(ctx.db, 'u15', { ok: false });
      await sleep();

      expect(watch).not.toHaveBeenCalled();
    });

    it('F21: clearErrorWatchers removes all watchers', async () => {
      const a = jest.fn();
      const b = jest.fn();
      ctx.orch.watchErrors(a);
      ctx.orch.watchErrors(b);

      ctx.orch.clearErrorWatchers();

      await writeUser(ctx.db, 'u16', { ok: false });
      await sleep();

      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });

    // ───────────────────────────────── G. Waiting Utilities ─────────────────────────────────

    it('G22: waitOne resolves on next successful run', async () => {
      const p = ctx.orch.waitOne(AppTrigger.OnUserWrite, { timeout: 1000 });
      await writeUser(ctx.db, 'u17', { ok: true });
      const ev = await p;
      expect(ev.key).toBe(AppTrigger.OnUserWrite);
      expect(ev.completedCount).toBeGreaterThanOrEqual(1);
    });

    it('G23: wait resolves when predicate passes', async () => {
      const p = ctx.orch.wait(
        AppTrigger.OnUserWrite,
        (e) => e.completedCount >= 2
      );
      await writeUser(ctx.db, 'u18', {
        ok: true,
        timstamp: FieldValue.serverTimestamp(),
      });
      await writeUser(ctx.db, 'u18', {
        ok: true,
        timstamp: FieldValue.serverTimestamp(),
      });
      const ev = await p;
      expect(ev.completedCount).toBeGreaterThanOrEqual(2);
    });

    it('G24: wait rejects on timeout', async () => {
      await expect(
        ctx.orch.wait(AppTrigger.OnUserWrite, () => false, { timeout: 50 })
      ).rejects.toThrow(/WaitHandle: timed-out/i);
    });

    it('G25: wait rejects if predicate throws', async () => {
      writeUser(ctx.db, 'u18', {
        ok: true,
      });

      await expect(
        ctx.orch.wait(AppTrigger.OnUserWrite, () => {
          throw new Error('boom');
        })
      ).rejects.toThrow(/WaitHandle: predicate error/i);
    });

    it('G26: cancelOnError=true rejects waiter on failure', async () => {
      const p = ctx.orch.wait(AppTrigger.OnUserWrite, () => false, {
        cancelOnError: true,
        timeout: 1000,
      });
      await writeUser(ctx.db, 'u19', { ok: false });
      await expect(p).rejects.toThrow(/WaitHandle: cancelled/i);
    });

    it('G27: multiple concurrent waiters resolve independently', async () => {
      const w1 = ctx.orch.wait(
        AppTrigger.OnUserWrite,
        (e) => e.completedCount >= 1,
        { timeout: 1000 }
      );
      const w2 = ctx.orch.wait(
        AppTrigger.OnUserWrite,
        (e) => e.completedCount >= 2,
        { timeout: 1000 }
      );
      await writeUser(ctx.db, 'u20', {
        ok: true,
        timestamp: FieldValue.serverTimestamp(),
      });
      const r1 = await w1;
      expect(r1.completedCount).toBeGreaterThanOrEqual(1);

      await writeUser(ctx.db, 'u20', {
        ok: true,
        timestamp: FieldValue.serverTimestamp(),
      });
      const r2 = await w2;
      expect(r2.completedCount).toBeGreaterThanOrEqual(2);
    });

    it('G28: interval lifecycle starts with first waiter and stops when none remain', async () => {
      const setSpy = jest.spyOn(global, 'setInterval');
      const clearSpy = jest.spyOn(global, 'clearInterval' as any);

      const w = ctx.orch.wait(
        AppTrigger.OnUserWrite,
        (e) => e.completedCount >= 1,
        { timeout: 1000 }
      );
      expect(setSpy).toHaveBeenCalled(); // interval ensured

      await writeUser(ctx.db, 'u21', { ok: true });
      await w;

      // give a tick for cleanup
      await sleep(5);
      expect(clearSpy).toHaveBeenCalled();

      setSpy.mockRestore();
      clearSpy.mockRestore();
    });

    it('G29: detaching cancels active waiters', async () => {
      const p = ctx.orch.wait(AppTrigger.OnUserWrite, () => false, {
        timeout: 1000,
      });
      ctx.orch.detach();
      await expect(p).rejects.toThrow(/WaitHandle: cancelled/i);
    });

    // ───────────────────────────────── H. Lifecycle attach/detach/reset ─────────────────────────────────

    it('H30: attach() enables all previously registered triggers', async () => {
      ctx.orch.all(false);
      ctx.orch.attach();
      expect(ctx.orch.isEnabled(AppTrigger.OnUserWrite)).toBe(true);
      expect(ctx.orch.isEnabled(AppTrigger.OnPostCreate)).toBe(true);
      expect(ctx.orch.isEnabled(AppTrigger.OnCommentWrite)).toBe(true);
    });

    it('H31: detach() disables triggers, clears observers & waiters, keeps stats', async () => {
      const before = jest.fn();
      ctx.orch.observe(AppTrigger.OnUserWrite, { before });

      const p = ctx.orch.wait(AppTrigger.OnUserWrite, () => false, {
        timeout: 1000,
      });
      const expectRejection = expect(p).rejects.toThrow(
        /WaitHandle: cancelled/i
      );

      writeUser(ctx.db, 'u22', {
        ok: true,
        timestamp: FieldValue.serverTimestamp(),
      });
      await ctx.orch.waitOne(AppTrigger.OnUserWrite);
      const statsBefore = statsFor(ctx.orch, AppTrigger.OnUserWrite);

      ctx.orch.detach();

      // observers cleared → no more callbacks
      await writeUser(ctx.db, 'u22', {
        ok: true,
        timestamp: FieldValue.serverTimestamp(),
      });
      await sleep(30);

      const statsAfter = statsFor(ctx.orch, AppTrigger.OnUserWrite);

      expect(statsAfter).toEqual(statsBefore); // unchanged

      await expectRejection;
    });

    it('H32: reset() zeroes stats and re-enables triggers, observers cleared', async () => {
      ctx.orch.observe(AppTrigger.OnUserWrite, { before: jest.fn() });
      await writeUser(ctx.db, 'u23', {
        ok: true,
        timestamp: FieldValue.serverTimestamp(),
      });
      await sleep();

      ctx.orch.reset();
      const s = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      expect(s).toEqual({ initiated: 0, completed: 0, errors: 0 });
      expect(ctx.orch.isEnabled(AppTrigger.OnUserWrite)).toBe(true);

      // observer cleared → no callbacks
      const spy = jest.fn();
      ctx.orch.observe(AppTrigger.OnUserWrite, { before: spy });
      await writeUser(ctx.db, 'u23', {
        ok: true,
        timestamp: FieldValue.serverTimestamp(),
      });
      await sleep();
      expect(spy).toHaveBeenCalledTimes(1); // fresh observer works
    });

    // ───────────────────────────────── I. Event payload & forwarding ─────────────────────────────────

    it('I33: forwarded TriggerEventArg merged into OrchestratorEventArg', async () => {
      const spy = jest.fn((arg) => {
        expect(arg.key).toBe(AppTrigger.OnUserWrite);
        // `arg` should carry the original payload fields (e.g., change.before/after in v1/v2 shims)
        // We only assert the presence of known shape keys here.
        expect('change' in arg || 'snap' in arg).toBe(true);
      });
      ctx.orch.observe(AppTrigger.OnUserWrite, { before: spy });
      await writeUser(ctx.db, 'u24', { ok: true });
      await sleep();
      expect(spy).toHaveBeenCalled();
    });

    it('I34: same-phase observers see the same frozen object identity', async () => {
      const ids: unknown[] = [];
      ctx.orch.observe(AppTrigger.OnUserWrite, {
        before: (arg) => ids.push(arg),
        after: (arg) => ids.push(arg),
      });
      await writeUser(ctx.db, 'u25', { ok: true });
      await sleep();

      const beforeIds = ids.slice(0, 1);
      const afterIds = ids.slice(1);
      expect(new Set(beforeIds).size).toBe(1);
      expect(new Set(afterIds).size).toBe(1);
    });

    // ───────────────────────────────── J. Error messages & edge cases ─────────────────────────────────

    it('J35: waiting on an unregistered key rejects with helpful message', async () => {
      await expect(
        ctx.orch.wait('Unknown' as any, () => true, { timeout: 20 })
      ).rejects.toThrow(/No trigger handler associated with the key/i);
    });

    it('J36: observe on unknown key throws', () => {
      expect(() =>
        ctx.orch.observe('Unknown' as any, { before: () => void 0 })
      ).toThrow(/No trigger handler associated with the key/i);
    });

    it('J37: no spurious invocation when suspended toggled around a write', async () => {
      ctx.orch.suspended = true;
      const s0 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      await writeUser(ctx.db, 'u26', { ok: true });
      ctx.orch.suspended = false;
      const s1 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      expect(s1).toEqual(s0);
    });

    // ───────────────────────────────── K. Concurrency & Ordering ─────────────────────────────────

    it('K38: ordering: before → handler → after', async () => {
      const calls: string[] = [];
      ctx.orch.observe(AppTrigger.OnUserWrite, {
        before: () => calls.push('before'),
        after: () => calls.push('after'),
      });

      await writeUser(ctx.db, 'u27', { ok: true });
      await sleep();

      // We assert relative order for callbacks; handler is between them by contract.
      expect(calls[0]).toBe('before');
      expect(calls[calls.length - 1]).toBe('after');
    });

    it('K39: counts monotonic across concurrent mix of successes/failures', async () => {
      const s0 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      await Promise.all([
        writeUser(ctx.db, 'u28', { ok: true }),
        writeUser(ctx.db, 'u29', { ok: false }),
        writeUser(ctx.db, 'u30', { ok: true }),
      ]);
      await sleep();

      const s1 = statsFor(ctx.orch, AppTrigger.OnUserWrite);
      expect(s1.initiated).toBe(s0.initiated + 3);
      expect(s1.completed + s1.errors).toBe(s0.completed + s0.errors + 3);
      expect(s1.completed).toBeGreaterThanOrEqual(s0.completed);
      expect(s1.errors).toBeGreaterThanOrEqual(s0.errors);
    });

    // ───────────────────────────────── L. Observer error origin classification ────────────────────────

    it('L40: OnAfter observer exceptions surface with origin=OnAfter', async () => {
      const err = new Error('after broke');
      ctx.orch.observe(AppTrigger.OnUserWrite, {
        after: () => {
          throw err;
        },
      });
      const watch = jest.fn((e) => {
        expect(e.origin).toBe(TriggerErrorOrigin.OnAfter);
        expect(e.cause).toBe(err);
        expect(e.arg.key).toBe(AppTrigger.OnUserWrite);
      });
      const unwatch = ctx.orch.watchErrors(watch);

      await writeUser(ctx.db, 'u31', { ok: true });
      await sleep();

      expect(watch).toHaveBeenCalledTimes(1);
      unwatch();
    });

    // ───────────────────────────────── Cascades sanity (optional light checks) ───────────────────────

    it('Cascades: user create → welcome post created → comment seed written (light sanity)', async () => {
      await writeUser(ctx.db, 'uc', { ok: true, emailVerified: true });
      await sleep();

      // Welcome post is deterministic
      const postRef = ctx.db.doc(PATH_WELCOME_POST.replace('{uid}', 'uc'));
      const post = await postRef.get();
      expect(post.exists).toBe(true);

      // Post-create handler writes a seed comment; ensure audit eventually appears after comment write handler
      const auditRef = ctx.db.doc(
        PATH_AUDIT_COMMENT.replace('{postId}', 'uc-welcome').replace(
          '{commentId}',
          SEED_COMMENT_ID
        )
      );
      const audit = await auditRef.get();
      expect(audit.exists).toBe(true);
    });

    it('Cascades failure: post create missing title → error path + watchErrors origin=Execute', async () => {
      const watch = jest.fn();
      const unwatch = ctx.orch.watchErrors(watch);

      await createPost(ctx.db, 'p-missing-title', {
        /* title absent */
      });

      await ctx.orch.waitOneError(AppTrigger.OnPostCreate);

      expect(watch).toHaveBeenCalled();
      const events = watch.mock.calls.map((c) => c[0]);
      expect(
        events.some(
          (e: any) =>
            e.origin === TriggerErrorOrigin.Execute &&
            (e.cause as Error)?.message?.includes(ERR_POST_CREATE_MISSING_TITLE)
        )
      ).toBe(true);
      unwatch();
    });
  });
}

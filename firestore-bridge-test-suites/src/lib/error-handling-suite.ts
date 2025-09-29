// error-handling.suite.ts
import {
  DocumentData,
  FieldValue,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { ExpectError } from './helpers/expect.error.js';
import { FirestoreBridgeTestContext } from './test-context.js';
import { isDocDataEqual } from './helpers/document-data.js';

export function errorHandlingSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID =
    'Error Handling — public error codes & batching semantics';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    function col() {
      return FirestoreDb.collection(COLLECTION_ID);
    }
    function docRef(id: string) {
      return col().doc(id);
    }

    describe('NOT_FOUND', () => {
      it('update() on a non-existent document yields NOT_FOUND', async () => {
        const r = docRef('nf-update-missing');
        await ExpectError.async(
          () => r.update({ a: 1 }),
          { code: Status.NOT_FOUND } // Status.NOT_FOUND
        );
        const snap = await r.get();
        expect(snap.exists).toBe(false);
      });

      it('delete({ exists: true }) on a non-existent document yields NOT_FOUND', async () => {
        const r = docRef('nf-delete-exists-true');
        await ExpectError.async(
          () => r.delete({ exists: true }),
          { code: Status.NOT_FOUND } // NOT_FOUND
        );
      });
    });

    describe('ALREADY_EXISTS', () => {
      it('create() on an existing document yields ALREADY_EXISTS', async () => {
        const r = docRef('ae-create-existing');
        await r.create({ a: 1 });

        await ExpectError.async(
          () => r.create({ a: 2 }),
          { code: Status.ALREADY_EXISTS } // Status.ALREADY_EXISTS
        );

        const snap = await r.get();
        const d = snap.data() as DocumentData;
        expect(d.a).toBe(1);
      });
    });

    describe('FAILED_PRECONDITION', () => {
      it('lastUpdateTime precondition mismatch yields FAILED_PRECONDITION', async () => {
        const r = docRef('fp-lastUpdateTime-mismatch');

        // Seed a doc and capture its current updateTime.
        await r.set({ v: 1 });
        const seeded = await r.get();
        expect(seeded.exists).toBe(true);
        const correctUpdateTime = seeded.updateTime as Timestamp;

        // Advance the doc so that the stored precondition becomes stale.
        await r.update({ v: 2 });

        // Using the stale updateTime should fail with FAILED_PRECONDITION.
        await ExpectError.async(
          // update/delete accept { lastUpdateTime } as a precondition
          // Use an outdated value to trigger the mismatch.
          () => r.update({ v: 3 }, { lastUpdateTime: correctUpdateTime }),
          { code: Status.FAILED_PRECONDITION } // Status.FAILED_PRECONDITION
        );

        // Verify doc value unchanged by the failed conditional write.
        const after = await r.get();
        const d = after.data() as DocumentData;
        expect(d.v).toBe(2);
      });
    });

    describe('ABORTED', () => {
      it('transaction conflict yields ABORTED (two concurrent txns, single attempt, tolerant assertions)', async () => {
        const target = docRef('ab-txn-conflict');
        await target.set({ n: 0 });

        // Barrier so both transactions read before either writes.
        let release!: () => void;
        const gate = new Promise<void>((res) => (release = res));

        const startTxn = (delta: number) =>
          FirestoreDb.runTransaction(
            async (tx) => {
              const snap = await tx.get(target);
              const current = ((snap.data() as DocumentData) ?? { n: 0 }).n;
              await gate; // synchronize writes
              tx.update(target, { n: current + delta });
            },
            { maxAttempts: 1 }
          );

        const p1 = startTxn(1);
        const p2 = startTxn(2);
        release();

        const [r1, r2] = await Promise.allSettled([p1, p2]);

        const successes = [r1, r2].filter(
          (r) => r.status === 'fulfilled'
        ).length;
        const failures = [r1, r2].filter(
          (r) => r.status === 'rejected'
        ) as PromiseRejectedResult[];

        // At least one ABORTED must occur.
        const codes = await Promise.all(
          failures.map((f) => f.reason?.code ?? Status.UNKNOWN) // helper that extracts numeric Status code
        );
        expect(codes).toContain(Status.ABORTED);

        // At most one can succeed.
        expect(successes).toBeLessThanOrEqual(1);

        // Final value reflects outcome:
        // - if one succeeded → n is 1 or 2
        // - if both aborted → n stays 0
        const finalSnap = await target.get();
        const n = ((finalSnap.data() as DocumentData) ?? { n: -1 }).n;

        if (successes === 1) {
          expect([1, 2]).toContain(n);
        } else {
          expect(n).toBe(0);
        }
      });
    });

    describe('INVALID_ARGUMENT', () => {
      it('update({}) rejects with INVALID_ARGUMENT (empty data object)', async () => {
        const r = docRef('ia-update-empty');
        await r.set({ a: 1 });

        await ExpectError.sync(
          // Empty object is not allowed for update()
          () => r.update({}),
          {
            match:
              /Update\(\) requires either a single JavaScript object or an alternating list of field\/value pairs that can be followed by an optional precondition. At least one field must be updated./,
          }
        );

        const snap = await r.get();
        const d = snap.data() as DocumentData;
        expect(d.a).toBe(1);
      });

      it('set() with FieldValue.delete at top-level rejects with INVALID_ARGUMENT', async () => {
        const r = docRef('ia-set-top-level-delete');
        // Top-level FieldValue.delete() is only valid within update(), not set() unless used under {merge:true} with a field path.
        await ExpectError.sync(
          () => r.set({ bad: FieldValue.delete() as unknown as number }),
          {
            match:
              /^Value for argument "data" is not a valid Firestore document\. FieldValue\.delete\(\) must appear at the top-level and can only be used in update\(\) or set\(\) with \{merge:true\} \(found in field "bad"\)\.$/,
          }
        );
      });
    });

    describe('Batch failure vs partial behavior', () => {
      it('WriteBatch: any failing write causes the whole batch to fail (all-or-nothing)', async () => {
        const okRef = docRef('batch-ok');
        const existsRef = docRef('batch-already-exists');
        // Make one operation guaranteed to fail: create() on an existing doc.
        await existsRef.create({ seeded: true });
        const batch = FirestoreDb.batch();
        batch.set(okRef, { ok: 1 });
        batch.create(existsRef, { shouldFail: true }); // will ALREADY_EXISTS
        await ExpectError.async(
          () => batch.commit(),
          { code: Status.ALREADY_EXISTS } // ALREADY_EXISTS from one op => whole batch rejects
        );
        // Assert atomicity: neither write was applied
        const okSnap = await okRef.get();
        expect(okSnap.exists).toBe(false);
        const existsSnap = await existsRef.get();
        const existsData = existsSnap.data() as DocumentData;
        expect(isDocDataEqual(existsData, { seeded: true })).toBe(true);
      });

      it('Non-batched concurrent writes: partial success is possible', async () => {
        const good = docRef('partial-good');
        const bad = docRef('partial-bad');
        await bad.create({ seeded: true }); // make a future create() fail
        const [s1, s2] = await Promise.allSettled([
          good.set({ ok: true }),
          bad.create({ another: true }), // will ALREADY_EXISTS
        ]);
        // One fulfilled…
        expect(s1.status).toBe('fulfilled');
        // …and one rejected with ALREADY_EXISTS
        expect(s2.status).toBe('rejected');
        await ExpectError.evaluate((s2 as PromiseRejectedResult).reason, {
          code: Status.ALREADY_EXISTS,
        });
        // Verify the successful write stuck
        const goodSnap = await good.get();
        const gd = goodSnap.data() as DocumentData;
        expect(gd.ok).toBe(true);
        // And the failing write did not alter the existing doc
        const badSnap = await bad.get();
        const bd = badSnap.data() as DocumentData;
        expect(isDocDataEqual(bd, { seeded: true })).toBe(true);
      });
    });
  });
}

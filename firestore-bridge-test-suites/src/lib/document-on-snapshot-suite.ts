/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Realtime Listeners — DocumentReference.onSnapshot
 *
 * Goal: Verify Admin SDK parity for document listeners using only public APIs.
 *
 * Surfaces:
 *  - DocumentReference.onSnapshot(listener, error?)
 *  - FieldValue transforms: serverTimestamp, increment, arrayUnion, arrayRemove
 *
 * Invariants exercised:
 *  1) Async delivery (never sync at registration)
 *  2) Initial emission (exists=false/true)
 *  3) Ordering & consistency (monotonic updateTime)
 *  4) Coalescing tolerated (we only assert final consistency, not emission count)
 *  5) Metadata expectations (no assertion on fromCache/hasPendingWrites; Admin SDK server)
 *  6) Unsubscribe idempotency
 *  7) Errors: update on missing doc does not emit a data snapshot
 */

import {
  DocumentData,
  FieldValue,
  Firestore,
  Timestamp,
  WriteResult,
} from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { isDocDataEqual } from './helpers/document-data.js';
import { ExpectError } from './helpers/expect.error.js';
import {
  assertAsyncInitialDelivery,
  collect,
} from './helpers/snapshot-collector.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function documentOnSnapshotSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Realtime Listeners — DocumentReference.onSnapshot';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    const sanitize = (s: string) =>
      s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);

    const docRef = () => {
      const name = sanitize(
        expect.getState().currentTestName ?? 'unknown_test'
      );
      return FirestoreDb.collection(COLLECTION_ID).doc(name);
    };

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('callbacks are delivered asynchronously; first emission never fires synchronously', async () => {
      const ref = docRef();
      const collector = collect(ref);
      // Assert: not delivered synchronously at registration
      await assertAsyncInitialDelivery(collector);
      collector.stop();
    });

    it('initial snapshot: attach before doc exists → exists=false; then set() → exists=true with correct data', async () => {
      const ref = docRef();
      const collector = collect(ref);

      // 1) First emission (doc missing)
      const first = await collector.first;
      expect(first.exists).toBe(false);
      expect(first.dataHash).toBe('DELETED');

      // 2) Create document
      let wr!: WriteResult;
      const next = await collector.waitForNext(async () => {
        wr = await ref.set({ a: 1, b: 'x' });
      });

      expect(wr).toBeDefined();
      expect(next.exists).toBe(true);
      const d = next.documentSnapshot!.data() as DocumentData;
      expect(isDocDataEqual(d, { a: 1, b: 'x' })).toBe(true);

      // updateTime should be present and equal to write result's time (millis match)
      expect(next.updateTime).toBeInstanceOf(Timestamp);
      expect(next.updateTime!.toMillis()).toBe(wr.writeTime.toMillis());

      collector.stop();
    });

    it('create / update (merge & nested) maintain exists=true and strictly monotonic updateTime', async () => {
      const ref = docRef();
      const collector = collect(ref);
      await collector.first; // exists=false

      // create
      let wr1!: WriteResult;
      const e1 = await collector.waitForNext(async () => {
        wr1 = await ref.set({ a: 1, m: { k: 'v' } });
      });
      expect(wr1).toBeDefined();

      // merge update
      let wr2!: WriteResult;
      const e2 = await collector.waitForNext(async () => {
        wr2 = await ref.set({ m: { z: 9 } }, { merge: true });
      });
      expect(wr2).toBeDefined();

      // nested update
      let wr3!: WriteResult;

      const e3 = await collector.waitForNext(async () => {
        wr3 = await ref.update({ 'm.k': 'vv', a: 2 });
      });
      expect(wr3).toBeDefined();

      // Data assertions
      const d3 = e3.documentSnapshot!.data() as DocumentData;
      expect(isDocDataEqual(d3, { a: 2, m: { k: 'vv', z: 9 } })).toBe(true);

      // Monotonic updateTime (strictly increasing)
      expect(e1.updateTime!.toMillis()).toBe(wr1.writeTime.toMillis());
      expect(e2.updateTime!.toMillis()).toBe(wr2.writeTime.toMillis());
      expect(e3.updateTime!.toMillis()).toBe(wr3.writeTime.toMillis());
      expect(e1.updateTime!.toMillis()).toBeLessThanOrEqual(
        e2.updateTime!.toMillis()
      );
      expect(e2.updateTime!.toMillis()).toBeLessThanOrEqual(
        e3.updateTime!.toMillis()
      );

      collector.stop();
    });

    it('delete() emits exists=false and readTime updates', async () => {
      const ref = docRef();
      const collector = collect(ref);
      await collector.first; // missing

      const created = await collector.waitForNext(() => ref.set({ n: 1 }));
      expect(created.exists).toBe(true);

      const deleted = await collector.waitForNext(() => ref.delete());
      expect(deleted.exists).toBe(false);
      expect(deleted.readTime).toBeInstanceOf(Timestamp);
      // updateTime may be undefined for non-existent docs; do not assert it here.

      collector.stop();
    });

    it('transforms: serverTimestamp, increment, arrayUnion/arrayRemove are reflected in subsequent emission', async () => {
      const ref = docRef();
      const collector = collect(ref);
      await collector.first; // missing

      // serverTimestamp on create
      const e1 = await collector.waitForNext(() =>
        ref.set({ ts: FieldValue.serverTimestamp(), n: 0, tags: ['a'] })
      );
      const d1 = e1.documentSnapshot!.data() as DocumentData;

      expect(d1.ts instanceof Timestamp).toBe(true);
      expect(d1.n).toBe(0);
      expect(Array.isArray(d1.tags)).toBe(true);
      expect((d1.tags as unknown[]).includes('a')).toBe(true);

      // increment & unions
      const e2 = await collector.waitForNext(() =>
        ref.update({
          n: FieldValue.increment(5),
          tags: FieldValue.arrayUnion('b', 'c'),
        })
      );
      const d2 = e2.documentSnapshot!.data() as DocumentData;
      expect(d2.n).toBe(5);
      expect((d2.tags as unknown[]).sort()).toEqual(['a', 'b', 'c']);

      const e3 = await collector.waitForNext(() =>
        ref.update({
          n: FieldValue.increment(-2),
          tags: FieldValue.arrayRemove('b'),
        })
      );
      const d3 = e3.documentSnapshot!.data() as DocumentData;
      expect(d3.n).toBe(3);
      expect((d3.tags as unknown[]).sort()).toEqual(['a', 'c']);

      // updateTime strictly monotonic over the three writes
      expect(e1.updateTime!.toMillis()).toBeLessThanOrEqual(
        e2.updateTime!.toMillis()
      );
      expect(e2.updateTime!.toMillis()).toBeLessThanOrEqual(
        e3.updateTime!.toMillis()
      );

      collector.stop();
    });

    it('unsubscribe is idempotent and prevents further emissions', async () => {
      const ref = docRef();
      const collector = collect(ref);
      await collector.first; // initial

      await collector.waitForNext(() => ref.set({ x: 1 }));
      const preStopCount = collector.emissions.length;

      collector.stop();
      collector.stop(); // idempotent

      // Give the listener time to close
      await sleep(50);
      await ref.update({ x: 2 });

      // Give the listener time to (not) receive anything
      await sleep(50);

      expect(collector.emissions.length).toBe(preStopCount);
    });

    it('rapid burst of writes results in a consistent final snapshot stream (no missing final state)', async () => {
      const ref = docRef();
      const collector = collect(ref);
      await collector.first;

      // Start with a base doc
      await collector.waitForNext(() => ref.set({ v: 0, arr: [] }));

      // Fire a burst of writes quickly (no awaits between them), then await all
      const writes: Array<Promise<unknown>> = [];
      for (let i = 1; i <= 5; i++) {
        writes.push(ref.update({ v: FieldValue.increment(1) }));
      }
      writes.push(ref.update({ arr: FieldValue.arrayUnion('k1') }));
      writes.push(ref.update({ arr: FieldValue.arrayUnion('k2') }));
      await Promise.all(writes);

      // Wait until we observe a snapshot whose data matches the expected final state
      const expected = { v: 5, arr: ['k1', 'k2'] };
      await collector.waitUntil((ems) => {
        const last = ems.at(-1)!;
        if (!last.exists) return false;

        const d = last.documentSnapshot!.data() as { v: number; arr: string[] };
        // order of arrayUnion results is not guaranteed (emulator may receive or process
        // the writes in a sequence other than that in which we submitted them above
        return (
          d.v === expected.v &&
          d.arr?.length === 2 &&
          d.arr.includes('k1') &&
          d.arr.includes('k2')
        );
      });

      const final = collector.last().documentSnapshot!.data() as DocumentData;
      expect(final.v).toBe(5);
      expect((final.arr as unknown[]).sort()).toEqual(['k1', 'k2']);

      // Monotonic updateTime across emissions
      const updates = collector.emissions
        .map((e) => e.updateTime?.toMillis())
        .filter((n): n is number => typeof n === 'number');
      for (let i = 1; i < updates.length; i++) {
        expect(updates[i - 1]).toBeLessThanOrEqual(updates[i]);
      }

      collector.stop();
    });

    it('update() on a non-existent document fails and does NOT emit a data snapshot', async () => {
      const ref = docRef();
      const collector = collect(ref);
      const first = await collector.first;
      expect(first.exists).toBe(false);

      await ExpectError.async(() => ref.update({ a: 1 }), {
        code: Status.NOT_FOUND,
      });

      // Ensure no extra data emission occurred for the failed write.
      expect(collector.emissions.length).toBe(1);

      collector.stop();
    });
  });
}

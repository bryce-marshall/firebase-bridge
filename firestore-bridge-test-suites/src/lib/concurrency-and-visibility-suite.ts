import { DocumentData, Firestore, Timestamp } from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from './test-context.js';

function compareTimestamp(a: Timestamp, b: Timestamp): number {
  if (a.seconds !== b.seconds) return a.seconds - b.seconds;

  return a.nanoseconds - b.nanoseconds;
}

export function concurrencyVisibilitySuite(
  context: FirestoreBridgeTestContext
) {
  const COLLECTION_ID = 'Concurrency & Visibility — root collection';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('Concurrent non-transactional writes → last-write-wins (final doc matches latest committed write)', async () => {
      const ref = FirestoreDb.collection(COLLECTION_ID).doc(
        'concurrent-last-write-wins'
      );

      // Launch three writes "concurrently" but stagger their *send* time so arrival order is deterministic.
      // We don’t await in between: they’re all in-flight together. The emulator/server can still commit
      // in-flight writes in a different order, so assertions below use the observed commit times.
      const op1 = (async () => {
        await delay(10);
        const data = { tag: 'first', seq: 1 };
        const result = await ref.set(data);
        return { data, result };
      })();

      const op2 = (async () => {
        await delay(20);
        const data = { tag: 'second', seq: 2 };
        const result = await ref.set(data);
        return { data, result };
      })();

      const op3 = (async () => {
        await delay(30);
        const data = { tag: 'third', seq: 3 };
        const result = await ref.set(data);
        return { data, result };
      })();

      const writes = await Promise.all([op1, op2, op3]);
      const latest = writes.reduce((prev, curr) =>
        compareTimestamp(prev.result.writeTime, curr.result.writeTime) >= 0
          ? prev
          : curr
      );

      // Final state should reflect the write with the latest committed writeTime.
      const snap = await ref.get();
      const data = snap.data() as DocumentData;
      expect(data.seq).toBe(latest.data.seq);
      expect(data.tag).toBe(latest.data.tag);

      // The snapshot's updateTime should match the latest write's writeTime.
      const finalUpdateTime = snap.updateTime as Timestamp;
      expect(finalUpdateTime.isEqual(latest.result.writeTime)).toBe(true);
    });

    it('Assert updateTime reflects ordering across sequential overwrites (monotonic, last write wins)', async () => {
      const ref = FirestoreDb.collection(COLLECTION_ID).doc(
        'sequential-overwrites'
      );

      const rA = await ref.set({ v: 'A', i: 1 });
      const rB = await ref.set({ v: 'B', i: 2 });
      const rC = await ref.set({ v: 'C', i: 3 });

      const a = rA.writeTime.toMillis();
      const b = rB.writeTime.toMillis();
      const c = rC.writeTime.toMillis();

      expect(a).toBeLessThanOrEqual(b);
      expect(b).toBeLessThanOrEqual(c);

      const snap = await ref.get();
      const d = snap.data() as DocumentData;
      expect(d.v).toBe('C');
      expect(d.i).toBe(3);
      expect((snap.updateTime as Timestamp).toMillis()).toBe(c);
    });

    it('Verify read-your-write: immediate document get() observes the completed write', async () => {
      const ref = FirestoreDb.collection(COLLECTION_ID).doc('ryww-doc');
      const marker = `m-${Date.now()}`;

      const res = await ref.set({ group: 'ryww', marker, n: 1 });
      const wroteAt = res.writeTime.toMillis();

      const snap = await ref.get();
      expect(snap.exists).toBe(true);

      const d = snap.data() as DocumentData;
      expect(d.group).toBe('ryww');
      expect(d.marker).toBe(marker);
      expect(d.n).toBe(1);

      // updateTime should be >= the write’s writeTime (typically equal)
      const seenAt = (snap.updateTime as Timestamp).toMillis();
      expect(seenAt).toBeGreaterThanOrEqual(wroteAt);
    });

    it('Verify read-your-write: immediate query observes the completed write', async () => {
      const col = FirestoreDb.collection(COLLECTION_ID);
      const doc = col.doc('ryww-query');
      const token = `token-${Date.now()}`;

      const res = await doc.set({ group: 'ryww-q', token, ready: true });
      const wroteAt = res.writeTime.toMillis();

      // Immediately run a query that should include the freshly written doc.
      const qs = await col
        .where('group', '==', 'ryww-q')
        .where('token', '==', token)
        .get();

      expect(qs.size).toBe(1);
      const got = qs.docs[0];
      expect(got.id).toBe(doc.id);

      const data = got.data() as DocumentData;
      expect(data.ready).toBe(true);

      // Query readTime should be >= the write’s writeTime.
      const readTime = qs.readTime?.toMillis();
      if (typeof readTime === 'number') {
        expect(readTime).toBeGreaterThanOrEqual(wroteAt);
      }
    });
  });
}

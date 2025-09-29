import { DocumentData, Firestore, Timestamp } from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from './test-context.js';

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

    it('Concurrent non-transactional writes → last-write-wins (final doc matches last arriving write)', async () => {
      const ref = FirestoreDb.collection(COLLECTION_ID).doc(
        'concurrent-last-write-wins'
      );

      // Launch three writes "concurrently" but stagger their *send* time so arrival order is deterministic.
      // We don’t await in between: they’re all in-flight together.
      const op1 = (async () => {
        await delay(10);
        return ref.set({ tag: 'first', seq: 1 });
      })();

      const op2 = (async () => {
        await delay(20);
        return ref.set({ tag: 'second', seq: 2 });
      })();

      const op3 = (async () => {
        await delay(30);
        return ref.set({ tag: 'third', seq: 3 });
      })();

      const [r1, r2, r3] = await Promise.all([op1, op2, op3]);

      // Verify write times are non-decreasing in the order we *sent* them.
      const t1 = r1.writeTime.toMillis();
      const t2 = r2.writeTime.toMillis();
      const t3 = r3.writeTime.toMillis();
      expect(t1).toBeLessThanOrEqual(t2);
      expect(t2).toBeLessThanOrEqual(t3);

      // Final state should reflect the last (latest-arriving) write: seq === 3, tag === 'third'
      const snap = await ref.get();
      const data = snap.data() as DocumentData;
      expect(data.seq).toBe(3);
      expect(data.tag).toBe('third');

      // The snapshot's updateTime should match the last write's writeTime.
      const finalUpdateTime = (snap.updateTime as Timestamp).toMillis();
      expect(finalUpdateTime).toBe(t3);
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

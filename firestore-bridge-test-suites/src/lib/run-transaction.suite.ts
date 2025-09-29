import {
  DocumentData,
  FieldValue,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { FirestoreBridgeTestContext } from './test-context.js';

export function runTransactionSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Transactions (runTransaction)';

  describe(COLLECTION_ID, () => {
    let Firestore!: Firestore;
    let FirestoreOther!: Firestore; // separate client for “external” writes

    const col = () => Firestore.collection(COLLECTION_ID);
    const docRef = (id: string) => col().doc(id);

    beforeAll(async () => {
      // Primary client + suite root cleanup
      Firestore = await context.init(COLLECTION_ID);
      // Secondary client (distinct Admin app under the hood)
      FirestoreOther = await context.init();
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('read-then-read uses a stable logical snapshot within an attempt (external write between reads is not observed)', async () => {
      const ref = docRef('consistent-reads');
      await ref.set({ v: 1 });

      // Barrier: start external write only AFTER the first transactional read.
      let releaseExternal!: () => void;
      const afterFirstRead = new Promise<void>(
        (res) => (releaseExternal = res)
      );

      const externalWrite = (async () => {
        await afterFirstRead; // ensure s1 finished
        const w = await FirestoreOther.doc(ref.path).update({ v: 2 });
        return w.writeTime as Timestamp;
      })();

      let t1!: Timestamp, t2!: Timestamp;

      await Firestore.runTransaction(async (tx) => {
        const s1 = await tx.get(ref);
        const d1 = s1.data() as DocumentData;
        t1 = s1.readTime as Timestamp;
        expect(d1).toEqual({ v: 1 });

        // Release the external write to occur "between" reads (don’t await it here).
        releaseExternal();
        await Promise.resolve(); // small scheduling window; safe to yield

        const s2 = await tx.get(ref);
        const d2 = s2.data() as DocumentData;
        t2 = s2.readTime as Timestamp;

        // Same snapshot within this attempt.
        expect(d2).toEqual({ v: 1 });
      });

      const extWT = await externalWrite;

      // Both reads happened at-or-before the external write.
      const tsLEQ = (a: Timestamp, b: Timestamp) =>
        a.seconds < b.seconds ||
        (a.seconds === b.seconds && a.nanoseconds <= b.nanoseconds);

      expect(tsLEQ(t1, extWT)).toBe(true);
      expect(tsLEQ(t2, extWT)).toBe(true);

      // After the transaction, the external write is visible.
      const after = await ref.get();
      expect((after.data() as DocumentData).v).toBe(2);
    });

    it('automatic retry on conflict: function is re-invoked and final outcome reflects latest state', async () => {
      const ref = docRef('conflict-retry');
      await ref.set({ n: 0 });

      // Barrier used to start the external transaction *after* attempt #1 has read.
      let releaseExternal!: () => void;
      const startExternal = new Promise<void>((res) => (releaseExternal = res));

      // Kick off a separate-client TRANSACTION that will bump by +100 once released.
      const externalTxn = (async () => {
        await startExternal;
        await FirestoreOther.runTransaction(async (tx2) => {
          const s = await tx2.get(ref);
          const c = ((s.data() as DocumentData) ?? {}).n ?? 0;
          tx2.update(ref, { n: c + 100 });
        });
      })();

      let attemptCount = 0;

      const result = await Firestore.runTransaction(async (tx) => {
        attemptCount++;

        // On the second attempt, pause briefly to give the external txn time to commit
        // before we read. This ensures we observe the latest state deterministically.
        if (attemptCount === 2) {
          await new Promise((r) => setTimeout(r, 250));
        }

        const snap = await tx.get(ref);
        const current = ((snap.data() as DocumentData) ?? {}).n ?? 0;

        if (attemptCount === 1) {
          // We’ve read the document in attempt #1. Now:
          // 1) release the external transaction (it will bump +100)
          // 2) inject an ABORTED error to force the SDK to retry our function.
          releaseExternal();

          const err = new Error('ABORTED (test-injected)');
          (err as unknown as { code: number }).code = Status.ABORTED; // Status.ABORTED
          throw err;
        }

        // Attempt #2 (or later): apply our +1 based on the *freshly* read value.
        tx.update(ref, { n: current + 1 });
        return current + 1;
      });

      // Ensure the external txn actually finished (sanity + cleanup).
      await externalTxn;

      // We expect at least one retry (two or more invocations).
      expect(attemptCount).toBeGreaterThanOrEqual(2);

      // External +100 then our +1 => 101.
      expect(result).toBe(101);

      const after = await ref.get();
      const d = after.data() as DocumentData;
      expect(d.n).toBe(101);
    });

    it('read-then-write: value used for the write is consistent within the invocation', async () => {
      const ref = docRef('read-then-write-consistency');
      await ref.set({ c: 10 });

      await Firestore.runTransaction(async (tx) => {
        const s1 = await tx.get(ref);
        const d1 = s1.data() as DocumentData;
        const c1 = (d1?.c as number) ?? 0;

        const s2 = await tx.get(ref);
        const d2 = s2.data() as DocumentData;
        const c2 = (d2?.c as number) ?? 0;

        // Within the same attempt (no txn writes yet), reads are consistent
        expect(c2).toBe(c1);

        // Now a transactional write based on the read value
        tx.update(ref, { c: c1 + 5 });
        // No further tx.get() calls here—reads-before-writes rule respected
      });

      const after = await ref.get();
      const d = after.data() as DocumentData;
      expect(d.c).toBe(15);
    });

    it('transform interplay: FieldValue.increment inside a transaction applies correctly (accumulated updates)', async () => {
      const ref = docRef('increment-inside-transaction');
      await ref.set({ count: 0 });

      await Firestore.runTransaction(async (tx) => {
        tx.update(ref, { count: FieldValue.increment(1) });
        tx.update(ref, { count: FieldValue.increment(2) });
      });

      const snap = await ref.get();
      const d = snap.data() as DocumentData;
      expect(d.count).toBe(3);
    });

    it('transform interplay: set({merge}) with FieldValue.increment creates/updates within a transaction', async () => {
      const ref = docRef('increment-set-merge');

      await Firestore.runTransaction(async (tx) => {
        tx.set(ref, { visits: FieldValue.increment(5) }, { merge: true });
      });

      const first = (await ref.get()).data() as DocumentData;
      expect(first.visits).toBe(5);

      await Firestore.runTransaction(async (tx) => {
        tx.update(ref, { visits: FieldValue.increment(2) });
      });

      const second = (await ref.get()).data() as DocumentData;
      expect(second.visits).toBe(7);
    });

    it('time sensitivity: stable snapshot semantics via data + ordering (no strict readTime equality)', async () => {
      const ref = docRef('readtime-stability');
      await ref.set({ v: 'x' });

      // Barrier: only start the external write AFTER the first transactional read completes.
      let releaseExternal!: () => void;
      const afterFirstRead = new Promise<void>(
        (res) => (releaseExternal = res)
      );

      // External write (separate client), triggered by the barrier; never awaited inside the tx.
      const externalWrite = (async () => {
        await afterFirstRead;
        const w = await FirestoreOther.doc(ref.path).update({ v: 'y' });
        return w.writeTime as Timestamp;
      })();

      let t1!: Timestamp, t2!: Timestamp;

      await Firestore.runTransaction(async (tx) => {
        const s1 = await tx.get(ref);
        const d1 = s1.data() as DocumentData;
        t1 = s1.readTime as Timestamp;
        expect(d1).toEqual({ v: 'x' });

        // Release the external write to occur *between* reads.
        releaseExternal();
        await Promise.resolve(); // small yield to schedule the external write

        const s2 = await tx.get(ref);
        const d2 = s2.data() as DocumentData;
        t2 = s2.readTime as Timestamp;

        // Same logical snapshot within this attempt (external write not observed).
        expect(d2).toEqual({ v: 'x' });
      });

      const wt = await externalWrite;

      // Both reads happened at-or-before the external write.
      const tsLEQ = (a: Timestamp, b: Timestamp) =>
        a.seconds < b.seconds ||
        (a.seconds === b.seconds && a.nanoseconds <= b.nanoseconds);

      expect(tsLEQ(t1, wt)).toBe(true);
      expect(tsLEQ(t2, wt)).toBe(true);

      // After the transaction, the external write is visible.
      const after = await ref.get();
      expect((after.data() as DocumentData).v).toBe('y');
    });
  });
}

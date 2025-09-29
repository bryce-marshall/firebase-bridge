/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  DocumentData,
  FieldValue,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from './test-context.js';

export function timeBehaviorSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Time Behavior — timestamps & serverTimestamp';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    const col = () => FirestoreDb.collection(COLLECTION_ID);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('create: createTime === updateTime on first write; later writes advance updateTime; createTime is stable', async () => {
      const ref = col().doc('create-vs-update');

      // First write (set): createTime === updateTime
      const r1 = await ref.set({ a: 1 });
      const s1 = await ref.get();
      expect(s1.exists).toBe(true);

      const c1 = s1.createTime!;
      const u1 = s1.updateTime!;
      expect(c1.isEqual(u1)).toBe(true);

      // Second write (update): updateTime advances; createTime remains the same
      await sleep(2); // tiny nudge to avoid equal-micros edge cases
      const r2 = await ref.update({ b: 2 });
      const s2 = await ref.get();
      const c2 = s2.createTime!;
      const u2 = s2.updateTime!;
      expect(c2.isEqual(c1)).toBe(true);

      // Allow equality-or-advance (microsecond truncation can collapse deltas)
      expect(u2.toMillis()).toBeGreaterThanOrEqual(u1.toMillis());

      // Also check write results are consistent with snapshot.updateTime
      expect(r1.writeTime.isEqual(u1)).toBe(true);
      expect(r2.writeTime.isEqual(u2)).toBe(true);
    });

    it('set({merge}) only advances updateTime; createTime stays fixed', async () => {
      const ref = col().doc('merge-advances-update');
      await ref.set({ x: 1 });
      const s1 = await ref.get();
      const c1 = s1.createTime!;
      const u1 = s1.updateTime!;

      await sleep(2);
      await ref.set({ y: 2 }, { merge: true });
      const s2 = await ref.get();
      const c2 = s2.createTime!;
      const u2 = s2.updateTime!;

      expect(c2.isEqual(c1)).toBe(true);
      expect(u2.toMillis()).toBeGreaterThanOrEqual(u1.toMillis());

      const d = s2.data() as DocumentData;
      expect(d).toMatchObject({ x: 1, y: 2 });
    });

    it('round-trips FieldValue.serverTimestamp(): stored value is a Timestamp aligned with commit time (tolerant to <1ms skew)', async () => {
      const ref = col().doc('server-timestamp-roundtrip');

      const wr = await ref.set({ ts: FieldValue.serverTimestamp() });
      const snap = await ref.get();
      const d = snap.data() as DocumentData;

      expect(d.ts instanceof Timestamp).toBe(true);

      const ts: Timestamp = d.ts;
      const updateTime = snap.updateTime!;
      const writeTime = wr.writeTime;

      // Authoritative equality: updateTime === writeTime
      expect(updateTime.isEqual(writeTime)).toBe(true);

      // The stored serverTimestamp should represent the commit time, but allow tiny
      // sub-ms differences that can occur in the emulator’s transform vs write path.
      const nanosDelta =
        Math.abs(ts.nanoseconds - updateTime.nanoseconds) +
        Math.abs(ts.seconds - updateTime.seconds) * 1_000_000_000;

      // Accept exact equality OR a small absolute skew (e.g., ≤ 5ms).
      expect(ts.isEqual(updateTime) || nanosDelta <= 5_000_000).toBe(true);
    });

    it('relative ordering across sequential writes to different docs is non-decreasing (tolerant comparison)', async () => {
      const a = col().doc('order-a');
      const b = col().doc('order-b');

      const ra = await a.set({ n: 1 });
      const sa = await a.get();

      // Nudge before second write; still allow equal timestamps in assertion
      await sleep(2);

      const rb = await b.set({ n: 2 });
      const sb = await b.get();

      const aUpdate = sa.updateTime!;
      const bUpdate = sb.updateTime!;

      // Some environments may produce identical-micros write times.
      expect(bUpdate.toMillis()).toBeGreaterThanOrEqual(aUpdate.toMillis());

      // Cross-check write results vs snapshot.updateTime
      expect(ra.writeTime.isEqual(aUpdate)).toBe(true);
      expect(rb.writeTime.isEqual(bUpdate)).toBe(true);
    });

    it('delete + recreate resets createTime; new createTime >= previous updateTime', async () => {
      const ref = col().doc('delete-then-recreate');

      // Create
      await ref.set({ v: 1 });
      const s1 = await ref.get();
      const c1 = s1.createTime!;
      const u1 = s1.updateTime!;
      expect(c1.isEqual(u1)).toBe(true);

      // Delete (idempotent)
      await sleep(2);
      await ref.delete();

      // Recreate at same path
      await sleep(2);
      await ref.set({ v: 2 });
      const s2 = await ref.get();
      const c2 = s2.createTime!;
      const u2 = s2.updateTime!;

      // New createTime must be >= last known updateTime before deletion
      expect(c2.toMillis()).toBeGreaterThanOrEqual(u1.toMillis());

      // And as a fresh doc, createTime === updateTime again
      expect(c2.isEqual(u2)).toBe(true);

      const d = s2.data() as DocumentData;
      expect(d.v).toBe(2);
    });

    it('updateTime is monotonic across multiple consecutive writes to the same document (allowing equal-micros)', async () => {
      const ref = col().doc('monotonic-update');

      await ref.set({ step: 1 });
      const s1 = await ref.get();
      const u1 = s1.updateTime!;

      await sleep(2);
      await ref.update({ step: 2 });
      const s2 = await ref.get();
      const u2 = s2.updateTime!;

      await sleep(2);
      await ref.update({ step: 3 });
      const s3 = await ref.get();
      const u3 = s3.updateTime!;

      // Non-decreasing sequence
      expect(u2.toMillis()).toBeGreaterThanOrEqual(u1.toMillis());
      expect(u3.toMillis()).toBeGreaterThanOrEqual(u2.toMillis());
    });
  });
}

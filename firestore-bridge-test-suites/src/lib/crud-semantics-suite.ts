import {
  DocumentData,
  FieldPath,
  FieldValue,
  Firestore,
  Timestamp,
  WriteResult,
} from 'firebase-admin/firestore';
import {
  isDocDataEqual,
  normalizeDocData,
  truncatedTimestamp,
} from './helpers/document-data.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function crudSemtanticsSuite(context: FirestoreBridgeTestContext) {
  // Unique collection name so emulator analysis can inspect post-run data without clashes
  const COLLECTION_ID = 'Basic CRUD & Document Lifecycle';

  describe(COLLECTION_ID, () => {
    let db!: Firestore;

    beforeAll(async () => {
      db = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    const col = () => db.collection(COLLECTION_ID);

    const writeTime = (wr: WriteResult): Timestamp =>
      (wr as unknown as { updateTime?: Timestamp }).updateTime ??
      (wr as unknown as { writeTime: Timestamp }).writeTime;

    const tsCmp = (a: Timestamp, b: Timestamp) =>
      a.seconds === b.seconds
        ? a.nanoseconds - b.nanoseconds
        : a.seconds - b.seconds;

    it('set() overwrite replaces the entire document', async () => {
      const ref = col().doc('set-overwrite');
      const wr1 = await ref.set({ a: 1, b: 2, nested: { x: 1 } });
      const s1 = await ref.get();
      expect(s1.exists).toBe(true);
      expect(
        isDocDataEqual(s1.data() as DocumentData, {
          a: 1,
          b: 2,
          nested: { x: 1 },
        })
      ).toBe(true);

      const wr2 = await ref.set({ a: 9, c: 3 }); // Overwrite
      const s2 = await ref.get();
      expect(isDocDataEqual(s2.data() as DocumentData, { a: 9, c: 3 })).toBe(
        true
      );

      // writeResult time matches snapshot.updateTime (allowing library naming differences)
      const t1 = truncatedTimestamp(writeTime(wr1));
      const t2 = truncatedTimestamp(writeTime(wr2));
      const u1 = truncatedTimestamp(s1.updateTime as Timestamp);
      const u2 = truncatedTimestamp(s2.updateTime as Timestamp);
      expect(t1.isEqual(u1)).toBe(true);
      expect(t2.isEqual(u2)).toBe(true);

      // Monotonic (non-decreasing) write times across consecutive writes
      expect(tsCmp(t2, t1)).toBeGreaterThanOrEqual(0);
    });

    it('set({merge:true}) merges fields (preserves others, updates overlaps)', async () => {
      const ref = col().doc('set-merge');
      await ref.set({ a: 1, b: 2, nested: { x: 1, y: 2 } });
      await ref.set({ b: 99, c: 3, nested: { y: 42, z: 7 } }, { merge: true });
      const snap = await ref.get();
      const data = normalizeDocData(snap.data() as DocumentData);
      expect(
        isDocDataEqual(data, {
          a: 1,
          b: 99, // updated
          c: 3, // added
          nested: { x: 1, y: 42, z: 7 }, // merged
        })
      ).toBe(true);
    });

    it('set({mergeFields:[...]}): targeted merges respect dot/FieldPath addressing', async () => {
      const ref = col().doc('set-mergeFields');
      await ref.set({ a: { b: 1, c: 2 }, d: 1 });

      await ref.set(
        { a: { c: 3, e: 4 }, x: 10 },
        { mergeFields: ['a.c', new FieldPath('a', 'e')] }
      );

      const snap = await ref.get();
      expect(
        isDocDataEqual(snap.data() as DocumentData, {
          a: { b: 1, c: 3, e: 4 }, // only the targeted keys changed/added
          d: 1,
        })
      ).toBe(true);
    });

    it('update() applies field path addressing and fails on missing document', async () => {
      const refMissing = col().doc('update-missing');
      await expect(refMissing.update({ a: 1 })).rejects.toMatchObject({
        code: 5,
      }); // NOT_FOUND

      const ref = col().doc('update-fieldpaths');
      await ref.set({ a: { b: 1, c: 2 }, arr: [1, 2], keep: true });

      // update nested using string path
      await ref.update({ 'a.b': 123 });

      // update nested using FieldPath
      await ref.update(new FieldPath('a', 'c'), 456);

      // delete a field
      await ref.update({ arr: FieldValue.delete() });

      const snap = await ref.get();
      expect(
        isDocDataEqual(snap.data() as DocumentData, {
          a: { b: 123, c: 456 },
          keep: true,
        })
      ).toBe(true);
    });

    it('create() succeeds only if the doc does not exist; otherwise ALREADY_EXISTS', async () => {
      const ref = col().doc('create-precond');
      const wr1 = await ref.create({ v: 1 });
      const s1 = await ref.get();
      expect(s1.exists).toBe(true);
      expect((s1.data() as DocumentData).v).toBe(1);

      const tWrite = truncatedTimestamp(writeTime(wr1));
      const tSnap = truncatedTimestamp(s1.updateTime as Timestamp);
      expect(tWrite.isEqual(tSnap)).toBe(true);

      await expect(ref.create({ v: 2 })).rejects.toMatchObject({ code: 6 }); // ALREADY_EXISTS
    });

    it('delete() is idempotent (no error if doc already deleted)', async () => {
      const ref = col().doc('delete-idempotent');
      await ref.set({ v: 1 });
      await ref.delete();

      // second delete should not throw
      await expect(ref.delete()).resolves.toBeDefined();

      const snap = await ref.get();
      expect(snap.exists).toBe(false);
    });

    it('delete() respects existence/updateTime preconditions', async () => {
      const ref = col().doc('delete-preconditions');

      // Create, capture updateTime
      await ref.set({ v: 1 });
      const before = await ref.get();
      const u1 = before.updateTime;

      // Bump the doc so u1 becomes stale
      await ref.update({ touch: 1 });

      // Delete with stale lastUpdateTime -> FAILED_PRECONDITION
      await expect(ref.delete({ lastUpdateTime: u1 })).rejects.toMatchObject({
        code: 9,
      }); // FAILED_PRECONDITION

      // Now delete with current lastUpdateTime -> succeeds
      const current = await ref.get();
      const wrOK = await ref.delete({ lastUpdateTime: current.updateTime });
      expect(wrOK).toBeDefined();

      // And the document is gone
      const after = await ref.get();
      expect(after.exists).toBe(false);
    });

    it('writeResult times are monotonic (non-decreasing) across consecutive writes', async () => {
      const ref = col().doc('monotonic-times');

      const wr1 = await ref.set({ step: 1 });
      const wr2 = await ref.update({ step: 2 });
      const wr3 = await ref.set({ step: 3 }, { merge: true });

      const t1 = truncatedTimestamp(writeTime(wr1));
      const t2 = truncatedTimestamp(writeTime(wr2));
      const t3 = truncatedTimestamp(writeTime(wr3));

      // Non-decreasing: t1 <= t2 <= t3
      expect(tsCmp(t2, t1)).toBeGreaterThanOrEqual(0);
      expect(tsCmp(t3, t2)).toBeGreaterThanOrEqual(0);

      // Latest writeResult time matches snapshot.updateTime
      const snap = await ref.get();
      const u = truncatedTimestamp(snap.updateTime as Timestamp);
      expect(u.isEqual(t3)).toBe(true);
    });

    it('snapshot timestamps: createTime/updateTime/readTime are correct', async () => {
      const ref = col().doc('snapshot-timestamps');

      // 1) First write -> createTime === updateTime on the first snapshot
      await ref.set({ v: 1 });
      const s1 = await ref.get();

      const c1 = truncatedTimestamp(s1.updateTime as Timestamp);
      const u1 = truncatedTimestamp(s1.updateTime as Timestamp);
      const r1 = truncatedTimestamp(s1.readTime as Timestamp);

      expect(c1.isEqual(u1)).toBe(true); // initial createTime == updateTime
      expect(r1.isEqual(truncatedTimestamp(s1.readTime))).toBe(true); // readTime is set

      // 2) Second write -> updateTime advances; createTime stays constant; readTime reflects read moment
      await ref.update({ v: 2 });
      const s2 = await ref.get();

      const c2 = truncatedTimestamp(s2.createTime as Timestamp);
      const u2 = truncatedTimestamp(s2.updateTime as Timestamp);
      const r2 = truncatedTimestamp(s2.readTime);

      expect(c2.isEqual(c1)).toBe(true); // createTime is immutable
      expect(u2.toMillis() >= u1.toMillis()).toBe(true); // updateTime is monotonic
      expect(r2.toMillis() >= u2.toMillis()).toBe(true); // readTime is at/after last update
    });
  });
}

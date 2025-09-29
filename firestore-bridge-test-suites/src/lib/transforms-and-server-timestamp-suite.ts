import {
  DocumentData,
  FieldValue,
  Firestore,
  GeoPoint,
  Timestamp,
} from 'firebase-admin/firestore';
import { ExpectError } from './helpers/expect.error.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function transformsAndServerTimestampsSuite(
  context: FirestoreBridgeTestContext
) {
  // Unique root collection name ensures no collisions/overwrites in emulator
  const COLLECTION_ID = 'Transforms & Server Timestamps';

  describe(COLLECTION_ID, () => {
    let Firestore: Firestore;

    const col = (colId: string) => Firestore.collection(COLLECTION_ID).doc('stub-doc').collection(colId);
    const docRef = (docId: string) => {
      const colId = 'test';

      return col(colId).doc(docId);}

    beforeAll(async () => {
      Firestore = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    describe('serverTimestamp()', () => {
      it('sets server timestamps at top-level and nested fields', async () => {
        const r = docRef('st-top-nested');

        const before = Timestamp.now();
        await r.set({
          top: FieldValue.serverTimestamp(),
          nested: { ts: FieldValue.serverTimestamp() },
        });

        const snap = await r.get();
        const d = snap.data() as DocumentData;

        expect(d.top).toBeInstanceOf(Timestamp);
        expect(d.nested.ts).toBeInstanceOf(Timestamp);

        // Timestamps should be >= the time we wrote (allowing for clock skew)
        const tTop = d.top as Timestamp;
        const tNested = d.nested.ts as Timestamp;
        expect(tTop.toMillis()).toBeGreaterThanOrEqual(before.toMillis());
        expect(tNested.toMillis()).toBeGreaterThanOrEqual(before.toMillis());
      });

      it('overwrites null and creates missing fields', async () => {
        const r = docRef('st-null-missing');
        await r.set({ a: null }); // a is null; b is missing

        await r.set(
          {
            a: FieldValue.serverTimestamp(),
            b: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        const snap = await r.get();
        const d = snap.data() as DocumentData;
        expect(d.a).toBeInstanceOf(Timestamp);
        expect(d.b).toBeInstanceOf(Timestamp);
      });

      it('monotonic across successive updates to the same field', async () => {
        const r = docRef('st-monotonic');

        await r.set({ ts: FieldValue.serverTimestamp() });
        let snap = await r.get();
        let d = snap.data() as DocumentData;
        const first = d.ts as Timestamp;

        // Small delay reduces flakiness on fast hosts
        await new Promise((res) => setTimeout(res, 15));

        await r.set({ ts: FieldValue.serverTimestamp() }, { merge: true });
        snap = await r.get();
        d = snap.data() as DocumentData;
        const second = d.ts as Timestamp;

        // Compare using millis
        expect(second.toMillis()).toBeGreaterThanOrEqual(first.toMillis());
      });

      it('compare-at-read: immediate read returns committed timestamp (no pending local estimate in Admin SDK)', async () => {
        const r = docRef('st-compare-at-read');

        await r.set({ when: FieldValue.serverTimestamp() });
        const snap = await r.get();
        const d = snap.data() as DocumentData;
        expect(d.when).toBeInstanceOf(Timestamp);

        // Sanity: committed value is "around now"
        const approxNow = Timestamp.now().toMillis();
        const committed = (d.when as Timestamp).toMillis();
        expect(Math.abs(approxNow - committed)).toBeLessThan(60_000);
      });
    });

    describe('increment()', () => {
      it('creates missing as operand value; null is treated as missing', async () => {
        const r = docRef('inc-missing-null');

        await r.set({}); // missing
        await r.update({ n: FieldValue.increment(5) });
        let snap = await r.get();
        let d = snap.data() as DocumentData;
        expect(d.n).toBe(5);

        await r.set({ n: null });
        await r.update({ n: FieldValue.increment(7) });
        snap = await r.get();
        d = snap.data() as DocumentData;
        expect(d.n).toBe(7); // treated as if starting from 0
      });

      it('adds negative and fractional increments', async () => {
        const r = docRef('inc-negative-float');
        await r.set({ n: 10 });

        await r.update({ n: FieldValue.increment(-2.5) });
        const snap = await r.get();
        const d = snap.data() as DocumentData;
        expect(d.n).toBeCloseTo(7.5);
      });

      it('increment on existing NaN keeps it NaN', async () => {
        const r = docRef('inc-nan-existing');

        await r.set({ a: Number.NaN });
        await r.update({ a: FieldValue.increment(1) });

        const d = (await r.get()).data() as DocumentData;
        expect(Number.isNaN(d.a)).toBe(true);
      });

      it('increment with NaN operand throws', async () => {
        const r = docRef('inc-nan-operand');

        await r.set({ b: 1 });

        ExpectError.sync(
          () => r.update({ b: FieldValue.increment(Number.NaN) }),
          {
            message:
              'Value for argument "FieldValue.increment()" is not a valid number.',
          }
        );
      });

      it('stays accurate within safe JS integer range', async () => {
        const r = docRef('inc-safe-int');
        const start = Number.MAX_SAFE_INTEGER - 3; // well within safe range
        await r.set({ n: start });

        await r.update({ n: FieldValue.increment(3) });
        const d = (await r.get()).data() as DocumentData;
        expect(d.n).toBe(start + 3);
      });
    });

    describe('arrayUnion() / arrayRemove()', () => {
      it('arrayUnion deduplicates by deep equality, including special types', async () => {
        const r = docRef('arr-union-deep');

        const refA = docRef('target-a');
        const geo = new GeoPoint(-36.8485, 174.7633);
        const ts = Timestamp.fromMillis(1724908800000); // 2024-08-29T00:00:00.000Z example
        const bytesA = Buffer.from([1, 2, 3]);
        const obj = { x: 1, y: { z: 'a' } };

        await r.set({
          arr: [1, 'x', obj, bytesA, geo, ts, refA],
        });

        // Same values (by deep/content equality), plus new unique values
        const bytesB = Buffer.from([1, 2, 3]); // equal content
        await r.update({
          arr: FieldValue.arrayUnion(
            1,
            'x',
            { x: 1, y: { z: 'a' } }, // deep-equal object
            bytesB, // equal bytes
            new GeoPoint(-36.8485, 174.7633), // equal geopoint
            Timestamp.fromMillis(1724908800000), // equal timestamp
            refA, // same ref
            2, // new
            { x: 2 } // new object
          ),
        });

        const d = (await r.get()).data() as DocumentData;
        // Expect only new unique additions (2 and {x:2}) appended
        // Preserve ordering rules: arrayUnion appends only new uniques at the end
        expect(d.arr).toEqual([
          1,
          'x',
          { x: 1, y: { z: 'a' } },
          bytesA,
          geo,
          ts,
          refA,
          2,
          { x: 2 },
        ]);
      });

      it('arrayRemove removes by deep equality, including special types and duplicates', async () => {
        const r = docRef('arr-remove-deep');

        const refB = docRef('target-b');
        const geo = new GeoPoint(1, 2);
        const ts = Timestamp.fromMillis(1000);
        const bytes = Buffer.from([9, 9]);

        await r.set({
          arr: [1, 1, { a: 1 }, { a: 1 }, refB, refB, geo, ts, bytes, 'keep'],
        });

        await r.update({
          arr: FieldValue.arrayRemove(
            1,
            { a: 1 },
            docRef('target-b'), // same path as refB
            new GeoPoint(1, 2),
            Timestamp.fromMillis(1000),
            Buffer.from([9, 9]),
            'not-present'
          ),
        });

        const d = (await r.get()).data() as DocumentData;
        expect(d.arr).toEqual(['keep']);
      });

      it('works on nested arrays via field paths', async () => {
        const r = docRef('arr-nested');

        await r.set({ nested: { a: [] } });

        await r.update({
          'nested.a': FieldValue.arrayUnion(1, 2, 2, 3),
        });

        let d = (await r.get()).data() as DocumentData;
        expect(d.nested.a).toEqual([1, 2, 3]);

        await r.update({
          'nested.a': FieldValue.arrayRemove(2, 99),
        });

        d = (await r.get()).data() as DocumentData;
        expect(d.nested.a).toEqual([1, 3]);
      });
    });

    describe('Transform ordering with set/update masks', () => {
      it('transforms are applied after non-transform field updates within the same write', async () => {
        const r = docRef('order-single-write');

        // Start at known value
        await r.set({ counter: 5, label: 'start' });

        // In a single update, we set a normal field and apply a transform to another
        await r.update({
          label: 'done',
          counter: FieldValue.increment(2),
        });

        const d = (await r.get()).data() as DocumentData;
        expect(d.label).toBe('done');
        expect(d.counter).toBe(7);
      });

      it('mergeFields mask controls whether a transform is applied', async () => {
        const r = docRef('order-merge-mask');

        await r.set({ a: 10, b: 0 });

        // Supply transform on 'a' but exclude it from mergeFields -> not applied
        await r.set(
          {
            a: FieldValue.increment(5),
            b: FieldValue.serverTimestamp(),
          },
          { mergeFields: ['b'] }
        );

        let d = (await r.get()).data() as DocumentData;
        expect(d.a).toBe(10); // unchanged
        expect(d.b).toBeInstanceOf(Timestamp);

        // Now include 'a' in the mask -> transform applied
        await r.set(
          {
            a: FieldValue.increment(5),
          },
          { mergeFields: ['a'] }
        );

        d = (await r.get()).data() as DocumentData;
        expect(d.a).toBe(15);
      });

      it('batch write order: update → transform → update applies in sequence', async () => {
        const r = docRef('order-batch-sequence');

        await r.set({ a: 0, b: 0 });

        const batch = Firestore.batch();
        batch.update(r, { a: 1 });
        batch.update(r, {
          lastModified: FieldValue.serverTimestamp(),
        }); // co-applied as transform
        batch.update(r, { b: 2 });
        await batch.commit();

        const d = (await r.get()).data() as DocumentData;
        expect(d.a).toBe(1);
        expect(d.b).toBe(2);
        expect(d.lastModified).toBeInstanceOf(Timestamp);
      });
    });
  });
}

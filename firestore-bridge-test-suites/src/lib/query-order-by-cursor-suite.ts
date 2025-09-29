import {
  FieldPath,
  Firestore
} from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from './test-context.js';

export function queryOrderByCursorsSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Queries — OrderBy, Cursors, Limits';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);

      // Seed deterministic documents for ordering/cursor tests.
      // We create multiple logical “groups” so queries can be targeted.
      const base = FirestoreDb.collection(COLLECTION_ID);

      // Group A: simple numeric ordering with ties
      //   a1: { group:'A', a: 1,  b: 1 }
      //   a2: { group:'A', a: 1,  b: 2 }
      //   a3: { group:'A', a: 2,  b: 1 }
      //   a4: { group:'A', a: 2,  b: 2 }
      await base.doc('a1').set({ group: 'A', a: 1, b: 1 });
      await base.doc('a2').set({ group: 'A', a: 1, b: 2 });
      await base.doc('a3').set({ group: 'A', a: 2, b: 1 });
      await base.doc('a4').set({ group: 'A', a: 2, b: 2 });

      // Group B: for snapshot cursor tests (distinct values + stable ids)
      // We’ll order by x asc, then id asc as tiebreaker.
      await base.doc('b1').set({ group: 'B', x: 10, tag: 'p' });
      await base.doc('b2').set({ group: 'B', x: 10, tag: 'q' });
      await base.doc('b3').set({ group: 'B', x: 20, tag: 'r' });
      await base.doc('b4').set({ group: 'B', x: 30, tag: 's' });

      // Group C: for endAt/endBefore tests (strings & numbers)
      await base.doc('c1').set({ group: 'C', k: 'alpha', n: 1 });
      await base.doc('c2').set({ group: 'C', k: 'alpha', n: 2 });
      await base.doc('c3').set({ group: 'C', k: 'beta', n: 3 });
      await base.doc('c4').set({ group: 'C', k: 'gamma', n: 4 });

      // Group D: special values ordering: null, NaN, bytes, reference, numbers
      const refA = base.doc('z-ref-a'); // path lexicographically smaller than z-ref-z
      const refZ = base.doc('z-ref-z');
      await refA.set({ anchor: 1 });
      await refZ.set({ anchor: 1 });

      await base.doc('d-null').set({ group: 'D', v: null });
      await base.doc('d-nan').set({ group: 'D', v: Number.NaN });
      await base.doc('d-num-0').set({ group: 'D', v: 0 });
      await base.doc('d-num-1').set({ group: 'D', v: 1 });
      await base.doc('d-bytes-a').set({ group: 'D', v: Uint8Array.from([0x61]) }); // 'a'
      await base.doc('d-bytes-b').set({ group: 'D', v: Uint8Array.from([0x62]) }); // 'b'
      await base.doc('d-ref-a').set({ group: 'D', v: refA });
      await base.doc('d-ref-z').set({ group: 'D', v: refZ });

      // Group E: limit/limitToLast over numeric domain with direction variations
      await base.doc('e1').set({ group: 'E', score: 1 });
      await base.doc('e2').set({ group: 'E', score: 2 });
      await base.doc('e3').set({ group: 'E', score: 3 });
      await base.doc('e4').set({ group: 'E', score: 4 });
      await base.doc('e5').set({ group: 'E', score: 5 });
    });

    afterAll(async () => {
      await context.tearDown();
    });

    function ids(docs: FirebaseFirestore.QueryDocumentSnapshot[]) {
      return docs.map((d) => d.id);
    }

    it('single-field orderBy (asc & desc) with numeric field', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'A');

      const asc = await base.orderBy('a', 'asc').get();
      expect(ids(asc.docs)).toEqual(['a1', 'a2', 'a3', 'a4']);

      const desc = await base.orderBy('a', 'desc').get();
      expect(ids(desc.docs)).toEqual(['a4', 'a3', 'a2', 'a1']);
    });

    it('multi-field orderBy enforces tiebreakers deterministically', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'A');

      // Primary: a asc; Secondary: b desc
      const q = await base.orderBy('a', 'asc').orderBy('b', 'desc').get();
      expect(ids(q.docs)).toEqual(['a2', 'a1', 'a4', 'a3']); // (1,2) (1,1) (2,2) (2,1)
    });

    it('startAt / startAfter with explicit values (multi-field)', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'A');
      const ordered = base.orderBy('a', 'asc').orderBy('b', 'asc');

      // Full ascending: a1(1,1), a2(1,2), a3(2,1), a4(2,2)
      const at = await ordered.startAt(1, 2).get();
      expect(ids(at.docs)).toEqual(['a2', 'a3', 'a4']); // inclusive of (1,2)

      const after = await ordered.startAfter(1, 2).get();
      expect(ids(after.docs)).toEqual(['a3', 'a4']); // exclusive of (1,2)
    });

    it('endAt / endBefore with explicit values (multi-field)', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'C');
      const ordered = base.orderBy('k', 'asc').orderBy('n', 'asc');
      // Order: c1(alpha,1), c2(alpha,2), c3(beta,3), c4(gamma,4)

      const at = await ordered.endAt('beta', 3).get();
      expect(ids(at.docs)).toEqual(['c1', 'c2', 'c3']); // inclusive

      const before = await ordered.endBefore('beta', 3).get();
      expect(ids(before.docs)).toEqual(['c1', 'c2']); // exclusive
    });

    it('startAt / startAfter using a DocumentSnapshot', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'B');
      const ordered = base.orderBy('x', 'asc').orderBy(FieldPath.documentId(), 'asc');

      // Snap for b2 (x=10)
      const snapB2 = await FirestoreDb
        .collection(COLLECTION_ID)
        .doc('b2')
        .get();

      // startAt(snap) includes b2 and later
      const at = await ordered.startAt(snapB2).get();
      expect(ids(at.docs)).toEqual(['b2', 'b3', 'b4']);

      // startAfter(snap) excludes b2
      const after = await ordered.startAfter(snapB2).get();
      expect(ids(after.docs)).toEqual(['b3', 'b4']);
    });

    it('endAt / endBefore using a DocumentSnapshot', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'B');
      const ordered = base.orderBy('x', 'asc').orderBy(FieldPath.documentId(), 'asc');

      const snapB3 = await FirestoreDb.collection(COLLECTION_ID).doc('b3').get();

      // endAt(snap) includes b3 and earlier
      const at = await ordered.endAt(snapB3).get();
      expect(ids(at.docs)).toEqual(['b1', 'b2', 'b3']);

      // endBefore(snap) excludes b3
      const before = await ordered.endBefore(snapB3).get();
      expect(ids(before.docs)).toEqual(['b1', 'b2']);
    });

    it('limit (with direction variations) returns leading segment', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'E');

      const asc2 = await base.orderBy('score', 'asc').limit(2).get();
      expect(ids(asc2.docs)).toEqual(['e1', 'e2']);

      const desc2 = await base.orderBy('score', 'desc').limit(2).get();
      expect(ids(desc2.docs)).toEqual(['e5', 'e4']);
    });

    it('limitToLast returns trailing segment in the query’s order', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'E');

      // Note: limitToLast requires an explicit orderBy.
      const last3Asc = await base.orderBy('score', 'asc').limitToLast(3).get();
      // The trailing 3 of the ascending-ordered set are e3,e4,e5 (returned in ascending order).
      expect(ids(last3Asc.docs)).toEqual(['e3', 'e4', 'e5']);

      const last2Desc = await base.orderBy('score', 'desc').limitToLast(2).get();
      // Descending full order: e5,e4,e3,e2,e1 — trailing 2 are e2,e1 (returned in DESC order).
      expect(ids(last2Desc.docs)).toEqual(['e2', 'e1']);
    });

    it('ordering of special values: null, NaN, bytes, references (ascending)', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'D');

      // Ascending by 'v'. Firestore’s canonical order across types is deterministic.
      // For the types we seeded here, the expected ascending order is:
      //   null  <  NaN  <  numbers  <  bytes  <  references
      const q = await base.orderBy('v', 'asc').get();
      expect(ids(q.docs)).toEqual([
        'd-null',     // nulls first
        'd-nan',      // NaN precedes other numbers
        'd-num-0',    // numbers (0, then 1)
        'd-num-1',
        'd-bytes-a',  // bytes: lexicographic by unsigned byte sequence
        'd-bytes-b',
        'd-ref-a',    // references: same DB; ordered by path lexicographically
        'd-ref-z',
      ]);
    });

    it('reverse order of special values (descending)', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'D');

      const q = await base.orderBy('v', 'desc').get();
      expect(ids(q.docs)).toEqual([
        'd-ref-z',
        'd-ref-a',
        'd-bytes-b',
        'd-bytes-a',
        'd-num-1',
        'd-num-0',
        'd-nan',
        'd-null',
      ]);
    });

    it('cursors respect composite ordering + limitToLast interplay', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'A');
      // Full asc by (a asc, b asc): a1(1,1), a2(1,2), a3(2,1), a4(2,2)
      const ordered = base.orderBy('a', 'asc').orderBy('b', 'asc');

      // Take a tail slice starting at (2,1) inclusive, then keep only the last 2 of that tail
      const tail = await ordered.startAt(2, 1).limitToLast(2).get();
      // Tail is [a3, a4]; last 2 of that are still [a3, a4], preserving order.
      expect(ids(tail.docs)).toEqual(['a3', 'a4']);
    });

    it('startAfter + endAt combine for interior slices', async () => {
      const base = FirestoreDb.collection(COLLECTION_ID).where('group', '==', 'C');
      const ordered = base.orderBy('k', 'asc').orderBy('n', 'asc');
      // Full order: c1(alpha,1), c2(alpha,2), c3(beta,3), c4(gamma,4)

      const slice = await ordered.startAfter('alpha', 1).endAt('gamma', 4).get();
      expect(ids(slice.docs)).toEqual(['c2', 'c3', 'c4']);
    });
  });
}

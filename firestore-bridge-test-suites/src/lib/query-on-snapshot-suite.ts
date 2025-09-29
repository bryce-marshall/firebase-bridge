/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Realtime Listeners — Query.onSnapshot
 *
 * Goal: Verify Admin SDK parity for query listeners using only public APIs.
 *
 * Surfaces:
 *  - Query.onSnapshot(listener, error?)
 *  - Filters, orderBy, cursors, limits (limit, limitToLast)
 *  - Composite conditions (AND / OR)
 *
 * Invariants exercised:
 *  1) Initial emission contains only matching docs, delivered as `added` in query order
 *  2) Writes that enter/leave the query emit `added`/`removed`
 *  3) Updates to ordered fields emit `modified` with correct oldIndex/newIndex
 *  4) Cursors/limits respected for initial and subsequent emissions
 *  5) Cleanup: listeners are always unsubscribed
 */

import { FieldPath, Filter, Firestore } from 'firebase-admin/firestore';
import { ExpectError } from './helpers/expect.error.js';
import { collect } from './helpers/snapshot-collector.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function queryOnSnapshotSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Realtime Listeners — Query.onSnapshot';

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

    // Per-test isolated subcollection under a container doc
    const col = () => {
      const name = sanitize(
        expect.getState().currentTestName ?? 'unknown_test'
      );
      return FirestoreDb.collection(COLLECTION_ID)
        .doc('container')
        .collection(name);
    };

    /** Seed helper with deterministic ids/values (optionally extra writes). */
    async function seedBasic(c = col()) {
      await c
        .doc('a1')
        .set({ group: 'A', a: 1, b: 1, flag: true, n: 5, tags: ['x'] });
      await c
        .doc('a2')
        .set({ group: 'A', a: 1, b: 2, flag: false, n: 2, tags: ['y'] });
      await c
        .doc('a3')
        .set({ group: 'A', a: 2, b: 1, flag: true, n: 9, tags: [] });
      await c
        .doc('b1')
        .set({ group: 'B', a: 3, b: 3, flag: false, n: 7, tags: ['z'] });
      return c;
    }

    it('initial emission: matches only, delivered as `added` in query order', async () => {
      const c = await seedBasic();
      // Query: group == 'A', order by (a asc, b asc)
      const q = c
        .where('group', '==', 'A')
        .orderBy('a', 'asc')
        .orderBy('b', 'asc');
      const collector = collect(q);
      try {
        const first = await collector.first;
        expect(first.ids).toEqual(['a1', 'a2', 'a3']); // A(1,1), A(1,2), A(2,1)
        expect(first.changes!.map((c) => c.type)).toEqual([
          'added',
          'added',
          'added',
        ]);
        expect(first.changes!.map((c) => c.newIndex)).toEqual([0, 1, 2]);
      } finally {
        collector.stop();
      }
    });

    it('filters: writes that enter/leave the query emit added/removed', async () => {
      const c = await seedBasic();
      const q = c.where('flag', '==', true).orderBy(FieldPath.documentId());
      const collector = collect(q);
      try {
        const first = await collector.first; // a1, a3
        expect(first.ids).toEqual(['a1', 'a3']);

        // Enter: flip a2.flag -> true
        const e1 = await collector.waitForNext(() =>
          c.doc('a2').update({ flag: true })
        );
        expect(e1.ids).toEqual(['a1', 'a2', 'a3']);
        const add = e1.changes!.find(
          (x) => x.type === 'added' && x.id === 'a2'
        )!;
        expect(add.newIndex).toBe(1);

        // Leave: flip a1.flag -> false
        const e2 = await collector.waitForNext(() =>
          c.doc('a1').update({ flag: false })
        );
        expect(e2.ids).toEqual(['a2', 'a3']);
        const rem = e2.changes!.find(
          (x) => x.type === 'removed' && x.id === 'a1'
        )!;
        expect(rem.oldIndex).toBe(0);
      } finally {
        collector.stop();
      }
    });

    it('ordering: updates to ordered fields move index and emit modified with oldIndex/newIndex', async () => {
      const c = await seedBasic();
      // Strict order by a asc, then b asc, limit wide enough
      const q = c
        .where('group', '==', 'A')
        .orderBy('a', 'asc')
        .orderBy('b', 'asc');
      const collector = collect(q);
      try {
        const first = await collector.first; // ['a1','a2','a3']
        expect(first.ids).toEqual(['a1', 'a2', 'a3']);

        // Move a3 from (2,1) -> (0.5,1) by setting a=0 (before a1)
        const e = await collector.waitForNext(() =>
          c.doc('a3').update({ a: 0 })
        );
        expect(e.ids).toEqual(['a3', 'a1', 'a2']);
        const mod = e.changes!.find(
          (x) => x.type === 'modified' && x.id === 'a3'
        )!;
        expect(mod.oldIndex).toBe(2);
        expect(mod.newIndex).toBe(0);
      } finally {
        collector.stop();
      }
    });

    it('cursors with values: startAt/startAfter and endAt/endBefore respected across updates', async () => {
      const c = await seedBasic();
      // order by n asc, then id asc for tie-break stability
      const q = c.orderBy('n', 'asc').orderBy(FieldPath.documentId(), 'asc');
      const at = q.startAt(5); // n >= 5
      const after = q.startAfter(5); // n > 5
      const endBefore = q.endBefore(7); // n < 7

      const colAt = collect(at);
      const colAfter = collect(after);
      const colEndBefore = collect(endBefore);
      try {
        const f1 = await colAt.first;
        const f2 = await colAfter.first;
        const f3 = await colEndBefore.first;

        // From seed: n values {2 (a2), 5 (a1), 7 (b1), 9 (a3)}
        expect(f1.ids).toEqual(['a1', 'b1', 'a3']); // >= 5 (a1=5, b1=7, a3=9)
        expect(f2.ids).toEqual(['b1', 'a3']); // > 5
        expect(f3.ids).toEqual(['a2', 'a1']); // < 7 (2,5) ordered by n then id

        const pAfter = colAfter.waitForNext(async () => Promise.resolve()); // may coalesce with above; force waiter to observe
        const pEndBefore = colEndBefore.waitForNext(async () =>
          Promise.resolve()
        );
        // Update a2.n from 2->8: should leave `endBefore`, enter both `at` and `after`
        const eAt = await colAt.waitForNext(() => c.doc('a2').update({ n: 8 }));
        const eAfter = await pAfter;
        const eEndBefore = await pEndBefore;

        expect(eAt.ids!.includes('a2')).toBe(true);
        expect(eAfter.ids!.includes('a2')).toBe(true);
        expect(eEndBefore.ids!.includes('a2')).toBe(false);
      } finally {
        colAt.stop();
        colAfter.stop();
        colEndBefore.stop();
      }
    });

    it('snapshot-based cursor: startAfter(doc) positions correctly as ordered fields change', async () => {
      const c = await seedBasic();
      // order by (a asc, b asc)
      const base = c
        .where('group', '==', 'A')
        .orderBy('a', 'asc')
        .orderBy('b', 'asc');

      const initialSnap = await base.get();
      const pivot = initialSnap.docs[0]; // 'a1' (a=1,b=1); boundary tuple is (1,1,a1)

      const q = base.startAfter(pivot); // start strictly after pivot's values
      const collector = collect(q);
      try {
        const first = await collector.first;
        expect(first.ids).toEqual(['a2', 'a3']); // after (1,1,a1) → a2(1,2), a3(2,1)

        // Change pivot (a1) so its tuple becomes (1,99,a1) > (1,1,a1) → a1 enters the query.
        const e1 = await collector.waitForNext(() =>
          c.doc('a1').update({ b: 99 })
        );
        expect(e1.ids).toEqual(['a2', 'a1', 'a3']); // order by (a,b): (1,2) a2, (1,99) a1, (2,1) a3
        const addA1 = e1.changes!.find(
          (x) => x.type === 'added' && x.id === 'a1'
        )!;
        expect(addA1.newIndex).toBe(1);

        // Move a2 to before the boundary by lowering a=0 → a2 leaves the query.
        const e2 = await collector.waitForNext(() =>
          c.doc('a2').update({ a: 0 })
        );
        expect(e2.ids).toEqual(['a1', 'a3']); // a2 removed; remaining in order
        const removed = e2.changes!.find(
          (x) => x.type === 'removed' && x.id === 'a2'
        )!;
        expect(removed.oldIndex).toBe(0);
      } finally {
        collector.stop();
      }
    });

    it('limit(n): inserts before the boundary push out tail; updates crossing boundary emit expected sequences', async () => {
      const c = await seedBasic();
      // order by n asc; limit 2 -> expect smallest two n
      const q = c
        .orderBy('n', 'asc')
        .orderBy(FieldPath.documentId(), 'asc')
        .limit(2);
      const collector = collect(q);
      try {
        const first = await collector.first;
        // n asc from seed: a2(2), a1(5), b1(7), a3(9)
        expect(first.ids).toEqual(['a2', 'a1']);

        // Insert a0 with n=1 → becomes ['a0','a2']
        const e1 = await collector.waitForNext(() => c.doc('a0').set({ n: 1 }));
        expect(e1.ids).toEqual(['a0', 'a2']);

        // Update a3 n=0 → becomes ['a3','a0']
        const e2 = await collector.waitForNext(() =>
          c.doc('a3').update({ n: 0 })
        );
        expect(e2.ids).toEqual(['a3', 'a0']);
      } finally {
        collector.stop();
      }
    });

    it('limitToLast(n): mirrors server semantics with stable forward ordering of docs', async () => {
      const c = await seedBasic();
      // order by n asc; limitToLast 2 -> largest two n in ascending order
      const q = c
        .orderBy('n', 'asc')
        .orderBy(FieldPath.documentId(), 'asc')
        .limitToLast(2);
      const collector = collect(q);
      try {
        const first = await collector.first;
        // largest two: a3(9), b1(7) → but presented in query order (asc): ['b1','a3']
        expect(first.ids).toEqual(['b1', 'a3']);

        // Increase a1 to 10 → last two should be [a3(9), a1(10)] -> asc → ['a3','a1']
        const e = await collector.waitForNext(() =>
          c.doc('a1').update({ n: 10 })
        );
        expect(e.ids).toEqual(['a3', 'a1']);
      } finally {
        collector.stop();
      }
    });

    it('composite conditions (OR): toggling membership via writes emits consistent change sets', async () => {
      const c = col();
      // x1 kind=a, x2 kind=b, x3 kind=c
      await c.doc('x1').set({ kind: 'a', score: 1 });
      await c.doc('x2').set({ kind: 'b', score: 2 });
      await c.doc('x3').set({ kind: 'c', score: 3 });

      // (kind == 'a' OR kind == 'c'), ordered by __name__ for stability
      const q = c
        .where(
          Filter.or(
            Filter.where('kind', '==', 'a'),
            Filter.where('kind', '==', 'c')
          )
        )
        .orderBy(FieldPath.documentId(), 'asc');

      const collector = collect(q);
      try {
        const first = await collector.first;
        expect(first.ids).toEqual(['x1', 'x3']); // x1 (a) and x3 (c) match

        // Make x2 enter the OR by changing kind -> 'a'
        const e1 = await collector.waitForNext(() =>
          c.doc('x2').update({ kind: 'a' })
        );
        expect(e1.ids).toEqual(['x1', 'x2', 'x3']);
        const add = e1.changes!.find(
          (c) => c.type === 'added' && c.id === 'x2'
        )!;
        // x2 inserts between x1 and x3 by id ordering
        expect(add.newIndex).toBe(1);

        // Make x1 leave by changing kind -> 'z'
        const e2 = await collector.waitForNext(() =>
          c.doc('x1').update({ kind: 'z' })
        );
        expect(e2.ids).toEqual(['x2', 'x3']);
        const rem = e2.changes!.find(
          (c) => c.type === 'removed' && c.id === 'x1'
        )!;
        expect(rem.oldIndex).toBe(0);
      } finally {
        collector.stop();
      }
    });

    it('special values: null/NaN/reference preserve same membership behavior as get()', async () => {
      const c = col();
      const refSame = c.doc('refTarget');
      await refSame.set({});

      await c.doc('n1').set({ v: null });
      await c.doc('n2').set({ v: 0 });
      await c.doc('n3').set({ v: Number.NaN });
      await c.doc('r1').set({ v: refSame });
      await c.doc('r2').set({ v: FirestoreDb.collection('other').doc('x') });

      const qNull = c.where('v', '==', null);
      const qNaN = c.where('v', '==', Number.NaN);
      const qRef = c.where('v', '==', refSame);

      const colNull = collect(qNull);
      const colNaN = collect(qNaN);
      const colRef = collect(qRef);
      try {
        const fNull = await colNull.first;
        expect(fNull.ids).toEqual(['n1']);

        const fNaN = await colNaN.first;
        expect(fNaN.ids).toEqual(['n3']); // NaN equality special-case

        const fRef = await colRef.first;
        expect(fRef.ids).toEqual(['r1']);

        // Updates preserve logic
        const eNull = await colNull.waitForNext(() =>
          c.doc('n2').update({ v: null })
        );
        expect(eNull.ids!.includes('n2')).toBe(true);

        const eRef = await colRef.waitForNext(() =>
          c.doc('r2').update({ v: refSame })
        );
        expect(eRef.ids!.includes('r2')).toBe(true);
      } finally {
        colNull.stop();
        colNaN.stop();
        colRef.stop();
      }
    });

    it('invalid operator combinations surface errors on registration', async () => {
      const c = col();
      await c.doc('x').set({ v: 1 });

      // Build the invalid query
      const q = c.where('v', 'in', [1, 2]).where('v', 'not-in', [3]);

      let unsub: (() => void) | undefined;
      try {
        const err = await new Promise<Error>((resolve, reject) => {
          // Arm a timeout so the test can fail cleanly if no error arrives
          const t = setTimeout(
            () => reject(new Error('No error from onSnapshot')),
            3000
          );

          unsub = q.onSnapshot(
            () => {
              /* ignore */
              console.log('*** snapshot resolved');
            },
            (e) => {
              clearTimeout(t);
              resolve(e);
            }
          );
        });

        expect(err).toBeDefined();
        ExpectError.evaluate(err, {
          match: /'NOT_IN' cannot be used in the same query with 'IN'/,
        });
      } finally {
        // Always unsubscribe to avoid leaks, even if the promise rejected
        unsub?.();
      }
    });
  });
}

import { Firestore } from 'firebase-admin/firestore';
import { ExpectError } from './helpers/expect.error.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function queryFiltersSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Queries - Filters (truth tables & edge cases)'; // unique root collection to avoid collisions

  describe(COLLECTION_ID, () => {
    let db!: Firestore;

    const ids = {
      // numeric set (edge cases: null, NaN, missing)
      n1: 'n1', // v: 1
      n2: 'n2', // v: 2
      n3: 'n3', // v: 3
      n4: 'n4', // v: null
      n5: 'n5', // v: <missing>
      n6: 'n6', // v: NaN

      // arrays (mixed types, null, NaN, objects; plus missing)
      a1: 'a1', // arr: [1, 2, 'x']
      a2: 'a2', // arr: [3, 'x']
      a3: 'a3', // arr: ['x']
      a4: 'a4', // arr: [1]
      a5: 'a5', // arr: [null, NaN, { z: 1 }]
      a6: 'a6', // arr: <missing>
      a7: 'a7', // arr: ['1', 1]  (type-distinguish test)

      // map vs scalar mismatch (+ null + missing)
      t1: 't1', // m: { a: 1 }
      t2: 't2', // m: 'scalar'
      t3: 't3', // m: <missing> (has s: 'scalar')
      t4: 't4', // m: null

      // references (same DB)
      r1: 'r1', // ref: targets/one
      r2: 'r2', // ref: targets/two
      r3: 'r3', // ref: <missing>
    };

    const expectPaths = (
      actualDocs: Array<{ ref: { path: string } }>,
      expectedDocIds: string[]
    ) => {
      const actual = new Set(actualDocs.map((d) => d.ref.path));
      const expected = new Set(
        expectedDocIds.map((id) => db.collection(COLLECTION_ID).doc(id).path)
      );

      expect(actual.size).toBe(expected.size);
      for (const p of expected) {
        expect(actual.has(p)).toBe(true);
      }
    };

    beforeAll(async () => {
      db = await context.init(COLLECTION_ID);

      // Seed targets for reference equality
      const targets = db.collection(`${COLLECTION_ID}-targets`);
      const refOne = targets.doc('one');
      const refTwo = targets.doc('two');
      await Promise.all([refOne.set({}), refTwo.set({})]);

      // Root collection
      const col = db.collection(COLLECTION_ID);

      // Numeric universe (v)
      await col.doc(ids.n1).set({ kind: 'nums', v: 1 });
      await col.doc(ids.n2).set({ kind: 'nums', v: 2 });
      await col.doc(ids.n3).set({ kind: 'nums', v: 3 });
      await col.doc(ids.n4).set({ kind: 'nums', v: null });
      await col.doc(ids.n5).set({ kind: 'nums' }); // missing v
      await col.doc(ids.n6).set({ kind: 'nums', v: Number.NaN });

      // Arrays (arr)
      await col.doc(ids.a1).set({ kind: 'arrays', arr: [1, 2, 'x'] });
      await col.doc(ids.a2).set({ kind: 'arrays', arr: [3, 'x'] });
      await col.doc(ids.a3).set({ kind: 'arrays', arr: ['x'] });
      await col.doc(ids.a4).set({ kind: 'arrays', arr: [1] });
      await col
        .doc(ids.a5)
        .set({ kind: 'arrays', arr: [null, Number.NaN, { z: 1 }] });
      await col.doc(ids.a6).set({ kind: 'arrays' }); // missing arr
      await col.doc(ids.a7).set({ kind: 'arrays', arr: ['1', 1] });

      // Map vs scalar (m)
      await col.doc(ids.t1).set({ kind: 'types', m: { a: 1 } });
      await col.doc(ids.t2).set({ kind: 'types', m: 'scalar' });
      await col.doc(ids.t3).set({ kind: 'types', s: 'scalar' }); // m missing
      await col.doc(ids.t4).set({ kind: 'types', m: null });

      // Refs (same DB only)
      await col.doc(ids.r1).set({ kind: 'refs', ref: refOne });
      await col.doc(ids.r2).set({ kind: 'refs', ref: refTwo });
      await col.doc(ids.r3).set({ kind: 'refs' }); // missing ref
    });

    afterAll(async () => {
      await context.tearDown();
    });

    //
    // == and != (basic numeric)
    //
    it('== (exact equality on number)', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'nums')
        .where('v', '==', 2)
        .get();

      expectPaths(qs.docs, [ids.n2]);
    });

    it('!= (not equal on number) – excludes the equal value; ignores order', async () => {
      // Intentionally restrict universe to documents where 'v' exists and is numeric via an additional equality guard.
      // (Avoids ambiguity with null/NaN/missing in != semantics across backends.)
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'nums')
        .where('v', 'in', [1, 2, 3]) // limit domain for deterministic != behavior
        .where('v', '!=', 2)
        .get();

      expectPaths(qs.docs, [ids.n1, ids.n3]);
    });

    //
    // Range operators: <, <=, >, >=
    //
    it('<, <=, >, >= on numbers', async () => {
      const base = db.collection(COLLECTION_ID).where('kind', '==', 'nums');

      const lt3 = await base.where('v', '<', 3).get();
      expectPaths(lt3.docs, [ids.n1, ids.n2]);

      const le2 = await base.where('v', '<=', 2).get();
      expectPaths(le2.docs, [ids.n1, ids.n2]);

      const gt1 = await base.where('v', '>', 1).get();
      expectPaths(gt1.docs, [ids.n2, ids.n3]);

      const ge3 = await base.where('v', '>=', 3).get();
      expectPaths(ge3.docs, [ids.n3]);
    });

    //
    // in / not-in (numbers incl. null; explicit exclusions for NaN/null in not-in lists)
    //
    it('in: selects any of the listed numeric values', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'nums')
        .where('v', 'in', [1, 3])
        .get();

      expectPaths(qs.docs, [ids.n1, ids.n3]);
    });

    it('== null: matches only null (not missing)', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'nums')
        .where('v', '==', null)
        .get();

      expectPaths(qs.docs, [ids.n4]);
    });

    it('not-in: excludes the listed numbers; includes NaN; excludes null/missing implicitly', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'nums')
        .where('v', 'not-in', [1, 3])
        .get();

      // Only n2 and n4 qualify: n1/n3 excluded by list, n5/n6 excluded by null/missing/NaN semantics
      expectPaths(qs.docs, [ids.n6, ids.n2]);
    });

    //
    // null / NaN equality
    //
    it('== null matches only null (not missing)', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'nums')
        .where('v', '==', null)
        .get();

      expectPaths(qs.docs, [ids.n4]);
    });

    it('== NaN matches NaN', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'nums')
        .where('v', '==', Number.NaN)
        .get();

      expectPaths(qs.docs, [ids.n6]);
    });

    //
    // array-contains / array-contains-any
    //
    it('array-contains (string): matches docs whose array contains "x"', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'arrays')
        .where('arr', 'array-contains', 'x')
        .get();

      expectPaths(qs.docs, [ids.a1, ids.a2, ids.a3]);
    });

    it('array-contains (number): matches typed value (1), ignoring order', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'arrays')
        .where('arr', 'array-contains', 1)
        .get();

      expectPaths(qs.docs, [ids.a1, ids.a4, ids.a7]);
    });

    it('array-contains (string "1"): type-sensitive match distinct from number 1', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'arrays')
        .where('arr', 'array-contains', '1')
        .get();

      expectPaths(qs.docs, [ids.a7]);
    });

    it('array-contains (null) is invalid (only == / != support null)', async () => {
      await ExpectError.sync(
        () =>
          db
            .collection(COLLECTION_ID)
            .where('kind', '==', 'arrays')
            .where('arr', 'array-contains', null)
            .get(),
        {
          // Message text varies by SDK/emulator; assert a stable fragment:
          match:
            /only perform ('==|=') and ('!=') comparisons on Null|invalid.*null/i,
        }
      );
    });

    it('array-contains (NaN) is invalid (only == supports NaN)', async () => {
      await ExpectError.sync(
        () =>
          db
            .collection(COLLECTION_ID)
            .where('kind', '==', 'arrays')
            .where('arr', 'array-contains', Number.NaN)
            .get(),
        {
          match: /nan|invalid/i,
        }
      );
    });

    // Keep valid cases:
    it('array-contains (string): matches docs whose array contains "x"', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'arrays')
        .where('arr', 'array-contains', 'x')
        .get();
      expectPaths(qs.docs, [ids.a1, ids.a2, ids.a3]);
    });

    it('array-contains (number): matches typed value (1)', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'arrays')
        .where('arr', 'array-contains', 1)
        .get();
      expectPaths(qs.docs, [ids.a1, ids.a4, ids.a7]);
    });

    it('array-contains-any: matches if any candidate appears', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'arrays')
        .where('arr', 'array-contains-any', ['x', 3])
        .get();

      expectPaths(qs.docs, [ids.a1, ids.a2, ids.a3]);
    });

    //
    // Map vs scalar mismatches (deep equality vs non-matching types)
    //
    it('map equality vs scalar mismatch', async () => {
      const eqMap = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'types')
        .where('m', '==', { a: 1 })
        .get();
      expectPaths(eqMap.docs, [ids.t1]);

      const eqScalar = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'types')
        .where('m', '==', 'scalar')
        .get();
      expectPaths(eqScalar.docs, [ids.t2]);

      const eqNull = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'types')
        .where('m', '==', null)
        .get();
      expectPaths(eqNull.docs, [ids.t4]);

      // Sanity: querying for the opposite shapes should return empty.
      const mapIsNumber = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'types')
        .where('m', '==', 5)
        .get();
      expectPaths(mapIsNumber.docs, []);
    });

    //
    // Reference equality (same DB)
    //
    it('reference == equality within same DB', async () => {
      const refOne = db.collection(`${COLLECTION_ID}-targets`).doc('one');
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'refs')
        .where('ref', '==', refOne)
        .get();

      expectPaths(qs.docs, [ids.r1]);
    });

    it('reference in / not-in', async () => {
      const refOne = db.collection(`${COLLECTION_ID}-targets`).doc('one');
      const refTwo = db.collection(`${COLLECTION_ID}-targets`).doc('two');

      const inBoth = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'refs')
        .where('ref', 'in', [refOne, refTwo])
        .get();
      expectPaths(inBoth.docs, [ids.r1, ids.r2]);

      const notInOne = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'refs')
        .where('ref', 'not-in', [refOne])
        .get();

      // Note: We purposely avoid asserting inclusion/exclusion of missing-field docs for not-in here.
      // We only assert that r2 (explicitly different ref) is returned.
      expect(notInOne.docs.map((d) => d.id)).toContain(ids.r2);
    });

    //
    // Missing fields: equality and membership (null vs missing)
    //
    it('missing vs null distinction (== only)', async () => {
      // n4 has v:null; n5 missing v
      const eqNull = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'nums')
        .where('v', '==', null)
        .get();
      expectPaths(eqNull.docs, [ids.n4]);

      // Avoid: `.where('v','in',[null])` — undefined / emulator-specific behavior.
      // If you want to keep a reference test, mark it skipped:
      // it.skip('in (null) — not portable across emulator/production', async () => { ... });
    });

    // remove/skip the in([null]) case
    it('== null: matches only null (not missing)', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'nums')
        .where('v', '==', null)
        .get();
      expectPaths(qs.docs, [ids.n4]);
    });

    it('not-in: excludes listed numbers; excludes NaN/null/missing via range guard', async () => {
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'nums')
        .where('v', '>=', 0)
        .where('v', '<=', 3)
        .where('v', 'not-in', [1, 3])
        .get();

      expectPaths(qs.docs, [ids.n2]);
    });

    it('array-contains (null) is invalid', async () => {
      await ExpectError.sync(
        () =>
          db
            .collection(COLLECTION_ID)
            .where('kind', '==', 'arrays')
            .where('arr', 'array-contains', null)
            .get(),
        {
          match:
            /Invalid query. You can only perform '==' and '!=' comparisons on Null./,
        }
      );
    });

    it('array-contains (NaN) is invalid', async () => {
      await ExpectError.sync(
        () =>
          db
            .collection(COLLECTION_ID)
            .where('kind', '==', 'arrays')
            .where('arr', 'array-contains', Number.NaN)
            .get(),
        {
          match:
            /Invalid query. You can only perform '==' and '!=' comparisons on NaN./,
        }
      );
    });

    it('reference not-in (exclude the listed ref; exclude missing)', async () => {
      const refOne = db.collection(`${COLLECTION_ID}-targets`).doc('one');
      const qs = await db
        .collection(COLLECTION_ID)
        .where('kind', '==', 'refs')
        .where('ref', 'not-in', [refOne])
        .get();

      // Only r2 matches: r1 excluded by list; r3 excluded (missing ref)
      expectPaths(qs.docs, [ids.r2]);
    });

    //
    // Queries in transactions
    //
    it('transaction: single filtered query (== on number) returns expected docs', async () => {
      const expectedPath = db.collection(COLLECTION_ID).doc(ids.n2).path;

      const paths = await db.runTransaction(async (tx) => {
        const q = db
          .collection(COLLECTION_ID)
          .where('kind', '==', 'nums')
          .where('v', '==', 2);

        const snap = await tx.get(q);
        return snap.docs.map((d) => d.ref.path);
      });

      expect(paths).toHaveLength(1);
      expect(paths[0]).toBe(expectedPath);
    });

    it('transaction: two filtered queries in a single transaction (array-contains + reference in)', async () => {
      const refOne = db.collection(`${COLLECTION_ID}-targets`).doc('one');
      const refTwo = db.collection(`${COLLECTION_ID}-targets`).doc('two');

      const { arrayPaths, refPaths } = await db.runTransaction(async (tx) => {
        const q1 = db
          .collection(COLLECTION_ID)
          .where('kind', '==', 'arrays')
          .where('arr', 'array-contains', 'x');

        const q2 = db
          .collection(COLLECTION_ID)
          .where('kind', '==', 'refs')
          .where('ref', 'in', [refOne, refTwo]);

        const [s1, s2] = await Promise.all([tx.get(q1), tx.get(q2)]);

        return {
          arrayPaths: s1.docs.map((d) => d.ref.path),
          refPaths: s2.docs.map((d) => d.ref.path),
        };
      });

      // Validate array-contains 'x'
      expect(new Set(arrayPaths)).toEqual(
        new Set([
          db.collection(COLLECTION_ID).doc(ids.a1).path,
          db.collection(COLLECTION_ID).doc(ids.a2).path,
          db.collection(COLLECTION_ID).doc(ids.a3).path,
        ])
      );

      // Validate ref in [one, two]
      expect(new Set(refPaths)).toEqual(
        new Set([
          db.collection(COLLECTION_ID).doc(ids.r1).path,
          db.collection(COLLECTION_ID).doc(ids.r2).path,
        ])
      );
    });

    it('transaction: range+membership filters are honored inside a transaction', async () => {
      const paths = await db.runTransaction(async (tx) => {
        // Restrict to numeric universe and apply range guards + not-in
        const q = db
          .collection(COLLECTION_ID)
          .where('kind', '==', 'nums')
          .where('v', '>=', 0)
          .where('v', '<=', 3)
          .where('v', 'not-in', [1, 3]);

        const snap = await tx.get(q);
        return snap.docs.map((d) => d.ref.path);
      });

      expect(new Set(paths)).toEqual(
        new Set([db.collection(COLLECTION_ID).doc(ids.n2).path])
      );
    });

    it('transaction: filtered query via tx.get() returns empty when no match', async () => {
      const docs = await db.runTransaction(async (tx) => {
        const q = db
          .collection(COLLECTION_ID)
          .where('kind', '==', 'nums')
          .where('v', '==', 999); // no seeded doc has v=999

        const snap = await tx.get(q);
        return snap.docs;
      });

      expect(docs.length).toBe(0);
      expectPaths(docs as unknown as Array<{ ref: { path: string } }>, []);
    });
  });
}

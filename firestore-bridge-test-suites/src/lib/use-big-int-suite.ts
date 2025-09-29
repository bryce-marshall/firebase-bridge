/**
 * Firestore Settings — `useBigInt` Fidelity Suite
 *
 * Goal: Verify that integer fields are surfaced according to the
 *       Firestore Admin SDK `useBigInt` setting, using only public APIs.
 *
 * Surfaces covered:
 *  - Initialization with { useBigInt: false } (default) and { useBigInt: true }
 *  - Write/read of integers at safe and unsafe (64-bit) ranges
 *  - BigInt read shape across primitives, arrays, and maps when useBigInt === true
 *  - Converters (withConverter) receive types aligned with setting
 *  - Equality queries with integer fields
 */

import { DocumentData, Firestore } from 'firebase-admin/firestore';

import { isDocDataEqual, normalizeDocData } from './helpers/document-data.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function useBigIntSettingsTests(context: FirestoreBridgeTestContext) {
  const ROOT_COLLECTION_ID =
    'Settings.useBigInt — Fidelity Suite (root collection)';

  /**
   * Helpers
   */
  const SAFE_POS = Number.MAX_SAFE_INTEGER; //  9_007_199_254_740_991
  const SAFE_NEG = Number.MIN_SAFE_INTEGER; // -9_007_199_254_740_991

  // Beyond JS safe integer range (cannot be represented precisely as a JS number)
  const UNSAFE_POS = 9_007_199_254_740_993n; // 2^53 + 1 + 1
  const UNSAFE_NEG = -9_007_199_254_740_993n;

  // Firestore's 64-bit integer bounds (signed)
  const BIGINT_MAX_64 = 9_223_372_036_854_775_807n; //  2^63 - 1
  const BIGINT_MIN_64 = -9_223_372_036_854_775_808n; // -2^63

  type MixedDoc = { a: bigint; b: { c: bigint[] } };

  /**
   * Utilities to get an isolated sub-collection per test (no collisions in emulator).
   */
  const sanitize = (s: string) =>
    (s || 'unknown_test').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);

  const subcol = (db: Firestore) => {
    const name = sanitize(expect.getState().currentTestName ?? 'unknown_test');
    return db.collection(ROOT_COLLECTION_ID).doc('container').collection(name);
  };

  /**
   * Mode A — useBigInt: false (default behavior)
   * Expectation: 64-bit integers deserialize to JS number (precision may be lost).
   */
  describe(`${ROOT_COLLECTION_ID} — useBigInt:false`, () => {
    let FirestoreDb!: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(ROOT_COLLECTION_ID, {
        useBigInt: false,
      });
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('safe integers round-trip as number', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('safe');
      await ref.set({ pos: SAFE_POS, neg: SAFE_NEG, zero: 0 });

      const snap = await ref.get();
      const d = snap.data() as DocumentData;

      expect(typeof d.pos).toBe('number');
      expect(typeof d.neg).toBe('number');
      expect(typeof d.zero).toBe('number');

      expect(d.pos).toBe(SAFE_POS);
      expect(d.neg).toBe(SAFE_NEG);
      expect(d.zero).toBe(0);
    });

    it('writing a BigInt at 64-bit bounds reads back as a number (precision may be lost)', async () => {
      const c = subcol(FirestoreDb);

      // MAX bound
      const rMax = c.doc('bounds-max');
      await rMax.set({ v: BIGINT_MAX_64 }); // write bigint literal
      const dMax = (await rMax.get()).data() as DocumentData;
      expect(typeof dMax.v).toBe('number');
      expect(dMax.v).toBe(Number(BIGINT_MAX_64));
      expect(BigInt(dMax.v)).not.toBe(BIGINT_MAX_64);

      // MIN bound
      const rMin = c.doc('bounds-min');
      await rMin.set({ v: BIGINT_MIN_64 });
      const dMin = (await rMin.get()).data() as DocumentData;
      expect(typeof dMin.v).toBe('number');
      expect(dMin.v).toBe(Number(BIGINT_MIN_64));
      expect(dMin.v).not.toBe(BIGINT_MIN_64);
    });

    it('nested BigInt (arrays/maps) deserialize as numbers', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('nested-as-number');
      const payload: MixedDoc = {
        a: UNSAFE_NEG,
        b: { c: [0n, 1n, UNSAFE_POS] },
      };
      await ref.set(payload);

      const d = (await ref.get()).data() as DocumentData;
      expect(typeof d.a).toBe('number');
      expect(d.b.c.every((x: unknown) => typeof x === 'number')).toBe(true);
      expect(BigInt(d.b.c[2])).not.toBe(UNSAFE_POS);
    });

    it('unsafe values written as Number round-trip as number (staying lossy)', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('unsafe-as-number');

      const lossy = Number(UNSAFE_POS);
      await ref.set({ v: lossy });

      const d = (await ref.get()).data() as DocumentData;
      expect(typeof d.v).toBe('number');
      expect(d.v).toBe(lossy);
    });

    it('withConverter: fromFirestore sees numbers (not bigint)', async () => {
      type Shape = { v: number };
      const conv = {
        toFirestore(i: Shape): DocumentData {
          return i;
        },
        fromFirestore(snap: FirebaseFirestore.QueryDocumentSnapshot): Shape {
          const data = snap.data() as DocumentData;
          expect(typeof data.v).toBe('number');
          return { v: data.v as number };
        },
      };

      const c = subcol(FirestoreDb).withConverter<Shape>(conv);
      const ref = c.doc('conv-number');
      await ref.set({ v: SAFE_POS });
      const snap = await ref.get();
      const got = snap.data() as DocumentData;
      expect(typeof got.v).toBe('number');
      expect(got.v).toBe(SAFE_POS);
    });

    it('equality query with number operand matches number-stored docs', async () => {
      const c = subcol(FirestoreDb);
      await c.doc('a').set({ v: 5 });
      await c.doc('b').set({ v: 6 });

      const qs = await c.where('v', '==', 6).get();
      expect(qs.size).toBe(1);
      expect(qs.docs[0].id).toBe('b');
      const payload = qs.docs[0].data() as DocumentData;
      expect(typeof payload.v).toBe('number');
      expect(payload.v).toBe(6);
    });
  });

  /**
   * Mode B — useBigInt: true
   * Expectation: **all integer** values deserialize to JS bigint (exact).
   * Doubles (non-integers) deserialize to number.
   */
  describe(`${ROOT_COLLECTION_ID} — useBigInt:true`, () => {
    let FirestoreDb!: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(ROOT_COLLECTION_ID, { useBigInt: true });
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('safe integers deserialize as bigint under useBigInt:true', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('safe');
      await ref.set({ pos: SAFE_POS, neg: SAFE_NEG, zero: 0 });

      const d = (await ref.get()).data() as DocumentData;
      expect(typeof d.pos).toBe('bigint');
      expect(typeof d.neg).toBe('bigint');
      expect(typeof d.zero).toBe('bigint');
      expect(d.pos).toBe(BigInt(SAFE_POS));
      expect(d.neg).toBe(BigInt(SAFE_NEG));
      expect(d.zero).toBe(0n);
    });

    it('64-bit bounds: BigInt writes surface as exact bigint on read', async () => {
      const c = subcol(FirestoreDb);

      // MAX bound
      const rMax = c.doc('bounds-max');
      await rMax.set({ v: BIGINT_MAX_64 });
      const dMax = (await rMax.get()).data() as DocumentData;
      expect(typeof dMax.v).toBe('bigint');
      expect(dMax.v).toBe(BIGINT_MAX_64);

      // MIN bound
      const rMin = c.doc('bounds-min');
      await rMin.set({ v: BIGINT_MIN_64 });
      const dMin = (await rMin.get()).data() as DocumentData;
      expect(typeof dMin.v).toBe('bigint');
      expect(dMin.v).toBe(BIGINT_MIN_64);
    });

    it('writing integer **number** values reads back as bigint (integers → bigint)', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('number-to-bigint');

      await ref.set({ v1: 1, v2: 2, v3: SAFE_POS }); // all integers
      const d = (await ref.get()).data() as DocumentData;

      expect(typeof d.v1).toBe('bigint');
      expect(typeof d.v2).toBe('bigint');
      expect(typeof d.v3).toBe('bigint');

      expect(d.v1).toBe(1n);
      expect(d.v2).toBe(2n);
      expect(d.v3).toBe(BigInt(SAFE_POS));
    });

    it('accepts nested BigInt in arrays and maps, surfaces bigint recursively', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('nested');

      const payload: MixedDoc = {
        a: UNSAFE_NEG,
        b: { c: [0n, 1n, UNSAFE_POS] },
      };
      await ref.set(payload);

      const d = (await ref.get()).data() as DocumentData;

      expect(typeof d.a).toBe('bigint');
      expect(d.a).toBe(UNSAFE_NEG);

      expect(Array.isArray(d.b.c)).toBe(true);
      expect(d.b.c.every((x: unknown) => typeof x === 'bigint')).toBe(true);
      expect(d.b.c[2]).toBe(UNSAFE_POS);

      expect(
        isDocDataEqual(normalizeDocData(d), normalizeDocData(payload))
      ).toBe(true);
    });

    it('withConverter: fromFirestore sees bigint for integer fields, number for doubles', async () => {
      const conv = {
        toFirestore(i: { vi: number | bigint; vd: number }): DocumentData {
          return i; // pass-through
        },
        fromFirestore(snap: FirebaseFirestore.QueryDocumentSnapshot) {
          const data = snap.data() as DocumentData;
          // vi should be bigint (integer field)
          expect(typeof data.vi).toBe('bigint');
          // vd is a double → number
          expect(typeof data.vd).toBe('number');
          return data;
        },
      };

      const c = subcol(FirestoreDb).withConverter(conv);
      const ref = c.doc('conv-mixed');

      // Write integer (as number) and a decimal
      await ref.set({ vi: 42, vd: 1.5 });
      const d = (await ref.get()).data() as DocumentData;

      expect(typeof d.vi).toBe('bigint');
      expect(d.vi).toBe(42n);

      expect(typeof d.vd).toBe('number');
      expect(d.vd).toBe(1.5);
    });

    it('equality query with bigint operand matches bigint-stored docs', async () => {
      const c = subcol(FirestoreDb);

      await c.doc('a').set({ v: 5 }); // integer number → bigint on read
      await c.doc('b').set({ v: 6n }); // explicit bigint

      const qs = await c.where('v', '==', 6n).get();
      expect(qs.size).toBe(1);
      expect(qs.docs[0].id).toBe('b');
      const payload = qs.docs[0].data() as DocumentData;
      expect(typeof payload.v).toBe('bigint');
      expect(payload.v).toBe(6n);
    });

    it('non-integer numbers remain numbers (doubles), even in bigint mode', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('non-integer');

      await ref.set({ v: 1.5 });
      const d = (await ref.get()).data() as DocumentData;
      expect(typeof d.v).toBe('number');
      expect(d.v).toBe(1.5);
    });

    it('writing Number near 64-bit integer bounds but not exactly integer (e.g., 1.5) remains number on read', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('as-double');

      await ref.set({ v: Number(UNSAFE_POS) + 0.5 }); // clearly non-integer double
      const d = (await ref.get()).data() as DocumentData;
      expect(typeof d.v).toBe('number');
    });
  });
}

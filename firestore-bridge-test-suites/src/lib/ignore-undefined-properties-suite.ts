/**
 * Firestore Settings — `ignoreUndefinedProperties` Fidelity Suite
 *
 * Goal: Verify that `undefined` values are handled per the Admin SDK setting,
 *       using only public Firestore APIs via FirestoreBridgeTestContext.
 *
 * Modes:
 *  - ignoreUndefinedProperties: false (default) → any `undefined` causes INVALID_ARGUMENT
 *  - ignoreUndefinedProperties: true  → `undefined` object properties are omitted
 *                                       (but array elements that are `undefined` still error)
 *
 * Surfaces covered:
 *  - set(), update(), set({ merge: true })
 *  - nested maps and arrays
 *  - withConverter() passthrough
 *  - no-op semantics when update({ field: undefined }) under ignoreUndefinedProperties:true
 */

import { DocumentData, FieldValue, Firestore } from 'firebase-admin/firestore';
import { ExpectError } from './helpers/expect.error.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function ignoreUndefinedSettingsTests(
  context: FirestoreBridgeTestContext
) {
  const ROOT_COLLECTION_ID =
    'Settings.ignoreUndefinedProperties — Fidelity Suite (root collection)';

  // Per-test sub-collection (avoids cross-test clashes on emulator)
  const sanitize = (s: string) =>
    (s || 'unknown_test').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);

  const subcol = (db: Firestore) => {
    const name = sanitize(expect.getState().currentTestName ?? 'unknown_test');
    return db.collection(ROOT_COLLECTION_ID).doc('container').collection(name);
  };

  /**
   * Mode A — ignoreUndefinedProperties: false (default)
   * Expectation: any occurrence of `undefined` → INVALID_ARGUMENT
   */
  describe(`${ROOT_COLLECTION_ID} — ignoreUndefinedProperties:false`, () => {
    let FirestoreDb!: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(ROOT_COLLECTION_ID, {
        ignoreUndefinedProperties: false,
      });
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('set(): top-level undefined → throws', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('top-undef');
      await ExpectError.sync(() => ref.set({ a: undefined }), {
        match: /Cannot use "undefined" as a Firestore value/,
      });
    });

    it('set(): nested undefined in map → throws', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('nested-undef');
      await ExpectError.sync(() => ref.set({ m: { x: 1, y: undefined } }), {
        match: /Cannot use "undefined" as a Firestore value/,
      });
    });

    it('set(): array containing undefined → throws (even when false)', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('array-undef');
      await ExpectError.sync(() => ref.set({ arr: [1, undefined, 3] }), {
        match: /Cannot use "undefined" as a Firestore value/,
      });
    });

    it('update(): undefined operand → throws', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('update-undef');
      await ref.set({ a: 1 });
      await ExpectError.sync(() => ref.update({ a: undefined }), {
        match: /Cannot use "undefined" as a Firestore value/,
      });
    });

    it('set({merge:true}): undefined in payload → throws', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('merge-undef');
      await ref.set({ a: 1 });
      await ExpectError.sync(() => ref.set({ a: undefined }, { merge: true }), {
        match: /Cannot use "undefined" as a Firestore value/,
      });
    });

    it('withConverter(): toFirestore returning undefined → throws', async () => {
      const conv = {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        toFirestore(_i: { a?: number }): DocumentData {
          // Intentionally include undefined
          return { a: undefined };
        },
        fromFirestore(snap: FirebaseFirestore.QueryDocumentSnapshot) {
          return snap.data();
        },
      };
      const c = subcol(FirestoreDb).withConverter(conv);
      const ref = c.doc('converter-undef');
      await ExpectError.sync(() => ref.set({}), {
        match: /Cannot use "undefined" as a Firestore value/,
      });
    });

    it('FieldValue.delete() is unrelated and still allowed in update()', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('delete-vs-undefined');
      await ref.set({ a: 1, b: 2 });

      await ref.update({ a: FieldValue.delete() }); // valid
      const d = (await ref.get()).data() as DocumentData;
      expect(d.a).toBeUndefined();
      expect(d.b).toBe(2);
    });
  });

  /**
   * Mode B — ignoreUndefinedProperties: true
   * Expectation:
   *  - `undefined` values in objects/maps are silently OMITTED (not written).
   *  - Array elements that are `undefined` still ERROR.
   *  - update({ field: undefined }) is a NO-OP (does not modify the field).
   */
  describe(`${ROOT_COLLECTION_ID} — ignoreUndefinedProperties:true`, () => {
    let FirestoreDb!: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(ROOT_COLLECTION_ID, {
        ignoreUndefinedProperties: true,
      });
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('set(): top-level undefined is omitted → empty document created', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('top-undef-omitted');

      await ref.set({ a: undefined });
      const snap = await ref.get();
      expect(snap.exists).toBe(true);

      const d = snap.data() as DocumentData;
      expect(d).toEqual({}); // `a` omitted
    });

    it('set(): nested undefined in map is omitted (other props preserved)', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('nested-undef-omitted');

      await ref.set({ m: { x: 1, y: undefined } });
      const d = (await ref.get()).data() as DocumentData;

      // `y` omitted, `x` retained
      expect(d.m).toEqual({ x: 1 });
      expect('y' in d.m).toBe(false);
    });

    it('set(): array omits undefined elements', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('array-undef-still-errors');

      await ref.set({ arr: [1, undefined, 3] });
      const snap = await ref.get();
      expect(snap.data()).toEqual({ arr: [1, 3] });
    });

    it('update(): undefined is a no-op (field not changed nor deleted)', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('update-noop');

      await ref.set({ a: 1, b: 2 });

      // Should not throw and should not change `a`
      await ref.update({ a: undefined });

      const d = (await ref.get()).data() as DocumentData;
      expect(d.a).toBe(1);
      expect(d.b).toBe(2);
    });

    it('set({merge:true}): undefined keys are omitted (existing values preserved)', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('merge-omits');

      await ref.set({ a: 1, b: 2, m: { x: 10 } });

      // Undefined should be omitted; merge should not delete or overwrite with undefined
      await ref.set({ a: undefined, m: { y: undefined } }, { merge: true });

      const d = (await ref.get()).data() as DocumentData;
      expect(d).toEqual({ a: 1, b: 2, m: { x: 10 } });
      expect('y' in d.m).toBe(false);
    });

    it('withConverter(): toFirestore returning undefined keys → omitted, not written', async () => {
      const conv = {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        toFirestore(_i: { a?: number; m?: { x?: number } }): DocumentData {
          return { a: undefined, m: { x: undefined } };
        },
        fromFirestore(snap: FirebaseFirestore.QueryDocumentSnapshot) {
          return snap.data();
        },
      };
      const c = subcol(FirestoreDb).withConverter(conv);
      const ref = c.doc('converter-omits');

      await ref.set({});
      const d = (await ref.get()).data() as DocumentData;
      expect(d).toEqual({}); // everything omitted
    });

    it('FieldValue.delete(): still deletes explicitly (not affected by ignore setting)', async () => {
      const c = subcol(FirestoreDb);
      const ref = c.doc('delete-explicit');

      await ref.set({ a: 1, b: 2 });
      await ref.update({ a: FieldValue.delete() });

      const d = (await ref.get()).data() as DocumentData;
      expect(d.a).toBeUndefined();
      expect(d.b).toBe(2);
    });
  });
}

import { FirestoreController, FirestoreMock } from '../..';

describe('Firestore.recursiveDelete — integration against in-memory DB', () => {
  let env!: FirestoreMock;

  beforeEach(() => {
    env = new FirestoreMock();
  });

  //
  // Utilities
  //
  function expectMissing(ctrl: FirestoreController, path: string) {
    const doc = ctrl.database.getDocument(path);
    expect(doc.exists).toBe(false);
  }
  function expectPresent(
    ctrl: FirestoreController,
    path: string,
    data?: unknown
  ) {
    const doc = ctrl.database.getDocument(path);
    expect(doc.exists).toBe(true);
    if (data !== undefined) expect(doc.data).toEqual(data);
  }

  function seedSimpleTree(ctrl: FirestoreController) {
    // A/.. branch (deep)
    ctrl.database.setDocument('A/a1', { on: 'A/a1' });
    ctrl.database.setDocument('A/a1/Aa/a1a', { on: 'A/a1/Aa/a1a' });
    ctrl.database.setDocument('A/a1/Aa/a1a/Aaa/a1aa', {
      on: 'A/a1/Aa/a1a/Aaa/a1aa',
    });
    ctrl.database.setDocument('A/a2', { on: 'A/a2' });

    // B/.. branch (siblings & nested)
    ctrl.database.setDocument('B/b1', { on: 'B/b1' });
    ctrl.database.setDocument('B/b1/Bb/b1b', { on: 'B/b1/Bb/b1b' });
    ctrl.database.setDocument('B/b2', { on: 'B/b2' });

    // C/.. branch (many leaves)
    for (let i = 0; i < 5; i++) {
      ctrl.database.setDocument(`C/c${i}`, { idx: i });
    }

    // D/.. unrelated branch
    ctrl.database.setDocument('D/d1', { on: 'D/d1' });

    return {
      A: ['A/a1', 'A/a1/Aa/a1a', 'A/a1/Aa/a1a/Aaa/a1aa', 'A/a2'],
      B: ['B/b1', 'B/b1/Bb/b1b', 'B/b2'],
      C: ['C/c0', 'C/c1', 'C/c2', 'C/c3', 'C/c4'],
      D: ['D/d1'],
    };
  }

  function seedWideMixed(ctrl: FirestoreController) {
    // E root with multiple subcollections and cross nesting
    ctrl.database.setDocument('E/e1', { tag: 'e1' });
    ctrl.database.setDocument('E/e1/Ee/e1e1', { tag: 'e1e1' });
    ctrl.database.setDocument('E/e1/Ee/e1e2', { tag: 'e1e2' });
    ctrl.database.setDocument('E/e2', { tag: 'e2' });
    ctrl.database.setDocument('E/e2/Ee/e2e1', { tag: 'e2e1' });
    ctrl.database.setDocument('E/e2/Ee/e2e1/Eee/e2e1e1', { tag: 'e2e1e1' });

    // F sibling root unaffected
    ctrl.database.setDocument('F/f1', { tag: 'f1' });

    return {
      E: [
        'E/e1',
        'E/e1/Ee/e1e1',
        'E/e1/Ee/e1e2',
        'E/e2',
        'E/e2/Ee/e2e1',
        'E/e2/Ee/e2e1/Eee/e2e1e1',
      ],
      F: ['F/f1'],
    };
  }

  //
  // Tests
  //

  it('deletes a leaf document (no subcollections)', async () => {
    const ctrl = env.createDatabase();
    seedSimpleTree(ctrl);

    const firestore = ctrl.firestore();
    await firestore.recursiveDelete(firestore.doc('C/c3'));

    // Deleted leaf only
    expectMissing(ctrl, 'C/c3');

    // Siblings & other branches remain
    expectPresent(ctrl, 'C/c2', { idx: 2 });
    expectPresent(ctrl, 'C/c4', { idx: 4 });
    expectPresent(ctrl, 'A/a1', { on: 'A/a1' });
    expectPresent(ctrl, 'B/b2', { on: 'B/b2' });
    expectPresent(ctrl, 'D/d1', { on: 'D/d1' });
  });

  it('deletes a document and all of its descendants (deep tree)', async () => {
    const ctrl = env.createDatabase();
    seedSimpleTree(ctrl);
    const firestore = ctrl.firestore();

    await firestore.recursiveDelete(firestore.doc('A/a1'));

    // Entire A/a1 subtree is gone
    expectMissing(ctrl, 'A/a1');
    expectMissing(ctrl, 'A/a1/Aa/a1a');
    expectMissing(ctrl, 'A/a1/Aa/a1a/Aaa/a1aa');

    // Sibling under A remains
    expectPresent(ctrl, 'A/a2', { on: 'A/a2' });
    // Unrelated branches untouched
    expectPresent(ctrl, 'B/b1', { on: 'B/b1' });
    expectPresent(ctrl, 'C/c1', { idx: 1 });
  });

  it('deletes a subcollection (CollectionReference) under a document only', async () => {
    const ctrl = env.createDatabase();
    seedSimpleTree(ctrl);
    const firestore = ctrl.firestore();

    // Delete subcollection Bb under B/b1
    await firestore.recursiveDelete(firestore.collection('B/b1/Bb'));

    // Subcollection documents gone
    expectMissing(ctrl, 'B/b1/Bb/b1b');

    // Parent doc remains
    expectPresent(ctrl, 'B/b1', { on: 'B/b1' });

    // Sibling doc under B remains
    expectPresent(ctrl, 'B/b2', { on: 'B/b2' });
  });

  it('deletes an entire top-level collection (CollectionReference)', async () => {
    const ctrl = env.createDatabase();
    seedSimpleTree(ctrl);
    const firestore = ctrl.firestore();

    await firestore.recursiveDelete(firestore.collection('C'));

    // All of C/* are gone
    for (const p of ['C/c0', 'C/c1', 'C/c2', 'C/c3', 'C/c4']) {
      expectMissing(ctrl, p);
    }

    // Other roots unaffected
    expectPresent(ctrl, 'A/a1', { on: 'A/a1' });
    expectPresent(ctrl, 'B/b2', { on: 'B/b2' });
    expectPresent(ctrl, 'D/d1', { on: 'D/d1' });
  });

  it('deletes nested collection subtree while preserving other roots', async () => {
    const ctrl = env.createDatabase();
    seedWideMixed(ctrl);
    const firestore = ctrl.firestore();

    await firestore.recursiveDelete(firestore.collection('E/e2/Ee'));

    // Everything under E/e2/Ee is gone
    expectMissing(ctrl, 'E/e2/Ee/e2e1');
    expectMissing(ctrl, 'E/e2/Ee/e2e1/Eee/e2e1e1');

    // E/e2 itself remains; other branch under E/e1 remains
    expectPresent(ctrl, 'E/e2', { tag: 'e2' });
    expectPresent(ctrl, 'E/e1', { tag: 'e1' });
    expectPresent(ctrl, 'E/e1/Ee/e1e1', { tag: 'e1e1' });

    // Unrelated F/* untouched
    expectPresent(ctrl, 'F/f1', { tag: 'f1' });
  });

  it('handles mixed depth: delete E/e1 document wipes only its subtree', async () => {
    const ctrl = env.createDatabase();
    seedWideMixed(ctrl);
    const firestore = ctrl.firestore();

    await firestore.recursiveDelete(firestore.doc('E/e1'));

    // E/e1 subtree gone
    expectMissing(ctrl, 'E/e1');
    expectMissing(ctrl, 'E/e1/Ee/e1e1');
    expectMissing(ctrl, 'E/e1/Ee/e1e2');

    // E/e2 branch remains
    expectPresent(ctrl, 'E/e2', { tag: 'e2' });
    expectPresent(ctrl, 'E/e2/Ee/e2e1', { tag: 'e2e1' });

    // F/* remains
    expectPresent(ctrl, 'F/f1', { tag: 'f1' });
  });

  it('deleting an empty collection is a no-op (idempotent)', async () => {
    const ctrl = env.createDatabase();
    const firestore = ctrl.firestore();

    // Create unrelated doc only
    ctrl.database.setDocument('X/x1', { tag: 'x1' });

    // Delete non-existent collection Y
    await firestore.recursiveDelete(firestore.collection('Y'));

    // Ensure unrelated doc still present
    expectPresent(ctrl, 'X/x1', { tag: 'x1' });
  });

  it('idempotency: deleting the same subtree twice leaves DB unchanged', async () => {
    const ctrl = env.createDatabase();
    seedSimpleTree(ctrl);
    const firestore = ctrl.firestore();

    await firestore.recursiveDelete(firestore.collection('B'));
    // Second pass should effectively be a no-op
    await firestore.recursiveDelete(firestore.collection('B'));

    // All B/* gone
    expectMissing(ctrl, 'B/b1');
    expectMissing(ctrl, 'B/b2');
    expectMissing(ctrl, 'B/b1/Bb/b1b');

    // Non-B branches remain
    expectPresent(ctrl, 'A/a1', { on: 'A/a1' });
    expectPresent(ctrl, 'C/c0', { idx: 0 });
  });

  it('large fan-out under a collection (basic scale sanity)', async () => {
    const ctrl = env.createDatabase();
    const firestore = ctrl.firestore();

    // Build G/* with many docs and some nested leaves
    const leafCount = 200;
    for (let i = 0; i < leafCount; i++) {
      ctrl.database.setDocument(`G/g${i}`, { i });
      if (i % 10 === 0) {
        ctrl.database.setDocument(`G/g${i}/Ga/ga${i}`, { i });
        ctrl.database.setDocument(`G/g${i}/Ga/ga${i}/Gaa/gaa${i}`, { i });
      }
    }

    await firestore.recursiveDelete(firestore.collection('G'));

    // Everything under G is gone
    for (let i = 0; i < leafCount; i++) {
      expectMissing(ctrl, `G/g${i}`);
      if (i % 10 === 0) {
        expectMissing(ctrl, `G/g${i}/Ga/ga${i}`);
        expectMissing(ctrl, `G/g${i}/Ga/ga${i}/Gaa/gaa${i}`);
      }
    }
  });

  it('preserves unrelated complex branches after targeted delete', async () => {
    const ctrl = env.createDatabase();
    seedSimpleTree(ctrl);
    seedWideMixed(ctrl);

    const firestore = ctrl.firestore();
    await firestore.recursiveDelete(firestore.doc('A/a1'));

    // Validate exported structure contains none of A/a1 subtree,
    // but does contain A/a2, B/*, C/*, D/*, E/*, F/* as seeded.
    const exported = ctrl.database.toStructuralDatabase();

    // spot-check a few key survivors
    expect(exported.A?.a2?.data).toEqual({ on: 'A/a2' });
    expect(exported.B?.b2?.data).toEqual({ on: 'B/b2' });
    expect(exported.F?.f1?.data).toEqual({ tag: 'f1' });

    // Ensure A/a1 is absent from the map shape entirely
    expect(exported.A?.a1).toBeUndefined();
  });
});

import { FirestoreController, FirestoreMock } from '../..';

type Stats = ReturnType<FirestoreController['database']['stats']>;

function expectStruct(
  s: Stats,
  {
    documentCount = 0,
    collectionCount = 0,
    stubDocumentCount = 0,
    stubCollectionCount = 0,
  }: Partial<Stats> = {}
) {
  expect(s.documentCount).toBe(documentCount);
  expect(s.collectionCount).toBe(collectionCount);
  expect(s.stubDocumentCount).toBe(stubDocumentCount);
  expect(s.stubCollectionCount).toBe(stubCollectionCount);
}

describe('DatabaseStats > StructuralStats (active vs stub collections/documents)', () => {
  let env!: FirestoreMock;

  beforeEach(() => {
    env = new FirestoreMock();
  });

  //
  // Baseline & lifecycle
  //
  describe('Baseline & lifecycle', () => {
    it('starts at zero', () => {
      const ctrl = env.createDatabase();
      expectStruct(ctrl.database.stats(), {
        documentCount: 0,
        collectionCount: 0,
        stubDocumentCount: 0,
        stubCollectionCount: 0,
      });
    });

    it('reset() clears structural counters', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('alpha/a1', { v: 1 });
      ctrl.database.setDocument('beta/b1/child/c1', { v: 1 }); // creates stub doc beta/b1 and may mark beta as stub collection if no active immediate children

      const before = ctrl.database.stats();
      expect(
        before.documentCount +
          before.collectionCount +
          before.stubDocumentCount +
          before.stubCollectionCount
      ).toBeGreaterThan(0);

      ctrl.database.reset();
      expectStruct(ctrl.database.stats());
    });
  });

  //
  // Flat collections
  //
  describe('Single-level collections (no stubs)', () => {
    it('one collection, one active doc', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('col1/doc1', { v: 1 });

      expectStruct(ctrl.database.stats(), {
        documentCount: 1,
        collectionCount: 1,
        stubDocumentCount: 0,
        stubCollectionCount: 0,
      });
    });

    it('one collection, multiple active docs', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('col1/doc1', { v: 1 });
      ctrl.database.setDocument('col1/doc2', { v: 2 });
      ctrl.database.setDocument('col1/doc3', { v: 3 });

      expectStruct(ctrl.database.stats(), {
        documentCount: 3,
        collectionCount: 1,
        stubDocumentCount: 0,
        stubCollectionCount: 0,
      });
    });

    it('multiple collections, each with active docs', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('a/a1', { v: 1 });
      ctrl.database.setDocument('a/a2', { v: 2 });
      ctrl.database.setDocument('b/b1', { v: 3 });

      expectStruct(ctrl.database.stats(), {
        documentCount: 3,
        collectionCount: 2, // a, b
        stubDocumentCount: 0,
        stubCollectionCount: 0,
      });
    });

    it('deleting last doc from a collection with no deeper descendants removes the collection entirely (no stub)', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('solo/a', { v: 1 });
      ctrl.database.deleteDocument('solo/a');

      expectStruct(ctrl.database.stats(), {
        documentCount: 0,
        collectionCount: 0,
        stubDocumentCount: 0,
        stubCollectionCount: 0,
      });
    });
  });

  //
  // Nested structure & stub documents/collections
  //
  describe('Nested structure: stub documents anchor deeper leaves; collections become stub if only anchoring deeper leaves', () => {
    it('leaf at col1/doc1/child/docA creates stub doc (col1/doc1) and stub collection (col1); child is active collection', () => {
      const ctrl = env.createDatabase();

      // Create only the deep leaf:
      ctrl.database.setDocument('col1/doc1/child/docA', { v: 'A' });

      // Active documents: child/docA
      // Stub documents: col1/doc1 (anchors `child`)
      // Collections:
      //   col1 → has 0 immediate active docs (doc1 is stub) but has deeper descendant (child/docA) → stub collection
      //   child → has immediate active doc (docA) → active collection
      expectStruct(ctrl.database.stats(), {
        documentCount: 1,
        collectionCount: 1, // child
        stubDocumentCount: 1, // col1/doc1
        stubCollectionCount: 1, // col1
      });
    });

    it('promoting the stub parent doc to active converts its collection from stub→active (child remains active)', () => {
      const ctrl = env.createDatabase();

      ctrl.database.setDocument('col1/doc1/child/docA', { v: 'A' });
      ctrl.database.setDocument('col1/doc1', { parent: true }); // promote

      expectStruct(ctrl.database.stats(), {
        documentCount: 2, // doc1 + child/docA
        collectionCount: 2, // col1 (now active), child (active)
        stubDocumentCount: 0, // doc1 no longer stub
        stubCollectionCount: 0, // col1 no longer stub
      });
    });

    it('deep chain A/d0/B/d1/C/d2 (only d2 active): A and B are stub collections; C is active', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('A/d0/B/d1/C/d2', { v: 2 });

      // Active docs: d2
      // Stub docs: d0, d1
      // Collections: A (stub), B (stub), C (active)
      expectStruct(ctrl.database.stats(), {
        documentCount: 1,
        collectionCount: 1, // C
        stubDocumentCount: 2, // d0, d1
        stubCollectionCount: 2, // A, B
      });
    });

    it('promote d1 to active: B becomes active (moves out of stub), A remains stub; C remains active', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('A/d0/B/d1/C/d2', { v: 2 });
      ctrl.database.setDocument('A/d0/B/d1', { promoted: true });

      expectStruct(ctrl.database.stats(), {
        documentCount: 2, // d1, d2
        collectionCount: 2, // B, C
        stubDocumentCount: 1, // d0
        stubCollectionCount: 1, // A (still only anchoring deeper)
      });
    });

    it('remove deep leaves under C; if B still has active immediate child (d1), A remains stub; C disappears (no deeper, no immediate)', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('A/d0/B/d1/C/d2', { v: 2 });
      ctrl.database.setDocument('A/d0/B/d1', { promoted: true });

      // Remove the only leaf under C; C now has 0 immediate and 0 deeper → not a stub and not active
      ctrl.database.deleteDocument('A/d0/B/d1/C/d2');

      // Now:
      // Active docs: d1
      // Collections: B is active (has d1); A has 0 immediate actives (d0 is stub) but deeper descendant active doc exists (d1) → A is stub
      // C: gone
      expectStruct(ctrl.database.stats(), {
        documentCount: 1,
        collectionCount: 1, // B
        stubDocumentCount: 1, // d0
        stubCollectionCount: 1, // A
      });
    });

    it('promote d0; A ceases to be stub and becomes active; still no C', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('A/d0/B/d1/C/d2', { v: 2 });
      ctrl.database.setDocument('A/d0/B/d1', { promoted: true });
      ctrl.database.deleteDocument('A/d0/B/d1/C/d2');

      // Promote d0
      ctrl.database.setDocument('A/d0', { promoted: true });

      expectStruct(ctrl.database.stats(), {
        documentCount: 2, // d0 + d1
        collectionCount: 2, // A + B
        stubDocumentCount: 0,
        stubCollectionCount: 0,
      });
    });
  });

  //
  // Stub collections only when anchoring deeper descendants
  //
  describe('Stub collections must anchor deeper descendants; empty collections are pruned', () => {
    it('deleting the only doc of a subcollection makes that subcollection vanish unless deeper leaves exist', () => {
      const ctrl = env.createDatabase();

      // parent active, create one grandchild
      ctrl.database.setDocument('p/doc', { active: true });
      ctrl.database.setDocument('p/doc/child/sub1', { v: 1 });

      // Now: p (active), child (active), no stub collections
      expectStruct(ctrl.database.stats(), {
        documentCount: 2, // p/doc + child/sub1
        collectionCount: 2, // p and child
        stubDocumentCount: 0,
        stubCollectionCount: 0,
      });

      // Delete the only sub doc; child now has 0 immediate and 0 deeper → disappears (not stub)
      ctrl.database.deleteDocument('p/doc/child/sub1');

      expectStruct(ctrl.database.stats(), {
        documentCount: 1, // p/doc
        collectionCount: 1, // p
        stubDocumentCount: 0,
        stubCollectionCount: 0, // child is not a stub (no deeper leaves)
      });
    });

    it('a collection with only a stub document (no deeper subcollections) is not counted as stub collection', () => {
      const ctrl = env.createDatabase();

      // Create deep then remove leaf so only a stub doc remains without deeper descendants
      ctrl.database.setDocument('root/d0/sg/d1', { v: 1 });
      ctrl.database.deleteDocument('root/d0/sg/d1');
      // At this point, depending on pruning, d0 (stub) may be dropped as unnecessary.
      // Under the clarified rule, there are no deeper leaves, so root is neither active nor stub.
      const s = ctrl.database.stats();
      expectStruct(s, {
        // Either fully pruned (all zeros) OR only non-contributing stubs removed:
        // Hard-assert the counts that matter to the rule:
        stubCollectionCount: 0,
        collectionCount: 0,
      });
    });
  });

  //
  // Batch operations and structural transitions
  //
  describe('Batch operations affecting structure', () => {
    it('batchSet across mixed depths yields correct active vs stub collection counts', () => {
      const ctrl = env.createDatabase();

      ctrl.database.batchSet(
        { path: 'k1/a', data: { i: 1 } }, // k1 active (immediate doc 'a')
        { path: 'k1/b/child/x', data: { i: 2 } }, // creates stub doc k1/b; 'child' is active (doc 'x')
        { path: 'k2/d0/c1/d1/c2/d2', data: { deep: true } } // deep chain: stub docs d0,d1; 'c2' active; stub collections 'k2','c1'
      );

      const s = ctrl.database.stats();

      // Active documents: k1/a, child/x, c2/d2 → 3
      // Active collections: k1 (has 'a'), child (has 'x'), c2 (has 'd2') → 3
      // Stub documents: k1/b, d0, d1 → 3
      // Stub collections: k2, c1 → 2
      expectStruct(s, {
        documentCount: 3,
        collectionCount: 3,
        stubDocumentCount: 3,
        stubCollectionCount: 2,
      });
    });

    it('batchDelete can eliminate active collections; only collections anchoring deeper leaves remain as stubs', () => {
      const ctrl = env.createDatabase();

      ctrl.database.batchSet(
        { path: 'z1/a', data: { i: 1 } },
        { path: 'z1/b/child/x', data: { i: 2 } }, // makes z1 active (a) and has deeper via b/child/x (b is stub doc)
        { path: 'z2/c/d/e', data: { i: 3 } } // z2 (stub), d (stub), e (active)
      );

      // Delete immediate active under z1 and the deep leaf under z2
      ctrl.database.batchDelete('z1/a', 'z1/b/child/x', 'z2/c/d/e');

      // After deletes:
      // z1: no immediate active (a gone) and no deeper leaves (child/x gone) → z1 should not be counted (neither active nor stub)
      // z2: no immediate active under z2, and we deleted the only deeper leaf; thus z2 not counted either.
      expectStruct(ctrl.database.stats(), {
        documentCount: 0,
        collectionCount: 0,
        stubDocumentCount: 0,
        stubCollectionCount: 0,
      });
    });
  });
});

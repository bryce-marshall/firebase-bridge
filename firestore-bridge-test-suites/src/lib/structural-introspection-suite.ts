import { DocumentData, Firestore } from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from './test-context.js';

export function structuralIntrospectionSuite(
  context: FirestoreBridgeTestContext
) {
  const COLLECTION_ID =
    'Structural Introspection — root & subcollection listing';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    // Unique root collections for this suite so we can subset-match from listCollections()
    const ROOT_A = `${COLLECTION_ID}-alpha`;
    const ROOT_B = `${COLLECTION_ID}-beta`;
    const ROOT_C = `${COLLECTION_ID}-gamma`;

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);

      // Seed minimal documents to ensure collections/materialization exist
      await FirestoreDb.collection(ROOT_A).doc('seedA').set({ ok: true });
      await FirestoreDb.collection(ROOT_B).doc('seedB').set({ ok: true });
      await FirestoreDb.collection(ROOT_C).doc('seedC').set({ ok: true });

      // Also create one parent document with subcollections we can list
      const parent = FirestoreDb.collection(ROOT_A).doc('parent');
      await parent.set({ marker: 'parent' } as DocumentData);

      // Subcollections under parent
      await parent
        .collection('s1')
        .doc('a')
        .set({ v: 1 } as DocumentData);
      await parent
        .collection('s2')
        .doc('b')
        .set({ v: 2 } as DocumentData);
      await parent
        .collection('s3')
        .doc('c')
        .set({ v: 3 } as DocumentData);

      // And a sibling doc with no subcollections
      await FirestoreDb.collection(ROOT_A)
        .doc('lonely')
        .set({ marker: 'lonely' } as DocumentData);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('Firestore.listCollections() returns root collections (includes this suite’s roots)', async () => {
      const roots = await FirestoreDb.listCollections();
      const rootIds = roots.map((c) => c.id);

      // We do a subset assertion to avoid depending on any other test data in the same project
      expect(rootIds).toEqual(expect.arrayContaining([ROOT_A, ROOT_B, ROOT_C]));

      // Sanity: returned items are CollectionReferences with top-level paths equal to their ids
      for (const c of roots) {
        // Root collections have no parent; their path equals their id.
        expect(c.path).toBe(c.id);
      }
    });

    it('DocumentReference.listCollections() returns subcollections for a populated document', async () => {
      const parent = FirestoreDb.collection(ROOT_A).doc('parent');
      const subs = await parent.listCollections();
      const subIds = subs.map((c) => c.id).sort();

      expect(subIds).toEqual(['s1', 's2', 's3']);

      // Parity checks: the returned CollectionReferences point under the parent path
      for (const c of subs) {
        expect(c.path).toBe(`${parent.path}/${c.id}`);
      }

      // And we can read a doc from each returned subcollection to confirm they’re usable
      for (const c of subs) {
        const snap = await c.limit(1).get();
        expect(snap.empty).toBe(false);
      }
    });

    it('DocumentReference.listCollections() returns an empty array when the document has no subcollections', async () => {
      const lonely = FirestoreDb.collection(ROOT_A).doc('lonely');
      const subs = await lonely.listCollections();
      expect(Array.isArray(subs)).toBe(true);
      expect(subs.length).toBe(0);
    });
  });
}

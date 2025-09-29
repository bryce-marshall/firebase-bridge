import {
    DocumentData,
    DocumentReference,
    FieldPath,
    Firestore,
} from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from './test-context.js';

export function collectionGroupQuerySuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Collection Group Queries — root';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);

      // Seed a small tree with multiple depths and duplicate IDs in different branches.
      const root = FirestoreDb.collection(COLLECTION_ID);

      // Branch p1
      await root.doc('p1').set({}); // parent doc (content irrelevant)
      await root
        .doc('p1')
        .collection('orders')
        .doc('o1')
        .set({ suite: COLLECTION_ID, branch: 'p1', depth: 1, seq: 1 });
      await root
        .doc('p1')
        .collection('orders')
        .doc('dupe')
        .set({ suite: COLLECTION_ID, branch: 'p1', depth: 1, seq: 2 });
      // Deeper under p1: p1/nested/b/orders/deep1
      await root.doc('p1').collection('nested').doc('b').set({});
      await root
        .doc('p1')
        .collection('nested')
        .doc('b')
        .collection('orders')
        .doc('deep1')
        .set({ suite: COLLECTION_ID, branch: 'p1/nested/b', depth: 3, seq: 3 });

      // Branch p2
      await root.doc('p2').set({});
      await root
        .doc('p2')
        .collection('orders')
        .doc('o2')
        .set({ suite: COLLECTION_ID, branch: 'p2', depth: 1, seq: 4 });
      await root
        .doc('p2')
        .collection('orders')
        .doc('dupe')
        .set({ suite: COLLECTION_ID, branch: 'p2', depth: 1, seq: 5 });
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('collectionGroup() returns members across all depths', async () => {
      const qs = await FirestoreDb.collectionGroup('orders')
        .where('suite', '==', COLLECTION_ID)
        .orderBy('seq', 'asc')
        .get();

      expect(qs.size).toBe(5);

      // Expect membership from shallow and deeper subcollections
      const ids = qs.docs.map((d) => d.id);
      expect(ids).toEqual(['o1', 'dupe', 'deep1', 'o2', 'dupe']);

      // Sanity check: each doc has the marker fields and increasing seq order
      let lastSeq = -Infinity;
      for (const snap of qs.docs) {
        const d = snap.data() as DocumentData;
        expect(d.suite).toBe(COLLECTION_ID);
        expect(typeof d.seq).toBe('number');
        expect(d.seq).toBeGreaterThan(lastSeq);
        lastSeq = d.seq;
      }
    });

    it('duplicate document IDs in different branches are all returned', async () => {
      const root = FirestoreDb.collection(COLLECTION_ID);
      const dupeP1 = root.doc('p1').collection('orders').doc('dupe');
      const dupeP2 = root.doc('p2').collection('orders').doc('dupe');

      const qs = await FirestoreDb.collectionGroup('orders')
        .where('suite', '==', COLLECTION_ID)
        .where(FieldPath.documentId(), 'in', [dupeP1, dupeP2])
        .get();

      expect(qs.size).toBe(2);

      // Both docs share the same leaf id but have different parent branches.
      const leafIds = qs.docs.map((d) => d.id);
      expect(leafIds.every((id) => id === 'dupe')).toBe(true);

      const parentDocIds = qs.docs.map(
        (d) => (d.ref.parent.parent as DocumentReference).id // parent doc id: 'p1' or 'p2'
      );
      expect(new Set(parentDocIds)).toEqual(new Set(['p1', 'p2']));

      // Data should reflect branch markers we wrote
      const branches = qs.docs.map((d) => (d.data() as DocumentData).branch);
      expect(new Set(branches)).toEqual(new Set(['p1', 'p2']));
    });

    it('FieldPath.documentId() equality can target a single document within the group', async () => {
      const root = FirestoreDb.collection(COLLECTION_ID);
      const target = root.doc('p1').collection('orders').doc('o1');

      const qs = await FirestoreDb.collectionGroup('orders')
        .where('suite', '==', COLLECTION_ID)
        .where(FieldPath.documentId(), '==', target)
        .get();

      expect(qs.size).toBe(1);
      const snap = qs.docs[0];
      expect(snap.id).toBe('o1');
      const d = snap.data() as DocumentData;
      expect(d.branch).toBe('p1');
      expect(d.seq).toBe(1);
    });
  });
}

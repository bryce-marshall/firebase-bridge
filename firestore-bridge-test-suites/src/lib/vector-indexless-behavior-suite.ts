import { DocumentData, FieldValue, Firestore } from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from './test-context.js';

export function vectorIndexlessBehaviorSuite(
  context: FirestoreBridgeTestContext
) {
  const COLLECTION_ID = 'Vector — indexless nearest behavior';
  const EMBED_FIELD = 'embed';

  describe(COLLECTION_ID, () => {
    let db: Firestore;
    const col = () => db.collection(COLLECTION_ID);

    beforeAll(async () => {
      db = await context.init(COLLECTION_ID);

      // Seed three orthonormal 3-D vectors
      await Promise.all([
        col()
          .doc('dA')
          .set({ [EMBED_FIELD]: FieldValue.vector([1, 0, 0]), tag: 'A' }),
        col()
          .doc('dB')
          .set({ [EMBED_FIELD]: FieldValue.vector([0, 1, 0]), tag: 'B' }),
        col()
          .doc('dC')
          .set({ [EMBED_FIELD]: FieldValue.vector([0, 0, 1]), tag: 'C' }),
      ]);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('indexless: matching-dimension nearest query returns docs and top-1 is the closest', async () => {
      const snap = await col()
        .findNearest({
          vectorField: EMBED_FIELD,
          queryVector: [1, 0, 0], // 3-D, matches corpus
          limit: 3,
          distanceMeasure: 'EUCLIDEAN', // COSINE would also put A first for these axes
        })
        .get();

      expect(snap.empty).toBe(false);
      expect(snap.size).toBe(3);

      // Top-1 should be the exact match ([1,0,0]) regardless of measure used here.
      const top = snap.docs[0].data() as DocumentData;
      expect(top.tag).toBe('A');

      // The rest can be in either order due to equal distance; just assert set membership.
      const tags = snap.docs.map((d) => (d.data() as DocumentData).tag).sort();
      expect(tags).toEqual(['A', 'B', 'C']);
    });

    it('indexless: mismatched-dimension nearest query returns empty (no error)', async () => {
      const snap = await col()
        .findNearest({
          vectorField: EMBED_FIELD,
          queryVector: [1, 0, 0, 0], // 4-D against 3-D corpus
          limit: 3,
          distanceMeasure: 'EUCLIDEAN',
        })
        .get();

      expect(snap.empty).toBe(true);
      expect(snap.size).toBe(0);
    });

    it('respects limit with matching dimension', async () => {
      const snap = await col()
        .findNearest({
          vectorField: EMBED_FIELD,
          queryVector: [1, 0, 0],
          limit: 1,
          distanceMeasure: 'EUCLIDEAN',
        })
        .get();

      expect(snap.size).toBe(1);
      const only = snap.docs[0].data() as DocumentData;
      expect(only.tag).toBe('A');
    });
  });
}

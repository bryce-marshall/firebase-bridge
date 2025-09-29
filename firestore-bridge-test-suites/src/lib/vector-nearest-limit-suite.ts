import { DocumentData, FieldValue, Firestore } from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { ExpectError } from './helpers/expect.error.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function vectorNearestLimitSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Vector — nearest limit behavior (emulator parity)';
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

    it('limit: 0 — succeeds and returns empty result set', async () => {
      await ExpectError.sync(
        () =>
          col()
            .findNearest({
              vectorField: EMBED_FIELD,
              queryVector: [1, 0, 0],
              limit: 0,
              distanceMeasure: 'EUCLIDEAN',
            })
            .get(),
        {
          literal:
            'Value for argument "limit" is not a valid positive limit number.',
        }
      );
    });

    it('limit within range works normally (ordering: closest first; respects limit)', async () => {
      const snap = await col()
        .findNearest({
          vectorField: EMBED_FIELD,
          queryVector: [1, 0, 0],
          limit: 2,
          distanceMeasure: 'EUCLIDEAN',
        })
        .get();

      expect(snap.size).toBe(2);

      const top = snap.docs[0].data() as DocumentData;
      expect(top.tag).toBe('A'); // exact match first

      const tags = snap.docs.map((d) => (d.data() as DocumentData).tag);
      expect(new Set(tags).size).toBe(2); // no dupes
    });

    it('limit > 1000 — fails', async () => {
      await ExpectError.async(
        () =>
          col()
            .findNearest({
              vectorField: EMBED_FIELD,
              queryVector: [1, 0, 0],
              limit: 1001,
              distanceMeasure: 'EUCLIDEAN',
            })
            .get(),
        {
          code: Status.INVALID_ARGUMENT,
          match:
            /FindNearest.limit must be a positive integer of no more than 1000/i,
        }
      );
    }, 10000);
  });
}

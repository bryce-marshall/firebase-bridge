import { Firestore, Timestamp } from 'firebase-admin/firestore';
import { isDocDataEqual } from '../helpers/document-data.js';
import { FirestoreBridgeTestContext } from '../test-context.js';

export function docCreateTests(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'DocumentCreateTests';

  describe('Document Create Tests', () => {
    let Firestore: Firestore;

    beforeAll(async () => {
      Firestore = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('creates a new document', async () => {
      const ref = Firestore.collection(COLLECTION_ID).doc('doc1');
      const data = {
        a: 'a value',
        b: 54321,
        c: true,
        d: false,
        e: Timestamp.fromDate(new Date(2020, 4, 5)),
        f: {
          a: 'f.a value',
        },
      };

      const result = await ref.create(data);
      expect(result).toBeDefined();
      const doc = await ref.get();
      expect(doc).toBeDefined();
      expect(doc.exists).toBe(true);
      expect(doc.createTime && doc.createTime.isEqual(result.writeTime));
      const readData = doc.data();
      expect(readData).toBeDefined();
      // Should be a different instance
      expect(readData === data).toBe(false);
      expect(isDocDataEqual(data, readData)).toBe(true);
    });
  });
}

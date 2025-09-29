import { Firestore } from 'firebase-admin/firestore';
import { ErrorMessages } from '../helpers/error-messages.js';
import { ExpectError } from '../helpers/expect.error.js';
import { FirestoreBridgeTestContext } from '../test-context.js';

export function pathTests(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'PathTests';

  describe('Path Tests', () => {
    let Firestore: Firestore;

    beforeAll(async () => {
      Firestore = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('returns the expected collection sub-path', async () => {
      const ref = Firestore.collection(COLLECTION_ID).doc('doc1');
      expect(ref.path).toEqual(`${COLLECTION_ID}/doc1`);
    });

    it('generates a new document id', async () => {
      const ref = Firestore.collection(COLLECTION_ID).doc();
      expect(ref.path.startsWith(`${COLLECTION_ID}/`)).toBe(true);
      expect(ref.id.length).toEqual(20);
    });

    it('throws if invalid document subpath (from collection)', async () => {
      const path = 'doc1/col2';
      ExpectError.inline(() => Firestore.collection(COLLECTION_ID).doc(path), {
        message: ErrorMessages.invalidPathArgument(
          'document',
          'documentPath',
          path
        ),
      });
    });

    it('throws if invalid document subpath (from doc)', async () => {
      const path = `${COLLECTION_ID}/doc1/col2`;
      ExpectError.inline(() => Firestore.doc(path), {
        message: ErrorMessages.invalidPathArgument(
          'document',
          'documentPath',
          path
        ),
      });
    });

    it('throws if invalid collection subpath (from doc)', async () => {
      const path = 'col2/doc2';
      ExpectError.inline(
        () => Firestore.collection(COLLECTION_ID).doc('doc1').collection(path),
        {
          message: ErrorMessages.invalidPathArgument(
            'collection',
            'collectionPath',
            path
          ),
        }
      );
    });

    it('throws if invalid collection subpath (from collection)', async () => {
      const path = `${COLLECTION_ID}/doc1`;
      ExpectError.inline(() => Firestore.collection(path), {
        message: ErrorMessages.invalidPathArgument(
          'collection',
          'collectionPath',
          path
        ),
      });
    });
  });
}

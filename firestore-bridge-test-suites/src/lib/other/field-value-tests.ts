import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { ErrorMessages } from '../helpers/error-messages.js';
import { ExpectError } from '../helpers/expect.error.js';
import { FirestoreBridgeTestContext } from '../test-context.js';

export function fieldValueTests(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'FieldValueTests';

  describe('FieldValue Tests', () => {
    let Firestore: Firestore;

    beforeAll(async () => {
      Firestore = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('server time as array value', async () => {
      const ref = Firestore.collection(COLLECTION_ID).doc('doc1');
      const data = {
        f0: {
          f1: [FieldValue.serverTimestamp()],
        },
      };

      await ExpectError.sync(() => ref.create(data), {
        message: ErrorMessages.fieldValueInArray(
          'data',
          'serverTimestamp',
          'f0.f1',
          0
        ),
      });

      // await expectSyncError(
      //   () => ref.create(data),
      //   ErrorMessages.fieldValueInArray('data', 'serverTimestamp', 'f0.f1', 0)
      // );
    });
  });
}

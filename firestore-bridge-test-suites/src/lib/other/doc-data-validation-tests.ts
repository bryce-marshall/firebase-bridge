import {
  DocumentData,
  DocumentReference,
  Firestore,
  Timestamp,
  WithFieldValue,
} from 'firebase-admin/firestore';
import { ErrorMessages } from '../helpers/error-messages.js';
import { ExpectError } from '../helpers/expect.error.js';
import { FirestoreBridgeTestContext } from '../test-context.js';

const COLLECTION_ID = 'DocDataValidationTests';

class NotPojo {
  readonly value = 1;
}

export function docDataValidationTests(context: FirestoreBridgeTestContext) {
  let Firestore: Firestore;

  beforeAll(async () => {
    Firestore = await context.init();
  });

  afterAll(async () => {
    await context.tearDown();
  });

  describe('Doc Data Validation Tests', () => {
    it('throws if non-document data passed to create', async () => {
      const ref = Firestore.collection(COLLECTION_ID).doc('doc1');

      function exec(data: unknown): void {
        ExpectError.sync(
          () => ref.create(data as WithFieldValue<DocumentData>),
          {
            message: ErrorMessages.customObject('data', data),
          }
        );
      }

      exec([1, 2, 3]);
      exec(1);
      exec(new Number(1));
      exec('test');
      exec(new String('test'));
      exec(Timestamp.now());
      exec(true);
      exec(new Boolean(true));
      exec(false);
      exec(new Boolean(false));
      const notPojo = new NotPojo();
      exec(notPojo);
    });

    it('throws on boxed types', () => {
      const ref = Firestore.collection(COLLECTION_ID).doc('doc1');

      execCustomObject(ref, new String('test'), 'f1');
      execCustomObject(ref, new Number(1), 'f1');
      execCustomObject(ref, new Boolean(true), 'f1');
      execCustomObject(ref, new String('test'), 'f1.f2', true);
      execCustomObject(ref, new Number(1), 'f1.f2', true);
      execCustomObject(ref, new Boolean(true), 'f1.f2', true);
    });

    it('throws on boxed types in arrays', () => {
      const ref = Firestore.collection(COLLECTION_ID).doc('doc1');

      execCustomObject(ref, ['test0', new String('test`1')], 'f1.`1`');
      execCustomObject(ref, [1, new Number(1)], 'f1.`1`');
      execCustomObject(ref, [true, new Boolean(true)], 'f1.`1`');
      execCustomObject(ref, ['test0', new String('test`1')], 'f1.f2.`1`', true);
      execCustomObject(ref, [1, new Number(1)], 'f1.f2.`1`', true);
      execCustomObject(ref, [true, new Boolean(true)], 'f1.f2.`1`', true);
    });

    function execCustomObject(
      ref: DocumentReference,
      value: WithFieldValue<DocumentData>,
      path: string,
      doubleDepth = false
    ): void {
      const data = doubleDepth ? { f1: { f2: value } } : { f1: value };
      ExpectError.sync(() => ref.create(data), {
        message: ErrorMessages.customObject('data', value, path),
      });
    }
  });
}

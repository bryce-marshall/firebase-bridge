import { Firestore, Settings } from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from 'firestore-bridge-test-suites';
import { FirestoreMock } from '../../lib/controller';

const MockEnv = new FirestoreMock();

export function testContext(): FirestoreBridgeTestContext {
  const ctrl = MockEnv.createDatabase();
  const clients: Firestore[] = [];

  return {
    async init(
      collectionPath?: string,
      settings?: Settings
    ): Promise<Firestore> {
      const firestore = ctrl.firestore(settings);
      if (collectionPath && clients.length === 1) {
        await firestore.recursiveDelete(firestore.collection(collectionPath));
      }
      clients.push(firestore);

      return firestore;
    },
    async tearDown(): Promise<void> {
      return new Promise((resolve) => {
        queueMicrotask(async () => {
          let firestore = clients.pop();
          while (firestore) {
            await firestore.terminate();
            firestore = clients.pop();
          }
          resolve();
        });
      });
    },
  };
}

import * as admin from 'firebase-admin';
import type {
  CloudStorageBucket,
} from '@firebase-bridge/cloud-storage';
import { createFirebaseCloudStorageService } from '@firebase-bridge/cloud-storage';
import type {
  CloudStorageBridgeTestContext,
} from 'cloud-storage-test-suites';

const DEFAULT_PROJECT_ID = 'default-project';

if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  console.log(
    `*** Missing process.env.FIREBASE_STORAGE_EMULATOR_HOST
    ***
    *** Ensure that jest.setup.cjs contains
    *** process.env.FIREBASE_STORAGE_EMULATOR_HOST = 'localhost:9199';
    ***
    `
  );
}

interface StorageContext {
  readonly app: admin.app.App;
  readonly bucketId: string;
}

export function testContext(): CloudStorageBridgeTestContext {
  const clients: StorageContext[] = [];

  return {
    async init(bucketId = 'lifecycle.test') {
      const app = createApp(`cloud-storage-app-${clients.length}`, bucketId);
      clients.push({ app, bucketId });
      const service = createFirebaseCloudStorageService({ app });
      await clearBucket(service.bucket(bucketId));
      return service.bucket(bucketId);
    },
    service() {
      const latest = clients[clients.length - 1];
      if (!latest) {
        throw new Error('Cloud Storage production context has not been initialized.');
      }
      return createFirebaseCloudStorageService({ app: latest.app });
    },
    async tearDown() {
      let context = clients.pop();
      while (context) {
        const service = createFirebaseCloudStorageService({ app: context.app });
        await clearBucket(service.bucket(context.bucketId));
        await context.app.delete();
        context = clients.pop();
      }
    },
  };
}

function createApp(name: string, storageBucket: string): admin.app.App {
  return admin.initializeApp(
    {
      projectId: DEFAULT_PROJECT_ID,
      storageBucket,
    },
    name
  );
}

async function clearBucket(bucket: CloudStorageBucket): Promise<void> {
  const objects = await bucket.list();
  await Promise.all(
    objects.objects.map((object) =>
      bucket.delete(object.path, { ignoreMissing: true })
    )
  );
}

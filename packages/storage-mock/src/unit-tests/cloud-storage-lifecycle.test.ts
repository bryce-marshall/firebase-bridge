import {
  cloudStorageErrorModelSuite,
  cloudStorageLifecycleSuite,
  cloudStorageListingSuite,
  cloudStorageMetadataSuite,
  cloudStoragePreconditionsSuite,
} from 'cloud-storage-test-suites';
import { StorageMock } from '../index.js';

function testContext() {
  const env = new StorageMock();
  const ctrl = env.createStorage({ defaultBucket: 'lifecycle.test' });
  return {
    async init(bucketId?: string) {
      ctrl.resetAll();
      return ctrl.service().bucket(bucketId);
    },
    service() {
      return ctrl.service();
    },
    async tearDown() {
      ctrl.resetAll();
    },
  };
}

cloudStorageLifecycleSuite(testContext());
cloudStorageErrorModelSuite(testContext());
cloudStorageMetadataSuite(testContext());
cloudStoragePreconditionsSuite(testContext());
cloudStorageListingSuite(testContext());

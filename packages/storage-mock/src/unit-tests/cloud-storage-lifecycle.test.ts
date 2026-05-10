import { cloudStorageLifecycleSuite } from 'cloud-storage-test-suites';
import { StorageMock } from '../index.js';

const env = new StorageMock();
const ctrl = env.createStorage({ defaultBucket: 'lifecycle.test' });

cloudStorageLifecycleSuite({
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
});

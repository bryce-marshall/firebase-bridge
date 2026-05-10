import type {
  CloudStorageBucket,
  CloudStorageBucketId,
  CloudStorageService,
} from '@firebase-bridge/cloud-storage';

export interface CloudStorageBridgeTestContext {
  init(bucketId?: CloudStorageBucketId): Promise<CloudStorageBucket>;
  service(): CloudStorageService;
  tearDown(): Promise<void>;
}

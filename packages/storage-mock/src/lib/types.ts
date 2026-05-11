import type {
  CloudStorageBucketId,
  CloudStorageObjectEvent,
  CloudStorageObjectPath,
  CloudStorageWritableData,
  CloudStorageReadTextOptions,
  CloudStorageObjectMetadata,
  CloudStorageSignedReadUrlOptions,
  CloudStorageSignedUrlResult,
} from '@firebase-bridge/cloud-storage';

export type StorageOperationName =
  | 'exists'
  | 'read'
  | 'write'
  | 'delete'
  | 'getMetadata'
  | 'setMetadata'
  | 'list'
  | 'signedUrl'
  | 'seed'
  | 'testDelete';

export interface CreateStorageOptions {
  readonly defaultBucket?: CloudStorageBucketId;
  readonly projectId?: string;
  readonly location?: string;
  readonly signedUrlSigner?: StorageSignedUrlSigner;
}

export interface StorageMockOptions {
  readonly now?: () => number;
  readonly signedUrlSigner?: StorageSignedUrlSigner;
}

export interface StorageSignedUrlSignerArg {
  readonly bucketId: CloudStorageBucketId;
  readonly path: CloudStorageObjectPath;
  readonly options: CloudStorageSignedReadUrlOptions;
  readonly metadata: CloudStorageObjectMetadata;
}

export type StorageSignedUrlSigner = (
  arg: StorageSignedUrlSignerArg
) => CloudStorageSignedUrlResult | Promise<CloudStorageSignedUrlResult>;

export interface StorageChangeRecord extends CloudStorageObjectEvent {
  readonly epoch: number;
}

export type StorageChangeListener = (record: StorageChangeRecord) => void;

export interface StorageLifecycleEventArg {
  readonly type: 'reset' | 'delete';
  readonly epoch: number;
  readonly controller: StorageController;
}

export type StorageLifecycleListener = (arg: StorageLifecycleEventArg) => void;

export interface StorageOperationRecord {
  readonly operation: StorageOperationName;
  readonly bucketId?: CloudStorageBucketId;
  readonly path?: CloudStorageObjectPath;
  readonly at: Date;
  readonly success: boolean;
  readonly errorCode?: string;
}

export interface StorageFailureRule {
  readonly operation?: StorageOperationName;
  readonly bucketId?: CloudStorageBucketId;
  readonly path?: CloudStorageObjectPath;
  readonly code?: string;
  readonly message?: string;
}

export interface StorageSeedObjectOptions {
  readonly contentType?: string;
  readonly cacheControl?: string;
  readonly contentEncoding?: string;
  readonly contentDisposition?: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface StorageTestObjectSnapshot {
  readonly bucketId: CloudStorageBucketId;
  readonly path: CloudStorageObjectPath;
  readonly data: Uint8Array;
  readonly metadata: CloudStorageObjectMetadata;
}

export type StorageTimeSource = () => number;

export interface StorageTestClock {
  now(): number;
}

export interface StorageTestControl {
  reset(bucket: CloudStorageBucketId): void;
  resetAll(): void;
  delete(bucket: CloudStorageBucketId): void;
  deleteAll(): void;
  seedObject(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath,
    data: CloudStorageWritableData,
    options?: StorageSeedObjectOptions
  ): CloudStorageObjectMetadata;
  getObject(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath
  ): StorageTestObjectSnapshot | undefined;
  getObjectText(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath,
    options?: CloudStorageReadTextOptions
  ): string | undefined;
  hasObject(bucketId: CloudStorageBucketId, path: CloudStorageObjectPath): boolean;
  listObjects(bucketId?: CloudStorageBucketId): readonly StorageTestObjectSnapshot[];
  deleteObject(bucketId: CloudStorageBucketId, path: CloudStorageObjectPath): boolean;
  getOperationLog(): readonly StorageOperationRecord[];
  clearOperationLog(): void;
  failNext(rule: StorageFailureRule): void;
  setClock(clock: StorageTestClock | StorageTimeSource): void;
}

export interface StorageController extends StorageTestControl {
  readonly defaultBucket: CloudStorageBucketId;
  readonly projectId: string;
  readonly location: string;
  readonly epoch: number;
  service(): import('@firebase-bridge/cloud-storage').CloudStorageService;
  onObjectChange(listener: StorageChangeListener): () => void;
  watchLifecycle(listener: StorageLifecycleListener): () => void;
}

export type StorageTriggerPredicate = (arg: StorageChangeRecord) => boolean;

export type TriggerKey = string | number;

export enum StorageTriggerErrorOrigin {
  Predicate,
  OnBefore,
  Execute,
  OnAfter,
}

export interface RegisterStorageTriggerOptions {
  predicate?(arg: StorageChangeRecord): boolean;
  onBefore?(arg: StorageChangeRecord): void;
  onAfter?(arg: StorageChangeRecord): void;
  onError?(arg: StorageTriggerRunnerErrorEventArg): void;
}

export interface StorageTriggerRunnerErrorEventArg {
  readonly origin: StorageTriggerErrorOrigin;
  readonly arg: StorageChangeRecord;
  readonly cause: unknown;
}

export interface StorageTriggerStats<TKey extends TriggerKey> {
  readonly key: TKey;
  readonly initiatedCount: number;
  readonly completedCount: number;
  readonly errorCount: number;
}

export interface StorageOrchestratorEventArg<TKey extends TriggerKey>
  extends StorageChangeRecord,
    StorageTriggerStats<TKey> {
  readonly origin?: StorageTriggerErrorOrigin;
  readonly cause?: unknown;
}

export interface StorageOrchestratorErrorEventArg<TKey extends TriggerKey>
  extends StorageOrchestratorEventArg<TKey> {
  readonly origin: StorageTriggerErrorOrigin;
  readonly cause: unknown;
}

export interface StorageTriggerObserver<TKey extends TriggerKey> {
  before?(arg: StorageOrchestratorEventArg<TKey>): void;
  after?(arg: StorageOrchestratorEventArg<TKey>): void;
  error?(arg: StorageOrchestratorErrorEventArg<TKey>): void;
}

export interface WaitOptions {
  readonly timeout?: number;
  readonly cancelOnError?: boolean;
}

export type WaitErrorOptions = Pick<WaitOptions, 'timeout'>;

export type StorageTriggerErrorWatcher<TKey extends TriggerKey> = (
  arg: StorageOrchestratorErrorEventArg<TKey>
) => void;

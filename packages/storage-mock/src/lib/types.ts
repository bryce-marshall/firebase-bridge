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

/** Names of mock storage operations that can be logged or failed. */
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

/** Options for creating a controller from a storage mock. */
export interface CreateStorageOptions {
  /** Default bucket id used when callers omit a bucket. */
  readonly defaultBucket?: CloudStorageBucketId;

  /** Project id surfaced by the test controller. */
  readonly projectId?: string;

  /** Storage location surfaced by the test controller. */
  readonly location?: string;

  /** Signed URL signer override for this controller. */
  readonly signedUrlSigner?: StorageSignedUrlSigner;
}

/** Options for configuring a storage mock instance. */
export interface StorageMockOptions {
  /** Time source used for metadata timestamps and operation logs. */
  readonly now?: () => number;

  /** Default signer used to create signed read URLs. */
  readonly signedUrlSigner?: StorageSignedUrlSigner;
}

/** Input passed to a mock signed URL signer. */
export interface StorageSignedUrlSignerArg {
  /** Bucket id for the object being signed. */
  readonly bucketId: CloudStorageBucketId;

  /** Object path being signed. */
  readonly path: CloudStorageObjectPath;

  /** Signed URL options requested by the caller. */
  readonly options: CloudStorageSignedReadUrlOptions;

  /** Metadata for the object being signed. */
  readonly metadata: CloudStorageObjectMetadata;
}

/** Creates a signed URL result for a mock storage object. */
export type StorageSignedUrlSigner = (
  arg: StorageSignedUrlSignerArg
) => CloudStorageSignedUrlResult | Promise<CloudStorageSignedUrlResult>;

/** Object-change record emitted by the storage mock. */
export interface StorageChangeRecord extends CloudStorageObjectEvent {
  /** Controller epoch in which the change occurred. */
  readonly epoch: number;
}

/** Listener invoked for each mock object-change record. */
export type StorageChangeListener = (record: StorageChangeRecord) => void;

/** Lifecycle event emitted when mock buckets are reset or deleted. */
export interface StorageLifecycleEventArg {
  /** Lifecycle action that occurred. */
  readonly type: 'reset' | 'delete';

  /** Controller epoch after the lifecycle change. */
  readonly epoch: number;

  /** Controller associated with the lifecycle event. */
  readonly controller: StorageController;
}

/** Listener invoked for mock storage lifecycle events. */
export type StorageLifecycleListener = (arg: StorageLifecycleEventArg) => void;

/** Operation log entry captured by the mock controller. */
export interface StorageOperationRecord {
  /** Operation that was attempted. */
  readonly operation: StorageOperationName;

  /** Bucket id associated with the operation, when any. */
  readonly bucketId?: CloudStorageBucketId;

  /** Object path associated with the operation, when any. */
  readonly path?: CloudStorageObjectPath;

  /** Time at which the operation was logged. */
  readonly at: Date;

  /** Whether the operation completed successfully. */
  readonly success: boolean;

  /** Error code recorded for failed injected operations. */
  readonly errorCode?: string;
}

/** Rule that makes the next matching operation fail. */
export interface StorageFailureRule {
  /** Operation name to match, or any operation when omitted. */
  readonly operation?: StorageOperationName;

  /** Bucket id to match, or any bucket when omitted. */
  readonly bucketId?: CloudStorageBucketId;

  /** Object path to match, or any path when omitted. */
  readonly path?: CloudStorageObjectPath;

  /** Error code to throw for the injected failure. */
  readonly code?: string;

  /** Error message to throw for the injected failure. */
  readonly message?: string;
}

/** Metadata options used when seeding a test object. */
export interface StorageSeedObjectOptions {
  /** MIME content type for the seeded object. */
  readonly contentType?: string;

  /** Cache-Control header for the seeded object. */
  readonly cacheControl?: string;

  /** Content-Encoding header for the seeded object. */
  readonly contentEncoding?: string;

  /** Content-Disposition header for the seeded object. */
  readonly contentDisposition?: string;

  /** User-defined metadata for the seeded object. */
  readonly customMetadata?: Readonly<Record<string, string>>;
}

/** Snapshot of an object stored in the mock. */
export interface StorageTestObjectSnapshot {
  /** Bucket id that contains the object. */
  readonly bucketId: CloudStorageBucketId;

  /** Object path within the bucket. */
  readonly path: CloudStorageObjectPath;

  /** Defensive copy of object bytes. */
  readonly data: Uint8Array;

  /** Object metadata. */
  readonly metadata: CloudStorageObjectMetadata;
}

/** Function that returns the current mock time in epoch milliseconds. */
export type StorageTimeSource = () => number;

/** Clock object accepted by storage test controls. */
export interface StorageTestClock {
  /** Returns the current mock time in epoch milliseconds. */
  now(): number;
}

/** Test-only controls for inspecting and mutating mock storage state. */
export interface StorageTestControl {
  /** Clears all objects in a bucket. */
  reset(bucket: CloudStorageBucketId): void;

  /** Clears all objects in all buckets. */
  resetAll(): void;

  /** Deletes an entire bucket from the mock. */
  delete(bucket: CloudStorageBucketId): void;

  /** Deletes all buckets from the mock. */
  deleteAll(): void;

  /** Creates or replaces an object without invoking service write APIs. */
  seedObject(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath,
    data: CloudStorageWritableData,
    options?: StorageSeedObjectOptions
  ): CloudStorageObjectMetadata;

  /** Gets a snapshot of an object, if it exists. */
  getObject(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath
  ): StorageTestObjectSnapshot | undefined;

  /** Gets object text, if the object exists. */
  getObjectText(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath,
    options?: CloudStorageReadTextOptions
  ): string | undefined;

  /** Returns whether an object exists. */
  hasObject(bucketId: CloudStorageBucketId, path: CloudStorageObjectPath): boolean;

  /** Lists object snapshots, optionally scoped to one bucket. */
  listObjects(bucketId?: CloudStorageBucketId): readonly StorageTestObjectSnapshot[];

  /** Deletes an object directly through test controls. */
  deleteObject(bucketId: CloudStorageBucketId, path: CloudStorageObjectPath): boolean;

  /** Returns the current operation log. */
  getOperationLog(): readonly StorageOperationRecord[];

  /** Clears the operation log. */
  clearOperationLog(): void;

  /** Fails the next operation matching a rule. */
  failNext(rule: StorageFailureRule): void;

  /** Sets the controller clock source. */
  setClock(clock: StorageTestClock | StorageTimeSource): void;
}

/** Storage test controller that exposes a Cloud Storage service and test controls. */
export interface StorageController extends StorageTestControl {
  /** Default bucket id used by the service. */
  readonly defaultBucket: CloudStorageBucketId;

  /** Project id associated with the controller. */
  readonly projectId: string;

  /** Storage location associated with the controller. */
  readonly location: string;

  /** Lifecycle epoch used to scope trigger delivery. */
  readonly epoch: number;

  /** Creates a Cloud Storage service backed by this controller. */
  service(): import('@firebase-bridge/cloud-storage').CloudStorageService;

  /** Registers a listener for object-change records. */
  onObjectChange(listener: StorageChangeListener): () => void;

  /** Registers a listener for reset/delete lifecycle events. */
  watchLifecycle(listener: StorageLifecycleListener): () => void;
}

/** Predicate used to decide whether a trigger receives a change record. */
export type StorageTriggerPredicate = (arg: StorageChangeRecord) => boolean;

/** Key type used to identify orchestrated trigger stubs. */
export type TriggerKey = string | number;

/** Phase in which a storage trigger runner error occurred. */
export enum StorageTriggerErrorOrigin {
  /** Error occurred while evaluating the predicate. */
  Predicate,

  /** Error occurred in an onBefore hook. */
  OnBefore,

  /** Error occurred while executing the trigger handler. */
  Execute,

  /** Error occurred in an onAfter hook. */
  OnAfter,
}

/** Options used when registering a mock storage trigger. */
export interface RegisterStorageTriggerOptions {
  /** Optional predicate that can suppress delivery for a record. */
  predicate?(arg: StorageChangeRecord): boolean;

  /** Hook invoked before the trigger handler runs. */
  onBefore?(arg: StorageChangeRecord): void;

  /** Hook invoked after the trigger handler completes. */
  onAfter?(arg: StorageChangeRecord): void;

  /** Hook invoked when predicate, handler, or lifecycle hooks throw. */
  onError?(arg: StorageTriggerRunnerErrorEventArg): void;
}

/** Error event emitted by a registered trigger runner. */
export interface StorageTriggerRunnerErrorEventArg {
  /** Phase in which the error occurred. */
  readonly origin: StorageTriggerErrorOrigin;

  /** Change record being processed. */
  readonly arg: StorageChangeRecord;

  /** Original thrown value. */
  readonly cause: unknown;
}

/** Execution counters for an orchestrated trigger. */
export interface StorageTriggerStats<TKey extends TriggerKey> {
  /** Trigger key associated with the counters. */
  readonly key: TKey;

  /** Number of trigger executions that started. */
  readonly initiatedCount: number;

  /** Number of trigger executions that completed successfully. */
  readonly completedCount: number;

  /** Number of trigger executions that reported an error. */
  readonly errorCount: number;
}

/** Observer event emitted for orchestrated trigger activity. */
export interface StorageOrchestratorEventArg<TKey extends TriggerKey>
  extends StorageChangeRecord,
    StorageTriggerStats<TKey> {
  /** Error phase, present for error events. */
  readonly origin?: StorageTriggerErrorOrigin;

  /** Error cause, present for error events. */
  readonly cause?: unknown;
}

/** Error event emitted for orchestrated trigger failures. */
export interface StorageOrchestratorErrorEventArg<TKey extends TriggerKey>
  extends StorageOrchestratorEventArg<TKey> {
  /** Phase in which the error occurred. */
  readonly origin: StorageTriggerErrorOrigin;

  /** Original thrown value. */
  readonly cause: unknown;
}

/** Observer hooks for a single orchestrated trigger. */
export interface StorageTriggerObserver<TKey extends TriggerKey> {
  /** Hook invoked before a trigger handler executes. */
  before?(arg: StorageOrchestratorEventArg<TKey>): void;

  /** Hook invoked after a trigger handler completes. */
  after?(arg: StorageOrchestratorEventArg<TKey>): void;

  /** Hook invoked when a trigger handler or observer reports an error. */
  error?(arg: StorageOrchestratorErrorEventArg<TKey>): void;
}

/** Options for waiting on orchestrated trigger activity. */
export interface WaitOptions {
  /** Maximum wait time in milliseconds. */
  readonly timeout?: number;

  /** Whether a trigger error should cancel a non-error wait. */
  readonly cancelOnError?: boolean;
}

/** Options for waiting on orchestrated trigger errors. */
export type WaitErrorOptions = Pick<WaitOptions, 'timeout'>;

/** Listener invoked for any orchestrated trigger error. */
export type StorageTriggerErrorWatcher<TKey extends TriggerKey> = (
  arg: StorageOrchestratorErrorEventArg<TKey>
) => void;

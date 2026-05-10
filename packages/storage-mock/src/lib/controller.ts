import { createHash } from 'node:crypto';
import {
  cloudStorageError,
  CloudStorageBucket,
  CloudStorageBucketId,
  CloudStorageDeleteOptions,
  CloudStorageDeleteResult,
  CloudStorageError,
  CloudStorageListOptions,
  CloudStorageListResult,
  CloudStorageObject,
  CloudStorageObjectMetadata,
  CloudStorageObjectPath,
  CloudStoragePrecondition,
  CloudStorageReadResult,
  CloudStorageReadTextOptions,
  CloudStorageService,
  CloudStorageSetMetadata,
  CloudStorageSignedReadUrlOptions,
  CloudStorageSignedUrlResult,
  CloudStorageWritableData,
  CloudStorageWriteOptions,
  CloudStorageWriteResult,
  CloudStorageWriteTextOptions,
} from '@firebase-bridge/cloud-storage';
import { Listeners } from './listeners.js';
import {
  CreateStorageOptions,
  StorageMockOptions,
  StorageChangeListener,
  StorageChangeRecord,
  StorageController,
  StorageFailureRule,
  StorageLifecycleEventArg,
  StorageLifecycleListener,
  StorageOperationName,
  StorageOperationRecord,
  StorageSeedObjectOptions,
  StorageTestClock,
  StorageTimeSource,
  StorageTestObjectSnapshot,
} from './types.js';

const DEFAULT_BUCKET = 'default.test';
const DEFAULT_PROJECT = 'default-project';
const DEFAULT_LOCATION = 'nam5';

interface StoredObject {
  readonly data: Uint8Array;
  readonly metadata: CloudStorageObjectMetadata;
}

class BucketState {
  readonly objects = new Map<string, StoredObject>();
  nextGeneration = 1;
}

export class StorageMock {
  private readonly buckets = new Map<string, BucketState>();
  private readonly controllers = new Set<InMemoryStorageController>();
  private readonly nowSource: StorageTimeSource;

  constructor(options?: StorageMockOptions) {
    this.nowSource = options?.now ?? (() => Date.now());
  }

  createStorage(options?: CreateStorageOptions): StorageController {
    const ctrl = new InMemoryStorageController(this, options);
    this.controllers.add(ctrl);
    return ctrl;
  }

  reset(bucket: CloudStorageBucketId): void {
    this.buckets.get(bucket)?.objects.clear();
    this.controllers.forEach((ctrl) => ctrl.bumpEpoch('reset'));
  }

  resetAll(): void {
    this.buckets.forEach((bucket) => bucket.objects.clear());
    this.controllers.forEach((ctrl) => ctrl.bumpEpoch('reset'));
  }

  delete(bucket: CloudStorageBucketId): void {
    this.buckets.delete(bucket);
    this.controllers.forEach((ctrl) => ctrl.bumpEpoch('delete'));
  }

  deleteAll(): void {
    this.buckets.clear();
    this.controllers.forEach((ctrl) => ctrl.bumpEpoch('delete'));
  }

  getBucket(bucketId: string): BucketState {
    let bucket = this.buckets.get(bucketId);
    if (!bucket) {
      bucket = new BucketState();
      this.buckets.set(bucketId, bucket);
    }
    return bucket;
  }

  maybeBucket(bucketId: string): BucketState | undefined {
    return this.buckets.get(bucketId);
  }

  now(): number {
    return this.nowSource();
  }
}

class InMemoryStorageController implements StorageController {
  private readonly changeListeners = new Listeners<StorageChangeRecord>();
  private readonly lifecycleListeners = new Listeners<StorageLifecycleEventArg>();
  private readonly operationLog: StorageOperationRecord[] = [];
  private readonly failures: StorageFailureRule[] = [];
  private nowSource: StorageTimeSource;
  private _epoch = 0;

  readonly defaultBucket: CloudStorageBucketId;
  readonly projectId: string;
  readonly location: string;

  constructor(
    private readonly mock: StorageMock,
    options?: CreateStorageOptions
  ) {
    this.defaultBucket = options?.defaultBucket ?? DEFAULT_BUCKET;
    this.projectId = options?.projectId ?? DEFAULT_PROJECT;
    this.location = options?.location ?? DEFAULT_LOCATION;
    this.nowSource = () => mock.now();
  }

  get epoch(): number {
    return this._epoch;
  }

  service(): CloudStorageService {
    return new InMemoryCloudStorageService(this);
  }

  reset(bucket: CloudStorageBucketId): void {
    this.mock.reset(bucket);
  }

  resetAll(): void {
    this.mock.resetAll();
  }

  delete(bucket: CloudStorageBucketId): void {
    this.mock.delete(bucket);
  }

  deleteAll(): void {
    this.mock.deleteAll();
  }

  seedObject(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath,
    data: CloudStorageWritableData,
    options?: StorageSeedObjectOptions
  ): CloudStorageObjectMetadata {
    this.assertPath(path);
    this.failIfRequested('seed', bucketId, path);
    const bucket = this.mock.getBucket(bucketId);
    const previous = bucket.objects.get(path);
    const metadata = this.makeMetadata(bucketId, path, toBytes(data), options, {
      previous,
      metageneration: '1',
    });
    bucket.objects.set(path, {
      data: toBytes(data),
      metadata,
    });
    this.log('seed', bucketId, path, true);
    return metadata;
  }

  getObject(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath
  ): StorageTestObjectSnapshot | undefined {
    const object = this.mock.maybeBucket(bucketId)?.objects.get(path);
    return object ? snapshot(bucketId, path, object) : undefined;
  }

  getObjectText(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath,
    options?: CloudStorageReadTextOptions
  ): string | undefined {
    const object = this.getObject(bucketId, path);
    return object
      ? Buffer.from(object.data).toString(options?.encoding ?? 'utf8')
      : undefined;
  }

  hasObject(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath
  ): boolean {
    return this.mock.maybeBucket(bucketId)?.objects.has(path) === true;
  }

  listObjects(
    bucketId?: CloudStorageBucketId
  ): readonly StorageTestObjectSnapshot[] {
    const entries: StorageTestObjectSnapshot[] = [];
    const buckets = bucketId
      ? [[bucketId, this.mock.maybeBucket(bucketId)] as const]
      : [...this.bucketEntries()];
    for (const [id, bucket] of buckets) {
      if (!bucket) continue;
      for (const [path, object] of bucket.objects) {
        entries.push(snapshot(id, path, object));
      }
    }
    return Object.freeze(entries.sort((a, b) => a.path.localeCompare(b.path)));
  }

  deleteObject(
    bucketId: CloudStorageBucketId,
    path: CloudStorageObjectPath
  ): boolean {
    this.failIfRequested('testDelete', bucketId, path);
    const deleted = this.mock.maybeBucket(bucketId)?.objects.delete(path) === true;
    this.log('testDelete', bucketId, path, true);
    return deleted;
  }

  getOperationLog(): readonly StorageOperationRecord[] {
    return Object.freeze([...this.operationLog]);
  }

  clearOperationLog(): void {
    this.operationLog.length = 0;
  }

  failNext(rule: StorageFailureRule): void {
    this.failures.push(rule);
  }

  setClock(clock: StorageTestClock | StorageTimeSource): void {
    this.nowSource =
      typeof clock === 'function' ? clock : () => clock.now();
  }

  onObjectChange(listener: StorageChangeListener): () => void {
    return this.changeListeners.register(listener);
  }

  watchLifecycle(listener: StorageLifecycleListener): () => void {
    return this.lifecycleListeners.register(listener);
  }

  bumpEpoch(type: 'reset' | 'delete'): void {
    this._epoch += 1;
    this.lifecycleListeners.next({
      type,
      epoch: this._epoch,
      controller: this,
    });
  }

  exists(bucketId: string, path: string): boolean {
    this.assertPath(path);
    this.failIfRequested('exists', bucketId, path);
    const exists = this.hasObject(bucketId, path);
    this.log('exists', bucketId, path, true);
    return exists;
  }

  read(bucketId: string, path: string): CloudStorageReadResult {
    this.assertPath(path);
    this.failIfRequested('read', bucketId, path);
    const object = this.requireObject(bucketId, path);
    this.log('read', bucketId, path, true);
    return {
      data: copyBytes(object.data),
      metadata: object.metadata,
    };
  }

  write(
    bucketId: string,
    path: string,
    data: CloudStorageWritableData,
    options?: CloudStorageWriteOptions
  ): CloudStorageWriteResult {
    this.assertPath(path);
    this.failIfRequested('write', bucketId, path);
    const bucket = this.mock.getBucket(bucketId);
    const previous = bucket.objects.get(path);
    this.assertPrecondition(previous, options?.precondition, path);
    const bytes = toBytes(data);
    const metadata = this.makeMetadata(bucketId, path, bytes, options?.metadata, {
      previous,
      metageneration: '1',
    });
    bucket.objects.set(path, {
      data: bytes,
      metadata,
    });
    this.log('write', bucketId, path, true);
    this.emit(previous ? 'finalized' : 'finalized', metadata, previous?.metadata);
    return { metadata };
  }

  deleteObjectOperation(
    bucketId: string,
    path: string,
    options?: CloudStorageDeleteOptions
  ): CloudStorageDeleteResult {
    this.assertPath(path);
    this.failIfRequested('delete', bucketId, path);
    const bucket = this.mock.maybeBucket(bucketId);
    const previous = bucket?.objects.get(path);
    if (!previous) {
      if (options?.ignoreMissing === true) {
        this.log('delete', bucketId, path, true);
        return { deleted: false };
      }
      throw this.objectNotFound(path);
    }
    this.assertPrecondition(previous, options?.precondition, path);
    bucket?.objects.delete(path);
    this.log('delete', bucketId, path, true);
    this.emit('deleted', previous.metadata, previous.metadata);
    return { deleted: true, metadata: previous.metadata };
  }

  getMetadata(bucketId: string, path: string): CloudStorageObjectMetadata {
    this.assertPath(path);
    this.failIfRequested('getMetadata', bucketId, path);
    const object = this.requireObject(bucketId, path);
    this.log('getMetadata', bucketId, path, true);
    return object.metadata;
  }

  setMetadata(
    bucketId: string,
    path: string,
    metadata: CloudStorageSetMetadata
  ): CloudStorageObjectMetadata {
    this.assertPath(path);
    this.failIfRequested('setMetadata', bucketId, path);
    const bucket = this.mock.maybeBucket(bucketId);
    const previous = bucket?.objects.get(path);
    if (!bucket || !previous) throw this.objectNotFound(path);
    this.assertPrecondition(previous, metadata.precondition, path);
    const next = this.makeMetadata(bucketId, path, previous.data, metadata, {
      previous,
      generation: previous.metadata.generation,
      metageneration: String(Number(previous.metadata.metageneration) + 1),
    });
    bucket.objects.set(path, {
      data: copyBytes(previous.data),
      metadata: next,
    });
    this.log('setMetadata', bucketId, path, true);
    this.emit('metadata-updated', next, previous.metadata);
    return next;
  }

  list(bucketId: string, options?: CloudStorageListOptions): CloudStorageListResult {
    this.failIfRequested('list', bucketId);
    const bucket = this.mock.maybeBucket(bucketId);
    const all = bucket
      ? [...bucket.objects.values()]
          .map((object) => object.metadata)
          .filter((metadata) =>
            options?.prefix ? metadata.path.startsWith(options.prefix) : true
          )
          .sort((a, b) => a.path.localeCompare(b.path))
      : [];
    const start = options?.pageToken ? Number(options.pageToken) : 0;
    const pageSize = options?.pageSize ?? all.length;
    const objects = all.slice(start, start + pageSize);
    const next = start + pageSize < all.length ? String(start + pageSize) : undefined;
    this.log('list', bucketId, undefined, true);
    return {
      objects: Object.freeze(objects),
      nextPageToken: next,
    };
  }

  createSignedReadUrl(
    bucketId: string,
    path: string,
    options: CloudStorageSignedReadUrlOptions
  ): CloudStorageSignedUrlResult {
    this.assertPath(path);
    this.failIfRequested('signedUrl', bucketId, path);
    this.requireObject(bucketId, path);
    this.log('signedUrl', bucketId, path, true);
    const encoded = encodeURIComponent(path);
    return {
      url: `https://storage-mock.local/${encodeURIComponent(bucketId)}/${encoded}?expires=${options.expiresAt.getTime()}`,
      expiresAt: new Date(options.expiresAt),
    };
  }

  private *bucketEntries(): IterableIterator<readonly [string, BucketState]> {
    const buckets = this.mock as unknown as { buckets: Map<string, BucketState> };
    yield* buckets.buckets.entries();
  }

  private makeMetadata(
    bucketId: string,
    path: string,
    data: Uint8Array,
    input: StorageSeedObjectOptions | CloudStorageSetMetadata | CloudStorageWriteOptions['metadata'] | undefined,
    options: {
      previous?: StoredObject;
      generation?: string;
      metageneration: string;
    }
  ): CloudStorageObjectMetadata {
    const previous = options.previous?.metadata;
    const bucket = this.mock.getBucket(bucketId);
    const generation = options.generation ?? String(bucket.nextGeneration++);
    const now = this.nowDate();
    const createdAt = previous?.createdAt ?? now;
    const customMetadata = input?.customMetadata ?? previous?.customMetadata ?? {};
    const metadata = {
      bucketId,
      path,
      name: path,
      size: data.byteLength,
      contentType: input?.contentType ?? previous?.contentType,
      cacheControl: input?.cacheControl ?? previous?.cacheControl,
      contentEncoding: input?.contentEncoding ?? previous?.contentEncoding,
      contentDisposition: input?.contentDisposition ?? previous?.contentDisposition,
      customMetadata: Object.freeze({ ...customMetadata }),
      generation,
      metageneration: options.metageneration,
      etag: hash(`${bucketId}/${path}/${generation}/${options.metageneration}`),
      md5Hash: createHash('md5').update(data).digest('base64'),
      crc32c: hash(Buffer.from(data).toString('base64')).slice(0, 8),
      createdAt: new Date(createdAt),
      updatedAt: new Date(now),
    };
    return Object.freeze(metadata);
  }

  private assertPrecondition(
    object: StoredObject | undefined,
    precondition: CloudStoragePrecondition | undefined,
    path: string
  ): void {
    if (!precondition || precondition.type === 'none') return;
    const metadata = object?.metadata;
    const fail = () => {
      throw cloudStorageError(
        'storage/precondition-failed',
        `Cloud Storage precondition failed for "${path}".`
      );
    };
    switch (precondition.type) {
      case 'does-not-exist':
        if (object) fail();
        break;
      case 'generation-match':
        if (!metadata || metadata.generation !== precondition.generation) fail();
        break;
      case 'metageneration-match':
        if (!metadata || metadata.metageneration !== precondition.metageneration) fail();
        break;
      case 'generation-and-metageneration-match':
        if (
          !metadata ||
          metadata.generation !== precondition.generation ||
          metadata.metageneration !== precondition.metageneration
        ) {
          fail();
        }
        break;
    }
  }

  private requireObject(bucketId: string, path: string): StoredObject {
    const object = this.mock.maybeBucket(bucketId)?.objects.get(path);
    if (!object) throw this.objectNotFound(path);
    return object;
  }

  private objectNotFound(path: string): CloudStorageError {
    return cloudStorageError('storage/object-not-found', `Object "${path}" was not found.`);
  }

  private assertPath(path: string): void {
    if (!path || path.startsWith('/')) {
      throw cloudStorageError('storage/invalid-path', `Invalid object path "${path}".`);
    }
  }

  private emit(
    kind: StorageChangeRecord['kind'],
    metadata: CloudStorageObjectMetadata,
    previousMetadata?: CloudStorageObjectMetadata
  ): void {
    const event: StorageChangeRecord = Object.freeze({
      id: `${this._epoch}:${metadata.bucketId}:${metadata.path}:${metadata.generation}:${metadata.metageneration}:${kind}`,
      epoch: this._epoch,
      kind,
      bucketId: metadata.bucketId,
      path: metadata.path,
      eventTime: this.nowDate(),
      metadata,
      previousMetadata,
    });
    this.changeListeners.next(event);
  }

  private failIfRequested(
    operation: StorageOperationName,
    bucketId?: string,
    path?: string
  ): void {
    const index = this.failures.findIndex((rule) => {
      return (
        (!rule.operation || rule.operation === operation) &&
        (!rule.bucketId || rule.bucketId === bucketId) &&
        (!rule.path || rule.path === path)
      );
    });
    if (index < 0) return;
    const [rule] = this.failures.splice(index, 1);
    const code = rule.code ?? 'storage/unavailable';
    this.log(operation, bucketId, path, false, code);
    throw cloudStorageError(
      code as never,
      rule.message ?? `Injected Cloud Storage failure for ${operation}.`
    );
  }

  private log(
    operation: StorageOperationName,
    bucketId: string | undefined,
    path: string | undefined,
    success: boolean,
    errorCode?: string
  ): void {
    this.operationLog.push(
      Object.freeze({
        operation,
        bucketId,
        path,
        at: this.nowDate(),
        success,
        errorCode,
      })
    );
  }

  private nowDate(): Date {
    return new Date(this.nowSource());
  }
}

class InMemoryCloudStorageService implements CloudStorageService {
  constructor(private readonly ctrl: InMemoryStorageController) {}

  bucket(bucketId?: CloudStorageBucketId): CloudStorageBucket {
    return new InMemoryCloudStorageBucket(
      this.ctrl,
      bucketId ?? this.ctrl.defaultBucket
    );
  }
}

class InMemoryCloudStorageBucket implements CloudStorageBucket {
  constructor(
    private readonly ctrl: InMemoryStorageController,
    readonly bucketId: CloudStorageBucketId
  ) {}

  object(path: CloudStorageObjectPath): CloudStorageObject {
    return new InMemoryCloudStorageObject(this, path);
  }

  async exists(path: CloudStorageObjectPath): Promise<boolean> {
    return this.ctrl.exists(this.bucketId, path);
  }

  async read(path: CloudStorageObjectPath): Promise<CloudStorageReadResult> {
    return this.ctrl.read(this.bucketId, path);
  }

  async readText(
    path: CloudStorageObjectPath,
    options?: CloudStorageReadTextOptions
  ): Promise<string> {
    const result = await this.read(path);
    return Buffer.from(result.data).toString(options?.encoding ?? 'utf8');
  }

  async write(
    path: CloudStorageObjectPath,
    data: CloudStorageWritableData,
    options?: CloudStorageWriteOptions
  ): Promise<CloudStorageWriteResult> {
    return this.ctrl.write(this.bucketId, path, data, options);
  }

  writeText(
    path: CloudStorageObjectPath,
    text: string,
    options?: CloudStorageWriteTextOptions
  ): Promise<CloudStorageWriteResult> {
    return this.write(path, Buffer.from(text, options?.encoding ?? 'utf8'), options);
  }

  async delete(
    path: CloudStorageObjectPath,
    options?: CloudStorageDeleteOptions
  ): Promise<CloudStorageDeleteResult> {
    return this.ctrl.deleteObjectOperation(this.bucketId, path, options);
  }

  async getMetadata(
    path: CloudStorageObjectPath
  ): Promise<CloudStorageObjectMetadata> {
    return this.ctrl.getMetadata(this.bucketId, path);
  }

  async setMetadata(
    path: CloudStorageObjectPath,
    metadata: CloudStorageSetMetadata
  ): Promise<CloudStorageObjectMetadata> {
    return this.ctrl.setMetadata(this.bucketId, path, metadata);
  }

  async list(options?: CloudStorageListOptions): Promise<CloudStorageListResult> {
    return this.ctrl.list(this.bucketId, options);
  }

  async createSignedReadUrl(
    path: CloudStorageObjectPath,
    options: CloudStorageSignedReadUrlOptions
  ): Promise<CloudStorageSignedUrlResult> {
    return this.ctrl.createSignedReadUrl(this.bucketId, path, options);
  }
}

class InMemoryCloudStorageObject implements CloudStorageObject {
  readonly bucketId: CloudStorageBucketId;

  constructor(
    private readonly bucketRef: InMemoryCloudStorageBucket,
    readonly path: CloudStorageObjectPath
  ) {
    this.bucketId = bucketRef.bucketId;
  }

  exists(): Promise<boolean> {
    return this.bucketRef.exists(this.path);
  }

  read(): Promise<CloudStorageReadResult> {
    return this.bucketRef.read(this.path);
  }

  readText(options?: CloudStorageReadTextOptions): Promise<string> {
    return this.bucketRef.readText(this.path, options);
  }

  write(
    data: CloudStorageWritableData,
    options?: CloudStorageWriteOptions
  ): Promise<CloudStorageWriteResult> {
    return this.bucketRef.write(this.path, data, options);
  }

  writeText(
    text: string,
    options?: CloudStorageWriteTextOptions
  ): Promise<CloudStorageWriteResult> {
    return this.bucketRef.writeText(this.path, text, options);
  }

  delete(options?: CloudStorageDeleteOptions): Promise<CloudStorageDeleteResult> {
    return this.bucketRef.delete(this.path, options);
  }

  getMetadata(): Promise<CloudStorageObjectMetadata> {
    return this.bucketRef.getMetadata(this.path);
  }

  setMetadata(
    metadata: CloudStorageSetMetadata
  ): Promise<CloudStorageObjectMetadata> {
    return this.bucketRef.setMetadata(this.path, metadata);
  }

  createSignedReadUrl(
    options: CloudStorageSignedReadUrlOptions
  ): Promise<CloudStorageSignedUrlResult> {
    return this.bucketRef.createSignedReadUrl(this.path, options);
  }
}

function toBytes(data: CloudStorageWritableData): Uint8Array {
  return typeof data === 'string'
    ? new Uint8Array(Buffer.from(data))
    : copyBytes(data);
}

function copyBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data);
}

function snapshot(
  bucketId: string,
  path: string,
  object: StoredObject
): StorageTestObjectSnapshot {
  return Object.freeze({
    bucketId,
    path,
    data: copyBytes(object.data),
    metadata: object.metadata,
  });
}

function hash(value: string): string {
  return createHash('sha1').update(value).digest('base64url');
}

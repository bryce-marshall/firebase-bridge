import type { EventContext } from 'firebase-functions/v1';
import {
  CloudStorageObjectMetadata,
  CloudStorageObjectEventKind,
} from '@firebase-bridge/cloud-storage';
import {
  RegisterStorageTriggerOptions,
  StorageChangeRecord,
  StorageTriggerErrorOrigin,
  StorageTriggerPredicate,
  StorageTriggerRunnerErrorEventArg,
} from './types.js';

/** Static metadata extracted from a Firebase storage trigger wrapper. */
export interface StorageTriggerMeta {
  /** Bucket filter configured on the trigger, when any. */
  readonly bucketId?: string;

  /** Storage event kinds handled by the trigger. */
  readonly kinds: readonly CloudStorageObjectEventKind[];
}

/** Firebase v1 object metadata payload shape used by the trigger harness. */
export interface ObjectMetadataLike {
  /** Resource kind string. */
  readonly kind: string;

  /** Provider object id. */
  readonly id: string;

  /** Bucket id that contains the object. */
  readonly bucket: string;

  /** Storage class for the object. */
  readonly storageClass: string;

  /** Object size serialized as a string. */
  readonly size: string;

  /** Object creation time as an ISO string. */
  readonly timeCreated: string;

  /** Object update time as an ISO string. */
  readonly updated: string;

  /** Object name/path. */
  readonly name?: string;

  /** Object generation. */
  readonly generation?: string;

  /** Object metageneration. */
  readonly metageneration?: string;

  /** MIME content type. */
  readonly contentType?: string;

  /** MD5 hash. */
  readonly md5Hash?: string;

  /** CRC32C checksum. */
  readonly crc32c?: string;

  /** Content-Encoding header. */
  readonly contentEncoding?: string;

  /** Content-Disposition header. */
  readonly contentDisposition?: string;

  /** Cache-Control header. */
  readonly cacheControl?: string;

  /** User-defined metadata. */
  readonly metadata?: Record<string, string>;
}

/** Firebase v2 CloudEvent shape used by the trigger harness. */
export interface StorageCloudEventLike<TData = StorageObjectDataLike> {
  /** CloudEvent id. */
  readonly id: string;

  /** CloudEvent source URI. */
  readonly source: string;

  /** CloudEvent subject. */
  readonly subject: string;

  /** CloudEvent type. */
  readonly type: string;

  /** CloudEvent time as an ISO string. */
  readonly time: string;

  /** Bucket id provided by Firebase storage events. */
  readonly bucket: string;

  /** Event payload. */
  readonly data: TData;

  /** CloudEvents spec version. */
  readonly specversion: '1.0';
}

/** Firebase v2 storage object event payload shape. */
export interface StorageObjectDataLike {
  /** Bucket id that contains the object. */
  readonly bucket: string;

  /** Object name/path. */
  readonly name: string;

  /** Object generation as a number. */
  readonly generation: number;

  /** Object metageneration as a number. */
  readonly metageneration: number;

  /** MIME content type. */
  readonly contentType?: string;

  /** Object size in bytes. */
  readonly size: number;

  /** Object creation time as an ISO string. */
  readonly timeCreated: string;

  /** Object update time as an ISO string. */
  readonly updated: string;

  /** User-defined metadata. */
  readonly metadata?: Record<string, string>;

  /** Cache-Control header. */
  readonly cacheControl?: string;

  /** Content-Encoding header. */
  readonly contentEncoding?: string;

  /** Content-Disposition header. */
  readonly contentDisposition?: string;

  /** MD5 hash. */
  readonly md5Hash?: string;

  /** CRC32C checksum. */
  readonly crc32c?: string;

  /** ETag value. */
  readonly etag?: string;

  /** Provider object id. */
  readonly id: string;

  /** Resource kind string. */
  readonly kind: 'storage#object';

  /** Storage class for the object. */
  readonly storageClass: 'STANDARD';
}

/** Normalizes a predicate-or-options overload into register options. */
export function normalizeRegisterOptions(
  predicateOrOptions?:
    | StorageTriggerPredicate
    | RegisterStorageTriggerOptions
): RegisterStorageTriggerOptions {
  return typeof predicateOrOptions === 'function'
    ? { predicate: predicateOrOptions }
    : predicateOrOptions ?? {};
}

/** Returns whether a change record should be delivered to a trigger. */
export function shouldDeliver(
  meta: StorageTriggerMeta,
  record: StorageChangeRecord
): boolean {
  return (
    meta.kinds.includes(record.kind) &&
    (!meta.bucketId || meta.bucketId === record.bucketId)
  );
}

/** Runs a trigger handler with predicate and lifecycle hooks. */
export async function runWithHooks(
  record: StorageChangeRecord,
  options: RegisterStorageTriggerOptions,
  run: () => unknown | Promise<unknown>
): Promise<void> {
  let origin = StorageTriggerErrorOrigin.Predicate;
  const emitError = (cause: unknown) => {
    const arg: StorageTriggerRunnerErrorEventArg = Object.freeze({
      origin,
      arg: record,
      cause,
    });
    try {
      options.onError?.(arg);
    } catch {
      // Match Firestore trigger harness behavior: avoid recursive error loops.
    }
  };

  try {
    if ((options.predicate?.(record) ?? true) !== true) return;
    origin = StorageTriggerErrorOrigin.OnBefore;
    options.onBefore?.(record);
    origin = StorageTriggerErrorOrigin.Execute;
    await run();
    origin = StorageTriggerErrorOrigin.OnAfter;
    options.onAfter?.(record);
  } catch (cause) {
    emitError(cause);
  }
}

/** Converts normalized metadata to a Firebase v1 object metadata payload. */
export function toObjectMetadata(
  metadata: CloudStorageObjectMetadata
): ObjectMetadataLike {
  return Object.freeze({
    kind: 'storage#object',
    id: `${metadata.bucketId}/${metadata.path}/${metadata.generation}`,
    bucket: metadata.bucketId,
    storageClass: 'STANDARD',
    size: String(metadata.size),
    timeCreated: metadata.createdAt.toISOString(),
    updated: metadata.updatedAt.toISOString(),
    name: metadata.path,
    generation: metadata.generation,
    metageneration: metadata.metageneration,
    contentType: metadata.contentType,
    md5Hash: metadata.md5Hash,
    crc32c: metadata.crc32c,
    contentEncoding: metadata.contentEncoding,
    contentDisposition: metadata.contentDisposition,
    cacheControl: metadata.cacheControl,
    metadata: { ...metadata.customMetadata },
  });
}

/** Converts a change record to a Firebase v1 event context. */
export function toEventContext(record: StorageChangeRecord): EventContext {
  return Object.freeze({
    eventId: record.id,
    eventType: toV1EventType(record.kind),
    timestamp: record.eventTime.toISOString(),
    params: {},
    resource: {
      service: 'storage.googleapis.com',
      name: `projects/_/buckets/${record.bucketId}/objects/${record.path}#${record.metadata.generation}`,
    },
  }) as EventContext;
}

/** Converts a change record to a Firebase v2 CloudEvent payload. */
export function toCloudEvent(record: StorageChangeRecord): StorageCloudEventLike {
  return Object.freeze({
    id: record.id,
    source: `//storage.googleapis.com/projects/_/buckets/${record.bucketId}`,
    subject: `objects/${record.path}`,
    type: toV2EventType(record.kind),
    time: record.eventTime.toISOString(),
    bucket: record.bucketId,
    data: toStorageObjectData(record.metadata),
    specversion: '1.0',
  });
}

/** Converts normalized metadata to Firebase v2 storage object data. */
export function toStorageObjectData(
  metadata: CloudStorageObjectMetadata
): StorageObjectDataLike {
  return Object.freeze({
    bucket: metadata.bucketId,
    name: metadata.path,
    generation: Number(metadata.generation),
    metageneration: Number(metadata.metageneration),
    contentType: metadata.contentType,
    size: metadata.size,
    timeCreated: metadata.createdAt.toISOString(),
    updated: metadata.updatedAt.toISOString(),
    metadata: { ...metadata.customMetadata },
    cacheControl: metadata.cacheControl,
    contentEncoding: metadata.contentEncoding,
    contentDisposition: metadata.contentDisposition,
    md5Hash: metadata.md5Hash,
    crc32c: metadata.crc32c,
    etag: metadata.etag,
    id: `${metadata.bucketId}/${metadata.path}/${metadata.generation}`,
    kind: 'storage#object',
    storageClass: 'STANDARD',
  });
}

/** Maps a Firebase v1 event type string to storage event kinds. */
export function mapV1Kind(eventType?: string): CloudStorageObjectEventKind[] {
  if (!eventType) return [];
  if (eventType.includes('object.finalize')) return ['finalized'];
  if (eventType.includes('object.delete')) return ['deleted'];
  if (eventType.includes('object.archive')) return ['archived'];
  if (eventType.includes('object.metadataUpdate')) return ['metadata-updated'];
  return [];
}

/** Maps a Firebase v2 event type string to storage event kinds. */
export function mapV2Kind(eventType?: string): CloudStorageObjectEventKind[] {
  if (!eventType) return [];
  if (eventType.includes('.finalized')) return ['finalized'];
  if (eventType.includes('.deleted')) return ['deleted'];
  if (eventType.includes('.archived')) return ['archived'];
  if (eventType.includes('.metadataUpdated')) return ['metadata-updated'];
  return [];
}

/** Extracts a bucket id from a Firebase v1 event resource string. */
export function extractBucketFromResource(resource: unknown): string | undefined {
  if (typeof resource !== 'string') return undefined;
  const marker = '/buckets/';
  const index = resource.indexOf(marker);
  return index >= 0 ? resource.slice(index + marker.length).split('/')[0] : resource;
}

/** Extracts a bucket filter from Firebase v2 event trigger filters. */
export function extractBucketFilter(filters: unknown): string | undefined {
  if (!filters) return undefined;
  if (Array.isArray(filters)) {
    const found = filters.find(
      (item) => item?.attribute === 'bucket' && typeof item.value === 'string'
    );
    return found?.value;
  }
  if (typeof filters === 'object') {
    const bucket = (filters as { bucket?: unknown }).bucket;
    return typeof bucket === 'string' ? bucket : undefined;
  }
  return undefined;
}

function toV1EventType(kind: CloudStorageObjectEventKind): string {
  switch (kind) {
    case 'finalized':
      return 'google.storage.object.finalize';
    case 'deleted':
      return 'google.storage.object.delete';
    case 'archived':
      return 'google.storage.object.archive';
    case 'metadata-updated':
      return 'google.storage.object.metadataUpdate';
  }
  return 'google.storage.object.change';
}

function toV2EventType(kind: CloudStorageObjectEventKind): string {
  switch (kind) {
    case 'finalized':
      return 'google.cloud.storage.object.v1.finalized';
    case 'deleted':
      return 'google.cloud.storage.object.v1.deleted';
    case 'archived':
      return 'google.cloud.storage.object.v1.archived';
    case 'metadata-updated':
      return 'google.cloud.storage.object.v1.metadataUpdated';
  }
  return 'google.cloud.storage.object.v1.changed';
}

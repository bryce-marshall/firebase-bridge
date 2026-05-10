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

export interface StorageTriggerMeta {
  readonly bucketId?: string;
  readonly kinds: readonly CloudStorageObjectEventKind[];
}

export interface ObjectMetadataLike {
  readonly kind: string;
  readonly id: string;
  readonly bucket: string;
  readonly storageClass: string;
  readonly size: string;
  readonly timeCreated: string;
  readonly updated: string;
  readonly name?: string;
  readonly generation?: string;
  readonly metageneration?: string;
  readonly contentType?: string;
  readonly md5Hash?: string;
  readonly crc32c?: string;
  readonly contentEncoding?: string;
  readonly contentDisposition?: string;
  readonly cacheControl?: string;
  readonly metadata?: Record<string, string>;
}

export interface StorageCloudEventLike<TData = StorageObjectDataLike> {
  readonly id: string;
  readonly source: string;
  readonly subject: string;
  readonly type: string;
  readonly time: string;
  readonly bucket: string;
  readonly data: TData;
  readonly specversion: '1.0';
}

export interface StorageObjectDataLike {
  readonly bucket: string;
  readonly name: string;
  readonly generation: number;
  readonly metageneration: number;
  readonly contentType?: string;
  readonly size: number;
  readonly timeCreated: string;
  readonly updated: string;
  readonly metadata?: Record<string, string>;
  readonly cacheControl?: string;
  readonly contentEncoding?: string;
  readonly contentDisposition?: string;
  readonly md5Hash?: string;
  readonly crc32c?: string;
  readonly etag?: string;
  readonly id: string;
  readonly kind: 'storage#object';
  readonly storageClass: 'STANDARD';
}

export function normalizeRegisterOptions(
  predicateOrOptions?:
    | StorageTriggerPredicate
    | RegisterStorageTriggerOptions
): RegisterStorageTriggerOptions {
  return typeof predicateOrOptions === 'function'
    ? { predicate: predicateOrOptions }
    : predicateOrOptions ?? {};
}

export function shouldDeliver(
  meta: StorageTriggerMeta,
  record: StorageChangeRecord
): boolean {
  return (
    meta.kinds.includes(record.kind) &&
    (!meta.bucketId || meta.bucketId === record.bucketId)
  );
}

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

export function mapV1Kind(eventType?: string): CloudStorageObjectEventKind[] {
  if (!eventType) return [];
  if (eventType.includes('object.finalize')) return ['finalized'];
  if (eventType.includes('object.delete')) return ['deleted'];
  if (eventType.includes('object.archive')) return ['archived'];
  if (eventType.includes('object.metadataUpdate')) return ['metadata-updated'];
  return [];
}

export function mapV2Kind(eventType?: string): CloudStorageObjectEventKind[] {
  if (!eventType) return [];
  if (eventType.includes('.finalized')) return ['finalized'];
  if (eventType.includes('.deleted')) return ['deleted'];
  if (eventType.includes('.archived')) return ['archived'];
  if (eventType.includes('.metadataUpdated')) return ['metadata-updated'];
  return [];
}

export function extractBucketFromResource(resource: unknown): string | undefined {
  if (typeof resource !== 'string') return undefined;
  const marker = '/buckets/';
  const index = resource.indexOf(marker);
  return index >= 0 ? resource.slice(index + marker.length).split('/')[0] : resource;
}

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

import {
  CloudStorageObjectEvent,
  CloudStorageObjectEventKind,
  CloudStorageObjectMetadata,
} from '../types.js';

type StorageEventFunction = {
  run?: (event: unknown) => unknown;
};

type V2StorageModule = typeof import('firebase-functions/v2/storage');
type V2StorageEvent = Parameters<
  Parameters<V2StorageModule['onObjectFinalized']>[1]
>[0];

export interface CloudStorageTriggerOptions<TPlatform> {
  readonly bucket?: string;
  readonly platform: () => TPlatform | Promise<TPlatform>;
}

export type CloudStorageTriggerHandler<TPlatform> = (
  event: CloudStorageObjectEvent,
  platform: TPlatform
) => unknown | Promise<unknown>;

export function onObjectFinalized<TPlatform>(
  options: CloudStorageTriggerOptions<TPlatform>,
  handler: CloudStorageTriggerHandler<TPlatform>
): StorageEventFunction {
  return wrapV2('finalized', options, handler);
}

export function onObjectDeleted<TPlatform>(
  options: CloudStorageTriggerOptions<TPlatform>,
  handler: CloudStorageTriggerHandler<TPlatform>
): StorageEventFunction {
  return wrapV2('deleted', options, handler);
}

export function onObjectArchived<TPlatform>(
  options: CloudStorageTriggerOptions<TPlatform>,
  handler: CloudStorageTriggerHandler<TPlatform>
): StorageEventFunction {
  return wrapV2('archived', options, handler);
}

export function onObjectMetadataUpdated<TPlatform>(
  options: CloudStorageTriggerOptions<TPlatform>,
  handler: CloudStorageTriggerHandler<TPlatform>
): StorageEventFunction {
  return wrapV2('metadata-updated', options, handler);
}

function wrapV2<TPlatform>(
  kind: CloudStorageObjectEventKind,
  options: CloudStorageTriggerOptions<TPlatform>,
  handler: CloudStorageTriggerHandler<TPlatform>
): StorageEventFunction {
  // Dynamic require keeps package loading tolerant in test environments that only use types.
  const storage = require('firebase-functions/v2/storage') as V2StorageModule;
  const opts = options.bucket ? { bucket: options.bucket } : {};
  const run = async (event: V2StorageEvent) => {
    const platform = await options.platform();
    return handler(normalizeStorageEvent(kind, event), platform);
  };
  switch (kind) {
    case 'finalized':
      return storage.onObjectFinalized(opts, run) as StorageEventFunction;
    case 'deleted':
      return storage.onObjectDeleted(opts, run) as StorageEventFunction;
    case 'archived':
      return storage.onObjectArchived(opts, run) as StorageEventFunction;
    case 'metadata-updated':
      return storage.onObjectMetadataUpdated(opts, run) as StorageEventFunction;
  }
}

function normalizeStorageEvent(
  kind: CloudStorageObjectEventKind,
  event: V2StorageEvent
): CloudStorageObjectEvent {
  const data = event.data;
  return Object.freeze({
    id: event.id,
    kind,
    bucketId: data.bucket,
    path: data.name,
    eventTime: new Date(event.time),
    metadata: toMetadata(data),
  });
}

function toMetadata(data: V2StorageEvent['data']): CloudStorageObjectMetadata {
  const createdAt = toDate(data.timeCreated);
  const updatedAt = toDate(data.updated);
  return Object.freeze({
    bucketId: data.bucket,
    path: data.name,
    name: data.name,
    size: Number(data.size ?? 0),
    contentType: data.contentType,
    cacheControl: data.cacheControl,
    contentEncoding: data.contentEncoding,
    contentDisposition: data.contentDisposition,
    customMetadata: Object.freeze({ ...(data.metadata ?? {}) }),
    generation: String(data.generation),
    metageneration: String(data.metageneration),
    etag: data.etag,
    md5Hash: data.md5Hash,
    crc32c: data.crc32c,
    createdAt,
    updatedAt,
  });
}

function toDate(value: string | Date | undefined): Date {
  if (value instanceof Date) return new Date(value);
  if (typeof value === 'string') return new Date(value);
  return new Date(0);
}

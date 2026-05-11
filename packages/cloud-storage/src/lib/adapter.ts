import type { App } from 'firebase-admin/app';
import { getStorage, type Storage } from 'firebase-admin/storage';
import { cloudStorageError, CloudStorageError } from './errors.js';
import {
  CloudStorageBucket,
  CloudStorageBucketId,
  CloudStorageDeleteOptions,
  CloudStorageDeleteResult,
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
} from './types.js';

type ProviderBucket = {
  name: string;
  file(path: string): ProviderFile;
  getFiles(options?: Record<string, unknown>): Promise<[ProviderFile[], { pageToken?: string } | undefined, unknown]>;
};

type ProviderFile = {
  name: string;
  exists(): Promise<[boolean]>;
  download(): Promise<[Buffer]>;
  save(data: string | Buffer, options?: Record<string, unknown>): Promise<void>;
  delete(options?: Record<string, unknown>): Promise<unknown>;
  getMetadata(): Promise<[ProviderMetadata]>;
  setMetadata(
    metadata: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<[ProviderMetadata]>;
  getSignedUrl(config: Record<string, unknown>): Promise<[string]>;
};

type ProviderMetadata = Record<string, unknown> & {
  bucket?: string;
  name?: string;
  size?: string | number;
  contentType?: string;
  cacheControl?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  generation?: string | number;
  metageneration?: string | number;
  etag?: string;
  md5Hash?: string;
  crc32c?: string;
  timeCreated?: string | Date;
  updated?: string | Date;
};

export interface FirebaseCloudStorageServiceOptions {
  readonly app?: App;
  readonly storage?: Storage;
}

export function createFirebaseCloudStorageService(
  options?: FirebaseCloudStorageServiceOptions
): CloudStorageService {
  return new FirebaseCloudStorageService(
    options?.storage ?? getStorage(options?.app)
  );
}

export class FirebaseCloudStorageService implements CloudStorageService {
  constructor(private readonly storage: Storage) {}

  bucket(bucketId?: CloudStorageBucketId): CloudStorageBucket {
    validateBucketId(bucketId);
    try {
      return new FirebaseCloudStorageBucket(
        this.storage.bucket(bucketId) as unknown as ProviderBucket
      );
    } catch (cause) {
      throw mapProviderError(cause, 'Unable to resolve Cloud Storage bucket.');
    }
  }
}

class FirebaseCloudStorageBucket implements CloudStorageBucket {
  readonly bucketId: CloudStorageBucketId;

  constructor(private readonly bucketRef: ProviderBucket) {
    this.bucketId = bucketRef.name;
  }

  object(path: CloudStorageObjectPath): CloudStorageObject {
    return new FirebaseCloudStorageObject(this, path);
  }

  async exists(path: CloudStorageObjectPath): Promise<boolean> {
    validatePath(path);
    try {
      const [exists] = await this.file(path).exists();
      return exists;
    } catch (cause) {
      throw mapProviderError(cause, `Unable to check object "${path}".`);
    }
  }

  async read(path: CloudStorageObjectPath): Promise<CloudStorageReadResult> {
    validatePath(path);
    try {
      const file = this.file(path);
      const [data] = await file.download();
      const [metadata] = await file.getMetadata();
      return {
        data: new Uint8Array(data),
        metadata: toMetadata(this.bucketId, metadata),
      };
    } catch (cause) {
      throw mapProviderError(cause, `Unable to read object "${path}".`);
    }
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
    validatePath(path);
    try {
      const file = this.file(path);
      await assertProviderPrecondition(file, path, options?.precondition);
      await file.save(toBuffer(data), {
        metadata: toProviderWriteMetadata(options?.metadata),
        preconditionOpts: toProviderPrecondition(options?.precondition),
      });
      const [metadata] = await file.getMetadata();
      return { metadata: toMetadata(this.bucketId, metadata) };
    } catch (cause) {
      throw mapProviderError(cause, `Unable to write object "${path}".`);
    }
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
    validatePath(path);
    try {
      const metadata = await this.getMetadata(path).catch((cause) => {
        if (options?.ignoreMissing === true && isNotFound(cause)) return undefined;
        throw cause;
      });
      if (!metadata) return { deleted: false };
      await assertProviderPrecondition(
        this.file(path),
        path,
        options?.precondition
      );
      await this.file(path).delete({
        ignoreNotFound: options?.ignoreMissing === true,
        preconditionOpts: toProviderPrecondition(options?.precondition),
      });
      return { deleted: true, metadata };
    } catch (cause) {
      if (options?.ignoreMissing === true && isNotFound(cause)) {
        return { deleted: false };
      }
      throw mapProviderError(cause, `Unable to delete object "${path}".`);
    }
  }

  async getMetadata(
    path: CloudStorageObjectPath
  ): Promise<CloudStorageObjectMetadata> {
    validatePath(path);
    try {
      const [metadata] = await this.file(path).getMetadata();
      return toMetadata(this.bucketId, metadata);
    } catch (cause) {
      throw mapProviderError(cause, `Unable to get metadata for "${path}".`);
    }
  }

  async setMetadata(
    path: CloudStorageObjectPath,
    metadata: CloudStorageSetMetadata
  ): Promise<CloudStorageObjectMetadata> {
    validatePath(path);
    try {
      await assertProviderPrecondition(this.file(path), path, metadata.precondition);
      const [updated] = await this.file(path).setMetadata(
        toProviderWriteMetadata(metadata) ?? {},
        {
          preconditionOpts: toProviderPrecondition(metadata.precondition),
        }
      );
      return toMetadata(this.bucketId, updated);
    } catch (cause) {
      throw mapProviderError(cause, `Unable to set metadata for "${path}".`);
    }
  }

  async list(options?: CloudStorageListOptions): Promise<CloudStorageListResult> {
    try {
      const [files, nextQuery] = await this.bucketRef.getFiles({
        prefix: options?.prefix,
        maxResults: options?.pageSize,
        pageToken: options?.pageToken,
        autoPaginate: false,
      });
      const objects = await Promise.all(
        files.map(async (file) => {
          const [metadata] = await file.getMetadata();
          return toMetadata(this.bucketId, metadata);
        })
      );
      return {
        objects,
        nextPageToken: nextQuery?.pageToken,
      };
    } catch (cause) {
      throw mapProviderError(cause, 'Unable to list Cloud Storage objects.');
    }
  }

  async createSignedReadUrl(
    path: CloudStorageObjectPath,
    options: CloudStorageSignedReadUrlOptions
  ): Promise<CloudStorageSignedUrlResult> {
    validatePath(path);
    try {
      const file = this.file(path);
      const [exists] = await file.exists();
      if (!exists) {
        throw cloudStorageError(
          'storage/object-not-found',
          `Object "${path}" was not found.`
        );
      }
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: options.expiresAt,
      });
      return { url, expiresAt: new Date(options.expiresAt) };
    } catch (cause) {
      throw mapProviderError(cause, `Unable to sign object "${path}".`);
    }
  }

  private file(path: string): ProviderFile {
    return this.bucketRef.file(path);
  }
}

class FirebaseCloudStorageObject implements CloudStorageObject {
  readonly bucketId: CloudStorageBucketId;

  constructor(
    private readonly bucketRef: CloudStorageBucket,
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

function validatePath(path: string): void {
  if (!path || path.startsWith('/') || containsControlCharacter(path)) {
    throw cloudStorageError(
      'storage/invalid-path',
      `Invalid Cloud Storage object path "${path}".`
    );
  }
}

function validateBucketId(bucketId: string | undefined): void {
  if (
    bucketId !== undefined &&
    (!bucketId || bucketId.includes('/') || containsControlCharacter(bucketId))
  ) {
    throw cloudStorageError(
      'storage/invalid-bucket',
      `Invalid Cloud Storage bucket id "${bucketId}".`
    );
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function toBuffer(data: CloudStorageWritableData): Buffer {
  return typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
}

function toProviderWriteMetadata(
  metadata?: CloudStorageSetMetadata | CloudStorageWriteOptions['metadata']
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return {
    contentType: metadata.contentType,
    cacheControl: metadata.cacheControl,
    contentEncoding: metadata.contentEncoding,
    contentDisposition: metadata.contentDisposition,
    metadata: metadata.customMetadata,
  };
}

function toProviderPrecondition(
  precondition?: CloudStoragePrecondition
): Record<string, string | number> | undefined {
  if (!precondition || precondition.type === 'none') return undefined;
  switch (precondition.type) {
    case 'does-not-exist':
      return { ifGenerationMatch: 0 };
    case 'generation-match':
      return { ifGenerationMatch: precondition.generation };
    case 'metageneration-match':
      return { ifMetagenerationMatch: precondition.metageneration };
    case 'generation-and-metageneration-match':
      return {
        ifGenerationMatch: precondition.generation,
        ifMetagenerationMatch: precondition.metageneration,
      };
  }
}

async function assertProviderPrecondition(
  file: ProviderFile,
  path: string,
  precondition?: CloudStoragePrecondition
): Promise<void> {
  if (!precondition || precondition.type === 'none') return;
  const [exists] = await file.exists();
  if (precondition.type === 'does-not-exist') {
    if (exists) throw preconditionFailed(path);
    return;
  }
  if (!exists) throw preconditionFailed(path);
  const [metadata] = await file.getMetadata();
  const generation = String(metadata.generation ?? '');
  const metageneration = String(metadata.metageneration ?? '');
  switch (precondition.type) {
    case 'generation-match':
      if (generation !== precondition.generation) throw preconditionFailed(path);
      break;
    case 'metageneration-match':
      if (metageneration !== precondition.metageneration) {
        throw preconditionFailed(path);
      }
      break;
    case 'generation-and-metageneration-match':
      if (
        generation !== precondition.generation ||
        metageneration !== precondition.metageneration
      ) {
        throw preconditionFailed(path);
      }
      break;
  }
}

function preconditionFailed(path: string): CloudStorageError {
  return cloudStorageError(
    'storage/precondition-failed',
    `Cloud Storage precondition failed for "${path}".`
  );
}

function toMetadata(
  fallbackBucketId: string,
  metadata: ProviderMetadata
): CloudStorageObjectMetadata {
  const path = String(metadata.name ?? '');
  return Object.freeze({
    bucketId: String(metadata.bucket ?? fallbackBucketId),
    path,
    name: path,
    size: Number(metadata.size ?? 0),
    contentType: metadata.contentType,
    cacheControl: metadata.cacheControl,
    contentEncoding: metadata.contentEncoding,
    contentDisposition: metadata.contentDisposition,
    customMetadata: Object.freeze({ ...(metadata.metadata ?? {}) }),
    generation: String(metadata.generation ?? '0'),
    metageneration: String(metadata.metageneration ?? '0'),
    etag: metadata.etag,
    md5Hash: metadata.md5Hash,
    crc32c: metadata.crc32c,
    createdAt: toDate(metadata.timeCreated),
    updatedAt: toDate(metadata.updated),
  });
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return new Date(value);
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value);
  }
  return new Date(0);
}

function mapProviderError(cause: unknown, message: string): CloudStorageError {
  if (cause instanceof CloudStorageError) return cause;
  const code = providerCode(cause);
  if (code === 404) {
    return cloudStorageError('storage/object-not-found', message, cause);
  }
  if (code === 412) {
    return cloudStorageError('storage/precondition-failed', message, cause);
  }
  if (code === 403) {
    return cloudStorageError('storage/permission-denied', message, cause);
  }
  if (code === 503 || code === 500) {
    return cloudStorageError('storage/unavailable', message, cause);
  }
  return cloudStorageError('storage/unknown', message, cause);
}

function providerCode(cause: unknown): number | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  const maybe = cause as { code?: unknown; statusCode?: unknown };
  const code = maybe.code ?? maybe.statusCode;
  return typeof code === 'number' ? code : undefined;
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof CloudStorageError
    ? cause.code === 'storage/object-not-found'
    : providerCode(cause) === 404;
}

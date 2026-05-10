export type CloudStorageBucketId = string;
export type CloudStorageObjectPath = string;
export type CloudStorageGeneration = string;
export type CloudStorageMetageneration = string;
export type CloudStorageWritableData = string | Uint8Array;

export interface CloudStorageService {
  bucket(bucketId?: CloudStorageBucketId): CloudStorageBucket;
}

export interface CloudStorageBucket {
  readonly bucketId: CloudStorageBucketId;

  object(path: CloudStorageObjectPath): CloudStorageObject;

  exists(path: CloudStorageObjectPath): Promise<boolean>;
  read(path: CloudStorageObjectPath): Promise<CloudStorageReadResult>;
  readText(
    path: CloudStorageObjectPath,
    options?: CloudStorageReadTextOptions
  ): Promise<string>;
  write(
    path: CloudStorageObjectPath,
    data: CloudStorageWritableData,
    options?: CloudStorageWriteOptions
  ): Promise<CloudStorageWriteResult>;
  writeText(
    path: CloudStorageObjectPath,
    text: string,
    options?: CloudStorageWriteTextOptions
  ): Promise<CloudStorageWriteResult>;
  delete(
    path: CloudStorageObjectPath,
    options?: CloudStorageDeleteOptions
  ): Promise<CloudStorageDeleteResult>;
  getMetadata(
    path: CloudStorageObjectPath
  ): Promise<CloudStorageObjectMetadata>;
  setMetadata(
    path: CloudStorageObjectPath,
    metadata: CloudStorageSetMetadata
  ): Promise<CloudStorageObjectMetadata>;
  list(options?: CloudStorageListOptions): Promise<CloudStorageListResult>;
  createSignedReadUrl(
    path: CloudStorageObjectPath,
    options: CloudStorageSignedReadUrlOptions
  ): Promise<CloudStorageSignedUrlResult>;
}

export interface CloudStorageObject {
  readonly bucketId: CloudStorageBucketId;
  readonly path: CloudStorageObjectPath;

  exists(): Promise<boolean>;
  read(): Promise<CloudStorageReadResult>;
  readText(options?: CloudStorageReadTextOptions): Promise<string>;
  write(
    data: CloudStorageWritableData,
    options?: CloudStorageWriteOptions
  ): Promise<CloudStorageWriteResult>;
  writeText(
    text: string,
    options?: CloudStorageWriteTextOptions
  ): Promise<CloudStorageWriteResult>;
  delete(options?: CloudStorageDeleteOptions): Promise<CloudStorageDeleteResult>;
  getMetadata(): Promise<CloudStorageObjectMetadata>;
  setMetadata(
    metadata: CloudStorageSetMetadata
  ): Promise<CloudStorageObjectMetadata>;
  createSignedReadUrl(
    options: CloudStorageSignedReadUrlOptions
  ): Promise<CloudStorageSignedUrlResult>;
}

export interface CloudStorageObjectMetadata {
  readonly bucketId: CloudStorageBucketId;
  readonly path: CloudStorageObjectPath;
  readonly name: CloudStorageObjectPath;
  readonly size: number;
  readonly contentType?: string;
  readonly cacheControl?: string;
  readonly contentEncoding?: string;
  readonly contentDisposition?: string;
  readonly customMetadata: Readonly<Record<string, string>>;
  readonly generation: CloudStorageGeneration;
  readonly metageneration: CloudStorageMetageneration;
  readonly etag?: string;
  readonly md5Hash?: string;
  readonly crc32c?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CloudStoragePrecondition =
  | { readonly type: 'none' }
  | { readonly type: 'does-not-exist' }
  | {
      readonly type: 'generation-match';
      readonly generation: CloudStorageGeneration;
    }
  | {
      readonly type: 'metageneration-match';
      readonly metageneration: CloudStorageMetageneration;
    }
  | {
      readonly type: 'generation-and-metageneration-match';
      readonly generation: CloudStorageGeneration;
      readonly metageneration: CloudStorageMetageneration;
    };

export interface CloudStorageReadResult {
  readonly data: Uint8Array;
  readonly metadata: CloudStorageObjectMetadata;
}

export interface CloudStorageReadTextOptions {
  readonly encoding?: BufferEncoding;
}

export interface CloudStorageWriteMetadata {
  readonly contentType?: string;
  readonly cacheControl?: string;
  readonly contentEncoding?: string;
  readonly contentDisposition?: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface CloudStorageWriteOptions {
  readonly metadata?: CloudStorageWriteMetadata;
  readonly precondition?: CloudStoragePrecondition;
}

export interface CloudStorageWriteTextOptions extends CloudStorageWriteOptions {
  readonly encoding?: BufferEncoding;
}

export interface CloudStorageWriteResult {
  readonly metadata: CloudStorageObjectMetadata;
}

export interface CloudStorageDeleteOptions {
  readonly ignoreMissing?: boolean;
  readonly precondition?: CloudStoragePrecondition;
}

export interface CloudStorageDeleteResult {
  readonly deleted: boolean;
  readonly metadata?: CloudStorageObjectMetadata;
}

export interface CloudStorageSetMetadata
  extends Partial<CloudStorageWriteMetadata> {
  readonly precondition?: CloudStoragePrecondition;
}

export interface CloudStorageListOptions {
  readonly prefix?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface CloudStorageListResult {
  readonly objects: readonly CloudStorageObjectMetadata[];
  readonly nextPageToken?: string;
}

export interface CloudStorageSignedReadUrlOptions {
  readonly expiresAt: Date;
}

export interface CloudStorageSignedUrlResult {
  readonly url: string;
  readonly expiresAt: Date;
}

export type CloudStorageObjectEventKind =
  | 'finalized'
  | 'deleted'
  | 'archived'
  | 'metadata-updated';

export interface CloudStorageObjectEvent {
  readonly id: string;
  readonly kind: CloudStorageObjectEventKind;
  readonly bucketId: CloudStorageBucketId;
  readonly path: CloudStorageObjectPath;
  readonly eventTime: Date;
  readonly metadata: CloudStorageObjectMetadata;
  readonly previousMetadata?: CloudStorageObjectMetadata;
}

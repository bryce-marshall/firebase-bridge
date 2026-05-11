/** Identifies a Cloud Storage bucket. */
export type CloudStorageBucketId = string;

/** Identifies an object path within a Cloud Storage bucket. */
export type CloudStorageObjectPath = string;

/** Provider-assigned object generation value. */
export type CloudStorageGeneration = string;

/** Provider-assigned object metageneration value. */
export type CloudStorageMetageneration = string;

/** Binary or text payload accepted by write operations. */
export type CloudStorageWritableData = string | Uint8Array;

/** Entry point for resolving Cloud Storage buckets. */
export interface CloudStorageService {
  /** Resolves the default bucket or the bucket with the given id. */
  bucket(bucketId?: CloudStorageBucketId): CloudStorageBucket;
}

/** Operations scoped to a single Cloud Storage bucket. */
export interface CloudStorageBucket {
  /** Bucket id served by this bucket facade. */
  readonly bucketId: CloudStorageBucketId;

  /** Creates an object facade for the given path. */
  object(path: CloudStorageObjectPath): CloudStorageObject;

  /** Returns whether an object exists at the given path. */
  exists(path: CloudStorageObjectPath): Promise<boolean>;

  /** Reads object bytes and metadata. */
  read(path: CloudStorageObjectPath): Promise<CloudStorageReadResult>;

  /** Reads object bytes and decodes them as text. */
  readText(
    path: CloudStorageObjectPath,
    options?: CloudStorageReadTextOptions
  ): Promise<string>;

  /** Writes object bytes or text and returns the updated metadata. */
  write(
    path: CloudStorageObjectPath,
    data: CloudStorageWritableData,
    options?: CloudStorageWriteOptions
  ): Promise<CloudStorageWriteResult>;

  /** Encodes text, writes it to an object, and returns the updated metadata. */
  writeText(
    path: CloudStorageObjectPath,
    text: string,
    options?: CloudStorageWriteTextOptions
  ): Promise<CloudStorageWriteResult>;

  /** Deletes an object and optionally returns its previous metadata. */
  delete(
    path: CloudStorageObjectPath,
    options?: CloudStorageDeleteOptions
  ): Promise<CloudStorageDeleteResult>;

  /** Gets metadata for an existing object. */
  getMetadata(
    path: CloudStorageObjectPath
  ): Promise<CloudStorageObjectMetadata>;

  /** Updates mutable object metadata. */
  setMetadata(
    path: CloudStorageObjectPath,
    metadata: CloudStorageSetMetadata
  ): Promise<CloudStorageObjectMetadata>;

  /** Lists objects in this bucket. */
  list(options?: CloudStorageListOptions): Promise<CloudStorageListResult>;

  /** Creates a signed URL that can read the object until it expires. */
  createSignedReadUrl(
    path: CloudStorageObjectPath,
    options: CloudStorageSignedReadUrlOptions
  ): Promise<CloudStorageSignedUrlResult>;
}

/** Operations scoped to a single Cloud Storage object path. */
export interface CloudStorageObject {
  /** Bucket id that contains the object. */
  readonly bucketId: CloudStorageBucketId;

  /** Object path within the bucket. */
  readonly path: CloudStorageObjectPath;

  /** Returns whether this object exists. */
  exists(): Promise<boolean>;

  /** Reads this object's bytes and metadata. */
  read(): Promise<CloudStorageReadResult>;

  /** Reads this object and decodes it as text. */
  readText(options?: CloudStorageReadTextOptions): Promise<string>;

  /** Writes bytes or text to this object. */
  write(
    data: CloudStorageWritableData,
    options?: CloudStorageWriteOptions
  ): Promise<CloudStorageWriteResult>;

  /** Encodes text and writes it to this object. */
  writeText(
    text: string,
    options?: CloudStorageWriteTextOptions
  ): Promise<CloudStorageWriteResult>;

  /** Deletes this object. */
  delete(options?: CloudStorageDeleteOptions): Promise<CloudStorageDeleteResult>;

  /** Gets this object's metadata. */
  getMetadata(): Promise<CloudStorageObjectMetadata>;

  /** Updates mutable metadata for this object. */
  setMetadata(
    metadata: CloudStorageSetMetadata
  ): Promise<CloudStorageObjectMetadata>;

  /** Creates a signed URL that can read this object until it expires. */
  createSignedReadUrl(
    options: CloudStorageSignedReadUrlOptions
  ): Promise<CloudStorageSignedUrlResult>;
}

/** Immutable object metadata normalized across storage providers. */
export interface CloudStorageObjectMetadata {
  /** Bucket id that contains the object. */
  readonly bucketId: CloudStorageBucketId;

  /** Object path within the bucket. */
  readonly path: CloudStorageObjectPath;

  /** Provider object name, equivalent to {@link path}. */
  readonly name: CloudStorageObjectPath;

  /** Object size in bytes. */
  readonly size: number;

  /** MIME content type, when known. */
  readonly contentType?: string;

  /** Cache-Control header value, when set. */
  readonly cacheControl?: string;

  /** Content-Encoding header value, when set. */
  readonly contentEncoding?: string;

  /** Content-Disposition header value, when set. */
  readonly contentDisposition?: string;

  /** User-defined metadata entries. */
  readonly customMetadata: Readonly<Record<string, string>>;

  /** Provider-assigned object generation. */
  readonly generation: CloudStorageGeneration;

  /** Provider-assigned metadata generation. */
  readonly metageneration: CloudStorageMetageneration;

  /** Provider ETag, when known. */
  readonly etag?: string;

  /** Provider MD5 hash, when known. */
  readonly md5Hash?: string;

  /** Provider CRC32C checksum, when known. */
  readonly crc32c?: string;

  /** Object creation time. */
  readonly createdAt: Date;

  /** Last object or metadata update time. */
  readonly updatedAt: Date;
}

/** Write/delete preconditions that guard object mutations. */
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

/** Result returned after reading object bytes. */
export interface CloudStorageReadResult {
  /** Object bytes. */
  readonly data: Uint8Array;

  /** Metadata captured with the read. */
  readonly metadata: CloudStorageObjectMetadata;
}

/** Options for decoding object bytes as text. */
export interface CloudStorageReadTextOptions {
  /** Buffer encoding used to decode bytes. */
  readonly encoding?: BufferEncoding;
}

/** Mutable metadata accepted by write operations. */
export interface CloudStorageWriteMetadata {
  /** MIME content type to store with the object. */
  readonly contentType?: string;

  /** Cache-Control header value to store with the object. */
  readonly cacheControl?: string;

  /** Content-Encoding header value to store with the object. */
  readonly contentEncoding?: string;

  /** Content-Disposition header value to store with the object. */
  readonly contentDisposition?: string;

  /** User-defined metadata to merge or store with the object. */
  readonly customMetadata?: Readonly<Record<string, string>>;
}

/** Options for writing object data. */
export interface CloudStorageWriteOptions {
  /** Metadata to store with the written object. */
  readonly metadata?: CloudStorageWriteMetadata;

  /** Optional mutation precondition. */
  readonly precondition?: CloudStoragePrecondition;
}

/** Options for encoding text before writing it. */
export interface CloudStorageWriteTextOptions extends CloudStorageWriteOptions {
  /** Buffer encoding used to encode the text. */
  readonly encoding?: BufferEncoding;
}

/** Result returned after writing object data. */
export interface CloudStorageWriteResult {
  /** Metadata after the write completes. */
  readonly metadata: CloudStorageObjectMetadata;
}

/** Options for deleting an object. */
export interface CloudStorageDeleteOptions {
  /** Whether a missing object should be treated as a successful no-op. */
  readonly ignoreMissing?: boolean;

  /** Optional mutation precondition. */
  readonly precondition?: CloudStoragePrecondition;
}

/** Result returned after deleting an object. */
export interface CloudStorageDeleteResult {
  /** Whether an object was actually deleted. */
  readonly deleted: boolean;

  /** Metadata for the deleted object, when it existed. */
  readonly metadata?: CloudStorageObjectMetadata;
}

/** Metadata patch accepted by set-metadata operations. */
export interface CloudStorageSetMetadata
  extends Partial<CloudStorageWriteMetadata> {
  /** Optional metadata mutation precondition. */
  readonly precondition?: CloudStoragePrecondition;
}

/** Options for listing objects. */
export interface CloudStorageListOptions {
  /** Prefix used to filter returned object paths. */
  readonly prefix?: string;

  /** Maximum number of objects to return. */
  readonly pageSize?: number;

  /** Continuation token returned by a previous list call. */
  readonly pageToken?: string;
}

/** Result returned by a list operation. */
export interface CloudStorageListResult {
  /** Object metadata entries in the current page. */
  readonly objects: readonly CloudStorageObjectMetadata[];

  /** Continuation token for the next page, when more objects remain. */
  readonly nextPageToken?: string;
}

/** Options for creating a signed read URL. */
export interface CloudStorageSignedReadUrlOptions {
  /** Absolute expiration time for the signed URL. */
  readonly expiresAt: Date;
}

/** Signed URL and its expiration time. */
export interface CloudStorageSignedUrlResult {
  /** URL that authorizes the requested operation. */
  readonly url: string;

  /** Absolute expiration time for the URL. */
  readonly expiresAt: Date;
}

/** Cloud Storage object event kind normalized across Firebase trigger versions. */
export type CloudStorageObjectEventKind =
  | 'finalized'
  | 'deleted'
  | 'archived'
  | 'metadata-updated';

/** Normalized Cloud Storage object event delivered to trigger handlers. */
export interface CloudStorageObjectEvent {
  /** Stable event id supplied by the trigger source. */
  readonly id: string;

  /** Kind of object change represented by the event. */
  readonly kind: CloudStorageObjectEventKind;

  /** Bucket id that contains the changed object. */
  readonly bucketId: CloudStorageBucketId;

  /** Path of the changed object. */
  readonly path: CloudStorageObjectPath;

  /** Time at which the event occurred. */
  readonly eventTime: Date;

  /** Metadata after the event, or the deleted object's metadata for delete events. */
  readonly metadata: CloudStorageObjectMetadata;

  /** Metadata before the event, when available. */
  readonly previousMetadata?: CloudStorageObjectMetadata;
}

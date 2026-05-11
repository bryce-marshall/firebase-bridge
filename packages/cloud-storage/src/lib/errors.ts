/** Error codes emitted by the Cloud Storage bridge abstraction. */
export type CloudStorageErrorCode =
  | 'storage/bucket-not-found'
  | 'storage/object-not-found'
  | 'storage/precondition-failed'
  | 'storage/invalid-bucket'
  | 'storage/invalid-path'
  | 'storage/permission-denied'
  | 'storage/unavailable'
  | 'storage/unknown';

/** Error type used for normalized Cloud Storage bridge failures. */
export class CloudStorageError extends Error {
  /** Creates a Cloud Storage bridge error with a normalized error code. */
  constructor(
    /** Normalized storage error code. */
    readonly code: CloudStorageErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'CloudStorageError';
  }
}

/** Creates a normalized Cloud Storage bridge error. */
export function cloudStorageError(
  code: CloudStorageErrorCode,
  message: string,
  cause?: unknown
): CloudStorageError {
  return new CloudStorageError(code, message, { cause });
}

/** Returns whether a value is a normalized Cloud Storage bridge error. */
export function isCloudStorageError(
  value: unknown
): value is CloudStorageError {
  return value instanceof CloudStorageError;
}

export type CloudStorageErrorCode =
  | 'storage/bucket-not-found'
  | 'storage/object-not-found'
  | 'storage/precondition-failed'
  | 'storage/invalid-bucket'
  | 'storage/invalid-path'
  | 'storage/permission-denied'
  | 'storage/unavailable'
  | 'storage/unknown';

export class CloudStorageError extends Error {
  constructor(
    readonly code: CloudStorageErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'CloudStorageError';
  }
}

export function cloudStorageError(
  code: CloudStorageErrorCode,
  message: string,
  cause?: unknown
): CloudStorageError {
  return new CloudStorageError(code, message, { cause });
}

export function isCloudStorageError(
  value: unknown
): value is CloudStorageError {
  return value instanceof CloudStorageError;
}

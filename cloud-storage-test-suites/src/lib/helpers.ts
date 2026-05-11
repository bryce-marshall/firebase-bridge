import {
  CloudStorageBucket,
  CloudStorageError,
  CloudStorageErrorCode,
} from '@firebase-bridge/cloud-storage';

export async function expectStorageError(
  promise: Promise<unknown>,
  code: CloudStorageErrorCode
): Promise<CloudStorageError> {
  try {
    await promise;
  } catch (cause) {
    expect(cause).toBeInstanceOf(CloudStorageError);
    expect(cause).toMatchObject({ code });
    return cause as CloudStorageError;
  }
  throw new Error(`Expected CloudStorageError with code "${code}".`);
}

export function expectObjectMissing(promise: Promise<unknown>): Promise<CloudStorageError> {
  return expectStorageError(promise, 'storage/object-not-found');
}

export function expectPreconditionFailed(
  promise: Promise<unknown>
): Promise<CloudStorageError> {
  return expectStorageError(promise, 'storage/precondition-failed');
}

export async function expectStorageErrorCause(
  promise: Promise<unknown>,
  code: CloudStorageErrorCode
): Promise<CloudStorageError> {
  const error = await expectStorageError(promise, code);
  const cause = (error as Error & { cause?: unknown }).cause;
  expect(cause).toBeDefined();
  expect(typeof cause).toBe('object');
  return error;
}

export async function expectNoObject(
  bucket: CloudStorageBucket,
  path: string
): Promise<void> {
  await expect(bucket.exists(path)).resolves.toBe(false);
}

export async function expectObjectText(
  bucket: CloudStorageBucket,
  path: string,
  text: string
): Promise<void> {
  await expect(bucket.readText(path)).resolves.toBe(text);
}

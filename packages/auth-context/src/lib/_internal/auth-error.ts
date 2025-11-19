import { FirebaseError } from 'firebase-admin';
import { applyToJSON } from './auth-helpers.js';

/**
 * The set of possible Auth error codes.
 *
 * @remarks
 * This union mirrors the documented `auth/*` error codes from the Firebase
 * Admin Authentication API, but **without** the `"auth/"` prefix. When used
 * with {@link authError}, each code is automatically prefixed to form the
 * full `FirebaseError.code` (for example, `"auth/user-not-found"`).
 */
export type AuthErrorCode =
  | 'claims-too-large'
  | 'email-already-exists'
  | 'id-token-expired'
  | 'id-token-revoked'
  | 'insufficient-permission'
  | 'internal-error'
  | 'invalid-argument'
  | 'invalid-claims'
  | 'invalid-continue-uri'
  | 'invalid-creation-time'
  | 'invalid-credential'
  | 'invalid-disabled-field'
  | 'invalid-display-name'
  | 'invalid-dynamic-link-domain'
  | 'invalid-email'
  | 'invalid-email-verified'
  | 'invalid-hash-algorithm'
  | 'invalid-hash-block-size'
  | 'invalid-hash-derived-key-length'
  | 'invalid-hash-key'
  | 'invalid-hash-memory-cost'
  | 'invalid-hash-parallelization'
  | 'invalid-hash-rounds'
  | 'invalid-hash-salt-separator'
  | 'invalid-id-token'
  | 'invalid-last-sign-in-time'
  | 'invalid-page-token'
  | 'invalid-password'
  | 'invalid-password-hash'
  | 'invalid-password-salt'
  | 'invalid-phone-number'
  | 'invalid-photo-url'
  | 'invalid-provider-data'
  | 'invalid-provider-id'
  | 'invalid-oauth-responsetype'
  | 'invalid-session-cookie-duration'
  | 'invalid-uid'
  | 'invalid-user-import'
  | 'maximum-user-count-exceeded'
  | 'missing-android-pkg-name'
  | 'missing-continue-uri'
  | 'missing-hash-algorithm'
  | 'missing-ios-bundle-id'
  | 'missing-uid'
  | 'missing-oauth-client-secret'
  | 'operation-not-allowed'
  | 'phone-number-already-exists'
  | 'project-not-found'
  | 'reserved-claims'
  | 'session-cookie-expired'
  | 'session-cookie-revoked'
  | 'too-many-requests'
  | 'uid-already-exists'
  | 'unauthorized-continue-uri'
  | 'user-disabled'
  | 'user-not-found';

/**
 * Creates a `uid-already-exists` {@link FirebaseError} for a given UID.
 *
 * @remarks
 * This helper mirrors the error shape thrown by the Admin SDK when attempting
 * to create a user with a UID that already exists in the project.
 *
 * @param uid - The conflicting user identifier.
 * @returns A {@link FirebaseError} with `code === "auth/uid-already-exists"`.
 */
export function uidExistsError(uid: string): FirebaseError {
  return authError('uid-already-exists', `The uid ${uid} already exists.`);
}

/**
 * Creates a `user-not-found` {@link FirebaseError} for a given lookup key set.
 *
 * @remarks
 * The `keys` argument is serialized into the error message to aid debugging.
 * Typical usage is to pass an object such as `{ uid }`, `{ email }`, or a
 * composite like `{ providerId, uid }`.
 *
 * @param keys - Name/value pairs describing the lookup criteria that failed.
 * @returns A {@link FirebaseError} with `code === "auth/user-not-found"`.
 */
export function userNotFoundError(keys: Record<string, string>): FirebaseError {
  return authError(
    'user-not-found',
    `No user exists having ${JSON.stringify(keys)}`
  );
}

/**
 * Constructs a {@link FirebaseError} instance for the given auth error code.
 *
 * @remarks
 * - The returned error has `code` set to `"auth/<code>"`.
 * - The error's `message` is either:
 *   - `"auth/<code>"` when `message` is omitted, or
 *   - `"auth/<code>: <message>"` when a message is provided.
 * - {@link applyToJSON} is called on the error so that `toJSON()` returns
 *   a data-only representation suitable for logging or serialization.
 *
 * This is the central factory used throughout the mock to ensure consistent
 * error formatting and typing.
 *
 * @param code - An {@link AuthErrorCode} (without the `auth/` prefix).
 * @param message - Optional human-readable message to append.
 * @returns A {@link FirebaseError} with a fully-qualified auth error code.
 */
export function authError(
  code: AuthErrorCode,
  message?: string
): FirebaseError {
  const fullCode = `auth/${code}`;

  const error = new Error(
    message ? `${fullCode}: ${message}` : fullCode
  ) as unknown as FirebaseError;
  error.code = fullCode;
  applyToJSON(error);

  return error;
}

/**
 * Normalizes an unknown error value into a {@link FirebaseError}.
 *
 * @remarks
 * - If `e` is already a {@link FirebaseError} (as per {@link isFirebaseError}),
 *   it is returned unchanged.
 * - Otherwise, a new `auth/internal-error` is returned, with the original
 *   error's message (when available) appended.
 *
 * This is useful when catching arbitrary exceptions and rethrowing them in
 * a form consistent with Firebase Auth semantics.
 *
 * @param e - Error-like value to normalize.
 * @returns A {@link FirebaseError} instance representing the error.
 */
export function asAuthError(e: unknown): FirebaseError {
  return isFirebaseError(e)
    ? e
    : authError('internal-error', (e as Error | undefined)?.message);
}

/**
 * Type guard that checks whether a value is a {@link FirebaseError}.
 *
 * @remarks
 * The check is intentionally minimal: it simply verifies that the value has
 * a non-`undefined` `code` property (which the Firebase Admin SDK uses to
 * distinguish its errors).
 *
 * @param e - Value to test.
 * @returns `true` if `e` is a {@link FirebaseError}; otherwise, `false`.
 */
export function isFirebaseError(e: unknown): e is FirebaseError {
  return (e as FirebaseError)?.code != undefined;
}

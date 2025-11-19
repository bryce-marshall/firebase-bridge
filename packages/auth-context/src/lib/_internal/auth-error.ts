import { FirebaseError } from 'firebase-admin';
import { applyToJSON } from './auth-helpers.js';

/**
 * The set of possible Auth error codes.
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

export function uidExistsError(uid: string): FirebaseError {
  return authError(
    'uid-already-exists',
    `The uid ${uid} already exists.`
  );
}
export function userNotFoundError(keys: Record<string, string>): FirebaseError {
  return authError(
    'user-not-found',
    `No user exists having ${JSON.stringify(keys)}`
  );
}

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

export function asAuthError(e: unknown): FirebaseError {
  return isFirebaseError(e)
    ? e
    : authError('internal-error', (e as Error | undefined)?.message);
}

export function isFirebaseError(e: unknown): e is FirebaseError {
  return (e as FirebaseError)?.code != undefined;
}

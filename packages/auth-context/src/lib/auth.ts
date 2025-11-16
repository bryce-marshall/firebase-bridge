import {
  ActionCodeSettings,
  AuthProviderConfig,
  AuthProviderConfigFilter,
  CreateRequest,
  DecodedAuthBlockingToken,
  DecodedIdToken,
  DeleteUsersResult,
  GetUsersResult,
  ListProviderConfigResults,
  ListUsersResult,
  SessionCookieOptions,
  UpdateAuthProviderRequest,
  UpdateRequest,
  UserIdentifier,
  UserImportOptions,
  UserImportRecord,
  UserImportResult,
  UserRecord,
} from 'firebase-admin/auth';
import { getUserRecord } from './_internal/auth-helpers.js';
import { AuthInstance, IAuth } from './_internal/auth-types.js';
import { rejectPromise, resolvePromise } from './_internal/util.js';

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

export class Auth implements IAuth {
  private _store: Map<string, AuthInstance>;
  private _now: () => number;

  constructor(store: Map<string, AuthInstance>, now: () => number) {
    this._store = store;
    this._now = now;
  }

  createCustomToken(uid: string, developerClaims?: object): Promise<string> {
    throw new Error('Method not implemented.');
  }
  verifyIdToken(
    idToken: string,
    checkRevoked?: boolean
  ): Promise<DecodedIdToken> {
    throw new Error('Method not implemented.');
  }
  getUser(uid: string): Promise<UserRecord> {
    const r = getUserRecord(uid, this._store);
    if (!r) return rejectPromise(authError('user-not-found'));

    return resolvePromise(r);
  }
  getUserByEmail(email: string): Promise<UserRecord> {
    throw new Error('Method not implemented.');
  }
  getUserByPhoneNumber(phoneNumber: string): Promise<UserRecord> {
    throw new Error('Method not implemented.');
  }
  getUserByProviderUid(providerId: string, uid: string): Promise<UserRecord> {
    throw new Error('Method not implemented.');
  }
  getUsers(identifiers: UserIdentifier[]): Promise<GetUsersResult> {
    throw new Error('Method not implemented.');
  }
  listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult> {
    throw new Error('Method not implemented.');
  }
  createUser(properties: CreateRequest): Promise<UserRecord> {
    throw new Error('Method not implemented.');
  }
  deleteUser(uid: string): Promise<void> {
    throw new Error('Method not implemented.');
  }
  deleteUsers(uids: string[]): Promise<DeleteUsersResult> {
    throw new Error('Method not implemented.');
  }
  updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord> {
    throw new Error('Method not implemented.');
  }
  setCustomUserClaims(
    uid: string,
    customUserClaims: object | null
  ): Promise<void> {
    throw new Error('Method not implemented.');
  }
  revokeRefreshTokens(uid: string): Promise<void> {
    throw new Error('Method not implemented.');
  }
  importUsers(
    users: UserImportRecord[],
    options?: UserImportOptions
  ): Promise<UserImportResult> {
    throw new Error('Method not implemented.');
  }
  createSessionCookie(
    idToken: string,
    sessionCookieOptions: SessionCookieOptions
  ): Promise<string> {
    throw new Error('Method not implemented.');
  }
  verifySessionCookie(
    sessionCookie: string,
    checkRevoked?: boolean
  ): Promise<DecodedIdToken> {
    throw new Error('Method not implemented.');
  }
  generatePasswordResetLink(
    email: string,
    actionCodeSettings?: ActionCodeSettings
  ): Promise<string> {
    throw new Error('Method not implemented.');
  }
  generateEmailVerificationLink(
    email: string,
    actionCodeSettings?: ActionCodeSettings
  ): Promise<string> {
    throw new Error('Method not implemented.');
  }
  generateVerifyAndChangeEmailLink(
    email: string,
    newEmail: string,
    actionCodeSettings?: ActionCodeSettings
  ): Promise<string> {
    throw new Error('Method not implemented.');
  }
  generateSignInWithEmailLink(
    email: string,
    actionCodeSettings: ActionCodeSettings
  ): Promise<string> {
    throw new Error('Method not implemented.');
  }
  listProviderConfigs(
    options: AuthProviderConfigFilter
  ): Promise<ListProviderConfigResults> {
    throw new Error('Method not implemented.');
  }
  getProviderConfig(providerId: string): Promise<AuthProviderConfig> {
    throw new Error('Method not implemented.');
  }
  deleteProviderConfig(providerId: string): Promise<void> {
    throw new Error('Method not implemented.');
  }
  updateProviderConfig(
    providerId: string,
    updatedConfig: UpdateAuthProviderRequest
  ): Promise<AuthProviderConfig> {
    throw new Error('Method not implemented.');
  }
  createProviderConfig(
    config: AuthProviderConfig
  ): Promise<AuthProviderConfig> {
    throw new Error('Method not implemented.');
  }
  _verifyAuthBlockingToken(
    token: string,
    audience?: string
  ): Promise<DecodedAuthBlockingToken> {
    throw new Error('Method not implemented.');
  }
}

function authError(code: AuthErrorCode, message?: string): Error {
  return new Error(message ? `auth/${code}: ${message}` : `auth/${code}`);
}

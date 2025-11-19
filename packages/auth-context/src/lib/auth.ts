import { FirebaseArrayIndexError, FirebaseError } from 'firebase-admin';
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
import {
  applyToJSON,
  AuthInstancePredicate,
  isValidUid,
  toUserRecord,
  validatedCustomClaims,
} from './_internal/auth-helpers.js';
import {
  AuthInstance,
  IAuth,
  PossibleIdentifier,
} from './_internal/auth-types.js';
import {
  cloneDeep,
  isoDateToEpoch,
  millisToSeconds,
  rejectPromise,
  resolvePromise,
} from './_internal/util.js';
import { decodeIdToken, encodeIdToken, encodeJWT } from './https/jwt.js';

import {
  asAuthError,
  authError,
  userNotFoundError,
} from './_internal/auth-error.js';
import { TenantManager } from './_internal/tenant-manager.js';
import { AuthKey } from './types.js';

/**
 * Base implementation of the mock `firebase-admin/auth` interface.
 *
 * @remarks
 * This class encapsulates common behaviour for both project-wide and
 * tenant-aware auth instances. It delegates all user storage to
 * {@link TenantManager}, and focuses on reproducing the
 * behaviour of:
 *
 * - Custom token creation and verification
 * - ID token and session cookie verification (including revocation)
 * - Basic user CRUD
 * - Custom claims management
 * - Provider configuration management
 * - Action-link generation (password reset, email verification, etc.)
 *
 * Concrete subclasses provide project-wide (`Auth`) and tenant-scoped
 * (`TenantAwareAuth`) entry points.
 */
export abstract class BaseAuth implements IAuth {
  protected readonly _tenantId: string | undefined;

  /**
   * Creates a new base auth instance backed by a shared tenant manager.
   *
   * @param tenants - Shared {@link TenantManager} responsible for
   * user and provider state.
   * @param tenantId - Optional tenant identifier to scope all operations,
   * or `undefined` for project-wide (non-tenant) scope.
   */
  constructor(
    protected readonly tenants: TenantManager<AuthKey>,
    tenantId?: string | undefined
  ) {
    this._tenantId = tenantId;
  }

  /**
   * Creates a mock custom token for the specified UID and optional claims.
   *
   * @remarks
   * - Validates the UID format using {@link isValidUid}.
   * - Validates `developerClaims` using the same rules as custom user claims
   *   via {@link validatedCustomClaims}, for fidelity.
   * - Produces a signed JWT using {@link encodeJWT}. The signature is not
   *   verifiable by the real Admin SDK, but is sufficient for tests that
   *   only decode or inspect the payload.
   *
   * @param uid - UID of the user for whom to create a custom token.
   * @param developerClaims - Optional additional claims to embed in the token.
   * @returns A promise resolving to the encoded custom token, or rejecting
   * with an auth error if validation fails.
   */
  createCustomToken(uid: string, developerClaims?: object): Promise<string> {
    if (!isValidUid(uid)) {
      return rejectPromise(authError('invalid-uid'));
    }

    if (developerClaims && typeof developerClaims !== 'object') {
      return rejectPromise(
        authError('invalid-argument', 'developerClaims must be an object')
      );
    }

    let claims: Record<string, unknown> | undefined;
    if (developerClaims) {
      try {
        // We reuse custom-claims validation rules for fidelity.
        claims = validatedCustomClaims(
          developerClaims as Record<string, unknown> | undefined
        );
      } catch (e) {
        return rejectPromise(asAuthError(e));
      }
    }

    const token = encodeJWT({
      uid,
      claims,
    });

    return resolvePromise(token);
  }

  /**
   * Verifies a mock ID token and returns its decoded payload.
   *
   * @remarks
   * Behaviour mirrors the real Admin SDK as closely as practical:
   *
   * - Decodes the token using {@link decodeIdToken}.
   * - Validates expiry (`exp` vs current epoch).
   * - Optionally checks for revocation when `checkRevoked` is `true`, by
   *   comparing `auth_time`/`iat` against `tokensValidAfterTime`.
   * - Rejects for disabled users with `user-disabled`.
   *
   * Signature verification is **not** performed; tokens are trusted as
   * produced by this mock environment.
   *
   * @param idToken - Encoded ID token produced by this mock.
   * @param checkRevoked - Whether to reject tokens issued before
   * `tokensValidAfterTime`.
   * @returns A promise resolving to the decoded token, or rejecting with an
   * appropriate auth error.
   */
  verifyIdToken(
    idToken: string,
    checkRevoked?: boolean
  ): Promise<DecodedIdToken> {
    let decoded: DecodedIdToken;
    try {
      decoded = decodeIdToken(idToken);
    } catch {
      return rejectPromise(authError('invalid-id-token'));
    }

    const now = this.tenants.epoch();

    // Expiry check.
    if (typeof decoded.exp === 'number' && decoded.exp <= now) {
      return rejectPromise(authError('id-token-expired'));
    }

    const ai = decoded.uid
      ? this.tenants.tryGet(this._tenantId, decoded.uid)
      : undefined;

    // Disabled-user check (mirrors Admin behaviour).
    if (ai && ai.disabled) {
      return rejectPromise(authError('user-disabled'));
    }

    // Revocation check via tokensValidAfterTime.
    if (checkRevoked) {
      if (ai) {
        const validSince = isoDateToEpoch(ai.tokensValidAfterTime);
        if (validSince !== undefined) {
          const authTimeSec = decoded.auth_time ?? decoded.iat ?? undefined;
          if (typeof authTimeSec === 'number') {
            if (authTimeSec < validSince) {
              return rejectPromise(authError('id-token-revoked'));
            }
          }
        }
      } else {
        return rejectPromise(userNotFoundError({ uid: decoded.uid }));
      }
    }

    return resolvePromise(decoded);
  }

  /**
   * Retrieves a user by UID.
   *
   * @param uid - UID of the user to look up.
   * @returns A promise resolving to the corresponding {@link UserRecord},
   * or rejecting with `user-not-found` if the UID does not exist.
   */
  getUser(uid: string): Promise<UserRecord> {
    const ai = this.tenants.tryGet(this._tenantId, uid);
    if (!ai) return rejectPromise(userNotFoundError({ uid }));

    return resolvePromise(toUserRecord(ai));
  }

  /**
   * Retrieves a user by primary email.
   *
   * @param email - Email address to look up.
   * @returns A promise resolving to the matched {@link UserRecord},
   * or rejecting with `user-not-found` if no user has this email.
   */
  getUserByEmail(email: string): Promise<UserRecord> {
    return this.findUser(emailPredicate(email));
  }

  /**
   * Retrieves a user by primary phone number.
   *
   * @param phoneNumber - Phone number to look up.
   * @returns A promise resolving to the matched {@link UserRecord},
   * or rejecting with `user-not-found` if no user has this phone number.
   */
  getUserByPhoneNumber(phoneNumber: string): Promise<UserRecord> {
    return this.findUser(phoneNumberPredicate(phoneNumber));
  }

  /**
   * Retrieves a user by provider ID and provider-specific UID.
   *
   * @param providerId - Provider identifier (for example, `"google.com"`).
   * @param uid - Provider-specific UID for the user.
   * @returns A promise resolving to the matched {@link UserRecord},
   * or rejecting with `user-not-found`.
   */
  getUserByProviderUid(providerId: string, uid: string): Promise<UserRecord> {
    return this.findUser(providerUidPredicate(providerId, uid));
  }

  /**
   * Retrieves multiple users by a collection of identifiers.
   *
   * @remarks
   * For each identifier, the mock attempts to resolve the user by:
   *
   * - Email
   * - Phone number
   * - Provider ID + provider UID
   * - UID
   *
   * and partitions the results into `users` and `notFound` arrays.
   *
   * @param identifiers - Identifiers describing users to look up.
   * @returns A promise resolving to a {@link GetUsersResult} containing both
   * found and missing identifiers.
   */
  getUsers(identifiers: UserIdentifier[]): Promise<GetUsersResult> {
    const r: GetUsersResult = {
      notFound: [],
      users: [],
    };

    for (const id of identifiers as PossibleIdentifier[]) {
      let pred: AuthInstancePredicate | undefined;
      if (id.email) {
        pred = emailPredicate(id.email).predicate;
      } else if (id.phoneNumber) {
        pred = phoneNumberPredicate(id.phoneNumber).predicate;
      } else if (id.providerId && id.uid) {
        pred = providerUidPredicate(id.providerId, id.uid).predicate;
      } else if (id.uid) {
        pred = (ai) => ai.uid === id.uid;
      }
      let ai: AuthInstance | undefined;
      if (pred) {
        ai = this.tenants.find(this._tenantId, pred);
      }
      if (ai) {
        if (!r.users.find((v) => v.uid === ai.uid)) {
          r.users.push(toUserRecord(ai));
        }
      } else {
        r.notFound.push(id as UserIdentifier);
      }
    }

    return resolvePromise(r);
  }

  /**
   * Lists users in the current tenant using cursor-based pagination.
   *
   * @remarks
   * - The mock uses a simple array slice plus numeric `pageToken`.
   * - The returned order is the internal iteration order of the backing store.
   *
   * @param maxResults - Maximum number of users to return in this page.
   * Defaults to `1000` if omitted.
   * @param pageToken - Optional numeric cursor (as a string) indicating the
   * starting index for the next page.
   * @returns A promise resolving to a {@link ListUsersResult} with users and
   * an optional `pageToken` for further pages.
   */
  listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult> {
    const DEFAULT_MAX_PAGE_SIZE = 1000;
    const all = this.tenants.all(this._tenantId);
    const start = pageToken ? parseInt(pageToken, 10) || 0 : 0;
    const limit = maxResults ?? DEFAULT_MAX_PAGE_SIZE;

    const slice = all.slice(start, start + limit);
    const users: UserRecord[] = slice.map((ai) => toUserRecord(ai));

    const result: ListUsersResult = { users };
    if (start + limit < all.length) {
      result.pageToken = String(start + limit);
    }

    return resolvePromise(result);
  }

  /**
   * Creates a new user in the current tenant.
   *
   * @param properties - User properties matching {@link CreateRequest}.
   * @returns A promise resolving to the created {@link UserRecord}.
   */
  createUser(properties: CreateRequest): Promise<UserRecord> {
    return this.tenants.create(this._tenantId, properties);
  }

  /**
   * Deletes a user by UID from the current tenant.
   *
   * @param uid - UID of the user to delete.
   * @returns A promise that resolves if the user was deleted, or rejects
   * with `user-not-found` if the user does not exist.
   */
  deleteUser(uid: string): Promise<void> {
    return this.tenants.delete(this._tenantId, uid)
      ? resolvePromise()
      : rejectPromise(userNotFoundError({ uid }));
  }

  /**
   * Deletes multiple users by UID from the current tenant.
   *
   * @remarks
   * The result records success and failure counts, along with any
   * `FirebaseArrayIndexError` entries corresponding to missing users.
   *
   * @param uids - UIDs to delete.
   * @returns A promise resolving to a {@link DeleteUsersResult}.
   */
  deleteUsers(uids: string[]): Promise<DeleteUsersResult> {
    const result = genericBatchOp(uids, (uid) => {
      return this.tenants.delete(this._tenantId, uid)
        ? undefined
        : userNotFoundError({ uid });
    });

    return resolvePromise(result as DeleteUsersResult);
  }

  /**
   * Updates a user by UID in the current tenant.
   *
   * @param uid - UID of the user to update.
   * @param properties - Partial update properties matching {@link UpdateRequest}.
   * @returns A promise resolving to the updated {@link UserRecord}.
   */
  updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord> {
    return this.tenants.update(this._tenantId, uid, properties);
  }

  /**
   * Sets or clears custom user claims for the specified user.
   *
   * @remarks
   * - When `customUserClaims` is non-null, it is validated using
   *   {@link validatedCustomClaims}.
   * - When `customUserClaims` is `null`, existing claims are removed.
   *
   * @param uid - UID of the user to modify.
   * @param customUserClaims - Claims object to store, or `null` to clear.
   * @returns A promise that resolves when the operation has completed or
   * rejects with an auth error if validation fails.
   */
  setCustomUserClaims(
    uid: string,
    customUserClaims: object | null
  ): Promise<void> {
    const ai = this.tenants.tryGet(this._tenantId, uid);
    if (!ai) return rejectPromise(userNotFoundError({ uid }));

    if (customUserClaims) {
      try {
        ai.claims =
          (validatedCustomClaims(
            customUserClaims as Record<string, unknown>
          ) as Record<string, unknown>) ?? {};
      } catch (e) {
        return rejectPromise(asAuthError(e));
      }
    } else {
      delete ai.claims;
    }

    return resolvePromise();
  }

  /**
   * Revokes refresh tokens for a user by setting `tokensValidAfterTime`
   * to the current time.
   *
   * @remarks
   * Subsequent token verification calls with `checkRevoked: true` will
   * reject tokens issued before this time.
   *
   * @param uid - UID of the user whose tokens should be revoked.
   * @returns A promise that resolves once the revocation timestamp has
   * been updated.
   */
  revokeRefreshTokens(uid: string): Promise<void> {
    const ai = this.tenants.tryGet(this._tenantId, uid);
    if (!ai) return rejectPromise(userNotFoundError({ uid }));

    ai.tokensValidAfterTime = new Date(this.tenants.now()).toISOString();

    return resolvePromise();
  }

  /**
   * Imports a batch of users into the current tenant.
   *
   * @remarks
   * - Hash options are currently ignored; any provided password hashes are
   *   trusted as-is.
   * - Errors encountered while importing individual users are captured in
   *   the {@link UserImportResult.errors} array.
   *
   * @param users - User records to import.
   * @param options - Optional import options; currently ignored in the mock.
   * @returns A promise resolving to a {@link UserImportResult}.
   */
  importUsers(
    users: UserImportRecord[],
    options?: UserImportOptions
  ): Promise<UserImportResult> {
    // For now, we ignore hash options and trust caller-supplied hashes.
    void options;

    const result = genericBatchOp(users, (u) => {
      try {
        this.tenants.import(this._tenantId, u);

        return undefined;
      } catch (e) {
        return e as FirebaseError;
      }
    });

    return resolvePromise(result as UserImportResult);
  }

  /**
   * Creates a mock session cookie from an existing ID token.
   *
   * @remarks
   * - The ID token is decoded and re-encoded with a new `exp` field based
   *   on the supplied `expiresIn` duration.
   * - Signature verification is not performed.
   *
   * @param idToken - ID token to wrap as a session cookie.
   * @param sessionCookieOptions - Options specifying the `expiresIn`
   * duration in milliseconds.
   * @returns A promise resolving to the encoded session cookie.
   */
  createSessionCookie(
    idToken: string,
    sessionCookieOptions: SessionCookieOptions
  ): Promise<string> {
    let decoded: DecodedIdToken;
    try {
      decoded = decodeIdToken(idToken);
    } catch (e) {
      return rejectPromise(authError('invalid-id-token', (e as Error).message));
    }

    const expiresIn = sessionCookieOptions.expiresIn;
    if (typeof expiresIn !== 'number' || expiresIn <= 0) {
      return rejectPromise(authError('invalid-session-cookie-duration'));
    }

    const payload = cloneDeep(decoded);
    payload.exp = millisToSeconds(this.tenants.now() + expiresIn);
    const cookie = encodeIdToken(payload as DecodedIdToken);

    return resolvePromise(cookie);
  }

  /**
   * Verifies a mock session cookie and returns its decoded payload.
   *
   * @remarks
   * Behaviour is analogous to {@link verifyIdToken}, but uses the
   * `session-cookie-expired` and `session-cookie-revoked` error codes
   * where appropriate.
   *
   * @param sessionCookie - Encoded session cookie to verify.
   * @param checkRevoked - Whether to perform revocation checks based on
   * `tokensValidAfterTime`.
   * @returns A promise resolving to the decoded token, or rejecting with an
   * appropriate auth error.
   */
  verifySessionCookie(
    sessionCookie: string,
    checkRevoked?: boolean
  ): Promise<DecodedIdToken> {
    let decoded: DecodedIdToken;
    try {
      decoded = decodeIdToken(sessionCookie);
    } catch (e) {
      return rejectPromise(authError('invalid-id-token', (e as Error).message));
    }

    const now = this.tenants.epoch();
    if (typeof decoded.exp === 'number' && decoded.exp <= now) {
      return rejectPromise(authError('session-cookie-expired'));
    }

    const ai = this.tenants.tryGet(this._tenantId, decoded.uid);

    if (!ai) return rejectPromise(userNotFoundError({ uid: decoded.uid }));

    if (ai.disabled) {
      return rejectPromise(authError('user-disabled'));
    }

    if (checkRevoked && ai) {
      const validSince = isoDateToEpoch(ai.tokensValidAfterTime);
      if (validSince !== undefined) {
        const authTimeSec = decoded.auth_time ?? decoded.iat ?? undefined;
        if (typeof authTimeSec === 'number') {
          if (authTimeSec < validSince) {
            return rejectPromise(authError('session-cookie-revoked'));
          }
        }
      }
    }

    return resolvePromise(decoded);
  }

  /**
   * Generates a mock password reset link for the given email address.
   *
   * @remarks
   * - `actionCodeSettings` is currently ignored.
   * - The resulting URL is deterministic and suitable for tests that only
   *   need to assert link generation semantics.
   *
   * @param email - Target email address.
   * @param actionCodeSettings - Additional settings (ignored in the mock).
   * @returns A promise resolving to the generated link URL.
   */
  generatePasswordResetLink(
    email: string,
    actionCodeSettings?: ActionCodeSettings
  ): Promise<string> {
    void actionCodeSettings;

    const url = this.mockLinkUrl('reset', {
      mode: 'resetPassword',
      email,
    });
    return resolvePromise(url);
  }

  /**
   * Generates a mock email verification link for the given email address.
   *
   * @param email - Target email address.
   * @param actionCodeSettings - Additional settings (ignored in the mock).
   * @returns A promise resolving to the generated link URL.
   */
  generateEmailVerificationLink(
    email: string,
    actionCodeSettings?: ActionCodeSettings
  ): Promise<string> {
    void actionCodeSettings;

    const url = this.mockLinkUrl('signin', {
      mode: 'verifyEmail',
      email,
    });

    return resolvePromise(url);
  }

  /**
   * Generates a mock link for verifying and changing a user's email address.
   *
   * @param email - Current email address.
   * @param newEmail - New email address to verify.
   * @param actionCodeSettings - Additional settings (ignored in the mock).
   * @returns A promise resolving to the generated link URL.
   */
  generateVerifyAndChangeEmailLink(
    email: string,
    newEmail: string,
    actionCodeSettings?: ActionCodeSettings
  ): Promise<string> {
    void actionCodeSettings;
    const url = this.mockLinkUrl('change-email', {
      mode: 'verifyAndChangeEmail',
      email,
      newEmail,
    });

    return resolvePromise(url);
  }

  /**
   * Generates a mock sign-in-with-email link.
   *
   * @param email - Target email address.
   * @param actionCodeSettings - Action code settings (ignored in the mock).
   * @returns A promise resolving to the generated link URL.
   */
  generateSignInWithEmailLink(
    email: string,
    actionCodeSettings: ActionCodeSettings
  ): Promise<string> {
    void actionCodeSettings;

    const url = this.mockLinkUrl('signin', {
      mode: 'signIn',
      email,
    });

    return resolvePromise(url);
  }

  /**
   * Lists provider configurations using cursor-based pagination.
   *
   * @remarks
   * - The mock ignores `options.type` and returns all stored provider configs.
   * - `pageToken` is treated as a numeric offset.
   *
   * @param options - Filter and pagination options.
   * @returns A promise resolving to {@link ListProviderConfigResults}.
   */
  listProviderConfigs(
    options: AuthProviderConfigFilter
  ): Promise<ListProviderConfigResults> {
    const all = Array.from(this.providerConfigs().values());
    // For now we ignore the `type` discriminator and return all configs.
    const start = options.pageToken ? parseInt(options.pageToken, 10) || 0 : 0;
    const limit = options.maxResults ?? 100;

    const slice = all
      .slice(start, start + limit)
      .map((cfg) => cloneDeep(cfg) as AuthProviderConfig);

    const result: ListProviderConfigResults = {
      providerConfigs: slice,
    };

    if (start + limit < all.length) {
      result.pageToken = String(start + limit);
    }

    return resolvePromise(result);
  }

  /**
   * Retrieves a provider configuration by provider ID.
   *
   * @param providerId - Provider identifier (for example, `"google.com"`).
   * @returns A promise resolving to the provider config, or rejecting with
   * `invalid-provider-id` if not found.
   */
  getProviderConfig(providerId: string): Promise<AuthProviderConfig> {
    const cfg = this.providerConfigs().get(providerId);
    if (!cfg) {
      return rejectPromise(
        authError(
          'invalid-provider-id',
          `No provider config for "${providerId}".`
        )
      );
    }

    return resolvePromise(cloneDeep(cfg) as AuthProviderConfig);
  }

  /**
   * Deletes a provider configuration by provider ID.
   *
   * @param providerId - Provider identifier of the config to delete.
   * @returns A promise that resolves if the provider config existed and was
   * deleted, or rejects with `invalid-provider-id` otherwise.
   */
  deleteProviderConfig(providerId: string): Promise<void> {
    if (!this.providerConfigs().delete(providerId)) {
      return rejectPromise(
        authError(
          'invalid-provider-id',
          `No provider config for "${providerId}".`
        )
      );
    }

    return resolvePromise();
  }

  /**
   * Updates an existing provider configuration.
   *
   * @param providerId - Provider identifier.
   * @param updatedConfig - Partial configuration to merge with the existing
   * config. The provider ID of the stored config is preserved.
   * @returns A promise resolving to the updated {@link AuthProviderConfig},
   * or rejecting with `invalid-provider-id` if no matching config exists.
   */
  updateProviderConfig(
    providerId: string,
    updatedConfig: UpdateAuthProviderRequest
  ): Promise<AuthProviderConfig> {
    const store = this.providerConfigs();
    const existing = store.get(providerId);
    if (!existing) {
      return rejectPromise(
        authError(
          'invalid-provider-id',
          `No provider config for "${providerId}".`
        )
      );
    }

    const merged = {
      ...cloneDeep(existing),
      ...cloneDeep(updatedConfig),
      providerId: existing.providerId,
    } as AuthProviderConfig;

    store.set(providerId, merged);

    return resolvePromise(cloneDeep(merged) as AuthProviderConfig);
  }

  /**
   * Creates a new provider configuration.
   *
   * @remarks
   * - Fails with `invalid-provider-id` if `providerId` is missing or already
   *   registered.
   *
   * @param config - Complete provider configuration to register.
   * @returns A promise resolving to the stored {@link AuthProviderConfig}.
   */
  createProviderConfig(
    config: AuthProviderConfig
  ): Promise<AuthProviderConfig> {
    const providerId = config.providerId as string | undefined;
    if (!providerId) {
      return rejectPromise(
        authError('invalid-provider-id', 'Missing providerId in config.')
      );
    }
    const store = this.providerConfigs();

    if (store.has(providerId)) {
      return rejectPromise(
        authError(
          'invalid-provider-id',
          `Provider "${providerId}" already exists.`
        )
      );
    }

    const stored = cloneDeep(config) as AuthProviderConfig;
    store.set(providerId, stored);

    return resolvePromise(cloneDeep(stored) as AuthProviderConfig);
  }

  /**
   * Verifies a mock auth-blocking token.
   *
   * @remarks
   * - The `audience` parameter is currently ignored.
   * - The token is decoded via {@link decodeIdToken}, cast to
   *   {@link DecodedAuthBlockingToken}, and normalized with {@link applyToJSON}.
   *
   * @param token - Encoded auth-blocking token.
   * @param audience - Expected audience (ignored in the mock).
   * @returns A promise resolving to the decoded auth-blocking token, or
   * rejecting with `invalid-id-token`.
   */
  _verifyAuthBlockingToken(
    token: string,
    audience?: string
  ): Promise<DecodedAuthBlockingToken> {
    void audience; // For now, audience is ignored in the mock.

    try {
      const decoded = decodeIdToken(
        token
      ) as unknown as DecodedAuthBlockingToken;
      applyToJSON(decoded);
      return resolvePromise(decoded);
    } catch {
      return rejectPromise(authError('invalid-id-token'));
    }
  }

  // ---- Private helpers -----------------------------------------------------

  /**
   * Gets the provider configuration store for the current tenant,
   * creating it on first use.
   *
   * @returns A mutable map of provider ID to {@link AuthProviderConfig}.
   */
  private providerConfigs(): Map<string, AuthProviderConfig> {
    return this.tenants.tenantScoped(
      this._tenantId,
      'pconfigs',
      () => new Map()
    );
  }

  /**
   * Finds a user using the provided resolver and returns a {@link UserRecord}.
   *
   * @param resolver - Resolver that describes the predicate and identifying
   * keys used for error reporting.
   * @returns A promise resolving to the matching {@link UserRecord}, or
   * rejecting with `user-not-found` if no user matches the predicate.
   */
  private findUser(resolver: UserResolver): Promise<UserRecord> {
    const ai = this.tenants.find(this._tenantId, resolver.predicate);

    return ai
      ? resolvePromise(toUserRecord(ai))
      : rejectPromise(userNotFoundError(resolver.keys));
  }

  /**
   * Constructs a deterministic mock action link URL for the given type and
   * query parameters.
   *
   * @param type - Logical link type (for example, `"reset"`, `"signin"`).
   * @param params - Optional query parameters to append to the URL.
   * @returns A deterministic URL string suitable for tests.
   */
  private mockLinkUrl(type: string, params?: Record<string, string>): string {
    const parts: string[] = [];

    function append(key: string, value: string | null | undefined): void {
      if (value) {
        parts.push(`${key}=${encodeURIComponent(value)}`);
      }
    }
    append('tenant', this._tenantId);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        append(key, value);
      }
    }
    const url = `https://mock.${type}.local/`;

    return parts.length > 0 ? url + '?' + parts.join('&') : url;
  }
}

/**
 * Project-wide mock implementation of `firebase-admin/auth`.
 *
 * @remarks
 * This class represents the default (non-tenant-aware) auth instance, and
 * is analogous to `admin.auth()` in a single-tenant project. Tenant-specific
 * instances can be created via {@link authForTenant}.
 */
export class Auth extends BaseAuth {
  /**
   * Creates a new project-wide auth instance.
   *
   * @param tenants - Shared {@link TenantManager} for managing users
   * and provider configs across tenants.
   */
  constructor(tenants: TenantManager<AuthKey>) {
    super(tenants);
  }

  /**
   * Returns a tenant-scoped auth instance for the given tenant ID.
   *
   * @param tenantId - Tenant identifier to scope subsequent operations.
   * @returns A {@link TenantAwareAuth} instance bound to the tenant.
   */
  authForTenant(tenantId: string): TenantAwareAuth {
    return new TenantAwareAuth(this.tenants, tenantId);
  }
}

/**
 * Tenant-specific mock implementation of `firebase-admin/auth`.
 *
 * @remarks
 * Instances of this class are created via {@link Auth.authForTenant} and
 * scope all operations (user CRUD, token verification, provider configs,
 * etc.) to a specific tenant.
 */
export class TenantAwareAuth extends BaseAuth {
  /**
   * Creates a new tenant-aware auth instance.
   *
   * @param tenants - Shared {@link TenantManager}.
   * @param tenantId - Non-empty tenant identifier.
   * @throws {@link Error} if `tenantId` is falsy.
   */
  constructor(tenants: TenantManager<AuthKey>, tenantId: string) {
    if (!tenantId) throw new Error('Invalid tenantId');

    super(tenants, tenantId);
  }

  /**
   * The tenant identifier for this auth instance.
   */
  get tenantId(): string {
    return this._tenantId as string;
  }
}

/**
 * Describes a user resolution strategy for lookups by email, phone number,
 * provider UID, or other criteria.
 */
type UserResolver = {
  /**
   * Predicate used to resolve the user within the current tenant.
   */
  predicate: AuthInstancePredicate;
  /**
   * Name/value pairs representing the query used to resolve the user.
   *
   * @remarks
   * These keys are used to construct meaningful error messages when
   * a user cannot be found (for example, `{ email: "alice@example.com" }`).
   */
  keys: Record<string, string>;
};

/**
 * Creates a {@link UserResolver} that matches users by email address.
 *
 * @param email - Email address to match.
 * @returns A resolver that matches users with a non-undefined email equal
 * to the provided value.
 */
function emailPredicate(email: string): UserResolver {
  return {
    predicate: (ai) => ai.email != undefined && ai.email === email,
    keys: {
      email,
    },
  };
}

/**
 * Creates a {@link UserResolver} that matches users by phone number.
 *
 * @param phoneNumber - Phone number to match.
 * @returns A resolver that matches users with a non-undefined phone number
 * equal to the provided value.
 */
function phoneNumberPredicate(phoneNumber: string): UserResolver {
  return {
    predicate: (ai) =>
      ai.phoneNumber != undefined && ai.phoneNumber === phoneNumber,
    keys: { phoneNumber },
  };
}

/**
 * Creates a {@link UserResolver} that matches users by provider ID and
 * provider-specific UID.
 *
 * @param providerId - Provider identifier (for example, `"google.com"`).
 * @param uid - Provider-specific UID.
 * @returns A resolver that matches users containing a {@link AuthInstance.userInfo}
 * entry with the given provider ID and UID.
 */
function providerUidPredicate(providerId: string, uid: string): UserResolver {
  return {
    predicate: (ai) => {
      for (const value of Object.values(ai.userInfo)) {
        if (value.providerId === providerId && value.uid === uid) return true;
      }

      return false;
    },
    keys: {
      providerId,
      uid,
    },
  };
}

/**
 * Generic batch operation result used for user deletion and import.
 */
type GenericBatchResult = {
  /**
   * Number of individual operations that failed.
   */
  failureCount: number;
  /**
   * Number of individual operations that succeeded.
   */
  successCount: number;
  /**
   * Per-item error details keyed by the index in the input array.
   */
  errors: FirebaseArrayIndexError[];
};

/**
 * Executes a batch operation over an array of values and aggregates results.
 *
 * @remarks
 * - The handler is invoked for each value.
 * - If the handler returns a {@link FirebaseError}, it is recorded as a failure
 *   for that index; otherwise, the operation is counted as a success.
 * - This utility underpins operations such as `deleteUsers` and `importUsers`.
 *
 * @typeParam T - Type of values being processed.
 * @param values - Values to process.
 * @param handler - Function that performs the operation and returns a
 * `FirebaseError` on failure, or `undefined` on success.
 * @returns An aggregated {@link GenericBatchResult}.
 */
function genericBatchOp<T>(
  values: T[],
  handler: (value: T) => FirebaseError | undefined
): GenericBatchResult {
  const result: GenericBatchResult = {
    errors: [],
    failureCount: 0,
    successCount: 0,
  };
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const error = handler(v);
    if (error) {
      result.failureCount += 1;
      result.errors.push({
        error,
        index: i,
      });
    } else {
      result.successCount += 1;
    }
  }

  return result;
}

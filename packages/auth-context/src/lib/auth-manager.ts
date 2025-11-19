import { DecodedAppCheckToken } from 'firebase-admin/app-check';
import {
  assignMultiFactors,
  generateEmail,
  generatePhoneNumber,
  resolveSecondFactor,
  validatedCustomClaims,
} from './_internal/auth-helpers.js';
import {
  AuthInstance,
  IUserMetadata,
  PersistedUserInfo,
} from './_internal/auth-types.js';
import { TenantManager } from './_internal/tenant-manager.js';
import {
  AuthProvider,
  DEFAULT_PROJECT_ID,
  DEFAULT_REGION,
  EPOCH_DAY,
  EPOCH_MINUTES_30,
  EPOCH_MINUTES_60,
  RemoveIndexSignature,
} from './_internal/types.js';
import {
  appId,
  assignDefer,
  assignIf,
  cloneDeep,
  epochSeconds,
  projectNumber,
  providerId,
  userId,
  utcDate,
} from './_internal/util.js';
import { Auth } from './auth.js';
import { _HttpsBroker } from './https/_internal/https-broker.js';
import { formatIss } from './https/_internal/util.js';
import { HttpsBroker } from './https/types.js';
import {
  AppCheckConstructor,
  AppCheckData,
  AuthContextOptions,
  AuthenticatedRequestContext,
  AuthKey,
  IdentityConstructor,
  IdentityOptions,
  MockIdentity,
  UnauthenticatedRequestContext,
} from './types.js';

/**
 * Construction options for {@link AuthManager}.
 *
 * @remarks
 * These options let you fix the “environment” your tests run in — time source,
 * project identity, region, and even stable OAuth provider IDs — so that
 * repeated invocations generate deterministic tokens and contexts.
 *
 * - All properties are optional.
 * - Missing values are synthesized to realistic Firebase-looking values.
 */
export interface AuthManagerOptions {
  /**
   * Function that returns the current epoch milliseconds.
   *
   * @remarks
   * - Used to derive `iat`, `auth_time`, and `exp` when not explicitly provided
   *   in {@link AuthContextOptions}.
   * - Override this in tests to get deterministic timestamps.
   * - Defaults to `() => Date.now()`.
   */
  now?: () => number;

  /**
   * Firebase App ID used to populate App Check tokens (`sub`, `app_id`).
   *
   * @remarks
   * If omitted, a synthetic app ID is generated from the project number so the
   * resulting token “looks” real.
   */
  appId?: string;

  /**
   * Firebase **project number** used as part of the App Check audience.
   *
   * @remarks
   * Defaults to a generated project number.
   */
  projectNumber?: string;

  /**
   * Firebase **project ID** (human-readable) used as the App Check audience.
   *
   * @remarks
   * Defaults to a sensible value (`"default-project"`) so tests do not need
   * to supply it.
   */
  projectId?: string;

  /**
   * Default Cloud Functions region used by the HTTPS broker.
   *
   * @remarks
   * This is applied to all mock HTTPS invocations made through
   * {@link AuthManager.https}.
   * Defaults to `'nam5'`.
   */
  region?: string;
}

/**
 * Test-focused provider for mock authentication and App Check contexts
 * for Firebase HTTPS functions.
 *
 * @typeParam TKey - The key type used to register and retrieve identities
 * (defaults to {@link AuthKey}).
 *
 * @remarks
 * - Keeps an in-memory registry of identity **templates** keyed by `TKey`.
 * - Produces fresh per-invocation auth contexts with realistic time claims.
 * - Can automatically attach an App Check token to each context.
 * - Exposes an {@link HttpsBroker} prebound to this manager’s project/region.
 */
export class AuthManager<TKey extends AuthKey = AuthKey>
  implements AuthProvider<TKey>
{
  private _tenantManager: TenantManager<TKey>;

  /**
   * Firebase App ID used for App Check tokens (`sub`, `app_id`).
   */
  readonly appId: string;

  /**
   * Firebase project **number** used in App Check token audience.
   */
  readonly projectNumber: string;

  /**
   * The audience for which App Check tokens are intended. Equal to your Firebase **project ID**.
   */
  readonly projectId: string;

  /**
   * Default Cloud Functions region used by {@link https}.
   */
  readonly region: string;

  /**
   * Issuer string used for App Check tokens, derived from the {@link projectNumber}.
   */
  readonly iss: string;

  /**
   * The HTTPS broker bound to this manager’s defaults (project/region).
   *
   * @remarks
   * The broker is used to invoke mock HTTPS callable/HTTP handlers with synthesized auth/app contexts.
   */
  readonly https: HttpsBroker<TKey>;

  /**
   * Auth facade exposing a high-fidelity mock of the Admin SDK Auth API.
   *
   * @remarks
   * Backed by the same internal `AuthInstance` map that powers context
   * generation, so operations such as `updateUser` are reflected in future
   * tokens and request contexts.
   */
  readonly auth: Auth;

  /**
   * Create a new {@link AuthManager} with optional environment overrides.
   *
   * @param options - Optional initialization overrides. See {@link AuthManagerOptions}.
   */
  constructor(options?: AuthManagerOptions) {
    this._tenantManager = new TenantManager(options?.now ?? (() => Date.now()));
    this.projectNumber = options?.projectNumber ?? projectNumber();
    this.appId = options?.appId ?? appId(this.projectNumber);
    this.projectId = options?.projectId ?? DEFAULT_PROJECT_ID;
    this.region = options?.region ?? DEFAULT_REGION;
    this.iss = formatIss(this.projectNumber);
    this.https = new _HttpsBroker(this);
    this.auth = new Auth(this._tenantManager);
  }

  /**
   * Register a normalized identity template under the specified key.
   *
   * @param key - Registry key to associate with this identity.
   * @param identity - Lightweight constructor (partial) that will be normalized.
   * @returns The UID of the newly registered identity.
   *
   * @throws {Error} If the key has already been registered.
   *
   * @remarks
   * - The identity is normalized via an internal {@link authInstance} helper.
   * - The stored template is immutable from the caller’s perspective; runtime
   *   methods return deep-cloned copies.
   */
  register(key: TKey, identity?: IdentityConstructor): string {
    const ai = this.authInstance(identity ?? {});
    this._tenantManager.register(key, ai);

    return ai.uid;
  }

  /**
   * Deregister a previously registered identity.
   *
   * @param key - Registry key to remove.
   * @returns `true` if the identity existed and was removed, otherwise `false`.
   *
   * @remarks
   * This removes both the default template and its active instance, so any
   * subsequent attempts to use `key` for a context will fail with an error.
   */
  deregister(key: TKey): boolean {
    return this._tenantManager.deregister(key);
  }

  /**
   * Build a request-auth context, either authenticated (when `key` is supplied)
   * or unauthenticated (when `key` is omitted).
   *
   * @param options - Per-invocation overrides (identity key, times, App Check).
   * @returns An {@link AuthenticatedRequestContext} or {@link UnauthenticatedRequestContext}.
   *
   * @throws {Error} If a `key` is supplied but no identity is registered for it.
   *
   * @remarks
   * - Authenticated case:
   *   - `iat` defaults to `now()`
   *   - `auth_time` defaults to `iat - 30m`
   *   - `exp` defaults to `iat + 30m`
   *   - Multi-factor details are applied if configured via
   *     {@link IdentityConstructor.multiFactorDefault} or
   *     {@link IdentityOptions.multifactorSelector}.
   * - Unauthenticated case:
   *   - Only `projectId` and optional App Check are included.
   * - Set `appCheck: false` to omit App Check for this call.
   */
  context(
    options?: AuthContextOptions<TKey>
  ): UnauthenticatedRequestContext | AuthenticatedRequestContext {
    let context: AuthenticatedRequestContext | UnauthenticatedRequestContext;
    const key = options?.key;
    if (key) {
      const identity = this.identity(key, options);
      const iat = epochSeconds(options?.iat ?? this._tenantManager.epoch());
      const auth_time = epochSeconds(
        options?.authTime ?? iat - EPOCH_MINUTES_30
      );
      const exp = epochSeconds(options?.expires ?? iat + EPOCH_MINUTES_30);

      context = {
        projectId: this.projectId,
        auth_time,
        exp,
        iat,
        identity,
      } as AuthenticatedRequestContext;
    } else {
      context = {
        projectId: this.projectId,
      } as UnauthenticatedRequestContext;
    }

    if (options?.appCheck !== false) {
      context.app = this.appCheck(
        options?.appCheck === true ? undefined : options?.appCheck
      );
    }

    return context;
  }

  /**
   * Reset mutable identity instances back to their registered defaults.
   *
   * @remarks
   * - Clears the internal instance map and re-clones all registered defaults.
   * - Does **not** remove registered identities; use {@link deregister} for that.
   * - Useful between tests to discard mutations from Admin SDK calls
   *   (`updateUser`, etc.) while keeping the registry intact.
   */
  reset(): void {
    this._tenantManager.reset();
  }

  /**
   * Synthesize an App Check payload from optional constructor values.
   *
   * @param c - Optional seed object containing explicit `iat`/`exp` or custom claims.
   * @returns A normalized {@link AppCheckData} ready to attach to a request context.
   *
   * @remarks
   * - Always enforces this manager’s `appId`, `aud`, and `iss`.
   * - Defaults to a 60-minute validity window when times are not provided.
   * - Preserves arbitrary additional properties on the token.
   */
  protected appCheck(c?: AppCheckConstructor | undefined): AppCheckData {
    // Clone the constructor to capture any arbitrary key/value pairs.
    const token = (c ? cloneDeep(c) : {}) as DecodedAppCheckToken;
    // Remove the AppCheckConstructor-specific property
    delete token.alreadyConsumed;
    // We don't allow overriding of these properties
    token.sub = this.appId;
    token.app_id = this.appId;
    token.aud = [this.projectNumber, this.projectId];
    token.iss = this.iss;
    // exp and iat may be overriden. Synthesize if not.
    token.exp = epochSeconds(
      c?.exp ?? this._tenantManager.epoch() + EPOCH_MINUTES_60
    );
    token.iat = epochSeconds(c?.iat ?? token.exp - EPOCH_MINUTES_60);
    // All other arbitrary values were cloned from the AppCheckConstructor

    const r: AppCheckData = {
      appId: token.app_id,
      token,
    };

    assignIf(r, 'alreadyConsumed', c?.alreadyConsumed);

    return r;
  }

  /**
   * Resolve a normalized {@link MockIdentity} for the given registry key.
   *
   * @param key - Registry key for the identity.
   * @param options - Optional provider and multi-factor selection overrides.
   * @returns A {@link MockIdentity} suitable for embedding into a request context.
   *
   * @throws {Error} If the key is not registered, the backing instance is
   *         missing, or the identity is disabled.
   *
   * @remarks
   * - Applies provider-derived identities (email/phone) into the
   *   `firebase.identities` bag.
   * - Chooses a default `sign_in_provider` when `options.signInProvider`
   *   is not supplied (first non-anonymous provider or `'anonymous'`).
   * - Applies multi-factor details based on {@link IdentityOptions.multifactorSelector}.
   * - Copies validated custom claims from the underlying `AuthInstance`.
   */
  identity(key: TKey, options?: IdentityOptions): MockIdentity {
    const ai = this._tenantManager.getByKey(key);

    if (ai.disabled)
      throw new Error(authInstanceError(key, ai.uid, `is disabled`));

    const identities: Record<string, string[]> = {};

    function appendIdentity(key: string, value: string | undefined): void {
      if (!value) return;
      const array = identities[key];
      if (array) {
        array.push(value);
      } else {
        identities[key] = [value];
      }
    }
    let signInProvider = options?.signInProvider;

    for (const ui of Object.values(ai.userInfo)) {
      if (!signInProvider) {
        signInProvider = ui.providerId;
      }
      if (ui.providerId !== 'anonymous') {
        appendIdentity(ui.providerId, ui.uid);
        appendIdentity('email', ui.email);
        appendIdentity('phone', ui.phoneNumber);
      }
    }

    if (!signInProvider) {
      signInProvider = 'anonymous';
    }
    const isAnonymous = signInProvider === 'anonymous';

    const id: RemoveIndexSignature<MockIdentity> = {
      uid: ai.uid,
      iss: this.iss,
      firebase: {
        sign_in_provider: signInProvider,
        identities,
      },
    };

    if (!isAnonymous) {
      const mfa = resolveSecondFactor(ai, options?.multifactorSelector);
      if (mfa) {
        id.firebase.sign_in_second_factor = mfa.factorId;
        id.firebase.second_factor_identifier = mfa.uid;
      }
    }

    if (ai.tenantId) {
      id.firebase.tenant = ai.tenantId;
    }
    if (!isAnonymous) {
      assignIf(id, 'email', ai.email);
      assignIf(id, 'email_verified', ai.emailVerified);
      assignIf(id, 'phone_number', ai.phoneNumber);
    }
    assignIf(id, 'photo_url', ai.photoURL);
    assignIf(id, 'name', ai.displayName);

    if (ai.claims) {
      const claims = cloneDeep(ai.claims);
      for (const [key, value] of Object.entries(claims)) {
        (id as MockIdentity)[key] = value;
      }
    }

    return id;
  }

  private authInstance(c: IdentityConstructor): AuthInstance {
    const userMeta = (): IUserMetadata => {
      const meta = c.metadata;
      const creationTime = epochSeconds(
        meta?.creationTime ?? this._tenantManager.epoch() - EPOCH_DAY
      );

      const neverSignedIn = meta?.lastRefreshTime === null;

      let lastSignInTime = neverSignedIn
        ? creationTime
        : epochSeconds(meta?.lastSignInTime ?? creationTime);

      if (lastSignInTime < creationTime) {
        lastSignInTime = creationTime;
      }

      let lastRefreshTime = neverSignedIn
        ? null
        : epochSeconds(meta?.lastRefreshTime ?? lastSignInTime);
      if (lastRefreshTime && lastRefreshTime < lastSignInTime) {
        lastRefreshTime = lastSignInTime;
      }

      return {
        creationTime: utcDate(creationTime),
        lastSignInTime: utcDate(lastSignInTime),
        lastRefreshTime: lastRefreshTime ? utcDate(lastRefreshTime) : null,
      };
    };
    const uid = c.uid ?? userId();
    const userInfo: Record<string, PersistedUserInfo> = {};

    const instance: AuthInstance = {
      uid,
      disabled: !!c.disabled,
      userInfo,
      metadata: userMeta(),
    };

    function applyUserInfo(ui: PersistedUserInfo): void {
      if (!c.suppressProviderDefaults) {
        assignDefer(instance, 'displayName', ui.displayName);
        assignDefer(instance, 'email', ui.email);
        assignDefer(instance, 'phoneNumber', ui.phoneNumber);
        assignDefer(instance, 'photoURL', ui.photoURL);
      }
    }

    if (c.customClaims) {
      instance.claims = validatedCustomClaims(c.customClaims);
    }

    assignIf(instance, 'multiFactorDefault', c.multiFactorDefault);
    if (c.multiFactorEnrollments) {
      const enrollments = ensureArray(c.multiFactorEnrollments);
      assignMultiFactors(instance, enrollments);
    }

    if (c.providers) {
      const providers = ensureArray(c.providers);
      for (const p of providers) {
        if (!p) continue;

        const data = p.data;
        const ui: PersistedUserInfo = {
          uid: data?.uid ?? providerId(p.type),
          providerId: p.signInProvider,
        };
        userInfo[ui.providerId] = ui;
        let hasId = false;
        if (data) {
          hasId = assignIf(ui, 'email', data.email) || hasId;
          hasId = assignIf(ui, 'phoneNumber', data.phoneNumber) || hasId;
          assignIf(ui, 'displayName', data?.displayName);
          assignIf(ui, 'photoURL', data.photoURL);
        }
        // Unless suppressed, assign provider-derived defaults on a first-in basis.
        // We do this here to avoid capturing any generated phone/email values so that
        // subsequent explicit provider values can be assigned instead.
        if (!c.suppressProviderDefaults) {
          applyUserInfo(ui);
        }
        // Assign generated phone/email after applyUserInfo()
        if (!hasId) {
          switch (p.type) {
            case 'anonymous':
              break;

            case 'phone':
              ui.phoneNumber = generatePhoneNumber();
              break;

            default:
              ui.email = generateEmail();
              break;
          }
        }
      }
      // Unless suppressed, assign provider-derived defaults on a first-in basis.
      // This iteration will capture any generated phone/email values.
      if (!c.suppressProviderDefaults) {
        for (const ui of Object.values(instance.userInfo)) {
          applyUserInfo(ui);
        }
      }
    }

    // Explicit identity values override implicit provider values.
    assignIf(instance, 'displayName', c.displayName);
    assignIf(instance, 'email', c.email);
    assignIf(instance, 'emailVerified', c.emailVerified ?? false);
    assignIf(instance, 'phoneNumber', c.phoneNumber);
    assignIf(instance, 'photoURL', c.photoURL);
    assignIf(instance, 'tenantId', c.tenantId);

    if (c.tokensValidAfterTime) {
      instance.tokensValidAfterTime = utcDate(c.tokensValidAfterTime);
    }

    return instance;
  }
}

function identityError(key: AuthKey, msg: string): string {
  return `Identity error for key "${key}". ${msg}.`;
}

function authInstanceError(key: AuthKey, uid: string, msg: string): string {
  return identityError(key, `Identity with uid ${uid} ${msg}.`);
}

function ensureArray<T>(input: T | T[]): T[] {
  return Array.isArray(input) ? input : [input];
}

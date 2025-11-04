import { DecodedAppCheckToken } from 'firebase-admin/app-check';
import { providerId } from './_internal/provider-id.js';
import {
  AuthProvider,
  DEFAULT_PROJECT_ID,
  DEFAULT_REGION,
  EPOCH_MINUTES_30,
  EPOCH_MINUTES_60,
} from './_internal/types.js';
import {
  appId,
  cloneDeep,
  epochSeconds,
  hexId,
  millisToSeconds,
  projectNumber,
  userId,
} from './_internal/util.js';
import { formatIss } from './https/_internal/util.js';
import { _HttpsBroker } from './https/_internal/https-broker.js';
import { HttpsBroker } from './https/types.js';
import {
  AppCheckConstructor,
  AppCheckData,
  AuthContextOptions,
  AuthenticatedRequestContext,
  AuthKey,
  FirebaseIdentities,
  IdentityConstructor,
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

  /**
   * Optional map of provider IDs to **stable** OAuth IDs to use in synthesized
   * identities.
   *
   * @remarks
   * - Keys should be Firebase provider IDs (e.g. `'google.com'`, `'apple.com'`),
   *   but missing/empty values are normalized.
   * - This is mainly for tests that assert on provider-specific UIDs in
   *   `firebase.identities[...]`.
   * - Once the manager is constructed this map is frozen.
   */
  oauthIds?: Record<string, string | undefined>;
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
  private _ids = new Map<TKey, MockIdentity>();
  private _now: () => number;

  /**
   * A set of consistent oauth ids for providers where tests require them, defined during
   * construction. This collection is readonly (frozen).
   */
  readonly oauthIds: Record<string, string>;

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
   * Create a new {@link AuthManager} with optional environment overrides.
   *
   * @param options - Optional initialization overrides. See {@link AuthManagerOptions}.
   */
  constructor(options?: AuthManagerOptions) {
    this._now = options?.now ?? (() => Date.now());
    this.projectNumber = options?.projectNumber ?? projectNumber();
    this.appId = options?.appId ?? appId(this.projectNumber);
    this.projectId = options?.projectId ?? DEFAULT_PROJECT_ID;
    this.region = options?.region ?? DEFAULT_REGION;
    this.iss = formatIss(this.projectNumber);
    this.https = new _HttpsBroker(this);
    this.oauthIds = {};
    if (options?.oauthIds) {
      for (const [key, value] of Object.entries(options.oauthIds)) {
        this.oauthIds[key] = value?.trim() ? value : providerId(key);
      }
    }
    Object.freeze(this.oauthIds);
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
   * - The identity is normalized via {@link AuthManager.mockIdentity}.
   * - The stored template is immutable from the caller’s perspective; runtime
   *   methods return deep-cloned copies.
   */
  register(key: TKey, identity?: IdentityConstructor): string {
    if (this._ids.has(key))
      throw new Error(`Identity already registered for the key "${key}".`);

    const result = this.mockIdentity(identity ?? {});
    this._ids.set(key, result);

    return result.uid;
  }

  /**
   * Deregister a previously registered identity.
   *
   * @param key - Registry key to remove.
   * @returns `true` if the identity existed and was removed, otherwise `false`.
   */
  deregister(key: TKey): boolean {
    return this._ids.delete(key);
  }

  /**
   * Retrieve a deep-cloned identity template for a key, if registered.
   *
   * @param key - Registry key to look up.
   * @returns A cloned {@link MockIdentity}, or `undefined` if not found.
   *
   * @remarks
   * The returned object is safe to mutate in tests without affecting the
   * underlying registry.
   */
  identity(key: TKey): MockIdentity | undefined {
    return cloneDeep(this._ids.get(key));
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
      const id = this._ids.get(key);
      if (id == undefined)
        throw new Error(`No identity registered for the key "${key}".`);

      const iat = epochSeconds(options?.iat) ?? millisToSeconds(this._now());
      const auth_time =
        epochSeconds(options?.authTime) ?? iat - EPOCH_MINUTES_30;
      const exp = epochSeconds(options?.expires) ?? iat + EPOCH_MINUTES_30;
      const identity: MockIdentity = cloneDeep(id);

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
    const alreadyConsumed = c?.alreadyConsumed === true;
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
    token.exp =
      epochSeconds(c?.exp) ?? millisToSeconds(this._now()) + EPOCH_MINUTES_60;
    token.iat = epochSeconds(c?.iat) ?? token.exp - EPOCH_MINUTES_60;
    // All other arbitrary values were cloned from the AppCheckConstructor

    const r: AppCheckData = {
      appId: token.app_id,
      token,
    };

    if (typeof alreadyConsumed === 'boolean') {
      r.alreadyConsumed = alreadyConsumed;
    }

    return r;
  }
  /**
   * Normalize an {@link IdentityConstructor} into a stable {@link MockIdentity}
   * suitable for registry storage.
   *
   * @param ic - Constructor containing partial profile/provider details.
   * @returns A fully normalized {@link MockIdentity}.
   *
   * @remarks
   * - Ensures `iss`, `uid`, and `firebase` blocks are present.
   * - Ensures a canonical sign-in provider is set (using
   *   {@link defaultProvider} logic).
   * - Applies extra arbitrary claims supplied via `ic.claims`.
   */
  protected mockIdentity(ic: IdentityConstructor): MockIdentity {
    const id: MockIdentity = cloneDeep(ic) as MockIdentity;
    const claims = (id as IdentityConstructor).claims;
    delete (id as IdentityConstructor).claims;
    delete (id as IdentityConstructor).signInProvider;

    id.iss = id.iss ?? this.iss;
    id.uid = ic.uid ?? userId();
    const fb: FirebaseIdentities = id.firebase ?? {};
    if (!fb.identities) {
      fb.identities = {};
    }

    id.firebase = fb;
    if (fb.sign_in_second_factor && !fb.second_factor_identifier) {
      fb.second_factor_identifier = userId();
    }

    defaultProvider(id, ic, this.oauthIds);

    if (claims) {
      for (const [key, value] of Object.entries(claims)) {
        id[key] = value;
      }
    }

    return id;
  }
}

/**
 * Internal helper to apply canonical provider defaults to a mock identity.
 *
 * @param id - The identity being normalized.
 * @param ic - The original constructor (may contain preferred provider).
 * @param oauth - Preconfigured stable OAuth IDs.
 *
 * @remarks
 * This function:
 * - Normalizes friendly provider aliases (e.g. `'google'`) to
 *   canonical IDs (e.g. `'google.com'`),
 * - Ensures the corresponding `firebase.identities[...]` bucket exists,
 * - Optionally attaches an email/phone identity where appropriate,
 * - And leaves `"custom"` / `"anonymous"` mostly untouched.
 */
function defaultProvider(
  id: MockIdentity,
  ic: IdentityConstructor,
  oauth: Record<string, string>
): void {
  // If caller pre-set firebase.sign_in_provider and no override requested, respect it.
  if (ic.firebase?.sign_in_provider && ic.signInProvider == undefined) return;

  // Normalize to canonical provider IDs expected in tokens.
  const wanted = ic.signInProvider ?? 'anonymous';

  const normalize = (p: string): string => {
    switch (p) {
      case 'google':
        return 'google.com';
      case 'apple':
        return 'apple.com';
      case 'microsoft':
        return 'microsoft.com';
      case 'twitter':
        return 'twitter.com'; // not "x.com"
      case 'github':
        return 'github.com';
      case 'facebook':
        return 'facebook.com';
      case 'yahoo':
        return 'yahoo.com';
      case 'playgames':
        return 'playgames.google.com';
      case 'gamecenter':
        return 'gc.apple.com';
      case 'password':
      case 'phone':
      case 'anonymous':
      case 'custom':
        return p;
      default:
        // fall back to raw if caller passed an already-canonical ID (e.g., "oidc.foo")
        return p;
    }
  };

  const provId = normalize(wanted);
  id.firebase.sign_in_provider = provId;

  // Helper to ensure an identities bucket exists and push a unique value.
  const pushIdentity = (key: string, value: string | undefined) => {
    if (!value) return;
    const arr = (id.firebase.identities[key] ??= []);
    if (!arr.includes(value)) arr.push(value);
  };

  // For email convenience (used by "password" and as optional extra for OAuth)
  const emailOrDefault = (domain: string) =>
    id.email ?? `user-${hexId(6)}@${domain}`;

  // For OAuth providers, we need a stable provider-specific UID (opaque).
  // Use existing id.providerUid map if you have one; otherwise synthesize.
  const providerUid = (prov: string) =>
    id.firebase.identities[prov]?.[0] ?? oauth[prov] ?? providerId(wanted);

  switch (provId) {
    case 'password': {
      // identities.email -> email
      pushIdentity('email', emailOrDefault('example.com'));
      break;
    }

    case 'phone': {
      // identities.phone -> E.164 number
      const phone = id.phone_number ?? '+15551234567';
      pushIdentity('phone', phone);
      break;
    }

    case 'anonymous':
    case 'custom': {
      // Typically no identities entries for these.
      break;
    }

    default: {
      // OAuth providers (google.com, apple.com, microsoft.com, twitter.com, etc.)
      pushIdentity(provId, providerUid(provId));
      // Add the email if it exists
      if (id.email) pushIdentity('email', id.email);
      break;
    }
  }
}

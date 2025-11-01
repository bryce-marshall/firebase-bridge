import { DecodedAppCheckToken } from 'firebase-admin/app-check';
import { DecodedIdToken } from 'firebase-admin/auth';

/**
 * Per-invocation override for App Check behavior.
 *
 * @remarks
 * Use this to inject a specific decoded App Check token and/or signal
 * whether that token should be treated as already consumed.
 */
export interface AppCheckOverride {
  /**
   * A decoded Firebase App Check token to use for this invocation.
   *
   * @remarks
   * If omitted, the provider (e.g., `AuthManager`) will synthesize a token.
   */
  token?: DecodedAppCheckToken;

  /**
   * Indicates whether this token was already consumed.
   *
   * @remarks
   * If this is the first time {@link AppCheck.verifyToken} has seen this token,
   * this flag is `false` and the service will mark it as consumed for future calls.
   * If `true`, the caller is attempting to reuse a previously consumed token.
   * Consider taking additional precautions (rejecting the request, extra checks, etc.).
   */
  alreadyConsumed?: boolean;
}

/**
 * Authentication provider metadata embedded inside ID tokens under the
 * reserved `firebase` claim.
 *
 * @remarks
 * Mirrors common fields exposed by Firebase Authentication and Identity Platform.
 */
export interface FirebaseIdentities {
  /**
   * Provider-specific identity details keyed by provider.
   * Example: `{ "email": ["alice@gmail.com"], "google.com": ["24I2SUdn5m4ox716tbiH6MML7jv6"] }`
   */
  identities: Record<string, string[]>;

  /**
   * The ID of the provider used to sign in the user.
   *
   * @remarks
   * Examples: `"anonymous"`, `"password"`, `"facebook.com"`, `"github.com"`,
   * `"google.com"`, `"twitter.com"`, `"apple.com"`, `"microsoft.com"`,
   * `"yahoo.com"`, `"phone"`, `"playgames.google.com"`, `"gc.apple.com"`, `"custom"`.
   * Identity Platform may include `"linkedin.com"`, SAML (`"saml.*"`) and OIDC (`"oidc.*"`) providers.
   */
  sign_in_provider: string;

  /**
   * The second-factor type (e.g., `"phone"`) when the user is multi-factor authenticated.
   */
  sign_in_second_factor?: string;

  /**
   * The `uid` of the second factor used to sign in.
   */
  second_factor_identifier?: string;

  /**
   * The tenant ID the user belongs to, if any.
   */
  tenant?: string;

  /** Additional provider-specific fields (extensible). */
  [key: string]: unknown;
}

/**
 * Static identity template registered with an auth provider (e.g., `AuthManager`).
 *
 * @remarks
 * This is not a raw JWT; rather, it represents the claims & profile that will be used
 * to construct `DecodedIdToken`/`AuthData` for requests.
 */
export interface MockIdentity {
  /** User email, if available. */
  email?: string;

  /** Whether the email is verified. */
  email_verified?: boolean;

  /**
   * Authentication provider metadata under the reserved `firebase` claim.
   */
  firebase: FirebaseIdentities;

  /**
   * Issuer of the token (e.g., `https://securetoken.google.com/<PROJECT_NUMBER>`).
   *
   * @remarks
   * Typically matches the project associated with the `aud` claim.
   */
  iss: string;

  /** Phone number, if available. */
  phone_number?: string;

  /** Photo URL, if available. */
  picture?: string;

  /**
   * The user’s UID (convenience mirror of the `sub` claim).
   *
   * @remarks
   * This is not literally present in raw JWT claims; it is provided as a convenience
   * and should mirror `sub`.
   */
  uid: string;

  /** Additional arbitrary claims or profile fields. */
  [key: string]: unknown;
}

/**
 * Remove index signatures from a type so named properties remain visible and strongly typed.
 *
 * @remarks
 * Interfaces with index signatures (e.g., `[key: string]: unknown`) can cause mapped types
 * (`Partial<T>`, `Omit<T, K>`) to degrade IntelliSense for explicit properties. This utility
 * filters out index signatures, preserving declared keys.
 *
 * @typeParam T - The source type from which to strip index signatures.
 *
 * @example
 * ```ts
 * // Without stripping, IntelliSense may hide named props due to `[key: string]: unknown`.
 * type Clean = Partial<StripIndexSignature<Omit<MockIdentity, 'firebase'>>>;
 * ```
 */
type StripIndexSignature<T> = {
  [K in keyof T as K extends string
    ? string extends K
      ? never
      : K
    : K extends number
    ? number extends K
      ? never
      : K
    : K extends symbol
    ? symbol extends K
      ? never
      : K
    : never]: T[K];
};

export type AutoProvider =
  | 'google'
  | 'microsoft'
  | 'apple'
  | 'twitter'
  | 'github'
  | 'facebook'
  | 'yahoo'
  | 'playgames'
  | 'gamecenter'
  | 'phone'
  | 'password'
  | 'custom'
  | 'anonymous';

/**
 * Lightweight constructor type for registering identities.
 *
 * @remarks
 * - Accepts a partial subset of {@link MockIdentity} (without the `firebase` block).
 * - Allows a partial {@link FirebaseIdentities} via the `firebase` property.
 * - Additional arbitrary claims are permitted.
 */
export interface IdentityConstructor
  extends Partial<Omit<StripIndexSignature<MockIdentity>, 'firebase'>> {
  /** Partial `firebase` provider metadata; missing fields are normalized by the provider. */
  firebase?: Partial<FirebaseIdentities>;
  /** The sign-in provider data to synthesize. Defaults to 'password'. */
  signInProvider?: AutoProvider;
  /** Additional arbitrary claims included in the ID token. */
  claims?: Record<string, unknown>;
}

/**
 * Constructor shape for building an App Check token in tests.
 *
 * @remarks
 * Missing fields are defaulted by the provider (e.g., `AuthManager.appCheck()`).
 */
export interface AppCheckConstructor {
  /**
   * Expiration time (seconds since Unix epoch, or `Date`).
   */
  exp?: Date | number;

  /**
   * Issued-at time (seconds since Unix epoch, or `Date`).
   */
  iat?: Date | number;

  /** Additional arbitrary properties (extensible). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * The App Check data exposed to callable handlers in v1/v2.
 */
export interface AppCheckData {
  /**
   * The Firebase App ID attested by the App Check token.
   */
  appId: string;

  /**
   * The decoded App Check token.
   */
  token: DecodedAppCheckToken;

  /**
   * Indicates if the token has already been consumed by the App Check service.
   *
   * @remarks
   * - `false`: first time seen; the service marks the token as consumed going forward.
   * - `true`: token was previously marked as consumed; consider extra precautions.
   */
  alreadyConsumed?: boolean;
}

/**
 * Version-agnostic authentication context bridged into v1/v2 request types.
 *
 * @remarks
 * Providers (e.g., `AuthManager`) generate this structure, and handlers transform
 * it into version-specific contexts (`CallableContext`, `CallableRequest`, etc.).
 */
export interface GenericAuthContext {
  /**
   * App Check payload, if present for the invocation.
   */
  app?: AppCheckData;
  /**
   * Firebase **project ID** (human-readable).
   */
  projectId: string;
  /**
   * Static identity template used to construct `AuthData`.
   */
  identity: MockIdentity;

  /**
   * Time (seconds since Unix epoch) when end-user authentication occurred for the session.
   *
   * @remarks
   * This is stable across token refreshes within the same session; see also {@link iat}.
   */
  auth_time: number;

  /**
   * ID token expiration time (seconds since Unix epoch).
   *
   * @remarks
   * Firebase SDKs refresh ID tokens transparently (typically hourly).
   */
  exp: number;

  /**
   * ID token issued-at time (seconds since Unix epoch).
   *
   * @remarks
   * Updates on refresh; for the initial sign-in time, use {@link auth_time}.
   */
  iat: number;
}

/**
 * Metadata about the authorization used to invoke a function.
 *
 * @remarks
 * Mirrors the shape surfaced in v1/v2 callables (`context.auth` / `request.auth`).
 */
export interface AuthData {
  /** The caller’s UID. */
  uid: string;

  /** The decoded ID token for the caller. */
  token: DecodedIdToken;
}

/**
 * Key type used to select a registered identity.
 *
 * @remarks
 * Often a string literal or enum value in tests; numbers are also supported.
 */
export type AuthKey = string | number;

/**
 * Options controlling how a {@link GenericAuthContext} is synthesized.
 *
 * @remarks
 * Use to override token timestamps or App Check behavior on a per-call basis.
 */
export interface AuthContextOptions {
  /**
   * Issued-at time for the ID token (seconds since epoch, or `Date`).
   * Defaults to `now()` if omitted.
   */
  iat?: number | Date;

  /**
   * Session authentication time (seconds since epoch, or `Date`).
   * Defaults to `iat - 30 minutes` if omitted.
   */
  authTime?: number | Date;

  /**
   * Expiration time for the ID token (seconds since epoch, or `Date`).
   * Defaults to `iat + 30 minutes` if omitted.
   */
  expires?: number | Date;

  /**
   * If `true`, omit App Check from the synthesized context.
   */
  suppressAppCheck?: boolean;

  /**
   * Seed values for constructing an App Check token;
   * missing fields are defaulted by the provider.
   */
  appCheck?: AppCheckConstructor;
}

/**
 * Contract for components that supply identities and synthesized auth contexts.
 *
 * @typeParam TKey - Registry key type used to look up identities.
 *
 * @remarks
 * Implemented by `AuthManager`; test code typically depends on this interface indirectly
 * via handlers/brokers. Returned values should be deep-cloned to avoid external mutation.
 */
export interface AuthProvider<TKey extends AuthKey> {
  /**
   * Retrieve a deep-cloned identity template by key.
   *
   * @returns The identity if registered; otherwise `undefined`.
   */
  identity(key: TKey): MockIdentity | undefined;

  /**
   * Build a generic auth context for the given identity key.
   *
   * @param key - Identity key.
   * @param options - Optional overrides for timestamps and App Check.
   * @returns A new {@link GenericAuthContext} suitable for v1/v2 adaptation.
   *
   * @throws {Error} Implementations may throw if the key is not registered.
   */
  context(key: TKey, options?: AuthContextOptions): GenericAuthContext;
}

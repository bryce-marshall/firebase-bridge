import { DecodedAppCheckToken } from 'firebase-admin/app-check';
import { DecodedIdToken } from 'firebase-admin/auth';
import { Undefinedify } from './_internal/util.js';

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

/**
 * Canonical shortcut names for sign-in providers that the mock can synthesize.
 *
 * @remarks
 * - `'custom'` → use when you want the identity to represent a custom-token
 *   sign-in (i.e. not backed by a first-party provider).
 * - `'anonymous'` → use when you want an anonymous sign-in with no provider
 *   identities attached.
 */
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
 * This is deliberately more permissive than {@link MockIdentity}:
 *
 * - You can provide any subset of the explicit `MockIdentity` properties
 *   **except** the `firebase` block (that stays normalized by the provider).
 * - You may provide a **partial** {@link FirebaseIdentities} in `firebase`,
 *   which will be completed/normalized (for example, sign-in provider,
 *   identities bucket) by the auth provider.
 * - You may provide arbitrary additional claims via `claims`; these are
 *   merged onto the resulting {@link MockIdentity} so tests can emulate
 *   custom claims / multi-tenant / role flags.
 */
export interface IdentityConstructor
  extends Partial<Omit<StripIndexSignature<MockIdentity>, 'firebase'>> {
  /**
   * Partial `firebase` provider metadata; any missing fields are filled by
   * the provider (for example, inferred `sign_in_provider` and per-provider
   * identity buckets).
   */
  firebase?: Partial<FirebaseIdentities>;

  /**
   * The sign-in provider to synthesize if one is not already present in
   * `firebase.sign_in_provider`.
   *
   * @remarks
   * This accepts simplified aliases (e.g. `'google'`, `'apple'`) which are
   * later normalized to canonical Firebase provider IDs (e.g. `'google.com'`).
   * Defaults to `'password'` for convenience if neither this nor a
   * provider-id in `firebase` is supplied.
   */
  signInProvider?: AutoProvider;

  /**
   * Additional arbitrary claims to materialize on the final identity.
   *
   * @remarks
   * These are copied onto the resulting {@link MockIdentity} after
   * normalization so you can model custom/tenant/role claims in tests.
   */
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

  /**
   * Indicates whether this token was already consumed. Defaults to `false`.
   *
   * @remarks
   * If this is the first time {@link AppCheck.verifyToken} has seen this token,
   * this flag is `false` and the service will mark it as consumed for future calls.
   * If `true`, the caller is attempting to reuse a previously consumed token.
   * Consider taking additional precautions (rejecting the request, extra checks, etc.).
   */
  alreadyConsumed?: boolean;

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
 * Portion of the request context that describes the Firebase application
 * making the call.
 *
 * @remarks
 * This part is always present, regardless of whether the caller is
 * authenticated. It carries the human-readable project ID and, when present,
 * the App Check payload attached to the invocation.
 */
interface RequestAppPart {
  /**
   * Firebase **project ID** (human-readable) that the mock request is being
   * executed against.
   */
  projectId: string;

  /**
   * App Check payload, if present for the invocation.
   *
   * @remarks
   * This is synthesized by the mock provider (for example, {@link AuthManager})
   * and mirrors what callable/HTTP handlers receive in Firebase Functions.
   */
  app?: AppCheckData;
}

/**
 * Portion of the request context that exists only when the caller is
 * authenticated.
 *
 * @remarks
 * These are the time-based claims and identity template used to build the
 * version-specific auth objects (`context.auth`, `request.auth`, etc.).
 * In the authenticated case, all of these are concrete; in the unauthenticated
 * case we deliberately replace them with `undefined` via
 * {@link Undefinedify<RequestIdentityPart>} to preserve shape but signal
 * absence.
 */
interface RequestIdentityPart {
  /**
   * Static identity template used to construct `DecodedIdToken`/`AuthData`
   * for the call.
   *
   * @remarks
   * This is **not** a raw JWT — it is the normalized identity stored in the
   * mock registry (for example, by {@link AuthManager.register}).
   */
  identity: MockIdentity;

  /**
   * Time (seconds since Unix epoch) when end-user authentication occurred
   * for the session.
   *
   * @remarks
   * This remains stable across token refreshes within a single session.
   * See also {@link iat} for the per-token issuance time.
   */
  auth_time: number;

  /**
   * ID token expiration time (seconds since Unix epoch).
   *
   * @remarks
   * Firebase SDKs refresh ID tokens transparently (typically hourly) — this
   * mirrors that behavior in tests.
   */
  exp: number;

  /**
   * ID token issued-at time (seconds since Unix epoch).
   *
   * @remarks
   * This updates on refresh. For the original login time, use {@link auth_time}.
   */
  iat: number;
}

/**
 * Request context for calls that do **not** provide an authenticated identity.
 *
 * @remarks
 * - Always contains the application part ({@link RequestAppPart}).
 * - Contains the **shape** of {@link RequestIdentityPart}, but all of its
 *   properties are forced to `undefined` via {@link Undefinedify}, so your
 *   downstream logic can safely narrow on the presence/absence of identity
 *   fields without optional-chaining everything.
 * - This mirrors Firebase Functions’ behavior where `context.auth` /
 *   `request.auth` is absent for unauthenticated invocations, but keeps the
 *   TypeScript shape stable across authenticated/unauthenticated branches.
 */
export interface UnauthenticatedRequestContext
  extends RequestAppPart,
    Undefinedify<RequestIdentityPart> {}

/**
 * Version-agnostic authentication context for **authenticated** requests.
 *
 * @remarks
 * This is the concrete form produced when a key is provided to the provider
 * (for example, {@link AuthManager.context} with `options.key`):
 *
 * - It always has the app part ({@link RequestAppPart})
 * - It always has the identity part ({@link RequestIdentityPart})
 * - Times (`iat`, `auth_time`, `exp`) are already normalized
 *
 * Handlers (v1 **and** v2) take this structure and map it to
 * `CallableContext`, `CallableRequest`, or express-style request extensions.
 */
export interface AuthenticatedRequestContext
  extends RequestAppPart,
    RequestIdentityPart {}

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
 * Options controlling how a {@link AuthenticatedRequestContext} or
 * {@link UnauthenticatedRequestContext} is synthesized for a single call.
 *
 * @typeParam TKey - Registry key type used to look up identities.
 *
 * @remarks
 * - If `key` is provided, an **authenticated** context is produced.
 * - If `key` is omitted, an **unauthenticated** context is produced, but the
 *   app part and (optionally) App Check are still present.
 * - Time values accept either epoch-seconds or `Date` and are normalized.
 */
export interface AuthContextOptions<TKey extends AuthKey = AuthKey> {
  /**
   * Identity registry key used to resolve the identity from the provider
   * (for example, {@link AuthManager}).
   *
   * @remarks
   * Omit this to generate an unauthenticated context.
   */
  key?: TKey;

  /**
   * Issued-at time for the ID token.
   *
   * @remarks
   * - Accepts seconds since epoch or a `Date`.
   * - Defaults to `now()` when omitted.
   * - Ignored when `key` is not provided (i.e. unauthenticated).
   */
  iat?: number | Date;

  /**
   * Session authentication time.
   *
   * @remarks
   * - Accepts seconds since epoch or a `Date`.
   * - Defaults to `iat - 30 minutes` when omitted.
   * - Ignored when `key` is not provided.
   */
  authTime?: number | Date;

  /**
   * Expiration time for the ID token.
   *
   * @remarks
   * - Accepts seconds since epoch or a `Date`.
   * - Defaults to `iat + 30 minutes` when omitted.
   * - Ignored when `key` is not provided.
   */
  expires?: number | Date;

  /**
   * Per-invocation App Check override.
   *
   * @remarks
   * - `true` or omitted → synthesize a default App Check token.
   * - `false` → omit App Check entirely.
   * - object → use the provided {@link AppCheckConstructor} as a seed and
   *   normalize missing fields.
   */
  appCheck?: AppCheckConstructor | boolean;
}

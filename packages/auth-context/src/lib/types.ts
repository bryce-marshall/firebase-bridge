import { DecodedAppCheckToken } from 'firebase-admin/app-check';
import { DecodedIdToken } from 'firebase-admin/auth';
import { Undefinedify } from './_internal/types.js';

export type AuthDateConstructor = Date | number | string;

/**
 * Authentication provider metadata embedded inside ID tokens under the
 * reserved `firebase` claim.
 *
 * @remarks
 * Mirrors common fields exposed by Firebase Authentication and Identity Platform.
 * This structure is attached to {@link MockIdentity.firebase}.
 */
export interface FirebaseIdentities {
  /**
   * Provider-specific identity details keyed by provider.
   *
   * @remarks
   * Keys are provider IDs such as `"email"`, `"phone"`, `"google.com"`,
   * `"github.com"`, etc. Values are arrays of provider-specific identifiers
   * (for example, provider UIDs or email addresses).
   *
   * @example
   * ```ts
   * {
   *   "email": ["alice@gmail.com"],
   *   "google.com": ["24I2SUdn5m4ox716tbiH6MML7jv6"]
   * }
   * ```
   */
  identities: Record<string, string[]>;

  /**
   * The ID of the provider used to sign in the user.
   *
   * @remarks
   * Examples:
   * - `"anonymous"`
   * - `"password"`
   * - `"phone"`
   * - `"facebook.com"`
   * - `"github.com"`
   * - `"google.com"`
   * - `"twitter.com"`
   * - `"apple.com"`
   * - `"microsoft.com"`
   * - `"yahoo.com"`
   * - `"playgames.google.com"`
   * - `"gc.apple.com"`
   * - `"custom"` (for custom-token sign-ins).
   *
   * Identity Platform may additionally include `"linkedin.com"`, SAML
   * providers (`"saml.*"`) and OIDC providers (`"oidc.*"`).
   */
  sign_in_provider: string;

  /**
   * The second-factor type when the user is multi-factor authenticated.
   *
   * @remarks
   * Typically `"phone"` for SMS second factors or `"totp"` for TOTP factors.
   */
  sign_in_second_factor?: string;

  /**
   * The `uid` of the second factor used to sign in.
   *
   * @remarks
   * Mirrors the MFA enrollment identifier for the factor that satisfied
   * the second-factor challenge.
   */
  second_factor_identifier?: string;

  /**
   * The tenant ID the user belongs to, if any.
   */
  tenant?: string;

  /**
   * Additional provider-specific fields (extensible).
   *
   * @remarks
   * This allows the mock to attach extra Firebase/Identity-Platform-specific
   * values if needed without changing the core interface.
   */
  [key: string]: unknown;
}

/**
 * The identity template constructed for an authentication context.
 *
 * @remarks
 * This is **not** a raw JWT; rather, it represents the claims and profile that
 * will be used to construct `DecodedIdToken`/`AuthData` for requests.
 *
 * Instances of this type are produced by {@link AuthManager.identity} and
 * embedded into the request context as part of {@link RequestIdentityPart}.
 */
export interface MockIdentity {
  /** User display name, if available. */
  name?: string;
  /** User email, if available. */
  email?: string;

  /** Whether the email is verified. */
  email_verified?: boolean;

  /**
   * Authentication provider metadata under the reserved `firebase` claim.
   */
  firebase: FirebaseIdentities;

  /**
   * Issuer of the token (for example, `https://securetoken.google.com/<PROJECT_NUMBER>`).
   *
   * @remarks
   * Typically matches the project associated with the `aud` claim. For identities
   * synthesized by {@link AuthManager}, this is derived from the manager’s
   * configured project number.
   */
  iss: string;

  /** Phone number, if available. */
  phone_number?: string;

  /** Photo URL, if available. */
  photo_url?: string;

  /**
   * The user’s UID (convenience mirror of the `sub` claim).
   *
   * @remarks
   * This property is not literally present in raw JWT claims in production;
   * it is provided as a convenience and should mirror the `sub` claim value.
   */
  uid: string;

  /**
   * Additional arbitrary claims or profile fields.
   *
   * @remarks
   * Custom claims added via {@link IdentityConstructor.customClaims} are
   * materialized here so tests can model tenant/role/domain-specific data.
   */
  [key: string]: unknown;
}

/**
 * Canonical shortcut names for sign-in providers that the mock can synthesize.
 *
 * @remarks
 * These are mapped to actual provider IDs (for example, `'google'`
 * → `"google.com"`) by {@link SignInProvider}.
 *
 * - `'custom'` → use when you want the identity to represent a custom-token
 *   sign-in (i.e. not backed by a first-party provider).
 * - `'anonymous'` → use when you want an anonymous sign-in with no provider
 *   identities attached.
 */
export type SignInProviderType =
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
 * Supported multi-factor provider identifiers.
 *
 * @remarks
 * These correspond to the `factorId` used for MFA enrollments and sign-in.
 */
export type MultiFactorIdentifier = 'phone' | 'totp';

/**
 * Lightweight constructor shape for multi-factor information.
 *
 * @remarks
 * This mirrors the core fields required to build an `IMultiFactorInfo`
 * in the backing `AuthInstance`.
 */
export interface MultiFactorConstructor {
  /**
   * The type identifier of the second factor.
   *
   * @remarks
   * - For SMS second factors, this is `'phone'`.
   * - For TOTP second factors, this is `'totp'`.
   */
  factorId: MultiFactorIdentifier;

  /**
   * The ID of the enrolled second factor.
   *
   * @remarks
   * This ID is unique to the user. If omitted, a synthetic ID is generated.
   */
  uid?: string;

  /**
   * The optional display name of the enrolled second factor.
   */
  displayName?: string;

  /**
   * The date the second factor was enrolled.
   *
   * @remarks
   * Accepts a `Date` instance, seconds from the Unix epoch, or a UTC string.
   * Values are normalized internally to a `Date`.
   */
  enrollmentTime?: AuthDateConstructor;
}

/**
 * Multi-factor constructor shape specific to phone (SMS) factors.
 *
 * @remarks
 * Extends {@link MultiFactorConstructor} with an optional `phoneNumber`.
 */
export interface PhoneMultiFactorContructor extends MultiFactorConstructor {
  factorId: 'phone';

  /**
   * The phone number associated with the SMS second factor, if known.
   */
  phoneNumber?: string;
}

/**
 * Minimal user profile properties used when synthesizing providers or identities.
 *
 * @remarks
 * These fields align with the core `UserRecord` properties in the Admin SDK.
 */
export interface UserConstructor {
  /**
   * The user identifier.
   *
   * @remarks
   * If not specified, a Firebase-style UID is auto-generated.
   */
  uid?: string;

  /**
   * The user display name.
   */
  displayName?: string;

  /**
   * The user email.
   */
  email?: string;

  /**
   * The user phone number.
   */
  phoneNumber?: string;

  /**
   * The user photo URL.
   */
  photoURL?: string;
}

export interface MetadataConstructor {
  /**
   * The date the user was created, formatted as a UTC string.
   */
  creationTime?: AuthDateConstructor;
  /**
   * The date the user last signed in, formatted as a UTC string.
   */
  lastSignInTime?: AuthDateConstructor;
  /**
   * The time at which the user was last active (ID token refreshed),
   * formatted as a UTC Date string (eg 'Sat, 03 Feb 2001 04:05:06 GMT').
   * Returns null if the user was never active.
   */
  lastRefreshTime?: AuthDateConstructor | null;
}

/**
 * Lightweight constructor type for registering identities with {@link AuthManager}.
 *
 * @remarks
 * This describes the minimal input needed to synthesize a rich `AuthInstance`
 * used to back tokens and request contexts.
 */
export interface IdentityConstructor extends UserConstructor {
  /**
   * Whether the identity is disabled.
   *
   * @remarks
   * Disabled identities cannot be used to generate authenticated contexts and
   * will cause {@link AuthManager.identity} to throw.
   */
  disabled?: boolean;

  metadata?: MetadataConstructor;

  /**
   * Whether the user’s email is verified.
   */
  emailVerified?: boolean;

  /**
   * Tenant ID associated with this identity.
   *
   * @remarks
   * This is surfaced via `firebase.tenant` on {@link MockIdentity}.
   */
  tenantId?: string;

  /**
   * One or more sign-in providers associated with the identity.
   *
   * @remarks
   * Values are created using {@link SignInProvider} helpers. Provider metadata
   * is used to populate identity defaults (email, phone, etc.) unless
   * {@link suppressProviderDefaults} is set.
   */
  providers?: SignInProvider[] | SignInProvider;

  /**
   * Multi-factor enrollments attached to this identity.
   *
   * @remarks
   * Each entry corresponds to an MFA enrollment; these can later be selected
   * via {@link IdentityOptions.multifactorSelector}.
   */
  multiFactorEnrollments?: MultiFactorConstructor | MultiFactorConstructor[];

  /**
   * If specified, will automatically apply multi-factor authentication to
   * contexts generated for this identity, using the first multi-factor
   * enrollment of the specified type (or matching selector).
   */
  multiFactorDefault?: MultiFactorIdentifier | MultiFactorSelector;

  /**
   * If `true`, will not automatically populate the generated `AuthInstance`
   * with sign-in provider data specified in {@link providers}. Defaults to `false`.
   *
   * @remarks
   * Use this when you want full manual control over the identity fields
   * without provider-derived defaults.
   */
  suppressProviderDefaults?: boolean;

  /**
   * Additional arbitrary claims to materialize on the final identity.
   *
   * @remarks
   * These are copied onto the resulting {@link MockIdentity} after
   * normalization so you can model custom/tenant/role claims in tests.
   * Validation is performed by the internal `validatedCustomClaims` helper.
   */
  customClaims?: Record<string, unknown>;
}

/**
 * Constructor shape for building an App Check token in tests.
 *
 * @remarks
 * Missing fields are defaulted by the provider (for example, `AuthManager.appCheck()`).
 * Arbitrary additional properties are preserved and surfaced in the decoded token.
 */
export interface AppCheckConstructor {
  /**
   * Expiration time (seconds since Unix epoch, or `Date`).
   */
  exp?: AuthDateConstructor;

  /**
   * Issued-at time (seconds since Unix epoch, or `Date`).
   */
  iat?: AuthDateConstructor;

  /**
   * Indicates whether this token was already consumed. Defaults to `false`.
   *
   * @remarks
   * If this is the first time the mock verifies this token, this flag is
   * interpreted as `false` and the token is treated as fresh. When `true`,
   * the caller is attempting to reuse a previously consumed token; tests
   * can assert on this via {@link AppCheckData.alreadyConsumed}.
   */
  alreadyConsumed?: boolean;

  /**
   * Additional arbitrary properties (extensible).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * The App Check data exposed to callable handlers in v1/v2.
 *
 * @remarks
 * This mirrors the structure that Firebase Functions exposes in
 * `context.app` / `request.app` when App Check is enabled.
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
 * Selector for a specific multi-factor enrollment.
 *
 * @remarks
 * Used from {@link IdentityConstructor.multiFactorDefault} and
 * {@link IdentityOptions.multifactorSelector} to choose which enrollment
 * should be applied to a given context.
 */
export interface MultiFactorSelector {
  /**
   * The type identifier of the second factor.
   *
   * @remarks
   * - For SMS second factors, this is `'phone'`.
   * - For TOTP second factors, this is `'totp'`.
   */
  factorId?: MultiFactorIdentifier;

  /**
   * The ID of the enrolled second factor. This ID is unique to the user.
   */
  uid?: string;
}

/**
 * Key type used to select a registered identity.
 *
 * @remarks
 * Often a string literal or enum value in tests; numbers are also supported.
 */
export type AuthKey = string | number;

/**
 * Per-call options relating to provider selection and multi-factor behavior.
 *
 * @remarks
 * These options are used both when constructing new identities and when
 * generating request contexts via {@link AuthManager.context}.
 */
export interface IdentityOptions {
  /**
   * The sign-in provider to use.
   *
   * @remarks
   * If not specified, defaults to the first `providerId` discovered in the
   * underlying `AuthInstance` or `'anonymous'` if none are defined.
   *
   * Values should generally correspond to the provider IDs encoded in
   * {@link FirebaseIdentities.sign_in_provider}, such as `"google.com"`,
   * `"password"`, `"phone"`, etc.
   */
  signInProvider?: string;

  /**
   * If specified, the multi-factor authentication to apply.
   *
   * @remarks
   * Has no effect if the associated identity has no multi-factor enrollments.
   * When provided, the mock will attempt to resolve a matching enrollment and
   * populate {@link FirebaseIdentities.sign_in_second_factor} and
   * {@link FirebaseIdentities.second_factor_identifier}.
   */
  multifactorSelector?: MultiFactorIdentifier | MultiFactorSelector;
}

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
export interface AuthContextOptions<TKey extends AuthKey = AuthKey>
  extends IdentityOptions {
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
  iat?: AuthDateConstructor;

  /**
   * Session authentication time.
   *
   * @remarks
   * - Accepts seconds since epoch or a `Date`.
   * - Defaults to `iat - 30 minutes` when omitted.
   * - Ignored when `key` is not provided.
   */
  authTime?: AuthDateConstructor;

  /**
   * Expiration time for the ID token.
   *
   * @remarks
   * - Accepts seconds since epoch or a `Date`.
   * - Defaults to `iat + 30 minutes` when omitted.
   * - Ignored when `key` is not provided.
   */
  expires?: AuthDateConstructor;

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

/**
 * Describes a sign-in provider used when building identities.
 *
 * @remarks
 * Instances are typically created using the static factory properties/methods
 * (for example, {@link SignInProvider.Google}, {@link SignInProvider.anonymous},
 * {@link SignInProvider.custom}).
 */
export class SignInProvider {
  /** Built-in Apple sign-in provider. */
  static readonly Apple = new SignInProvider('apple');

  /** Built-in Facebook sign-in provider. */
  static readonly Facebook = new SignInProvider('facebook');

  /** Built-in Game Center sign-in provider. */
  static readonly GameCenter = new SignInProvider('gamecenter');

  /** Built-in GitHub sign-in provider. */
  static readonly GitHub = new SignInProvider('github');

  /** Built-in Google sign-in provider. */
  static readonly Google = new SignInProvider('google');

  /** Built-in Microsoft sign-in provider. */
  static readonly Microsoft = new SignInProvider('microsoft');

  /** Built-in phone (SMS) sign-in provider. */
  static readonly Phone = new SignInProvider('phone');

  /** Built-in email/password sign-in provider. */
  static readonly Password = new SignInProvider('password');

  /** Built-in Play Games sign-in provider. */
  static readonly PlayGames = new SignInProvider('playgames');

  /** Built-in Twitter sign-in provider. */
  static readonly Twitter = new SignInProvider('twitter');

  /**
   * The sign-in provider ID (for example, `"google.com"` for the Google provider).
   */
  readonly signInProvider: string;

  private constructor(
    /**
     * Canonical shortcut type for this provider.
     */
    readonly type: SignInProviderType,
    signInProvider?: string,
    /**
     * Optional user profile seed used when synthesizing provider data.
     */
    readonly data?: UserConstructor
  ) {
    this.signInProvider = signInProvider ?? this.normalizedProvider();
  }

  /**
   * Return a new {@link SignInProvider} with the same type/providerId but
   * overridden user profile data.
   *
   * @remarks
   * For `'anonymous'` providers, this method is a no-op and returns the
   * existing instance.
   */
  override(data: UserConstructor): SignInProvider {
    if (this.type === 'anonymous') return this;

    return new SignInProvider(this.type, this.signInProvider, data);
  }

  /**
   * Create an anonymous sign-in provider with an optional fixed UID.
   *
   * @remarks
   * Anonymous providers do not contribute email/phone identities.
   */
  static anonymous(uid?: string): SignInProvider {
    return new SignInProvider('anonymous', undefined, { uid });
  }

  /**
   * Create a custom sign-in provider with an arbitrary provider ID.
   *
   * @remarks
   * - If `signInProvider` is `'anonymous'`, an anonymous provider is returned.
   * - Otherwise, the provider is tagged as `'custom'` and uses the given
   *   `signInProvider` string verbatim.
   */
  static custom(signInProvider: string, data: UserConstructor): SignInProvider {
    if (signInProvider === 'anonymous')
      return SignInProvider.anonymous(data.uid);

    return new SignInProvider('custom', signInProvider, data);
  }

  /**
   * Resolve a Firebase-style provider ID for this provider type.
   *
   * @remarks
   * For example:
   * - `'google'` → `"google.com"`
   * - `'apple'` → `"apple.com"`
   * - `'microsoft'` → `"microsoft.com"`
   * - `'phone'` → `"phone"`
   * - `'anonymous'` → `"anonymous"`
   */
  private normalizedProvider(): string {
    switch (this.type) {
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
      default:
        return this.type;
    }
  }
}

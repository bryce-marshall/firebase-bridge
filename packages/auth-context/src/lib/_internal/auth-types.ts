import {
  BaseAuth,
  EmailIdentifier,
  MultiFactorInfo,
  PhoneIdentifier,
  PhoneMultiFactorInfo,
  ProviderIdentifier,
  UidIdentifier,
  UserInfo,
  UserMetadata,
  UserRecord,
} from 'firebase-admin/auth';
import { MultiFactorIdentifier, MultiFactorSelector } from '../types.js';
import { MockedDataType } from './types.js';

/**
 * Internal representation of provider-specific user info stored in the mock.
 *
 * @remarks
 * This is a mutable, data-only version of {@link UserInfo} (via
 * {@link MockedDataType}), with `uid` and `providerId` required. It is used
 * as the value type for {@link AuthInstance.userInfo}, keyed by provider ID.
 */
export interface PersistedUserInfo extends Partial<MockedDataType<UserInfo>> {
  /**
   * Provider-specific UID for this user.
   */
  uid: string;

  /**
   * The provider ID associated with this set of user information.
   *
   * @remarks
   * Examples include `"google.com"`, `"password"`, `"phone"`, `"anonymous"`,
   * etc. This value is also used as the key in the {@link AuthInstance.userInfo}
   * map.
   */
  providerId: string;
}

/**
 * Internal, mutable representation of a user record in the mock auth store.
 *
 * @remarks
 * This type captures the data needed to emulate Firebase Authentication
 * behavior for user management and token verification. It is more permissive
 * (and more mutable) than the public {@link UserRecord}, and is the primary
 * internal shape managed by {@link InternalTenantManager} and related helpers.
 */
export interface AuthInstance {
  /**
   * The Firebase UID.
   */
  uid: string;

  /**
   * Whether the account is disabled.
   *
   * @remarks
   * When `true`, token verification operations (for example,
   * `verifyIdToken()` / `verifySessionCookie()`) will reject with
   * `auth/user-disabled` when this user is the subject.
   */
  disabled: boolean;

  /**
   * Provider-specific user information keyed by provider ID.
   *
   * @remarks
   * Each entry corresponds to a {@link PersistedUserInfo} for a particular
   * provider (for example, `"google.com"`, `"password"`, `"phone"`).
   */
  userInfo: Record<string, PersistedUserInfo>;

  /**
   * User metadata such as creation time and last sign-in time.
   */
  metadata: IUserMetadata;

  /**
   * The time, as an ISO string, after which tokens are considered valid.
   *
   * @remarks
   * Mirrors the semantics of `UserRecord.tokensValidAfterTime`. When set,
   * token verification routines will reject tokens whose `auth_time`/`iat`
   * precede this timestamp with `auth/id-token-revoked` or
   * `auth/session-cookie-revoked` (depending on context).
   */
  tokensValidAfterTime?: string;

  /** Phone number, if available. */
  phoneNumber?: string | null;

  /** Photo URL, if available. */
  photoURL?: string | null;

  /** User email, if available. */
  email?: string | null;

  /** Whether the email is verified. */
  emailVerified?: boolean;

  /**
   * The user's display name, if available.
   */
  displayName?: string | null;

  /**
   * The user's password hash, if set, encoded as a base64 string.
   *
   * @remarks
   * This is used only for fidelity in user import and is not intended for
   * real password verification.
   */
  passwordHash?: string | null;

  /**
   * The user's password salt, if set, encoded as a base64 string.
   */
  passwordSalt?: string | null;

  /**
   * Multi-factor enrollments associated with this user.
   *
   * @remarks
   * Each entry corresponds to an {@link IMultiFactorInfo}, typically created
   * from {@link MultiFactorConstructor} or {@link PhoneMultiFactorContructor}
   * definitions.
   */
  multiFactorInfo?: IMultiFactorInfo[];

  /**
   * Default multi-factor configuration for this user.
   *
   * @remarks
   * When present, this hints which enrollment should be used when simulating
   * multi-factor authentication for this identity. It can be a simple
   * factor type ({@link MultiFactorIdentifier}) or a more specific
   * {@link MultiFactorSelector}.
   */
  multiFactorDefault?: MultiFactorIdentifier | MultiFactorSelector;

  /**
   * The ID of the tenant the user belongs to, if available.
   *
   * @remarks
   * `null` or `undefined` indicates the default (non-tenant) context.
   */
  tenantId?: string | null;

  /**
   * Custom claims associated with the user.
   *
   * @remarks
   * These claims are validated (for forbidden/overlapping keys) by
   * `validatedCustomClaims()` before being stored and are surfaced as part
   * of decoded ID tokens returned by the mock.
   */
  claims?: Record<string, unknown>;
}

/**
 * Mock-friendly view of `firebase-admin/auth`'s {@link BaseAuth}.
 *
 * @remarks
 * This type uses {@link MockedDataType} to produce a mutable, data-only
 * representation of `BaseAuth` and then omits the internal
 * `verifyDecodedJWTNotRevokedOrDisabled` method, which is not needed for
 * the public mock surface.
 */
export type IAuth = Omit<
  MockedDataType<BaseAuth>,
  'verifyDecodedJWTNotRevokedOrDisabled'
>;

/**
 * Mock-friendly view of {@link UserRecord}.
 *
 * @remarks
 * Produced by applying {@link MockedDataType} to `UserRecord`, yielding a
 * mutable, data-only shape suited for fixtures and internal storage.
 */
export type IUserRecord = MockedDataType<UserRecord>;

/**
 * Mock-friendly view of {@link UserInfo}.
 *
 * @remarks
 * Used when constructing or inspecting provider-specific user data.
 */
export type IUserInfo = MockedDataType<UserInfo>;

/**
 * Mock-friendly view of {@link UserMetadata}.
 *
 * @remarks
 * Used as the concrete type for {@link AuthInstance.metadata}.
 */
export type IUserMetadata = MockedDataType<UserMetadata>;

/**
 * Mock-friendly view of {@link MultiFactorInfo}.
 *
 * @remarks
 * Represents a generic MFA enrollment (for example, phone or TOTP).
 */
export type IMultiFactorInfo = MockedDataType<MultiFactorInfo>;

/**
 * Mock-friendly view of {@link PhoneMultiFactorInfo}.
 *
 * @remarks
 * Represents a phone-based (SMS) MFA enrollment.
 */
export type IPhoneMultiFactorInfo = MockedDataType<PhoneMultiFactorInfo>;

/**
 * Composite identifier type used when resolving users by multiple criteria.
 *
 * @remarks
 * This mirrors the union of identifier types accepted by Admin SDK methods
 * such as `getUsers()`, combining:
 *
 * - {@link UidIdentifier}
 * - {@link EmailIdentifier}
 * - {@link PhoneIdentifier}
 * - {@link ProviderIdentifier}
 *
 * All properties are optional, and consumers pick the relevant subset based
 * on the lookup they wish to perform.
 */
export type PossibleIdentifier = Partial<
  UidIdentifier & EmailIdentifier & PhoneIdentifier & ProviderIdentifier
>;

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

export interface PersistedUserInfo extends Partial<MockedDataType<UserInfo>> {
  uid: string;
  providerId: string;
}

export interface AuthInstance {
  /**
   * The Firebase uid.
   */
  uid: string;
  /**
   * Whether the account is disabled.
   */
  disabled: boolean;
  userInfo: Record<string, PersistedUserInfo>;
  metadata: IUserMetadata;
  tokensValidAfterTime?: string;
  /** Phone number, if available. */
  phoneNumber?: string | null;
  /** Photo URL, if available. */
  photoURL?: string | null;
  /** User email, if available. */
  email?: string | null;
  /** Whether the email is verified. */
  emailVerified?: boolean;
  displayName?: string | null;
  passwordHash?: string | null;
  passwordSalt?: string | null;
  multiFactorInfo?: IMultiFactorInfo[];
  multiFactorDefault?: MultiFactorIdentifier | MultiFactorSelector;
  /**
   * The ID of the tenant the user belongs to, if available.
   */
  tenantId?: string | null;

  /**
   * Custom claims.
   */
  claims?: Record<string, unknown>;
}

export type IAuth = Omit<
  MockedDataType<BaseAuth>,
  'verifyDecodedJWTNotRevokedOrDisabled'
>;

export type IUserRecord = MockedDataType<UserRecord>;

export type IUserInfo = MockedDataType<UserInfo>;

export type IUserMetadata = MockedDataType<UserMetadata>;

export type IMultiFactorInfo = MockedDataType<MultiFactorInfo>;
export type IPhoneMultiFactorInfo = MockedDataType<PhoneMultiFactorInfo>;

export type PossibleIdentifier = Partial<
  UidIdentifier & EmailIdentifier & PhoneIdentifier & ProviderIdentifier
>;

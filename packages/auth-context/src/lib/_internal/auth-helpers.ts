import {
  MultiFactorInfo,
  UpdateMultiFactorInfoRequest,
  UserInfo,
  UserRecord,
} from 'firebase-admin/auth';
import {
  MultiFactorConstructor,
  MultiFactorIdentifier,
  MultiFactorSelector,
  PhoneMultiFactorContructor,
} from '../types.js';
import { authError } from './auth-error.js';
import {
  AuthInstance,
  IMultiFactorInfo,
  IPhoneMultiFactorInfo,
  IUserRecord,
} from './auth-types.js';
import {
  assignIf,
  cloneDeep,
  hexId,
  numericId,
  userId,
  utcDate,
} from './util.js';

type WithToJSON<T> = T & { toJSON(): object };

export function isValidUid(uid: string | null | undefined): boolean {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128;
}

/**
 * Claim keys that must NOT be used when setting custom user claims.
 *
 * @remarks
 * Includes:
 * - Standard JWT registered claims (RFC 7519)
 * - OpenID Connect standard claims
 * - Firebase-reserved claims
 * - Common identity provider fields
 */
const FORBIDDEN_CUSTOM_CLAIMS = new Set([
  // --- JWT registered claim names (RFC 7519) ---
  'iss', // issuer
  'sub', // subject (user_id)
  'aud', // audience
  'exp', // expiration time
  'nbf', // not before
  'iat', // issued at
  'jti', // JWT ID

  // --- Firebase-reserved claims ---
  'auth_time',
  'user_id',
  'uid',
  'firebase', // entire nested object (provider info, sign-in method)
  'sign_in_provider',
  'tenant_id',

  // // --- Common OIDC standard claims ---
  'name',
  // 'given_name',
  // 'family_name',
  // 'middle_name',
  // 'nickname',
  // 'preferred_username',
  // 'profile',
  // 'picture',
  // 'website',
  // 'email',
  // 'email_verified',
  // 'gender',
  // 'birthdate',
  // 'zoneinfo',
  // 'locale',
  // 'phone_number',
  // 'phone_number_verified',
  // 'address',
  // 'updated_at',

  // // --- Misc / identity provider overlap ---
  // 'provider_id',
  // 'claims',
  // 'custom_claims', // sometimes appears in management payloads
  // 'amr', // authentication methods reference
]);

export function validatedCustomClaims(
  claims: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!claims) return undefined;

  for (const key of Object.keys(claims)) {
    if (isForbiddenCustomClaim(key))
      throw authError(
        'invalid-claims',
        `The key "${key}" is reserved and cannot be used as a custom claim.`
      );
  }

  let json: string;
  try {
    json = JSON.stringify(claims);
  } catch {
    throw authError('invalid-claims');
  }

  if (json.length > 1000) {
    throw authError('claims-too-large');
  }

  return JSON.parse(json);
}

export function isForbiddenCustomClaim(key: string): boolean {
  return FORBIDDEN_CUSTOM_CLAIMS.has(key);
}

export function generateEmail(domain?: string): string {
  return `user-${hexId(6)}@${domain ?? 'example.com'}`;
}

export function generatePhoneNumber(country?: number) {
  // E.164 number
  return `+${country ?? 1}555${numericId(7)}`;
}

export function withToJSON<T>(value: T): WithToJSON<T> {
  (value as WithToJSON<T>).toJSON = () => cloneDeep(value as object);

  return value as WithToJSON<T>;
}

export function applyToJSON<T>(target: T | T[] | undefined): void {
  if (!target) return;
  if (Array.isArray(target)) {
    target.forEach((item) => {
      withToJSON(item);
    });
  } else {
    withToJSON(target);
  }
}

export type AuthInstancePredicate = (ai: AuthInstance) => boolean;

export function findUserRecord(
  store: Map<string, AuthInstance>,
  predicate: AuthInstancePredicate
): UserRecord | undefined {
  for (const ai of store.values()) {
    if (predicate(ai)) return toUserRecord(ai);
  }

  return undefined;
}

export function getUserRecord(
  uid: string,
  store: Map<string, AuthInstance>
): UserRecord | undefined {
  const ai = store.get(uid);

  return ai ? toUserRecord(ai) : undefined;
}

export function toUserRecord(ai: AuthInstance): UserRecord {
  const providerData = cloneDeep(Object.values(ai.userInfo)) as UserInfo[];
  applyToJSON(providerData);

  const ur: IUserRecord = {
    uid: ai.uid,
    disabled: ai.disabled,
    emailVerified: ai.emailVerified === true,
    metadata: withToJSON(cloneDeep(ai.metadata)),
    providerData,
  };
  if (ai.multiFactorInfo?.length) {
    ur.multiFactor = withToJSON({
      enrolledFactors: ai.multiFactorInfo.map((v) =>
        withToJSON(cloneDeep(v) as MultiFactorInfo)
      ),
    });
  }
  if (ai.claims && Object.entries(ai.claims).length) {
    ur.customClaims = cloneDeep(ai.claims);
  }

  assignIf(ur, 'email', ai.email);
  assignIf(ur, 'displayName', ai.displayName);
  assignIf(ur, 'photoURL', ai.photoURL);
  assignIf(ur, 'phoneNumber', ai.phoneNumber);
  assignIf(ur, 'passwordHash', ai.passwordHash);
  assignIf(ur, 'passwordSalt', ai.passwordSalt);
  assignIf(ur, 'tenantId', ai.tenantId);
  assignIf(ur, 'tokensValidAfterTime', ai.tokensValidAfterTime);

  return ur as UserRecord;
}

export function resolveSecondFactor(
  ai: AuthInstance,
  secondFactor: MultiFactorIdentifier | MultiFactorSelector | undefined
): IMultiFactorInfo | undefined {
  if (!ai.multiFactorInfo?.length) return undefined;

  if (!secondFactor) {
    secondFactor = ai.multiFactorDefault;
  }
  if (!secondFactor) return undefined;

  if (typeof secondFactor === 'string') {
    secondFactor = { factorId: secondFactor };
  }
  let result: IMultiFactorInfo | undefined;

  if (secondFactor.uid) {
    result = ai.multiFactorInfo.find((item) => item.uid === secondFactor.uid);
  } else if (secondFactor.factorId) {
    result = ai.multiFactorInfo.find(
      (item) => item.factorId === secondFactor.factorId
    );
  }

  return cloneDeep(result);
}

export function assignMultiFactors(
  ai: AuthInstance,
  enrollments:
    | MultiFactorConstructor[]
    | UpdateMultiFactorInfoRequest[]
    | null
    | undefined
): void {
  if (!enrollments?.length) return;

  for (const mfe of enrollments) {
    if (!mfe) continue;

    const mfi: IMultiFactorInfo = {
      factorId: mfe.factorId,
      uid: mfe.uid ?? userId(),
    };
    if (mfi.factorId === 'phone') {
      assignIf(
        mfi as IPhoneMultiFactorInfo,
        'phoneNumber',
        (mfe as PhoneMultiFactorContructor).phoneNumber
      );
    }
    assignIf(mfi, 'displayName', mfe.displayName);
    assignIf(
      mfi,
      'enrollmentTime',
      mfe.enrollmentTime ? utcDate(mfe.enrollmentTime) : undefined
    );
    (ai.multiFactorInfo ?? (ai.multiFactorInfo = [])).push(mfi);
  }
}

export function base64PasswordHash(password: string): string {
  return '';
}

export function base64PasswordSalt(): string {
  return '';
}

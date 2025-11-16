import { UserRecord } from 'firebase-admin/auth';
import { MultiFactorIdentifier, MultiFactorSelector } from '../types.js';
import { AuthInstance, IMultiFactorInfo, IUserRecord } from './auth-types.js';
import { cloneDeep, hexId, numericId } from './util.js';

type WithToJSON<T> = T & { toJSON(): object };

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
      throw new Error(
        `The key "${key}" is reserved and cannot be used as a custom claim.`
      );
  }

  return JSON.parse(JSON.stringify(claims));
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

export function getUserRecord(
  uid: string,
  store: Map<string, AuthInstance>
): UserRecord | undefined {
  const ai = store.get(uid);
  if (!ai) return undefined;

  // const metadata = 

  // const ur: IUserRecord = {
  //   uid: ai.uid,
  //   disabled: ai.disabled,
  //   emailVerified: ai.emailVerified === true,
    

  // }

  // applyToJSON(ur.multiFactor);
  // applyToJSON(ur.multiFactor?.enrolledFactors);
  // applyToJSON(ur.metadata);
  // applyToJSON(ur.providerData);

  // return withToJSON(ur);

  return undefined;
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

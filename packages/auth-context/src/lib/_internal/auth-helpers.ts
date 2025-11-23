import {
  MultiFactorInfo,
  UpdateMultiFactorInfoRequest,
  UserInfo,
  UserRecord,
} from 'firebase-admin/auth';
import { IdGenerator } from '../id-generator.js';
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
import { assignIf, cloneDeep, utcDate } from './util.js';

type WithToJSON<T> = T & { toJSON(): object };

/**
 * Determines whether a UID is valid according to Firebase Auth constraints.
 *
 * @remarks
 * A UID is considered valid when:
 * - It is a non-empty string
 * - Its length is at most 128 characters
 *
 * This mirrors the core UID validation used by Firebase Authentication.
 *
 * @param uid - UID to test for validity.
 * @returns `true` if the UID is valid; otherwise, `false`.
 */
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

/**
 * Validates and normalizes custom claims for a user.
 *
 * @remarks
 * This helper enforces several constraints on custom claims to mirror
 * Firebase Authentication behavior:
 *
 * - Rejects any claim whose key is listed in {@link FORBIDDEN_CUSTOM_CLAIMS}
 *   using the `auth/invalid-claims` error code.
 * - Ensures that the claims object is JSON-serializable.
 * - Enforces a maximum serialized size of 1000 characters, otherwise throws
 *   `auth/claims-too-large`.
 *
 * On success, a deep-cloned copy of the claims object is returned to prevent
 * accidental mutation of the original input.
 *
 * @param claims - Raw custom claims object supplied by the caller.
 * @returns A deep-cloned, validated claims object, or `undefined` if the input
 * is falsy.
 * @throws {@link FirebaseError} with codes `auth/invalid-claims` or
 * `auth/claims-too-large` when validation fails.
 */
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

/**
 * Tests whether a given custom-claim key is reserved/forbidden.
 *
 * @param key - Claim key to inspect.
 * @returns `true` if the key is reserved and must not be used in custom
 * claims; otherwise, `false`.
 */
export function isForbiddenCustomClaim(key: string): boolean {
  return FORBIDDEN_CUSTOM_CLAIMS.has(key);
}

/**
 * Generates a synthetic email address for test identities.
 *
 * @remarks
 * The local-part is randomized via a 6-hex ID. The domain defaults to
 * `"example.com"` when not explicitly provided.
 *
 * @param domain - Optional domain to use in the generated email.
 * @returns A realistic email address (for example, `"user-a1b2c3@example.com"`).
 */
export function generateEmail(domain?: string): string {
  return `user-${IdGenerator.hexId(6)}@${domain ?? 'example.com'}`;
}

/**
 * Generates a synthetic E.164-style phone number for test identities.
 *
 * @remarks
 * The generated value follows the pattern:
 * `+<country or 1>555<7 digit random number>`.
 *
 * @param country - Optional country code (numeric). Defaults to `1` (US/Canada).
 * @returns A phone number string in a plausible E.164 format.
 */
export function generatePhoneNumber(country?: number): string {
  // E.164 number
  return `+${country ?? 1}555${IdGenerator.numericId(7)}`;
}

/**
 * Attaches a `toJSON()` method to a value that returns a deep copy of the value.
 *
 * @remarks
 * Some Firebase Admin SDK classes (for example, {@link UserRecord}) expose
 * data primarily via `toJSON()`. When building mock equivalents, this helper
 * ensures the same behavior is available by:
 *
 * - Assigning a `toJSON` function that returns a deep clone of the object.
 * - Returning the value with the added `toJSON` method typed as {@link WithToJSON}.
 *
 * @typeParam T - Type of the value to decorate.
 * @param value - Value to which a `toJSON` method will be attached.
 * @returns The same value, now typed as {@link WithToJSON}, with a `toJSON()`
 * method returning a deep copy.
 */
export function withToJSON<T>(value: T): WithToJSON<T> {
  (value as WithToJSON<T>).toJSON = () => cloneDeep(value as object);

  return value as WithToJSON<T>;
}

/**
 * Recursively applies {@link withToJSON} to a value or array of values.
 *
 * @remarks
 * - If `target` is `undefined` or `null`, nothing is done.
 * - If `target` is an array, each element is decorated with `toJSON()`.
 * - Otherwise, the single value is decorated in-place.
 *
 * This is especially useful for collections such as `providerData` or
 * `multiFactor.enrolledFactors` that are expected to support `toJSON()`
 * in the Admin SDK.
 *
 * @typeParam T - Type of the target value(s).
 * @param target - A single value or array of values to decorate.
 */
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

/**
 * Predicate used to select matching {@link AuthInstance} entries.
 *
 * @remarks
 * This is used throughout the mock to implement lookup helpers that
 * search the in-memory auth store by arbitrary conditions.
 */
export type AuthInstancePredicate = (ai: AuthInstance) => boolean;

/**
 * Finds the first user record in a store that matches a predicate.
 *
 * @remarks
 * - Iterates over all {@link AuthInstance} values in the store.
 * - Returns the first match converted to a {@link UserRecord} via
 *   {@link toUserRecord}.
 *
 * @param store - A map of UID to {@link AuthInstance}.
 * @param predicate - Predicate used to test each entry.
 * @returns The first matching {@link UserRecord}, or `undefined` if no match
 * is found.
 */
export function findUserRecord(
  store: Map<string, AuthInstance>,
  predicate: AuthInstancePredicate
): UserRecord | undefined {
  for (const ai of store.values()) {
    if (predicate(ai)) return toUserRecord(ai);
  }

  return undefined;
}

/**
 * Retrieves a user record from the store by UID.
 *
 * @param uid - UID of the user to look up.
 * @param store - Map of UID to {@link AuthInstance}.
 * @returns The corresponding {@link UserRecord}, or `undefined` if the user
 * does not exist.
 */
export function getUserRecord(
  uid: string,
  store: Map<string, AuthInstance>
): UserRecord | undefined {
  const ai = store.get(uid);

  return ai ? toUserRecord(ai) : undefined;
}

/**
 * Converts an internal {@link AuthInstance} into a public {@link UserRecord}.
 *
 * @remarks
 * This function:
 *
 * - Deep clones and attaches `toJSON()` to metadata and provider data.
 * - Normalizes `emailVerified` to a boolean.
 * - Populates multi-factor enrollments on `userRecord.multiFactor.enrolledFactors`.
 * - Copies custom claims to `userRecord.customClaims` when present.
 * - Assigns core fields (email, displayName, photoURL, phoneNumber, etc.)
 *   using {@link assignIf} for optionality.
 *
 * The resulting object is cast to {@link UserRecord} but is backed by a
 * {@link IUserRecord} (mock-friendly mutable data type).
 *
 * @param ai - The internal auth instance to transform.
 * @returns A {@link UserRecord} mirroring what the Admin SDK would return.
 */
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

/**
 * Resolves a specific second-factor enrollment from an {@link AuthInstance}.
 *
 * @remarks
 * Resolution logic:
 *
 * 1. If `ai.multiFactorInfo` is empty or undefined → returns `undefined`.
 * 2. If `secondFactor` is not supplied, falls back to `ai.multiFactorDefault`.
 * 3. If still undefined, `undefined` is returned.
 * 4. If `secondFactor` is a string, it is treated as a `factorId`.
 * 5. If `secondFactor.uid` is present, matching is done by UID.
 * 6. Otherwise, if `secondFactor.factorId` is present, matching is done
 *    by factorId.
 *
 * A deep clone of the resolved {@link IMultiFactorInfo} is returned so
 * that callers may modify the result safely.
 *
 * @param ai - Auth instance containing multi-factor enrollments.
 * @param secondFactor - Selector specifying which enrollment to resolve.
 * @returns A cloned {@link IMultiFactorInfo} for the matching factor, or
 * `undefined` if no appropriate enrollment is found.
 */
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

/**
 * Populates an {@link AuthInstance}'s multi-factor enrollments.
 *
 * @remarks
 * This function normalizes the different multi-factor request shapes to the
 * internal {@link IMultiFactorInfo} representation:
 *
 * - Creates new factor entries for each item in `enrollments`.
 * - Generates a synthetic UID when one is not provided.
 * - For `factorId === 'phone'`, copies `phoneNumber` from
 *   {@link PhoneMultiFactorContructor}.
 * - Normalizes `enrollmentTime` using {@link utcDate}.
 *
 * Existing enrollments on `ai.multiFactorInfo` are preserved; new factors
 * are appended.
 *
 * @param ai - The auth instance to mutate.
 * @param enrollments - One or more multi-factor enrollment definitions,
 * or `null`/`undefined` to do nothing.
 */
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
      uid: mfe.uid ?? IdGenerator.firebaseUid(),
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

/**
 * Generates a synthetic, base64-like password hash for tests.
 *
 * @remarks
 * The supplied `password` is intentionally ignored; the returned hash is
 * a random 64-character base64-like string generated by {@link base64LikeId}.
 * This is sufficient for tests that only require a non-empty hash value.
 *
 * @param password - Ignored; present for API shape compatibility.
 * @returns A random 64-character base64-like string.
 */
export function base64PasswordHash(password: string): string {
  void password;
  return IdGenerator.base64LikeId(64);
}

/**
 * Generates a synthetic, base64-like password salt for tests.
 *
 * @remarks
 * The returned value is a random 16-character base64-like string generated
 * by {@link base64LikeId}.
 *
 * @returns A random 16-character base64-like string.
 */
export function base64PasswordSalt(): string {
  return IdGenerator.base64LikeId(16);
}

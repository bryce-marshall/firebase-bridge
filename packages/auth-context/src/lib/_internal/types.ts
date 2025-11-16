import {
  AuthContextOptions,
  AuthenticatedRequestContext,
  AuthKey,
  UnauthenticatedRequestContext,
} from '../types.js';

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
export type RemoveIndexSignature<T> = {
  [K in keyof T as string extends K
    ? never
    : number extends K
    ? never
    : symbol extends K
    ? never
    : K]: T[K];
};

/**
 * Make every key in T optional, but if it’s present,
 * its value must be exactly `undefined`.
 */
export type Undefinedify<T> = {
  [K in keyof T]?: undefined;
};

/**
 * Strips any decorator properties from a callable (`Function`) type.
 */
export type JustCallable<T> = T extends { (...args: infer A): infer R }
  ? (...args: A) => R
  : never;

/**
 * Extracts only the non-function (i.e. data) properties from a type.
 *
 * @typeParam T - The source type to filter.
 *
 * @remarks
 * This mapped type removes all keys whose values are assignable to `Function`,
 * leaving you with a shape that contains only data-bearing fields. This is
 * useful when working with class-like types (such as Firebase SDK types) where
 * you want a plain-object representation without instance methods.
 */
export type DataPropsOf<T> = {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  [K in keyof T as T[K] extends Function ? never : K]: T[K];
};

/**
 * Convenience type for creating a mock-friendly version of another type.
 *
 * @typeParam T - The source type to transform.
 *
 * @remarks
 * This type first removes all function members from `T` (via {@link DataPropsOf})
 * and then makes the remaining properties writable (via {@link Mutable}). The
 * result is a plain, assignable object shape that is easy to construct in tests
 * and mock frameworks, even when the original type was a class or had
 * `readonly` properties.
 *
 * This is useful for SDK- or library-provided types where you only care about
 * the data-bearing fields and want to avoid extra casting when building
 * fixtures.
 */
export type MockedDataType<T> = Mutable<DataPropsOf<T>>;

/**
 * Makes all properties of a type writable.
 *
 * @typeParam T - The source type to make mutable.
 *
 * @remarks
 * This is the inverse of `Readonly<T>`. It is handy in mock/testing code where
 * SDK types expose `readonly` fields but you need to assign to them when
 * constructing fixtures.
 */
export type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

export const DEFAULT_PROJECT_ID = 'default-project';
export const DEFAULT_REGION = 'nam5';
export const EPOCH_MINUTES_30 = 60 * 30;
export const EPOCH_MINUTES_60 = EPOCH_MINUTES_30 + EPOCH_MINUTES_30;
export const EPOCH_DAY = 60 * 60 * 24;

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
   * Build a generic auth context for the given identity key.
   *
   * @param key - Identity key.
   * @param options - Optional overrides for timestamps and App Check.
   * @returns A new {@link AuthenticatedRequestContext} suitable for v1/v2 adaptation.
   *
   * @throws {Error} Implementations may throw if the key is not registered.
   */
  context(
    options?: AuthContextOptions<TKey>
  ): UnauthenticatedRequestContext | AuthenticatedRequestContext;
}

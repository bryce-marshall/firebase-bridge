import { AuthContextOptions, AuthenticatedRequestContext, AuthKey, UnauthenticatedRequestContext } from "../types.js";

export const DEFAULT_PROJECT_ID = 'default-project';
export const DEFAULT_REGION = 'nam5';
export const EPOCH_MINUTES_30 = 60 * 30;
export const EPOCH_MINUTES_60 = EPOCH_MINUTES_30 + EPOCH_MINUTES_30;

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
  authContext(
    options?: AuthContextOptions<TKey>
  ): UnauthenticatedRequestContext | AuthenticatedRequestContext;
}

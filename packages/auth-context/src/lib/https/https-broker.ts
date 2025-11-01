import { AuthKey, AuthProvider } from '../types.js';
import { HttpsV1Handler } from './https-v1-handler.js';
import { HttpsV2Handler } from './https-v2-handler.js';

/**
 * Facade for invoking Firebase HTTPS functions (v1 & v2) with mocked auth/app contexts.
 *
 * @typeParam TKey - The identity key type used by the {@link AuthProvider}.
 *
 * @remarks
 * - Constructed with an {@link AuthProvider} (e.g., {@code AuthManager}) that supplies
 *   per-invocation auth contexts (and optional App Check) for HTTP/callable handlers.
 * - Exposes versioned handlers via {@link v1} and {@link v2} for explicit Cloud Functions API parity.
 * - Keeps version concerns separate so tests can target specific runtime semantics.
 *
 * @example
 * ```ts
 * // Arrange: create an AuthManager and register an identity
 * const auth = new AuthManager();
 * auth.register('alice', { uid: 'alice', email: 'alice@example.com' });
 *
 * // Create the broker and pick the API version you want to test
 * const https = auth.https(); // or: new HttpsBroker(auth)
 *
 * // v1 example (handler shape depends on your HttpsV1Handler API)
 * const res1 = await https.v1.invokeCallable('alice', myV1Callable, { data: { x: 1 } });
 *
 * // v2 example
 * const res2 = await https.v2.invokeCallable('alice', myV2Callable, { data: { y: 2 } });
 * ```
 */
export class HttpsBroker<TKey extends AuthKey> {
  /**
   * Cloud Functions **v1** HTTPS handler utilities bound to the provided {@link AuthProvider}.
   *
   * @remarks
   * Use this for testing v1 `https.onRequest` and `https.onCall` handlers with mocked auth contexts.
   * The exact invocation helpers are defined by {@link HttpsV1Handler}.
   */
  readonly v1: HttpsV1Handler<TKey>;

  /**
   * Cloud Functions **v2** HTTPS handler utilities bound to the provided {@link AuthProvider}.
   *
   * @remarks
   * Use this for testing v2 `https.onRequest` and `https.onCall` handlers with mocked auth contexts.
   * The exact invocation helpers are defined by {@link HttpsV2Handler}.
   */
  readonly v2: HttpsV2Handler<TKey>;

  /**
   * Create a new {@link HttpsBroker}.
   *
   * @param provider - An {@link AuthProvider} that supplies identities and contexts for requests.
   *
   * @remarks
   * The broker wires the same provider into both {@link v1} and {@link v2} handlers to ensure
   * consistent identity and App Check behavior across API versions.
   */
  constructor(provider: AuthProvider<TKey>) {
    this.v1 = new HttpsV1Handler(provider);
    this.v2 = new HttpsV2Handler(provider);
  }
}

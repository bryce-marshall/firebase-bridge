import { CallableRequest, HttpsFunction } from 'firebase-functions/v2/https';
import { JustCallable } from '../_internal/util.js';
import { CloudFunctionsParsedBody, MockHttpResponse } from '../http/types.js';
import { AuthKey } from '../types.js';
import { CallableFunctionRequest, RawHttpRequest } from './types.js';

/**
 * V2 callable handler shape (`https.onCall`) as invoked by tests.
 *
 * @typeParam TData - Payload type provided to the callable.
 * @typeParam TResponse - Response payload type returned by the callable.
 *
 * @remarks
 * - Matches the v2 signature: `(request: CallableRequest<TData>) => TResponse | Promise<TResponse>`.
 * - The request object includes `data`, `auth`, optional `app` (App Check), `rawRequest`,
 *   and `acceptsStreaming`.
 */
export type CallableHandlerV2<
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
  TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> = (request: CallableRequest<TData>) => Promise<TResponse> | TResponse;

export type RequestHandlerV2 = JustCallable<HttpsFunction>;

/**
 * Utilities to execute **Firebase Functions v2** HTTPS handlers with mocked auth/app contexts.
 *
 * @typeParam TKey - Registry key type used by the {@link AuthProvider}.
 *
 * @remarks
 * - Construct with an {@link AuthProvider} (e.g., `AuthManager`) that supplies identities and App Check tokens.
 * - Supports both `https.onRequest` (Express-like) and `https.onCall` (single-arg) handlers.
 * - Uses in-memory request/response mocks; no network or emulator is required.
 */
export interface HttpsV2Handler<TKey extends AuthKey> {
  /**
   * Invoke a v2 **`https.onRequest`** handler with a mocked request/response.
   *
   * @typeParam TData - Parsed body type for the HTTP request (if any).
   *
   * @param request - Describes target identity key, headers/body, and HTTP options.
   * @param handler - The v2 `HttpsFunction` to run (request/response style).
   * @returns A promise that resolves to the **mock response** after the handler finishes.
   *
   * @remarks
   * - Builds a mock `Request`/`Response` via {@link mockHttpRequest} / {@link mockHttpResponse}.
   * - Applies function metadata via {@link applyFunctionMeta}.
   * - Awaits the response lifecycle via {@link execAndAwaitResponse}; the returned
   *   {@link MockHttpResponse} is safe to inspect (status, headers, body) once the promise resolves.
   *
   * @example
   * ```ts
   * const v2 = new HttpsV2Handler(authProvider);
   * const res = await v2.onRequest(
   *   { key: 'alice', options: { method: 'POST', body: { ping: true } } },
   *   myV2OnRequest
   * );
   *
   * expect(res.statusCode).toBe(200);
   * // With node-mocks-http helpers, for example:
   * // expect(res._getJSONData()).toEqual({ ok: true });
   * ```
   */
  onRequest<TData extends CloudFunctionsParsedBody>(
    request: RawHttpRequest<TKey, TData>,
    handler: RequestHandlerV2
  ): Promise<MockHttpResponse>;

  /**
   * Invoke a v2 **`https.onCall`** handler with a synthesized {@link CallableRequest}.
   *
   * @typeParam TData - Callable request data type.
   * @typeParam TResponse - Callable response data type.
   *
   * @param request - Includes the identity key, optional headers, and `data` to pass to the callable.
   * @param handler - The v2 callable `(req) => result`.
   * @returns A promise resolving to the callable’s returned value.
   *
   * @remarks
   * - Obtains a {@link AuthenticatedRequestContext} from the provider for `request.key`.
   * - Converts it to a v2 {@link CallableRequest} via {@link toCallableRequest}, including:
   *   - `data` (from the test),
   *   - `auth` (derived from identity),
   *   - optional `app` (App Check),
   *   - `rawRequest` (mocked),
   *   - `acceptsStreaming` (set to `false` by default).
   * - Executes via {@link execPromise} to normalize sync/async returns.
   *
   * @example
   * ```ts
   * const res = await v2.onCall(
   *   { key: 'alice', data: { x: 1 } },
   *   myV2Callable
   * );
   * ```
   */
  onCall<
    TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
    TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
  >(
    request: CallableFunctionRequest<TKey, TData>,
    handler: CallableHandlerV2<TData, TResponse>
  ): Promise<TResponse>;

  /**
   * Run a **wrapped** v2 callable function previously produced by Firebase.
   *
   * @typeParam TData - Callable request data type.
   * @typeParam TResponse - Callable response data type.
   *
   * @param request - Includes the identity key, optional headers, and `data` to pass to the callable.
   * @param httpsFunction - The wrapped v2 `HttpsFunction` (callable form) to be invoked.
   * @returns A promise resolving to the callable’s returned value.
   *
   * @remarks
   * - v2 callables accept a single `CallableRequest<T>` argument; this method mirrors that path.
   * - Context generation mirrors {@link onCall}.
   * - Uses {@link execPromise} so sync throws are surfaced as rejected promises.
   *
   * @example
   * ```ts
   * const res = await v2.runCallable(
   *   { key: 'alice', data: { y: 2 } },
   *   wrappedV2Callable // e.g., functions.https.onCall(...)
   * );
   * ```
   */
  runCallable<
    TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
    TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
  >(
    request: CallableFunctionRequest<TKey, TData>,
    httpsFunction: HttpsFunction
  ): Promise<TResponse>;
}

import { HttpsFunction, Runnable } from 'firebase-functions/v1';
import { CallableContext } from 'firebase-functions/v1/https';
import { JustCallable } from '../_internal/types.js';
import { CloudFunctionsParsedBody, MockHttpResponse } from '../http/http-types.js';
import { AuthKey } from '../types.js';
import { CallableFunctionRequest, RawHttpRequest } from './https-types.js';

/**
 * V1 callable handler shape (`https.onCall`) as seen by test code.
 *
 * @typeParam TData - Payload type expected by the callable.
 * @typeParam TResponse - Response payload type returned by the callable.
 *
 * @remarks
 * - Matches the standard v1 signature `(data, context) => result`.
 * - The returned value may be synchronous or a `Promise`.
 */
export type CallableHandlerV1<
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
  TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> = (data: TData, context: CallableContext) => Promise<TResponse> | TResponse;

export type RequestHandlerV1 = JustCallable<HttpsFunction>;

/**
 * Utilities to execute **Firebase Functions v1** HTTPS handlers with mocked auth/app contexts.
 *
 * @typeParam TKey - Registry key type used by the {@link AuthProvider}.
 *
 * @remarks
 * - Constructed with an {@link AuthProvider} (e.g., `AuthManager`) that supplies
 *   identities and App Check tokens.
 * - Provides helpers for both `https.onRequest` and `https.onCall` shapes.
 * - Requests/responses are simulated using in-memory mocks; no network is used.
 */
export interface HttpsV1Handler<TKey extends AuthKey> {
  /**
   * Invoke a v1 **`https.onRequest`** handler with a mocked Express request/response.
   *
   * @typeParam TData - Parsed body type for the HTTP request (if any).
   *
   * @param request - Describes the target identity key, headers/body, and HTTP options.
   * @param handler - The v1 `HttpsFunction` to run.
   * @returns A promise that resolves to the **mock response** after the handler finishes.
   *
   * @remarks
   * - Builds a mock `Request`/`Response` pair using {@link mockHttpRequest} / {@link mockHttpResponse}.
   * - Applies function metadata (e.g., versioning/region hints) via {@link applyFunctionMeta}.
   * - Awaits the response lifecycle via {@link execAndAwaitResponse}; the returned
   *   {@link MockHttpResponse} is safe to inspect (status, headers, body) when the promise resolves.
   *
   * @example
   * ```ts
   * const broker = new HttpsV1Handler(authProvider);
   * const res = await broker.onRequest(
   *   { key: 'alice', options: { method: 'POST', body: { hello: 'world' } } },
   *   myV1OnRequestHandler
   * );
   *
   * expect(res.statusCode).toBe(200);
   * // If using node-mocks-http helpers:
   * // expect(res._getJSONData()).toEqual({ ok: true });
   * ```
   */
  onRequest<TData extends CloudFunctionsParsedBody>(
    request: RawHttpRequest<TKey, TData>,
    handler: RequestHandlerV1
  ): Promise<MockHttpResponse>;

  /**
   * Invoke a v1 **`https.onCall`** handler with synthesized auth/app context.
   *
   * @typeParam TData - Callable request data type.
   * @typeParam TResponse - Callable response data type.
   *
   * @param request - Includes the identity key, headers, and `data` to pass to the callable.
   * @param handler - The raw callable function `(data, context) => result`.
   * @returns A promise resolving to the callable's returned value.
   *
   * @remarks
   * - Obtains a {@link AuthenticatedRequestContext} from the provider for `request.key`.
   * - Converts it to a v1 {@link CallableContext} via {@link toCallableContext}, including:
   *   - `auth` (derived from the identity),
   *   - `rawRequest` (mocked), and
   *   - optional `app` (App Check), if present.
   * - Executes the handler via {@link execPromise} to normalize sync/async returns.
   *
   * @example
   * ```ts
   * const res = await broker.onCall(
   *   { key: 'alice', data: { x: 1 } },
   *   myV1Callable
   * );
   * ```
   */
  onCall<
    TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
    TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
  >(
    request: CallableFunctionRequest<TKey, TData>,
    handler: CallableHandlerV1<TData, TResponse>
  ): Promise<TResponse>;

  /**
   * Run a **wrapped** v1 callable (`HttpsFunction & Runnable`) previously produced by Firebase.
   *
   * @typeParam TData - Callable request data type.
   * @typeParam TResponse - Callable response data type.
   *
   * @param request - Includes the identity key, headers, and `data` to pass to the callable.
   * @param runnable - The wrapped callable exposing a `.run(data, context)` method.
   * @returns A promise resolving to the callable's returned value.
   *
   * @remarks
   * - Use when your tests have already bound/registered the Cloud Function and you want
   *   to exercise the **same runtime path** Firebase uses (i.e., `runnable.run`).
   * - Context generation mirrors {@link onCall}.
   *
   * @example
   * ```ts
   * const res = await broker.runCallable(
   *   { key: 'alice', data: { y: 2 } },
   *   wrappedV1Callable // e.g., functions.https.onCall(...);
   * );
   * ```
   */
  runCallable<
    TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
    TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
  >(
    request: CallableFunctionRequest<TKey, TData>,
    runnable: HttpsFunction & Runnable<TData>
  ): Promise<TResponse>;
}

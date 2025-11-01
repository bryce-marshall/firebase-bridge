import { HttpsFunction, Runnable } from 'firebase-functions/v1';
import { CallableContext, Request } from 'firebase-functions/v1/https';
import { cloneDeep, execPromise, JustCallable } from '../_internal/util.js';
import { buildAuthData, execAndAwaitResponse } from '../http/_internal/util.js';
import { mockHttpRequest } from '../http/mock-http-request.js';
import {
  mockHttpResponse,
  MockHttpResponse,
} from '../http/mock-http-response.js';
import { CloudFunctionsParsedBody, HttpRequestOptions } from '../http/types.js';
import {
  AuthData,
  AuthKey,
  AuthProvider,
  GenericAuthContext,
} from '../types.js';
import { CallableFunctionRequest, RawHttpRequest } from './types.js';
import { applyFunctionMeta } from './util.js';

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

// export type RequestHandlerV1 = (
//   req: Request,
//   resp: Response
// ) => void | Promise<void>;

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
export class HttpsV1Handler<TKey extends AuthKey> {
  /**
   * @param _provider - Supplies per-invocation auth/app context for a given key.
   */
  constructor(private readonly _provider: AuthProvider<TKey>) {}

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
  ): Promise<MockHttpResponse> {
    const context = toRequestContext(request);

    return execAndAwaitResponse<void>(
      () => handler(context.request, context.response),
      context.response
    ).then(() => context.response);
  }

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
   * - Obtains a {@link GenericAuthContext} from the provider for `request.key`.
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
  ): Promise<TResponse> {
    const context = this._provider.context(request.key);
    const nativeContext = toCallableContext(request, context);

    return execPromise(() => handler(request.data, nativeContext));
  }

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
  ): Promise<TResponse> {
    const context = this._provider.context(request.key);
    const nativeContext = toCallableContext(request, context);

    return execPromise(() => runnable.run(request.data, nativeContext));
  }
}

/**
 * Build a mock v1 HTTP request/response pair for `https.onRequest`.
 *
 * @internal
 *
 * @typeParam TKey - Registry key type.
 * @typeParam TData - Parsed body type for the HTTP request (if any).
 *
 * @param request - Raw HTTP request description including key and options.
 * @returns Object containing the mock `request` and `response`.
 *
 * @remarks
 * - Clones user‐provided `HttpRequestOptions` to avoid mutation.
 * - Applies function metadata via {@link applyFunctionMeta}.
 */
function toRequestContext<
  TKey extends AuthKey,
  TData extends CloudFunctionsParsedBody
>(
  request: RawHttpRequest<TKey, TData>
): {
  request: Request;
  response: MockHttpResponse;
} {
  const options: HttpRequestOptions = cloneDeep(request.options) ?? {};
  applyFunctionMeta(request, options, false);
  const rawRequest = mockHttpRequest(options);
  const response = mockHttpResponse();

  return { request: rawRequest, response };
}

/**
 * Convert a generic auth/app context to a v1 {@link CallableContext}.
 *
 * @internal
 *
 * @typeParam TKey - Registry key type.
 * @typeParam TData - Callable data type.
 *
 * @param request - Callable description (key, headers, data).
 * @param generic - Generic context produced by the {@link AuthProvider}.
 * @returns A v1 {@link CallableContext} containing `auth`, `rawRequest`, and optional `app`.
 *
 * @remarks
 * - `auth` is constructed from the identity via {@link buildAuthData}.
 * - `rawRequest` is mocked using provided headers (deep-cloned).
 * - When present in `generic`, App Check is attached as `app`.
 */
function toCallableContext<
  TKey extends AuthKey,
  TData extends CloudFunctionsParsedBody
>(
  request: CallableFunctionRequest<TKey, TData>,
  generic: GenericAuthContext
): CallableContext {
  const auth: AuthData = buildAuthData(generic);
  const headers = cloneDeep(request.headers) ?? {};
  const options: HttpRequestOptions = {
    headers,
  };
  applyFunctionMeta(request, options, true);
  const rawRequest = mockHttpRequest(options);

  const result: CallableContext = {
    auth,
    rawRequest,
  };

  if (generic.app) {
    result.app = generic.app;
  }

  return result;
}

import {
  CallableRequest,
  HttpsFunction,
  Request as V2Request,
} from 'firebase-functions/v2/https';
import { cloneDeep, execPromise, JustCallable } from '../_internal/util.js';
import { buildAuthData, execAndAwaitResponse } from '../http/_internal/util.js';
import { mockHttpRequest } from '../http/mock-http-request.js';
import {
  mockHttpResponse,
  MockHttpResponse,
} from '../http/mock-http-response.js';
import { CloudFunctionsParsedBody, HttpRequestOptions } from '../http/types.js';
import {
  AuthKey,
  AuthProvider,
  GenericAuthContext,
  RequestContext,
} from '../types.js';
import { CallableFunctionRequest, RawHttpRequest } from './types.js';
import { applyFunctionMeta } from './util.js';

interface RunnableV2<
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
  TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> {
  run(request: CallableRequest<TData>): Promise<TResponse> | TResponse;
}

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
export class HttpsV2Handler<TKey extends AuthKey> {
  /**
   * @param _provider - Supplies per-invocation auth/app context for a given key.
   */
  constructor(private readonly _provider: AuthProvider<TKey>) {}

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
    request: RawHttpRequest<TData>,
    handler: RequestHandlerV2
  ): Promise<MockHttpResponse> {
    const context = toRequestContext(request);

    return execAndAwaitResponse<void>(
      () => handler(context.request, context.response),
      context.response
    ).then(() => context.response);
  }

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
   * - Obtains a {@link GenericAuthContext} from the provider for `request.key`.
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
  ): Promise<TResponse> {
    const context = request.key
      ? this._provider.authContext(request.key, request)
      : this._provider.requestContext(request);
    const callableReq = toCallableRequest(request, context);

    return execPromise(() => handler(callableReq));
  }

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
  ): Promise<TResponse> {
    // v2 callable functions accept a single CallableRequest<T> argument.
    const generic = this._provider.requestContext(request);
    const callableReq = toCallableRequest(request, generic);

    return execPromise(() =>
      (httpsFunction as unknown as RunnableV2<TData, TResponse>).run(
        callableReq
      )
    );
  }
}

/**
 * Build a mock v2 HTTP request/response pair for `https.onRequest`.
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
 * - Clones user-provided {@link HttpRequestOptions} to avoid mutation.
 * - Applies function metadata via {@link applyFunctionMeta}.
 */
function toRequestContext<TData extends CloudFunctionsParsedBody>(
  request: RawHttpRequest<TData>
): {
  request: V2Request;
  response: MockHttpResponse;
} {
  const options: HttpRequestOptions = cloneDeep(request.options ?? {});
  applyFunctionMeta(request, options, /* onCallMode */ false);
  const rawRequest = mockHttpRequest(options);
  const response = mockHttpResponse();

  return { request: rawRequest as unknown as V2Request, response };
}

/**
 * Convert a generic auth/app context to a v2 {@link CallableRequest}.
 *
 * @internal
 *
 * @typeParam TKey - Registry key type.
 * @typeParam TData - Callable data type.
 *
 * @param request - Callable description (key, headers, data).
 * @param generic - Generic context produced by the {@link AuthProvider}.
 * @returns A v2 {@link CallableRequest} containing `data`, `auth`, optional `app`,
 *          a mocked `rawRequest`, and `acceptsStreaming: false`.
 *
 * @remarks
 * - `auth` is constructed from the identity via {@link buildAuthData}.
 * - `rawRequest` is mocked using provided headers (deep-cloned).
 * - `acceptsStreaming` is set to `false` by default. Handlers may safely call
 *   `response.sendChunk` (if your mock response supports it), but code that
 *   branches on `acceptsStreaming` should treat this as a non-streaming call.
 */
function toCallableRequest<
  TKey extends AuthKey,
  TData extends CloudFunctionsParsedBody
>(
  request: CallableFunctionRequest<TKey, TData>,
  generic: RequestContext | GenericAuthContext
): CallableRequest<TData> {
  // Build underlying raw request (Express-ish) with callable defaults
  const headers = cloneDeep(request.headers) ?? {};
  const options: HttpRequestOptions = { headers };
  applyFunctionMeta(request, options, /* onCallMode */ true);
  const rawRequest = mockHttpRequest(options); // kept internal; no need to expose if not part of v2 type

  // Auth / App are surfaced on request in v2
  const auth = buildAuthData(generic);
  const callableReq: CallableRequest<TData> = {
    data: request.data,
    auth,
    rawRequest,
    acceptsStreaming: false,
  };

  if (generic.app) {
    callableReq.app = generic.app;
  }

  return callableReq;
}

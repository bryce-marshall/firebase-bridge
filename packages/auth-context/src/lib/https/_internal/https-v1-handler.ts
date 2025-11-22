import { HttpsFunction, Runnable } from 'firebase-functions/v1';
import { CallableContext, Request } from 'firebase-functions/v1/https';
import { AuthProvider } from '../../_internal/types.js';
import { cloneDeep, execPromise } from '../../_internal/util.js';
import { mockHttpRequest } from '../../http/_internal/mock-http-request.js';
import { mockHttpResponse } from '../../http/_internal/mock-http-response.js';
import {
  CloudFunctionsParsedBody,
  HttpRequestOptions,
  MockHttpResponse,
} from '../../http/http-types.js';
import {
  AuthenticatedRequestContext,
  AuthKey,
  UnauthenticatedRequestContext,
} from '../../types.js';
import { CallableFunctionRequest, RawHttpRequest } from '../https-types.js';
import {
  CallableHandlerV1,
  HttpsV1Handler,
  RequestHandlerV1,
} from '../v1-types.js';
import { applyFunctionMeta } from './apply-function-meta.js';
import { buildAuthData, execAndAwaitResponse } from './util.js';

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
export class _HttpsV1Handler<TKey extends AuthKey>
  implements HttpsV1Handler<TKey>
{
  /**
   * @param _provider - Supplies per-invocation auth/app context for a given key.
   */
  constructor(private readonly _provider: AuthProvider<TKey>) {}

  onRequest<TData extends CloudFunctionsParsedBody>(
    request: RawHttpRequest<TKey, TData>,
    handler: RequestHandlerV1
  ): Promise<MockHttpResponse> {
    const generic = this._provider.context(request);
    const context = toRequestContext(request, generic);

    return execAndAwaitResponse<void>(
      () => handler(context.request, context.response),
      context.response
    ).then(() => context.response);
  }

  onCall<
    TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
    TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
  >(
    request: CallableFunctionRequest<TKey, TData>,
    handler: CallableHandlerV1<TData, TResponse>
  ): Promise<TResponse> {
    const context = this._provider.context(request);
    const nativeContext = toCallableContext(request, context);

    return execPromise(() => handler(request.data, nativeContext));
  }

  runCallable<
    TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
    TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
  >(
    request: CallableFunctionRequest<TKey, TData>,
    runnable: HttpsFunction & Runnable<TData>
  ): Promise<TResponse> {
    const context = this._provider.context(request);
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
  request: RawHttpRequest<TKey, TData>,
  generic: UnauthenticatedRequestContext | AuthenticatedRequestContext
): {
  request: Request;
  response: MockHttpResponse;
} {
  const options: HttpRequestOptions = cloneDeep(request.options) ?? {};
  const auth = buildAuthData(generic);
  applyFunctionMeta(request, options, {
    onCallMode: false,
    appCheck: generic.app?.token,
    id: auth?.token,
  });
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
  generic: UnauthenticatedRequestContext | AuthenticatedRequestContext
): CallableContext {
  const auth = buildAuthData(generic);
  const headers = cloneDeep(request.headers) ?? {};
  const options: HttpRequestOptions = {
    headers,
  };
  applyFunctionMeta(request, options, {
    onCallMode: true,
    appCheck: generic.app?.token,
    id: auth?.token,
  });
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

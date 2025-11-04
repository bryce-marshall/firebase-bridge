import {
  CallableRequest,
  HttpsFunction,
  Request as V2Request,
} from 'firebase-functions/v2/https';
import { AuthProvider } from '../../_internal/types.js';
import { cloneDeep, execPromise } from '../../_internal/util.js';
import { mockHttpRequest } from '../../http/_internal/mock-http-request.js';
import { mockHttpResponse } from '../../http/_internal/mock-http-response.js';
import {
  CloudFunctionsParsedBody,
  HttpRequestOptions,
  MockHttpResponse,
} from '../../http/types.js';
import {
  AuthenticatedRequestContext,
  AuthKey,
  UnauthenticatedRequestContext,
} from '../../types.js';
import { CallableFunctionRequest, RawHttpRequest } from '../types.js';
import {
  CallableHandlerV2,
  HttpsV2Handler,
  RequestHandlerV2,
} from '../v2-types.js';
import { applyFunctionMeta } from './apply-function-meta.js';
import { buildAuthData, execAndAwaitResponse } from './util.js';

interface RunnableV2<
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
  TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> {
  run(request: CallableRequest<TData>): Promise<TResponse> | TResponse;
}

export class _HttpsV2Handler<TKey extends AuthKey>
  implements HttpsV2Handler<TKey>
{
  /**
   * @param _provider - Supplies per-invocation auth/app context for a given key.
   */
  constructor(private readonly _provider: AuthProvider<TKey>) {}

  onRequest<TData extends CloudFunctionsParsedBody>(
    request: RawHttpRequest<TKey, TData>,
    handler: RequestHandlerV2
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
    handler: CallableHandlerV2<TData, TResponse>
  ): Promise<TResponse> {
    const context = this._provider.context(request);
    const callableReq = toCallableRequest(request, context);

    return execPromise(() => handler(callableReq));
  }

  runCallable<
    TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
    TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
  >(
    request: CallableFunctionRequest<TKey, TData>,
    httpsFunction: HttpsFunction
  ): Promise<TResponse> {
    // v2 callable functions accept a single CallableRequest<T> argument.
    const generic = this._provider.context(request);
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
function toRequestContext<
  TKey extends AuthKey,
  TData extends CloudFunctionsParsedBody
>(
  request: RawHttpRequest<TKey, TData>,
  generic: UnauthenticatedRequestContext | AuthenticatedRequestContext
): {
  request: V2Request;
  response: MockHttpResponse;
} {
  const options: HttpRequestOptions = cloneDeep(request.options ?? {});
  const auth = buildAuthData(generic);
  applyFunctionMeta(request, options, {
    onCallMode: false,
    appCheck: generic.app?.token,
    id: auth?.token,
  });
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
  generic: UnauthenticatedRequestContext | AuthenticatedRequestContext
): CallableRequest<TData> {
  // Build underlying raw request (Express-ish) with callable defaults
  const headers = cloneDeep(request.headers) ?? {};
  const options: HttpRequestOptions = { headers };
  const auth = buildAuthData(generic);
  applyFunctionMeta(request, options, {
    onCallMode: true,
    appCheck: generic.app?.token,
    id: auth?.token,
  });
  const rawRequest = mockHttpRequest(options); // kept internal; no need to expose if not part of v2 type

  // Auth / App are surfaced on request in v2
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

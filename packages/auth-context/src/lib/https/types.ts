import {
  CloudFunctionsParsedBody,
  HttpHeaders,
  HttpRequestOptions,
} from '../http/types.js';
import { AuthContextOptions, AuthKey } from '../types.js';

/**
 * Common fields for describing an invocation target and payload for HTTPS functions.
 *
 * @typeParam TKey - Registry key type used to look up the mock identity (via the AuthProvider).
 * @typeParam TData - Arbitrary JSON-serializable payload passed to the function (see {@link CloudFunctionsParsedBody}).
 *
 * @remarks
 * - The `key` selects which registered identity to use when synthesizing `auth` and (optionally) App Check.
 * - `region`, `project`, and `asEmulator` influence function metadata applied to the request (e.g., headers/URL shaping).
 * - `app` allows per-call override or suppression of App Check data.
 * - `functionName` is advisory metadata used by helpers to annotate the request (helpful in logs or routing).
 */
export interface CloudFunctionRequestBase<
  TKey extends AuthKey,
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> extends AuthContextOptions<TKey> {
  /**
   * Logical payload for the call. For `onCall`, this becomes `request.data`;
   * for `onRequest`, helpers may serialize/embed as the HTTP body depending on the mock.
   */
  data?: TData;

  /**
   * Cloud Functions region hint (e.g., `"us-central1"`).
   * If omitted, the broker/provider default region is used.
   */
  region?: string;

  /**
   * Firebase project ID hint. If omitted, the broker/provider default project ID is used.
   */
  project?: string;

  /**
   * If `true`, function metadata is marked as targeting the local emulator.
   * This may influence headers/host construction performed by helpers.
   */
  asEmulator?: boolean;

  /**
   * Optional descriptive function name. Used for diagnostics and to decorate mock request metadata.
   */
  functionName?: string;
}

/**
 * Request descriptor for v1/v2 **`https.onCall`** tests.
 *
 * @typeParam TKey - Registry key type used to look up the mock identity.
 * @typeParam TData - Callable request payload type.
 *
 * @remarks
 * Firebase clients do not control the low-level HTTP request for `onCall`:
 * method, URL/path, params/query, cookies/sessions, files, and raw body are not user-configurable.
 * Handlers receive `(data, context)` (v1) or a single `CallableRequest` (v2). A `rawRequest`
 * object exists for compatibility, but only limited surface (like headers) is configurable here.
 */
export interface CallableFunctionRequest<
  TKey extends AuthKey,
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> extends CloudFunctionRequestBase<TKey, TData>,
    AuthContextOptions<TKey> {
  /**
   * The data passed to the callable function.
   */
  data: TData;
  /**
   * Additional HTTP headers to surface on the underlying `rawRequest` snapshot.
   * (Auth/App Check headers are synthesized by the orchestrator/provider.)
   *
   * @example
   * ```ts
   * const req: CallableFunctionRequest<'alice', { x: number }> = {
   *   key: 'alice',
   *   data: { x: 1 },
   *   headers: { 'x-test-scenario': 'smoke' },
   * };
   * ```
   */
  headers?: HttpHeaders;
}

/**
 * Request descriptor for v1/v2 **`https.onRequest`** tests.
 *
 * @typeParam TKey - Registry key type used to look up the mock identity.
 * @typeParam TData - Parsed body type that your mock request may carry.
 *
 * @remarks
 * - `options` allows you to shape the Express-like request seen by the handler:
 *   method, URL, headers, query, cookies, and serialized body.
 * - Auth/App Check are still synthesized from `key` (and `app` override) by the provider,
 *   not by manually setting headers in `options`.
 */
export interface RawHttpRequest<
  TKey extends AuthKey,
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> extends CloudFunctionRequestBase<TKey, TData> {
  /**
   * Low-level request shaping options for `onRequest` handlers.
   * These are consumed by the mock HTTP layer to construct an Express-like `Request`.
   *
   * @example
   * ```ts
   * const req: RawHttpRequest<'bob', { ping: true }> = {
   *   key: 'bob',
   *   data: { ping: true },
   *   options: {
   *     method: 'POST',
   *     path: '/widgets?limit=10',
   *     headers: { 'content-type': 'application/json' },
   *     body: { ping: true },
   *   },
   * };
   * ```
   */
  options?: HttpRequestOptions;
}

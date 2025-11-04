import { Request } from 'firebase-functions/v1/https';
import {
  Body,
  createRequest,
  Files,
  RequestMethod,
  RequestOptions,
} from 'node-mocks-http';
import {
  CloudFunctionsParsedBody,
  GenericValueDictionary,
  HttpCookies,
  HttpHeaders,
  HttpRequestOptions,
} from '../types.js';

/**
 * Concrete request type used by v1 `firebase-functions` HTTPS handlers.
 *
 * @remarks
 * This is the Express-style `Request` re-exported for clarity and paired
 * with `node-mocks-http` so tests can construct realistic requests without
 * a running server.
 */
export type MockHttpRequest = Request;

/**
 * Create a mocked HTTP request suitable for invoking v1 `https.onRequest`
 * handlers (and for building v1 `onCall` contexts upstream).
 *
 * @param options - High-level request options (method, URL, headers, body, etc.).
 * @returns A {@link MockHttpRequest} instance compatible with Express/Firebase v1.
 *
 * @remarks
 * - Defaults the HTTP method to **POST** when a body is provided, otherwise **GET**.
 * - Ensures headers are normalized to lowercase (Node convention).
 * - Synthesizes `content-type` and `content-length` if they’re missing.
 * - Populates `rawBody` with the exact bytes sent (stringified for objects/arrays)
 *   to mirror Firebase’s request shape and allow signature verification flows.
 *
 * @example
 * ```ts
 * const req = mockHttpRequest({
 *   method: 'POST',
 *   url: '/api/ping',
 *   headers: { 'x-forwarded-proto': 'https' },
 *   body: { ping: true },
 * });
 * expect(req.method).toBe('POST');
 * expect(req.get('content-type')).toMatch(/application\/json/i);
 * expect(req.rawBody).toBeInstanceOf(Buffer);
 * ```
 */
export function mockHttpRequest(options?: HttpRequestOptions): MockHttpRequest {
  const _options = buildRequestOptions(options);
  const r: MockHttpRequest = createRequest(_options);
  r.rawBody = _options.bodyBuffer ?? Buffer.alloc(0);

  return r;
}

/**
 * Normalize a user-supplied header map to Node's expected lowercase keys and
 * serialize array values as comma-delimited strings.
 *
 * @param src - Original headers (case/shape agnostic).
 * @returns A header record with lowercase keys and string or string[] values.
 *
 * @remarks
 * Node stores header names in lowercase. When a value is an array, many frameworks
 * serialize it as a single comma-separated string; we follow that convention.
 *
 * @internal
 */
function normalizeHeaders(
  src?: HttpHeaders
): Record<string, string | string[]> {
  if (!src) return {};
  const out: Record<string, string | string[]> = {};
  for (const k of Object.keys(src)) {
    const v = src[k as keyof HttpHeaders];
    if (v == undefined) continue;
    // node stores headers lowercase, convert array values to comma-delimited string
    out[k.toLowerCase()] = Array.isArray(v)
      ? v.filter((s) => s != undefined && s.length > 0).join(', ')
      : v;
  }
  return out;
}

/**
 * Convert a flexible body shape into a raw byte buffer suitable for
 * `req.rawBody` and for deriving content headers.
 *
 * @param body - Buffer, string, object/array (JSON), or undefined/null.
 * @returns A Buffer containing the exact bytes of the request body.
 *
 * @example
 * ```ts
 * materializeBodyBuffer({ a: 1 }) // => Buffer of '{"a":1}'
 * materializeBodyBuffer('hello')  // => Buffer of 'hello'
 * ```
 *
 * @internal
 */
function materializeBodyBuffer(
  body: CloudFunctionsParsedBody | undefined
): Buffer {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  // arrays / objects (JSON)
  return Buffer.from(JSON.stringify(body), 'utf8');
}

/**
 * Ensure essential content headers are present (`content-type` and `content-length`).
 *
 * @param headers - Mutable header record (lowercased keys).
 * @param bodyBuf - Raw body buffer used to derive length.
 * @param explicitType - Optional explicit content type to prefer.
 *
 * @remarks
 * - If `content-type` is missing, uses `explicitType` if provided; otherwise
 *   defaults to `application/json; charset=utf-8` when the body is non-empty.
 * - Always sets `content-length` if missing, based on `bodyBuf.length`.
 *
 * @internal
 */
function ensureContentHeaders(
  headers: Record<string, string | string[]>,
  bodyBuf: Buffer,
  explicitType?: string
) {
  const hasCT = 'content-type' in headers;
  const hasCL = 'content-length' in headers;

  if (!hasCT) {
    // Prefer explicit type passed in options.headers; otherwise assume JSON for POJOs, text when body is string.
    const fallback =
      explicitType ??
      (bodyBuf.length ? 'application/json; charset=utf-8' : undefined);
    if (fallback) headers['content-type'] = fallback;
  }

  if (!hasCL) {
    headers['content-length'] = String(bodyBuf.length);
  }
}

/**
 * Build a `node-mocks-http` {@link RequestOptions} object from high-level
 * {@link HttpRequestOptions}, applying sensible defaults for method, URL,
 * headers, cookies, and network fields.
 *
 * @param options - High-level request options, all optional.
 * @returns A populated RequestOptions plus a `bodyBuffer` copy for Firebase parity.
 *
 * @remarks
 * - Method defaults to **POST** when a `body` is provided, otherwise **GET**.
 * - If `host` is not provided, defaults to `localhost`.
 * - If neither `x-forwarded-proto` nor `forwarded` is provided, defaults to `http`.
 * - Keeps a copy of the raw body bytes in `bodyBuffer` to set `req.rawBody` later.
 *
 * @internal
 */
function buildRequestOptions(
  options?: HttpRequestOptions
): RequestOptions & { bodyBuffer?: Buffer } {
  const method: RequestMethod =
    options?.method ??
    // If caller supplied a body, default to POST; otherwise GET.
    (options?.body != null ? 'POST' : 'GET');

  // Basic URL defaults
  const url = options?.url ?? '/';
  const originalUrl = options?.originalUrl ?? url;
  const baseUrl = options?.baseUrl ?? '';
  const path = options?.path ?? url;

  // Params / query / session / cookies
  const params = (options?.params ?? {}) as GenericValueDictionary;
  const query = (options?.query ?? {}) as GenericValueDictionary;
  const session = (options?.session ?? {}) as GenericValueDictionary;
  const cookies = (options?.cookies ?? {}) as HttpCookies;
  const signedCookies = (options?.signedCookies ?? {}) as HttpCookies;

  // Headers
  const headers = normalizeHeaders(options?.headers);
  const bodyBuffer = materializeBodyBuffer(options?.body);
  ensureContentHeaders(
    headers,
    bodyBuffer,
    headers['content-type'] as string | undefined
  );

  // Host/proto conveniences (commonly expected by Express)
  // If the caller set "host" or "x-forwarded-proto", Express will derive hostname/protocol/secure.
  if (!headers.host) headers.host = 'localhost';
  if (!headers['x-forwarded-proto'] && headers['forwarded'] == null) {
    // If caller wants https semantics, they can pass x-forwarded-proto: https.
    // We default to http.
    headers['x-forwarded-proto'] = 'http';
  }

  // node-mocks-http RequestOptions
  const ro: RequestOptions & { bodyBuffer?: Buffer } = {
    method,
    url,
    originalUrl,
    baseUrl,
    path,
    params,
    query,
    session,
    cookies,
    signedCookies,
    headers,
    // node-mocks-http expects a JS value for body; keep the POJO/string here
    body: options?.body as Body,
    files: options?.files as unknown as Files,
    ip: options?.ip ?? '127.0.0.1',
  };

  // Keep a copy of the raw body bytes for Firebase parity
  ro.bodyBuffer = bodyBuffer;

  return ro;
}

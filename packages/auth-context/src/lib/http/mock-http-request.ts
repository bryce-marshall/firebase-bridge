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
} from './types.js';

export type MockHttpRequest = Request;

export function mockHttpRequest(options?: HttpRequestOptions): MockHttpRequest {
  const _options = buildRequestOptions(options);
  const r: MockHttpRequest = createRequest(_options);
  r.rawBody = _options.bodyBuffer ?? Buffer.alloc(0);

  return r;
}

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

function materializeBodyBuffer(
  body: CloudFunctionsParsedBody | undefined
): Buffer {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  // arrays / objects (JSON)
  return Buffer.from(JSON.stringify(body), 'utf8');
}

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

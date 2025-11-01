import { CookieOptions, Response } from 'express';
import { createResponse } from 'node-mocks-http';
import { GenericMultiValue, HttpResponseOptions } from './types.js';

/**
 * Describes a cookie that was set on the mocked HTTP response.
 *
 * @remarks
 * This mirrors the shape produced by `node-mocks-http` when code under test
 * calls `res.cookie(name, value, options)`. It’s useful for assertions in
 * tests to verify that cookies are written with the expected value and flags.
 */
export type ResponseCookie = {
  /**
   * The cookie value as written by application code.
   * May be a string or a multi-value type depending on the helper used.
   */
  value: GenericMultiValue;

  /**
   * Cookie attributes such as `httpOnly`, `secure`, `sameSite`, and `maxAge`.
   */
  options: CookieOptions;
};

/**
 * A lightweight, test-friendly facade that resembles the Web API
 * `Headers` interface while still allowing arbitrary header fields
 * to be accessed and enumerated.
 *
 * @remarks
 * Many Node frameworks expose headers as plain objects, whereas browser and
 * Fetch environments expose `Headers`. This hybrid type lets tests interact
 * with headers using familiar Web API methods (e.g. `get`, `set`, `forEach`)
 * while retaining index access (`headers['content-type']`).
 */
export interface HeaderWebAPI {
  /**
   * Index signature for direct/legacy access, e.g. `headers['x-auth']`.
   */
  [header: string]: unknown;

  /** Append a new value onto an existing header or create it if missing. */
  append(name: string, value: string): void;

  /** Remove a header by name (case-insensitive). */
  delete(name: string): void;

  /** Get the first value for a header, or `null` if not present. */
  get(name: string): string | null;

  /** Whether a header exists (case-insensitive). */
  has(name: string): boolean;

  /** Set/replace a header value. */
  set(name: string, value: string): void;

  /**
   * Iterate all header entries, invoking `callbackfn` for each pair.
   * @param callbackfn Receives `(value, key, parent)` for each header.
   * @param thisArg Optional `this` binding for the callback.
   */
  forEach(
    callbackfn: (value: string, key: string, parent: HeaderWebAPI) => void,
    thisArg?: unknown
  ): void;

  /** Returns an iterator of `[key, value]` tuples. */
  entries(): IterableIterator<[string, string]>;

  /** Returns an iterator of header names. */
  keys(): IterableIterator<string>;

  /** Returns an iterator of header values. */
  values(): IterableIterator<string>;

  /** Enables `for..of` iteration over `[key, value]` tuples. */
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

/**
 * Extension of Express' {@link Response} with `node-mocks-http` test helpers.
 *
 * @remarks
 * The underscore-prefixed methods are provided by `node-mocks-http` to
 * introspect the response in tests (status, headers, body, cookies, etc.).
 * These are *not* part of the real Express runtime API and should only be
 * used in test code.
 *
 * @example
 * ```ts
 * // Assert JSON status and payload
 * const res = mockHttpResponse();
 * await handler(req, res);
 * expect(res._getStatusCode()).toBe(200);
 * expect(res._isJSON()).toBe(true);
 * expect(res._getJSONData()).toEqual({ ok: true });
 * ```
 *
 * @example
 * ```ts
 * // Assert headers and cookies
 * const res = mockHttpResponse();
 * await handler(req, res);
 * const headers = res._getHeaders();
 * expect(headers.get('content-type')).toMatch(/json/i);
 * expect(res.cookies['session'].options.httpOnly).toBe(true);
 * ```
 */
type MockResponse = Response & {
  /**
   * Whether `res.end()` (or an equivalent) has been called.
   */
  _isEndCalled(): boolean;

  /**
   * Returns the response headers in a {@link HeaderWebAPI}-compatible wrapper.
   */
  _getHeaders(): HeaderWebAPI;

  /**
   * Returns the raw response payload as parsed by `node-mocks-http`.
   *
   * @typeParam T - Expected body type (defaults to `unknown`).
   */
  _getData<T = unknown>(): T;

  /**
   * Returns the response body parsed as JSON.
   *
   * @typeParam T - Expected JSON shape (defaults to `unknown`).
   */
  _getJSONData<T = unknown>(): T;

  /**
   * Returns the raw response buffer.
   */
  _getBuffer(): Buffer;

  /**
   * Returns the `res.locals` bag for assertions.
   *
   * @typeParam T - Expected shape of `locals` (defaults to `unknown`).
   */
  _getLocals<T = unknown>(): T;

  /**
   * Returns the numeric HTTP status code (e.g. `200`, `404`).
   */
  _getStatusCode(): number;

  /**
   * Returns the HTTP status message (e.g. "OK", "Not Found").
   */
  _getStatusMessage: () => string;

  /**
   * Whether the response was sent as JSON.
   */
  _isJSON(): boolean;

  /**
   * Whether the response buffer is valid UTF-8.
   */
  _isUTF8(): boolean;

  /**
   * Whether the recorded `Content-Length` matches the actual buffer length.
   */
  _isDataLengthValid(): boolean;

  /**
   * If a redirect occurred, returns the target URL; otherwise an empty string.
   */
  _getRedirectUrl(): string;

  /**
   * Returns the template/render context if `res.render()` was used.
   *
   * @typeParam T - Expected shape of the render data (defaults to `unknown`).
   */
  _getRenderData<T = unknown>(): T;

  /**
   * Returns the render view name/path if `res.render()` was used.
   */
  _getRenderView(): string;

  /**
   * Cookies written to the response, keyed by cookie name.
   */
  cookies: { [name: string]: ResponseCookie };
};

/**
 * Concrete test response type exported for convenience.
 */
export type MockHttpResponse = MockResponse;

/**
 * Create a new mocked Express `Response` suitable for unit tests.
 *
 * @param options - Optional `node-mocks-http` response configuration
 * (e.g., custom `eventEmitter`, `writableStream`, or `locals`).
 *
 * @returns A {@link MockHttpResponse} that implements Express' `Response`
 * plus `node-mocks-http` inspection helpers (e.g., `_getJSONData()`).
 *
 * @example
 * ```ts
 * import { mockHttpRequest } from './mock-http-request';
 *
 * const req = mockHttpRequest({ method: 'POST', body: { ping: true } });
 * const res = mockHttpResponse();
 * await onRequestHandler(req, res);
 *
 * expect(res._getStatusCode()).toBe(200);
 * expect(res._getJSONData()).toEqual({ pong: true });
 * ```
 */
export function mockHttpResponse(
  options?: HttpResponseOptions
): MockHttpResponse {
  return createResponse(options);
}

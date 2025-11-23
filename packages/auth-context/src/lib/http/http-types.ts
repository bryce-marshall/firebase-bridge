import { CookieOptions, Response } from 'express';
import EventEmitter from 'node:events';
import { IncomingMessage } from 'node:http';
import { Writable } from 'stream';

/**
 * Standard HTTP methods accepted by the mock request layer.
 *
 * @remarks
 * Values are uppercase and map 1:1 to Express/Node semantics.
 */
export type HttpMethod =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'CONNECT'
  | 'OPTIONS'
  | 'TRACE'
  | 'PATCH';

/**
 * Represents the body of a CloudFunctions request.
 * Handlers in your tests should treat `body` as **parsed** (no raw buffer/string parsing required).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CloudFunctionsBody = any;

/** Single generic optional value used by index signatures. */
export type GenericValue = string | undefined;
/** Single or multi-value used by index signatures. */
export type GenericMultiValue = string | string[] | undefined;
/** Dictionary of single values. */
export type GenericValueDictionary = Record<string, GenericValue>;
/** Dictionary of single or multi-values. */
export type GenericMultiValueDictionary = Record<string, GenericMultiValue>;

/**
 * Minimal file metadata compatible with common **Multer** shapes.
 *
 * @remarks
 * Use when mocking `multipart/form-data` uploads handled by Multer-like middleware.
 * Fields are a pragmatic subset often consumed by app code and tests.
 */
export interface MulterFileLike {
  /** Form field name (e.g., `"avatar"`). */
  fieldname: string;
  /** Original filename on the user’s device. */
  originalname: string;
  /** MIME type (e.g., `"image/png"`). */
  mimetype: string;
  /** File size in bytes. */
  size: number;

  /** File content for memory storage backends. */
  buffer?: Buffer;

  /** Directory containing the stored file (disk storage). */
  destination?: string;
  /** Basename within `destination` (disk storage). */
  filename?: string;
  /** Full absolute path (disk storage). */
  path?: string;

  /** Readable stream for streaming pipelines. */
  stream?: NodeJS.ReadableStream;

  /** Optional transfer/storage metadata. */
  encoding?: string; // e.g., "7bit"
  md5?: string;
}

/**
 * Minimal file metadata compatible with common **Formidable** shapes.
 *
 * @remarks
 * Matches fields frequently seen in `formidable` and `node-mocks-http` examples.
 */
export interface FormidableFileLike {
  /** Original filename provided by the client. */
  originalFilename: string;
  /** Current (temporary) file path on disk. */
  filepath: string;
  /** MIME type as detected/provided. */
  mimetype: string;
  /** File size in bytes. */
  size: number;

  /** Optional metadata emitted by parsers. */
  newFilename?: string;
  hash?: string;
  lastModifiedDate?: Date;

  /** Legacy/alternate fields occasionally present in older code. */
  name?: string;
  type?: string;
}

/**
 * Union of supported uploaded file shapes.
 *
 * @remarks
 * Accept either Multer-style or Formidable-style objects.
 */
export type UploadedFileLike = MulterFileLike | FormidableFileLike;

/**
 * Mapping of form field name → file or files.
 *
 * @remarks
 * Some fields may accept multiple files, hence the `UploadedFileLike[]` variant.
 */
export type HttpFiles = Record<string, UploadedFileLike | UploadedFileLike[]>;

/** Route params (e.g., from `:id` segments). */
export type HttpParams = GenericValueDictionary;
/** Query string key/value pairs (parsed). */
export type HttpQuery = GenericValueDictionary;
/** Session key/value pairs for tests that simulate session middleware. */
export type HttpSession = GenericValueDictionary;
/** Cookie name/value pairs (unsigned). */
export type HttpCookies = Record<string, string>;

/**
 * Options used to construct a mock Express-like request object.
 *
 * @remarks
 * These fields are consumed by the mock HTTP layer (e.g., `node-mocks-http`)
 * to build a `Request` compatible object for your handlers.
 * - **Auth/App Check headers are synthesized** by the orchestrator; you typically do not set them here.
 * - Unknown keys are permitted (index signature) to support niche middleware flags used by tests.
 */
export interface HttpRequestOptions {
  /** HTTP method (defaults to `GET`). */
  method?: HttpMethod;
  /** Fully-qualified URL (if provided, may override other URL components). */
  url?: string;
  /** Original URL before any internal rewrites (Express compatibility). */
  originalUrl?: string;
  /** Base mount path (Express `baseUrl`). */
  baseUrl?: string;
  /** Path portion of the URL (e.g., `"/widgets/42"`). */
  path?: string;

  /** Route params extracted from the path. */
  params?: HttpParams;
  /** Session bag for tests that simulate session middleware. */
  session?: HttpSession;

  /** Incoming cookies (unsigned). */
  cookies?: HttpCookies;
  /** Signed cookies (if your test simulates a signing secret). */
  signedCookies?: HttpCookies;

  /** Additional request headers. */
  headers?: HttpHeaders;

  /**
   * Parsed request body.
   *
   * @remarks
   * Supply an already-parsed value; the mock does not parse raw buffers/strings.
   */
  body?: CloudFunctionsBody;

  /** Parsed query string values. */
  query?: HttpQuery;

  /** Uploaded files keyed by form field. */
  files?: HttpFiles;

  /** Client IP address. */
  ip?: string;

  /**
   * Escape hatch for library/middleware-specific flags.
   * Unknown keys are preserved and attached to the request object.
   */
  [key: string]:
    | GenericMultiValue
    | GenericValue
    | GenericMultiValueDictionary
    | GenericValueDictionary
    | CloudFunctionsBody
    | undefined;
}

/**
 * Case-insensitive, lower-cased HTTP headers with lenient multi-value support.
 *
 * @remarks
 * - Keys are modeled in **lower case** to match Node/Express conventions.
 * - For `set-cookie`, an array is exposed (multiple headers).
 * - You may add arbitrary header names via the index signature inherited from
 *   {@link GenericMultiValueDictionary}.
 */
export interface HttpHeaders extends GenericMultiValueDictionary {
  accept?: string;
  'accept-language'?: string;
  'accept-patch'?: string;
  'accept-ranges'?: string;
  'access-control-allow-credentials'?: string;
  'access-control-allow-headers'?: string;
  'access-control-allow-methods'?: string;
  'access-control-allow-origin'?: string;
  'access-control-expose-headers'?: string;
  'access-control-max-age'?: string;
  age?: string;
  allow?: string;
  'alt-svc'?: string;
  authorization?: string;
  'cache-control'?: string;
  connection?: string;
  'content-disposition'?: string;
  'content-encoding'?: string;
  'content-language'?: string;
  'content-length'?: string;
  'content-location'?: string;
  'content-range'?: string;
  'content-type'?: string;
  cookie?: string;
  date?: string;
  expect?: string;
  expires?: string;
  forwarded?: string;
  from?: string;
  host?: string;
  'if-match'?: string;
  'if-modified-since'?: string;
  'if-none-match'?: string;
  'if-unmodified-since'?: string;
  'last-modified'?: string;
  location?: string;
  pragma?: string;
  'proxy-authenticate'?: string;
  'proxy-authorization'?: string;
  'public-key-pins'?: string;
  range?: string;
  referer?: string;
  'retry-after'?: string;
  'set-cookie'?: string[];
  'strict-transport-security'?: string;
  tk?: string;
  trailer?: string;
  'transfer-encoding'?: string;
  upgrade?: string;
  'user-agent'?: string;
  vary?: string;
  via?: string;
  warning?: string;
  'www-authenticate'?: string;
}

/**
 * Optional knobs passed to the mock response factory.
 *
 * @remarks
 * These map to features commonly exposed by `node-mocks-http`.
 * Use only when your test needs to hook into the response lifecycle or pipe output.
 */
export interface HttpResponseOptions {
  /** Custom event emitter to receive response lifecycle events. */
  eventEmitter?: EventEmitter;
  /** Writable stream to which response data should be piped. */
  writableStream?: Writable;
  /** The originating Node `IncomingMessage` (advanced scenarios). */
  req?: IncomingMessage;
  /** Bag for Express-style `res.locals`. */
  locals?: Record<string, unknown>;
}

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

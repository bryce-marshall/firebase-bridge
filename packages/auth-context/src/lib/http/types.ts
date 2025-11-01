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
 * Canonical set of **already-parsed** request body shapes supported by the mock.
 *
 * @remarks
 * - For `application/json`: either an **object** or **array**.
 * - For `application/x-www-form-urlencoded`: a string map or string-array map as produced by typical parsers.
 * - For `text/*`: a string.
 * - `null` / `undefined` indicates no body or an unsupported content type.
 *
 * Handlers in your tests should treat `body` as **parsed** (no raw buffer/string parsing required).
 */
export type CloudFunctionsParsedBody =
  // JSON:
  | { [k: string]: unknown } // application/json (object)
  | unknown[] // application/json (array)
  // URL-encoded:
  | { [k: string]: string | string[] } // application/x-www-form-urlencoded
  // Text:
  | string // text/plain, text/*
  // Absent/unsupported:
  | null
  | undefined;

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
  body?: CloudFunctionsParsedBody;

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
    | CloudFunctionsParsedBody
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

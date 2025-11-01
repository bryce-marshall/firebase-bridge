import { DEFAULT_PROJECT_ID, DEFAULT_REGION } from '../_internal/constants.js';
import { cloneDeep, defaultString } from '../_internal/util.js';
import { CloudFunctionsParsedBody, HttpRequestOptions } from '../http/types.js';
import { AuthKey } from '../types.js';
import { CloudFunctionRequestBase } from './types.js';

/**
 * Populate/normalize HTTP request metadata for a Cloud Function invocation.
 *
 * @param request - High-level function request descriptor (identity key, region, project, emulator flag, etc.).
 * @param options - Low-level HTTP request options object to **mutate** (URL, method, headers, etc.).
 * @param onCallMode - If `true`, enforce callable (`onCall`) defaults (e.g., `POST`, JSON body, synthesized URL).
 *
 * @remarks
 * This helper shapes an Express-like `HttpRequestOptions` for both `onRequest` and `onCall` flows:
 *
 * - **URL / path shaping**
 *   - If `onCallMode === true` **or** `options.url` is missing, sets a synthetic path based on
 *     `{project}/{region}/{functionName}` when targeting the **emulator**, or `/{functionName}` for hosted.
 *   - Defaults:
 *     - `region` → {@link DEFAULT_REGION}
 *     - `project` → {@link DEFAULT_PROJECT_ID}
 *     - `functionName` → `"defaultFunction"`
 *   - Also mirrors the path to `originalUrl`, `path`, and clears `baseUrl`.
 *
 * - **Headers**
 *   - Ensures a `host` header:
 *     - Emulator: `"127.0.0.1:5001"`
 *     - Hosted: `"<region>-<project>.cloudfunctions.net"`
 *   - Ensures `x-forwarded-proto` (`"http"` for emulator, otherwise `"https"`).
 *   - Ensures `content-type: application/json` for callable mode, or if not already set.
 *
 * - **HTTP method**
 *   - Sets `method: "POST"` in callable mode, or if `options.method` is not provided.
 *
 * - **Mutation/Safety**
 *   - This function **modifies** the provided `options` object in place.
 *   - Existing `headers`, `url`, and `method` are respected unless callable-mode requires an override,
 *     or they are undefined/empty.
 */
export function applyFunctionMeta(
  request: CloudFunctionRequestBase<AuthKey, CloudFunctionsParsedBody>,
  options: HttpRequestOptions,
  onCallMode: boolean
): void {
  const region = defaultString(request?.region, DEFAULT_REGION);
  const project = defaultString(request?.project, DEFAULT_PROJECT_ID);
  const asEmulator = !!request.asEmulator;
  if (request.data) {
    options.body = cloneDeep(request.data);
  }

  // In callable mode (or missing URL), synthesize a canonical path.
  if (onCallMode || !options.url) {
    const functionName = defaultString(
      request?.functionName,
      'defaultFunction'
    );
    const path = asEmulator
      ? `/${project}/${region}/${functionName}`
      : `/${functionName}`;

    options.url = path;
    options.originalUrl = path;
    options.path = path;
    options.baseUrl = '';
  }

  // Ensure a headers bag, then add defaults only if missing/empty.
  const headers = options.headers ?? (options.headers = {});
  /**
   * Determine whether a header is missing or effectively empty.
   *
   * @internal
   */
  function noHeader(key: string): boolean {
    const value = headers[key];
    return (value == undefined || !value.length) ?? 0 === 0;
  }

  // Host header
  if (noHeader('host')) {
    const host = asEmulator
      ? `127.0.0.1:5001`
      : `${region}-${project}.cloudfunctions.net`;
    headers.host = host;
  }

  // Forwarded proto
  if (noHeader('x-forwarded-proto')) {
    headers['x-forwarded-proto'] ??= asEmulator ? 'http' : 'https';
  }

  // Method
  if (onCallMode || !options.method) {
    options.method = 'POST';
  }

  // Content type
  if (onCallMode || noHeader('content-type')) {
    // onRequest: multipart if files are present (callable never uses multipart)
    if (!onCallMode && options.files && Object.keys(options.files).length > 0) {
      const existing = headers['content-type'];
      const boundary =
        existing?.match(/boundary=([^;]+)/i)?.[1] ?? '----firebase-bridge-mock';

      headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
    } else {
      const body = options.body;

      // Helper: is URL-encoded candidate (flat k=v / k=[v1,v2] shape)
      const isUrlEncoded =
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        Object.values(body as Record<string, unknown>).every(
          (v) =>
            typeof v === 'string' ||
            (Array.isArray(v) &&
              (v as unknown[]).every((x) => typeof x === 'string'))
        );

      let ctype: string | undefined;

      if (onCallMode) {
        // Callable is always JSON
        ctype = 'application/json';
      } else if (isUrlEncoded) {
        ctype = 'application/x-www-form-urlencoded';
      } else if (Array.isArray(body) || typeof body === 'object') {
        // Treat objects/arrays as JSON
        ctype = 'application/json';
      } else if (typeof body === 'string') {
        ctype = 'text/plain; charset=utf-8';
      } else if (body == null) {
        // No body: leave unset for onRequest
        ctype = undefined;
      } else {
        // Fallback
        ctype = 'application/json';
      }

      if (ctype) headers['content-type'] = ctype;
    }
  }
}

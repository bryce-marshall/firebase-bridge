import { createResponse } from 'node-mocks-http';
import { HttpResponseOptions, MockHttpResponse } from '../http-types.js';

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

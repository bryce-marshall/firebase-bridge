import { CookieOptions, Response } from 'express';
import { createResponse } from 'node-mocks-http';
import { GenericMultiValue, HttpResponseOptions } from './types.js';

export type ResponseCookie = {
  value: GenericMultiValue;
  options: CookieOptions;
};

/**
 * HeaderWebAPI interface combines the existing Headers type with
 * standard Web API Headers interface methods for better compatibility
 * with browser environments.
 */
export interface HeaderWebAPI {
  // Include all the header properties
  [header: string]: unknown;

  // Web API Headers methods
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(
    callbackfn: (value: string, key: string, parent: HeaderWebAPI) => void,
    thisArg?: unknown
  ): void;

  // Iterator methods
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

type MockResponse = Response & {
  _isEndCalled(): boolean;
  _getHeaders(): HeaderWebAPI;
  _getData<T = unknown>(): T;
  _getJSONData<T = unknown>(): T;
  _getBuffer(): Buffer;
  _getLocals<T = unknown>(): T;
  _getStatusCode(): number;
  _getStatusMessage: () => string;
  _isJSON(): boolean;
  _isUTF8(): boolean;
  _isDataLengthValid(): boolean;
  _getRedirectUrl(): string;
  _getRenderData<T = unknown>(): T;
  _getRenderView(): string;

  cookies: { [name: string]: ResponseCookie };
};

export type MockHttpResponse = MockResponse;

export function mockHttpResponse(
  options?: HttpResponseOptions
): MockHttpResponse {
  return createResponse(options);
}

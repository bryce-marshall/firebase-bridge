import { Request, Response } from 'express';
import { MockHttpResponse } from '../../lib/http/mock-http-response';
import { CloudFunctionsParsedBody } from '../../lib/http/types';
import { CallableFunctionRequest, RawHttpRequest } from '../../lib/https/types';
import { AppCheckData, AuthData } from '../../lib/types';
import { TestIdentity } from '../_helpers/test-manager';

/**
 * The request used to call a callable function.
 */
export interface CommonCallableRequest<
  T extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> {
  /**
   * The parameters used by a client when calling this function.
   */
  data: T;
  /**
   * The result of decoding and verifying a Firebase App Check token.
   */
  app?: AppCheckData;
  /**
   * The result of decoding and verifying a Firebase Auth ID token.
   */
  auth?: AuthData;
  /**
   * An unverified token for a Firebase Instance ID.
   */
  instanceIdToken?: string;
  /**
   * The raw request handled by the callable.
   */
  rawRequest: Request;
}

export type CommonCallableHandler<
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
  TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> = (request: CommonCallableRequest<TData>) => Promise<TResponse> | TResponse;

export type CommonRequestHandler = (
  req: Request,
  resp: Response
) => void | Promise<void>;

export interface TestRunner {
  onCall<
    TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
    TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
  >(
    request: CallableFunctionRequest<TestIdentity, TData>,
    handler: CommonCallableHandler<TData, TResponse>
  ): Promise<TResponse>;
  onRequest<TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody>(
    request: RawHttpRequest<TestIdentity, TData>,
    handler: CommonRequestHandler
  ): Promise<MockHttpResponse>;
}

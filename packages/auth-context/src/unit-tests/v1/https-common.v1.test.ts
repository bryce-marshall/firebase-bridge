import {
  CloudFunctionsParsedBody,
  MockHttpResponse,
} from '../../lib/http/types.js';
import {
  CallableFunctionRequest,
  RawHttpRequest,
} from '../../lib/https/types.js';
import { TestIdentity, TestManager } from '../_helpers/test-manager.js';
import {
  CommonCallableHandler,
  CommonRequestHandler,
  TestRunner,
} from '../common/common-types.js';
import { runHttpsCommonSuites } from '../common/https-common.suite.js';

class V1Runner implements TestRunner {
  readonly manager = new TestManager();
  onCall<
    TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
    TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
  >(
    request: CallableFunctionRequest<TestIdentity, TData>,
    handler: CommonCallableHandler<TData, TResponse>
  ): Promise<TResponse> {
    return this.manager.https.v1.onCall(request, (data, context) => {
      return handler({
        ...context,
        data,
      });
    });
  }

  onRequest<TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody>(
    request: RawHttpRequest<TestIdentity, TData>,
    handler: CommonRequestHandler
  ): Promise<MockHttpResponse> {
    return this.manager.https.v1.onRequest(request, (req, resp) => {
      return handler(req, resp);
    });
  }
}

runHttpsCommonSuites('v1', new V1Runner());

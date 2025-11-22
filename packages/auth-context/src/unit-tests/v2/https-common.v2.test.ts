import {
  CloudFunctionsParsedBody,
  MockHttpResponse,
} from '../../lib/http/http-types.js';
import {
  CallableFunctionRequest,
  RawHttpRequest,
} from '../../lib/https/https-types.js';
import {
  TestAuthManager,
  TestIdentity,
} from '../_helpers/test-auth-manager.js';
import {
  CommonCallableHandler,
  CommonRequestHandler,
  TestRunner,
} from '../common/common-types.js';
import { runHttpsCommonSuites } from '../common/https-common.suite.js';

class V2Runner implements TestRunner {
  readonly manager = new TestAuthManager();
  onCall<
    TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody,
    TResponse extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
  >(
    request: CallableFunctionRequest<TestIdentity, TData>,
    handler: CommonCallableHandler<TData, TResponse>
  ): Promise<TResponse> {
    return this.manager.https.v2.onCall(request, (context) => {
      return handler(context);
    });
  }

  onRequest<TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody>(
    request: RawHttpRequest<TestIdentity, TData>,
    handler: CommonRequestHandler
  ): Promise<MockHttpResponse> {
    return this.manager.https.v2.onRequest(request, (req, resp) => {
      return handler(req, resp);
    });
  }
}
runHttpsCommonSuites('v2', new V2Runner());

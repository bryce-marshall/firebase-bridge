import type { CallableRequest } from 'firebase-functions/v2/https';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { RequestHandlerV2 } from '../../lib/https/v2-types.js';
import {
  TestAuthManager,
  TestIdentity,
} from '../_helpers/test-auth-manager.js';

const INPUT_VALUE = 1234567;
const EXPECTED_OUTPUT_VALUE = 'application/json';

interface InputData {
  inputValue: number;
}

interface OutputData {
  inputValue: number;
  outputValue: string;
}

function makeOutputData(data: InputData, req: Request): OutputData {
  return {
    inputValue: data.inputValue,
    outputValue: req.headers.get('content-type') ?? '',
  };
}

const onCallHandlerV2 = onCall(
  (request: CallableRequest<InputData>): OutputData => {
    const { data } = request;
    return makeOutputData(data, request.rawRequest as unknown as Request);
  }
);

const onCallHandlerV2Promise = onCall(
  (request: CallableRequest<InputData>): Promise<OutputData> => {
    const { data } = request;
    return Promise.resolve(
      makeOutputData(data, request.rawRequest as unknown as Request)
    );
  }
);

const onRequestHandlerV2 = onRequest((req, res): void => {
  const result = makeOutputData(
    req.body as InputData,
    req as unknown as Request
  );
  res.status(100).json(result);
});

const onRequestHandlerV2Promise = onRequest((req, res): Promise<void> => {
  const result = makeOutputData(
    req.body as InputData,
    req as unknown as Request
  );
  res.status(100).json(result);
  return Promise.resolve();
});

describe('AuthManager native handlers (v2)', () => {
  const auth = new TestAuthManager();

  async function testOnCallV2(handler: typeof onCallHandlerV2): Promise<void> {
    const result = await auth.https.v2.runCallable(
      {
        key: TestIdentity.John,
        data: {
          inputValue: INPUT_VALUE,
        },
      },
      handler
    );

    expect(result).toEqual<OutputData>({
      inputValue: INPUT_VALUE,
      outputValue: EXPECTED_OUTPUT_VALUE,
    });
  }

  async function testOnRequestV2(handler: RequestHandlerV2): Promise<void> {
    const response = await auth.https.v2.onRequest(
      {
        key: TestIdentity.John,
        data: {
          inputValue: INPUT_VALUE,
        },
      },
      handler
    );

    const result = response._getJSONData();

    expect(result).toEqual<OutputData>({
      inputValue: INPUT_VALUE,
      outputValue: EXPECTED_OUTPUT_VALUE,
    });
  }

  it('Handles native v2 onCall sync response', async () => {
    await testOnCallV2(onCallHandlerV2);
  });

  it('Handles native v2 onCall async response', async () => {
    await testOnCallV2(onCallHandlerV2Promise);
  });

  it('Handles native v2 onRequest sync response', async () => {
    await testOnRequestV2(onRequestHandlerV2);
  });

  it('Handles native v2 onRequest async response', async () => {
    await testOnRequestV2(onRequestHandlerV2Promise);
  });
});

import { HttpsFunction, Runnable, runWith } from 'firebase-functions/v1';
import { RequestHandlerV1 } from '../../lib/https/v1-types.js';
import { TestIdentity, TestManager } from '../_helpers/test-manager.js';

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

const onCallHandler = runWith({}).https.onCall(
  (data: InputData, context): OutputData => {
    return makeOutputData(data, context.rawRequest as unknown as Request);
  }
);

const onCallHandlerPromise = runWith({}).https.onCall(
  (data: InputData, context): Promise<OutputData> => {
    return Promise.resolve(
      makeOutputData(data, context.rawRequest as unknown as Request)
    );
  }
);

const onRequestHandler = runWith({}).https.onRequest((req, resp): void => {
  const result = makeOutputData(req.body, req as unknown as Request);
  resp.status(100).json(result);
});

const onRequestHandlerPromise = runWith({}).https.onRequest(
  (req, resp): Promise<void> => {
    const result = makeOutputData(req.body, req as unknown as Request);
    resp.status(100).json(result);

    return Promise.resolve();
  }
);

describe('AuthManager native handlers (v1)', () => {
  const auth = new TestManager();

  async function testOnCall(
    handler: HttpsFunction & Runnable<InputData>
  ): Promise<void> {
    const result = await auth.https.v1.runCallable(
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

  async function testOnRequest(handler: RequestHandlerV1): Promise<void> {
    const response = await auth.https.v1.onRequest(
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

  it('Handles native onCall sync response', async () => {
    await testOnCall(onCallHandler);
  });

  it('Handles native onCall async response', async () => {
    await testOnCall(onCallHandlerPromise);
  });

  it('Handles native onRequest sync response', async () => {
    await testOnRequest(onRequestHandler);
  });

  it('Handles native onRequest async response', async () => {
    await testOnRequest(onRequestHandlerPromise);
  });
});

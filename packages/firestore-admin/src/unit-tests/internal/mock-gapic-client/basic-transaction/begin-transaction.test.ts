import { Status } from 'google-gax';
import { ExpectError } from '../../../common';
import { MockGapicTestContext, mockGapicTestContext } from '../test-utils';
import { google } from '../test-utils/google';

describe('MockGapicClient.beginTransaction', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'DatabaseOne' });
  });

  it('returns a valid transaction ID for a readOnly transaction', async () => {
    await testId(Mock, {
      options: {
        readOnly: {},
      },
    });
  });

  it('returns a valid transaction ID for a readWrite transaction', async () => {
    await testId(Mock, {
      options: {
        readWrite: {},
      },
    });
  });

  it('throws if no transaction options are provided', async () => {
    await ExpectError.async(
      () => Mock.client.beginTransaction({}),
      ExpectError.status(Status.INVALID_ARGUMENT)
    );
  });

  it('throws if both readOnly and readWrite are specified', async () => {
    await ExpectError.async(
      () =>
        Mock.client.beginTransaction({
          options: {
            readOnly: {},
            readWrite: {},
          },
        }),
      ExpectError.status(Status.INVALID_ARGUMENT)
    );
  });
});

async function testId(
  mock: MockGapicTestContext,
  request: google.firestore.v1.IBeginTransactionRequest
): Promise<void> {
  const [res] = await mock.client.beginTransaction(request);
  expect(res).toHaveProperty('transaction');
  expect(res.transaction instanceof Uint8Array).toBe(true);
  expect(res.transaction?.length).toBeGreaterThan(0);
}

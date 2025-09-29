/* eslint-disable @typescript-eslint/no-explicit-any */
import { GoogleError, Status } from 'google-gax';
import {
  MockGapicTestContext,
  mockGapicTestContext,
  runAggregationQueryExpectError,
  runAggregationQueryExpectOk,
  runQueryExpectError,
  runQueryExpectOk,
} from '../test-utils';
import { google } from '../test-utils/google';

type Mode = 'std' | 'agg';
type StandardRequest = Partial<google.firestore.v1.RunQueryRequest>;
type AggregationRequest =
  Partial<google.firestore.v1.RunAggregationQueryRequest>;
type QueryRequest = StandardRequest | AggregationRequest;

consistencySelectorTests('std', runQueryExpectOk, runQueryExpectError);
consistencySelectorTests(
  'agg',
  runAggregationQueryExpectOk,
  runAggregationQueryExpectError
);

function consistencySelectorTests(
  mode: Mode,
  expectOk: (
    mock: MockGapicTestContext,
    request: QueryRequest
  ) => Promise<void>,
  expectError: (
    mock: MockGapicTestContext,
    request: QueryRequest
  ) => Promise<GoogleError>
): void {
  describe(`MockGapicClient.${
    mode === 'std' ? 'runQuery' : 'runAggregationQuery'
  } > consistency-selectors`, () => {
    let Mock!: MockGapicTestContext;

    beforeEach(() => {
      Mock = mockGapicTestContext({ database: 'TestDB' });
    });

    // --- helpers ---
    const validReadTime = (): google.protobuf.ITimestamp => ({
      seconds: Math.floor(Date.now() / 1000),
      nanos: 0,
    });

    const base = (): QueryRequest =>
      createRequest(
        mode,
        Mock.context.toGapicPath(''), // root parent
        [{ collectionId: 'users' }]
      );

    // --- mutual exclusivity ---

    it('rejects when both transaction and readTime are provided', async () => {
      const req = base();
      req.transaction = new Uint8Array([1, 2, 3]);
      req.readTime = validReadTime();
      const err = await expectError(Mock, req);
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects when both transaction and newTransaction are provided', async () => {
      const req = base();
      req.transaction = new Uint8Array([1]);
      req.newTransaction = {
        readOnly: {},
      } as google.firestore.v1.ITransactionOptions;
      const err = await expectError(Mock, req);
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects when both newTransaction and readTime are provided', async () => {
      const req = base();
      req.newTransaction = {
        readOnly: {},
      } as google.firestore.v1.ITransactionOptions;
      (req as any).readTime = validReadTime();
      const err = await expectError(Mock, req);
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects when transaction, newTransaction, and readTime are all provided', async () => {
      const req = base();
      (req as any).transaction = new Uint8Array([7]);
      req.newTransaction = {
        readOnly: {},
      } as google.firestore.v1.ITransactionOptions;
      (req as any).readTime = validReadTime();
      const err = await expectError(Mock, req);
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    // --- transaction validation ---

    it('rejects when transaction is not a Uint8Array', async () => {
      const req = base();
      req.transaction = 'abc' as any; // invalid type
      const err = await expectError(Mock, req);
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects when transaction is an empty Uint8Array', async () => {
      const req = base();
      req.transaction = new Uint8Array(0);
      const err = await expectError(Mock, req);
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    // --- readTime validation ---

    // it('rejects when readTime is not a valid protobuf Timestamp (wrong type)', async () => {
    //   const req = base();
    //   req.readTime = '2020-01-01T00:00:00Z' as any; // invalid type
    //   const err = await expectError(Mock, req);
    //   expect(err.code).toBe(Status.INVALID_ARGUMENT);
    // });

    // it('rejects when readTime timestamp shape is invalid (missing seconds/nanos)', async () => {
    //   const req = base();
    //   (req as any).readTime = {} as google.protobuf.ITimestamp;
    //   const err = await expectError(Mock, req);
    //   expect(err.code).toBe(Status.INVALID_ARGUMENT);
    // });

    it('accepts when only a valid readTime is provided', async () => {
      const req = base();
      req.readTime = validReadTime();
      await expect(expectOk(Mock, req)).resolves.toBeUndefined();
    });

    // // --- newTransaction validation ---

    it('rejects newTransaction with neither readOnly nor readWrite', async () => {
      const req = base();
      req.newTransaction = {} as google.firestore.v1.ITransactionOptions;
      const err = await expectError(Mock, req);
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects newTransaction with both readOnly and readWrite', async () => {
      const req = base();
      req.newTransaction = {
        readOnly: {},
        readWrite: {},
      } as google.firestore.v1.ITransactionOptions;
      const err = await expectError(Mock, req);
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    // it('rejects newTransaction.readOnly.readTime with invalid timestamp type', async () => {
    //   const req = base();
    //   (req as any).newTransaction = {
    //     readOnly: { readTime: 'nope' as any },
    //   } as google.firestore.v1.ITransactionOptions;
    //   const err = await expectError(Mock, req);
    //   expect(err.code).toBe(Status.INVALID_ARGUMENT);
    // });

    it('accepts newTransaction.readOnly with a valid readTime', async () => {
      const req = base();
      req.newTransaction = {
        readOnly: { readTime: validReadTime() },
      } as google.firestore.v1.ITransactionOptions;
      await expect(expectOk(Mock, req)).resolves.toBeUndefined();
    });

    it('rejects newTransaction.readWrite.retryTransaction with invalid type', async () => {
      const req = base();
      req.newTransaction = {
        readWrite: { retryTransaction: 'abc' as any }, // must be Uint8Array
      } as google.firestore.v1.ITransactionOptions;
      const err = await expectError(Mock, req);
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects newTransaction.readWrite.retryTransaction as empty Uint8Array', async () => {
      const req = base();
      req.newTransaction = {
        readWrite: { retryTransaction: new Uint8Array(0) },
      } as google.firestore.v1.ITransactionOptions;
      const err = await expectError(Mock, req);
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('accepts newTransaction.readWrite without retryTransaction', async () => {
      const req = base();
      req.newTransaction = {
        readWrite: {},
      } as google.firestore.v1.ITransactionOptions;
      await expect(expectOk(Mock, req)).resolves.toBeUndefined();
    });
  });
}

function createRequest(
  mode: Mode,
  parentPath: string,
  from: google.firestore.v1.StructuredQuery.ICollectionSelector[]
): QueryRequest {
  const request: QueryRequest = {
    parent: parentPath,
  };

  const structuredQuery: Partial<google.firestore.v1.StructuredQuery> = {
    from,
  };

  if (mode === 'std') {
    (request as StandardRequest).structuredQuery = structuredQuery;
  } else {
    (request as AggregationRequest).structuredAggregationQuery = {
      structuredQuery,
      aggregations: [{ count: {} }],
    };
  }

  return request;
}

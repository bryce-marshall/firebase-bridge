/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Status } from 'google-gax';
import { google } from '../test-utils/google';
import { MockGapicTestContext, mockGapicTestContext } from '../test-utils';

describe('MockGapicClient.rollback', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'RollbackDB' });
  });

  it('returns empty response for a valid transaction', async () => {
    const [begin] = await Mock.client.beginTransaction({
      options: { readWrite: {} },
    });
    const txn = begin.transaction!;

    const [emptyResponse] = await Mock.client.rollback({ transaction: txn });

    expect(emptyResponse).toEqual<google.protobuf.IEmpty>({});
  });

  it('does not modify documents when rolling back', async () => {
    const docPath = 'users/user1';
    Mock.context.toGapicPath(docPath);

    const [begin] = await Mock.client.beginTransaction({
      options: {
        readWrite: {},
      },
    });
    const txn = begin.transaction!;

    // Create a doc outside the transaction
    Mock.db.setDocument(docPath, { a: 1 });

    await Mock.client.rollback({ transaction: txn });

    // Document remains unchanged
    const doc = Mock.db.getDocument(docPath);
    expect(doc.exists).toBe(true);
    expect(doc.data).toEqual({ a: 1 });
  });

  it('throws INVALID_ARGUMENT if transaction is missing', async () => {
    await expect(
      Mock.client.rollback({ transaction: undefined })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('throws INVALID_ARGUMENT if transaction is unknown', async () => {
    // Fake transaction ID
    const badTxn = new Uint8Array([1, 2, 3, 4]);
    await expect(
      Mock.client.rollback({ transaction: badTxn })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('succeeds for a read-only transaction', async () => {
    const [begin] = await Mock.client.beginTransaction({
      options: { readOnly: {} },
    });
    const txn = begin.transaction!;

    const [emptyResponse] = await Mock.client.rollback({ transaction: txn });

    expect(emptyResponse).toEqual<google.protobuf.IEmpty>({});
  });

  it('rejects on second rollback of the same transaction', async () => {
    const [begin] = await Mock.client.beginTransaction({
      options: { readWrite: {} },
    });
    const txn = begin.transaction!;

    await Mock.client.rollback({ transaction: txn });
    await expect(
      Mock.client.rollback({ transaction: txn })
    ).rejects.toMatchObject({ code: Status.ABORTED });
  });

  it('rejects rollback for a transaction that has already committed', async () => {
    const [begin] = await Mock.client.beginTransaction({
      options: { readWrite: {} },
    });
    const txn = begin.transaction!;

    // Commit the transaction
    await Mock.client.commit({ transaction: txn, writes: [] });

    await expect(
      Mock.client.rollback({ transaction: txn })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('ignores extra fields in the request and still succeeds', async () => {
    const [begin] = await Mock.client.beginTransaction({
      options: { readWrite: {} },
    });
    const txn = begin.transaction!;

    const [emptyResponse] = await Mock.client.rollback({
      transaction: txn,
      extraField: 'ignored',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(emptyResponse).toEqual<google.protobuf.IEmpty>({});
  });
});

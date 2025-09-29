/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Status } from 'google-gax';
import { mockGapicTestContext, MockGapicTestContext } from '../test-utils';

describe('MockGapicClient.commit in transaction', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'TestDB' });
  });

  it('commits successfully in an active readWrite transaction', async () => {
    // Start transaction
    const [txBegin] = await Mock.client.beginTransaction({
      options: { readWrite: {} },
    });
    const txId = txBegin.transaction!;

    const path = Mock.context.toGapicPath('users/user-tx1');

    const [res] = await Mock.client.commit({
      transaction: txId,
      writes: [
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ a: 1 }),
          },
        },
      ],
    });

    expect(res.writeResults).toHaveLength(1);
    expect(Mock.db.getDocument('users/user-tx1').data).toEqual({ a: 1 });
  });

  it('rejects commit with unknown transaction ID', async () => {
    const bogusTxId = new Uint8Array(Buffer.from('non-existent-tx'));

    await expect(
      Mock.client.commit({
        transaction: bogusTxId,
        writes: [],
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('rejects commit for inactive transaction', async () => {
    // Start transaction and commit it
    const [txBegin] = await Mock.client.beginTransaction({
      options: { readWrite: {} },
    });
    const txId = txBegin.transaction!;

    await Mock.client.commit({ transaction: txId, writes: [] });

    // Try committing again
    await expect(
      Mock.client.commit({ transaction: txId, writes: [] })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('rejects writes in readOnly transaction', async () => {
    const [txBegin] = await Mock.client.beginTransaction({
      options: { readOnly: {} },
    });
    const txId = txBegin.transaction!;

    const path = Mock.context.toGapicPath('users/user-tx2');

    await expect(
      Mock.client.commit({
        transaction: txId,
        writes: [
          {
            update: {
              name: path,
              fields: Mock.context.serializer.encodeFields({ a: 1 }),
            },
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('marks transaction inactive after rollback', async () => {
    const [txBegin] = await Mock.client.beginTransaction({
      options: { readWrite: {} },
    });
    const txId = txBegin.transaction!;

    await Mock.client.rollback({ transaction: txId });

    await expect(
      Mock.client.commit({ transaction: txId, writes: [] })
    ).rejects.toMatchObject({ code: Status.ABORTED });
  });
});

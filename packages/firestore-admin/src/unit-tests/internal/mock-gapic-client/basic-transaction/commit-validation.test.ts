import { Status } from 'google-gax';
import { mockGapicTestContext, MockGapicTestContext } from '../test-utils';
import { google } from '../test-utils/google';

describe('MockGapicClient.commit › Validation', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'TestDB' });
  });

  it('rejects write with no operation set', async () => {
    await expect(Mock.client.commit({ writes: [{}] })).rejects.toMatchObject({
      code: Status.INVALID_ARGUMENT,
    });
  });

  it('rejects write with both update and delete', async () => {
    const path = Mock.context.toGapicPath('users/user-val1');
    await expect(
      Mock.client.commit({
        writes: [{ update: { name: path, fields: {} }, delete: path }],
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('rejects write with delete and updateTransforms', async () => {
    const path = Mock.context.toGapicPath('users/user-val2');
    await expect(
      Mock.client.commit({
        writes: [
          {
            delete: path,
            updateTransforms: [
              { fieldPath: 'foo', setToServerValue: 'REQUEST_TIME' },
            ],
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('rejects update missing name', async () => {
    await expect(
      Mock.client.commit({
        writes: [{ update: { fields: {} } }],
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('rejects updateMask with invalid field path', async () => {
    const path = Mock.context.toGapicPath('users/user-val3');
    await expect(
      Mock.client.commit({
        writes: [
          {
            update: { name: path, fields: {} },
            updateMask: { fieldPaths: [''] },
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('rejects transform with empty field path', async () => {
    const path = Mock.context.toGapicPath('users/user-val4');
    await expect(
      Mock.client.commit({
        writes: [
          {
            update: { name: path, fields: {} },
            updateTransforms: [
              { fieldPath: '', setToServerValue: 'REQUEST_TIME' },
            ],
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  // it('rejects duplicate document paths in same commit', async () => {
  //   const path = Mock.context.toGapicPath('users/user-val5');
  //   await expect(
  //     Mock.client.commit({
  //       writes: [
  //         { update: { name: path, fields: {} } },
  //         { update: { name: path, fields: {} } },
  //       ],
  //     })
  //   ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  // });

  it('allows commit with empty writes array', async () => {
    const [res] = await Mock.client.commit({ writes: [] });

    // A valid commitTime is still returned
    expect(res.commitTime).toBeDefined();

    // No write results because no writes were sent
    expect(res.writeResults).toHaveLength(0);
  });

  it('rejects update with invalid document name format', async () => {
    const badPath = 'invalid/path';
    await expect(
      Mock.client.commit({
        writes: [{ update: { name: badPath, fields: {} } }],
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('rejects transform with unsupported setToServerValue', async () => {
    const path = Mock.context.toGapicPath('users/user-val6');
    await expect(
      Mock.client.commit({
        writes: [
          {
            update: { name: path, fields: {} },
            updateTransforms: [{ fieldPath: 'foo', setToServerValue: 'FOO' }],
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.UNIMPLEMENTED });
  });

  it('allows valid field path in updateMask even if field does not exist', async () => {
    const path = Mock.context.toGapicPath('users/user-val7');
    const [res] = await Mock.client.commit({
      writes: [
        {
          update: { name: path, fields: {} },
          updateMask: { fieldPaths: ['missingField'] },
        },
      ],
    });
    expect(res.writeResults).toHaveLength(1);
    expect(
      (res as google.firestore.v1.IBatchWriteResponse).status
    ).toBeUndefined(); // commit returns no per-write status
  });
});

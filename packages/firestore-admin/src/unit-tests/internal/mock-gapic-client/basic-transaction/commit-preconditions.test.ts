/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Status } from 'google-gax';
import {
  mockGapicTestContext,
  MockGapicTestContext,
  ProtoHelper,
} from '../test-utils';

describe('MockGapicClient.commit › Preconditions', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'TestDB' });
  });

  it('allows update with matching lastUpdateTime', async () => {
    const path = 'users/user-pre1';
    const name = Mock.client.context.toGapicPath(path);

    const [initial] = await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { age: Mock.context.serializer.encodeValue(30)! },
          },
        },
      ],
    });

    const [res] = await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { age: Mock.context.serializer.encodeValue(31)! },
          },
          currentDocument: {
            updateTime: ProtoHelper.timestamp(initial.commitTime!),
          },
        },
      ],
    });

    expect(Mock.db.getDocument(path).data?.age).toBe(31);
    expect(res.writeResults?.length).toBe(1);
  });

  it('rejects update with stale lastUpdateTime', async () => {
    const path = 'users/user-pre2';
    const name = Mock.context.toGapicPath(path);

    const [initial] = await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { name: Mock.context.serializer.encodeValue('A')! },
          },
        },
      ],
    });

    Mock.time.advance();
    // Perform a second update to change the timestamp
    await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { name: Mock.context.serializer.encodeValue('B')! },
          },
        },
      ],
    });

    // Try to update using stale timestamp
    await expect(
      Mock.client.commit({
        writes: [
          {
            update: {
              name,
              fields: { name: Mock.context.serializer.encodeValue('C')! },
            },
            currentDocument: { updateTime: initial.commitTime! },
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.FAILED_PRECONDITION });
  });

  it('rejects update when exists = false and document exists', async () => {
    const path = 'users/user-pre3';
    const name = Mock.context.toGapicPath(path);

    await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { alive: Mock.context.serializer.encodeValue(true)! },
          },
        },
      ],
    });

    await expect(
      Mock.client.commit({
        writes: [
          {
            update: {
              name,
              fields: { alive: Mock.context.serializer.encodeValue(false)! },
            },
            currentDocument: { exists: false },
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.ALREADY_EXISTS });
  });

  it('allows update when exists = false and document is missing', async () => {
    const path = 'users/user-pre4';
    const name = Mock.context.toGapicPath(path);

    const [res] = await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { created: Mock.context.serializer.encodeValue(true)! },
          },
          currentDocument: { exists: false },
        },
      ],
    });

    expect(Mock.db.getDocument(path).exists).toBe(true);
    expect(res.writeResults?.length).toBe(1);
  });

  it('allows delete with matching lastUpdateTime', async () => {
    const path = 'users/user-pre5';
    const name = Mock.context.toGapicPath(path);

    const [initial] = await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { foo: Mock.context.serializer.encodeValue('bar')! },
          },
        },
      ],
    });

    const [res] = await Mock.client.commit({
      writes: [
        {
          delete: name,
          currentDocument: { updateTime: initial.commitTime! },
        },
      ],
    });

    expect(Mock.db.getDocument(path).exists).toBe(false);
    expect(res.writeResults?.length).toBe(1);
  });

  it('rejects delete with stale lastUpdateTime', async () => {
    const path = 'users/user-pre6';
    const name = Mock.context.toGapicPath(path);

    const [initial] = await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { v: Mock.context.serializer.encodeValue(1)! },
          },
        },
      ],
    });

    Mock.time.advance();
    // Advance document state
    await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { v: Mock.context.serializer.encodeValue(2)! },
          },
        },
      ],
    });

    await expect(
      Mock.client.commit({
        writes: [
          {
            delete: name,
            currentDocument: { updateTime: initial.commitTime! },
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.FAILED_PRECONDITION });
  });

  it('rejects delete when exists = true but document missing', async () => {
    const path = 'users/user-pre7';
    const name = Mock.context.toGapicPath(path);

    await expect(
      Mock.client.commit({
        writes: [
          {
            delete: name,
            currentDocument: { exists: true },
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.NOT_FOUND });
  });

  it('uses updateTime over exists when both are present', async () => {
    const path = 'users/user-pre8';
    const name = Mock.context.toGapicPath(path);

    const [initial] = await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { val: Mock.context.serializer.encodeValue(1)! },
          },
        },
      ],
    });

    Mock.time.advance();
    await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { val: Mock.context.serializer.encodeValue(2)! },
          },
        },
      ],
    });

    await expect(
      Mock.client.commit({
        writes: [
          {
            update: {
              name,
              fields: { val: Mock.context.serializer.encodeValue(3)! },
            },
            currentDocument: {
              exists: true,
              updateTime: initial.commitTime!,
            },
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.FAILED_PRECONDITION });
  });

  it('rejects update when exists = true and document missing', async () => {
    const path = 'users/user-pre9';
    const name = Mock.context.toGapicPath(path);

    await expect(
      Mock.client.commit({
        writes: [
          {
            update: {
              name,
              fields: { foo: Mock.context.serializer.encodeValue('bar')! },
            },
            currentDocument: { exists: true },
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.NOT_FOUND });
  });

  it('rejects update with stale lastUpdateTime when document deleted', async () => {
    const path = 'users/user-pre10';
    const name = Mock.context.toGapicPath(path);

    const [initial] = await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: { foo: Mock.context.serializer.encodeValue('bar')! },
          },
        },
      ],
    });

    Mock.time.advance();
    await Mock.client.commit({
      writes: [{ delete: name }],
    });

    await expect(
      Mock.client.commit({
        writes: [
          {
            update: {
              name,
              fields: { foo: Mock.context.serializer.encodeValue('baz')! },
            },
            currentDocument: { updateTime: initial.commitTime! },
          },
        ],
      })
    ).rejects.toMatchObject({ code: Status.FAILED_PRECONDITION });
  });
});

import { Status } from 'google-gax';
import { mockGapicTestContext, MockGapicTestContext } from '../test-utils';

describe('Duplicate document paths', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'TestDB' });
  });

  describe('commit', () => {
    // it('rejects update + update on same path', async () => {
    //   const path = Mock.context.toGapicPath('users/user1');
    //   await expect(
    //     Mock.client.commit({
    //       writes: [
    //         {
    //           update: {
    //             name: path,
    //             fields: Mock.context.serializer.encodeFields({ a: 1 }),
    //           },
    //         },
    //         {
    //           update: {
    //             name: path,
    //             fields: Mock.context.serializer.encodeFields({ b: 2 }),
    //           },
    //         },
    //       ],
    //     })
    //   ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
    // });
    // it('rejects delete + delete on same path', async () => {
    //   const path = Mock.context.toGapicPath('users/user2');
    //   await expect(
    //     Mock.client.commit({
    //       writes: [{ delete: path }, { delete: path }],
    //     })
    //   ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
    // });
    // it('rejects update + delete on same path', async () => {
    //   const path = Mock.context.toGapicPath('users/user3');
    //   await expect(
    //     Mock.client.commit({
    //       writes: [
    //         {
    //           update: {
    //             name: path,
    //             fields: Mock.context.serializer.encodeFields({ a: 1 }),
    //           },
    //         },
    //         { delete: path },
    //       ],
    //     })
    //   ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
    // });
    // it('rejects update + transform on same path', async () => {
    //   const path = Mock.context.toGapicPath('users/user4');
    //   await expect(
    //     Mock.client.commit({
    //       writes: [
    //         {
    //           update: {
    //             name: path,
    //             fields: Mock.context.serializer.encodeFields({ a: 1 }),
    //           },
    //         },
    //         {
    //           update: { name: path, fields: {} },
    //           updateTransforms: [
    //             { fieldPath: 't', setToServerValue: 'REQUEST_TIME' },
    //           ],
    //         },
    //       ],
    //     })
    //   ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
    // });
    // it('rejects same doc with different transforms', async () => {
    //   const path = Mock.context.toGapicPath('users/user5');
    //   await expect(
    //     Mock.client.commit({
    //       writes: [
    //         {
    //           update: { name: path, fields: {} },
    //           updateTransforms: [
    //             { fieldPath: 'a', setToServerValue: 'REQUEST_TIME' },
    //           ],
    //         },
    //         {
    //           update: { name: path, fields: {} },
    //           updateTransforms: [
    //             { fieldPath: 'b', setToServerValue: 'REQUEST_TIME' },
    //           ],
    //         },
    //       ],
    //     })
    //   ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
    // });
  });

  describe('batchWrite', () => {
    it('allows duplicate doc paths', async () => {
      const path = Mock.context.toGapicPath('users/user6');
      const [res] = await Mock.client.batchWrite({
        writes: [
          {
            update: {
              name: path,
              fields: Mock.context.serializer.encodeFields({ a: 1 }),
            },
          },
          {
            update: {
              name: path,
              fields: Mock.context.serializer.encodeFields({ b: 2 }),
            },
          },
        ],
      });

      expect(res.writeResults).toHaveLength(2);
      expect(res.status).toHaveLength(2);
      expect(res.status?.every((s) => s.code === Status.OK)).toBe(true);
    });
  });
});

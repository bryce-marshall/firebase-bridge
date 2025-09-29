import { Status } from 'google-gax';
import { MockGapicTestContext, mockGapicTestContext } from '../test-utils';

describe('MockGapicClient.listCollectionIds', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'ListColIdsDB' });
  });

  it('lists all direct subcollection IDs for a document', async () => {
    Mock.db.setDocument('users/user1', { a: 1 });
    Mock.db.setDocument('users/user1/posts/post1', { title: 'One' });
    Mock.db.setDocument('users/user1/comments/comment1', { text: 'Hi' });

    const [collectionIds] = await Mock.client.listCollectionIds({
      parent: Mock.context.toGapicPath('users/user1'),
    });

    expect(collectionIds.sort()).toEqual(['comments', 'posts']);
  });

  it('returns empty array if parent has no subcollections', async () => {
    Mock.db.setDocument('users/user2', { a: 2 });

    const [collectionIds] = await Mock.client.listCollectionIds({
      parent: Mock.context.toGapicPath('users/user2'),
    });

    expect(collectionIds).toEqual([]);
  });

  it('lists subcollections even if parent document does not exist', async () => {
    Mock.db.setDocument('users/user3/posts/post1', { title: 'Ghost post' });

    const [collectionIds] = await Mock.client.listCollectionIds({
      parent: Mock.context.toGapicPath('users/user3'),
    });

    expect(collectionIds).toEqual(['posts']);
  });

  it('throws INVALID_ARGUMENT if parent is missing', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Mock.client.listCollectionIds({ parent: undefined as any })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('throws INVALID_ARGUMENT if parent path is not a document path', async () => {
    // 'users' is a collection, not a document
    await expect(
      Mock.client.listCollectionIds({
        parent: Mock.context.toGapicPath('users'),
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });
});

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Status } from 'google-gax';
import { MockGapicTestContext, mockGapicTestContext } from '../test-utils';

describe('MockGapicClient.listDocuments', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'ListDocsDB' });
  });

  it('lists all documents in a collection', async () => {
    Mock.db.setDocument('users/alice', { name: 'Alice' });
    Mock.db.setDocument('users/bob', { name: 'Bob' });
    Mock.db.setDocument('users/carl', { name: 'Carl' });

    const [res] = await Mock.client.listDocuments({
      parent: Mock.context.toGapicPath(''),
      collectionId: 'users',
    });

    const ids = res.map((doc) =>
      Mock.context.toInternalPath(doc.name!, 'document')
    );
    expect(ids.sort()).toEqual(['users/alice', 'users/bob', 'users/carl']);
  });

  it('returns empty array if collection has no documents', async () => {
    const [res] = await Mock.client.listDocuments({
      parent: Mock.context.toGapicPath(''),
      collectionId: 'emptyCol',
    });
    expect(res).toEqual([]);
  });

  it('includes missing parent documents when showMissing is true', async () => {
    Mock.db.setDocument('users/alice/posts/post1', { title: 'Hello' });

    const [res] = await Mock.client.listDocuments({
      parent: Mock.context.toGapicPath(''),
      collectionId: 'users',
      showMissing: true,
    });

    const ids = res.map((doc) =>
      Mock.context.toInternalPath(doc.name!, 'document')
    );
    expect(ids).toContain('users/alice');
  });

  it('excludes missing parent documents when showMissing is false', async () => {
    Mock.db.setDocument('users/alice/posts/post1', { title: 'Hello' });

    const [res] = await Mock.client.listDocuments({
      parent: Mock.context.toGapicPath(''),
      collectionId: 'users',
      showMissing: false,
    });

    const ids = res.map((doc) =>
      Mock.context.toInternalPath(doc.name!, 'document')
    );
    expect(ids).not.toContain('users/alice');
  });

  it('throws INVALID_ARGUMENT if parent is missing', async () => {
    await expect(
      Mock.client.listDocuments({
        parent: undefined,
        collectionId: 'users',
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });

  it('throws INVALID_ARGUMENT if collectionId is missing', async () => {
    await expect(
      Mock.client.listDocuments({
        parent: Mock.context.toGapicPath(''),
        collectionId: undefined,
      })
    ).rejects.toMatchObject({ code: Status.INVALID_ARGUMENT });
  });
});

import { ExpectError } from '../../../common';
import { mockGapicTestContext, MockGapicTestContext } from '../test-utils';
import { Status } from 'google-gax';

describe('MockGapicClient close tests', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext();
  });

  it('closes the client without error', async () => {
    await expect(Mock.client.close()).resolves.toBeUndefined();
  });

  it('is idempotent', async () => {
    await Mock.client.close();
    await expect(Mock.client.close()).resolves.toBeUndefined();
  });

  describe('rejects all operations if closed', () => {
    beforeEach(async () => {
      await Mock.client.close();
    });

    it('getProjectId', () => {
      expectClosedSync(() => Mock.client.getProjectId());
    });

    it('beginTransaction', () => {
      expectClosedSync(() => Mock.client.beginTransaction({}, {}));
    });

    it('commit', () => {
      expectClosedSync(() => Mock.client.commit({}, {}));
    });

    it('batchWrite', () => {
      expectClosedSync(() => Mock.client.batchWrite({}, {}));
    });

    it('rollback', () => {
      expectClosedSync(() => Mock.client.rollback({}, {}));
    });

    it('batchGetDocuments', () => {
      expectClosedSync(() => Mock.client.batchGetDocuments({}, {}));
    });

    it('runQuery', () => {
      expectClosedSync(() => Mock.client.runQuery({}, {}));
    });

    it('runAggregationQuery', () => {
      expectClosedSync(() => Mock.client.runAggregationQuery({}, {}));
    });

    it('listDocuments', () => {
      expectClosedSync(() =>
        Mock.client.listDocuments({ parent: '', collectionId: '' }, {})
      );
    });

    it('listCollectionIds', () => {
      expectClosedSync(() => Mock.client.listCollectionIds({ parent: '' }, {}));
    });

    it('listen', () => {
      expectClosedSync(() => Mock.client.listen({}));
    });

    it('partitionQueryStream', () => {
      expectClosedSync(() => Mock.client.partitionQueryStream({}, {}));
    });
  });
});

function expectClosedSync(fn: () => unknown): void {
  ExpectError.inline(fn, {
    code: Status.UNAVAILABLE,
    match: /The client has already been closed/,
  });
}

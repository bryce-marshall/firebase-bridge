import { GoogleError, Status } from 'google-gax';
import {
  MockGapicTestContext,
  mockGapicTestContext,
  runAggregationQueryExpectError,
  runAggregationQueryExpectOk,
  runQueryExpectOk,
} from '../test-utils';
import { google } from '../test-utils/google';

type Mode = 'std' | 'agg';

type StandardRequest = Partial<google.firestore.v1.RunQueryRequest>;
type AggregationRequest =
  Partial<google.firestore.v1.RunAggregationQueryRequest>;

type QueryRequest = StandardRequest | AggregationRequest;

pathValidationTests('std', runQueryExpectOk, runAggregationQueryExpectError);
pathValidationTests(
  'agg',
  runAggregationQueryExpectOk,
  runAggregationQueryExpectError
);

function pathValidationTests(
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
  } > path-validation`, () => {
    let Mock!: MockGapicTestContext;

    beforeEach(() => {
      Mock = mockGapicTestContext({ database: 'TestDB' });
    });

    it('rejects when parent is missing', async () => {
      const err = await expectError(Mock, {
        // parent omitted on purpose
        structuredQuery: {
          from: [{ collectionId: 'users' }],
        },
      });

      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects when parent is not a valid resource name (missing /documents suffix)', async () => {
      const err = await expectError(Mock, {
        parent: 'projects/p1/databases/d1', // invalid: no /documents
        structuredQuery: {
          from: [{ collectionId: 'users' }],
        },
      });

      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects when parent is a collection path (not root or document)', async () => {
      // This looks like a collection resource name; parent for runQuery must be
      // either .../documents (root) or a fully-qualified *document* name.
      const err = await expectError(Mock, {
        parent: Mock.context.toGapicPath('users'), // collection path, not allowed
        structuredQuery: {
          from: [{ collectionId: 'orders' }],
        },
      });

      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('accepts a collection query from the database root parent', async () => {
      const request = createRequest(Mock, mode, Mock.context.toGapicPath(''), [
        { collectionId: 'users' },
      ]);
      await expect(expectOk(Mock, request)).resolves.toBeUndefined();
    });

    it('accepts a subcollection query with a document-scoped parent', async () => {
      const request = createRequest(
        Mock,
        mode,
        Mock.context.toGapicPath('tenants/acme'),
        [{ collectionId: 'users' }]
      );
      await expect(expectOk(Mock, request)).resolves.toBeUndefined();
    });

    it('accepts a collection-group query (allDescendants:true) with a document-scoped parent', async () => {
      const request = createRequest(
        Mock,
        mode,
        Mock.context.toGapicPath('tenants/acme'),
        [{ collectionId: 'users', allDescendants: true }]
      );
      await expect(expectOk(Mock, request)).resolves.toBeUndefined();
    });

    it('accepts a database-wide collection-group query from the /documents root', async () => {
      const request = createRequest(Mock, mode, Mock.context.toGapicPath(''), [
        { collectionId: 'users', allDescendants: true },
      ]);
      await expect(expectOk(Mock, request)).resolves.toBeUndefined();
    });

    it('rejects when parent has a trailing slash', async () => {
      const err = await expectError(Mock, {
        parent: Mock.context.toGapicPath('') + '//', // malformed
        structuredQuery: { from: [{ collectionId: 'users' }] },
      });
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects when parent is a malformed resource name (wrong prefix)', async () => {
      const err = await expectError(Mock, {
        parent: `project/${Mock.context.projectId}/databases/${Mock.context.databaseId}/documents`, // "project" vs "projects"
        structuredQuery: { from: [{ collectionId: 'users' }] },
      });
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects when parent projectId does not match the client context', async () => {
      const err = await expectError(Mock, {
        parent: `projects/wrong-proj/databases/${Mock.context.databaseId}/documents`,
        structuredQuery: { from: [{ collectionId: 'users' }] },
      });
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects when parent databaseId does not match the client context', async () => {
      const err = await expectError(Mock, {
        parent: `projects/${Mock.context.projectId}/databases/OtherDB/documents`,
        structuredQuery: { from: [{ collectionId: 'users' }] },
      });
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });

    it('rejects when parent points to a non-document odd/even segment mismatch (collection path)', async () => {
      const err = await expectError(Mock, {
        parent: Mock.context.toGapicPath('users'), // collection path under /documents
        structuredQuery: { from: [{ collectionId: 'orders' }] },
      });
      expect(err.code).toBe(Status.INVALID_ARGUMENT);
    });
  });
}

function createRequest(
  mock: MockGapicTestContext,
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

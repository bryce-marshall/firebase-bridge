import {
  arrayValueTransformer,
  execSingleFilterQuery,
  IndexableFieldType,
  MockGapicTestContext,
  mockGapicTestContext,
  toDefaultDocPaths,
} from '../test-utils';

describe('MockGapicClient.runQuery > temp', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext();
  });

  describe('Integer tests', () => {
    executeSingleFilterTests(() => Mock, 'number');
  });

  describe('String tests', () => {
    executeSingleFilterTests(() => Mock, 'string');
  });

  describe('Timestamp tests', () => {
    executeSingleFilterTests(() => Mock, 'timestamp');
  });

  describe('Geopoint tests', () => {
    executeSingleFilterTests(() => Mock, 'geopoint');
  });

  describe('DocumentReference tests', () => {
    executeSingleFilterTests(() => Mock, 'reference');
  });

  describe('Byte tests', () => {
    executeSingleFilterTests(() => Mock, 'bytes');
  });
});

function executeSingleFilterTests(
  getMock: () => MockGapicTestContext,
  type: IndexableFieldType
): void {
  it('filters with EQUAL', async () => {
    const mock = getMock();
    const docs = await execSingleFilterQuery(mock, type, 'EQUAL', 5);
    expect(docs).toEqual(toDefaultDocPaths(5));
  });

  it('filters with LESS_THAN', async () => {
    const mock = getMock();
    const docs = await execSingleFilterQuery(mock, type, 'LESS_THAN', 3);
    expect(docs).toEqual(toDefaultDocPaths(0, 1, 2));
  });

  it('filters with GREATER_THAN', async () => {
    const mock = getMock();
    const docs = await execSingleFilterQuery(mock, type, 'GREATER_THAN', 6);
    expect(docs).toEqual(toDefaultDocPaths(7, 8, 9));
  });

  it('filters with LESS_THAN_OR_EQUAL', async () => {
    const mock = getMock();
    const docs = await execSingleFilterQuery(
      mock,
      type,
      'LESS_THAN_OR_EQUAL',
      3
    );
    expect(docs).toEqual(toDefaultDocPaths(0, 1, 2, 3));
  });

  it('filters with GREATER_THAN_OR_EQUAL', async () => {
    const mock = getMock();
    const docs = await execSingleFilterQuery(
      mock,
      type,
      'GREATER_THAN_OR_EQUAL',
      7
    );
    expect(docs).toEqual(toDefaultDocPaths(7, 8, 9));
  });

  it('filters with NOT_EQUAL', async () => {
    const mock = getMock();
    const docs = await execSingleFilterQuery(mock, type, 'NOT_EQUAL', 5);
    expect(docs).toEqual(toDefaultDocPaths(0, 1, 2, 3, 4, 6, 7, 8, 9));
  });

  it('filters with ARRAY_CONTAINS', async () => {
    const mock = getMock();
    const docs = await execSingleFilterQuery(
      mock,
      type,
      'ARRAY_CONTAINS',
      5,
      arrayValueTransformer
    );
    expect(docs).toEqual(toDefaultDocPaths(5));
  });

  it('filters with IN', async () => {
    const mock = getMock();
    const docs = await execSingleFilterQuery(mock, type, 'IN', [2, 4, 6]);
    expect(docs).toEqual(toDefaultDocPaths(2, 4, 6));
  });

  it('filters with ARRAY_CONTAINS_ANY', async () => {
    const mock = getMock();
    const docs = await execSingleFilterQuery(
      mock,
      type,
      'ARRAY_CONTAINS_ANY',
      [3, 7],
      arrayValueTransformer
    );
    expect(docs).toEqual(toDefaultDocPaths(3, 7));
  });

  it('filters with NOT_IN', async () => {
    const mock = getMock();
    const docs = await execSingleFilterQuery(mock, type, 'NOT_IN', [2, 4, 6]);
    expect(docs).toEqual(toDefaultDocPaths(0, 1, 3, 5, 7, 8, 9));
  });
}

import {
  createValueRangeDocs,
  IndexableFieldType,
  makeUnaryFilterRequest,
  toDefaultDocPaths,
} from '../test-utils';
import { executeQuery } from '../test-utils/helpers';
import {
  MockGapicTestContext,
  mockGapicTestContext,
} from '../test-utils/mock-factories';

const ALL_TYPES: IndexableFieldType[] = [
  'number',
  'string',
  'timestamp',
  'geopoint',
  'reference',
  'bytes',
];

// Use a non-number type for testing NaN operators against non-integer types.
const NAN_TYPE: IndexableFieldType[] = ['string'];

describe('MockGapicClient.runQuery › unaryFilter (IS_NULL / IS_NAN)', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext();
  });

  ALL_TYPES.forEach((type) => {
    describe(`Null tests (type=${type})`, () => {
      beforeEach(() => {
        createValueRangeDocs(Mock, type);
      });

      it('IS_NULL on maybeNull → matches even indices', async () => {
        const req = makeUnaryFilterRequest(Mock, 'maybeNull', 'IS_NULL');
        const docs = await executeQuery(Mock, req);
        expect(docs).toEqual(toDefaultDocPaths(0, 2, 4, 6, 8));
      });

      it('IS_NOT_NULL on maybeNull → matches odd indices', async () => {
        const req = makeUnaryFilterRequest(Mock, 'maybeNull', 'IS_NOT_NULL');
        const docs = await executeQuery(Mock, req);
        expect(docs).toEqual(toDefaultDocPaths(1, 3, 5, 7, 9));
      });

      it('IS_NULL on a non-nullable scalar (index) → no matches', async () => {
        const req = makeUnaryFilterRequest(Mock, 'index', 'IS_NULL');
        const docs = await executeQuery(Mock, req);
        expect(docs).toEqual([]);
      });
      it('IS_NULL on valueA (always set) → no matches', async () => {
        const req = makeUnaryFilterRequest(Mock, 'valueA', 'IS_NULL');
        const docs = await executeQuery(Mock, req);
        expect(docs).toEqual([]);
      });
    });
  });

  (NAN_TYPE as IndexableFieldType[]).forEach((type) => {
    describe(`NaN tests (using type=${type})`, () => {
      beforeEach(() => {
        createValueRangeDocs(Mock, type);
      });

      it('IS_NAN on maybeNaN → matches even indices', async () => {
        const req = makeUnaryFilterRequest(Mock, 'maybeNaN', 'IS_NAN');
        const docs = await executeQuery(Mock, req);
        expect(docs).toEqual(toDefaultDocPaths(0, 2, 4, 6, 8));
      });

      it('IS_NOT_NAN on maybeNaN → matches odd indices', async () => {
        const req = makeUnaryFilterRequest(Mock, 'maybeNaN', 'IS_NOT_NAN');
        const docs = await executeQuery(Mock, req);
        expect(docs).toEqual(toDefaultDocPaths(1, 3, 5, 7, 9));
      });

      it('IS_NAN on a regular number field (index) → no matches', async () => {
        const req = makeUnaryFilterRequest(Mock, 'index', 'IS_NAN');
        const docs = await executeQuery(Mock, req);
        expect(docs).toEqual([]);
      });

      it('IS_NOT_NAN on a regular number field (index) → all matches', async () => {
        const req = makeUnaryFilterRequest(Mock, 'index', 'IS_NOT_NAN');
        const docs = await executeQuery(Mock, req);
        expect(docs).toEqual(toDefaultDocPaths(0, 1, 2, 3, 4, 5, 6, 7, 8, 9));
      });

      it('IS_NAN on valueA (non-number types should not match) → no matches', async () => {
        const req = makeUnaryFilterRequest(Mock, 'valueA', 'IS_NAN');
        const docs = await executeQuery(Mock, req);
        expect(docs).toEqual([]);
      });
    });
  });
});

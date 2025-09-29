// tests/composite-filter.generic.test.ts
import {
  arrayValueTransformer as arrayEmbed,
  ClauseSpec,
  execCompositeFilterQuery,
  IndexableFieldType,
  toDefaultDocPaths,
} from '../test-utils';
import {
  MockGapicTestContext,
  mockGapicTestContext,
} from '../test-utils/mock-factories';

describe('MockGapicClient.runQuery › compositeFilter', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext();
  });

  (
    [
      'number',
      'string',
      'timestamp',
      'geopoint',
      'reference',
      'bytes',
    ] as IndexableFieldType[]
  ).forEach((type) => {
    describe(`${type} with valueA/valueB + index fields`, () => {
      it('AND: valueA == mapped(5) AND valueB == mapped(4) → only doc5', async () => {
        const specs: ClauseSpec[] = [
          { fieldPath: 'valueA', op: 'EQUAL', type, index: 5 },
          { fieldPath: 'valueB', op: 'EQUAL', type, index: 4 }, // 9-5
        ];
        const docs = await execCompositeFilterQuery(Mock, type, specs, 'AND');
        expect(docs).toEqual(toDefaultDocPaths(5));
      });

      it('AND: index >= 7 AND inverseIndex <= 2 → {7,8,9}', async () => {
        const specs: ClauseSpec[] = [
          { fieldPath: 'index', op: 'GREATER_THAN_OR_EQUAL', literal: 7 },
          { fieldPath: 'inverseIndex', op: 'LESS_THAN_OR_EQUAL', literal: 2 },
        ];
        const docs = await execCompositeFilterQuery(Mock, type, specs, 'AND');
        expect(docs).toEqual(toDefaultDocPaths(7, 8, 9));
      });

      it('AND: ARRAY_CONTAINS(valueA) & >= mapped(index) → {index}', async () => {
        const specs: ClauseSpec[] = [
          {
            fieldPath: 'valueA',
            op: 'ARRAY_CONTAINS_ANY',
            type,
            index: [1, 3, 5, 8, 9],
            valueTransformer: arrayEmbed,
          },
          {
            fieldPath: 'index',
            op: 'GREATER_THAN_OR_EQUAL',
            type,
            literal: 6,
          },
        ];
        const docs = await execCompositeFilterQuery(
          Mock,
          type,
          specs,
          'AND',
          arrayEmbed
        );
        expect(docs).toEqual(toDefaultDocPaths(8, 9));
      });

      it('OR (if supported): valueA == mapped(2) OR valueB == mapped(2) → {2,7}', async () => {
        const specs: ClauseSpec[] = [
          { fieldPath: 'valueA', op: 'EQUAL', type, index: 2 },
          { fieldPath: 'valueB', op: 'EQUAL', type, index: 2 }, // which corresponds to doc7 via inverse
        ];
        const docs = await execCompositeFilterQuery(Mock, type, specs, 'OR');
        expect(docs).toEqual(toDefaultDocPaths(2, 7));
      });

      it('OR (if supported): IN on index OR >= mapped(8) → {1,3,8,9}', async () => {
        const specs: ClauseSpec[] = [
          { fieldPath: 'index', op: 'IN', literal: [1, 3] },
          { fieldPath: 'valueA', op: 'GREATER_THAN_OR_EQUAL', type, index: 8 },
        ];
        const docs = await execCompositeFilterQuery(Mock, type, specs, 'OR');
        expect(docs).toEqual(toDefaultDocPaths(1, 3, 8, 9));
      });

      it('AND (negative): index < 3 AND inverseIndex < 3 → {}', async () => {
        const specs: ClauseSpec[] = [
          { fieldPath: 'index', op: 'LESS_THAN', literal: 3 },
          { fieldPath: 'inverseIndex', op: 'LESS_THAN', literal: 3 },
        ];
        const docs = await execCompositeFilterQuery(Mock, type, specs, 'AND');
        expect(docs).toEqual([]);
      });
    });
  });
});

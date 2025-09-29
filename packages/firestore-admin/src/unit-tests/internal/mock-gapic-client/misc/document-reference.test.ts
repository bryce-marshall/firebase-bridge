import { DocumentReference } from 'firebase-admin/firestore';
import { compareValues } from '../../../../lib/_internal/mock-gapic-client/utils/compare-values';
import { mockGapicTestContext, MockGapicTestContext } from '../test-utils';
import { google } from '../test-utils/google';

const RELATIVE_SENTINEL_PATH = 'col1/doc1/col2/__id-9223372036854775808__';

const RELATIVE_SENTINEL_PATH_WILDCARD =
  'col1/doc1/col2\u0000/__id-9223372036854775808__';

const SENTINEL_PATH =
  'projects/[DEFAULT]/databases/(default)/documents/col1/doc1/col2/__id-9223372036854775808__';
const SENTINEL_PATH_WILDCARD =
  'projects/[DEFAULT]/databases/(default)/documents/col1/doc1/col2\u0000/__id-9223372036854775808__';

describe('MockGapicClient DocumentReference tests', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext();
  });

  it('Create NumbericId sentinel DocumentReference from relative path', () => {
    const docRef1 = Mock.firestore.doc(
      'col1/doc1/col2/__id-9223372036854775808__'
    );
    expect(docRef1).toBeDefined();
    const docRef2 = Mock.firestore.doc(
      'col1/doc1/col2\u0000/__id-9223372036854775808__'
    );
    expect(docRef2).toBeDefined();
  });

  it('Create NumbericId sentinel DocumentReference from referenceValue', () => {
    const value1: google.firestore.v1.IValue = {
      referenceValue: SENTINEL_PATH,
    };

    const value2: google.firestore.v1.IValue = {
      referenceValue: SENTINEL_PATH_WILDCARD,
    };
    const docRef1 = Mock.context.serializer.decodeValue(
      value1
    ) as DocumentReference;
    expect(docRef1).toBeDefined();
    const docRef2 = Mock.context.serializer.decodeValue(
      value2
    ) as DocumentReference;
    expect(docRef2).toBeDefined();
  });

  it('Relative and absolute sentinel paths are equal', () => {
    const value1: google.firestore.v1.IValue = {
      referenceValue: SENTINEL_PATH,
    };
    const docRef1 = Mock.context.serializer.decodeValue(
      value1
    ) as DocumentReference;
    const docRef2 = Mock.firestore.doc(RELATIVE_SENTINEL_PATH);
    expectEqual(docRef1, docRef2);
  });

  it('Relative and absolute wildcard sentinel paths are equal', () => {
    const value1: google.firestore.v1.IValue = {
      referenceValue: SENTINEL_PATH_WILDCARD,
    };
    const docRef1 = Mock.context.serializer.decodeValue(
      value1
    ) as DocumentReference;
    const docRef2 = Mock.firestore.doc(RELATIVE_SENTINEL_PATH_WILDCARD);
    expectEqual(docRef1, docRef2);
  });

  it('Resolves NumericId sentinel comparisons', async () => {
    const sentinelRef = Mock.firestore.doc(RELATIVE_SENTINEL_PATH);
    const docRef1 = Mock.firestore.doc('col1/doc1/col2/doc2');
    expectLessThan(sentinelRef, docRef1);
    const docRef2 = Mock.firestore.doc('col1/doc1');
    expectGreaterThan(sentinelRef, docRef2);
    const docRef3 = Mock.firestore.doc('col1/doc1/col2/doc2/col3/doc3');
    expectLessThan(sentinelRef, docRef3);
  });

  it('Resolves NumericId sentinel wildcard comparisons', async () => {
    const sentinelRef = Mock.firestore.doc(RELATIVE_SENTINEL_PATH_WILDCARD);
    const docRef1 = Mock.firestore.doc('col1/doc1/col2/doc2');
    expectGreaterThan(sentinelRef, docRef1);
    const docRef2 = Mock.firestore.doc('col1/doc1');
    expectGreaterThan(sentinelRef, docRef2);
    const docRef3 = Mock.firestore.doc('col1/doc1/col2/doc2/col3/doc3');
    expectGreaterThan(sentinelRef, docRef3);
  });

  it('Wildcard sentinel sorts before sibling prefix col12/**', () => {
    const hi = Mock.firestore.doc(RELATIVE_SENTINEL_PATH_WILDCARD);
    const sibling = Mock.firestore.doc('col12/docX');
    // hi < 'col12/...'
    expectLessThan(hi, sibling);
  });

  it('Numeric-id order is by BigInt', () => {
    const lo = Mock.firestore.doc('col1/doc1/col2/__id-2__');
    const hi = Mock.firestore.doc('col1/doc1/col2/__id-1__');
    expectLessThan(lo, hi);
  });
});

/**
 * Expects `a` to be less-than `b`
 */
function expectLessThan(a: DocumentReference, b: DocumentReference): void {
  expectDefined(a, b);
  expect(compareValues(a, b)).toBeLessThan(0);
}

/**
 * Expects `a` to be greater-than `b`
 */
function expectGreaterThan(a: DocumentReference, b: DocumentReference): void {
  expectDefined(a, b);
  expect(compareValues(a, b)).toBeGreaterThan(0);
}

/**
 * Expects `a` to be equal to `b`
 */
function expectEqual(a: DocumentReference, b: DocumentReference): void {
  expectDefined(a, b);
  expect(compareValues(a, b)).toBe(0);
}

function expectDefined(a: DocumentReference, b: DocumentReference): void {
  expect(a).toBeDefined();
  expect(b).toBeDefined();
}

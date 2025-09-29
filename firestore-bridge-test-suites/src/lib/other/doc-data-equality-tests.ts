import {
  DocumentData,
  DocumentReference,
  Firestore,
  GeoPoint,
  Timestamp,
} from 'firebase-admin/firestore';
import { isDocDataEqual } from '../helpers/document-data.js';
import { FirestoreBridgeTestContext } from '../test-context.js';

const DEFAULT_DATE = new Date(2020, 4, 5, 15, 24, 23, 678);

export function docDataEqualityTests(context: FirestoreBridgeTestContext) {
  describe('Doc Data Equality Tests', () => {
    let Firestore: Firestore;

    function isEqual(
      x: DocumentData | undefined | null,
      y: DocumentData | undefined | null
    ): boolean {
      return isDocDataEqual(x, y);
    }

    function fieldPairTest(f1: unknown, f2: unknown): boolean {
      return isEqual({ f1 }, { f2 });
    }

    beforeAll(async () => {
      Firestore = await context.init();
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('returns true for empty data', () => {
      expect(isEqual({}, {})).toBe(true);
    });

    it('returns true for undefined data', () => {
      expect(isEqual(undefined, undefined)).toBe(true);
    });

    it('returns true for null data', () => {
      expect(isEqual(null, null)).toBe(true);
    });

    it('returns false for null/undefined data', () => {
      expect(isEqual(null, undefined)).toBe(false);
      expect(isEqual(undefined, null)).toBe(false);
    });

    it('returns true for simple field value data', () => {
      const x = simpleFieldValues();
      const y = simpleFieldValues();
      expect(isEqual(x, y)).toBe(true);
    });

    it('returns true for typed field value data', () => {
      const x = typedFieldValues(Firestore);
      const y = typedFieldValues(Firestore);
      expect(isEqual(x, y)).toBe(true);
    });

    it('returns false for primitive field value differences', () => {
      expect(fieldPairTest('a', 'b')).toBe(false);
      expect(fieldPairTest(5, 6)).toBe(false);
      expect(fieldPairTest(true, false)).toBe(false);
      expect(fieldPairTest(false, true)).toBe(false);
      // Ensure it doesn't evaluate `truthy` values as boolean
      expect(fieldPairTest(false, 0)).toBe(false);
      expect(fieldPairTest(true, 1)).toBe(false);
      expect(fieldPairTest(true, 'true')).toBe(false);
      expect(fieldPairTest(true, {})).toBe(false);
      expect(fieldPairTest(false, undefined)).toBe(false);
      expect(fieldPairTest(false, null)).toBe(false);
    });

    it('expects false for typed field value differences', () => {
      expect(isEqual(new GeoPoint(1, 2), new GeoPoint(2, 1))).toBe(false);
      expect(isEqual(new GeoPoint(-1, -1), new GeoPoint(1, 1))).toBe(false);

      expect(
        isEqual(Firestore.doc('col1/doc1'), Firestore.doc('col1/doc11'))
      ).toBe(false);

      expect(isEqual(Timestamp.fromMillis(0), Timestamp.fromMillis(1))).toBe(
        false
      );
    });

    it('returns false for primitive field array element differences', () => {
      expect(fieldPairTest(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
      expect(fieldPairTest(['a', 'b'], ['b', 'a'])).toBe(false);
      expect(fieldPairTest(['a', 'b'], ['a', 'c'])).toBe(false);
      expect(fieldPairTest(['a', 'b'], ['c', 'b'])).toBe(false);

      expect(fieldPairTest([1, 2], [1, 2, 3])).toBe(false);
      expect(fieldPairTest([1, 2], [2, 1])).toBe(false);
      expect(fieldPairTest([1, 2], [1, 3])).toBe(false);
      expect(fieldPairTest([1, 2], [3, 2])).toBe(false);

      expect(fieldPairTest([true, false], [true, false, true])).toBe(false);
      expect(fieldPairTest([true, false], [false, true])).toBe(false);
      expect(fieldPairTest([true, false], [true, true])).toBe(false);
      expect(fieldPairTest([false, true], [false, false])).toBe(false);

      // Ensure it doesn't evaluate `truthy` values as boolean
      expect(fieldPairTest([true, false], [1, false])).toBe(false);
      expect(fieldPairTest([true, false], [true, 0])).toBe(false);
      expect(fieldPairTest([false, false], [0, 0])).toBe(false);
      expect(fieldPairTest([true, true], [1, 1])).toBe(false);
      expect(fieldPairTest([false, false], [undefined, undefined])).toBe(false);
      expect(fieldPairTest([true, true], ['true', 'true'])).toBe(false);
    });
  });
}

interface SimpleFieldValues {
  a: string;
  b: number;
  c: number;
  d: boolean;
  e: boolean;
  f: object;
  g: (string | number | boolean)[];
  h: {
    ga: object;
    gb: boolean;
    gc: boolean;
    gd: number;
    ge: number;
    gf: string;
  };
}

interface TypedFieldValues {
  i: Timestamp;
  j: GeoPoint;
  k: DocumentReference;
  l: (Timestamp | GeoPoint | DocumentReference)[];
}

export function typedFieldValues(firestore: Firestore): TypedFieldValues {
  return {
    i: Timestamp.fromDate(DEFAULT_DATE),
    j: new GeoPoint(83, 126),
    k: firestore.doc('col1/doc1/col2/doc2'),
    l: [
      firestore.doc('col2/doca/col3/docb'),
      new GeoPoint(17, 99),
      Timestamp.fromDate(DEFAULT_DATE),
    ],
  };
}

function simpleFieldValues(): SimpleFieldValues {
  return {
    a: 'field-a',
    b: 543321,
    c: 0.9876,
    d: true,
    e: false,
    f: {},
    g: ['a', 3, 'b', 2, 'c', true, 'd', false],
    h: {
      ga: {},
      gb: false,
      gc: true,
      gd: 0.432,
      ge: 876,
      gf: 'field-a.gf',
    },
  };
}

import {
  DocumentReference,
  GeoPoint,
  Timestamp,
} from 'firebase-admin/firestore';
import { google } from './google';
import { isInequalityOperator } from './helpers';
import { MockGapicTestContext } from './mock-factories';

export const DEFAULT_ROOT_COLLECTION = 'col1';
export const DEFAULT_DOC_PREFIX = 'doc';

const INDEX_LBOUND = 0;
const INDEX_UBOUND = 9;

export interface QueryTestDocument<
  T extends IndexableFieldValue,
  TValue extends T | T[]
> {
  description: string;
  valueA: TValue;
  valueB: TValue;
  maybeNull: TValue | null;
  index: number;
  inverseIndex: number;
  maybeNaN: number;
}

type MapperFunction<T extends IndexableFieldValue = IndexableFieldValue> = (
  index: number
) => T;

export interface ValueTransformerArg<
  T extends IndexableFieldValue = IndexableFieldValue
> {
  type: IndexableFieldType;
  index: number;
  fieldValue: T;
  map(ordinal: number): T;
}

// Values allowed in fieldFilter comparisons (==, !=, <, <=, >, >=, in, not-in)
export type IndexableFieldValue =
  | null
  | boolean
  | number // integers & doubles (incl. NaN/±Infinity handling per Firestore)
  | string
  | Timestamp
  | GeoPoint
  | Uint8Array // bytes/blob
  | DocumentReference;

// String tags (handy for parametrized tests)
export type IndexableFieldType =
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'timestamp'
  | 'geopoint'
  | 'bytes'
  | 'reference';

export type CompositeOp =
  google.firestore.v1.StructuredQuery.CompositeFilter.Operator;

export interface ClauseSpec<
  T extends IndexableFieldValue = IndexableFieldValue
> {
  /** Field to filter on. Use 'valueA' | 'valueB' | 'index' | 'inverseIndex' (or any field you seeded). */
  fieldPath: string;

  /** Operator (EQUAL, IN, ARRAY_CONTAINS, etc.). */
  op: google.firestore.v1.StructuredQuery.FieldFilter.Operator;

  /**
   * Choose ONE of the following inputs:
   * 1) mapped values: provide `type` and `index` (number or number[]) to use canonical mappers;
   * 2) literal: provide concrete Firestore value(s) (bypasses mapping entirely).
   */
  type?: IndexableFieldType;
  index?: number | number[];
  literal?: IndexableFieldValue | IndexableFieldValue[];

  /** Optional per-clause transformer (e.g., arrayEmbed) applied to mapped single values. */
  valueTransformer?: (arg: ValueTransformerArg<T>) => T | T[];
}

export function defaultDocPath(value: IndexableFieldValue): string {
  return `${DEFAULT_ROOT_COLLECTION}/${DEFAULT_DOC_PREFIX}${indexFromValue(
    value
  )}`;
}

export function toDefaultDocPaths(...values: IndexableFieldValue[]): string[] {
  return values.map((v) => defaultDocPath(v));
}

export function createValueRangeDocs<
  T extends IndexableFieldValue = IndexableFieldValue
>(
  mock: MockGapicTestContext,
  type: IndexableFieldType,
  valueTransformer?: (arg: ValueTransformerArg<T>) => T | T[]
): void {
  const map = mapperFn(mock, type) as MapperFunction<T>;

  function transformValue(ordinal: number): T | T[] {
    if (!valueTransformer) return map(ordinal) as T;

    return valueTransformer({
      type,
      fieldValue: map(ordinal) as T,
      index: ordinal,
      map,
    });
  }

  const baseDocName = `${DEFAULT_ROOT_COLLECTION}/${DEFAULT_DOC_PREFIX}`;
  for (let index = INDEX_LBOUND; index <= INDEX_UBOUND; index++) {
    const inverseIndex = INDEX_UBOUND - index;
    const valueA = transformValue(index) as T;
    const isOdd = index % 2;
    const doc: QueryTestDocument<T, T> = {
      description: `Test document ${index}`,
      valueA,
      valueB: transformValue(inverseIndex) as T,
      maybeNull: isOdd ? valueA : null,
      index,
      inverseIndex,
      maybeNaN: isOdd ? index : NaN,
    };

    mock.db.setDocument(`${baseDocName}${index}`, doc);
  }
}

export function makeSingleFilter(
  mock: MockGapicTestContext,
  type: IndexableFieldType,
  op: google.firestore.v1.StructuredQuery.FieldFilter.Operator,
  index: number | number[]
): google.firestore.v1.IRunQueryRequest {
  assertIndexBounds(index);
  const mapper = mapperFn(mock, type);
  const value = Array.isArray(index)
    ? index.map((i) => mapper(i))
    : mapper(index);

  const r: google.firestore.v1.IRunQueryRequest = {
    parent: mock.context.gapicRoot, // root /documents path
    structuredQuery: {
      from: [{ collectionId: DEFAULT_ROOT_COLLECTION }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'valueA' },
          op,
          value: mock.context.serializer.encodeValue(value),
        },
      },
    },
  };

  if (isInequalityOperator(op)) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    r.structuredQuery!.orderBy = [{ field: { fieldPath: 'valueA' } }];
  }

  return r;
}

export function indexableFieldTypeFromValue(
  value: IndexableFieldValue
): IndexableFieldType {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'object':
      if (value instanceof Timestamp) return 'timestamp';
      if (value instanceof GeoPoint) return 'geopoint';
      // Buffer extends Uint8Array, so this covers both.
      if (value instanceof Uint8Array) return 'bytes';
      if (value instanceof DocumentReference) return 'reference';
      break;
  }

  // All other primitives are excluded by the IndexableFieldValue union.
  // This path should be unreachable.
  throw new Error(`Unsupported value type: ${typeof value}`);
}

function mapperFn(
  mock: MockGapicTestContext,
  type: IndexableFieldType
): MapperFunction {
  switch (type) {
    case 'boolean':
      return (n) => n % 2 === 1;

    case 'string':
      // Cycle A–Z then a–z (52 chars total).
      return (n) => String.fromCharCode(65 + (n % 52));

    case 'number':
      return (n) => n;

    case 'null':
      return () => null;

    case 'timestamp':
      // Create increasing timestamps (seconds = index, nanos = 0).
      return (n) => Timestamp.fromMillis(n * 1000);

    case 'geopoint':
      // Deterministic, valid lat/lng within bounds.
      return (n) => new GeoPoint((n % 10) - 5, ((n * 3) % 10) - 5);

    case 'bytes':
      // Single-byte payload varying by index.
      return (n) => Uint8Array.from([n & 0xff]);

    case 'reference':
      return (n) => mock.firestore.doc(`testDocs/doc${n}`);

    default: {
      // Should be unreachable if IndexableFieldType is exhaustive.
      // Keeps the compiler happy if the union grows in future.
      const _exhaustive: never = type;
      throw new Error(`Non-indexable type "${_exhaustive}"`);
    }
  }
}

function indexFromValue(value: IndexableFieldValue): number {
  // Normalize to a small non-negative integer for doc suffixing.
  const hashString = (s: string) =>
    Array.from(s).reduce((a, c) => (a + c.charCodeAt(0)) | 0, 0);

  function extractTrailingInt(input: unknown): number | undefined {
    if (typeof input !== 'string') return undefined;

    const match = input.match(/(\d+)$/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  switch (typeof value) {
    case 'number':
      return value; // numbers from mapperFn('number') are already 0..9

    case 'boolean':
      return value ? 1 : 0;

    case 'string':
      return value.length > 0 ? value.charCodeAt(0) % 52 : 0;

    case 'object': {
      if (value === null) return 0;

      if (value instanceof Timestamp) {
        // Use seconds component; stays monotonic for our mapper.
        return Math.abs(Math.floor(value.seconds)) % 10;
      }

      if (value instanceof GeoPoint) {
        // Combine lat/lng deterministically.
        const n =
          Math.round((value.latitude + 90) * 1000) +
          Math.round((value.longitude + 180) * 1000);
        return Math.abs(n) % 10;
      }

      if (isBytes(value)) {
        // First byte if present, else 0.
        return value.length ? value[0] : 0;
      }

      // DocumentReference (or any object with id/path-ish fields)
      // Prefer id, then path; fall back to toString().
      return (
        extractTrailingInt(value.id ?? value.path) ??
        Math.abs(hashString(String(value)))
      );
    }

    default:
      throw new Error(`Non-indexable value "${String(value)}"`);
  }
}

function assertIndexBounds(index: number | number[]): void {
  if (Array.isArray(index)) {
    for (const i of index) {
      assertIndexBounds(i);
    }
  } else if (index < INDEX_LBOUND || index > INDEX_UBOUND) {
    throw new Error(
      `The index must be >= ${INDEX_LBOUND} && <= ${INDEX_UBOUND}`
    );
  }
}

type BytesLike = Uint8Array | ArrayBuffer | Buffer;

function isBytes(v: unknown): v is BytesLike {
  return (
    v instanceof Uint8Array ||
    v instanceof ArrayBuffer ||
    (typeof Buffer !== 'undefined' && v instanceof Buffer)
  );
}

export function makeCompositeFilterRequest(
  mock: MockGapicTestContext,
  specs: ClauseSpec[],
  compositeOp: CompositeOp = 'AND'
): google.firestore.v1.IRunQueryRequest {
  if (!specs.length) throw new Error('At least one clause is required.');

  const filters = specs.map((s) => encodeClause(mock, s));

  const rq: google.firestore.v1.IRunQueryRequest = {
    parent: mock.context.gapicRoot,
    structuredQuery: {
      from: [{ collectionId: DEFAULT_ROOT_COLLECTION }],
      where: { compositeFilter: { op: compositeOp, filters } },
    },
  };

  // If any inequality is present, add orderBy on that field (mirrors single-filter helper).
  const firstIneq = specs.find((s) => isInequalityOperator(s.op));
  if (firstIneq) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    rq.structuredQuery!.orderBy = [
      { field: { fieldPath: firstIneq.fieldPath } },
    ];
  }

  return rq;
}

function encodeClause(
  mock: MockGapicTestContext,
  clause: ClauseSpec
): google.firestore.v1.StructuredQuery.IFilter {
  const value = resolveValue(mock, clause);
  return {
    fieldFilter: {
      field: { fieldPath: clause.fieldPath },
      op: clause.op,
      value: mock.context.serializer.encodeValue(value),
    },
  };
}

function resolveValue(
  mock: MockGapicTestContext,
  clause: ClauseSpec
): IndexableFieldValue | IndexableFieldValue[] {
  // 1) Literal wins (perfect for index/inverseIndex numeric filters)
  if (clause.literal !== undefined) return clause.literal;

  // 2) Mapped values
  const { type, index, valueTransformer } = clause;
  if (!type || index === undefined) {
    throw new Error(
      `Clause requires either 'literal' or both 'type' and 'index': ${JSON.stringify(
        clause
      )}`
    );
  }

  const map = mapperFn(mock, type);

  // Array-valued clauses (IN / ARRAY_CONTAINS_ANY) commonly pass an index[]
  if (Array.isArray(index)) {
    // For array ops, we usually want the raw list of mapped values.
    return index.map((i) => map(i) as IndexableFieldValue);
  }

  // Single-valued clause; allow a transformer to wrap it (e.g., arrayEmbed)
  const base = map(index) as IndexableFieldValue;
  if (!valueTransformer) return base;

  const arg: ValueTransformerArg = {
    type,
    index,
    fieldValue: base,
    map: map as (n: number) => IndexableFieldValue,
  };

  return valueTransformer(arg) as IndexableFieldValue | IndexableFieldValue[];
}

export function arrayValueTransformer(
  arg: ValueTransformerArg
): IndexableFieldValue[] {
  switch (arg.type) {
    case 'boolean':
      break;

    case 'geopoint':
      break;

    case 'null':
      break;

    case 'number':
      return [97, 98, 99, arg.fieldValue, 101, 102];

    case 'bytes':
    case 'reference':
      return [
        arg.map(97),
        arg.map(98),
        arg.map(99),
        arg.fieldValue,
        arg.map(101),
        arg.map(102),
      ];
      break;

    case 'string':
      return ['vv', 'ww', 'xx', arg.fieldValue, 'yy', 'zz'];

    case 'timestamp':
      return [
        Timestamp.fromMillis(100),
        Timestamp.fromMillis(200),
        arg.fieldValue,
        Timestamp.fromMillis(300),
        Timestamp.fromMillis(400),
      ];
  }

  return [arg.fieldValue];
}

export type UnaryOp = google.firestore.v1.StructuredQuery.UnaryFilter.Operator;

export function makeUnaryFilterRequest(
  Mock: MockGapicTestContext,
  fieldPath: string,
  op: UnaryOp
): google.firestore.v1.IRunQueryRequest {
  return {
    parent: Mock.context.gapicRoot,
    structuredQuery: {
      from: [{ collectionId: DEFAULT_ROOT_COLLECTION }],
      where: {
        unaryFilter: {
          op,
          field: { fieldPath },
        },
      },
    },
  };
}

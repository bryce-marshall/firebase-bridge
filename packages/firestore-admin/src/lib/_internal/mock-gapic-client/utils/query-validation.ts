import type { google } from '@gcf/firestore-protos';
import { Status } from 'google-gax';
import { googleError } from '../../functions/google-error.js';
import {
  assertInstanceOf,
  assertMutuallyExclusive,
  assertNotEmpty,
  assertRequestArgumentNotSupported,
} from './assert.js';

/**
 * Validates request-level invariants common to both `RunQuery` and
 * `RunAggregationQuery`.
 *
 * Enforced rules:
 * - `explainOptions` are **not supported** by the mock (kept unsupported for fidelity).
 * - Exactly one of `readTime`, `transaction`, or `newTransaction` may be set
 *   (mutually exclusive pairs are checked).
 * - If `transaction` is present, it must be a non-empty `Uint8Array`.
 *
 * @param request - A GAPIC `IRunQueryRequest` or `IRunAggregationQueryRequest`.
 * @throws {GoogleError} (`INVALID_ARGUMENT` / `UNIMPLEMENTED`) if validation fails.
 */
export function validateCommonQueryRequest(
  request:
    | google.firestore.v1.IRunQueryRequest
    | google.firestore.v1.IRunAggregationQueryRequest
): void {
  // Explain is not supported in the mock for fidelity
  assertRequestArgumentNotSupported('explainOptions', request.explainOptions);
  assertMutuallyExclusive(
    'readTime',
    request.readTime,
    'transaction',
    request.transaction
  );
  assertMutuallyExclusive(
    'transaction',
    request.transaction,
    'newTransaction',
    request.newTransaction
  );
  assertMutuallyExclusive(
    'readTime',
    request.readTime,
    'newTransaction',
    request.newTransaction
  );
  assertInstanceOf(
    'transaction',
    'Uint8Array',
    request.transaction,
    Uint8Array,
    false
  );
  assertNotEmpty('transaction', request.transaction, false);
}

/** Shortcut alias for `StructuredQuery.Direction`. */
export type Dir = google.firestore.v1.StructuredQuery.Direction;
/** Shortcut alias for `StructuredQuery.FieldFilter.Operator`. */
export type Op = google.firestore.v1.StructuredQuery.FieldFilter.Operator;

/**
 * Pre-parsed details for array-valued operands used by `IN`, `NOT_IN`,
 * and `ARRAY_CONTAINS_ANY`.
 */
export interface ArrayOperandInfo {
  op: 'IN' | 'NOT_IN' | 'ARRAY_CONTAINS_ANY';
  vals: google.firestore.v1.IValue[];
  size: number;
  hasNull: boolean;
  hasNaN: boolean;
  typeTags: Set<
    | 'null'
    | 'nan'
    | 'number'
    | 'string'
    | 'boolean'
    | 'timestamp'
    | 'reference'
    | 'geo'
    | 'bytes'
    | 'map'
    | 'array'
  >;
  refDbKeys: Set<string | undefined>; // for reference DB consistency
  hasStructured: boolean; // array/map present
}

/**
 * Aggregate view of a StructuredQuery used for validation and later planning.
 */
export interface QueryValidationData {
  // Operators & counts
  /** All operators observed in `where` (set). */
  ops: Set<Op>;
  /** Per-operator counts used for simple cardinality checks. */
  opCounts: {
    IN: number;
    NOT_IN: number;
    ARRAY_CONTAINS_ANY: number;
    ARRAY_CONTAINS: number;
    NOT_EQUAL: number;
    LT: number;
    LTE: number;
    GT: number;
    GTE: number;
  };

  // Derived flags
  /** Whether any `IN` operator is present. */
  hasIn: boolean;
  /** Whether any `NOT_IN` operator is present. */
  hasNotIn: boolean;
  /** Whether any `!=` operator is present. */
  hasNotEqual: boolean;
  /** Whether any bounded inequality (`<`, `<=`, `>`, `>=`) exists. */
  hasBoundedInequality: boolean;
  /** Whether any inequality exists (`bounded` OR `!=` OR `NOT_IN`). */
  hasAnyInequality: boolean;

  // Fields
  /** Distinct fields appearing in inequalities (sorted). */
  inequalityFields: string[];
  /** Fields listed in client-specified `orderBy`. */
  orderByFields: string[];
  /** First client-specified orderBy field, if any. */
  firstOrderByField?: string;
  /** `true` if any orderBy was provided. */
  hasOrderBy: boolean;

  // Direction inheritance context (from client-specified orderBy)
  /** Last explicit direction encountered (ignores `DIRECTION_UNSPECIFIED`). */
  lastExplicitDirection: Dir;
  /** `true` if any orderBy item specified a direction. */
  orderByHasExplicitDirection: boolean;

  // Array-operand audits for IN / NOT_IN / ARRAY_CONTAINS_ANY
  /** One entry per array-valued operand encountered. */
  arrayOperands: ArrayOperandInfo[];
  /** `true` if any array operand is empty. */
  anyArrayOpEmpty: boolean;
  /** `true` if any array operand exceeds 10 elements. */
  anyArrayOpTooLarge: boolean;
  /** `true` if any array operand contains `null` or `NaN`. */
  anyArrayHasNullOrNaN: boolean;

  // -------------------------
  // Vector / FindNearest audit
  // -------------------------

  /** Field path targeted by `findNearest.vectorField`. */
  vectorFieldPath?: string;

  /** Shape audit for `findNearest.queryVector` (length & numeric checks). */
  vectorQueryShape?: {
    length: number;
    hasNaN: boolean;
    hasNull: boolean;
    /** `true` if all elements are finite numbers (ints/doubles, no NaN). */
    valid: boolean;
  };

  /** Distance measure specified (enum string). */
  distanceMeasure?: string;
  /** `true` if `distanceMeasure` is recognized/supported (or unspecified). */
  hasValidDistanceMeasure: boolean;
  /** Optional non-negative threshold. */
  distanceThreshold?: number;
  /** Optional field path to write the distance score into. */
  distanceResultField?: string;

  /** `true` if `findNearest` is present. */
  hasFindNearest: boolean;
  /** `true` if query-vector length exceeds 2048. */
  vectorLengthExceeded?: boolean;
  /** `true` if `findNearest.limit` exceeds 1000. */
  vectorLimitExceeded?: boolean;
}

/**
 * Extracts and summarizes validation-relevant info from a StructuredQuery.
 * Produces counts, flags, field sets, and audits for array operands and
 * `findNearest` options to enable precise error messaging elsewhere.
 *
 * This function does **not** throw; callers should apply dedicated validators.
 *
 * @param query - The StructuredQuery to analyze.
 * @returns A populated {@link QueryValidationData}.
 */
export function buildQueryValidationData(
  query: google.firestore.v1.IStructuredQuery
): QueryValidationData {
  const orderBy = query.orderBy ?? [];
  const orderByFields = orderBy
    .map((o) => o.field?.fieldPath)
    .filter((s): s is string => !!s);

  // Track last explicit direction for inheritance
  let lastExplicitDirection: Dir = 'ASCENDING';
  let orderByHasExplicitDirection = false;
  for (const o of orderBy) {
    if (o.direction && o.direction !== 'DIRECTION_UNSPECIFIED') {
      lastExplicitDirection = o.direction;
      orderByHasExplicitDirection = true;
    }
  }

  const ops = new Set<Op>();
  const opCounts = {
    IN: 0,
    NOT_IN: 0,
    ARRAY_CONTAINS_ANY: 0,
    ARRAY_CONTAINS: 0,
    NOT_EQUAL: 0,
    LT: 0,
    LTE: 0,
    GT: 0,
    GTE: 0,
  };

  const inequalityFieldSet = new Set<string>();
  const arrayOperands: QueryValidationData['arrayOperands'] = [];

  const getArray = (v?: google.firestore.v1.IValue | null) =>
    v?.arrayValue?.values ?? [];
  const isNaNVal = (v: google.firestore.v1.IValue) =>
    'doubleValue' in v &&
    v.doubleValue != null &&
    Number.isNaN(v.doubleValue as number);

  const classifyValue = (v: google.firestore.v1.IValue) => {
    if ('nullValue' in v) return { tag: 'null' as const };
    if ('booleanValue' in v) return { tag: 'boolean' as const };
    if ('integerValue' in v) return { tag: 'number' as const };
    if ('doubleValue' in v)
      return { tag: isNaNVal(v) ? ('nan' as const) : ('number' as const) };
    if ('stringValue' in v) return { tag: 'string' as const };
    if ('timestampValue' in v) return { tag: 'timestamp' as const };
    if ('bytesValue' in v) return { tag: 'bytes' as const };
    if ('geoPointValue' in v) return { tag: 'geo' as const };
    if ('arrayValue' in v) return { tag: 'array' as const };
    if ('mapValue' in v) return { tag: 'map' as const };
    if ('referenceValue' in v) {
      const ref = v.referenceValue ?? '';
      const m = ref.match(/^projects\/([^/]+)\/databases\/([^/]+)\//);
      return {
        tag: 'reference' as const,
        dbKey: m ? `${m[1]}/${m[2]}` : undefined,
      };
    }
    return { tag: 'map' as const };
  };

  const walk = (f?: google.firestore.v1.StructuredQuery.IFilter | null) => {
    if (!f) return;

    if (f.compositeFilter) {
      for (const sub of f.compositeFilter.filters ?? []) walk(sub);
      return;
    }

    if (f.fieldFilter) {
      const op = f.fieldFilter.op as Op | undefined;
      const path = f.fieldFilter.field?.fieldPath ?? undefined;
      const val = f.fieldFilter.value ?? undefined;

      if (op) {
        ops.add(op);
        switch (op) {
          case 'IN':
            opCounts.IN++;
            break;
          case 'NOT_IN':
            opCounts.NOT_IN++;
            break;
          case 'ARRAY_CONTAINS_ANY':
            opCounts.ARRAY_CONTAINS_ANY++;
            break;
          case 'ARRAY_CONTAINS':
            opCounts.ARRAY_CONTAINS++;
            break;
          case 'NOT_EQUAL':
            opCounts.NOT_EQUAL++;
            break;
          case 'LESS_THAN':
            opCounts.LT++;
            break;
          case 'LESS_THAN_OR_EQUAL':
            opCounts.LTE++;
            break;
          case 'GREATER_THAN':
            opCounts.GT++;
            break;
          case 'GREATER_THAN_OR_EQUAL':
            opCounts.GTE++;
            break;
        }
      }

      if (
        path &&
        (op === 'LESS_THAN' ||
          op === 'LESS_THAN_OR_EQUAL' ||
          op === 'GREATER_THAN' ||
          op === 'GREATER_THAN_OR_EQUAL' ||
          op === 'NOT_EQUAL' ||
          op === 'NOT_IN')
      ) {
        inequalityFieldSet.add(path);
      }

      if (op === 'IN' || op === 'NOT_IN' || op === 'ARRAY_CONTAINS_ANY') {
        const vals = getArray(val);
        const hasNull = vals.some((v) => 'nullValue' in v);
        const hasNaN = vals.some((v) => isNaNVal(v));
        const tags = vals.map(classifyValue);
        const typeTags = new Set(tags.map((t) => t.tag));
        const refDbKeys = new Set(tags.map((t) => t.dbKey));
        const hasStructured = typeTags.has('array') || typeTags.has('map');

        arrayOperands.push({
          op,
          vals,
          size: vals.length,
          hasNull,
          hasNaN,
          typeTags,
          refDbKeys,
          hasStructured,
        });
      }
      return;
    }
    // unaryFilter — ignore for now
  };

  walk(query.where);

  const hasBoundedInequality =
    opCounts.LT + opCounts.LTE + opCounts.GT + opCounts.GTE > 0;
  const hasNotEqual = opCounts.NOT_EQUAL > 0;
  const hasNotIn = opCounts.NOT_IN > 0;
  const hasIn = opCounts.IN > 0;
  const hasAnyInequality = hasBoundedInequality || hasNotEqual || hasNotIn;

  const anyArrayOpEmpty = arrayOperands.some((a) => a.size === 0);
  const anyArrayOpTooLarge = arrayOperands.some((a) => a.size > 10);
  const anyArrayHasNullOrNaN = arrayOperands.some((a) => a.hasNull || a.hasNaN);

  // --- findNearest audit ------------------------------------------------------
  const fn = query.findNearest as
    | google.firestore.v1.StructuredQuery.IFindNearest
    | undefined;

  const vectorFieldPath = fn?.vectorField?.fieldPath ?? undefined;

  // Extract queryVector as array of Value (proto), if present
  const qvVals: google.firestore.v1.IValue[] =
    fn?.queryVector?.arrayValue?.values ?? [];

  const vectorQueryShape = fn
    ? {
        length: qvVals.length,
        hasNaN: qvVals.some((v) => isNaNVal(v)),
        hasNull: qvVals.some((v) => 'nullValue' in v),
        // A "valid" element is numeric (int/double) and not NaN.
        valid: qvVals.every((v) => {
          if ('doubleValue' in v && v.doubleValue != null) {
            return !Number.isNaN(v.doubleValue as number);
          }
          if ('integerValue' in v && v.integerValue != null) {
            return true;
          }
          return false;
        }),
      }
    : undefined;

  const MAX_VECTOR_LENGTH = 2048; // Firestore’s current documented max
  const vectorLimitExceeded = (fn?.limit?.value ?? 0) > 1000;
  const vectorLengthExceeded =
    !!vectorQueryShape && vectorQueryShape.length > MAX_VECTOR_LENGTH;

  const distanceMeasure = fn?.distanceMeasure as string | undefined;
  const SUPPORTED_DISTANCE_MEASURES = new Set([
    'EUCLIDEAN',
    'COSINE',
    'DOT_PRODUCT',
  ]);
  // Consider "unspecified" as valid (server may default)
  const hasValidDistanceMeasure =
    distanceMeasure == null || SUPPORTED_DISTANCE_MEASURES.has(distanceMeasure);

  const distanceThreshold =
    typeof fn?.distanceThreshold === 'number'
      ? (fn.distanceThreshold as number)
      : undefined;

  const distanceResultField = fn?.distanceResultField ?? undefined;

  const hasFindNearest = !!fn;

  return {
    ops,
    opCounts,

    hasIn,
    hasNotIn,
    hasNotEqual,
    hasBoundedInequality,
    hasAnyInequality,

    inequalityFields: Array.from(inequalityFieldSet).sort(),
    orderByFields,
    firstOrderByField: orderByFields[0],
    hasOrderBy: orderByFields.length > 0,

    lastExplicitDirection,
    orderByHasExplicitDirection,

    arrayOperands,
    anyArrayOpEmpty,
    anyArrayOpTooLarge,
    anyArrayHasNullOrNaN,

    // --- findNearest audit ---
    vectorFieldPath,
    vectorQueryShape,
    distanceMeasure,
    hasValidDistanceMeasure,
    distanceThreshold,
    distanceResultField,
    hasFindNearest,
    vectorLengthExceeded,
    vectorLimitExceeded,
  };
}

/**
 * Validates the `where` clause of a query against Firestore-like constraints.
 *
 * Checks include:
 * - Operator coexistence and cardinality (`IN`/`NOT_IN`/`ARRAY_CONTAINS_ANY`,
 *   `ARRAY_CONTAINS`, `NOT_EQUAL`, range operators).
 * - Array operand constraints (non-empty, ≤10 elements, no `null`/`NaN`,
 *   same-type requirements, same-DB references, etc.).
 *
 * @param query - The StructuredQuery (used for feature presence checks).
 * @param validationData - The precomputed audit from {@link buildQueryValidationData}.
 * @throws {GoogleError} with `INVALID_ARGUMENT` on violations.
 */
export function validateWhereFilterCompatibility(
  query: google.firestore.v1.IStructuredQuery,
  validationData: QueryValidationData
): void {
  if (!query.where) return;

  validateOperatorCombos(validationData);
  validateArrayOperands(validationData);
}

/**
 * Validates a `findNearest` clause (vector search) for shape and compatibility.
 *
 * Enforced rules (subset):
 * - `vectorField` and `queryVector` are required.
 * - `queryVector` elements must be finite numbers (no `null`/`NaN`), length ≤ 2048.
 * - `limit` must be ≤ 1000.
 * - `distanceMeasure` must be one of: `EUCLIDEAN`, `COSINE`, `DOT_PRODUCT` (or unspecified).
 * - `distanceThreshold` (if provided) must be a finite, non-negative number.
 * - Cannot be combined with `orderBy` (results are implicitly distance-ordered).
 * - `vectorField` cannot also be used in an inequality filter.
 *
 * @param validationData - The precomputed audit from {@link buildQueryValidationData}.
 * @throws {GoogleError} with `INVALID_ARGUMENT` on violations.
 */
export function validateFindNearestFilter(
  validationData: QueryValidationData
): void {
  if (!validationData.hasFindNearest) return;

  const {
    vectorFieldPath,
    vectorQueryShape,
    vectorLengthExceeded,
    hasValidDistanceMeasure,
    vectorLimitExceeded,
    distanceMeasure,
    distanceThreshold,
    hasOrderBy,
    inequalityFields,
  } = validationData;

  // Required fields
  if (!vectorFieldPath) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      'findNearest.vectorField is required.'
    );
  }
  if (!vectorQueryShape) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      'findNearest.queryVector is required.'
    );
  }

  if (vectorQueryShape.hasNull) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      'findNearest.queryVector must not contain null elements.'
    );
  }
  if (vectorQueryShape.hasNaN) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      'findNearest.queryVector must not contain NaN values.'
    );
  }
  if (!vectorQueryShape.valid) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      'findNearest.queryVector must be an array of finite numbers.'
    );
  }
  if (vectorLengthExceeded) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `findNearest.queryVector length ${vectorQueryShape.length} exceeds maximum 2048.`
    );
  }

  if (vectorLimitExceeded) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `FindNearest.limit must be a positive integer of no more than 1000.`
    );
  }

  // Distance measure
  if (!hasValidDistanceMeasure) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `Unsupported findNearest.distanceMeasure: ${String(distanceMeasure)}.`
    );
  }

  // Threshold (if provided)
  if (distanceThreshold != null) {
    if (!Number.isFinite(distanceThreshold)) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        'findNearest.distanceThreshold must be a finite number when provided.'
      );
    }
    if (distanceThreshold < 0) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        'findNearest.distanceThreshold must be a non-negative number.'
      );
    }
  }

  // Incompatibilities with other clauses
  //  - OrderBy: vector search defines its own ordering by distance.
  if (hasOrderBy) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      'findNearest cannot be combined with orderBy; results are implicitly ordered by vector distance.'
    );
  }

  //  - Inequalities on the vector field itself are not allowed.
  if (inequalityFields.includes(vectorFieldPath)) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `findNearest.vectorField "${vectorFieldPath}" cannot also appear in inequality filters.`
    );
  }
}

/**
 * Validates combinations and cardinality for filter operators.
 *
 * Rules (subset):
 * - At most one of each: `IN`, `NOT_IN`, `ARRAY_CONTAINS_ANY`, `ARRAY_CONTAINS`.
 * - `IN`/`NOT_IN`/`ARRAY_CONTAINS_ANY` are disjunctive; you may use **only one** of these families.
 * - `NOT_IN` cannot be combined with `IN`, `ARRAY_CONTAINS_ANY`, or `!=`.
 * - Multi-field inequalities are allowed but capped at 10 distinct fields
 *   (`<`, `<=`, `>`, `>=`, `!=`, `NOT_IN`).
 *
 * @param d - The precomputed audit.
 * @throws {GoogleError} with `INVALID_ARGUMENT` on violations.
 * @internal
 */
function validateOperatorCombos(d: QueryValidationData) {
  // Per-op limits (conservative & portable)
  if (d.opCounts.IN > 1) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `At most one IN filter may be used.`
    );
  }
  if (d.opCounts.NOT_IN > 1) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `At most one NOT_IN filter may be used.`
    );
  }
  if (d.opCounts.ARRAY_CONTAINS_ANY > 1) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `At most one ARRAY_CONTAINS_ANY filter may be used.`
    );
  }
  if (d.opCounts.ARRAY_CONTAINS > 1) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `At most one ARRAY_CONTAINS filter may be used.`
    );
  }

  // Disjunctive family: choose at most one of IN / NOT_IN / ARRAY_CONTAINS_ANY
  const disjunctiveCats =
    (d.opCounts.IN > 0 ? 1 : 0) +
    (d.opCounts.NOT_IN > 0 ? 1 : 0) +
    (d.opCounts.ARRAY_CONTAINS_ANY > 0 ? 1 : 0);
  if (disjunctiveCats > 1) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `'NOT_IN' cannot be used in the same query with 'IN'.`
      // `At most one of IN, NOT_IN, or ARRAY_CONTAINS_ANY may be used.`
    );
  }

  // NOT_IN mutual exclusions (per docs)
  if (
    d.hasNotIn &&
    (d.hasIn || d.opCounts.ARRAY_CONTAINS_ANY > 0 || d.hasNotEqual)
  ) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `NOT_IN cannot be used with IN, ARRAY_CONTAINS_ANY, or '!='.`
    );
  }

  // Multi-field inequality support (new behavior):
  // Allow inequalities across multiple fields, but cap the distinct count to 10.
  // Inequality fields include: <, <=, >, >=, !=, NOT_IN
  if (d.hasAnyInequality && d.inequalityFields.length > 10) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `At most 10 distinct inequality fields are allowed in a single query.`
    );
  }

  // Intentionally allowed combinations:
  // - '!=' may be combined with 'IN' and/or range filters (subject to index & ordering rules enforced elsewhere).
  // - 'NOT_IN' may be combined with range filters (on any fields), but not with IN/ARRAY_CONTAINS_ANY/!=.
}

/**
 * Validates array operands for `IN`, `NOT_IN`, and `ARRAY_CONTAINS_ANY`.
 *
 * Rules:
 * - Arrays must be non-empty and ≤ 10 elements.
 * - Arrays cannot contain `null` or `NaN`.
 * - Except for `ARRAY_CONTAINS_ANY`, elements must be of comparable types
 *   (numbers can mix ints/doubles).
 * - Reference values must all point to the same database.
 *
 * @param d - The precomputed audit.
 * @throws {GoogleError} with `INVALID_ARGUMENT` on violations.
 * @internal
 */
function validateArrayOperands(d: QueryValidationData) {
  for (const a of d.arrayOperands) {
    if (a.size === 0) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `${a.op} requires a non-empty array.`
      );
    }
    if (a.size > 10) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `${a.op} supports at most 10 elements.`
      );
    }
    if (a.hasNull || a.hasNaN) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `${a.op} array cannot contain null or NaN.`
      );
    }

    if (a.op !== 'ARRAY_CONTAINS_ANY') {
      // Mixed-type restriction (numbers OK together)
      const tags = new Set(
        Array.from(a.typeTags).map((t) => (t === 'number' ? 'number' : t))
      );
      if (tags.size > 1) {
        throw googleError(
          Status.INVALID_ARGUMENT,
          `${a.op} array elements must be of comparable types.`
        );
      }
    }

    // Same-db references
    if (a.typeTags.has('reference') && a.refDbKeys.size > 1) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `${a.op} array cannot mix references from different databases.`
      );
    }

    validateArrayTypes(a.op, a.vals);
  }
}

/**
 * Optional early validation that enforces an orderBy presence constraint
 * when inequalities exist **and** the client provided an orderBy clause.
 *
 * Rule:
 * - If any inequality exists and an orderBy is present, the **first** orderBy
 *   must explicitly target one of the inequality fields.
 *
 * @param d - The precomputed audit.
 * @throws {GoogleError} with `INVALID_ARGUMENT` on violations.
 */
export function validateOrderByPresenceForInequalities(d: QueryValidationData) {
  // Only validate when the client actually provided an orderBy.
  if (!d.hasAnyInequality || !d.hasOrderBy) return;

  // Require the first orderBy to target the (single) inequality field.
  if (!d.firstOrderByField) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      'Missing field in first orderBy.'
    );
  }

  if (!d.inequalityFields.includes(d.firstOrderByField)) {
    // Optional: include the expected field in the message if you’ve already normalized to one.
    // const expected = d.inequalityFields.join(', ');
    throw googleError(
      Status.INVALID_ARGUMENT,
      'First orderBy must be explicitly specified and must target a field used in an inequality filter.'
      // or: `First orderBy must target inequality field: ${expected}.`
    );
  }
}

type TypeTag =
  | 'null'
  | 'nan'
  | 'number'
  | 'string'
  | 'boolean'
  | 'timestamp'
  | 'reference' // includes db key detail
  | 'geo'
  | 'bytes'
  | 'map'
  | 'array';

/**
 * Enforces Firestore-like type compatibility for `IN` / `NOT_IN` / `ARRAY_CONTAINS_ANY` operand arrays.
 *
 * Additional checks beyond {@link validateArrayOperands}:
 * - Disallow mixing `null`/`NaN` with other elements.
 * - For `IN`/`NOT_IN`, require homogeneity (numbers may mix int/double).
 * - If references are used, require all references to be from the same database.
 * - (Optional fidelity) restrict structured values (arrays/maps) to homogeneous usage.
 *
 * @param op - The operator providing the array.
 * @param vals - The proto values making up the operand.
 * @throws {GoogleError} with `INVALID_ARGUMENT` on violations.
 * @internal
 */
function validateArrayTypes(
  op: 'IN' | 'NOT_IN' | 'ARRAY_CONTAINS_ANY',
  vals: google.firestore.v1.IValue[]
): void {
  // 1) Disallow any mixture involving null or NaN
  const anyNull = vals.some((v) => 'nullValue' in v);
  const anyNaN = vals.some(
    (v) => 'doubleValue' in v && Number.isNaN(v.doubleValue as number)
  );
  if ((anyNull && vals.length > 1) || (anyNaN && vals.length > 1)) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `${op} array cannot mix null/NaN with other values.`
    );
  }

  const tags = vals.map(classifyValue);

  if (op !== 'ARRAY_CONTAINS_ANY') {
    // 2) Compute tags and ensure homogeneity, with special allowance for numbers
    const nonNumberTags = new Set(
      tags.map((t) => (t.tag === 'number' ? 'number' : t.tag))
    );
    if (nonNumberTags.size > 1) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `${op} array elements must be of comparable types.`
      );
    }
  }

  // 3) Reference values must all point to the same database
  if (tags[0]?.tag === 'reference') {
    const dbKeys = new Set(tags.map((t) => t.dbKey));
    if (dbKeys.size > 1) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `${op} array cannot mix document references from different databases.`
      );
    }
  }

  // 4) (Optional—but closer fidelity) Disallow arrays-of-arrays and arrays-of-maps for IN/NOT_IN/AC_ANY
  // Firestore’s comparability/index rules are strict for composite/nested structures.
  if (tags[0]?.tag === 'array' || tags[0]?.tag === 'map') {
    const allSame = tags.every((t) => t.tag === tags[0].tag);
    if (!allSame) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `${op} array cannot mix structured values (arrays/maps) with other types.`
      );
    }
    // You could go further and reject structured types altogether:
    // throw googleError(Status.INVALID_ARGUMENT, `${op} does not support arrays/maps as elements.`);
  }
}

/**
 * Extracts a stable "type tag" and optional database key from a proto `Value`.
 *
 * - Integers & doubles collapse to `'number'`.
 * - References include a derived `"projectId/databaseId"` key for same-DB checks.
 *
 * @param v - The proto `Value`.
 * @returns A small record with `tag` and optional `dbKey`.
 * @internal
 */
function classifyValue(v: google.firestore.v1.IValue): {
  tag: TypeTag;
  dbKey?: string;
} {
  if ('nullValue' in v) return { tag: 'null' };
  if ('booleanValue' in v) return { tag: 'boolean' };
  if ('integerValue' in v) return { tag: 'number' };
  if ('doubleValue' in v) {
    const dv = v.doubleValue as number | null | undefined;
    if (dv != null && Number.isNaN(dv)) return { tag: 'nan' };
    return { tag: 'number' };
  }
  if ('stringValue' in v) return { tag: 'string' };
  if ('timestampValue' in v) return { tag: 'timestamp' };
  if ('bytesValue' in v) return { tag: 'bytes' };
  if ('geoPointValue' in v) return { tag: 'geo' };
  if ('arrayValue' in v) return { tag: 'array' };
  if ('mapValue' in v) return { tag: 'map' };
  if ('referenceValue' in v) {
    const ref = v.referenceValue ?? '';
    // Expect: projects/{p}/databases/{d}/documents/...
    // Use db key to ensure all refs in an IN array belong to same DB.
    const m = ref.match(/^projects\/([^/]+)\/databases\/([^/]+)\//);
    const dbKey = m ? `${m[1]}/${m[2]}` : undefined;
    return { tag: 'reference', dbKey };
  }
  // Fallback (shouldn't happen with well-formed values)
  return { tag: 'map' };
}

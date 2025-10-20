import type { google } from '@gcf/firestore-protos';
import { Timestamp } from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { Duplex } from 'stream';
import {
  InternalTransaction,
  MetaDocumentExists,
} from '../../data-accessor.js';
import { TimestampFromProto } from '../../firestore/typecast.js';
import { cloneDocumentData } from '../../functions/clone-document-data.js';
import { freezeDocumentData } from '../../functions/freeze-document-data.js';
import { googleError } from '../../functions/google-error.js';
import { resolvePromise } from '../../functions/resolve-promise.js';
import {
  getVectorValue,
  parseFieldPath,
  peekVectorValue,
  toProtoTimestamp,
  VectorLike,
} from '../../functions/util.js';
import { Mutable } from '../../internal-types.js';
import { GapicContext } from '../gapic-context.js';
import { StreamEndpoint } from '../stream-endpoint.js';
import { assertFieldArgument, assertRequestArgument } from './assert.js';
import { compareValues, getComparable } from './compare-values.js';
import { setDeepValue } from './deep-value.js';
import { Operators } from './operators.js';
import {
  buildQueryValidationData,
  Dir,
  QueryValidationData,
  validateCommonQueryRequest,
  validateFindNearestFilter,
  validateOrderByPresenceForInequalities,
  validateWhereFilterCompatibility,
} from './query-validation.js';
import { TransactionHelper } from './transaction-helper.js';
import { validateTransactionOptions } from './transaction-validation.js';
import { NAME_SENTINEL } from './types.js';
import { UnaryOperators } from './unary-operators.js';

/**
 * Arguments supplied to a query response encoder.
 */
interface QueryResolverArg {
  /** Context wrapping serializer, accessor, and path utilities. */
  context: GapicContext;
  /** The underlying stream (Duplex) to push GAPIC responses onto. */
  stream: Duplex;
  /** Documents produced by QueryBuilder.run(). */
  docs: MetaDocumentExists[];
  /** The read time used for the query (explicit or derived from transaction). */
  readTime: Timestamp | undefined;
  /** Transaction id (GAPIC bytes) to include in responses when applicable. */
  transaction?: Uint8Array;
}

/**
 * A subset of common properties shared by RunQuery and RunAggregationQuery
 * GAPIC requests.
 */
interface QueryRequestCommon {
  /** RunQueryRequest parent (required by Firestore, validated separately). */
  parent?: string | null;
  /** Existing transaction to read under, mutually exclusive with newTransaction/readTime. */
  transaction?: Uint8Array | null;
  /** New transaction options (read-only/read-write), validated by validateTransactionOptions(). */
  newTransaction?: google.firestore.v1.ITransactionOptions | null;
  /** Point-in-time read timestamp, mutually exclusive with transaction/newTransaction. */
  readTime?: google.protobuf.ITimestamp | null;
  /** Explain options (ignored by the mock, but accepted). */
  explainOptions?: google.firestore.v1.IExplainOptions | null;
}

function defaultPredicate(): true {
  return true;
}

function defaultComparator(): 0 {
  return 0;
}

/**
 * StructuredQuery REST API reference for rules:
 *
 * https://cloud.google.com/firestore/docs/reference/rest/v1/StructuredQuery
 */

/**
 * Builds, validates, and executes Firestore StructuredQuery and
 * AggregationQuery requests against the in-memory data store.
 *
 * Design notes:
 * - Validation (inequalities/orderBy compatibility, cursor shapes, etc.) is
 *   performed up front via helpers in query-validation.ts.
 * - The instance is immutable with respect to request interpretation
 *   (predicates/comparators/transformers are computed once in applyStructureQuery()).
 * - Execution is deterministic and synchronous over the in-memory snapshot
 *   but invoked asynchronously by StreamEndpoint to match Firestore’s async surface.
 */
export class QueryBuilder {
  /** Collection id targeted by the FROM clause (undefined means “any root”). */
  collectionId: string | undefined;
  /** Whether descendants are included (collection group). */
  allDescendants = false;
  /** Conjunction/disjunction of where/unary filters. */
  wherePredicate: (doc: MetaDocumentExists) => boolean;
  /** Cursor boundary predicate derived from startAt/endAt. */
  cursorPredicate: (doc: MetaDocumentExists) => boolean;
  /** Total ordering comparator derived from orderBy (+ implicit __name__). */
  orderByComparator: (x: MetaDocumentExists, y: MetaDocumentExists) => number;
  /** Optional post-processing for findNearest KNN transforms. */
  findNearestTransformer:
    | ((docs: MetaDocumentExists[]) => MetaDocumentExists[])
    | undefined;

  /** Result offset after filtering/sorting (StructuredQuery.offset). */
  offset = 0;
  /** Result limit (StructuredQuery.limit.value). */
  limit: number | undefined;
  /** Optional field mask for projection (StructuredQuery.select.fields). */
  fieldMask: string[] | undefined;

  /**
   * The parent resource path of the query (document root or document path).
   * Always validated via assertRequestArgument().
   */
  readonly parentPath: string;
  /** Optional point-in-time read time. */
  readonly readTime?: Timestamp;
  /** Existing transaction id (GAPIC bytes) when provided. */
  readonly transaction?: Uint8Array | null;
  /** New transaction request options when provided. */
  readonly newTransaction?: google.firestore.v1.ITransactionOptions | null;

  /**
   * @param request The raw request object (RunQuery or RunAggregationQuery).
   * @param encoder A function that converts the resolved docs into the
   *                corresponding GAPIC response(s) and pushes to the stream.
   * @throws {GoogleError} {Status.INVALID_ARGUMENT} when required arguments are missing.
   */
  private constructor(
    request: QueryRequestCommon,
    private readonly encoder: (arg: QueryResolverArg) => void
  ) {
    this.parentPath = assertRequestArgument('parent', request.parent);
    this.readTime = request.readTime
      ? (Timestamp as unknown as TimestampFromProto).fromProto(request.readTime)
      : undefined;
    this.transaction = request.transaction;
    this.newTransaction = request.newTransaction;
    this.wherePredicate = defaultPredicate;
    this.cursorPredicate = defaultPredicate;
    this.orderByComparator = defaultComparator;
  }

  /**
   * Constructs a QueryBuilder for a StructuredQuery (RunQuery).
   *
   * Validates common request constraints, parses the StructuredQuery into
   * predicates and comparators, and wires an encoder that emits
   * google.firestore.v1.RunQueryResponse messages for each result row (and a
   * trailing message conveying readTime/transaction when empty).
   *
   * @param context GapicContext providing serializer and accessors.
   * @param request RunQuery request payload.
   * @returns A configured QueryBuilder.
   * @throws {GoogleError} {Status.INVALID_ARGUMENT} on missing/invalid fields.
   * @throws {GoogleError} {Status.FAILED_PRECONDITION} on invalid transaction shapes.
   */
  static fromQuery(
    context: GapicContext,
    request?: google.firestore.v1.IRunQueryRequest
  ): QueryBuilder {
    request = assertRequest(request);
    validateCommonQueryRequest(request);

    const builder = new QueryBuilder(request, (arg: QueryResolverArg) => {
      if (arg.docs.length) {
        for (const meta of arg.docs) {
          const response: google.firestore.v1.IRunQueryResponse = {
            document: arg.context.serializeDoc(meta, builder.fieldMask),
          };
          assignCommonQueryResponse(arg, response);

          arg.stream.push(response);
        }
      } else {
        const emptyResult: google.firestore.v1.IRunQueryResponse =
          assignCommonQueryResponse(arg, {});
        arg.stream.push(emptyResult);
      }
    });
    const query = assertRequestArgument(
      'structuredQuery',
      request?.structuredQuery
    );
    validateTransactionOptions(request.newTransaction);
    builder.applyStructureQuery(context, query);

    return builder;
  }

  /**
   * Constructs a QueryBuilder for a StructuredAggregationQuery (RunAggregationQuery).
   *
   * Parses COUNT/SUM/AVG aggregations into an executable plan and wires an
   * encoder that emits a single google.firestore.v1.RunAggregationQueryResponse
   * with aggregateFields and readTime.
   *
   * Notes:
   * - The mock supports COUNT, SUM, and AVG only.
   * - SUM emits integerValue when all inputs are integers; otherwise doubleValue.
   * - AVG emits doubleValue; if no numeric inputs exist, the value is nullValue.
   *
   * @param context GapicContext providing serializer and accessors.
   * @param request RunAggregationQuery request payload.
   * @returns A configured QueryBuilder.
   * @throws {GoogleError} {Status.INVALID_ARGUMENT} on missing/invalid fields or duplicate aliases.
   * @throws {GoogleError} {Status.UNIMPLEMENTED} for unsupported aggregation kinds.
   */
  static fromAggregationQuery(
    context: GapicContext,
    request?: google.firestore.v1.IRunAggregationQueryRequest
  ): QueryBuilder {
    request = assertRequest(request);
    validateCommonQueryRequest(request);

    const structuredAgg = assertRequestArgument(
      'structuredAggregationQuery',
      request.structuredAggregationQuery
    );
    const query = assertRequestArgument(
      'structuredQuery',
      structuredAgg.structuredQuery
    );
    const aggregations = assertRequestArgument(
      'aggregations',
      structuredAgg.aggregations
    );

    validateTransactionOptions(request.newTransaction);

    if (!Array.isArray(aggregations) || aggregations.length === 0) {
      throw googleError(Status.INVALID_ARGUMENT, 'Missing aggregations.');
    }

    // Pre-parse aggregations into a uniform plan
    type AggPlan =
      | { kind: 'COUNT'; alias: string }
      | { kind: 'SUM'; alias: string; fieldPath: string }
      | { kind: 'AVG'; alias: string; fieldPath: string };

    const plans: AggPlan[] = [];
    const usedAliases = new Set<string>();
    let autoAliasSeq = 0;

    function nextAutoAlias(prefix: string): string {
      let alias: string;
      do {
        alias = `${prefix}${autoAliasSeq++}`;
      } while (usedAliases.has(alias));
      usedAliases.add(alias);
      return alias;
    }

    for (const agg of aggregations) {
      // Determine alias (optional in API)
      let alias = agg.alias?.trim();
      // Note: generate deterministic auto alias if absent/empty
      if (!alias) {
        // Try a nicer default per type; fall back to "aggN"
        if (agg.count) alias = nextAutoAlias('count_');
        else if (agg.sum) {
          const p = agg.sum.field?.fieldPath || '';
          alias = p ? nextAutoAlias(`sum_${p}_`) : nextAutoAlias('sum_');
        } else if (agg.avg) {
          const p = agg.avg.field?.fieldPath || '';
          alias = p ? nextAutoAlias(`avg_${p}_`) : nextAutoAlias('avg_');
        } else {
          alias = nextAutoAlias('agg_');
        }
      } else {
        if (usedAliases.has(alias)) {
          throw googleError(
            Status.INVALID_ARGUMENT,
            `Duplicate aggregation alias "${alias}".`
          );
        }
        usedAliases.add(alias);
      }

      if (agg.count) {
        // COUNT(*) — Firestore also supports upTo, but we ignore it for now (not needed for semantics)
        plans.push({ kind: 'COUNT', alias });
        continue;
      }

      if (agg.sum) {
        const fieldPath = agg.sum.field?.fieldPath;
        if (!fieldPath) {
          throw googleError(
            Status.INVALID_ARGUMENT,
            'SUM requires a field path.'
          );
        }
        plans.push({ kind: 'SUM', alias, fieldPath });
        continue;
      }

      if (agg.avg) {
        const fieldPath = agg.avg.field?.fieldPath;
        if (!fieldPath) {
          throw googleError(
            Status.INVALID_ARGUMENT,
            'AVG requires a field path.'
          );
        }
        plans.push({ kind: 'AVG', alias, fieldPath });
        continue;
      }

      // Anything else is not supported in the mock
      throw googleError(
        Status.UNIMPLEMENTED,
        'Only COUNT, SUM, and AVG aggregations are supported in mock.'
      );
    }

    const builder = new QueryBuilder(request, (arg: QueryResolverArg) => {
      // Compute aggregateFields map
      const out: Record<string, google.firestore.v1.IValue> =
        Object.create(null);

      // Helper for numeric extraction
      const isFiniteNumber = (v: unknown): v is number =>
        typeof v === 'number' && Number.isFinite(v);

      for (const plan of plans) {
        switch (plan.kind) {
          case 'COUNT': {
            // Count of docs after filters/ordering/limit/offset applied by QueryBuilder
            out[plan.alias] = { integerValue: String(arg.docs.length) };
            break;
          }

          case 'SUM': {
            let sum = 0;
            let sawFloat = false;
            let sawAnyNumeric = false;

            for (const md of arg.docs) {
              const v = getComparable(context, md, plan.fieldPath);
              if (isFiniteNumber(v)) {
                sawAnyNumeric = true;
                if (!Number.isInteger(v)) sawFloat = true;
                sum += v;
              }
            }

            if (!sawAnyNumeric) {
              out[plan.alias] = { integerValue: 0 };
            } else if (sawFloat) {
              out[plan.alias] = { doubleValue: sum };
            } else {
              // integer-only sum
              // Use integerValue as string (per Value proto)
              out[plan.alias] = { integerValue: sum };
            }
            break;
          }

          case 'AVG': {
            let sum = 0;
            let count = 0;

            for (const md of arg.docs) {
              const v = getComparable(context, md, plan.fieldPath);
              if (isFiniteNumber(v)) {
                sum += v;
                count++;
              }
            }

            if (count === 0) {
              out[plan.alias] = { nullValue: 'NULL_VALUE' };
            } else {
              out[plan.alias] = { doubleValue: sum / count };
            }
            break;
          }
        }
      }

      const response: google.firestore.v1.IRunAggregationQueryResponse = {
        result: { aggregateFields: out },
      };

      assignCommonQueryResponse(arg, response);

      arg.stream.push(response);
    });

    builder.applyStructureQuery(context, query);

    return builder;
  }

  /**
   * Executes the built query (or aggregation) under the provided TransactionHelper
   * and emits responses to the given StreamEndpoint.
   *
   * Semantics:
   * - If a transaction is active, a readTime is ensured and every returned
   *   document is registered as a read.
   * - For RunQuery, a response is pushed per row (or a single empty response
   *   with readTime if no rows). For RunAggregationQuery, a single response.
   *
   * @param tm Transaction helper resolving transaction/readTime context.
   * @param stream Stream endpoint to emit responses to.
   */
  executeRequest(tm: TransactionHelper, stream: StreamEndpoint<unknown>): void {
    const executor = async () => {
      const accessor = tm.context.getAccessor();
      const tx = tm.resolve(this);
      const readTime =
        this.readTime ?? InternalTransaction.ensureReadTime(accessor, tx);

      const docs = await resolvePromise(this.run(tm.context, readTime));
      if (tx && docs.length) {
        docs.forEach((doc) => {
          tx.registerRead(doc);
        });
      }

      this.encoder({
        context: tm.context,
        stream: stream.duplex,
        docs,
        readTime,
        transaction: tx ? tm.toGapicId(tx) : undefined,
      });
    };

    stream.runPromise(executor, true);
  }

  /**
   * Executes the query against the current in-memory snapshot at the given readTime.
   *
   * Pipeline:
   *   accessor.query() → sort(orderBy) → filter(cursors) → slice(offset/limit)
   *   → optional findNearest post-transform.
   *
   * @param context GapicContext.
   * @param readTime Point-in-time read.
   * @returns Final list of documents to encode.
   */
  run(context: GapicContext, readTime: Timestamp): MetaDocumentExists[] {
    const accessor = context.getAccessor();

    const docs = accessor.query({
      parent: context.toInternalPath(this.parentPath ?? '', 'document'),
      predicate: this.wherePredicate,
      collectionId: this.collectionId,
      allDescendants: this.allDescendants,
      readTime,
    });

    const filtered = docs
      .sort((a, b) => this.orderByComparator(a, b))
      .filter((d) => this.cursorPredicate(d))
      .slice(
        this.offset,
        this.limit !== undefined ? this.offset + this.limit : undefined
      );

    return this.findNearestTransformer?.(filtered) ?? filtered;
  }

  /**
   * Parses and applies a StructuredQuery to this builder:
   * - offset/limit
   * - from(collectionId, allDescendants)
   * - where/unary filters → wherePredicate
   * - orderBy (+ implicit constraints) → orderByComparator
   * - startAt/endAt → cursorPredicate
   * - findNearest → optional post-transformer
   * - select.fields → fieldMask
   *
   * @param context GapicContext.
   * @param query StructuredQuery payload.
   * @throws {GoogleError} {Status.INVALID_ARGUMENT} on invalid shapes/values.
   */
  private applyStructureQuery(
    context: GapicContext,
    query: google.firestore.v1.IStructuredQuery
  ): void {
    if (!query) return;

    this.offset = query.offset ?? 0;
    this.limit = query.limit?.value ?? undefined;

    if (this.limit && this.limit < 0) {
      throw googleError(Status.INVALID_ARGUMENT, 'limit is negative');
    }

    const from = assertRequestArgument('from', query.from)?.[0];
    this.collectionId = from.collectionId ?? undefined;

    this.allDescendants = from.allDescendants === true;
    const validationData = buildQueryValidationData(query);
    this.wherePredicate = buildWherePredicate(context, query, validationData);
    this.orderByComparator = parseOrderBy(context, query, validationData);
    this.cursorPredicate = buildCursorPredicate(
      context,
      query.orderBy ?? [],
      query.startAt,
      query.endAt
    );
    this.findNearestTransformer = buildFindNearestTransformer(
      context,
      query,
      validationData
    );

    this.fieldMask = query.select?.fields
      ?.map((f) => f.fieldPath)
      .filter((s): s is string => !!s && s.length > 0);
  }
}

function assertRequest<T extends QueryRequestCommon>(request?: T): T {
  if (!request) {
    throw googleError(Status.INVALID_ARGUMENT, 'Missing request payload.');
  }

  return request;
}

/**
 * Builds a predicate function from a StructuredQuery.where filter.
 * Returns a predicate that evaluates a Firestore document's data against the filter.
 *
 * @param filter - StructuredQuery.filter
 * @returns A predicate: (data) => boolean
 */
function buildWherePredicate(
  context: GapicContext,
  query: google.firestore.v1.IStructuredQuery,
  validationData: QueryValidationData
): (doc: MetaDocumentExists) => boolean {
  validateWhereFilterCompatibility(query, validationData);

  function inner(
    context: GapicContext,
    filter?: google.firestore.v1.StructuredQuery.IFilter | null
  ): (doc: MetaDocumentExists) => boolean {
    if (!filter) return defaultPredicate;

    if (filter.compositeFilter) {
      const subPredicates = (filter.compositeFilter.filters ?? []).map((f) =>
        inner(context, f)
      );

      if (filter.compositeFilter.op === 'AND') {
        return (data) => subPredicates.every((p) => p(data));
      } else if (filter.compositeFilter.op === 'OR') {
        return (data) => subPredicates.some((p) => p(data));
      } else {
        throw new Error(
          `Unsupported composite filter operator: ${filter.compositeFilter.op}`
        );
      }
    }

    if (filter.fieldFilter) {
      const fieldFilter = filter.fieldFilter;
      const fieldPath = assertFieldArgument(
        'fieldPath',
        fieldFilter?.field?.fieldPath
      );
      const op = assertFieldArgument('op', fieldFilter?.op);
      const value = assertFieldArgument('value', fieldFilter?.value);
      const expected = context.serializer.decodeValue(value);

      return (meta: MetaDocumentExists) => {
        const actual = getComparable(context, meta, fieldPath);

        return Operators.eval(op, actual, expected);
      };
    }

    if (filter.unaryFilter) {
      const { op, field } = filter.unaryFilter;
      const fieldPath = field?.fieldPath ?? '';

      return (meta: MetaDocumentExists) => {
        const actual = getComparable(context, meta, fieldPath);

        return UnaryOperators.eval(op, actual);
      };
    }

    throw googleError(
      Status.INVALID_ARGUMENT,
      'Unsupported query filter structure'
    );
  }
  return inner(context, query.where);
}

/**
 * Builds a predicate that filters documents based on StructuredQuery cursors.
 *
 * Applies cursor logic in conjunction with orderBy, as per Firestore semantics:
 * - startAt / startAfter: filters the beginning of the result set
 * - endAt / endBefore: filters the end of the result set
 *
 * This should be applied after filtering and sorting, but before offset/limit.
 *
 * @param orderBy - The StructuredQuery.orderBy[] array
 * @param startAt - Optional startAt/startAfter cursor
 * @param endAt - Optional endAt/endBefore cursor
 * @returns A predicate (doc) => boolean
 */
function buildCursorPredicate(
  context: GapicContext,
  orderBy: google.firestore.v1.StructuredQuery.IOrder[],
  startAt?: google.firestore.v1.ICursor | null,
  endAt?: google.firestore.v1.ICursor | null
): (doc: MetaDocumentExists) => boolean {
  const cursorMatch = (
    meta: MetaDocumentExists,
    cursor: google.firestore.v1.ICursor,
    isStart: boolean
  ): boolean => {
    const cursorValues = cursor.values ?? [];

    if (cursorValues.length > orderBy.length) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `Cursor value count (${cursorValues.length}) cannot exceed orderBy count (${orderBy.length}).`
      );
    }

    for (let i = 0; i < cursorValues.length; i++) {
      const order = orderBy[i];
      const fieldPath = order.field?.fieldPath ?? '';

      const docVal = getComparable(context, meta, fieldPath);
      const cursorVal = context.serializer.decodeValue(cursorValues[i]);

      // Asc compare
      let cmp = compareValues(docVal, cursorVal);

      // Invert for DESC
      const isDesc = order.direction === 'DESCENDING';
      if (isDesc) cmp = -cmp;

      // doc before/after the bound in the query's ordering
      if (cmp < 0) return isStart ? false : true; // before bound
      if (cmp > 0) return isStart ? true : false; // after bound
      // else equal on this field: check next field
    }

    // All fields equal to bound: inclusivity depends on start vs end and 'before'
    const before = cursor.before ?? false;
    return isStart ? before : !before;
  };

  return (meta: MetaDocumentExists) => {
    if (startAt && !cursorMatch(meta, startAt, true)) return false;
    if (endAt && !cursorMatch(meta, endAt, false)) return false;
    return true;
  };
}

/**
 * Parses a Firestore StructuredQuery.orderBy[] definition into a comparator function
 * for sorting document data.
 *
 * The comparator operates on decoded POJO document fields (not ProtoValues).
 * Field paths are resolved using dot-notation.
 *
 * Inequality ordering rules (Firestore server-side behavior):
 * - If a query includes any inequality filter (<, <=, >, >=, !=, NOT_IN),
 *   the first orderBy clause must be explicitly specified and must order
 *   on one of the fields used in an inequality filter. If this is not the
 *   case, the query will fail.
 * - All inequality fields must appear in orderBy. Any that are missing are
 *   appended in lexicographical order after the existing orderBy entries.
 * - Missing sort directions inherit from the last explicitly specified
 *   direction, or default to ASCENDING if none was specified.
 * - __name__ is always appended last (unless already last) as a final
 *   tiebreaker, using the same direction as the last orderBy entry.
 *
 * @param orderBy - The orderBy array from StructuredQuery
 * @returns A comparator function: (a, b) => number
 */
// ---- orderBy.ts ----
function parseOrderBy(
  context: GapicContext,
  query: google.firestore.v1.IStructuredQuery,
  validationData: QueryValidationData
): (a: MetaDocumentExists, b: MetaDocumentExists) => number {
  // Guard: if there’s any inequality, the first orderBy must be explicitly
  // specified and target an inequality field.
  validateOrderByPresenceForInequalities(validationData);
  // Start from client-specified orderBy
  const effective: google.firestore.v1.StructuredQuery.IOrder[] = [
    ...(query.orderBy ?? []),
  ];

  // Append missing inequality fields (lexicographic)
  const present = new Set(
    effective.map((o) => o.field?.fieldPath).filter((s): s is string => !!s)
  );
  for (const f of validationData.inequalityFields) {
    if (!present.has(f)) {
      effective.push({ field: { fieldPath: f } });
    }
  }

  // Append implicit __name__ last (if not already last)
  const lastPath = effective[effective.length - 1]?.field?.fieldPath;
  if (lastPath !== NAME_SENTINEL) {
    effective.push({ field: { fieldPath: NAME_SENTINEL } });
  }

  // Build comparators with direction inheritance
  let currentDirection: Dir = 'ASCENDING';
  const fields = effective.map((o) => {
    const fieldPath = o.field?.fieldPath;
    if (!fieldPath) throw new Error('Missing field path in orderBy clause.');

    if (o.direction && o.direction !== 'DIRECTION_UNSPECIFIED') {
      currentDirection = o.direction;
    }
    const sign = currentDirection === 'DESCENDING' ? -1 : 1;

    return {
      compare: (a: MetaDocumentExists, b: MetaDocumentExists) => {
        const aVal = getComparable(context, a, fieldPath);
        const bVal = getComparable(context, b, fieldPath);

        // Missing-field placement per Firestore:
        // ASC: undefined LAST  |  DESC: undefined FIRST
        const aU = aVal === undefined;
        const bU = bVal === undefined;
        if (aU || bU) {
          if (aU && bU) return 0; // equal for this clause; defer to next (eventually __name__)
          return (aU ? 1 : -1) * sign; // place missing per direction
        }

        // Both defined: compare, applying direction
        const primary = compareValues(aVal, bVal) * sign;
        if (primary !== 0) return primary;

        // equal for this clause; defer to next (eventually __name__)
        return 0;
      },
    };
  });

  return (a, b) => {
    for (const { compare } of fields) {
      const cmp = compare(a, b);
      if (cmp !== 0) return cmp;
    }
    return 0;
  };
}

export function buildFindNearestTransformer(
  context: GapicContext,
  query: google.firestore.v1.IStructuredQuery,
  validationData: QueryValidationData
): ((docs: MetaDocumentExists[]) => MetaDocumentExists[]) | undefined {
  const fn = query.findNearest;
  if (!fn) return undefined;
  validateFindNearestFilter(validationData);

  const vectorField = fn.vectorField?.fieldPath ?? '';
  const distanceMeasure: google.firestore.v1.StructuredQuery.FindNearest.DistanceMeasure =
    fn.distanceMeasure ?? 'EUCLIDEAN';
  const distanceThreshold = fn.distanceThreshold?.value ?? undefined;
  const limit = Math.max(0, Math.min(1000, fn.limit?.value ?? 0)); // Firestore allows up to 1000
  const distanceResultField = fn.distanceResultField || undefined;

  // Extract query vector (accepts a few shapes defensively)
  const queryVector = extractQueryVector(context, fn);

  // No-op transformer if essential inputs are missing
  if (!queryVector) {
    return (docs) => {
      // If distanceResultField is requested but we didn't run KNN, keep docs unchanged
      return docs;
    };
  }

  function readVector(
    doc: MetaDocumentExists,
    fieldPath: string
  ): number[] | undefined {
    const v = getVectorValue(
      getComparable(context, doc, fieldPath) as VectorLike
    );
    if (!v.length || v.some((x) => typeof x !== 'number')) return undefined;

    return v as number[];
  }

  function score(
    a: number[],
    b: number[],
    kind: google.firestore.v1.StructuredQuery.FindNearest.DistanceMeasure
  ): { rank: number; report: number } {
    switch (kind) {
      case 'EUCLIDEAN': {
        let s = 0;
        for (let i = 0; i < a.length; i++) {
          const d = a[i] - b[i];
          s += d * d;
        }
        const dist = Math.sqrt(s);
        return { rank: dist, report: dist }; // report distance
      }
      case 'COSINE': {
        let dot = 0,
          na = 0,
          nb = 0;
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i];
          na += a[i] * a[i];
          nb += b[i] * b[i];
        }
        const denom = Math.sqrt(na) * Math.sqrt(nb);
        const sim = denom === 0 ? 0 : dot / denom; // [-1, 1]
        const dist = 1 - sim; // [0, 2], smaller = closer
        return { rank: dist, report: dist }; // <-- report distance, not similarity
      }

      case 'DOT_PRODUCT': {
        let dot = 0;
        for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
        return { rank: -dot, report: dot }; // rank by -dot, report raw dot
      }
      default:
        // Unsuported rejected during validation
        return { rank: Number.POSITIVE_INFINITY, report: NaN };
    }
  }

  function normZero(x: number): number {
    // avoid writing -0
    return Object.is(x, -0) ? 0 : x;
  }

  return (input: MetaDocumentExists[]): MetaDocumentExists[] => {
    if (input.length === 0) return input;
    // 1) Score candidates (skip docs without a usable vector)
    const scored: Array<{
      doc: Mutable<MetaDocumentExists>;
      d: number;
      report: number;
    }> = [];
    for (const doc of input) {
      const v = readVector(doc, vectorField);
      if (!v || v.length !== queryVector.length) continue;

      const s = score(queryVector, v, distanceMeasure);
      if (distanceThreshold === undefined || s.rank <= distanceThreshold) {
        scored.push({ doc, d: s.rank, report: s.report });
      }
    }

    if (scored.length === 0) return [];

    // 2) Sort by ascending distance; tie-break by canonical doc reference
    scored.sort((x, y) => {
      if (x.d !== y.d) return x.d - y.d;
      // Fallback to the Firestore default __name__ reference values
      const rx = x.doc.path;
      const ry = y.doc.path;
      return compareValues(rx, ry);
    });

    // 3) Apply findNearest.limit
    const top = scored.slice(0, Math.min(limit, scored.length));

    return distanceResultField
      ? top.map((s) => {
          const mutated = cloneDocumentData(s.doc.data);
          const segments = parseFieldPath(distanceResultField);
          setDeepValue(mutated, segments, normZero(s.report));

          return {
            ...s.doc,
            data: freezeDocumentData(mutated),
          };
        })
      : top.map((s) => s.doc);
  };

  // --- helpers ---

  function extractQueryVector(
    context: GapicContext,
    f: google.firestore.v1.StructuredQuery.IFindNearest
  ): number[] | undefined {
    const qv = f.queryVector;
    if (!qv) return undefined;

    return peekVectorValue(
      context.serializer.decodeValue(qv) as VectorLike
    ) as number[];
  }
}

function assignCommonQueryResponse<
  T extends
    | google.firestore.v1.IRunQueryResponse
    | google.firestore.v1.IRunAggregationQueryResponse
>(arg: QueryResolverArg, response: T): T {
  if (arg.readTime) {
    response.readTime = toProtoTimestamp(arg.readTime);
  }
  if (arg.transaction) {
    response.transaction = arg.transaction;
  }

  return response;
}

import type { google } from '@gcf/firestore-protos';
import { compareValues, evalDataType } from './compare-values.js';
import { EvalDataType } from './types.js';

/**
 * Firestore-compatible predicate evaluation for `StructuredQuery.FieldFilter`.
 *
 * This utility mirrors Firestore server semantics for equality, range, membership,
 * and array operators. Important nuances captured here:
 *
 * - **Presence vs. undefined:** Missing/undefined fields are not equal to anything and
 *   are excluded from most operators (with specific exceptions noted below).
 * - **NaN equality:** `NaN` is only equal to `NaN`; for `!=`, `NaN != NaN` is **false**.
 * - **Range comparability:** Only certain kinds participate in `<`, `<=`, `>`, `>=`.
 * - **NOT_IN / IN:** Expected values are arrays; equality uses Firestore canonical
 *   comparison (`compareValues`) and requires presence unless otherwise stated.
 * - **Arrays:** `array-contains` and `array-contains-any` compare elements using
 *   Firestore equality, not JS strict equality.
 */
export class Operators {
  /**
   * Kinds that Firestore meaningfully supports for **range** predicates.
   * (Array/Map are not range-comparable; Boolean is typically disallowed by validation.)
   * @internal
   */
  private static readonly RANGE_KINDS = new Set<EvalDataType>([
    EvalDataType.Number,
    EvalDataType.Timestamp,
    EvalDataType.String,
    EvalDataType.Bytes,
    EvalDataType.Reference,
    EvalDataType.GeoPoint,
  ]);

  /**
   * Equality with Firestore semantics (includes special `NaN` handling).
   * Excludes `Undefined` (missing fields never equal anything).
   *
   * @param actual - The field value (may be missing).
   * @param expected - The query operand.
   * @returns `true` if equal, otherwise `false`.
   * @internal
   */
  private static eq(actual: unknown, expected: unknown): boolean {
    const ka = evalDataType(actual);
    const kb = evalDataType(expected);

    // Missing/undefined never equals anything (Firestore equality requires presence).
    if (ka === EvalDataType.Undefined || kb === EvalDataType.Undefined)
      return false;

    // NaN is equal only to NaN
    if (ka === EvalDataType.NumberNaN || kb === EvalDataType.NumberNaN) {
      return ka === EvalDataType.NumberNaN && kb === EvalDataType.NumberNaN;
    }

    // Types must match for equality
    if (ka !== kb) return false;

    // Deep/value equality via canonical comparator
    return compareValues(actual, expected) === 0;
  }

  /**
   * Inequality with Firestore semantics.
   *
   * Rules:
   * - Missing/undefined fields are **included** by `!=` (return `true`).
   * - Type mismatch with a present `actual` counts as not equal.
   * - `NaN != NaN` is **false** (since `NaN` equals `NaN` for Firestore equality).
   *
   * @param actual - The field value (may be missing).
   * @param expected - The query operand.
   * @returns `true` if not equal, otherwise `false`.
   * @internal
   */
  private static neq(actual: unknown, expected: unknown): boolean {
    const ka = evalDataType(actual);
    const kb = evalDataType(expected);

    // Missing/undefined fields are included by !=
    if (ka === EvalDataType.Undefined) return true;

    // If types differ (and actual is present), it's not equal
    if (ka !== kb) return true;

    // Both NaN -> equal, so not-equal is false
    if (ka === EvalDataType.NumberNaN && kb === EvalDataType.NumberNaN)
      return false;

    // Otherwise invert equality
    return !Operators.eq(actual, expected);
  }

  /** Gate for range operators: presence, same-kind, allowed kind, and non-NaN/non-null. */ /**
   * Guard for range operators: requires presence, same kind, allowed kinds,
   * and excludes `null` and `NaN`.
   *
   * @param actual - The field value.
   * @param expected - The query operand.
   * @returns `true` if range comparison is permitted.
   * @internal
   */
  private static rangeComparable(actual: unknown, expected: unknown): boolean {
    const ka = evalDataType(actual);
    const kb = evalDataType(expected);

    // Must be present
    if (ka === EvalDataType.Undefined || kb === EvalDataType.Undefined)
      return false;

    // Null and NaN are excluded from ranges
    if (
      ka === EvalDataType.Null ||
      kb === EvalDataType.Null ||
      ka === EvalDataType.NumberNaN ||
      kb === EvalDataType.NumberNaN
    ) {
      return false;
    }

    // Must be same kind and kind must be allowed for ranges
    if (ka !== kb) return false;
    if (!Operators.RANGE_KINDS.has(ka)) return false;

    return true;
  }

  // ---------- Range operators ----------

  /**
   * Firestore `<` comparison.
   * @returns `true` when `actual < expected`, otherwise `false`.
   */
  static lessThan(actual: unknown, expected: unknown): boolean {
    if (!Operators.rangeComparable(actual, expected)) return false;
    return compareValues(actual, expected) < 0;
    // NOTE: comparator is total; gate ensured we're in a valid comparable subset.
  }

  /**
   * Firestore `<=` comparison.
   * @returns `true` when `actual <= expected`, otherwise `false`.
   */
  static lessThanOrEqual(actual: unknown, expected: unknown): boolean {
    if (!Operators.rangeComparable(actual, expected)) return false;
    return compareValues(actual, expected) <= 0;
  }

  /**
   * Firestore `>` comparison.
   * @returns `true` when `actual > expected`, otherwise `false`.
   */
  static greaterThan(actual: unknown, expected: unknown): boolean {
    if (!Operators.rangeComparable(actual, expected)) return false;
    return compareValues(actual, expected) > 0;
  }

  /**
   * Firestore `>=` comparison.
   * @returns `true` when `actual >= expected`, otherwise `false`.
   */
  static greaterThanOrEqual(actual: unknown, expected: unknown): boolean {
    if (!Operators.rangeComparable(actual, expected)) return false;
    return compareValues(actual, expected) >= 0;
  }

  // ---------- Equality operators ----------

  /**
   * Firestore `==` (EQUAL) comparison.
   * @returns `true` when equal under Firestore semantics.
   */
  static equal(actual: unknown, expected: unknown): boolean {
    return Operators.eq(actual, expected);
  }

  /**
   * Firestore `!=` (NOT_EQUAL) comparison.
   * @returns `true` when not equal under Firestore semantics.
   */
  static notEqual(actual: unknown, expected: unknown): boolean {
    return Operators.neq(actual, expected);
  }

  // ---------- Set membership ----------

  /**
   * Firestore `in` membership test.
   *
   * Rules:
   * - `expected` must be an array (defensively checked here).
   * - Missing/undefined `actual` is **not** included.
   * - Uses Firestore equality to match any element.
   *
   * @returns `true` if `actual` equals any element in `expected`.
   */
  static in(actual: unknown, expected: unknown): boolean {
    // Validation layer should already enforce expected is an array; here we guard defensively.
    if (!Array.isArray(expected)) return false;

    // Presence required for 'in'
    if (evalDataType(actual) === EvalDataType.Undefined) return false;

    for (const v of expected) {
      if (Operators.eq(actual, v)) return true;
    }
    return false;
  }

  /**
   * Firestore `not-in` membership test.
   *
   * Rules:
   * - `expected` must be an array (defensively checked).
   * - Missing/undefined and `null` **do not** match (return `false`).
   * - `NaN` is **included** (returns `true`).
   * - Otherwise returns `true` iff `actual` is present and unequal to every element.
   */
  static notIn(actual: unknown, expected: unknown): boolean {
    if (!Array.isArray(expected)) return false;

    const kind = evalDataType(actual);

    // Emulator-compatibility:
    // - Exclude missing and null
    if (kind === EvalDataType.Undefined || kind === EvalDataType.Null)
      return false;

    // - Include NaN
    if (kind === EvalDataType.NumberNaN) return true;

    // Otherwise: present & not equal to any listed value
    for (const v of expected) {
      if (Operators.eq(actual, v)) return false; // equal to any -> excluded
    }
    return true;
  }

  // ---------- Array membership ----------

  /**
   * Firestore `array-contains` operator.
   * Returns `true` when `actual` is an array and contains an element equal to `expected`
   * under Firestore equality.
   */
  static arrayContains(actual: unknown, expected: unknown): boolean {
    if (evalDataType(actual) !== EvalDataType.Array) return false;

    const arr = actual as unknown[];
    for (const el of arr) {
      if (Operators.eq(el, expected)) return true;
    }
    return false;
  }

  /**
   * Firestore `array-contains-any` operator.
   * Returns `true` when `actual` is an array and it contains **any** element equal to
   * **any** value in `expected` (which must be an array), using Firestore equality.
   */
  static arrayContainsAny(actual: unknown, expected: unknown): boolean {
    if (evalDataType(actual) !== EvalDataType.Array) return false;
    if (!Array.isArray(expected)) return false;

    const arr = actual as unknown[];
    // Early exit: if any expected matches any element
    for (const candidate of expected) {
      for (const el of arr) {
        if (Operators.eq(el, candidate)) return true;
      }
    }
    return false;
  }

  /**
   * Dispatches the provided GAPIC operator to the appropriate implementation.
   *
   * @param operator - GAPIC `FieldFilter.Operator` enum value.
   * @param actual - The field value from the document.
   * @param expected - The operand supplied in the filter.
   * @returns The boolean result of the predicate.
   * @throws {Error} If the operator is not supported.
   */
  static eval(
    operator: google.firestore.v1.StructuredQuery.FieldFilter.Operator,
    actual: unknown,
    expected: unknown
  ): boolean {
    switch (operator) {
      case 'EQUAL':
        return Operators.equal(actual, expected);
      case 'NOT_EQUAL':
        return Operators.notEqual(actual, expected);
      case 'LESS_THAN':
        return Operators.lessThan(actual, expected);
      case 'LESS_THAN_OR_EQUAL':
        return Operators.lessThanOrEqual(actual, expected);
      case 'GREATER_THAN':
        return Operators.greaterThan(actual, expected);
      case 'GREATER_THAN_OR_EQUAL':
        return Operators.greaterThanOrEqual(actual, expected);
      case 'ARRAY_CONTAINS':
        return Operators.arrayContains(actual, expected);
      case 'IN':
        return Operators.in(actual, expected);
      case 'ARRAY_CONTAINS_ANY':
        return Operators.arrayContainsAny(actual, expected);
      case 'NOT_IN':
        return Operators.notIn(actual, expected);
      default:
        throw new Error(`Unsupported field filter operator: ${operator}`);
    }
  }
}

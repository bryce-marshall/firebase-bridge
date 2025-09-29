import type { google } from '@gcf/firestore-protos';
import { evalDataType } from './compare-values.js';
import { EvalDataType } from './types.js';

/**
 * Firestore-compatible evaluation for `StructuredQuery.UnaryFilter`.
 *
 * Semantics captured here:
 * - **IS_NULL**: matches only when the field is present and `null`
 *   (missing/`undefined` does **not** match).
 * - **IS_NAN**: matches only when the field is a `number` and `NaN`.
 * - **IS_NOT_NULL**: matches only when the field is present and **not** `null`
 *   (missing/`undefined` does **not** match).
 * - **IS_NOT_NAN**: matches only when the field is a `number` and **not** `NaN`
 *   (non-numeric values and missing/`undefined` do **not** match).
 *
 * Note: These semantics differ from equality semantics with `null`
 * (e.g., `== null` may include missing), but unary operators here require
 * field **presence** for the non-null variants.
 */
export class UnaryOperators {
  /**
   * Evaluates a unary operator against a single value.
   *
   * @param operator - GAPIC unary operator (`IS_NULL`, `IS_NAN`, `IS_NOT_NULL`, `IS_NOT_NAN`).
   * @param value - The field value from the document (may be missing/`undefined`).
   * @returns `true` if the predicate matches; otherwise `false`.
   * @throws {Error} If the operator is not supported.
   */
  static eval(
    operator:
      | google.firestore.v1.StructuredQuery.UnaryFilter.Operator
      | null
      | undefined,
    value: unknown
  ): boolean {
    const kind = evalDataType(value);

    switch (operator) {
      case 'IS_NULL':
        return kind === EvalDataType.Null;

      case 'IS_NAN':
        return kind === EvalDataType.NumberNaN;

      case 'IS_NOT_NULL':
        // Field must be present and not null
        return kind !== EvalDataType.Undefined && kind !== EvalDataType.Null;

      case 'IS_NOT_NAN':
        // Only numbers that are not NaN
        return kind === EvalDataType.Number;

      default:
        throw new Error(`Unsupported unary filter operator: ${operator}`);
    }
  }
}

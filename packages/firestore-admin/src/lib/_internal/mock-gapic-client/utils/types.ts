export const NAME_SENTINEL = '__name__';

/**
 * Firestore type ordering ranks for mixed-type comparisons.
 *
 * Matches Firestore's canonical ordering:
 * null < boolean < number < timestamp < string < bytes < reference < geopoint < array < vector < map
 */
export enum FirestoreTypeOrder {
  Null = 0,
  Boolean = 1,
  Number = 2, // Integer and double share this rank
  Timestamp = 3,
  String = 4,
  Bytes = 5,
  Reference = 6,
  GeoPoint = 7,
  Array = 8,
  Vector = 9,
  Map = 10,
}

/**
 * Classification for **predicate evaluation** (phase A) in the mock query engine.
 *
 * This enum is designed for operator gating and value-kind checks. It is **not**
 * a canonical sort order; use FirestoreTypeOrder for ordering values.
 *
 * Notes
 * - Firestore does not store `undefined`. If `undefined` reaches the engine (from JS),
 *   it is classified as {@link EvalDataType.Undefined}. Operator logic should decide
 *   whether to treat it like "missing".
 * - `NumberNaN` is separated for predicate semantics (excluded from ranges; `==` only to itself)
 *   but maps to the numeric order bucket for sorting.
 * - Arrays/Maps require deep-equality for `==` and element equality for array ops.
 * - Reference equality requires same database; carry a `refDbKey` (or similar) outside this enum.
 */
export enum EvalDataType {
  /**
   * An unsupported type.
   */
  Invalid,
  /**
   * JS `undefined`.
   * Firestore never persists `undefined`, so represents a missing field value; treat according to operator rules.
   */
  Undefined,

  /** Firestore `null` value. */
  Null,

  /** Boolean primitive (`true`/`false`). */
  Boolean,

  /**
   * Numeric value that is **not** `NaN`. This includes finite numbers and ±Infinity.
   * For predicate rules, handle range/equality as normal numbers.
   */
  Number,

  /**
   * Numeric `NaN`. Predicate semantics:
   * - Excluded from range operators.
   * - `==` matches only when both sides are `NaN`.
   * For ordering, translate to the numeric order bucket.
   */
  NumberNaN,

  /**
   * Firestore `Timestamp`. If values may originate from different module instances,
   * prefer a brand/type-guard (e.g. `isTimestamp`) over `instanceof` at call sites.
   */
  Timestamp,

  /** UTF-16 JavaScript string. */
  String,

  /**
   * Firestore `Bytes`/byte-array-like value (e.g., `Uint8Array`, Buffer).
   * Detection relies on `isByteArrayLike(v)`.
   */
  Bytes,

  /**
   * Firestore `DocumentReference`. Equality/compatibility also requires same database.
   * Carry DB identity alongside this classification for comparisons.
   */
  Reference,

  /**
   * Firestore `GeoPoint`. As with `Timestamp`, consider branded checks if crossing module boundaries.
   */
  GeoPoint,

  /** JavaScript array (`Array.isArray(v) === true`). */
  Array,

  /** Vector type */
  Vector,

  /**
   * Plain object treated as a Firestore map value.
   * Must exclude Firestore special types (Timestamp, GeoPoint, Bytes, Reference).
   */
  Map,
}

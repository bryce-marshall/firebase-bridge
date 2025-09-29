import {
  DocumentReference,
  GeoPoint,
  Timestamp,
} from 'firebase-admin/firestore';
import { MetaDocumentExists } from '../../data-accessor.js';
import {
  ByteArrayLike,
  getVectorValue,
  isByteArrayLike,
  isPlainObject,
  isVectorLikeShallow,
  toBuffer,
  VectorLike,
} from '../../functions/util.js';
import { GapicContext } from '../gapic-context.js';
import { EvalDataType, FirestoreTypeOrder, NAME_SENTINEL } from './types.js';

/**
 * Resolves a comparable value from a document given a field path.
 *
 * Special case:
 * - When the field path is `__name__` (the sentinel), the function
 *   returns a Firestore reference value derived from the document path.
 *
 * @param context - GAPIC context providing serializer and path utilities.
 * @param meta - The metadata for a document that exists.
 * @param fieldPath - The dot-delimited field path (or `__name__` sentinel).
 * @returns The decoded or raw comparable value, or `undefined` if the field is not present.
 */
export function getComparable(
  context: GapicContext,
  meta: MetaDocumentExists,
  fieldPath: string
): unknown {
  if (fieldPath === NAME_SENTINEL)
    return context.serializer.decodeValue({
      referenceValue: context.toGapicPath(meta.path),
    });

  return fieldPath.split('.').reduce((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return acc[key];
  }, meta.data);
}

interface ResourcePath {
  /**
   * Compare the current path against another Path object.
   *
   * Compare the current path against another Path object. Paths are compared segment by segment,
   * prioritizing numeric IDs (e.g., "__id123__") in numeric ascending order, followed by string
   * segments in lexicographical order.
   *
   * @private
   * @internal
   * @param other The path to compare to.
   * @returns -1 if current < other, 1 if current > other, 0 if equal
   */
  compareTo(other: ResourcePath): number;
}

interface Resource {
  _path: ResourcePath;
}

/**
 * Compares two Firestore values according to the canonical ordering
 * used by queries, cursors, and inequality filters.
 *
 * Ordering rules (by type precedence):
 * 1. Null
 * 2. Boolean (`false` < `true`)
 * 3. Number (with special handling: `NaN < -Infinity < ... < Infinity`; `-0 == 0`)
 * 4. Timestamp (seconds, then nanoseconds)
 * 5. String (lexicographic)
 * 6. Bytes (lexicographic by byte sequence)
 * 7. Reference (path segments)
 * 8. GeoPoint (latitude, then longitude)
 * 9. Array (lexicographic element-wise, shorter first)
 * 10. Vector (dimension length, then element-wise numeric)
 * 11. Map (sorted by key, then value; shorter first)
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns -1 if a < b, 1 if a > b, 0 if equal.
 */
export function compareValues(a: unknown, b: unknown): number {
  // Fast-path: same object identity
  if (a === b) return 0;

  // Type precedence rank per Firestore docs
  const rankA = valueTypeRank(a);
  const rankB = valueTypeRank(b);
  if (rankA !== rankB) return rankA - rankB;

  // Same Firestore "kind" so compare within-kind
  switch (rankA) {
    case FirestoreTypeOrder.Null:
      return 0;

    case FirestoreTypeOrder.Boolean: {
      const aa = a as boolean,
        bb = b as boolean;
      return aa === bb ? 0 : aa ? 1 : -1; // false < true
    }

    case FirestoreTypeOrder.Number: /* number (int/double interleaved) */ {
      return compareNumber(a as number, b as number);
    }

    case FirestoreTypeOrder.Timestamp: {
      const ta = a as Timestamp,
        tb = b as Timestamp;
      // Compare seconds, then nanos (microsecond precision stored; nanos preserved in type)
      if (ta.seconds !== tb.seconds) return ta.seconds < tb.seconds ? -1 : 1;
      if (ta.nanoseconds !== tb.nanoseconds)
        return ta.nanoseconds < tb.nanoseconds ? -1 : 1;
      return 0;
    }

    case FirestoreTypeOrder.String: {
      const aa = String(a),
        bb = String(b);
      // For exact fidelity with queries you could compare UTF‑8 byte sequences
      // and truncate to 1500 bytes, but this lexicographic compare is typically sufficient.
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    }

    case FirestoreTypeOrder.Bytes: {
      const aa = toBuffer(a as ByteArrayLike);
      const bb = toBuffer(b as ByteArrayLike);
      const len = Math.min(aa.length, bb.length);
      for (let i = 0; i < len; i++) {
        if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
      }
      return aa.length - bb.length;
    }

    case FirestoreTypeOrder.Reference: {
      // return (a as PathComparable).compareTo(b as PathComparable);
      return (a as Resource)._path.compareTo((b as Resource)._path);
    }

    case FirestoreTypeOrder.GeoPoint: {
      const ga = a as GeoPoint,
        gb = b as GeoPoint;
      // Firestore GeoPoint ordering (lat asc, then lon asc)
      if (ga.latitude !== gb.latitude)
        return ga.latitude < gb.latitude ? -1 : 1;
      if (ga.longitude !== gb.longitude)
        return ga.longitude < gb.longitude ? -1 : 1;
      return 0;
    }

    case FirestoreTypeOrder.Array: {
      const aa = a as unknown[],
        bb = b as unknown[];
      const len = Math.min(aa.length, bb.length);
      for (let i = 0; i < len; i++) {
        const c = compareValues(aa[i], bb[i]);
        if (c !== 0) return c;
      }
      return aa.length - bb.length; // shorter first
    }

    case FirestoreTypeOrder.Vector: /* vector (dimension, then elements) */ {
      // If supporting embeddings: compare dimension (length) then element-wise numeric order.
      const aa = getVectorValue(a as VectorLike),
        bb = getVectorValue(b as VectorLike);
      if (aa.length !== bb.length) return aa.length - bb.length;
      for (let i = 0; i < aa.length; i++) {
        const c = compareNumber(aa[i], bb[i]);
        if (c !== 0) return c;
      }
      return 0;
    }

    case FirestoreTypeOrder.Map: /* map (sorted by key, then value; shorter first) */ {
      const ma = a as Record<string, unknown>;
      const mb = b as Record<string, unknown>;
      const ka = Object.keys(ma).sort();
      const kb = Object.keys(mb).sort();
      const klen = Math.min(ka.length, kb.length);
      for (let i = 0; i < klen; i++) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1; // key order
        const c = compareValues(ma[ka[i]], mb[kb[i]]);
        if (c !== 0) return c; // value order
      }
      return ka.length - kb.length; // shorter first
    }

    default:
      // Should not happen; keep deterministic
      return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }
}

/**
 * Returns the Firestore type precedence rank for a value.
 *
 * The rank corresponds to {@link FirestoreTypeOrder} and dictates
 * how values of different types are ordered in queries.
 *
 * @param v - The value to rank.
 * @returns The Firestore type order rank.
 */
export function valueTypeRank(v: unknown): FirestoreTypeOrder {
  switch (evalDataType(v)) {
    case EvalDataType.Undefined:
    case EvalDataType.Null:
      return FirestoreTypeOrder.Null;

    case EvalDataType.Boolean:
      return FirestoreTypeOrder.Boolean;

    case EvalDataType.Number:
    case EvalDataType.NumberNaN:
      return FirestoreTypeOrder.Number;

    case EvalDataType.Timestamp:
      return FirestoreTypeOrder.Timestamp;

    case EvalDataType.String:
      return FirestoreTypeOrder.String;

    case EvalDataType.Bytes:
      return FirestoreTypeOrder.Bytes;

    case EvalDataType.Reference:
      return FirestoreTypeOrder.Reference;

    case EvalDataType.GeoPoint:
      return FirestoreTypeOrder.GeoPoint;

    case EvalDataType.Array:
      return FirestoreTypeOrder.Array;

    case EvalDataType.Vector:
      return FirestoreTypeOrder.Vector;

    case EvalDataType.Map:
      return FirestoreTypeOrder.Map;

    default: {
      // This should be unreachable if evalDataType() is exhaustive.
      // Fallback: treat unknowns as strings to keep sort total
      return FirestoreTypeOrder.String;
    }
  }
}

/**
 * Compares two numbers with Firestore semantics:
 * - `NaN` is ordered before all other numbers.
 * - `-0` and `0` are treated as equal.
 *
 * @param a - First number.
 * @param b - Second number.
 * @returns -1 if a < b, 1 if a > b, 0 if equal.
 */
function compareNumber(a: number, b: number): number {
  const aNaN = Number.isNaN(a),
    bNaN = Number.isNaN(b);
  if (aNaN && bNaN) return 0;
  if (aNaN) return -1; // Firestore: NaN < -Infinity
  if (bNaN) return 1;
  // Treat -0 and 0 as equal
  if (Object.is(a, -0) && Object.is(b, 0)) return 0;
  if (Object.is(a, 0) && Object.is(b, -0)) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

function isReference(v: unknown): v is DocumentReference {
  return v instanceof DocumentReference;
}

/**
 * Classifies a runtime value into an {@link EvalDataType} for
 * query operator evaluation.
 *
 * Rules:
 * - Distinguishes `NumberNaN` from regular numbers.
 * - Treats `undefined` as {@link EvalDataType.Undefined}.
 * - Recognizes Firestore-specific types (Timestamp, GeoPoint, Reference).
 * - Recognizes plain objects as `Map`, shallow vector-like values as `Vector`.
 * - Everything else defaults to `Invalid`.
 *
 * @param v - The runtime value.
 * @returns The evaluated data type.
 */
export function evalDataType(v: unknown): EvalDataType {
  if (v === null) return EvalDataType.Null;
  if (v === undefined) return EvalDataType.Undefined;
  if (typeof v === 'boolean') return EvalDataType.Boolean;
  if (typeof v === 'number')
    return Number.isNaN(v) ? EvalDataType.NumberNaN : EvalDataType.Number;
  if (v instanceof Timestamp) return EvalDataType.Timestamp;
  if (typeof v === 'string') return EvalDataType.String;
  if (isByteArrayLike(v)) return EvalDataType.Bytes;
  if (isReference(v)) return EvalDataType.Reference;
  if (v instanceof GeoPoint) return EvalDataType.GeoPoint;
  if (Array.isArray(v)) return EvalDataType.Array;
  if (isVectorLikeShallow(v)) return EvalDataType.Vector;
  if (isPlainObject(v)) return EvalDataType.Map;

  return EvalDataType.Invalid;
}

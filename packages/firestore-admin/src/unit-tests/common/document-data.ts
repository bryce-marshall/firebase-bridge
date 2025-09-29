import { DocumentData, Timestamp } from 'firebase-admin/firestore';

interface MaybeIsEqual {
  isEqual: (other: unknown) => boolean;
}

/**
 * Deep equality for Firestore document-like data structures.
 * - Primitives by value (with special-case for NaN)
 * - Arrays by order/length + element-wise
 * - Firestore immutable types via .isEqual()
 * - Plain objects by keys + recursive values
 * - Bytes (Uint8Array/Buffer) by byte comparison
 */
export function isDocDataEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // Handle nulls
  if (a === null || b === null) return a === b;

  // Type mismatch
  if (typeof a !== typeof b) return false;

  // Numbers (handle NaN explicitly; Infinity/-Infinity are fine with === above)
  if (typeof a === 'number' && typeof b === 'number') {
    // If both NaN, treat as equal
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    // Otherwise a!==b already handled by top-level fast path; this is unequal
    return false;
  }

  // Arrays
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== (b as unknown[]).length) return false;
    const bb = b as unknown[];
    for (let i = 0; i < a.length; i++) {
      if (!isDocDataEqual(a[i], bb[i])) return false;
    }
    return true;
  }

  // Bytes (Uint8Array/Buffer)
  if (isByteArrayLike(a) || isByteArrayLike(b)) {
    if (!isByteArrayLike(a) || !isByteArrayLike(b)) return false;
    return bytesEqual(a, b);
  }

  // Objects with isEqual()
  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    typeof (a as MaybeIsEqual).isEqual === 'function' &&
    typeof (b as MaybeIsEqual).isEqual === 'function'
  ) {
    if (!(a as MaybeIsEqual).isEqual(b)) {
      console.log('Failed MaybeIsEqual a', a);
      console.log('Failed MaybeIsEqual b', b);
    }
    return (a as MaybeIsEqual).isEqual(b);
  }

  // Plain objects
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;

    // Ensure the same key set
    for (const k of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    }

    // Compare values
    for (const k of aKeys) {
      if (
        !isDocDataEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k]
        )
      ) {
        console.log(`Values at key ${k} are not equal.`);
        return false;
      }
    }
    return true;
  }

  // All other cases (mismatched structures or unsupported types)
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DocumentFieldValue = any;

export function normalizeDocData(data: DocumentData): DocumentData {
  if (data == undefined) return data;

  function recurse(value: DocumentFieldValue): DocumentFieldValue {
    if (value instanceof Timestamp) return truncatedTimestamp(value);

    // Arrays
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        result.push(recurse(value[i]));
      }
      return result;
    }

    // Plain objects
    if (isPlainObject(value)) {
      const keys = Object.keys(value);

      // Compare values
      const result: Record<string, unknown> = {};
      for (const k of keys) {
        const fieldValue = recurse(
          (value as Record<string, DocumentFieldValue>)[k]
        );
        // Note strict comparitor `!==` - we want to exclude `undefined` but include `null`
        if (fieldValue !== undefined) {
          result[k] = fieldValue;
        }
      }

      return isEmpty(result) ? (null as unknown as DocumentFieldValue) : result;
    }

    // All other cases returned verbatim
    return value;
  }

  return recurse(data) ?? {};
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function isEmpty(value: {}): boolean {
  return Object.keys(value).length === 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;

  // Cross-realm tolerant tag check
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;

  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true; // Object.create(null)

  // Accept if the immediate prototype's constructor "looks like" Object,
  // either same-realm (=== Object) or cross-realm (.name === 'Object')
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const ctor = (proto as { constructor?: Function }).constructor;
  return (
    typeof ctor === 'function' && (ctor === Object || ctor.name === 'Object')
  );
}

/**
 * Returns true if the value is one of the supported byte-array inputs.
 * Safe in browser & Node (Buffer may be undefined in browsers).
 */
export function isByteArrayLike(v: unknown): v is Buffer {
  return (
    v instanceof Uint8Array ||
    v instanceof ArrayBuffer ||
    (typeof Buffer !== 'undefined' && v instanceof Buffer)
  );
}

function bytesEqual(a: Buffer, b: Buffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Creates a `Timestamp` with nanoseconds truncated in accordance with backend persistence behaviour.
 */
export function truncatedTimestamp(value: Timestamp): Timestamp {
  return new Timestamp(
    value.seconds,
    Math.floor(value.nanoseconds / 1_000) * 1_000
  );
}

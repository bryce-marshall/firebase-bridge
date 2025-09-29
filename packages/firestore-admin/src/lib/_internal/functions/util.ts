import {
  DocumentData,
  DocumentReference,
  FieldValue,
  GeoPoint,
  Timestamp,
} from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { googleError } from './google-error.js';

import type { google } from '@gcf/firestore-protos';

/**
 * Returns whether a runtime value should be treated as an **immutable Firestore value**.
 *
 * A value is considered immutable if it is one of:
 * - `Timestamp` — Firestore timestamp object
 * - `FieldValue` — sentinel values (e.g., `serverTimestamp()`, `delete()`, `increment()`)
 * - `GeoPoint` — geographic coordinate value
 * - `DocumentReference` — reference to another document
 * - A **vector-like** value as determined by `isVectorLikeShallow` (e.g., a typed array
 *   or array-of-numbers representation used for embeddings)
 *
 * This predicate is useful in cloning/freezing routines to avoid deep mutation or
 * unnecessary copying of Firestore-native types and vector buffers.
 *
 * Notes:
 * - The vector check is **shallow** and delegates to `isVectorLikeShallow`.
 * - Containers (arrays/maps) are **not** considered immutable unless they themselves
 *   satisfy the vector-like predicate.
 *
 * @param value - Any runtime value to test.
 * @returns `true` if `value` is a Firestore-native immutable or vector-like value; otherwise `false`.
 *
 * @example
 * isImmutableFirestoreType(Timestamp.now());               // true
 * isImmutableFirestoreType(FieldValue.serverTimestamp());  // true
 * isImmutableFirestoreType(new GeoPoint(1, 2));            // true
 * isImmutableFirestoreType(docRef);                        // true
 * isImmutableFirestoreType(new Float32Array([0.1, 0.2]));  // true (if treated as vector-like)
 * isImmutableFirestoreType({ a: 1 });                      // false
 */
export function isImmutableFirestoreType(value: unknown): boolean {
  return (
    value instanceof Timestamp ||
    value instanceof FieldValue ||
    value instanceof GeoPoint ||
    value instanceof DocumentReference ||
    isVectorLikeShallow(value)
  );
}

/**
 * Ensures a `google.protobuf.ITimestamp` wire-protocol structure rather than an
 * internal `Timestamp` instance.
 */
export function toProtoTimestamp(
  value: google.protobuf.ITimestamp | Timestamp
): google.protobuf.ITimestamp {
  return value instanceof Timestamp
    ? {
        seconds: value.seconds.toString(),
        nanos: value.nanoseconds,
      }
    : {
        seconds: Number(value?.seconds || 0).toString(),
        nanos: value?.nanos,
      };
}

// /**
//  * Returns true if the provided string is a valid Firestore document field name.
//  *
//  * Firestore field names:
//  * - Must not be empty.
//  * - Must not contain unescaped dots (which represent path segments).
//  * - Cannot be solely whitespace (but otherwise can contain internal, leading, and trailing whitespace).
//  * - May contain reserved names like `__name__`, but their use is context-dependent.
//  *
//  * @param fieldName - The name of the document field to validate.
//  * @returns `true` if the field name is valid for use in Firestore; otherwise, `false`.
//  */
// export function isValidFieldName(fieldName: string): boolean {
//   if (typeof fieldName !== 'string') return false;

//   // Must not be empty or only whitespace
//   if (fieldName.trim().length === 0) return false;

//   // Must not contain unescaped dots (dots represent path segments)
//   // Firestore allows field paths like "a.b", but as a *name*, "a.b" is invalid
//   if (fieldName.includes('.')) return false;

//   return true;
// }

/**
 * Splits and validates a Firestore field path into segments.
 * Mimics the behavior of Firestore Admin SDK's FieldPath.fromDotSeparatedString().
 *
 * @param fieldPath - Dot-separated string representation of a field path.
 * @returns An array of field path segments.
 */
export function parseFieldPath(fieldPath: string): string[] {
  if (!fieldPath || typeof fieldPath !== 'string') {
    throw googleError(
      Status.INVALID_ARGUMENT,
      'Field path must be a non-empty string.'
    );
  }

  const segments: string[] = [];
  const buf: string[] = [];
  let inBackticks = false;
  let i = 0;

  while (i < fieldPath.length) {
    const char = fieldPath[i];

    if (char === '`') {
      if (!inBackticks) {
        // Starting quoted segment
        if (buf.length > 0) {
          throw googleError(
            Status.INVALID_ARGUMENT,
            `Invalid field path "${fieldPath}": unexpected backtick in unquoted identifier.`
          );
        }
        inBackticks = true;
      } else {
        // Possible end of quoted segment or escaped backtick
        if (i + 1 < fieldPath.length && fieldPath[i + 1] === '`') {
          // Escaped backtick (`` -> `)
          buf.push('`');
          i++; // Skip the second backtick
        } else {
          // End of quoted segment
          inBackticks = false;
        }
      }
    } else if (char === '.' && !inBackticks) {
      if (buf.length === 0) {
        throw googleError(
          Status.INVALID_ARGUMENT,
          `Invalid field path "${fieldPath}": empty segment.`
        );
      }
      segments.push(buf.join(''));
      buf.length = 0;
    } else {
      buf.push(char);
    }

    i++;
  }

  if (inBackticks) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `Invalid field path "${fieldPath}": unmatched backtick.`
    );
  }

  if (buf.length > 0) {
    segments.push(buf.join(''));
  }

  // Validate unquoted segments
  const identifierRegex = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
  for (const seg of segments) {
    const isQuoted = seg.startsWith('`') && seg.endsWith('`');
    if (!isQuoted && !identifierRegex.test(seg)) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `Invalid field path segment "${seg}" in path "${fieldPath}". ` +
          'Unquoted segments must match /^[a-zA-Z_][a-zA-Z_0-9]*$/.'
      );
    }
  }

  return segments;
}

export type ByteArrayLike = Uint8Array | ArrayBuffer | Buffer;

/**
 * Returns true if the value is one of the supported byte-array inputs.
 * Safe in browser & Node (Buffer may be undefined in browsers).
 */
export function isByteArrayLike(v: unknown): v is ByteArrayLike {
  return (
    v instanceof Uint8Array ||
    v instanceof ArrayBuffer ||
    (typeof Buffer !== 'undefined' && v instanceof Buffer)
  );
}

/**
 * Create a Buffer *view* over the provided input without copying bytes.
 * - Buffer:      returned as-is (same object; no copy)
 * - Uint8Array:  view over the same underlying memory, honoring offset/length
 * - ArrayBuffer: view over the same buffer (full range)
 *
 * If you need an independent copy, use `cloneByteArray()` instead.
 */
export function toBuffer(v: ByteArrayLike): Buffer {
  if (Buffer.isBuffer(v)) return v;

  if (v instanceof Uint8Array) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }

  // v is ArrayBuffer
  return Buffer.from(v as ArrayBuffer);
}

/**
 * Deeply clones the provided byte data into a new Buffer with its own memory.
 * The resulting Buffer shares no memory with the input.
 */
export function cloneByteArray(v: ByteArrayLike): Buffer {
  const src = toBuffer(v); // correct view (offset/length-safe)
  return Buffer.from(src.buffer, src.byteOffset, src.byteLength); // allocate new buffer & copy bytes
}

/**
 * Verifies that 'obj' is a plain JavaScript object that can be encoded as a
 * 'Map' in Firestore.
 *
 * @private
 * @internal
 * @param input The argument to verify.
 * @returns 'true' if the input can be a treated as a plain object.
 */
export function isPlainObject(input: unknown): input is DocumentData {
  return (
    isObject(input) &&
    (Object.getPrototypeOf(input) === Object.prototype ||
      Object.getPrototypeOf(input) === null ||
      input.constructor.name === 'Object')
  );
}

/**
 * Determines whether `value` is a JavaScript object.
 *
 * @private
 * @internal
 */
export function isObject(value: unknown): value is { [k: string]: unknown } {
  return Object.prototype.toString.call(value) === '[object Object]';
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

/** A minimal duck-typed shape for Firestore vector values. */
export type VectorLike = { toArray(): number[] };

/**
 * Lightweight, allocation-free check for a Firestore vector value.
 *
 * @remarks
 * In Node/Admin Firestore, vector fields are the only values that expose a {@link VectorLike.toArray} method.
 * This guard intentionally **does not** call `toArray()` to avoid extra allocations or O(n) scans—use it
 * before calling {@link vectorDims} on hot paths.
 *
 * @param v - Unknown value from decoded document data.
 * @returns `true` if `v` looks like a vector (has a callable `toArray()`), otherwise `false`.
 *
 * @example
 * ```ts
 * if (isVectorLikeShallow(value)) {
 *   // Safe to treat as VectorLike; call vectorDims(value) to size it.
 * }
 * ```
 */
export function isVectorLikeShallow(v: unknown): v is VectorLike {
  return !!v && typeof (v as VectorLike).toArray === 'function';
}

interface VectorValueInternal {
  _values: number[] | undefined;
}

export function vectorDims(v: VectorLike): number {
  // We cannot use the `WeakMap` strategy because `VectorValue` instances are treated
  // as immutable Firestore types and therefore the underlying array is not released until
  // the database the document is deleted.
  return (v as unknown as VectorValueInternal)._values?.length ?? 0;
}

export function getVectorValue(
  v: Partial<VectorLike> | null | undefined
): number[] {
  return v && isVectorLikeShallow(v) ? v.toArray() : [];
}

export function peekVectorValue(
  v: Partial<VectorLike> | null | undefined
): readonly number[] {
  const n = (v as unknown as VectorValueInternal)._values ?? [];

  return Object.freeze(n);
}

/**
 * Returns a new array with duplicate items removed while preserving the order
 * of the first occurrence of each element.
 *
 * If no `comparer` is provided, strict equality (`===`) is used.
 *
 * You can also provide a custom `comparer` to control how elements are considered
 * equal. The comparer may be:
 *
 * - **Equality-style**: `(x, y) => boolean` — return `true` when `x` and `y` should be treated as duplicates.
 * - **Comparator-style**: `(x, y) => number` — return `0` when `x` and `y` should be treated as duplicates
 *   (similar to `Array.prototype.sort` comparators).
 *
 * The original array is never mutated.
 *
 * @typeParam T - The element type of the array.
 * @param array - The input array. If `null` or `undefined`, an empty array is returned.
 * @param comparer - Optional function used to determine equality between two items.
 * @returns A new array containing only the first occurrence of each distinct item.
 *
 * @example
 * // Default: dedupes primitives by strict equality
 * dedupeArray([1, 2, 2, 3, NaN, NaN]); // => [1, 2, 3, NaN, NaN] (since NaN !== NaN)
 *
 * @example
 * // Equality-style comparer: case-insensitive string dedupe
 * const ci = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
 * dedupeArray(['A', 'a', 'b'], ci); // => ['A', 'b']
 *
 * @example
 * // Comparator-style comparer: dedupe by object.id
 * interface Item { id: number; name: string }
 * const byId = (a: Item, b: Item) => a.id - b.id; // equal when result === 0
 * dedupeArray([{ id:1, name:'x' }, { id:1, name:'y' }, { id:2, name:'z' }], byId);
 * // => [{ id:1, name:'x' }, { id:2, name:'z' }]
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dedupeArray<T = any>(
  array: T[] | null | undefined,
  comparer?: (x: T, y: T) => boolean | number
): T[] {
  if (!array || array.length === 0) return [];

  const cmp = comparer ?? ((a: T, b: T) => a === b); // default strict equality

  const out: T[] = [];
  outer: for (const curr of array) {
    for (let i = 0; i < out.length; i++) {
      const res = cmp(out[i], curr);
      const equal = typeof res === 'number' ? res === 0 : !!res;
      if (equal) {
        continue outer; // duplicate found; skip current
      }
    }
    out.push(curr); // first occurrence
  }
  return out;
}

/**
 * Returns the last element of a stack-like array **without** removing it.
 *
 * - Runs in O(1) time.
 * - Does not mutate the input array.
 * - Returns `undefined` when the array is empty.
 *
 * @typeParam T - Element type of the stack.
 * @param stack - The array acting as a stack (top at the end of the array).
 * @returns The top element, or `undefined` if `stack` is empty.
 *
 * @example
 * const s = [1, 2, 3];
 * stackPeek(s); // 3
 * s;            // [1, 2, 3] (unchanged)
 *
 * @example
 * stackPeek<number>([]); // undefined
 */
export function stackPeek<T>(stack: T[]): T | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined;
}

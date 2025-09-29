/* eslint-disable @typescript-eslint/no-explicit-any */

import { Timestamp } from 'firebase-admin/firestore';
import {
  cloneByteArray,
  isByteArrayLike,
  isImmutableFirestoreType,
  truncatedTimestamp,
} from './util.js';

/**
 * Deep-clones Firestore document data.
 * Special Firestore types (Timestamp, FieldValue, GeoPoint) are returned as-is.
 */
export function cloneDocumentData<T>(input: T): T {
  if (
    // `==` includes `null` values
    input == undefined ||
    typeof input !== 'object' ||
    Object.prototype.toString.call(input) === '[object String]' ||
    Object.prototype.toString.call(input) === '[object Number]' ||
    Object.prototype.toString.call(input) === '[object Boolean]'
  ) {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map(cloneDocumentData) as unknown as T;
  }

  if (isImmutableFirestoreType(input)) {
    if (input instanceof Timestamp)
      return truncatedTimestamp(input) as unknown as T;
    return input; // Immutable Firestore objects
  }

  if (isByteArrayLike(input)) return cloneByteArray(input) as unknown as T;

  const result: any = {};
  for (const key in input) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      result[key] = cloneDocumentData((input as any)[key]);
    }
  }
  return result;
}

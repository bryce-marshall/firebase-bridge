import { DocumentData } from 'firebase-admin/firestore';
import { DocumentFieldValue } from '../internal-types.js';
import { isByteArrayLike, isImmutableFirestoreType } from './util.js';

/**
 * Recursively freezes the `DocumentData` instance.
 */
export function freezeDocumentData<T extends DocumentData = DocumentData>(
  data: T
): T {
  recursiveFreeze(data);
  return data as T;
}

function recursiveFreeze(data: DocumentData | DocumentFieldValue): void {
  // Primitives or null/undefined ─ nothing to freeze
  if (data === null || data === undefined || typeof data !== 'object') {
    return;
  }

  // Leave Firestore‐specific immutable classes untouched
  if (isImmutableFirestoreType(data)) {
    return;
  }

  if (isByteArrayLike(data)) {
    try {
      Object.freeze(data);
    } catch {
      // jsdom/Hermes may throw: "Cannot freeze array buffer views with elements"
      // We accept best-effort here; bytes remain mutable in those hosts.
    }
    return;
  }

  // Recurse into arrays
  if (Array.isArray(data)) {
    for (const item of data) {
      recursiveFreeze(item as DocumentFieldValue);
    }
    Object.freeze(data);
    return;
  }

  // Recurse into plain objects
  for (const key of Object.keys(data)) {
    recursiveFreeze(
      (data as Record<string, unknown>)[key] as DocumentFieldValue
    );
  }

  Object.freeze(data);
}

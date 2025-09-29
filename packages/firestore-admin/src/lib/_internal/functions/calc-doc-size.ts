import {
  DocumentData,
  DocumentReference,
  GeoPoint,
  Timestamp,
} from 'firebase-admin/firestore';
import { isVectorLikeShallow, vectorDims } from './util.js';

/** Firestore per-document serialized size limit (bytes). 1 MiB = 1,048,576 bytes. */
export const MAX_DOC_SIZE_BYTES = 1_048_576;

/**
 * Checks whether a document fits Firestore’s per-document serialized size limit (≤ 1,048,576 bytes).
 *
 * The size is computed by {@link calcDocSize}, which includes:
 *  - document name size (path segments relative to `/documents`, UTF-8 bytes + 1 per segment, +16),
 *  - 32 bytes of document overhead,
 *  - field name sizes (UTF-8 bytes + 1 each),
 *  - field value sizes (e.g., strings = UTF-8 bytes + 1; bytes = raw length; numbers = 8; boolean/null = 1;
 *    Timestamp = 8; GeoPoint = 16; Reference = document name size; arrays/maps = sum of children;
 *    VectorValue = 8 bytes × dimensions).
 *
 * @param docName - Document path **relative to** the database `/documents` root (e.g. "users/alice/tasks/t1").
 * @param docData - Document contents to be serialized using Firestore’s rules.
 * @returns `true` if the serialized size is **≤** {@link MAX_DOC_SIZE_BYTES}, otherwise `false`.
 */
export function isDocSizeWithinLimit(
  docName: string,
  docData: DocumentData
): boolean {
  return calcDocSize(docName, docData) <= MAX_DOC_SIZE_BYTES;
}

/**
 * Calculates the serialized Firestore document size in bytes.
 *
 * Formula:
 *   docSize =
 *     documentNameSize(docName)           // sum(UTF-8 bytes + 1) for each path segment + 16
 *     + 32                                // document overhead
 *     + sum( fieldNameSize + valueSize )  // for all (possibly nested) fields
 *
 * String size = UTF-8 byte length + 1.
 * Array size = sum of element sizes (no extra array overhead).
 * Map size   = sum over entries of (fieldNameSize + valueSize).
 * Number     = 8 bytes (int or double).
 * Boolean    = 1 byte.
 * Null       = 1 byte.
 * Timestamp  = 8 bytes.
 * GeoPoint   = 16 bytes.
 * Reference  = documentNameSize(referencedDocPath).
 * Bytes      = byteLength + 1 (Buffer/Uint8Array/ArrayBuffer/DataView).
 *
 * Notes:
 * - `docName` must be the path relative to `/documents`, e.g. "users/alice/tasks/t1".
 * - `undefined` fields are ignored (the Admin SDK omits them on write).
 * - Sentinel FieldValue transforms are not accounted here (compute size after transforms).
 */
export function calcDocSize(docName: string, docData: DocumentData): number {
  const nameBytes = documentNameSize(docName);
  const bodyBytes = 32 + mapSize(docData);
  return nameBytes + bodyBytes;
}

function documentNameSize(path: string): number {
  // Σ(stringSize(segment)) + 16
  const segs = path.split('/').filter(Boolean);
  let total = 16;
  for (const seg of segs) total += stringSize(seg);
  return total;
}

function stringSize(s: string): number {
  // UTF-8 bytes + 1
  return Buffer.byteLength(s, 'utf8') + 1;
}

function isByteLike(
  v: unknown
): v is Buffer | Uint8Array | ArrayBuffer | DataView {
  return (
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) ||
    v instanceof Uint8Array ||
    v instanceof ArrayBuffer ||
    v instanceof DataView
  );
}

function byteLikeSize(v: Buffer | Uint8Array | ArrayBuffer | DataView): number {
  // length + 1
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v.length + 1;
  if (v instanceof Uint8Array) return v.byteLength + 1;
  if (v instanceof ArrayBuffer) return v.byteLength + 1;
  return (v as DataView).byteLength + 1;
}

function isDocRef(v: unknown): v is DocumentReference {
  return v instanceof DocumentReference;
}

function valueSize(v: unknown): number {
  if (v === null) return 1;
  if (v === undefined) return 0; // undefined fields are not stored
  const t = typeof v;

  if (t === 'boolean') return 1;
  if (t === 'number') return 8;
  if (t === 'string') return stringSize(v as string);

  if (v instanceof Timestamp) return 8;
  if (v instanceof GeoPoint) return 16;

  if (isDocRef(v)) return documentNameSize(v.path);
  if (isByteLike(v)) return byteLikeSize(v);
  if (isVectorLikeShallow(v)) return vectorDims(v) * 8;

  if (Array.isArray(v)) {
    let sum = 0;
    for (const el of v) sum += valueSize(el);
    return sum;
  }

  if (typeof v === 'object') {
    return mapSize(v as Record<string, unknown>);
  }

  // Fallback (shouldn't be hit in valid Firestore data)
  return 0;
}

function mapSize(obj: Record<string, unknown>): number {
  let sum = 0;
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue; // Admin SDK omits undefined
    sum += stringSize(key) + valueSize(val);
  }
  return sum;
}

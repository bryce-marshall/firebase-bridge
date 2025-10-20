import type {
  MetaDocument,
  TriggerEventArg,
} from '@firebase-bridge/firestore-admin';
import { FirestoreController } from '@firebase-bridge/firestore-admin';
import { createHash } from 'crypto';
import {
  DocumentSnapshot as AdminDocSnap,
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  FieldPath,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';

import type { Change, firestore as firestoreV2 } from 'firebase-functions/v2';

export function eventGuid(
  controller: FirestoreController,
  meta: MetaDocument
): string {
  // Pack inputs deterministically
  const path = Buffer.from(toFirestorePath(controller, meta.path), 'utf8');
  const ints = Buffer.allocUnsafe(8 * 4); // version, server, create, update (all 64-bit)
  let o = 0;
  ints.writeBigUInt64BE(BigInt(meta.version), o);
  o += 8;
  ints.writeBigUInt64BE(BigInt(meta.serverTime.toMillis()), o);
  o += 8;
  ints.writeBigUInt64BE(
    BigInt((meta.createTime ?? meta.serverTime).toMillis()),
    o
  );
  o += 8;
  ints.writeBigUInt64BE(BigInt(meta.updateTime.toMillis()), o);

  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(path.length);

  // Hash → first 16 bytes → stamp UUID v5 (0101) + RFC4122 variant
  const h = createHash('sha1').update(ints).update(len).update(path).digest(); // sha1 for v5-ish
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC4122

  // Hex → 8-4-4-4-12
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Builds a fully-qualified Firestore **document resource name** in GAPIC form.
 *
 * Format:
 * ```
 * projects/{projectId}/databases/{databaseId}/documents/{localPath}
 * ```
 *
 * @param controller - Source of `projectId` and `databaseId`.
 * @param localPath - Document path relative to `/documents` (e.g. `"cities/LA"`).
 * @returns The fully-qualified document resource name.
 *
 * @example
 * toFirestorePath(ctrl, 'cities/LA');
 * // → "projects/my-proj/databases/(default)/documents/cities/LA"
 */
export function toFirestorePath(
  controller: FirestoreController,
  localPath: string
): string {
  return `projects/${controller.projectId}/databases/${controller.databaseId}/documents/${localPath}`;
}

/**
 * Canonical kinds of Firestore document change events understood by
 * Functions v1/v2 handlers and this bridge.
 */
export type Kind = 'create' | 'update' | 'delete';

/**
 * Infers the **specific** change kind (`create` | `update` | `delete`) from a
 * {@link MetaDocument}. Returns `undefined` for **no-op** writes that did not
 * modify user-visible fields (so that `onUpdate` does not fire).
 *
 * Notes:
 * - Does **not** return `'write'`; callers that handle generic "written"
 *   semantics should map `undefined|create|update|delete` accordingly.
 *
 * @param m - The meta-document emitted by the bridge.
 * @returns The inferred kind, or `undefined` if the write is a no-op.
 */
export function changeKind(m: MetaDocument): Kind | undefined {
  const prev = m.previous;
  if (m.exists) {
    if (!prev || !prev.exists) return 'create';
    return m.hasChanges ? 'update' : undefined; // no-op writes don't fire onUpdate
  } else {
    return prev && prev.exists ? 'delete' : undefined;
  }
}

// /**
//  * Executes a function within a **minimal Cloud Functions-like environment**,
//  * setting environment variables commonly read by the Functions SDK:
//  * `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, and `FIREBASE_CONFIG`.
//  *
//  * Environment variables are restored to their previous values after `run`
//  * completes (successfully or with an error).
//  *
//  * @typeParam T - Return type of the `run` callback.
//  * @param ctx - Controller providing `projectId` and `databaseId`.
//  * @param run - Function to execute under the temporary environment.
//  * @returns The result of `run()`.
//  *
//  * @example
//  * const result = withFunctionsEnv(controller, () => handler.run(payload, ctx));
//  */
// export function withFunctionsEnv<T>(ctx: FirestoreController, run: () => T): T {
//   const keys = [
//     'GOOGLE_CLOUD_PROJECT',
//     'GCLOUD_PROJECT',
//     'FIREBASE_CONFIG',
//   ] as const;
//   const prev: Record<string, string | undefined> = {};
//   for (const k of keys) prev[k] = process.env[k];

//   const projectId = ctx.projectId;
//   const databaseId = ctx.databaseId;
//   Object.assign(process.env, {
//     GOOGLE_CLOUD_PROJECT: projectId,
//     GCLOUD_PROJECT: projectId,
//     FIREBASE_CONFIG: JSON.stringify({ projectId, databaseId }),
//   });


//   try {
//     return run();
//   } finally {
//     for (const k of keys) {
//       if (prev[k] === undefined) {
//         delete process.env[k];
//       } else {
//         process.env[k] = prev[k];
//       }
//     }
//   }
// }

export interface ChangeRecord {
  kind: Kind;
  before: AdminDocSnap;
  after: AdminDocSnap;
}

export function toChangeRecord(
  firestore: Firestore,
  meta: MetaDocument
): ChangeRecord | undefined {
  const kind = meta ? changeKind(meta) : undefined;
  if (!kind) return undefined;

  const after = toDocumentSnapshot(firestore, kind, meta.path, meta);
  const before = toDocumentSnapshot(
    firestore,
    'update',
    meta.path,
    meta.previous
  );

  return {
    kind,
    before,
    after,
  };
}

export function nonExistingSnapshotLike(existing: AdminDocSnap): AdminDocSnap {
  const exists = false;
  const ref = existing.ref;
  const readTime = existing.readTime;
  return {
    id: ref.id,
    ref,
    exists,
    createTime: undefined,
    updateTime: undefined,
    readTime,
    get: () => undefined,
    data: () => undefined,
    isEqual: (other: AdminDocSnap) => isEqual(other, ref, exists, undefined),
  };
}

/**
 * Constructs a **structural** Admin SDK {@link DocumentSnapshot} suitable for
 * Cloud Functions handlers and tests.
 *
 * Characteristics:
 * - Uses a real {@link DocumentReference} (from the provided Admin `Firestore`)
 *   for `.ref`, `.id`, and path identity checks.
 * - Implements key snapshot APIs: `.exists`, `.data()`, `.get(field)`,
 *   `.readTime`, `.updateTime`, `.createTime`, `.isEqual(other)`.
 * - For non-existent docs (`meta` undefined or `{ exists: false }`), `.exists`
 *   is `false` and `.data()` returns `undefined`.
 *
 * Field access:
 * - `.get(field)` supports dotted string paths and basic `FieldPath` usage
 *   via stringification; this covers common test cases but is not a full
 *   escape/quoting implementation.
 *
 * Timestamps:
 * - `readTime` is chosen as `meta.serverTime` (if available), otherwise
 *   `meta.updateTime`, otherwise epoch (`Timestamp.fromMillis(0)`).
 *
 * @param db - Admin `Firestore` instance from the mock/bridge.
 * @param path - Document path like `"col/a/sub/b"`.
 * @param meta - The meta-document for the desired state (`before` or `after`).
 * @returns A structural `DocumentSnapshot` instance.
 *
 * @example
 * const before = toDocumentSnapshot(db, 'cities/LA', meta.previous);
 * const after  = toDocumentSnapshot(db, 'cities/LA', meta);
 */
function toDocumentSnapshot(
  db: Firestore,
  kind: Kind,
  path: string,
  meta: MetaDocument | undefined
): AdminDocSnap {
  const ref: DocumentReference = db.doc(path);
  const exists = !!meta?.exists;
  const frozen = meta?.data; // already Object.freeze()'d on MetaDocument
  const createTime = exists
    ? meta.createTime
    : kind === 'delete'
    ? meta?.previous?.createTime
    : undefined;
  const updateTime = meta ? meta.updateTime : undefined;
  const readTime: Timestamp =
    meta?.serverTime ?? updateTime ?? Timestamp.fromMillis(0);

  // light field resolver for .get(); supports dotted string paths & FieldPath (basic)
  const getField = (
    data: DocumentData | undefined,
    field: string | FieldPath
  ) => {
    if (!data) return undefined;
    const parts =
      typeof field === 'string'
        ? field.split('.')
        : // FieldPath.toString() returns a dotted form without escaping in Admin SDK;
          // good enough for most test cases. If full escaping fidelity is required, add a parser.
          String(field).split('.');
    let cur = data;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  };

  // Build a structural object that satisfies the Admin DocumentSnapshot shape.
  const snap: Partial<AdminDocSnap> = {
    ref,
    id: ref.id,
    exists,
    createTime,
    updateTime,
    readTime,
    data: () =>
      kind === 'delete' ? meta?.previous?.cloneData() : meta?.cloneData(),
    get: (field: string | FieldPath) => getField(frozen, field),
    isEqual: (other: AdminDocSnap) => isEqual(other, ref, exists, updateTime),
  };

  return snap as AdminDocSnap;
}

function isEqual(
  other: AdminDocSnap,
  ref: DocumentReference,
  exists: boolean,
  updateTime: Timestamp | undefined
): boolean {
  return (
    other.ref.path === ref.path &&
    !!other.exists === exists &&
    (!!other.updateTime && !!updateTime
      ? other.updateTime.isEqual(updateTime)
      : other.updateTime === updateTime)
  );
}

export type V2CloudEventData =
  | Change<firestoreV2.DocumentSnapshot>
  | firestoreV2.DocumentSnapshot
  | firestoreV2.QueryDocumentSnapshot;

export type V2CloudEvent = firestoreV2.FirestoreEvent<V2CloudEventData>;

export type GenericTriggerEventData = firestoreV2.FirestoreEvent<unknown>;

/**
 * Builds a Firestore **CloudEvent** payload (v2) from a meta-document change.
 *
 * Event mapping:
 * - **create**  → `type: 'google.cloud.firestore.document.v1.created'`, `data: after`
 * - **delete**  → `type: 'google.cloud.firestore.document.v1.deleted'`, `data: before`
 * - **update**  → `type: 'google.cloud.firestore.document.v1.updated'`, `data: { before, after }`
 * - **write**   → `type: 'google.cloud.firestore.document.v1.written'`, `data: { before, after }`
 *
 * Common CloudEvent fields produced:
 * - `id`: `${version}:${subject}` (stable identifier useful for test de-duplication)
 * - `time`: ISO-8601 timestamp (derived from the change server time)
 * - `subject`: the document path (e.g., `"cities/LA"`)
 * - `source`: `"projects/{projectId}/databases/{databaseId|(default)}"`
 * - `params`: an object for route parameters (filled by caller)
 *
 * @param ctrl - The controller providing project/database identifiers.
 * @param emitKind - The kind to emit (`'create' | 'update' | 'delete' | 'write'`).
 * @param subject - Document path for the event `subject`.
 * @param before - Snapshot representing the previous state.
 * @param after - Snapshot representing the current state.
 * @param version - Monotonic version used to form the event id.
 * @param isoTime - Event time in ISO-8601 format.
 * @returns A CloudEvent-like object suitable for Functions v2 handlers.
 * @internal
 */
export function buildCloudEvent(
  ctrl: FirestoreController,
  emitKind: Kind | 'write', // <-- allow 'write'
  arg: TriggerEventArg,
  before: DocumentSnapshot,
  after: DocumentSnapshot
): GenericTriggerEventData {
  let type: string;
  let data: V2CloudEventData;

  switch (emitKind) {
    case 'create':
      type = 'google.firestore.document.create';
      data = after;
      break;

    case 'delete':
      type = 'google.firestore.document.delete';
      data = after;
      break;

    case 'update':
      type = 'google.firestore.document.update';
      data = { before, after };

      break;

    case 'write':
      type = 'google.firestore.document.write';
      data = { before, after };
      break;
  }

  const meta = arg.doc;
  const source = `//firestore.googleapis.com/projects/${ctrl.projectId}/databases/${ctrl.databaseId}`;
  const event: V2CloudEvent = {
    id: eventGuid(ctrl, meta),
    type,
    time: meta.serverTime.toDate().toISOString(),
    document: meta.path,
    source,
    subject: `documents/${meta.path}`,
    params: arg.params,
    data,
    location: ctrl.location,
    project: ctrl.projectId,
    database: ctrl.databaseId,
    namespace: ctrl.namespace,
    specversion: '1.0',
  };

  return event;
}

export function runUnavailableMsg(version: 'v1' | 'v2'): string {
  return (
    'CloudFunction.run() not available. Pass the exported CloudFunction wrapper ' +
    `from firebase-functions/${version} (not the raw handler), or upgrade firebase-functions.`
  );
}

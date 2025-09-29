/* eslint-disable @typescript-eslint/no-explicit-any */
import { FirestoreController } from '@firebase-bridge/firestore-admin';
import {
  DocumentSnapshot,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import type { CloudFunction } from 'firebase-functions/v2';
import {
  FirestoreEvent,
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentUpdated,
  onDocumentWritten,
} from 'firebase-functions/v2/firestore';
import { nonExistingSnapshotLike } from '../../lib/_internal/util.js';
import { registerTrigger as registerV2 } from '../../lib/v2/register-trigger.js';
import {
  CommonTriggerEvent,
  TriggerDescriptor,
  TriggerFactory,
  TriggerUnsubsciber,
} from './factory.js';

function commonMetaFromV2(
  ctrl: FirestoreController,
  ev: any, // CloudEvent
  subjectPath?: string
) {
  const path = subjectPath ?? ev?.subject ?? ev?.data?.ref?.path ?? '';
  const projectId = ctrl.projectId;
  const databaseId = ctrl.databaseId;
  return {
    id: ev?.id ?? `${Date.now()}:${path}`,
    time: ev?.time ?? new Date().toISOString(),
    params: (ev?.params ?? {}) as Record<string, string>,
    resourceName: `projects/${projectId}/databases/${databaseId}/documents/${path}`,
  };
}

function isDocSnap(x: any): x is DocumentSnapshot {
  return (
    x &&
    typeof x === 'object' &&
    typeof x.data === 'function' &&
    x.ref &&
    typeof x.exists === 'boolean'
  );
}
function isChangePayload(
  x: any
): x is { before: DocumentSnapshot; after: DocumentSnapshot } {
  return (
    x && typeof x === 'object' && isDocSnap(x.before) && isDocSnap(x.after)
  );
}

export function eventFromV2Change(
  ctrl: FirestoreController,
  ev: FirestoreEvent<any, Record<string, string>>
): CommonTriggerEvent {
  const t = String(ev?.type ?? '');

  let before: DocumentSnapshot;
  let after: DocumentSnapshot;

  if (isChangePayload(ev?.data)) {
    // onDocumentWritten / onDocumentUpdated
    before = ev.data.before;
    after = ev.data.after;
  } else if (isDocSnap(ev?.data)) {
    // onDocumentCreated / onDocumentDeleted
    const snap = ev.data;
    if (t.includes('.created')) {
      before = nonExistingSnapshotLike(snap);
      after = snap;
    } else if (t.includes('.deleted')) {
      before = snap;
      after = nonExistingSnapshotLike(snap);
    } else {
      // Fallback by existence if type is missing/unknown
      before = snap.exists ? nonExistingSnapshotLike(snap) : snap;
      after = snap.exists ? snap : nonExistingSnapshotLike(snap);
    }
  } else {
    throw new Error(
      'Unexpected v2 Firestore event payload: neither Change nor DocumentSnapshot.'
    );
  }

  const subject = ev?.subject ?? after?.ref?.path ?? before?.ref?.path ?? '';

  return {
    before,
    after,
    meta: commonMetaFromV2(ctrl, ev, subject),
  };
}

function eventFromV2Created(
  ctrl: FirestoreController,
  ev: FirestoreEvent<QueryDocumentSnapshot | undefined, Record<string, string>>
): CommonTriggerEvent {
  const snap = ev?.data as FirebaseFirestore.DocumentSnapshot;
  const before = nonExistingSnapshotLike(snap);
  const after = snap;
  const subject = ev?.subject ?? snap?.ref?.path ?? '';
  return {
    before,
    after,
    meta: commonMetaFromV2(ctrl, ev, subject),
  };
}

function eventFromV2Deleted(
  ctrl: FirestoreController,
  ev: FirestoreEvent<QueryDocumentSnapshot | undefined, Record<string, string>>
): CommonTriggerEvent {
  const snap = ev?.data as FirebaseFirestore.DocumentSnapshot;
  const before = nonExistingSnapshotLike(snap);
  const after = snap;
  const subject = ev?.subject ?? snap?.ref?.path ?? '';
  return {
    before,
    after,
    meta: commonMetaFromV2(ctrl, ev, subject),
  };
}

export const v2TriggerFactory: TriggerFactory = (
  ctrl: FirestoreController,
  descriptor: TriggerDescriptor,
  handler: (event: CommonTriggerEvent) => unknown
): TriggerUnsubsciber => {
  // Build a real v2 Cloud Function (CloudEvent-based)
  let fn: CloudFunction<any>;

  switch (descriptor.type) {
    case 'create':
      fn = onDocumentCreated(descriptor.route, (ev) =>
        handler(eventFromV2Created(ctrl, ev))
      );
      break;

    case 'delete':
      fn = onDocumentDeleted(descriptor.route, (ev) =>
        handler(eventFromV2Deleted(ctrl, ev))
      );
      break;

    case 'update':
      fn = onDocumentUpdated(descriptor.route, (ev) =>
        handler(eventFromV2Change(ctrl, ev))
      );
      break;

    case 'write':
      fn = onDocumentWritten(descriptor.route, (ev) =>
        handler(eventFromV2Change(ctrl, ev))
      );
      break;
  }

  // Bind to the mock via the v2 adapter
  return registerV2(ctrl, fn);
};

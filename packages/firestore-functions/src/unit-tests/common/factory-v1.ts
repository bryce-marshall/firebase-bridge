/* eslint-disable @typescript-eslint/no-explicit-any */
import { FirestoreController } from '@firebase-bridge/firestore-admin';
import {
  Change,
  CloudFunction,
  EventContext,
  firestore,
} from 'firebase-functions/v1';
import { nonExistingSnapshotLike } from '../../lib/_internal/util.js';
import { registerTrigger } from '../../lib/v1/register-trigger.js';
import {
  CommonTriggerEvent,
  TriggerDescriptor,
  TriggerUnsubsciber,
} from './factory.js';

export function v1TriggerFactory(
  ctrl: FirestoreController,
  descriptor: TriggerDescriptor,
  handler: (event: CommonTriggerEvent) => unknown
): TriggerUnsubsciber {
  function changeHandler(
    change: Change<firestore.DocumentSnapshot>,
    context: EventContext
  ): any {
    return handler(eventFromChange(change, context));
  }

  function snapshotHandler(
    snapshot: firestore.QueryDocumentSnapshot,
    context: EventContext
  ): any {
    return handler(eventFromSnapshot(snapshot, context));
  }

  const document = firestore.document(descriptor.route);
  let fn: CloudFunction<any>;

  switch (descriptor.type) {
    case 'create':
      fn = document.onCreate(snapshotHandler);
      break;

    case 'delete':
      fn = document.onDelete(snapshotHandler);
      break;

    case 'update':
      fn = document.onUpdate(changeHandler);
      break;

    case 'write':
      fn = document.onWrite(changeHandler);
      break;
  }

  return registerTrigger(ctrl, fn);
}

function resourceNameFrom(context: EventContext, docPath: string): string {
  const name = (context as any)?.resource?.name as string | undefined;
  if (name) return name;

  const project =
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCLOUD_PROJECT ??
    'default-project';

  let database = '(default)';
  try {
    const cfg =
      process.env.FIREBASE_CONFIG && JSON.parse(process.env.FIREBASE_CONFIG);
    database = cfg?.databaseId || database;
  } catch {
    /* ignore */
  }

  return `projects/${project}/databases/${database}/documents/${docPath}`;
}

function commonMeta(context: EventContext, docPath: string) {
  return {
    id: context.eventId,
    time: context.timestamp,
    params: context.params ?? {},
    resourceName: resourceNameFrom(context, docPath),
  };
}

function pathOf(s?: firestore.DocumentSnapshot | null): string | undefined {
  return s ? s.ref.path : undefined;
}

export function eventFromChange(
  change: Change<firestore.DocumentSnapshot>,
  context: EventContext
): CommonTriggerEvent {
  const path = pathOf(change.after) ?? pathOf(change.before) ?? '';
  return {
    before: change.before,
    after: change.after,
    meta: commonMeta(context, path),
  };
}

export function eventFromSnapshot(
  snapshot: firestore.QueryDocumentSnapshot, // v1 onCreate provides exists=true; onDelete provides exists=false via DocumentSnapshot
  context: EventContext
): CommonTriggerEvent {
  return eventFromChange(
    {
      before: nonExistingSnapshotLike(snapshot),
      after: snapshot,
    },
    context
  );
}

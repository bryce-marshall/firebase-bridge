import { FirestoreController } from '@firebase-bridge/firestore-admin';
import { DocumentSnapshot } from 'firebase-admin/firestore';

export interface CommonTriggerEvent<
  TParams extends Record<string, string> = Record<string, string>
> {
  before: DocumentSnapshot;
  after: DocumentSnapshot;
  meta: {
    id: string; // v1: context.eventId; v2: event.id
    time: string; // v1: context.timestamp; v2: event.time
    params: TParams; // v1: context.params; v2: event.params
    resourceName: string; // v1: context.resource.name; v2: build from event.subject
  };
}

export interface TriggerDescriptor {
  type: 'write' | 'create' | 'update' | 'delete';
  route: string;
}

export type TriggerUnsubsciber = () => void;

export type TriggerFactory = (
  ctrl: FirestoreController,
  descriptor: TriggerDescriptor,
  handler: (event: CommonTriggerEvent) => unknown
) => TriggerUnsubsciber;

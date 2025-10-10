/* eslint-disable @typescript-eslint/no-explicit-any */
import { CloudFunction } from 'firebase-functions/v1';
import { Kind } from '../_internal/util.js';

export type TriggerMetaV1 = {
  route: string; // e.g. "users/{uid}/accounts/{aid}"
  kinds: (Kind | 'write')[]; // mapped from eventType
  resource: string; // full resource name
  eventType: string; // raw event type string
};

function getEndpointSafe(h: any) {
  try {
    return h.__endpoint;
  } catch {
    // no-op
  }
  try {
    return h.__trigger;
  } catch {
    // no-op
  }
  return undefined;
}

function mapKinds(eventType: string): (Kind | 'write')[] {
  if (eventType.includes('document.create')) return ['create'];
  if (eventType.includes('document.update')) return ['update'];
  if (eventType.includes('document.delete')) return ['delete'];
  return ['write'];
}

export function getTriggerMeta(handler: CloudFunction<any>): TriggerMetaV1 {
  const ep = getEndpointSafe(handler);
  const resource: string | undefined = ep?.eventTrigger?.eventFilters?.resource;
  const eventType: string | undefined = ep?.eventTrigger?.eventType;
  if (!resource || !eventType) {
    throw new Error('Not a Firestore event function or missing metadata');
  }
  const i = resource.indexOf('/documents/');
  const route = i >= 0 ? resource.slice(i + '/documents/'.length) : resource;
  return { route, kinds: mapKinds(eventType), resource, eventType };
}

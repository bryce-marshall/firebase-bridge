import type { CloudEvent, CloudFunction } from 'firebase-functions/v2';
import { Kind } from '../_internal/util.js';

/**
 * Metadata describing a Firestore v2 trigger that we care about for routing.
 *
 * - `route` is the document path template relative to `/documents`
 *   (e.g. `"users/{uid}/accounts/{aid}"`).
 * - `kinds` is a one-element array indicating which specific change kind
 *   the trigger represents (`'create' | 'update' | 'delete' | 'write'`),
 *   derived from the endpoint's `eventType`.
 */
export type TriggerMetaV2 = {
  route: string; // e.g. "users/{uid}/accounts/{aid}"
  kinds: (Kind | 'write')[]; // mapped from eventType
};

/**
 * Maps a v2 Firestore CloudEvent `eventType` to an internal change kind.
 *
 * Handles both new (`*.document.v1.*`) and older (`*.document.*`) type strings.
 *
 * @param eventType - CloudEvent type string from the endpoint manifest.
 * @returns A single-element tuple with the mapped {@link Kind}.
 */
function mapKindsV2(eventType: string): [Kind | 'write'] {
  const et = eventType || '';
  if (et.includes('document.v1.created')) return ['create'];
  if (et.includes('document.v1.updated')) return ['update'];
  if (et.includes('document.v1.deleted')) return ['delete'];
  if (et.includes('document.v1.written')) return ['write'];
  // fallback
  if (et.includes('document.created')) return ['create'];
  if (et.includes('document.updated')) return ['update'];
  if (et.includes('document.deleted')) return ['delete'];
  if (et.includes('document.written')) return ['write'];

  return ['write'];
}

/**
 * A CloudEvent filter expressed as an object map (common in v2 endpoint manifests),
 * e.g. `{ database: '(default)', document: 'users/{userId}/profile' }`.
 */
type EventFilterObject = Readonly<Record<string, string | undefined>>;

/**
 * A CloudEvent filter expressed as an array of key/value entries (older / alt form),
 * e.g. `[{ attribute: 'document', value: 'users/{userId}/profile' }, ...]`.
 * `operator` is included for completeness (e.g., `'match-path-pattern'` on GCF).
 */
type EventFilterArray = ReadonlyArray<
  Readonly<{
    attribute?: string;
    value?: string;
    operator?: string;
  }>
>;

/**
 * Path-pattern version of filters: attribute → **path pattern**.
 * For Firestore, this commonly carries the document route template, e.g.:
 * `{ document: 'users/{userId}/data/profile' }`.
 */
type EventFilterPathPatterns = Readonly<Record<string, string | undefined>>;

/**
 * Minimal, public-safe shape for a v2 Firestore event trigger section.
 * Captures both object and array forms of `eventFilters`, plus
 * `eventFilterPathPatterns` used for path-template matching.
 */
type EventTrigger = Readonly<{
  /** e.g. 'google.cloud.firestore.document.v1.written' */
  eventType: string;

  /** Filters can appear as an object map or an array of entries. */
  eventFilters?: EventFilterObject | EventFilterArray;

  /** Path-pattern filters as an attribute → path-pattern map. */
  eventFilterPathPatterns?: EventFilterPathPatterns;

  /** v1-style fallback: fully-qualified resource string with '/documents/' */
  resource?: string;
}>;

/**
 * Minimal public-safe shape for the internal function metadata.
 * Covers both modern `__endpoint` and legacy `__trigger` layouts.
 */
type EndpointLike = Readonly<{
  eventTrigger?: EventTrigger;
}>;

/**
 * Helper shape for safely reading internal properties off the CloudFunction wrapper.
 */
type EndpointHost = {
  __endpoint?: EndpointLike;
  __trigger?: EndpointLike;
};

/**
 * Safely extracts the internal endpoint/trigger description from a v2 CloudFunction.
 *
 * Tries `__endpoint` first (current), then `__trigger` (legacy). Returns `undefined`
 * if neither property is available (which can happen in some test environments).
 *
 * @param h - The CloudFunction wrapper returned by `firebase-functions/v2`.
 * @returns The endpoint manifest subset we care about, or `undefined`.
 */
function getEndpointSafe(
  h: CloudFunction<CloudEvent<unknown>>
): EndpointLike | undefined {
  try {
    return (h as EndpointHost).__endpoint;
  } catch {
    //
  }
  try {
    return (h as EndpointHost).__trigger;
  } catch {
    //
  }
  return undefined;
}

/**
 * Extracts the Firestore **document route template** from an {@link EventTrigger}.
 *
 * Resolution order:
 * 1. `eventFilterPathPatterns` (object form): uses `document`/`doc`/`path`/`subject`
 * 2. `eventFilters` (array form): finds `{ attribute: 'document', value: '...' }`
 * 3. `eventFilters` (object form): reads `document` directly
 * 4. `resource` (v1-style): slices after `'/documents/'`
 *
 * @param et - The event trigger manifest section.
 * @returns The route template relative to `/documents`, e.g. `"users/{id}"`.
 * @throws If no supported field is found.
 */
function extractRouteFromEventTrigger(et: EventTrigger): string {
  // v2 shape #1: objects
  //   eventFilters: { database: '(default)', namespace: '(default)' }
  //   eventFilterPathPatterns: { document: 'users/{userId}/data/profile' }
  const objPath = et?.eventFilterPathPatterns;
  if (objPath && typeof objPath === 'object') {
    const cand =
      objPath.document ?? objPath.doc ?? objPath.path ?? objPath.subject;
    if (typeof cand === 'string' && cand.length) return cand;
  }

  // v2 shape #2: arrays
  //   eventFilters: [{ attribute:'document', value:'col/{id}' }, ...]
  const arr = et?.eventFilters;
  if (Array.isArray(arr)) {
    const f = arr.find(
      (x: { attribute: string }) => x?.attribute === 'document'
    );
    if (f?.value) return String(f.value);
  }

  // v2 shape #3: eventFilters as object with 'document'
  if (arr && typeof arr === 'object') {
    const cand = (arr as { document: string }).document;
    if (typeof cand === 'string' && cand.length) return cand;
  }

  // Fallback to v1-style resource
  const res: string | undefined = et?.resource;
  if (typeof res === 'string') {
    const i = res.indexOf('/documents/');
    if (i >= 0) return res.slice(i + '/documents/'.length);
  }

  throw new Error(
    'Unable to extract Firestore document route from v2 endpoint.'
  );
}

/** Extracts route/kinds from a v2 Cloud Function endpoint. */
export function getTriggerMetaV2(
  handler: CloudFunction<CloudEvent<unknown>>
): TriggerMetaV2 {
  const ep = getEndpointSafe(handler);
  const et = ep?.eventTrigger;
  if (!et)
    throw new Error('Not a Firestore v2 event function (missing eventTrigger)');

  const route = extractRouteFromEventTrigger(et);
  const kinds = mapKindsV2(et.eventType);

  return { route, kinds };
}

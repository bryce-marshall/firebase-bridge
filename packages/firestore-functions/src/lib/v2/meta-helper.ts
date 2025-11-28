import { Expression } from 'firebase-functions/params';
import type { CloudEvent, CloudFunction } from 'firebase-functions/v2';
import { ManifestEndpoint } from 'node_modules/firebase-functions/lib/runtime/manifest.js';
import {
  GenericTriggerMeta,
  TriggerKind,
} from '../_internal/trigger-runner.js';

/**
 * Maps a v2 Firestore CloudEvent `eventType` to an internal change kind.
 *
 * Handles both new (`*.document.v1.*`) and older (`*.document.*`) type strings.
 *
 * @param eventType - CloudEvent type string from the endpoint manifest.
 * @returns A single-element tuple with the mapped {@link Kind}.
 */
function mapKinds(eventType: string | undefined): TriggerKind[] {
  if (!eventType) return [];
  const et = eventType || '';
  if (et.includes('.created')) return ['create'];
  if (et.includes('.updated')) return ['update'];
  if (et.includes('.deleted')) return ['delete'];
  if (et.includes('.written')) return ['write'];

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

type ResetValue = unknown;

/**
 * Minimal public-safe shape for the internal function metadata.
 * Covers both modern `__endpoint` and legacy `__trigger` layouts.
 */
interface EventTriggerLike {
  eventFilters: Record<string, string | Expression<string>>;
  eventFilterPathPatterns?: Record<string, string | Expression<string>>;
  channel?: string;
  eventType: string;
  retry: boolean | Expression<boolean> | ResetValue;
  region?: string;
  serviceAccountEmail?: string | ResetValue;
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
function extractRouteFromEventTrigger(et: EventTriggerLike): string {
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
  const res: string | undefined = (et as EventTrigger)?.resource;
  if (typeof res === 'string') {
    const i = res.indexOf('/documents/');
    if (i >= 0) return res.slice(i + '/documents/'.length);
  }

  throw new Error(
    'Unable to extract Firestore document route from v2 endpoint.'
  );
}

/**
 * Derives minimal Firestore trigger metadata from a v2 endpoint manifest.
 *
 * @remarks
 * This helper inspects the `eventTrigger` section of a `ManifestEndpoint`
 * produced by `firebase-functions/v2` and extracts:
 *
 * - {@link GenericTriggerMeta.route} — the Firestore **document route
 *   template** (e.g. `"users/{userId}/profile"`), resolved via
 *   {@link extractRouteFromEventTrigger}.
 * - {@link GenericTriggerMeta.kinds} — the inferred change kind(s) based on
 *   the CloudEvent `eventType`, using {@link mapKinds}.
 *
 * If `ep` is `undefined` or does not describe a Firestore document trigger,
 * the returned object may have `route` or `kinds` omitted.
 *
 * @param ep - The v2 endpoint manifest for a Cloud Function handler.
 * @returns A partial {@link GenericTriggerMeta} containing any resolved
 *          `route` and `kinds` values.
 */
export function getTriggerMeta(
  ep: ManifestEndpoint | undefined
): Partial<GenericTriggerMeta> {
  const et = ep?.eventTrigger;
  const route = et ? extractRouteFromEventTrigger(et) : undefined;
  const kinds = mapKinds(et?.eventType);

  return { route, kinds };
}

/** Extracts route/kinds from a v2 Cloud Function endpoint. */
export function triggerMetaFromFunction(
  handler: CloudFunction<CloudEvent<unknown>>
): GenericTriggerMeta {
  const meta = getTriggerMeta(handler?.__endpoint);
  if (!meta.kinds?.length || !meta.route) {
    throw new Error('Not a Firestore event function or missing metadata');
  }

  return meta as GenericTriggerMeta;
}

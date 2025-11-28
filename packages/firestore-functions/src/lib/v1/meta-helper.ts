import { CloudFunction } from 'firebase-functions/v1';
import { ManifestEndpoint } from 'node_modules/firebase-functions/lib/runtime/manifest.js';
import {
  GenericTriggerMeta,
  TriggerKind,
} from '../_internal/trigger-runner.js';

/**
 * Lightweight representation of a Firebase Functions trigger annotation.
 *
 * @remarks
 * This mirrors the subset of fields exposed on `CloudFunction.__trigger` and
 * manifest endpoints that are relevant for extracting Firestore trigger
 * metadata. Only properties that may be consulted by {@link getTriggerMeta}
 * and {@link triggerMetaFromFunction} are included.
 */
export interface TriggerAnnotationLike {
  /** Amount of memory allocated to the function instance, in MB. */
  availableMemoryMb?: number;

  /**
   * Configuration for blocking triggers such as before/after create hooks.
   *
   * @remarks
   * The exact shape is intentionally loose, as it is owned by
   * `firebase-functions` and may evolve over time.
   */
  blockingTrigger?: {
    /** Event type identifier for the blocking trigger. */
    eventType: string;
    /** Provider-specific options for the blocking trigger. */
    options?: Record<string, unknown>;
  };

  /**
   * Event-trigger configuration for background functions.
   *
   * @remarks
   * For Firestore triggers, this describes the document event type and
   * resource path used to derive the trigger route.
   */
  eventTrigger?: {
    /**
     * Event type string.
     *
     * @example
     * `'providers/cloud.firestore/eventTypes/document.create'`
     */
    eventType: string;
    /**
     * Fully-qualified resource for the event source.
     *
     * @example
     * `'projects/{projectId}/databases/(default)/documents/collection/{id}'`
     */
    resource: string;
    /** Backend service identifier for the event source. */
    service: string;
  };

  /**
   * Failure policy configuration controlling automatic retries.
   *
   * @remarks
   * Left as `unknown` to avoid depending on internal `firebase-functions`
   * types.
   */
  failurePolicy?: unknown;

  /**
   * HTTPS trigger configuration for callable or HTTP functions.
   *
   * @remarks
   * Included for completeness; not used when extracting Firestore metadata.
   */
  httpsTrigger?: {
    /** List of IAM members allowed to invoke the HTTPS endpoint. */
    invoker?: string[];
  };

  /** User-defined labels attached to the function deployment. */
  labels?: {
    [key: string]: string;
  };

  /** GCP regions in which the function is deployed. */
  regions?: string[];

  /**
   * Schedule configuration for scheduled (cron) functions.
   *
   * @remarks
   * Left as `unknown` to avoid depending on internal `firebase-functions`
   * types.
   */
  schedule?: unknown;

  /** Function timeout expressed as a duration string (for example `"60s"`). */
  timeout?: string;

  /** Name of the VPC connector used by the function, if any. */
  vpcConnector?: string;

  /** Egress settings applied to the VPC connector. */
  vpcConnectorEgressSettings?: string;

  /** Service account email used to execute the function. */
  serviceAccountEmail?: string;

  /** Network ingress settings for the function. */
  ingressSettings?: string;

  /** Names of secrets mounted for the function. */
  secrets?: string[];
}

/**
 * Map a Firestore event type string to the corresponding {@link TriggerKind}s.
 *
 * @remarks
 * This performs a simple substring match against known Firestore document
 * event type suffixes:
 *
 * - `"document.create"` → `["create"]`
 * - `"document.update"` → `["update"]`
 * - `"document.delete"` → `["delete"]`
 * - Anything else (including generic `"document.write"`) → `["write"]`
 *
 * If `eventType` is `undefined`, an empty array is returned.
 *
 * @param eventType - Event type string from a manifest or trigger annotation.
 * @returns The inferred trigger kinds, or an empty array when unknown.
 */
function mapKinds(eventType: string | undefined): TriggerKind[] {
  if (!eventType) return [];

  if (eventType.includes('document.create')) return ['create'];
  if (eventType.includes('document.update')) return ['update'];
  if (eventType.includes('document.delete')) return ['delete'];

  return ['write'];
}

/**
 * Derive minimal Firestore trigger metadata from a manifest endpoint and/or
 * trigger annotation.
 *
 * @remarks
 * This helper extracts two core pieces of information:
 *
 * - {@link GenericTriggerMeta.kinds} — derived from the event type using
 *   {@link mapKinds}.
 * - {@link GenericTriggerMeta.route} — derived from the Firestore resource by
 *   stripping the `/documents/` prefix from the fully-qualified resource path.
 *
 * When both `manifest` and `annotation` are provided, the manifest takes
 * precedence for `eventType` and `resource`.
 *
 * @example
 * ```ts
 * const meta = getTriggerMeta(endpoint, annotation);
 * // meta.kinds -> ['create']
 * // meta.route -> 'users/{userId}'
 * ```
 *
 * @param manifest - Parsed `ManifestEndpoint` produced by the Functions runtime.
 * @param annotation - Legacy trigger annotation attached to the handler.
 * @returns A partial {@link GenericTriggerMeta} containing the inferred
 *          trigger kinds and route; missing fields indicate that the supplied
 *          metadata does not describe a Firestore document event.
 */
export function getTriggerMeta(
  manifest: ManifestEndpoint | undefined,
  annotation?: TriggerAnnotationLike
): Partial<GenericTriggerMeta> {
  const eventType =
    manifest?.eventTrigger?.eventType ?? annotation?.eventTrigger?.eventType;

  const resource =
    (manifest?.eventTrigger?.eventFilters?.resource as string | undefined) ??
    annotation?.eventTrigger?.resource;

  const i = resource?.indexOf('/documents/') ?? -1;
  const route =
    i >= 0 ? (resource as string).slice(i + '/documents/'.length) : resource;

  return {
    kinds: mapKinds(eventType),
    route,
  };
}

/**
 * Extract {@link GenericTriggerMeta} from a `CloudFunction` handler instance.
 *
 * @remarks
 * Firebase Functions attaches internal metadata to deployed handlers via
 * private fields:
 *
 * - `handler.__endpoint` — v2-style manifest endpoint
 * - `handler.__trigger` — v1-style trigger annotation
 *
 * This helper reads those fields and derives the Firestore trigger metadata
 * using {@link getTriggerMeta}. If the handler is not a Firestore document
 * event function, or if required metadata cannot be resolved, an error is
 * thrown.
 *
 * @typeParam T - Event payload type of the `CloudFunction`.
 *
 * @param handler - Cloud Function whose Firestore trigger metadata should be
 *                  inspected.
 * @returns A fully-populated {@link GenericTriggerMeta} describing the
 *          Firestore trigger.
 * @throws If the handler does not represent a Firestore event function, or if
 *         either the trigger kinds or the route cannot be determined.
 */
export function triggerMetaFromFunction<T = unknown>(
  handler: CloudFunction<T>
): GenericTriggerMeta {
  const meta = getTriggerMeta(handler.__endpoint, handler.__trigger);
  if (!meta.kinds?.length || !meta.route) {
    throw new Error('Not a Firestore event function or missing metadata');
  }

  return meta as GenericTriggerMeta;
}

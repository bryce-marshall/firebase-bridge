import type { CloudEvent, CloudFunction } from 'firebase-functions/v2';
import type { StorageController } from '../types.js';
import {
  enqueueTriggerRun,
  extractBucketFilter,
  mapV2Kind,
  normalizeRegisterOptions,
  shouldDeliver,
  StorageCloudEventLike,
  toCloudEvent,
} from '../trigger-utils.js';
import type {
  RegisterStorageTriggerOptions,
  StorageTriggerPredicate,
} from '../types.js';

type V2StorageFunction = CloudFunction<CloudEvent<unknown>> & {
  __endpoint?: {
    eventTrigger?: {
      eventType?: string;
      eventFilters?: unknown;
    };
  };
};

/** Payload passed to Firebase v2 Cloud Storage trigger handlers. */
export type StorageEventLike<T = unknown> = StorageCloudEventLike<T>;

/** Registers a Firebase v2 Cloud Storage trigger handler against a mock controller. */
export function registerTrigger<T extends CloudEvent<unknown>>(
  ctrl: StorageController,
  handler: CloudFunction<T>,
  predicateOrOptions?: StorageTriggerPredicate | RegisterStorageTriggerOptions
): () => void {
  if (typeof handler.run !== 'function') {
    throw new Error('CloudFunction.run() not available. Pass a firebase-functions/v2 CloudFunction wrapper.');
  }
  const fn = handler as V2StorageFunction;
  const trigger = fn.__endpoint?.eventTrigger;
  const meta = {
    bucketId: extractBucketFilter(trigger?.eventFilters),
    kinds: mapV2Kind(trigger?.eventType),
  };
  if (!meta.kinds.length) {
    throw new Error('Not a Cloud Storage v2 event function or missing metadata.');
  }
  const options = normalizeRegisterOptions(predicateOrOptions);
  let queue = Promise.resolve();
  return ctrl.onObjectChange((record) => {
    if (!shouldDeliver(meta, record)) return;
    queue = enqueueTriggerRun(queue, record, options, () =>
      handler.run(toCloudEvent(record) as unknown as T)
    );
    void queue;
  });
}

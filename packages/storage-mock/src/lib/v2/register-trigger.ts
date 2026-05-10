import type { CloudEvent, CloudFunction } from 'firebase-functions/v2';
import type { StorageController } from '../types.js';
import {
  extractBucketFilter,
  mapV2Kind,
  normalizeRegisterOptions,
  runWithHooks,
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

export type StorageEventLike<T = unknown> = StorageCloudEventLike<T>;

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
  return ctrl.onObjectChange((record) => {
    if (!shouldDeliver(meta, record)) return;
    void runWithHooks(record, options, () =>
      handler.run(toCloudEvent(record) as unknown as T)
    );
  });
}

import type { CloudFunction } from 'firebase-functions/v1';
import type { StorageController } from '../controller.js';
import {
  enqueueTriggerRun,
  normalizeRegisterOptions,
  ObjectMetadataLike,
  extractBucketFromResource,
  mapV1Kind,
  shouldDeliver,
  toEventContext,
  toObjectMetadata,
} from '../trigger-utils.js';
import type {
  RegisterStorageTriggerOptions,
  StorageTriggerPredicate,
} from '../types.js';

type V1StorageFunction = CloudFunction<ObjectMetadataLike> & {
  __trigger?: {
    eventTrigger?: {
      eventType?: string;
      resource?: unknown;
    };
  };
};

/** Payload passed to Firebase v1 Cloud Storage trigger handlers. */
export type TriggerPayload = ObjectMetadataLike;

/** Registers a Firebase v1 Cloud Storage trigger handler against a mock controller. */
export function registerTrigger(
  ctrl: StorageController,
  handler: CloudFunction<ObjectMetadataLike>,
  predicateOrOptions?: StorageTriggerPredicate | RegisterStorageTriggerOptions
): () => void {
  if (typeof handler.run !== 'function') {
    throw new Error('CloudFunction.run() not available. Pass a firebase-functions/v1 CloudFunction wrapper.');
  }
  const fn = handler as V1StorageFunction;
  const trigger = fn.__trigger?.eventTrigger;
  const meta = {
    bucketId: extractBucketFromResource(trigger?.resource),
    kinds: mapV1Kind(trigger?.eventType),
  };
  if (!meta.kinds.length) {
    throw new Error('Not a Cloud Storage v1 event function or missing metadata.');
  }
  const options = normalizeRegisterOptions(predicateOrOptions);
  let queue = Promise.resolve();
  return ctrl.onObjectChange((record) => {
    if (!shouldDeliver(meta, record)) return;
    queue = enqueueTriggerRun(queue, record, options, () =>
      handler.run(toObjectMetadata(record.metadata), toEventContext(record))
    );
    void queue;
  });
}

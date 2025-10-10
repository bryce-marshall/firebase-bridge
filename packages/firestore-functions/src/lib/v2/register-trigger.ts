/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  FirestoreController,
  TriggerEventArg,
} from '@firebase-bridge/firestore-admin';
import type { CloudEvent, CloudFunction } from 'firebase-functions/v2';
import {
  GenericTriggerMeta,
  TriggerRunner,
} from '../_internal/trigger-runner.js';
import {
  GenericTriggerEventData,
  runUnavailableMsg,
} from '../_internal/util.js';
import { RegisterTriggerOptions } from '../types.js';
import { getTriggerMetaV2 } from './meta-helper.js';

/**
 * Registers a Cloud Functions **v2** Firestore trigger against the mock controller
 * and returns an unsubscribe function.
 *
 * What this does
 * - Resolves trigger metadata (`route`, accepted `kinds`) via {@link getTriggerMetaV2}.
 * - Subscribes to the underlying database change stream at `route`.
 * - Filters each change by kind (`'create' | 'update' | 'delete' | 'write'`).
 * - Converts the change into a **CloudEvent** payload (see {@link buildCloudEvent}).
 * - Invokes the user function either via `.run(ce)` (preferred v2 wrapper) or as
 *   a bare function `(ce)`, within a simulated Functions environment
 *   using {@link withFunctionsEnv}.
 *
 * Kind semantics
 * - If the function was registered as `"write"`, a **written** event is emitted
 *   for every non-noop change.
 * - Otherwise, only the specific kind (`create`, `update`, or `delete`) is emitted
 *   and the others are ignored.
 *
 * Disposer
 * - The returned function detaches the trigger; call it to clean up in tests.
 *
 * @param target - The controller that provides access to the mock Firestore and its database stream.
 * @param handler - A v2 `CloudFunction` (either the wrapper exposing `.run` or a callable function).
 * @param predicate Optional synchronous guard evaluated after route matching and change-kind filtering.
 * If provided and it returns `false`, the Cloud Function is not invoked for that event.
 * Receives the low-level {@link TriggerEventArg} (params, doc). Defaults to invoking for all
 * matching events when omitted.
 * @returns A function that, when called, unregisters the trigger.
 *
 * @example
 * import * as v2 from 'firebase-functions/v2';
 *
 * const onWritten = v2.firestore.onDocumentWritten('cities/{cityId}', (event) => {
 *   // event.type === 'google.cloud.firestore.document.v1.written'
 *   // event.data.before / event.data.after are DocumentSnapshots
 * });
 *
 * const dispose = registerTrigger(controller, onWritten);
 * // ... perform writes in tests ...
 * dispose(); // clean up
 */
export function registerTrigger<T extends CloudEvent<unknown>>(
  target: FirestoreController,
  handler: CloudFunction<T>,
  options?: RegisterTriggerOptions
): () => void {
  if (typeof handler.run !== 'function') {
    throw new Error(runUnavailableMsg('v2'));
  }

  const runner = new (class extends TriggerRunner<CloudFunction<T>> {
    override getTriggerMeta(
      target: FirestoreController,
      handler: CloudFunction<any>
    ): GenericTriggerMeta {
      return getTriggerMetaV2(target, handler);
    }

    override run(
      handler: CloudFunction<T>,
      _arg: TriggerEventArg,
      data: GenericTriggerEventData
    ): unknown {
      return handler.run(data as unknown as T);
    }

    override checkpoint(): void {
      //
    }
  })(target, handler, options);

  return runner.unsub;
}

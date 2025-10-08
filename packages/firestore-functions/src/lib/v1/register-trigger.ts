import {
  FirestoreController,
  TriggerEventArg,
} from '@firebase-bridge/firestore-admin';
import {
  DocumentSnapshot,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { Change, CloudFunction, EventContext } from 'firebase-functions/v1';
import {
  GenericTriggerMeta,
  TriggerRunner,
} from '../_internal/trigger-runner.js';
import { RegisterTriggerOptions } from '../types.js';
import {
  GenericTriggerEventData,
  runUnavailableMsg,
  toFirestorePath
} from '../_internal/util.js';
import { getTriggerMeta } from './meta-helper.js';

export type TriggerPayload =
  | Change<DocumentSnapshot> // onWrite / onUpdate
  | QueryDocumentSnapshot // onCreate
  | DocumentSnapshot; // onDelete

/**
 * Registers a Cloud Functions v1 Firestore trigger against the mock controller
 * and returns an unsubscribe function.
 *
 * What this does
 * - Attaches a callback to the bridge’s database change stream for the given `route`.
 * - Converts internal change events into the Cloud Functions v1 payload:
 *   `Change<DocumentSnapshot>` plus an event context.
 * - Filters events according to the trigger kind (`create`, `update`, `delete`,
 *   or `write`) derived from {@link getTriggerMeta}.
 * - Executes the user function via `handler.run(change, context)` inside a
 *   simulated Functions environment (`withFunctionsEnv`) for production-like
 *   globals/env behavior.
 *
 * Requirements
 * - `handler` **must** be the wrapper exported by `firebase-functions/v1`
 *   (i.e., a `CloudFunction`) — not the raw `(change, context) => {}` handler.
 *   If `handler.run` is missing, an error is thrown with guidance.
 *
 * Event payload details
 * - `change.before` / `change.after`: created with `toDocumentSnapshot(...)`,
 *   using the controller’s `firestore()` to ensure native `DocumentSnapshot`s.
 * - `context.eventId`: `${version}:${path}` for stable de-duplication in tests.
 * - `context.timestamp`: ISO string derived from the change `serverTime`.
 * - `context.params`: route parameters resolved by the controller.
 * - `context.resource`: `{ service: 'firestore.googleapis.com', name: <doc GAPIC path> }`,
 *   where `name` is constructed via {@link toFirestorePath}.
 *
 * Returned disposer
 * - The function returned by `registerTrigger` detaches the trigger from the
 *   underlying database/controller and should be called to avoid leaks in tests.
 *
 * @param target - The controller that provides access to the mock Firestore and its database stream.
 * @param handler - A `firebase-functions/v1` CloudFunction wrapper (must expose `run`).
 * @param predicate Optional synchronous guard evaluated after route matching and change-kind filtering.
 * If provided and it returns `false`, the Cloud Function is not invoked for that event.
 * Receives the low-level {@link TriggerEventArg} (params, doc). Defaults to invoking for all
 * matching events when omitted.
 * @returns A function that, when called, unregisters the trigger.
 *
 * @throws {Error} If `handler.run` is not available (likely not a v1 `CloudFunction` wrapper).
 *
 * @example
 * import * as functions from 'firebase-functions/v1';
 *
 * const onWrite = functions.firestore
 *   .document('cities/{cityId}')
 *   .onWrite(async (change, ctx) => { /* ... *\/ });
 *
 * const dispose = registerTrigger(controller, onWrite);
 * // ... perform writes in tests ...
 * dispose(); // clean up
 */
export function registerTrigger<
  T extends TriggerPayload = Change<DocumentSnapshot>
>(
  target: FirestoreController,
  handler: CloudFunction<T>,
  options?: RegisterTriggerOptions
): () => void {
  if (typeof handler.run !== 'function') {
    throw new Error(runUnavailableMsg('v1'));
  }

  const runner = new (class extends TriggerRunner<CloudFunction<T>> {
    override getTriggerMeta(
      target: FirestoreController,
      handler: CloudFunction<T>
    ): GenericTriggerMeta {
      return getTriggerMeta(target, handler);
    }

    override run(
      handler: CloudFunction<T>,
      arg: TriggerEventArg,
      data: GenericTriggerEventData
    ): unknown {
      const ctx: EventContext = {
        eventId: data.id,
        eventType: data.type,
        timestamp: data.time,
        params: data.params,
        resource: {
          service: 'firestore.googleapis.com',
          name: toFirestorePath(target, arg.doc.path),
        },
      };

      return handler.run(data.data as T, ctx);
    }
  })(target, handler, options);

  return runner.unsub;
}

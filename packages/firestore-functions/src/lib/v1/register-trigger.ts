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
  buildCloudEvent,
  Kind,
  toChangeRecord,
  toFirestorePath,
  withFunctionsEnv
} from '../_internal/util.js';
import { getTriggerMeta } from './meta-helper.js';

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
  T extends
    | Change<DocumentSnapshot> // onWrite / onUpdate
    | QueryDocumentSnapshot // onCreate
    | DocumentSnapshot = Change<DocumentSnapshot> // onDelete
>(target: FirestoreController, handler: CloudFunction<T>): () => void {
  if (typeof handler.run !== 'function') {
    throw new Error(
      'CloudFunction.run() not available. Pass the exported CloudFunction wrapper ' +
        'from firebase-functions/v1 (not the raw handler), or upgrade firebase-functions.'
    );
  }
  const { route, kinds } = getTriggerMeta(target, handler); // merged meta

  return target.database.registerTrigger({
    route,
    callback: async (arg: TriggerEventArg) => {
      type EmitKind = Kind | 'write';
      const firestore = target.firestore();
      const rec = toChangeRecord(firestore, arg.doc);
      if (!rec?.kind) return; // ignore no-op writes
      const emitKind: EmitKind = kinds[0] === 'write' ? 'write' : rec.kind;
      if (emitKind !== 'write' && !kinds.includes(emitKind)) return;

      const ce = buildCloudEvent(
        target,
        emitKind,
        arg,
        rec.before as DocumentSnapshot,
        rec.after as DocumentSnapshot
      );

      const ctx: EventContext = {
        eventId: ce.id,
        eventType: ce.type,
        timestamp: ce.time,
        params: ce.params,
        resource: {
          service: 'firestore.googleapis.com',
          name: toFirestorePath(target, arg.doc.path),
        },
      };

      // Do we need to await for prod-like completion semantics?
      return withFunctionsEnv(target, () => handler.run(ce.data as T, ctx));
    },
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  FirestoreController,
  TriggerEventArg,
} from '@firebase-bridge/firestore-admin';
import { DocumentSnapshot } from 'firebase-admin/firestore';
import type { CloudFunction } from 'firebase-functions/v2';
import { RegisterTriggerOptions } from '../_internal/types.js';
import {
  buildCloudEvent,
  Kind,
  toChangeRecord,
  withFunctionsEnv,
} from '../_internal/util.js';
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
export function registerTrigger(
  target: FirestoreController,
  handler: CloudFunction<any>,
  options?: RegisterTriggerOptions
): () => void {
  if (typeof handler.run !== 'function') {
    throw new Error(
      'CloudFunction.run() not available. Pass the exported CloudFunction wrapper ' +
        'from firebase-functions/v2 (not the raw handler), or upgrade firebase-functions.'
    );
  }

  const { route, kinds } = getTriggerMetaV2(target, handler);

  return target.database.registerTrigger({
    route,
    callback: async (arg: TriggerEventArg) => {
      if ((options?.predicate?.(arg) ?? true) !== true) return;

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

      const fn: any = handler;
      if (typeof fn.run === 'function') {
        return withFunctionsEnv(target, () => fn.run(ce));
      }
      return withFunctionsEnv(target, () => fn(ce));
    },
  });
}

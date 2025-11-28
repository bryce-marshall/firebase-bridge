import {
  FirestoreController,
  TriggerEventArg,
} from '@firebase-bridge/firestore-admin';
import { DocumentSnapshot } from 'firebase-admin/firestore';
import {
  RegisterTriggerOptions,
  TriggerErrorOrigin,
  TriggerRunnerErrorEventArg,
} from '../types.js';
import { CloudContext } from './cloud-context.js';
import {
  buildCloudEvent,
  GenericTriggerEventData,
  Kind,
  toChangeRecord,
} from './util.js';

export type TriggerKind = Kind | 'write';
/**
 * Minimal metadata describing a Firestore trigger binding.
 *
 * @remarks
 * - `route` is the collection/document path pattern (e.g. `"users/{uid}"`)
 *   resolved by the internal database change stream.
 * - `kinds` determines which change kinds the trigger should receive.
 *   Use a subset of {@link Kind} (`'create' | 'update' | 'delete'`)
 *   or include `'write'` to receive **all** writes (create/update/delete)
 *   via a single handler.
 */
export interface GenericTriggerMeta {
  /** Route pattern that this trigger listens to (e.g. `"users/{uid}"`). */
  route: string;

  /**
   * Accepted kinds for this trigger.
   * - Include `'write'` to receive all write events.
   * - Otherwise, provide an array of specific {@link Kind} values.
   */
  kinds: TriggerKind[];
}

/**
 * Base class that wires the in-memory Firestore change stream to a Cloud
 * Functions-style handler.
 *
 * @typeParam THandler - The framework-specific handler type
 * (e.g. `firebase-functions/v1` `CloudFunction`, or v2 `CloudFunction<CloudEvent>`).
 *
 * @remarks
 * This class is subclassed by the v1 and v2 `registerTrigger()` implementations.
 * It:
 * - Subscribes to {@link FirestoreController.database.registerTrigger}.
 * - Converts internal change events into Cloud Functions payloads using
 *   {@link toChangeRecord} and {@link buildCloudEvent}.
 * - Applies routing (`route`) and kind filtering (`kinds`), including the
 *   special `'write'` aggregate kind.
 * - Evaluates an optional predicate (`options.predicate`) to enable/disable
 *   a trigger dynamically (all triggers are enabled by default).
 * - Executes optional lifecycle callbacks `onBefore`, `onAfter`, and
 *   `onError` with structured error context via {@link TriggerRunnerErrorEventArg}.
 * - Runs the user handler inside a minimal Cloud Functions-like environment
 *   via {@link CloudContext.start}, ensuring environment variables and globals
 *   are scoped to the invocation.
 */
export abstract class TriggerRunner<THandler> {
  /**
   * Disposes the trigger subscription. Invoke in test teardown or when you no
   * longer need the trigger to observe writes.
   */
  readonly unsub: () => void;

  /**
   * Creates a trigger runner and immediately subscribes to database changes.
   *
   * @param target - The in-memory Firestore controller binding the trigger.
   * @param handler - The framework-specific trigger handler to execute.
   * @param options - Optional registration controls:
   *  - `predicate` — Return `true` to execute, `false` to skip (default: `true`).
   *  - `onBefore` — Called after predicate passes and before handler execution.
   *  - `onAfter` — Called after successful handler execution.
   *  - `onError` — Called when predicate, lifecycle callbacks, or handler throw.
   *
   * @remarks
   * Error origin is reported via {@link TriggerErrorOrigin}:
   * - `Predicate` — Failures while evaluating `options.predicate`.
   * - `OnBefore` — Failures thrown by `options.onBefore`.
   * - `Execute` — Failures thrown by the user `handler`.
   * - `OnAfter` — Failures thrown by `options.onAfter`.
   *
   * No-op writes (where neither `before` nor `after` materialize a meaningful
   * change) are ignored.
   */
  constructor(
    target: FirestoreController,
    handler: THandler,
    options?: RegisterTriggerOptions
  ) {
    const opt = { ...options };
    // Execute within a Cloud Functions-like environment
    const { route, kinds } = CloudContext.start(target, () => {
      return this.getTriggerMeta(handler);
    });

    this.unsub = target.database.registerTrigger({
      route,
      callback: (arg: TriggerEventArg) => {
        let origin = TriggerErrorOrigin.Predicate;

        /**
         * Emits a structured error to `options.onError`, guarding against
         * secondary failures in the error handler itself.
         */
        function emitError(cause: unknown): void {
          const errorArg: TriggerRunnerErrorEventArg = {
            origin,
            arg,
            cause,
          };

          Object.freeze(errorArg);
          try {
            opt.onError?.(errorArg);
          } catch {
            // Intentionally ignore errors from the error handler.
          }
        }

        try {
          // 1) Predicate gate (default allow)
          if ((opt?.predicate?.(arg) ?? true) !== true) return;

          // 2) Map to change record and enforce kind filtering
          type EmitKind = Kind | 'write';
          const firestore = target.firestore();
          const rec = toChangeRecord(firestore, arg.doc);
          if (!rec?.kind) return; // ignore no-op writes

          const emitKind: EmitKind = kinds.includes('write')
            ? 'write'
            : rec.kind;
          if (emitKind !== 'write' && !kinds.includes(emitKind)) return;

          // 3) Build Cloud Functions-compatible event payload
          const data = buildCloudEvent(
            target,
            emitKind,
            arg,
            rec.before as DocumentSnapshot,
            rec.after as DocumentSnapshot
          );

          // 4) Execute within a Cloud Functions-like environment
          CloudContext.start(target, async () => {
            try {
              origin = TriggerErrorOrigin.OnBefore;
              opt.onBefore?.(arg);

              origin = TriggerErrorOrigin.Execute;
              await this.run(handler, arg, data);

              origin = TriggerErrorOrigin.OnAfter;
              opt.onAfter?.(arg);
            } catch (cause) {
              emitError(cause);
            }
          });
        } catch (cause) {
          emitError(cause);
        }
      },
    });
  }

  /**
   * Extracts route and kind metadata for the given handler.
   *
   * @param handler - The framework-specific handler instance to introspect.
   * @returns The route pattern and accepted kinds for this trigger.
   *
   * @remarks
   * Subclasses must implement this to reflect their handler model:
   * - **v1**: Inspect `CloudFunction` internals to derive path and kind.
   * - **v2**: Inspect the `CloudFunction<CloudEvent>` registration details.
   */
  abstract getTriggerMeta(handler: THandler): GenericTriggerMeta;

  /**
   * Invokes the framework-specific handler with a Cloud Functions-style payload.
   *
   * @param handler - The v1/v2 handler instance to execute.
   * @param arg - The low-level trigger event arg from the database.
   * @param data - The Cloud Functions-compatible event payload:
   *   - **v1**: `Change<DocumentSnapshot>` + `EventContext` (wrapped).
   *   - **v2**: `CloudEvent<FirestoreEvent<T>>` (wrapped).
   *
   * @returns A promise if the handler is async; otherwise any returned value.
   *
   * @remarks
   * Subclasses are responsible for calling the appropriate `handler.run(...)`
   * (v1) or function body with a `CloudEvent` (v2), matching the target API.
   */
  abstract run(
    handler: THandler,
    arg: TriggerEventArg,
    data: GenericTriggerEventData
  ): unknown | Promise<unknown>;
}

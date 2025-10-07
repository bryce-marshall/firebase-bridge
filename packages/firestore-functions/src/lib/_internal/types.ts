import { TriggerEventArg } from '@firebase-bridge/firestore-admin';

/**
 * Optional hooks that refine how a Firestore trigger is invoked when using
 * {@link registerTrigger} for both **v1** (`firebase-functions/v1`) and **v2**
 * (`firebase-functions/v2`) handlers.
 *
 * @remarks
 * The lifecycle is:
 *
 * 1. **Route & kind filtering** — The trigger is matched on path and kind
 *    (`create` | `update` | `delete` | `write`) by the registration call.
 * 2. **`predicate`** — If provided, it is evaluated with the event. If it
 *    returns `false`, the trigger is **skipped** (no handler invocation).
 * 3. **`onBefore`** — Runs immediately before the Cloud Function is invoked.
 * 4. **Handler invocation** — Your v1/v2 function is invoked inside the mock
 *    Functions environment.
 * 5. **`onAfter` / `onError`** — Exactly one of these runs after the handler
 *    settles: `onAfter` on successful fulfillment; `onError` on throw/rejection.
 *
 * All callbacks are synchronous and should be fast; they execute on the same
 * deterministic async turn that the mock uses to simulate Functions behavior.
 * Any exception you throw in a callback is not swallowed and will surface to
 * your test process, which is often desirable for failing fast.
 *
 * @see registerTrigger
 * @see TriggerEventArg
 * @since 0.0.1
 */
export interface RegisterTriggerOptions {
  /**
   * Final guard after route/kind filtering but **before** the handler runs.
   * Return `false` to skip invoking the Cloud Function for this event.
   *
   * Common uses include:
   * - Feature-flagging a trigger during a subset of a test
   * - Debouncing initial seed writes
   * - Scoping to specific document IDs or payload fields
   *
   * @example
   * ```ts
   * let enabled = false;
   * const dispose = registerTrigger(ctl, onWriteHandler, {
   *   predicate: () => enabled,
   * });
   *
   * // ... perform setup writes (won’t run)
   * enabled = true;
   * // ... subsequent writes now invoke the handler
   * ```
   *
   * @param arg - Event context (route, kind, snapshots/change, metadata).
   * @returns `true` to allow invocation; `false` to skip.
   */
  predicate?(arg: TriggerEventArg): boolean;

  /**
   * Runs immediately **before** the Cloud Function handler is invoked,
   * after `predicate` has allowed the event.
   *
   * Typical uses:
   * - Install per-invocation test spies/timers
   * - Capture input payloads for assertions
   * - Mutate deterministic time or environment state
   *
   * Throwing here prevents the handler from running and surfaces the error.
   *
   * @param arg - Event context passed to the handler.
   */
  onBefore?(arg: TriggerEventArg): void;

  /**
   * Runs **after** the Cloud Function handler **successfully settles**
   * (i.e., fulfills its returned promise). Not called if the handler throws
   * or rejects—use {@link onError} for failure handling.
   *
   * Typical uses:
   * - Verifying side effects completed
   * - Counting invocations
   * - Emitting structured debug output
   *
   * Throwing here will surface to your test process.
   *
   * @param arg - Event context corresponding to the successful invocation.
   */
  onAfter?(arg: TriggerEventArg): void;

  /**
   * Runs if the Cloud Function handler **throws** or **rejects**.
   * This is mutually exclusive with {@link onAfter}.
   *
   * Typical uses:
   * - Asserting expected failures
   * - Normalizing framework errors for snapshot tests
   * - Logging diagnostics
   *
   * Throwing here will surface to your test process.
   *
   * @param arg - Event context corresponding to the failed invocation.
   * @param error - The error thrown/rejected by the handler.
   */
  onError?(arg: TriggerEventArg, error: unknown): void;
}

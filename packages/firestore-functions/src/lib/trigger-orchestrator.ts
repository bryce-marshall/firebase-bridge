import {
  FirestoreController,
  TriggerEventArg,
} from '@firebase-bridge/firestore-admin';
import { CloudFunction as CloudFunctionV1 } from 'firebase-functions/v1';
import {
  CloudEvent,
  CloudFunction as CloudFunctionV2,
} from 'firebase-functions/v2';
import { } from './_internal/util.js';
import {
  RegisterTriggerOptions,
  TriggerErrorOrigin,
  TriggerRunnerErrorEventArg,
} from './types.js';
import {
  TriggerPayload as TriggerPayloadV1,
  registerTrigger as registerTriggerV1,
} from './v1/register-trigger.js';
import { registerTrigger as registerTriggerV2 } from './v2/register-trigger.js';

/**
 * # TriggerOrchestrator
 *
 * Coordinates **Cloud Functions for Firestore** triggers (both **v1** and **v2**) that
 * are bound to the in-memory Firestore provided by
 * **`@firebase-bridge/firestore-admin`**. It centralizes:
 *
 * - Handler registration keyed by a logical identifier you choose (e.g., an enum).
 * - Global enable/disable controls (per-key and all-at-once).
 * - Deterministic waiting utilities (await the next invocation or a predicate match).
 * - Per-trigger stats (initiated/completed/error counts).
 * - Observer hooks (`before`/`after`/`error`) for white-box validation.
 * - Global error watching (surface trigger/observer failures to your tests).
 *
 * @remarks
 * - Purpose-built for **unit/integration tests** to avoid emulator boot/deploy loops.
 * - **Enabled by default:** After construction, all registered triggers are enabled
 *   (equivalent to calling `orch.all(true)`).
 * - **Suspension gate:** While `suspended === true`, invocations are **blocked at the registration gate**
 *   (handlers are not entered, stats do not change, observers are not called).
 * - External services (Pub/Sub, third-party APIs) are **out of scope**—provide your own test doubles.
 * - All invocations are bridged via the package’s `v1/register-trigger` and `v2/register-trigger` shims.
 *
 * @packageDocumentation
 */

/** Union of allowed keys used to identify triggers in the orchestrator. */
export type TriggerKey = string | number;

/**
 * Aggregate counters for a given trigger key.
 *
 * @public
 */
export interface TriggerStats<TKey extends TriggerKey> {
  /** The logical key used to identify this trigger. */
  readonly key: TKey;
  /** Count of invocations that were initiated (entered the handler). */
  readonly initiatedCount: number;
  /** Count of invocations that completed successfully (fulfilled). */
  readonly completedCount: number;
  /** Count of invocations that failed (threw/rejected). */
  readonly errorCount: number;
}

/**
 * Extended trigger event argument that includes per-trigger statistics.
 *
 * @public
 */
export interface OrchestratorEventArg<TKey extends TriggerKey>
  extends TriggerEventArg,
    TriggerStats<TKey> {
  /**
   * Classification for where the error originated.
   * - `"trigger"`: the Cloud Function threw/rejected.
   * - `"onBefore" | "onAfter"` (or corresponding observer-origin values): an observer threw.
   */
  origin?: TriggerErrorOrigin;
  /** The underlying error/exception (as thrown by the trigger or observer). */
  cause?: unknown;
}

/**
 * Argument passed to global error watchers registered via
 * {@link TriggerOrchestrator.watchErrors}.
 *
 * @public
 */
export interface OrchestratorErrorEventArg<TKey extends TriggerKey>
  extends OrchestratorEventArg<TKey> {
  origin: TriggerErrorOrigin;
  cause: unknown;
}

/**
 * Observer callbacks that can be attached to a single trigger key.
 *
 * @remarks
 * - `before` runs **immediately prior** to the Cloud Function invocation (after `suspended` gate passes).
 * - `after` runs **only** if the Cloud Function **fulfills** (no error thrown).
 * - `error` runs **only** if the Cloud Function **throws/rejects**.
 * - If an observer throws, that exception is surfaced to global error watchers via
 *   {@link TriggerOrchestrator.watchErrors | watchErrors()} with `origin` set to the
 *   appropriate observer phase.
 *
 * @public
 */
export interface TriggerObserver<TKey extends TriggerKey> {
  before?: (arg: OrchestratorEventArg<TKey>) => void;
  after?: (arg: OrchestratorEventArg<TKey>) => void;
  error?: (arg: OrchestratorErrorEventArg<TKey>) => void;
}

/**
 * Registrar passed to your setup function in the {@link TriggerOrchestrator} constructor.
 * Use it to register v1 and v2 Firestore trigger handlers and associate them with keys.
 *
 * @example Registering two handlers
 * ```ts
 * enum AppTrigger {
 *   OnTransactionWrite = 'OnTransactionWrite',
 *   OnBudgetStructureCreate = 'OnBudgetStructureCreate',
 * }
 *
 * new TriggerOrchestrator<AppTrigger>(ctl, (r) => {
 *   r.v1(AppTrigger.OnTransactionWrite, onTransactionWriteV1);
 *   r.v2(AppTrigger.OnBudgetStructureCreate, onBudgetStructureCreateV2);
 * });
 * ```
 *
 * @public
 */
export interface TriggerRegistrar<TKey extends TriggerKey> {
  /**
   * Registers a Cloud Functions **v1** Firestore handler for a key.
   *
   * @param key - The logical key used to address this handler.
   * @param handler - The Cloud Functions v1 wrapper exported from `firebase-functions/v1`.
   */
  v1<T extends TriggerPayloadV1>(key: TKey, handler: CloudFunctionV1<T>): void;

  /**
   * Registers a Cloud Functions **v2** Firestore handler for a key.
   *
   * @param key - The logical key used to address this handler.
   * @param handler - The Cloud Functions v2 wrapper exported from `firebase-functions/v2`.
   */
  v2<T>(key: TKey, handler: CloudFunctionV2<CloudEvent<T>>): void;
}

/**
 * Policy governing how long a `wait*()` operation may run before timing out.
 *
 * @remarks
 * - Units are milliseconds.
 * - If omitted, the waiter applies a **3000 ms** default.
 * - Applies to all `wait*()` variants.
 */
export interface WaitTimeoutPolicy {
  /**
   * Maximum duration (in milliseconds) to wait before rejecting with a timeout error.
   *
   * @defaultValue 3000
   */
  timeout?: number;
}

/**
 * Policy controlling whether an in-flight `wait*()` should be **interrupted**
 * (rejected) due to errors raised by matching trigger runs **before** the
 * wait predicate is satisfied.
 *
 * @remarks
 * This does not affect timeouts; combine with {@link WaitTimeoutPolicy} for
 * overall behavior.
 */
export interface WaitInterruptionPolicy {
  /**
   * When `true`, if a matching trigger run throws or rejects **before** the
   * wait predicate becomes true, the waiter rejects immediately with that error.
   *
   * When `false`, errors in matching trigger runs are ignored for the purposes
   * of the current wait, and the waiter continues until the predicate is
   * satisfied or the timeout elapses.
   *
   * @defaultValue false
   */
  cancelOnError?: boolean;
}

/**
 * Combined options for standard `wait*()` operations over trigger activity.
 *
 * @remarks
 * - Merges {@link WaitTimeoutPolicy} and {@link WaitInterruptionPolicy}.
 * - Suitable for most "wait for event" scenarios where both timeout and
 *   error-interruption behavior are relevant.
 */
export interface WaitOptions
  extends WaitTimeoutPolicy,
    WaitInterruptionPolicy {}

/**
 * Options for `wait*()` variants that target **error conditions** specifically.
 *
 * @remarks
 * - Only timeout behavior is relevant when *awaiting errors*; interruption
 *   semantics ({@link WaitInterruptionPolicy}) are not applicable.
 * - This alias exists to make intent explicit at call sites.
 */
export type WaitErrorOptions = WaitTimeoutPolicy;

/**
 * Callback signature for global error watchers.
 *
 * @public
 */
export type TriggerErrorWatcher<TKey extends TriggerKey> = (
  arg: OrchestratorErrorEventArg<TKey>
) => void;

/** @internal */
type ObserverCallback<TKey extends TriggerKey> = (
  arg: OrchestratorEventArg<TKey>
) => void;
type ObserverErrorCallback<TKey extends TriggerKey> = (
  arg: OrchestratorErrorEventArg<TKey>
) => void;

/** @internal */
type InternalHandler =
  | CloudFunctionV1<TriggerPayloadV1>
  | CloudFunctionV2<CloudEvent<unknown>>;

/** @internal */
interface TriggerStub<TKey extends TriggerKey> {
  key: TKey;
  get active(): boolean;
  sub: () => void;
  unsub: () => void;
  stats: {
    initiatedCount: number;
    completedCount: number;
    errorCount: number;
  };
  observers: TriggerObserver<TKey>[];
  waitHandles: WaitHandle<TKey, OrchestratorEventArg<TKey>>[];
  errorWaitHandles: WaitHandle<TKey, OrchestratorErrorEventArg<TKey>>[];
}

/**
 * Single-use waiter that resolves when a predicate matches, or rejects on
 * timeout/cancel. Instances are serviced by a short **internal interval** (5ms)
 * that checks expiration. When no waiters remain, the interval is cleared.
 *
 * @internal
 */
class WaitHandle<TKey extends TriggerKey, TArg> {
  private _expires: number;
  private _resolve!: (arg: TArg) => void;
  private _reject!: (reason: Error) => void;

  /** Promise that resolves when the predicate matches or rejects on timeout/cancel. */
  readonly promise: Promise<TArg>;
  /** When `true`, fail the waiter if a matching trigger run errors. */
  readonly cancelOnError: boolean;

  /**
   * @param set - The internal set to which this waiter belongs (auto-removed on settle).
   * @param predicate - Predicate evaluated against each completed event.
   * @param options - Timeout and cancellation behavior (defaults: `timeout=3000`, `cancelOnError=false`).
   */
  constructor(
    private readonly set: WaitHandle<TKey, TArg>[],
    private readonly predicate: (arg: TArg) => boolean,
    options?: WaitOptions
  ) {
    const DEFAULT_TIMEOUT = 3000;
    this._expires = Date.now() + (options?.timeout ?? DEFAULT_TIMEOUT);
    this.cancelOnError = options?.cancelOnError === true;
    this.promise = new Promise<TArg>(
      (resolve: (arg: TArg) => void, reject: (reason: Error) => void) => {
        this._resolve = resolve;
        this._reject = reject;
      }
    );
    set.push(this);
  }

  /** Evaluate the waiter against an event; resolve if the predicate matches. */
  eval(arg: TArg): void {
    try {
      if (this.predicate(arg)) {
        this.remove();
        this._resolve(arg);
      }
    } catch (cause) {
      this.reject('predicate error', cause);
    }
  }

  /** Tick the timer; rejects if now >= timeout. */
  tick(evalTime: number): void {
    if (evalTime >= this._expires) {
      this.reject('timed-out.');
    }
  }

  /** Cancel the waiter with an optional cause. */
  cancel(cause?: unknown): void {
    this.reject('cancelled', cause);
  }

  private reject(msg: string, cause?: unknown): void {
    this.remove();
    this._reject(new Error(waitHandleMsg(msg), { cause }));
  }

  private remove(): void {
    const idx = this.set.indexOf(this);
    if (idx >= 0) {
      this.set.splice(idx, 1);
    }
  }
}

/** @internal */
type HandlerResolver<TKey extends TriggerKey> = (
  obs: TriggerObserver<TKey>
) => ObserverCallback<TKey> | ObserverErrorCallback<TKey> | undefined;

/**
 * Coordinates Cloud Functions (v1/v2) Firestore trigger handlers over the
 * in-memory Firestore database, providing enable/disable controls, per-trigger
 * stats, observer hooks, and awaiting utilities for deterministic testing.
 *
 * @typeParam TKey - The key type used to identify triggers (string or number).
 *
 * @example Basic setup & enabling
 * ```ts
 * const orch = new TriggerOrchestrator<AppTrigger>(ctl, (r) => {
 *   r.v1(AppTrigger.OnTransactionWrite, onTransactionWriteV1);
 *   r.v2(AppTrigger.OnBudgetStructureCreate, onBudgetStructureCreateV2);
 * });
 *
 * // Triggers are enabled by default, but you can make it explicit:
 * orch.all(true);
 * ```
 *
 * @example Waiting for the next invocation
 * ```ts
 * // Wait up to 2s for the next successful run of the key
 * const evt = await orch.waitOne(AppTrigger.OnTransactionWrite, { timeout: 2000 });
 * expect(evt.completedCount).toBeGreaterThan(0);
 * ```
 *
 * @example Predicate-based waits with cancel-on-error
 * ```ts
 * await orch.wait(
 *   AppTrigger.OnTransactionWrite,
 *   (e) => e.after?.exists === true, // any predicate against OrchestratorEventArg
 *   { timeout: 3000, cancelOnError: true }
 * );
 * ```
 *
 * @example Observing successes and failures
 * ```ts
 * const off = orch.on(AppTrigger.OnTransactionWrite, {
 *   before: (a) => console.log('about to run', a.key, a.initiatedCount),
 *   after:  (a) => console.log('ok', a.key, a.completedCount),
 *   error:  (a, e) => console.warn('fail', a.key, e),
 * });
 * // later: off();
 * ```
 *
 * @example Pausing all triggers (setup/teardown)
 * ```ts
 * orch.suspended = true;   // suppress new invocations at registration gate
 * // ... setup test data ...
 * orch.suspended = false;  // resume
 * ```
 */
export class TriggerOrchestrator<TKey extends TriggerKey> {
  private _epoch = 0;
  private _suspended = false;
  private _interrupt: ReturnType<typeof setInterval> | undefined;
  private _stubs = new Map<TKey, TriggerStub<TKey>>();
  private _errorWatchers = new Map<symbol, TriggerErrorWatcher<TKey>>();
  private _unsub: (() => void) | undefined;

  /**
   * Creates a new orchestrator and registers all triggers provided by `register`.
   *
   * @param ctrl - The in-memory Firestore controller to bind to.
   * @param register - A function that receives a {@link TriggerRegistrar} and
   *   calls `v1`/`v2` to associate handlers with keys.
   *
   * @remarks
   * - On construction, all registered triggers are **enabled** via {@link all}(true).
   * - Each registered handler is wrapped so that it:
   *   - Is gated by {@link suspended} (not invoked while suspended).
   *   - Updates per-trigger stats.
   *   - Notifies observers and active waiters.
   */
  constructor(
    ctrl: FirestoreController,
    register: (registrar: TriggerRegistrar<TKey>) => void
  ) {
    this._unsub = ctrl.watchLifecycle((arg) => {
      switch (arg.type) {
        case 'reset':
          this._epoch = arg.epoch;
          break;

        case 'delete':
          this.dispose();
          break;
      }
    });
    const inScope = (arg: TriggerEventArg): boolean => {
      return !this.isDiposed && arg.doc.epoch === this._epoch;
    };

    const makeRegistrar = (owner: this) => {
      const map = this._stubs;

      const addStub = <THandler extends InternalHandler>(
        key: TKey,
        handler: THandler,
        regFn: (
          ctrl: FirestoreController,
          handler: THandler,
          _options?: RegisterTriggerOptions
        ) => () => void
      ): void => {
        if (map.has(key)) {
          throw new Error(`Duplicate trigger key "${key}".`);
        }

        let unsub: (() => void) | undefined;
        const stub: TriggerStub<TKey> = {
          key,
          get active() {
            return unsub != undefined;
          },
          sub(): void {
            if (unsub) return;

            // Bridge to v1/v2 register functions with our lifecycle hooks.
            unsub = regFn(ctrl, handler, {
              predicate(arg) {
                return !owner._suspended && inScope(arg);
              },
              onBefore(arg) {
                if (!inScope(arg)) return;

                owner._onBefore(stub, arg);
              },
              onAfter(arg) {
                if (!inScope(arg)) return;

                owner._onAfter(stub, arg);
              },
              onError(arg) {
                if (!inScope(arg.arg)) return;

                owner._onError(stub, arg);
              },
            });
          },
          unsub(): void {
            unsub?.();
            unsub = undefined;
          },
          stats: {
            initiatedCount: 0,
            completedCount: 0,
            errorCount: 0,
          },
          observers: [],
          waitHandles: [],
          errorWaitHandles: [],
        };

        map.set(key, stub);
      };

      const registrar: TriggerRegistrar<TKey> = {
        v1(key: TKey, handler: CloudFunctionV1<TriggerPayloadV1>): void {
          addStub(key, handler, registerTriggerV1);
        },
        v2<T>(key: TKey, handler: CloudFunctionV2<CloudEvent<T>>): void {
          addStub(key, handler, registerTriggerV2);
        },
      };

      return registrar;
    };

    register(makeRegistrar(this));
    this._epoch = ctrl.epoch();
    this.all(true);
  }

  /**
   * The database **epoch** this orchestrator is currently bound to (per-DataAccessor).
   *
   * Only trigger events whose stamped epoch matches this value are processed; events
   * from prior/reset epochs are ignored to ensure test isolation and prevent leakage
   * of late async work from earlier runs.
   *
   * @remarks
   * - The epoch increments **only** when the underlying in-memory database is reset.
   * - This orchestrator **re-binds** and recaptures the current epoch **automatically** whenever the bound database is reset.
   */
  get epoch(): number {
    return this._epoch;
  }

  /**
   * When `true`, suppresses **all** trigger invocations at the registration gate.
   * Useful for test setup/teardown or to pause cascading side-effects.
   */
  get suspended(): boolean {
    return this._suspended;
  }

  /** Sets {@link suspended}. */
  set suspended(value: boolean) {
    this._suspended = !!value;
  }

  get isDiposed(): boolean {
    return this._unsub == undefined;
  }

  dispose(): void {
    if (this._unsub) {
      this.detach();
      this._epoch = Number.MIN_SAFE_INTEGER;
      this._unsub();
      this._unsub = undefined;
    }
  }

  /**
   * Enables or disables **all** registered triggers in one call.
   *
   * @param enable - `true` to enable; `false` to disable.
   */
  all(enable: boolean): void {
    assertNotDisposed(this);

    const all = Array.from(this._stubs.keys());
    if (enable) {
      this.enable(...all);
    } else {
      this.disable(...all);
    }
  }

  /**
   * Enables the specified triggers by key.
   *
   * @param keys - One or more keys to enable.
   * @throws Error if any key has not been registered.
   */
  enable(...keys: TKey[]): void {
    assertNotDisposed(this);

    keys.forEach((k) => {
      const rec = this._stubs.get(k);
      if (!rec) throw new Error(handlerNotRegistered(k));
      if (!rec.active) {
        rec.sub();
      }
    });
  }

  /**
   * Disables the specified triggers by key.
   *
   * @param keys - One or more keys to disable.
   * @throws Error if any key has not been registered.
   */
  disable(...keys: TKey[]): void {
    assertNotDisposed(this);

    keys.forEach((k) => {
      const rec = this._stubs.get(k);
      if (!rec) throw new Error(handlerNotRegistered(k));
      if (rec.active) {
        rec.unsub();
      }
    });
  }

  /**
   * Returns `true` if the specified trigger is currently enabled.
   *
   * @param trigger - The key to check.
   */
  isEnabled(trigger: TKey): boolean {
    assertNotDisposed(this);

    return this._stubs.get(trigger)?.active === true;
  }

  /**
   * Returns immutable stats for a trigger key. If the key is unknown,
   * a zeroed stats object is returned.
   *
   * @param key - The key for which to fetch stats.
   */
  getStats(key: TKey): TriggerStats<TKey> {
    assertNotDisposed(this);

    const stub = this._stubs.get(key);
    const stats = stub?.stats
      ? {
          key,
          ...stub.stats,
        }
      : {
          key,
          completedCount: 0,
          errorCount: 0,
          initiatedCount: 0,
        };

    Object.freeze(stats);

    return stats;
  }

  /**
   * Register a global error watcher. The watcher is invoked for:
   *
   * - Failures thrown by the Cloud Function (`origin: "trigger"`).
   * - Exceptions thrown by any observer callback (`origin: "onBefore" | "onAfter"` etc.).
   *
   * @param callback - The watcher to invoke on error.
   * @returns Unsubscribe function to remove the watcher.
   *
   * @example
   * ```ts
   * const off = orch.watchErrors(({ origin, arg, cause }) => {
   *   fail(`Unhandled error from ${origin} for ${String(arg.key)}: ${String(cause)}`);
   * });
   * // later: off();
   * ```
   */
  watchErrors(callback: TriggerErrorWatcher<TKey>): () => void {
    assertNotDisposed(this);

    const id = Symbol();
    this._errorWatchers.set(id, callback);

    return () => {
      this._errorWatchers.delete(id);
    };
  }

  /** Removes all registered error watchers. */
  clearErrorWatchers(): void {
    assertNotDisposed(this);

    this._errorWatchers.clear();
  }

  /**
   * Attach an observer to a specific trigger key.
   *
   * @param key - Trigger key to observe.
   * @param observer - Observer callbacks.
   * @returns Unsubscribe function.
   *
   * @throws Error if the trigger key has not been registered.
   */
  observe(key: TKey, observer: TriggerObserver<TKey>): () => void {
    assertNotDisposed(this);

    const stub = this._stubs.get(key);
    if (!stub) throw new Error(handlerNotRegistered(key));

    stub.observers.push(observer);
    return () => {
      const i = stub.observers.indexOf(observer);
      if (i >= 0) stub.observers.splice(i, 1);
    };
  }

  /**
   * Attach the same observer to **all currently registered triggers**.
   *
   * The supplied {@link TriggerObserver} is added to each trigger key’s
   * observer list. Its callbacks (`before`, `after`, `error`) fire with the
   * same semantics as {@link observe}:
   *
   * - `before` runs immediately prior to the handler invocation (after the
   *   `suspended` gate passes).
   * - `after` runs only if the handler **fulfills** (no throw/reject).
   * - `error` runs only if the handler **throws/rejects**.
   * - If a callback throws, the exception is surfaced via {@link watchErrors}.
   *
   * @remarks
   * - Applies to triggers **already registered** at call time. (Registration
   *   occurs in the constructor; new keys are not expected later.)
   * - The same `observer` object instance is attached to every key; if it
   *   keeps mutable state, ensure it is safe across keys.
   * - Callback order is per-key registration order; there is no cross-key
   *   ordering guarantee.
   *
   * @param observer - Observer callbacks to attach to every registered key.
   * @returns Unsubscribe function that removes this observer from **all** keys.
   *
   * @example
   * ```ts
   * const offAll = orch.observeAll({
   *   after: (e) => console.log('completed', String(e.key), e.completedCount),
   *   error: (e, err) => console.warn('failed', String(e.key), err),
   * });
   *
   * // ...later
   * offAll();
   * ```
   */
  observeAll(observer: TriggerObserver<TKey>): () => void {
    assertNotDisposed(this);

    const unsubs: (() => void)[] = [];
    this._stubs.forEach((stub) => {
      unsubs.push(this.observe(stub.key, observer));
    });

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }

  /**
   * Register a **post-invocation** callback for a trigger key.
   *
   * The `callback` runs **after** the associated Cloud Function handler
   * successfully completes (i.e., the invocation **fulfills** without
   * throwing/rejecting). It receives an {@link OrchestratorEventArg}
   * that includes the trigger payload and per-trigger stats.
   *
   * @remarks
   * - This is **not** an alias of {@link observe}. It is a convenience for
   *   `observe(key, { after: callback })`.
   * - The callback does **not** run for failed invocations. To react to
   *   failures, either use {@link observe} with an `error` handler or attach a
   *   global watcher via {@link watchErrors}.
   * - Multiple callbacks may be registered; they are invoked in **registration order**.
   * - If the callback throws, the exception is surfaced to global error
   *   watchers via {@link watchErrors} with `origin = "onAfter"`.
   *
   * @param key - Trigger key to attach the post-invocation callback to.
   * @param callback - Function invoked after a **successful** handler run.
   * @returns Unsubscribe function that removes this callback.
   *
   * @throws Error If no handler is registered for `key`.
   *
   * @example
   * ```ts
   * const off = orch.on(AppTrigger.OnTransactionWrite, (e) => {
   *   expect(e.completedCount).toBeGreaterThan(0);
   * });
   * // later: off();
   * ```
   */
  on(
    key: TKey,
    callback: (arg: OrchestratorEventArg<TKey>) => void
  ): () => void {
    assertNotDisposed(this);

    return this.observe(key, { after: callback });
  }

  /**
   * Register the same **post-invocation** callback for **all currently registered triggers**.
   *
   * The `callback` runs **after** each associated Cloud Function handler
   * successfully completes (i.e., the invocation **fulfills** without
   * throwing/rejecting). It receives an {@link OrchestratorEventArg}
   * that includes the trigger payload and per-trigger stats.
   *
   * @remarks
   * - Convenience for `observeAll({ after: callback })`.
   * - Applies to triggers **already registered** at call time (new keys are not expected later).
   * - The callback does **not** run for failed invocations. To react to failures,
   *   either use {@link observeAll} with an `error` handler or attach a global watcher
   *   via {@link watchErrors}.
   * - The same `callback` function instance is attached to every key; if it holds state,
   *   ensure it is safe across keys.
   * - Multiple callbacks may be registered; they are invoked in **registration order** per key.
   * - If the callback throws, the exception is surfaced to global error watchers via
   *   {@link watchErrors} with `origin = "onAfter"`.
   *
   * @param callback - Function invoked after a **successful** handler run for each key.
   * @returns Unsubscribe function that removes this callback from **all** keys.
   *
   * @example
   * ```ts
   * const off = orch.onAll((e) => {
   *   // Runs after each successful trigger, regardless of key
   *   console.log('completed', String(e.key), e.completedCount);
   * });
   * // ...later
   * off();
   * ```
   */
  onAll(callback: (arg: OrchestratorEventArg<TKey>) => void): () => void {
    assertNotDisposed(this);

    return this.observeAll({ after: callback });
  }

  /**
   * Wait for the **next** event for the given key that satisfies `predicate`.
   * Resolves with the extended event argument, or rejects on timeout/cancel.
   *
   * @remarks
   * - Use {@link waitOne} for a simpler “next invocation” await with no predicate.
   * - If `options.cancelOnError === true`, the waiter rejects if a matching
   *   run fails before the predicate can be satisfied.
   * - Waiters are serviced by a lightweight internal interval (5ms) that is
   *   **auto-stopped** when no waiters remain.
   *
   * @param key - Trigger key to wait on.
   * @param predicate - Match function evaluated on each **successful** completed event.
   * @param options - Timeout and cancellation behavior.
   */
  wait(
    key: TKey,
    predicate: (arg: OrchestratorEventArg<TKey>) => boolean,
    options?: WaitOptions
  ): Promise<OrchestratorEventArg<TKey>> {
    assertNotDisposed(this);

    return this.registerWaitHandle(
      key,
      predicate,
      (stub) => stub.waitHandles,
      options
    );
  }

  /**
   * Wait for the **next** event for the given key (no predicate).
   *
   * @param key - Trigger key.
   * @param options - Timeout and cancellation behavior.
   * @see {@link wait}
   */
  waitOne(
    key: TKey,
    options?: WaitOptions
  ): Promise<OrchestratorEventArg<TKey>> {
    assertNotDisposed(this);

    return this.wait(key, () => true, options);
  }

  /**
   * Wait for the **next error event** for the given key that satisfies `predicate`.
   * Resolves with {@link OrchestratorErrorEventArg} or rejects on timeout.
   *
   * @remarks
   * - Use {@link waitOneError} to await the next error without a predicate.
   * - Error waiters match **only** failed trigger runs (or observer failures surfaced
   *   via {@link watchErrors}).
   *
   * @param key - Trigger key to wait on.
   * @param predicate - Match function evaluated on each error event.
   * @param options - Timeout behavior.
   */
  waitError(
    key: TKey,
    predicate: (arg: OrchestratorErrorEventArg<TKey>) => boolean,
    options?: WaitErrorOptions
  ): Promise<OrchestratorErrorEventArg<TKey>> {
    assertNotDisposed(this);

    return this.registerWaitHandle(
      key,
      predicate,
      (stub) => stub.errorWaitHandles,
      options
    );
  }

  /**
   * Wait for the **next error event** for the given key (no predicate).
   *
   * @param key - Trigger key.
   * @param options - Timeout behavior.
   * @see {@link waitError}
   */
  waitOneError(
    key: TKey,
    options?: WaitErrorOptions
  ): Promise<OrchestratorErrorEventArg<TKey>> {
    assertNotDisposed(this);

    return this.waitError(key, () => true, options);
  }

  /**
   * Resets orchestrator state:
   * - Unsubscribes all observers,
   * - Cancels all active waiters,
   * - Zeroes all counters,
   * - Re-enables all registered triggers.
   *
   * @remarks
   * - Stats are preserved only until this call; after reset they are zeroed.
   * - Observers and waiters are **not** preserved.
   */
  reset(): void {
    if (this.isDiposed) return;

    this.detach();
    this._stubs.forEach((stub) => {
      const stats = stub.stats;
      stats.initiatedCount = 0;
      stats.completedCount = 0;
      stats.errorCount = 0;
      stub.sub();
    });
  }

  /**
   * Enables all registered triggers (does not alter observers or waiters).
   */
  attach(): void {
    assertNotDisposed(this);

    this.all(true);
  }

  /**
   * Disables all registered triggers, clears observers, and cancels active
   * waiters. Does **not** clear stats.
   */
  detach(): void {
    if (this.isDiposed) return;

    function cancelWaitHandles<T>(set: WaitHandle<TKey, T>[]): void {
      for (const wh of [...set]) {
        wh.cancel();
      }
    }
    this.clearInterrupt();
    this._stubs.forEach((stub) => {
      stub.observers.length = 0;
      stub.unsub();
      cancelWaitHandles(stub.waitHandles);
      cancelWaitHandles(stub.errorWaitHandles);
    });
  }

  // --- Internals below here ---

  /** @internal */
  private registerWaitHandle<TArg>(
    key: TKey,
    predicate: (arg: TArg) => boolean,
    setResolver: (stub: TriggerStub<TKey>) => WaitHandle<TKey, TArg>[],
    options?: WaitErrorOptions
  ): Promise<TArg> {
    const stub = this._stubs.get(key);
    if (!stub)
      return Promise.reject(
        new Error(waitHandleMsg(handlerNotRegistered(key)))
      );

    const set = setResolver(stub);

    const wh = new WaitHandle(set, predicate, options);
    this.ensureInterrupt();

    return wh.promise;
  }

  /**
   * Starts (if necessary) the interval that services waiter timeouts.
   * The interval is cleared automatically when no waiters remain.
   *
   * @internal
   */
  private ensureInterrupt(): void {
    function tick<T>(now: number, set: WaitHandle<TKey, T>[]): void {
      for (const wh of [...set]) {
        wh.tick(now);
      }
    }

    const INTERVAL = 5;
    if (!this._interrupt) {
      const t = setInterval(() => {
        const now = Date.now();
        this._stubs.forEach((stub) => {
          tick(now, stub.waitHandles);
          tick(now, stub.errorWaitHandles);
        });
        // Clear interval if no wait handles remain
        let count = 0;
        this._stubs.forEach((stub) => {
          count += stub.waitHandles.length;
          count += stub.errorWaitHandles.length;
        });
        if (count === 0) {
          this.clearInterrupt();
        }
      }, INTERVAL);
      t.unref?.();
      this._interrupt = t;
    }
  }

  /** Clears the waiter timeout interval (if running). @internal */
  private clearInterrupt(): void {
    if (this._interrupt) {
      clearInterval(this._interrupt);
      this._interrupt = undefined;
    }
  }

  /** Internal hook invoked before the wrapped trigger handler executes. @internal */
  private _onBefore(stub: TriggerStub<TKey>, arg: TriggerEventArg): void {
    stub.stats.initiatedCount += 1;
    this.executeObservers(
      TriggerErrorOrigin.OnBefore,
      stub,
      arg,
      (stub) => stub.before
    );
  }

  /** Internal hook invoked after the wrapped trigger handler fulfills. @internal */
  private _onAfter(stub: TriggerStub<TKey>, arg: TriggerEventArg): void {
    stub.stats.completedCount += 1;
    this.executeObservers(
      TriggerErrorOrigin.OnAfter,
      stub,
      arg,
      (stub) => stub.after
    );
    if (!stub.waitHandles.length) return;

    const argEx = makeEventArg(stub, arg);
    for (const wh of [...stub.waitHandles]) {
      wh.eval(argEx);
    }
  }

  /** Internal hook invoked when the wrapped trigger handler throws/rejects. @internal */
  private _onError(
    stub: TriggerStub<TKey>,
    arg: TriggerRunnerErrorEventArg
  ): void {
    stub.stats.errorCount += 1;
    this.executeObservers(arg.origin, stub, arg.arg, (stub) => stub.error, {
      cause: arg.cause,
    });
    if (stub.waitHandles.length) {
      for (const wh of [...stub.waitHandles]) {
        if (wh.cancelOnError) {
          wh.cancel(arg.cause);
        }
      }
    }

    const argEx = makeEventArg(stub, arg.arg);
    this.raiseGlobalError(arg.origin, argEx, arg.cause);

    if (!stub.errorWaitHandles.length) return;

    const eArg = makeErrorEventArg(arg.origin, argEx, arg.cause);
    for (const wh of [...stub.errorWaitHandles]) {
      wh.eval(eArg);
    }
  }

  /**
   * Executes the resolved observer callback and surfaces any thrown errors
   * through {@link watchErrors}.
   *
   * @internal
   */
  private executeObservers(
    origin: TriggerErrorOrigin,
    stub: TriggerStub<TKey>,
    arg: TriggerEventArg,
    resolver: HandlerResolver<TKey>,
    error?: {
      cause?: unknown;
    }
  ): void {
    if (!stub.observers.length) return;

    const isError = error != undefined;
    let baseArg: OrchestratorEventArg<TKey> | undefined;
    let refArg:
      | OrchestratorEventArg<TKey>
      | OrchestratorErrorEventArg<TKey>
      | undefined;
    for (const obs of [...stub.observers]) {
      const fn = resolver(obs);
      if (!fn) continue;
      if (!baseArg) {
        baseArg = makeEventArg(stub, arg);
        refArg = isError
          ? makeErrorEventArg(origin, baseArg, error.cause)
          : baseArg;
      }
      try {
        // Cast as ObserverErrorCallback for convenience.
        fn(refArg as OrchestratorErrorEventArg<TKey>);
      } catch (e) {
        this.raiseGlobalError(origin, baseArg, e);
      }
    }
  }

  /** Raises a global error event to all registered error watchers. @internal */
  private raiseGlobalError(
    origin: TriggerErrorOrigin,
    arg: OrchestratorEventArg<TKey>,
    cause: unknown
  ): void {
    if (!this._errorWatchers.size) return;
    const eArg = makeErrorEventArg(origin, arg, cause);

    this._errorWatchers.forEach((fn) => {
      try {
        fn(eArg);
      } catch {
        // Swallow watcher exceptions to avoid error loops.
      }
    });
  }
}

function assertNotDisposed<TKey extends TriggerKey>(
  o: TriggerOrchestrator<TKey>
): void {
  if (o.isDiposed) throw new Error('Object disposed.');
}

/** @internal */
function makeErrorEventArg<TKey extends TriggerKey>(
  origin: TriggerErrorOrigin,
  arg: OrchestratorEventArg<TKey>,
  cause: unknown
): OrchestratorErrorEventArg<TKey> {
  const eArg: OrchestratorErrorEventArg<TKey> = {
    origin,
    cause,
    ...arg,
  };

  Object.freeze(eArg);

  return eArg;
}

/** @internal */
function makeEventArg<TKey extends TriggerKey>(
  stub: TriggerStub<TKey>,
  arg: TriggerEventArg
): OrchestratorEventArg<TKey> {
  const ex: OrchestratorEventArg<TKey> = {
    key: stub.key,
    ...arg,
    ...stub.stats,
  };
  Object.freeze(ex);

  return ex;
}

/** @internal */
function handlerNotRegistered(key: TriggerKey): string {
  return `No trigger handler associated with the key "${key}" is registered.`;
}

/** @internal */
function waitHandleMsg(msg: string): string {
  return `TriggerOrchestrator WaitHandle: ${msg}`;
}

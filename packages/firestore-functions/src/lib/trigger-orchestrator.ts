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
 * - This module is designed for **unit/integration tests**. It replaces the emulator boot/deploy
 *   loop with a fast, deterministic in-process environment.
 * - Triggers are **enabled by default** after construction (equivalent to `orch.all(true)`).
 * - External services (Pub/Sub, third-party APIs, etc.) are not mocked here—supply your own doubles.
 * - All invocations flow through the package’s `v1/register-trigger` and `v2/register-trigger` shims.
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
export interface TriggerEventExArg<TKey extends TriggerKey>
  extends TriggerEventArg,
    TriggerStats<TKey> {}

/**
 * Observer callbacks that can be attached to a single trigger key.
 *
 * @remarks
 * - `before` runs immediately prior to the Cloud Function invocation.
 * - `after` runs if the Cloud Function **fulfills** (no error thrown).
 * - `error` runs if the Cloud Function **throws/rejects**.
 * - If an observer throws, that exception is surfaced via
 *   {@link TriggerOrchestrator.watchErrors | watchErrors()}.
 *
 * @public
 */
export interface TriggerObserver<TKey extends TriggerKey> {
  before?: (arg: TriggerEventExArg<TKey>) => void;
  after?: (arg: TriggerEventExArg<TKey>) => void;
  error?: (arg: TriggerEventExArg<TKey>, error: unknown) => void;
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
 * Options controlling the behavior of a single waiter created by
 * {@link TriggerOrchestrator.wait} or {@link TriggerOrchestrator.waitOne}.
 *
 * @public
 */
export interface WaitOptions {
  /**
   * If `true`, the waiter is **rejected** when a matching trigger run fails
   * (throws/rejects) before its predicate can be satisfied. Defaults to `false`.
   */
  cancelOnError?: boolean;

  /**
   * Timeout in milliseconds before the waiter rejects with a timeout error.
   * Defaults to `3000`.
   */
  timeout?: number;
}

/**
 * Argument passed to global error watchers registered via
 * {@link TriggerOrchestrator.watchErrors}.
 *
 * @public
 */
export interface TriggerErrorEventArg<TKey extends TriggerKey> {
  /** Classification for where the error originated. */
  origin: TriggerErrorOrigin;
  /** The extended event argument for the failed/observed run. */
  arg: TriggerEventExArg<TKey>;
  /** The underlying error/exception (as thrown by the trigger or observer). */
  cause: unknown;
}

/**
 * Callback signature for global error watchers.
 *
 * @public
 */
export type TriggerErrorWatcher<TKey extends TriggerKey> = (
  arg: TriggerErrorEventArg<TKey>
) => void;

type ObserverCallback<TKey extends TriggerKey> = (
  arg: TriggerEventExArg<TKey>,
  error?: unknown
) => void;

type InternalHandler =
  | CloudFunctionV1<TriggerPayloadV1>
  | CloudFunctionV2<CloudEvent<unknown>>;

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
  waitHandles: WaitHandle<TKey, TriggerEventExArg<TKey>>[];
  errorWaitHandles: WaitHandle<TKey, TriggerErrorEventArg<TKey>>[];
}

class WaitHandle<TKey extends TriggerKey, TArg> {
  private _expires: number;
  private _resolve!: (arg: TArg) => void;
  private _reject!: (reason: Error) => void;

  /** Promise that resolves when the predicate matches or rejects on timeout/cancel. */
  readonly promise: Promise<TArg>;
  /** When `true`, fail the waiter if a matching trigger run errors. */
  readonly cancelOnError: boolean;

  /**
   * @param stub - Internal trigger record to attach this waiter to.
   * @param predicate - Predicate evaluated against each completed event.
   * @param options - Timeout and cancellation behavior.
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

type HandlerResolver<TKey extends TriggerKey> = (
  obs: TriggerObserver<TKey>
) => ObserverCallback<TKey> | undefined;

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
 *   (e) => e.after?.exists === true, // any predicate against TriggerEventExArg
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
  private _suspended = false;
  private _interrupt: ReturnType<typeof setInterval> | undefined;
  private _stubs = new Map<TKey, TriggerStub<TKey>>();
  private _errorWatchers = new Map<symbol, TriggerErrorWatcher<TKey>>();

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
              predicate() {
                return !owner._suspended;
              },
              onBefore(arg) {
                owner._onBefore(stub, arg);
              },
              onAfter(arg) {
                owner._onAfter(stub, arg);
              },
              onError(arg) {
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
    this.all(true);
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

  /**
   * Enables or disables **all** registered triggers in one call.
   *
   * @param enable - `true` to enable; `false` to disable.
   */
  all(enable: boolean): void {
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
    return this._stubs.get(trigger)?.active === true;
  }

  /**
   * Returns immutable stats for a trigger key. If the key is unknown,
   * a zeroed stats object is returned.
   *
   * @param key - The key for which to fetch stats.
   */
  getStats(key: TKey): TriggerStats<TKey> {
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
   * - Exceptions thrown by any observer callback (`origin: "observer-*"`).
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
    const id = Symbol();
    this._errorWatchers.set(id, callback);

    return () => {
      this._errorWatchers.delete(id);
    };
  }

  /** Removes all registered error watchers. */
  clearErrorWatchers(): void {
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
    const stub = this._stubs.get(key);
    if (!stub) throw new Error(handlerNotRegistered(key));

    stub.observers.push(observer);
    return () => {
      const i = stub.observers.indexOf(observer);
      if (i >= 0) stub.observers.splice(i, 1);
    };
  }

  /**
   * Alias of {@link observe}.
   *
   * @param key - Trigger key to observe.
   * @param observer - Observer callbacks.
   * @returns Unsubscribe function.
   */
  on(key: TKey, observer: TriggerObserver<TKey>): () => void {
    return this.observe(key, observer);
  }

  /**
   * Wait for the **next** event for the given key that satisfies `predicate`.
   * Resolves with the extended event argument, or rejects on timeout/cancel.
   *
   * @remarks
   * - Use {@link waitOne} for a simpler “next invocation” await with no predicate.
   * - If `options.cancelOnError === true`, the waiter rejects if a matching
   *   run fails before the predicate can be satisfied.
   *
   * @param key - Trigger key to wait on.
   * @param predicate - Match function evaluated on each completed event.
   * @param options - Timeout and cancellation behavior.
   */
  wait(
    key: TKey,
    predicate: (arg: TriggerEventExArg<TKey>) => boolean,
    options?: WaitOptions
  ): Promise<TriggerEventExArg<TKey>> {
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
  waitOne(key: TKey, options?: WaitOptions): Promise<TriggerEventExArg<TKey>> {
    return this.wait(key, () => true, options);
  }

  waitError(
    key: TKey,
    predicate: (arg: TriggerErrorEventArg<TKey>) => boolean,
    options?: WaitOptions
  ): Promise<TriggerErrorEventArg<TKey>> {
    return this.registerWaitHandle(
      key,
      predicate,
      (stub) => stub.errorWaitHandles,
      options
    );
  }

  waitOneError(
    key: TKey,
    options?: WaitOptions
  ): Promise<TriggerErrorEventArg<TKey>> {
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
   * Stats are preserved only until this call; after reset they are zeroed.
   */
  reset(): void {
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
    this.all(true);
  }

  /**
   * Disables all registered triggers, clears observers, and cancels active
   * waiters. Does **not** clear stats.
   */
  detach(): void {
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

  private registerWaitHandle<TArg>(
    key: TKey,
    predicate: (arg: TArg) => boolean,
    setResolver: (stub: TriggerStub<TKey>) => WaitHandle<TKey, TArg>[],
    options?: WaitOptions
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

  /** Starts (if necessary) the interval that services waiter timeouts. */
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

  /** Clears the waiter timeout interval (if running). */
  private clearInterrupt(): void {
    if (this._interrupt) {
      clearInterval(this._interrupt);
      this._interrupt = undefined;
    }
  }

  /** Internal hook invoked before the wrapped trigger handler executes. */
  private _onBefore(stub: TriggerStub<TKey>, arg: TriggerEventArg): void {
    stub.stats.initiatedCount += 1;
    this.executeObservers(
      TriggerErrorOrigin.OnBefore,
      stub,
      arg,
      (stub) => stub.before
    );
  }

  /** Internal hook invoked after the wrapped trigger handler fulfills. */
  private _onAfter(stub: TriggerStub<TKey>, arg: TriggerEventArg): void {
    stub.stats.completedCount += 1;
    this.executeObservers(
      TriggerErrorOrigin.OnAfter,
      stub,
      arg,
      (stub) => stub.after
    );
    if (!stub.waitHandles.length) return;

    const argEx = makeArgEx(stub, arg);
    for (const wh of [...stub.waitHandles]) {
      wh.eval(argEx);
    }
  }

  /** Internal hook invoked when the wrapped trigger handler throws/rejects. */
  private _onError(
    stub: TriggerStub<TKey>,
    arg: TriggerRunnerErrorEventArg
  ): void {
    stub.stats.errorCount += 1;
    this.executeObservers(
      arg.origin,
      stub,
      arg.arg,
      (stub) => stub.error,
      arg.cause
    );
    if (stub.waitHandles.length) {
      for (const wh of [...stub.waitHandles]) {
        if (wh.cancelOnError) {
          wh.cancel(arg.cause);
        }
      }
    }

    const argEx = makeArgEx(stub, arg.arg);
    this.raiseGlobalError(arg.origin, argEx, arg.cause);

    if (!stub.errorWaitHandles.length) return;

    const eArg = makeErrorArg(arg.origin, argEx, arg.cause);
    for (const wh of [...stub.errorWaitHandles]) {
      wh.eval(eArg);
    }
  }

  /**
   * Executes the resolved observer callback and surfaces any thrown errors
   * through {@link watchErrors}.
   */
  private executeObservers(
    origin: TriggerErrorOrigin,
    stub: TriggerStub<TKey>,
    arg: TriggerEventArg,
    resolver: HandlerResolver<TKey>,
    error?: unknown
  ): void {
    if (!stub.observers.length) return;

    let ex: TriggerEventExArg<TKey> | undefined;
    for (const obs of [...stub.observers]) {
      const fn = resolver(obs);
      if (!fn) continue;
      if (!ex) {
        ex = makeArgEx(stub, arg);
      }
      try {
        fn(ex, error);
      } catch (e) {
        this.raiseGlobalError(origin, ex, e);
      }
    }
  }

  /** Raises a global error event to all registered error watchers. */
  private raiseGlobalError(
    origin: TriggerErrorOrigin,
    arg: TriggerEventExArg<TKey>,
    cause: unknown
  ): void {
    if (!this._errorWatchers.size) return;
    const eArg = makeErrorArg(origin, arg, cause);

    this._errorWatchers.forEach((fn) => {
      try {
        fn(eArg);
      } catch {
        // Swallow watcher exceptions to avoid error loops.
      }
    });
  }
}

function makeErrorArg<TKey extends TriggerKey>(
  origin: TriggerErrorOrigin,
  arg: TriggerEventExArg<TKey>,
  cause: unknown
): TriggerErrorEventArg<TKey> {
  const eArg: TriggerErrorEventArg<TKey> = {
    origin,
    arg,
    cause,
  };

  Object.freeze(eArg);

  return eArg;
}

function makeArgEx<TKey extends TriggerKey>(
  stub: TriggerStub<TKey>,
  arg: TriggerEventArg
): TriggerEventExArg<TKey> {
  const ex: TriggerEventExArg<TKey> = {
    key: stub.key,
    ...arg,
    ...stub.stats,
  };
  Object.freeze(ex);

  return ex;
}

function handlerNotRegistered(key: TriggerKey): string {
  return `No trigger handler associated with the key "${key}" is registered.`;
}

function waitHandleMsg(msg: string): string {
  return `TriggerOrchestrator WaitHandle: ${msg}`;
}

import {
  FirestoreController,
  TriggerEventArg,
} from '@firebase-bridge/firestore-admin';
import { CloudFunction as CloudFunctionV1 } from 'firebase-functions/v1';
import {
  CloudEvent,
  CloudFunction as CloudFunctionV2,
} from 'firebase-functions/v2';
import { RegisterTriggerOptions } from './_internal/types.js';
import { } from './_internal/util.js';
import {
  TriggerPayload as TriggerPayloadV1,
  registerTrigger as registerTriggerV1,
} from './v1/register-trigger.js';
import { registerTrigger as registerTriggerV2 } from './v2/register-trigger.js';

/**
 * @module TriggerOrchestrator
 *
 * Orchestrates registration, enable/disable, observation, and waiting for
 * Firestore trigger handlers (Cloud Functions v1 **and** v2) against the
 * in-memory database from `@firebase-bridge/firestore-admin`.
 *
 * @remarks
 * - This module is intended for **test environments**. It helps you stand up a
 *   complete backend (Firestore data + trigger functions) without the emulator.
 * - External services (e.g., PubSub, third-party APIs) are **not** mocked here;
 *   you will need to provide your own doubles/stubs for those.
 * - All trigger invocations flow through `registerTriggerV1`/`registerTriggerV2`
 *   with a guard based on the orchestrator’s `suspended` state.
 */

/** Union of allowed keys used to identify triggers in the orchestrator. */
export type TriggerKey = string | number;

/**
 * Aggregate counters for a given trigger key.
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
 */
export interface TriggerEventExArg<TKey extends TriggerKey>
  extends TriggerEventArg,
    TriggerStats<TKey> {}

/**
 * Observer callbacks that can be attached to a single trigger key.
 *
 * @remarks
 * - `before` runs just prior to the Cloud Function invocation.
 * - `after` runs if the Cloud Function **fulfills**.
 * - `error` runs if the Cloud Function **throws/rejects**.
 * - If an observer callback throws, the exception is surfaced via
 *   {@link TriggerOrchestrator.watchErrors}.
 */
export interface TriggerObserver<TKey extends TriggerKey> {
  before?: (arg: TriggerEventExArg<TKey>) => void;
  after?: (arg: TriggerEventExArg<TKey>) => void;
  error?: (arg: TriggerEventExArg<TKey>, error: unknown) => void;
}

/**
 * Registrar passed to your setup function in the {@link TriggerOrchestrator}
 * constructor. Use it to register v1 and v2 handlers bound to keys.
 *
 * @example
 * ```ts
 * new TriggerOrchestrator<AppTrigger>(ctl, (r) => {
 *   r.v1(AppTrigger.OnTransactionWrite, onTransactionWriteV1);
 *   r.v2(AppTrigger.OnBudgetStructureCreate, onBudgetStructureCreateV2);
 * });
 * ```
 */
export interface TriggerRegistrar<TKey extends TriggerKey> {
  /**
   * Registers a Cloud Functions **v1** Firestore handler for a key.
   */
  v1(key: TKey, handler: CloudFunctionV1<TriggerPayloadV1>): void;

  /**
   * Registers a Cloud Functions **v2** Firestore handler for a key.
   */
  v2<T>(key: TKey, handler: CloudFunctionV2<CloudEvent<T>>): void;
}

/**
 * Options controlling the behavior of a single {@link TriggerOrchestrator.waitOne}
 * or {@link TriggerOrchestrator.waitNext} waiter.
 */
export interface WaitOneOptions {
  /**
   * If `true`, the waiter is rejected when the corresponding trigger run
   * fails (throws/rejects). Default is `false`.
   */
  cancelOnError?: boolean;

  /**
   * Timeout in milliseconds. Default is `3000`.
   */
  timeout?: number;
}

/** Where a surfaced error originated. */
export type TriggerErrorSource =
  | 'observer-before'
  | 'observer-after'
  | 'observer-error'
  | 'trigger';

/**
 * Argument passed to error watchers registered via
 * {@link TriggerOrchestrator.watchErrors}.
 */
export interface TriggerErrorEventArg<TKey extends TriggerKey> {
  /** Classification for where the error originated. */
  source: TriggerErrorSource;
  /** The extended event argument for the failed/observed run. */
  arg: TriggerEventExArg<TKey>;
  /** The underlying error/exception. */
  cause: unknown;
}

/** Callback signature for global error watchers. */
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
  waitHandles: WaitHandle<TKey>[];
}

class WaitHandle<TKey extends TriggerKey> {
  private _expires: number;
  private _resolve!: (arg: TriggerEventExArg<TKey>) => void;
  private _reject!: (reason: Error) => void;

  /** Promise that resolves when the predicate matches or rejects on timeout/cancel. */
  readonly promise: Promise<TriggerEventExArg<TKey>>;
  /** When `true`, fail the waiter if a matching trigger run errors. */
  readonly cancelOnError: boolean;

  constructor(
    private readonly stub: TriggerStub<TKey>,
    private readonly predicate: (arg: TriggerEventExArg<TKey>) => boolean,
    options?: WaitOneOptions
  ) {
    const DEFAULT_TIMEOUT = 3000;
    this._expires = Date.now() + (options?.timeout ?? DEFAULT_TIMEOUT);
    this.cancelOnError = options?.cancelOnError === true;
    this.promise = new Promise<TriggerEventExArg<TKey>>(
      (
        resolve: (arg: TriggerEventExArg<TKey>) => void,
        reject: (reason: Error) => void
      ) => {
        this._resolve = resolve;
        this._reject = reject;
      }
    );
    stub.waitHandles.push(this);
  }

  /** Evaluate the waiter against an event; resolve if the predicate matches. */
  eval(arg: TriggerEventExArg<TKey>): void {
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
    const idx = this.stub.waitHandles.indexOf(this);
    if (idx >= 0) {
      this.stub.waitHandles.splice(idx, 1);
    }
  }
}

interface HandlerResolver<TKey extends TriggerKey> {
  source: TriggerErrorSource;
  resolve(obs: TriggerObserver<TKey>): ObserverCallback<TKey> | undefined;
}

const OnBeforeResolver: HandlerResolver<TriggerKey> = {
  source: 'observer-before',
  resolve(
    obs: TriggerObserver<TriggerKey>
  ): ObserverCallback<TriggerKey> | undefined {
    return obs.before;
  },
};

const OnAfterResolver: HandlerResolver<TriggerKey> = {
  source: 'observer-after',
  resolve(
    obs: TriggerObserver<TriggerKey>
  ): ObserverCallback<TriggerKey> | undefined {
    return obs.after;
  },
};

const OnErrorResolver: HandlerResolver<TriggerKey> = {
  source: 'observer-error',
  resolve(
    obs: TriggerObserver<TriggerKey>
  ): ObserverCallback<TriggerKey> | undefined {
    return obs.error;
  },
};

/**
 * Coordinates Cloud Functions (v1/v2) trigger handlers over the in-memory
 * Firestore database, providing enable/disable controls, per-trigger stats,
 * observer hooks, and awaiting utilities for deterministic testing.
 *
 * @typeParam TKey - The key type used to identify triggers (string or number).
 *
 * @example Basic setup
 * ```ts
 * const orch = new TriggerOrchestrator<AppTrigger>(ctl, (r) => {
 *   r.v1(AppTrigger.OnTransactionWrite, onTransactionWriteV1);
 *   r.v2(AppTrigger.OnBudgetStructureCreate, onBudgetStructureCreateV2);
 * });
 *
 * // Ensure all triggers are enabled (default after construction)
 * orch.all(true);
 * ```
 *
 * @example Wait for the next invocation
 * ```ts
 * const evt = await orch.waitNext(AppTrigger.OnTransactionWrite, { timeout: 2000 });
 * expect(evt.completedCount).toBeGreaterThan(0);
 * ```
 *
 * @example Observe successes and failures
 * ```ts
 * const off = orch.on(AppTrigger.OnTransactionWrite, {
 *   after: (a) => console.log('ok', a.key, a.completedCount),
 *   error: (a, e) => console.warn('fail', a.key, e),
 * });
 * // later: off();
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
   * - On construction, all registered triggers are **enabled** by default via {@link all}(true).
   * - Each registered handler is wrapped so that:
   *   - It is gated by {@link suspended} (not invoked while suspended).
   *   - It updates per-trigger stats.
   *   - It notifies any observers and active waiters.
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
              onError(arg, error) {
                owner._onError(stub, arg, error);
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
   * When `true`, suppresses **all** trigger invocations at the registration layer.
   * Useful for test setup/teardown or to pause cascading side-effects.
   */
  get suspended(): boolean {
    return this._suspended;
  }

  /** Sets {@link suspended}. */
  set suspended(value: boolean) {
    this._suspended = value === true;
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
   * @throws Error if a key has not been registered.
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
   * @throws Error if a key has not been registered.
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

  /** Returns `true` if the specified trigger is currently enabled. */
  isEnabled(trigger: TKey): boolean {
    return this._stubs.get(trigger)?.active === true;
  }

  /**
   * Returns immutable stats for a trigger key. If the key is unknown,
   * a zeroed stats object is returned.
   */
  getStats(key: TKey): TriggerStats<TKey> {
    const stub = this._stubs.get(key);
    if (stub?.stats)
      return {
        key,
        ...stub.stats,
      };

    return {
      key,
      completedCount: 0,
      errorCount: 0,
      initiatedCount: 0,
    };
  }

  /**
   * Register a global error watcher. The watcher is invoked for:
   * - Failures thrown by the Cloud Function (`source: "trigger"`).
   * - Exceptions thrown by any observer callback (`source: "observer-*"`)
   *
   * @returns Unsubscribe function.
   *
   * @example
   * ```ts
   * const off = orch.watchErrors(({ source, arg, cause }) => {
   *   fail(`Unhandled error from ${source}: ${String(cause)}`);
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

  /** Alias of {@link observe}. */
  on(key: TKey, observer: TriggerObserver<TKey>): () => void {
    return this.observe(key, observer);
  }

  /**
   * Wait for the **next** event for the given key that satisfies `predicate`.
   * Resolves with the extended event argument, or rejects on timeout/cancel.
   *
   * @remarks
   * - Use {@link waitNext} as a convenience when you don't need a predicate.
   * - If `options.cancelOnError === true`, the waiter is rejected if a matching
   *   run fails before the predicate can be satisfied.
   */
  waitOne(
    key: TKey,
    predicate: (arg: TriggerEventExArg<TKey>) => boolean,
    options?: WaitOneOptions
  ): Promise<TriggerEventExArg<TKey>> {
    const stub = this._stubs.get(key);
    if (!stub)
      return Promise.reject(
        new Error(waitHandleMsg(handlerNotRegistered(key)))
      );

    const wh = new WaitHandle(stub, predicate, options);
    this.ensureInterrupt();

    return wh.promise;
  }

  /**
   * Wait for the **next** event for the given key (no predicate).
   *
   * @see waitOne
   */
  waitNext(
    key: TKey,
    options?: WaitOneOptions
  ): Promise<TriggerEventExArg<TKey>> {
    return this.waitOne(key, () => true, options);
  }

  /**
   * Resets orchestrator state:
   * - Unsubscribes all observers,
   * - Cancels all active waiters,
   * - Zeroes all counters,
   * - Re-enables all registered triggers.
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

  /** Enables all registered triggers (does not alter observers or waiters). */
  attach(): void {
    this.all(true);
  }

  /**
   * Disables all registered triggers, clears observers, and cancels active
   * waiters. Does **not** clear stats.
   */
  detach(): void {
    this.clearInterrupt();
    this._stubs.forEach((stub) => {
      stub.observers.length = 0;
      stub.unsub();
      for (const wh of [...stub.waitHandles]) {
        wh.cancel();
      }
    });
  }

  // --- Internals below here ---

  private ensureInterrupt(): void {
    const INTERVAL = 50;
    if (!this._interrupt) {
      const t = setInterval(() => {
        const now = Date.now();
        this._stubs.forEach((stub) => {
          for (const wh of [...stub.waitHandles]) {
            wh.tick(now);
          }
        });
        // Clear interrupt if no wait handles remain
        let count = 0;
        this._stubs.forEach((stub) => {
          count += stub.waitHandles.length;
        });
        if (count === 0) {
          this.clearInterrupt();
        }
      }, INTERVAL);
      t.unref?.();
      this._interrupt = t;
    }
  }

  private clearInterrupt(): void {
    if (this._interrupt) {
      clearInterval(this._interrupt);
      this._interrupt = undefined;
    }
  }

  private _onBefore(stub: TriggerStub<TKey>, arg: TriggerEventArg): void {
    stub.stats.initiatedCount += 1;
    this.executeObservers(stub, arg, OnBeforeResolver);
  }

  private _onAfter(stub: TriggerStub<TKey>, arg: TriggerEventArg): void {
    stub.stats.completedCount += 1;
    this.executeObservers(stub, arg, OnAfterResolver);
    if (!stub.waitHandles.length) return;

    const argEx = makeArgEx(stub, arg);
    for (const wh of [...stub.waitHandles]) {
      wh.eval(argEx);
    }
  }

  private _onError(
    stub: TriggerStub<TKey>,
    arg: TriggerEventArg,
    error: unknown
  ): void {
    stub.stats.errorCount += 1;
    this.executeObservers(stub, arg, OnErrorResolver, error);
    if (stub.waitHandles.length) {
      for (const wh of [...stub.waitHandles]) {
        if (wh.cancelOnError) {
          wh.cancel(error);
        }
      }
    }
    this.raiseGlobalError('trigger', makeArgEx(stub, arg), error);
  }

  private executeObservers(
    stub: TriggerStub<TKey>,
    arg: TriggerEventArg,
    resolver: HandlerResolver<TKey>,
    error?: unknown
  ): void {
    if (!stub.observers.length) return;

    let ex: TriggerEventExArg<TKey> | undefined;
    for (const obs of [...stub.observers]) {
      const fn = resolver.resolve(obs);
      if (!fn) continue;
      if (!ex) {
        ex = makeArgEx(stub, arg);
      }
      try {
        fn(ex, error);
      } catch (e) {
        this.raiseGlobalError(resolver.source, ex, e);
      }
    }
  }

  private raiseGlobalError(
    source: TriggerErrorSource,
    arg: TriggerEventExArg<TKey>,
    cause: unknown
  ): void {
    if (!this._errorWatchers.size) return;
    const wArg: TriggerErrorEventArg<TKey> = {
      arg,
      cause,
      source,
    };

    Object.freeze(wArg);

    this._errorWatchers.forEach((fn) => {
      try {
        fn(wArg);
      } catch {
        // noop
      }
    });
  }
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

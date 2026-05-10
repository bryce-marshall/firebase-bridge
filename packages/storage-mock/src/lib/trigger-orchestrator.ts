import type { CloudFunction as CloudFunctionV1 } from 'firebase-functions/v1';
import type {
  CloudEvent,
  CloudFunction as CloudFunctionV2,
} from 'firebase-functions/v2';
import {
  RegisterStorageTriggerOptions,
  StorageController,
  StorageChangeRecord,
  StorageOrchestratorErrorEventArg,
  StorageOrchestratorEventArg,
  StorageTriggerErrorOrigin,
  StorageTriggerErrorWatcher,
  StorageTriggerObserver,
  StorageTriggerRunnerErrorEventArg,
  StorageTriggerStats,
  TriggerKey,
  WaitErrorOptions,
  WaitOptions,
} from './types.js';
import {
  registerTrigger as registerTriggerV1,
  TriggerPayload as TriggerPayloadV1,
} from './v1/register-trigger.js';
import { registerTrigger as registerTriggerV2 } from './v2/register-trigger.js';

export interface StorageTriggerRegistrar<TKey extends TriggerKey> {
  v1(key: TKey, handler: CloudFunctionV1<TriggerPayloadV1>): void;
  v2<T extends CloudEvent<unknown>>(key: TKey, handler: CloudFunctionV2<T>): void;
}

type InternalHandler =
  | CloudFunctionV1<TriggerPayloadV1>
  | CloudFunctionV2<CloudEvent<unknown>>;

interface TriggerStub<TKey extends TriggerKey> {
  readonly key: TKey;
  get active(): boolean;
  sub(): void;
  unsub(): void;
  readonly stats: {
    initiatedCount: number;
    completedCount: number;
    errorCount: number;
  };
  readonly observers: StorageTriggerObserver<TKey>[];
  readonly waitHandles: WaitHandle<TKey, StorageOrchestratorEventArg<TKey>>[];
  readonly errorWaitHandles: WaitHandle<TKey, StorageOrchestratorErrorEventArg<TKey>>[];
}

class WaitHandle<TKey extends TriggerKey, TArg> {
  private expires: number;
  private resolve!: (arg: TArg) => void;
  private rejectFn!: (reason: Error) => void;
  readonly promise: Promise<TArg>;
  readonly cancelOnError: boolean;

  constructor(
    private readonly set: WaitHandle<TKey, TArg>[],
    private readonly predicate: (arg: TArg) => boolean,
    options?: WaitOptions
  ) {
    this.expires = Date.now() + (options?.timeout ?? 3000);
    this.cancelOnError = options?.cancelOnError === true;
    this.promise = new Promise<TArg>((resolve, reject) => {
      this.resolve = resolve;
      this.rejectFn = reject;
    });
    set.push(this);
  }

  eval(arg: TArg): void {
    try {
      if (this.predicate(arg)) {
        this.remove();
        this.resolve(arg);
      }
    } catch (cause) {
      this.reject('predicate error', cause);
    }
  }

  tick(now: number): void {
    if (now >= this.expires) this.reject('timed-out.');
  }

  cancel(cause?: unknown): void {
    this.reject('cancelled', cause);
  }

  private reject(message: string, cause?: unknown): void {
    this.remove();
    this.rejectFn(new Error(`StorageTriggerOrchestrator WaitHandle: ${message}`, { cause }));
  }

  private remove(): void {
    const index = this.set.indexOf(this);
    if (index >= 0) this.set.splice(index, 1);
  }
}

export class StorageTriggerOrchestrator<TKey extends TriggerKey> {
  private _epoch = 0;
  private _suspended = false;
  private interrupt: ReturnType<typeof setInterval> | undefined;
  private readonly stubs = new Map<TKey, TriggerStub<TKey>>();
  private readonly errorWatchers = new Map<symbol, StorageTriggerErrorWatcher<TKey>>();
  private unsubLifecycle: (() => void) | undefined;

  constructor(
    ctrl: StorageController,
    register: (registrar: StorageTriggerRegistrar<TKey>) => void
  ) {
    this.unsubLifecycle = ctrl.watchLifecycle((arg) => {
      switch (arg.type) {
        case 'reset':
          this._epoch = arg.epoch;
          break;
        case 'delete':
          this.dispose();
          break;
      }
    });

    const inScope = (arg: StorageChangeRecord) =>
      !this.isDisposed && arg.epoch === this._epoch;

    const addStub = <THandler extends InternalHandler>(
      key: TKey,
      handler: THandler,
      regFn: (
        ctrl: StorageController,
        handler: THandler,
        options?: RegisterStorageTriggerOptions
      ) => () => void
    ) => {
      if (this.stubs.has(key)) {
        throw new Error(`Duplicate trigger key "${key}".`);
      }
      let unsub: (() => void) | undefined;
      const stub: TriggerStub<TKey> = {
        key,
        get active() {
          return unsub != undefined;
        },
        sub: () => {
          if (unsub) return;
          unsub = regFn(ctrl, handler, {
            predicate: (arg) => !this._suspended && inScope(arg),
            onBefore: (arg) => {
              if (inScope(arg)) this.onBefore(stub, arg);
            },
            onAfter: (arg) => {
              if (inScope(arg)) this.onAfter(stub, arg);
            },
            onError: (arg) => {
              if (inScope(arg.arg)) this.onError(stub, arg);
            },
          });
        },
        unsub: () => {
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
      this.stubs.set(key, stub);
    };

    register({
      v1: (key, handler) => addStub(key, handler, registerTriggerV1),
      v2: (key, handler) => addStub(key, handler, registerTriggerV2),
    });
    this._epoch = ctrl.epoch;
    this.all(true);
  }

  get epoch(): number {
    return this._epoch;
  }

  get suspended(): boolean {
    return this._suspended;
  }

  set suspended(value: boolean) {
    this._suspended = !!value;
  }

  get isDisposed(): boolean {
    return this.unsubLifecycle == undefined;
  }

  dispose(): void {
    if (!this.unsubLifecycle) return;
    this.detach();
    this._epoch = Number.MIN_SAFE_INTEGER;
    this.unsubLifecycle();
    this.unsubLifecycle = undefined;
  }

  all(enable: boolean): void {
    this.assertNotDisposed();
    const keys = [...this.stubs.keys()];
    if (enable) this.enable(...keys);
    else this.disable(...keys);
  }

  enable(...keys: TKey[]): void {
    this.assertNotDisposed();
    keys.forEach((key) => {
      const stub = this.requireStub(key);
      if (!stub.active) stub.sub();
    });
  }

  disable(...keys: TKey[]): void {
    this.assertNotDisposed();
    keys.forEach((key) => {
      const stub = this.requireStub(key);
      if (stub.active) stub.unsub();
    });
  }

  isEnabled(key: TKey): boolean {
    this.assertNotDisposed();
    return this.stubs.get(key)?.active === true;
  }

  getStats(key: TKey): StorageTriggerStats<TKey> {
    this.assertNotDisposed();
    const stats = this.stubs.get(key)?.stats ?? {
      initiatedCount: 0,
      completedCount: 0,
      errorCount: 0,
    };
    return Object.freeze({ key, ...stats });
  }

  observe(key: TKey, observer: StorageTriggerObserver<TKey>): () => void {
    this.assertNotDisposed();
    const stub = this.requireStub(key);
    stub.observers.push(observer);
    return () => {
      const index = stub.observers.indexOf(observer);
      if (index >= 0) stub.observers.splice(index, 1);
    };
  }

  on(
    key: TKey,
    callback: (arg: StorageOrchestratorEventArg<TKey>) => void
  ): () => void {
    return this.observe(key, { after: callback });
  }

  observeAll(observer: StorageTriggerObserver<TKey>): () => void {
    this.assertNotDisposed();
    const unsubs = [...this.stubs.keys()].map((key) => this.observe(key, observer));
    return () => unsubs.forEach((fn) => fn());
  }

  onAll(
    callback: (arg: StorageOrchestratorEventArg<TKey>) => void
  ): () => void {
    return this.observeAll({ after: callback });
  }

  watchErrors(callback: StorageTriggerErrorWatcher<TKey>): () => void {
    this.assertNotDisposed();
    const id = Symbol();
    this.errorWatchers.set(id, callback);
    return () => {
      this.errorWatchers.delete(id);
    };
  }

  wait(
    key: TKey,
    predicate: (arg: StorageOrchestratorEventArg<TKey>) => boolean,
    options?: WaitOptions
  ): Promise<StorageOrchestratorEventArg<TKey>> {
    return this.registerWaitHandle(key, predicate, (stub) => stub.waitHandles, options);
  }

  waitOne(
    key: TKey,
    options?: WaitOptions
  ): Promise<StorageOrchestratorEventArg<TKey>> {
    return this.wait(key, () => true, options);
  }

  waitError(
    key: TKey,
    predicate: (arg: StorageOrchestratorErrorEventArg<TKey>) => boolean,
    options?: WaitErrorOptions
  ): Promise<StorageOrchestratorErrorEventArg<TKey>> {
    return this.registerWaitHandle(
      key,
      predicate,
      (stub) => stub.errorWaitHandles,
      options
    );
  }

  waitOneError(
    key: TKey,
    options?: WaitErrorOptions
  ): Promise<StorageOrchestratorErrorEventArg<TKey>> {
    return this.waitError(key, () => true, options);
  }

  attach(): void {
    this.all(true);
  }

  detach(): void {
    if (this.isDisposed) return;
    this.clearInterrupt();
    this.stubs.forEach((stub) => {
      stub.observers.length = 0;
      stub.unsub();
      for (const waiter of [...stub.waitHandles]) waiter.cancel();
      for (const waiter of [...stub.errorWaitHandles]) waiter.cancel();
    });
  }

  reset(): void {
    if (this.isDisposed) return;
    this.detach();
    this.stubs.forEach((stub) => {
      stub.stats.initiatedCount = 0;
      stub.stats.completedCount = 0;
      stub.stats.errorCount = 0;
      stub.sub();
    });
  }

  private registerWaitHandle<TArg>(
    key: TKey,
    predicate: (arg: TArg) => boolean,
    setResolver: (stub: TriggerStub<TKey>) => WaitHandle<TKey, TArg>[],
    options?: WaitOptions
  ): Promise<TArg> {
    this.assertNotDisposed();
    const stub = this.requireStub(key);
    const waiter = new WaitHandle(setResolver(stub), predicate, options);
    this.ensureInterrupt();
    return waiter.promise;
  }

  private ensureInterrupt(): void {
    if (this.interrupt) return;
    this.interrupt = setInterval(() => {
      const now = Date.now();
      let count = 0;
      this.stubs.forEach((stub) => {
        for (const waiter of [...stub.waitHandles]) waiter.tick(now);
        for (const waiter of [...stub.errorWaitHandles]) waiter.tick(now);
        count += stub.waitHandles.length + stub.errorWaitHandles.length;
      });
      if (count === 0) this.clearInterrupt();
    }, 5);
    this.interrupt.unref?.();
  }

  private clearInterrupt(): void {
    if (this.interrupt) {
      clearInterval(this.interrupt);
      this.interrupt = undefined;
    }
  }

  private onBefore(stub: TriggerStub<TKey>, arg: StorageChangeRecord): void {
    stub.stats.initiatedCount += 1;
    this.executeObservers(StorageTriggerErrorOrigin.OnBefore, stub, arg, 'before');
  }

  private onAfter(stub: TriggerStub<TKey>, arg: StorageChangeRecord): void {
    stub.stats.completedCount += 1;
    this.executeObservers(StorageTriggerErrorOrigin.OnAfter, stub, arg, 'after');
    const eventArg = makeEventArg(stub, arg);
    for (const waiter of [...stub.waitHandles]) waiter.eval(eventArg);
  }

  private onError(
    stub: TriggerStub<TKey>,
    arg: StorageTriggerRunnerErrorEventArg
  ): void {
    stub.stats.errorCount += 1;
    const eventArg = makeEventArg(stub, arg.arg);
    const errorArg = makeErrorEventArg(arg.origin, eventArg, arg.cause);
    this.executeObservers(arg.origin, stub, arg.arg, 'error', arg.cause);
    for (const waiter of [...stub.waitHandles]) {
      if (waiter.cancelOnError) waiter.cancel(arg.cause);
    }
    for (const waiter of [...stub.errorWaitHandles]) waiter.eval(errorArg);
    this.raiseGlobalError(errorArg);
  }

  private executeObservers(
    origin: StorageTriggerErrorOrigin,
    stub: TriggerStub<TKey>,
    arg: StorageChangeRecord,
    phase: 'before' | 'after' | 'error',
    cause?: unknown
  ): void {
    if (!stub.observers.length) return;
    const base = makeEventArg(stub, arg);
    const errorArg = cause == undefined ? undefined : makeErrorEventArg(origin, base, cause);
    for (const observer of [...stub.observers]) {
      try {
        if (phase === 'error') observer.error?.(errorArg as StorageOrchestratorErrorEventArg<TKey>);
        else observer[phase]?.(base);
      } catch (observerCause) {
        this.raiseGlobalError(makeErrorEventArg(origin, base, observerCause));
      }
    }
  }

  private raiseGlobalError(arg: StorageOrchestratorErrorEventArg<TKey>): void {
    this.errorWatchers.forEach((watcher) => {
      try {
        watcher(arg);
      } catch {
        // Do not let watcher failures produce loops.
      }
    });
  }

  private requireStub(key: TKey): TriggerStub<TKey> {
    const stub = this.stubs.get(key);
    if (!stub) throw new Error(`No trigger handler associated with the key "${key}" is registered.`);
    return stub;
  }

  private assertNotDisposed(): void {
    if (this.isDisposed) throw new Error('Object disposed.');
  }
}

function makeEventArg<TKey extends TriggerKey>(
  stub: TriggerStub<TKey>,
  arg: StorageChangeRecord
): StorageOrchestratorEventArg<TKey> {
  return Object.freeze({
    key: stub.key,
    ...arg,
    ...stub.stats,
  });
}

function makeErrorEventArg<TKey extends TriggerKey>(
  origin: StorageTriggerErrorOrigin,
  arg: StorageOrchestratorEventArg<TKey>,
  cause: unknown
): StorageOrchestratorErrorEventArg<TKey> {
  return Object.freeze({
    ...arg,
    origin,
    cause,
  });
}

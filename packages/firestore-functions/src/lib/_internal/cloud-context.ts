import { FirestoreController } from '@firebase-bridge/firestore-admin';
import * as async_hooks from 'node:async_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Union of environment variable keys that are commonly present inside a
 * Google Cloud / Firebase Functions process.
 *
 * @remarks
 * The {@link CloudContext} helper will set/unset these keys on
 * {@link NodeJS.ProcessEnv} (`process.env`) to simulate a production-like
 * Functions environment while running unit/integration tests in-process.
 *
 * @see {@link ENV_KEYS}
 */
type EnvKey = 'GOOGLE_CLOUD_PROJECT' | 'GCLOUD_PROJECT' | 'FIREBASE_CONFIG';

/**
 * Ordered list of {@link EnvKey} names used when applying environment updates.
 *
 * @remarks
 * Iteration is performed by key name (not array index) to guarantee stable,
 * explicit semantics when assigning/deleting values on `process.env`.
 */
const ENV_KEYS: readonly EnvKey[] = [
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'FIREBASE_CONFIG',
] as const;

// ---------------------------------------------------------------------------
// Reserved (future) extension points — intentionally kept commented-out
// ---------------------------------------------------------------------------

/**
 * Callback hooks that may be exposed in a future revision to observe the
 * lifecycle of the Cloud Functions simulation.
 *
 * @remarks
 * Retained (commented-out) so that re-enabling these hooks later
 * does not require readers to rediscover intended semantics.
 */
// export interface CloudContextOptions {
//   /** Invoked once after the AsyncLocalStorage (ALS) is initialized. */
//   onInit?: () => void;
//   /** Invoked immediately after an async resource yields back to this context. */
//   onSuspend?: () => void;
//   /** Invoked immediately before an async resource runs within this context. */
//   onResume?: () => void;
//   /** Invoked when an async resource is destroyed or a promise resolves. */
//   onFinalize?: () => void;
// }

/**
 * Internal frame carried by {@link AsyncLocalStorage} that captures the
 * environment variable values (and, in a future revision, optional hooks)
 * for the active Cloud Functions simulation.
 */
interface ContextFrame {
  /** Snapshot of environment variables to apply while the frame is active. */
  values: Record<EnvKey, string | undefined>;
  // onSuspend?: () => void;
  // onResume?: () => void;
  // onFinalize?: () => void;
}

/**
 * Simulates a minimal Google Cloud / Firebase Functions environment
 * by projecting controller-scoped metadata into `process.env` for the
 * duration of a synchronous or asynchronous run function.
 *
 * @remarks
 * - **What it does:**
 *   Uses Node’s {@link AsyncLocalStorage} with an {@link async_hooks} hook
 *   to apply/restore a set of environment variables (`GOOGLE_CLOUD_PROJECT`,
 *   `GCLOUD_PROJECT`, `FIREBASE_CONFIG`) whenever execution enters the stored
 *   async context. This mirrors how Cloud Functions exposes project/database
 *   configuration to handlers at runtime.
 *
 * - **Why ALS:**
 *   ALS scopes the environment to the current async “continuation,” so nested
 *   tasks (promises, timers, I/O callbacks) inherit the same env without
 *   leaking into unrelated test cases.
 *
 * - **Global side-effects:**
 *   This class **does mutate** `process.env` while code runs inside the ALS
 *   context. Values are reassigned on every `before` callback and deleted if
 *   undefined. Keep runs isolated per test to avoid cross-test interference.
 *
 * - **Single instance:**
 *   A private singleton is used to install the `async_hooks` hook once.
 *
 * @example
 * ```ts
 * const env = new FirestoreMock();
 * const ctrl = env.createDatabase(); // has projectId/databaseId
 *
 * const result = CloudContext.start(ctrl, () => {
 *   // Inside this function (and any awaited async work),
 *   // process.env.GOOGLE_CLOUD_PROJECT and process.env.FIREBASE_CONFIG
 *   // are populated to mimic a Functions environment.
 *   return doWorkThatReadsProcessEnv();
 * });
 * ```
 */
export class CloudContext {
  /** Internal singleton used to ensure a single async_hooks installation. */
  private static readonly singleton = new CloudContext();

  /**
   * Runs the provided function within a simulated Cloud Functions environment
   * derived from the given {@link FirestoreController}.
   *
   * @typeParam TResult - Return type of the `run` function. May be a value or a Promise.
   * @param ctrl - The Firestore controller whose `projectId` and `databaseId`
   *   are projected into `process.env`.
   * @param run - The function to execute inside the AsyncLocalStorage context.
   *   Any asynchronous work awaited within `run` inherits the same context.
   * @returns The return value of `run`. If `run` returns a Promise, that
   *   Promise is returned to the caller unchanged.
   *
   * @remarks
   * The environment variables set are:
   * - `GOOGLE_CLOUD_PROJECT` = `ctrl.projectId`
   * - `GCLOUD_PROJECT` = `ctrl.projectId`
   * - `FIREBASE_CONFIG` = JSON string containing `{ projectId, databaseId }`
   *
   * The commented‐out `options` parameter is retained for a future revision
   * that may surface lifecycle callbacks (init/suspend/resume/finalize).
   */
  static start<TResult = unknown>(
    ctrl: FirestoreController,
    run: () => TResult
    // options?: CloudContextOptions
  ): TResult {
    const context = CloudContext.singleton;
    context.ensureALS();
    const frame = context.initialize(ctrl);
    // options?.onInit?.();

    return context._als.run(frame, run);
  }

  /** Tracks whether AsyncLocalStorage + async_hooks have been initialized. */
  private _initialized = false;

  /** AsyncLocalStorage carrying the active {@link ContextFrame}. */
  private readonly _als = new AsyncLocalStorage<ContextFrame>();

  /** @internal Use {@link CloudContext.start} instead. */
  private constructor() {
    // noop
  }

  /**
   * Ensures the AsyncLocalStorage instance is paired with an active
   * {@link async_hooks} hook that reapplies the current frame’s environment
   * before each async resource callback.
   *
   * @remarks
   * This is idempotent and safe to call multiple times; the hook is installed
   * only once per process.
   */
  private ensureALS(): void {
    if (this._initialized) return;
    this._initialized = true;

    // const finalize = () => {
    //   const frame = this._als.getStore();
    //   if (frame) {
    //     frame.onFinalize?.();
    //   }
    // };

    async_hooks
      .createHook({
        /**
         * Reapply the frame’s environment before an async callback executes,
         * ensuring `process.env` reflects the intended Cloud Functions context.
         */
        before: () => {
          const frame = this._als.getStore();
          if (frame) {
            this.apply(frame.values);
            // frame.onResume?.();
          }
        },
        // after: () => {
        //   const frame = this._als.getStore();
        //   frame?.onSuspend?.();
        // },
        // destroy: finalize,
        // promiseResolve: finalize,
      })
      .enable();
  }

  /**
   * Creates a new {@link ContextFrame} for the supplied controller and applies
   * its environment immediately to the current process.
   *
   * @param ctrl - The Firestore controller providing `projectId` and `databaseId`.
   * @returns The initialized {@link ContextFrame} to be stored in ALS.
   */
  private initialize(
    ctrl: FirestoreController
    // options?: CloudContextOptions
  ): ContextFrame {
    const projectId = ctrl.projectId;
    const databaseId = ctrl.databaseId;

    const frame: ContextFrame = {
      values: {
        GOOGLE_CLOUD_PROJECT: projectId,
        GCLOUD_PROJECT: projectId,
        FIREBASE_CONFIG: JSON.stringify({ projectId, databaseId }),
      },
      // onSuspend: options?.onSuspend,
      // onResume: options?.onResume,
      // onFinalize: options?.onFinalize,
    };

    this.apply(frame.values);

    return frame;
  }

  /**
   * Applies the provided environment map to `process.env`, assigning each
   * {@link EnvKey} when defined and deleting it when `undefined` or `null`.
   *
   * @param values - Map of environment variable values keyed by {@link EnvKey}.
   *
   * @remarks
   * The keys are applied in {@link ENV_KEYS} order for consistency. Deleting
   * unassigned keys helps prevent stale configuration from leaking across
   * isolated test runs.
   */
  private apply(values: Record<EnvKey, string | undefined>): void {
    // IMPORTANT: iterate values by key name, not by index
    for (const key of ENV_KEYS) {
      const value = values[key];
      if (value != null) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

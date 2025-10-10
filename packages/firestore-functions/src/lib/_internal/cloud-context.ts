import { FirestoreController } from '@firebase-bridge/firestore-admin';
import * as async_hooks from 'node:async_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';

type EnvKey = 'GOOGLE_CLOUD_PROJECT' | 'GCLOUD_PROJECT' | 'FIREBASE_CONFIG';
const ENV_KEYS: readonly EnvKey[] = [
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'FIREBASE_CONFIG',
] as const;

// export interface CloudContextOptions {
//   onInit?: () => void;
//   onSuspend?: () => void;
//   onResume?: () => void;
//   onFinalize?: () => void;
// }

interface ContextFrame {
  values: Record<EnvKey, string | undefined>;
  // onSuspend?: () => void;
  // onResume?: () => void;
  // onFinalize?: () => void;
}

export class CloudContext {
  private static readonly singleton = new CloudContext();

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

  private _initialized = false;
  private readonly _als = new AsyncLocalStorage<ContextFrame>();

  private constructor() {
    // noop
  }

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

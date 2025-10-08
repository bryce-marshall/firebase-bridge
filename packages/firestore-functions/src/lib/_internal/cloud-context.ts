import { FirestoreController } from '@firebase-bridge/firestore-admin';

type EnvKey = 'GOOGLE_CLOUD_PROJECT' | 'GCLOUD_PROJECT' | 'FIREBASE_CONFIG';
const ENV_KEYS: readonly EnvKey[] = [
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'FIREBASE_CONFIG',
] as const;

interface ContextFrame {
  sequence: number;
  prevSequence: number; // kept for potential future lineage uses
  values: Record<EnvKey, string | undefined>;
}

const VOID_SEQUENCE = -1;

/**
 * Process-global coordinator for a minimal "Cloud Functions-like" environment.
 *
 * Semantics:
 * - Each `start()` call pushes a "frame" with a monotonically increasing sequence.
 * - The **active owner** is the frame with the highest sequence that is still active.
 * - When a frame finalizes:
 *    - If it is **not** the active owner, do nothing (a later frame owns the env).
 *    - If it **is** the active owner, switch env to the next-latest active frame
 *      (highest remaining sequence). If none remain, clear env.
 *
 * This provides deterministic behavior under nesting and overlap without locks.
 */
export class CloudContext {
  private static readonly singleton = new CloudContext();

  static start<T>(ctx: FirestoreController, run: () => T): T {
    return CloudContext.singleton.run(ctx, run);
  }

  private _sequence = 0;
  private _activeSequence = VOID_SEQUENCE;
  private readonly _frames = new Map<number, ContextFrame>();

  private constructor() {
    // noop
  }

  private run<T>(ctx: FirestoreController, run: () => T): T {
    const sequence = this.initialize(ctx);

    try {
      const out = run() as Promise<unknown> | unknown;
      // Promise-aware finalizer in case run() is async
      if (out && typeof (out as Promise<unknown>).finally === 'function') {
        (out as Promise<unknown>).finally(() => this.finalize(sequence));
      } else {
        this.finalize(sequence);
      }
      return out as T;
    } catch (e) {
      this.finalize(sequence);
      throw e;
    }
  }

  private initialize(ctx: FirestoreController): number {
    const sequence = this._sequence++;
    const projectId = ctx.projectId;
    const databaseId = ctx.databaseId;

    const frame: ContextFrame = {
      sequence,
      prevSequence: this._activeSequence,
      values: {
        GOOGLE_CLOUD_PROJECT: projectId,
        GCLOUD_PROJECT: projectId,
        FIREBASE_CONFIG: JSON.stringify({ projectId, databaseId }),
      },
    };

    this._frames.set(sequence, frame);
    this.apply(sequence, frame.values);
    return sequence;
  }
  private finalize(sequence: number): void {
    // Remove the finishing frame
    const frame = this._frames.get(sequence);
    this._frames.delete(sequence);

    // Nothing left: clear env
    if (this._frames.size === 0) {
      this.clear();
      return;
    }

    // If this frame isn't the active owner, do nothing
    if (this._activeSequence !== sequence) {
      return;
    }

    // 1) Try nearest surviving ancestor chain
    const pickAncestor = (start: number): ContextFrame | undefined => {
      let seq = this._frames.get(start)?.sequence ?? start; // normalize if start already removed
      while (seq !== VOID_SEQUENCE) {
        const candidate = this._frames.get(seq);
        if (candidate) return candidate; // found a surviving ancestor
        // walk to the next ancestor using the original (now-removed) frame's lineage
        const prev =
          (seq === sequence
            ? frame?.prevSequence
            : this._frames.get(seq)?.prevSequence) ?? VOID_SEQUENCE;
        seq = prev;
      }
      return undefined;
    };

    let next = frame ? pickAncestor(frame.prevSequence) : undefined;

    // 2) Fallback to latest remaining (highest sequence) if no ancestor survives
    if (!next) {
      let nextSeq = VOID_SEQUENCE;
      for (const s of this._frames.keys()) {
        if (s > nextSeq) nextSeq = s;
      }
      next = this._frames.get(nextSeq) as ContextFrame;
    }

    this.apply(next.sequence, next.values);
  }

  private clear(): void {
    this.apply(VOID_SEQUENCE, {} as Record<EnvKey, string | undefined>);
  }

  private apply(
    sequence: number,
    values: Record<EnvKey, string | undefined>
  ): void {
    this._activeSequence = sequence;

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

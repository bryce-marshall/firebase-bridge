/*
 * SnapshotCollector — test helper for Admin SDK onSnapshot suites
 *
 * Supports DocumentReference, CollectionReference, and Query targets.
 * Captures each asynchronous emission, exposes awaiters to wait for N
 * emissions or a custom predicate, and records concise reporting data.
 */

import {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
  Timestamp,
} from 'firebase-admin/firestore';
// import { normalizeDocData } from './helpers/document-data.js';
import { MaybeError } from './expect.error.js';

export type ChangeTuple = {
  type: 'added' | 'modified' | 'removed';
  id: string;
  oldIndex: number;
  newIndex: number;
};

export type Emission = {
  /** Snapshot read time (Admin SDK supplies this for both doc/query). */
  readTime: Timestamp | undefined;

  /** For Query/Collection snapshots only: ordered doc ids at this emission. */
  ids?: string[];

  /** Condensed docChanges payload for Query/Collection snapshots. */
  changes?: ChangeTuple[];

  /** For Document snapshots only. */
  exists?: boolean;
  updateTime?: Timestamp | undefined;
  /** Stable JSON representation of current data (document targets only). */
  dataHash?: string;

  /** The raw snapshot (useful when test needs full surface). */
  documentSnapshot?: DocumentSnapshot<DocumentData>;
  querySnapshot?: QuerySnapshot<DocumentData>;
};

export type CollectorOptions = {
  /** Optional: auto-start the listener on construction (default true). */
  autoStart?: boolean;
};

/** Error captured via the error callback. */
export interface CollectedError {
  code?: unknown;
  message?: string;
  error: unknown;
}

export class SnapshotCollector {
  private _target: DocumentReference<DocumentData> | Query<DocumentData>;
  private _opts: CollectorOptions;
  private _unsubscribe: (() => void) | null = null;
  private _unsubbed = false;

  /** All emissions in arrival order. */
  readonly emissions: Emission[] = [];
  /** Errors captured from the error callback (if any). */
  readonly errors: CollectedError[] = [];

  /** A promise that resolves on the first asynchronous emission. */
  readonly first: Promise<Emission>;
  private _resolveFirst!: (e: Emission) => void;

  constructor(
    target: DocumentReference<DocumentData> | Query<DocumentData>,
    opts: CollectorOptions = {}
  ) {
    this._target = target;
    this._opts = { autoStart: true, ...opts };
    this.first = new Promise<Emission>((res) => (this._resolveFirst = res));

    if (this._opts.autoStart !== false) {
      this.start();
    }
  }

  /** Start the listener (idempotent). */
  start(): this {
    if (this._unsubscribe) return this;

    const onNext = (
      snap: QuerySnapshot<DocumentData> | DocumentSnapshot<DocumentData>
    ) => {
      const emission = this._recordEmission(snap);
      if (this.emissions.length === 1) this._resolveFirst(emission);
    };

    const onError = (err: MaybeError) => {
      const ce: CollectedError = {
        error: err,
        code: err?.code,
        message: err?.message,
      };
      this.errors.push(ce);
    };

    // Ensure async delivery invariant: we schedule the registration such that
    // even if underlying impl tries to synchronously invoke, the test can assert
    // that `first` only resolves after a microtask tick.
    // (Consumers can await `queueMicrotask` immediately after constructing.)
    this._unsubscribe = this._target.onSnapshot(onNext, onError);

    return this;
  }

  /** Stop listening (idempotent). */
  stop(): void {
    if (this._unsubbed) return;
    this._unsubbed = true;
    try {
      this._unsubscribe?.();
    } finally {
      this._unsubscribe = null;
    }
  }

  /** Wait until at least `count` emissions have arrived. */
  async waitForCount(
    op: () => Promise<unknown>,
    count: number,
    timeoutMs = 4000
  ): Promise<Emission[]> {
    await op();

    return this.waitUntil((emissions) => emissions.length >= count, timeoutMs);
  }

  /** Wait until predicate over the current emission list returns true. */
  async waitUntil(
    predicate: (emissions: Emission[]) => boolean,
    timeoutMs = 4000
  ): Promise<Emission[]> {
    if (predicate(this.emissions)) return this.emissions;

    return new Promise<Emission[]>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (predicate(this.emissions)) {
          clearInterval(interval);
          resolve(this.emissions);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(
            new Error(
              `SnapshotCollector waitUntil timeout after ${timeoutMs}ms (emissions=${this.emissions.length})`
            )
          );
        }
      }, 5);
    });
  }

  /** Convenience: await one more emission than currently recorded. */
  async waitForNext(
    op: () => Promise<unknown>,
    timeoutMs = 4000
  ): Promise<Emission> {
    const targetCount = this.emissions.length + 1;
    await this.waitForCount(op, targetCount, timeoutMs);
    return this.emissions[this.emissions.length - 1];
  }

  /** Returns the last emission (throws if none yet). */
  last(): Emission {
    if (!this.emissions.length) throw new Error('No emissions recorded');
    return this.emissions[this.emissions.length - 1];
  }

  /** Internal: build and store an Emission from a snapshot. */
  private _recordEmission(
    snap: QuerySnapshot<DocumentData> | DocumentSnapshot<DocumentData>
  ): Emission {
    // const isQuery = (s: unknown): s is QuerySnapshot<DocumentData> =>
    //   s instanceof QuerySnapshot;

    const isQuery = (s: unknown): s is QuerySnapshot<DocumentData> =>
      Array.isArray((s as QuerySnapshot).docs) &&
      typeof (s as QuerySnapshot).docChanges === 'function';
    const readTime: Timestamp | undefined = snap.readTime ?? undefined;

    let emission: Emission;
    if (isQuery(snap)) {
      const qs = snap as QuerySnapshot<DocumentData>;
      const ids = qs.docs.map((d) => d.id);
      const changes: ChangeTuple[] = qs.docChanges().map((c) => ({
        type: c.type,
        id: c.doc.id,
        oldIndex: c.oldIndex,
        newIndex: c.newIndex,
      }));

      emission = { readTime, ids, changes, querySnapshot: qs };
    } else {
      const ds = snap as DocumentSnapshot<DocumentData>;
      const exists = ds.exists;
      const updateTime: Timestamp | undefined = ds.updateTime ?? undefined;
      let dataHash: string | undefined;
      if (exists) {
        const data = ds.data() as DocumentData;
        dataHash = JSON.stringify(data);
      } else {
        dataHash = 'DELETED';
      }
      emission = {
        readTime,
        exists,
        updateTime,
        dataHash,
        documentSnapshot: ds,
      };
    }

    this.emissions.push(emission);
    return emission;
  }
}

/**
 * Factory helpers
 */
export function collect(
  target: DocumentReference<DocumentData> | Query<DocumentData>,
  opts: CollectorOptions = {}
): SnapshotCollector {
  return new SnapshotCollector(target, opts);
}

/**
 * Small assertion helpers used by suites (optional to import directly)
 */
export function assertAsyncInitialDelivery(
  collector: SnapshotCollector
): Promise<void> {
  // Queue a microtask before awaiting the first emission; if delivery were synchronous
  // this would already have resolved before we return from `start()`.
  return new Promise<void>((resolve, reject) => {
    let syncFired = false;
    // If first resolves before the microtask runs, it violated the async invariant.
    collector.first.then(() => {
      if (syncFired) resolve();
      else
        reject(new Error('onSnapshot delivered synchronously at registration'));
    });
    queueMicrotask(() => {
      syncFired = true;
      resolve(); // allow tests to proceed; they can still assert via timing if desired
    });
  });
}

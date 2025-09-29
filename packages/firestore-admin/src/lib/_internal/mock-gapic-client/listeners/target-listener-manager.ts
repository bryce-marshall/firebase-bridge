import type { google } from '@gcf/firestore-protos';
import { Timestamp } from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { DataChangeEventArg } from '../../data-accessor.js';
import { googleError } from '../../functions/google-error.js';
import { GapicContext } from '../gapic-context.js';
import { StreamEndpoint } from '../stream-endpoint.js';
import { DocumentTargetListener } from './document-target-listener.js';
import { QueryTargetListener } from './query-target-listener.js';
import { TargetListener } from './target-listener.js';
import { TargetWriter } from './target-writer.js';

/**
 * Manages all active listen targets for a single stream and orchestrates
 * GAPIC listen messages (TargetChange/DocumentChange) for those targets.
 *
 * Responsibilities:
 * - Accepts IListenRequest writes (`addTarget` / `removeTarget`) from the client.
 * - Enforces Firestore target-id rules (server-assigned vs client-assigned).
 * - Subscribes to datastore change notifications and fans them out to targets.
 * - Tracks per-target consistency and emits global `NO_CHANGE` watermarks
 *   (empty `targetIds`) when all targets are consistent at a new read time.
 *
 * Protocol notes:
 * - A TargetChange with **empty** `targetIds` communicates that **all** active
 *   targets on the stream are now consistent at its `readTime`.
 * - When a client first uses `targetId=0` (server-assigned), **all subsequent
 *   targets on the same stream must also use `targetId=0`**. If not, the server
 *   should immediately send a `TargetChange::REMOVE` for that target.
 */
export class TargetListenerManager extends StreamEndpoint<google.firestore.v1.IListenRequest> {
  /** Unsubscribe callback for datastore reset notifications. */
  private _resetSub: () => void;
  /** Unsubscribe callback for per-commit change notifications. */
  private _changeSub?: () => void;
  /** Writer that emits listen responses onto this stream's duplex. */
  private readonly _writer: TargetWriter;
  /** Active targets keyed by `targetId`. */
  private readonly _listeners = new Map<number, TargetListener>();
  /**
   * Snapshot of last observed consistency version per target. When a target's
   * internal `consistencyVersion` advances beyond the stored value, it is not
   * yet "accounted for" in the global consistency check.
   */
  private readonly _consistency = new Map<number, number>();
  /** Pending debounce handle for global consistency checks. */
  private _checkHandle: NodeJS.Timeout | undefined;
  /**
   * The last `readTime` emitted via a global `NO_CHANGE` TargetChange
   * (with empty `targetIds`). Indicates the most recent "all targets consistent"
   * watermark seen by the client.
   */
  private _lastGlobalReadTime = Timestamp.fromMillis(0);
  /** The last atomic change batch delivered by the datastore. */
  private _lastChange!: DataChangeEventArg;

  /**
   * Used to enforce server-assigned target-id rules:
   * - Once a target is added with `targetId=0`, all subsequent targets must
   *   also use `targetId=0` (server assigns ids). If a later `addTarget` supplies
   *   a non-zero id, a `TargetChange::REMOVE` should be sent for that request.
   */
  private _requireZeroId = false;
  /** Monotonic counter used to generate unique server-assigned target ids. */
  private _nextTargetId = 0;

  /**
   * @param context GAPIC context providing serializer, accessors, and path utils.
   *
   * Subscribes to datastore reset/change notifications and initializes
   * internal state for target management.
   */
  constructor(readonly context: GapicContext) {
    super();
    this._writer = new TargetWriter(context, this.duplex);
    this._resetSub = this.context.getAccessor().registerResetListener(() => {
      this.init();
    });
    this.init();
  }

  /**
   * Closes the stream and releases all listeners and scheduled tasks.
   *
   * - Unsubscribes from reset and change watchers.
   * - Cancels any pending consistency check.
   * - Delegates to {@link StreamEndpoint.close} for duplex teardown.
   */
  override close(): Promise<void> {
    this._resetSub();
    this._changeSub?.();
    if (this._checkHandle) {
      clearTimeout(this._checkHandle);
      this._checkHandle = undefined;
    }

    return super.close();
  }

  /**
   * Schedules a short-delay check to determine whether **all** active targets
   * are now consistent at a strictly newer `readTime`. If so, emits a global
   * `TargetChange{ NO_CHANGE, targetIds: [] }` with that `readTime`.
   *
   * Implementation details:
   * - Debounced with a small delay to coalesce rapid batches.
   * - Consistency is determined by comparing each listener’s current
   *   `consistencyVersion` with the last recorded version in `_consistency`.
   * - The emitted `readTime` is the max of all listeners’ `lastReadTime`.
   */
  markForConsistencyCheck(): void {
    const DELAY_MS = 5;
    clearTimeout(this._checkHandle);

    this._checkHandle = setTimeout(() => {
      this._checkHandle = undefined;
      let consistent = true;
      const prevReadTime = this._lastGlobalReadTime.toMillis();
      let readTime = prevReadTime;

      for (const l of this._listeners.values()) {
        consistent = this._consistency.get(l.targetId) !== l.consistencyVersion;
        if (!consistent) break;
        const listenerMillis = l.lastReadTime.toMillis();
        if (listenerMillis > readTime) {
          readTime = listenerMillis;
        }
      }
      if (consistent && readTime > prevReadTime) {
        for (const l of this._listeners.values()) {
          this._consistency.set(l.targetId, l.consistencyVersion);
        }
        const ts = Timestamp.fromMillis(readTime);
        this._writer.targetNoChange(ts);
        this._lastGlobalReadTime = ts;
      }
    }, DELAY_MS);
  }

  /**
   * Handles a client write to the listen stream.
   *
   * Exactly one of `addTarget` or `removeTarget` must be present.
   *
   * @param request GAPIC listen request.
   * @throws {GoogleError} {@link Status.INVALID_ARGUMENT} if both or neither are present.
   */
  protected override async onWrite(
    request: google.firestore.v1.IListenRequest
  ): Promise<void> {
    const hasAdd = !!request.addTarget;
    const hasRemove = Number.isFinite(request.removeTarget);

    if (hasAdd && hasRemove) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        'ListenRequest must contain exactly one of addTarget or removeTarget'
      );
    }

    if (hasAdd) {
      await this.handleAdd(request.addTarget as google.firestore.v1.Target);
    } else if (hasRemove) {
      await this.handleRemove(request.removeTarget as number);
    }
  }

  /**
   * Adds a new target (documents or query) to the stream, creating the
   * corresponding {@link TargetListener}, assigning/validating `targetId`,
   * and emitting `TargetChange::ADD`.
   *
   * Enforces server-assigned id rules and rejects invalid target shapes.
   *
   * @param target GAPIC `Target` definition from `addTarget`.
   * @throws {GoogleError} {@link Status.INVALID_ARGUMENT} for invalid ids or empty target.
   * @throws {GoogleError} {@link Status.ALREADY_EXISTS} when reusing an active id.
   */
  private async handleAdd(target: google.firestore.v1.Target): Promise<void> {
    const providedId = target.targetId ?? 0;

    if (!Number.isInteger(providedId) || providedId < 0) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `Invalid targetId ${providedId}.`
      );
    }
    if (providedId === 0) {
      this._requireZeroId = true;
    } else if (this._requireZeroId) {
      this._writer.targetRemove(providedId);
    }

    if (providedId > 0 && this._listeners.has(providedId)) {
      throw googleError(
        Status.ALREADY_EXISTS,
        `The target id ${providedId} is already active on this stream.`
      );
    }
    {
      const isDocTarget = !!target.documents?.documents?.length;
      const isQueryTarget = !!target.query?.structuredQuery;

      if (!isDocTarget && !isQueryTarget) {
        throw googleError(
          Status.INVALID_ARGUMENT,
          'addTarget must specify a non-empty documents.documents[] or a query.structuredQuery.'
        );
      }
      const targetId = providedId > 0 ? providedId : this.nextTargetId();
      let listener: TargetListener;
      if (isDocTarget) {
        listener = new DocumentTargetListener(
          targetId,
          this._writer,
          target.documents as google.firestore.v1.Target.IDocumentsTarget
        );
      } else {
        listener = new QueryTargetListener(
          targetId,
          this._writer,
          this.context,
          target.query as google.firestore.v1.Target.IQueryTarget
        );
      }
      this._listeners.set(targetId, listener);
      this._consistency.set(targetId, 0);
      this._writer.targetAdd(targetId);
      this.initListener(listener);
    }
  }

  /**
   * Re-subscribes to datastore change feed and primes the manager's cached
   * last-change, then processes the change to initialize all current targets.
   *
   * Called on construction and on datastore reset.
   */
  private init(): void {
    this._changeSub?.(); // Already flushed by DataAccessor, but invoke for consistency
    this._changeSub = this.context
      .getAccessor()
      .registerChangeWatcher((arg) => {
        this._lastChange = arg;
        this.onChange();
      });
  }

  /**
   * Runs the initial computation for a listener:
   * - Processes the last known change as an initial batch (isInitial=true).
   * - Schedules a global consistency check.
   *
   * @param listener The newly added target listener.
   */
  private initListener(listener: TargetListener): void {
    listener.processChanges(this.context, this._lastChange, true);
    this.markForConsistencyCheck();
  }

  /**
   * Delivers the most recent atomic change batch to **all** active targets,
   * allowing each to update its snapshot, then schedules a global consistency check.
   *
   * Rationale:
   * The manager—not each target—subscribes to datastore changes so it can
   * coordinate global consistency watermarks across all targets.
   */
  private onChange(): void {
    this._listeners.forEach((l) => {
      l.processChanges(this.context, this._lastChange);
    });
    this.markForConsistencyCheck();
  }

  /**
   * Removes a target from the stream and emits `TargetChange::REMOVE`.
   *
   * @param targetId The id of the target to remove.
   * @throws {GoogleError} {@link Status.NOT_FOUND} if the id is not active.
   */
  private async handleRemove(targetId: number): Promise<void> {
    const listener = this._listeners.get(targetId);
    if (!listener) {
      throw googleError(
        Status.NOT_FOUND,
        `Target ID ${targetId} is not active on this stream`
      );
    }
    this._listeners.delete(targetId);
    this._consistency.delete(targetId);
    this._writer.targetRemove(targetId);
  }

  /**
   * Generates the next available server-assigned `targetId`, skipping any
   * ids currently in use.
   *
   * @returns A unique, positive integer target id.
   */
  private nextTargetId(): number {
    let nextId = ++this._nextTargetId;
    while (this._listeners.has(nextId)) {
      nextId = ++this._nextTargetId;
    }

    return nextId;
  }
}

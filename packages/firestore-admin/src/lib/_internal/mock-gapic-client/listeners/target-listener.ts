import { Timestamp } from 'firebase-admin/firestore';
import {
  DataChangeEventArg,
  MetaDocument,
  MetaDocumentExists,
} from '../../data-accessor.js';
import { GapicContext } from '../gapic-context.js';
import { TargetWriter } from './target-writer.js';

type DocumentPath = string;
type DocumentVersion = number;
/**
 * Sentinel version used for documents that are not present in the local snapshot.
 * When a document is first seen with any positive version, it replaces this value.
 */
const NotExistVersion = 0;

/**
 * Base class for active listen targets (document or query) that:
 * - tracks a target-scoped snapshot of matching documents (path → version),
 * - consumes low-level data change events, and
 * - emits GAPIC listen responses via a {@link TargetWriter}.
 *
 * Subclasses implement {@link onChange} to interpret incoming datastore changes
 * for their specific target type (e.g., a single document vs a structured query),
 * and {@link onUnsubscribe} for cleanup.
 *
 * State machine / semantics:
 * - `processChanges()` is called for each change batch with the authoritative `serverTime`.
 *   It delegates to {@link onChange}, which should call {@link registerDocumentChange} and/or
 *   {@link applyDelta} as appropriate. If any change was observed, the listener increments a
 *   monotonic `consistencyVersion` and emits `TargetChange{CURRENT}` via the writer.
 * - The internal snapshot is a map of document path to *last observed* version. It is only
 *   updated when a newer version arrives, ensuring idempotence across out-of-order signals.
 */
export abstract class TargetListener {
  /**
   * Target-local snapshot: document path → last observed version.
   * Used to compute diffs per change batch.
   */
  private _snapshot: Map<DocumentPath, DocumentVersion> = new Map();
  /**
   * The last server read time applied to this target.
   */
  private _readTime = Timestamp.fromMillis(0);
  /**
   * Tracks whether the current change batch produced any observable change.
   */
  private _wasChanged = false;
  /**
   * A monotonic version incremented whenever a change batch mutates the snapshot.
   * Can be used by callers to detect target consistency progress.
   */
  private _consistencyVersion = NotExistVersion;

  /**
   * @param targetId The GAPIC listen target id.
   * @param writer Stream writer used to emit document and target change messages.
   */
  constructor(
    readonly targetId: number,
    private readonly writer: TargetWriter
  ) {}

  /**
   * Current monotonic consistency version for this target. Increments by 1
   * whenever a processed batch results in any change to the target snapshot.
   */
  get consistencyVersion(): number {
    return this._consistencyVersion;
  }

  /**
   * The last read time applied to this target (from the most recent change batch).
   */
  get lastReadTime(): Timestamp {
    return this._readTime;
  }

  /**
   * Processes a batch of datastore changes for this target.
   *
   * Flow:
   * 1) Marks the batch as "initial" or "incremental".
   * 2) Sets the `lastReadTime` from the batch.
   * 3) Delegates to {@link onChange}, which should update `_snapshot` via
   *    {@link registerDocumentChange} and/or {@link applyDelta}.
   * 4) If any changes occurred, increments `consistencyVersion` and emits a
   *    `TargetChange(CURRENT)` with the batch `serverTime`.
   *
   * @param context Gapic context (serializer/accessors).
   * @param arg The data change batch (contains `serverTime` and change set).
   * @param isInitial Whether this is the initial snapshot computation for the target.
   */
  processChanges(
    context: GapicContext,
    arg: DataChangeEventArg,
    isInitial = false
  ): void {
    this._wasChanged = isInitial;
    this._readTime = arg.serverTime;
    this.onChange(context, arg);
    if (this._wasChanged) {
      this._consistencyVersion += 1;
      this.writer.targetCurrent(this.targetId, arg.serverTime);
    }
  }

  /**
   * Subclass hook to interpret the incoming change batch for this target.
   *
   * Implementations should call {@link registerDocumentChange} for
   * per-document updates, or {@link applyDelta} to reconcile a complete
   * set of current matches (for query targets).
   *
   * @param context Gapic context (serializer/accessors).
   * @param arg The data change batch to process.
   */
  protected abstract onChange(
    context: GapicContext,
    arg: DataChangeEventArg
  ): void;

  /**
   * Hook invoked when the target is unsubscribed.
   * Subclasses should override to perform any needed cleanup (e.g., index detach).
   */
  protected onUnsubscribe(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Registers a single document-level change against the target snapshot and
   * emits the corresponding writer event.
   *
   * Behavior:
   * - For an existing document: only updates the snapshot and emits a change
   *   if the incoming version is strictly greater than the stored version.
   * - For a non-existing document: deletes from the snapshot and emits a delete.
   * - Sets the batch's `_wasChanged` flag when an observable mutation occurs.
   *
   * @param change The meta-document change (exists or not).
   */
  protected registerDocumentChange(change: MetaDocument): void {
    const prevVersion = this._snapshot.get(change.path) ?? NotExistVersion;
    if (change.exists) {
      if (change.version > prevVersion) {
        this._snapshot.set(change.path, change.version);
        this.writer.documentChange(change as MetaDocumentExists, [
          this.targetId,
        ]);
        this._wasChanged = true;
      }
    } else {
      this._snapshot.delete(change.path);
      this.writer.documentDelete(change.path, change.serverTime);
      this._wasChanged = true;
    }
  }

  /**
   * Reconciles the target snapshot against a *complete* set of matching documents
   * computed at the provided `readTime`. Useful for query targets that re-evaluate
   * membership after a datastore change.
   *
   * Behavior:
   * - When `changes` is empty: all previously tracked docs are considered non-matching
   *   and are deleted from the snapshot (emitting deletes).
   * - When `changes` is non-empty: each doc in `changes` is registered (potentially
   *   updating version and emitting a change). Any doc in the snapshot not present
   *   in `changes` is deleted and emitted as a delete.
   *
   * Implementation detail:
   * - The method safely deletes entries from `_snapshot` while iterating its keys.
   *   JavaScript `Map` iteration semantics permit deletions during iteration; only
   *   remaining keys continue to be yielded.
   *
   * @param readTime The read time associated with this reconciliation.
   * @param changes The full set of documents that currently match the target.
   */
  protected applyDelta(
    readTime: Timestamp,
    changes: MetaDocumentExists[]
  ): void {
    const del = (path: string): void => {
      this._snapshot.delete(path);
      this.writer.documentDelete(path, readTime);
      this._wasChanged = true;
    };

    if (changes.length === 0) {
      if (this._snapshot.size) {
        for (const path of this._snapshot.keys()) {
          del(path);
        }
      }
    } else {
      const seen = new Set<string>();

      for (const meta of changes) {
        seen.add(meta.path);
        this.registerDocumentChange(meta); // does a single Map lookup internally
      }

      for (const path of this._snapshot.keys()) {
        if (!seen.has(path)) {
          del(path);
        }
      }
    }
  }
}

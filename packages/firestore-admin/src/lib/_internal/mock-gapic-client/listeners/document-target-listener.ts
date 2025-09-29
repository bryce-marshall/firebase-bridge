import type { google } from '@gcf/firestore-protos';
import { Status } from 'google-gax';
import { DataChangeEventArg } from '../../data-accessor.js';
import { googleError } from '../../functions/google-error.js';
import { dedupeArray } from '../../functions/util.js';
import { GapicContext } from '../gapic-context.js';
import { TargetListener } from './target-listener.js';
import { TargetWriter } from './target-writer.js';

/**
 * Listen target that tracks one or more explicit document paths.
 *
 * Behavior:
 * - Validates that at least one non-empty document path is provided.
 * - Deduplicates document paths while preserving order.
 * - On each change batch, inspects only those documents and applies
 *   per-document updates via {@link TargetListener.registerDocumentChange}.
 *
 * Notes:
 * - This target does not re-evaluate membership; it only mirrors
 *   the state of the addressed documents.
 */
export class DocumentTargetListener extends TargetListener {
  /** Ordered, de-duplicated list of GAPIC document paths for this target. */
  private _docPaths: string[];

  /**
   * @param targetId GAPIC listen target id.
   * @param writer Stream writer used to emit document/target changes.
   * @param target GAPIC `DocumentsTarget` specifying explicit document paths.
   * @throws {GoogleError} {@link Status.INVALID_ARGUMENT}
   *         when no valid document paths are provided.
   */
  constructor(
    targetId: number,
    writer: TargetWriter,
    target: google.firestore.v1.Target.IDocumentsTarget
  ) {
    super(targetId, writer);
    this._docPaths = dedupeArray(target.documents).filter((s) => s.length > 0);
    if (this._docPaths.length === 0) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        'DocumentTargetListener requires at least one document path'
      );
    }
  }

  /**
   * Applies a change batch to this document target.
   *
   * For each declared document path:
   * - Converts the GAPIC path to an internal path.
   * - Looks up any corresponding `MetaDocument` in the batch.
   * - Registers the change via {@link TargetListener.registerDocumentChange}.
   *
   * Snapshot/consistency version updates and CURRENT target signaling are
   * handled by the base {@link TargetListener.processChanges}.
   *
   * @param context Gapic context with path utilities.
   * @param arg Data change batch containing `serverTime` and a map of changes.
   */
  override onChange(context: GapicContext, arg: DataChangeEventArg): void {
    const changes = arg.changes();
    for (const gapicPath of this._docPaths) {
      const internalPath = context.toInternalPath(gapicPath, 'document');
      const meta = changes[internalPath];
      if (meta) {
        this.registerDocumentChange(meta);
      }
    }
  }
}

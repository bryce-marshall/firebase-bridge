import type { google } from '@gcf/firestore-protos';
import { Timestamp } from 'firebase-admin/firestore';
import { Duplex } from 'stream';
import { MetaDocumentExists } from '../../data-accessor.js';
import { toProtoTimestamp } from '../../functions/util.js';
import { GapicContext } from '../gapic-context.js';

/**
 * Emits Firestore Listen API responses onto a stream (Duplex).
 *
 * Responsibilities:
 * - Encodes and pushes {@link google.firestore.v1.IListenResponse} messages
 *   derived from higher-level target/document events.
 * - Normalizes timestamps to proto format and paths to GAPIC resource names.
 *
 * Protocol notes:
 * - `targetIds: []` in a `TargetChange` is a global “watermark”: it announces
 *   that **all active targets** on the stream are consistent at the attached `readTime`.
 */
export class TargetWriter {
  /**
   * @param context - GAPIC context for serialization and path conversion.
   * @param duplex - Stream to push {@link google.firestore.v1.IListenResponse} values onto.
   */
  constructor(
    private readonly context: GapicContext,
    private readonly duplex: Duplex
  ) {}

  /**
   * Emits a `TargetChange{ ADD }` for a specific target.
   *
   * @param targetId - The target identifier being added.
   */
  targetAdd(targetId: number): void {
    this.targetChange('ADD', targetId);
  }

  /**
   * Emits a `TargetChange{ REMOVE }` for a specific target.
   *
   * @param targetId - The target identifier being removed.
   */
  targetRemove(targetId: number): void {
    this.targetChange('REMOVE', targetId);
  }

  /**
   * Emits a `TargetChange{ CURRENT }` indicating the target is in a consistent state.
   *
   * @param targetId - The target identifier that is now current.
   * @param readTime - The read time associated with the consistent snapshot.
   */
  targetCurrent(targetId: number, readTime: Timestamp): void {
    this.targetChange('CURRENT', targetId, readTime);
  }

  /**
   * Emits a global `TargetChange{ NO_CHANGE, targetIds: [] }` watermark,
   * signaling that **all active targets** are consistent at `readTime`.
   *
   * @param readTime - The watermark read time to announce.
   */
  targetNoChange(readTime: Timestamp): void {
    this.targetChange('NO_CHANGE', undefined, readTime);
  }

  /**
   * Emits a `DocumentChange` for the given document and target list.
   *
   * @param doc - The changed document (must exist).
   * @param targetIds - The targets affected by this change.
   */
  documentChange(doc: MetaDocumentExists, targetIds: number[]): void {
    const documentChange: google.firestore.v1.IDocumentChange = {
      document: this.context.serializeDoc(doc),
      targetIds,
    };
    this.pushResponse({ documentChange });
  }

  /**
   * Emits a `DocumentDelete` for the given document path.
   *
   * @param path - Internal document path to delete (converted to GAPIC path).
   * @param readTime - The time at which the delete is observed.
   */
  documentDelete(path: string, readTime: Timestamp): void {
    const documentDelete: google.firestore.v1.IDocumentDelete = {
      document: this.context.toGapicPath(path),
      readTime: toProtoTimestamp(readTime),
    };
    this.pushResponse({ documentDelete });
  }

  /**
   * Emits a `TargetChange` response.
   *
   * When `targetId` is provided, the change applies to that single target
   * (encoded as `targetIds: [targetId]`). When `targetId` is `undefined`,
   * the change is emitted with `targetIds: []`, which the Listen protocol
   * uses as a **global** signal (e.g., a NO_CHANGE watermark indicating that
   * all active targets are consistent at `readTime`).
   *
   * If `readTime` is provided, it is converted to a protobuf timestamp and
   * included in the payload.
   *
   * @param targetChangeType - The kind of target change to emit
   *   (`ADD`, `REMOVE`, `CURRENT`, `NO_CHANGE`, etc.).
   * @param targetId - The target id to address; omit to emit a global change with empty `targetIds`.
   * @param readTime - Optional read time associated with this change.
   */
  private targetChange(
    targetChangeType: google.firestore.v1.TargetChange.TargetChangeType,
    targetId: number | undefined,
    readTime?: Timestamp
  ): void {
    const targetChange: google.firestore.v1.ITargetChange = {
      targetChangeType,
      targetIds: targetId != undefined ? [targetId] : [],
    };
    if (readTime) {
      targetChange.readTime = toProtoTimestamp(readTime);
    }
    this.pushResponse({ targetChange });
  }

  /**
   * Pushes an {@link google.firestore.v1.IListenResponse} asynchronously to the stream.
   *
   * Uses `queueMicrotask()` to preserve event-loop ordering and emulate async server behavior.
   *
   * @param response - The listen response to push.
   */
  private pushResponse(response: google.firestore.v1.IListenResponse): void {
    queueMicrotask(() => {
      this.duplex.push(response);
    });
  }
}

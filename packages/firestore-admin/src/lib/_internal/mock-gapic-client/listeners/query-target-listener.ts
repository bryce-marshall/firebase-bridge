import type { google } from '@gcf/firestore-protos';
import { DataChangeEventArg } from '../../data-accessor.js';
import { GapicContext } from '../gapic-context.js';
import { QueryBuilder } from '../utils/query-builder.js';
import { TargetListener } from './target-listener.js';
import { TargetWriter } from './target-writer.js';

/**
 * Listen target that tracks the results of a StructuredQuery.
 *
 * Behavior:
 * - Translates a GAPIC {@link google.firestore.v1.Target.IQueryTarget} into a
 *   `RunQuery`-style request and builds a {@link QueryBuilder}.
 * - On each change batch, re-executes the query at the batch `serverTime`
 *   (point-in-time read) and reconciles the target snapshot against the
 *   *complete* result set via {@link TargetListener.applyDelta}.
 *
 * Notes:
 * - Membership is re-evaluated on every datastore change; documents may be
 *   added, updated, or removed based on filter/order/cursor constraints.
 * - Emission of document changes and `TargetChange(CURRENT)` is handled by the
 *   base {@link TargetListener.processChanges}.
 */
export class QueryTargetListener extends TargetListener {
  /** Query executor derived from the incoming IQueryTarget. */
  private readonly _builder: QueryBuilder;
  /**
   * @param targetId GAPIC listen target id.
   * @param writer Stream writer used to emit document/target changes.
   * @param context GAPIC context providing serializer, accessors, and path utils.
   * @param target GAPIC `IQueryTarget` describing the structured query to listen to.
   *
   * The constructor adapts `IQueryTarget` to a minimal `IRunQueryRequest` shape
   * (spread assignment) and delegates parsing/validation to
   * {@link QueryBuilder.fromQuery}, which enforces query rules (inequalities,
   * orderBy presence, cursors, etc.).
   */
  constructor(
    targetId: number,
    writer: TargetWriter,
    context: GapicContext,
    target: google.firestore.v1.Target.IQueryTarget
  ) {
    super(targetId, writer);
    const request: google.firestore.v1.IRunQueryRequest = {
      ...target,
    };
    this._builder = QueryBuilder.fromQuery(context, request);
  }

  /**
   * Processes a change batch by re-evaluating the query at `arg.serverTime`
   * and reconciling the target snapshot to the resulting document set.
   *
   * Flow:
   * 1) Execute {@link QueryBuilder.run} with the batch read time.
   * 2) Call {@link TargetListener.applyDelta} to emit adds/updates/deletes
   *    and update the target snapshot.
   *
   * Snapshot/consistency version updates and CURRENT target signaling are
   * handled by the base {@link TargetListener.processChanges}.
   *
   * @param context Gapic context.
   * @param arg Data change batch containing `serverTime` and datastore diffs.
   */
  override onChange(context: GapicContext, arg: DataChangeEventArg): void {
    const docs = this._builder.run(context, arg.serverTime);
    this.applyDelta(arg.serverTime, docs);
  }
}

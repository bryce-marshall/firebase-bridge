/* eslint-disable @typescript-eslint/no-unused-vars */
import type { google } from '@gcf/firestore-protos';
import { Firestore } from 'firebase-admin/firestore';
import { CallOptions, Status } from 'google-gax';
import { Duplex } from 'stream';
import { InternalTransaction, WriteMode } from '../data-accessor.js';
import { DatabasePool } from '../database-pool.js';
import { GapicClient } from '../firestore/types.js';
import { googleError } from '../functions/google-error.js';
import { rejectPromise } from '../functions/reject-promise.js';
import { resolvePromise } from '../functions/resolve-promise.js';
import { toProtoTimestamp } from '../functions/util.js';
import { GapicContext } from './gapic-context.js';
import { TargetListenerManager } from './listeners/target-listener-manager.js';
import { NoOpStreamEndpoint, StreamCollection } from './stream-endpoint.js';
import { assertRequestArgument } from './utils/assert.js';
import { transformWrites } from './utils/convert.js';
import { QueryBuilder } from './utils/query-builder.js';
import { TransactionHelper } from './utils/transaction-helper.js';

export class MockGapicClient implements GapicClient {
  private _terminated = false;
  readonly context: GapicContext;
  private readonly _transactionManager: TransactionHelper;
  private readonly _streams = new StreamCollection();

  constructor(firestore: Firestore, pool: DatabasePool) {
    this.context = new GapicContext(firestore, pool);
    this._transactionManager = new TransactionHelper(this.context);
  }

  /**
   * Invoked directly from `Firestore.initializeIfNeeded()`
   */
  getProjectId(): Promise<string> {
    this.assertNotClosed();

    return resolvePromise(this.context.projectId);
  }

  /**
   * Invoked via
   * - `WriteBatch._commit`
   */
  beginTransaction(
    request: google.firestore.v1.IBeginTransactionRequest,
    _options?: CallOptions
  ): Promise<
    [google.firestore.v1.IBeginTransactionResponse, unknown, unknown]
  > {
    this.assertNotClosed();
    try {
      const options = request.options;
      if (!options) {
        throw googleError(
          Status.INVALID_ARGUMENT,
          'Transaction options is required.'
        );
      }

      const response = this._transactionManager.begin(options);

      return resolvePromise([response, undefined, undefined]);
    } catch (e) {
      return rejectPromise(e);
    }
  }

  /**
   * Invoked via:
   * - `WriteBatch._commit()`
   */
  commit(
    request: google.firestore.v1.ICommitRequest,
    _options?: CallOptions
  ): Promise<[google.firestore.v1.ICommitResponse, unknown, unknown]> {
    this.assertNotClosed();
    try {
      const response = this._transactionManager.commit(
        WriteMode.Atomic,
        request
      );

      return resolvePromise([response, undefined, undefined]);
    } catch (e) {
      return rejectPromise(e);
    }
  }

  /**
   * Invoked via
   * - `WriteBatch._commit`
   */
  batchWrite(
    request: google.firestore.v1.IBatchWriteRequest,
    _options?: CallOptions
  ): Promise<[google.firestore.v1.IBatchWriteResponse, unknown, unknown]> {
    this.assertNotClosed();
    try {
      const { writeResults, statuses } = applyWritesAndBuildResponse({
        context: this.context,
        writes: request.writes ?? [],
        mode: WriteMode.Serial,
      });

      const response: google.firestore.v1.IBatchWriteResponse = {
        writeResults,
        status: statuses,
      };

      return resolvePromise([response, undefined, undefined]);
    } catch (e) {
      return rejectPromise(e);
    }
  }

  /**
   * Invoked via:
   * - `Transaction.rollback()`
   * - `WriteBatch._commit`
   */
  rollback(
    request: google.firestore.v1.IRollbackRequest,
    _options?: CallOptions
  ): Promise<[google.protobuf.IEmpty, unknown, unknown]> {
    this.assertNotClosed();
    try {
      if (!request.transaction) {
        throw googleError(Status.INVALID_ARGUMENT, 'Missing transaction ID.');
      }

      const tx = this._transactionManager.fetch(request.transaction);
      tx.rollback();

      return resolvePromise<[google.protobuf.IEmpty, unknown, unknown]>([
        {}, // google.protobuf.Empty
        undefined,
        undefined,
      ]);
    } catch (e) {
      return rejectPromise(e);
    }
  }

  /**
   * Invoked via
   * - `DocumentReader.fetchDocuments()`
   */
  batchGetDocuments(
    request?: google.firestore.v1.IBatchGetDocumentsRequest,
    _options?: CallOptions
  ): Duplex {
    this.assertNotClosed();
    const stream = new NoOpStreamEndpoint();
    this._streams.register(stream);

    stream.runMicrotask(() => {
      if (!request?.documents?.length) {
        throw googleError(
          Status.INVALID_ARGUMENT,
          'Missing "documents" in BatchGetDocumentsRequest.'
        );
      }

      const results = this._transactionManager.batchRead(request);
      results.forEach((r) => {
        stream.duplex.push(r);
      });
    }, true);

    return stream.duplex;
  }

  /**
   * Invoked via `QueryUtil._stream()`
   */
  runQuery(
    request?: google.firestore.v1.IRunQueryRequest,
    _options?: CallOptions
  ): Duplex {
    this.assertNotClosed();
    const stream = new NoOpStreamEndpoint();
    this._streams.register(stream);

    stream.run(() => {
      QueryBuilder.fromQuery(this.context, request).executeRequest(
        this._transactionManager,
        stream
      );
    });

    return stream.duplex;
  }

  /**
   * Invoked via
   * - `AggregateQuery._stream()`
   *
   * Supports `.count()` aggregate queries over a base `StructuredQuery`.
   * Only `COUNT(*)` is supported; other aggregation types are not implemented.
   */
  runAggregationQuery(
    request?: google.firestore.v1.IRunAggregationQueryRequest,
    _options?: CallOptions
  ): Duplex {
    this.assertNotClosed();
    this.assertNotClosed();
    const stream = new NoOpStreamEndpoint();
    this._streams.register(stream);

    stream.run(() => {
      QueryBuilder.fromAggregationQuery(this.context, request).executeRequest(
        this._transactionManager,
        stream
      );
    });

    return stream.duplex;
  }

  /**
   * Invoked via
   * - `CollectionReference.listDocuments()`
   * - `WriteBatch._commit`
   */
  listDocuments(
    request: google.firestore.v1.IListDocumentsRequest,
    _options?: CallOptions
  ): Promise<[google.firestore.v1.IDocument[], unknown, unknown]> {
    this.assertNotClosed();

    try {
      const path = this.context.collectionPath(
        assertRequestArgument('parent', request.parent),
        assertRequestArgument('collectionId', request.collectionId)
      );

      if (request.orderBy || request.pageToken || request.mask) {
        // Early validation to expose unsupported features in tests
        throw googleError(
          Status.UNIMPLEMENTED,
          'Query modifiers not supported in mock.'
        );
      }
      const accessor = this.context.getAccessor();

      return accessor.async
        .listDocuments(path, request.showMissing === true)
        .then((result) => {
          return [
            result.map((metaDoc) => this.context.serializeDoc(metaDoc)),
            undefined,
            undefined,
          ];
        });
    } catch (e) {
      return rejectPromise(e);
    }
  }

  /**
   * Invoked via
   * - `DocumentReference.listCollections()`
   * - `WriteBatch._commit`
   */
  listCollectionIds(
    request: google.firestore.v1.IListCollectionIdsRequest,
    _options?: CallOptions
  ): Promise<[string[], unknown, unknown]> {
    this.assertNotClosed();

    try {
      const path = this.context.toInternalPath(request.parent, 'document');
      const accessor = this.context.getAccessor();

      return accessor.async
        .listCollectionIds(path)
        .then((result) => [result, undefined, undefined]);
    } catch (e) {
      return rejectPromise(e);
    }
  }

  /**
   * Invoked via
   * - `Watch.initStream()`
   */
  listen(_options?: CallOptions): Duplex {
    this.assertNotClosed();
    const manager = new TargetListenerManager(this.context);
    this._streams.register(manager);

    return manager.duplex;
  }

  /**
   * Invoked via
   * - `CollectionGroup.getPartitions()`
   *
   * Stub implementation for `partitionQueryStream`, which is used to return
   * query cursors for parallelized query execution (e.g. partitioned exports).
   *
   * This mock does not currently support query partitioning logic.
   * Returns an empty stream for compatibility with tests that call
   * `Query.getPartitions()` but do not rely on its results.
   *
   * Implementing true partitioning logic can be deferred unless required
   * for testing large-scale query batching or export pipelines.
   */
  partitionQueryStream(
    _request?: google.firestore.v1.IPartitionQueryRequest,
    _options?: CallOptions
  ): Duplex {
    this.assertNotClosed();
    const stream = new (class AutoCloseStream extends NoOpStreamEndpoint {
      override onRead(): void {
        this.close();
      }
    })();

    return stream.duplex;
  }

  close(): Promise<void> {
    if (this._terminated) return resolvePromise<void>(undefined);

    // We do not reset the database or transaction manager here, as the Firestore instance
    // may pool multiple client instances.
    this._terminated = true;
    return this._streams.destroy();
  }

  private assertNotClosed(): void {
    if (this._terminated) {
      throw googleError(
        Status.UNAVAILABLE,
        'The client has already been closed.'
      );
    }
  }
}

interface ApplyWriteOptions {
  context: GapicContext;
  writes: google.firestore.v1.IWrite[];
  mode: WriteMode;
  transaction?: InternalTransaction;
}

interface ApplyWriteResult {
  writeResults: google.firestore.v1.IWriteResult[];
  statuses?: google.rpc.IStatus[]; // Only populated for batchWrite
  serverTime: google.protobuf.ITimestamp;
}

function applyWritesAndBuildResponse({
  context,
  writes,
  mode,
}: ApplyWriteOptions): ApplyWriteResult {
  const accessor = context.getAccessor();
  const transformed = transformWrites(context, writes);

  const writeResults: google.firestore.v1.IWriteResult[] = [];
  const result = accessor.batchWrite(
    transformed.map((t) => t.normalized),
    mode
  );
  const serverTime = toProtoTimestamp(result.serverTime);
  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    const transformResults = transformed[i].transformResults;

    const wr: google.firestore.v1.IWriteResult = {
      updateTime: toProtoTimestamp(r.serverTime),
    };

    if (transformResults?.length) {
      wr.transformResults = transformResults;
    }

    writeResults.push(wr);
  }

  return {
    writeResults,
    statuses: result.statuses,
    serverTime: serverTime ?? toProtoTimestamp(accessor.serverTime()),
  };
}

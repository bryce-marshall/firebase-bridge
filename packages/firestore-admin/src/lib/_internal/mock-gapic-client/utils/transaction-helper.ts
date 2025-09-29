import type { google } from '@gcf/firestore-protos';
import { Timestamp } from 'firebase-admin/firestore';
import {
  ResolveTransactionShape as ExternalResolveTransaction,
  InternalTransaction,
  ITransactionOptions,
  WriteMode,
} from '../../data-accessor.js';
import { TimestampFromProto, ToProto } from '../../firestore/typecast.js';
import { toProtoTimestamp } from '../../functions/util.js';
import { GapicContext } from '../gapic-context.js';
import { transformWrites } from './convert.js';
import { assertRequestArgument } from './assert.js';

/**
 * Minimal subset of transaction selector fields accepted by
 * {@link TransactionHelper.resolve}. Mirrors GAPIC request shapes.
 */
export interface ResolveTransactionShape {
  /** Optional read-only/read-write options to begin a new transaction. */
  newTransaction?: google.firestore.v1.ITransactionOptions | null | undefined;
  /** Optional existing transaction id (GAPIC bytes). */
  transaction?: Uint8Array | null | undefined;
}

/**
 * Helper that adapts GAPIC transaction requests to the mock's internal
 * transaction API and provides convenience methods for begin/commit/batchRead.
 *
 * Behavior notes:
 * - `resolve()` will either fetch an existing transaction (when `transaction`
 *   is provided) or request that a new transaction be created (when
 *   `newTransaction` is provided). If neither is provided, it returns `undefined`
 *   (no transaction).
 * - `commit()` uses an existing transaction when the request provides one,
 *   otherwise a new transaction is started implicitly for the commit.
 * - `batchRead()` ensures a point-in-time `readTime` and includes it in all
 *   responses; when a transaction is present, it is echoed back and read locks
 *   are registered as appropriate.
 */
export class TransactionHelper {
  /**
   * @param context GAPIC context exposing accessors, serializer, and path utils.
   */
  constructor(readonly context: GapicContext) {}

  /**
   * Resolves a transaction from a request selector.
   *
   * - If `resolver.newTransaction` is present, returns a newly started
   *   {@link InternalTransaction} configured with the converted options.
   * - If `resolver.transaction` is present, returns the fetched
   *   {@link InternalTransaction} for that id.
   * - If neither is present or `resolver` is undefined, returns `undefined`.
   *
   * @param resolver The request's transaction selector.
   * @returns The resolved transaction or `undefined`.
   */
  resolve(
    resolver: ResolveTransactionShape | undefined
  ): InternalTransaction | undefined {
    return this.context
      .getAccessor()
      .resolveTransaction(Convert.resolveTransactionShape(resolver));
  }

  /**
   * Fetches an existing transaction by its GAPIC id (bytes).
   *
   * @param transactionId GAPIC transaction id as a byte array.
   * @returns The fetched {@link InternalTransaction}.
   */
  fetch(transactionId: Uint8Array): InternalTransaction {
    const accessor = this.context.getAccessor();

    return accessor.fetch(Convert.fromGapicId(transactionId));
  }

  /**
   * Begins a new transaction with optional read-only / read-write options.
   *
   * The options are converted to internal shape; invalid combinations are
   * deferred to the transaction manager for validation and error surfacing.
   *
   * @param options GAPIC transaction options or `null`/`undefined`.
   * @returns GAPIC {@link google.firestore.v1.IBeginTransactionResponse}
   *          containing the new transaction id (bytes).
   */
  begin(
    options: google.firestore.v1.ITransactionOptions | null | undefined
  ): google.firestore.v1.IBeginTransactionResponse {
    const accessor = this.context.getAccessor();

    const tx = accessor.begin(Convert.transactionOptions(options));

    return {
      transaction: Convert.toGapicId(tx),
    };
  }

  /**
   * Commits a set of writes, optionally under an existing transaction.
   *
   * - If `request.transaction` is present, it is asserted and fetched.
   * - Otherwise a new transaction is implicitly begun for the commit.
   * - Each incoming GAPIC write is normalized via {@link transformWrites}
   *   (e.g., preconditions, transforms) before being passed to the internal commit.
   * - Returned `writeResults[i]` carry the per-write commit time; when transform
   *   results were produced, they are included in `transformResults`.
   *
   * @param mode Write mode (e.g., transactional vs non-transactional).
   * @param request GAPIC commit request containing writes and optional transaction id.
   * @returns GAPIC {@link google.firestore.v1.ICommitResponse} with `commitTime`
   *          and per-write `writeResults`.
   * @throws {GoogleError} {Status.INVALID_ARGUMENT} when `transaction` is present but invalid
   *         (surfaced by {@link assertRequestArgument} or downstream fetch/validation).
   */
  commit(
    mode: WriteMode,
    request: google.firestore.v1.ICommitRequest
  ): google.firestore.v1.ICommitResponse {
    const accessor = this.context.getAccessor();
    const transaction = request.transaction
      ? accessor.fetch(
          Convert.fromGapicId(
            assertRequestArgument('transaction', request.transaction)
          ) as Buffer
        )
      : accessor.begin();

    const transformed = transformWrites(this.context, request.writes ?? []);
    const writes = transformed.map((t) => t.normalized);

    const result = transaction.commit({
      mode,
      writes,
    });

    const writeResults: google.firestore.v1.IWriteResult[] = [];
    const commitTime = toProtoTimestamp(result.serverTime);
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
      commitTime,
      writeResults,
    };
  }

  /**
   * Batch-reads a set of documents at a consistent read time, optionally under
   * a transaction. For each requested document path, emits a corresponding
   * GAPIC {@link google.firestore.v1.IBatchGetDocumentsResponse} item:
   *
   * - If the document exists at `readTime`, `found` is populated with a
   *   serialized document.
   * - Otherwise `missing` is set to the requested path.
   * - `readTime` is included in every item.
   * - When a transaction is used, its id (bytes) is echoed back and the read
   *   is registered on the transaction to support conflict detection.
   *
   * @param request GAPIC batch-get request with `documents` and optional
   *                transaction/readTime selectors.
   * @returns Array of GAPIC batch-get responses aligned with `documents` order.
   */
  batchRead(
    request: google.firestore.v1.IBatchGetDocumentsRequest
  ): google.firestore.v1.IBatchGetDocumentsResponse[] {
    const result: google.firestore.v1.IBatchGetDocumentsResponse[] = [];

    const accessor = this.context.getAccessor();
    const tx = this.resolve(request);
    const readTime = InternalTransaction.ensureReadTime(accessor, tx);
    if (!request.documents) return result;

    for (const docPath of request.documents) {
      const internalPath = this.context.toInternalPath(docPath, 'document');
      const metaDoc = accessor.getDoc(internalPath, readTime);

      const response: google.firestore.v1.IBatchGetDocumentsResponse = {
        readTime: (readTime as unknown as ToProto).toProto().timestampValue,
      };
      if (tx) {
        response.transaction = Convert.toGapicId(tx);
        tx.registerRead(metaDoc);
      }

      if (metaDoc?.exists) {
        response.found = this.context.serializeDoc(metaDoc);
      } else {
        response.missing = docPath;
      }

      result.push(response);
    }

    return result;
  }

  /**
   * Converts an internal transaction id to its GAPIC byte-array form.
   *
   * @param tx Internal transaction.
   * @returns GAPIC transaction id as Uint8Array.
   */
  toGapicId(tx: InternalTransaction): Uint8Array {
    return Convert.toGapicId(tx);
  }
}

/**
 * Internal converters between GAPIC request/response wire forms and the mock's
 * internal transaction/timestamp shapes.
 *
 * These are intentionally small and side-effect free; validation of invalid
 * combinations is deferred to the transaction manager where possible.
 */
class Convert {
  /**
   * Converts GAPIC transaction options to internal options.
   *
   * Both `readOnly` and `readWrite` are passed through (when present) so that
   * invalid combinations can be validated later by the transaction manager.
   *
   * @param options GAPIC options or null/undefined.
   * @returns Internal options object or `undefined` if neither mode was set.
   */
  static transactionOptions(
    options: google.firestore.v1.ITransactionOptions | null | undefined
  ): ITransactionOptions | undefined {
    if (!options?.readOnly && !options?.readWrite) return undefined;

    // Important! We set both `readOnly` and `readWrite` so that invalid options
    // are forwarded to the transaction manager for validation/error handling
    const result: ITransactionOptions = {};

    if (options.readOnly) {
      result.readOnly = {
        readTime: Convert.timestamp(options.readOnly.readTime),
      };
    }

    if (options.readWrite) {
      result.readWrite = {
        retryTransaction: Convert.fromOptionalGapicId(
          options.readWrite.retryTransaction
        ),
      };
    }

    return result;
  }

  /**
   * Normalizes a request's "transaction selector" into the internal union shape:
   * - `{ newTransaction: ... }` → begins a new transaction with converted options
   * - `{ transaction: <bytes> }` → uses an existing transaction
   *
   * @param resolver External selector (from request).
   * @returns Internal resolver shape or `undefined` when absent.
   */
  static resolveTransactionShape(
    resolver: ResolveTransactionShape | undefined
  ): ExternalResolveTransaction | undefined {
    if (resolver?.newTransaction)
      return {
        newTransaction: Convert.transactionOptions(resolver.newTransaction),
      };
    if (resolver?.transaction)
      return {
        transaction: Convert.fromGapicId(resolver.transaction),
      };

    return undefined;
  }

  /**
   * Converts a protobuf timestamp to a Firestore {@link Timestamp}.
   *
   * @param proto Protobuf ITimestamp or null/undefined.
   * @returns Firestore Timestamp or undefined.
   */
  static timestamp(
    proto: google.protobuf.ITimestamp | null | undefined
  ): Timestamp | undefined {
    return proto
      ? (Timestamp as unknown as TimestampFromProto).fromProto(proto)
      : undefined;
  }

  /**
   * Converts an internal transaction id (Buffer-like) to a GAPIC Uint8Array id.
   *
   * @param tx Internal transaction.
   * @returns Uint8Array representing the GAPIC transaction id.
   */
  static toGapicId(tx: InternalTransaction): Uint8Array {
    return Uint8Array.from(tx.id);
  }

  /**
   * Converts a GAPIC transaction id to an internal Buffer id.
   *
   * @param tx GAPIC transaction id (bytes).
   * @returns Internal Buffer id.
   */
  static fromGapicId(tx: Uint8Array): Buffer {
    return Buffer.from(tx);
  }

  /**
   * Converts an optional GAPIC transaction id to an optional internal Buffer id.
   *
   * @param tx GAPIC transaction id or null/undefined.
   * @returns Internal Buffer id or undefined.
   */
  static fromOptionalGapicId(
    tx: Uint8Array | null | undefined
  ): Buffer | undefined {
    return tx ? Buffer.from(tx) : undefined;
  }
}

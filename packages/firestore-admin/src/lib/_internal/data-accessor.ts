import { getRandomValues } from 'crypto';
import {
  DocumentData,
  Precondition,
  Timestamp,
} from 'firebase-admin/firestore';
import { GoogleError, Status } from 'google-gax';
import {
  StructuralCollection,
  StructuralCollectionGroup,
  StructuralDatabase,
  StructuralDocument,
} from '../structural-database.js';
import { isDocSizeWithinLimit } from './functions/calc-doc-size.js';
import { cloneDocumentData } from './functions/clone-document-data.js';
import { freezeDocumentData } from './functions/freeze-document-data.js';
import { googleError } from './functions/google-error.js';
import { resolvePromise } from './functions/resolve-promise.js';
import {
  cloneByteArray,
  isByteArrayLike,
  isImmutableFirestoreType,
  isVectorLikeShallow,
  peekVectorValue,
  stackPeek,
} from './functions/util.js';
import { DocumentFieldValue, Mutable } from './internal-types.js';
import { Listeners } from './listeners.js';
import {
  assertEitherRequired,
  assertInstanceOf,
  assertMutuallyExclusive,
  assertNotEmpty,
} from './mock-gapic-client/utils/assert.js';
import {
  matchFirestorePath,
  ParamPathPart,
  PathData,
  PathDataCache,
  PathDataProvider,
  PathType,
} from './path.js';
import { object } from 'firebase-functions/v1/storage';

const MILLIS_PER_SECOND = 1000;
const SIXTY_SECONDS = MILLIS_PER_SECOND * 60;
const Zero = Timestamp.fromMillis(0);

interface OperationStats {
  /**
   * Total number of transactional document write operations (excluding deletes) that resulted
   * in a change to stored data.
   *
   * Counting rules:
   * - Increment once per document write that modifies data (create or update), whether partial
   *   or complete.
   * - Excludes writes that produce no effective change (tracked under `noopWrites`).
   * - Every write is treated as transactional for accounting purposes, regardless of whether it
   *   occurred within an explicit `Transaction` context.
   */
  readonly writes: number;

  /**
   * Total number of document read operations that returned an existing document.
   *
   * Counting rules:
   * - Increment once per document delivered by a read operation (e.g., `get`, query, or listen
   *   snapshot) when the document exists.
   * - Excludes read attempts that return no data (tracked under `noopReads`).
   */
  readonly reads: number;

  /**
   * Total number of document delete operations that successfully removed existing documents.
   *
   * Counting rules:
   * - Increment once per document that was actually deleted.
   * - Excludes delete attempts that targeted non-existent documents (tracked under `noopDeletes`).
   */
  readonly deletes: number;

  /**
   * Total number of document read operations that produced no results because the
   * target documents did not exist or the query result set was empty.
   *
   * Counting rules:
   * - **Direct lookups:** One count per document reference read that does not exist
   *   (e.g. `DocumentReference.get()`, `IBatchGetDocumentsRequest`, or an
   *   `IListenRequest` targeting specific documents).
   * - **Queries with no matches:** One count for a query execution that returns
   *   zero documents (e.g. `IListDocumentsRequest`, `IRunQueryRequest`,
   *   `IRunAggregationQueryRequest`, or an `IListenRequest` specifying a query).
   *
   * Note: This metric tracks *no-op* read attempts only; successful reads of existing
   * documents are accounted for under `reads`.
   */
  readonly noopReads: number;

  /**
   * Total number of transactional document write operations (excluding deletes) that resulted
   * in no effective change to stored data.
   *
   * Counting rules:
   * - Increment once per attempted document write (partial or complete) whose final stored state
   *   is identical to the prior state.
   * - Tracked for fidelity with Firestore semantics, which may still bill for such no-op writes.
   */
  readonly noopWrites: number;

  /**
   * Total number of transactional document delete operations that targeted non-existent documents.
   *
   * Counting rules:
   * - Increment once per attempted delete that had no effect because the document did not exist.
   * - Tracked for fidelity with Firestore semantics, which may still bill for such no-op deletes.
   */
  readonly noopDeletes: number;
}

interface StructuralStats {
  /**
   * Total number of active (materialized) documents that currently have stored data.
   * Does not include placeholder documents.
   */
  readonly documentCount: number;

  /**
   * Total number of active collections that currently contain one or more documents.
   * Does not include placeholder collections.
   */
  readonly collectionCount: number;

  /**
   * Total number of placeholder document nodes (structural documents with no stored data).
   * These are created to maintain tree structure (e.g., a document node that exists only
   * to anchor subcollections).
   */
  readonly stubDocumentCount: number;

  /**
   * Total number of placeholder collection nodes (structural collections with zero documents).
   * These exist only to maintain tree structure (e.g., referenced subcollection paths that
   * currently contain no documents).
   */
  readonly stubCollectionCount: number;
}

/**
 * Statistical counters for database activity and structural state maintained by the
 * in-memory Firestore mock.
 *
 * This interface exposes metrics that track:
 * - **Structural state:** The number of active vs. structural (placeholder) documents
 *   and collections currently present in the database tree.
 * - **Operations:** Totals for writes, reads, and deletes, along with their no-op
 *   counterparts (operations that produced no effective change or returned no data).
 *
 * All counters are cumulative within the lifetime of the current database context (or until
 * `reset()` is invoked).
 * They are primarily intended for validation in tests and for fidelity with Firestore
 * semantics (e.g. Firestore may still bill for no-op operations).
 */
export type DatabaseStats = OperationStats & StructuralStats;

/**
 * Represents the internal in-memory structure of a Firestore database.
 */
interface Datasource {
  /**
   * A map of all stored documents, keyed by their fully qualified document path.
   */
  readonly docs: Map<string, MasterDocument>;

  /**
   * A map of all collections, keyed by their fully qualified collection path.
   */
  readonly cols: Map<string, InternalCollection>;

  /**
   * Database-level statistics tracking document and write operations.
   */
  readonly stats: Mutable<OperationStats>;

  /**
   * Retrieves path metadata from the `PathData` cache.
   *
   * @param path - The fully qualified Firestore path to inspect.
   * @param guard - A `PathType` used to assert the expected type of the path (`empty`, `document`, or `collection`).
   * @returns The corresponding `PathData` instance.
   */
  pathData(path: string, ...guard: PathType[]): PathData;

  /**
   * Invalidates the database's structural stats.
   */
  invalidateStats(): void;

  /**
   * A list of `MetaDocument` instances representing the document changes produced
   * during the most recent atomic commit operation.
   */
  readonly changes: MetaDocument[];
}

interface DocumentIterator {
  getDocumentIterator(): IterableIterator<MasterDocument>;
}

export interface FieldTransformContext {
  readonly serverTime: Timestamp;
  readonly fieldValue?: DocumentFieldValue;
}

export type DocumentFieldTransformer = (
  context: FieldTransformContext
) => DocumentFieldValue;

/**
 * Controls how new data is applied to an existing Firestore document.
 *
 * This type unifies the semantics of `set()` and `update()` operations:
 *
 * - `'root'`
 *   Replace the entire document with the provided data.
 *   Equivalent to `set(data)` or `set(data, { merge: false })`.
 *   Unspecified fields are removed.
 *
 * - `'branch'`
 *   Deep-merge provided map fields into the existing document.
 *   Equivalent to `set(data, { merge: true })`.
 *   Nested maps are merged recursively; scalars and arrays replace.
 *   Unspecified branches remain unchanged.
 *
 * - `'node'`
 *   Apply only the explicitly specified field paths, without recursive merge.
 *   Equivalent to `set(data, { mergeFields: [...] })` or `update(data)`.
 *   Each path sets or deletes its target field; sibling fields are unaffected.
 */
export type MergeGranularity = 'root' | 'branch' | 'node';

/**
 * A normalized **set** (create/overwrite/merge) operation.
 * Produced by decoding a GAPIC `IWrite` into the mock’s internal representation.
 *
 * Notes:
 * - `merge` encodes the set granularity (e.g., full overwrite, merge all, merge specific fields),
 *   already resolved from any API-level input (e.g., `set(..., { merge: true|fields })`).
 * - `precondition`, when present, must be satisfied at apply-time (e.g., `exists`, `updateTime`).
 */
export interface NormalizedSet {
  /** Discriminator: identifies this operation as a set. */
  type: 'set';

  /** Fully-qualified document path (e.g., `"cities/SF"`). */
  path: string;

  /** Document payload to write after server-side transforms are evaluated. */
  data: DocumentData;

  /**
   * Merge granularity computed from the original API call.
   * Determines whether the set is a full overwrite or a partial field merge.
   */
  merge: MergeGranularity;

  /**
   * Optional write precondition (e.g., exists/doesNotExist, updateTime match).
   * If not met at apply-time, the write fails with a precondition error.
   */
  precondition?: Precondition;
}

/**
 * A normalized **delete** operation.
 * Produced by decoding a GAPIC `IWrite` into the mock’s internal representation.
 */
export interface NormalizedDelete {
  /** Discriminator: identifies this operation as a delete. */
  type: 'delete';

  /** Fully-qualified document path to delete. */
  path: string;

  /**
   * Optional delete precondition (e.g., must exist, or updateTime must match).
   * If not met at apply-time, the delete fails with a precondition error.
   */
  precondition?: Precondition;
}

/**
 * Controls how a group of normalized writes is executed by the DataAccessor.
 *
 * - `Atomic`: Apply all writes as a single commit. Either all succeed or the commit fails.
 * - `Serial`: Apply writes one-by-one in order, collecting per-write statuses; later writes
 *   still run even if an earlier one fails.
 */
export enum WriteMode {
  /** Single atomic commit: all-or-nothing semantics. */
  Atomic,

  /** One-by-one application: collect per-write outcomes. */
  Serial,
}

/**
 * A normalized Firestore write operation.
 * Internal form used by the mock after decoding GAPIC `IWrite`.
 * All fields are resolved/preprocessed for application by `DataAccessor`.
 */
export type NormalizedWrite = NormalizedSet | NormalizedDelete;

/**
 * Outcome for a single write in `WriteMode.Serial`.
 * Mirrors GAPIC `google.rpc.Status` shape at a high level.
 */
export interface WriteStatus {
  /** Numeric status code (e.g., `Status.OK`, `Status.FAILED_PRECONDITION`). */
  code?: Status | null;

  /** Optional diagnostic message associated with the code. */
  message?: string | null;
}

/**
 * The structured result of applying one or more normalized writes.
 */
export interface NormalizedWriteResult {
  /**
   * The authoritative server time used for this application.
   * Aligns with commit time for `Atomic`, and with the batch's processing clock for `Serial`.
   */
  serverTime: Timestamp;

  /**
   * One `MetaDocument` per affected path in apply order (creates/updates/deletes).
   * For `Atomic`, represents the final post-commit state. For `Serial`, represents
   * the state after each write is applied.
   */
  results: MetaDocument[];

  /**
   * Per-write status results, only populated when `mode === WriteMode.Serial`.
   * The array length equals the number of input writes and indexes align with `results`
   * entries that reflect the corresponding write’s effect (when any).
   */
  statuses?: WriteStatus[];
}

/**
 * A map of document path → `MetaDocument` describing the changed state for that path.
 * Typically used to coalesce distinct changes by final path state for listener dispatch.
 */
export type DataChangeSet = { [path: string]: MetaDocument };

/**
 * The argument delivered to change watchers during data change notifications.
 * Encapsulates the batch’s server time and a lazily-materialized change set.
 */
export interface DataChangeEventArg {
  /**
   * The authoritative server time associated with the emission (commit/application time).
   */
  readonly serverTime: Timestamp;

  /**
   * `true` if this is an initial emission (e.g., first subscription snapshot),
   * `false` for subsequent delta-driven emissions.
   */
  readonly isInitial: boolean;

  /**
   * Returns the set of changes keyed by document path, representing the final state per
   * path for this emission. Implementations may compute this lazily.
   */
  changes(): DataChangeSet;
}

/**
 * Callback invoked when a `DataChangeEventArg` is available (e.g., for snapshot listeners).
 */
export type ChangeWatcher = (arg: DataChangeEventArg) => void;

/**
 * Argument passed to a trigger callback when a matched document changes.
 *
 * @public
 * @remarks
 * - `params` are the extracted path variables from the matched {@link Trigger.route}
 *   (e.g., for `items/{itemId}`, `params.itemId` is populated).
 * - `doc` is the meta-document representing the post-commit state for the path,
 *   including existence, update/create/delete semantics, and read/write times as
 *   tracked by the in-memory engine.
 */
export interface TriggerEventArg {
  /**
   * Named parameters captured from the route template.
   * For example, a route `groups/{gid}/items/{iid}` yields `{ gid, iid }`.
   */
  params: Record<string, string>;

  /**
   * The meta-document affected by the change.
   * Contains structural and timing metadata used by the mock to emulate Firestore.
   */
  doc: MetaDocument;
}

/**
 * Declarative registration for a DataAccessor trigger.
 *
 * @public
 * @remarks
 * - Triggers are fired by the DataAccessor after an atomic commit resolves.
 * - The `callback` is invoked synchronously on the mock's microtask queue
 *   (deterministic async), preserving commit order.
 */
export interface Trigger {
  /**
   * Route pattern describing which documents this trigger listens to.
   * Supports Firestore-like wildcards, e.g. `items/{itemId}` or
   * `tenants/{tenantId}/orders/{orderId}`.
   */
  route: string;

  /**
   * Handler invoked when a document at a matching route changes.
   *
   * @param arg - The event payload containing path params and the affected meta-document.
   */
  callback: (arg: TriggerEventArg) => void;
}

/**
 * Configuration hooks for the in-memory database.
 *
 * @public
 * @remarks
 * Provide deterministic time behavior for commits and reads. The mock calls
 * {@link DatabaseConfig.serverTime} to stamp commit/update/read times so tests
 * can control clock behavior (e.g., fixed or advancing time).
 */
export interface DatabaseConfig {
  /**
   * Returns the "server" time used to stamp commits and readTimes.
   * Should be monotonic within a test run.
   */
  serverTime: () => Timestamp;
}

/**
 * Internal representation of a structured Firestore query.
 *
 * Used by `DataAccessor` to scope and filter documents according to Firestore’s
 * hierarchy and collection‑group semantics.
 *
 * ## Scoping & Resolution Rules
 *
 * Let:
 * - **P** = `parent` (document path or `''` for the database root)
 * - **A** = `allDescendants` (boolean; defaults to `false` if omitted)
 * - **C** = `collectionId` (optional)
 *
 * The effective search domain is determined by `{P} × {A} × {C}`:
 *
 * | Case | `parent` (P)                | `allDescendants` (A) | `collectionId` (C) | Search domain                                                                 |
 * |------|-----------------------------|-----------------------|--------------------|---------------------------------------------------------------------------------|
 * | 1    | `''` (DB root)              | `true`                | **set**            | All documents in **every** collection named `C`, anywhere in the database.      |
 * | 2    | `''` (DB root)              | `true`                | **unset**          | All documents in **all** collections (entire database).                         |
 * | 3    | `''` (DB root)              | `false`               | **set**            | All documents in **top‑level** collections named `C`.                           |
 * | 4    | `''` (DB root)              | `false`               | **unset**          | All documents in **all top‑level** collections (union of immediate children).   |
 * | 5    | document path (e.g. `a/b`)  | `true`                | **set**            | All documents in descendant subcollections named `C` under that document.       |
 * | 6    | document path (e.g. `a/b`)  | `true`                | **unset**          | **All descendant documents** under that document (any collection name).         |
 * | 7    | document path (e.g. `a/b`)  | `false`               | **set**            | All documents in immediate child subcollection `C` of that document.            |
 * | 8    | document path (e.g. `a/b`)  | `false`               | **unset**          | All documents in **any immediate** child subcollection of that document.        |
 *
 * Notes:
 * - `parent: ''` corresponds to `.../documents` in GAPIC requests.
 * - If `collectionId` is **provided**, it filters the domain by name; if **omitted**,
 *   no name filter is applied (a union across collection names).
 * - Implementations should still enforce any additional query constraints (orderBy,
 *   cursors, limit/offset) *outside* of this scoping step.
 *
 * ### Examples
 * - Sweep all descendants under a doc (used by recursive deletes):
 *   `{ parent: 'col1/doc1', allDescendants: true }`
 * - Global collection group over `posts`:
 *   `{ parent: '', allDescendants: true, collectionId: 'posts' }`
 * - Top‑level `users` only:
 *   `{ parent: '', collectionId: 'users' }`
 *
 * @template T The shape of stored document data (defaults to `DocumentData`).
 */
export interface DocumentQuery<T extends DocumentData = DocumentData> {
  /**
   * The parent path that defines the query scope.
   *
   * - **Document path** → scope is beneath that document.
   * - **Empty string `''` (default)** → scope is the database root (`.../documents`).
   */
  parent?: string;

  /**
   * Whether to include all nested collections under `parent`.
   *
   * - `true` → include **all descendant** collections (collection‑group semantics).
   * - `false` or omitted → include **only immediate** child collections of `parent`.
   */
  allDescendants?: boolean;

  /**
   * Optional collection ID to restrict by collection name.
   *
   * - When provided, only documents from collections with this ID are considered.
   * - When omitted, documents from **all** collection names in scope are considered.
   */
  collectionId?: string;

  /**
   * Point-in-time consistency selector for the query.
   *
   * When provided, `DataAccessor` must evaluate the query **as of** this
   * `readTime` (inclusive):
   * - Return the latest stored version of each document whose `updateTime`
   *   ≤ `readTime`.
   * - Exclude documents created after `readTime` and those deleted at or
   *   before `readTime`.
   *
   * Notes:
   * - This value is typically derived from a transaction’s read time or an
   *   explicit `IRunQueryRequest.readTime`. By the time it reaches
   *   `DataAccessor`, it should be the resolved value to use (no additional
   *   inference needed).
   * - This controls **visibility only**; ordering, cursors, limits, etc. are
   *   applied normally to the visible snapshot.
   */
  readTime?: Timestamp;

  /**
   * A predicate applied to each candidate document (post‑scope filtering).
   * Return `true` to include the document in results.
   */
  predicate: (meta: MetaDocumentExists<T>) => boolean;
}

/**
 * A lightweight, immutable snapshot describing the state and lineage of a document
 * after a single atomic operation (read/write/commit) in the mock datastore.
 *
 * Notes:
 * - Instances are frozen; nested `data` is also frozen.
 * - Time fields (`serverTime`, `updateTime`, `createTime`) are `Timestamp`s aligned to the
 *   mock's commit/application clock (not the client wall clock).
 * - `previous` is provided only for write operations that changed the document.
 */
export interface MetaDocument<T extends DocumentData = DocumentData> {
  /**
   * The path of the parent collection for this document (e.g., `"cities/SF/neighborhoods"`).
   * Always a collection path, never a document path.
   */
  readonly parent: string;

  /**
   * The fully-qualified document path (e.g., `"cities/SF"`).
   */
  readonly path: string;

  /**
   * The last path segment of `path`; i.e., the document ID (e.g., `"SF"`).
   */
  readonly id: string;

  /**
   * `true` if a user document exists at `path` after the associated operation completes;
   * `false` if the document does not exist (was deleted or never created).
   */
  readonly exists: boolean;

  /**
   * The mock server's wall time at which the operation was processed.
   * This is the authoritative "now" used by server-generated values (e.g., serverTimestamp transforms).
   */
  readonly serverTime: Timestamp;

  /**
   * The time that the meta document at `path` was last updated. If no document has ever existed,
   * then `updateTime.toMillis() === 0`.
   */
  readonly updateTime: Timestamp;

  /**
   * The internal, monotonically increasing version (commit sequence number) of the atomic
   * commit operation (`batchWrite`) that produced this state.
   *
   * - If the document was deleted by the operation, `version` is still the commit that processed the delete.
   * - If the document has never existed, then `version === 0`.
   */
  readonly version: number;

  /**
   * The creation time of the document (time of the first successful create/upsert),
   * or `undefined` if the document has never existed.
   */
  readonly createTime?: Timestamp;

  /**
   * A deeply frozen (`Object.freeze`) copy of the document contents after the operation,
   * or `undefined` if the document does not exist.
   *
   * The copy preserves Firestore value types (e.g., `Timestamp`, `GeoPoint`, `Bytes`, `FieldValue` outputs).
   */
  readonly data?: T | undefined;

  /**
   * Returns `true` if the initiating data operation resulted in changes to the underlying document
   * (create, update, transform, or delete). Always returns `false` for pure read operations.
   */
  readonly hasChanges: boolean;

  /**
   * The prior state of the document immediately before the change that produced this instance,
   * provided only when `hasChanges === true`. For read operations or no-ops, this is `undefined`.
   *
   * `previous.updateTime` is always less than or equal to `updateTime`. `previous.data` may be
   * `undefined` if the prior state was "no document".
   */
  readonly previous?: MetaDocument<T>;

  /**
   * Returns a **defensive deep clone** of `data` suitable for mutation by callers,
   * or `undefined` if the document does not exist. The clone is not frozen.
   * Firestore sentinel/value types (e.g., `Timestamp`, `GeoPoint`) are preserved as instances.
   */
  cloneData(): T | undefined;
}

/**
 * A refined `MetaDocument` describing a document that **exists** after the operation.
 * Narrows `exists` to `true` and guarantees presence of both `createTime` and `data`.
 *
 * @typeParam T - The shape of the document data.
 *
 * Notes:
 * - `createTime` is the timestamp of the first successful creation/upsert of the document.
 * - `data` is a deeply frozen snapshot of the document contents after the operation.
 */
export interface MetaDocumentExists<T extends DocumentData = DocumentData>
  extends MetaDocument<T> {
  /** Always `true` for existing documents. */
  readonly exists: true;

  /** The time the document was first created (never `undefined` for existing docs). */
  readonly createTime: Timestamp;

  /** The document's data after the operation (never `undefined` for existing docs). */
  readonly data: T;
}

/**
 * A refined `MetaDocument` describing a document that **does not exist** after the operation.
 * Narrows `exists` to `false` and guarantees absence of both `createTime` and `data`.
 *
 * @typeParam T - The (potential) shape of the document data when present.
 *
 * Notes:
 * - `createTime` is absent when the document has never existed or has been deleted.
 * - `data` is absent because there is no stored document at `path`.
 */
export interface MetaDocumentNotExists<T extends DocumentData = DocumentData>
  extends MetaDocument<T> {
  /** Always `false` for non-existent documents. */
  readonly exists: false;

  /** Absent because the document does not exist. */
  readonly createTime?: undefined;

  /** Absent because the document does not exist. */
  readonly data?: undefined;
}

interface BatchWriteMeta {
  data?: DocumentData | undefined;
  updateTime?: Timestamp;
  exists: boolean;
}

/**
 * Async façade over `DataAccessor` that enforces deterministic asynchronous I/O.
 *
 * All methods delegate to the underlying synchronous/async `DataAccessor` and
 * wrap the result via `resolvePromise(...)` to guarantee:
 * - microtask-based asynchrony (no sync callbacks),
 * - consistent error propagation through Promises,
 * - parity with Firestore’s event-loop-driven behavior.
 */
class _AsyncDataAccessor {
  /**
   * @param _inner The underlying, high-fidelity in-memory `DataAccessor`.
   */
  constructor(private readonly _inner: DataAccessor) {}

  /**
   * Lists the IDs of **direct child collections** under a document path.
   *
   * @param documentPath - Fully-qualified document path (e.g., `"cities/SF"`).
   * @returns A Promise resolving to the distinct collection IDs (no duplicates).
   */
  listCollectionIds(documentPath: string): Promise<string[]> {
    return resolvePromise(this._inner.listCollectionIds(documentPath));
  }

  /**
   * Lists documents in a collection.
   *
   * @param collectionPath - Fully-qualified collection path (e.g., `"cities"` or `"cities/SF/areas"`).
   * @param showMissing - If `true`, include non-existent “placeholder” meta-documents
   *   (useful for structural introspection). If `false`, only existing documents are returned.
   * @returns A Promise resolving to meta-documents in the collection.
   */
  listDocuments(
    collectionPath: string,
    showMissing: boolean
  ): Promise<MetaDocument[]> {
    return resolvePromise(
      this._inner.listDocuments(collectionPath, showMissing)
    );
  }

  /**
   * Executes a structured document query and returns **existing** documents only.
   *
   * @typeParam T - The shape of the document data.
   * @param q - The normalized, validated `DocumentQuery`.
   * @returns A Promise resolving to an array of `MetaDocumentExists<T>`, ordered per query.
   */
  query<T extends DocumentData = DocumentData>(
    q: DocumentQuery<T>
  ): Promise<MetaDocumentExists<T>[]> {
    return resolvePromise(this._inner.query(q));
  }

  /**
   * Reads a single document, optionally **as of** a past `readTime`.
   *
   * If `readTime` is provided, returns the state closest to (≤) that timestamp,
   * or a non-existent meta-document if the document did not exist at/ before that time.
   *
   * @typeParam T - The shape of the document data.
   * @param documentPath - Fully-qualified document path.
   * @param readTime - Optional historical read time.
   * @returns A Promise resolving to a `MetaDocument<T>` describing the doc state.
   */
  getDoc<T extends DocumentData = DocumentData>(
    documentPath: string,
    readTime?: Timestamp
  ): Promise<MetaDocument<T>> {
    return resolvePromise(this._inner.getDoc(documentPath, readTime));
  }

  /**
   * Applies a batch of normalized writes.
   *
   * - `WriteMode.Atomic`: all-or-nothing commit semantics.
   * - `WriteMode.Serial`: apply sequentially and report per-write statuses.
   *
   * Server time used for transforms and timestamps is exposed on the result.
   *
   * @param ops - Normalized write operations to apply.
   * @param mode - Write execution mode (`Atomic` or `Serial`).
   * @returns A Promise resolving to the structured write result.
   */
  batchWrite(
    ops: NormalizedWrite[],
    mode: WriteMode
  ): Promise<NormalizedWriteResult> {
    return resolvePromise(this._inner.batchWrite(ops, mode));
  }
}

/**
 * Public alias for the async `DataAccessor` façade.
 *
 * Prefer this type in consumer-facing signatures to avoid exporting the
 * private class name.
 */
export type AsyncDataAccessor = _AsyncDataAccessor;

export class DataAccessor implements PathDataProvider {
  /**
   * The monotonically increasing atomic commit version (increments with each atomic `batchWrite`).
   * Each document change (create/update/delete) carries the version associated with its corresponding
   * `batchWrite`.
   */
  private _version = 0;
  private readonly _resetListeners = new Listeners<void>();
  private readonly _statsWatchers = new Listeners<DatabaseStats>();
  private readonly _changeWatchers = new Set<ChangeWatcher>();
  private readonly _triggers = new Set<Trigger>();
  private _pathCache = new PathDataCache();
  private _stats: StructuralStats | undefined;
  private _txs: TransactionManager;
  private _src: Datasource = {
    cols: new Map(),
    docs: new Map(),
    changes: [],
    stats: {
      deletes: 0,
      reads: 0,
      writes: 0,
      noopReads: 0,
      noopWrites: 0,
      noopDeletes: 0,
    },
    pathData: (path: string, ...guards: PathType[]): PathData => {
      return this._pathCache.assert(path, ...guards);
    },
    invalidateStats: (): void => {
      this._stats = undefined;
    },
  };
  /**
   * Returns the current "server" time.
   */
  readonly serverTime: () => Timestamp;
  /**
   * Async façade over `DataAccessor` that enforces deterministic asynchronous I/O.
   */
  readonly async: AsyncDataAccessor = new _AsyncDataAccessor(this);

  constructor(config: DatabaseConfig) {
    this.serverTime = config.serverTime;
    this._txs = new TransactionManager(this);
  }

  /**
   * Returns cached structural metadata for a given path, optionally asserting its type.
   *
   * @param path - A canonical path string (e.g., `'items/i1'`, `'users/u1/posts'`).
   * @param guards - Optional type guards that must match the path (e.g., `'document'`, `'collection'`, `'root'`).
   * @returns The {@link PathData} for the path if it exists in the cache and satisfies the guards; otherwise `undefined`.
   *
   * @remarks
   * - This is a pure cache lookup via the internal `PathDataCache`.
   * - When `guards` are provided, the path must satisfy **all** requested types or `undefined` is returned.
   * - No I/O occurs and the database state is not mutated.
   */
  pathData(path: string, ...guards: PathType[]): PathData | undefined {
    return this._pathCache.pathData(path, ...guards);
  }

  /**
   * Registers a listener that fires whenever the in-memory database is reset.
   *
   * @param callback - Invoked after a reset operation completes.
   * @returns An unsubscribe function that removes the listener.
   *
   * @remarks
   * - Reset events typically occur in tests to clear state between cases.
   * - The callback is invoked on the mock’s deterministic microtask queue.
   * - Multiple listeners are supported; order of invocation is unspecified.
   */
  registerResetListener(callback: () => void): () => void {
    return this._resetListeners.register(callback);
  }

  /**
   * Registers a low-level change watcher and immediately delivers a synthetic
   * "current state" snapshot followed by future change notifications.
   *
   * @param watcher - The {@link ChangeWatcher} to receive change batches.
   * @returns An unsubscribe function that de-registers the watcher.
   *
   * @remarks
   * - Upon registration, the watcher is primed by calling
   *   {@link processChangeWatchers} with all existing documents (a sync pass),
   *   using the current {@link serverTime}.
   * - Subsequent atomic commits produce batched change notifications in commit order.
   * - The unsubscribe function is idempotent.
   */
  registerChangeWatcher(watcher: ChangeWatcher): () => void {
    this._changeWatchers.add(watcher);
    const changes = this.all();
    this.processChangeWatchers(this.serverTime(), changes, watcher);

    return () => {
      this._changeWatchers.delete(watcher);
    };
  }

  /**
   * Registers a route-based trigger that fires after atomic commits affecting matching documents.
   *
   * @param trigger - The trigger definition (route + callback). A shallow copy is stored internally.
   * @returns An unsubscribe function that removes the trigger.
   *
   * @remarks
   * - Routes use Firestore-like wildcards (e.g., `items/{itemId}`).
   * - Triggers observe **post-commit** state and fire on the mock’s microtask queue.
   * - If multiple writes target the same document in a single commit, only the
   *   **final** state for that path is delivered to the trigger.
   */
  registerTrigger(trigger: Trigger): () => void {
    trigger = { ...trigger };
    this._triggers.add(trigger);

    return () => {
      this._triggers.delete(trigger);
    };
  }

  /**
   * Lists the IDs of direct child collections beneath a document (or the root).
   *
   * @param documentPath - A document path (e.g., `users/u1`) or root sentinel if supported.
   * @returns An array of child collection IDs, filtered to those with active leaf documents.
   *
   * @throws {Error} If `documentPath` is not a document (or allowed root), as asserted by the path cache.
   *
   * @remarks
   * - Only collections that currently contain at least one active document are returned.
   * - This mirrors `DocumentReference.listCollections()` behavior at a structural level.
   */
  listCollectionIds(documentPath: string): string[] {
    this._pathCache.assert(documentPath, 'document', 'root');
    const result: string[] = [];
    const doc = this._src.docs.get(documentPath);

    if (doc?.hasActiveLeafDocs) {
      for (const col of doc.getCollectionIterator()) {
        if (col.hasActiveLeafDocs) {
          result.push(col.pathData.id);
        }
      }
    }

    return result;
  }

  /**
   * Produces a sorted array of meta-documents representing all existing documents.
   *
   * @returns An array of {@link MetaDocumentExists}, sorted lexicographically by `path`.
   *
   * @remarks
   * - Each element is computed via {@link readMetaDoc} using the current {@link serverTime}.
   * - Only documents with `exists === true` are included.
   * - Useful for assertions and structural introspection in tests.
   */
  toMetaArray(): MetaDocumentExists[] {
    const result: MetaDocumentExists[] = [];

    const serverTime = this.serverTime();

    this._src.docs.forEach((master) => {
      if (master.exists) {
        result.push(
          readMetaDoc(serverTime, master, master) as MetaDocumentExists
        );
      }
    });

    result.sort((x, y) => x.path.localeCompare(y.path));

    return result;
  }

  /**
   * Returns a map of document path → meta-document for all existing documents.
   *
   * @returns A plain object whose keys are canonical document paths and values are {@link MetaDocumentExists}.
   *
   * @remarks
   * - Meta entries are materialized using {@link readMetaDoc} with the current {@link serverTime}.
   * - Only documents with `exists === true` are included.
   * - Order is not guaranteed; use {@link toMetaArray} for a stable, sorted view.
   */
  toMetaMap(): Record<string, MetaDocumentExists> {
    const result: DocumentData = {};

    const serverTime = this.serverTime();

    this._src.docs.forEach((master) => {
      if (master.exists) {
        result[master.pathData.path] = readMetaDoc(serverTime, master, master);
      }
    });

    return result;
  }

  /**
   * Returns a map of document path → cloned document data for all existing documents.
   *
   * @returns A plain object whose keys are canonical document paths and values are deep-cloned {@link DocumentData}.
   *
   * @remarks
   * - Only documents with `exists === true` are included.
   * - Values are cloned via {@link cloneDocumentData} to prevent accidental mutation of internal state.
   * - Intended for test visibility and debugging; not optimized for very large datasets.
   */
  toMap(): Record<string, DocumentData> {
    const result: DocumentData = {};

    this._src.docs.forEach((master) => {
      if (master.exists) {
        result[master.pathData.path] = cloneDocumentData(
          master.data
        ) as DocumentData;
      }
    });

    return result;
  }

  /**
   * Materializes a **read-only structural snapshot** of the entire in-memory database
   * as a tree of collections → documents → (nested collections), rooted at `''`.
   *
   * @returns A {@link StructuralDatabase} object representing the current state.
   *
   * @remarks
   * - Only documents with `exists === true` are included.
   * - Each document’s `data` is deep-cloned (no shared references with internal state).
   * - The returned structure is suitable for serialization, diffing, or round-tripping
   *   back into the database via {@link fromStructuralDatabase}.
   *
   * @example
   * ```ts
   * // Shape example (collections → documents → data|collections):
   * const tree = acc.toStructuralDatabase();
   * // {
   * //   users: {
   * //     u1: {
   * //       data: { name: 'Ada' },
   * //       collections: {
   * //         posts: {
   * //           p1: { data: { title: 'Hello' } }
   * //         }
   * //       }
   * //     }
   * //   }
   * // }
   * ```
   */
  toStructuralDatabase(): StructuralDatabase {
    const root: StructuralDocument = {};

    function ensureNode(
      pathData: PathData
    ): StructuralDocument | StructuralCollection {
      if (pathData.type === 'root') return root;
      // Walks backwards up the tree to ensure the entire branch
      const above = ensureNode(pathData.parent());
      const isDocument = pathData.type === 'document';
      const container = (
        isDocument ? above : above.collections ?? (above.collections = {})
      ) as DocumentData;

      return container[pathData.id] ?? (container[pathData.id] = {});
    }

    this._src.docs.forEach((master) => {
      if (master.exists) {
        const doc = ensureNode(master.pathData) as StructuralDocument;
        doc.data = cloneDocumentData(master.data) as DocumentData;
      }
    });

    return root.collections ?? {};
  }

  /**
   * Ingests a {@link StructuralDatabase} tree and applies it to the in-memory
   * database via a single atomic batch write.
   *
   * @param data - The structural tree to import (collections → documents → data / nested collections).
   * @param merge - Optional merge granularity for `set` operations; defaults to `'root'`.
   * @returns A {@link NormalizedWriteResult} describing the applied atomic commit.
   *
   * @remarks
   * - Each structural document with a `data` property becomes a `set` write at its path.
   * - Nested `collections` are traversed depth-first; the resulting writes are committed atomically.
   * - `merge` controls how document data is applied (see {@link MergeGranularity} semantics).
   * - This is ideal for seeding fixtures, restoring snapshots, or constructing complex hierarchies
   *   in tests with deterministic commit semantics.
   *
   * @example
   * ```ts
   * const fixtures: StructuralDatabase = {
   *   users: {
   *     u1: { data: { name: 'Ada' } },
   *     u2: {
   *       data: { name: 'Grace' },
   *       collections: {
   *         posts: {
   *           p1: { data: { title: 'Hello' } }
   *         }
   *       }
   *     }
   *   }
   * };
   *
   * // Apply as a single atomic commit
   * const result = acc.fromStructuralDatabase(fixtures, 'root');
   * ```
   */
  fromStructuralDatabase(
    data: StructuralDatabase,
    merge: MergeGranularity = 'root'
  ): NormalizedWriteResult {
    const segments: string[] = [];
    const writes: NormalizedWrite[] = [];

    const structuralGroup = (
      grp: StructuralCollectionGroup | undefined
    ): void => {
      if (!grp) return;

      for (const [colId, col] of Object.entries(grp)) {
        segments.push(colId);

        for (const [docId, doc] of Object.entries(col)) {
          segments.push(docId);
          structuralDoc(doc);
          segments.pop();
        }

        segments.pop();
      }
    };

    const structuralDoc = (doc: StructuralDocument | undefined): void => {
      if (!doc) return;

      if (doc.data) {
        const path = segments.join('/');
        writes.push({ path, data: doc.data, type: 'set', merge });
      }

      structuralGroup(doc.collections);
    };

    structuralGroup(data);

    return this.batchWrite(writes, WriteMode.Atomic);
  }

  /**
   * Lists meta-documents under a given collection path.
   *
   * @param collectionPath - Canonical collection path (e.g., `"users"`, `"users/u1/posts"`).
   * @param showMissing - When `true`, include *missing* documents that have active child collections
   *   (i.e., documents that don't exist but have nested subcollections). When `false`, only existing
   *   documents are returned.
   * @returns An array of {@link MetaDocument} describing each document’s post-commit state at the
   *   current {@link serverTime}. For missing documents included due to `showMissing`, `exists === false`.
   *
   * @throws {Error} If `collectionPath` is not a collection path (validated by the path cache).
   *
   * @remarks
   * - Uses the in-memory structural index; no network I/O.
   * - When `showMissing` is `true`, a document is included if it has **active leaf docs** in a
   *   descendant collection, even if the document itself is not stored.
   * - Read accounting: only **existing** documents contribute to read counts; missing documents are
   *   not charged. This is applied via an aggregated `bumpReads()` call.
   * - Each returned meta-document is produced by `readMetaDoc(serverTime, …, showMissing)` to embed
   *   consistent timing and existence metadata.
   *
   * @example
   * ```ts
   * // Only existing docs in a collection
   * const existingOnly = acc.listDocuments('users', false);
   * // Existing + synthetic "missing" docs that have subcollections
   * const withMissing = acc.listDocuments('users', true);
   *
   * // Filter existing docs
   * const existing = withMissing.filter(d => d.exists);
   * ```
   */
  listDocuments(collectionPath: string, showMissing: boolean): MetaDocument[] {
    this._pathCache.assert(collectionPath, 'collection');
    const result: MetaDocument[] = [];
    const serverTime = this.serverTime();
    const col = this._src.cols.get(collectionPath);

    if (col && (col.hasActiveDocs || (showMissing && col.hasActiveLeafDocs))) {
      for (const doc of col.getDocumentIterator()) {
        if (doc.exists || (showMissing && doc.hasActiveLeafDocs)) {
          result.push(readMetaDoc(serverTime, doc, doc, showMissing));
        }
      }
    }
    // Count reads for existing docs only (no allocation)
    const existingCount = result.reduce((n, r) => n + (r.exists ? 1 : 0), 0);
    bumpReads(this._src, existingCount);

    return result;
  }

  /**
   * CONTRACT: DataAccessor.query
   * --------------------------------
   * Role
   *  - Enumerate candidate documents from the in-memory tree according to:
   *    (a) scope (`parent`), (b) depth (`allDescendants`), (c) name filter (`collectionId`),
   *    (d) point-in-time visibility (`readTime`), and (e) a WHERE-like `predicate(data)`.
   *
   * Inputs
   *  - `parent`: '' for database root, or a document path. Already validated upstream.
   *  - `allDescendants`: if true, walk all descendant collections; else only immediate child collections.
   *  - `collectionId` (optional): when set, only *collect* docs from collections with this ID at the current depth.
   *    IMPORTANT: This does NOT restrict recursion; traversal must continue so deeper matches aren’t missed.
   *  - `readTime` (optional): evaluate existence and data **as of** this timestamp.
   *    Uses ghost nodes + `MasterDocument.getSnapshot(now, readTime)` for point-in-time views.
   *  - `predicate(data)`: pure function implementing WHERE logic; called only for documents visible at `readTime`.
   *
   * Guarantees
   *  - Returns a flat array of `MetaDocumentExists<T>` where each item:
   *      • is within scope rooted at `parent`
   *      • is visible at `readTime` (or “now” if absent)
   *      • originates from a collection whose name matches `collectionId` at the *collection where it was found*,
   *        when `collectionId` is provided
   *      • satisfies `predicate(data)`
   *  - Traverses subcollections even when a parent document doesn’t exist (now or at `readTime`).
   *  - No reliance on “active” flags when `readTime` is present (they’re “now” signals only).
   *  - Does not deduplicate (tree contains unique document nodes); every returned meta has `exists === true`.
   *  - **Ordering is undefined** (implementation detail). Callers must not rely on output order.
   *
   * Non-Responsibilities (handled by higher layers / execution plan)
   *  - `orderBy` (including implicit `__name__`), `startAt` / `endAt` cursors,
   *    `offset` / `limit`, field projection (`select`), streaming/envelope, and aggregation computation.
   *
   * Error / Edge Semantics
   *  - If `parent` does not resolve to a node, returns `[]`.
   *  - Assumes request validation is performed upstream (paths, mutually exclusive consistency selectors, etc.).
   *
   * Performance Notes
   *  - It’s safe to short-circuit via “active” flags **only when** `readTime` is undefined.
   *  - Prefer single enumeration of each collection’s iterator (buffer once; collect then recurse).
   */
  query<T extends DocumentData = DocumentData>(
    q: DocumentQuery<T>
  ): MetaDocumentExists<T>[] {
    const now = this.serverTime();
    const wantDeep = q.allDescendants === true;
    const results: MetaDocumentExists<T>[] = [];

    const pathData = this._pathCache.assert(q.parent ?? '', 'document', 'root');
    const root = this._src.docs.get(pathData.path);
    if (!root) return results;

    const metaFetch = q.readTime
      ? (doc: MasterDocument) => {
          return doc.getSnapshot(now, q.readTime as Timestamp) as
            | MetaDocument<T>
            | undefined;
        }
      : (doc: MasterDocument) => {
          return doc.exists
            ? (readMetaDoc<T>(now, doc, doc) as MetaDocument<T>)
            : undefined;
        };

    const stack: MasterDocument[] = [root];

    while (stack.length) {
      const parent = stack.pop() as MasterDocument;
      for (const col of parent.getCollectionIterator()) {
        const collectHere =
          q.collectionId == null || q.collectionId === col.pathData.id;
        // If this collection won't contribute and we won't recurse, skip it entirely.
        if (!collectHere && !wantDeep) continue;

        const docs = Array.from(col.getDocumentIterator());

        if (collectHere) {
          for (const doc of docs) {
            const meta = metaFetch(doc);
            if (meta?.exists && q.predicate(meta as MetaDocumentExists<T>)) {
              results.push(meta as MetaDocumentExists<T>);
            }
          }
        }

        if (wantDeep) stack.push(...docs);
      }
    }
    bumpReads(this._src, results.length);

    return results;
  }

  /**
   * Reads a meta-document at the given path, optionally as-of a specific {@link Timestamp}.
   *
   * @typeParam T - The document’s data shape (defaults to {@link DocumentData}).
   * @param documentPath - Canonical document path, e.g. `"users/u1"` or `"users/u1/posts/p1"`.
   * @param readTime - Optional historical read time. When provided, returns the best-known
   *   snapshot materialized at (or before) this time according to the mock’s version store.
   *   When omitted, returns the latest state.
   * @returns A {@link MetaDocument} describing existence, times, and data (typed as `T`).
   *
   * @remarks
   * - Delegates to `MasterDocument.get(...)` with the current `serverTime()` and optional `readTime`.
   * - Read accounting: only **existing** documents increment read counts; missing docs do not.
   * - No mutation occurs. The returned `meta.data` is safe to consume but should be treated as read-only.
   *
   * @example
   * ```ts
   * // Latest state
   * const meta = acc.getDoc<{name: string}>('users/u1');
   * if (meta.exists) {
   *   console.log(meta.data!.name);
   * }
   *
   * // Historical read
   * const asOf = Timestamp.fromMillis(t0);
   * const old = acc.getDoc('users/u1', asOf);
   * ```
   */
  getDoc<T extends DocumentData = DocumentData>(
    documentPath: string,
    readTime?: Timestamp
  ): MetaDocument<T> {
    const meta = MasterDocument.get<T>(
      this._src,
      this.serverTime(),
      documentPath,
      readTime
    );
    bumpReads(this._src, meta.exists ? 1 : 0);

    return meta;
  }

  /**
   * Returns whether a document currently exists at the given path.
   *
   * @param documentPath - Canonical document path, e.g. `"users/u1"`.
   * @returns `true` if the document exists **now**; otherwise `false`.
   *
   * @remarks
   * - This is a lightweight structural check against the in-memory index.
   * - No read accounting is performed and no historical read is supported here.
   *   Use {@link getDoc} with `readTime` for time-travel queries.
   *
   * @example
   * ```ts
   * if (!acc.docExists('users/u1')) {
   *   await db.doc('users/u1').set({ created: true });
   * }
   * ```
   */
  docExists(documentPath: string): boolean {
    return this._src.docs.get(documentPath)?.exists === true;
  }

  /**
   * Returns `true` if `documentInfo` accurately reflects the referenced document's current state
   * in the database, otherwise returns `false.
   */
  docIsCurrent(documentInfo: MetaDocument): boolean {
    const master = this._src.docs.get(documentInfo.path);

    return master?.version === documentInfo.version;
  }

  /**
   * Returns `true` if every `DocumentInfo` item in `info` accurately reflects the referenced document's
   * current state in the database, otherwise returns `false.
   */
  docsAreCurrent(info: MetaDocument[]): boolean {
    let result = true;

    for (const di of info) {
      result &&= this.docIsCurrent(di);
      if (!result) break;
    }

    return result;
  }

  /**
   * Applies a batch of normalized writes to the in-memory store, either **atomically**
   * or in **serial** mode with per-op status reporting.
   *
   * @param ops - An ordered array of normalized writes (each with `path`, `type`, optional
   *   `data`, and optional `precondition`).
   * @param mode - Write behavior: `WriteMode.Atomic` or `WriteMode.Serial`.
   * @returns A {@link NormalizedWriteResult} containing:
   * - `serverTime`: the commit timestamp used for all writes in this batch,
   * - `results`: an array of {@link MetaDocument} in the **same order** as `ops`,
   * - `statuses` (Serial mode only): per-op {@link WriteStatus} with `code`/`message` or `OK`.
   *
   * @remarks
   * ### Modes
   * - **Atomic**: The batch is validated and applied as a single unit. On the first
   *   failing precondition or validation, a {@link GoogleError} is thrown and **no**
   *   changes are committed.
   * - **Serial**: Each operation is independently validated/applied in order. For a
   *   failing op, an entry is pushed into `statuses` with the error code/message and the
   *   op is skipped; subsequent ops continue. Successful ops receive `Status.OK`.
   *
   * ### Preconditions
   * For each operation, these checks are performed against the buffered view:
   * - `exists === false` → error `ALREADY_EXISTS` if the document currently exists.
   * - `exists === true`  → error `NOT_FOUND` if the document is missing.
   * - `lastUpdateTime`   → error `FAILED_PRECONDITION` if it does not match current `updateTime`.
   *
   * ### Validation & Transforms (`set` only)
   * - `data` must be defined (`INVALID_ARGUMENT` if not).
   * - Field transforms are applied (`applyTransformers`) using the batch `serverTime`.
   * - Data is normalized to Firestore's wire-compatible representation.
   * - Structural/size guards run (`assertMaxDepth`, `assertWithinSizeLimit`).
   *
   * ### Execution Model
   * - A per-document buffer is built first so multiple ops on the same path coalesce,
   *   with the **final** state (exists/data/updateTime) used when committing.
   * - After successful buffering, changes are applied to the store in op order:
   *   `set` → `MasterDocument.set(...)`; otherwise `MasterDocument.delete(...)`.
   * - Each applied op yields a {@link MetaDocument} pushed to `results` at the same index
   *   as the originating op.
   * - `enqueueChanges(serverTime)` is invoked once at the end to notify watchers/triggers.
   * - The internal store version increments once per `batchWrite` call.
   *
   * ### Error Semantics
   * - **Atomic**: throws a {@link GoogleError} immediately on first failure; no partial writes.
   * - **Serial**: records each failure into `statuses` and skips that op; does **not** throw
   *   for per-op failures. Non-`GoogleError` exceptions are wrapped as `INTERNAL`.
   *
   * @example
   * ```ts
   * // Atomic: all-or-nothing
   * const atomic = acc.batchWrite(
   *   [
   *     { path: 'users/u1', type: 'set', data: { name: 'Ada' } },
   *     { path: 'users/u2', type: 'delete' },
   *   ],
   *   WriteMode.Atomic
   * );
   * // atomic.results[0].exists === true
   *
   * // Serial: continue after failures, inspect per-op statuses
   * const serial = acc.batchWrite(
   *   [
   *     { path: 'users/u3', type: 'set', data: { name: 'Grace' } },
   *     { path: 'users/u3', type: 'set',  } as any, // missing data → INVALID_ARGUMENT
   *     { path: 'users/uX', type: 'delete', precondition: { exists: true } }, // may fail
   *   ],
   *   WriteMode.Serial
   * );
   * // serial.statuses → [{ code: OK }, { code: INVALID_ARGUMENT, ... }, { code: NOT_FOUND, ... }]
   * ```
   */
  batchWrite(ops: NormalizedWrite[], mode: WriteMode): NormalizedWriteResult {
    const SerialFailToken = 'SerialFail';
    const version = ++this._version;
    const serverTime = this.serverTime() as Timestamp;
    const results: MetaDocument[] = [];
    const statuses: (WriteStatus | undefined)[] | undefined =
      mode === WriteMode.Serial ? [] : undefined;

    const docBuffer = new Map<string, BatchWriteMeta>();

    function onError(error: GoogleError): void {
      if (statuses === undefined) throw error;
      statuses.push({
        code: error.code,
        message: error.message,
      });

      throw SerialFailToken;
    }

    const ensureMeta = (path: string): BatchWriteMeta => {
      let meta = docBuffer.get(path);
      if (meta == undefined) {
        const existing = MasterDocument.get(this._src, serverTime, path);
        meta = {
          exists: existing.exists,
        };
        if (existing.exists) {
          meta.updateTime = existing.updateTime;
          meta.data = existing.data;
        }
        docBuffer.set(path, meta);
      }

      return meta;
    };

    try {
      for (const op of ops) {
        const existing = ensureMeta(op.path);
        let proceed = true;

        try {
          if (op.type === 'set' && op.data == undefined) {
            onError(
              googleError(
                Status.INVALID_ARGUMENT,
                `Document data must be defined: ${op.path}`
              )
            );
          }
          // 1. Precondition check
          if (op.precondition) {
            if (op.precondition.exists === false && existing.exists) {
              onError(createError(Status.ALREADY_EXISTS, op.path));
            }

            if (op.precondition.exists === true && !existing.exists) {
              onError(createError(Status.NOT_FOUND, op.path));
            }

            if (
              op.precondition.lastUpdateTime &&
              (!existing.exists ||
                !timestampsEqual(
                  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                  existing.updateTime!,
                  op.precondition.lastUpdateTime
                ))
            ) {
              onError(createError(Status.FAILED_PRECONDITION, op.path));
            }
          }
        } catch (error) {
          if (error === SerialFailToken) {
            proceed = false;
          } else {
            throw error;
          }
        }

        if (!proceed) continue;
        if (statuses) {
          statuses.push(undefined);
        }

        // 2. Apply mutation
        switch (op.type) {
          case 'set': {
            const current = existing.data ?? {};
            const cloned = mergeInto(op, current);
            applyTransformers(serverTime, cloned, current);
            const normalized = normalizeFirestoreData(cloned);
            assertMaxDepth(cloned);
            assertWithinSizeLimit(op.path, normalized);
            existing.exists = true;
            existing.data = normalized;
            existing.updateTime = serverTime;
            break;
          }

          case 'delete': {
            existing.exists = false;
            existing.data = undefined;
            existing.updateTime = serverTime;
            break;
          }
        }
      }

      // 3. Apply to store
      for (const op of ops) {
        const doc = docBuffer.get(op.path);
        let writeResult: MetaDocument | undefined;
        if (doc?.exists) {
          writeResult = MasterDocument.set(
            this._src,
            version,
            serverTime,
            op.path,
            doc.data as DocumentData
          );
        }
        if (!writeResult) {
          writeResult = MasterDocument.delete(
            this._src,
            version,
            serverTime,
            op.path
          );
        }
        results.push(writeResult);
      }
      this.enqueueChanges(serverTime);
    } catch (cause) {
      this._src.changes.slice(0);
      if (cause instanceof GoogleError) throw cause;

      throw createError(Status.INTERNAL, { cause });
    }

    return {
      serverTime,
      results,
      statuses: statuses?.length
        ? statuses.map((s) => {
            return s ?? { code: Status.OK };
          })
        : undefined,
    };
  }

  /**
   * Returns consolidated database statistics.
   *
   * @returns A {@link DatabaseStats} object combining:
   * - **Operational counters** from `_src.stats` (e.g., reads/writes as tracked by the engine), and
   * - **Structural counters** computed on demand (documents/collections and their structural stubs).
   *
   * @remarks
   * - Structural stats are computed lazily and memoized in `_stats` until the next invalidation
   *   (e.g., after writes/resets elsewhere in the DataAccessor). The method merges a **fresh**
   *   structural snapshot with the current operational stats at call time.
   * - **Stub** items:
   *   - `stubDocumentCount`: non-existent documents that anchor subcollections with active leaf docs.
   *   - `stubCollectionCount`: collections with no immediate docs but with active descendants.
   * - The synthetic root is excluded from document counts.
   *
   * @example
   * ```ts
   * const stats = acc.getStats();
   * // stats.documentCount, stats.collectionCount, stats.stubDocumentCount, stats.stubCollectionCount
   * // stats.readCount, stats.writeCount, ... (from _src.stats)
   * ```
   */
  getStats(): DatabaseStats {
    const ensureStructural = (): StructuralStats => {
      if (this._stats) return this._stats;

      let documentCount = 0;
      let collectionCount = 0;
      let stubDocumentCount = 0;
      let stubCollectionCount = 0;

      // Documents
      this._src.docs.forEach((doc) => {
        // Ignore the synthetic root node (type === 'root')
        if (doc.pathData.type !== 'document') return;

        if (doc.exists) {
          documentCount += 1;
        } else if (doc.hasActiveLeafDocs) {
          // Structural placeholder: anchors subcollections that have active docs
          stubDocumentCount += 1;
        }
      });

      // Collections
      this._src.cols.forEach((col) => {
        if (col.hasActiveDocs) {
          collectionCount += 1;
        } else if (col.hasActiveLeafDocs) {
          // Structural placeholder: no immediate docs, but descendants have active docs
          stubCollectionCount += 1;
        }
      });

      this._stats = {
        documentCount,
        collectionCount,
        stubDocumentCount,
        stubCollectionCount,
      };
      return this._stats;
    };

    return { ...this._src.stats, ...ensureStructural() };
  }

  /**
   * Subscribes to database stat updates.
   *
   * @param watcher - Callback invoked with the latest {@link DatabaseStats}.
   * @returns An unsubscribe function to stop receiving updates.
   *
   * @remarks
   * - The `watcher` is called **immediately** with `getStats()` to prime consumers.
   * - Subsequent updates are delivered according to the DataAccessor’s internal
   *   stats invalidation/notification flow (e.g., after writes or resets).
   *
   * @example
   * ```ts
   * const unsub = acc.watchStats(s => console.log('Stats:', s));
   * // ...
   * unsub();
   * ```
   */
  watchStats(watcher: (stats: DatabaseStats) => void): () => void {
    watcher(this.getStats());

    return this._statsWatchers.register(watcher);
  }

  /**
   * Resolves a transaction handle from a flexible resolver shape.
   *
   * @param resolver - A {@link ResolveTransactionShape} describing how to locate the transaction,
   *   or `undefined` to indicate no active transaction.
   * @returns The matching {@link InternalTransaction}, or `undefined` if `resolver` is undefined
   *   (or does not match any active transaction depending on resolver semantics).
   *
   * @remarks
   * - Intended for internal plumbing where APIs may accept either a transaction object,
   *   identifier, or a sentinel indicating “no transaction”.
   */
  resolveTransaction(
    resolver: ResolveTransactionShape | undefined
  ): InternalTransaction | undefined {
    return this._txs.resolve(resolver);
  }

  /**
   * Begins a new transaction.
   *
   * @param options - Optional {@link ITransactionOptions} controlling transaction behavior.
   * @returns An {@link InternalTransaction} representing the opened transaction.
   *
   * @remarks
   * - The returned handle should be used with subsequent read/write operations and then
   *   committed/rolled back by the coordinating layer.
   */
  begin(options?: ITransactionOptions | null | undefined): InternalTransaction {
    return this._txs.begin(options);
  }

  /**
   * Fetches an existing transaction by its identifier.
   *
   * @param transactionId - The binary identifier of the transaction.
   * @returns The {@link InternalTransaction} associated with the identifier.
   *
   * @remarks
   * - Use when resuming/continuing work in a known transaction context.
   * - Behavior for unknown identifiers is implementation-defined (may throw).
   */
  fetch(transactionId: Buffer): InternalTransaction {
    return this._txs.fetch(transactionId);
  }

  /**
   * Clears the database without performing a `reset`. This method:
   * - Deletes all documents and collections
   * - Flushes all pending changes without invoking watcher callbacks
   * - Sets the the database stats `collectionCount` and `documentCount` properties to `0`
   *
   */
  clear(): void {
    this._src.cols.clear();
    this._src.docs.clear();
    this._src.changes.splice(0);
    this._txs.reset();
    this._stats = undefined;
  }

  /**
   * Resets the database. This method:
   * - Deletes all documents and collections
   * - Flushes all pending changes without invoking watcher callbacks
   * - Sets all database stats properties to `0`
   * - Resets the internal change version nonce (assigned to `MetaDocument` instances) to `0`
   */
  reset(): void {
    this.clear();
    this._version = 0;
    this._changeWatchers.clear();
    this._triggers.clear();
    this._pathCache.flush();
    const stats = this._src.stats;
    stats.deletes = 0;
    stats.reads = 0;
    stats.writes = 0;
    stats.noopReads = 0;
    stats.noopDeletes = 0;
    stats.noopWrites = 0;
    this._resetListeners.next();
  }

  /**
   * Enqueues processing of pending document changes on the next microtask tick.
   *
   * This method is called after each atomic mutation (e.g. via `commit`, `batchWrite`)
   * to deliver change notifications to snapshot listeners.
   *
   * Changes are drained from the internal `_src.changes` queue and passed to
   * `processChanges()` within a microtask, ensuring asynchronous and deterministic
   * listener notification timing consistent with Firestore semantics.
   */
  private enqueueChanges(serverTime: Timestamp): void {
    const changes = this._src.changes.splice(0);
    if (changes.length > 0) {
      // Ensure that we're using only triggers assigned when the commit occured.
      // This wouldn't be a problem in a production environment, but could be in a test
      // environment given that unit-tests may perform writes to setup the test and subsequently
      // register triggers which are processed asynchronously following a delay.
      const triggers = Array.from(this._triggers.values());

      queueMicrotask(() => {
        this.processChanges(serverTime, changes, triggers);
      });
    }
  }

  /**
   * Processes document changes and notifies matching snapshot watchers.
   *
   * This method is invoked after atomic write operations that may affect registered
   * `DocumentWatcher`s. Each watcher defines a `path`
   * and `predicate` function to evaluate whether it should be notified of the change.
   *
   * @param changes - The list of MetaDocument instances representing applied document changes.
   *                  Each MetaDocument may represent a create, update, or delete event.
   */
  private processChanges(
    serverTime: Timestamp,
    changes: MetaDocument[],
    triggers: Trigger[]
  ): void {
    this.processChangeWatchers(serverTime, changes);
    // Defer trigger dispatch to a timed macrotask (≥ MIN_LATENCY). For commit N we finish scheduling
    // all snapshot emissions first; triggers then run and any writes they perform become commit N+1.
    // This preserves "nth-generation" ordering: listeners always observe N before N+1 (mirrors prod/emulator timing).
    resolvePromise().then(() => {
      this.processTriggers(triggers, changes);
    });
  }

  /**
   * Notifies change watchers with a normalized change-set.
   *
   * @param serverTime - The commit-time used for the associated changes.
   * @param changes - The per-document meta changes to surface.
   * @param watcher - When provided, only this watcher is invoked and `isInitial` is `true`.
   *                  When omitted, all registered watchers are notified and `isInitial` is `false`.
   *
   * @remarks
   * - The event payload exposes `changes()` which **lazily** materializes a frozen
   *   `DataChangeSet` (path → `MetaDocument`) on first access, avoiding work if
   *   a subscriber never inspects it.
   * - When `watcher` is specified, this method acts as a *priming* call for that
   *   single watcher (used on registration). Otherwise, it broadcasts to all.
   * - The `DataChangeEventArg` object itself is frozen to prevent subscriber mutation.
   */
  private processChangeWatchers(
    serverTime: Timestamp,
    changes: MetaDocument[],
    watcher?: ChangeWatcher
  ): void {
    const isInitial = watcher != undefined;
    let changeSet: DataChangeSet | undefined;
    const arg: DataChangeEventArg = Object.freeze({
      serverTime,
      isInitial,
      changes: () => {
        if (changeSet == undefined) {
          changeSet = {};
          changes.forEach((meta) => {
            (changeSet as DataChangeSet)[meta.path] = meta;
          });
          Object.freeze(changeSet);
        }
        return changeSet;
      },
    });

    if (!isInitial) {
      this._changeWatchers.forEach((w) => {
        w(arg);
      });
    } else {
      watcher(arg);
    }
  }

  /**
   * Dispatches route-based triggers for a batch of document changes.
   *
   * @param triggers - The candidate triggers to evaluate.
   * @param changes - The raw, ordered list of meta-doc changes produced by the commit.
   *
   * @remarks
   * - If multiple operations target the **same document path** within the batch,
   *   only the **last** one is delivered to triggers (coalescing), while preserving
   *   the original ordering of those last occurrences across distinct paths.
   * - Trigger matching uses `matchFirestorePath(route, path)` (Firestore-like wildcards).
   * - Each trigger callback is scheduled via `queueMicrotask` to (a) unwind the
   *   current stack, and (b) isolate subscriber exceptions from the writer.
   * - The `params` map is populated from `{param}` segments of the matched route.
   */
  private processTriggers(triggers: Trigger[], changes: MetaDocument[]): void {
    if (triggers.length === 0) return;

    // Keep only the last operation per path, preserving original ordering of those last ops
    const lastIdxByPath = new Map<string, number>();
    for (let i = 0; i < changes.length; i++)
      lastIdxByPath.set(changes[i].path, i);

    const distinct = changes.filter(
      (m, idx) => lastIdxByPath.get(m.path) === idx
    );

    distinct.forEach((doc) => {
      for (const t of triggers) {
        const parts = matchFirestorePath(t.route, doc.path);
        if (!parts) continue;
        const arg: TriggerEventArg = {
          doc,
          params: {},
        };
        for (const part of parts) {
          if (part.type === 'param') {
            arg.params[(part as ParamPathPart).name] = part.value;
          }
        }
        Object.freeze(arg.params);
        Object.freeze(arg);
        // Invoke via microtask to both unwind the call stack and isolate any subscriber exceptions.
        queueMicrotask(() => t.callback(arg));
      }
    });
  }

  /**
   * Returns a snapshot of all **existing** documents as meta-docs.
   *
   * @returns An array of {@link MetaDocument} for every document with `exists === true`.
   *
   * @remarks
   * - Uses the current {@link serverTime} to materialize meta fields consistently.
   * - Missing documents and structural stubs are **not** included.
   * - Intended to prime watchers or support structural introspection.
   */
  private all(): MetaDocument[] {
    const r: MetaDocument[] = [];
    if (this._src.docs.size > 0) {
      const serverTime = this.serverTime();
      this._src.docs.forEach((d) => {
        if (d.exists) {
          r.push(readMetaDoc(serverTime, d, d));
        }
      });
    }

    return r;
  }
}

/**
 * Represents a logical database collection.
 */
class InternalCollection implements DocumentIterator {
  private readonly _docs: Map<string, MasterDocument> = new Map();
  private _activeDocCount = 0;
  private _leafDocCount = 0;

  readonly parent: MasterDocument;

  private constructor(datasource: Datasource, readonly pathData: PathData) {
    this.parent = MasterDocument.ensure(datasource, pathData.parentPath);
  }

  /**
   * Returns `true` if the collection has 1 or more active documents as immediate children.
   */
  get hasActiveDocs(): boolean {
    return this._activeDocCount > 0;
  }

  /**
   * Returns `true` if the collection has 1 or more active documents at or below it.
   */
  get hasActiveLeafDocs(): boolean {
    return this._leafDocCount > 0;
  }

  static addDoc(
    datasource: Datasource,
    doc: MasterDocument
  ): InternalCollection | undefined {
    // Don't proceed above the root document
    if (doc.pathData.type === 'root') return undefined;

    let col = datasource.cols.get(doc.pathData.parentPath);
    if (col == undefined) {
      col = new InternalCollection(datasource, doc.pathData.parent());
      datasource.cols.set(col.pathData.path, col);
      MasterDocument.addCollection(col);
    }
    col._docs.set(doc.pathData.path, doc);

    return col;
  }

  getDocumentIterator(): IterableIterator<MasterDocument> {
    return this._docs.values();
  }

  incrementLeafCount(): void {
    this._leafDocCount += 1;
    this.parent.incrementLeafCount();
  }

  decrementLeafCount(): void {
    this._leafDocCount -= 1;
    this.parent.decrementLeafCount();
  }

  incrementActiveDocs(): void {
    this._activeDocCount += 1;
    this.incrementLeafCount();
  }

  decrementActiveDocs(): void {
    this._activeDocCount -= 1;
    this.decrementLeafCount();
  }
}

abstract class InternalDocument {
  /**
   * The document commit version (incremented with each write).
   * This is the version of the transaction context within which the document was last updated,
   * and will be the same across all documents updated within a common context.
   */
  abstract readonly version: number;

  /**
   * The server time at the time the document was created.
   */
  abstract readonly createTime: Timestamp;

  /**
   * The server time at the time the document was last updated.
   * This time is common to all documents written within the same transaction context.
   */
  abstract readonly updateTime: Timestamp;

  /**
   * Returns `true` if the document represented by this instance has been deleted from the database,
   * otherwise returns `false`. Necessary to maintain historic document versions in support of
   * read-only transactions with a `readTime` property specified.
   */
  abstract readonly exists: boolean;

  /**
   * The document data.
   */
  abstract readonly data: DocumentData | undefined;
}

/**
 * Represents a database document (both client document data and internal data).
 */
class MasterDocument extends InternalDocument {
  private _version = 0;
  private _leafDocCount = 0;
  private _createTime: Timestamp = Zero;
  private _updateTime: Timestamp = Zero;
  private _exists = false;
  private _data: DocumentData | undefined;
  private _collections = new Set<InternalCollection>();
  /**
   * Historic document data.
   * Used to support read-only transactions with a `readTime` property specified.
   * Note that we do not flush stale `HistoricDocument` snapspots because client-code
   * has dynamic control of the "current" system time via the `serverTime` function passed
   * to the `DataAccessor` constructor, and is consequently able to shift the snapshot scope
   * window at any time.
   */
  private _history: HistoricDocument[] = [];

  readonly parent: InternalCollection | undefined;

  /**
   *
   * @param path The fully-qualified document path.
   */
  private constructor(datasource: Datasource, readonly pathData: PathData) {
    super();
    datasource.docs.set(pathData.path, this);
    this.parent = InternalCollection.addDoc(datasource, this);
  }

  get hasActiveLeafDocs(): boolean {
    return this._leafDocCount > 0;
  }

  get version(): number {
    return this._version;
  }

  get createTime(): Timestamp {
    return this._createTime;
  }

  get updateTime(): Timestamp {
    return this._updateTime;
  }

  get exists(): boolean {
    return this._exists;
  }

  get isRoot(): boolean {
    return this.pathData.path === '';
  }

  get data(): DocumentData | undefined {
    return this._data;
  }

  static docExists(datasource: Datasource, path: string): boolean {
    return datasource.docs.get(path)?.exists === true;
  }

  static ensure(datasource: Datasource, path: string): MasterDocument {
    let master = datasource.docs.get(path);
    if (!master) {
      master = new MasterDocument(
        datasource,
        // throws
        datasource.pathData(path, 'document', 'root')
      );
    }

    return master;
  }

  static get<T extends DocumentData>(
    datasource: Datasource,
    serverTime: Timestamp,
    path: string,
    readTime?: Timestamp
  ): MetaDocument<T> {
    const master = datasource.docs.get(path);
    if (master == undefined)
      return notExistsMetaDoc(
        serverTime,
        // throws
        datasource.pathData(path, 'document'),
        undefined
      );

    if (!readTime) return readMetaDoc(serverTime, master, master);

    return master.getSnapshot(serverTime, readTime);
  }

  /**
   *
   */
  static set<T extends DocumentData>(
    datasource: Datasource,
    version: number,
    serverTime: Timestamp,
    path: string,
    data: T
  ): MetaDocument<T> {
    const master = MasterDocument.ensure(datasource, path);
    data = freezeDocumentData(cloneDocumentData(data));
    const meta = writeMetaDoc<T>(version, serverTime, master, data);

    if (meta.hasChanges) {
      master.pushHistory();
      if (!master.exists) {
        // structure changed: new active doc
        master._createTime = serverTime;
        master.parent?.incrementActiveDocs();
        datasource.invalidateStats();
      }
      master._updateTime = serverTime;
      master._data = data;
      master._exists = true;
      master._version = version;
      incStat(datasource, 'writes');
      datasource.changes.push(meta);
    } else {
      incStat(datasource, 'noopWrites');
    }

    return meta;
  }

  static delete<T extends DocumentData>(
    datasource: Datasource,
    version: number,
    serverTime: Timestamp,
    path: string
  ): MetaDocumentNotExists<T> {
    const master = datasource.docs.get(path);
    if (!master?.exists) {
      incStat(datasource, 'noopDeletes');
      return notExistsMetaDoc(
        serverTime,
        master?.pathData ?? datasource.pathData(path, 'document'),
        master
      );
    }
    // structure changed: an active doc was removed
    const prev = master.pushHistory();
    master._updateTime = serverTime;
    master._data = undefined;
    master._exists = false;
    master._version = version;
    master.parent?.decrementActiveDocs();
    datasource.invalidateStats();
    incStat(datasource, 'deletes');

    const meta = notExistsMetaDoc<T>(
      serverTime,
      master.pathData,
      master,
      readMetaDoc(prev.updateTime, master, prev)
    );
    datasource.changes.push(meta);

    return meta;
  }

  static addCollection(collection: InternalCollection): void {
    collection.parent._collections.add(collection);
  }

  incrementLeafCount(): void {
    this._leafDocCount += 1;
    this.parent?.incrementLeafCount();
  }

  decrementLeafCount(): void {
    this._leafDocCount -= 1;
    this.parent?.decrementLeafCount();
  }

  getSnapshot<T extends DocumentData>(
    serverTime: Timestamp,
    readTime: Timestamp
  ): MetaDocument<T> {
    const readTimeMillis = readTime.toMillis();
    if (readTimeMillis >= this.updateTime.toMillis())
      return readMetaDoc(serverTime, this, this);

    // Enforce the Firestore maximum historic read-time of 60 seconds
    if (serverTime.toMillis() - readTimeMillis > SIXTY_SECONDS)
      return notExistsMetaDoc(serverTime, this.pathData, this);

    for (let i = this._history.length - 1; i >= 0; i--) {
      const historic = this._history[i];
      if (readTimeMillis >= historic.updateTime.toMillis())
        return readMetaDoc(serverTime, this, historic);
    }

    return notExistsMetaDoc(serverTime, this.pathData, this);
  }

  *getCollectionIterator(): IterableIterator<InternalCollection> {
    for (const col of this._collections) {
      yield col;
    }
  }

  private pushHistory(): InternalDocument {
    const prev = stackPeek(this._history);
    if (prev?.version === this.version) return prev;

    const h = new HistoricDocument(this);
    this._history.push(h);

    return h;
  }
}
/**
 * Historic document data.
 * Used to support read-only transactions with a `readTime` property specified.
 */
class HistoricDocument extends InternalDocument {
  readonly version: number;
  readonly createTime: Timestamp;
  readonly updateTime: Timestamp;
  readonly data: DocumentData | undefined;
  readonly exists: boolean;

  constructor(
    /**
     * The active version of the document represented by this instance.
     */
    readonly master: MasterDocument
  ) {
    super();
    this.version = master.version;
    this.createTime = master.createTime;
    this.updateTime = master.updateTime;
    this.exists = master.exists;
    this.data = master.data;
  }
}

/**
 * Constructs a `MetaDocument<T>` from the given internal Firestore document state.
 *
 * Used to materialize a Firestore document snapshot in mock Firestore implementations.
 *
 * - If `version.exists` is `false` and `showMissing` is not explicitly set or
 *   `master.hasActiveLeafDocs` is false, a synthetic "not exists" snapshot is returned.
 * - Otherwise, returns a frozen `MetaDocument` representing the latest known version.
 *
 * @template T - The type of the document's data.
 *
 * @param serverTime - The current "read time" used for the snapshot. Typically the server time
 *   associated with the read request.
 * @param master - The canonical document entry in the index, including path and leaf document status.
 * @param version - The internal document version to be materialized. May represent a missing document.
 * @param showMissing - If `true`, returns a snapshot even if the document does not exist, provided the parent
 *   has active leaf documents. Defaults to `false`.
 *
 * @returns A frozen `MetaDocument<T>` representing the snapshot at `serverTime`. If the document does not
 *   exist and `showMissing` is `false` (or `hasActiveLeafDocs` is false), a synthetic "not exists" document is returned.
 *
 * @remarks
 * In the Admin SDK, `showMissing` is only ever set in `CollectionReference.listDocuments()`.
 * There is no requirement to support historic missing document state in earlier snapshotted versions.
 */
function readMetaDoc<T extends DocumentData>(
  serverTime: Timestamp,
  master: MasterDocument,
  version: InternalDocument,
  showMissing = false
): MetaDocument<T> {
  if (!version.exists && !(showMissing && master.hasActiveLeafDocs))
    return notExistsMetaDoc(serverTime, master.pathData, master);

  // Reference a snapshot, because if `version` is the master it may change.
  const data = version.data as T | undefined;

  function cloneData(): T {
    return cloneDocumentData(data) as T;
  }

  const result: MetaDocument<T> = {
    data,
    exists: version.exists,
    id: master.pathData.id,
    parent: master.pathData.parentPath,
    path: master.pathData.path,
    serverTime,
    createTime: version.createTime,
    updateTime: version.updateTime,
    version: version.version,
    hasChanges: false,
    cloneData,
  };

  return Object.freeze(result);
}
/**
 * Constructs a `MetaDocument<T>` representing the result of a document write operation.
 *
 * This function simulates a successful write, producing a snapshot with `exists = true` and the provided `data`.
 *
 * If the new data differs from the existing `master` data, the snapshot is marked with `hasChanges = true`, and
 * a `previous` snapshot is included referencing the prior state.
 *
 * @template T - The type of the document's data.
 *
 * @param version - The new logical version number assigned to the document.
 * @param serverTime - The server timestamp to use for the document's `updateTime` (and possibly `createTime`).
 * @param master - The canonical document entry before the write. May represent an existing or non-existent document.
 * @param data - The new document data to be written.
 *
 * @returns A frozen `MetaDocument<T>` representing the document after the write. Includes a `.previous` field
 *   if the write caused changes to the data.
 */
function writeMetaDoc<T extends DocumentData>(
  version: number,
  serverTime: Timestamp,
  master: MasterDocument,
  data: T
): MetaDocument<T> {
  function cloneData(): T {
    return cloneDocumentData(data);
  }
  const result: MetaDocument<T> = {
    data,
    exists: true,
    id: master.pathData.id,
    parent: master.pathData.parentPath,
    path: master.pathData.path,
    serverTime,
    createTime: master.exists ? master.createTime : serverTime,
    updateTime: serverTime,
    version,
    hasChanges: !deepDocumentDataEqual(data, master.data),
    cloneData,
  };

  if (result.hasChanges) {
    (result as Mutable<MetaDocument<T>>).previous = readMetaDoc(
      master.updateTime,
      master,
      master
    );
  }

  return Object.freeze(result);
}
/**
 * Constructs a `MetaDocumentNotExists<T>` representing a non-existent document snapshot.
 *
 * This is used when a document does not exist at the time of a read. If a `previousVersion` is provided
 * and it represents an existing document, the result will be marked with `hasChanges = true` and will include
 * the previous version in `.previous` to allow change tracking (e.g., for triggers or differential queries).
 *
 * @template T - The type of the document's data (always `undefined` in this case).
 *
 * @param serverTime - The "read time" for the snapshot, typically the server timestamp associated with the read.
 * @param pathData - Path metadata identifying the document (its path and ID).
 * @param previousVersion - Optional prior document version. If it was an existing document, this result will be marked
 *   with `hasChanges = true` and will carry the frozen `previousVersion` as `.previous`.
 *
 * @returns A frozen `MetaDocumentNotExists<T>` representing a non-existent document snapshot at the given time.
 */
function notExistsMetaDoc<T extends DocumentData>(
  serverTime: Timestamp,
  pathData: PathData,
  master: MasterDocument | undefined,
  previousVersion?: MetaDocument<T>
): MetaDocumentNotExists<T> {
  function cloneData(): undefined {
    return undefined;
  }

  const result: MetaDocumentNotExists<T> = {
    data: undefined,
    exists: false,
    hasChanges: previousVersion?.exists === true,
    id: pathData.id,
    parent: pathData.parentPath,
    path: pathData.path,
    serverTime,
    updateTime: master?.updateTime ?? Zero,
    version: master?.version ?? 0,
    cloneData,
  };
  if (result.hasChanges) {
    (result as Mutable<MetaDocument<T>>).previous =
      Object.freeze(previousVersion);
  }

  return Object.freeze(result);
}

type PathErrorStatus =
  | Status.ALREADY_EXISTS
  | Status.NOT_FOUND
  | Status.FAILED_PRECONDITION;
type SimpleErrorStatus = Status.INTERNAL;

function createError(status: PathErrorStatus, path: string): GoogleError;
function createError(status: SimpleErrorStatus): GoogleError;
function createError(
  status: SimpleErrorStatus,
  cause: ErrorOptions
): GoogleError;
function createError(status: Status, arg?: string | ErrorOptions): GoogleError {
  let message: string;
  switch (status) {
    case Status.ALREADY_EXISTS:
      message = `Document already exists: ${arg}`;
      break;

    case Status.NOT_FOUND:
      message = `Document does not exist: ${arg}`;
      break;

    case Status.FAILED_PRECONDITION:
      message = `Failed precondition: ${arg}`;
      break;

    default:
      message =
        ((arg as ErrorOptions).cause as Error)?.message ?? 'Unexpected error';
      break;
  }
  const options = arg && typeof arg !== 'object' ? { cause: arg } : undefined;

  return googleError(status, message, options?.cause);
}

export function deepDocumentDataEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // Handle null
  if (a === null || b === null) return a === b;

  // Type mismatch
  if (typeof a !== typeof b) return false;

  // Handle arrays
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepDocumentDataEqual(v, b[i]));
  }

  // Handle objects with `isEqual()` method
  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    typeof (a as { isEqual?: unknown }).isEqual === 'function' &&
    typeof (b as { isEqual?: unknown }).isEqual === 'function'
  ) {
    return (a as { isEqual(other: unknown): boolean }).isEqual(b);
  }

  // Handle plain objects
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;

    return aKeys.every((key) =>
      deepDocumentDataEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )
    );
  }

  // Fallback for primitives
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function applyTransformers(
  serverTime: Timestamp,
  target: DocumentData,
  previous: DocumentData
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (obj: any, prev: any) => {
    if (isImmutableFirestoreType(obj)) return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];

      if (typeof val === 'function') {
        const ctx: FieldTransformContext = {
          serverTime,
          fieldValue: prev?.[key],
        };
        const result = val(ctx);
        obj[key] = result;
      } else if (
        val !== null &&
        typeof val === 'object' &&
        !Array.isArray(val)
      ) {
        visit(val, prev?.[key]);
      }
    }
  };

  visit(target, previous);
}

/**
 * Normalizes a POJO to match Firestore persistence behavior:
 * - Removes undefined values
 * - Preserves arrays (even if empty)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeFirestoreData(input: any): any {
  if (input === null) return input;

  if (Array.isArray(input)) {
    return input.map(normalizeFirestoreData);
  }

  if (isImmutableFirestoreType(input)) {
    if (isVectorLikeShallow(input)) {
      const MAX_LENGTH = 2048;
      const values = peekVectorValue(input);
      if (values.length === 0) {
        throw googleError(
          Status.INVALID_ARGUMENT,
          'FieldValue.vector() must contain at least one element.'
        );
      }
      if (values.length > MAX_LENGTH) {
        throw googleError(
          Status.INVALID_ARGUMENT,
          `FieldValue.vector() length ${values.length} exceeds maximum 2048.`
        );
      }

      values.forEach((v, i) => {
        let msg: string | undefined;

        if (Array.isArray(v)) {
          msg = `FieldValue.vector() must be a flat array of numbers; found a nested array at index ${i}.`;
        }

        if (!msg && typeof v !== 'number') {
          const kind =
            v === null
              ? 'null'
              : v === undefined
              ? 'undefined'
              : Array.isArray(v)
              ? 'array'
              : typeof v;
          msg = `FieldValue.vector() elements must be numbers; found ${kind} at index ${i}.`;
        }

        if (!msg && Number.isNaN(v)) {
          msg = `FieldValue.vector() elements must be finite numbers; NaN is not allowed (index ${i}).`;
        }

        if (msg) {
          throw googleError(Status.INVALID_ARGUMENT, msg);
        }
      });
    }
    return input;
  }

  if (isByteArrayLike(input)) return cloneByteArray(input);

  if (typeof input === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      // Skip `undefined` but not `null`
      if (value === undefined) continue;
      // Capture `null` field values
      const normalized = value !== null ? normalizeFirestoreData(value) : value;
      result[key] = normalized;
    }

    return result;
  }

  return input;
}

/**
 * Merges changes from the `NormalizedSet` operation into `current` and returns the result.
 */
function mergeInto(op: NormalizedSet, current: DocumentData): DocumentData {
  const update = cloneDocumentData(op.data);

  if (op.merge === 'root') return update;

  const target = cloneDocumentData(current);

  function mergeRecursively(
    target: DocumentData,
    source: DocumentData,
    deepMerge: boolean
  ): void {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'function') {
        target[key] = value;
        continue;
      }

      const existing = target[key];

      if (deepMerge && isPlainObject(value) && isPlainObject(existing)) {
        // Both are maps: recurse
        mergeRecursively(existing as DocumentData, value as DocumentData, true);
      } else {
        // Replace scalar, array, or incompatible type (or shallow merge)
        target[key] = value;
      }
    }
  }

  mergeRecursively(target, update, op.merge === 'node');

  return target;
}

function timestampsEqual(
  x: Timestamp | Timestamp,
  y: Timestamp | Timestamp
): boolean {
  return x.seconds === y.seconds && x.nanoseconds === y.nanoseconds;
}

function bumpReads(datasource: Datasource, count: number): void {
  if (count > 0) {
    datasource.stats.reads += count;
  } else {
    datasource.stats.noopReads += 1; // minimum-1 rule for empty read ops
  }
}

function incStat(datasource: Datasource, field: keyof OperationStats): void {
  datasource.stats[field] += 1;
}

//#region TransactionManager

const MAX_TX_AGE_MILLIS = 270_000;
const MAX_TX_IDLE_MILLIS = 60_000;

export interface IReadOnly {
  /** ReadOnly readTime */
  readTime?: Timestamp | null | undefined;
}

export interface IReadWrite {
  /** ReadWrite retryTransaction */
  retryTransaction?: Buffer | null;
}

export interface ITransactionOptions {
  /** TransactionOptions readOnly */
  readOnly?: IReadOnly | null | undefined;

  /** TransactionOptions readWrite */
  readWrite?: IReadWrite | null | undefined;
}

export interface ITransactionWrites {
  writes: NormalizedWrite[];
  mode: WriteMode;
}

/**
 * Represents a base64-encoded transaction ID.
 */
export type TransactionId = string;

export type TransactionType = 'readOnly' | 'readWrite';

export enum TransactionStatus {
  Active = 0,
  Committed,
  Aborted,
}

export class InternalTransaction {
  private _status = TransactionStatus.Active;
  private _readTime: Timestamp | undefined;
  private _created: number;
  private _touched: number;
  private readonly _accessor: DataAccessor;
  private readonly _map: Map<TransactionId, InternalTransaction>;
  private readonly _readSet: Set<string>;

  readonly id: Buffer;
  readonly sId: string;
  constructor(
    accessor: DataAccessor,
    map: Map<TransactionId, InternalTransaction>,
    readonly type: TransactionType,
    readTime: Timestamp | undefined,
    readonly retryKey: string | undefined
  ) {
    this._accessor = accessor;
    this._map = map;
    this._readTime = readTime;
    // 256-bit ID;
    this.id = getRandomValues(Buffer.alloc(32));
    this.sId = toBase64Id(this.id);
    this._created = accessor.serverTime().toMillis();
    this._touched = this._created;
    this._readSet = new Set();
  }

  get status(): TransactionStatus {
    return this._status;
  }

  get readTime(): Timestamp | undefined {
    return this._readTime;
  }

  static ensureReadTime(
    accessor: DataAccessor,
    transaction: InternalTransaction | undefined
  ): Timestamp {
    let ts: Timestamp;
    if (transaction) {
      ts =
        transaction.readTime ??
        (transaction._readTime = accessor.serverTime() as Timestamp);
    } else {
      ts = accessor.serverTime() as Timestamp;
    }

    return ts;
  }

  commit(writes?: ITransactionWrites): NormalizedWriteResult {
    if (this.type === 'readOnly' && writes) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        'Cannot write in a read-only transaction.'
      );
    }
    // Snapshot isolation: any change to a previously-read doc after readTime aborts.
    if (
      (writes?.writes.length ?? 0) > 0 &&
      this.readTime &&
      this._readSet.size > 0
    ) {
      const readTimeMs = this.readTime.toMillis();

      for (const path of this._readSet) {
        const meta = this._accessor.getDoc(path); // MetaDocument (always defined)
        const changedMs = meta.updateTime.toMillis(); // 0 if never existed

        if (changedMs > readTimeMs) {
          // Distinguish deletion vs creation/update for a more helpful message
          const kind = meta.exists ? 'creation/update' : 'deletion';
          throw googleError(
            Status.ABORTED,
            `Transaction aborted due to a concurrent ${kind} of path'. The document changed after it was read; please retry the transaction.`
          );
        }
      }
    }

    try {
      let result: NormalizedWriteResult;
      if (writes) {
        result = this._accessor.batchWrite(writes.writes, writes.mode);
      } else {
        result = { results: [], serverTime: this._accessor.serverTime() };
      }
      this.complete(true);

      return result;
    } catch (e) {
      this.rollback();
      throw e;
    }
  }

  rollback(): void {
    this.complete(false);
  }

  registerRead(doc: MetaDocument): void {
    this._readSet.add(doc.path);
  }

  isTimedOut(now: number): boolean {
    return (
      now - this._touched >= MAX_TX_IDLE_MILLIS ||
      now - this._created >= MAX_TX_AGE_MILLIS
    );
  }

  touch(): void {
    this._touched = this._accessor.serverTime().toMillis();
  }

  private complete(commit: boolean): void {
    if (this._status !== TransactionStatus.Active) {
      throw googleError(
        Status.ABORTED,
        `Transaction ${this.sId} already completed.`
      );
    }
    this.setStatus(
      commit ? TransactionStatus.Committed : TransactionStatus.Aborted
    );
  }

  private setStatus(status: TransactionStatus): void {
    this._status = status;
    if (status === TransactionStatus.Committed) {
      this._map.delete(this.sId);
    }
  }
}

export interface ResolveTransactionShape {
  newTransaction?: ITransactionOptions | null | undefined;
  transaction?: Buffer | null | undefined;
}

class TransactionManager {
  private _accessor: DataAccessor;
  private _transactions = new Map<TransactionId, InternalTransaction>();

  constructor(accessor: DataAccessor) {
    this._accessor = accessor;
  }

  resolve(
    resolver: ResolveTransactionShape | undefined
  ): InternalTransaction | undefined {
    if (resolver?.transaction) {
      return this.fetch(resolver.transaction);
    } else if (resolver?.newTransaction) {
      return this.begin(resolver.newTransaction);
    }

    return undefined;
  }

  begin(options: ITransactionOptions | null | undefined): InternalTransaction {
    // Validate input shape first.
    validateTransactionOptions(options);

    // Firestore defaults to READ-WRITE if options are undefined.
    const type: TransactionType = options?.readOnly ? 'readOnly' : 'readWrite';

    let readTime: Timestamp | undefined;
    let retryKey: string | undefined;

    if (type === 'readOnly') {
      // Read-only transactions may pin a readTime.
      if (options?.readOnly?.readTime) {
        readTime = options.readOnly.readTime;
      }
    } else {
      // READ-WRITE: optional retry of a prior aborted attempt.
      const retryBytes = options?.readWrite?.retryTransaction;
      if (retryBytes && retryBytes.length > 0) {
        retryKey = retryBytes.toString('base64');

        // Validate the referenced attempt:
        // - must still be known (i.e., recent; not flushed)
        // - must be a READ-WRITE attempt
        // - must have ABORTED (not committed)
        const base = this._transactions.get(retryKey);
        if (
          !base ||
          base.type !== 'readWrite' ||
          base.status !== TransactionStatus.Aborted
        ) {
          throw googleError(
            Status.INVALID_ARGUMENT,
            'Invalid retryTransaction.'
          );
        }
        // Note: We don't copy/pin a readTime for read-write; snapshot is established on first read.
        // The retry token is not "consumed" here; it may be referenced again within its lifetime.
      }
    }

    const tx = new InternalTransaction(
      this._accessor,
      this._transactions,
      type,
      readTime,
      retryKey
    );
    this._transactions.set(tx.sId, tx);

    return tx;
  }

  fetch(transactionId: Buffer): InternalTransaction {
    const tx = this._transactions.get(toBase64Id(transactionId));

    if (tx == undefined) {
      throw googleError(Status.INVALID_ARGUMENT, 'Unknown transaction.');
    }

    tx.touch();

    return tx;
  }

  flush(): void {
    const now = Date.now();
    this.finalizeAll(
      Array.from(this._transactions.values()).filter((tx) => tx.isTimedOut(now))
    );
  }

  reset(): void {
    this.finalizeAll(Array.from(this._transactions.values()));
  }

  private finalizeAll(txs: InternalTransaction[]): void {
    txs.forEach((tx) => {
      if (tx.status === TransactionStatus.Active) {
        tx.rollback();
      }
      this._transactions.delete(tx.sId);
    });
  }
}

function toBase64Id(id: Buffer): string {
  return id.toString('base64');
}

export function validateTransactionOptions(
  options: ITransactionOptions | null | undefined
): void {
  if (options == undefined) return;

  assertEitherRequired(
    'readOnly',
    options.readOnly,
    'readWrite',
    options.readWrite
  );
  assertMutuallyExclusive(
    'readOnly',
    options.readOnly,
    'readWrite',
    options.readWrite
  );
  assertInstanceOf(
    'readonly.retryTransaction',
    'Buffer',
    options.readWrite?.retryTransaction,
    (v) => Buffer.isBuffer(v),
    false
  );
  assertNotEmpty(
    'readonly.retryTransaction',
    options.readWrite?.retryTransaction,
    false
  );
}

//#endregion

function assertWithinSizeLimit(path: string, data: DocumentData): void {
  if (!isDocSizeWithinLimit(path, data)) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      'Maximum entity size is 1048576 bytes'
    );
  }
}

function assertMaxDepth(input: DocumentData): void {
  const MAX_MAP_DEPTH = 20;
  let depth = -1;
  function inc(fn: () => void): void {
    depth += 1;
    if (depth > MAX_MAP_DEPTH) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `Property ${keys[keys.length - 1]} contains an invalid nested entity.`
      );
    }

    fn();
    depth -= 1;
  }

  const keys: (string | number)[] = [];
  function walk(f: unknown): void {
    if (
      !(
        f == undefined || // `==` includes `null` values
        typeof f !== 'object' ||
        Object.prototype.toString.call(f) === '[object String]' ||
        Object.prototype.toString.call(f) === '[object Number]' ||
        Object.prototype.toString.call(f) === '[object Boolean]' ||
        isImmutableFirestoreType(f) ||
        isByteArrayLike(f)
      )
    ) {
      if (Array.isArray(f)) {
        inc(() => {
          for (let i = 0; i < f.length; i++) {
            walk(f[i]);
          }
        });
      } else if (isPlainObject(f)) {
        inc(() => {
          for (const key in f) {
            keys.push(key);
            if (Object.prototype.hasOwnProperty.call(f, key)) {
              walk((f as Record<string, unknown>)[key]);
            }
            keys.pop();
          }
        });
      }
    }
  }
  walk(input);
}

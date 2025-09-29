import { DocumentData } from 'firebase-admin/firestore';
import {
  DataAccessor,
  DatabaseStats,
  DocumentQuery,
  MergeGranularity,
  MetaDocument,
  MetaDocumentExists,
  NormalizedDelete,
  NormalizedSet,
  NormalizedWrite,
  NormalizedWriteResult,
  Trigger,
  WriteMode,
} from './_internal/data-accessor.js';
import { StructuralDatabase } from './structural-database.js';

/**
 * A convenience shape for bulk `set` operations that pairs a document
 * path with its strongly-typed data.
 *
 * @template T - Firestore document data type.
 */
export interface DatabaseDocument<T extends DocumentData = DocumentData> {
  /** Canonical document path, e.g. `"col/doc/sub/doc2"`. */
  path: string;
  /** The document data to write. */
  data: T;
}

/**
 * Thin, synchronous façade over the internal {@link DataAccessor} that
 * exposes ergonomic helpers for tests and tools that interact with the
 * in-memory database directly (bypassing Admin SDK objects).
 *
 * Notes:
 * - All write operations are executed atomically (single commit) and
 *   use {@link WriteMode.Atomic}.
 * - Trigger registration/dispatch is delegated to the underlying {@link DataAccessor}.
 * - Methods returning `MetaDocument` / `MetaDocumentExists` include metadata such as
 *   update times and existence state to aid fidelity testing.
 */
export class DatabaseDirect {
  private _accessor: DataAccessor;

  /**
   * Create a direct database adapter bound to an existing {@link DataAccessor}.
   *
   * @param accessor - The backing in-memory data accessor.
   */
  constructor(accessor: DataAccessor) {
    this._accessor = accessor;
  }

  /**
   * Register a low-level trigger callback that will be invoked for document
   * changes produced by atomic commits.
   *
   * @param trigger - Trigger descriptor.
   * @returns A function that unregisters the trigger when called.
   */
  registerTrigger(trigger: Trigger): () => void {
    return this._accessor.registerTrigger(trigger);
  }

  /**
   * Retrieve aggregate database statistics (document count, bytes, etc.).
   *
   * @returns Current {@link DatabaseStats}.
   */
  stats(): DatabaseStats {
    return this._accessor.getStats();
  }

  /**
   * Remove all user documents from the database, preserving indexes and
   * internal structures.
   */
  clear(): void {
    this._accessor.clear();
  }

  /**
   * Reset the database to a pristine state, clearing documents and internal
   * state (timestamps, counters) as defined by the accessor.
   */
  reset(): void {
    this._accessor.reset();
  }

  /**
   * Snapshot all **existing** documents as an ordered array of meta records.
   *
   * @returns Array of {@link MetaDocumentExists}.
   */
  toMetaArray(): MetaDocumentExists[] {
    return this._accessor.toMetaArray();
  }

  /**
   * Snapshot all **existing** documents keyed by document path.
   *
   * @returns Map of path ⇒ {@link MetaDocumentExists}.
   */
  toMetaMap(): Record<string, MetaDocumentExists> {
    return this._accessor.toMetaMap();
  }

  /**
   * Snapshot all **existing** documents as plain data keyed by document path.
   *
   * @returns Map of path ⇒ {@link DocumentData}.
   */
  toMap(): Record<string, DocumentData> {
    return this._accessor.toMap();
  }

  /**
   * Produce a structural view of the database suitable for serialization
   * or coarse-grained merges.
   *
   * @returns A {@link StructuralDatabase} snapshot.
   */
  toStructuralDatabase(): StructuralDatabase {
    return this._accessor.toStructuralDatabase();
  }

  /**
   * Import/merge a {@link StructuralDatabase} into this database.
   *
   * @param src - Source structural snapshot.
   * @param merge - Merge granularity; defaults to `'root'`.
   * @returns A normalized result describing applied writes.
   */
  fromStructuralDatabase(
    src: StructuralDatabase,
    merge: MergeGranularity = 'root'
  ): NormalizedWriteResult {
    return this._accessor.fromStructuralDatabase(src, merge);
  }

  /**
   * List direct child collection IDs of a document.
   *
   * @param documentPath - Parent document path.
   * @returns Array of collection IDs (no paths).
   */
  listCollectionIds(documentPath: string): string[] {
    return this._accessor.listCollectionIds(documentPath);
  }

  /**
   * List documents within a collection.
   *
   * @param collectionPath - Collection path.
   * @param showMissing - If `true`, include placeholders for missing
   *   documents (non-existent meta entries).
   * @returns Array of {@link MetaDocument} (existing or missing).
   */
  listDocuments(collectionPath: string, showMissing: boolean): MetaDocument[] {
    return this._accessor.listDocuments(collectionPath, showMissing);
  }

  /**
   * Execute an in-memory query over existing documents.
   *
   * @template T - Result document data type.
   * @param q - A normalized {@link DocumentQuery}.
   * @returns Array of existing meta documents that match the query.
   */
  query<T extends DocumentData = DocumentData>(
    q: DocumentQuery<T>
  ): MetaDocumentExists<T>[] {
    return this._accessor.query(q);
  }

  /**
   * Get a single document by path, returning an existing or missing meta
   * record.
   *
   * @template T - Document data type.
   * @param documentPath - Canonical document path.
   * @returns {@link MetaDocument} describing existence and data.
   */
  getDocument<T extends DocumentData = DocumentData>(
    documentPath: string
  ): MetaDocument<T> {
    return this._accessor.getDoc(documentPath);
  }

  /**
   * Set (create or replace) a single document at the given path.
   * Equivalent to a normalized `'set'` with `merge: 'root'`.
   *
   * @template T - Document data type.
   * @param documentPath - Document path.
   * @param data - Document payload to write.
   * @returns The resulting {@link MetaDocument}.
   */
  setDocument<T extends DocumentData = DocumentData>(
    documentPath: string,
    data: T
  ): MetaDocument<T> {
    const op: NormalizedSet = {
      type: 'set',
      path: documentPath,
      data,
      merge: 'root',
    };

    return this.singleWriteOp(op);
  }

  /**
   * Atomically set multiple documents. Each item is written as a `'set'`
   * with `merge: 'root'`.
   *
   * @template T - Document data type.
   * @param documents - One or more `{ path, data }` tuples.
   * @returns Resulting {@link MetaDocument} array, in the same order.
   */
  batchSet<T extends DocumentData = DocumentData>(
    ...documents: DatabaseDocument<T>[]
  ): MetaDocument<T>[] {
    return this._accessor.batchWrite(
      documents.map<NormalizedSet>((d) => ({
        type: 'set',
        merge: 'root',
        ...d,
      })),
      WriteMode.Atomic
    ).results as MetaDocument<T>[];
  }

  /**
   * Atomically delete multiple documents.
   *
   * @template T - Document data type (for return shape only).
   * @param paths - One or more document paths to delete.
   * @returns Resulting {@link MetaDocument} array, in the same order.
   */
  batchDelete<T extends DocumentData = DocumentData>(
    ...paths: string[]
  ): MetaDocument<T>[] {
    return this._accessor.batchWrite(
      paths.map<NormalizedDelete>((path) => ({
        type: 'delete',
        path,
      })),
      WriteMode.Atomic
    ).results as MetaDocument<T>[];
  }

  /**
   * Atomically apply a heterogeneous set of writes where each entry is either:
   * - a `{ path, data }` object → normalized to a `'set'` with `merge: 'root'`, or
   * - a `string` path → normalized to a `'delete'`.
   *
   * @template T - Document data type (for return shape only).
   * @param writes - `(DatabaseDocument | string)[]` describing mixed writes.
   * @returns Resulting {@link MetaDocument} array, in the same order.
   */
  batchWrite<T extends DocumentData = DocumentData>(
    writes: (DatabaseDocument | string)[]
  ): MetaDocument<T>[] {
    return this._accessor.batchWrite(
      writes.map<NormalizedWrite>((value) => {
        return typeof value === 'string'
          ? {
              type: 'delete',
              path: value,
            }
          : {
              type: 'set',
              merge: 'root',
              ...value,
            };
      }),
      WriteMode.Atomic
    ).results as MetaDocument<T>[];
  }

  /**
   * Delete a single document by path.
   *
   * @template T - Document data type (for return shape only).
   * @param documentPath - Document path to delete.
   * @returns The resulting {@link MetaDocument}.
   */
  deleteDocument<T extends DocumentData = DocumentData>(
    documentPath: string
  ): MetaDocument<T> {
    const op: NormalizedDelete = {
      type: 'delete',
      path: documentPath,
    };

    return this.singleWriteOp(op);
  }

  /**
   * Helper to execute a single normalized write as an atomic batch and
   * return its sole {@link MetaDocument} result.
   *
   * @template T - Document data type.
   * @param op - A normalized write operation.
   * @returns The resulting {@link MetaDocument}.
   * @internal
   */
  private singleWriteOp<T extends DocumentData>(
    op: NormalizedWrite
  ): MetaDocument<T> {
    return this._accessor.batchWrite([op], WriteMode.Atomic)
      .results[0] as MetaDocument<T>;
  }
}

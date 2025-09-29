import { DocumentData } from 'firebase-admin/firestore';

/**
 * A mapping of **document IDs** → {@link StructuralDocument} within a single collection.
 *
 * Keys must be document IDs (no slashes).
 *
 * @example
 * const users: StructuralCollection = {
 *   alice: { data: { name: 'Alice' } },
 *   bob:   { data: { name: 'Bob' } },
 * };
 */
export type StructuralCollection = Record<string, StructuralDocument>;

/**
 * A mapping of **collection IDs** → {@link StructuralCollection}.
 *
 * Used to represent:
 *  - root-level collections in a database; and
 *  - subcollections nested under a document.
 *
 * Keys must be collection IDs (no slashes).
 *
 * @example
 * const root: StructuralCollectionGroup = {
 *   users: {
 *     alice: { data: { name: 'Alice' } },
 *   },
 *   products: {
 *     p1: { data: { sku: 'ABC-123' } },
 *   },
 * };
 */
export type StructuralCollectionGroup = Record<string, StructuralCollection>;

/**
 * Structural snapshot of the entire database, represented as a
 * {@link StructuralCollectionGroup} at the root.
 *
 * This is the shape consumed/produced by helpers such as
 * `toStructuralDatabase()` and `fromStructuralDatabase()`.
 *
 * @example
 * const db: StructuralDatabase = {
 *   users: {
 *     alice: {
 *       data: { name: 'Alice' },
 *       collections: {
 *         posts: {
 *           post1: { data: { title: 'Hello' } },
 *         },
 *       },
 *     },
 *   },
 * };
 */
export type StructuralDatabase = StructuralCollectionGroup;

/**
 * Structural representation of a single Firestore-like document.
 *
 * Semantics:
 * - If `data` is omitted, the document is considered **missing/non-existent**
 *   (but may still host subcollections), mirroring Firestore behavior.
 * - If `collections` is omitted, the document has no subcollections.
 *
 * This shape enables round-trippable import/export of database content
 * without requiring live Admin SDK objects.
 */
export interface StructuralDocument {
  /**
   * Subcollections nested under this document, keyed by collection ID.
   */
  collections?: StructuralCollectionGroup;

  /**
   * The document's stored fields. When omitted, the document is treated
   * as non-existent while still allowing `collections`.
   */
  data?: DocumentData;
}

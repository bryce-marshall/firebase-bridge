import { DatabaseStats } from './_internal/data-accessor.js';

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
export interface FirestoreMockStats extends DatabaseStats {
  /**
   * The database ID.
   */
  databaseId: string;
}

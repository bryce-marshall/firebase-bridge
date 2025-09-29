import { Status } from 'google-gax';
import { DataAccessor, DatabaseConfig } from './data-accessor.js';
import { googleError } from './functions/google-error.js';

/**
 * Represents a single pooled in-memory Firestore database instance.
 *
 * @typeParam TMessage - The message type that the host will process.
 */
export class PooledDatabase<THost = unknown> {
  /** The underlying data accessor for database operations. */
  readonly accessor: DataAccessor;

  /**
   * The host responsible for managing this pooled database instance.
   * Hosts receive all messages broadcast by the {@link DatabasePool}.
   */
  readonly host: THost;

  /**
   * Constructs a new pooled database instance.
   *
   * @param config - The configuration used for database construction.
   * @param host - The host associated with the pooled instance.
   */
  constructor(config: DatabaseConfig, host: THost) {
    this.accessor = new DataAccessor(config);
    this.host = host;
  }
}

/**
 * The internal mapping of database IDs to pooled database instances for a given project.
 * @internal
 */
type DatabaseMap<THost> = Map<string, PooledDatabase<THost>>;

/**
 * Manages a pool of in-memory Firestore database instances, organized by project ID and database ID.
 *
 * - Supports multiple projects and multiple databases per project.
 * - Associates each database instance with a host, which can receive broadcast messages.
 * - Prevents accidental overwrite of existing databases.
 * - Provides efficient creation, deletion, and lookup operations for mock databases.
 *
 * @typeParam TMessage - The type of message that can be broadcast to database hosts.
 */
export class DatabasePool<THost = unknown> {
  /**
   * The underlying two-level map of project ID → (database ID → PooledDatabase).
   * @internal
   */
  private readonly _pool = new Map<string, DatabaseMap<THost>>();

  /**
   * Constructs a new DatabasePool with a given default configuration for all databases.
   *
   * @param _config - The configuration to use for all databases created via this pool.
   */
  constructor(private readonly _config: DatabaseConfig) {}

  /**
   * Checks if a database exists for the given project and database IDs.
   *
   * @param projectId - The logical project ID.
   * @param databaseId - The logical database ID.
   * @returns `true` if the database exists, otherwise `false`.
   */
  exists(projectId: string, databaseId: string): boolean {
    return this.get(projectId, databaseId) != undefined;
  }

  /**
   * Creates a new in-memory database instance for the specified project and database IDs.
   *
   * @param projectId - The logical project ID.
   * @param databaseId - The logical database ID.
   * @param host - The host object to associate with the new database.
   * @returns The newly created {@link PooledDatabase} instance.
   * @throws {Error} If a database with the same project and database ID already exists in the pool.
   */
  create(
    projectId: string,
    databaseId: string,
    host: THost
  ): PooledDatabase<THost> {
    let inner = this._pool.get(projectId);
    if (inner == undefined) {
      inner = new Map();
      this._pool.set(projectId, inner);
    } else if (inner.has(databaseId)) {
      throw new Error(
        `The database "${projectId}/${databaseId}" already exists.`
      );
    }

    const result = new PooledDatabase(this._config, host);
    inner.set(databaseId, result);

    return result;
  }

  /**
   * Deletes a database instance from the pool for the given project and database IDs.
   *
   * - If the project has no remaining databases after deletion, it is removed from the pool.
   *
   * @param projectId - The logical project ID.
   * @param databaseId - The logical database ID.
   * @returns `true` if the database was found and deleted, otherwise `false`.
   */
  delete(projectId: string, databaseId: string): boolean {
    const inner = this._pool.get(projectId);
    if (!inner || !inner.delete(databaseId)) return false;

    if (inner.size === 0) {
      this._pool.delete(projectId);
    }

    return true;
  }

  /**
   * Retrieves a pooled database instance for the specified project and database IDs, if it exists.
   *
   * @param projectId - The logical project ID.
   * @param databaseId - The logical database ID.
   * @returns The {@link PooledDatabase} instance, or `undefined` if not found.
   */
  get(
    projectId: string,
    databaseId: string
  ): PooledDatabase<THost> | undefined {
    return this._pool.get(projectId)?.get(databaseId);
  }

  /**
   * Retrieves a pooled database instance for the specified project and database IDs, asserting it exists.
   *
   * @param projectId - The logical project ID.
   * @param databaseId - The logical database ID.
   * @returns The {@link PooledDatabase} instance.
   * @throws {Error} If the database does not exist.
   */
  getWithAssert(projectId: string, databaseId: string): PooledDatabase<THost> {
    const result = this.get(projectId, databaseId);
    if (!result)
      throw googleError(
        Status.NOT_FOUND,
        `The database "${projectId}/${databaseId}" does not exist.`
      );

    return result;
  }

  /**
   * Invokes `callback` once for each active host in the pool.
   *
   * @param message - The message to broadcast to all database hosts.
   */
  forEach(callback: (host: THost) => void): void {
    const targets: THost[] = [];
    for (const project of this._pool.values()) {
      for (const host of project.values()) {
        targets.push(host.host);
      }
    }

    for (const host of targets) {
      callback(host);
    }
  }
}

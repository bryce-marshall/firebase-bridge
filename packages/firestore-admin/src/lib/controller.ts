import { Firestore, Settings, Timestamp } from 'firebase-admin/firestore';
import { DataAccessor, DatabaseStats } from './_internal/data-accessor.js';
import { DatabasePool } from './_internal/database-pool.js';
import { DEFAULT_DATABASE_ID } from './_internal/firestore/constants.js';
import { logger } from './_internal/firestore/logger.js';
import { ClientPool } from './_internal/firestore/pool.js';
import { GapicClient } from './_internal/firestore/types.js';
import {
  DEFAULT_LOCATION,
  DEFAULT_NAMESPACE,
  DEFAULT_PROJECT_ID,
} from './_internal/internal-types.js';
import { Listeners } from './_internal/listeners.js';
import { MockGapicClient } from './_internal/mock-gapic-client/mock-gapic-client.js';
import { DatabaseDirect } from './database-direct.js';
import { SystemTime } from './system-time.js';
import { FirestoreMockStats } from './types.js';

/**
 * Configuration for a mock Firestore controller instance.
 *
 * These options define the logical identity and environment of the mocked
 * Firestore database and are used when constructing resource names
 * (e.g. `//firestore.googleapis.com/projects/{projectId}/databases/{databaseId}`)
 * and CloudEvent metadata (project, database, location, namespace).
 *
 * All properties are optional and have sensible defaults to allow quick setup.
 *
 * @example
 * const ctrl = env.createDatabase({
 *   projectId: 'my-project',
 *   databaseId: '(default)',
 *   location: 'nam5',       // or 'us-central1'
 *   namespace: '(default)',
 * });
 */
export interface FirestoreControllerOptions {
  /**
   * The logical database ID (Firestore database).
   * Used in resource names like:
   *   //firestore.googleapis.com/projects/{projectId}/databases/{databaseId}
   * Defaults to '(default)' if omitted.
   */
  databaseId?: string;

  /**
   * The logical Google Cloud project ID.
   * Defaults to 'default-project' if omitted.
   */
  projectId?: string;

  /**
   * Firestore database location identifier used in CloudEvents and resource metadata.
   * Accepts multi-region IDs (e.g. 'nam5', 'eur3') or regional IDs (e.g. 'us-central1').
   * Defaults to 'nam5' if omitted.
   */
  location?: string;

  /**
   * Datastore namespace. For Firestore Native mode this should remain '(default)'.
   * Included for fidelity when simulating Datastore-mode events.
   * Defaults to '(default)' if omitted.
   */
  namespace?: string;
}

/**
 * Discrete lifecycle transitions emitted by a {@link FirestoreController}.
 *
 * - `'delete'` — The database has been **permanently disposed**. All resources
 *   held by the controller are released and no further operations against this
 *   instance are expected to succeed.
 * - `'reset'` — The database has been **cleared back to an empty state** and its `epoch` incremented
 * while keeping the same controller instance. This is typically used between tests to
 * guarantee isolation without tearing down the process.
 *
 * @remarks
 * Use these event types to distinguish teardown vs. in-place reinitialization
 * when coordinating triggers, listeners, or other observers.
 */
export type DatabaseLifecycleEventType = 'delete' | 'reset';

/**
 * Payload describing a lifecycle transition of a {@link FirestoreController}.
 *
 * @public
 */
export interface DatabaseLifecycleEventArg {
  /**
   * The kind of lifecycle transition that occurred.
   *
   * - `'delete'` — The controller has been torn down and will not emit further
   *   events.
   * - `'reset'` — The controller remains valid, but its underlying database
   *   contents have been cleared to a pristine state and its `epoch` incremented.
   *
   * @see DatabaseLifecycleEventType
   */
  type: DatabaseLifecycleEventType;
  /**
   * The `epoch` of the underlying database when the event was raised.
   */
  epoch: number;

  /**
   * The controller instance whose database underwent the transition.
   *
   * @remarks
   * On `'reset'`, consumers can re-establish data/fixtures or rebind observers
   * against this controller. On `'delete'`, consumers should release references
   * and unsubscribe from any observers associated with this controller.
   */
  database: FirestoreController;
}

/**
 * Structural shim for augmenting a `Firestore` instance with access to the
 * Admin SDK’s internal GAPIC client pool.
 *
 * Used by `FirestoreMock` to monkey-patch the instance so that the
 * `ClientPool` yields `MockGapicClient` instances instead of real networked
 * clients. This relies on a private, underscored property in the Admin SDK
 * and is **not** part of the public API surface.
 *
 * @internal
 * @remarks
 * - Treat this as test-only infrastructure; the shape may change across SDK versions.
 * - The underscore name mirrors the Admin SDK’s private field.
 */
interface WithClientPool {
  /**
   * The internal pool the Admin SDK uses to create/reuse GAPIC clients.
   * `FirestoreMock` replaces or rebinds this pool so it returns
   * `MockGapicClient` instances (in-memory, no network).
   */
  _clientPool: ClientPool<GapicClient>;
}

/**
 * An in-memory Firestore mock environment supporting multiple named projects and databases.
 *
 * ## Purpose
 * - Injects an in-memory database into a Firestore Admin SDK `Firestore` instance for unit and integration testing, without network or emulator dependencies.
 * - Supports multiple logical projects and databases in a single environment.
 * - Enables deterministic testing, time manipulation, and low-level access to mock database state and statistics.
 *
 * ## Usage
 * - Typically, create a fresh `FirestoreMock` per test (or test suite) to ensure data isolation.
 * - Use `createDatabase()` to provision databases, and `getDatabase()` to access/manage them.
 * - Use `firestore()` to create Firestore SDK-compatible mock instances.
 *
 * @example
 * const env = new FirestoreMock();
 * const db = env.createDatabase('my-project', 'my-database');
 * const firestore = db.firestore();
 * // ... use Firestore API as normal, all operations are in-memory
 */
export class FirestoreMock {
  private readonly _databasePool: DatabasePool<FirestoreController>;
  readonly systemTime = new SystemTime();

  /**
   * Constructs a new FirestoreMock.
   *
   * @param config Optional configuration for time mocking, etc.
   */
  constructor() {
    this._databasePool = new DatabasePool({
      serverTime: () => Timestamp.fromDate(this.systemTime.now()),
    });
  }

  /**
   * Constructs a new mock `Firestore` instance using the specified settings.
   *
   * - `settings()` may also be invoked on the returned instance for further configuration (mirroring the real SDK).
   * - Network settings (e.g., host, port) are accepted for compatibility but have no effect.
   * - The returned instance is not tied to a specific project/database unless set in `settings`.
   *
   * @param settings Optional Firestore settings. Project/database may be specified here.
   * @returns A `Firestore` instance that operates upon the specified mock database.
   */
  firestore(settings?: Settings): Firestore {
    const firestore = new Firestore(settings);
    patchClientPool(firestore, this._databasePool);

    return firestore;
  }

  /**
   * Creates a new mock Firestore database using an options object.
   *
   * - Preferred overload: pass a single {@link FirestoreControllerOptions} for clarity.
   * - Throws if a database with the same `projectId`/`databaseId` already exists in this environment.
   * - Returns a {@link FirestoreController} for low-level control and access.
   *
   * Defaults (when omitted):
   * - `projectId`: `'default-project'`
   * - `databaseId`: `'(default)'`
   * - `location`: `'nam5'` (or your environment default)
   * - `namespace`: `'(default)'`
   *
   * @param options Optional configuration for the database identity and environment.
   * @returns A {@link FirestoreController} instance for the created database.
   * @throws {Error} If a database with the given `projectId`/`databaseId` already exists.
   *
   * @example
   * const ctrl = env.createDatabase({
   *   projectId: 'my-project',
   *   databaseId: '(default)',
   *   location: 'nam5',
   *   namespace: '(default)',
   * });
   */
  createDatabase(options?: FirestoreControllerOptions): FirestoreController;
  /**
   * Creates a new mock Firestore database within the specified project.
   *
   * - Throws if the database already exists in this environment.
   * - Returns a {@link FirestoreController} for low-level control and access.
   *
   * @param projectId The logical project ID. Defaults to 'default-project' if omitted.
   * @param databaseId The logical database ID. Defaults to '(default)' if omitted.
   * @returns A FirestoreController instance for the created database.
   * @throws {Error} If a database with the given projectId/databaseId already exists.
   */
  createDatabase(projectId?: string, databaseId?: string): FirestoreController;
  createDatabase(
    p1?: string | FirestoreControllerOptions,
    p2?: string
  ): FirestoreController {
    const p1Type = typeof p1;
    const options: FirestoreControllerOptions | undefined =
      p1Type === 'string' || (p1Type == 'undefined' && typeof p2 === 'string')
        ? {
            projectId: p1 as string | undefined,
            databaseId: p2,
          }
        : (p1 as FirestoreControllerOptions | undefined);

    return new FirestoreController(this, this._databasePool, options);
  }

  /**
   * Retrieves a controller for the specified mock Firestore database, if it exists.
   *
   * - Throws if the requested database has not been created or has been deleted.
   * - Returns the same controller instance for the same project/database while it exists.
   *
   * @param projectId The logical project ID. Defaults to 'default-project' if omitted.
   * @param databaseId The logical database ID. Defaults to '(default)' if omitted.
   * @returns The FirestoreController instance for the requested database.
   * @throws {Error} If the database does not exist.
   */
  getDatabase(projectId?: string, databaseId?: string): FirestoreController {
    return this._databasePool.getWithAssert(
      projectId ?? DEFAULT_PROJECT_ID,
      databaseId ?? DEFAULT_DATABASE_ID
    ).host;
  }

  /**
   * Retrieves a value indicating whether or not the specified mock Firestore database exists.
   *
   * @param projectId The logical project ID. Defaults to 'default-project' if omitted.
   * @param databaseId The logical database ID. Defaults to '(default)' if omitted.
   * @returns `true` if the specified database exists, otherwise `false`.
   */
  databaseExists(projectId?: string, databaseId?: string): boolean {
    return this._databasePool.exists(
      projectId ?? DEFAULT_PROJECT_ID,
      databaseId ?? DEFAULT_DATABASE_ID
    );
  }

  /**
   * Deletes all databases in the environment.
   * - Synchronously invokes the `delete()` operation on all pooled database controllers.
   */
  deleteAll(): void {
    this._databasePool.forEach((controller) => {
      controller.delete();
    });
  }

  /**
   * Resets all databases in the environment.
   * - Synchronously invokes the `reset()` operation on all pooled database controllers.
   */
  resetAll(): void {
    this._databasePool.forEach((controller) => {
      controller.reset();
    });
  }
}

/**
 * Provides low-level control and observation for a single mock Firestore database instance.
 *
 * - Used for creating project/database-scoped Firestore API instances, inspecting stats, resetting, or deleting the database.
 * - One controller exists per database within a `FirestoreMock`; always use {@link FirestoreMock.getDatabase} or {@link FirestoreMock.createDatabase} to obtain a controller.
 * - Deleting a database via `delete()` invalidates the controller and removes all associated data.
 */
export class FirestoreController {
  private _accessor: DataAccessor | undefined;
  private _statWatchers = new Listeners<FirestoreMockStats>();
  private _lifecycleWatchers = new Listeners<DatabaseLifecycleEventArg>();

  /** The project ID for this mock database. */
  readonly projectId: string;
  /** The database ID for this mock database. */
  readonly databaseId: string;
  /**
   * Firestore database location identifier used in CloudEvents and resource metadata.
   * Accepts multi-region IDs (e.g. 'nam5', 'eur3') or regional IDs (e.g. 'us-central1').
   * Defaults to 'nam5' if omitted.
   */
  readonly location: string;
  /**
   * Datastore namespace. For Firestore Native mode this should remain '(default)'.
   * Included for fidelity when simulating Datastore-mode events.
   * Defaults to '(default)' if omitted.
   */
  readonly namespace: string;
  /**
   * Provides direct, low-level access to the underlying mock database.
   * - Primarily for advanced test scenarios, data seeding, or test-only operations.
   */
  readonly database: DatabaseDirect;

  /**
   * @internal
   * Constructs a new FirestoreController.
   * @param mock The parent mock environment.
   * @param _pool The backing database pool (internal).
   * @param projectId The logical project ID for this database.
   * @param databaseId The logical database ID for this database.
   */
  constructor(
    readonly mock: FirestoreMock,
    private readonly _pool: DatabasePool<FirestoreController>,
    options?: FirestoreControllerOptions
  ) {
    this.projectId = options?.projectId ?? DEFAULT_PROJECT_ID;
    this.databaseId = options?.databaseId ?? DEFAULT_DATABASE_ID;
    this.location = options?.location ?? DEFAULT_LOCATION;
    this.namespace = options?.namespace ?? DEFAULT_NAMESPACE;
    this._accessor = _pool.create(
      this.projectId,
      this.databaseId,
      this
    ).accessor;
    this.database = new DatabaseDirect(this._accessor);
    this.mock = mock;
    this._accessor.watchStats((stats) => {
      if (this._accessor) {
        this._statWatchers.next(this.formatStats(stats));
      }
    });
    this._accessor.registerResetListener((epoch) => {
      this._lifecycleWatchers.next({
        type: 'reset',
        epoch,
        database: this,
      });
    });
  }

  /**
   * Constructs a new mock Firestore instance, scoped to this controller's project/database.
   *
   * - The returned instance always uses this controller's `projectId` and `databaseId`, regardless of settings provided.
   * - `settings()` may also be invoked on the returned instance (mirroring the real SDK).
   * - Network-related settings are accepted but have no effect.
   *
   * @param settings Optional Firestore settings; projectId/databaseId will be overridden.
   * @returns A Firestore instance scoped to this database.
   */
  firestore(settings?: Settings): Firestore {
    this.assertExists();

    return this.mock.firestore({
      ...settings,
      databaseId: this.databaseId,
      projectId: this.projectId,
    });
  }

  /**
   * Checks if this database still exists in the mock environment.
   *
   * @returns `true` if the database exists; `false` if it has been deleted.
   */
  exists(): boolean {
    return this._accessor != undefined;
  }

  /**
   * The monotonically increasing database epoch identifier.
   *
   * - **Increments only when the database is reset** (never for reads/writes/commits).
   * - Remains constant for the entire lifetime of a given database instance between resets.
   * - When combined with {@link version()} (the commit sequence number), `(epoch, version)`
   *   provides a stable total ordering key across resets.
   */
  epoch(): number {
    this.assertExists();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this._accessor!.epoch;
  }

  /**
   * The monotonically increasing atomic commit version of the database.
   *
   * @returns The database commit version.
   * @throws {Error} If this database has been deleted.
   */
  version(): number {
    this.assertExists();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this._accessor!.version;
  }

  /**
   * Deletes the database from the mock environment, invalidating this controller.
   *
   * - After deletion, further calls to methods on this controller (other than `exists()` and `reset()`)
   * will throw.
   * - All associated data and stats are lost.
   */
  delete(): void {
    if (this.exists()) {
      const epoch = this.epoch();
      this._pool.delete(this.projectId, this.databaseId);
      this._statWatchers.clear();
      try {
        this._lifecycleWatchers.next({
          type: 'delete',
          epoch,
          database: this,
        });
      } finally {
        this._lifecycleWatchers.clear();
        this._accessor = undefined;
      }
    }
  }

  /**
   * Resets all documents and stats for this database, preserving its existence and this controller.
   *
   * - Does not affect listeners or other attached controllers.
   * - Useful for resetting state between tests.
   */
  reset(): void {
    if (this.exists()) {
      this._pool
        .getWithAssert(this.projectId, this.databaseId)
        ?.accessor.reset();
    }
  }

  /**
   * Retrieves the current stats for this database.
   *
   * @returns A snapshot of current FirestoreMockStats (e.g., document/operation counts).
   * @throws {Error} If this database has been deleted.
   */
  getStats(): FirestoreMockStats {
    this.assertExists();

    return this.formatStats(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._accessor!.getStats()
    );
  }

  /**
   * Registers a watcher function to receive the latest stats whenever they change.
   *
   * - The watcher is immediately called with the current stats.
   * - Returns a function to deregister the watcher.
   * - Throws if the database has been deleted.
   *
   * @param statsWatcher Callback function to receive FirestoreMockStats updates.
   * @returns Deregistration function.
   * @throws {Error} If this database has been deleted.
   */
  watchStats(statsWatcher: (stats: FirestoreMockStats) => void): () => void {
    this.assertExists();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.formatStats(this._accessor!.getStats());

    return this._statWatchers.register(statsWatcher);
  }

  /**
   * Registers a watcher function to receive **database lifecycle events** emitted
   * by this {@link FirestoreController}.
   *
   * - Fires on `'reset'` when the underlying database is cleared but the
   *   controller remains usable.
   * - Fires on `'delete'` when the controller/database is permanently disposed.
   * - Returns a function to deregister the watcher.
   * - Throws if the database has already been deleted.
   *
   * @param lifecycleWatcher Callback invoked for each lifecycle transition with a
   *   {@link DatabaseLifecycleEventArg} describing the event and source controller.
   * @returns Deregistration function.
   * @throws {Error} If this database has been deleted.
   */
  watchLifecycle(
    lifecycleWatcher: (arg: DatabaseLifecycleEventArg) => void
  ): () => void {
    this.assertExists();

    return this._lifecycleWatchers.register(lifecycleWatcher);
  }

  /**
   * Formats internal DataAccessorStats as a user-facing FirestoreMockStats object.
   *
   * @param stats Raw stats from the DataAccessor.
   * @returns Immutable FirestoreMockStats.
   * @internal
   */
  private formatStats(stats: DatabaseStats): FirestoreMockStats {
    return Object.freeze({
      databaseId: this.databaseId,
      ...stats,
    });
  }

  /**
   * Throws if this controller's database has been deleted.
   *
   * @throws {Error} If the database has been deleted via `delete()`.
   * @internal
   */
  private assertExists(): void {
    if (!this.exists())
      throw new Error(
        `The Firestore mock database ${this.projectId}/${this.databaseId} has been deleted.`
      );
  }
}

/*!
 * The maximum number of concurrent requests supported by a single GRPC channel,
 * as enforced by Google's Frontend. If the SDK issues more than 100 concurrent
 * operations, we need to use more than one GAPIC client since these clients
 * multiplex all requests over a single channel.
 */
const MAX_CONCURRENT_REQUESTS_PER_CLIENT = 100;
/**
 * How many idle channels the pool is allowed to keep alive.
 *
 * @internal
 */
const DEFAULT_MAX_IDLE_CHANNELS = 1;

/**
 * Replaces the Admin SDK's internal GAPIC `ClientPool` on a freshly-created
 * `Firestore` instance with a pool that emits `MockGapicClient` instances.
 *
 * This enables high-fidelity, in-memory testing by routing all Firestore
 * backend calls (e.g., `commit`, `batchGetDocuments`, queries) to the mock
 * implementation instead of the network.
 *
 * @remarks
 * - This function intentionally reaches into a **private** underscored field
 *   (`_clientPool`). It relies on internal Admin SDK internals and is not a
 *   stable, public API. Pin compatible versions and keep a test that fails
 *   loudly if the field moves or the constructor signature changes.
 * - The provided `firestore` instance should be **new and uninitialized**.
 *   When the native pool has zero active clients, `terminate()` resolves
 *   immediately.
 *
 * @param firestore - The newly-created Admin SDK `Firestore` instance to patch.
 * @param databasePool - The in-memory database pool backing the mock GAPIC client.
 *
 * @internal
 */
function patchClientPool(
  firestore: Firestore,
  databasePool: DatabasePool
): void {
  const nativePool = (firestore as unknown as WithClientPool)._clientPool;
  // Close out the native pool to avoid leaking idle gRPC channels. On a fresh Firestore
  // instance there are no active clients, so this resolves immediately and has no effect
  // on the patched instance. We deliberately don't await it—`void` marks this as an
  // intentional fire-and-forget to satisfy linters (no-floating-promises) and reviewers.
  void nativePool.terminate().catch(() => {
    // intentional: silence unhandled rejections, nothing to clean up
  });

  const pool = new ClientPool<GapicClient>(
    MAX_CONCURRENT_REQUESTS_PER_CLIENT,
    DEFAULT_MAX_IDLE_CHANNELS,
    /* clientFactory= */ () => {
      const useFallback = false;
      const client = new MockGapicClient(firestore, databasePool);
      logger(
        'clientFactory',
        null,
        'Initialized Firestore GAPIC Client (useFallback: %s)',
        useFallback
      );
      return client;
    },
    /* clientDestructor= */ (client) => client.close()
  );
  (firestore as unknown as WithClientPool)._clientPool = pool;
}

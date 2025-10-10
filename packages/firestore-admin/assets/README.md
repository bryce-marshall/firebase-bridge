# @firebase-bridge/firestore-admin

> High‑fidelity **in‑memory mock** for the **Firestore Admin SDK**. Purpose‑built for fast, deterministic backend unit tests (no emulator boot, no deploy loop).

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)

### What it is

This package lets you run a real `firebase-admin` **Firestore** instance entirely **in-process** against an in‑memory database with high-fidelity production Firestore semantics (CRUD, batches, transactions, queries, aggregations, vector values, listeners, etc).

- **Backend only** (Node.js). No client/browser APIs.
- **Dev dependency** intended for **unit‑testing** and **rapid prototyping** of backend logic.
- To bind firebase-functions v1/v2 Firestore triggers to an in-memory Firestore database use the companion package **[@firebase-bridge/firestore-functions](https://www.npmjs.com/package/@firebase-bridge/firestore-functions)**.

### When to use it

- Unit and integration tests for backend code using `firebase-admin/firestore`
- CI where the **Firestore Emulator** is slow or unavailable
- Deterministic tests that need a controllable clock and fast resets

### Why not the emulator (for this use case)

- Zero boot time. Zero deploy loop. Zero external processes — just edit, save, and test
- Deterministic **in-memory Firestore** with controllable time
- Suited to tight test loops and CI where startup cost matters

---

## Support

This project is made freely available under the [Apache 2.0 License](#license).  
If you find it useful and would like to support ongoing development, you can [buy me a coffee](https://buymeacoffee.com/brycemarshall). ☕

---

## Install

```bash
# npm
npm i -D @firebase-bridge/firestore-admin firebase-admin

# pnpm
pnpm add -D @firebase-bridge/firestore-admin firebase-admin

# yarn
yarn add -D @firebase-bridge/firestore-admin firebase-admin
```

> **Peer deps:** `firebase-admin` • **Node:** 18+ recommended • **TS:** strict mode recommended.

---

## Quick start (Jest/Vitest)

Two common setup styles are shown below. **Prefer the fast reset approach** for speed; use **fresh DB per test** when you need complete DB lifecycle isolation.

### A) Fast resets (preferred)

Create one environment and one database for the whole suite; **reset between tests**:

```ts
import { Firestore } from 'firebase-admin/firestore';
import { FirestoreMock } from '@firebase-bridge/firestore-admin';

describe('Example suite (fast resets)', () => {
  const env = new FirestoreMock();
  const firestore: Firestore = env.createDatabase().firestore();

  afterEach(() => {
    env.resetAll(); // clears all databases in this env, keeps them alive
  });

  it('writes and reads', async () => {
    const ref = firestore.collection('users').doc('ada');
    await ref.set({ name: 'Ada', score: 1 });
    const snap = await ref.get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ name: 'Ada', score: 1 });
  });
});
```

### B) Fresh DB per test (full isolation)

Provision a new logical DB per test and **delete** after each:

```ts
import { Firestore } from 'firebase-admin/firestore';
import { FirestoreMock } from '@firebase-bridge/firestore-admin';

describe('Example suite (fresh DB per test)', () => {
  const env = new FirestoreMock();
  let firestore!: Firestore;

  beforeEach(() => {
    firestore = env.createDatabase().firestore();
  });

  afterEach(() => {
    env.deleteAll(); // disposes all databases in this env
  });

  it('writes and reads', async () => {
    const ref = firestore.collection('users').doc('ada');
    await ref.set({ name: 'Ada', score: 1 });
    const snap = await ref.get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ name: 'Ada', score: 1 });
  });
});
```

### Multiple databases & Firestore isolation

You can host **many logical databases** in one environment, and you can create **multiple Firestore instances** attached to the **same** database when you need Firestore‑level isolation (e.g., independent listeners) over shared state.

```ts
const env = new FirestoreMock();

// Two separate logical databases
const dbA = env.createDatabase('proj-A', '(default)');
const dbB = env.createDatabase('proj-B', '(default)');

const fsA1 = dbA.firestore();
const fsA2 = dbA.firestore(); // isolated Firestore instances, same DB
const fsB = dbB.firestore(); // different DB entirely
```

---

## Core concepts & API

This package exposes a small set of high‑leverage primitives. Names below are **actual exports**.

### `class FirestoreMock`

A top-level **environment** that owns one or more in-memory databases and a controllable clock.

- `createDatabase(options?: FirestoreControllerOptions): FirestoreController`
  Provision a new database using an options object. All fields are optional with defaults:

  - `projectId` defaults to `"default-project"`
  - `databaseId` defaults to `"(default)"`
  - `location` defaults to `"nam5"`
  - `namespace` defaults to `"(default)"`
    Use this form if you need to specify location or namespace in your tests.

- `createDatabase(projectId?: string, databaseId?: string): FirestoreController`
  Provision a new database by explicit IDs (defaults as above).
- `getDatabase(projectId?: string, databaseId?: string): FirestoreController`
  Access an existing database (throws if missing/deleted).
- `databaseExists(projectId?: string, databaseId?: string): boolean`
- `deleteAll(): void` – delete all databases in the environment.
- `resetAll(): void` – reset all databases (data & stats) without deleting them.
- `systemTime: SystemTime` – **controllable time source** for deterministic tests.

### `class FirestoreController`

A handle to a **single logical database** (identified by `projectId` and `databaseId`).

- `projectId: string`, `databaseId: string`
- `location: string` – Firestore database location identifier used in CloudEvents and resource metadata. Accepts multi‑region IDs (e.g. `nam5`, `eur3`) or regional IDs (e.g. `us-central1`). Defaults to `nam5` if omitted.
- `namespace: string` – Datastore namespace. For Firestore Native mode this should remain `(default)`. Included for fidelity when simulating Datastore‑mode events. Defaults to `(default)` if omitted.
- `firestore(settings?: Settings): Firestore`
  Create a **Firestore Admin SDK** instance **scoped** to this database.
- `exists(): boolean` – whether the database still exists.
- `version(): number` – The monotonically increasing atomic commit version of the database.
- `delete(): void` – delete this database; subsequent calls (besides `exists()`/`reset()`) throw.
- `reset(): void` – clear documents & stats but keep the DB alive.
- `getStats(): FirestoreMockStats` – current cumulative stats snapshot.
- `watchStats(watcher: (s: FirestoreMockStats) => void): () => void` – subscribe to stat changes (returns an unsubscribe).
- `database: DatabaseDirect` – direct/low‑level access to the in‑memory DB (see below).

### `class DatabaseDirect`

A thin, synchronous façade for **direct data access** (seeding, inspection, structural imports/exports). It bypasses Admin SDK objects but maintains Firestore semantics.

- **Inspection & structure**

  - `listCollectionIds(documentPath: string): string[]`
  - `listDocuments(collectionPath: string, showMissing: boolean): MetaDocument[]`
  - `query<T>(q: DocumentQuery<T>): MetaDocumentExists<T>[]`
  - `toStructuralDatabase(): StructuralDatabase`
  - `fromStructuralDatabase(src: StructuralDatabase, merge?: MergeGranularity): NormalizedWriteResult`
  - Conversion helpers: `toMetaArray()`, `toMetaMap()`, `toMap()`

- **Single‑doc ops**

  - `getDocument<T>(path: string): MetaDocument<T>`
  - `setDocument<T>(path: string, data: T): MetaDocument<T>`
  - `deleteDocument<T>(path: string): MetaDocument<T>`

- **Batch ops** (atomic)

  - `batchSet<T>(...docs: DatabaseDocument<T>[]): MetaDocument<T>[]`
  - `batchDelete<T>(...paths: string[]): MetaDocument<T>[]`
  - `batchWrite<T>(writes: (DatabaseDocument<T> | string)[]): MetaDocument<T>[]`
    (`{ path, data }` → `set`; `string` → `delete`)

> **Triggers:** Low‑level trigger registration exists on `DatabaseDirect`. This can be handy in white‑box tests. For Cloud Functions parity (v1/v2 events, subjects, metadata), prefer the **[@firebase-bridge/firestore-functions](https://www.npmjs.com/package/@firebase-bridge/firestore-functions)** companion package..

#### Low‑level trigger example (DatabaseDirect)

```ts
import { FirestoreMock } from '@firebase-bridge/firestore-admin';

const env = new FirestoreMock();
const ctl = env.createDatabase('proj', '(default)');
const direct = ctl.database;

const unsubscribe = direct.registerTrigger({
  route: 'users/{uid}/posts/{pid}',
  callback: ({ params, doc }) => {
    // Derive semantic kind from lineage
    const prev = doc.previous;
    const kind =
      !prev?.exists && doc.exists
        ? 'create'
        : prev?.exists && doc.exists
        ? 'update'
        : prev?.exists && !doc.exists
        ? 'delete'
        : 'write';

    console.log(`[${kind}] users/${params.uid}/posts/${params.pid}`, {
      exists: doc.exists,
      version: doc.version,
      updateTime: doc.updateTime.toDate().toISOString(),
    });

    // doc.data is deeply frozen; use cloneData() for a mutable copy
    const mutable = doc.cloneData();
    // ...assertions, enqueue side effects for tests, etc.
  },
});

// Perform writes via Firestore or DatabaseDirect
const fs = ctl.firestore();
await fs
  .collection('users')
  .doc('u1')
  .collection('posts')
  .doc('p1')
  .set({ title: 'hello' });

unsubscribe();
```

> Notes:
>
> - Triggers fire **after** each atomic commit.
> - If multiple writes target the same document in a single commit, only the **final state** for that path is delivered.
> - For Cloud Functions fidelity (v1/v2 payload shaping, subjects, event IDs), prefer the **[@firebase-bridge/firestore-functions](https://www.npmjs.com/package/@firebase-bridge/firestore-functions)** companion package.

#### DatabaseDirect — writes (including `fromStructuralDatabase()` shapes)

```ts
import {
  FirestoreMock,
  StructuralDatabase,
  MergeGranularity,
} from '@firebase-bridge/firestore-admin';

const env = new FirestoreMock();
const ctl = env.createDatabase('proj', '(default)');
const direct = ctl.database;

// 1) Single set / delete
direct.setDocument('users/alice', { name: 'Alice', score: 7 });
direct.deleteDocument('users/bob'); // no-op if it didn't exist

// 2) Batch set / delete (atomic)
direct.batchSet(
  { path: 'users/bob', data: { name: 'Bob', score: 3 } },
  { path: 'users/cara', data: { name: 'Cara', tags: ['pro'] } }
);
direct.batchDelete('users/bob', 'users/ghost');

// 3) Heterogeneous batch write (atomic)
//    - {path,data} → normalized to 'set' (merge: 'root')
//    - 'string'   → normalized to 'delete'
direct.batchWrite([{ path: 'users/alice', data: { score: 8 } }, 'users/ghost']);

// 4) Import from a structural snapshot
const snapshot: StructuralDatabase = {
  users: {
    alice: {
      data: { name: 'Alice', role: 'admin' },
      collections: {
        posts: {
          p1: { data: { title: 'Hello', likes: 1 } },
          p2: { data: { title: 'Second', likes: 0 } },
        },
      },
    },
    cara: { data: { name: 'Cara' } },
  },
  products: {
    p1: { data: { sku: 'ABC-123', price: 19.95 } },
  },
};

// Merge strategies:
// - 'root'   → replace entire doc with provided data
// - 'branch' → deep-merge maps; scalars/arrays replace
// - 'node'   → apply only explicit field paths (like update/mergeFields)

direct.fromStructuralDatabase(snapshot, 'root' satisfies MergeGranularity);

// 5) Export to a structural snapshot (round-trippable)
const roundTrip = direct.toStructuralDatabase();
```

> `fromStructuralDatabase` returns a normalized write result (server time + `MetaDocument[]`). All write helpers are **atomic** at the batch call boundary.

#### DatabaseDirect — `stats()` (example shape)

```ts
import { DatabaseStats } from '@firebase-bridge/firestore-admin';

const s: DatabaseStats = direct.stats();
console.log(s);
/*
{
  // Operation counters (cumulative until reset)
  writes: 4,
  reads: 3,
  deletes: 1,
  noopReads: 1,
  noopWrites: 0,
  noopDeletes: 1,

  // Structural counters (current view of the tree)
  documentCount: 3,
  collectionCount: 2,
  stubDocumentCount: 0,
  stubCollectionCount: 0
}
*/
```

- Use `ctl.getStats()` for controller-scoped stats (adds DB identity).
- To reset counters **and** wipe all data while keeping databases, call `ctl.reset()` (single DB) or `env.resetAll()` (all DBs). This **deletes all documents and collections**, **flushes pending changes without invoking watcher callbacks**, **zeros all database stats**, and **resets the internal change-version nonce to `0`**.

#### DatabaseDirect — `query()` examples

`DocumentQuery<T>` provides scoping (root/document, collection ID, collection-group toggle), optional point-in-time `readTime`, and a `predicate` over existing docs.

```ts
import { Timestamp } from 'firebase-admin/firestore';
import {
  DocumentQuery,
  MetaDocumentExists,
} from '@firebase-bridge/firestore-admin';

// 1) All docs in top-level 'users'
const q1: DocumentQuery = {
  parent: '',
  allDescendants: false,
  collectionId: 'users',
  predicate: () => true,
};
const users: MetaDocumentExists[] = direct.query(q1);

// 2) Collection group query: any 'posts' anywhere under 'users/alice'
const q2: DocumentQuery<{ title: string; likes: number }> = {
  parent: 'users/alice',
  allDescendants: true,
  collectionId: 'posts',
  predicate: (m) => (m.data.likes ?? 0) >= 1,
};
const hotPosts = direct.query(q2);

// 3) As-of read (point-in-time)
const at: Timestamp = Timestamp.fromMillis(Date.now() - 1000);
const q3: DocumentQuery = {
  parent: '',
  allDescendants: true,
  predicate: () => true,
  readTime: at, // include docs with updateTime <= at
};
const asOfDocs = direct.query(q3);
```

> Results are `MetaDocumentExists<T>[]` only (non-existing docs are excluded). Order as needed in your test code.

#### `MetaDocumentExists` & `MetaDocumentNotExists` (what you get back)

Immutable snapshots returned from direct ops, queries, and write results.

**Common fields (`MetaDocument<T>`)**

- `parent: string` – collection path of the doc’s parent
- `path: string` – fully qualified document path
- `id: string` – last segment of `path`
- `serverTime: Timestamp` – authoritative commit/apply time for the producing op
- `updateTime: Timestamp` – last update time for the doc (0 if never existed)
- `version: number` – internal change sequence number
- `hasChanges: boolean` – whether the producing op changed the doc
- `createTime?: Timestamp` – when the doc was first created (undefined if never existed)
- `data?: T` – **deeply frozen** data; use `cloneData()` for a mutable copy
- `previous?: MetaDocument<T>` – **immediate** prior state for the same path (present when `hasChanges === true`; not a transitive chain)
- `cloneData(): T | undefined` – defensive deep clone of `data`

**Refinements**

- `MetaDocumentExists<T>`:

  - `exists: true`
  - `createTime: Timestamp`
  - `data: T`

- `MetaDocumentNotExists<T>`:

  - `exists: false`
  - `createTime?: undefined`
  - `data?: undefined`

```ts
const m = direct.getDocument<{ name: string }>('users/alice');
if (m.exists) {
  // MetaDocumentExists<{name:string}>
  console.log(m.path, m.updateTime.toDate(), m.data.name);
  const mutable = m.cloneData();
} else {
  // MetaDocumentNotExists
  console.log('missing:', m.path);
}
```

#### Snapshots as arrays & maps (`toMetaArray`, `toMetaMap`, `toMap`)

```ts
// Seed
direct.batchSet(
  { path: 'users/alice', data: { name: 'Alice', score: 7 } },
  { path: 'users/cara', data: { name: 'Cara', score: 3 } }
);

// 1) Array of existing meta documents (ordered)
const arr = direct.toMetaArray();

// 2) Map of path → MetaDocumentExists
const metaMap = direct.toMetaMap();

// 3) Map of path → plain document data (no meta)
const dataMap = direct.toMap();
```

### `class SystemTime`

Deterministically control “now” as observed by writes, transforms, and snapshot timestamps.

- `now(): Date` – current time per strategy.
- `system(): void` – real clock.
- `constant(date: Date): void` – fixed instant.
- `offset(...)`: start from a **root** time and move forward in real time (overloads support `Date` or `UTC parts`).
- `advance(msOrParts): void` – jump the clock forward.
- `custom(fn: () => Date): void` – fully custom time generator.

#### SystemTime & `Timestamp.now()` gotcha

Internally, this mock derives all commit/write/update times from **`SystemTime`**. However, **`firebase-admin`’s** `Timestamp.now()` calls into the **real clock** (e.g., `Date.now()`), which we do **not** monkey‑patch by default. As a result, if your application/test code _directly_ calls `Timestamp.now()`, it will not reflect `SystemTime` unless you take additional steps.

**Options:**

1. **Don’t call `Timestamp.now()` directly in tests.** Instead derive from `SystemTime`:

```ts
import { Timestamp } from 'firebase-admin/firestore';
const ts = Timestamp.fromDate(env.systemTime.now());
```

2. **Monkey‑patch `Timestamp.now` during tests** (scoped and reversible):

```ts
import { Timestamp } from 'firebase-admin/firestore';
let restore: undefined | (() => void);

beforeAll(() => {
  const original = Timestamp.now;
  (Timestamp as any).now = () => Timestamp.fromDate(env.systemTime.now());
  restore = () => {
    (Timestamp as any).now = original;
  };
});

afterAll(() => restore?.());
```

3. **Use your test runner’s fake‑time utilities** to align the global clock with `SystemTime`.

- **Jest** (modern fake timers):

```ts
import { jest } from '@jest/globals';

beforeAll(() => {
  jest.useFakeTimers();
});

beforeEach(() => {
  jest.setSystemTime(env.systemTime.now());
});

afterAll(() => {
  jest.useRealTimers();
});
```

- **Vitest** (`vi.useFakeTimers()` / `vi.setSystemTime()`), similarly.

> We intentionally avoid patching `Timestamp.now()` automatically to keep this library side‑effect‑free with respect to peer dependencies. All **internal** timestamps (commit time, `serverTimestamp`, `updateTime`, `writeTime`) do honor `SystemTime`.

---

## Structural snapshots (seed, diff, round‑trip)

The **structural** types let you snapshot/import database state without Firestore objects:

- `StructuralDatabase` – object tree of collections → documents → nested collections.
- `StructuralCollection`, `StructuralCollectionGroup`, `StructuralDocument`

```ts
import {
  StructuralDatabase,
  DatabaseDirect,
} from '@firebase-bridge/firestore-admin';

const ctl = new FirestoreMock().createDatabase('proj', '(default)');
const direct: DatabaseDirect = ctl.database;

// Export
const snapshot: StructuralDatabase = direct.toStructuralDatabase();

// Import/merge
const writes = direct.fromStructuralDatabase(
  snapshot /*, 'root' | 'collection' | 'document' */
);
expect(writes.count).toBeGreaterThan(0);
```

---

## Stats & observability

Use `FirestoreController.getStats()` to assert fidelity and track operations:

```ts
const ctl = new FirestoreMock().createDatabase();
const fs = ctl.firestore();
await fs.collection('c').doc('d').set({ a: 1 });

const stats = ctl.getStats();
expect(stats.documents.total).toBe(1);
```

Subscribe to live updates during tests with `watchStats()` (remember to unsubscribe):

```ts
const stop = ctl.watchStats((s) => {
  // e.g., console.log('writes', s.operations.writes.total)
});
// ...
stop();
```

---

## Notes on fidelity (high level)

- **Atomicity**: batches/transactions are atomic; transform results follow Firestore’s ordering rules.
- **Time**: `updateTime`, `writeTime`, and stored `serverTimestamp` follow Firestore relationships; use `SystemTime` to make tests deterministic.
- **Queries**: filters (including `or`/`not-in`/`in`), ordering, cursors, limits, collection‑group, and aggregations (e.g., `count()`).
- **Vector values**: supports `FieldValue.vector()` fields and nearest‑neighbor features in queries that expose them through the Admin API surface.
- **Listeners**: document and query listeners behave like streaming APIs with monotonic `readTime` and proper change sets.
- **Partitioned queries (CollectionGroup.getPartitions() / Query.getPartitions() → GAPIC partitionQuery)**: currently stubbed — the mock returns an empty stream (no partitions) for compatibility with tests that call it but don’t use the results. Use the emulator/Firestore for real partitioning semantics (parallel exports/batching).

> If you find behavior that diverges from the real Admin SDK or emulator, please open an issue with a minimal repro — **fidelity is the project’s #1 priority**.

---

## Package exports (public)

From this package you can import:

- `FirestoreMock`, `FirestoreController`
- `DatabaseDirect` and structural types: `StructuralDatabase`, `StructuralCollection`, `StructuralCollectionGroup`, `StructuralDocument`
- Time control: `SystemTime`
- Useful types for assertions: `MetaDocument`, `MetaDocumentExists`, `MetaDocumentNotExists`, `MergeGranularity`, `Trigger`, `TriggerEventArg`, `FirestoreMockStats`

> **Cloud Functions:** for registering/using triggers in tests, depend on the **[@firebase-bridge/firestore-functions](https://www.npmjs.com/package/@firebase-bridge/firestore-functions)** companion package.

---

## Troubleshooting

- **My Firestore calls don’t hit the mock**
  Ensure you’re using `firestore = env.createDatabase(...).firestore()` from a `FirestoreController` **created by** this environment.

- **I need fresh state between tests**
  Prefer `env.resetAll()` (fast) over `env.deleteAll()` (disposes DBs completely). You can also reset a single DB via `controller.reset()`.

- **Time‑sensitive assertions are flaky**
  Pin or advance time via `env.systemTime`.

- **Tests hang or fail to exit cleanly after running**  
  Ensure all in-memory databases are explicitly disposed of once tests finish.  
  Add an `afterEach()` or `afterAll()` hook to call one of the following, depending on scope:

  - `env.deleteAll()` — deletes **all databases** in the `FirestoreMock` environment
  - `controller.delete()` — deletes a **single database** via its `FirestoreController`

  This guarantees that background resources (timers, intervals, listeners, etc.) are released and allows your test runner to shut down cleanly.

---

## Versioning & compatibility

- Peer dependency: `firebase-admin` (see your package’s `peerDependencies` for the supported range).
- Node.js ≥ 18. TypeScript projects (ESM or CJS) are supported via the Admin SDK.

---

## Contributing

Thanks for your interest! This project is in **minimal-maintainer mode**.

- **Issues first.** Please open an issue with a clear repro or failing test. Unsolicited feature PRs may be closed.
- **PRs limited to**: bug fixes with tests, small docs improvements, or build/release hygiene. New features require an accepted proposal in an issue first.
- **Tests are required.** Changes must include high-fidelity tests that show alignment (or documented divergence) with the Firebase Emulator.
- **Review cadence.** I review in batches and may be slow. There’s no support SLA.
- **Scope guardrails.** The goal is fidelity to Firestore/Admin SDK semantics; out-of-scope features will be declined.

If that works for you, awesome—bugfixes and docs tweaks are especially welcome.

---

## License

Apache-2.0 © 2025 Bryce Marshall

---

## Trademarks & attribution

This project is **not** affiliated with, associated with, or endorsed by Google LLC. “Firebase” and “Firestore” are trademarks of Google LLC. Names are used solely to identify compatibility and do not imply endorsement.

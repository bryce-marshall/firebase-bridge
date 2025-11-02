# @firebase-bridge/firestore-functions

> Bind **`firebase-functions` v1 & v2 Firestore triggers** to an **in-memory Firestore** database from **[@firebase-bridge/firestore-admin](https://www.npmjs.com/package/@firebase-bridge/firestore-admin)**. Enables fast, deterministic end‑to‑end trigger testing with no emulator boot or deploy loop.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)

### What it is

This package wires **Cloud Functions for Firestore** (both **v1** and **v2**) to the **in‑memory Firestore** provided by the **[@firebase-bridge/firestore-admin](https://www.npmjs.com/package/@firebase-bridge/firestore-admin)** companion package. Your tests can simulate a **full backend** — registering all Firestore triggers your production app exports — and drive them by performing writes against the mock database. No emulator, network, or deploy step required.

- Adapts **Firestore trigger handlers** declared using `firebase-functions` **v1** (background functions) and **v2** (CloudEvents) so they are **invoked** by changes in the **in‑memory** database
- Generates realistic **onCreate**, **onUpdate**, **onDelete**, and **onWrite** event payloads (params/subject IDs, `Change` vs `CloudEvent<Change<...>>`, `before`/`after` snapshots or v2 `data` shape) and metadata (event time/ID) suitable for backend tests
- Preserves **commit semantics**: for multiple writes to the **same document** in a single atomic commit, **only the final state** for that path is delivered to triggers (no intermediary bleed‑through)
- Respects **transaction/batch** boundaries; triggers fire **after** the commit is applied
- Uses the mock’s **SystemTime** for event timestamps so your tests can be deterministic

> **Note:** You can register **any compatible Cloud Function**. This package simulates **Firestore change events and snapshots** only; if your handler uses other Google Cloud services (Pub/Sub, Scheduler, Auth, Storage, etc.), provide your own **test doubles/mocks** or bind to those services' emulators for testing.

### When to use it

- Unit or integration testing of Cloud Functions that depend on Firestore triggers
- Fast local testing in CI without the **Firestore Emulator**
- Deterministic tests with controllable time and atomic commit semantics

### Why not the emulator (for this use case)

- Zero boot time. Zero deploy loop. Zero external processes — just edit, save, and test
- Deterministic **in-memory Firestore** with controllable time
- Suited to tight test loops and CI where startup cost matters

### Companion Packages

- For a high‑fidelity **in‑memory mock** for the **Firestore Admin SDK** purpose‑built for fast, deterministic backend unit tests (no emulator boot, no deploy loop) use the companion package **[@firebase-bridge/firestore-admin](https://www.npmjs.com/package/@firebase-bridge/firestore-admin)**.
- For a high-fidelity **mock invocation layer** for **Firebase HTTPS Cloud Functions** (v1 & v2) — run real `onCall` / `onRequest` handlers locally with realistic **auth**, **App Check**, **instance ID**, and headers (no emulator) — use the companion package **[@firebase-bridge/auth-context](https://www.npmjs.com/package/@firebase-bridge/auth-context)**.

---

## Support

This project is made freely available under the [Apache 2.0 License](#license).
If you find it useful and would like to support ongoing development, you can [buy me a coffee](https://buymeacoffee.com/brycemarshall). ☕

---

## Install

```bash
# npm
npm i -D @firebase-bridge/firestore-functions @firebase-bridge/firestore-admin firebase-admin firebase-functions

# pnpm
pnpm add -D @firebase-bridge/firestore-functions @firebase-bridge/firestore-admin firebase-admin firebase-functions

# yarn
yarn add -D @firebase-bridge/firestore-functions @firebase-bridge/firestore-admin firebase-admin firebase-functions
```

> **Node:** 18+ recommended • **TS:** strict mode recommended.

---

## Quick start

The **preferred** way to attach Firestore triggers in tests is the high‑level **`TriggerOrchestrator`**. It coordinates registration, invocation, waiting, observation, and teardown for both **v1** and **v2** handlers — all bound to a single in‑memory database.

```ts
// test.triggers.spec.ts
import { FirestoreMock } from '@firebase-bridge/firestore-admin';
import { TriggerOrchestrator } from '@firebase-bridge/firestore-functions';
import * as v1 from 'firebase-functions/v1';
import * as v2 from 'firebase-functions/v2';

// 1) Define a stable key for each trigger (enum recommended)
enum AppTrigger {
  OnUserCreate = 'OnUserCreate',
  OnUserWritten = 'OnUserWritten',
}

// 2) Create an in-memory Firestore database
const env = new FirestoreMock();
const ctrl = env.createDatabase();
const db = ctrl.firestore();

// 3) Construct the orchestrator and register handlers via the registrar callback
const triggers = new TriggerOrchestrator<AppTrigger>(ctrl, (reg) => {
  // v1: background function
  reg.v1(
    AppTrigger.OnUserCreate,
    v1.firestore.document('users/{uid}').onCreate(async (snap, ctx) => {
      // Always return a Promise (use async/await)
      await db
        .collection('audit')
        .add({ uid: ctx.params.uid, name: snap.data()?.name });
    })
  );

  // v2: CloudEvent function
  reg.v2(
    AppTrigger.OnUserWritten,
    v2.firestore.onDocumentWritten('users/{uid}', async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();
      await db
        .collection('changeLog')
        .add({ uid: event.params.uid, before, after });
    })
  );
});

// 4) Drive changes and assert effects
it('fires v1/v2 triggers', async () => {
  await db.collection('users').doc('u1').set({ name: 'Ada' });
  await db.collection('users').doc('u1').update({ name: 'Ada Lovelace' });

  // Optionally await a specific invocation
  await triggers.waitOne(AppTrigger.OnUserWritten, { timeout: 2000 });
});

// 5) Teardown — release orchestrator and database resources
afterAll(() => {
  triggers.detach();
  ctrl.delete(); // or env.deleteAll()
});
```

> **Use your real production handlers:** You don’t need to write test-only handlers—import the Cloud Function exports from your app and register them here. The orchestrator expects the wrapped CloudFunction objects created by `firebase-functions` `v1`/`v2` (i.e. the things you export for production), not raw `(change, ctx) => {}` functions.

```ts
// Example: registering production exports
import { onUserCreate } from '@my-app/functions/users'; // v1 export
import { onUserWritten } from '@my-app/functions/audit'; // v2 export

const triggers = new TriggerOrchestrator<AppTrigger>(ctrl, (reg) => {
  reg.v1(AppTrigger.OnUserCreate, onUserCreate); // v1 CloudFunction
  reg.v2(AppTrigger.OnUserWritten, onUserWritten); // v2 CloudFunction
});
```

> **Enabled by default:** After construction, the orchestrator enables all registered triggers. You can pause all invocations by setting `triggers.suspended = true` during setup, then set it back to `false` to resume.

### Why `async`/`await` matters

Handlers **must** be declared `async` (or return a `Promise`) so the orchestrator can **await** completion and **capture errors** thrown inside your handler. This mirrors production Cloud Functions behavior and prevents silent failures in tests.

### Proper teardown

At the end of each suite, always release resources to prevent leaked timers/listeners:

```ts
afterAll(() => {
  triggers.detach(); // unregisters all orchestrated triggers & cancels waiters
  ctrl.delete(); // or env.deleteAll() to clear the environment
});
```

---

## Alternate: Direct `registerTrigger` usage

> You can register triggers directly with `registerTrigger()` from the `v1` and `v2` submodules. This provides a lightweight option for simple suites.
> Use this approach when you need a minimal harness without orchestration or statistics.

```ts
import { FirestoreMock } from '@firebase-bridge/firestore-admin';
import * as v1 from 'firebase-functions/v1';
import * as v2 from 'firebase-functions/v2';
import * as bridgeV1 from '@firebase-bridge/firestore-functions/v1';
import * as bridgeV2 from '@firebase-bridge/firestore-functions/v2';

const env = new FirestoreMock();
const ctl = env.createDatabase();
const db = ctl.firestore();

// v1 trigger
bridgeV1.registerTrigger(
  ctl,
  v1.firestore.document('users/{uid}').onCreate(async (snap, ctx) => {
    await db.collection('audit').add({ uid: ctx.params.uid });
  })
);

// v2 trigger
bridgeV2.registerTrigger(
  ctl,
  v2.firestore.onDocumentWritten('users/{uid}', async (event) => {
    await db.collection('changeLog').add({ uid: event.params.uid });
  })
);
```

> You can also register production exports directly:

```ts
import { onUserCreate } from '@my-app/functions/users';

bridgeV1.registerTrigger(ctl, onUserCreate);
```

### Optional per-event predicate (advanced)

> **Scope:** Predicates apply to the **direct** `registerTrigger` helpers (v1/v2). The `TriggerOrchestrator` does **not** accept per‑event predicates; use `suspended`, `observe()`, or the `wait*` utilities for orchestration‑level control.

You can attach a **synchronous predicate** to any registered trigger to **gate** invocation after the route matches and the change kind (create/update/delete/write) is determined. If the predicate returns `false`, the handler is **not** invoked for that event.

- Signature: `(arg: TriggerEventArg) => boolean`
- Receives low-level event data (e.g., params, doc path/snap info) for precise control
- Great for **feature flags**, **test-scoped filters**, or **param-based gating**

```ts
// Continuing from the Quick start example...

let enabled = true;

// v1: only run when `enabled` is true
const disposeV1 = bridgeV1.registerTrigger(
  ctl,
  v1.firestore.document('users/{uid}').onCreate(async (snap, ctx) => {
    // ... your v1 handler ...
  }),
  () => enabled
);

// v2: only run for a specific route param (e.g., uid starts with "test-")
const disposeV2 = bridgeV2.registerTrigger(
  ctl,
  v2.firestore.onDocumentWritten('users/{uid}', async (event) => {
    // ... your v2 handler ...
  }),
  (arg) => arg.params.uid?.startsWith('test-') === true
);

// Drive changes
await db.collection('users').doc('user-1').set({ name: 'Alice' }); // v1 gated off, v2 gated off
enabled = true;
await db.collection('users').doc('test-2').set({ name: 'Bob' }); // v1 + v2 both allowed

// Clean up
disposeV1();
disposeV2();
```

> Predicates run **in-process** and must be synchronous. If omitted, the trigger runs for **all** matching events.

> Predicates run per delivered change after commit coalescing. In a batch that mutates multiple docs, a counter-based predicate (like “allow from the second event”) applies to the dispatch order of those changes, not to a specific doc. For doc-specific gating, use a param/data predicate (e.g., `arg.params.uid?.startsWith('test-')`).

---

## Core concepts & API

### `type TriggerKey`

`string | number` — A logical identifier you choose for each trigger (enums recommended). Keys are **unique** within an orchestrator and are required for per‑trigger operations.

### `class TriggerOrchestrator<TKey extends TriggerKey>`

Coordinates **v1** and **v2** Firestore triggers bound to a single in‑memory database.

```ts
constructor(
  ctrl: FirestoreController,
  register: (registrar: TriggerRegistrar<TKey>) => void
)
```

**Lifecycle & control**

- `epoch: number` — The database **epoch** the orchestrator is currently bound to. Only trigger events whose stamped epoch matches this value are processed; events from prior/reset epochs are ignored to ensure test isolation and prevent leakage of late async work from earlier runs. The `epoch` automatically rebinds whenever the bound database is reset.
- `suspended: boolean` — When `true`, blocks new invocations at the registration gate (handlers are not entered; stats/observers do not change).
- `attach(): void` — Enables **all** registered triggers (does not clear observers/waiters).
- `detach(): void` — Disables all triggers, **clears observers**, and **cancels active waiters**. Stats are not cleared.
- `reset(): void` — Detaches, zeroes all counters, and re‑attaches every registered trigger.
- `dipose(): void` — Releases all resources and dipsoses the instance.
- `all(enable: boolean): void` — Enable/disable all triggers at once.
- `enable(...keys: TKey[]): void` / `disable(...keys: TKey[]): void` — Per‑key enable/disable (throws if a key wasn’t registered).
- `isEnabled(key: TKey): boolean` — Current enable state.

**Stats & observation**

- `getStats(key: TKey): TriggerStats<TKey>` — Immutable snapshot of per-key counters.
- `observe(key: TKey, observer: TriggerObserver<TKey>): () => void` — Attach `before`/`after`/`error` hooks for a key.
- `on(key: TKey, callback: (arg: OrchestratorEventArg<TKey>) => void): () => void` — Attach an `after` hook for a key.
- `observeAll(observer: TriggerObserver<TKey>): () => void` — Attach the same observer to **all currently registered triggers**. Its `before`, `after`, and `error` callbacks fire for every trigger key using the same semantics as `observe`. Returns an unsubscribe function that removes the observer from all keys.
- `onAll(callback: (arg: OrchestratorEventArg<TKey>) => void): () => void` — Register the same **post-invocation** (`after`) callback for all registered triggers. Equivalent to `observeAll({ after: callback })`. Returns an unsubscribe function that removes this callback from all keys.
- `watchErrors(cb: TriggerErrorWatcher<TKey>): () => void` — Global watcher for any error raised by a trigger or observer.

**Deterministic waiting**

- `waitOne(key: TKey, options?: WaitOptions): Promise<OrchestratorEventArg<TKey>>` — Wait for the **next success** for a key.
- `wait(key: TKey, predicate: (e: OrchestratorEventArg<TKey>) => boolean, options?: WaitOptions)` — Wait until a **predicate** over the extended event arg matches.
- `waitOneError(key: TKey, options?: WaitErrorOptions): Promise<OrchestratorErrorEventArg<TKey>>` — Wait for the **next failure** for a key.
- `waitError(key: TKey, predicate: (arg: OrchestratorErrorEventArg<TKey>) => boolean, options?: WaitErrorOptions): Promise<OrchestratorErrorEventArg<TKey>>` — Wait until a **predicate** over the error event arg matches.

**WaitOptions**

- `timeout?: number` (default **3000ms**) — Reject if not satisfied in time.
- `cancelOnError?: boolean` (default **false**) — If `true`, a matching error will **cancel** the waiter before its predicate can succeed.

**WaitErrorOptions**

- `timeout?: number` (default **3000ms**) — Reject if not satisfied in time.

### `interface TriggerRegistrar<TKey extends TriggerKey>`

Registrar passed to the orchestrator’s constructor. Use it to associate handlers with keys.

```ts
v1<T extends TriggerPayloadV1>(key: TKey, handler: CloudFunctionV1<T>): void
v2<T>(key: TKey, handler: CloudFunctionV2<CloudEvent<T>>): void
```

### `interface TriggerStats<TKey>`

```
{ key: TKey; initiatedCount: number; completedCount: number; errorCount: number }
```

### `interface OrchestratorEventArg<TKey>`

Extends `TriggerEventArg` (the low‑level Firestore change info) **and** `TriggerStats<TKey>` for the key.

### `interface OrchestratorErrorEventArg<TKey>`

Extends `OrchestratorEventArg<TKey>` with:

- `origin: "trigger" | "onBefore" | "onAfter" | ...` — Where the error came from.
- `cause: unknown` — The underlying error thrown/rejected.

### `interface TriggerObserver<TKey>`

Optional hooks for a key:

- `before(arg)` — Runs **just before** the handler executes (after `suspended` gate).
- `after(arg)` — Runs only when the handler **fulfills**.
- `error(arg, cause)` — Runs only when the handler **throws/rejects**.

> **Semantics recap:** Triggers fire **after commit**; multiple writes to the same doc within a commit are **coalesced** to a single event; timestamps derive from the mock’s **SystemTime**; triggers are **enabled by default** upon construction.

---

## Supported trigger shapes

**v1 (`firebase-functions/v1`)**

- `functions.firestore.document('path').onCreate(handler)`
- `onUpdate(handler)`
- `onDelete(handler)`
- `onWrite(handler)` (called on any of the above)

**v2 (`firebase-functions/v2`)**

- `firestore.onDocumentCreated('path', handler)`
- `firestore.onDocumentUpdated('path', handler)`
- `firestore.onDocumentDeleted('path', handler)`
- `firestore.onDocumentWritten('path', handler)`

All handlers receive **Admin SDK snapshots** (v1) or **CloudEvent** payloads (v2) with appropriate route params populated from the `path` pattern (e.g., `{uid}` → `ctx.params.uid` in v1 or `event.params.uid` in v2 where applicable).

---

## Event semantics & fidelity

- **Commit boundary**: Triggers run **after** a transaction/batch commit is applied.
- **Coalescing**: If the same document is written multiple times within a single commit, only the **final** change for that path is delivered to triggers.
- **Ordering**: Changes dispatch in the order they are **committed**, not necessarily the order inside your application code.
- **Timestamps**: Event times derive from the mock’s **SystemTime**; align your test clock as needed.
- **`before/after`**: Provided per trigger kind; v1 uses `Change<QueryDocumentSnapshot|DocumentSnapshot>`, v2 wraps the `Change` in a `CloudEvent`.
- **Subjects/params**: Route parameters (e.g., `{uid}`) are extracted from the changed path. v2 **CloudEvent** fields (`id`, `source`, `subject`, `type`, `time`) are populated consistently for testing.

> The goal is to match Cloud Functions behavior closely enough for robust tests. If you observe divergence from the emulator or production, please file a minimal repro.

---

## Testing patterns

### Fast test loops

- Prefer **one environment + database** per suite, with `env.resetAll()` in `afterEach()`.
- For hard isolation between tests, create a **fresh database** via `env.createDatabase()` inside `beforeEach()` and dispose with `env.deleteAll()` afterward.

### Asserting effects

- Your triggers often write to Firestore; assert via reads on the **same in-memory DB**.
- For non‑Firestore side effects (e.g., Pub/Sub publish), inject **test doubles** into your handler code so you can assert invocations.

### Time control

- Coordinate clock control with **`env.systemTime`** from **[@firebase-bridge/firestore-admin](https://www.npmjs.com/package/@firebase-bridge/firestore-admin)**.
- If your handler uses `Timestamp.now()`, consider Jest/Vitest **fake timers** to align global time, or patch `Timestamp.now` in a scoped way (see the admin README’s SystemTime notes).

---

## Non‑Firestore dependencies

This package focuses on **Firestore** trigger invocation. You can register **any** Cloud Function, but for behaviors that involve other GCP services you must supply the dependency yourself:

- **Pub/Sub**: wrap `publish` behind an interface and inject a mock in tests (or point to the Pub/Sub emulator).
- **Scheduler**: invoke the handler directly with crafted context/time values.
- **Auth/Storage/Other**: inject test doubles or emulator clients and structure your handler for DI so tests and production share code paths.

> In short: **registration is supported for all function types**, but this package only **emits Firestore events**; it does not emulate other products. Keep non‑Firestore calls behind thin abstractions for easy testing.

## Compatibility & peer deps

- **Peer dependencies**: `firebase-admin`, `firebase-functions`
- **Node**: >= 18
- Works with **Jest** or **Vitest** in Node test environments (ESM or CJS).

---

## Caveats & limitations

- **Emulator parity** is a goal, but some highly niche edge cases may differ.
- **Network behaviors** (retries/backoff, streaming resets) are not simulated; triggers run in‑process.
- **Partitioned queries** in the mock Admin layer are currently **stubbed** (empty stream). If your triggers depend on real partitioning, use the emulator/Firestore.

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

# @firebase-bridge/firestore-functions

> Bind **`firebase-functions` v1 & v2 Firestore triggers** to an **in-memory Firestore** database from `@firebase-bridge/firestore-admin`. Enables fast, deterministic end‑to‑end trigger testing with no emulator boot or deploy loop.

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
  - Suited to tight test loops and CI where startup cost s, coalescing, route params)

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

## What this does

- Adapts **Firestore trigger handlers** declared using `firebase-functions` **v1** (background functions) and **v2** (CloudEvents) so they are **invoked** by changes in the **in‑memory** database
- Generates **realistic event payloads** (params/subject IDs, `Change` vs `CloudEvent<Change<...>>`, `before`/`after` snapshots or v2 `data` shape) and metadata (event time/ID) suitable for backend tests
- Preserves **commit semantics**: for multiple writes to the **same document** in a single atomic commit, **only the final state** for that path is delivered to triggers (no intermediary bleed‑through)
- Respects **transaction/batch** boundaries; triggers fire **after** the commit is applied
- Uses the mock’s **SystemTime** for event timestamps so your tests can be deterministic

> **Note:** You can register **any compatible Cloud Function**. This package simulates **Firestore change events and snapshots** only; if your handler uses other Google Cloud services (Pub/Sub, Scheduler, Auth, Storage, etc.), provide your own **test doubles/mocks** or bind to those services' emulators for testing.

---

## Quick start

Trigger binding is **explicit** (unlike production, where deploy-time discovery wires everything automatically). In tests, you must register each function you want to exercise.

```ts
// test.triggers.spec.ts
import { FirestoreMock } from '@firebase-bridge/firestore-admin';
import * as v1 from 'firebase-functions/v1';
import * as v2 from 'firebase-functions/v2';
import * as bridgeV1 from '@firebase-bridge/firestore-functions/v1';
import * as bridgeV2 from '@firebase-bridge/firestore-functions/v2';

// 1) Define your production-style triggers (v1 + v2)
const onUserCreateV1 = v1.firestore
  .document('users/{uid}')
  .onCreate(async (snap, ctx) => {
    // ... your handler code ...
  });

const onUserWrittenV2 = v2.firestore.onDocumentWritten(
  'users/{uid}',
  async (event) => {
    // event.data.before / event.data.after (v2 CloudEvent payload)
  }
);

// 2) Create an in-memory Firestore database
const env = new FirestoreMock();
const ctl = env.createDatabase();
const db = ctl.firestore();

// 3) Register triggers explicitly against this database
bridgeV1.registerTrigger(ctl, onUserCreateV1);
bridgeV2.registerTrigger(ctl, onUserWrittenV2);

// 4) Drive changes and assert effects
it('fires v1/v2 triggers', async () => {
  const ref = db.collection('users').doc('u1');
  await ref.set({ name: 'Ada' }); // should fire onCreate (v1) and onWritten (v2)

  // ...assert your effects (writes, logs, test doubles, etc.)
});
```

> You can register **many** triggers for the same database/controller — even your entire production set — to simulate a full backend in tests.

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

- Coordinate clock control with **`env.systemTime`** from `@firebase-bridge/firestore-admin`.
- If your handler uses `Timestamp.now()`, consider Jest/Vitest **fake timers** to align global time, or patch `Timestamp.now` in a scoped way (see the admin README’s SystemTime notes).

---

## Non‑Firestore dependencies

This package focuses on **Firestore** trigger invocation. You can register **any** Cloud Function, but for behaviors that involve other GCP services you must supply the dependency yourself:

- **Pub/Sub**: wrap `publish` behind an interface and inject a mock in tests (or point to the Pub/Sub emulator).
- **Scheduler**: invoke the handler directly with crafted context/time values.
- **Auth/Storage/Other**: inject test doubles or emulator clients and structure your handler for DI so tests and production share code paths.

> In short: **registration is supported for all function types**, but this package only **emits Firestore events**; it does not emulate other products. Keep non‑Firestore calls behind thin abstractions for eas

## Compatibility & peer deps

- **Peer dependencies**: `firebase-admin`, `firebase-functions`
- **Node**: >= 18
- Works with **Jest** or **Vitest** in Node test environments (ESM or CJS).

---

## Caveats & limitations

- **Emulator parity** is a goal, but some highly niche edge cases may differ.
- **Network behaviors** (retries/backoff, streaming resets) are not simulated; triggers run in‑process.
- **Partitioned queries** (`CollectionGroup.getPartitions()` / `Query.getPartitions()`) in the mock Admin layer are currently **stubbed** (empty stream). If your triggers depend on real partitioning, use the emulator/Firestore.

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

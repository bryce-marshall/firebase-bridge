# Firebase‑Bridge Workspace

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license) ![node >=18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)

Developer‑focused overview of the **Firebase‑Bridge** monorepo. This workspace provides an **in‑memory Firestore Admin SDK mock** and **Cloud Functions trigger binding** utilities to enable fast, deterministic testing of backend code, plus a shared test‑suite to verify parity against the Firebase Emulator.

---

## Support

This project is made freely available under the [Apache 2.0 License](#license).  
If you find it useful and would like to support ongoing development, you can [buy me a coffee](https://buymeacoffee.com/brycemarshall). ☕

---

## Intent

* **Move fast**: iterate on triggers and backend logic without the emulator boot/deploy loop.
* **High fidelity**: mirror Firestore Admin SDK semantics (writes, transforms, queries, listeners, vector values, etc.).
* **Trust but verify**: run the same suites against the **mock** and the **emulator** to catch divergences early.

---

## Output npm packages & licensing

| Package                                  | Project (this repo)            | Purpose                                                                       | License        |
| ---------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------- | -------------- |
| **@firebase-bridge/firestore-admin**     | `packages/firestore-admin`     | High‑fidelity **in‑memory Firestore Admin SDK** mock for unit tests           | **Apache‑2.0** |
| **@firebase-bridge/firestore-functions** | `packages/firestore-functions` | Binds **`firebase-functions` v1 & v2** Firestore triggers to the in‑memory DB | **Apache‑2.0** |

> Licensing: The workspace uses **Apache‑2.0**. Some files adapt Google code (e.g., `googleapis/nodejs-firestore`); those files carry upstream headers and a modification notice. See each package’s `LICENSE` and (where applicable) `NOTICE`.

---

## Projects (at repo root)

* **`packages/firestore-admin`** — implementation of `@firebase-bridge/firestore-admin` (the in‑memory Firestore Admin SDK mock). Tests run **in‑process** (no emulator).
* **`packages/firestore-functions`** — implementation of `@firebase-bridge/firestore-functions` (trigger binding for `firebase-functions` v1/v2). Tests run **in‑process** (no emulator). Binding is **explicit** in tests.
* **`firestore-bridge-test-suites`** — shared, black‑box test suites that exercise Firestore behavior via public APIs. Consumed by both the mock and emulator runners.
* **`firestore-bridge-production`** — test runner that targets the **Firebase Emulator** and forwards to `firestore-bridge-test-suites` to validate parity.
* **`smoke/smoke-consumer`** — a tiny app that consumes the locally built packages, verifying installability, published shape, and dual CJS/ESM execution.

> **Workspaces:** The root `package.json` declares workspaces:
>
> * `packages/*`
> * `firestore-bridge-production`
> * `firestore-bridge-test-suites`
> * `smoke/*`

### Repository structure

```txt
.
├─ packages/
│  ├─ firestore-admin/             # @firebase-bridge/firestore-admin (in-memory Admin SDK)
│  │  ├─ src/
│  │  ├─ jest.config.ts
│  │  └─ package.json
│  └─ firestore-functions/         # @firebase-bridge/firestore-functions (v1/v2 trigger binding)
│     ├─ src/
│     ├─ jest.config.ts
│     └─ package.json
├─ firestore-bridge-production/    # emulator-backed test runner
│  ├─ src/
│  ├─ jest.config.ts
│  └─ package.json
├─ firestore-bridge-test-suites/   # shared suites used by both runners
│  ├─ src/
│  ├─ jest.config.ts
│  └─ package.json
├─ smoke/
│  └─ smoke-consumer/              # consumer app for smoke-testing built packages
│     ├─ src/
│     ├─ dist/
│     └─ package.json
├─ .scripts/
│  └─ start-emulators.js
├─ nx.json
├─ package.json                    # workspaces root (private)
├─ tsconfig.base.json
└─ README.md
```

---

## Prerequisites

* **Node.js ≥ 18** (repo uses `@types/node@18.16.9`)
* Local install of **Nx** (invoked via `npx nx`) and **Jest** via devDependencies
* Firebase Emulator (only needed for `firestore-bridge-production` tests)

Install dependencies at the repo root:

```bash
npm i
```

---

## Root workspace metadata

From `package.json` (root):

* **Name:** `@firebase-bridge/source` (**private**)
* **License (root):** **Apache‑2.0**
* **Scripts:**

  * `npm test` → `jest --detectOpenHandles`
  * `npm run firebase-emulators:start` → runs `./.scripts/start-emulators.js`
* **Dependencies (runtime):**

  * `firebase-admin@^13.4.0`
  * `firebase-functions@^6.4.0`
  * `google-gax@>=5 <6`
* **Dev dependencies (tooling excerpt):**

  * `nx@21.2.3`, `typescript@~5.8.2`, `jest@^29.7.0`
  * ESLint 9 + `typescript-eslint@^8.40.0`, Prettier 2
  * Both **@swc/jest** and **ts-jest** are available; use per-project Jest config

---

## Build & project info (Nx + TypeScript)

Use TypeScript project references or Nx to build/inspect:

```bash
# TypeScript build (shared test suites)
npx tsc -b firestore-bridge-test-suites

# Nx builds (per project)
npx nx run firestore-admin:build
npx nx run firestore-functions:build

# Show Nx project info
npx nx show project firestore-admin
```

---

## Testing

### In‑process (mock) tests

For **`firestore-admin`** and **`firestore-functions`** the unit tests run entirely **in process** — no emulator, no special init.

```bash
# Run tests per project
npx jest firestore-admin
npx jest firestore-functions
```

### Emulator tests

For **`firestore-bridge-production`**, start the emulator first, then run tests:

```bash
npm run firebase-emulators:start
npx jest firestore-bridge-production
```

> The production runner imports the same `firestore-bridge-test-suites` to verify behavioral consistency with the mock.

### Run all tests

```bash
npm run firebase-emulators:start
npx jest
```

---

## Trigger binding (tests)

In production, Cloud Functions are wired at deploy time. In tests, **binding is explicit** so you decide which triggers to exercise.

```ts
import { FirestoreMock } from '@firebase-bridge/firestore-admin';
import * as v1 from 'firebase-functions/v1';
import * as v2 from 'firebase-functions/v2';
import * as bridgeV1 from '@firebase-bridge/firestore-functions/v1';
import * as bridgeV2 from '@firebase-bridge/firestore-functions/v2';

const onUserCreateV1 = v1.firestore
  .document('users/{uid}')
  .onCreate(async (snap, ctx) => { /* ... */ });

const onUserWrittenV2 = v2.firestore
  .onDocumentWritten('users/{uid}', async (event) => { /* ... */ });

const env = new FirestoreMock();
const ctl = env.createDatabase('proj', '(default)');
const db  = ctl.firestore();

bridgeV1.registerTrigger(ctl, onUserCreateV1);
bridgeV2.registerTrigger(ctl, onUserWrittenV2);

await db.collection('users').doc('u1').set({ name: 'Ada' });
```

---

## Deterministic time in tests

The mock exposes a controllable clock (`SystemTime`) to make **commit/write/update times** deterministic. Internal timestamps and `FieldValue.serverTimestamp()` respect this clock.

* If your code calls `Timestamp.now()`, note that it uses the **real clock** by default. You can align global time with your test runner’s fake timers or patch `Timestamp.now()` in a scoped way.

---

## Known limits (mock layer)

* **Partitioned queries** (`CollectionGroup.getPartitions()` / `Query.getPartitions()` → GAPIC `partitionQuery`) are currently **stubbed** and return an **empty stream**.

---

## Publishing

Follow this checklist when publishing any Firebase‑Bridge package.

### 1. Prepare package metadata

Each package must define:

* `name`, `version`, and `license: "Apache‑2.0"`
* `files` whitelist (e.g., `cjs/`, `esm/`, `LICENSE`, `NOTICE`, `README.md`, `package.json`)
* `publishConfig.access: "public"`
* Correct `exports` and `types` entries for both ESM and CJS
* `sideEffects: false` unless the module performs work on import

Include **LICENSE** in every package. Add a **NOTICE** file where Google‑derived code exists.

### 2. Build artifacts

Run the Nx build targets or package scripts to generate both ESM and CJS outputs:

```bash
npx nx run firestore-admin:build
npx nx run firestore-functions:build
```

### 3. Sanity check before publishing

Refer to `smoke/smoke-consumer/README.md` for pre‑publish validation steps. This confirms installability, import behavior, and type resolution in both CJS and ESM environments.

### 4. Verify publish output

From each package directory:

```bash
npm publish --dry-run
```

Confirm the tarball contents include only built files, licenses, and docs (no TypeScript sources).

### 5. Authenticate with npm

Login once via:

```bash
npm login
```

Ensure your account has publish rights under the `@firebase-bridge` scope.

### 6. Publish

From each package root:

```bash
npm publish --access public
```

Use `--tag next` for prereleases if desired.

### 7. Tag the release in Git

Tag each package individually:

```bash
git tag -a firestore-admin-v0.0.1 -m "firestore-admin v0.0.1"
git tag -a firestore-functions-v0.0.1 -m "firestore-functions v0.0.1"
git tag -a auth-context-v0.0.1 -m "auth-context v0.0.1"
git push --tags
```

### 8. Post‑publish

* Confirm packages appear on npm and can be installed directly.
* Update GitHub releases and changelog as needed.

---

## Contributing

* Keep behavior parity with the Admin SDK and the Emulator as a priority.
* Add/extend test cases in `firestore-bridge-test-suites` and run against both runners.
* If behavior diverges, prefer matching the **real** Firestore semantics.

---

## License

**Apache‑2.0** © 2025 Bryce Marshall — applies to the entire workspace and all published packages.

* Each package ships a `LICENSE` (Apache‑2.0).
* Packages containing adapted Google files also ship a `NOTICE` and preserve upstream headers with a modification notice.

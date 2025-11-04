# @firebase-bridge/auth-context

> High-fidelity **mock invocation layer** for **Firebase HTTPS Cloud Functions** (v1 & v2). Purpose-built for fast, deterministic backend unit tests without network calls or the Functions emulator.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)

### What it is

This package provides a realistic **in-memory invocation harness** for Firebase **HTTPS Cloud Functions**. It supports both **v1** (`firebase-functions/v1`) and **v2** (`firebase-functions/v2`) APIs, enabling deterministic local execution of callable (`onCall`) and request (`onRequest`) handlers.

* Works with **real function handlers** — no stubbing or rewriting required.
* Simulates **auth**, **App Check**, **instance ID**, and **request metadata**.
* Provides configurable identity and contextual overrides.
* Designed for **fast, side-effect-free tests** — no emulator or deployment loop.

> **Important:** `@firebase-bridge/auth-context` mocks the **invocation context**, not the Cloud Functions SDK itself. Your handlers execute exactly as they would in production — the mock simply supplies realistic `Request`, `Response`, and context objects, allowing you to test business logic locally and deterministically.

### When to use it

* Unit tests for Cloud Function handlers (`onCall`, `onRequest`).
* CI environments where the **Functions Emulator** is unavailable or slow.
* Deterministic handler testing with realistic auth & request data.

### Companion Packages

* For a high-fidelity **in-memory mock** for the **Firestore Admin SDK** purpose-built for fast, deterministic backend unit tests (no emulator boot, no deploy loop) use the companion package **[@firebase-bridge/firestore-admin](https://www.npmjs.com/package/@firebase-bridge/firestore-admin)**.
* To bind firebase-functions (v1 & v2) Firestore triggers to an in-memory Firestore database use the companion package **[@firebase-bridge/firestore-functions](https://www.npmjs.com/package/@firebase-bridge/firestore-functions)**.

---

## Install

```bash
# npm
npm i -D @firebase-bridge/auth-context firebase-functions

# pnpm
pnpm add -D @firebase-bridge/auth-context firebase-functions

# yarn
yarn add -D @firebase-bridge/auth-context firebase-functions
```

> **Peer deps:** `firebase-functions` • **Node:** 18+ recommended • **TS:** strict mode recommended.

---

## Quick start

This package is built around a single orchestrator: **`AuthManager`**. You register one or more identities up front (by key), then invoke real Firebase HTTPS handlers (v1 or v2) against those identities. The manager synthesizes realistic `auth`, App Check, timestamps, and request metadata.

### 1) Set up the manager

```ts
import { AuthManager } from '@firebase-bridge/auth-context';

const auth = new AuthManager({
  projectId: 'demo-project',
  region: 'us-central1',
});
```

### 2) Register identities

```ts
auth.register('alice', {
  signInProvider: 'google.com',
  // optionally: uid, email, custom claims, appCheck, timestamps…
});
auth.register('anon', {
  signInProvider: 'anonymous',
});
```

> **Why register?** The manager needs a stable definition of “who is calling” so it can build a realistic Firebase `CallableContext` / `Request` for every test. Using an unknown key throws — this helps catch typos in tests.

---

## Invoking HTTPS functions

The manager exposes a symmetric surface for **v1** and **v2** via `auth.https.v1` and `auth.https.v2`. Both support `onCall(...)` and `onRequest(...)`.

### v1 callable example

```ts
import { runWith } from 'firebase-functions/v1';
import { AuthManager } from '@firebase-bridge/auth-context';

const auth = new AuthManager();
auth.register('alice', { signInProvider: 'google.com' });

export const addNumbers = runWith({}).https.onCall((data, context) => {
  return {
    sum: (data.a ?? 0) + (data.b ?? 0),
    caller: context.auth?.uid ?? null,
  };
});

it('adds numbers as alice', async () => {
  const res = await auth.https.v1.onCall(
    { key: 'alice', data: { a: 2, b: 3 } },
    addNumbers
  );
  expect(res.sum).toBe(5);
  expect(res.caller).toMatch(/^uid_/);
});
```

### v2 callable example

```ts
import { runWith } from 'firebase-functions/v2';
import { AuthManager } from '@firebase-bridge/auth-context';

const auth = new AuthManager();
auth.register('bob', { signInProvider: 'google.com' });

export const greet = runWith({}).https.onCall((req) => {
  const name = req.data?.name ?? 'stranger';
  return { message: `Hello, ${name}!`, appId: req.app?.appId ?? 'n/a' };
});

it('greets bob', async () => {
  const res = await auth.https.v2.onCall(
    { key: 'bob', data: { name: 'Bob' } },
    greet
  );
  expect(res.message).toBe('Hello, Bob!');
});
```

### Request-style handlers (v1 or v2)

Request handlers receive a mock Express-like `Request` and a mock `Response` (from `node-mocks-http`). You can shape the request via `options`.

```ts
import { runWith } from 'firebase-functions/v1';
import { AuthManager } from '@firebase-bridge/auth-context';

const auth = new AuthManager();
auth.register('carol', { signInProvider: 'google.com' });

const hello = runWith({}).https.onRequest((req, res) => {
  res.status(200).json({
    method: req.method,
    path: req.path,
    uid: (req as any).auth?.uid ?? null,
  });
});

it('invokes request handler as carol', async () => {
  const response = await auth.https.v1.onRequest(
    {
      key: 'carol',
      options: {
        method: 'GET',
        path: '/hello',
      },
    },
    hello
  );

  expect(response._getStatusCode()).toBe(200);
  const body = response._getJSONData();
  expect(body.uid).toMatch(/^uid_/);
});
```

---

## Core concepts

### 1. `AuthManager` (primary export)

This is the entry point you’ll use in tests.

* Holds defaults for project, region, and time.
* Keeps a registry of **identities** keyed by string.
* Knows how to build realistic **Firebase auth** and **App Check** data per invocation.
* Produces **inspectable** mock HTTP responses.

**Key members (conceptual):**

* `register(key, identity)` — define who “alice”, “bob”, etc. are.
* `https.v1.onCall(request, handler)` — call a v1 callable handler with a mock context.
* `https.v2.onCall(request, handler)` — call a v2 callable handler with a mock context.
* `https.v1.onRequest(request, handler)` — call a v1 request handler with a mock `Request`/`Response`.
* `https.v2.onRequest(request, handler)` — same for v2.

> The actual source exports additional request/identity types — those are there to let you describe the call more precisely (custom headers, custom timestamps, explicit App Check, etc.).

### 2. Registered identities

Identities describe what Firebase would have put in `context.auth` (v1) or `req.auth` (v2): provider, UID shape, timestamps, etc. The library generates realistic IDs and OAuth provider IDs so your unit tests don’t drift too far from production.

### 3. Deterministic time

The manager can be constructed with an explicit `now()` so token timestamps, issued-at, and expirations are all stable across tests. This is especially useful if you later assert on token fields.

---

## Per-call overrides

Most request descriptors in this package share a common shape:

* **who** is calling (`key`)
* **what** they’re sending (`data`)
* **how** the HTTP request should look (for `onRequest`)
* **how** tokens should be timestamped or constructed

This is expressed via the exported request types (e.g. `CallableFunctionRequest`, `RawHttpRequest`) that you already have in your source. At test time, you pass a plain object with the relevant fields — the manager fills in the Firebase bits.

### Callable overrides

```ts
await auth.https.v2.onCall(
  {
    key: 'alice',
    data: { ping: true },
    // token shaping
    iat: Date.now() / 1000,
    expires: (Date.now() + 30 * 60_000) / 1000,
    // raw request decoration
    headers: {
      'x-test-scenario': 'v2-callable',
    },
  },
  handler
);
```

### Request overrides

```ts
await auth.https.v1.onRequest(
  {
    key: 'alice',
    options: {
      method: 'POST',
      path: '/widgets?limit=10',
      headers: { 'content-type': 'application/json' },
      body: { limit: 10 },
    },
  },
  handler
);
```

Behind the scenes the library still synthesizes the Firebase headers (auth, app check, emulator hints, etc.) — you only specify the parts your test actually cares about.

---

## Using it with an app-local façade (recommended pattern)

If your production code already calls something like `MyApp.verifyIdToken(req)` (instead of calling the Admin SDK directly), you can plug `@firebase-bridge/auth-context` straight into that abstraction for tests.

**Example façade:**

```ts
import { DecodedAppCheckToken } from 'firebase-admin/app-check';
import { DecodedIdToken } from 'firebase-admin/auth';

export interface FirebaseAppConfig {
  now: () => Date;
  appCheckTokenVerifier: (request: Request) => DecodedAppCheckToken | undefined;
  idTokenVerifier: (request: Request) => DecodedIdToken | undefined;
}

export class FirebaseApp {
  private _config: FirebaseAppConfig | undefined;

  private assertConfig(): FirebaseAppConfig {
    if (this._config) return this._config;
    throw new Error('init has not been called.');
  }

  init(config: FirebaseAppConfig): void {
    if (this._config) throw new Error('init has already been called.');
    this._config = config;
  }

  now(): Date {
    return this.assertConfig().now();
  }

  verifyAppCheckToken(request: Request) {
    return this.assertConfig().appCheckTokenVerifier(request);
  }

  verifyIdToken(request: Request) {
    return this.assertConfig().idTokenVerifier(request);
  }
}

export const MyApp = new FirebaseApp();
```

**In tests**, initialize it with the mock verifiers exported by `@firebase-bridge/auth-context`:

```ts
import {
  getMockAppCheckToken,
  getMockIdToken,
} from '@firebase-bridge/auth-context';
import { MyApp } from './firebase-app';

MyApp.init({
  now: () => new Date(),
  appCheckTokenVerifier: getMockAppCheckToken,
  idTokenVerifier: getMockIdToken,
});
```

Now your `onRequest()`-backed APIs can call `MyApp.verifyIdToken(req)` and still get a realistic decoded token — without the real Admin SDK, without networking, and without the Functions emulator. The same façade can be initialized differently in production.

---

## Notes on fidelity

* **Auth context** — realistic UID, provider data, claims, and timestamps.
* **AppCheck** — synthesized automatically (configurable per-call and indirectly via `AuthManagerOptions`).
* **Request/Response** — fully inspectable mocks from `node-mocks-http`.
* **Headers & metadata** — follow Firebase conventions (`content-type`, `authorization`, `x-firebase-appcheck`).

---

## Versioning & compatibility

* Peer dependency: `firebase-functions` (v1/v2)
* Node.js ≥ 18 required.
* Works with both ESM and CJS TypeScript projects.

---

## Contributing

This project is in **minimal-maintainer mode**.

* **Issues first.** Open an issue for fidelity or compatibility issues.
* **PRs limited to:** bug fixes with tests, doc updates, or build hygiene.
* **Fidelity priority:** any behavioral changes must remain consistent with Cloud Functions v1/v2 semantics.

---

## License

Apache-2.0 © 2025 Bryce Marshall

---

## Trademarks & attribution

This project is **not** affiliated with, associated with, or endorsed by Google LLC. “Firebase” and “Cloud Functions” are trademarks of Google LLC. Names are used solely to identify compatibility and do not imply endo

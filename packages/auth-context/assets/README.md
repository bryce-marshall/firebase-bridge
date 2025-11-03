# @firebase-bridge/auth-context

> High-fidelity **mock invocation layer** for **Firebase HTTPS Cloud Functions** (v1 & v2). Purpose-built for fast, deterministic backend unit tests without network calls or the Functions emulator.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)

### What it is

This package provides a realistic **in-memory invocation harness** for Firebase **HTTPS Cloud Functions**. It supports both **v1** (`firebase-functions/v1`) and **v2** (`firebase-functions/v2`) APIs, enabling deterministic local execution of callable (`onCall`) and request (`onRequest`) handlers.

- Works with **real function handlers** — no stubbing or rewriting required.
- Simulates **auth**, **App Check**, **instance ID**, and **request metadata**.
- Provides configurable identity and contextual overrides.
- Designed for **fast, side-effect-free tests** — no emulator or deployment loop.

> **Important:** `@firebase-bridge/auth-context` mocks the **invocation context**, not the Cloud Functions SDK itself. Your handlers execute exactly as they would in production — the mock simply supplies realistic `Request`, `Response`, and context objects, allowing you to test business logic locally and deterministically.


### When to use it
- Unit tests for Cloud Function handlers (`onCall`, `onRequest`).
- CI environments where the **Functions Emulator** is unavailable or slow.
- Deterministic handler testing with realistic auth & request data.


### Companion Packages

- For a high‑fidelity **in‑memory mock** for the **Firestore Admin SDK** purpose‑built for fast, deterministic backend unit tests (no emulator boot, no deploy loop) use the companion package **[@firebase-bridge/firestore-admin](https://www.npmjs.com/package/@firebase-bridge/firestore-admin)**.
- To bind firebase-functions (v1 & v2) Firestore triggers to an in-memory Firestore database use the companion package **[@firebase-bridge/firestore-functions](https://www.npmjs.com/package/@firebase-bridge/firestore-functions)**.

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

### v1 callable function

```ts
import { runWith, https } from 'firebase-functions/v1';
import { AuthManager } from '@firebase-bridge/auth-context';

export const addNumbers = runWith({}).https.onCall((data, context) => {
  const { a, b } = data;
  return { result: a + b, uid: context.auth?.uid ?? null };
});

const auth = new AuthManager();
auth.register('alice', { signInProvider: 'google.com' });

describe('addNumbers', () => {
  it('adds numbers with auth', async () => {
    const res = await auth.https.v1.onCall(
      { key: 'alice', data: { a: 5, b: 7 } },
      addNumbers
    );
    expect(res.result).toBe(12);
    expect(res.uid).toMatch(/^uid_/);
  });
});
```

### v2 callable function

```ts
import { runWith, https } from 'firebase-functions/v2';
import { AuthManager } from '@firebase-bridge/auth-context';

export const greetUser = runWith({}).https.onCall((data, context) => {
  const name = data?.name ?? 'unknown';
  return { greeting: `Hello, ${name}!`, appId: context.app?.appId ?? 'none' };
});

const auth = new AuthManager();
auth.register('bob', { signInProvider: 'google' });

describe('greetUser', () => {
  it('returns a proper greeting', async () => {
    const res = await auth.https.v2.onCall(
      { key: 'bob', data: { name: 'Bob' } },
      greetUser
    );
    expect(res.greeting).toBe('Hello, Bob!');
  });
});
```

### v1/v2 request handlers

Both handler variants are accessed via the same interface:

```ts
const fn = runWith({}).https.onRequest((req, res) => {
  res.status(200).json({ path: req.path, method: req.method });
});

const auth = new AuthManager();
auth.register('carol', { signInProvider: 'google' });

const response = await auth.https.v2.onRequest(
  { key: 'carol', options: { method: 'GET', path: '/hello' } },
  fn
);
expect(response._getStatusCode()).toBe(200);
```

---

## Core concepts & API

This package focuses on deterministic and configurable Cloud Function invocation.

### `class AuthManager`

The central **identity and environment manager** for all handler invocations.

- `options: AuthManagerOptions` — defines environmental defaults (clock, app name, project ID, etc.).
- `register(key: string, identity?: IdentityConstructor): string` — registers a named identity. **Keys must be registered before use**; using an unregistered key will throw an error. Returns the uid of the registered user.
- `https.v1` — exposes v1-compatible `onCall()` and `onRequest()` methods.
- `https.v2` — exposes v2-compatible `onCall()` and `onRequest()` methods.

Anonymous identities may also be registered:

```ts
auth.register('anon', {
  signInProvider: 'anonymous',
});
```

### `AuthManagerOptions`

Construction options for `AuthManager`.

````ts
/**
 * Construction options for {@link AuthManager}.
 *
 * @remarks
 * - All values are optional; reasonable defaults are derived when omitted.
 * - `now` allows deterministic time control in tests.
 */
export interface AuthManagerOptions {
  /**
   * Function that returns the current epoch milliseconds.
   * Used to derive `iat`, `auth_time`, and `exp` when not explicitly provided.
   * Defaults to `() => Date.now()`.
   */
  now?: () => number;

  /**
   * Firebase App ID used to populate App Check tokens (`sub`, `app_id`).
   * Defaults to a synthetic value derived from {@link projectNumber}.
   */
  appId?: string;

  /**
   * Firebase **project number** used as part of the App Check audience.
   * Defaults to a synthetic value from {@link projectNumber}.
   */
  projectNumber?: string;

  /**
   * Firebase **project ID** (human-readable). Used as the App Check audience.
   * Defaults to `'default-project'`.
   */
  projectId?: string;

  /**
   * Default Cloud Functions region used by the HTTPS broker.
   * Defaults to `'nam5'`.
   */
  region?: string;
  /**
   * Allows specification of consistent oauth ids for providers where tests require them.
   * Where a provider is specified without an accompanying id, the id will be generated by
   * the `AuthManager` and will remain consistent throughout its lifecycle.
   * Example:
   * ```ts
   *    oauthIds: {
   *       'google.com': '24I2SUdn5m4ox716tbiH6MML7jv6',
   *       'apple.com': undefined,
   *    }
   */
  oauthIds?: Record<string, string | undefined>;
}
````

### OAuth ID behavior

When a registered identity specifies a known `signInProvider` (e.g. `google.com`, `apple.com`, `facebook.com`), `AuthManager` synthesizes **realistic provider IDs** for each:

| Provider     | Example ID                    |
| ------------ | ----------------------------- |
| google.com   | `100012345678901234567`       |
| apple.com    | `54321.1A2B3C4D5E6F7890.0012` |
| facebook.com | `12345678901234567`           |
| github.com   | `7654321`                     |
| twitter.com  | `87654321`                    |

This behavior mirrors real-world UID and OAuth ID shapes.

---

## Contextual invocation overrides

Every invocation supports contextual overrides for timestamps, headers, and App Check data.

### `CloudFunctionRequestBase`

The common base interface passed to `onRequest()` and `onCall()` invocations (v1/v2):

```ts
/**
 * Common fields for describing an invocation target and payload for HTTPS functions.
 *
 * @typeParam TKey - Registry key type used to look up the mock identity (via the AuthProvider).
 * @typeParam TData - Arbitrary JSON-serializable payload passed to the function (see {@link CloudFunctionsParsedBody}).
 *
 * @remarks
 * - The `key` selects which registered identity to use when synthesizing `auth` and (optionally) App Check.
 * - `region`, `project`, and `asEmulator` influence function metadata applied to the request (e.g., headers/URL shaping).
 * - `app` allows per-call override or suppression of App Check data.
 * - `functionName` is advisory metadata used by helpers to annotate the request (helpful in logs or routing).
 */
export interface CloudFunctionRequestBase<
  TKey extends AuthKey,
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> {
  /**
   * Identity registry key used to build the auth context for this invocation.
   */
  key: TKey;

  /**
   * Logical payload for the call. For `onCall`, this becomes `request.data`;
   * for `onRequest`, helpers may serialize/embed as the HTTP body depending on the mock.
   */
  data?: TData;

  /**
   * Cloud Functions region hint (e.g., `"us-central1"`).
   * If omitted, the broker/provider default region is used.
   */
  region?: string;

  /**
   * Firebase project ID hint. If omitted, the broker/provider default project ID is used.
   */
  project?: string;

  /**
   * If `true`, function metadata is marked as targeting the local emulator.
   * This may influence headers/host construction performed by helpers.
   */
  asEmulator?: boolean;

  /**
   * Optional descriptive function name. Used for diagnostics and to decorate mock request metadata.
   */
  functionName?: string;
}
```

### `RawHttpRequest`

Extends `CloudFunctionRequestBase` and applies to `onRequest()` invocations (v1/v2):

````ts
/**
 * Request descriptor for v1/v2 **`https.onRequest`** tests.
 *
 * @typeParam TKey - Registry key type used to look up the mock identity.
 * @typeParam TData - Parsed body type that your mock request may carry.
 *
 * @remarks
 * - `options` allows you to shape the Express-like request seen by the handler:
 *   method, URL, headers, query, cookies, and serialized body.
 * - Auth/App Check are still synthesized from `key` (and `app` override) by the provider,
 *   not by manually setting headers in `options`.
 */
export interface RawHttpRequest<
  TKey extends AuthKey,
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> extends CloudFunctionRequestBase<TKey, TData> {
  /**
   * Low-level request shaping options for `onRequest` handlers.
   * These are consumed by the mock HTTP layer to construct an Express-like `Request`.
   *
   * @example
   * ```ts
   * const req: RawHttpRequest<'bob', { ping: true }> = {
   *   key: 'bob',
   *   data: { ping: true },
   *   options: {
   *     method: 'POST',
   *     path: '/widgets?limit=10',
   *     headers: { 'content-type': 'application/json' },
   *     body: { ping: true },
   *   },
   * };
   * ```
   */
  options?: HttpRequestOptions;
}
````

### `AuthContextOptions`

Options controlling how a `GenericAuthContext` is synthesized.

```ts
/**
 * Options controlling how a {@link GenericAuthContext} is synthesized.
 *
 * @remarks
 * Use to override token timestamps or App Check behavior on a per-call basis.
 */
export interface AuthContextOptions {
  /**
   * Issued-at time for the ID token (seconds since epoch, or `Date`).
   * Defaults to `now()` if omitted.
   */
  iat?: number | Date;

  /**
   * Session authentication time (seconds since epoch, or `Date`).
   * Defaults to `iat - 30 minutes` if omitted.
   */
  authTime?: number | Date;

  /**
   * Expiration time for the ID token (seconds since epoch, or `Date`).
   * Defaults to `iat + 30 minutes` if omitted.
   */
  expires?: number | Date;

  /**
   * Per-invocation App Check override.
   * - Provide an `AppCheckConstructor` object to override default synthesized token fields.
   * - Provide `true` or omit to automatically synthesize an app check.
   * - Provide `false` to omit App Check entirely.
   */
  appCheck?: AppCheckConstructor | boolean;
}
```

### `CallableFunctionsRequest`

Extends **both** `CloudFunctionRequestBase` **and** `AuthContextOptions`, and applies to `onCall()` invocations (v1/v2):

````ts
/**
 * Request descriptor for v1/v2 **`https.onCall`** tests.
 *
 * @typeParam TKey - Registry key type used to look up the mock identity.
 * @typeParam TData - Callable request payload type.
 *
 * @remarks
 * Firebase clients do not control the low-level HTTP request for `onCall`:
 * method, URL/path, params/query, cookies/sessions, files, and raw body are not user-configurable.
 * Handlers receive `(data, context)` (v1) or a single `CallableRequest` (v2). A `rawRequest`
 * object exists for compatibility, but only limited surface (like headers) is configurable here.
 */
export interface CallableFunctionRequest<
  TKey extends AuthKey,
  TData extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
> extends CloudFunctionRequestBase<TKey, TData>,
    AuthContextOptions {
  data: TData;
  /**
   * Additional HTTP headers to surface on the underlying `rawRequest` snapshot.
   * (Auth/App Check headers are synthesized by the orchestrator/provider.)
   *
   * @example
   * ```ts
   * const req: CallableFunctionRequest<'alice', { x: number }> = {
   *   key: 'alice',
   *   data: { x: 1 },
   *   headers: { 'x-test-scenario': 'smoke' },
   * };
   * ```
   */
  headers?: HttpHeaders;
}
````

> By default, realistic **App Check** data is synthesized for every `onCall` invocation. You can disable or customize this behavior via the `appCheck` option.

Example:

```ts
await auth.https.v2.onCall(
  {
    key: 'bob',
    data: { test: true },
    appCheck: { custom_value: 'custom-token' },
  },
  handler
);
```

### `RawHttpRequest`

Extends `CloudFunctionRequestBase` and applies to `onRequest()` invocations (v1/v2):

- `key` — identity key for the auth context.
- `options: HttpRequestOptions` — overrides `Request` properties (`method`, `url`, `body`, `headers`, etc.).

Example:

```ts
await auth.https.v1.onRequest(
  {
    key: 'carol',
    options: {
      method: 'POST',
      body: { value: 42 },
      headers: { 'content-type': 'application/json' },
    },
  },
  handler
);
```

---

## Notes on fidelity

- **Auth context** — realistic UID, provider data, claims, and timestamps.
- **AppCheck** — synthesized automatically (configurable per-call and indirectly via `AuthManagerOptions`).
- **Request/Response** — fully inspectable mocks from `node-mocks-http`.
- **Headers & metadata** — follow Firebase conventions (`content-type`, `authorization`, `x-firebase-appcheck`).

---

## Versioning & compatibility

- Peer dependency: `firebase-functions` (v1/v2)
- Node.js ≥ 18 required.
- Works with both ESM and CJS TypeScript projects.

---

## Contributing

This project is in **minimal-maintainer mode**.

- **Issues first.** Open an issue for fidelity or compatibility issues.
- **PRs limited to:** bug fixes with tests, doc updates, or build hygiene.
- **Fidelity priority:** any behavioral changes must remain consistent with Cloud Functions v1/v2 semantics.

---

## License

Apache-2.0 © 2025 Bryce Marshall

---

## Trademarks & attribution

This project is **not** affiliated with, associated with, or endorsed by Google LLC. “Firebase” and “Cloud Functions” are trademarks of Google LLC. Names are used solely to identify compatibility and do not imply endorsement.

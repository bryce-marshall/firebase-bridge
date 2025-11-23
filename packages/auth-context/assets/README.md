# @firebase-bridge/auth-context

> High-fidelity **mock invocation layer** for **Firebase HTTPS Cloud Functions** (v1 & v2), integrating a lightweight in-memory mock of the firebase-admin/auth API. Purpose-built for fast, deterministic backend unit tests without network calls or the Functions or Auth emulators.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)

## What it is

This package provides a realistic **in-memory invocation harness** for Firebase **HTTPS Cloud Functions**, compatible with both **v1** (`firebase-functions/v1`) and **v2** (`firebase-functions/v2`) APIs.

It executes real onCall/onRequest handlers locally and deterministically, supplying realistic:

- auth context,
- App Check tokens,
- timestamps,
- Firebase headers & metadata,
- Express-like Request/Response objects (via node-mocks-http).

In addition, the package ships with a **lightweight in-memory mock** of the `firebase-admin/auth` API. This mock is _not_ required to invoke Cloud Functions, but is intended for projects that:

- inject an Auth facade in production (wrapping the real Admin SDK), and
- want to inject a fully in-memory, emulator-free implementation in unit tests.

The mock auth API allows tests to create/update/delete users, shape claims, and exercise code paths that expect Admin SDK behaviour — all without needing the emulator or network access. It operates directly on the **identities managed by each AuthManager instance**. This means HTTPS function implementations invoked in tests (for example, an administrative endpoint) can indirectly call the mock auth API to:

- enable or disable a registered identity,
- modify a user's custom claims,
- create or delete users,
- or otherwise mutate authentication state

and these changes immediately affect subsequent invocations, because they update the AuthManager’s working identity set.

> **Important caveat** — The mock Auth API includes `tenantManager()` and `projectConfigManager()` for API-shape compatibility, but these are _not_ full implementations.  
> Only the following method works:
>
> - `TenantManager.authForTenant()`
>
> All other methods on both returned types will reject with:
>
> ```text
> auth/operation-not-allowed
> ```
>
> This prevents tests from accidentally relying on unimplemented Admin SDK features.

## When to use it

Use this package for:

- Unit and integration tests for `onCall` and `onRequest` handlers.
- CI environments where the Functions Emulator is too slow or unavailable.
- Deterministic tests requiring realistic auth, App Check, headers, metadata, and token generation.
- End-to-end–style backend testing using your **production codebase**, with fully mocked identity state and zero emulator dependencies.

### Why not the emulator (for this use case)

- Zero boot time. Zero deploy loop. Zero external processes — just edit, save, and test
- Deterministic token generation, identity shaping, timestamp control, and HTTP request simulation
- Suited to tight test loops and CI pipelines where emulator startup cost and variability matter

## Companion Packages

- For a high‑fidelity **in‑memory mock** for the **Firestore Admin SDK** purpose‑built for fast, deterministic backend unit tests (no emulator boot, no deploy loop) use the companion package **[@firebase-bridge/firestore-admin](https://www.npmjs.com/package/@firebase-bridge/firestore-admin)**.
- To bind firebase-functions (v1 & v2) Firestore triggers to an in-memory Firestore database use the companion package **[@firebase-bridge/firestore-functions](https://www.npmjs.com/package/@firebase-bridge/firestore-functions)**.

Used together, these packages allow you to run realistic, end-to-end–style backend tests
using your production codebase — without starting the Functions or Firestore emulators.

---

## Support

This project is made freely available under the [Apache 2.0 License](#license).  
If you find it useful and would like to support ongoing development, you can [buy me a coffee](https://buymeacoffee.com/brycemarshall). ☕

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

---

## Quick start

### 1) Construct an AuthManager

```ts
import { AuthManager, SignInProvider } from '@firebase-bridge/auth-context';

const authManager = new AuthManager({
  projectId: 'demo',
  region: 'us-central1',
});
```

### 2) Register identities

```ts
authManager.register('alice', {
  providers: SignInProvider.Google,
  email: 'alice@example.com',
});

authManager.register('anon', {
  providers: SignInProvider.anonymous(),
});
```

### 3) Invoke Https function with synthesized authentication token

Registered identities are convenience references used in tests. If `key` is omitted, the call is treated as unauthenticated.

```ts
await authManager.https.v2.onCall({ key: 'alice', data: { x: 1 } }, handler);
```

---

## Invoking HTTPS functions

The manager exposes:

- `authManager.https.v1.onCall` / `authManager.https.v2.onCall`
- `authManager.https.v1.onRequest` / `authManager.https.v2.onRequest`

These wrap real function handlers and supply a realistic context.

### v2 onCall

```ts
const greet = onCall((req) => {
  return { message: `Hello, ${req.data.name}!` };
});

const result = await authManager.https.v2.onCall(
  { key: 'alice', data: { name: 'Bob' } },
  greet
);
```

### v1 onCall

```ts
const add = runWith({}).https.onCall((data, ctx) => {
  return { sum: data.a + data.b, caller: ctx.auth?.uid };
});

await authManager.https.v1.onCall({ key: 'alice', data: { a: 2, b: 3 } }, add);
```

### v2 onRequest

```ts
const hello = onRequest((req, res) => {
  res.json({ uid: (req as any).auth?.uid ?? null });
});

await authManager.https.v2.onRequest(
  { key: 'alice', options: { method: 'GET', path: '/hello' } },
  hello
);
```

### v2 onRequest with full HTTP request shaping

The following example shows a more complete `onRequest` invocation using the generic `AuthManager`, explicit identity registration, and rich HTTP request options:

```ts
import { onRequest } from 'firebase-functions/v2/https';
import {
  AuthManager,
  SignInProvider,
  RequestHandlerV2,
} from '@firebase-bridge/auth-context';

// 1) Construct an AuthManager and register an identity
const authManager = new AuthManager({
  projectId: 'demo',
  region: 'us-central1',
});

authManager.register('john', {
  uid: 'john-uid-123',
  providers: SignInProvider.Google.override({
    email: 'john@example.com',
  }),
});

// Example handler under test
const echoHandler: RequestHandlerV2 = onRequest((req, res) => {
  const body = (req as any).body ?? {};
  const authCtx = (req as any).auth ?? {};

  res.status(200).json({
    path: req.path,
    method: req.method,
    query: req.query,
    params: req.params,
    cookies: req.cookies,
    inputValue: body.inputValue ?? null,
    uid: authCtx.uid ?? null,
  });
});

// 2) Invoke the handler with shaped HTTP options
async function invokeEcho() {
  const response = await authManager.https.v2.onRequest(
    {
      key: 'john', // use the registered identity "john"
      data: {
        // becomes req.body
        inputValue: 123,
      },
      options: {
        method: 'POST',
        url: '/api/echo?debug=true',
        cookies: {
          session: 'abc123',
        },
        originalUrl: '/root/api/echo?debug=true',
        query: {
          debug: 'true',
        },
        params: {
          widgetId: 'w-001',
        },
        headers: {
          'x-test-header': 'example',
          'content-type': 'application/json',
        },
      },
    },
    echoHandler
  );

  // node-mocks-http helpers on the response
  const status = response._getStatusCode();
  const body = response._getJSONData();

  console.log('status:', status);
  console.log('json body:', body);
}
```

---

# Core Concepts

## AuthManager

`AuthManager` is the primary entry point. It provides:

- identity registration (`register`),
- HTTPS invocation (`https.v1` / `https.v2`),
- context and `DecodedIdToken` construction (`context()` and `token()`),
- a working identity set,
- reset semantics (`reset()`),
- a mock Admin Auth API (`auth`).

### Registered identities

- Added via `register(key, identity)`.
- Serve as convenient test references.
- On `reset()`, the working set is restored from them.

### Configuring identities with SignInProvider

All identities that are not anonymous must be configured with a sign-in provider via the `providers` field using **SignInProvider** sentinels:

- `SignInProvider.Google` — synthetic Google identity with realistic `firebase.identities` entries.
- `SignInProvider.Microsoft`, `SignInProvider.Apple`, etc. — other common providers.
- `SignInProvider.custom(id, defaults)` — arbitrary provider ID with default fields.
- `SignInProvider.anonymous()` — Firebase anonymous auth.

You can pass a single provider or an array of providers:

- When multiple providers are supplied, a generated token's `firebase.sign_in_provider` defaults to the **first** provider in the `providers` array.
- You can override the effective sign-in provider for a specific context/token (such as when invoking an http function) by setting the `signInProvider` field on `AuthContextOptions` / `AuthTokenOptions`.

For example:

```ts
authManager.register('alice', {
  providers: [
    SignInProvider.Google.override({ email: 'alice12345@gmail.com' }),
    SignInProvider.Microsoft.override({
      displayName: 'alice',
      email: 'alice12345@outlook.com',
    }),
    SignInProvider.Apple.override({
      email: 'alice12345@gmail.com',
      photoURL: 'https://photos.example.com/alice/image1.png',
    }),
  ],
});

const token = authManager.token({
  key: 'alice',
  // Specifically assert the Apple signin provider for this context to avoid defaulting to Google
  signInProvider: SignInProvider.Apple.signInProvider,
});
```

## Generating Identity Details

Identity registration produces a persisted internal identity (equivalent to a Firebase `UserRecord`). All authentication token identity fields are derived **only** from persisted identities; providers influence identity creation **at registration time only**.

### Identity defaults and auto-generated fields

When an identity is registered via `AuthManager.register()`:

- Any unspecified `uid` fields are auto-generated
- Any assigned sign-in provider other than `anonymous` is assigned a minimal provider-specific generated identity if one is not explicitly supplied:

  - For `phone` providers, a synthetic E.164-like phone number is generated.
  - For all other providers, a synthetic email address is generated.

- Provider profile fields (`email`, `phoneNumber`, `displayName`, `photoURL`, etc.) are copied into the identity’s top-level fields unless `suppressProviderDefaults: true` is set, or the top-level field was explicitly set.
- Providers are processed **in array order**. Once a top-level field has been populated, later providers do not overwrite it.
- If a valid email is supplied or generated and `emailVerified` is omitted, the identity's `emailVerified` field defaults to to `true`. This is an intentional convenience for testing and differs from Firebase’s auth api default (`false`).
- `creationTime`, `lastSignInTime`, and `lastRefreshTime` are generated if not supplied. `creationTime` defaults to the current time (according to the time generator) - 1 day. If `lastSignInTime` is not specified, or is less than `creationTime`, it defaults to `creationTime`. If `lastRefreshTime` is not specified or less than `lastSignInTime`, it defaults to `lastSignInTime`.

### Auth API (`createUser`, `updateUser`)

When using the mock Admin Auth API:

- Provider defaults are **not applied**.
- No values are generated or derived.
- All identity fields must be explicitly provided (mirroring Firebase Admin SDK behaviour).

### Provider identities in tokens

Provider identities **are always embedded** in the generated token under `firebase.identities`, for example:

```json
"firebase": {
  "identities": {
    "google.com": ["<google_uid>"],
    "email": ["user@example.com"]
  }
}
```

These values are derived from the identity’s provider list, not from top-level fields.

#### Top-level token fields

Top-level identity fields like `email`, `phoneNumber`, `displayName`, and `photoURL` map to token claims such as `email`, `phone_number`, `name`, and `photo_url`. Once an identity has been created, top-level token claims are never assigned from provider fields.

## Using AltKey for Identity Resolution

The `key` passed with an http function execution request may be:

- `undefined` → unauthenticated invocation
- `string | number` → lookup a **registered identity** by its key
- an `AltKey` instance → lookup a user in the _working set_ by UID, email, or phone

AltKey enables dynamic discovery of identities from the **working identity set**, including:

- registered identities,
- identities created via `auth.createUser()` or otherwise modified by the mock Admin Auth API.

Note that `AltKey` is not an alias system, but rather a search filter applied to a unique index.

### Examples

```ts
import { AltKey } from '@firebase-bridge/auth-context';

// Lookup by UID
await authManager.https.v2.onCall(
  { key: AltKey.uid('UID_123'), data: {} },
  handler
);

// Lookup by email (tenant optional)
await authManager.https.v2.onCall(
  { key: AltKey.email('a@example.com'), data: {} },
  handler
);
```

### Lookup failure rules

`AltKey` lookups will throw if:

- no matching working identity is found, or
- the matching identity is **disabled**.

### Working identity set

This is the set used at invocation time. It includes:

- copies of registered identities,
- identities created via the mock Admin Auth API,
- identities modified or deleted via the mock Admin Auth API.

**Invocation fails if:**

1. no identity can be resolved for the request, or
2. the resolved identity exists but is **disabled**.

### Mock Admin Auth API (`AuthManager.auth`)

This is an optional test utility. It:

- mimics parts of the Admin Auth SDK,
- allows creation, update, and deletion of users,
- mutates only the _working set_,
- is not required for HTTPS invocation.

This exists primarily to support test suites that inject a facade which normally wraps the Admin Auth SDK.

### Deterministic time

You may supply a custom `now()` function to the `AuthManager` constructor to stabilize token timestamps across tests.

---

## Multi-tenant support

The mock supports multi-tenant environments. As in **Firebase**, each identity belongs either to the default (non-tenanted) user store or to a specific tenant’s user store. Once an identity has been created in a given store, it cannot be moved to another tenant.

Register an identity with a tenant by specifying `tenantId` on the `IdentityConstructor` passed to `AuthManager.register()`.

Example:

```ts
authManager.register('alice', {
  providers: SignInProvider.Google,
  tenantId: 'tenant-one',
});
```

Create an identity for a tenant using the auth API mock.

Example:

```ts
// Obtain a tenant-scoped auth instance
const tenant = authManager.auth.tenantManager().authForTenant('tenant-two');
// Create the user
const user = await tenant.createUser({
  displayName: 'Bob',
  email: 'bob@example.com',
  emailVerified: true,
});
// Link a provider (required, otherwise request contexts will be unauthenticated)
await tenant.updateUser(user.uid, {
  providerToLink: {
    providerId: 'google.com',
    uid: '123456789',
    email: 'bob@example.com',
  },
});
```

When an identity belongs to a tenant, the synthesized token embeds it as:

```json
{ "firebase": { "tenant": "tenant-one" } }
```

---

## Identity Lifecycle & Reset Semantics

### Working identity set mutation

The working identity set may be modified via the mock Admin Auth API, accessible through
`authManager.auth` and its tenant-scoped instances (for example, `authManager.auth.tenantManager().authForTenant(...)`).

### Resetting vs clearing state

`authManager.reset()`

- deletes all **non-registered** identities,
- restores each registered identity to its original state,
- clears mutations introduced via the mock Admin Auth API.

`authManager.clear()`

- clears **all state**, including registered identities,
- returns the manager to an empty state (no identities configured).

### Invocation failures

Invocation fails with a Firebase auth error if:

- the identity does not exist in the working set,
- the working identity is disabled.

This applies to both key-based and AltKey-based lookups.

### Synthesizing tokens

`AuthManager.token(options)` lets you generate a `DecodedIdToken` directly from the same machinery used for HTTPS invocation:

```ts
const token = authManager.token({ key: 'alice' });
```

`AuthTokenOptions` extends `AuthContextOptions` and requires a non-undefined `key` (string/number or `AltKey`). This is useful when:

- testing modules that operate purely on `DecodedIdToken` values,
- snapshotting claims/identity shaping logic,
- or when you want a token without invoking an HTTPS function.

### Example identity configurations and resulting tokens

The snippets below illustrate how different identity configurations shape the resulting `DecodedIdToken`.

#### Minimal identity creation

```ts
authManager.register('alice', {
  providers: SignInProvider.Google,
});

const token = authManager.token({ key: 'alice' });
console.log('minimal identity creation token:', JSON.stringify(token, null, 2));
```

generates a token like:

```json
{
  "sub": "vxiUXBlDQexHDstT29LChGrwOM0R",
  "aud": "demo",
  "iat": 1763704517,
  "exp": 1763706317,
  "auth_time": 1763702717,
  "uid": "vxiUXBlDQexHDstT29LChGrwOM0R",
  "iss": "https://firebaseappcheck.googleapis.com/425447859205",
  "firebase": {
    "sign_in_provider": "google.com",
    "identities": {
      "google.com": ["990058071739787504953"],
      "email": ["user-422347@example.com"]
    }
  },
  "email": "user-422347@example.com",
  "email_verified": true
}
```

#### Enhanced identity creation (MFA + custom claims)

```ts
authManager.register('alice', {
  providers: SignInProvider.Google.override({
    phoneNumber: '+5551234567',
  }),
  displayName: 'alice',
  email: 'alice@example.com',
  multiFactorEnrollments: { factorId: 'phone' },
  multiFactorDefault: 'phone',
  customClaims: {
    user_roles: ['premium-features'],
  },
  photoURL: 'https://photos.example.com/alice/image1.png',
});

const token = authManager.token({ key: 'alice' });
console.log(
  'enhanced identity creation token:',
  JSON.stringify(token, null, 2)
);
```

generates a token like:

```json
{
  "sub": "9YSAX91fEcDqumXv6uGoBuHFM3kP",
  "aud": "demo",
  "iat": 1763704517,
  "exp": 1763706317,
  "auth_time": 1763702717,
  "uid": "9YSAX91fEcDqumXv6uGoBuHFM3kP",
  "iss": "https://firebaseappcheck.googleapis.com/425447859205",
  "firebase": {
    "sign_in_provider": "google.com",
    "identities": {
      "google.com": ["726351463890305018478"],
      "phone": ["+5551234567"]
    },
    "sign_in_second_factor": "phone",
    "second_factor_identifier": "5LBGdIcI5fboqVV4tlvO0Du6cmFT"
  },
  "email": "alice@example.com",
  "email_verified": true,
  "phone_number": "+5551234567",
  "photo_url": "https://photos.example.com/alice/image1.png",
  "name": "alice",
  "user_roles": ["premium-features"]
}
```

#### Multiple identity providers

```ts
authManager.register('alice', {
  providers: [
    SignInProvider.Google.override({ email: 'alice12345@gmail.com' }),
    SignInProvider.Microsoft.override({
      displayName: 'alice',
      email: 'alice12345@outlook.com',
    }),
    SignInProvider.Apple.override({
      email: 'alice12345@gmail.com',
      photoURL: 'https://photos.example.com/alice/image1.png',
    }),
  ],
});

const token = authManager.token({ key: 'alice' });
console.log(
  'multiple identity creation token:',
  JSON.stringify(token, null, 2)
);
```

generates a token like:

```json
{
  "sub": "tss9G1AOWoFwMxb01TWOyzz5KAZm",
  "aud": "demo",
  "iat": 1763704517,
  "exp": 1763706317,
  "auth_time": 1763702717,
  "uid": "tss9G1AOWoFwMxb01TWOyzz5KAZm",
  "iss": "https://firebaseappcheck.googleapis.com/425447859205",
  "firebase": {
    "sign_in_provider": "google.com",
    "identities": {
      "google.com": ["134134107080242480262"],
      "email": ["alice12345@gmail.com", "alice12345@outlook.com"],
      "microsoft.com": ["6e532444bf41ee3847934679b81ceb86"],
      "apple.com": ["522566.1b37fd71b9c0b98beaf0dc207eb36e61.8079"]
    }
  },
  "email": "alice12345@gmail.com",
  "email_verified": true,
  "photo_url": "https://photos.example.com/alice/image1.png",
  "name": "alice"
}
```

#### Anonymous identity creation

```ts
authManager.register('anon', {
  providers: SignInProvider.anonymous(),
});
// also by default: auth.register('anon');

const token = authManager.token({ key: 'anon' });
console.log(
  'anonymous identity creation token:',
  JSON.stringify(token, null, 2)
);
```

generates a token like:

```json
{
  "sub": "6cFPERExNGZRcc5J9TqN76ud40Z7",
  "aud": "demo",
  "iat": 1763704518,
  "exp": 1763706318,
  "auth_time": 1763702718,
  "uid": "6cFPERExNGZRcc5J9TqN76ud40Z7",
  "iss": "https://firebaseappcheck.googleapis.com/425447859205",
  "firebase": {
    "sign_in_provider": "anonymous",
    "identities": {}
  }
}
```

---

## Per-call Overrides

All onCall/onRequest request descriptors support optional shaping fields:

```ts
await authManager.https.v2.onCall(
  {
    key: 'alice',
    data: { x: 1 },
    iat: 12345,
    expires: 67890,
    headers: { 'x-test': 'yes' },
  },
  handler
);
```

- `iat`, `expires` → control token timestamps
- `headers` → adds raw HTTP headers
- `options` → supplied for onRequest handlers

---

## HTTP headers & JWT propagation

For both `onCall` and `onRequest` invocations, the mock synthesizes an Express-like HTTP request and **automatically populates key headers** to match real Cloud Functions behaviour.

### Host and protocol

- `host`
  - Emulator: `127.0.0.1:5001`
  - Hosted-style: `<region>-<project>.cloudfunctions.net`
- `x-forwarded-proto`
  - Emulator: `"http"`
  - Hosted-style: `"https"`

These are only set if not already present on the request descriptor.

### Authorization and App Check

If an **ID token** (`DecodedIdToken`) is present in the invocation context and no `authorization` header is already provided:

- `authorization: Bearer <jwt>`
  - The `<jwt>` value is a JWT-encoded form of the synthesized `DecodedIdToken`.

If an **App Check token** (`DecodedAppCheckToken`) is present and the App Check header is missing:

- `x-firebase-appcheck: <jwt>`
  - The `<jwt>` value is a JWT-encoded form of the synthesized App Check token.

This applies to both `onCall` and `onRequest` flows, so any code that reads tokens from HTTP headers (e.g. `authorization` or `x-firebase-appcheck`) will see realistic values.

### Content type and method

- For `onCall`:
  - `method` defaults to `POST` (if not explicitly set).
  - `content-type` is forced to `application/json`.
- For `onRequest`:
  - `method` defaults to `POST` if not specified.
  - `content-type` is inferred when missing:
    - `multipart/form-data; boundary=…` if `files` are present.
    - `application/x-www-form-urlencoded` for simple `key=value`/`key=[v1,v2]` bodies.
    - `application/json` for object/array bodies.
    - `text/plain; charset=utf-8` for string bodies.

All of this shaping occurs on a mutable `HttpRequestOptions` instance, so you can still override headers, method, or URL explicitly in your test descriptors where needed.

## Identifier generation

`AuthManager` automatically generates realistic identifiers for you when registering identities if values such as `uid` or provider-specific UIDs are not explicitly supplied. In most cases this is sufficient for tests that only care about “plausible” identity data.

For scenarios where you want **explicit control or consistency across tests** (for example, shared constants for test users, or stable IDs reused across multiple suites), `AuthManager` exposes a small helper:

```ts
authManager.idGen; // alias for the static IdGenerator class
```

This helper provides methods for creating Firebase-like identifiers:

```ts
// Firebase-style UID (28-char alphanumeric)
const uid = authManager.idGen.firebaseUid();

// Provider-specific UID (by type)
const googleUid = authManager.idGen.providerTypeUid('google'); // 21-digit numeric
const appleUid = authManager.idGen.providerUid('apple.com'); // composite Apple-style ID

// Project/app identifiers
const projectNumber = authManager.idGen.projectNumber(); // 12-digit numeric
const appId = authManager.idGen.appId(projectNumber); // 1:<projectNumber>:web:<hex>
```

You can use these values to:

- define **stable test-user constants** shared across suites,
- assign a fixed `uid` for the `AuthManager` registration key (generic `TKey`),
- or reuse the same synthetic provider UIDs in fixtures and snapshots.

All identifiers are generated using `Math.random()` and are **not cryptographically secure**. They are intended exclusively for mocks, fixtures, and test environments.

## Using AuthManager with an Application-Level Facade (for End-to-End Testability)

In many real-world Firebase backends, authentication is not consumed directly from Cloud Function contexts. Instead, applications wrap `firebase-admin/auth` inside a **local facade** or **service layer** that production code calls consistently (e.g., `AppServices.auth.verifyIdToken(req)`).

This section demonstrates how `AuthManager` can be integrated into such an architecture, allowing you to run end-to-end (or near end-to-end) backend tests against your **production codebase**—without the emulator, without network calls, and with no conditional logic. The same production modules that call the Admin Auth SDK in production can call the mock Admin Auth API in tests.

This pattern is optional, but extremely powerful for teams building structured Firebase backends.

---

### Minimal Example – Injecting AuthManager into a Simple Facade

A small facade provides stable entry points for your backend code:

```ts
// services.ts
import { Auth } from 'firebase-admin/auth';

export interface AppServices {
  auth: Auth; // Admin Auth implementation
  now: () => Date; // Time source
}

export const Services: AppServices = {
  auth: {} as Auth, // populated at runtime
  now: () => new Date(),
};
```

Your production code calls the facade:

```ts
// api/profile.ts
import { Services } from './services';

export async function getProfile(req: Request) {
  const idToken = extractIdTokenFromRequest(req); // your own helper
  const token = await Services.auth.verifyIdToken(idToken);

  return { uid: token.uid };
}
```

#### Test Initialization Using AuthManager

```ts
import { AuthManager, SignInProvider } from '@firebase-bridge/auth-context';
import { Services } from './services';

const auth = new AuthManager({
  projectId: 'demo',
  region: 'us-central1',
  now: () => Services.now().valueOf(),
});
Services.auth = auth.auth; // inject mock Admin Auth API
Services.now = () => new Date(0); // deterministic time

auth.register('alice', { providers: SignInProvider.Google });

const res = await auth.https.v2.onRequest(
  { key: 'alice', options: { method: 'GET', path: '/profile' } },
  getProfile
);
```

Your production handler now runs unchanged against a fully mocked environment.

---

## Advanced: Full Integration with a Service Registry and TestAuthManager

The following expanded pattern is suitable for larger backends with multiple services, multi-tenancy, deterministic time, and environment-specific service wiring.

<details>
<summary><strong>Show advanced DI example</strong></summary>

### Service Registry

```ts
// service-registry.ts
export type ServiceMap = Record<string, any>;

export interface ServiceStore<TServices extends ServiceMap> {
  get<K extends keyof TServices>(key: K): TServices[K];
  optional<K extends keyof TServices>(key: K): TServices[K] | undefined;
}

export class ServiceRegistry<TServices extends ServiceMap>
  implements ServiceStore<TServices>
{
  private readonly store = new Map<
    keyof TServices,
    TServices[keyof TServices]
  >();

  set<K extends keyof TServices>(key: K, value: TServices[K]): void {
    this.store.set(key, value);
  }

  get<K extends keyof TServices>(key: K): TServices[K] {
    if (!this.store.has(key)) {
      throw new Error(`Service "${String(key)}" has not been registered.`);
    }
    return this.store.get(key) as TServices[K];
  }

  optional<K extends keyof TServices>(key: K): TServices[K] | undefined {
    return this.store.get(key) as TServices[K];
  }

  reset(): void {
    this.store.clear();
  }
}
```

### Configuration for the Runtime Environment

```ts
import { ServiceMap, ServiceRegistry, ServiceStore } from './service-registry';

// single instance for this module
const registry: ServiceStore<ServiceMap> = new ServiceRegistry<ServiceMap>();

export function serviceRegistry<
  TServices extends ServiceMap = ServiceMap
>(): ServiceStore<TServices> {
  return registry as ServiceStore<TServices>;
}

export function registerServices<TServices extends ServiceMap>(
  services: Partial<TServices>
): void {
  for (const [key, value] of Object.entries(services)) {
    if (key && value) {
      (registry as ServiceRegistry<TServices>).set(
        key as keyof TServices,
        value
      );
    }
  }
}

export function resetServices(): void {
  (registry as ServiceRegistry<ServiceMap>).reset();
}
```

### Facade for Production Code

```ts
// app-facade.ts
import { Auth } from 'firebase-admin/auth';
import { serviceRegistry } from './app-env';
import { ServiceStore } from './service-registry';

export interface TimeService {
  now: () => Date;
  millisNow: () => number;
}

export interface PlatformServiceMap {
  readonly auth: Auth;
  readonly time: TimeService;
}

export class AppFacade {
  private readonly _services: ServiceStore<PlatformServiceMap>;

  static readonly singleton = new AppFacade();

  private constructor() {
    this._services = serviceRegistry<PlatformServiceMap>();
  }

  get auth(): Auth {
    return this._services.get('auth');
  }

  get time(): TimeService {
    return this._services.get('time');
  }
}
```

### TestAuthManager – Bridges AuthManager into the Facade

```ts
// test-manager.ts
import { AuthManager, SignInProvider } from '@firebase-bridge/auth-context';
import { registerServices, resetServices } from './app-env';
import { PlatformServiceMap, TimeService } from './app-facade';

export class TestTimeService implements TimeService {
  private _fn: (() => Date) | undefined;
  now(): Date {
    return this._fn?.() ?? new Date();
  }

  millisNow(): number {
    return this.now().valueOf();
  }

  set(fn?: () => Date) {
    this._fn = fn;
  }
}

export class TestAuthManager extends AuthManager<string> {
  readonly time = new TestTimeService();

  constructor(options?: any) {
    super({ ...options, now: () => this.time.millisNow() });
    this.clear();
    resetServices();
    registerServices<PlatformServiceMap>({
      time: this.time,
      auth: this.auth,
    });
  }

  override reset(): void {
    this.time.set();
    super.reset();
  }

  override clear(): void {
    super.clear();
    this.register('admin', {
      uid: 'admin',
      providers: SignInProvider.Google.override({ email: 'admin@example.com' }),
    });
  }
}
```

### Example Test Using the Facade

```ts
const auth = new TestAuthManager({ projectId: 'demo', region: 'us-central1' });

auth.register('alice', {
  uid: 'alice',
  providers: SignInProvider.Google.override({
    email: 'alice@example.com',
    tenantId: 'tenant-one',
  }),
});

// Use the facade exactly as production code would
const tenant = AppFacade.singleton.auth
  .tenantManager()
  .authForTenant('tenant-one');

const user = await tenant.getUser('alice');
console.log(user.uid); // "alice"
```

</details>

---

## Notes on fidelity

- realistic UID/email/phone/provider data
- realistic AppCheck tokens
- correct Firebase headers and metadata
- deterministic context construction

---

## Versioning & compatibility

- Peer dependency: `firebase-functions`
- Node ≥ 18
- Works in ESM and CJS

---

## Contributing

Minimal-maintainer mode. Issues welcome; PRs for fixes/docs.

---

## License

Apache-2.0 © 2025 Bryce Marshall

---

## Trademarks

Not affiliated with Google LLC. “Firebase” and “Cloud Functions” are trademarks of Google LLC.

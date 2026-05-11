# @firebase-bridge/storage-mock

> Deterministic **in-memory Cloud Storage mock** and **Firebase Storage trigger harness** for backend tests. Purpose-built for fast unit and integration tests without a Firebase Emulator, network calls, or deploy loop.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)

## What it is

`@firebase-bridge/storage-mock` implements the `@firebase-bridge/cloud-storage` abstraction with deterministic in-memory storage. Tests can write, read, list, update metadata, delete objects, create mock signed read URLs, inspect state, inject failures, and drive Firebase Cloud Storage trigger handlers in-process.

Unlike `@firebase-bridge/firestore-admin`, this package does **not** replace or emulate `firebase-admin.storage()` directly. Production code should depend on `@firebase-bridge/cloud-storage` or your own platform facade, then tests can substitute this mock.

## When to use it

- Unit and integration tests for backend code that reads or writes Cloud Storage objects.
- CI where the Storage Emulator is slow, unavailable, or unnecessary.
- Tests that need deterministic metadata, generation values, timestamps, operation logs, and reset behavior.
- Trigger tests for Firebase Functions v1/v2 Storage handlers without deploying functions.

## Install

```bash
# npm
npm i -D @firebase-bridge/storage-mock @firebase-bridge/cloud-storage firebase-functions

# pnpm
pnpm add -D @firebase-bridge/storage-mock @firebase-bridge/cloud-storage firebase-functions

# yarn
yarn add -D @firebase-bridge/storage-mock @firebase-bridge/cloud-storage firebase-functions
```

> **Peer deps:** `firebase-functions` for trigger registration.
> **Node:** 18+ recommended. **TypeScript:** strict mode recommended.

## Quick start

```ts
import { StorageMock } from '@firebase-bridge/storage-mock';

describe('storage-backed import', () => {
  const env = new StorageMock({
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  });
  const storage = env.createStorage({ defaultBucket: 'imports.test' });
  const bucket = storage.service().bucket();

  afterEach(() => {
    storage.resetAll();
    storage.clearOperationLog();
  });

  it('writes and reads object text', async () => {
    const write = await bucket.writeText('imports/a.csv', 'id,name\n1,Ada\n', {
      metadata: {
        contentType: 'text/csv',
        customMetadata: { importId: 'imp-001' },
      },
      precondition: { type: 'does-not-exist' },
    });

    expect(write.metadata.generation).toBe('1');
    expect(write.metadata.metageneration).toBe('1');
    expect(await bucket.readText('imports/a.csv')).toContain('Ada');
    expect(storage.getObjectText('imports.test', 'imports/a.csv')).toContain('Ada');
  });
});
```

## Production wiring pattern

Use `@firebase-bridge/cloud-storage` in production code, then inject the mock service in tests:

```ts
import type { CloudStorageService } from '@firebase-bridge/cloud-storage';

export async function readManifest(storage: CloudStorageService) {
  const bucket = storage.bucket('imports.test');
  return JSON.parse(await bucket.readText('manifest.json'));
}
```

```ts
import { StorageMock } from '@firebase-bridge/storage-mock';

const ctrl = new StorageMock().createStorage({ defaultBucket: 'imports.test' });
ctrl.seedObject('imports.test', 'manifest.json', JSON.stringify({ ok: true }));

await expect(readManifest(ctrl.service())).resolves.toEqual({ ok: true });
```

## Core concepts

### `class StorageMock`

Top-level environment that owns shared in-memory bucket state.

- `new StorageMock({ now?, signedUrlSigner? })`
- `createStorage(options?): StorageController`
- `reset(bucket)`, `resetAll()`
- `delete(bucket)`, `deleteAll()`

Use one `StorageMock` per suite when you want fast resets. Create separate environments when suites must not share any bucket state.

### `StorageController`

Controller returned by `createStorage()`. It exposes the test service and direct inspection controls.

- Identity/config: `defaultBucket`, `projectId`, `location`, `epoch`
- Service: `service(): CloudStorageService`
- State controls: `reset()`, `resetAll()`, `delete()`, `deleteAll()`
- Seeding/inspection: `seedObject()`, `getObject()`, `getObjectText()`, `hasObject()`, `listObjects()`, `deleteObject()`
- Observability: `getOperationLog()`, `clearOperationLog()`, `onObjectChange()`, `watchLifecycle()`
- Test behavior: `failNext()`, `setClock()`

### Cloud Storage operations

The service implements the `@firebase-bridge/cloud-storage` bucket/object API:

- `exists()`
- `read()` / `readText()`
- `write()` / `writeText()`
- `delete()`
- `getMetadata()` / `setMetadata()`
- `list()`
- `createSignedReadUrl()`

Bucket-level and object-level facades share the same behavior:

```ts
const bucket = ctrl.service().bucket('uploads.test');
const object = bucket.object('avatars/alice.png');

await object.write(new Uint8Array([1, 2, 3]), {
  metadata: { contentType: 'image/png' },
});

const metadata = await object.setMetadata({
  cacheControl: 'private, max-age=60',
});

expect(metadata.metageneration).toBe('2');
```

## Metadata, generations, and preconditions

Object metadata is immutable when returned from the mock. Each object has:

- `generation`: increments when object data is written.
- `metageneration`: starts at `1` and increments when metadata changes.
- `createdAt` / `updatedAt`: derived from the mock clock.
- `customMetadata`: frozen user metadata.
- `md5Hash`, `crc32c`, and `etag`: deterministic test values.

Mutation preconditions mirror the abstraction:

```ts
await bucket.writeText('file.txt', 'first', {
  precondition: { type: 'does-not-exist' },
});

const meta = await bucket.getMetadata('file.txt');

await bucket.writeText('file.txt', 'second', {
  precondition: {
    type: 'generation-match',
    generation: meta.generation,
  },
});
```

Supported precondition types:

- `{ type: 'none' }`
- `{ type: 'does-not-exist' }`
- `{ type: 'generation-match', generation }`
- `{ type: 'metageneration-match', metageneration }`
- `{ type: 'generation-and-metageneration-match', generation, metageneration }`

Failures reject with `CloudStorageError` from `@firebase-bridge/cloud-storage`.

## Listing and pagination

`list()` returns deterministic path-sorted metadata and uses numeric page tokens:

```ts
await bucket.writeText('a/1.txt', 'one');
await bucket.writeText('a/2.txt', 'two');

const page1 = await bucket.list({ prefix: 'a/', pageSize: 1 });
expect(page1.objects.map((m) => m.path)).toEqual(['a/1.txt']);

const page2 = await bucket.list({
  prefix: 'a/',
  pageSize: 1,
  pageToken: page1.nextPageToken,
});
expect(page2.objects.map((m) => m.path)).toEqual(['a/2.txt']);
```

## Test controls

Seed objects directly when setup should not exercise application write paths:

```ts
ctrl.seedObject('uploads.test', 'seed.txt', 'seeded', {
  contentType: 'text/plain',
});

expect(ctrl.hasObject('uploads.test', 'seed.txt')).toBe(true);
expect(ctrl.getObjectText('uploads.test', 'seed.txt')).toBe('seeded');
expect(ctrl.listObjects('uploads.test').map((o) => o.path)).toEqual(['seed.txt']);
```

`reset(bucket)` and `resetAll()` clear objects but keep bucket/controller lifecycles alive. `delete(bucket)` and `deleteAll()` remove buckets and advance controller epochs. Trigger orchestrators use epochs to ignore stale events captured before a reset.

## Operation logs and failure injection

Every service/test-control operation records an operation log entry. Use `failNext()` to force a matching operation to fail once:

```ts
ctrl.failNext({
  operation: 'read',
  bucketId: 'uploads.test',
  path: 'seed.txt',
  code: 'storage/unavailable',
});

await expect(bucket.read('seed.txt')).rejects.toMatchObject({
  code: 'storage/unavailable',
});

expect(ctrl.getOperationLog()).toContainEqual(
  expect.objectContaining({
    operation: 'read',
    success: false,
    errorCode: 'storage/unavailable',
  })
);
```

## Signed read URLs

The default signer returns deterministic local URLs:

```ts
const signed = await bucket.createSignedReadUrl('seed.txt', {
  expiresAt: new Date('2026-01-02T00:00:00.000Z'),
});

expect(signed.url).toBe(
  'https://storage-mock.local/uploads.test/seed.txt?expires=1767312000000'
);
```

These are **not** Google Cloud Storage signed URLs. They are local test artifacts. To model application-specific URL formats, pass `signedUrlSigner` to `new StorageMock()` or `createStorage()`:

```ts
const env = new StorageMock({
  signedUrlSigner: ({ bucketId, path, options }) => ({
    url: `mock://${bucketId}/${path}?until=${options.expiresAt.toISOString()}`,
    expiresAt: options.expiresAt,
  }),
});
```

The mock still validates paths, applies failure injection, and checks object existence before invoking your signer.

## Trigger registration

Direct trigger registration lets real Firebase Functions v1/v2 storage handlers run when mock object events occur.

### v2 trigger example

```ts
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { StorageMock } from '@firebase-bridge/storage-mock';
import { registerTrigger } from '@firebase-bridge/storage-mock/v2';

const ctrl = new StorageMock().createStorage({ defaultBucket: 'imports.test' });
const bucket = ctrl.service().bucket();
const calls: string[] = [];

const dispose = registerTrigger(
  ctrl,
  onObjectFinalized({ bucket: 'imports.test' }, (event) => {
    calls.push(`${event.bucket}:${event.data.name}`);
  }),
  (record) => record.path.endsWith('.csv')
);

await bucket.writeText('skip.txt', 'skip');
await bucket.writeText('keep.csv', 'id,name\n1,Ada\n');
await new Promise((resolve) => setTimeout(resolve, 10));

expect(calls).toEqual(['imports.test:keep.csv']);
dispose();
```

### v1 trigger example

```ts
import * as functions from 'firebase-functions/v1';
import { registerTrigger } from '@firebase-bridge/storage-mock/v1';

const dispose = registerTrigger(
  ctrl,
  functions.storage.bucket('imports.test').object().onFinalize((object, context) => {
    expect(object.bucket).toBe('imports.test');
    expect(context.eventType).toBe('google.storage.object.finalize');
  })
);
```

`registerTrigger()` accepts either a predicate function or an options object:

```ts
registerTrigger(ctrl, handler, {
  predicate: (record) => record.path.endsWith('.csv'),
  onBefore: (record) => undefined,
  onAfter: (record) => undefined,
  onError: ({ origin, arg, cause }) => undefined,
});
```

Errors from predicates, hooks, or handlers are reported to `onError()` and swallowed so test harness delivery can continue.

## Trigger orchestrator

`StorageTriggerOrchestrator` is a higher-level harness for larger trigger suites. It registers keyed trigger stubs, lets tests enable/disable them, waits for activity, observes phases, and captures errors.

```ts
import { onObjectDeleted, onObjectFinalized } from 'firebase-functions/v2/storage';
import { StorageMock, StorageTriggerOrchestrator } from '@firebase-bridge/storage-mock';

enum TriggerKey {
  Finalized = 'Finalized',
  Deleted = 'Deleted',
}

const ctrl = new StorageMock().createStorage({ defaultBucket: 'imports.test' });
const bucket = ctrl.service().bucket();

const orchestrator = new StorageTriggerOrchestrator<TriggerKey>(ctrl, (reg) => {
  reg.v2(
    TriggerKey.Finalized,
    onObjectFinalized({ bucket: 'imports.test' }, async (event) => {
      console.log(event.data.name);
    })
  );

  reg.v2(
    TriggerKey.Deleted,
    onObjectDeleted({ bucket: 'imports.test' }, async () => {
      throw new Error('delete failed');
    })
  );
});

const done = orchestrator.waitOne(TriggerKey.Finalized);
await bucket.writeText('manifest.json', '{}');
await expect(done).resolves.toMatchObject({ completedCount: 1 });

const failed = orchestrator.waitOneError(TriggerKey.Deleted);
await bucket.delete('manifest.json');
await expect(failed).resolves.toMatchObject({ errorCount: 1 });

orchestrator.disable(TriggerKey.Finalized);
orchestrator.enable(TriggerKey.Finalized);
orchestrator.dispose();
```

Useful methods:

- `all(enable)`, `enable(...keys)`, `disable(...keys)`, `isEnabled(key)`
- `observe(key, observer)`, `observeAll(observer)`, `on(key, callback)`, `onAll(callback)`
- `watchErrors(callback)`
- `wait(key, predicate, options)`, `waitOne(key, options)`
- `waitError(key, predicate, options)`, `waitOneError(key, options)`
- `attach()`, `detach()`, `reset()`, `dispose()`
- `getStats(key)`

## Event behavior

The mock emits object events only after successful operations:

- `finalized` after `write()` / `writeText()` / object data replacement.
- `metadata-updated` after `setMetadata()`.
- `deleted` after a real delete.
- `archived` is recognized by the trigger harness, but normal mock operations do not currently emit archive events.

No event is emitted for failed operations or `delete({ ignoreMissing: true })` when the object is absent.

## Validation and errors

The mock follows the same intentionally narrow validation policy as `@firebase-bridge/cloud-storage`:

- Explicit bucket ids must be non-empty and must not contain `/` or control characters.
- Object paths must be non-empty and must not start with `/` or contain control characters.

Portable failures reject with `CloudStorageError`. Match on `error.code`, not provider-specific internals.

## Package exports

Main package:

- `StorageMock`
- `StorageTriggerOrchestrator`
- test-control, trigger, listener, wait, and observer types

Subpath exports:

- `@firebase-bridge/storage-mock/v1`: `registerTrigger`, `TriggerPayload`
- `@firebase-bridge/storage-mock/v2`: `registerTrigger`, `StorageEventLike`

## Non-goals

This package does not provide:

- Direct monkey-patching of `firebase-admin.storage()`
- Storage Rules emulation
- resumable uploads or streaming APIs
- ACL/public access behavior
- retry/backoff simulation
- Google Cloud Storage emulator compatibility
- real cryptographic signed URLs

## Troubleshooting

- **My production code still calls real Storage**
  Ensure production code receives a `CloudStorageService` from `@firebase-bridge/cloud-storage` or your own facade. Code that directly calls `firebase-admin.storage()` cannot be automatically redirected to this mock.

- **My trigger did not run**
  Make sure you registered the trigger against the same `StorageController`, used the correct v1/v2 subpath, and allowed the asynchronous handler to flush before asserting.

- **My waiter timed out**
  Check that the trigger is enabled, the bucket filter matches, and the predicate returns `true`.

- **A reset caused old events to disappear**
  This is intentional. Controller epochs advance on reset/delete so orchestrators ignore stale events from a previous lifecycle.

## Versioning and compatibility

- Depends on `@firebase-bridge/cloud-storage`.
- Peer dependency: `firebase-functions` for trigger wrappers.
- Node.js >= 18.
- ESM and CJS consumers are supported through package exports.

## Contributing

This project is in minimal-maintainer mode. Issues with small reproducible examples are welcome. PRs should be focused on bug fixes, docs improvements, or fidelity gaps with tests.

## License

Apache-2.0 (c) 2026 Bryce Marshall

## Trademarks and attribution

This project is not affiliated with, associated with, or endorsed by Google LLC. "Firebase", "Cloud Storage", and "Google Cloud Storage" are trademarks of Google LLC. Names are used solely to identify compatibility and do not imply endorsement.

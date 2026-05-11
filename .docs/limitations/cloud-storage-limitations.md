# Cloud Storage Limitations

Last updated: 2026-05-11

This document records known limitations of the Firebase Bridge Cloud Storage packages and their test support.

## Production Adapter

- The production adapter is an abstraction over Firebase Admin / Google Cloud Storage. It does not replace or monkey-patch `firebase-admin.storage()`.
- Production code must use the `@firebase-bridge/cloud-storage` abstraction, or an application platform layer built on top of it, to be testable with `@firebase-bridge/storage-mock`.
- Provider-specific raw errors are normalized into `CloudStorageError` codes. Consumers should assert on the abstraction-level error code rather than Firebase Admin or Google Cloud Storage SDK error shapes.
- Bucket and object path validation is intentionally narrow. Explicit bucket ids must be non-empty and must not contain `/` or control characters. Object paths must be non-empty and must not start with `/` or contain control characters. This is not a full Google Cloud Storage naming rules emulator.
- `createSignedReadUrl()` requires the object to exist. Missing objects are mapped to `storage/object-not-found` before provider signing is attempted.
- Successful `createSignedReadUrl()` behavior depends on Firebase Admin / Google Cloud Storage signing support and credentials. The Firebase Storage emulator does not currently provide stable signed URL support, so production/emulator parity tests do not include signed URL success cases.

## Storage Mock

- The mock is an in-memory implementation of the Firebase Bridge Cloud Storage abstraction. It is not a Google Cloud Storage emulator and does not expose real network behavior.
- Mock signed read URLs are local test artifacts. The default signer is deterministic, but it does not perform real cryptographic signing.
- Tests that need specific URL shapes can provide a custom `signedUrlSigner` on `StorageMock` or per `createStorage()` controller. The mock still applies path validation, failure injection, and object existence checks before invoking the signer.
- Natural missing-object errors are not recorded in the operation log. Injected failures are recorded with `success: false`.
- Failure injection is deterministic and scoped to mock operations. It is intended for error-path testing, not for simulating provider retries, backoff, networking, or distributed failures.
- Bucket lifecycle helpers such as `reset()`, `resetAll()`, `delete()`, and `deleteAll()` are synchronous mock controls. They are not production bucket management APIs.

## Object Versioning And Archive Events

- Object versioning is not implemented.
- Archived object events are not emitted by the mock.
- v1/v2 archive trigger registration is accepted where detectable, but archive handlers remain inactive until explicit object versioning/archive emission support exists.

## Trigger Testing

- Cloud Storage trigger tests are mock-driven. Production Cloud Functions cannot be invoked by the Firebase Storage emulator without deployment.
- Direct v1/v2 trigger registration support depends on detectable Firebase Functions metadata shapes. Unsupported or future trigger shapes may require adapter updates.
- Storage triggers are bucket-scoped. Path or prefix filtering should be implemented in consumer code or through optional mock registration predicates.
- The mock trigger delivery model is in-process and deterministic. It does not simulate distributed at-least-once delivery, duplicate delivery, delayed delivery, or cross-process ordering.

## Unsupported Cloud Storage Features

The current Cloud Storage support does not attempt to implement:

- Firebase Storage Security Rules emulation
- ACLs or public access behavior
- resumable uploads
- streaming reads or writes
- real bucket creation/deletion APIs beyond mock test controls
- real network behavior
- retry/backoff simulation
- Google Cloud Storage emulator compatibility beyond the supported production adapter test surface
- object version history
- archive/versioning lifecycle events

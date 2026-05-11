# @firebase-bridge/cloud-storage

Cloud Storage abstraction and Firebase Admin adapter utilities for Firebase Bridge.

This package defines a narrow backend-facing Cloud Storage interface that can be implemented by production Google Cloud Storage and by the in-memory `@firebase-bridge/storage-mock` package.

Unlike `@firebase-bridge/firestore-admin`, this package does not replace or emulate `firebase-admin.storage()` directly. Production code should use the `@firebase-bridge/cloud-storage` abstraction, and tests can substitute `@firebase-bridge/storage-mock` to drive object lifecycle behavior and Cloud Storage trigger invocation in-process.

## What Is Included

- `CloudStorageService`, bucket, and object interfaces
- object metadata, read/write/delete/list/signed URL types
- generation and metageneration preconditions
- package-level `CloudStorageError` codes
- shared Cloud Storage object event types
- Firebase Admin-backed adapter
- lightweight production v2 trigger wrapper helpers

## Validation And Errors

The abstraction normalizes common failure paths into `CloudStorageError` codes instead of exposing raw Firebase Admin or Google Cloud Storage SDK errors. It performs a deliberately narrow validation pass before provider calls:

- explicit bucket ids must be non-empty and must not contain `/` or control characters
- object paths must be non-empty and must not start with `/` or contain control characters

This validation is not intended to duplicate every Google Cloud Storage naming rule. Provider-specific bucket naming failures may still be returned by the underlying SDK and mapped to the closest stable `CloudStorageError.code`.

Consumers should treat `CloudStorageError.code` as the portable behavior contract. The error `cause` field preserves the underlying provider or mock failure for diagnostics, audit logging, and sanitized operational traces, but provider-specific cause shapes are not part of the cross-environment contract.

## Signed Read URLs

`createSignedReadUrl()` requires the object to exist and returns the provider-generated URL plus the requested `expiresAt`. In production, signing support depends on Firebase Admin / Google Cloud Storage credentials. Emulator-backed tests should not assume signing credentials are available; use adapter unit tests with fake provider objects for credential-independent signed URL behavior.

## Non-Goals

This package does not provide Storage Rules emulation, resumable uploads, streaming APIs, ACL/public access behavior, retry/backoff simulation, or Google Cloud Storage emulator compatibility.

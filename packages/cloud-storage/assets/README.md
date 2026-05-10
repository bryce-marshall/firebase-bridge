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

## Non-Goals

This package does not provide Storage Rules emulation, resumable uploads, streaming APIs, ACL/public access behavior, retry/backoff simulation, or Google Cloud Storage emulator compatibility.

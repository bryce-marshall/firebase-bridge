# @firebase-bridge/storage-mock

In-memory Cloud Storage mock and trigger harness for Firebase Bridge.

This package implements the `@firebase-bridge/cloud-storage` abstraction with deterministic in-memory storage. Tests can write, read, list, update metadata, delete objects, and drive Cloud Storage trigger handlers without a Firebase Emulator, network calls, or deploy loop.

Unlike `@firebase-bridge/firestore-admin`, this package does not replace or emulate `firebase-admin.storage()` directly. Production code should use the `@firebase-bridge/cloud-storage` abstraction, and tests can substitute this package to drive object lifecycle behavior and Cloud Storage trigger invocation in-process.

## What Is Included

- `StorageMock` and `StorageController`
- immutable in-memory object bytes and metadata
- generation/metageneration preconditions
- deterministic time, signed read URLs, operation logs, and failure injection
- synchronous reset/delete lifecycle controls
- object finalized, deleted, and metadata-updated event emission
- direct v1/v2 `firebase-functions` Storage trigger registration
- `StorageTriggerOrchestrator` with enablement, waiters, observers, and error capture

## Important Constraint

Production code that directly calls `firebase-admin.storage()` cannot be automatically exercised against this mock. Put Cloud Storage access behind `@firebase-bridge/cloud-storage` or your own platform/DI layer.

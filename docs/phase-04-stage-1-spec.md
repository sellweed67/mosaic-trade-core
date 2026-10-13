# Phase 04 Stage 1 — Storage Contract & Adapters (spec as received, v1.5)
Source: the Stage 1 instruction of 2026-10-13, which quotes the approved Phase 04 Specification Correction v1.5. The full v1.5 document is not stored in this repository. This file records only the requirements quoted for Stage 1.
- Contract `contracts/storage.ts`: key pattern `^[a-zA-Z0-9_.:-]{1,256}$`. Statuses active and tombstone. StorageRecord, StorageTombstone, StorageEntry. A StateStore with get, getEntry, put(expectedVersion), delete(expectedVersion), has and close. No unconditional upsert.
- CAS: expectedVersion 0 creates only if the key never existed (v1). An update needs the current version and gives v+1. Delete needs the current active version and leaves a tombstone at v+1. Recreating a deleted key needs the tombstone's version and gives v+1. Versions never reset.
- InMemoryStateStore and SingleProcessFileStore({ baseDir }).
- The lock uses O_CREAT|O_EXCL. An existing lock is never broken and there are no PID or timestamp heuristics. Opening fails and an operator must recover. The lock is removed on close.
- Writes: temp file in the same directory, fsync, rename, then fsync the directory (unsupported platforms are ignored).
- Corrupt files make the store fail closed and are never changed. Tombstones and versions survive restarts.

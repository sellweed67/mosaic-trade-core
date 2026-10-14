/**
 * Storage contract (Phase 04 v1.5, Stage 1). Owner: contracts. Pure types, validation and CAS planning.
 * Every adapter delegates its compare-and-set and tombstone transitions to planPut/planDelete, so all
 * adapters share one set of semantics. No unconditional upsert exists.
 */
import { mosaicError, type MosaicError } from "./error.ts";
import { ok, err, type Result } from "./result.ts";
import { checkAllowedKeys, checkJsonSafe, contractFailure, deepFreeze, isIsoTimestamp, isPlainObject, type ContractIssue } from "./validation.ts";

export const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9_.:-]{1,256}$/;
export const STORAGE_STATUSES = ["active", "tombstone"] as const;
export type StorageStatus = (typeof STORAGE_STATUSES)[number];
export const MAX_STORAGE_VALUE_DEPTH = 32;
export const MAX_ETAG_LENGTH = 256;

export interface StorageRecord<T = unknown> {
  readonly key: string;
  readonly value: T;
  /** Strictly positive and monotonically increasing per key, across delete and recreate. */
  readonly version: number;
  readonly status: "active";
  readonly created_at: string;
  readonly updated_at: string;
  readonly etag?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface StorageTombstone {
  readonly key: string;
  readonly version: number;
  readonly status: "tombstone";
  readonly deleted_at: string;
}
export type StorageEntry<T = unknown> = StorageRecord<T> | StorageTombstone;

export interface StoragePutInput {
  readonly key: string;
  readonly value: unknown;
  readonly etag?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Conditional-write state store. Every write is guarded by expectedVersion; there is no unconditional upsert. */
export interface StateStore {
  /** Active record, or null if the key never existed or is a tombstone. */
  get(key: string): Promise<Result<StorageRecord | null>>;
  /** Active record or tombstone, or null if the key never existed. */
  getEntry(key: string): Promise<Result<StorageEntry | null>>;
  put(input: StoragePutInput, expectedVersion: number): Promise<Result<StorageRecord>>;
  delete(key: string, expectedVersion: number): Promise<Result<StorageTombstone>>;
  /** True only if an active record exists. */
  has(key: string): Promise<Result<boolean>>;
  /** Paginated active keys (tombstones excluded). See planListKeys for ordering and cursor semantics. */
  listKeys(options?: ListKeysOptions): Promise<Result<ListKeysResult>>;
  close(): Promise<void>;
}

export const isStorageKey = (k: unknown): k is string => typeof k === "string" && STORAGE_KEY_PATTERN.test(k);
const isVersion = (v: unknown, min: number) => Number.isSafeInteger(v) && (v as number) >= min;

export function checkStorageKey(key: unknown): Result<string> {
  return isStorageKey(key) ? ok(key) : err(contractFailure("storage.invalid_key", "Storage key", [{ path: "$.key", rule: key === undefined ? "required" : "invalid_format" }]));
}

function collectPutInput(input: unknown, expectedVersion: unknown, issues: ContractIssue[]): void {
  if (!isVersion(expectedVersion, 0)) issues.push({ path: "$.expectedVersion", rule: "non_negative_safe_integer" });
  if (!isPlainObject(input)) { issues.push({ path: "$", rule: "expected_object" }); return; }
  checkAllowedKeys(input, ["key", "value", "etag", "metadata"], "$", issues);
  if (!isStorageKey(input.key)) issues.push({ path: "$.key", rule: input.key === undefined ? "required" : "invalid_format" });
  if (input.value === undefined) issues.push({ path: "$.value", rule: "required" });
  else checkJsonSafe(input.value, "$.value", issues, { scanSensitive: true, maxDepth: MAX_STORAGE_VALUE_DEPTH });
  if (input.etag !== undefined && (typeof input.etag !== "string" || input.etag.length === 0 || input.etag.length > MAX_ETAG_LENGTH)) issues.push({ path: "$.etag", rule: "invalid_etag" });
  if (input.metadata !== undefined) {
    if (!isPlainObject(input.metadata)) issues.push({ path: "$.metadata", rule: "expected_object" });
    else checkJsonSafe(input.metadata, "$.metadata", issues, { scanSensitive: true, maxDepth: 8 });
  }
}

/** Structural validation of a persisted/returned entry. Used by adapters when reloading data (fail closed). */
export function validateStorageEntry(v: unknown): Result<StorageEntry> {
  const issues: ContractIssue[] = [];
  if (!isPlainObject(v)) return err(contractFailure("storage.invalid_entry", "Storage entry", [{ path: "$", rule: "expected_object" }]));
  if (!isStorageKey(v.key)) issues.push({ path: "$.key", rule: "invalid_format" });
  if (!isVersion(v.version, 1)) issues.push({ path: "$.version", rule: "positive_safe_integer" });
  if (v.status === "active") {
    checkAllowedKeys(v, ["key", "value", "version", "status", "created_at", "updated_at", "etag", "metadata"], "$", issues);
    if (!("value" in v) || v.value === undefined) issues.push({ path: "$.value", rule: "required" });
    else checkJsonSafe(v.value, "$.value", issues, { scanSensitive: false, maxDepth: MAX_STORAGE_VALUE_DEPTH });
    if (!isIsoTimestamp(v.created_at)) issues.push({ path: "$.created_at", rule: "invalid_timestamp" });
    if (!isIsoTimestamp(v.updated_at)) issues.push({ path: "$.updated_at", rule: "invalid_timestamp" });
    if (v.etag !== undefined && (typeof v.etag !== "string" || !v.etag || v.etag.length > MAX_ETAG_LENGTH)) issues.push({ path: "$.etag", rule: "invalid_etag" });
    if (v.metadata !== undefined && !isPlainObject(v.metadata)) issues.push({ path: "$.metadata", rule: "expected_object" });
  } else if (v.status === "tombstone") {
    checkAllowedKeys(v, ["key", "version", "status", "deleted_at"], "$", issues);
    if (!isIsoTimestamp(v.deleted_at)) issues.push({ path: "$.deleted_at", rule: "invalid_timestamp" });
  } else issues.push({ path: "$.status", rule: "invalid_enum" });
  return issues.length ? err(contractFailure("storage.invalid_entry", "Storage entry", issues)) : ok(deepFreeze(structuredClone(v as unknown as StorageEntry)));
}

export function versionConflict(expected: number, current: StorageEntry | undefined): MosaicError {
  return mosaicError("storage.version_conflict", "conflict", "Expected version does not match the current entry", {
    details: { expected_version: expected, actual_version: current?.version ?? 0, actual_status: current?.status ?? "absent" },
  });
}

const nextVersion = (v: number): Result<number> =>
  v + 1 > Number.MAX_SAFE_INTEGER ? err(mosaicError("storage.version_exhausted", "conflict", "Version counter exhausted for this key")) : ok(v + 1);

/**
 * Pure CAS planning for put:
 * - absent:    expectedVersion 0                    -> active v1
 * - active:    expectedVersion === current.version  -> active v+1 (created_at kept)
 * - tombstone: expectedVersion === tombstone.version -> active v+1 (new created_at)
 * Anything else is storage.version_conflict. Versions never reset (ABA prevention).
 * put replaces the whole record: etag/metadata that are omitted are not carried over.
 */
export function planPut(current: StorageEntry | undefined, input: StoragePutInput, expectedVersion: number, now: string): Result<StorageRecord> {
  const issues: ContractIssue[] = [];
  collectPutInput(input, expectedVersion, issues);
  if (issues.length) return err(contractFailure("storage.invalid_input", "Storage put", issues));
  const matches = current === undefined ? expectedVersion === 0 : expectedVersion === current.version;
  if (!matches) return err(versionConflict(expectedVersion, current));
  const v = nextVersion(current?.version ?? 0);
  if (!v.ok) return v;
  const record: StorageRecord = {
    key: input.key, value: structuredClone(input.value), version: v.value, status: "active",
    created_at: current?.status === "active" ? current.created_at : now, updated_at: now,
    ...(input.etag !== undefined ? { etag: input.etag } : {}),
    ...(input.metadata !== undefined ? { metadata: structuredClone(input.metadata) } : {}),
  };
  return ok(deepFreeze(record));
}

/** Pure CAS planning for delete: only an active entry whose version equals expectedVersion becomes a tombstone (v+1). */
export function planDelete(current: StorageEntry | undefined, key: string, expectedVersion: number, now: string): Result<StorageTombstone> {
  const k = checkStorageKey(key);
  if (!k.ok) return k;
  if (!isVersion(expectedVersion, 0)) return err(contractFailure("storage.invalid_input", "Storage delete", [{ path: "$.expectedVersion", rule: "non_negative_safe_integer" }]));
  if (current?.status !== "active" || current.version !== expectedVersion) return err(versionConflict(expectedVersion, current));
  const v = nextVersion(current.version);
  if (!v.ok) return v;
  return ok(deepFreeze({ key, version: v.value, status: "tombstone", deleted_at: now }));
}

/** Canonical JSON form of an entry (fixed field order). */
export function serializeStorageEntry(e: StorageEntry): string {
  if (e.status === "tombstone") return JSON.stringify({ key: e.key, version: e.version, status: e.status, deleted_at: e.deleted_at });
  return JSON.stringify({
    key: e.key, value: e.value, version: e.version, status: e.status, created_at: e.created_at, updated_at: e.updated_at,
    ...(e.etag !== undefined ? { etag: e.etag } : {}), ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
  });
}

/** Key listing (Phase 04 Stage 2, Increment 2.1). */
export const DEFAULT_LIST_KEYS_LIMIT = 50;
export const MAX_LIST_KEYS_LIMIT = 250;
export const STORAGE_KEY_PREFIX_PATTERN = /^[a-zA-Z0-9_.:-]{0,256}$/;
export interface ListKeysOptions {
  /** Only keys starting with this prefix (applied before pagination). Empty or omitted = all keys. */
  readonly prefix?: string;
  /** Page size, integer 1..MAX_LIST_KEYS_LIMIT. Default DEFAULT_LIST_KEYS_LIMIT. */
  readonly limit?: number;
  /** Exclusive lower bound: only keys strictly greater than this (same ordering as results). */
  readonly cursor?: string;
}
export interface ListKeysResult {
  /** Active keys only, ascending UTF-16 code-unit order (equals byte order for the ASCII key alphabet). */
  readonly keys: readonly string[];
  /** Present only when more matching keys exist; pass as cursor for the next page. */
  readonly next_cursor?: string;
}

/**
 * Pure listing planner shared by every adapter, so ordering, filtering and paging are identical.
 * The returned page is O(limit); the scan itself is O(n) over the adapter's in-memory entries
 * (both current adapters keep all entries in memory, so total adapter memory is NOT O(limit)).
 */
export function planListKeys(entries: Iterable<StorageEntry>, options?: ListKeysOptions): Result<ListKeysResult> {
  const issues: ContractIssue[] = [];
  const o: Record<string, unknown> = options === undefined ? {} : (options as unknown as Record<string, unknown>);
  if (!isPlainObject(o)) issues.push({ path: "$", rule: "expected_object" });
  else {
    checkAllowedKeys(o, ["prefix", "limit", "cursor"], "$", issues);
    if (o.prefix !== undefined && (typeof o.prefix !== "string" || !STORAGE_KEY_PREFIX_PATTERN.test(o.prefix))) issues.push({ path: "$.prefix", rule: "invalid_format" });
    if (o.limit !== undefined && (!Number.isSafeInteger(o.limit) || (o.limit as number) < 1 || (o.limit as number) > MAX_LIST_KEYS_LIMIT)) issues.push({ path: "$.limit", rule: `integer_1_to_${MAX_LIST_KEYS_LIMIT}` });
    if (o.cursor !== undefined && !isStorageKey(o.cursor)) issues.push({ path: "$.cursor", rule: "invalid_format" });
  }
  if (issues.length) return err(contractFailure("storage.invalid_input", "Storage listKeys", issues));
  const prefix = (o.prefix as string | undefined) ?? "";
  const limit = (o.limit as number | undefined) ?? DEFAULT_LIST_KEYS_LIMIT;
  const cursor = o.cursor as string | undefined;
  const matching: string[] = [];
  for (const e of entries) {
    if (e.status !== "active" || !e.key.startsWith(prefix)) continue;
    if (cursor !== undefined && !(e.key > cursor)) continue;
    matching.push(e.key);
  }
  matching.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const keys = matching.slice(0, limit);
  const result: ListKeysResult = matching.length > limit ? { keys, next_cursor: keys[keys.length - 1]! } : { keys };
  return ok(deepFreeze(result));
}

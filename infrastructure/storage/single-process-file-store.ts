/**
 * File-backed StateStore for ONE process. See docs/ARCHITECTURE.md §15 for guarantees and limits.
 *
 * Layout:  <baseDir>/process.lock     exclusive lock (O_CREAT|O_EXCL), holds a random owner token
 *          <baseDir>/records/<sha256(key)>.json   one canonical JSON StorageEntry per key
 * Write:   temp file in the same dir -> fsync -> rename over the destination -> fsync the directory
 *          (directory fsync is skipped only when the platform reports it as unsupported).
 * Safety:
 * - An existing lock is never broken or inspected. Opening fails, and an operator must recover.
 * - Any file that can't be interpreted makes open() fail closed. Bytes are never modified or deleted.
 * - Leftover temp files (an interrupted write before rename) are left in place and counted in diagnostics.
 * - If a failure happens at or after rename, the on-disk outcome is unknown. The store "poisons" itself
 *   and rejects every further operation until it is closed and reopened (which reloads from disk).
 */
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import {
  checkStorageKey, mosaicError, ok, err, planDelete, planPut, serializeStorageEntry, validateStorageEntry,
  type MosaicError, type Result, type StateStore, type StorageEntry, type StoragePutInput, type StorageRecord, type StorageTombstone,
} from "../../contracts/index.ts";
import { SystemError } from "../../core/index.ts";

export interface SingleProcessFileStoreConfig { readonly baseDir: string; }
/** Fault-injection hooks for tests. A throwing hook simulates a failure at that point. */
export interface FileStoreHooks {
  readonly afterTempWrite?: (tmpPath: string) => Promise<void> | void;
  readonly afterRename?: (destPath: string) => Promise<void> | void;
}
export interface FileStoreOptions { readonly now?: () => Date; readonly hooks?: FileStoreHooks; }
export interface FileStoreDiagnostics {
  readonly entries: number;
  readonly orphan_temp_files: number;
  readonly directory_fsync_supported: boolean;
  readonly poisoned: boolean;
  readonly closed: boolean;
}

export const LOCK_FILE = "process.lock";
export const RECORDS_DIR = "records";
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;
const TEMP_MARKER = ".tmp.";
const DIR_FSYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"]);
export const fileNameForKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex") + ".json";

const fatal = (code: string, message: string, cause?: unknown) =>
  new SystemError(code, "unavailable", message, { retryable: false, ...(cause !== undefined ? { cause } : {}) });

export class SingleProcessFileStore implements StateStore {
  readonly #baseDir: string;
  readonly #recordsDir: string;
  readonly #lockPath: string;
  readonly #token: string;
  readonly #now: () => Date;
  readonly #hooks: FileStoreHooks;
  readonly #entries: Map<string, StorageEntry>;
  readonly #orphans: number;
  #dirSync = true;
  #queue: Promise<unknown> = Promise.resolve();
  #poisoned: MosaicError | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  private constructor(p: { baseDir: string; token: string; entries: Map<string, StorageEntry>; orphans: number; dirSync: boolean; opts: FileStoreOptions }) {
    this.#baseDir = p.baseDir; this.#recordsDir = join(p.baseDir, RECORDS_DIR); this.#lockPath = join(p.baseDir, LOCK_FILE);
    this.#token = p.token; this.#entries = p.entries; this.#orphans = p.orphans; this.#dirSync = p.dirSync;
    this.#now = p.opts.now ?? (() => new Date()); this.#hooks = p.opts.hooks ?? {};
  }

  /** Acquires the lock, then loads and validates every entry. Fails closed and releases its own lock on any problem. */
  static async open(config: SingleProcessFileStoreConfig, opts: FileStoreOptions = {}): Promise<SingleProcessFileStore> {
    if (!config || typeof config.baseDir !== "string" || config.baseDir.length === 0) throw new SystemError("storage.invalid_config", "configuration", "baseDir is required");
    const baseDir = resolve(config.baseDir);
    await mkdir(baseDir, { recursive: true });
    const lockPath = join(baseDir, LOCK_FILE);
    const token = randomBytes(16).toString("hex");
    let fh;
    try { fh = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
    catch (e: any) {
      if (e?.code === "EEXIST") throw fatal("storage.lock_held", `Store lock ${lockPath} already exists. Another process may be using this store, or a previous run ended abnormally. Operator recovery required: confirm no process uses this directory, then remove the lock manually.`);
      throw fatal("storage.lock_failed", "Could not create the store lock", e);
    }
    try {
      try { await fh.writeFile(JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() })); await fh.sync(); }
      finally { await fh.close(); }
      const dirSync = await syncDir(baseDir);
      const recordsDir = join(baseDir, RECORDS_DIR);
      await mkdir(recordsDir, { recursive: true });
      await syncDir(baseDir);
      const { entries, orphans } = await load(recordsDir);
      return new SingleProcessFileStore({ baseDir, token, entries, orphans, dirSync, opts });
    } catch (e) {
      await releaseLock(lockPath, token);
      throw e;
    }
  }

  diagnostics(): FileStoreDiagnostics {
    return { entries: this.#entries.size, orphan_temp_files: this.#orphans, directory_fsync_supported: this.#dirSync, poisoned: this.#poisoned !== undefined, closed: this.#closed };
  }

  #unusable(): Result<never> | undefined {
    if (this.#closed || this.#closing) return err(mosaicError("storage.closed", "unavailable", "Store is closed", { retryable: false }));
    if (this.#poisoned) return err(this.#poisoned);
    return undefined;
  }

  async get(key: string): Promise<Result<StorageRecord | null>> {
    const e = await this.getEntry(key);
    return e.ok ? ok(e.value?.status === "active" ? e.value : null) : e;
  }
  async getEntry(key: string): Promise<Result<StorageEntry | null>> {
    const u = this.#unusable(); if (u) return u;
    const k = checkStorageKey(key); if (!k.ok) return k;
    return ok(this.#entries.get(key) ?? null);
  }
  async has(key: string): Promise<Result<boolean>> {
    const r = await this.get(key);
    return r.ok ? ok(r.value !== null) : r;
  }
  put(input: StoragePutInput, expectedVersion: number): Promise<Result<StorageRecord>> {
    return this.#exclusive(() => {
      const key = (input as { key?: unknown })?.key;
      return planPut(typeof key === "string" ? this.#entries.get(key) : undefined, input, expectedVersion, this.#now().toISOString());
    });
  }
  delete(key: string, expectedVersion: number): Promise<Result<StorageTombstone>> {
    return this.#exclusive(() => planDelete(typeof key === "string" ? this.#entries.get(key) : undefined, key, expectedVersion, this.#now().toISOString()));
  }

  /** Serializes writes. The CAS plan is computed and persisted inside the critical section. */
  #exclusive<T extends StorageEntry>(plan: () => Result<T>): Promise<Result<T>> {
    const run = this.#queue.then(async (): Promise<Result<T>> => {
      const u = this.#unusable(); if (u) return u;
      const p = plan();
      if (!p.ok) return p;
      const w = await this.#persist(p.value);
      if (!w.ok) return w;
      this.#entries.set(p.value.key, p.value);
      return p;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #persist(entry: StorageEntry): Promise<Result<void>> {
    const dest = join(this.#recordsDir, fileNameForKey(entry.key));
    const tmp = `${dest}${TEMP_MARKER}${randomBytes(8).toString("hex")}`;
    try {
      const fh = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await fh.writeFile(serializeStorageEntry(entry)); await fh.sync(); } finally { await fh.close(); }
      await this.#hooks.afterTempWrite?.(tmp);
    } catch (e) {
      await unlink(tmp).catch(() => undefined); // only our own temp file; the destination was not touched
      return err(mosaicError("storage.write_failed", "unavailable", "Write failed before commit; stored state is unchanged", { cause: e }));
    }
    try {
      await rename(tmp, dest);
      await this.#hooks.afterRename?.(dest);
      this.#dirSync = (await syncDir(this.#recordsDir)) && this.#dirSync;
      return ok(undefined);
    } catch (e) {
      this.#poisoned = mosaicError("storage.durability_unknown", "unknown_external_state", "Failure during or after commit; on-disk state is uncertain. Close and reopen the store to reconcile.", { cause: e });
      return err(this.#poisoned);
    }
  }

  /** Waits for pending writes, then releases the lock if this instance still owns it. Idempotent. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      await this.#queue;
      this.#closed = true;
      await releaseLock(this.#lockPath, this.#token);
      await syncDir(this.#baseDir).catch(() => false);
    })();
    return this.#closing;
  }
}

/** fsync a directory. Returns false when the platform reports directory fsync as unsupported; rethrows other errors. */
async function syncDir(dir: string): Promise<boolean> {
  let fh;
  try { fh = await open(dir, constants.O_RDONLY); }
  catch (e: any) { if (DIR_FSYNC_UNSUPPORTED.has(e?.code)) return false; throw e; }
  try { await fh.sync(); return true; }
  catch (e: any) { if (DIR_FSYNC_UNSUPPORTED.has(e?.code)) return false; throw e; }
  finally { await fh.close(); }
}

/** Removes the lock only if its content still carries our token. Never touches someone else's lock. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const content = JSON.parse(await readFile(lockPath, "utf8"));
    if (content?.token === token) await unlink(lockPath);
  } catch { /* missing or foreign lock: leave as is */ }
}

async function load(recordsDir: string): Promise<{ entries: Map<string, StorageEntry>; orphans: number }> {
  const entries = new Map<string, StorageEntry>();
  let orphans = 0;
  for (const name of (await readdir(recordsDir)).sort()) {
    if (name.includes(TEMP_MARKER)) { orphans++; continue; }
    if (!RECORD_FILE.test(name)) throw fatal("storage.unexpected_file", `Unexpected file in records directory: ${name}. Refusing to open; nothing was modified.`);
    const bytes = await readFile(join(recordsDir, name));
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); }
    catch { throw fatal("storage.corrupt_entry", `Record file ${name} is not valid JSON. Refusing to open; the file was preserved unchanged.`); }
    const v = validateStorageEntry(parsed);
    if (!v.ok) throw fatal("storage.corrupt_entry", `Record file ${name} does not match the storage schema. Refusing to open; the file was preserved unchanged.`);
    if (fileNameForKey(v.value.key) !== name) throw fatal("storage.corrupt_entry", `Record file ${name} does not match the key it contains. Refusing to open; the file was preserved unchanged.`);
    entries.set(v.value.key, v.value);
  }
  return { entries, orphans };
}

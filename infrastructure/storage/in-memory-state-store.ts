/**
 * In-process StateStore. Not durable: contents vanish with the process.
 * All CAS work happens synchronously between awaits, so each operation is atomic within the event loop.
 */
import { checkStorageKey, mosaicError, ok, err, planDelete, planListKeys, planPut, type ListKeysOptions, type ListKeysResult, type Result, type StateStore, type StorageEntry, type StoragePutInput, type StorageRecord, type StorageTombstone } from "../../contracts/index.ts";

const closedError = () => err(mosaicError("storage.closed", "unavailable", "Store is closed", { retryable: false }));

export class InMemoryStateStore implements StateStore {
  readonly #entries = new Map<string, StorageEntry>();
  readonly #now: () => Date;
  #closed = false;
  constructor(opts: { readonly now?: () => Date } = {}) { this.#now = opts.now ?? (() => new Date()); }

  async get(key: string): Promise<Result<StorageRecord | null>> {
    const e = await this.getEntry(key);
    return e.ok ? ok(e.value?.status === "active" ? e.value : null) : e;
  }
  async getEntry(key: string): Promise<Result<StorageEntry | null>> {
    if (this.#closed) return closedError();
    const k = checkStorageKey(key); if (!k.ok) return k;
    return ok(this.#entries.get(key) ?? null);
  }
  async has(key: string): Promise<Result<boolean>> {
    const r = await this.get(key);
    return r.ok ? ok(r.value !== null) : r;
  }
  async listKeys(options?: ListKeysOptions): Promise<Result<ListKeysResult>> {
    if (this.#closed) return closedError();
    return planListKeys(this.#entries.values(), options);
  }
  async put(input: StoragePutInput, expectedVersion: number): Promise<Result<StorageRecord>> {
    if (this.#closed) return closedError();
    const key = (input as { key?: unknown })?.key;
    const plan = planPut(typeof key === "string" ? this.#entries.get(key) : undefined, input, expectedVersion, this.#now().toISOString());
    if (plan.ok) this.#entries.set(plan.value.key, plan.value);
    return plan;
  }
  async delete(key: string, expectedVersion: number): Promise<Result<StorageTombstone>> {
    if (this.#closed) return closedError();
    const plan = planDelete(typeof key === "string" ? this.#entries.get(key) : undefined, key, expectedVersion, this.#now().toISOString());
    if (plan.ok) this.#entries.set(key, plan.value);
    return plan;
  }
  async close(): Promise<void> { this.#closed = true; }
}

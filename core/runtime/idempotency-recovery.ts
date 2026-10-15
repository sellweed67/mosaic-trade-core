/**
 * Startup scan of the durable idempotency ledger (Phase 04 Stage 2, Increment 2.2). Owner: CORE RUNTIME.
 * Orphaned in_progress records become unknown_external_state (guarded CAS). Nothing is retried or pruned.
 * Three distinct outcomes: throws (operational failure, fail closed), "clean", or "unresolved_records_exist".
 * Not yet called at startup: that wiring is Increment 2.3.
 */
import type { StateStore } from "../../contracts/index.ts";
import { MosaicFault } from "../foundation/errors.ts";
import { IDEMPOTENCY_KEY_PREFIX, parseDurableRecord, type DurableIdempotencyRecord } from "./durable-idempotency-ledger.ts";

export type RecoveryStatus = "clean" | "unresolved_records_exist";
export interface RecoveryReport {
  readonly status: RecoveryStatus;
  readonly scannedCount: number;
  readonly transitionedCount: number;
  readonly unresolvedKeys: readonly string[];
}

export class IdempotencyRecovery {
  readonly #store: StateStore;
  readonly #now: () => Date;
  constructor(store: StateStore, opts: { readonly now?: () => Date } = {}) { this.#store = store; this.#now = opts.now ?? (() => new Date()); }

  async recover(): Promise<RecoveryReport> {
    let scannedCount = 0, transitionedCount = 0;
    const unresolvedKeys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#store.listKeys({ prefix: IDEMPOTENCY_KEY_PREFIX, ...(cursor !== undefined ? { cursor } : {}) });
      if (!page.ok) throw new MosaicFault(page.error);
      for (const key of page.value.keys) {
        const got = await this.#store.get(key);
        if (!got.ok) throw new MosaicFault(got.error);
        if (got.value === null) continue; // deleted after listing: tombstones are never unresolved
        scannedCount++;
        const rec = parseDurableRecord(got.value.value); // corrupt record fails closed
        if (rec.state === "in_progress") {
          const next: DurableIdempotencyRecord = { ...rec, state: "unknown_external_state", requires_reconciliation: true, updated_at: this.#now().toISOString() };
          const put = await this.#store.put({ key, value: next }, got.value.version);
          if (!put.ok) throw new MosaicFault(put.error);
          transitionedCount++; unresolvedKeys.push(key);
        } else if (rec.state === "unknown_external_state") unresolvedKeys.push(key);
      }
      cursor = page.value.next_cursor;
    } while (cursor !== undefined);
    if (unresolvedKeys.length === 0) return Object.freeze({ status: "clean", scannedCount, transitionedCount: 0, unresolvedKeys: Object.freeze([]) });
    return Object.freeze({ status: "unresolved_records_exist", scannedCount, transitionedCount, unresolvedKeys: Object.freeze(unresolvedKeys) });
  }
}

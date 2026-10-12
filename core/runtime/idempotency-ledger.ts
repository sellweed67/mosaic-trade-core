/**
 * Process-local, bounded idempotency ledger for COMMAND dispatch. Owner: CORE RUNTIME.
 * It applies the Phase 02 rules (classifyDelivery, mayExecute, transitionIdempotency).
 * LIMITATIONS: in-memory only. It is lost on process exit and isn't shared across processes, so it gives no
 * durable or cross-process exactly-once guarantee. It lives as long as its Lifecycle instance (including restarts).
 */
import { createHash } from "node:crypto";
import {
  classifyDelivery, mayExecute, transitionIdempotency, mosaicError,
  type IdempotencyDescriptor, type IdempotencyRecord, type IdempotencyState, type MessageEnvelope, type MosaicError,
} from "../../contracts/index.ts";

export type LedgerBegin =
  | { readonly action: "execute"; readonly key: string }
  | { readonly action: "duplicate" }
  | { readonly action: "reject"; readonly error: MosaicError };

const EVICTABLE: ReadonlySet<IdempotencyState> = new Set(["succeeded", "failed_final", "failed_retryable"]);

export class IdempotencyLedger {
  readonly #max: number;
  readonly #records = new Map<string, IdempotencyRecord>();
  constructor(max: number) { this.#max = max; }
  get size(): number { return this.#records.size; }

  begin(destination: string, env: MessageEnvelope, now: Date = new Date()): LedgerBegin {
    const k = `${destination}\u0000${env.idempotency_key}`;
    const descriptor: IdempotencyDescriptor = {
      key: env.idempotency_key!, scope: { namespace: destination, operation: "command" },
      fingerprint: "sha256:" + createHash("sha256").update(JSON.stringify(env.payload)).digest("hex"),
      created_at: now.toISOString(),
    };
    const existing = this.#records.get(k);
    const delivery = classifyDelivery(existing, descriptor, now);
    if (delivery === "key_reuse_conflict" || delivery === "expired_key") {
      return { action: "reject", error: mosaicError("dispatch.idempotency_conflict", "conflict", "Idempotency key reused for a different operation") };
    }
    const gate = mayExecute(existing);
    if (!gate.allowed) {
      if (existing!.state === "succeeded") return { action: "duplicate" };
      if (existing!.state === "unknown_external_state") return { action: "reject", error: mosaicError("dispatch.reconciliation_required", "unknown_external_state", "Previous outcome unknown; reconcile before retrying") };
      return { action: "reject", error: mosaicError(`dispatch.idempotency_${gate.reason}`, "conflict", `Operation not executable: ${gate.reason}`) };
    }
    if (!existing && this.#records.size >= this.#max && !this.#evictOne()) {
      return { action: "reject", error: mosaicError("dispatch.idempotency_capacity", "unavailable", "Idempotency ledger full of unresolved operations") };
    }
    const from: IdempotencyState = existing?.state ?? "new";
    const t = transitionIdempotency(from, "in_progress", "execution");
    if (!t.ok) return { action: "reject", error: t.error };
    this.#records.delete(k); // re-insert to mark as most recent
    this.#records.set(k, { ...descriptor, state: "in_progress", attempts: (existing?.attempts ?? 0) + 1, updated_at: now.toISOString() });
    return { action: "execute", key: k };
  }

  complete(key: string, to: IdempotencyState, now: Date = new Date()): void {
    const r = this.#records.get(key);
    if (!r) return;
    const t = transitionIdempotency(r.state, to, "execution");
    if (t.ok) this.#records.set(key, { ...r, state: to, updated_at: now.toISOString() });
  }
  state(destination: string, idempotencyKey: string): IdempotencyState | undefined {
    return this.#records.get(`${destination}\u0000${idempotencyKey}`)?.state;
  }
  /** Evicts the oldest terminal or retryable record. Never evicts in_progress or unknown_external_state. */
  #evictOne(): boolean {
    for (const [k, r] of this.#records) if (EVICTABLE.has(r.state)) { this.#records.delete(k); return true; }
    return false;
  }
}

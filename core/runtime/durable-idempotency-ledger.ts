/**
 * Durable idempotency ledger (Phase 04 Stage 2, Increment 2.2). Owner: CORE RUNTIME.
 * Backed by any StateStore; every write is a guarded compare-and-set. NOT wired into the Dispatcher:
 * startup integration and dispatch gating are Increment 2.3. No pruning is performed here.
 */
import { createHash } from "node:crypto";
import { isIdentifier, isIsoTimestamp, isPlainObject, validateEnvelope, type MessageEnvelope, type MosaicError, type StateStore, type StorageRecord } from "../../contracts/index.ts";
import { ContractError, DomainError, MosaicFault, SystemError } from "../foundation/errors.ts";
import { computeFingerprint } from "./canonical-fingerprint.ts";

export const MIN_RETENTION_MS = 86_400_000;
export const DEFAULT_RETENTION_MS = 604_800_000;
export const MAX_RETENTION_MS = 2_592_000_000;
export const IDEMPOTENCY_KEY_PREFIX = "idmp:";

export const DURABLE_STATES = ["in_progress", "succeeded", "failed_final", "unknown_external_state"] as const;
export type DurableIdempotencyState = (typeof DURABLE_STATES)[number];

export interface ResponseRef {
  readonly status: "success" | "failure";
  readonly error_code?: string;
  readonly sanitized_message?: string;
}
export interface DurableIdempotencyRecord {
  readonly idempotency_key: string;
  readonly namespace: string;
  readonly operation: string;
  readonly execution_fingerprint: string;
  readonly state: DurableIdempotencyState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at?: string;
  readonly retention_deadline?: string;
  readonly requires_reconciliation?: boolean;
  readonly response_ref?: ResponseRef;
}

export interface ClaimOptions { readonly namespace: string; readonly operation: string; }
export type ClaimResult =
  | { readonly outcome: "claimed"; readonly key: string; readonly version: number; readonly record: DurableIdempotencyRecord }
  | { readonly outcome: "duplicate"; readonly key: string; readonly record: DurableIdempotencyRecord };
/** Outcome of an execution. "unknown" means the external side effect may or may not have happened. */
export type CompletionResult =
  | { readonly status: "success" }
  | { readonly status: "failure"; readonly error_code: string; readonly sanitized_message?: string }
  | { readonly status: "unknown" };
export type ReconciliationResult = Exclude<CompletionResult, { status: "unknown" }>;

const SCOPE_PART = /^[a-z][a-z0-9_.:-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function clampRetention(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_RETENTION_MS;
  if (!Number.isFinite(ms)) throw new ContractError("idempotency.invalid_retention", "contract_violation", "Retention must be a finite number");
  return Math.min(MAX_RETENTION_MS, Math.max(MIN_RETENTION_MS, Math.trunc(ms)));
}

export function ledgerKey(namespace: string, operation: string, callerKey: string): string {
  return `${IDEMPOTENCY_KEY_PREFIX}${createHash("sha256").update(namespace + "\u0000" + operation, "utf8").digest("hex")}:${callerKey}`;
}

/** Structural check of a persisted record. Anything unexpected fails closed. */
export function parseDurableRecord(v: unknown): DurableIdempotencyRecord {
  const bad = (why: string): never => { throw new SystemError("idempotency.corrupt_record", "internal", `Stored idempotency record is invalid: ${why}`); };
  if (!isPlainObject(v)) return bad("not_object");
  const r = v as Record<string, unknown>;
  if (!isIdentifier(r.idempotency_key)) bad("idempotency_key");
  if (typeof r.namespace !== "string" || !SCOPE_PART.test(r.namespace)) bad("namespace");
  if (typeof r.operation !== "string" || !SCOPE_PART.test(r.operation)) bad("operation");
  if (typeof r.execution_fingerprint !== "string" || !HEX64.test(r.execution_fingerprint)) bad("execution_fingerprint");
  if (!DURABLE_STATES.includes(r.state as DurableIdempotencyState)) bad("state");
  if (!isIsoTimestamp(r.created_at) || !isIsoTimestamp(r.updated_at)) bad("timestamps");
  const terminal = r.state === "succeeded" || r.state === "failed_final";
  if (terminal) {
    if (!isIsoTimestamp(r.completed_at) || !isIsoTimestamp(r.retention_deadline)) bad("terminal_without_retention");
    if (!isPlainObject(r.response_ref)) bad("terminal_without_response_ref");
  } else if (r.completed_at !== undefined || r.retention_deadline !== undefined) bad("unresolved_with_completion");
  if (r.state === "unknown_external_state" && r.requires_reconciliation !== true) bad("unknown_without_reconciliation_flag");
  return v as unknown as DurableIdempotencyRecord;
}

const storageFault = (e: MosaicError) => new MosaicFault(e);

export interface DurableLedgerOptions { readonly retentionMs?: number; readonly now?: () => Date; }

export class DurableIdempotencyLedger {
  readonly #store: StateStore;
  readonly #retentionMs: number;
  readonly #now: () => Date;
  constructor(store: StateStore, opts: DurableLedgerOptions = {}) {
    this.#store = store;
    this.#retentionMs = clampRetention(opts.retentionMs);
    this.#now = opts.now ?? (() => new Date());
  }
  get retentionMs(): number { return this.#retentionMs; }

  /**
   * Validates and canonicalizes BEFORE any durable write, then claims with expectedVersion 0.
   * On conflict the stored record is verified (fingerprint first) before any duplicate is returned.
   */
  async claim(envelope: MessageEnvelope, options: ClaimOptions): Promise<ClaimResult> {
    if (!isPlainObject(options) || typeof options.namespace !== "string" || !SCOPE_PART.test(options.namespace) || typeof options.operation !== "string" || !SCOPE_PART.test(options.operation)) {
      throw new ContractError("idempotency.invalid_scope", "contract_violation", "Invalid idempotency namespace/operation");
    }
    const fingerprint = computeFingerprint(envelope); // throws contract.invalid_payload; nothing written yet
    const v = validateEnvelope(envelope);
    if (!v.ok) throw new MosaicFault(v.error);
    const env = v.value;
    if (env.message_type !== "COMMAND" || env.destination === undefined || !isIdentifier(env.idempotency_key)) {
      throw new ContractError("idempotency.not_a_command", "contract_violation", "Only COMMAND envelopes with destination and idempotency_key can be claimed");
    }
    const key = ledgerKey(options.namespace, options.operation, env.idempotency_key);
    const now = this.#now().toISOString();
    const record: DurableIdempotencyRecord = {
      idempotency_key: env.idempotency_key, namespace: options.namespace, operation: options.operation,
      execution_fingerprint: fingerprint, state: "in_progress", created_at: now, updated_at: now,
    };
    const put = await this.#store.put({ key, value: record }, 0);
    if (put.ok) return { outcome: "claimed", key, version: put.value.version, record };
    if (put.error.code !== "storage.version_conflict") throw storageFault(put.error);

    const entry = await this.#store.getEntry(key);
    if (!entry.ok) throw storageFault(entry.error);
    if (entry.value === null || entry.value.status === "tombstone") {
      throw new DomainError("idempotency.key_retired", "conflict", "Idempotency key is permanently retired and cannot be reused");
    }
    const stored = parseDurableRecord(entry.value.value);
    if (stored.execution_fingerprint !== fingerprint) {
      throw new DomainError("idempotency.fingerprint_mismatch", "conflict", "Idempotency key reused for a different operation");
    }
    switch (stored.state) {
      case "succeeded": case "failed_final": return { outcome: "duplicate", key, record: stored };
      case "in_progress": throw new DomainError("idempotency.in_flight", "conflict", "Operation with this idempotency key is already in progress");
      case "unknown_external_state": throw new SystemError("idempotency.reconciliation_required", "unknown_external_state", "Previous outcome unknown; reconcile before any retry");
    }
  }

  /** Guarded in_progress -> terminal | unknown_external_state. CAS or state mismatch fails closed. */
  async complete(key: string, result: CompletionResult, expectedVersion: number): Promise<StorageRecord> {
    return this.#transition(key, expectedVersion, "in_progress", result);
  }

  /** Guarded unknown_external_state -> terminal. Retention starts only now. */
  async reconcile(key: string, result: ReconciliationResult, expectedVersion: number): Promise<StorageRecord> {
    if ((result as CompletionResult).status === "unknown") throw new ContractError("idempotency.invalid_reconciliation", "contract_violation", "Reconciliation must resolve to a terminal outcome");
    return this.#transition(key, expectedVersion, "unknown_external_state", result);
  }

  async read(key: string): Promise<{ readonly version: number; readonly record: DurableIdempotencyRecord } | null> {
    const r = await this.#store.get(key);
    if (!r.ok) throw storageFault(r.error);
    return r.value === null ? null : { version: r.value.version, record: parseDurableRecord(r.value.value) };
  }

  async #transition(key: string, expectedVersion: number, from: DurableIdempotencyState, result: CompletionResult): Promise<StorageRecord> {
    const cur = await this.#store.get(key);
    if (!cur.ok) throw storageFault(cur.error);
    if (cur.value === null || cur.value.version !== expectedVersion) {
      throw new DomainError("idempotency.version_conflict", "conflict", "Record changed or missing; refusing transition", { details: { expected_version: expectedVersion, actual_version: cur.value?.version ?? 0 } });
    }
    const rec = parseDurableRecord(cur.value.value);
    if (rec.state !== from) throw new DomainError("idempotency.illegal_transition", "conflict", `Cannot transition from ${rec.state}`);
    const nowD = this.#now(); const now = nowD.toISOString();
    const { completed_at: _c, retention_deadline: _r, requires_reconciliation: _q, response_ref: _p, ...base } = rec;
    let next: DurableIdempotencyRecord;
    if (result.status === "unknown") {
      next = { ...base, state: "unknown_external_state", updated_at: now, requires_reconciliation: true };
    } else {
      if (result.status === "failure" && (typeof result.error_code !== "string" || !result.error_code)) throw new ContractError("idempotency.invalid_result", "contract_violation", "failure requires error_code");
      const response_ref: ResponseRef = result.status === "success" ? { status: "success" } : {
        status: "failure", error_code: result.error_code, ...(result.sanitized_message !== undefined ? { sanitized_message: result.sanitized_message } : {}),
      };
      next = {
        ...base, state: result.status === "success" ? "succeeded" : "failed_final", updated_at: now, completed_at: now,
        retention_deadline: new Date(nowD.getTime() + this.#retentionMs).toISOString(), response_ref,
      };
    }
    const put = await this.#store.put({ key, value: next }, expectedVersion);
    if (!put.ok) throw storageFault(put.error);
    return put.value;
  }
}

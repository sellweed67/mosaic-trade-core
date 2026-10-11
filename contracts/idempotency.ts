/**
 * idempotency_key contract. Owner: contracts. Defines scope, lifecycle and delivery classification.
 * No store is implemented: callers supply the existing record (if any) from their own persistence.
 */
import { isIdentifier, type IdempotencyKey } from "./identifiers.ts";
import { checkAllowedKeys, checkEnum, checkInt, checkString, fail, deepFreeze, isIsoTimestamp, isPlainObject, type ContractIssue } from "./validation.ts";
import { ok, err, type Result } from "./result.ts";
import { mosaicError } from "./error.ts";

/** A key is unique only within (namespace, operation). The same key in another scope is a different operation. */
export interface IdempotencyScope { readonly namespace: string; readonly operation: string; }
export interface IdempotencyDescriptor {
  readonly key: IdempotencyKey;
  readonly scope: IdempotencyScope;
  /** Caller-computed digest of the logical operation's inputs. Same key + different fingerprint = misuse. */
  readonly fingerprint: string;
  readonly created_at: string;
  readonly expires_at?: string;
}

export const IDEMPOTENCY_STATES = ["new", "in_progress", "succeeded", "failed_retryable", "failed_final", "unknown_external_state"] as const;
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];
export interface IdempotencyRecord extends IdempotencyDescriptor {
  readonly state: IdempotencyState;
  readonly attempts: number;
  readonly updated_at: string;
}

const SCOPE_PART = /^[a-z][a-z0-9_.:-]{0,127}$/;
const FINGERPRINT = /^[A-Za-z0-9+/=_:-]{16,256}$/;

export function collectIdempotencyDescriptor(v: unknown, path: string, issues: ContractIssue[], allowRecordFields = false): void {
  if (!isPlainObject(v)) { issues.push({ path, rule: v === undefined ? "required" : "expected_object" }); return; }
  checkAllowedKeys(v, ["key", "scope", "fingerprint", "created_at", "expires_at", ...(allowRecordFields ? ["state", "attempts", "updated_at"] : [])], path, issues);
  if (!isIdentifier(v.key)) issues.push({ path: `${path}.key`, rule: v.key === undefined ? "required" : "invalid_identifier" });
  if (!isPlainObject(v.scope)) issues.push({ path: `${path}.scope`, rule: v.scope === undefined ? "required" : "expected_object" });
  else {
    checkAllowedKeys(v.scope, ["namespace", "operation"], `${path}.scope`, issues);
    checkString(v.scope.namespace, SCOPE_PART, `${path}.scope.namespace`, issues);
    checkString(v.scope.operation, SCOPE_PART, `${path}.scope.operation`, issues);
  }
  checkString(v.fingerprint, FINGERPRINT, `${path}.fingerprint`, issues);
  if (!isIsoTimestamp(v.created_at)) issues.push({ path: `${path}.created_at`, rule: v.created_at === undefined ? "required" : "invalid_timestamp" });
  if (v.expires_at !== undefined) {
    if (!isIsoTimestamp(v.expires_at)) issues.push({ path: `${path}.expires_at`, rule: "invalid_timestamp" });
    else if (isIsoTimestamp(v.created_at) && Date.parse(v.expires_at) <= Date.parse(v.created_at)) issues.push({ path: `${path}.expires_at`, rule: "must_be_after_created_at" });
  }
  if (allowRecordFields) {
    checkEnum(v.state, IDEMPOTENCY_STATES, `${path}.state`, issues);
    checkInt(v.attempts, 0, 1_000_000, `${path}.attempts`, issues);
    if (!isIsoTimestamp(v.updated_at)) issues.push({ path: `${path}.updated_at`, rule: v.updated_at === undefined ? "required" : "invalid_timestamp" });
  }
}
export function validateIdempotencyDescriptor(v: unknown): Result<IdempotencyDescriptor> {
  const issues: ContractIssue[] = []; collectIdempotencyDescriptor(v, "$", issues);
  return issues.length ? fail("contract.invalid_idempotency", "Idempotency descriptor", issues) : ok(deepFreeze(structuredClone(v as IdempotencyDescriptor)));
}
export function validateIdempotencyRecord(v: unknown): Result<IdempotencyRecord> {
  const issues: ContractIssue[] = []; collectIdempotencyDescriptor(v, "$", issues, true);
  return issues.length ? fail("contract.invalid_idempotency", "Idempotency record", issues) : ok(deepFreeze(structuredClone(v as IdempotencyRecord)));
}

export type DeliveryClass =
  | "new_operation"        // no prior record: may execute
  | "duplicate_delivery"   // same key, scope and fingerprint: same logical operation, don't execute again blindly
  | "key_reuse_conflict"   // same key and scope, different inputs: reject
  | "expired_key";         // prior record expired: reject; caller must mint a new key for a new operation

const sameScope = (a: IdempotencyScope, b: IdempotencyScope) => a.namespace === b.namespace && a.operation === b.operation;

/** Classifies an incoming delivery against the stored record for the same key. Invalid input throws nothing and returns a conflict (fail closed). */
export function classifyDelivery(existing: IdempotencyRecord | undefined, incoming: IdempotencyDescriptor, now: Date = new Date()): DeliveryClass {
  if (!validateIdempotencyDescriptor(incoming).ok) return "key_reuse_conflict";
  if (existing === undefined) return "new_operation";
  if (!validateIdempotencyRecord(existing).ok || existing.key !== incoming.key || !sameScope(existing.scope, incoming.scope)) return "key_reuse_conflict";
  if (existing.expires_at !== undefined && Date.parse(existing.expires_at) <= now.getTime()) return "expired_key";
  return existing.fingerprint === incoming.fingerprint ? "duplicate_delivery" : "key_reuse_conflict";
}

/**
 * May the operation execute now? Only "new" and "failed_retryable" may.
 * "unknown_external_state" never may: a side effect may already have happened, so reconcile first.
 */
export function mayExecute(record: IdempotencyRecord | undefined): { readonly allowed: boolean; readonly reason: string } {
  if (record === undefined) return { allowed: true, reason: "new_operation" };
  switch (record.state) {
    case "new": case "failed_retryable": return { allowed: true, reason: record.state };
    case "in_progress": return { allowed: false, reason: "in_progress" };
    case "succeeded": return { allowed: false, reason: "already_succeeded_return_stored_result" };
    case "failed_final": return { allowed: false, reason: "failed_final" };
    case "unknown_external_state": return { allowed: false, reason: "reconciliation_required" };
    default: return { allowed: false, reason: "invalid_state" };
  }
}

export type TransitionVia = "execution" | "reconciliation";
/**
 * Legal idempotency transitions. A lost response or timeout while in_progress must move to
 * unknown_external_state, never directly to failed_*. Leaving unknown_external_state is only legal via reconciliation.
 */
export const IDEMPOTENCY_TRANSITIONS: Readonly<Record<TransitionVia, Readonly<Partial<Record<IdempotencyState, readonly IdempotencyState[]>>>>> = Object.freeze({
  execution: {
    new: ["in_progress"],
    in_progress: ["succeeded", "failed_retryable", "failed_final", "unknown_external_state"],
    failed_retryable: ["in_progress"],
  },
  reconciliation: {
    unknown_external_state: ["succeeded", "failed_retryable", "failed_final"],
  },
});
export function transitionIdempotency(from: IdempotencyState, to: IdempotencyState, via: TransitionVia): Result<IdempotencyState> {
  const allowed = IDEMPOTENCY_TRANSITIONS[via]?.[from] ?? [];
  return allowed.includes(to) ? ok(to) : err(mosaicError("contract.invalid_idempotency_transition", "contract_violation", `Illegal idempotency transition ${from} -> ${to} via ${via}`));
}

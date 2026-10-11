/**
 * retry_policy contract and a PURE retry decision function. Owner: contracts.
 * RELIABILITY will own execution (scheduling, timers). Nothing here schedules or sleeps.
 */
import { ERROR_CATEGORY_KIND, isRetryForbiddenCategory, type ErrorCategory, type MosaicError } from "./error.ts";
import type { IdempotencyKey } from "./identifiers.ts";
import { checkAllowedKeys, checkEnum, checkInt, fail, deepFreeze, isIsoTimestamp, isPlainObject, type ContractIssue } from "./validation.ts";
import { ok, type Result } from "./result.ts";

export interface BackoffPolicy {
  readonly strategy: "fixed" | "exponential";
  readonly initial_delay_ms: number;
  readonly max_delay_ms: number;
  /** Must be 1 for fixed; must be >1 and <=10 for exponential. */
  readonly multiplier: number;
  readonly jitter: "none" | "full";
}
export interface RetryPolicy {
  readonly retry_allowed: boolean;
  /** Total attempts including the first. 1 means no retry. */
  readonly max_attempts: number;
  readonly retryable_categories: readonly ErrorCategory[];
  readonly backoff: BackoffPolicy;
  readonly attempt_timeout_ms?: number;
  /** Absolute ISO-8601 UTC deadline after which no further attempt may start. */
  readonly deadline?: string;
  /** Always true: an unknown external outcome must be reconciled before any retry. Cannot be disabled. */
  readonly reconcile_on_unknown_outcome: true;
  /** When true, a retry is refused unless an idempotency key is supplied. */
  readonly requires_idempotency_key: boolean;
}

export function collectRetryPolicy(v: unknown, path: string, issues: ContractIssue[]): void {
  if (!isPlainObject(v)) { issues.push({ path, rule: v === undefined ? "required" : "expected_object" }); return; }
  checkAllowedKeys(v, ["retry_allowed", "max_attempts", "retryable_categories", "backoff", "attempt_timeout_ms", "deadline", "reconcile_on_unknown_outcome", "requires_idempotency_key"], path, issues);
  if (typeof v.retry_allowed !== "boolean") issues.push({ path: `${path}.retry_allowed`, rule: "expected_boolean" });
  const attemptsOk = checkInt(v.max_attempts, 1, 20, `${path}.max_attempts`, issues);
  const cats = v.retryable_categories;
  if (!Array.isArray(cats)) issues.push({ path: `${path}.retryable_categories`, rule: "expected_array" });
  else {
    if (new Set(cats).size !== cats.length) issues.push({ path: `${path}.retryable_categories`, rule: "duplicate_entries" });
    cats.forEach((c, i) => {
      if (checkEnum(c, Object.keys(ERROR_CATEGORY_KIND) as ErrorCategory[], `${path}.retryable_categories[${i}]`, issues) && isRetryForbiddenCategory(c))
        issues.push({ path: `${path}.retryable_categories[${i}]`, rule: "category_never_retryable" });
    });
  }
  if (v.retry_allowed === false && attemptsOk && v.max_attempts !== 1) issues.push({ path: `${path}.max_attempts`, rule: "must_be_1_when_retry_not_allowed" });
  if (v.retry_allowed === false && Array.isArray(cats) && cats.length) issues.push({ path: `${path}.retryable_categories`, rule: "must_be_empty_when_retry_not_allowed" });
  if (v.retry_allowed === true && attemptsOk && (v.max_attempts as number) < 2) issues.push({ path: `${path}.max_attempts`, rule: "must_be_at_least_2_when_retry_allowed" });
  if (v.retry_allowed === true && Array.isArray(cats) && !cats.length) issues.push({ path: `${path}.retryable_categories`, rule: "required_when_retry_allowed" });
  const b = v.backoff;
  if (!isPlainObject(b)) issues.push({ path: `${path}.backoff`, rule: b === undefined ? "required" : "expected_object" });
  else {
    const bp = `${path}.backoff`;
    checkAllowedKeys(b, ["strategy", "initial_delay_ms", "max_delay_ms", "multiplier", "jitter"], bp, issues);
    const strat = checkEnum(b.strategy, ["fixed", "exponential"] as const, `${bp}.strategy`, issues);
    const initOk = checkInt(b.initial_delay_ms, 0, 600_000, `${bp}.initial_delay_ms`, issues);
    const maxOk = checkInt(b.max_delay_ms, 0, 3_600_000, `${bp}.max_delay_ms`, issues);
    if (initOk && maxOk && (b.max_delay_ms as number) < (b.initial_delay_ms as number)) issues.push({ path: `${bp}.max_delay_ms`, rule: "must_be_gte_initial_delay" });
    checkEnum(b.jitter, ["none", "full"] as const, `${bp}.jitter`, issues);
    const m = b.multiplier;
    if (typeof m !== "number" || !Number.isFinite(m)) issues.push({ path: `${bp}.multiplier`, rule: "expected_number" });
    else if (strat && b.strategy === "fixed" && m !== 1) issues.push({ path: `${bp}.multiplier`, rule: "must_be_1_for_fixed" });
    else if (strat && b.strategy === "exponential" && (m <= 1 || m > 10)) issues.push({ path: `${bp}.multiplier`, rule: "must_be_gt1_lte10_for_exponential" });
  }
  if (v.attempt_timeout_ms !== undefined) checkInt(v.attempt_timeout_ms, 1, 3_600_000, `${path}.attempt_timeout_ms`, issues);
  if (v.deadline !== undefined && !isIsoTimestamp(v.deadline)) issues.push({ path: `${path}.deadline`, rule: "invalid_timestamp" });
  if (v.reconcile_on_unknown_outcome !== true) issues.push({ path: `${path}.reconcile_on_unknown_outcome`, rule: "must_be_true" });
  if (typeof v.requires_idempotency_key !== "boolean") issues.push({ path: `${path}.requires_idempotency_key`, rule: "expected_boolean" });
}
export function validateRetryPolicy(v: unknown): Result<RetryPolicy> {
  const issues: ContractIssue[] = [];
  collectRetryPolicy(v, "$", issues);
  return issues.length ? fail("contract.invalid_retry_policy", "Retry policy", issues) : ok(deepFreeze(structuredClone(v as RetryPolicy)));
}

export type RetryDecision =
  | { readonly action: "retry"; readonly delay_ms: number; readonly next_attempt: number }
  | { readonly action: "reconcile"; readonly reason: "unknown_external_state" }
  | { readonly action: "stop"; readonly reason: "invalid_policy" | "retry_not_allowed" | "error_not_retryable" | "category_not_retryable" | "max_attempts_reached" | "idempotency_key_required" | "deadline_exceeded" | "invalid_attempt" };

export interface RetryInput {
  readonly error: MosaicError;
  /** Number of attempts already made (>= 1). */
  readonly attempt: number;
  readonly idempotency_key?: IdempotencyKey;
  readonly now?: Date;
  /** Injected randomness for jitter, in [0,1). */
  readonly random?: () => number;
}

/**
 * Pure, deterministic decision. Order of checks matters: reconciliation comes first, so an unknown
 * external outcome can never produce "retry" whatever the policy says. Invalid input => stop.
 */
export function decideRetry(policy: unknown, input: RetryInput): RetryDecision {
  if (input.error.requires_reconciliation || input.error.category === "unknown_external_state") return { action: "reconcile", reason: "unknown_external_state" };
  const v = validateRetryPolicy(policy);
  if (!v.ok) return { action: "stop", reason: "invalid_policy" };
  const p = v.value;
  if (!Number.isInteger(input.attempt) || input.attempt < 1) return { action: "stop", reason: "invalid_attempt" };
  if (!p.retry_allowed) return { action: "stop", reason: "retry_not_allowed" };
  if (!input.error.is_retryable || isRetryForbiddenCategory(input.error.category)) return { action: "stop", reason: "error_not_retryable" };
  if (!p.retryable_categories.includes(input.error.category)) return { action: "stop", reason: "category_not_retryable" };
  if (input.attempt >= p.max_attempts) return { action: "stop", reason: "max_attempts_reached" };
  if (p.requires_idempotency_key && input.idempotency_key === undefined) return { action: "stop", reason: "idempotency_key_required" };
  const b = p.backoff;
  const base = b.strategy === "fixed" ? b.initial_delay_ms : b.initial_delay_ms * b.multiplier ** (input.attempt - 1);
  const capped = Math.min(b.max_delay_ms, Math.round(base));
  const delay_ms = b.jitter === "full" ? Math.floor(Math.min(Math.max((input.random ?? Math.random)(), 0), 0.999999) * capped) : capped;
  if (p.deadline !== undefined && (input.now ?? new Date()).getTime() + delay_ms >= Date.parse(p.deadline)) return { action: "stop", reason: "deadline_exceeded" };
  return { action: "retry", delay_ms, next_attempt: input.attempt + 1 };
}

/**
 * policy_context contract. Owner: contracts (canonical precedence). POLICY & SECURITY owns the future engine.
 * This file defines data, ordering and conflict representation only. It is not a policy engine.
 */
import { checkAllowedKeys, checkEnum, checkString, fail, deepFreeze, isPlainObject, type ContractIssue } from "./validation.ts";
import { ok, type Result } from "./result.ts";

/** Highest priority first. Higher-level policy always wins. */
export const POLICY_PRECEDENCE = ["safety", "security", "risk", "data", "privacy", "cost", "performance", "optimization"] as const;
export type PolicyLevel = (typeof POLICY_PRECEDENCE)[number];

export const POLICY_EFFECTS = ["deny", "require_approval", "allow"] as const;
/** Ordered most -> least restrictive. Used to break ties within one level. */
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export interface PolicyConstraint {
  readonly level: PolicyLevel;
  readonly policy_id: string;
  readonly effect: PolicyEffect;
  readonly reason_code?: string;
}
export interface PolicyContext { readonly constraints: readonly PolicyConstraint[]; }

export interface PolicyConflict {
  readonly winner: Pick<PolicyConstraint, "level" | "policy_id" | "effect">;
  readonly overridden: Pick<PolicyConstraint, "level" | "policy_id" | "effect">;
}
export interface PolicyResolution {
  readonly outcome: PolicyEffect;
  /** null means no valid constraint decided, so the outcome is deny (fail closed). */
  readonly decided_by: Pick<PolicyConstraint, "level" | "policy_id" | "effect"> | null;
  /** Every constraint whose effect differs from the winner. Conflicts are reported, never silently dropped. */
  readonly conflicts: readonly PolicyConflict[];
}

const POLICY_ID = /^[a-z][a-z0-9_.:-]{0,127}$/;
const MAX_CONSTRAINTS = 256;

export function collectPolicyContext(v: unknown, path: string, issues: ContractIssue[]): void {
  if (!isPlainObject(v)) { issues.push({ path, rule: v === undefined ? "required" : "expected_object" }); return; }
  checkAllowedKeys(v, ["constraints"], path, issues);
  if (!Array.isArray(v.constraints)) { issues.push({ path: `${path}.constraints`, rule: "expected_array" }); return; }
  if (v.constraints.length > MAX_CONSTRAINTS) issues.push({ path: `${path}.constraints`, rule: "too_many_entries" });
  v.constraints.forEach((c, i) => {
    const p = `${path}.constraints[${i}]`;
    if (!isPlainObject(c)) { issues.push({ path: p, rule: "expected_object" }); return; }
    checkAllowedKeys(c, ["level", "policy_id", "effect", "reason_code"], p, issues);
    checkEnum(c.level, POLICY_PRECEDENCE, `${p}.level`, issues);
    checkString(c.policy_id, POLICY_ID, `${p}.policy_id`, issues);
    checkEnum(c.effect, POLICY_EFFECTS, `${p}.effect`, issues);
    if (c.reason_code !== undefined) checkString(c.reason_code, POLICY_ID, `${p}.reason_code`, issues);
  });
}
export function validatePolicyContext(v: unknown): Result<PolicyContext> {
  const issues: ContractIssue[] = [];
  collectPolicyContext(v, "$", issues);
  return issues.length ? fail("contract.invalid_policy_context", "Policy context", issues) : ok(deepFreeze(structuredClone(v as PolicyContext)));
}

const rank = (c: PolicyConstraint) => POLICY_PRECEDENCE.indexOf(c.level) * POLICY_EFFECTS.length + POLICY_EFFECTS.indexOf(c.effect);
const brief = (c: PolicyConstraint) => ({ level: c.level, policy_id: c.policy_id, effect: c.effect });

/**
 * Deterministic resolution. The highest-precedence level present decides. Within that level the most
 * restrictive effect wins (deny > require_approval > allow). Invalid or empty context => deny.
 * The result doesn't depend on input order.
 */
export function resolvePolicyContext(ctx: unknown): PolicyResolution {
  const v = validatePolicyContext(ctx);
  if (!v.ok || v.value.constraints.length === 0) return { outcome: "deny", decided_by: null, conflicts: [] };
  const sorted = [...v.value.constraints].sort((a, b) => rank(a) - rank(b) || a.policy_id.localeCompare(b.policy_id));
  const winner = sorted[0]!;
  return {
    outcome: winner.effect,
    decided_by: brief(winner),
    conflicts: sorted.slice(1).filter((c) => c.effect !== winner.effect).map((c) => ({ winner: brief(winner), overridden: brief(c) })),
  };
}

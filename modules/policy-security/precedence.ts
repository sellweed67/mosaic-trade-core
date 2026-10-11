/**
 * Phase 01 per-level decision combiner, kept for compatibility. Owner: POLICY & SECURITY.
 * The canonical precedence order lives in contracts/policy.ts. Constraint-based resolution: resolvePolicyContext.
 */
import { POLICY_PRECEDENCE, type PolicyLevel } from "../../contracts/index.ts";
export { POLICY_PRECEDENCE, type PolicyLevel };
export type Decision = "allow" | "deny" | "unknown";

/** The highest level that has a decision wins. "unknown" or no decision at all => deny (fail closed). */
export function resolvePrecedence(decisions: Partial<Record<PolicyLevel, Decision>>): "allow" | "deny" {
  for (const level of POLICY_PRECEDENCE) {
    const d = decisions[level];
    if (d === undefined) continue;
    return d === "allow" ? "allow" : "deny";
  }
  return "deny";
}

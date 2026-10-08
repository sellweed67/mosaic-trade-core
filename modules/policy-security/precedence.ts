/** Policy precedence (highest first). Owner: POLICY & SECURITY. Engine itself is NOT implemented. */
export const POLICY_PRECEDENCE = [
  "safety", "security", "risk", "data", "privacy", "cost", "performance", "optimization",
] as const;
export type PolicyLevel = (typeof POLICY_PRECEDENCE)[number];
export type Decision = "allow" | "deny" | "unknown";

/**
 * Combines per-level decisions. The highest level that has a decision wins.
 * Any "unknown" at or above the winning level, or no decision at all, => deny (fail closed).
 */
export function resolvePrecedence(decisions: Partial<Record<PolicyLevel, Decision>>): "allow" | "deny" {
  for (const level of POLICY_PRECEDENCE) {
    const d = decisions[level];
    if (d === undefined) continue;
    return d === "allow" ? "allow" : "deny";
  }
  return "deny";
}

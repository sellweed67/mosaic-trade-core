import type { ModuleDescriptor } from "../../core/index.ts";
/** reliability module. RESERVED boundary — no functionality implemented in Phase 00-B. */
export const module: ModuleDescriptor = Object.freeze({
  id: "reliability",
  owns: ["timeout", "retry", "backoff", "circuit-breaker", "recovery", "reconciliation", "safe-state", "checkpoint", "resume", "idempotency"],
  dependsOn: ["foundation"],
  status: "reserved",
});

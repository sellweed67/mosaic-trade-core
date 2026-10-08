import type { ModuleDescriptor } from "../../core/index.ts";
/** policy-security module. RESERVED boundary — no functionality implemented in Phase 00-B. */
export const module: ModuleDescriptor = {
  id: "policy-security",
  owns: ["policy-engine", "identity", "authentication", "authorization", "capability-access-control", "permission", "secret-management", "rate-limiting", "safety-rules"],
  dependsOn: ["foundation"],
  status: "reserved",
};

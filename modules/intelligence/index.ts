import type { ModuleDescriptor } from "../../core/index.ts";
/** intelligence module. RESERVED boundary — no functionality implemented in Phase 00-B. */
export const module: ModuleDescriptor = Object.freeze({
  id: "intelligence",
  owns: ["ai-registry-view", "ai-discovery", "ai-router", "capability-matching", "quality-evaluation", "ai-fallback", "model-escalation"],
  dependsOn: ["resource", "policy-security"],
  status: "reserved",
});

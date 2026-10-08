import type { ModuleDescriptor } from "../../core/index.ts";
/** resource module. RESERVED boundary — no functionality implemented in Phase 00-B. */
export const module: ModuleDescriptor = {
  id: "resource",
  owns: ["resource-registry", "resource-discovery", "resource-allocation", "resource-health", "resource-lifecycle"],
  dependsOn: ["foundation"],
  status: "reserved",
};

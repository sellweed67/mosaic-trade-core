import type { ModuleDescriptor } from "../../core/index.ts";
/** validation module. RESERVED boundary — no functionality implemented in Phase 00-B. */
export const module: ModuleDescriptor = {
  id: "validation",
  owns: ["input-validation", "contract-validation", "compatibility-check"],
  dependsOn: ["foundation"],
  status: "reserved",
};

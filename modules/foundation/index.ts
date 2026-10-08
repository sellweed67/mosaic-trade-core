import type { ModuleDescriptor } from "../../core/index.ts";
/** foundation module. RESERVED boundary — no functionality implemented in Phase 00-B. */
export const module: ModuleDescriptor = {
  id: "foundation",
  owns: ["bootstrap", "lifecycle", "configuration", "environment", "version", "module-registration", "error-model", "health-aggregation"],
  dependsOn: [],
  status: "reserved",
};

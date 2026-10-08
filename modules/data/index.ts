import type { ModuleDescriptor } from "../../core/index.ts";
/** data module. RESERVED boundary — no functionality implemented in Phase 00-B. */
export const module: ModuleDescriptor = {
  id: "data",
  owns: ["primary-database", "object-storage", "cache", "memory", "archive", "data-lifecycle"],
  dependsOn: ["foundation"],
  status: "reserved",
};

import type { ModuleDescriptor } from "../../core/index.ts";
/** observability module. RESERVED boundary — no functionality implemented in Phase 00-B. */
export const module: ModuleDescriptor = Object.freeze({
  id: "observability",
  owns: ["logging-sink", "metrics", "tracing", "audit", "provenance"],
  dependsOn: ["foundation"],
  status: "reserved",
});

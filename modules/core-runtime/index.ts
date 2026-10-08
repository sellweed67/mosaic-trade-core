import type { ModuleDescriptor } from "../../core/index.ts";
/** core-runtime module. RESERVED boundary — no functionality implemented in Phase 00-B. */
export const module: ModuleDescriptor = Object.freeze({
  id: "core-runtime",
  owns: ["task-execution", "workflow-engine", "event-bus", "queue", "scheduling"],
  dependsOn: ["foundation"],
  status: "reserved",
});

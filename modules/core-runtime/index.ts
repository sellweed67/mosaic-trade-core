import type { ModuleDescriptor } from "../../core/index.ts";
/** core-runtime module. RESERVED boundary — descriptor only. "internal-dispatch" is implemented in core/runtime (Phase 03). */
export const module: ModuleDescriptor = {
  id: "core-runtime",
  owns: ["internal-dispatch", "task-execution", "workflow-engine", "event-bus", "queue", "scheduling"],
  dependsOn: ["foundation"],
  status: "reserved",
};

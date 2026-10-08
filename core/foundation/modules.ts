import type { HealthCheck } from "./health.ts";
import type { Logger } from "./logging.ts";
import type { MosaicConfig } from "./config.ts";
import type { SecretProvider } from "./secrets.ts";
import { SystemError } from "./errors.ts";

/** Module registry boundary. Owner: FOUNDATION. */
export const MODULE_IDS = [
  "foundation", "core-runtime", "intelligence", "resource", "data", "policy-security",
  "validation", "resource-optimization", "reliability", "observability", "control", "universal-integration",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** Dependencies passed explicitly (dependency initialization boundary). No global container. */
export interface ModuleContext {
  readonly config: MosaicConfig;
  readonly logger: Logger;
  readonly secrets: SecretProvider;
}

export interface ModuleDescriptor {
  readonly id: ModuleId;
  readonly owns: readonly string[];
  /** Other modules this one depends on (communicating through contracts only). */
  readonly dependsOn: readonly ModuleId[];
  readonly status: "reserved" | "implemented";
  init?(ctx: ModuleContext): Promise<void> | void;
  stop?(): Promise<void> | void;
  health?: HealthCheck;
}

/**
 * Validates ids, ownership and dependencies; returns a deterministic topological order
 * (dependencies first; ties keep registration order). Shutdown uses the reverse.
 */
export function orderModules(mods: readonly ModuleDescriptor[]): ModuleDescriptor[] {
  const byId = new Map<ModuleId, ModuleDescriptor>();
  const owner = new Map<string, ModuleId>();
  for (const m of mods) {
    if (!(MODULE_IDS as readonly string[]).includes(m.id)) throw new SystemError("registry.unknown_module", "configuration", `Unknown module id: ${m.id}`);
    if (byId.has(m.id)) throw new SystemError("registry.duplicate_module", "configuration", `Duplicate module id: ${m.id}`);
    byId.set(m.id, m);
    for (const cap of m.owns) {
      const prev = owner.get(cap);
      if (prev) throw new SystemError("registry.duplicate_authority", "configuration", `Duplicate authority: "${cap}" owned by ${prev} and ${m.id}`);
      owner.set(cap, m.id);
    }
  }
  const out: ModuleDescriptor[] = [];
  const state = new Map<ModuleId, "visiting" | "done">();
  const visit = (id: ModuleId, path: readonly ModuleId[]) => {
    const m = byId.get(id);
    if (!m) throw new SystemError("registry.missing_dependency", "configuration", `Missing module dependency: ${path.join(" -> ")} -> ${id}`);
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") throw new SystemError("registry.cycle", "configuration", `Module dependency cycle: ${[...path, id].join(" -> ")}`);
    state.set(id, "visiting");
    for (const d of m.dependsOn) visit(d, [...path, id]);
    state.set(id, "done");
    out.push(m);
  };
  for (const m of mods) visit(m.id, []);
  return out;
}

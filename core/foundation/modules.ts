import type { HealthCheck } from "./health.ts";
import type { Logger } from "./logging.ts";
import type { MosaicConfig } from "./config.ts";

/** Module registration boundary. Owner: FOUNDATION. */
export const MODULE_IDS = [
  "foundation", "core-runtime", "intelligence", "resource", "data", "policy-security",
  "validation", "resource-optimization", "reliability", "observability", "control", "universal-integration",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** Dependencies passed explicitly (dependency initialization boundary). No global container. */
export interface ModuleContext { readonly config: MosaicConfig; readonly logger: Logger; }

export interface ModuleDescriptor {
  readonly id: ModuleId;
  readonly owns: readonly string[];
  /** Other modules this one may depend on (via contracts only). */
  readonly dependsOn: readonly ModuleId[];
  readonly status: "reserved" | "implemented";
  init?(ctx: ModuleContext): Promise<void>;
  stop?(): Promise<void>;
  health?: HealthCheck;
}

/** Validates uniqueness of ids and ownership, and produces a dependency-ordered list. */
export function orderModules(mods: readonly ModuleDescriptor[]): ModuleDescriptor[] {
  const byId = new Map<ModuleId, ModuleDescriptor>();
  const owner = new Map<string, ModuleId>();
  for (const m of mods) {
    if (byId.has(m.id)) throw new Error(`Duplicate module id: ${m.id}`);
    byId.set(m.id, m);
    for (const cap of m.owns) {
      const prev = owner.get(cap);
      if (prev) throw new Error(`Duplicate authority: "${cap}" owned by ${prev} and ${m.id}`);
      owner.set(cap, m.id);
    }
  }
  const out: ModuleDescriptor[] = []; const state = new Map<ModuleId, 1 | 2>();
  const visit = (id: ModuleId, path: ModuleId[]) => {
    const m = byId.get(id); if (!m) throw new Error(`Unknown module dependency: ${id}`);
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`Module dependency cycle: ${[...path, id].join(" -> ")}`);
    state.set(id, 1); m.dependsOn.forEach((d) => visit(d, [...path, id])); state.set(id, 2); out.push(m);
  };
  mods.forEach((m) => visit(m.id, []));
  return out;
}

import type { ModuleDescriptor, ModuleContext } from "./modules.ts";
import { orderModules } from "./modules.ts";
import { aggregateHealth, type HealthCheck } from "./health.ts";

/** Runtime lifecycle. Owner: FOUNDATION. State is local to the instance (no global mutable state). */
export type LifecycleState = "created" | "starting" | "running" | "stopping" | "stopped" | "failed";

export class Lifecycle {
  #state: LifecycleState = "created";
  #started: ModuleDescriptor[] = [];
  readonly #ordered: ModuleDescriptor[];
  readonly #ctx: ModuleContext;
  constructor(modules: readonly ModuleDescriptor[], ctx: ModuleContext) { this.#ordered = orderModules(modules); this.#ctx = ctx; }
  get state(): LifecycleState { return this.#state; }

  async start(): Promise<void> {
    if (this.#state !== "created") throw new Error(`Cannot start from state ${this.#state}`);
    this.#state = "starting";
    try {
      for (const m of this.#ordered) { await m.init?.(this.#ctx); this.#started.push(m); }
      this.#state = "running";
    } catch (e) {
      this.#state = "failed";
      await this.#stopStarted(); // fail safely: unwind what started
      throw e;
    }
  }
  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopping"; await this.#stopStarted(); this.#state = "stopped";
  }
  async #stopStarted(): Promise<void> {
    for (const m of [...this.#started].reverse()) {
      try { await m.stop?.(); } catch (e) { this.#ctx.logger.log("error", "module stop failed", { module: m.id, error: String(e) }); }
    }
    this.#started = [];
  }
  health() {
    const checks = new Map<string, HealthCheck>();
    for (const m of this.#ordered) if (m.health) checks.set(m.id, m.health);
    return aggregateHealth(checks, this.#ctx.config.timeouts.defaultMs);
  }
}

import type { LivenessReport, ReadinessReport } from "../../contracts/index.ts";
import { orderModules, type ModuleDescriptor, type ModuleContext } from "./modules.ts";
import { aggregateHealth, isReady, type HealthCheck } from "./health.ts";
import { SystemError, toFault, toMosaicError } from "./errors.ts";
import { withDeadline } from "./timeout.ts";

/** Runtime lifecycle. Owner: FOUNDATION. State is owned by this instance (no global mutable state). */
export type LifecycleState = "created" | "starting" | "running" | "stopping" | "stopped" | "failed";

/** The only legal transitions. Anything else throws. */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = Object.freeze({
  created: ["starting", "stopping"],
  starting: ["running", "failed"],
  running: ["stopping"],
  failed: ["stopping"],
  stopping: ["stopped"],
  stopped: [],
});

export interface ShutdownReport { readonly clean: boolean; readonly failures: readonly { module: string; code: string; message: string }[]; }

export class Lifecycle {
  #state: LifecycleState = "created";
  #history: LifecycleState[] = ["created"];
  #started: ModuleDescriptor[] = [];
  #stopping: Promise<ShutdownReport> | undefined;
  readonly #ordered: readonly ModuleDescriptor[];
  readonly #ctx: ModuleContext;

  constructor(modules: readonly ModuleDescriptor[], ctx: ModuleContext) {
    this.#ordered = Object.freeze(orderModules(modules));
    this.#ctx = ctx;
  }
  get state(): LifecycleState { return this.#state; }
  get history(): readonly LifecycleState[] { return [...this.#history]; }
  get startupOrder(): readonly string[] { return this.#ordered.map((m) => m.id); }

  #to(next: LifecycleState): void {
    if (!LIFECYCLE_TRANSITIONS[this.#state].includes(next)) {
      throw new SystemError("lifecycle.invalid_transition", "internal", `Invalid lifecycle transition ${this.#state} -> ${next}`);
    }
    this.#ctx.logger.debug("lifecycle transition", { from: this.#state, to: next });
    this.#state = next;
    this.#history.push(next);
  }
  #moduleCtx(m: ModuleDescriptor): ModuleContext {
    return { ...this.#ctx, logger: this.#ctx.logger.child({ module: m.id }) };
  }

  /** Starts modules in dependency order. On any failure: rolls back started modules (reverse) and enters "failed". */
  async start(): Promise<void> {
    this.#to("starting");
    const { startupMs, shutdownMs } = this.#ctx.config.timeouts;
    try {
      for (const m of this.#ordered) {
        if (m.init) await withDeadline(() => m.init!(this.#moduleCtx(m)), startupMs, "lifecycle.startup_timeout", `init of module ${m.id}`);
        this.#started.push(m);
      }
      this.#to("running");
      this.#ctx.logger.info("lifecycle running", { modules: this.#started.length });
    } catch (e) {
      const fault = toFault(e);
      this.#ctx.logger.error("startup failed; rolling back", { error: toMosaicError(fault) });
      this.#to("failed");
      const report = await this.#unwind(Date.now() + shutdownMs);
      if (!report.clean) this.#ctx.logger.error("rollback incomplete", { failures: report.failures });
      throw fault;
    }
  }

  /** Graceful shutdown: reverse start order, within a total budget of timeouts.shutdownMs. Idempotent. */
  stop(): Promise<ShutdownReport> {
    if (this.#stopping) return this.#stopping;
    if (this.#state === "starting") return Promise.reject(new SystemError("lifecycle.invalid_transition", "internal", "Cannot stop while starting"));
    this.#to("stopping");
    this.#stopping = (async () => {
      const report = await this.#unwind(Date.now() + this.#ctx.config.timeouts.shutdownMs);
      this.#to("stopped");
      this.#ctx.logger.log(report.clean ? "info" : "error", "lifecycle stopped", { clean: report.clean, failures: report.failures });
      return report;
    })();
    return this.#stopping;
  }

  async #unwind(deadline: number): Promise<ShutdownReport> {
    const failures: { module: string; code: string; message: string }[] = [];
    for (const m of [...this.#started].reverse()) {
      if (!m.stop) continue;
      try {
        await withDeadline(() => m.stop!(), deadline - Date.now(), "lifecycle.shutdown_timeout", `stop of module ${m.id}`);
      } catch (e) {
        const err = toMosaicError(e);
        failures.push({ module: m.id, code: err.code, message: err.message });
      }
    }
    this.#started = [];
    return { clean: failures.length === 0, failures };
  }

  liveness(): LivenessReport {
    return { live: this.#state !== "failed" && this.#state !== "stopped", state: this.#state, checkedAt: new Date().toISOString() };
  }
  async readiness(): Promise<ReadinessReport> {
    const state = this.#state;
    const checks = new Map<string, HealthCheck>();
    if (state === "running") for (const m of this.#ordered) if (m.health) checks.set(m.id, m.health);
    const reports = await aggregateHealth(checks, this.#ctx.config.timeouts.defaultMs);
    return { ready: state === "running" && this.#state === "running" && isReady(reports), state: this.#state, checks: reports, checkedAt: new Date().toISOString() };
  }
}

import { mosaicError, type LivenessReport, type MosaicError, type ReadinessReport } from "../../contracts/index.ts";
import { orderModules, type ModuleDescriptor, type ModuleContext } from "./modules.ts";
import { aggregateHealth, isReady, type HealthCheck } from "./health.ts";
import { MosaicFault, SystemError, toMosaicError } from "./errors.ts";
import { withDeadline } from "./timeout.ts";

/**
 * Runtime lifecycle. Owner: FOUNDATION. State is owned by this instance (no global mutable state).
 * Canonical five-state machine (Phase 02): created -> starting -> running -> stopping -> stopped.
 * Failures are NOT a state. They're reported through the error model and `lastStartupFailure`.
 */
export type LifecycleState = "created" | "starting" | "running" | "stopping" | "stopped";
export const LIFECYCLE_STATES: readonly LifecycleState[] = Object.freeze(["created", "starting", "running", "stopping", "stopped"]);

/**
 * The only legal transitions. Anything else is rejected.
 * - starting -> stopping is startup rollback.
 * - created -> stopping supports stop-before-start.
 * - stopped -> starting allows a clean restart (started-module list is always empty in stopped).
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = Object.freeze({
  created: Object.freeze(["starting", "stopping"] as const),
  starting: Object.freeze(["running", "stopping"] as const),
  running: Object.freeze(["stopping"] as const),
  stopping: Object.freeze(["stopped"] as const),
  stopped: Object.freeze(["starting"] as const),
});

export interface CleanupFailure { readonly module: string; readonly code: string; readonly message: string; }
export interface ShutdownReport { readonly clean: boolean; readonly failures: readonly CleanupFailure[]; }

const CLEAN: ShutdownReport = Object.freeze({ clean: true, failures: Object.freeze([]) });

export class Lifecycle {
  #state: LifecycleState = "created";
  #history: LifecycleState[] = ["created"];
  #started: ModuleDescriptor[] = [];
  #starting: Promise<void> | undefined;
  #stopping: Promise<ShutdownReport> | undefined;
  #lastFailure: MosaicError | undefined;
  #lastRollback: ShutdownReport | undefined;
  readonly #ordered: readonly ModuleDescriptor[];
  readonly #ctx: ModuleContext;

  constructor(modules: readonly ModuleDescriptor[], ctx: ModuleContext) {
    this.#ordered = Object.freeze(orderModules(modules));
    this.#ctx = ctx;
  }
  get state(): LifecycleState { return this.#state; }
  get history(): readonly LifecycleState[] { return [...this.#history]; }
  get startupOrder(): readonly string[] { return this.#ordered.map((m) => m.id); }
  /** Serializable contract form of the most recent startup failure (with rollback diagnostics), if any. */
  get lastStartupFailure(): MosaicError | undefined { return this.#lastFailure; }

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

  /**
   * Starts modules in dependency order.
   * - While starting: returns the in-flight start (no duplicate acquisition).
   * - From running/stopping: rejects with lifecycle.invalid_transition (Phase 01 behaviour).
   * - On failure: rolls back started modules in reverse order, ends in "stopped", and rejects with the
   *   PRIMARY error (same code/category/message), with rollback diagnostics in details.rollback and the original as `cause`.
   */
  start(): Promise<void> {
    if (this.#state === "starting" && this.#starting) return this.#starting;
    try { this.#to("starting"); } catch (e) { return Promise.reject(e); }
    this.#stopping = undefined; this.#lastFailure = undefined; this.#lastRollback = undefined;
    const run = this.#runStart();
    this.#starting = run;
    run.then(() => { this.#starting = undefined; }, () => { this.#starting = undefined; });
    return run;
  }

  async #runStart(): Promise<void> {
    const { startupMs, shutdownMs } = this.#ctx.config.timeouts;
    try {
      for (const m of this.#ordered) {
        if (m.init) await withDeadline(() => m.init!(this.#moduleCtx(m)), startupMs, "lifecycle.startup_timeout", `init of module ${m.id}`);
        this.#started.push(m);
      }
      this.#to("running");
      this.#ctx.logger.info("lifecycle running", { modules: this.#started.length });
    } catch (e) {
      const primary = toMosaicError(e);
      this.#ctx.logger.error("startup failed; rolling back", { error: primary });
      this.#to("stopping");
      const rollback = await this.#unwind(Date.now() + shutdownMs);
      this.#lastRollback = rollback;
      this.#to("stopped");
      if (!rollback.clean) this.#ctx.logger.error("rollback incomplete", { failures: rollback.failures });
      const fault = new MosaicFault(mosaicError(primary.code, primary.category, primary.message, {
        retryable: primary.is_retryable,
        requires_reconciliation: primary.requires_reconciliation,
        ...(primary.correlation_id !== undefined ? { correlation_id: primary.correlation_id } : {}),
        details: { ...(primary.details ?? {}), rollback },
        cause: e,
      }));
      this.#lastFailure = fault.toJSON();
      throw fault;
    }
  }

  /**
   * Graceful shutdown: reverse start order, within a total budget of timeouts.shutdownMs.
   * Idempotent: concurrent/repeated calls share one report. stop() in "stopped" resolves with the last
   * report (or clean). During startup rollback it waits for the rollback and returns its report.
   * stop() while starting normally (not rolling back) rejects; signal handlers treat that as unclean.
   */
  stop(): Promise<ShutdownReport> {
    if (this.#stopping) return this.#stopping;
    if (this.#state === "stopping" && this.#starting) {
      return this.#starting.then(() => CLEAN, () => this.#lastRollback ?? CLEAN);
    }
    if (this.#state === "stopped") return Promise.resolve(this.#lastRollback ?? CLEAN);
    try { this.#to("stopping"); } catch (e) { return Promise.reject(e); }
    this.#stopping = (async () => {
      const report = await this.#unwind(Date.now() + this.#ctx.config.timeouts.shutdownMs);
      this.#to("stopped");
      this.#ctx.logger.log(report.clean ? "info" : "error", "lifecycle stopped", { clean: report.clean, failures: report.failures });
      return report;
    })();
    return this.#stopping;
  }

  /**
   * Stops every started module in reverse order. Keeps going after individual failures and records each one.
   * Limit: modules without a stop() hook, or with external side effects, can't be undone. The registry only
   * guarantees that every stop() it can call is called.
   */
  async #unwind(deadline: number): Promise<ShutdownReport> {
    const failures: CleanupFailure[] = [];
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
    return Object.freeze({ clean: failures.length === 0, failures: Object.freeze(failures) });
  }

  liveness(): LivenessReport {
    return { live: this.#state !== "stopped", state: this.#state, checkedAt: new Date().toISOString() };
  }
  async readiness(): Promise<ReadinessReport> {
    const state = this.#state;
    const checks = new Map<string, HealthCheck>();
    if (state === "running") for (const m of this.#ordered) if (m.health) checks.set(m.id, m.health);
    const reports = await aggregateHealth(checks, this.#ctx.config.timeouts.defaultMs);
    return { ready: state === "running" && this.#state === "running" && isReady(reports), state: this.#state, checks: reports, checkedAt: new Date().toISOString() };
  }
}

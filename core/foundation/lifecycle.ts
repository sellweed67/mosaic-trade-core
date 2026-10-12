import { mosaicError, scrubSensitive, type LivenessReport, type MosaicError, type ReadinessReport, type Result } from "../../contracts/index.ts";
import { orderModules, type ModuleDescriptor, type ModuleContext, type ModuleRuntimeContext, type ModuleRunState, type DispatchOptions, type DispatchOutcome } from "./modules.ts";
import { redact } from "./logging.ts";
import { Dispatcher, type DispatchStats } from "../runtime/dispatcher.ts";
import { CapabilityTable, type CapabilityGrant } from "../runtime/capabilities.ts";
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

export interface LifecycleOptions {
  /** Capability grants from the composition root. Modules can't grant themselves anything. Default: none (deny all). */
  readonly grants?: readonly CapabilityGrant[];
}
export interface RuntimeDiagnostics {
  readonly state: LifecycleState;
  readonly history: readonly LifecycleState[];
  readonly modules: readonly { readonly id: string; readonly state: ModuleRunState }[];
  readonly dispatch: DispatchStats;
  readonly last_startup_failure?: unknown;
}
const MAX_HISTORY = 20;

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
  readonly #moduleStates = new Map<string, ModuleRunState>();
  readonly #dispatcher: Dispatcher;
  /** Cancellation for the current run. Aborted when shutdown or rollback begins. Owned by this instance. */
  #abort = new AbortController();

  constructor(modules: readonly ModuleDescriptor[], ctx: ModuleContext, opts: LifecycleOptions = {}) {
    this.#ordered = Object.freeze(orderModules(modules));
    this.#ctx = ctx;
    const byId = new Map(this.#ordered.map((m) => [m.id as string, m]));
    for (const m of this.#ordered) this.#moduleStates.set(m.id, "pending");
    const capabilities = new CapabilityTable(opts.grants ?? [], new Set(byId.keys()));
    this.#dispatcher = new Dispatcher({
      limits: ctx.config.dispatch, logger: ctx.logger, capabilities,
      accepting: () => (this.#state === "starting" || this.#state === "running") && !this.#abort.signal.aborted,
      runtimeSignal: () => this.#abort.signal,
      target: (id) => {
        const m = byId.get(id);
        return m ? { state: this.#moduleStates.get(id)!, handlers: m.handlers ?? {} } : undefined;
      },
    });
  }
  /** In-process dispatch of a complete envelope from the composition root. See core/runtime/dispatcher.ts. */
  dispatch(envelope: unknown, opts?: DispatchOptions): Promise<Result<DispatchOutcome>> { return this.#dispatcher.dispatch(envelope, opts); }
  moduleState(id: string): ModuleRunState | undefined { return this.#moduleStates.get(id); }
  /** Bounded, redacted runtime diagnostics. */
  diagnostics(): RuntimeDiagnostics {
    return redact({
      state: this.#state,
      history: this.#history.slice(-MAX_HISTORY),
      modules: this.#ordered.map((m) => ({ id: m.id, state: this.#moduleStates.get(m.id)! })),
      dispatch: this.#dispatcher.stats(),
      ...(this.#lastFailure ? { last_startup_failure: this.#lastFailure } : {}),
    }) as RuntimeDiagnostics;
  }
  /** Process-local idempotency state of a COMMAND (diagnostics). */
  commandState(destination: string, idempotencyKey: string) { return this.#dispatcher.idempotencyState(destination, idempotencyKey); }
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
  #moduleCtx(m: ModuleDescriptor): ModuleRuntimeContext {
    return {
      ...this.#ctx, logger: this.#ctx.logger.child({ module: m.id }), signal: this.#abort.signal,
      dispatch: (init, o) => this.#dispatcher.dispatchAs({ kind: "module", id: m.id }, init, o),
    };
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
    this.#abort = new AbortController();
    for (const m of this.#ordered) this.#moduleStates.set(m.id, "pending");
    const run = this.#runStart();
    this.#starting = run;
    run.then(() => { this.#starting = undefined; }, () => { this.#starting = undefined; });
    return run;
  }

  async #runStart(): Promise<void> {
    const { startupMs, shutdownMs } = this.#ctx.config.timeouts;
    try {
      for (const m of this.#ordered) {
        this.#moduleStates.set(m.id, "starting");
        try {
          if (m.init) await withDeadline(() => m.init!(this.#moduleCtx(m)), startupMs, "lifecycle.startup_timeout", `init of module ${m.id}`);
        } catch (e) { this.#moduleStates.set(m.id, "failed"); throw e; }
        this.#started.push(m);
        this.#moduleStates.set(m.id, "running");
      }
      this.#to("running");
      this.#ctx.logger.info("lifecycle running", { modules: this.#started.length });
    } catch (e) {
      const primary = toMosaicError(e);
      this.#ctx.logger.error("startup failed; rolling back", { error: primary });
      this.#to("stopping");
      this.#abort.abort(); // tells a late/hung init and any handlers to stop
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
    this.#abort.abort(); // stop accepting dispatches and cancel in-flight handlers
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
    if (!(await this.#dispatcher.drain(deadline))) failures.push({ module: "runtime.dispatch", code: "dispatch.drain_timeout", message: "In-flight handlers still running at shutdown deadline" });
    for (const m of [...this.#started].reverse()) {
      this.#moduleStates.set(m.id, "stopping");
      if (!m.stop) { this.#moduleStates.set(m.id, "stopped"); continue; }
      try {
        await withDeadline(() => m.stop!(), deadline - Date.now(), "lifecycle.shutdown_timeout", `stop of module ${m.id}`);
        this.#moduleStates.set(m.id, "stopped");
      } catch (e) {
        const err = toMosaicError(e);
        this.#moduleStates.set(m.id, "failed");
        failures.push({ module: m.id, code: err.code, message: scrubSensitive(err.message).slice(0, 500) });
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
    return { ready: state === "running" && this.#state === "running" && [...this.#moduleStates.values()].every((s) => s === "running") && isReady(reports), state: this.#state, checks: reports, checkedAt: new Date().toISOString() };
  }
}

/**
 * Minimal in-process message dispatcher. Owner: CORE RUNTIME ("internal-dispatch").
 *
 * Guarantees (all in-process, best effort, NOT durable):
 * - Every message is validated with the Phase 02 envelope validator before routing.
 * - It routes only to a registered module that is "running" and declares a handler for the message type.
 * - Deny by default: the source needs a composition-root capability grant for (destination, message_type).
 * - Bounded: at most `maxInFlight` concurrent handlers (no queue; excess is rejected), depth <= `maxDepth`,
 *   loop detection by message_id, and every handler is limited to `handlerTimeoutMs`.
 * - COMMANDs are deduplicated by idempotency key in a process-local ledger. A timed-out command becomes
 *   unknown_external_state and is never re-executed automatically.
 * - Errors returned to callers carry correlation_id, a scrubbed message, and no details or cause.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createEnvelope, validateEnvelope, mosaicError, ok, err, resolvePolicyContext, scrubSensitive,
  type EndpointRef, type ErrorCategory, type MessageEnvelope, type MosaicError, type Result,
} from "../../contracts/index.ts";
import { currentLogContext, withLogContext, type Logger } from "../foundation/logging.ts";
import { toMosaicError } from "../foundation/errors.ts";
import { withDeadline } from "../foundation/timeout.ts";
import type { DispatchInit, DispatchOptions, DispatchOutcome, HandlerContext, MessageHandler, ModuleRunState } from "../foundation/modules.ts";
import type { CapabilityTable } from "./capabilities.ts";
import { IdempotencyLedger } from "./idempotency-ledger.ts";

export interface DispatchLimits {
  readonly maxInFlight: number;
  readonly maxDepth: number;
  readonly handlerTimeoutMs: number;
  readonly maxIdempotencyEntries: number;
}
export interface DispatchTarget { readonly state: ModuleRunState; readonly handlers: Readonly<Partial<Record<string, MessageHandler>>>; }
export interface DispatcherDeps {
  readonly limits: DispatchLimits;
  readonly logger: Logger;
  readonly capabilities: CapabilityTable;
  /** True only while the runtime may accept work (starting/running and not cancelled). */
  readonly accepting: () => boolean;
  readonly runtimeSignal: () => AbortSignal;
  readonly target: (moduleId: string) => DispatchTarget | undefined;
}
export interface DispatchStats {
  readonly in_flight: number;
  readonly dispatched: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly duplicates: number;
  readonly rejected: Readonly<Record<string, number>>;
  readonly idempotency_entries: number;
}

interface Chain { readonly depth: number; readonly seen: ReadonlySet<string>; readonly parent: MessageEnvelope; }
const MAX_REJECT_CODES = 64;
const MAX_ERROR_MESSAGE = 500;

export class Dispatcher {
  readonly #d: DispatcherDeps;
  readonly #ledger: IdempotencyLedger;
  readonly #chain = new AsyncLocalStorage<Chain>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #dispatched = 0; #succeeded = 0; #failed = 0; #duplicates = 0;
  readonly #rejected = new Map<string, number>();

  constructor(deps: DispatcherDeps) { this.#d = deps; this.#ledger = new IdempotencyLedger(deps.limits.maxIdempotencyEntries); }

  stats(): DispatchStats {
    return {
      in_flight: this.#inFlight.size, dispatched: this.#dispatched, succeeded: this.#succeeded, failed: this.#failed,
      duplicates: this.#duplicates, rejected: Object.fromEntries(this.#rejected), idempotency_entries: this.#ledger.size,
    };
  }
  /** Process-local idempotency state for inspection (diagnostics/tests). */
  idempotencyState(destination: string, key: string) { return this.#ledger.state(destination, key); }

  /** Waits for in-flight handlers until the deadline. Returns false if some were still running. */
  async drain(deadline: number): Promise<boolean> {
    if (this.#inFlight.size === 0) return true;
    try { await withDeadline(() => Promise.allSettled([...this.#inFlight]), Math.max(0, deadline - Date.now()), "dispatch.drain_timeout", "dispatch drain"); return true; }
    catch { return false; }
  }

  /** Dispatch of a fully formed envelope supplied by the composition root (apps/). No values are generated. */
  dispatch(envelope: unknown, opts: DispatchOptions = {}): Promise<Result<DispatchOutcome>> {
    return this.#run(validateEnvelope(envelope), undefined, opts);
  }

  /** Dispatch on behalf of a module. Source is forced to that module; correlation/trace IDs are inherited. */
  dispatchAs(source: EndpointRef, init: DispatchInit, opts: DispatchOptions = {}): Promise<Result<DispatchOutcome>> {
    const parent = this.#chain.getStore()?.parent;
    const inherited = parent?.correlation_id ?? (currentLogContext().correlation_id as string | undefined);
    if (parent && init.correlation_id !== undefined && init.correlation_id !== parent.correlation_id) {
      return Promise.resolve(this.#reject("dispatch.correlation_mismatch", "validation", "Child message must keep the parent correlation_id", parent));
    }
    const built = createEnvelope({
      ...(parent?.task_id !== undefined ? { task_id: parent.task_id } : {}),
      ...(parent?.workflow_id !== undefined ? { workflow_id: parent.workflow_id } : {}),
      ...(parent?.execution_id !== undefined ? { execution_id: parent.execution_id } : {}),
      ...init,
      ...((init.correlation_id ?? inherited) !== undefined ? { correlation_id: (init.correlation_id ?? inherited) as never } : {}),
      source,
    } as never);
    return this.#run(built, source, opts);
  }

  async #run(envR: Result<MessageEnvelope>, enforcedSource: EndpointRef | undefined, opts: DispatchOptions): Promise<Result<DispatchOutcome>> {
    if (!envR.ok) return this.#rejectError(envR.error, undefined);
    const env = envR.value;
    const ctx = {
      correlation_id: env.correlation_id, message_id: env.message_id, message_type: env.message_type,
      ...(env.request_id !== undefined ? { request_id: env.request_id } : {}),
      ...(env.task_id !== undefined ? { task_id: env.task_id } : {}),
      ...(env.execution_id !== undefined ? { execution_id: env.execution_id } : {}),
    };
    return withLogContext(ctx, () => this.#route(env, enforcedSource, opts));
  }

  async #route(env: MessageEnvelope, enforcedSource: EndpointRef | undefined, opts: DispatchOptions): Promise<Result<DispatchOutcome>> {
    const chain = this.#chain.getStore();
    const depth = chain ? chain.depth + 1 : 0;
    if (enforcedSource && (env.source.kind !== enforcedSource.kind || env.source.id !== enforcedSource.id)) return this.#reject("dispatch.source_mismatch", "security", "Envelope source does not match the dispatching module", env);
    if (!this.#d.accepting()) return this.#reject("runtime.not_accepting", "unavailable", "Runtime is not accepting messages", env, false);
    if (depth > this.#d.limits.maxDepth) return this.#reject("dispatch.depth_exceeded", "validation", `Dispatch depth exceeds ${this.#d.limits.maxDepth}`, env);
    if (chain?.seen.has(env.message_id)) return this.#reject("dispatch.loop_detected", "validation", "Message already dispatched in this chain", env);
    const dest = env.destination;
    if (!dest) return this.#reject("dispatch.destination_required", "validation", "In-process dispatch requires a destination (broadcast unsupported)", env);
    if (dest.kind !== "module") return this.#reject("dispatch.unsupported_destination_kind", "not_found", "Only module destinations are routable in-process", env);
    const target = this.#d.target(dest.id);
    if (!target) return this.#reject("dispatch.unknown_destination", "not_found", "Destination module is not registered", env);
    if (target.state !== "running") return this.#reject("dispatch.destination_unavailable", "unavailable", `Destination module is ${target.state}`, env);
    const handler = target.handlers[env.message_type];
    if (typeof handler !== "function") return this.#reject("dispatch.unsupported_message_type", "not_found", "Destination has no handler for this message type", env);
    if (!this.#d.capabilities.allows(env.source, dest.id, env.message_type)) return this.#reject("dispatch.capability_denied", "policy_denied", "No capability grant for this source, destination and message type", env);
    if (opts.policy !== undefined && resolvePolicyContext(opts.policy).outcome !== "allow") return this.#reject("dispatch.policy_denied", "policy_denied", "Policy context did not resolve to allow", env);
    if (this.#inFlight.size >= this.#d.limits.maxInFlight) return this.#reject("dispatch.overloaded", "unavailable", "Too many in-flight dispatches", env);

    let ledgerKey: string | undefined;
    if (env.message_type === "COMMAND") {
      const b = this.#ledger.begin(dest.id, env);
      if (b.action === "duplicate") { this.#duplicates++; return ok({ kind: "duplicate", message_id: env.message_id }); }
      if (b.action === "reject") return this.#rejectError(b.error, env);
      ledgerKey = b.key;
    }
    return this.#execute(env, dest.id, handler, ledgerKey, chain);
  }

  async #execute(env: MessageEnvelope, destId: string, handler: MessageHandler, ledgerKey: string | undefined, chain: Chain | undefined): Promise<Result<DispatchOutcome>> {
    const ctrl = new AbortController();
    const runtimeSignal = this.#d.runtimeSignal();
    const onAbort = () => ctrl.abort();
    if (runtimeSignal.aborted) ctrl.abort(); else runtimeSignal.addEventListener("abort", onAbort, { once: true });
    const self: EndpointRef = { kind: "module", id: destId };
    const hctx: HandlerContext = {
      envelope: env, signal: ctrl.signal, logger: this.#d.logger.child({ module: destId }),
      dispatch: (init, o) => this.dispatchAs(self, init, o),
    };
    const nextChain: Chain = { depth: chain ? chain.depth + 1 : 0, seen: new Set([...(chain?.seen ?? []), env.message_id]), parent: env };
    this.#dispatched++;
    const p = this.#chain.run(nextChain, () => withDeadline(() => handler(hctx), this.#d.limits.handlerTimeoutMs, "dispatch.handler_timeout", `handler ${destId}/${env.message_type}`));
    this.#inFlight.add(p);
    try {
      const value = await p;
      if (ledgerKey) this.#ledger.complete(ledgerKey, "succeeded");
      if (env.message_type === "REQUEST") {
        const r = createEnvelope({
          message_type: "RESPONSE", source: self, destination: env.source, request_id: env.request_id!, correlation_id: env.correlation_id,
          ...(env.task_id !== undefined ? { task_id: env.task_id } : {}),
          ...(env.workflow_id !== undefined ? { workflow_id: env.workflow_id } : {}),
          ...(env.execution_id !== undefined ? { execution_id: env.execution_id } : {}),
          payload: value === undefined ? null : value,
        });
        if (!r.ok) { this.#failed++; return this.#reject("dispatch.invalid_response", "contract_violation", "Handler returned a payload that is not a valid RESPONSE", env); }
        this.#succeeded++;
        return ok({ kind: "response", envelope: r.value });
      }
      this.#succeeded++;
      return ok({ kind: "ack", message_id: env.message_id });
    } catch (e) {
      ctrl.abort();
      const me = toMosaicError(e);
      const timedOut = me.code === "dispatch.handler_timeout";
      let out: MosaicError;
      if (ledgerKey && (timedOut || me.requires_reconciliation)) {
        this.#ledger.complete(ledgerKey, "unknown_external_state");
        out = mosaicError("dispatch.outcome_unknown", "unknown_external_state", timedOut ? "Command handler timed out; outcome unknown, reconcile before retry" : this.#scrub(me.message), { correlation_id: env.correlation_id });
      } else {
        if (ledgerKey) this.#ledger.complete(ledgerKey, me.is_retryable ? "failed_retryable" : "failed_final");
        out = this.#sanitize(me, env);
      }
      this.#failed++;
      this.#d.logger.warn("dispatch handler failed", { code: out.code, category: out.category, destination: destId });
      return err(out);
    } finally {
      this.#inFlight.delete(p);
      runtimeSignal.removeEventListener("abort", onAbort);
    }
  }

  #scrub(m: string): string { return scrubSensitive(m).slice(0, MAX_ERROR_MESSAGE); }
  #sanitize(e: MosaicError, env: MessageEnvelope | undefined): MosaicError {
    return mosaicError(e.code, e.category, this.#scrub(e.message), {
      retryable: e.is_retryable, requires_reconciliation: e.requires_reconciliation,
      ...(env ? { correlation_id: env.correlation_id } : {}),
      ...(e.category === "contract_violation" && e.details ? { details: e.details } : {}), // validation issues hold paths/rules only, never values
    });
  }
  #count(code: string): void {
    if (this.#rejected.has(code) || this.#rejected.size < MAX_REJECT_CODES) this.#rejected.set(code, (this.#rejected.get(code) ?? 0) + 1);
  }
  #rejectError(e: MosaicError, env: MessageEnvelope | undefined): Result<never> {
    this.#count(e.code);
    this.#d.logger.warn("dispatch rejected", { code: e.code, category: e.category });
    return err(this.#sanitize(e, env));
  }
  #reject(code: string, category: ErrorCategory, message: string, env: MessageEnvelope | undefined, retryable?: boolean): Result<never> {
    return this.#rejectError(mosaicError(code, category, message, retryable === undefined ? {} : { retryable }), env);
  }
}

import type { HealthCheck } from "./health.ts";
import type { Logger } from "./logging.ts";
import type { MosaicConfig } from "./config.ts";
import type { SecretProvider } from "./secrets.ts";
import { SystemError } from "./errors.ts";
import { MESSAGE_TYPES, type CorrelationId, type EnvelopeInit, type MessageEnvelope, type MessageType, type Result } from "../../contracts/index.ts";

/** Module registry boundary. Owner: FOUNDATION. */
export const MODULE_IDS = [
  "foundation", "core-runtime", "intelligence", "resource", "data", "policy-security",
  "validation", "resource-optimization", "reliability", "observability", "control", "universal-integration",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** Per-module runtime state. Distinct from the five-state runtime lifecycle; "failed" here is a module diagnostic. */
export type ModuleRunState = "pending" | "starting" | "running" | "stopping" | "stopped" | "failed";

/** Dependencies passed explicitly (dependency initialization boundary). No global container. */
export interface ModuleContext {
  readonly config: MosaicConfig;
  readonly logger: Logger;
  readonly secrets: SecretProvider;
}

// ---------- in-process dispatch types (Phase 03) ----------
/** Envelope init for dispatch: the runtime sets `source` (no spoofing), and correlation is inherited when omitted. */
export type DispatchInit = Omit<EnvelopeInit, "source" | "correlation_id"> & { readonly correlation_id?: CorrelationId };
export interface DispatchOptions {
  /** Optional Phase 02 policy_context. Anything other than an "allow" outcome rejects the dispatch. */
  readonly policy?: unknown;
}
export type DispatchOutcome =
  | { readonly kind: "ack"; readonly message_id: string }
  | { readonly kind: "response"; readonly envelope: MessageEnvelope }
  | { readonly kind: "duplicate"; readonly message_id: string };
export type Dispatch = (init: DispatchInit, opts?: DispatchOptions) => Promise<Result<DispatchOutcome>>;
export interface HandlerContext {
  readonly envelope: MessageEnvelope;
  /** Aborted on handler timeout or runtime shutdown. Handlers must stop side effects once it is aborted. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** Dispatch on behalf of the handling module (counts toward depth/loop limits). */
  readonly dispatch: Dispatch;
}
/** Return value becomes the RESPONSE payload for REQUEST messages; it's ignored for other types. */
export type MessageHandler = (ctx: HandlerContext) => unknown;

/** Context given to a module's init(): the base context plus a lifecycle signal and a source-bound dispatch. */
export interface ModuleRuntimeContext extends ModuleContext {
  readonly signal: AbortSignal;
  readonly dispatch: Dispatch;
}

export interface ModuleDescriptor {
  readonly id: ModuleId;
  readonly owns: readonly string[];
  /** Other modules this one depends on (communicating through contracts only). All dependencies are required. */
  readonly dependsOn: readonly ModuleId[];
  readonly status: "reserved" | "implemented";
  init?(ctx: ModuleRuntimeContext): Promise<void> | void;
  stop?(): Promise<void> | void;
  health?: HealthCheck;
  /** Message types this module accepts. Accepting a type does not grant anyone the right to send it. */
  readonly handlers?: Readonly<Partial<Record<MessageType, MessageHandler>>>;
}

const CAPABILITY_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const cfg = (code: string, msg: string) => new SystemError(code, "configuration", msg);

/**
 * Validates ids, ownership, dependencies and handlers; returns a deterministic topological order
 * (dependencies first, ties keep registration order). Shutdown uses the reverse.
 * Called by the Lifecycle constructor, so invalid registrations fail before any module starts.
 */
export function orderModules(mods: readonly ModuleDescriptor[]): ModuleDescriptor[] {
  const byId = new Map<ModuleId, ModuleDescriptor>();
  const owner = new Map<string, ModuleId>();
  for (const m of mods) {
    if (!(MODULE_IDS as readonly string[]).includes(m.id)) throw cfg("registry.unknown_module", `Unknown module id: ${m.id}`);
    if (byId.has(m.id)) throw cfg("registry.duplicate_module", `Duplicate module id: ${m.id}`);
    byId.set(m.id, m);
    if (!Array.isArray(m.owns) || !Array.isArray(m.dependsOn)) throw cfg("registry.invalid_descriptor", `Module ${m.id}: owns and dependsOn must be arrays`);
    for (const cap of m.owns) {
      if (typeof cap !== "string" || !CAPABILITY_NAME.test(cap)) throw cfg("registry.invalid_capability", `Module ${m.id}: invalid owned capability name`);
      const prev = owner.get(cap);
      if (prev) throw cfg("registry.duplicate_authority", `Duplicate authority: "${cap}" owned by ${prev} and ${m.id}`);
      owner.set(cap, m.id);
    }
    if (new Set(m.dependsOn).size !== m.dependsOn.length) throw cfg("registry.duplicate_dependency", `Module ${m.id}: duplicate dependency`);
    for (const [type, h] of Object.entries(m.handlers ?? {})) {
      if (!(MESSAGE_TYPES as readonly string[]).includes(type) || typeof h !== "function") throw cfg("registry.invalid_handler", `Module ${m.id}: invalid handler for "${type}"`);
    }
  }
  const out: ModuleDescriptor[] = [];
  const state = new Map<ModuleId, "visiting" | "done">();
  const visit = (id: ModuleId, path: readonly ModuleId[]) => {
    const m = byId.get(id);
    if (!m) throw cfg("registry.missing_dependency", `Missing module dependency: ${path.join(" -> ")} -> ${id}`);
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") throw cfg("registry.cycle", `Module dependency cycle: ${[...path, id].join(" -> ")}`);
    state.set(id, "visiting");
    for (const d of m.dependsOn) visit(d, [...path, id]);
    state.set(id, "done");
    out.push(m);
  };
  for (const m of mods) visit(m.id, []);
  return out;
}

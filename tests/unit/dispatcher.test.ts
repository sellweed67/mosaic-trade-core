import { test } from "node:test";
import assert from "node:assert/strict";
import { Lifecycle, withLogContext, type ModuleDescriptor, type CapabilityGrant, type HandlerContext, type ModuleId } from "../../core/index.ts";
import { testCtx, testConfig } from "../helpers.ts";

const T0 = "2026-10-12T00:00:00.000Z";
const app = { kind: "service", id: "app" } as const;
const mod = (id: ModuleId, handlers: ModuleDescriptor["handlers"] = {}, extra: Partial<ModuleDescriptor> = {}): ModuleDescriptor => ({ id, owns: [], dependsOn: [], status: "implemented", handlers, ...extra });
const grant = (dest: string, types: CapabilityGrant["message_types"], source: CapabilityGrant["source"] = app): CapabilityGrant => ({ source, destination: dest, message_types: types });
const env = (type: string, extra: object = {}) => ({ message_id: `m-${Math.random().toString(36).slice(2)}`, correlation_id: "corr-1", source: app, destination: { kind: "module", id: "data" }, message_type: type, contract_version: { major: 1, minor: 0 }, created_at: T0, payload: { q: 1 }, metadata: {}, ...extra });
async function rt(mods: ModuleDescriptor[], grants: CapabilityGrant[], config = testConfig()) {
  const ctx = testCtx(config); const lc = new Lifecycle(mods, ctx, { grants }); await lc.start(); return { lc, ctx };
}
const code = (r: any) => (r.ok ? "ok" : r.error.code);

test("REQUEST -> RESPONSE preserves request/correlation/task/execution ids", async () => {
  const { lc } = await rt([mod("data", { REQUEST: ({ envelope }) => ({ echo: envelope.payload }) })], [grant("data", ["REQUEST"])]);
  const r = await lc.dispatch(env("REQUEST", { request_id: "r-1", task_id: "t-1", execution_id: "e-1" }));
  assert.ok(r.ok && r.value.kind === "response");
  const e = (r.value as any).envelope;
  assert.deepEqual([e.message_type, e.request_id, e.correlation_id, e.task_id, e.execution_id, e.source.id, e.destination.id], ["RESPONSE", "r-1", "corr-1", "t-1", "e-1", "data", "app"]);
  assert.deepEqual(e.payload, { echo: { q: 1 } });
  await lc.stop();
});
test("invalid envelope, missing destination, unknown module, unsupported type, unsupported kind", async () => {
  const { lc } = await rt([mod("data", { EVENT: () => {} })], [grant("data", ["EVENT", "REQUEST"])]);
  assert.equal(code(await lc.dispatch({ nope: 1 })), "contract.invalid_envelope");
  assert.equal(code(await lc.dispatch(env("EVENT", { destination: undefined }))), "dispatch.destination_required");
  assert.equal(code(await lc.dispatch(env("EVENT", { destination: { kind: "module", id: "control" } }))), "dispatch.unknown_destination");
  assert.equal(code(await lc.dispatch(env("REQUEST", { request_id: "r" }))), "dispatch.unsupported_message_type");
  assert.equal(code(await lc.dispatch(env("EVENT", { destination: { kind: "external", id: "x" } }))), "dispatch.unsupported_destination_kind");
  const r: any = await lc.dispatch(env("EVENT", { destination: { kind: "module", id: "control" } }));
  assert.equal(r.error.correlation_id, "corr-1");
  await lc.stop();
});
test("capabilities: deny by default, exact grant required, self-declared handlers grant nothing", async () => {
  const { lc } = await rt([mod("data", { EVENT: () => {}, COMMAND: () => {} })], [grant("data", ["EVENT"])]);
  assert.equal(code(await lc.dispatch(env("EVENT"))), "ok");
  assert.equal(code(await lc.dispatch(env("COMMAND", { idempotency_key: "k" }))), "dispatch.capability_denied");
  assert.equal(code(await lc.dispatch(env("EVENT", { source: { kind: "service", id: "other" } }))), "dispatch.capability_denied");
  await lc.stop();
  const { lc: none } = await rt([mod("data", { EVENT: () => {} })], []);
  const r: any = await none.dispatch(env("EVENT"));
  assert.equal(r.error.category, "policy_denied"); await none.stop();
});
test("invalid grants are rejected before any module starts", () => {
  let started = false;
  const m = mod("data", {}, { init: () => { started = true; } });
  assert.throws(() => new Lifecycle([m], testCtx(), { grants: [grant("control", ["EVENT"])] }), /unknown destination/);
  assert.throws(() => new Lifecycle([m], testCtx(), { grants: [grant("data", [])] }), /non-empty/);
  assert.throws(() => new Lifecycle([m], testCtx(), { grants: [grant("data", ["PING" as any])] }), /unknown message type/);
  assert.throws(() => new Lifecycle([m], testCtx(), { grants: [grant("data", ["EVENT"]), grant("data", ["COMMAND"])] }), /duplicate/);
  assert.equal(started, false);
});
test("policy context must resolve to allow", async () => {
  const { lc } = await rt([mod("data", { EVENT: () => {} })], [grant("data", ["EVENT"])]);
  assert.equal(code(await lc.dispatch(env("EVENT"), { policy: { constraints: [{ level: "safety", policy_id: "s", effect: "deny" }, { level: "optimization", policy_id: "o", effect: "allow" }] } })), "dispatch.policy_denied");
  assert.equal(code(await lc.dispatch(env("EVENT"), { policy: { constraints: [] } })), "dispatch.policy_denied");
  assert.equal(code(await lc.dispatch(env("EVENT"), { policy: { constraints: [{ level: "security", policy_id: "s", effect: "allow" }] } })), "ok");
  await lc.stop();
});
test("handler errors are contained, scrubbed, correlated; runtime keeps running", async () => {
  const { lc, ctx } = await rt([mod("data", { EVENT: () => { throw new Error("db failed password=hunter2 token=abc"); } })], [grant("data", ["EVENT"])]);
  const r: any = await lc.dispatch(env("EVENT"));
  assert.equal(r.error.code, "internal.unhandled"); assert.equal(r.error.correlation_id, "corr-1");
  assert.ok(!JSON.stringify(r).includes("hunter2") && !JSON.stringify(r).includes("abc"));
  assert.equal(r.error.details, undefined);
  assert.equal(lc.state, "running"); assert.equal(lc.moduleState("data"), "running");
  assert.ok(!JSON.stringify(ctx.lines()).includes("hunter2"));
  assert.equal(lc.diagnostics().dispatch.failed, 1);
  await lc.stop();
});
test("module dispatch: source forced, correlation inherited, depth and loops bounded", async () => {
  let depthSeen = 0; let childCorr = "";
  const { lc } = await rt([
    mod("data", { EVENT: async (h: HandlerContext) => { depthSeen++; const r = await h.dispatch({ message_type: "EVENT", destination: { kind: "module", id: "control" }, payload: null }); return r; } }),
    mod("control", { EVENT: async (h: HandlerContext) => { childCorr = h.envelope.correlation_id; depthSeen++; await h.dispatch({ message_type: "EVENT", destination: { kind: "module", id: "data" }, payload: null }); } }),
  ], [grant("data", ["EVENT"]), grant("control", ["EVENT"], { kind: "module", id: "data" }), grant("data", ["EVENT"], { kind: "module", id: "control" })]);
  const r = await lc.dispatch(env("EVENT"));
  assert.ok(r.ok);
  assert.equal(childCorr, "corr-1");
  assert.equal(depthSeen, 4); // maxDepth=3 in test config: depths 0..3 run, the 5th is rejected
  assert.equal(lc.diagnostics().dispatch.rejected["dispatch.depth_exceeded"], 1);
  await lc.stop();
});
test("module cannot spoof source or change correlation in a child message", async () => {
  let res: any; let mismatch: any;
  const { lc } = await rt([
    mod("data", { EVENT: async (h: HandlerContext) => {
      res = await h.dispatch({ message_type: "EVENT", destination: { kind: "module", id: "control" }, payload: null, source: { kind: "service", id: "app" } } as any);
      mismatch = await h.dispatch({ message_type: "EVENT", destination: { kind: "module", id: "control" }, payload: null, correlation_id: "other" as any });
    } }),
    mod("control", { EVENT: () => {} }),
  ], [grant("data", ["EVENT"]), grant("control", ["EVENT"])]);
  await lc.dispatch(env("EVENT"));
  assert.equal(res.error.code, "dispatch.capability_denied"); // source was forced back to module:data, which has no grant
  assert.equal(mismatch.error.code, "dispatch.correlation_mismatch");
  await lc.stop();
});
test("module init dispatch inherits correlation from the log context", async () => {
  let seen = "";
  const ctx = testCtx();
  const lc = new Lifecycle([mod("data", { EVENT: (h: HandlerContext) => { seen = h.envelope.correlation_id; } }), mod("control", {}, { dependsOn: ["data"], init: async (c) => { await withLogContext({ correlation_id: "boot-1" as any }, () => c.dispatch({ message_type: "EVENT", destination: { kind: "module", id: "data" }, payload: null })); } })], ctx, { grants: [grant("data", ["EVENT"], { kind: "module", id: "control" })] });
  await lc.start(); assert.equal(seen, "boot-1"); await lc.stop();
});
test("bounded in-flight work: excess is rejected, not queued", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const { lc } = await rt([mod("data", { EVENT: () => gate })], [grant("data", ["EVENT"])]);
  const pending = [1, 2, 3, 4].map(() => lc.dispatch(env("EVENT")));
  assert.equal(code(await lc.dispatch(env("EVENT"))), "dispatch.overloaded");
  assert.equal(lc.diagnostics().dispatch.in_flight, 4);
  release(); assert.ok((await Promise.all(pending)).every((r) => r.ok));
  await lc.stop();
});
test("runaway handler times out and its signal is aborted", async () => {
  let aborted = false;
  const { lc } = await rt([mod("data", { EVENT: (h: HandlerContext) => new Promise(() => { h.signal.addEventListener("abort", () => { aborted = true; }); }) })], [grant("data", ["EVENT"])], testConfig({ dispatch: { maxInFlight: 4, maxDepth: 3, handlerTimeoutMs: 20, maxIdempotencyEntries: 3 } }));
  const r: any = await lc.dispatch(env("EVENT"));
  assert.equal(r.error.code, "dispatch.handler_timeout"); assert.ok(aborted);
  assert.equal(lc.diagnostics().dispatch.in_flight, 0);
  await lc.stop();
});
test("COMMAND idempotency: duplicate not re-executed; key reuse rejected; unknown outcome blocks retry", async () => {
  let runs = 0; let mode: "ok" | "hang" | "retryable" = "ok";
  const { lc } = await rt([mod("data", { COMMAND: () => { runs++; if (mode === "hang") return new Promise(() => {}); if (mode === "retryable") throw Object.assign(new Error("busy"), {}); } })], [grant("data", ["COMMAND"])], testConfig({ dispatch: { maxInFlight: 4, maxDepth: 3, handlerTimeoutMs: 20, maxIdempotencyEntries: 3 } }));
  const c = (key: string, payload: unknown = { a: 1 }) => env("COMMAND", { idempotency_key: key, payload });
  assert.equal(code(await lc.dispatch(c("k1"))), "ok");
  const dup: any = await lc.dispatch(c("k1")); assert.equal(dup.value.kind, "duplicate"); assert.equal(runs, 1);
  assert.equal(code(await lc.dispatch(c("k1", { a: 2 }))), "dispatch.idempotency_conflict");
  mode = "hang";
  const lost: any = await lc.dispatch(c("k2"));
  assert.equal(lost.error.category, "unknown_external_state"); assert.equal(lost.error.requires_reconciliation, true); assert.equal(lost.error.is_retryable, false);
  assert.equal(lc.commandState("data", "k2"), "unknown_external_state");
  mode = "ok";
  assert.equal(code(await lc.dispatch(c("k2"))), "dispatch.reconciliation_required"); assert.equal(runs, 2);
  mode = "retryable";
  assert.equal(code(await lc.dispatch(c("k3"))), "internal.unhandled");
  assert.equal(lc.commandState("data", "k3"), "failed_final");
  assert.equal(code(await lc.dispatch(c("k3"))), "dispatch.idempotency_failed_final");
  await lc.stop();
});
test("idempotency ledger is bounded and never evicts unresolved operations", async () => {
  const { lc } = await rt([mod("data", { COMMAND: () => new Promise(() => {}) })], [grant("data", ["COMMAND"])], testConfig({ dispatch: { maxInFlight: 8, maxDepth: 3, handlerTimeoutMs: 10, maxIdempotencyEntries: 2 } }));
  for (const k of ["a", "b"]) await lc.dispatch(env("COMMAND", { idempotency_key: k }));
  assert.equal(code(await lc.dispatch(env("COMMAND", { idempotency_key: "c" }))), "dispatch.idempotency_capacity");
  assert.equal(lc.diagnostics().dispatch.idempotency_entries, 2);
  await lc.stop();
});
test("dispatch rejected when runtime is not running or destination module isn't running", async () => {
  const ctx = testCtx();
  const lc = new Lifecycle([mod("data", { EVENT: () => {} }), mod("control", {}, { dependsOn: ["data"], init: () => { throw new Error("boom"); } })], ctx, { grants: [grant("data", ["EVENT"]), grant("control", ["EVENT"])] });
  assert.equal(code(await lc.dispatch(env("EVENT"))), "runtime.not_accepting");
  await assert.rejects(lc.start());
  assert.equal(code(await lc.dispatch(env("EVENT"))), "runtime.not_accepting");
  const ok2 = new Lifecycle([mod("data", { EVENT: () => {} }), mod("control", { EVENT: () => {} }, { dependsOn: ["data"], init: async (c) => {
    const r: any = await c.dispatch({ message_type: "EVENT", destination: { kind: "module", id: "control" }, payload: null, correlation_id: "x" as any });
    assert.equal(r.error.code, "dispatch.destination_unavailable"); // control itself is still starting
  } })], testCtx(), { grants: [grant("control", ["EVENT"], { kind: "module", id: "control" })] });
  await ok2.start(); await ok2.stop();
  assert.equal(code(await ok2.dispatch(env("EVENT"))), "runtime.not_accepting");
});
test("shutdown cancels in-flight handlers and waits for them within the deadline", async () => {
  let cancelled = false; let entered!: () => void; const inside = new Promise<void>((r) => { entered = r; });
  const { lc } = await rt([mod("data", { EVENT: (h: HandlerContext) => new Promise<void>((res) => { entered(); h.signal.addEventListener("abort", () => { cancelled = true; res(); }); }) })], [grant("data", ["EVENT"])], testConfig({ dispatch: { maxInFlight: 4, maxDepth: 3, handlerTimeoutMs: 5000, maxIdempotencyEntries: 3 } }));
  const p = lc.dispatch(env("EVENT")); await inside;
  const report = await lc.stop();
  assert.ok(cancelled); assert.ok(report.clean); assert.ok((await p).ok);
  assert.equal(lc.diagnostics().dispatch.in_flight, 0);
});

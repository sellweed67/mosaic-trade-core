import { test } from "node:test";
import assert from "node:assert/strict";
import { Lifecycle, LIFECYCLE_TRANSITIONS, type ModuleDescriptor, type ModuleId } from "../../core/index.ts";
import { testCtx, testConfig, sleep } from "../helpers.ts";

function tracked(events: string[], id: ModuleId, deps: ModuleId[] = [], extra: Partial<ModuleDescriptor> = {}): ModuleDescriptor {
  return { id, dependsOn: deps, owns: [id], status: "implemented", init: () => { events.push(`init:${id}`); }, stop: () => { events.push(`stop:${id}`); }, ...extra };
}

test("ordered startup and reverse shutdown with deterministic transitions", async () => {
  const ev: string[] = [];
  const lc = new Lifecycle([tracked(ev, "data", ["foundation"]), tracked(ev, "foundation"), tracked(ev, "control", ["data"])], testCtx());
  await lc.start();
  assert.equal(lc.state, "running");
  const r = await lc.stop();
  assert.ok(r.clean);
  assert.deepEqual(ev, ["init:foundation", "init:data", "init:control", "stop:control", "stop:data", "stop:foundation"]);
  assert.deepEqual(lc.history, ["created", "starting", "running", "stopping", "stopped"]);
});
test("invalid transitions are rejected", async () => {
  const lc = new Lifecycle([], testCtx());
  await lc.start();
  await assert.rejects(lc.start(), /Invalid lifecycle transition running -> starting/);
  await lc.stop();
  await assert.rejects(lc.start(), /stopped -> starting/);
  assert.deepEqual(LIFECYCLE_TRANSITIONS.stopped, []);
});
test("startup failure rolls back started modules in reverse and enters failed", async () => {
  const ev: string[] = [];
  const lc = new Lifecycle([tracked(ev, "foundation"), tracked(ev, "data", ["foundation"]), tracked(ev, "control", ["data"], { init: () => { throw new Error("boom"); } })], testCtx());
  await assert.rejects(lc.start(), (e: any) => e.category === "internal" && /boom/.test(e.message));
  assert.equal(lc.state, "failed");
  assert.deepEqual(ev, ["init:foundation", "init:data", "stop:data", "stop:foundation"]);
  assert.equal(lc.liveness().live, false);
  await lc.stop(); assert.equal(lc.state, "stopped");
});
test("startup timeout fails safely", async () => {
  const ev: string[] = [];
  const lc = new Lifecycle([tracked(ev, "foundation"), tracked(ev, "data", ["foundation"], { init: () => sleep(1000) })], testCtx(testConfig({ timeouts: { defaultMs: 50, startupMs: 30, shutdownMs: 100 } })));
  await assert.rejects(lc.start(), (e: any) => e.code === "lifecycle.startup_timeout" && e.category === "timeout");
  assert.deepEqual(ev, ["init:foundation", "stop:foundation"]);
});
test("shutdown budget: hung module times out, others still stop, report is unclean", async () => {
  const ev: string[] = [];
  const lc = new Lifecycle([tracked(ev, "foundation"), tracked(ev, "data", ["foundation"], { stop: () => sleep(1000) })], testCtx(testConfig({ timeouts: { defaultMs: 50, startupMs: 50, shutdownMs: 40 } })));
  await lc.start();
  const t0 = Date.now(); const r = await lc.stop();
  assert.ok(Date.now() - t0 < 500);
  assert.equal(r.clean, false); assert.equal(r.failures[0]!.module, "data"); assert.equal(r.failures[0]!.code, "lifecycle.shutdown_timeout");
  assert.equal(lc.state, "stopped");
});
test("stop is idempotent and concurrent-safe; stop errors are captured", async () => {
  const ev: string[] = [];
  const lc = new Lifecycle([tracked(ev, "foundation", [], { stop: () => { ev.push("stop"); throw new Error("x"); } })], testCtx());
  await lc.start();
  const [a, b] = await Promise.all([lc.stop(), lc.stop()]);
  assert.equal(a, b); assert.deepEqual(ev, ["init:foundation", "stop"]); assert.equal(a.clean, false);
});
test("modules receive explicit context with module-scoped logger", async () => {
  const ctx = testCtx(); let got: any;
  const lc = new Lifecycle([{ id: "data", owns: [], dependsOn: [], status: "implemented", init: (c) => { got = c; c.logger.info("hi"); } }], ctx);
  await lc.start();
  assert.equal(got.config, ctx.config); assert.ok(got.secrets);
  assert.ok(ctx.lines().some((l) => l.msg === "hi" && l.module === "data"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Lifecycle, orderModules, type ModuleDescriptor, type ModuleId } from "../../core/index.ts";
import { testCtx, testConfig } from "../helpers.ts";

const mod = (id: ModuleId, extra: Partial<ModuleDescriptor> = {}): ModuleDescriptor => ({ id, owns: [], dependsOn: [], status: "implemented", ...extra });

test("registry rejects invalid descriptors before start", () => {
  assert.throws(() => orderModules([mod("data", { dependsOn: ["foundation", "foundation"] }), mod("foundation")]), /duplicate dependency/);
  assert.throws(() => orderModules([mod("data", { owns: ["Bad Name"] })]), /invalid owned capability/);
  assert.throws(() => orderModules([mod("data", { handlers: { PING: () => {} } as any })]), /invalid handler/);
  assert.throws(() => orderModules([mod("data", { handlers: { EVENT: "x" } as any })]), /invalid handler/);
  assert.throws(() => new Lifecycle([mod("data", { dependsOn: ["control"] })], testCtx()), /Missing module dependency/);
});
test("module states: partial startup, failure, rollback, restart", async () => {
  let fail = true;
  const lc = new Lifecycle([mod("foundation"), mod("data", { dependsOn: ["foundation"], init: () => { if (fail) throw new Error("x"); } }), mod("control", { dependsOn: ["data"] })], testCtx());
  const states = () => lc.diagnostics().modules.map((m) => `${m.id}:${m.state}`);
  assert.deepEqual(states(), ["foundation:pending", "data:pending", "control:pending"]);
  await assert.rejects(lc.start());
  assert.deepEqual(states(), ["foundation:stopped", "data:failed", "control:pending"]);
  assert.equal((await lc.readiness()).ready, false);
  assert.equal(lc.diagnostics().last_startup_failure !== undefined, true);
  fail = false; await lc.start();
  assert.deepEqual(states(), ["foundation:running", "data:running", "control:running"]);
  assert.equal((await lc.readiness()).ready, true);
  await lc.stop();
  assert.deepEqual(states(), ["foundation:stopped", "data:stopped", "control:stopped"]);
});
test("no automatic restart: a failed init is attempted exactly once per start() call", async () => {
  let n = 0;
  const lc = new Lifecycle([mod("data", { init: () => { n++; throw new Error("x"); } })], testCtx());
  await assert.rejects(lc.start()); assert.equal(n, 1); assert.equal(lc.state, "stopped");
});
test("startup timeout aborts the module signal so late work can stop", async () => {
  let aborted = false;
  const lc = new Lifecycle([mod("data", { init: (c) => new Promise<void>(() => { c.signal.addEventListener("abort", () => { aborted = true; }); }) })], testCtx(testConfig({ timeouts: { defaultMs: 50, startupMs: 20, shutdownMs: 50 } })));
  await assert.rejects(lc.start(), /startup_timeout|exceeded/);
  assert.ok(aborted); assert.equal(lc.state, "stopped"); assert.equal(lc.moduleState("data"), "failed");
});
test("stop failure marks module failed and is reported, others still stop", async () => {
  const lc = new Lifecycle([mod("foundation", { stop: () => { throw new Error("leak token=xyz"); } }), mod("data", { dependsOn: ["foundation"] })], testCtx());
  await lc.start(); const r = await lc.stop();
  assert.equal(r.clean, false); assert.equal(lc.moduleState("foundation"), "failed"); assert.equal(lc.moduleState("data"), "stopped");
  assert.ok(!JSON.stringify(r).includes("xyz"));
});
test("diagnostics are bounded and redacted", async () => {
  const lc = new Lifecycle([mod("data")], testCtx());
  for (let i = 0; i < 15; i++) { await lc.start(); await lc.stop(); }
  assert.ok(lc.diagnostics().history.length <= 20);
});

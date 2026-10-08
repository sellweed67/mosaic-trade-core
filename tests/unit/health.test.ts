import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateHealth, isReady, Lifecycle, type ModuleDescriptor } from "../../core/index.ts";
import { testCtx, sleep } from "../helpers.ts";

const now = () => new Date().toISOString();
test("aggregation: timeout -> unknown, throw -> unhealthy, invalid -> unknown", async () => {
  const r = await aggregateHealth(new Map<string, any>([
    ["ok", () => ({ component: "x", status: "healthy", checkedAt: now() })],
    ["slow", async () => { await sleep(500); return { component: "slow", status: "healthy", checkedAt: now() }; }],
    ["bad", () => { throw new Error("down"); }],
    ["weird", () => ({ status: "great" })],
  ]), 30);
  assert.deepEqual(r.map((x) => [x.component, x.status]), [["ok", "healthy"], ["slow", "unknown"], ["bad", "unhealthy"], ["weird", "unknown"]]);
});
test("readiness rule fails closed", () => {
  assert.equal(isReady([]), true);
  assert.equal(isReady([{ component: "a", status: "degraded", checkedAt: now() }]), true);
  assert.equal(isReady([{ component: "a", status: "unknown", checkedAt: now() }]), false);
});
test("liveness and readiness follow lifecycle and module checks", async () => {
  let status: "healthy" | "unhealthy" = "healthy";
  const mod: ModuleDescriptor = { id: "data", owns: [], dependsOn: [], status: "implemented", health: () => ({ component: "data", status, checkedAt: now() }) };
  const lc = new Lifecycle([mod], testCtx());
  assert.equal((await lc.readiness()).ready, false);
  assert.equal(lc.liveness().live, true);
  await lc.start();
  assert.equal((await lc.readiness()).ready, true);
  status = "unhealthy";
  const r = await lc.readiness();
  assert.equal(r.ready, false); assert.equal(r.checks[0]!.status, "unhealthy");
  await lc.stop();
  assert.equal(lc.liveness().live, false); assert.equal((await lc.readiness()).ready, false);
});

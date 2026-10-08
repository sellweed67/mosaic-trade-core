import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../../core/index.ts";
import { coreModules } from "../../modules/index.ts";

const configDir = fileURLToPath(new URL("../../config/", import.meta.url));
const silent = { log() {}, child() { return silent; } };

test("bootstrap -> start -> health -> stop", async () => {
  const lc = await bootstrap({ env: { MOSAIC_ENV: "test" }, configDir, modules: coreModules, logger: silent });
  await lc.start(); assert.equal(lc.state, "running");
  assert.ok(Array.isArray(await lc.health()));
  await lc.stop(); assert.equal(lc.state, "stopped");
});
test("failed module init unwinds and fails safely", async () => {
  const stopped: string[] = [];
  const mods = [
    { id: "foundation", owns: ["a"], dependsOn: [], status: "reserved", init: async () => {}, stop: async () => { stopped.push("foundation"); } },
    { id: "data", owns: ["b"], dependsOn: ["foundation"], status: "reserved", init: async () => { throw new Error("boom"); } },
  ] as const;
  const lc = await bootstrap({ env: { MOSAIC_ENV: "test" }, configDir, modules: mods, logger: silent });
  await assert.rejects(lc.start()); assert.equal(lc.state, "failed"); assert.deepEqual(stopped, ["foundation"]);
});

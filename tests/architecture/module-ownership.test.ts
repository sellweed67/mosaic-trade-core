import { test } from "node:test";
import assert from "node:assert/strict";
import { coreModules } from "../../modules/index.ts";
import { MODULE_IDS, orderModules } from "../../core/index.ts";

test("every canonical module registered exactly once", () => {
  assert.deepEqual([...coreModules.map((m) => m.id)].sort(), [...MODULE_IDS].sort());
});
test("each capability has exactly one owner and no cycles", () => {
  assert.doesNotThrow(() => orderModules(coreModules));
});
test("duplicate authority is rejected", () => {
  const a = { id: "data", owns: ["cache"], dependsOn: [], status: "reserved" } as const;
  const b = { id: "resource", owns: ["cache"], dependsOn: [], status: "reserved" } as const;
  assert.throws(() => orderModules([a, b]), /Duplicate authority/);
});

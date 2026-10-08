import { test } from "node:test";
import assert from "node:assert/strict";
import { orderModules, type ModuleDescriptor, type ModuleId } from "../../core/index.ts";

const m = (id: ModuleId, dependsOn: ModuleId[] = [], owns: string[] = [id]): ModuleDescriptor => ({ id, dependsOn, owns, status: "reserved" });

test("topological order: dependencies first, deterministic", () => {
  const order = orderModules([m("intelligence", ["resource", "policy-security"]), m("resource", ["foundation"]), m("policy-security", ["foundation"]), m("foundation")]).map((x) => x.id);
  assert.deepEqual(order, ["foundation", "resource", "policy-security", "intelligence"]);
  assert.deepEqual(orderModules([m("data"), m("foundation")]).map((x) => x.id), ["data", "foundation"]);
});
test("cycle detection reports path", () => {
  assert.throws(() => orderModules([m("data", ["resource"]), m("resource", ["control"]), m("control", ["data"])]), /cycle: data -> resource -> control -> data/);
  assert.throws(() => orderModules([m("data", ["data"])]), /cycle/);
});
test("missing dependency, duplicate id, duplicate authority, unknown id", () => {
  assert.throws(() => orderModules([m("data", ["resource"])]), /Missing module dependency/);
  assert.throws(() => orderModules([m("data"), m("data", [], ["x"])]), /Duplicate module id/);
  assert.throws(() => orderModules([m("data", [], ["cache"]), m("resource", [], ["cache"])]), /Duplicate authority/);
  assert.throws(() => orderModules([m("bogus" as ModuleId)]), /Unknown module id/);
});

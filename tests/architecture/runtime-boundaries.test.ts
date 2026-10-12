import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const files = (d: string): string[] => { try { return readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; }); } catch { return []; } };
const read = (f: string) => readFileSync(f, "utf8");

test("runtime uses only node built-ins and repo code (no network, no packages)", () => {
  const bad = files(join(ROOT, "core")).filter((f) => [...read(f).matchAll(/from\s+["']([^"']+)["']/g)].some((m) => {
    const s = m[1]!; return !(s.startsWith(".") || ["node:async_hooks", "node:crypto", "node:fs/promises", "node:path"].includes(s));
  }));
  assert.deepEqual(bad.map((f) => relative(ROOT, f)), []);
});
test("module descriptors never declare capability grants (grants come only from the composition root)", () => {
  const bad = files(join(ROOT, "modules")).filter((f) => /\bgrants?\b\s*:/.test(read(f)));
  assert.deepEqual(bad.map((f) => relative(ROOT, f)), []);
});
test("single dispatcher, single lifecycle, single registry", () => {
  const all = ["apps", "core", "modules", "integrations", "infrastructure", "trading"].flatMap((l) => files(join(ROOT, l)));
  for (const re of [/export\s+class\s+Dispatcher\b/, /export\s+class\s+Lifecycle\b/, /export\s+function\s+orderModules\b/, /export\s+class\s+CapabilityTable\b/])
    assert.equal(all.filter((f) => re.test(read(f))).length, 1, String(re));
});
test("no queue/broker/database/UI packages in package.json", () => {
  const pkg = JSON.parse(read(join(ROOT, "package.json")));
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ["@types/node", "typescript"]);
});

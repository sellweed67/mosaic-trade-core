import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const files = (dir: string): string[] => { try { return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; }); } catch { return []; } };
const src = (layers: string[]) => layers.flatMap((l) => files(join(ROOT, l))).map((f) => [relative(ROOT, f), readFileSync(f, "utf8")] as const);
const LIB = ["core", "contracts", "modules", "integrations", "infrastructure", "trading"];

test("process.env is read only in apps/ (composition root)", () => {
  assert.deepEqual(src(LIB).filter(([, s]) => /process\.env/.test(s)).map(([f]) => f), []);
});
test("no console.* in library code (use Logger)", () => {
  assert.deepEqual(src(LIB).filter(([, s]) => /\bconsole\./.test(s)).map(([f]) => f), []);
});
test("no exported mutable module-level state", () => {
  assert.deepEqual(src(LIB).filter(([, s]) => /^export\s+(let|var)\s/m.test(s)).map(([f]) => f), []);
});
test("no UI / frontend frameworks and no network clients in library code", () => {
  const bad = /from\s+["'](react|vue|svelte|@angular|next|vite)|\bfetch\(|node:(http|https|net)["']/;
  assert.deepEqual(src(LIB).filter(([, s]) => bad.test(s)).map(([f]) => f), []);
});
test("lifecycle-internal deadline helper is not exported from core", () => {
  assert.ok(!readFileSync(join(ROOT, "core/index.ts"), "utf8").includes("timeout.ts"));
});

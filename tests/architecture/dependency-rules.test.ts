import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const LAYERS = ["apps", "core", "contracts", "modules", "infrastructure", "integrations", "trading"] as const;
type Layer = (typeof LAYERS)[number];
/** Allowed import targets per layer (besides itself). */
const ALLOWED: Record<Layer, Layer[]> = {
  contracts: [],
  core: ["contracts"],
  modules: ["core", "contracts"],
  infrastructure: ["core", "contracts"],
  integrations: ["core", "contracts"],
  trading: ["contracts"],
  apps: ["core", "contracts", "modules", "infrastructure", "integrations"],
};
function files(dir: string): string[] {
  try { return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; }); }
  catch { return []; }
}
const imports = (src: string) => [...src.matchAll(/(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]!);

test("layer dependency rules hold", () => {
  const violations: string[] = [];
  for (const layer of LAYERS) for (const f of files(join(ROOT, layer))) {
    for (const spec of imports(readFileSync(f, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = relative(ROOT, resolve(dirname(f), spec)).split(sep)[0] as Layer;
      if (target !== layer && !ALLOWED[layer].includes(target)) violations.push(`${relative(ROOT, f)} -> ${spec}`);
      // modules must not import each other's internals
      if (layer === "modules" && target === "modules") {
        const a = relative(ROOT, f).split(sep)[1], b = relative(ROOT, resolve(dirname(f), spec)).split(sep)[1];
        if (a !== b && !a?.endsWith(".ts")) violations.push(`cross-module: ${relative(ROOT, f)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("no hard-coded secret-looking literals in source", () => {
  const bad = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  for (const layer of LAYERS) for (const f of files(join(ROOT, layer))) assert.ok(!bad.test(readFileSync(f, "utf8")), f);
});

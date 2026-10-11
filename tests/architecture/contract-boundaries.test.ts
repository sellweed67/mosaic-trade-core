import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const files = (d: string): string[] => { try { return readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "node_modules" ? [] : files(p)) : p.endsWith(".ts") ? [p] : []; }); } catch { return []; } };
const SRC = ["apps", "core", "contracts", "modules", "infrastructure", "integrations", "trading"].flatMap((l) => files(join(ROOT, l)));

test("contracts import only sibling contract files (no node:, packages, trading, providers)", () => {
  const bad = files(join(ROOT, "contracts")).filter((f) => [...readFileSync(f, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].some((m) => !m[1]!.startsWith("./")));
  assert.deepEqual(bad.map((f) => relative(ROOT, f)), []);
});
test("no trading/broker/MT5/provider/messaging SDK terms in the universal contract layer code", () => {
  const re = /\b(mt5|metatrader|broker|openai|anthropic|gemini|telegram|line-bot|order_execution)\b/i;
  const bad = files(join(ROOT, "contracts")).filter((f) => re.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  assert.deepEqual(bad.map((f) => relative(ROOT, f)), []);
});
test("canonical definitions exist exactly once", () => {
  for (const name of ["MESSAGE_TYPES", "MessageEnvelope", "POLICY_PRECEDENCE", "SecretRef", "SECRET_REF_PATTERN", "IDENTIFIER_PATTERN", "LIFECYCLE_TRANSITIONS", "RetryPolicy", "IdempotencyState", "SENSITIVE_VALUE_PATTERNS"]) {
    const re = new RegExp(`export\\s+(?:const|type|interface|function|class)\\s+${name}\\b`);
    const hits = SRC.filter((f) => re.test(readFileSync(f, "utf8")));
    assert.equal(hits.length, 1, `${name}: ${hits.map((f) => relative(ROOT, f))}`);
  }
});
test("no login, user database, OAuth, connector implementation or new runtime dependency", () => {
  assert.deepEqual(SRC.filter((f) => /(login|oauth|session|users?_?db)/i.test(relative(ROOT, f))).map((f) => relative(ROOT, f)), []);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(files(join(ROOT, "integrations")).map((f) => relative(ROOT, f)), ["integrations/adapter.ts"]);
  assert.deepEqual(files(join(ROOT, "trading")).map((f) => relative(ROOT, f)), ["trading/boundary.ts"]);
});

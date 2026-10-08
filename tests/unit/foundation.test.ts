import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveEnvironment, validateConfig, Secret, envSecretProvider, createLogger, MOSAIC_VERSION } from "../../core/index.ts";
import { resolvePrecedence } from "../../modules/policy-security/precedence.ts";

const base = { timeouts: { defaultMs: 1, shutdownMs: 1 }, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, resourceLimits: { maxConcurrentTasks: 1 } };

test("unknown environment fails closed", () => { assert.throws(() => resolveEnvironment("prod-ish")); });
test("config rejects inline secrets", () => {
  assert.throws(() => validateConfig({ ...base, featureFlags: { apiKey: "x" } }, "test"), /Inline secret/);
  assert.throws(() => validateConfig({ ...base, secretRefs: { a: "plain" } }, "test"), /secret ref/);
});
test("config is immutable", () => {
  const c = validateConfig({ ...base, secretRefs: { ai: "env://MOSAIC_SECRET_AI" } }, "test");
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.timeouts));
});
test("secrets never serialize; missing secret fails", async () => {
  const s = new Secret("v");
  assert.equal(JSON.stringify({ s }), '{"s":"[REDACTED]"}'); assert.equal(String(s), "[REDACTED]");
  await assert.rejects(envSecretProvider({}).resolve("env://NOPE"));
  await assert.rejects(envSecretProvider({}).resolve("vault://x"));
});
test("logger redacts secret fields", () => {
  const lines: string[] = []; createLogger((l) => lines.push(l)).log("info", "m", { token: "abc", nested: { password: "p" } });
  assert.ok(!lines[0]!.includes("abc") && !lines[0]!.includes('"p"'));
});
test("policy precedence: higher level wins, unknown/absent fails closed", () => {
  assert.equal(resolvePrecedence({ safety: "deny", optimization: "allow" }), "deny");
  assert.equal(resolvePrecedence({ security: "allow", cost: "deny" }), "allow");
  assert.equal(resolvePrecedence({ risk: "unknown", cost: "allow" }), "deny");
  assert.equal(resolvePrecedence({}), "deny");
});
test("version metadata matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(MOSAIC_VERSION, pkg.version);
});

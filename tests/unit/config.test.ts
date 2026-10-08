import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, loadConfig, envOverrides, resolveEnvironment, MosaicFault } from "../../core/index.ts";
import { baseRawConfig, testConfig } from "../helpers.ts";

const bad = (over: object, re: RegExp) => assert.throws(() => validateConfig({ ...structuredClone(baseRawConfig), ...over }, "test"), (e: any) => e instanceof MosaicFault && e.category === "configuration" && re.test(e.message));

test("environment: unknown fails closed", () => { assert.throws(() => resolveEnvironment("prod-ish"), /fail closed/); assert.equal(resolveEnvironment(undefined), "development"); });
test("valid config is deeply frozen", () => {
  const c = testConfig({ secretRefs: { ai: "env://MOSAIC_SECRET_AI" } });
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.timeouts) && Object.isFrozen(c.secretRefs));
  assert.throws(() => { (c as any).timeouts.defaultMs = 1; });
});
test("schema: types, ranges, unknown and required keys", () => {
  bad({ timeouts: { defaultMs: "1", startupMs: 1, shutdownMs: 1 } }, /timeouts\.defaultMs/);
  bad({ retry: { maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 } }, /maxAttempts/);
  bad({ extra: 1 }, /unknown key/);
  bad({ logging: { level: "loud" } }, /logging\.level/);
  bad({ featureFlags: { x: "yes" } }, /featureFlags\.x/);
  bad({ retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 10 } }, /maxDelayMs/);
  const { logging: _l, ...noLogging } = structuredClone(baseRawConfig);
  assert.throws(() => validateConfig(noLogging, "test"), /logging: required/);
});
test("schema collects all issues at once", () => {
  try { validateConfig({ ...baseRawConfig, extra: 1, logging: { level: "x" } }, "test"); assert.fail(); }
  catch (e: any) { assert.equal(e.details.issues.length, 2); }
});
test("no inline secrets; secret refs only", () => {
  bad({ featureFlags: { apiKey: true } }, /secret-like key/);
  bad({ secretRefs: { a: "plain-value" } }, /secret reference/);
});
test("env overrides parse JSON, nest by __, reject bad keys", () => {
  assert.deepEqual(envOverrides({ MOSAIC_CONFIG__timeouts__defaultMs: "5000", MOSAIC_CONFIG__logging__level: "warn", OTHER: "x" }), { logging: { level: "warn" }, timeouts: { defaultMs: 5000 } });
  assert.throws(() => envOverrides({ MOSAIC_CONFIG____proto____x: "1" }), /Invalid config override/);
  assert.throws(() => envOverrides({ MOSAIC_CONFIG__constructor__x: "1" }), /Invalid config override/);
});
test("layering: default < env file < env overrides; default.json required", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosaic-cfg-"));
  await assert.rejects(loadConfig(dir, "test"), /Cannot read config file default.json/);
  await writeFile(join(dir, "default.json"), JSON.stringify(baseRawConfig));
  await writeFile(join(dir, "test.json"), JSON.stringify({ timeouts: { defaultMs: 111 }, logging: { level: "warn" } }));
  const c = await loadConfig(dir, "test", { MOSAIC_CONFIG__logging__level: "error" });
  assert.equal(c.timeouts.defaultMs, 111); assert.equal(c.timeouts.startupMs, 200); assert.equal(c.logging.level, "error"); assert.equal(c.environment, "test");
  await writeFile(join(dir, "test.json"), "{bad");
  await assert.rejects(loadConfig(dir, "test"), /Malformed JSON/);
});
test("repository config/default.json is valid", async () => {
  const c = await loadConfig(new URL("../../config/", import.meta.url).pathname, "development");
  assert.equal(c.environment, "development");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { Secret, envSecretProvider, isSecretRef } from "../../core/index.ts";

test("Secret never leaks through serialization", () => {
  const s = new Secret("hunter2");
  assert.equal(JSON.stringify({ s }), '{"s":"[REDACTED]"}');
  assert.equal(`${s}`, "[REDACTED]");
  assert.ok(!inspect({ s }).includes("hunter2"));
  assert.equal(s.reveal(), "hunter2");
});
test("env provider resolves only MOSAIC_SECRET_ env refs; fails closed otherwise", async () => {
  const p = envSecretProvider({ MOSAIC_SECRET_AI: "v", PATH: "/bin" });
  assert.equal((await p.resolve("env://MOSAIC_SECRET_AI")).reveal(), "v");
  await assert.rejects(p.resolve("env://PATH"), /MOSAIC_SECRET_/);
  await assert.rejects(p.resolve("env://MOSAIC_SECRET_MISSING"), /not available/);
  await assert.rejects(p.resolve("vault://a/b"), /Unsupported/);
});
test("secret ref format", () => {
  assert.ok(isSecretRef("env://MOSAIC_SECRET_X")); assert.ok(isSecretRef("vault://kv/x"));
  assert.ok(!isSecretRef("http://x")); assert.ok(!isSecretRef("env://"));
});

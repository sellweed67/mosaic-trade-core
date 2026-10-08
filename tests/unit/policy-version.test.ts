import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MOSAIC_VERSION } from "../../core/index.ts";
import { resolvePrecedence } from "../../modules/policy-security/precedence.ts";

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

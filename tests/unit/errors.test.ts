import { test } from "node:test";
import assert from "node:assert/strict";
import { mosaicError } from "../../contracts/index.ts";
import { DomainError, SystemError, ContractError, MosaicFault, toMosaicError, toFault } from "../../core/index.ts";

test("hierarchy: kind derives from category", () => {
  const d = new DomainError("x", "validation", "m"), s = new SystemError("y", "timeout", "m"), c = new ContractError("z", "incompatible_version", "m");
  assert.ok(d instanceof MosaicFault && d instanceof Error);
  assert.deepEqual([d.kind, s.kind, c.kind], ["domain", "system", "contract"]);
  assert.equal(d.name, "DomainError");
});
test("retry defaults: timeout/unavailable retryable, others not", () => {
  assert.equal(new SystemError("t", "timeout", "m").is_retryable, true);
  assert.equal(new SystemError("u", "unavailable", "m").is_retryable, true);
  assert.equal(new DomainError("v", "validation", "m").is_retryable, false);
});
test("fail-closed categories can never be retryable", () => {
  for (const cat of ["policy_denied", "security", "configuration", "incompatible_version", "contract_violation"] as const)
    assert.equal(mosaicError("c", cat, "m", { retryable: true }).is_retryable, false, cat);
});
test("unknown external state requires reconciliation and is not retryable", () => {
  const e = new SystemError("x", "unknown_external_state", "m", { retryable: true });
  assert.equal(e.requires_reconciliation, true); assert.equal(e.is_retryable, false);
  const t = mosaicError("t", "timeout", "m", { requires_reconciliation: true });
  assert.equal(t.is_retryable, false);
});
test("normalization of unknown throwables", () => {
  const e = toMosaicError(new TypeError("bad"));
  assert.equal(e.category, "internal"); assert.equal(e.kind, "system"); assert.equal(e.is_retryable, false);
  assert.equal(toMosaicError("str").message, "str");
  const f = new DomainError("a", "conflict", "m"); assert.equal(toFault(f), f);
  assert.equal(toMosaicError(f).code, "a");
});
test("toJSON excludes stack and cause", () => {
  const j = JSON.parse(JSON.stringify(new SystemError("x", "internal", "m", { cause: new Error("secret") })));
  assert.equal(j.stack, undefined); assert.equal(j.cause, undefined); assert.equal(j.code, "x");
});

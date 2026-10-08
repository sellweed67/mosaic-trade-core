import { test } from "node:test";
import assert from "node:assert/strict";
import { IDENTIFIER_NAMES, isCompatible, mosaicError, isMosaicError, ERROR_CATEGORY_KIND } from "../../contracts/index.ts";

test("identifier standard is exactly the reserved set", () => {
  assert.deepEqual([...IDENTIFIER_NAMES], ["message_id", "request_id", "task_id", "workflow_id", "execution_id", "correlation_id", "idempotency_key"]);
});
test("incompatible major versions are rejected", () => {
  assert.equal(isCompatible({ major: 1, minor: 0 }, { major: 2, minor: 0 }), false);
  assert.equal(isCompatible({ major: 1, minor: 2 }, { major: 1, minor: 1 }), true);
  assert.equal(isCompatible({ major: 1, minor: 1 }, { major: 1, minor: 2 }), false);
});
test("error contract shape is complete and frozen", () => {
  const e = mosaicError("x", "unknown_external_state", "m", { retryable: true, correlation_id: "c" });
  assert.ok(Object.isFrozen(e) && isMosaicError(e));
  assert.deepEqual([e.kind, e.is_retryable, e.requires_reconciliation, e.correlation_id], ["system", false, true, "c"]);
  assert.deepEqual(new Set(Object.values(ERROR_CATEGORY_KIND)), new Set(["domain", "system", "contract"]));
});

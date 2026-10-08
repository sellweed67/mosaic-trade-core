import { test } from "node:test";
import assert from "node:assert/strict";
import { IDENTIFIER_NAMES, isCompatible, mosaicError } from "../../contracts/index.ts";

test("identifier standard is exactly the reserved set", () => {
  assert.deepEqual([...IDENTIFIER_NAMES], ["message_id", "request_id", "task_id", "workflow_id", "execution_id", "correlation_id", "idempotency_key"]);
});
test("incompatible major versions are rejected", () => {
  assert.equal(isCompatible({ major: 1, minor: 0 }, { major: 2, minor: 0 }), false);
  assert.equal(isCompatible({ major: 1, minor: 2 }, { major: 1, minor: 1 }), true);
});
test("unknown external state is never retryable", () => {
  assert.equal(mosaicError("x", "unknown_external_state", "m", { retryable: true }).retryable, false);
});

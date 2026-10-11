import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_TYPES, createEnvelope, validateEnvelope, serializeEnvelope, parseEnvelope, mosaicError,
  isAuthorized, isVerifiedIdentity, validateSecurityContext, toSecurityDiagnostic, resolvePolicyContext,
  validateRetryPolicy, decideRetry, classifyDelivery, mayExecute, transitionIdempotency, validateExecutionContext,
} from "../../contracts/index.ts";

const src = { kind: "module", id: "core-runtime" } as const, dst = { kind: "module", id: "data" } as const;
const base = (t: string, extra: object = {}) => ({ message_id: "m-1", correlation_id: "c-1", source: src, message_type: t, contract_version: { major: 1, minor: 0 }, created_at: "2026-10-11T00:00:00.000Z", payload: { a: [1, "x", null] }, metadata: { trace: "t" }, ...extra });
const perType: Record<string, object> = {
  COMMAND: { destination: dst, idempotency_key: "k-1" }, REQUEST: { destination: dst, request_id: "r-1" }, RESPONSE: { destination: dst, request_id: "r-1" },
  EVENT: {}, RESULT: { task_id: "t-1" }, ERROR: { payload: mosaicError("x.y", "timeout", "slow") },
};
const issues = (r: any) => r.ok ? [] : r.error.details.issues.map((i: any) => `${i.path}:${i.rule}`);

test("every canonical message type validates and round-trips without loss", () => {
  assert.deepEqual([...MESSAGE_TYPES], ["COMMAND", "REQUEST", "RESPONSE", "EVENT", "RESULT", "ERROR"]);
  for (const t of MESSAGE_TYPES) {
    const input = base(t, perType[t]); const before = JSON.stringify(input);
    const v = validateEnvelope(input); assert.ok(v.ok, `${t}: ${issues(v)}`);
    assert.equal(JSON.stringify(input), before, "input not mutated");
    const s = serializeEnvelope(v.value); assert.ok(s.ok);
    const back = parseEnvelope(s.value); assert.ok(back.ok); assert.deepEqual(back.value, v.value);
    assert.ok(Object.isFrozen(v.value) && Object.isFrozen(v.value.payload));
  }
});
test("createEnvelope fills only message_id/created_at/version; never correlation_id; keeps supplied ids", () => {
  const r = createEnvelope({ correlation_id: "c" as any, source: src, message_type: "EVENT", payload: 1, message_id: "keep" as any });
  assert.ok(r.ok); assert.equal(r.value.message_id, "keep"); assert.equal(r.value.contract_version.major, 1);
  assert.ok(!createEnvelope({ source: src, message_type: "EVENT", payload: 1 } as any).ok);
});
test("malformed envelopes fail deterministically", () => {
  assert.deepEqual(issues(validateEnvelope(base("PING"))), ["$.message_type:invalid_enum"]);
  assert.ok(issues(validateEnvelope({ ...base("EVENT"), message_id: undefined })).includes("$.message_id:required"));
  assert.ok(issues(validateEnvelope(base("EVENT", { message_id: "bad id!" }))).includes("$.message_id:invalid_identifier"));
  assert.ok(issues(validateEnvelope(base("COMMAND", { destination: dst }))).includes("$.idempotency_key:required_for_command"));
  assert.ok(issues(validateEnvelope(base("REQUEST", { destination: dst }))).includes("$.request_id:required_for_request"));
  assert.ok(issues(validateEnvelope(base("RESULT"))).includes("$.task_id:result_requires_task_or_execution_id"));
  assert.ok(issues(validateEnvelope(base("ERROR", { payload: { code: "x" } }))).length > 1);
  assert.ok(issues(validateEnvelope(base("EVENT", { execute_now: true }))).includes("$.execute_now:unknown_field"));
  assert.ok(issues(validateEnvelope(base("EVENT", { payload: { f: () => 1 } }))).includes("$.payload.f:non_json_value"));
  assert.equal((parseEnvelope("{bad") as any).error.details.issues[0].rule, "malformed_json");
  const inc = validateEnvelope(base("EVENT", { contract_version: { major: 2, minor: 0 } }));
  assert.ok(!inc.ok && inc.error.category === "incompatible_version");
  const a = validateEnvelope(base("EVENT", { x: 1, y: 2 })), b = validateEnvelope(base("EVENT", { y: 2, x: 1 }));
  assert.deepEqual(a, b);
});
test("metadata cannot carry secrets or control instructions; errors never echo values", () => {
  const r = validateEnvelope(base("EVENT", { metadata: { api_key: "x", "mosaic.route": "y", note: "Bearer abc.def.ghi", nested: { a: 1 }, message_type: "COMMAND" } }));
  assert.deepEqual(issues(r).sort(), ["$.metadata.api_key:sensitive_key", "$.metadata.message_type:reserved_key", "$.metadata.mosaic.route:reserved_key", "$.metadata.nested:non_primitive_value", "$.metadata.note:sensitive_value"]);
  const p = validateEnvelope(base("EVENT", { payload: { k: "sk-ABCDEFGHIJKLMNOPQRST" } }));
  assert.ok(!p.ok); assert.ok(!JSON.stringify(p).includes("sk-ABCDEF")); assert.ok(!JSON.stringify(r).includes("abc.def.ghi"));
});
test("identity claims are not authentication", () => {
  assert.equal(isVerifiedIdentity({ actor: { kind: "agent", id: "a" }, subject: { kind: "user", id: "u" }, verification: { status: "unverified" } }), false);
  assert.equal(isVerifiedIdentity({ actor: { kind: "agent", id: "a" }, verification: { status: "verified" } }), false);
  assert.equal(isVerifiedIdentity({ actor: { kind: "service_account", id: "s" }, verification: { status: "verified", verified_by: { kind: "service", id: "idp" }, verified_at: "2026-10-11T00:00:00Z" } }), true);
});
test("security context: refs only, raw secrets rejected, diagnostics masked", () => {
  const ok = validateSecurityContext({ trust_level: "internal", flags: ["dry_run"], credential_refs: { db: "env://MOSAIC_SECRET_DB" } });
  assert.ok(ok.ok); assert.deepEqual(toSecurityDiagnostic(ok.value).credential_refs, { db: "[REDACTED_REF]" });
  const bad = validateSecurityContext({ trust_level: "root", flags: ["x"], credential_refs: { db: "sk-ABCDEFGHIJKLMNOPQ", k: "plain" } });
  assert.ok(!bad.ok); assert.ok(!JSON.stringify(bad).includes("sk-ABC"));
  assert.ok(issues(bad).includes("$.credential_refs.db:raw_secret_not_allowed"));
});
test("authorization fails closed", () => {
  const req = { action: "workflow.run", resource: { type: "workflow", id: "w1" }, permission_refs: ["perm.run"] };
  const granted = { request: req, decision: { status: "granted", decided_by: { kind: "service", id: "authz" }, decided_at: "2026-10-11T00:00:00Z" } };
  assert.equal(isAuthorized(granted), true);
  assert.equal(isAuthorized({ request: req, decision: { status: "unresolved" } }), false);
  assert.equal(isAuthorized({ request: req, decision: { status: "denied", decided_by: { kind: "service", id: "a" }, decided_at: "2026-10-11T00:00:00Z" } }), false);
  assert.equal(isAuthorized({ request: req, decision: { status: "granted" } }), false);
  assert.equal(isAuthorized({ ...granted, decision: { ...granted.decision, expires_at: "2020-01-01T00:00:00Z" } }), false);
  assert.equal(isAuthorized(undefined), false); assert.equal(isAuthorized({ decision: granted.decision }), false);
});
test("policy precedence is deterministic, conflicts reported, empty/invalid deny", () => {
  const c = [{ level: "optimization", policy_id: "fast", effect: "allow" }, { level: "safety", policy_id: "guard", effect: "deny" }, { level: "cost", policy_id: "budget", effect: "require_approval" }];
  const r1 = resolvePolicyContext({ constraints: c }), r2 = resolvePolicyContext({ constraints: [...c].reverse() });
  assert.deepEqual(r1, r2); assert.equal(r1.outcome, "deny"); assert.equal(r1.decided_by?.level, "safety"); assert.equal(r1.conflicts.length, 2);
  assert.equal(resolvePolicyContext({ constraints: [{ level: "risk", policy_id: "a", effect: "allow" }, { level: "risk", policy_id: "b", effect: "deny" }] }).outcome, "deny");
  assert.equal(resolvePolicyContext({ constraints: [] }).outcome, "deny");
  assert.equal(resolvePolicyContext({ constraints: [{ level: "bogus", policy_id: "a", effect: "allow" }] }).outcome, "deny");
});
const policy = { retry_allowed: true, max_attempts: 3, retryable_categories: ["timeout", "unavailable"], backoff: { strategy: "exponential", initial_delay_ms: 100, max_delay_ms: 1000, multiplier: 2, jitter: "none" }, reconcile_on_unknown_outcome: true, requires_idempotency_key: true };
test("retry policy validation rejects unsafe settings", () => {
  assert.ok(validateRetryPolicy(policy).ok);
  for (const bad of [{ max_attempts: 0 }, { max_attempts: 1 }, { retryable_categories: ["policy_denied"] }, { retryable_categories: ["unknown_external_state"] }, { reconcile_on_unknown_outcome: false }, { retry_allowed: false }, { backoff: { ...policy.backoff, multiplier: 1 } }, { backoff: { ...policy.backoff, max_delay_ms: 10 } }])
    assert.ok(!validateRetryPolicy({ ...policy, ...bad }).ok, JSON.stringify(bad));
});
test("retry decisions: backoff, limits, idempotency, unknown outcome => reconcile", () => {
  const t = mosaicError("t", "timeout", "m");
  assert.deepEqual(decideRetry(policy, { error: t, attempt: 1, idempotency_key: "k" as any }), { action: "retry", delay_ms: 100, next_attempt: 2 });
  assert.equal((decideRetry(policy, { error: t, attempt: 2, idempotency_key: "k" as any }) as any).delay_ms, 200);
  assert.equal((decideRetry(policy, { error: t, attempt: 3, idempotency_key: "k" as any }) as any).reason, "max_attempts_reached");
  assert.equal((decideRetry(policy, { error: t, attempt: 1 }) as any).reason, "idempotency_key_required");
  assert.deepEqual(decideRetry(policy, { error: mosaicError("u", "unknown_external_state", "lost response"), attempt: 1, idempotency_key: "k" as any }), { action: "reconcile", reason: "unknown_external_state" });
  assert.equal((decideRetry({ ...policy, max_attempts: 99 }, { error: t, attempt: 1 }) as any).reason, "invalid_policy");
  assert.equal((decideRetry(policy, { error: mosaicError("v", "validation", "m"), attempt: 1, idempotency_key: "k" as any }) as any).reason, "error_not_retryable");
});
test("idempotency: duplicate vs new vs conflict; unknown outcome blocks blind retry", () => {
  const d = { key: "k-1", scope: { namespace: "data", operation: "write" }, fingerprint: "sha256:0123456789abcdef", created_at: "2026-10-11T00:00:00Z" } as any;
  const rec = (state: string, extra = {}) => ({ ...d, state, attempts: 1, updated_at: "2026-10-11T00:00:01Z", ...extra }) as any;
  assert.equal(classifyDelivery(undefined, d), "new_operation");
  assert.equal(classifyDelivery(rec("succeeded"), d), "duplicate_delivery");
  assert.equal(classifyDelivery(rec("succeeded"), { ...d, fingerprint: "sha256:ffffffffffffffff" }), "key_reuse_conflict");
  assert.equal(classifyDelivery(rec("succeeded", { expires_at: "2026-10-11T00:00:02Z" }), d, new Date("2027-01-01")), "expired_key");
  assert.deepEqual(mayExecute(rec("unknown_external_state")), { allowed: false, reason: "reconciliation_required" });
  assert.equal(mayExecute(rec("failed_retryable")).allowed, true);
  assert.ok(transitionIdempotency("in_progress", "unknown_external_state", "execution").ok);
  assert.ok(!transitionIdempotency("unknown_external_state", "in_progress", "execution").ok);
  assert.ok(!transitionIdempotency("unknown_external_state", "failed_retryable", "execution").ok);
  assert.ok(transitionIdempotency("unknown_external_state", "failed_retryable", "reconciliation").ok);
  assert.ok(!transitionIdempotency("succeeded", "in_progress", "execution").ok);
});
test("execution context bundle validates all parts together", () => {
  const ctx = { identity: { actor: { kind: "agent", id: "a" }, verification: { status: "unverified" } }, security: { trust_level: "untrusted", flags: [], credential_refs: {} }, policy: { constraints: [] }, retry: policy };
  assert.ok(validateExecutionContext(ctx).ok);
  assert.ok(!validateExecutionContext({ ...ctx, password: "x" }).ok);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStateStore } from "../../../infrastructure/index.ts";
import {
  DurableIdempotencyLedger, clampRetention, ledgerKey, MIN_RETENTION_MS, MAX_RETENTION_MS, DEFAULT_RETENTION_MS,
} from "../../../core/runtime/durable-idempotency-ledger.ts";

const T0 = new Date("2026-10-15T00:00:00.000Z");
const cmd = (payload: unknown = { q: 1 }, key = "k-1") => ({
  message_id: `m-${Math.random().toString(36).slice(2)}`, correlation_id: "corr-1", source: { kind: "service", id: "app" },
  destination: { kind: "module", id: "data" }, message_type: "COMMAND", contract_version: { major: 1, minor: 0 },
  created_at: T0.toISOString(), payload, metadata: {}, idempotency_key: key,
}) as any;
const scope = { namespace: "data", operation: "write" };
const setup = (retentionMs?: number) => {
  const store = new InMemoryStateStore({ now: () => T0 });
  return { store, ledger: new DurableIdempotencyLedger(store, { now: () => T0, ...(retentionMs !== undefined ? { retentionMs } : {}) }) };
};
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: any) => e.code === code);

test("claim creates an in_progress record at version 1 under the idmp key scheme", async () => {
  const { store, ledger } = setup();
  const c = await ledger.claim(cmd(), scope);
  assert.equal(c.outcome, "claimed");
  assert.match(c.key, /^idmp:[0-9a-f]{64}:k-1$/);
  assert.equal(c.key, ledgerKey("data", "write", "k-1"));
  if (c.outcome !== "claimed") return;
  assert.equal(c.version, 1);
  const s = (await store.get(c.key)) as any;
  assert.equal(s.value.value.state, "in_progress");
  assert.equal(s.value.value.completed_at, undefined);
});
test("same caller key in a different scope is a different record", async () => {
  const { ledger } = setup();
  const a = await ledger.claim(cmd(), scope);
  const b = await ledger.claim(cmd(), { namespace: "data", operation: "other" });
  assert.notEqual(a.key, b.key);
  assert.equal(b.outcome, "claimed");
});
test("duplicate with identical fingerprint returns cached success / cached failure", async () => {
  const { ledger } = setup();
  const c = await ledger.claim(cmd({ b: 1, a: 2 }), scope);
  if (c.outcome !== "claimed") throw new Error();
  await ledger.complete(c.key, { status: "success" }, c.version);
  const d = await ledger.claim(cmd({ a: 2, b: 1 }), scope); // same canonical payload, different key order
  assert.equal(d.outcome, "duplicate");
  assert.deepEqual(d.record.response_ref, { status: "success" });

  const f = await ledger.claim(cmd({ x: 1 }, "k-2"), scope);
  if (f.outcome !== "claimed") throw new Error();
  await ledger.complete(f.key, { status: "failure", error_code: "data.rejected", sanitized_message: "rejected" }, f.version);
  const fd = await ledger.claim(cmd({ x: 1 }, "k-2"), scope);
  assert.equal(fd.outcome, "duplicate");
  assert.equal(fd.record.state, "failed_final");
  assert.deepEqual(fd.record.response_ref, { status: "failure", error_code: "data.rejected", sanitized_message: "rejected" });
});
test("mismatched fingerprint is a conflict and is checked before the cached result is returned", async () => {
  const { ledger } = setup();
  const c = await ledger.claim(cmd({ q: 1 }), scope);
  if (c.outcome !== "claimed") throw new Error();
  await ledger.complete(c.key, { status: "success" }, c.version);
  await rejects(ledger.claim(cmd({ q: 2 }), scope), "idempotency.fingerprint_mismatch");
  const v2 = cmd({ q: 1 }); v2.contract_version = { major: 1, minor: 1 };
  await rejects(ledger.claim(v2, scope), "idempotency.fingerprint_mismatch");
});
test("in_progress duplicate is an in-flight conflict", async () => {
  const { ledger } = setup();
  await ledger.claim(cmd(), scope);
  await rejects(ledger.claim(cmd(), scope), "idempotency.in_flight");
});
test("concurrent claims: exactly one wins", async () => {
  const { ledger } = setup();
  const rs = await Promise.allSettled([1, 2, 3, 4].map(() => ledger.claim(cmd(), scope)));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(rs.filter((r) => r.status === "rejected").every((r: any) => r.reason.code === "idempotency.in_flight"));
});
test("unknown_external_state: no completed_at/retention, reclaim fails closed, never auto-retried", async () => {
  const { store, ledger } = setup();
  const c = await ledger.claim(cmd(), scope);
  if (c.outcome !== "claimed") throw new Error();
  const r = await ledger.complete(c.key, { status: "unknown" }, c.version);
  const rec = r.value as any;
  assert.equal(rec.state, "unknown_external_state");
  assert.equal(rec.requires_reconciliation, true);
  assert.equal(rec.completed_at, undefined);
  assert.equal(rec.retention_deadline, undefined);
  for (let i = 0; i < 3; i++) await assert.rejects(ledger.claim(cmd(), scope), (e: any) => e.code === "idempotency.reconciliation_required" && e.is_retryable === false && e.requires_reconciliation === true);
  assert.equal(((await store.get(c.key)) as any).value.version, r.version, "rejected claims wrote nothing");
  await rejects(ledger.complete(c.key, { status: "success" }, r.version), "idempotency.illegal_transition");
});
test("reconciliation starts retention; reconcile cannot resolve to unknown", async () => {
  const later = new Date(T0.getTime() + 3_600_000);
  let now = T0;
  const store = new InMemoryStateStore();
  const ledger = new DurableIdempotencyLedger(store, { now: () => now });
  const c = await ledger.claim(cmd(), scope);
  if (c.outcome !== "claimed") throw new Error();
  const u = await ledger.complete(c.key, { status: "unknown" }, c.version);
  await rejects(ledger.reconcile(c.key, { status: "unknown" } as any, u.version), "idempotency.invalid_reconciliation");
  now = later;
  const r = (await ledger.reconcile(c.key, { status: "success" }, u.version)).value as any;
  assert.equal(r.completed_at, later.toISOString());
  assert.equal(r.retention_deadline, new Date(later.getTime() + DEFAULT_RETENTION_MS).toISOString());
  assert.equal(r.requires_reconciliation, undefined);
});
test("retention is clamped to 24h..30d, default 7d, and applied to terminal records", async () => {
  assert.equal(clampRetention(undefined), DEFAULT_RETENTION_MS);
  assert.equal(clampRetention(1), MIN_RETENTION_MS);
  assert.equal(clampRetention(10 * MAX_RETENTION_MS), MAX_RETENTION_MS);
  assert.equal(clampRetention(2 * MIN_RETENTION_MS), 2 * MIN_RETENTION_MS);
  assert.throws(() => clampRetention(NaN));
  for (const [asked, eff] of [[1, MIN_RETENTION_MS], [Number.MAX_SAFE_INTEGER, MAX_RETENTION_MS]] as const) {
    const { ledger } = setup(asked);
    assert.equal(ledger.retentionMs, eff);
    const c = await ledger.claim(cmd(), scope);
    if (c.outcome !== "claimed") throw new Error();
    const r = (await ledger.complete(c.key, { status: "success" }, c.version)).value as any;
    assert.equal(Date.parse(r.retention_deadline) - Date.parse(r.completed_at), eff);
  }
});
test("tombstoned key is permanently retired and cannot be reclaimed", async () => {
  const { store, ledger } = setup();
  const c = await ledger.claim(cmd(), scope);
  if (c.outcome !== "claimed") throw new Error();
  const done = await ledger.complete(c.key, { status: "success" }, c.version);
  assert.equal((await store.delete(c.key, done.version)).ok, true);
  await rejects(ledger.claim(cmd(), scope), "idempotency.key_retired");
  await rejects(ledger.claim(cmd({ other: true }), scope), "idempotency.key_retired");
  assert.equal(((await store.getEntry(c.key)) as any).value.status, "tombstone");
});
test("pre-claim validation: invalid payload/envelope/scope writes nothing", async () => {
  const { store, ledger } = setup();
  await rejects(ledger.claim(cmd({ n: 1n }), scope), "contract.invalid_payload");
  await rejects(ledger.claim(cmd({ d: new Date() }), scope), "contract.invalid_payload");
  const noKey = cmd(); delete noKey.idempotency_key;
  await assert.rejects(ledger.claim(noKey, scope));
  const ev = cmd(); ev.message_type = "EVENT"; delete ev.idempotency_key;
  await assert.rejects(ledger.claim(ev, scope));
  await rejects(ledger.claim(cmd(), { namespace: "Bad Space", operation: "x" }), "idempotency.invalid_scope");
  assert.deepEqual(((await store.listKeys()) as any).value.keys, []);
});
test("complete: stale expectedVersion fails closed without writing", async () => {
  const { store, ledger } = setup();
  const c = await ledger.claim(cmd(), scope);
  if (c.outcome !== "claimed") throw new Error();
  await rejects(ledger.complete(c.key, { status: "success" }, 7), "idempotency.version_conflict");
  await rejects(ledger.complete(c.key, { status: "failure" } as any, c.version), "idempotency.invalid_result");
  assert.equal(((await store.get(c.key)) as any).value.version, 1);
});

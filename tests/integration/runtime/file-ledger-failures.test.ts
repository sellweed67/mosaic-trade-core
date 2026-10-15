import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SingleProcessFileStore, InMemoryStateStore, RECORDS_DIR } from "../../../infrastructure/index.ts";
import { mosaicError, err, type StateStore } from "../../../contracts/index.ts";
import { DurableIdempotencyLedger } from "../../../core/runtime/durable-idempotency-ledger.ts";
import { IdempotencyRecovery } from "../../../core/runtime/idempotency-recovery.ts";
import { tempDir } from "../../storage-helpers.ts";
const T0 = new Date("2026-10-15T00:00:00.000Z");
const cmd = (payload: unknown = { q: 1 }, key = "k-1") => ({
  message_id: `m-${Math.random().toString(36).slice(2)}`, correlation_id: "corr-1", source: { kind: "service", id: "app" },
  destination: { kind: "module", id: "data" }, message_type: "COMMAND", contract_version: { major: 1, minor: 0 },
  created_at: T0.toISOString(), payload, metadata: {}, idempotency_key: key,
}) as any;

const scope = { namespace: "data", operation: "write" };
const ioErr = () => err(mosaicError("storage.io_failure", "unavailable", "injected", { retryable: false }));

/** Wraps a store; methods named in `fail` return injected I/O failures, optionally after N successful calls. */
function faulty(inner: StateStore, fail: Partial<Record<keyof StateStore, number>>): StateStore {
  const calls: Record<string, number> = {};
  const wrap = (m: keyof StateStore) => async (...a: any[]) => {
    calls[m] = (calls[m] ?? 0) + 1;
    if (fail[m] !== undefined && calls[m]! > fail[m]!) return ioErr();
    return (inner[m] as any)(...a);
  };
  return { get: wrap("get"), getEntry: wrap("getEntry"), put: wrap("put"), delete: wrap("delete"), has: wrap("has"), listKeys: wrap("listKeys"), close: () => inner.close() } as StateStore;
}

test("closed file store: claim and recovery throw (fail closed)", async () => {
  const s = await SingleProcessFileStore.open({ baseDir: await tempDir() });
  await s.close();
  await assert.rejects(new DurableIdempotencyLedger(s).claim(cmd(), scope), (e: any) => e.code === "storage.closed");
  await assert.rejects(new IdempotencyRecovery(s).recover(), (e: any) => e.code === "storage.closed");
});

test("I/O failure on claim put, on conflict read, and on completion throws", async () => {
  await assert.rejects(new DurableIdempotencyLedger(faulty(new InMemoryStateStore(), { put: 0 })).claim(cmd(), scope), (e: any) => e.code === "storage.io_failure");
  const inner = new InMemoryStateStore();
  await new DurableIdempotencyLedger(inner).claim(cmd(), scope);
  await assert.rejects(new DurableIdempotencyLedger(faulty(inner, { getEntry: 0 })).claim(cmd(), scope), (e: any) => e.code === "storage.io_failure");
  const i2 = new InMemoryStateStore();
  const l = new DurableIdempotencyLedger(faulty(i2, { put: 1 }));
  const c = await l.claim(cmd(), scope); if (c.outcome !== "claimed") throw new Error();
  await assert.rejects(l.complete(c.key, { status: "success" }, c.version), (e: any) => e.code === "storage.io_failure");
  assert.equal(((await i2.get(c.key)) as any).value.value.state, "in_progress", "record unchanged after failed completion");
});

test("CAS conflict during completion: concurrent completers, exactly one wins", async () => {
  const s = await SingleProcessFileStore.open({ baseDir: await tempDir() });
  const l = new DurableIdempotencyLedger(s);
  const c = await l.claim(cmd(), scope); if (c.outcome !== "claimed") throw new Error();
  const rs = await Promise.allSettled([l.complete(c.key, { status: "success" }, c.version), l.complete(c.key, { status: "unknown" }, c.version)]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  const rej = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(rej.reason.code, /version_conflict|illegal_transition/);
  await s.close();
});

test("interrupted recovery fails closed and a rerun completes it", async () => {
  const inner = new InMemoryStateStore();
  const l = new DurableIdempotencyLedger(inner);
  for (const k of ["a-1", "a-2", "a-3"]) await l.claim(cmd({ k }, k), scope);
  // first put succeeds, second fails: recovery must throw, not report clean/unresolved
  await assert.rejects(new IdempotencyRecovery(faulty(inner, { put: 1 })).recover(), (e: any) => e.code === "storage.io_failure");
  await assert.rejects(new IdempotencyRecovery(faulty(inner, { listKeys: 0 })).recover(), (e: any) => e.code === "storage.io_failure");
  await assert.rejects(new IdempotencyRecovery(faulty(inner, { get: 0 })).recover(), (e: any) => e.code === "storage.io_failure");
  const r = await new IdempotencyRecovery(inner).recover();
  assert.equal(r.status, "unresolved_records_exist");
  assert.equal(r.unresolvedKeys.length, 3);
  assert.equal(r.transitionedCount, 2, "one record was already transitioned by the interrupted run");
});

test("recovery CAS conflict (record changed between read and write) fails closed", async () => {
  const inner = new InMemoryStateStore();
  const c = await new DurableIdempotencyLedger(inner).claim(cmd(), scope);
  const racing: StateStore = { ...faulty(inner, {}), get: async (k: string) => {
    const r = await inner.get(k);
    if (r.ok && r.value) await inner.put({ key: k, value: r.value.value }, r.value.version); // concurrent writer bumps version
    return r;
  } };
  await assert.rejects(new IdempotencyRecovery(racing).recover(), (e: any) => e.code === "storage.version_conflict");
  assert.equal(((await inner.get(c.key)) as any).value.value.state, "in_progress");
});

test("corrupt ledger record fails recovery closed", async () => {
  const inner = new InMemoryStateStore();
  await inner.put({ key: "idmp:" + "0".repeat(64) + ":x", value: { state: "weird" } }, 0);
  await assert.rejects(new IdempotencyRecovery(inner).recover(), (e: any) => e.code === "idempotency.corrupt_record");
});

test("malformed file on disk prevents the store (and therefore recovery) from opening", async () => {
  const dir = await tempDir();
  const s = await SingleProcessFileStore.open({ baseDir: dir });
  await new DurableIdempotencyLedger(s).claim(cmd(), scope);
  await s.close();
  const f = (await readdir(join(dir, RECORDS_DIR)))[0]!;
  await writeFile(join(dir, RECORDS_DIR, f), "{not json");
  await assert.rejects(SingleProcessFileStore.open({ baseDir: dir }));
});

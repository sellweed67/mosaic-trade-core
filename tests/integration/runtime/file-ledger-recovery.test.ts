import { test } from "node:test";
import assert from "node:assert/strict";
import { SingleProcessFileStore } from "../../../infrastructure/index.ts";
import { DurableIdempotencyLedger } from "../../../core/runtime/durable-idempotency-ledger.ts";
import { IdempotencyRecovery } from "../../../core/runtime/idempotency-recovery.ts";
import { tempDir } from "../../storage-helpers.ts";
import { cmd } from "../../unit/runtime/durable-idempotency.test.ts";

const scope = { namespace: "data", operation: "write" };

test("clean store (empty and terminal-only) recovers as clean", async () => {
  const dir = await tempDir();
  let s = await SingleProcessFileStore.open({ baseDir: dir });
  assert.deepEqual(await new IdempotencyRecovery(s).recover(), { status: "clean", scannedCount: 0, transitionedCount: 0, unresolvedKeys: [] });
  const l = new DurableIdempotencyLedger(s);
  const c = await l.claim(cmd(), scope); if (c.outcome !== "claimed") throw new Error();
  await l.complete(c.key, { status: "success" }, c.version);
  await s.close();
  s = await SingleProcessFileStore.open({ baseDir: dir });
  assert.deepEqual(await new IdempotencyRecovery(s).recover(), { status: "clean", scannedCount: 1, transitionedCount: 0, unresolvedKeys: [] });
  await s.close();
});

test("crash with in_progress -> unknown_external_state on restart; preserved on later restarts; clean after reconciliation", async () => {
  const dir = await tempDir();
  let s = await SingleProcessFileStore.open({ baseDir: dir });
  const c = await new DurableIdempotencyLedger(s).claim(cmd(), scope);
  await s.close(); // simulated crash before completion

  s = await SingleProcessFileStore.open({ baseDir: dir });
  const r1 = await new IdempotencyRecovery(s).recover();
  assert.deepEqual(r1, { status: "unresolved_records_exist", scannedCount: 1, transitionedCount: 1, unresolvedKeys: [c.key] });
  const ledger = new DurableIdempotencyLedger(s);
  const after = await ledger.read(c.key);
  assert.equal(after!.record.state, "unknown_external_state");
  assert.equal(after!.record.requires_reconciliation, true);
  assert.equal(after!.record.completed_at, undefined);
  assert.equal(after!.record.retention_deadline, undefined);
  await assert.rejects(ledger.claim(cmd(), scope), (e: any) => e.code === "idempotency.reconciliation_required");
  await s.close();

  s = await SingleProcessFileStore.open({ baseDir: dir });
  const r2 = await new IdempotencyRecovery(s).recover();
  assert.deepEqual(r2, { status: "unresolved_records_exist", scannedCount: 1, transitionedCount: 0, unresolvedKeys: [c.key] });
  const l2 = new DurableIdempotencyLedger(s);
  const cur = await l2.read(c.key);
  assert.equal(cur!.version, after!.version, "existing unknown record not mutated");
  await l2.reconcile(c.key, { status: "failure", error_code: "data.not_applied" }, cur!.version);
  assert.equal((await new IdempotencyRecovery(s).recover()).status, "clean");
  await s.close();
});

test("pagination: recovery scans more keys than one page", async () => {
  const dir = await tempDir();
  const s = await SingleProcessFileStore.open({ baseDir: dir });
  const l = new DurableIdempotencyLedger(s);
  for (let i = 0; i < 60; i++) await l.claim(cmd({ i }, `k-${i}`), scope);
  const r = await new IdempotencyRecovery(s).recover();
  assert.equal(r.scannedCount, 60);
  assert.equal(r.transitionedCount, 60);
  assert.equal(new Set(r.unresolvedKeys).size, 60);
  await s.close();
});

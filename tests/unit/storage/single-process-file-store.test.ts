import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SingleProcessFileStore, LOCK_FILE, RECORDS_DIR, fileNameForKey } from "../../../infrastructure/index.ts";
import { tempDir, code } from "../../storage-helpers.ts";

const exists = (p: string) => stat(p).then(() => true, () => false);

test("lock: exclusive creation, collision fails fatally without breaking the lock, released on close", async () => {
  const dir = await tempDir();
  const a = await SingleProcessFileStore.open({ baseDir: dir });
  const lockBytes = await readFile(join(dir, LOCK_FILE));
  await assert.rejects(SingleProcessFileStore.open({ baseDir: dir }), (e: any) => e.code === "storage.lock_held" && e.is_retryable === false && /Operator recovery required/.test(e.message));
  assert.deepEqual(await readFile(join(dir, LOCK_FILE)), lockBytes, "lock untouched");
  await a.close();
  assert.equal(await exists(join(dir, LOCK_FILE)), false);
  const b = await SingleProcessFileStore.open({ baseDir: dir }); await b.close();
});
test("abnormal termination: a leftover lock (even a very old one) is never removed automatically", async () => {
  const dir = await tempDir();
  await SingleProcessFileStore.open({ baseDir: dir }); // never closed = simulated crash
  const stale = JSON.stringify({ token: "x", pid: 1, created_at: "2000-01-01T00:00:00.000Z" });
  await writeFile(join(dir, LOCK_FILE), stale);
  await assert.rejects(SingleProcessFileStore.open({ baseDir: dir }), /lock/i);
  assert.equal(await readFile(join(dir, LOCK_FILE), "utf8"), stale);
});
test("close does not remove a lock it does not own", async () => {
  const dir = await tempDir();
  const s = await SingleProcessFileStore.open({ baseDir: dir });
  await writeFile(join(dir, LOCK_FILE), JSON.stringify({ token: "someone-else" }));
  await s.close();
  assert.equal(await exists(join(dir, LOCK_FILE)), true);
});
test("records and tombstones persist across restarts; monotonic versions and recreation rules hold", async () => {
  const dir = await tempDir();
  let s = await SingleProcessFileStore.open({ baseDir: dir });
  await s.put({ key: "a", value: { v: 1 } }, 0); await s.put({ key: "a", value: { v: 2 } }, 1); await s.delete("a", 2);
  await s.put({ key: "b", value: "keep", etag: "e", metadata: { m: true } }, 0);
  await s.close();
  s = await SingleProcessFileStore.open({ baseDir: dir });
  assert.deepEqual((await s.getEntry("a") as any).value.status, "tombstone");
  assert.equal((await s.getEntry("a") as any).value.version, 3);
  assert.equal(code(await s.put({ key: "a", value: 0 }, 0)), "storage.version_conflict");
  assert.equal((await s.put({ key: "a", value: 0 }, 3) as any).value.version, 4);
  const b: any = (await s.get("b")).ok && (await s.get("b"));
  assert.deepEqual([b.value.value, b.value.etag, b.value.metadata], ["keep", "e", { m: true }]);
  await s.close();
  s = await SingleProcessFileStore.open({ baseDir: dir });
  assert.equal((await s.get("a") as any).value.version, 4);
  await s.close();
  const raw = JSON.parse(await readFile(join(dir, RECORDS_DIR, fileNameForKey("a")), "utf8"));
  assert.deepEqual(Object.keys(raw), ["key", "value", "version", "status", "created_at", "updated_at"]);
});
for (const [label, bytes] of [["invalid JSON", "{\"key\": \"a\", trunc"], ["wrong schema", JSON.stringify({ key: "a", version: 0, status: "active" })], ["empty file", ""]] as const) {
  test(`malformed persisted data (${label}): open fails closed and bytes are preserved`, async () => {
    const dir = await tempDir();
    const s = await SingleProcessFileStore.open({ baseDir: dir }); await s.put({ key: "a", value: 1 }, 0); await s.close();
    const file = join(dir, RECORDS_DIR, fileNameForKey("a"));
    await writeFile(file, bytes);
    await assert.rejects(SingleProcessFileStore.open({ baseDir: dir }), (e: any) => e.code === "storage.corrupt_entry");
    assert.equal(await readFile(file, "utf8"), bytes);
    assert.equal(await exists(join(dir, LOCK_FILE)), false, "failed open releases its own lock");
  });
}
test("key/file mismatch and unexpected files fail closed", async () => {
  const dir = await tempDir();
  const s = await SingleProcessFileStore.open({ baseDir: dir }); await s.put({ key: "a", value: 1 }, 0); await s.close();
  const content = await readFile(join(dir, RECORDS_DIR, fileNameForKey("a")));
  await writeFile(join(dir, RECORDS_DIR, fileNameForKey("b")), content);
  await assert.rejects(SingleProcessFileStore.open({ baseDir: dir }), /does not match the key/);
  const d2 = await tempDir(); const s2 = await SingleProcessFileStore.open({ baseDir: d2 }); await s2.close();
  await writeFile(join(d2, RECORDS_DIR, "notes.txt"), "x");
  await assert.rejects(SingleProcessFileStore.open({ baseDir: d2 }), (e: any) => e.code === "storage.unexpected_file");
  assert.equal(await readFile(join(d2, RECORDS_DIR, "notes.txt"), "utf8"), "x");
});
test("interrupted write before commit: original preserved, temp cleaned, store stays usable", async () => {
  const dir = await tempDir();
  let fail = false;
  const s = await SingleProcessFileStore.open({ baseDir: dir }, { hooks: { afterTempWrite: () => { if (fail) throw new Error("disk full"); } } });
  await s.put({ key: "a", value: "v1" }, 0);
  const file = join(dir, RECORDS_DIR, fileNameForKey("a")); const before = await readFile(file, "utf8");
  fail = true;
  const r: any = await s.put({ key: "a", value: "v2" }, 1);
  assert.equal(r.error.code, "storage.write_failed");
  assert.equal(await readFile(file, "utf8"), before);
  assert.deepEqual((await readdir(join(dir, RECORDS_DIR))).filter((n) => n.includes(".tmp.")), []);
  assert.equal((await s.get("a") as any).value.version, 1);
  fail = false;
  assert.equal((await s.put({ key: "a", value: "v2" }, 1) as any).value.version, 2);
  await s.close();
});
test("crash leftover temp file: open succeeds, temp preserved and reported, committed data intact", async () => {
  const dir = await tempDir();
  let s = await SingleProcessFileStore.open({ baseDir: dir }); await s.put({ key: "a", value: "v1" }, 0); await s.close();
  const orphan = join(dir, RECORDS_DIR, fileNameForKey("a") + ".tmp.deadbeef");
  await writeFile(orphan, "{\"partial\":");
  s = await SingleProcessFileStore.open({ baseDir: dir });
  assert.equal(s.diagnostics().orphan_temp_files, 1);
  assert.equal((await s.get("a") as any).value.value, "v1");
  assert.equal(await readFile(orphan, "utf8"), "{\"partial\":");
  await s.close();
});
test("failure at/after rename poisons the store (fail closed); reopen reloads what reached disk", async () => {
  const dir = await tempDir();
  let fail = false;
  let s = await SingleProcessFileStore.open({ baseDir: dir }, { hooks: { afterRename: () => { if (fail) throw new Error("EIO"); } } });
  await s.put({ key: "a", value: "v1" }, 0);
  fail = true;
  const r: any = await s.put({ key: "a", value: "v2" }, 1);
  assert.equal(r.error.category, "unknown_external_state"); assert.equal(r.error.requires_reconciliation, true);
  assert.equal(s.diagnostics().poisoned, true);
  assert.equal(code(await s.get("a")), "storage.durability_unknown");
  assert.equal(code(await s.put({ key: "b", value: 1 }, 0)), "storage.durability_unknown");
  await s.close();
  s = await SingleProcessFileStore.open({ baseDir: dir });
  assert.equal((await s.get("a") as any).value.version, 2); // the rename had completed
  await s.close();
});
test("concurrent writes across keys and conflicting writes on one key serialize correctly and persist", async () => {
  const dir = await tempDir();
  let s = await SingleProcessFileStore.open({ baseDir: dir });
  const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
  assert.ok((await Promise.all(keys.map((k) => s.put({ key: k, value: k }, 0)))).every((r) => r.ok));
  const race = await Promise.all([1, 2, 3, 4, 5].map((n) => s.put({ key: "k0", value: n }, 1)));
  const winner = race.findIndex((r) => r.ok);
  assert.equal(race.filter((r) => r.ok).length, 1);
  await s.close();
  s = await SingleProcessFileStore.open({ baseDir: dir });
  assert.equal(s.diagnostics().entries, 20);
  assert.equal((await s.get("k0") as any).value.value, winner + 1);
  assert.equal((await s.get("k0") as any).value.version, 2);
  await s.close();
});
test("filenames are hashed, so keys can't escape the records directory", async () => {
  const dir = await tempDir();
  const s = await SingleProcessFileStore.open({ baseDir: dir });
  await s.put({ key: "..:..:etc", value: 1 }, 0);
  assert.deepEqual(await readdir(join(dir, RECORDS_DIR)), [fileNameForKey("..:..:etc")]);
  assert.ok(typeof s.diagnostics().directory_fsync_supported === "boolean");
  await s.close();
});
test("open rejects missing baseDir", async () => {
  await assert.rejects(SingleProcessFileStore.open({ baseDir: "" }), (e: any) => e.code === "storage.invalid_config");
});

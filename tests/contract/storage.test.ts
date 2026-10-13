import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStateStore, SingleProcessFileStore } from "../../infrastructure/index.ts";
import type { StateStore } from "../../contracts/index.ts";
import { tempDir, code } from "../storage-helpers.ts";

const factories: [string, () => Promise<StateStore>][] = [
  ["InMemoryStateStore", async () => new InMemoryStateStore()],
  ["SingleProcessFileStore", async () => SingleProcessFileStore.open({ baseDir: await tempDir() })],
];

for (const [name, make] of factories) {
  test(`${name}: create requires expectedVersion 0 and yields version 1`, async () => {
    const s = await make();
    assert.equal(code(await s.put({ key: "a", value: 1 }, 1)), "storage.version_conflict");
    const r: any = await s.put({ key: "a", value: { n: 1 }, etag: "e1", metadata: { m: 1 } }, 0);
    assert.equal(r.value.version, 1); assert.equal(r.value.status, "active"); assert.equal(r.value.created_at, r.value.updated_at);
    assert.equal(code(await s.put({ key: "a", value: 2 }, 0)), "storage.version_conflict");
    assert.deepEqual((await s.get("a") as any).value.value, { n: 1 });
    assert.equal((await s.has("a") as any).value, true); assert.equal((await s.has("zz") as any).value, false);
    assert.equal((await s.get("zz") as any).value, null); assert.equal((await s.getEntry("zz") as any).value, null);
    await s.close();
  });
  test(`${name}: update increments by exactly 1; stale versions fail closed`, async () => {
    const s = await make();
    await s.put({ key: "a", value: 1 }, 0);
    const u: any = await s.put({ key: "a", value: 2 }, 1);
    assert.equal(u.value.version, 2);
    const stale: any = await s.put({ key: "a", value: 3 }, 1);
    assert.equal(stale.error.code, "storage.version_conflict"); assert.equal(stale.error.is_retryable, false);
    assert.deepEqual(stale.error.details, { expected_version: 1, actual_version: 2, actual_status: "active" });
    assert.equal((await s.get("a") as any).value.value, 2);
    await s.close();
  });
  test(`${name}: delete -> tombstone v+1; recreate needs tombstone version; no ABA`, async () => {
    const s = await make();
    await s.put({ key: "a", value: 1 }, 0); await s.put({ key: "a", value: 2 }, 1);
    assert.equal(code(await s.delete("a", 1)), "storage.version_conflict");
    const t: any = await s.delete("a", 2);
    assert.deepEqual([t.value.status, t.value.version], ["tombstone", 3]);
    assert.equal((await s.get("a") as any).value, null); assert.equal((await s.has("a") as any).value, false);
    assert.equal((await s.getEntry("a") as any).value.status, "tombstone");
    assert.equal(code(await s.delete("a", 3)), "storage.version_conflict");
    assert.equal(code(await s.put({ key: "a", value: 9 }, 0)), "storage.version_conflict");
    assert.equal(code(await s.put({ key: "a", value: 9 }, 2)), "storage.version_conflict");
    const re: any = await s.put({ key: "a", value: 9 }, 3);
    assert.equal(re.value.version, 4); assert.equal(re.value.status, "active");
    assert.equal(code(await s.delete("never", 0)), "storage.version_conflict");
    await s.close();
  });
  test(`${name}: input validation and secret rejection`, async () => {
    const s = await make();
    assert.equal(code(await s.put({ key: "../etc/passwd", value: 1 }, 0)), "storage.invalid_input");
    assert.equal(code(await s.get("bad key")), "storage.invalid_key");
    assert.equal(code(await s.put({ key: "a", value: undefined }, 0)), "storage.invalid_input");
    assert.equal(code(await s.put({ key: "a", value: 1 }, -1)), "storage.invalid_input");
    assert.equal(code(await s.put({ key: "a", value: 1 }, 1.5)), "storage.invalid_input");
    assert.equal(code(await s.put({ key: "a", value: { x: () => 1 } }, 0)), "storage.invalid_input");
    const sec: any = await s.put({ key: "a", value: { t: "sk-ABCDEFGHIJKLMNOPQRST" } }, 0);
    assert.equal(sec.error.code, "storage.invalid_input"); assert.ok(!JSON.stringify(sec).includes("sk-ABCDEF"));
    assert.equal(code(await s.put({ key: "a", value: 1, extra: 1 } as any, 0)), "storage.invalid_input");
    await s.close();
  });
  test(`${name}: returned entries are frozen copies; caller objects are not mutated or aliased`, async () => {
    const s = await make();
    const value = { n: [1, 2] }; const before = JSON.stringify(value);
    const r: any = await s.put({ key: "a", value }, 0);
    value.n.push(3);
    assert.equal(JSON.stringify((await s.get("a") as any).value.value), before);
    assert.ok(Object.isFrozen(r.value) && Object.isFrozen(r.value.value));
    await s.close();
  });
  test(`${name}: concurrent writes with the same expected version -> exactly one wins`, async () => {
    const s = await make();
    await s.put({ key: "c", value: 0 }, 0);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => s.put({ key: "c", value: i }, 1)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => code(r) === "storage.version_conflict").length, 9);
    assert.equal((await s.get("c") as any).value.version, 2);
    await s.close();
  });
  test(`${name}: operations after close fail`, async () => {
    const s = await make(); await s.close(); await s.close();
    assert.equal(code(await s.get("a")), "storage.closed");
    assert.equal(code(await s.put({ key: "a", value: 1 }, 0)), "storage.closed");
  });
}

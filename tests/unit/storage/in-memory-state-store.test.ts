import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStateStore } from "../../../infrastructure/index.ts";
import { planPut, planDelete } from "../../../contracts/index.ts";

test("uses injected clock; update keeps created_at, recreate gets a new created_at", async () => {
  let t = 0; const s = new InMemoryStateStore({ now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)) });
  const a: any = await s.put({ key: "k", value: 1 }, 0);
  const b: any = await s.put({ key: "k", value: 2 }, 1);
  assert.equal(b.value.created_at, a.value.created_at); assert.notEqual(b.value.updated_at, a.value.updated_at);
  const d: any = await s.delete("k", 2); assert.equal(d.value.deleted_at, "2026-01-01T00:00:02.000Z");
  const c: any = await s.put({ key: "k", value: 3 }, 3);
  assert.equal(c.value.created_at, "2026-01-01T00:00:03.000Z");
});
test("put replaces the whole record: omitted etag/metadata are not carried over", async () => {
  const s = new InMemoryStateStore();
  await s.put({ key: "k", value: 1, etag: "e", metadata: { a: 1 } }, 0);
  const r: any = await s.put({ key: "k", value: 2 }, 1);
  assert.equal(r.value.etag, undefined); assert.equal(r.value.metadata, undefined);
});
test("planners are pure and reject version exhaustion", () => {
  const cur = { key: "k", value: 1, version: Number.MAX_SAFE_INTEGER, status: "active", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } as const;
  const r: any = planPut(cur, { key: "k", value: 2 }, Number.MAX_SAFE_INTEGER, "2026-01-01T00:00:01Z");
  assert.equal(r.error.code, "storage.version_exhausted");
  assert.equal((planDelete(cur, "k", Number.MAX_SAFE_INTEGER, "2026-01-01T00:00:01Z") as any).error.code, "storage.version_exhausted");
  assert.equal(cur.version, Number.MAX_SAFE_INTEGER);
});
test("no unconditional upsert exists on the public interface", () => {
  const s = new InMemoryStateStore() as any;
  for (const m of ["upsert", "set", "save", "write"]) assert.equal(typeof s[m], "undefined");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStateStore, SingleProcessFileStore } from "../../infrastructure/index.ts";
import { DEFAULT_LIST_KEYS_LIMIT, MAX_LIST_KEYS_LIMIT, type StateStore } from "../../contracts/index.ts";
import { tempDir, code } from "../storage-helpers.ts";

const factories: [string, () => Promise<StateStore>][] = [
  ["InMemoryStateStore", async () => new InMemoryStateStore()],
  ["SingleProcessFileStore", async () => SingleProcessFileStore.open({ baseDir: await tempDir() })],
];
const KEYS = ["b", "a:2", "a:10", "a:1", "B", "a", "ab", "a.x", "z-9", "_u"];
const seed = async (s: StateStore, keys = KEYS) => { for (const k of keys) assert.ok((await s.put({ key: k, value: 1 }, 0)).ok); };
const list = async (s: StateStore, o?: any): Promise<any> => { const r: any = await s.listKeys(o); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
const drain = async (s: StateStore, o: any = {}) => { const out: string[] = []; let cursor: string | undefined; let pages = 0;
  do { const r = await list(s, { ...o, ...(cursor ? { cursor } : {}) }); out.push(...r.keys); cursor = r.next_cursor; pages++; assert.ok(r.keys.length <= (o.limit ?? 50)); } while (cursor);
  return { out, pages }; };
const sorted = (a: string[]) => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

for (const [name, make] of factories) {
  test(`${name}: empty store and no-match prefix return empty pages without next_cursor`, async () => {
    const s = await make();
    assert.deepEqual(await list(s), { keys: [] });
    await seed(s);
    assert.deepEqual(await list(s, { prefix: "nomatch" }), { keys: [] });
    await s.close();
  });
  test(`${name}: deterministic code-unit ordering and prefix filtering before pagination`, async () => {
    const s = await make(); await seed(s);
    assert.deepEqual((await list(s)).keys, sorted(KEYS));
    assert.deepEqual((await list(s)).keys, ["B", "_u", "a", "a.x", "a:1", "a:10", "a:2", "ab", "b", "z-9"]);
    assert.deepEqual((await list(s, { prefix: "a:" })).keys, ["a:1", "a:10", "a:2"]);
    const p = await list(s, { prefix: "a", limit: 2 });
    assert.deepEqual(p, { keys: ["a", "a.x"], next_cursor: "a.x" });
    assert.deepEqual((await drain(s, { prefix: "a", limit: 2 })).out, ["a", "a.x", "a:1", "a:10", "a:2", "ab"]);
    assert.deepEqual((await list(s, { prefix: "" })).keys, sorted(KEYS));
    await s.close();
  });
  test(`${name}: pagination boundaries, exclusive cursor, next_cursor only when more exist`, async () => {
    const s = await make(); await seed(s);
    assert.deepEqual(await list(s, { limit: 10 }), { keys: sorted(KEYS) });
    const nine = await list(s, { limit: 9 }); assert.equal(nine.keys.length, 9); assert.equal(nine.next_cursor, sorted(KEYS)[8]);
    assert.deepEqual(await list(s, { cursor: nine.next_cursor }), { keys: ["z-9"] });
    assert.deepEqual(await list(s, { cursor: "z-9" }), { keys: [] });
    assert.deepEqual((await list(s, { cursor: "a:1" })).keys[0], "a:10"); // exclusive, and cursor need not exist
    assert.deepEqual((await list(s, { cursor: "aa" })).keys[0], "ab");
    for (const limit of [1, 3, 7]) { const d = await drain(s, { limit }); assert.deepEqual(d.out, sorted(KEYS)); assert.equal(d.pages, Math.ceil(KEYS.length / limit)); }
    await s.close();
  });
  test(`${name}: default limit 50 and max 250`, async () => {
    const s = await make();
    const many = Array.from({ length: 260 }, (_, i) => `k${String(i).padStart(3, "0")}`); await seed(s, many);
    const d = await list(s); assert.equal(d.keys.length, DEFAULT_LIST_KEYS_LIMIT); assert.equal(d.next_cursor, "k049");
    const m = await list(s, { limit: MAX_LIST_KEYS_LIMIT }); assert.equal(m.keys.length, 250); assert.equal(m.next_cursor, "k249");
    assert.equal((await drain(s, { limit: 250 })).out.length, 260);
    await s.close();
  });
  test(`${name}: tombstones excluded; recreated keys reappear`, async () => {
    const s = await make(); await seed(s, ["a", "b", "c"]);
    await s.delete("b", 1);
    assert.deepEqual(await list(s), { keys: ["a", "c"] });
    assert.deepEqual(await list(s, { limit: 1, cursor: "a" }), { keys: ["c"] });
    await s.delete("c", 1);
    assert.deepEqual(await list(s, { limit: 1 }), { keys: ["a"] }); // tombstone after page does not produce next_cursor
    await s.put({ key: "b", value: 2 }, 2);
    assert.deepEqual((await list(s)).keys, ["a", "b"]);
    await s.close();
  });
  test(`${name}: invalid options rejected with storage.invalid_input`, async () => {
    const s = await make(); await seed(s, ["a"]);
    for (const o of [{ limit: 0 }, { limit: 251 }, { limit: 1.5 }, { limit: -1 }, { limit: "5" }, { limit: NaN },
      { prefix: "a/b" }, { prefix: "../" }, { prefix: 5 }, { prefix: "x".repeat(257) }, { prefix: "a b" },
      { cursor: "" }, { cursor: "bad key" }, { cursor: 1 }, { extra: 1 }, null, "a", [] ]) {
      const r: any = await s.listKeys(o as any);
      assert.equal(code(r), "storage.invalid_input", JSON.stringify(o)); assert.equal(r.error.is_retryable, false);
    }
    await s.close();
  });
  test(`${name}: results are frozen; listing does not alter store state`, async () => {
    const s = await make(); await seed(s, ["a", "b"]);
    const r = await list(s, { limit: 1 });
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.keys));
    assert.throws(() => (r.keys as string[]).push("x"));
    assert.equal((await s.get("a") as any).value.version, 1);
    assert.deepEqual((await list(s)).keys, ["a", "b"]);
    await s.close();
  });
  test(`${name}: listKeys after close fails`, async () => {
    const s = await make(); await s.close();
    assert.equal(code(await s.listKeys()), "storage.closed");
  });
}

test("adapter parity: identical results for the same operation sequence", async () => {
  const [a, b] = [new InMemoryStateStore(), await SingleProcessFileStore.open({ baseDir: await tempDir() })];
  for (const s of [a, b]) { await seed(s); await s.delete("ab", 1); await s.delete("a:2", 1); await s.put({ key: "a:2", value: 3 }, 2); }
  for (const o of [undefined, { limit: 1 }, { limit: 3, prefix: "a" }, { cursor: "a" }, { prefix: "a:", cursor: "a:1" }, { prefix: "zz" }])
    assert.deepEqual(await a.listKeys(o), await b.listKeys(o), JSON.stringify(o));
  await a.close(); await b.close();
});
test("file store: listing survives restart (tombstones still excluded)", async () => {
  const dir = await tempDir();
  const s = await SingleProcessFileStore.open({ baseDir: dir }); await seed(s, ["x", "y", "z"]); await s.delete("y", 1); await s.close();
  const r = await SingleProcessFileStore.open({ baseDir: dir });
  assert.deepEqual(await list(r), { keys: ["x", "z"] });
  await r.close();
});

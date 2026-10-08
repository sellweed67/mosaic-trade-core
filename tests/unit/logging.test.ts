import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, withLogContext, currentLogContext, redact, scrubString, Secret } from "../../core/index.ts";
import { captureLogger, sleep } from "../helpers.ts";

test("level filtering", () => {
  const out: string[] = []; const l = createLogger({ level: "warn", write: (x) => out.push(x) });
  l.debug("d"); l.info("i"); l.warn("w"); l.error("e");
  assert.deepEqual(out.map((x) => JSON.parse(x).level), ["warn", "error"]);
  assert.equal(l.isEnabled("info"), false);
});
test("trace context propagates across async boundaries and nests", async () => {
  const { logger, lines } = captureLogger();
  await withLogContext({ correlation_id: "c1" as any, request_id: "r1" as any }, async () => {
    await sleep(1);
    logger.info("a");
    await withLogContext({ task_id: "t1" as any }, async () => { await sleep(1); logger.info("b"); });
  });
  logger.info("outside");
  const [a, b, o] = lines();
  assert.equal(a!.correlation_id, "c1"); assert.equal(a!.request_id, "r1");
  assert.equal(b!.task_id, "t1"); assert.equal(b!.correlation_id, "c1");
  assert.equal(o!.correlation_id, undefined); assert.deepEqual(currentLogContext(), {});
});
test("child loggers add base context", () => {
  const { logger, lines } = captureLogger();
  logger.child({ module: "data" }).child({ execution_id: "e1" as any }).info("x");
  assert.equal(lines()[0]!.module, "data"); assert.equal(lines()[0]!.execution_id, "e1");
});
test("automatic secret scrubbing: keys, values, Secret, Errors, message", () => {
  const { logger, lines } = captureLogger();
  logger.info("auth Bearer abc.def.ghi failed", {
    password: "p1", nested: { apiKey: "k1", note: "token=xyz123" }, s: new Secret("s1"),
    err: new Error("got sk-ABCDEFGHIJKLMNOP"), arr: ["AKIAABCDEFGHIJKLMNOP"],
  });
  const raw = JSON.stringify(lines()[0]);
  for (const leaked of ["p1", "k1", "xyz123", "s1", "sk-ABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP", "abc.def.ghi"]) assert.ok(!raw.includes(leaked), leaked);
});
test("redact handles cycles and depth; logger never throws", () => {
  const a: any = { x: 1 }; a.self = a;
  assert.equal((redact(a) as any).self, "[Circular]");
  assert.equal(scrubString("plain"), "plain");
  const l = createLogger({ write: () => { throw new Error("sink down"); } });
  assert.doesNotThrow(() => l.info("x"));
});

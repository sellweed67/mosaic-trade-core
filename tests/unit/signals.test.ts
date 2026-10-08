import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Lifecycle, installSignalHandlers } from "../../core/index.ts";
import { testCtx, sleep } from "../helpers.ts";

test("SIGTERM triggers graceful stop and exit 0; second signal forces exit 1; uninstall removes handlers", async () => {
  const ctx = testCtx(); const src = new EventEmitter(); const exits: number[] = [];
  let stopped = false;
  const lc = new Lifecycle([{ id: "data", owns: [], dependsOn: [], status: "implemented", stop: async () => { await sleep(20); stopped = true; } }], ctx);
  await lc.start();
  const uninstall = installSignalHandlers(lc, { logger: ctx.logger, source: src, exit: (c) => exits.push(c) });
  src.emit("SIGTERM"); src.emit("SIGINT");
  assert.deepEqual(exits, [1]);
  await sleep(50);
  assert.ok(stopped); assert.deepEqual(exits, [1, 0]); assert.equal(lc.state, "stopped");
  uninstall();
  assert.equal(src.listenerCount("SIGTERM") + src.listenerCount("SIGINT"), 0);
});
test("unclean shutdown exits 1", async () => {
  const ctx = testCtx(); const src = new EventEmitter(); const exits: number[] = [];
  const lc = new Lifecycle([{ id: "data", owns: [], dependsOn: [], status: "implemented", stop: () => { throw new Error("x"); } }], ctx);
  await lc.start();
  installSignalHandlers(lc, { logger: ctx.logger, source: src, exit: (c) => exits.push(c) });
  src.emit("SIGINT"); await sleep(20);
  assert.deepEqual(exits, [1]);
});

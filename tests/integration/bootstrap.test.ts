import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { bootstrap, envSecretProvider } from "../../core/index.ts";
import { coreModules } from "../../modules/index.ts";
import { captureLogger } from "../helpers.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const configDir = root + "config/";

test("bootstrap -> start -> ready -> stop with real config and all modules", async () => {
  const { logger, lines } = captureLogger();
  const lc = await bootstrap({ env: { MOSAIC_ENV: "test" }, configDir, modules: coreModules, logger });
  assert.equal(lc.startupOrder[0], "foundation");
  await lc.start(); assert.equal(lc.state, "running");
  assert.equal((await lc.readiness()).ready, true);
  assert.ok((await lc.stop()).clean);
  assert.ok(lines().some((l) => l.msg === "mosaic bootstrap"));
});
test("env overrides apply and invalid overrides fail closed", async () => {
  const silent = captureLogger().logger;
  const lc = await bootstrap({ env: { MOSAIC_ENV: "test", MOSAIC_CONFIG__timeouts__defaultMs: "1234" }, configDir, modules: [], logger: silent });
  await lc.start(); await lc.stop();
  await assert.rejects(bootstrap({ env: { MOSAIC_ENV: "test", MOSAIC_CONFIG__timeouts__defaultMs: "-1" }, configDir, modules: [], logger: silent }), /Invalid configuration/);
  await assert.rejects(bootstrap({ env: { MOSAIC_ENV: "nope" }, configDir, modules: [] }), /fail closed/);
});
test("modules can resolve declared secrets without them appearing in logs", async () => {
  const { logger, lines } = captureLogger();
  const lc = await bootstrap({
    env: { MOSAIC_ENV: "test", MOSAIC_CONFIG__secretRefs__db: "env://MOSAIC_SECRET_DB" }, configDir, logger,
    secrets: envSecretProvider({ MOSAIC_SECRET_DB: "s3cr3t-value" }),
    modules: [{ id: "data", owns: [], dependsOn: [], status: "implemented", init: async (c) => {
      const s = await c.secrets.resolve(c.config.secretRefs.db!);
      c.logger.info("resolved", { secret: s, password: s.reveal() });
    } }],
  });
  await lc.start(); await lc.stop();
  assert.ok(!JSON.stringify(lines()).includes("s3cr3t-value"));
});
test("process: --once boots and exits 0; SIGTERM shuts down gracefully", async () => {
  const run = (args: string[], signal?: NodeJS.Signals) => new Promise<{ code: number | null; out: string }>((res) => {
    const p = spawn(process.execPath, ["apps/mosaic-core/main.ts", ...args], { cwd: root, env: { ...process.env, MOSAIC_ENV: "test" } });
    let out = ""; p.stdout.on("data", (d) => { out += d; if (signal && out.includes("lifecycle running")) p.kill(signal); });
    p.on("exit", (code) => res({ code, out }));
  });
  assert.equal((await run(["--once"])).code, 0);
  const r = await run([], "SIGTERM");
  assert.equal(r.code, 0); assert.ok(r.out.includes("shutdown signal received"));
});

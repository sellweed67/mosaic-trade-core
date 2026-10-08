/**
 * Local development health endpoint (headless, JSON only — not a UI).
 * Exists so the hosting dev supervisor has a process to probe. Not a production API.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { bootstrap, versionInfo } from "../../core/index.ts";
import { coreModules } from "../../modules/index.ts";

const configDir = process.env.MOSAIC_CONFIG_DIR ?? fileURLToPath(new URL("../../config/", import.meta.url));
const lifecycle = await bootstrap({ env: process.env, configDir, modules: coreModules });
await lifecycle.start();

const port = Number(process.env.PORT ?? 8080);
createServer(async (_req, res) => {
  const body = JSON.stringify({ service: "mosaic-core", state: lifecycle.state, version: versionInfo, health: await lifecycle.health() });
  res.writeHead(200, { "content-type": "application/json" }).end(body);
}).listen(port, "0.0.0.0");

const shutdown = async () => { await lifecycle.stop(); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

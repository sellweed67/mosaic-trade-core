/**
 * Local development health endpoint (headless, JSON only — not a UI, not a production API).
 * Exists so the hosting dev supervisor has a long-running process to probe.
 *   GET /health/live  -> 200 | 503
 *   GET /health/ready -> 200 | 503
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { bootstrap, installSignalHandlers, createLogger, versionInfo } from "../../core/index.ts";
import { coreModules } from "../../modules/index.ts";

const configDir = process.env.MOSAIC_CONFIG_DIR ?? fileURLToPath(new URL("../../config/", import.meta.url));
const lifecycle = await bootstrap({ env: process.env, configDir, modules: coreModules });
await lifecycle.start();

const port = Number(process.env.PORT ?? 8080);
const server = createServer(async (req, res) => {
  const send = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (req.url === "/health/live") { const l = lifecycle.liveness(); return send(l.live ? 200 : 503, l); }
  if (req.url === "/health/ready") { const r = await lifecycle.readiness(); return send(r.ready ? 200 : 503, r); }
  return send(200, { service: "mosaic-core", state: lifecycle.state, version: versionInfo, endpoints: ["/health/live", "/health/ready"] });
}).listen(port, "0.0.0.0");

installSignalHandlers(lifecycle, {
  logger: createLogger(), source: process,
  exit: (c) => { server.close(); process.exit(c); },
});

/** Composition root for the Mosaic Core process (headless, no UI). */
import { fileURLToPath } from "node:url";
import { bootstrap } from "../../core/index.ts";
import { coreModules } from "../../modules/index.ts";

const configDir = process.env.MOSAIC_CONFIG_DIR ?? fileURLToPath(new URL("../../config/", import.meta.url));
const lifecycle = await bootstrap({ env: process.env, configDir, modules: coreModules });
await lifecycle.start();
const shutdown = async () => { await lifecycle.stop(); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
if (process.argv.includes("--once")) await shutdown();

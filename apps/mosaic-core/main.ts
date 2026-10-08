/** Composition root for the Mosaic Core process (headless, no UI). */
import { fileURLToPath } from "node:url";
import { bootstrap, installSignalHandlers, createLogger, toMosaicError } from "../../core/index.ts";
import { coreModules } from "../../modules/index.ts";

const configDir = process.env.MOSAIC_CONFIG_DIR ?? fileURLToPath(new URL("../../config/", import.meta.url));
try {
  const lifecycle = await bootstrap({ env: process.env, configDir, modules: coreModules });
  await lifecycle.start();
  if (process.argv.includes("--once")) {
    const r = await lifecycle.stop();
    process.exit(r.clean ? 0 : 1);
  }
  installSignalHandlers(lifecycle, { logger: createLogger(), source: process, exit: (c) => process.exit(c) });
} catch (e) {
  createLogger().error("mosaic failed to start", { error: toMosaicError(e) });
  process.exit(1);
}

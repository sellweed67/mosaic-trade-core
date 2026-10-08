import { resolveEnvironment } from "./environment.ts";
import { loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logging.ts";
import { Lifecycle } from "./lifecycle.ts";
import type { ModuleDescriptor } from "./modules.ts";
import { versionInfo } from "./version.ts";

/** Application bootstrap. Owner: FOUNDATION. Composition happens in apps/, not here. */
export interface BootstrapOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly configDir: string;
  readonly modules: readonly ModuleDescriptor[];
  readonly logger?: Logger;
}
export async function bootstrap(opts: BootstrapOptions): Promise<Lifecycle> {
  const environment = resolveEnvironment(opts.env.MOSAIC_ENV);
  const config = await loadConfig(opts.configDir, environment);
  const logger = opts.logger ?? createLogger();
  logger.log("info", "mosaic bootstrap", { environment, version: versionInfo });
  return new Lifecycle(opts.modules, { config, logger });
}

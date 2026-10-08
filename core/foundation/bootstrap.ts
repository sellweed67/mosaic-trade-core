import { resolveEnvironment } from "./environment.ts";
import { loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logging.ts";
import { Lifecycle } from "./lifecycle.ts";
import type { ModuleDescriptor } from "./modules.ts";
import { envSecretProvider, type SecretProvider } from "./secrets.ts";
import { versionInfo } from "./version.ts";

/** Application bootstrap. Owner: FOUNDATION. The process environment is passed in explicitly; composition happens in apps/. */
export interface BootstrapOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configDir: string;
  readonly modules: readonly ModuleDescriptor[];
  readonly logger?: Logger;
  readonly secrets?: SecretProvider;
}
export async function bootstrap(opts: BootstrapOptions): Promise<Lifecycle> {
  const environment = resolveEnvironment(opts.env.MOSAIC_ENV);
  const config = await loadConfig(opts.configDir, environment, opts.env);
  const logger = opts.logger ?? createLogger({ level: config.logging.level, base: { service: "mosaic-core", environment } });
  const secrets = opts.secrets ?? envSecretProvider(opts.env);
  logger.info("mosaic bootstrap", { version: versionInfo });
  return new Lifecycle(opts.modules, { config, logger, secrets });
}

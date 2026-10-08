import { validateConfig, createLogger, envSecretProvider, type Logger, type ModuleContext, type MosaicConfig } from "../core/index.ts";
export const baseRawConfig = {
  featureFlags: {}, timeouts: { defaultMs: 200, startupMs: 200, shutdownMs: 200 },
  retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 }, resourceLimits: { maxConcurrentTasks: 2 },
  logging: { level: "debug" }, secretRefs: {},
};
export function testConfig(over: Partial<Record<keyof typeof baseRawConfig, unknown>> = {}): MosaicConfig {
  return validateConfig({ ...structuredClone(baseRawConfig), ...over }, "test");
}
export function captureLogger(level: "debug" | "info" = "debug"): { logger: Logger; lines: () => Record<string, any>[] } {
  const raw: string[] = [];
  return { logger: createLogger({ level, write: (l) => raw.push(l) }), lines: () => raw.map((l) => JSON.parse(l)) };
}
export function testCtx(config = testConfig()): ModuleContext & { lines: () => Record<string, any>[] } {
  const { logger, lines } = captureLogger();
  return { config, logger, secrets: envSecretProvider({}), lines };
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

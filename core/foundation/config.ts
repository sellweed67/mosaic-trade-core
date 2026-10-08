import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "./environment.ts";
import type { SecretRef } from "./secrets.ts";

/** Configuration (non-secret, immutable after load). Owner: FOUNDATION. Not runtime state. */
export interface MosaicConfig {
  readonly environment: Environment;
  readonly featureFlags: Readonly<Record<string, boolean>>;
  readonly timeouts: { readonly defaultMs: number; readonly shutdownMs: number };
  readonly retry: { readonly maxAttempts: number; readonly baseDelayMs: number; readonly maxDelayMs: number };
  readonly resourceLimits: { readonly maxConcurrentTasks: number };
  /** Secret references only — never secret values. */
  readonly secretRefs: Readonly<Record<string, SecretRef>>;
}

const SECRET_KEY_PATTERN = /(password|passwd|token|api[_-]?key|secret|credential)/i;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

/** Validates shape and rejects anything resembling an inline secret (fail closed). */
export function validateConfig(raw: unknown, environment: Environment): MosaicConfig {
  const c = raw as Record<string, any>;
  const num = (v: unknown, n: string) => { if (typeof v !== "number" || !(v >= 0)) throw new Error(`Invalid config: ${n}`); return v; };
  const walk = (o: unknown, path: string) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      const p = `${path}.${k}`;
      if (p.startsWith("$.secretRefs.")) {
        if (typeof v !== "string" || !/^(env|vault):\/\//.test(v)) throw new Error(`Invalid secret ref at ${p}`);
        continue;
      }
      if (p !== "$.secretRefs" && SECRET_KEY_PATTERN.test(k)) throw new Error(`Inline secret-like key "${p}" not allowed in configuration; use secretRefs.`);
      walk(v, p);
    }
  };
  walk(c, "$");
  return deepFreeze({
    environment,
    featureFlags: { ...(c.featureFlags ?? {}) },
    timeouts: { defaultMs: num(c.timeouts?.defaultMs, "timeouts.defaultMs"), shutdownMs: num(c.timeouts?.shutdownMs, "timeouts.shutdownMs") },
    retry: { maxAttempts: num(c.retry?.maxAttempts, "retry.maxAttempts"), baseDelayMs: num(c.retry?.baseDelayMs, "retry.baseDelayMs"), maxDelayMs: num(c.retry?.maxDelayMs, "retry.maxDelayMs") },
    resourceLimits: { maxConcurrentTasks: num(c.resourceLimits?.maxConcurrentTasks, "resourceLimits.maxConcurrentTasks") },
    secretRefs: { ...(c.secretRefs ?? {}) },
  });
}

/** Loads config/default.json then optional config/<env>.json (shallow per top-level key). */
export async function loadConfig(dir: string, environment: Environment): Promise<MosaicConfig> {
  const read = async (f: string) => {
    try { return JSON.parse(await readFile(join(dir, f), "utf8")); }
    catch (e: any) { if (e?.code === "ENOENT") return {}; throw e; }
  };
  const base = await read("default.json");
  const overlay = await read(`${environment}.json`);
  return validateConfig({ ...base, ...overlay }, environment);
}

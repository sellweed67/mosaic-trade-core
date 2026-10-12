import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "./environment.ts";
import { isSecretRef, type SecretRef } from "./secrets.ts";
import { SystemError } from "./errors.ts";
import { SENSITIVE_KEY_PATTERN } from "../../contracts/index.ts";
import { LOG_LEVELS, type LogLevel } from "./logging.ts";

/** Configuration (non-secret, deeply frozen after load). Owner: FOUNDATION. Never runtime state. */
export interface MosaicConfig {
  readonly environment: Environment;
  readonly featureFlags: Readonly<Record<string, boolean>>;
  readonly timeouts: { readonly defaultMs: number; readonly startupMs: number; readonly shutdownMs: number };
  readonly retry: { readonly maxAttempts: number; readonly baseDelayMs: number; readonly maxDelayMs: number };
  readonly resourceLimits: { readonly maxConcurrentTasks: number };
  readonly logging: { readonly level: LogLevel };
  /** In-process dispatch bounds (Phase 03). */
  readonly dispatch: { readonly maxInFlight: number; readonly maxDepth: number; readonly handlerTimeoutMs: number; readonly maxIdempotencyEntries: number };
  /** Secret references only — never secret values. */
  readonly secretRefs: Readonly<Record<string, SecretRef>>;
}

type Spec =
  | { readonly t: "int"; readonly min: number; readonly max: number }
  | { readonly t: "bool" }
  | { readonly t: "enum"; readonly values: readonly string[] }
  | { readonly t: "secretRef" }
  | { readonly t: "obj"; readonly fields: Readonly<Record<string, Spec>> }
  | { readonly t: "rec"; readonly value: Spec };

const ms = { t: "int", min: 1, max: 600_000 } as const;
export const CONFIG_SCHEMA: Spec = {
  t: "obj", fields: {
    featureFlags: { t: "rec", value: { t: "bool" } },
    timeouts: { t: "obj", fields: { defaultMs: ms, startupMs: ms, shutdownMs: ms } },
    retry: { t: "obj", fields: { maxAttempts: { t: "int", min: 1, max: 20 }, baseDelayMs: { t: "int", min: 0, max: 600_000 }, maxDelayMs: { t: "int", min: 0, max: 600_000 } } },
    resourceLimits: { t: "obj", fields: { maxConcurrentTasks: { t: "int", min: 1, max: 100_000 } } },
    logging: { t: "obj", fields: { level: { t: "enum", values: LOG_LEVELS } } },
    dispatch: { t: "obj", fields: { maxInFlight: { t: "int", min: 1, max: 10_000 }, maxDepth: { t: "int", min: 1, max: 64 }, handlerTimeoutMs: ms, maxIdempotencyEntries: { t: "int", min: 1, max: 1_000_000 } } },
    secretRefs: { t: "rec", value: { t: "secretRef" } },
  },
};

const SECRET_KEY_PATTERN = SENSITIVE_KEY_PATTERN;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function check(spec: Spec, v: unknown, path: string, issues: string[]): void {
  switch (spec.t) {
    case "int": if (!Number.isInteger(v) || (v as number) < spec.min || (v as number) > spec.max) issues.push(`${path}: expected integer ${spec.min}..${spec.max}`); return;
    case "bool": if (typeof v !== "boolean") issues.push(`${path}: expected boolean`); return;
    case "enum": if (!spec.values.includes(v as string)) issues.push(`${path}: expected one of ${spec.values.join("|")}`); return;
    case "secretRef": if (!isSecretRef(v)) issues.push(`${path}: expected secret reference env://NAME or vault://path`); return;
    case "rec": case "obj": {
      if (!isObj(v)) { issues.push(`${path}: expected object`); return; }
      for (const k of Object.keys(v)) {
        if (FORBIDDEN_KEYS.has(k)) { issues.push(`${path}.${k}: forbidden key`); continue; }
        if (!(path === "$" && k === "secretRefs") && path !== "$.secretRefs" && SECRET_KEY_PATTERN.test(k)) issues.push(`${path}.${k}: secret-like key not allowed in configuration; use secretRefs`);
      }
      if (spec.t === "rec") { for (const [k, x] of Object.entries(v)) check(spec.value, x, `${path}.${k}`, issues); return; }
      for (const k of Object.keys(v)) if (!(k in spec.fields)) issues.push(`${path}.${k}: unknown key`);
      for (const [k, s] of Object.entries(spec.fields)) {
        if (!(k in v)) issues.push(`${path}.${k}: required`); else check(s, v[k], `${path}.${k}`, issues);
      }
    }
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}
function deepMerge(a: unknown, b: unknown): unknown {
  if (!isObj(a) || !isObj(b)) return structuredClone(b);
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) { if (!FORBIDDEN_KEYS.has(k)) out[k] = k in out ? deepMerge(out[k], v) : structuredClone(v); }
  return out;
}

/** Validates against CONFIG_SCHEMA, collects ALL issues, fails closed. */
export function validateConfig(raw: unknown, environment: Environment): MosaicConfig {
  const issues: string[] = [];
  check(CONFIG_SCHEMA, raw, "$", issues);
  if (!issues.length) {
    const r = raw as Record<string, any>;
    if (r.retry.maxDelayMs < r.retry.baseDelayMs) issues.push("$.retry.maxDelayMs: must be >= baseDelayMs");
  }
  if (issues.length) throw new SystemError("config.invalid", "configuration", `Invalid configuration:\n  ${issues.join("\n  ")}`, { details: { issues } });
  return deepFreeze({ environment, ...structuredClone(raw as object) }) as MosaicConfig;
}

export const ENV_OVERRIDE_PREFIX = "MOSAIC_CONFIG__";
/** MOSAIC_CONFIG__timeouts__defaultMs=5000 -> { timeouts: { defaultMs: 5000 } }. Values parsed as JSON, else string. */
export function envOverrides(env: Readonly<Record<string, string | undefined>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith(ENV_OVERRIDE_PREFIX)) continue;
    const path = key.slice(ENV_OVERRIDE_PREFIX.length).split("__");
    if (path.some((p) => !p || FORBIDDEN_KEYS.has(p))) throw new SystemError("config.invalid_override", "configuration", `Invalid config override key: ${key}`);
    const raw = env[key] ?? "";
    let value: unknown; try { value = JSON.parse(raw); } catch { value = raw; }
    let cur = out;
    path.slice(0, -1).forEach((p) => { if (!isObj(cur[p])) cur[p] = {}; cur = cur[p] as Record<string, unknown>; });
    cur[path[path.length - 1]!] = value;
  }
  return out;
}

/** Precedence (low -> high): config/default.json, config/<env>.json, MOSAIC_CONFIG__* env overrides. */
export async function loadConfig(dir: string, environment: Environment, env: Readonly<Record<string, string | undefined>> = {}): Promise<MosaicConfig> {
  const read = async (f: string, required: boolean) => {
    let text: string;
    try { text = await readFile(join(dir, f), "utf8"); }
    catch (e: any) {
      if (e?.code === "ENOENT" && !required) return {};
      throw new SystemError("config.unreadable", "configuration", `Cannot read config file ${f}`, { cause: e });
    }
    try { return JSON.parse(text); } catch (e) { throw new SystemError("config.malformed", "configuration", `Malformed JSON in ${f}`, { cause: e }); }
  };
  const merged = deepMerge(deepMerge(await read("default.json", true), await read(`${environment}.json`, false)), envOverrides(env));
  return validateConfig(merged, environment);
}

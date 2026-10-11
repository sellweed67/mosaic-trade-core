import { AsyncLocalStorage } from "node:async_hooks";
import { SENSITIVE_KEY_PATTERN, scrubSensitive, type TraceContext } from "../../contracts/index.ts";

/**
 * Structured logging boundary. Owner: FOUNDATION (logger API); OBSERVABILITY owns sinks/export later.
 * Trace context propagates through async calls via AsyncLocalStorage. This holds per-call context,
 * not shared mutable application state.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogContext = TraceContext & Readonly<Record<string, unknown>>;
const contextStore = new AsyncLocalStorage<LogContext>();
export function withLogContext<T>(ctx: LogContext, fn: () => T): T { return contextStore.run({ ...contextStore.getStore(), ...ctx }, fn); }
export function currentLogContext(): LogContext { return contextStore.getStore() ?? {}; }

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  isEnabled(level: LogLevel): boolean;
  child(ctx: LogContext): Logger;
}

const SECRET_KEY = SENSITIVE_KEY_PATTERN;
/** Scrubs secret-looking substrings. Delegates to the canonical contracts/sensitive.ts definition. */
export function scrubString(s: string): string { return scrubSensitive(s); }
/** Deep-copies a value with secret keys and secret-looking strings redacted. Handles cycles and Errors. */
export function redact(v: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof v === "string") return scrubString(v);
  if (typeof v === "bigint") return v.toString();
  if (v === null || typeof v !== "object") return typeof v === "function" ? "[Function]" : v;
  if (depth > 8) return "[Truncated]";
  if (seen.has(v)) return "[Circular]";
  seen.add(v);
  if (v instanceof Error) {
    const e = v as Error & { code?: unknown; category?: unknown };
    return { name: e.name, message: scrubString(e.message), ...(e.code !== undefined ? { code: e.code } : {}), ...(e.category !== undefined ? { category: e.category } : {}) };
  }
  if (typeof (v as { toJSON?: unknown }).toJSON === "function") return redact((v as { toJSON(): unknown }).toJSON(), depth + 1, seen);
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1, seen));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : redact(x, depth + 1, seen)]));
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly write?: (line: string) => void;
  readonly base?: LogContext;
  readonly clock?: () => Date;
}
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const write = opts.write ?? ((l: string) => { process.stdout.write(l + "\n"); });
  const base = opts.base ?? {};
  const clock = opts.clock ?? (() => new Date());
  const isEnabled = (l: LogLevel) => RANK[l] >= RANK[level];
  const log = (l: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    if (!isEnabled(l)) return;
    const body = redact({ ...currentLogContext(), ...base, ...fields }) as Record<string, unknown>;
    try { write(JSON.stringify({ ts: clock().toISOString(), level: l, msg: scrubString(msg), ...body })); } catch { /* logging must never crash callers */ }
  };
  return {
    log, isEnabled,
    debug: (m, f) => log("debug", m, f), info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f), error: (m, f) => log("error", m, f),
    child: (ctx) => createLogger({ level, write, clock, base: { ...base, ...ctx } }),
  };
}

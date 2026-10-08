import type { TraceContext } from "../../contracts/index.ts";
/** Logging boundary. Owner: OBSERVABILITY (sink); FOUNDATION provides this minimal structured logger. */
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  child(ctx: TraceContext & Record<string, unknown>): Logger;
}
const REDACT = /(password|passwd|token|api[_-]?key|secret|credential|authorization)/i;
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (typeof (v as any).toJSON === "function") return (v as any).toJSON();
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, REDACT.test(k) ? "[REDACTED]" : redact(x, depth + 1)]));
}
export function createLogger(write: (line: string) => void = (l) => process.stdout.write(l + "\n"), base: Record<string, unknown> = {}): Logger {
  return {
    log(level, msg, fields = {}) {
      write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact({ ...base, ...fields }) as object) }));
    },
    child(ctx) { return createLogger(write, { ...base, ...ctx }); },
  };
}

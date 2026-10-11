/**
 * Shared, dependency-free contract validation primitives. Owner: contracts.
 * Issues record WHERE and WHICH rule failed, never the offending value, so validation
 * errors can't leak secrets.
 */
import { mosaicError, type MosaicError } from "./error.ts";
import { err, type Result } from "./result.ts";
import { containsSensitiveValue } from "./sensitive.ts";

export interface ContractIssue { readonly path: string; readonly rule: string; }

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
export function isIsoTimestamp(v: unknown): v is string { return typeof v === "string" && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)); }

export function checkAllowedKeys(o: Record<string, unknown>, allowed: readonly string[], path: string, issues: ContractIssue[]): void {
  for (const k of Object.keys(o)) {
    if (FORBIDDEN_KEYS.has(k)) issues.push({ path: `${path}.${k}`, rule: "forbidden_key" });
    else if (!allowed.includes(k)) issues.push({ path: `${path}.${k}`, rule: "unknown_field" });
  }
}
export function checkEnum<T extends string>(v: unknown, values: readonly T[], path: string, issues: ContractIssue[]): v is T {
  if (typeof v === "string" && (values as readonly string[]).includes(v)) return true;
  issues.push({ path, rule: v === undefined ? "required" : "invalid_enum" });
  return false;
}
export function checkInt(v: unknown, min: number, max: number, path: string, issues: ContractIssue[]): v is number {
  if (Number.isInteger(v) && (v as number) >= min && (v as number) <= max) return true;
  issues.push({ path, rule: v === undefined ? "required" : `integer_${min}_${max}` });
  return false;
}
export function checkString(v: unknown, pattern: RegExp, path: string, issues: ContractIssue[], rule = "invalid_format"): v is string {
  if (typeof v === "string" && pattern.test(v)) return true;
  issues.push({ path, rule: v === undefined ? "required" : rule });
  return false;
}

/** JSON-safe value check (no undefined, functions, bigint, symbols, cycles, class instances, non-finite numbers). */
export function checkJsonSafe(v: unknown, path: string, issues: ContractIssue[], opts: { readonly scanSensitive: boolean; readonly maxDepth: number }, depth = 0, seen: WeakSet<object> = new WeakSet()): void {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "string") { if (opts.scanSensitive && containsSensitiveValue(v)) issues.push({ path, rule: "sensitive_value" }); return; }
  if (typeof v === "number") { if (!Number.isFinite(v)) issues.push({ path, rule: "non_finite_number" }); return; }
  if (typeof v !== "object") { issues.push({ path, rule: "non_json_value" }); return; }
  if (depth >= opts.maxDepth) { issues.push({ path, rule: "max_depth_exceeded" }); return; }
  if (seen.has(v)) { issues.push({ path, rule: "circular_reference" }); return; }
  seen.add(v);
  if (Array.isArray(v)) { v.forEach((x, i) => checkJsonSafe(x, `${path}[${i}]`, issues, opts, depth + 1, seen)); }
  else if (!isPlainObject(v)) issues.push({ path, rule: "non_json_value" });
  else for (const [k, x] of Object.entries(v)) {
    if (FORBIDDEN_KEYS.has(k)) issues.push({ path: `${path}.${k}`, rule: "forbidden_key" });
    else checkJsonSafe(x, `${path}.${k}`, issues, opts, depth + 1, seen);
  }
  seen.delete(v);
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}
/** Builds a deterministic contract_violation failure. Issues are sorted for stable output. */
export function contractFailure(code: string, subject: string, issues: readonly ContractIssue[]): MosaicError {
  const sorted = [...issues].sort((a, b) => (a.path === b.path ? a.rule.localeCompare(b.rule) : a.path.localeCompare(b.path)));
  return mosaicError(code, "contract_violation", `${subject} is invalid (${sorted.length} issue${sorted.length === 1 ? "" : "s"})`, { details: { issues: sorted } });
}
export function fail(code: string, subject: string, issues: readonly ContractIssue[]): Result<never> {
  return err(contractFailure(code, subject, issues));
}

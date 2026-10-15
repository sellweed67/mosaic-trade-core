/**
 * Canonical fingerprint (Phase 04 Stage 2, Increment 2.2). Owner: CORE RUNTIME.
 * Mosaic Deterministic JSON Serialization (MDJS v1) + SHA-256 over a fixed preimage envelope.
 *
 * TRUST BOUNDARY: input is inspected by reflection (Reflect.ownKeys, property descriptors, prototypes).
 * A hostile in-process Proxy can run trap code during that reflection and can answer differently
 * on each trap call, so this module cannot defend against it. Callers that need isolation must
 * first cross a serialization/clone boundary (for example JSON or structuredClone done by a trusted party).
 * Proxies with no hostile traps are treated like their targets.
 */
import { createHash } from "node:crypto";
import type { ContractVersion, EndpointRef, MessageType } from "../../contracts/index.ts";
import { ContractError } from "../foundation/errors.ts";

export const MDJS_VERSION = "mdjs-v1";

const invalid = (path: string, rule: string): never => {
  throw new ContractError("contract.invalid_payload", "contract_violation", `Payload is not canonicalizable at ${path}: ${rule}`, { details: { path, rule } });
};

function escapeString(s: string, path: string): string {
  let out = "\"";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (n < 0xdc00 || n > 0xdfff) invalid(path, "lone_surrogate");
      out += s[i]! + s[i + 1]!; i++; continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) invalid(path, "lone_surrogate");
    switch (c) {
      case 0x22: out += "\\\""; break;
      case 0x5c: out += "\\\\"; break;
      case 0x08: out += "\\b"; break;
      case 0x0c: out += "\\f"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0d: out += "\\r"; break;
      case 0x09: out += "\\t"; break;
      default: out += c < 0x20 ? "\\u" + c.toString(16).toUpperCase().padStart(4, "0") : s[i]!;
    }
  }
  return out + "\"";
}

function serializeNumber(v: number, path: string): string {
  if (!Number.isFinite(v)) return invalid(path, "non_finite_number");
  if (Number.isInteger(v) && (v < Number.MIN_SAFE_INTEGER || v > Number.MAX_SAFE_INTEGER)) return invalid(path, "unsafe_integer");
  if (Object.is(v, -0)) return "0";
  // ECMAScript Number::toString is the RFC 8785 (JCS 3.2.2.3) number form: lowercase "e", shortest round-trip.
  return String(v);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function ser(v: unknown, path: string, stack: Set<object>): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean": return v ? "true" : "false";
    case "string": return escapeString(v, path);
    case "number": return serializeNumber(v, path);
    case "undefined": case "function": case "symbol": case "bigint": return invalid(path, `unsupported_${typeof v}`);
  }
  const o = v as object;
  if (stack.has(o)) return invalid(path, "circular_reference");
  const isArr = Array.isArray(o);
  const proto = Object.getPrototypeOf(o);
  if (isArr ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid(path, "class_instance");
  stack.add(o);
  try {
    const keys = Reflect.ownKeys(o);
    const strKeys: string[] = [];
    for (const k of keys) {
      if (typeof k === "symbol") return invalid(path, "symbol_key");
      if (isArr && k === "length") continue;
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (!d) return invalid(`${path}.${k}`, "unstable_property");
      if (d.get !== undefined || d.set !== undefined || !("value" in d)) return invalid(`${path}.${k}`, "accessor_property");
      if (!d.enumerable) return invalid(`${path}.${k}`, "non_enumerable_property");
      strKeys.push(k);
    }
    if (isArr) {
      const a = o as unknown[];
      if (strKeys.length !== a.length) {
        for (let i = 0; i < a.length; i++) if (!Object.prototype.hasOwnProperty.call(a, i)) return invalid(`${path}[${i}]`, "sparse_array");
        return invalid(path, "array_extra_property");
      }
      const parts: string[] = [];
      for (let i = 0; i < a.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(a, i)) return invalid(`${path}[${i}]`, "sparse_array");
        parts.push(ser(a[i], `${path}[${i}]`, stack));
      }
      return "[" + parts.join(",") + "]";
    }
    strKeys.sort(cmp);
    const rec = o as Record<string, unknown>;
    return "{" + strKeys.map((k) => escapeString(k, `${path}.<key>`) + ":" + ser(rec[k], `${path}.${k}`, stack)).join(",") + "}";
  } finally { stack.delete(o); }
}

/** MDJS v1 canonical string. Throws ContractError(contract.invalid_payload) for anything unsupported (fail closed). */
export function canonicalize(value: unknown): string { return ser(value, "$", new Set()); }

export interface FingerprintInput {
  readonly contract_version: ContractVersion;
  readonly destination: EndpointRef;
  readonly message_type: MessageType;
  readonly payload: unknown;
}

/** Exact preimage: {"contract_version":..,"destination":..,"message_type":..,"payload":..} in MDJS v1. */
export function fingerprintPreimage(input: FingerprintInput): string {
  if (input === null || typeof input !== "object") invalid("$", "expected_object");
  return canonicalize({
    contract_version: input.contract_version, destination: input.destination,
    message_type: input.message_type, payload: input.payload,
  });
}

/** Lowercase hex SHA-256 of the UTF-8 preimage. */
export function computeFingerprint(input: FingerprintInput): string {
  return createHash("sha256").update(Buffer.from(fingerprintPreimage(input), "utf8")).digest("hex");
}

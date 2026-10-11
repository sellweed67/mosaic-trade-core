/**
 * Universal message envelope. Owner: contracts. Provider- and transport-neutral.
 * The envelope carries routing and tracing. `payload` carries domain data that the envelope never interprets
 * (except that ERROR payloads must be a MosaicError).
 */
import { CONTRACTS_VERSION, isCompatible, type ContractVersion } from "./version.ts";
import { isIdentifier, newId, type MessageId, type RequestId, type TaskId, type WorkflowId, type ExecutionId, type CorrelationId, type IdempotencyKey } from "./identifiers.ts";
import { ERROR_CATEGORY_KIND, mosaicError, type MosaicError } from "./error.ts";
import { ok, err, type Result } from "./result.ts";
import { collectEndpointRef, type EndpointRef } from "./refs.ts";
import { isSensitiveKey, containsSensitiveValue } from "./sensitive.ts";
import {
  checkAllowedKeys, checkEnum, checkInt, checkJsonSafe, deepFreeze, fail, isIsoTimestamp, isPlainObject, type ContractIssue,
} from "./validation.ts";

export const MESSAGE_TYPES = ["COMMAND", "REQUEST", "RESPONSE", "EVENT", "RESULT", "ERROR"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export type MetadataValue = string | number | boolean | null;
/** Metadata is flat, bounded, non-secret, informational only. It is never read as a control instruction. */
export const METADATA_LIMITS = Object.freeze({ maxEntries: 32, maxStringLength: 1024 });
export const METADATA_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
export const RESERVED_METADATA_PREFIXES: readonly string[] = ["mosaic.", "x-mosaic", "sys.", "control."];
export const MAX_SERIALIZED_ENVELOPE_CHARS = 1_048_576;
export const MAX_PAYLOAD_DEPTH = 32;

export interface MessageEnvelope<P = unknown, T extends MessageType = MessageType> {
  /** Unique ID of this message. Required. Never regenerated during (de)serialization. */
  readonly message_id: MessageId;
  /** Request/response pairing. Required for REQUEST and RESPONSE. */
  readonly request_id?: RequestId;
  readonly task_id?: TaskId;
  readonly workflow_id?: WorkflowId;
  readonly execution_id?: ExecutionId;
  /** Groups every message of one logical operation. Required. */
  readonly correlation_id: CorrelationId;
  /** Deduplication key for side-effecting operations. Required for COMMAND. */
  readonly idempotency_key?: IdempotencyKey;
  readonly source: EndpointRef;
  /** Required for COMMAND, REQUEST and RESPONSE. Optional for EVENT/RESULT/ERROR (broadcast). */
  readonly destination?: EndpointRef;
  readonly message_type: T;
  readonly contract_version: ContractVersion;
  /** ISO-8601 UTC timestamp. */
  readonly created_at: string;
  readonly payload: P;
  readonly metadata: Readonly<Record<string, MetadataValue>>;
}

export type Message<P = unknown> = MessageEnvelope<P>;
export type Command<P = unknown> = MessageEnvelope<P, "COMMAND"> & { readonly destination: EndpointRef; readonly idempotency_key: IdempotencyKey };
export type Request<P = unknown> = MessageEnvelope<P, "REQUEST"> & { readonly destination: EndpointRef; readonly request_id: RequestId };
export type Response<P = unknown> = MessageEnvelope<P, "RESPONSE"> & { readonly destination: EndpointRef; readonly request_id: RequestId };
/** Events describe facts that happened. Events are NOT runtime state. */
export type Event<P = unknown> = MessageEnvelope<P, "EVENT">;
export type ResultMessage<P = unknown> = MessageEnvelope<P, "RESULT">;
export type ErrorMessage = MessageEnvelope<MosaicError, "ERROR">;

const FIELDS = [
  "message_id", "request_id", "task_id", "workflow_id", "execution_id", "correlation_id", "idempotency_key",
  "source", "destination", "message_type", "contract_version", "created_at", "payload", "metadata",
] as const;
const OPTIONAL_IDS = ["request_id", "task_id", "workflow_id", "execution_id", "idempotency_key"] as const;
const ERROR_PAYLOAD_FIELDS = ["code", "kind", "category", "message", "is_retryable", "requires_reconciliation", "correlation_id", "details"];

function collectMetadata(v: unknown, issues: ContractIssue[]): void {
  if (v === undefined) return;
  if (!isPlainObject(v)) { issues.push({ path: "$.metadata", rule: "expected_object" }); return; }
  const entries = Object.entries(v);
  if (entries.length > METADATA_LIMITS.maxEntries) issues.push({ path: "$.metadata", rule: "too_many_entries" });
  for (const [k, x] of entries) {
    const p = `$.metadata.${METADATA_KEY_PATTERN.test(k) ? k : "<invalid-key>"}`;
    if (!METADATA_KEY_PATTERN.test(k)) { issues.push({ path: p, rule: "invalid_key" }); continue; }
    if (RESERVED_METADATA_PREFIXES.some((pre) => k.startsWith(pre)) || (FIELDS as readonly string[]).includes(k)) issues.push({ path: p, rule: "reserved_key" });
    if (isSensitiveKey(k)) issues.push({ path: p, rule: "sensitive_key" });
    if (typeof x === "string") {
      if (x.length > METADATA_LIMITS.maxStringLength) issues.push({ path: p, rule: "value_too_long" });
      if (containsSensitiveValue(x)) issues.push({ path: p, rule: "sensitive_value" });
    } else if (typeof x === "number") { if (!Number.isFinite(x)) issues.push({ path: p, rule: "non_finite_number" }); }
    else if (x !== null && typeof x !== "boolean") issues.push({ path: p, rule: "non_primitive_value" });
  }
}

function collectErrorPayload(v: unknown, issues: ContractIssue[]): void {
  if (!isPlainObject(v)) { issues.push({ path: "$.payload", rule: "expected_error_object" }); return; }
  checkAllowedKeys(v, ERROR_PAYLOAD_FIELDS, "$.payload", issues);
  if (typeof v.code !== "string" || !v.code) issues.push({ path: "$.payload.code", rule: "required" });
  if (typeof v.message !== "string") issues.push({ path: "$.payload.message", rule: "required" });
  if (checkEnum(v.category, Object.keys(ERROR_CATEGORY_KIND), "$.payload.category", issues)) {
    if (v.kind !== ERROR_CATEGORY_KIND[v.category as keyof typeof ERROR_CATEGORY_KIND]) issues.push({ path: "$.payload.kind", rule: "kind_category_mismatch" });
    if (v.category === "unknown_external_state" && v.requires_reconciliation !== true) issues.push({ path: "$.payload.requires_reconciliation", rule: "must_be_true_for_unknown_external_state" });
  }
  for (const f of ["is_retryable", "requires_reconciliation"]) if (typeof v[f] !== "boolean") issues.push({ path: `$.payload.${f}`, rule: "expected_boolean" });
  if (v.requires_reconciliation === true && v.is_retryable === true) issues.push({ path: "$.payload.is_retryable", rule: "must_be_false_when_reconciliation_required" });
}

/**
 * Validates an untrusted value as an envelope. Pure: never mutates input and never fills in missing IDs.
 * On success, returns a deep-frozen copy in canonical field order. Absent optional fields stay absent.
 */
export function validateEnvelope(input: unknown): Result<MessageEnvelope> {
  if (!isPlainObject(input)) return fail("contract.invalid_envelope", "Message envelope", [{ path: "$", rule: "expected_object" }]);
  const issues: ContractIssue[] = [];
  checkAllowedKeys(input, FIELDS, "$", issues);
  for (const f of ["message_id", "correlation_id"] as const) {
    if (input[f] === undefined) issues.push({ path: `$.${f}`, rule: "required" });
    else if (!isIdentifier(input[f])) issues.push({ path: `$.${f}`, rule: "invalid_identifier" });
  }
  for (const f of OPTIONAL_IDS) if (input[f] !== undefined && !isIdentifier(input[f])) issues.push({ path: `$.${f}`, rule: "invalid_identifier" });
  const typeOk = checkEnum(input.message_type, MESSAGE_TYPES, "$.message_type", issues);
  collectEndpointRef(input.source, "$.source", issues);
  if (input.destination !== undefined) collectEndpointRef(input.destination, "$.destination", issues);
  const cv = input.contract_version;
  if (!isPlainObject(cv)) issues.push({ path: "$.contract_version", rule: cv === undefined ? "required" : "expected_object" });
  else { checkAllowedKeys(cv, ["major", "minor"], "$.contract_version", issues); checkInt(cv.major, 0, 65535, "$.contract_version.major", issues); checkInt(cv.minor, 0, 65535, "$.contract_version.minor", issues); }
  if (!isIsoTimestamp(input.created_at)) issues.push({ path: "$.created_at", rule: input.created_at === undefined ? "required" : "invalid_timestamp" });
  if (!("payload" in input) || input.payload === undefined) issues.push({ path: "$.payload", rule: "required" });
  else checkJsonSafe(input.payload, "$.payload", issues, { scanSensitive: true, maxDepth: MAX_PAYLOAD_DEPTH });
  collectMetadata(input.metadata, issues);

  if (typeOk) {
    const t = input.message_type as MessageType;
    const need = (f: string, rule: string) => { if (input[f] === undefined) issues.push({ path: `$.${f}`, rule }); };
    if (t === "COMMAND") { need("destination", "required_for_command"); need("idempotency_key", "required_for_command"); }
    if (t === "REQUEST") { need("destination", "required_for_request"); need("request_id", "required_for_request"); }
    if (t === "RESPONSE") { need("destination", "required_for_response"); need("request_id", "required_for_response"); }
    if (t === "RESULT" && input.task_id === undefined && input.execution_id === undefined) issues.push({ path: "$.task_id", rule: "result_requires_task_or_execution_id" });
    if (t === "ERROR") collectErrorPayload(input.payload, issues);
  }
  if (issues.length) return fail("contract.invalid_envelope", "Message envelope", issues);

  const version = { major: (cv as any).major as number, minor: (cv as any).minor as number };
  if (!isCompatible(CONTRACTS_VERSION, version)) {
    return err(mosaicError("contract.incompatible_version", "incompatible_version",
      `Envelope contract version ${version.major}.${version.minor} is not compatible with ${CONTRACTS_VERSION.major}.${CONTRACTS_VERSION.minor}`));
  }
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (f === "metadata") out.metadata = { ...((input.metadata as object | undefined) ?? {}) };
    else if (f === "contract_version") out.contract_version = version;
    else if (input[f] !== undefined) out[f] = structuredClone(input[f]);
  }
  return ok(deepFreeze(out) as unknown as MessageEnvelope);
}

/** Serializes a (re-validated) envelope to JSON in canonical field order. */
export function serializeEnvelope(envelope: unknown): Result<string> {
  const v = validateEnvelope(envelope);
  return v.ok ? ok(JSON.stringify(v.value)) : v;
}

/** Parses untrusted JSON text into a validated envelope. */
export function parseEnvelope(text: unknown): Result<MessageEnvelope> {
  if (typeof text !== "string") return fail("contract.invalid_envelope", "Message envelope", [{ path: "$", rule: "expected_string" }]);
  if (text.length > MAX_SERIALIZED_ENVELOPE_CHARS) return fail("contract.invalid_envelope", "Message envelope", [{ path: "$", rule: "too_large" }]);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail("contract.invalid_envelope", "Message envelope", [{ path: "$", rule: "malformed_json" }]); }
  return validateEnvelope(parsed);
}

export type EnvelopeInit<P = unknown> =
  Omit<MessageEnvelope<P>, "message_id" | "created_at" | "contract_version" | "metadata"> &
  Partial<Pick<MessageEnvelope<P>, "message_id" | "created_at" | "contract_version" | "metadata">>;

/**
 * Explicit construction helper. It is the ONLY place that generates values, and it only fills message_id,
 * created_at, contract_version (current) and empty metadata when they're absent. Supplied values are kept.
 * correlation_id is never generated. The caller must supply it.
 */
export function createEnvelope<P>(init: EnvelopeInit<P>, now: () => Date = () => new Date()): Result<MessageEnvelope> {
  return validateEnvelope({
    ...init,
    message_id: init.message_id ?? newId<MessageId>(),
    created_at: init.created_at ?? now().toISOString(),
    contract_version: init.contract_version ?? CONTRACTS_VERSION,
    metadata: init.metadata ?? {},
  });
}

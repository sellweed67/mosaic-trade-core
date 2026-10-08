/**
 * Single identifier standard for Mosaic. Owner: contracts.
 * Branded string types prevent mixing identifier kinds. No competing ID systems may exist.
 */
declare const brand: unique symbol;
type Id<K extends string> = string & { readonly [brand]: K };

export type MessageId = Id<"message_id">;
export type RequestId = Id<"request_id">;
export type TaskId = Id<"task_id">;
export type WorkflowId = Id<"workflow_id">;
export type ExecutionId = Id<"execution_id">;
export type CorrelationId = Id<"correlation_id">;
export type IdempotencyKey = Id<"idempotency_key">;

export const IDENTIFIER_NAMES = [
  "message_id", "request_id", "task_id", "workflow_id",
  "execution_id", "correlation_id", "idempotency_key",
] as const;
export type IdentifierName = (typeof IDENTIFIER_NAMES)[number];

/** Trace context every future component must be able to carry. */
export interface TraceContext {
  readonly request_id?: RequestId;
  readonly task_id?: TaskId;
  readonly workflow_id?: WorkflowId;
  readonly execution_id?: ExecutionId;
  readonly correlation_id?: CorrelationId;
}

/** Generation strategy (UUIDv4 via node:crypto) — reversible; may become UUIDv7/ULID in Phase 02. */
export function newId<T extends string>(): T {
  return globalThis.crypto.randomUUID() as T;
}

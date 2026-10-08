/**
 * RESERVED contract placeholders. Location and ownership are fixed here; full shapes are Phase 02.
 * Each type is intentionally minimal and MUST NOT be redefined elsewhere.
 */
import type { MessageId, RequestId, TaskId, WorkflowId, ExecutionId, IdempotencyKey, TraceContext } from "./identifiers.ts";
import type { ContractVersion } from "./version.ts";

interface Envelope extends TraceContext { readonly message_id: MessageId; readonly version: ContractVersion; readonly createdAt: string; }

export interface Message<P = unknown> extends Envelope { readonly kind: string; readonly payload: P; }
export interface Command<P = unknown> extends Message<P> { readonly idempotency_key: IdempotencyKey; }
export interface Request<P = unknown> extends Message<P> { readonly request_id: RequestId; }
export interface Response<P = unknown> extends Message<P> { readonly request_id: RequestId; }
/** Events describe facts that happened. Events are NOT runtime state. */
export interface Event<P = unknown> extends Message<P> { readonly occurredAt: string; }

export interface Resource { readonly resourceId: string; readonly resourceType: string; }
export interface Task { readonly task_id: TaskId; }
export interface Workflow { readonly workflow_id: WorkflowId; }
export interface Execution { readonly execution_id: ExecutionId; }
export type PolicyDecision = "allow" | "deny";
export interface Policy { readonly policyId: string; readonly level: string; }
export interface Approval { readonly approvalId: string; readonly decision: "approved" | "rejected" | "pending"; }
export interface Connector { readonly connectorId: string; readonly version: ContractVersion; }

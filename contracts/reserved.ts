/**
 * RESERVED contract placeholders, still minimal after Phase 02. Location and ownership are fixed here.
 * Message/Command/Request/Response/Event moved to envelope.ts in Phase 02. Policy now uses the canonical PolicyLevel.
 * Each type MUST NOT be redefined elsewhere.
 */
import type { TaskId, WorkflowId, ExecutionId } from "./identifiers.ts";
import type { ContractVersion } from "./version.ts";
import type { PolicyLevel } from "./policy.ts";

export interface Resource { readonly resourceId: string; readonly resourceType: string; }
export interface Task { readonly task_id: TaskId; }
export interface Workflow { readonly workflow_id: WorkflowId; }
export interface Execution { readonly execution_id: ExecutionId; }
export type PolicyDecision = "allow" | "deny";
export interface Policy { readonly policyId: string; readonly level: PolicyLevel; }
export interface Approval { readonly approvalId: string; readonly decision: "approved" | "rejected" | "pending"; }
export interface Connector { readonly connectorId: string; readonly version: ContractVersion; }

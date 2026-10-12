/**
 * Runtime capability table. Concept owner: POLICY & SECURITY ("capability-access-control"). It lives in core
 * because the runtime enforces it and modules may not import one another.
 *
 * Grants come ONLY from the composition root (apps/ via bootstrap options), never from module descriptors.
 * Deny by default. Every decision is expressed as a Phase 02 AuthorizationContext and checked with isAuthorized().
 *
 * LIMITATION: this is an in-process policy check, not a security sandbox. Any code in the same process can
 * bypass it by importing modules directly.
 */
import {
  MESSAGE_TYPES, collectEndpointRef, isAuthorized,
  type AuthorizationContext, type ContractIssue, type EndpointRef, type MessageType,
} from "../../contracts/index.ts";
import { SystemError } from "../foundation/errors.ts";

export interface CapabilityGrant {
  readonly source: EndpointRef;
  readonly destination: string;
  readonly message_types: readonly MessageType[];
}
export const RUNTIME_GRANTOR: EndpointRef = Object.freeze({ kind: "service", id: "runtime.capabilities" });

const keyOf = (s: EndpointRef, dest: string) => `${s.kind}:${s.id}->${dest}`;

export class CapabilityTable {
  readonly #allowed: ReadonlyMap<string, ReadonlySet<MessageType>>;
  constructor(grants: readonly CapabilityGrant[], moduleIds: ReadonlySet<string>) {
    const allowed = new Map<string, Set<MessageType>>();
    grants.forEach((g, i) => {
      const issues: ContractIssue[] = [];
      collectEndpointRef(g?.source, `grants[${i}].source`, issues);
      const bad = (why: string) => new SystemError("capability.invalid_grant", "configuration", `Invalid capability grant #${i}: ${why}`);
      if (issues.length) throw bad("invalid source");
      if (!moduleIds.has(g.destination)) throw bad("unknown destination module");
      if (!Array.isArray(g.message_types) || g.message_types.length === 0) throw bad("message_types must be non-empty");
      if (g.message_types.some((t) => !(MESSAGE_TYPES as readonly string[]).includes(t))) throw bad("unknown message type");
      const k = keyOf(g.source, g.destination);
      if (allowed.has(k)) throw bad("duplicate grant for source/destination");
      allowed.set(k, new Set(g.message_types));
    });
    this.#allowed = allowed;
  }
  get size(): number { return this.#allowed.size; }
  /** Builds the Phase 02 authorization context for this request (granted or denied by the runtime). */
  authorization(source: EndpointRef, destination: string, type: MessageType, now: Date = new Date()): AuthorizationContext {
    const granted = this.#allowed.get(keyOf(source, destination))?.has(type) === true;
    return {
      request: { action: `dispatch.${type.toLowerCase()}`, resource: { type: "module", id: destination }, permission_refs: [] },
      decision: granted
        ? { status: "granted", decided_by: RUNTIME_GRANTOR, decided_at: now.toISOString() }
        : { status: "denied", decided_by: RUNTIME_GRANTOR, decided_at: now.toISOString(), reason_code: "no_grant" },
    };
  }
  allows(source: EndpointRef, destination: string, type: MessageType, now?: Date): boolean {
    return isAuthorized(this.authorization(source, destination, type, now), now);
  }
}

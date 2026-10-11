/** Provider-neutral participant references. Owner: contracts. A reference is a name, not proof of identity. */
import { isIdentifier } from "./identifiers.ts";
import { checkAllowedKeys, checkEnum, checkString, isPlainObject, type ContractIssue } from "./validation.ts";

/** Who sends or receives a message. No vendor, broker or transport is encoded here. */
export const ENDPOINT_KINDS = ["module", "service", "agent", "adapter", "external"] as const;
export type EndpointKind = (typeof ENDPOINT_KINDS)[number];
export interface EndpointRef { readonly kind: EndpointKind; readonly id: string; }

/** Who acts or is acted upon. */
export const PRINCIPAL_KINDS = ["user", "service_account", "agent", "system"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
export interface PrincipalRef { readonly kind: PrincipalKind; readonly id: string; }

/** What is acted upon. `type` is a lowercase namespace such as "workflow" or "dataset". */
export const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
export interface ResourceRef { readonly type: string; readonly id: string; }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function kindIdRef(v: unknown, kinds: readonly string[], path: string, issues: ContractIssue[]): void {
  if (!isPlainObject(v)) { issues.push({ path, rule: v === undefined ? "required" : "expected_object" }); return; }
  checkAllowedKeys(v, ["kind", "id"], path, issues);
  checkEnum(v.kind, kinds, `${path}.kind`, issues);
  if (!isIdentifier(v.id)) issues.push({ path: `${path}.id`, rule: v.id === undefined ? "required" : "invalid_identifier" });
}
export function collectEndpointRef(v: unknown, path: string, issues: ContractIssue[]): void { kindIdRef(v, ENDPOINT_KINDS, path, issues); }
export function collectPrincipalRef(v: unknown, path: string, issues: ContractIssue[]): void { kindIdRef(v, PRINCIPAL_KINDS, path, issues); }
export function collectResourceRef(v: unknown, path: string, issues: ContractIssue[]): void {
  if (!isPlainObject(v)) { issues.push({ path, rule: v === undefined ? "required" : "expected_object" }); return; }
  checkAllowedKeys(v, ["type", "id"], path, issues);
  checkString(v.type, RESOURCE_TYPE_PATTERN, `${path}.type`, issues);
  checkString(v.id, ID, `${path}.id`, issues, "invalid_identifier");
}

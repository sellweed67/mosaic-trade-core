/**
 * Execution context contracts: identity, security, authorization (plus policy/retry/idempotency from
 * their own files). Owner: contracts. TYPES AND VALIDATION ONLY. Nothing here authenticates,
 * authorizes, resolves secrets or calls external systems.
 */
import { collectEndpointRef, collectPrincipalRef, collectResourceRef, type EndpointRef, type PrincipalRef, type ResourceRef } from "./refs.ts";
import { isSecretRef, type SecretRef } from "./secret-ref.ts";
import { containsSensitiveValue } from "./sensitive.ts";
import { collectPolicyContext, type PolicyContext } from "./policy.ts";
import { collectRetryPolicy, type RetryPolicy } from "./retry.ts";
import { collectIdempotencyDescriptor, type IdempotencyDescriptor } from "./idempotency.ts";
import { checkAllowedKeys, checkEnum, checkString, fail, deepFreeze, isIsoTimestamp, isPlainObject, type ContractIssue } from "./validation.ts";
import { ok, type Result } from "./result.ts";

// ---------- identity_context ----------
/**
 * actor = who performs the operation. subject = whose resources/data are affected (may differ, e.g. an agent
 * acting for a user). A reference is a CLAIM: "verified" only records that a named verifier asserted it.
 * Mosaic has no verifier yet, so callers must treat every identity as unauthenticated (see isVerifiedIdentity).
 */
export type IdentityVerification =
  | { readonly status: "unverified" }
  | { readonly status: "verified"; readonly verified_by: EndpointRef; readonly verified_at: string };
export interface IdentityContext {
  readonly actor: PrincipalRef;
  readonly subject?: PrincipalRef;
  readonly verification: IdentityVerification;
}
export function collectIdentityContext(v: unknown, path: string, issues: ContractIssue[]): void {
  if (!isPlainObject(v)) { issues.push({ path, rule: v === undefined ? "required" : "expected_object" }); return; }
  checkAllowedKeys(v, ["actor", "subject", "verification"], path, issues);
  collectPrincipalRef(v.actor, `${path}.actor`, issues);
  if (v.subject !== undefined) collectPrincipalRef(v.subject, `${path}.subject`, issues);
  const ver = v.verification, vp = `${path}.verification`;
  if (!isPlainObject(ver)) { issues.push({ path: vp, rule: ver === undefined ? "required" : "expected_object" }); return; }
  if (checkEnum(ver.status, ["unverified", "verified"] as const, `${vp}.status`, issues)) {
    if (ver.status === "unverified") checkAllowedKeys(ver, ["status"], vp, issues);
    else {
      checkAllowedKeys(ver, ["status", "verified_by", "verified_at"], vp, issues);
      collectEndpointRef(ver.verified_by, `${vp}.verified_by`, issues);
      if (!isIsoTimestamp(ver.verified_at)) issues.push({ path: `${vp}.verified_at`, rule: ver.verified_at === undefined ? "required" : "invalid_timestamp" });
    }
  }
}
/** Fail closed: only a structurally valid "verified" record counts. It is still a claim until a verifier exists. */
export function isVerifiedIdentity(ctx: unknown): boolean {
  const issues: ContractIssue[] = []; collectIdentityContext(ctx, "$", issues);
  return issues.length === 0 && (ctx as IdentityContext).verification.status === "verified";
}

// ---------- security_context ----------
export const TRUST_LEVELS = ["untrusted", "internal", "trusted"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export const SECURITY_FLAGS = ["contains_pii", "elevated_privilege", "break_glass", "dry_run", "sandbox"] as const;
export type SecurityFlag = (typeof SECURITY_FLAGS)[number];
export interface SecurityContext {
  readonly trust_level: TrustLevel;
  readonly flags: readonly SecurityFlag[];
  /** Named references to separately managed secrets. Raw secret values are rejected. */
  readonly credential_refs: Readonly<Record<string, SecretRef>>;
}
const CRED_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export function collectSecurityContext(v: unknown, path: string, issues: ContractIssue[]): void {
  if (!isPlainObject(v)) { issues.push({ path, rule: v === undefined ? "required" : "expected_object" }); return; }
  checkAllowedKeys(v, ["trust_level", "flags", "credential_refs"], path, issues);
  checkEnum(v.trust_level, TRUST_LEVELS, `${path}.trust_level`, issues);
  if (!Array.isArray(v.flags)) issues.push({ path: `${path}.flags`, rule: "expected_array" });
  else {
    if (new Set(v.flags).size !== v.flags.length) issues.push({ path: `${path}.flags`, rule: "duplicate_entries" });
    v.flags.forEach((f, i) => checkEnum(f, SECURITY_FLAGS, `${path}.flags[${i}]`, issues));
  }
  const refs = v.credential_refs;
  if (!isPlainObject(refs)) { issues.push({ path: `${path}.credential_refs`, rule: refs === undefined ? "required" : "expected_object" }); return; }
  for (const [k, ref] of Object.entries(refs)) {
    const p = `${path}.credential_refs.${CRED_NAME.test(k) ? k : "<invalid-key>"}`;
    if (!CRED_NAME.test(k)) issues.push({ path: p, rule: "invalid_key" });
    if (typeof ref === "string" && containsSensitiveValue(ref)) issues.push({ path: p, rule: "raw_secret_not_allowed" });
    else if (!isSecretRef(ref)) issues.push({ path: p, rule: "expected_secret_reference" });
  }
}
/** Diagnostic form: keeps trust level, flags and reference NAMES. Reference targets are masked. */
export function toSecurityDiagnostic(ctx: SecurityContext): Readonly<Record<string, unknown>> {
  return {
    trust_level: ctx.trust_level, flags: [...ctx.flags],
    credential_refs: Object.fromEntries(Object.keys(ctx.credential_refs).sort().map((k) => [k, "[REDACTED_REF]"])),
  };
}

// ---------- authorization_context ----------
/** The REQUEST (what is asked) is kept separate from the DECISION (what was decided, by whom). */
export interface AuthorizationRequest {
  readonly action: string;
  readonly resource: ResourceRef;
  readonly permission_refs: readonly string[];
}
export type AuthorizationDecision =
  | { readonly status: "unresolved" }
  | { readonly status: "granted" | "denied"; readonly decided_by: EndpointRef; readonly decided_at: string; readonly expires_at?: string; readonly policy_ref?: string; readonly reason_code?: string };
export interface AuthorizationContext { readonly request: AuthorizationRequest; readonly decision: AuthorizationDecision; }

const ACTION = /^[a-z][a-z0-9_.:-]{0,127}$/;
export function collectAuthorizationContext(v: unknown, path: string, issues: ContractIssue[]): void {
  if (!isPlainObject(v)) { issues.push({ path, rule: v === undefined ? "required" : "expected_object" }); return; }
  checkAllowedKeys(v, ["request", "decision"], path, issues);
  const r = v.request, rp = `${path}.request`;
  if (!isPlainObject(r)) issues.push({ path: rp, rule: r === undefined ? "required" : "expected_object" });
  else {
    checkAllowedKeys(r, ["action", "resource", "permission_refs"], rp, issues);
    checkString(r.action, ACTION, `${rp}.action`, issues);
    collectResourceRef(r.resource, `${rp}.resource`, issues);
    if (!Array.isArray(r.permission_refs)) issues.push({ path: `${rp}.permission_refs`, rule: "expected_array" });
    else r.permission_refs.forEach((p, i) => checkString(p, ACTION, `${rp}.permission_refs[${i}]`, issues));
  }
  const d = v.decision, dp = `${path}.decision`;
  if (!isPlainObject(d)) { issues.push({ path: dp, rule: d === undefined ? "required" : "expected_object" }); return; }
  if (!checkEnum(d.status, ["unresolved", "granted", "denied"] as const, `${dp}.status`, issues)) return;
  if (d.status === "unresolved") { checkAllowedKeys(d, ["status"], dp, issues); return; }
  checkAllowedKeys(d, ["status", "decided_by", "decided_at", "expires_at", "policy_ref", "reason_code"], dp, issues);
  collectEndpointRef(d.decided_by, `${dp}.decided_by`, issues);
  if (!isIsoTimestamp(d.decided_at)) issues.push({ path: `${dp}.decided_at`, rule: d.decided_at === undefined ? "required" : "invalid_timestamp" });
  if (d.expires_at !== undefined && !isIsoTimestamp(d.expires_at)) issues.push({ path: `${dp}.expires_at`, rule: "invalid_timestamp" });
  for (const f of ["policy_ref", "reason_code"]) if (d[f] !== undefined) checkString(d[f], ACTION, `${dp}.${f}`, issues);
}
/**
 * FAIL CLOSED. True only for a structurally valid context with an explicit, unexpired "granted" decision.
 * Missing, malformed, unresolved, denied or expired all return false. This is a contract-level guard, not an authorization service.
 */
export function isAuthorized(ctx: unknown, now: Date = new Date()): boolean {
  const issues: ContractIssue[] = []; collectAuthorizationContext(ctx, "$", issues);
  if (issues.length) return false;
  const d = (ctx as AuthorizationContext).decision;
  if (d.status !== "granted") return false;
  return d.expires_at === undefined || Date.parse(d.expires_at) > now.getTime();
}

// ---------- execution context bundle ----------
/** Context that travels with an operation. Kept apart from the envelope and from the business payload. */
export interface ExecutionContext {
  readonly identity: IdentityContext;
  readonly security: SecurityContext;
  readonly policy: PolicyContext;
  readonly authorization?: AuthorizationContext;
  readonly retry?: RetryPolicy;
  readonly idempotency?: IdempotencyDescriptor;
}
export function validateExecutionContext(v: unknown): Result<ExecutionContext> {
  const issues: ContractIssue[] = [];
  if (!isPlainObject(v)) return fail("contract.invalid_context", "Execution context", [{ path: "$", rule: "expected_object" }]);
  checkAllowedKeys(v, ["identity", "security", "policy", "authorization", "retry", "idempotency"], "$", issues);
  collectIdentityContext(v.identity, "$.identity", issues);
  collectSecurityContext(v.security, "$.security", issues);
  collectPolicyContext(v.policy, "$.policy", issues);
  if (v.authorization !== undefined) collectAuthorizationContext(v.authorization, "$.authorization", issues);
  if (v.retry !== undefined) collectRetryPolicy(v.retry, "$.retry", issues);
  if (v.idempotency !== undefined) collectIdempotencyDescriptor(v.idempotency, "$.idempotency", issues);
  return issues.length ? fail("contract.invalid_context", "Execution context", issues) : ok(deepFreeze(structuredClone(v as unknown as ExecutionContext)));
}
const single = <T>(collect: (v: unknown, p: string, i: ContractIssue[]) => void, code: string, subject: string) => (v: unknown): Result<T> => {
  const issues: ContractIssue[] = []; collect(v, "$", issues);
  return issues.length ? fail(code, subject, issues) : ok(deepFreeze(structuredClone(v as T)));
};
export const validateIdentityContext = single<IdentityContext>(collectIdentityContext, "contract.invalid_context", "Identity context");
export const validateSecurityContext = single<SecurityContext>(collectSecurityContext, "contract.invalid_context", "Security context");
export const validateAuthorizationContext = single<AuthorizationContext>(collectAuthorizationContext, "contract.invalid_context", "Authorization context");

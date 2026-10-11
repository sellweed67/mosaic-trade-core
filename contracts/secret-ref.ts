/**
 * Secret REFERENCE contract. Owner: contracts (moved from core in Phase 02; core re-exports it).
 * A reference names separately managed secret material. It is never the secret itself.
 */
export type SecretRef = `env://${string}` | `vault://${string}`;
export const SECRET_REF_PATTERN = /^(env|vault):\/\/[A-Za-z0-9_./-]+$/;
export function isSecretRef(v: unknown): v is SecretRef { return typeof v === "string" && SECRET_REF_PATTERN.test(v); }

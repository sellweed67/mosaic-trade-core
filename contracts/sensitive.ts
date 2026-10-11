/**
 * Canonical sensitive-data detection. Owner: contracts. Used by the envelope and context validators
 * and by core logging/config, so there's one definition of what counts as secret-looking.
 * Detection is best-effort defence in depth, not a guarantee.
 */
export const SENSITIVE_KEY_PATTERN = /(pass(word|wd)?|token|api[_-]?key|secret|credential|authorization|cookie|private[_-]?key)/i;

/** Patterns for raw secret VALUES. A capture group 1, when present, is a prefix kept during scrubbing. */
export const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  /((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s&,;"']+/i,
];

export function isSensitiveKey(key: string): boolean { return SENSITIVE_KEY_PATTERN.test(key); }
export function containsSensitiveValue(s: string): boolean { return SENSITIVE_VALUE_PATTERNS.some((p) => p.test(s)); }
export function scrubSensitive(s: string): string {
  let out = s;
  for (const p of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"), (_m, g1) => (typeof g1 === "string" ? `${g1}[REDACTED]` : "[REDACTED]"));
  }
  return out;
}

/** Canonical error model. Owner: contracts. Implementation details: Phase 02. */
export type ErrorCategory =
  | "configuration" | "validation" | "policy_denied" | "security"
  | "timeout" | "unavailable" | "conflict" | "incompatible_version"
  | "unknown_external_state" | "internal";

export interface MosaicError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  /** Whether a retry is permitted. Unknown external state is never retryable before reconciliation. */
  readonly retryable: boolean;
  readonly correlation_id?: string;
  readonly cause?: unknown;
}

export function mosaicError(
  code: string, category: ErrorCategory, message: string,
  extra: { retryable?: boolean; correlation_id?: string; cause?: unknown } = {},
): MosaicError {
  const retryable = category === "unknown_external_state" ? false : (extra.retryable ?? false);
  return Object.freeze({ code, category, message, ...extra, retryable });
}

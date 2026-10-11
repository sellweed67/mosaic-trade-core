/** Canonical error model. Owner: contracts. Kind is derived from category (single source of truth). */
export type ErrorKind = "domain" | "system" | "contract";

export const ERROR_CATEGORY_KIND = {
  validation: "domain", policy_denied: "domain", conflict: "domain", not_found: "domain",
  configuration: "system", security: "system", timeout: "system", unavailable: "system",
  unknown_external_state: "system", internal: "system",
  incompatible_version: "contract", contract_violation: "contract",
} as const satisfies Record<string, ErrorKind>;
export type ErrorCategory = keyof typeof ERROR_CATEGORY_KIND;

export interface MosaicError {
  readonly code: string;
  readonly kind: ErrorKind;
  readonly category: ErrorCategory;
  readonly message: string;
  /** Whether an automatic retry is permitted. */
  readonly is_retryable: boolean;
  /** External state is unknown: must be reconciled before any retry. Implies is_retryable=false. */
  readonly requires_reconciliation: boolean;
  readonly correlation_id?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export interface ErrorExtra {
  readonly retryable?: boolean;
  readonly requires_reconciliation?: boolean;
  readonly correlation_id?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCategory> = new Set(["timeout", "unavailable"]);
/** Categories that may never be retried automatically (fail closed). */
const NEVER_RETRY: ReadonlySet<ErrorCategory> = new Set(["policy_denied", "security", "incompatible_version", "contract_violation", "unknown_external_state", "configuration"]);

/** True for categories that must never be retried automatically. */
export function isRetryForbiddenCategory(category: ErrorCategory): boolean { return NEVER_RETRY.has(category); }

export function mosaicError(code: string, category: ErrorCategory, message: string, extra: ErrorExtra = {}): MosaicError {
  const requires_reconciliation = category === "unknown_external_state" || extra.requires_reconciliation === true;
  const is_retryable = requires_reconciliation || NEVER_RETRY.has(category) ? false : (extra.retryable ?? RETRYABLE_BY_DEFAULT.has(category));
  return Object.freeze({
    code, kind: ERROR_CATEGORY_KIND[category], category, message, is_retryable, requires_reconciliation,
    ...(extra.correlation_id !== undefined ? { correlation_id: extra.correlation_id } : {}),
    ...(extra.details !== undefined ? { details: extra.details } : {}),
    ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
  });
}

export function isMosaicError(v: unknown): v is MosaicError {
  return !!v && typeof v === "object" && "code" in v && "kind" in v && "category" in v && "is_retryable" in v;
}

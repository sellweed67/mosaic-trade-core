import {
  mosaicError, isMosaicError, ERROR_CATEGORY_KIND,
  type MosaicError, type ErrorKind, type ErrorCategory, type ErrorExtra,
} from "../../contracts/index.ts";

/** Error hierarchy. Owner: FOUNDATION. Throwable form of the MosaicError contract. */
type CategoryOf<K extends ErrorKind> = { [C in ErrorCategory]: (typeof ERROR_CATEGORY_KIND)[C] extends K ? C : never }[ErrorCategory];

export class MosaicFault extends Error implements MosaicError {
  readonly code: string;
  readonly kind: ErrorKind;
  readonly category: ErrorCategory;
  readonly is_retryable: boolean;
  readonly requires_reconciliation: boolean;
  readonly correlation_id?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(e: MosaicError) {
    super(e.message, e.cause === undefined ? undefined : { cause: e.cause });
    this.name = new.target.name;
    this.code = e.code; this.kind = e.kind; this.category = e.category;
    this.is_retryable = e.is_retryable; this.requires_reconciliation = e.requires_reconciliation;
    if (e.correlation_id !== undefined) this.correlation_id = e.correlation_id;
    if (e.details !== undefined) this.details = e.details;
  }
  /** Serializable contract form (no stack, no cause object). */
  toJSON(): MosaicError {
    return mosaicError(this.code, this.category, this.message, {
      retryable: this.is_retryable, requires_reconciliation: this.requires_reconciliation,
      ...(this.correlation_id !== undefined ? { correlation_id: this.correlation_id } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    });
  }
}
export class DomainError extends MosaicFault {
  constructor(code: string, category: CategoryOf<"domain">, message: string, extra?: ErrorExtra) { super(mosaicError(code, category, message, extra)); }
}
export class SystemError extends MosaicFault {
  constructor(code: string, category: CategoryOf<"system">, message: string, extra?: ErrorExtra) { super(mosaicError(code, category, message, extra)); }
}
export class ContractError extends MosaicFault {
  constructor(code: string, category: CategoryOf<"contract">, message: string, extra?: ErrorExtra) { super(mosaicError(code, category, message, extra)); }
}

/** Normalizes any throwable into the canonical contract. Unknown throwables become non-retryable internal errors. */
export function toMosaicError(e: unknown): MosaicError {
  if (e instanceof MosaicFault) return e.toJSON();
  if (isMosaicError(e)) return e;
  return mosaicError("internal.unhandled", "internal", e instanceof Error ? e.message : String(e), { cause: e });
}
/** Throwable form of any error (preserves existing faults). */
export function toFault(e: unknown): MosaicFault {
  return e instanceof MosaicFault ? e : new MosaicFault(toMosaicError(e));
}

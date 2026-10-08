import type { MosaicError } from "./error.ts";
/** Result contract. Owner: contracts. */
export type Result<T, E = MosaicError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

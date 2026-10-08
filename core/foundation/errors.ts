import { mosaicError, type MosaicError } from "../../contracts/index.ts";
/** Error model boundary. Owner: FOUNDATION. Converts unknown throwables to the canonical contract. */
export function toMosaicError(e: unknown): MosaicError {
  if (e && typeof e === "object" && "category" in e && "code" in e) return e as MosaicError;
  return mosaicError("internal.unhandled", "internal", e instanceof Error ? e.message : String(e), { cause: e });
}

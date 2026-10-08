import { SystemError } from "./errors.ts";
/**
 * Lifecycle-internal deadline helper. NOT the general-purpose timeout policy (owned by RELIABILITY);
 * intentionally not exported from core/index.ts.
 */
export async function withDeadline<T>(work: () => Promise<T> | T, ms: number, code: string, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SystemError(code, "timeout", `${label} exceeded ${ms}ms`)), Math.max(0, ms));
  });
  try { return await Promise.race([Promise.resolve().then(work), deadline]); }
  finally { clearTimeout(timer); }
}

import { SystemError } from "./errors.ts";
import { isSecretRef, type SecretRef } from "../../contracts/index.ts";
export { SECRET_REF_PATTERN, isSecretRef, type SecretRef } from "../../contracts/index.ts";
/**
 * Secrets boundary. Owner: POLICY & SECURITY (secret management); the interface lives in FOUNDATION
 * so bootstrap can wire a provider. Configuration holds only REFERENCES, never values.
 */

/** Opaque wrapper: never serializes, stringifies or inspects to its value. */
export class Secret {
  #value: string;
  constructor(value: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  toString(): string { return "[REDACTED]"; }
  toJSON(): string { return "[REDACTED]"; }
  [Symbol.for("nodejs.util.inspect.custom")](): string { return "[REDACTED]"; }
}

export interface SecretProvider { resolve(ref: SecretRef): Promise<Secret>; }

/** Env-backed provider. Only env:// refs with MOSAIC_SECRET_ prefix; everything else fails closed. */
export function envSecretProvider(env: Readonly<Record<string, string | undefined>>): SecretProvider {
  return {
    async resolve(ref) {
      if (!isSecretRef(ref) || !ref.startsWith("env://")) throw new SystemError("secret.unsupported_ref", "security", "Unsupported secret reference scheme");
      const name = ref.slice("env://".length);
      if (!name.startsWith("MOSAIC_SECRET_")) throw new SystemError("secret.forbidden_ref", "security", `Secret env name must start with MOSAIC_SECRET_: ${ref}`);
      const v = env[name];
      if (v === undefined || v === "") throw new SystemError("secret.unavailable", "security", `Secret not available: ${ref}`);
      return new Secret(v);
    },
  };
}

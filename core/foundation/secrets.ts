/**
 * Secrets boundary. Owner: POLICY & SECURITY (secret management); interface lives in FOUNDATION
 * so bootstrap can wire a provider. Configuration holds only REFERENCES, never values.
 */
export type SecretRef = `env://${string}` | `vault://${string}`;

/** Opaque wrapper: never serializes or logs its value. */
export class Secret {
  #value: string;
  constructor(value: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  toString(): string { return "[REDACTED]"; }
  toJSON(): string { return "[REDACTED]"; }
  [Symbol.for("nodejs.util.inspect.custom")](): string { return "[REDACTED]"; }
}

export interface SecretProvider { resolve(ref: SecretRef): Promise<Secret>; }

/** Minimal env-backed provider. Only env:// refs; anything else fails closed. */
export function envSecretProvider(env: NodeJS.ProcessEnv): SecretProvider {
  return {
    async resolve(ref) {
      if (!ref.startsWith("env://")) throw new Error(`Unsupported secret ref scheme: ${ref.split("://")[0]}`);
      const name = ref.slice("env://".length);
      const v = env[name];
      if (v === undefined || v === "") throw new Error(`Secret not available: ${ref}`);
      return new Secret(v);
    },
  };
}

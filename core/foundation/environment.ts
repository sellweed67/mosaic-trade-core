/** Environment identification. Owner: FOUNDATION. Unknown values fail closed. */
export const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
export function resolveEnvironment(raw: string | undefined): Environment {
  const v = raw ?? "development";
  if ((ENVIRONMENTS as readonly string[]).includes(v)) return v as Environment;
  throw new Error(`Unknown MOSAIC_ENV "${v}" — refusing to start (fail closed).`);
}

/** Health contracts. Owner: contracts. Unknown is treated as not healthy (fail closed). */
export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";
export const HEALTH_STATUSES: readonly HealthStatus[] = ["healthy", "degraded", "unhealthy", "unknown"];
export interface HealthReport {
  readonly component: string;
  readonly status: HealthStatus;
  readonly detail?: string;
  readonly checkedAt: string;
}
/** Liveness: is the process able to make progress (should it NOT be restarted)? */
export interface LivenessReport { readonly live: boolean; readonly state: string; readonly checkedAt: string; }
/** Readiness: may this instance accept work right now? */
export interface ReadinessReport { readonly ready: boolean; readonly state: string; readonly checks: readonly HealthReport[]; readonly checkedAt: string; }

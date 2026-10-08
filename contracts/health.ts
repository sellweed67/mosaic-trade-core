/** Health contract. Owner: contracts. Unknown is treated as not healthy (fail closed). */
export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";
export interface HealthReport {
  readonly component: string;
  readonly status: HealthStatus;
  readonly detail?: string;
  readonly checkedAt: string;
}

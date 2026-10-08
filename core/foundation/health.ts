import { HEALTH_STATUSES, type HealthReport } from "../../contracts/index.ts";
/** Health aggregation. Owner: FOUNDATION (aggregation); each module owns its own check. */
export type HealthCheck = () => Promise<HealthReport> | HealthReport;

export async function aggregateHealth(checks: ReadonlyMap<string, HealthCheck>, timeoutMs: number, now: () => Date = () => new Date()): Promise<HealthReport[]> {
  return Promise.all([...checks].map(async ([component, check]): Promise<HealthReport> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<HealthReport>((r) => { timer = setTimeout(() => r({ component, status: "unknown", detail: "timeout", checkedAt: now().toISOString() }), timeoutMs); });
    try {
      const rep = await Promise.race([Promise.resolve().then(check), timeout]);
      if (!HEALTH_STATUSES.includes(rep?.status)) return { component, status: "unknown", detail: "invalid report", checkedAt: now().toISOString() };
      return { ...rep, component };
    } catch (e) {
      return { component, status: "unhealthy", detail: e instanceof Error ? e.message : "error", checkedAt: now().toISOString() };
    } finally { clearTimeout(timer); }
  }));
}
/** Ready only if every check is healthy or degraded. Unknown/unhealthy fail closed. */
export function isReady(reports: readonly HealthReport[]): boolean {
  return reports.every((r) => r.status === "healthy" || r.status === "degraded");
}

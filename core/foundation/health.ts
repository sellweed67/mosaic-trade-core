import type { HealthReport } from "../../contracts/index.ts";
/** Health-check boundary. Owner: FOUNDATION (aggregation); each module owns its own check. */
export type HealthCheck = () => Promise<HealthReport>;
export async function aggregateHealth(checks: ReadonlyMap<string, HealthCheck>, timeoutMs: number): Promise<HealthReport[]> {
  return Promise.all([...checks].map(async ([component, check]) => {
    const timeout = new Promise<HealthReport>((r) => setTimeout(() => r({ component, status: "unknown", detail: "timeout", checkedAt: new Date().toISOString() }), timeoutMs).unref());
    try { return await Promise.race([check(), timeout]); }
    catch (e) { return { component, status: "unhealthy" as const, detail: e instanceof Error ? e.message : "error", checkedAt: new Date().toISOString() }; }
  }));
}

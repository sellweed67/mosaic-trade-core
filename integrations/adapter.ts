import type { Connector, HealthReport, Result, ContractVersion } from "../contracts/index.ts";
/**
 * Universal adapter boundary. Owner: UNIVERSAL INTEGRATION (module) governs registration;
 * concrete adapters live under integrations/<kind>/ in later phases.
 * Reserved kinds — none implemented, no external connections exist.
 */
export const ADAPTER_KINDS = ["rest", "websocket", "webhook", "trading-app", "mt5", "line", "telegram"] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number] | `future:${string}`;

export interface Adapter extends Connector {
  readonly kind: AdapterKind;
  readonly supportedVersions: readonly ContractVersion[];
  connect(): Promise<Result<void>>;
  disconnect(): Promise<void>;
  health(): Promise<HealthReport>;
}

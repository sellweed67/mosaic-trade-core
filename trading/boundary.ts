import type { ContractVersion } from "../contracts/index.ts";
/**
 * Trading boundary. Trading Satellite is EXTERNAL to Mosaic Core.
 * This file may import contracts/ only. Core, modules and integrations must never import trading/.
 * No strategy, signals, risk engine, order execution, MT5 or broker connectivity exists here.
 */
export const TRADING_BOUNDARY_VERSION: ContractVersion = Object.freeze({ major: 0, minor: 0 });

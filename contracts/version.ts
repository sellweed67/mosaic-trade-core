/** Version / Compatibility contract. Owner: contracts. */
export interface ContractVersion { readonly major: number; readonly minor: number; }
/** Incompatible versions must not silently communicate: different major => incompatible. */
export function isCompatible(local: ContractVersion, remote: ContractVersion): boolean {
  return local.major === remote.major && remote.minor <= local.minor;
}
export const CONTRACTS_VERSION: ContractVersion = Object.freeze({ major: 1, minor: 0 });

import { ethers } from "ethers";

// Model selection, never instance admission. Cached Sourcify exact_match source:
// RUETHCashivaToken / NativeWrappable.sol, SHA256
// a665ba60627a530631fb7ffe6eb51278e00a251cb250db185c44d54d2b427668.
// The only immutable is UUPSUpgradeable.__self; bind all its compiler offsets.
export const SELF_BURN_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const SELF_BURN_SELF_OFFSETS = [3825, 3866, 4187] as const;
const IMPLEMENTATION_HASH = "0xc5a4d5044a7d54c1faa502bc825c58649fd05eca7104fa3d3ef4963ab22de810";
const PROXY_HASH = "0xee8a105971995661291a9f284262a87abf2381b3cdc93b2c8fbeffe4cd636dd9";

export function verifySelfBurnProxy(code: string): boolean {
  return /^0x(?:[0-9a-fA-F]{2})+$/.test(code) && ethers.keccak256(code) === PROXY_HASH;
}
export function verifySelfBurnImplementation(code: string, implementation: string): boolean {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return false;
  const bytes = ethers.getBytes(code);
  if (bytes.length !== 13705) return false;
  for (const offset of SELF_BURN_SELF_OFFSETS) {
    if (BigInt(ethers.hexlify(bytes.slice(offset, offset + 32))) !== BigInt(implementation)) return false;
    bytes.fill(0, offset, offset + 32);
  }
  return ethers.keccak256(bytes) === IMPLEMENTATION_HASH;
}

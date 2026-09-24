import { ethers } from "ethers";

// Audited runtime behavior, including immutable bindings. These hashes prove
// code identity; no pool/token address list grants admission.
export const SAT1_HOOK_CODE_HASH = "0x7cbdd344a7f5e33ccdd136b4833010b6a23e423b5d6eb0012dbb683af4781dae";
export const SAT1_TOKEN_CODE_HASH = "0xcdfab929a7eca56a690fbf02929e7fd80c4db4b0337097f7de4a63157a546308";
export const SAT1 = new ethers.Interface([
  "function POOL_MANAGER() view returns (address)",
  "function SAT1_TOKEN() view returns (address)",
  "function GENESIS_BLOCK() view returns (uint256)",
  "function poolInitialized() view returns (bool)",
  "function selfDeprecated() view returns (bool)",
  "function ethCum() view returns (uint256)",
  "function marginalPrice() view returns (uint256)",
  "function totalMintedFair() view returns (uint256)",
  "function minter() view returns (address)",
  "function totalSupply() view returns (uint256)",
]);
export const SAT1_MAX_BUY = 5n * 10n ** 18n;
export const SAT1_FAIR_SUPPLY_CAP = 21_000_000n * 10n ** 18n;
export function sat1Permissions(hook: string): boolean {
  return (BigInt(ethers.getAddress(hook)) & 0x3fffn) === 0x2888n;
}
export function hookDataFor(
  descriptor: { readonly hookModel?: string; readonly hook: string },
  executor: string,
  zeroForOne: boolean,
): string {
  if (descriptor.hookModel !== "sat1") return "0x";
  const buyer = ethers.getAddress(executor);
  // The verified post-entropy Sat1 code uses this field only as a cooldown
  // key, not as a recipient or authenticated caller. Keep buys bound to the
  // executor; give sells a stable, hook-scoped identity (no wallet required).
  // Exact, cache compatibility and execution must all use this same policy.
  const seller = ethers.getAddress(ethers.dataSlice(ethers.solidityPackedKeccak256(
    ["string", "address", "address"],
    ["univ4-fee-hook:sat1:sell:v1", buyer, descriptor.hook],
  ), 12));
  if (seller === buyer || seller === ethers.ZeroAddress) throw new Error("sat1 actor identity collision");
  return ethers.AbiCoder.defaultAbiCoder().encode(["address"], [zeroForOne ? buyer : seller]);
}

import { ethers } from "ethers";

export const GOLDX_INTERFACE = new ethers.Interface([
  "function unit() view returns (uint256)",
  "function mint(address receiver,uint256 amount)",
]);

export const GOLDX_WAD = 10n ** 18n;
export const GOLDX_SAMPLE = 10n ** 18n;

export function goldxQuote(amountIn: bigint, unit: bigint): bigint {
  if (amountIn < 0n) throw new Error("GOLDx amountIn cannot be negative");
  if (unit <= 0n) throw new Error(`GOLDx unit() returned ${unit}`);
  const product = amountIn * unit;
  if (product > (1n << 256n) - 1n) throw new Error("GOLDx multiplication overflow");
  return product / GOLDX_WAD;
}

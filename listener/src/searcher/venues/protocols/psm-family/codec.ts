import { ethers } from "ethers";

export const PSM_INTERFACE = new ethers.Interface([
  "function gem() view returns (address)",
  "function dai() view returns (address)",
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
  "function sellGem(address usr,uint256 gemAmt)",
  "function buyGem(address usr,uint256 gemAmt)",
]);

export const PSM_WAD = 10n ** 18n;
export const PSM_GEM_TO_DAI_SCALE = 10n ** 12n;
export const PSM_CURRENT_SAMPLE = 10n ** 6n;

export function psmSellQuote(
  amountIn: bigint,
  tin: bigint,
  scale: bigint,
): bigint {
  if (amountIn < 0n) throw new Error("PSM amountIn cannot be negative");
  if (tin < 0n || tin > PSM_WAD) {
    throw new Error(`PSM tin returned invalid fee ${tin}`);
  }
  const scaled = amountIn * scale;
  return scaled - scaled * tin / PSM_WAD;
}

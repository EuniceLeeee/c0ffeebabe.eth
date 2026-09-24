import { ethers } from "ethers";

export const PSM_INTERFACE = new ethers.Interface([
  "function gem() view returns (address)",
  "function dai() view returns (address)",
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
  "function pocket() view returns (address)",
  "function to18ConversionFactor() view returns (uint256)",
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
  const max = (1n << 256n) - 1n;
  if (scale <= 0n || scaled > max || scaled * tin > max) {
    throw new Error("PSM scaling or fee multiplication overflow");
  }
  return scaled - scaled * tin / PSM_WAD;
}

/** DssLitePsm buyGem charges scaled gem + floor(scaled gem * tout / WAD).
 * Invert that integer cost, not a spot price, to spend at most amountIn DAI.
 */
export function psmBuyCost(gemAmount: bigint, tout: bigint, scale: bigint): bigint {
  const max = (1n << 256n) - 1n;
  const scaled = gemAmount * scale;
  if (gemAmount < 0n || scale <= 0n || tout < 0n || tout > PSM_WAD ||
    scaled > max || scaled * tout > max) throw new Error("PSM invalid buy amount or fee overflow");
  const cost = scaled + scaled * tout / PSM_WAD;
  if (cost > max) throw new Error("PSM buy cost overflow");
  return cost;
}

export function psmBuyQuote(amountIn: bigint, tout: bigint, scale: bigint): bigint {
  if (amountIn < 0n || amountIn > (1n << 256n) - 1n || scale <= 0n || tout < 0n || tout > PSM_WAD) {
    throw new Error("PSM invalid buy input or fee");
  }
  const gemAmount = ((amountIn + 1n) * PSM_WAD - 1n) / (PSM_WAD + tout) / scale;
  if (psmBuyCost(gemAmount, tout, scale) > amountIn) throw new Error("PSM buy exceeds input");
  return gemAmount;
}

import { ethers } from "ethers";

/**
 * Olympus V3 staking surface owned by this Family.
 *
 * `index()` is the staking contract's OHM-per-gOHM exchange rate with the
 * protocol's 9-decimal INDEX_SCALE (at block 26184922 it returned
 * 269238508004, i.e. 269.238508004 OHM per gOHM). gOHM is an 18-decimal
 * token and OHM is a 9-decimal token, so a gOHM amount in 18-decimal wei
 * converts to OHM wei (9 decimals) as:
 *
 *   OHM wei = floor(gOHM wei * index / 1e18)
 *
 * The landed sample 0x28c9e5f8b41db8e2a0b5653b0a48520307bcafe95d1edf993f6f15e1ea904696
 * burned 1997321805946478 gOHM wei and received 537755943 OHM wei at that
 * block: floor(1997321805946478 * 269238508004 / 1e18) = 537755943.
 * The observed transfer also fixes the divisor: 1e9 (the index scale
 * itself) would produce 537755943 * 1e9 wei and 1e27 would produce zero,
 * so only the 1e18 divisor reproduces the landing. `index` therefore
 * carries 9 decimals while the conversion normalizes 18-decimal gOHM to
 * 9-decimal OHM, which is exactly one 1e18 divisor.
 */
export const OLYMPUS_INTERFACE = new ethers.Interface([
  "function unstake(address recipient,uint256 amount,bool trigger,bool rebasing)",
  "function index() view returns (uint256)",
  "function OHM() view returns (address)",
  "function gOHM() view returns (address)",
]);

export const OLYMPUS_ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

export const OLYMPUS_INDEX_SCALE = 10n ** 18n;
export const OLYMPUS_GOHM_DECIMALS = 18n;
export const OLYMPUS_OHM_DECIMALS = 9n;
/** 1 gOHM (18 decimals) is a price point, not a production amount. */
export const OLYMPUS_SAMPLE = 10n ** 18n;
export const OLYMPUS_UNSTAKE_SELECTOR = OLYMPUS_INTERFACE.getFunction(
  "unstake",
)!.selector;

export function olympusQuote(amountIn: bigint, index: bigint): bigint {
  if (amountIn < 0n) throw new Error("Olympus amountIn cannot be negative");
  if (index <= 0n) throw new Error(`Olympus index() returned ${index}`);
  const product = amountIn * index;
  if (product > (1n << 256n) - 1n) {
    throw new Error("Olympus gOHM/index multiplication overflow");
  }
  return product / OLYMPUS_INDEX_SCALE;
}

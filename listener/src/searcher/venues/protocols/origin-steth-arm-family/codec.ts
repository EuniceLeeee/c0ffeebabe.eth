import { ethers } from "ethers";
import type { AdapterRequest } from "../../adapter-request-program.js";

export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Origin's stETH ARM (Automated Redemption Manager), mainnet.
 *
 * On-chain identity at N=26244681 (verified with block-pinned eth_getCode /
 * eth_getStorageAt against MAINNET_RPC_URL):
 *   proxy address     0x85B78AcA6Deae198fBF201c82DAF6Ca21942acc6
 *   proxy code hash   0x2f2547c03a7df08ab5b52c16c83ce594279bd2f79b39d43008bbf9dee11c7510
 *   EIP-1967 slot     0x360894a1…bbc -> 0x850da2E21F1F71479E2A307EDab114777D9F6217
 *   impl code hash    0x12828de7a5e8dd262821cf306d4f6d3c12d494816316cad5d72cea22f4c5d63d
 *                     (23915 bytes; Sourcify runtime match, solc 0.8.23,
 *                     sources src/contracts/LidoARM.sol + AbstractARM.sol)
 *   stETH code hash   0xb9c1c929064cd21734c102a698e68bf617feefcfa5a9f62407c45401546736bf
 *   WETH  code hash   0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23
 *
 * The verified implementation is a Uniswap-V2-router-compatible two-token
 * liquidity venue. `token0` is WETH and `token1` is stETH (both immutables are
 * fixed in the runtime code). `swapExactTokensForTokens(inToken, outToken,
 * amountIn, amountOutMin, to)` (selector 0x6c08c57e) pulls `amountIn` of the
 * input token from msg.sender via transferFrom and transfers the output token
 * to `to`. The output amount is:
 *
 *   amountOut = convertedAmountIn * price / PRICE_SCALE
 *   PRICE_SCALE = 1e36
 *   price = traderate0 when inToken == token0 (WETH -> stETH)
 *   price = traderate1 when inToken == token1 (stETH -> WETH)
 *   _convert() is the 1:1 default on LidoARM (no override), so convertedAmountIn
 *   equals amountIn for both stETH and WETH.
 *
 * `traderate0`/`traderate1` are the operator-set buy/sell prices in proxy
 * storage slots 50/51 (scaled by 1e36). There is no separate swap fee: the
 * spread is embedded in those two prices, so pricing reads the same storage
 * words the swap will use.
 *
 * Observed sample tx 0x1b6545dd…0f5c: 8589306883606 stETH in ->
 * 8588137580972 WETH out with traderate1 = 999863865309614123000000000000000000
 * at N; floor(8589306883606 * traderate1 / 1e36) = 8588137580972 exactly.
 */
export const ORIGIN_STETH_ARM = "0x85B78AcA6Deae198fBF201c82DAF6Ca21942acc6";
export const ORIGIN_STETH_ARM_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const ORIGIN_STETH_ARM_STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";

export const ORIGIN_STETH_ARM_EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const ORIGIN_STETH_ARM_PROXY_CODE_HASH =
  "0x2f2547c03a7df08ab5b52c16c83ce594279bd2f79b39d43008bbf9dee11c7510";
export const ORIGIN_STETH_ARM_IMPLEMENTATION =
  "0x850da2E21F1F71479E2A307EDab114777D9F6217";
export const ORIGIN_STETH_ARM_IMPLEMENTATION_CODE_HASH =
  "0x12828de7a5e8dd262821cf306d4f6d3c12d494816316cad5d72cea22f4c5d63d";
export const ORIGIN_STETH_ARM_STETH_CODE_HASH =
  "0xb9c1c929064cd21734c102a698e68bf617feefcfa5a9f62407c45401546736bf";
export const ORIGIN_STETH_ARM_WETH_CODE_HASH =
  "0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23";

/** Proxy storage slots (AbstractARM layout): traderate0 = slot 50, traderate1 = 51. */
export const ORIGIN_STETH_ARM_TRADERATE0_SLOT =
  "0x0000000000000000000000000000000000000000000000000000000000000032";
export const ORIGIN_STETH_ARM_TRADERATE1_SLOT =
  "0x0000000000000000000000000000000000000000000000000000000000000033";

/** Both assets are 18-decimal, so 1e36 is the exact ARM price scale. */
export const ORIGIN_STETH_ARM_PRICE_SCALE = 10n ** 36n;
export const ORIGIN_STETH_ARM_PRICE_SAMPLE = 10n ** 18n;
/** Two amounts keep an amount-independent response from passing identity. */
export const ORIGIN_STETH_ARM_BEHAVIOR_SAMPLES = Object.freeze([
  10n ** 12n,
  10n ** 15n,
]);
/** Fixed probe recipient: the payer is the executor, so the swap's `to`
 * argument cannot be a call-time caller reference. A literal probe recipient
 * proves the output-recipient side independently of msg.sender. */
export const ORIGIN_STETH_ARM_PROBE_RECIPIENT =
  "0x0000000000000000000000000000000000000001";

export const ORIGIN_STETH_ARM_INTERFACE = new ethers.Interface([
  "function swapExactTokensForTokens(address inToken,address outToken,uint256 amountIn,uint256 amountOutMin,address to) returns (uint256[] amounts)",
  "function traderate0() view returns (uint256)",
  "function traderate1() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint256 reserve0,uint256 reserve1)",
]);

export const ORIGIN_STETH_ARM_SWAP_SELECTOR =
  ORIGIN_STETH_ARM_INTERFACE.getFunction("swapExactTokensForTokens")!.selector;
export const ORIGIN_STETH_ARM_SWAP_SIGNATURE =
  "swapExactTokensForTokens(address,address,uint256,uint256,address)";

export type OriginStethArmDirection = "steth-to-weth" | "weth-to-steth";

export const ORIGIN_STETH_ARM_DIRECTIONS: readonly OriginStethArmDirection[] =
  Object.freeze(["steth-to-weth", "weth-to-steth"]);

export function originStethArmTokenIn(direction: OriginStethArmDirection): string {
  return direction === "steth-to-weth"
    ? ORIGIN_STETH_ARM_STETH
    : ORIGIN_STETH_ARM_WETH;
}

export function originStethArmTokenOut(direction: OriginStethArmDirection): string {
  return direction === "steth-to-weth"
    ? ORIGIN_STETH_ARM_WETH
    : ORIGIN_STETH_ARM_STETH;
}

/** Rate slot that the verified swap implementation reads for this direction. */
export function originStethArmRateSlot(
  direction: OriginStethArmDirection,
): string {
  return direction === "steth-to-weth"
    ? ORIGIN_STETH_ARM_TRADERATE1_SLOT
    : ORIGIN_STETH_ARM_TRADERATE0_SLOT;
}

export function originStethArmRateGetter(
  direction: OriginStethArmDirection,
): "traderate0" | "traderate1" {
  return direction === "steth-to-weth" ? "traderate1" : "traderate0";
}

/** Upper sanity bound: setPrices keeps the sell rate at or below 1e36 and the
 * cross price at or above 0.998e36, so both rates stay below 2e36. This is a
 * malformed-state guard, not a fee assumption. */
export const ORIGIN_STETH_ARM_MAX_RATE = 2n * ORIGIN_STETH_ARM_PRICE_SCALE;

/**
 * Exact swap output of the verified implementation:
 *   floor(amountIn * rate / 1e36)
 * Solidity's checked arithmetic reverts when `convertedAmountIn * price`
 * overflows uint256, so the quote refuses the same amounts.
 */
export function originStethArmQuote(amountIn: bigint, rate: bigint): bigint {
  if (amountIn < 0n) {
    throw new Error("Origin stETH ARM amountIn cannot be negative");
  }
  if (rate <= 0n || rate > ORIGIN_STETH_ARM_MAX_RATE) {
    throw new Error(`Origin stETH ARM rate is outside the supported range: ${rate}`);
  }
  if (amountIn > MAX_UINT256 / rate) {
    throw new Error("Origin stETH ARM amountIn * rate overflows uint256");
  }
  return amountIn * rate / ORIGIN_STETH_ARM_PRICE_SCALE;
}

export function storageRequest(
  id: string,
  address: string,
  slot: string,
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "get-storage" as const,
    address: ethers.getAddress(address),
    slot,
  });
}

/** Decode one block-pinned storage word as uint256. */
export function storageWordToUint(data: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(data)) {
    throw new Error("Origin stETH ARM storage word is malformed");
  }
  return BigInt(data);
}

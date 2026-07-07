import { ethers } from "ethers";
import { TOPICS, lower } from "../registry/protocols.js";
import { hexToBigInt } from "../rpc/client.js";
import type { SwapDirection } from "./victim-source.js";

export interface DecodedSwap {
  txHash: string;
  index: number;
  logIndex: number;
  direction: SwapDirection;
  poolId: string;
  sizeRaw: bigint;
}

const V2_SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);
const V3_SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const V4_SWAP_IFACE = new ethers.Interface([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const CURVE_SWAP_IFACE = new ethers.Interface([
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)",
  "event TokenExchangeUnderlying(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)",
]);
const BALANCER_V2_SWAP_IFACE = new ethers.Interface([
  "event Swap(bytes32 indexed poolId, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
]);

export function decodeAnySwapLog(log: any): DecodedSwap | null {
  const topic = lower(String(log?.topics?.[0] ?? ""));
  if (topic === lower(TOPICS.univ2Swap)) return v2SwapFromLog(log);
  if (topic === lower(TOPICS.univ3Swap)) return v3SwapFromLog(log);
  if (topic === lower(TOPICS.univ4Swap)) return v4SwapFromLog(log);
  if (topic === lower(TOPICS.curveTokenExchange)) return curveSwapFromLog(log);
  if (topic === lower(TOPICS.curveTokenExchangeUnderlying)) return curveSwapFromLog(log);
  if (topic === lower(TOPICS.balancerV2Swap)) return balancerV2SwapFromLog(log);
  return null;
}

export function v2SwapFromLog(log: any): DecodedSwap | null {
  const base = baseSwapFields(log, lower(String(log?.address ?? "")));
  if (!base) return null;
  try {
    const parsed = V2_SWAP_IFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
    if (!parsed) return null;
    const amount0In = toBigInt(parsed.args[1]);
    const amount1In = toBigInt(parsed.args[2]);
    const amount0Out = toBigInt(parsed.args[3]);
    const amount1Out = toBigInt(parsed.args[4]);
    const direction = v2Direction(amount0In, amount1In, amount0Out, amount1Out);
    if (!direction) return null;
    return {
      ...base,
      direction,
      sizeRaw: amount0In + amount1In + amount0Out + amount1Out,
    };
  } catch {
    return null;
  }
}

export function v3SwapFromLog(log: any): DecodedSwap | null {
  const base = baseSwapFields(log, lower(String(log?.address ?? "")));
  if (!base) return null;
  try {
    const parsed = V3_SWAP_IFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
    if (!parsed) return null;
    const amount0 = toBigInt(parsed.args[2]);
    const amount1 = toBigInt(parsed.args[3]);
    const direction = signedDirection(amount0, amount1);
    if (!direction) return null;
    return {
      ...base,
      direction,
      sizeRaw: abs(amount0) + abs(amount1),
    };
  } catch {
    return null;
  }
}

export function v4SwapFromLog(log: any): DecodedSwap | null {
  try {
    const parsed = V4_SWAP_IFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
    if (!parsed) return null;
    const poolId = lower(String(parsed.args[0]));
    const base = baseSwapFields(log, poolId);
    if (!base) return null;
    const amount0 = toBigInt(parsed.args[2]);
    const amount1 = toBigInt(parsed.args[3]);
    const direction = signedDirection(amount0, amount1);
    if (!direction) return null;
    return {
      ...base,
      direction,
      sizeRaw: abs(amount0) + abs(amount1),
    };
  } catch {
    return null;
  }
}

export interface V4SwapFill {
  poolId: string;
  logIndex: number;
  amount0: bigint; // signed BalanceDelta from the swapper's view: negative = paid in, positive = received
  amount1: bigint;
  zeroForOne: boolean; // token0 in, token1 out
}

/**
 * Signed per-side v4 fill from a PoolManager Swap log — the real amountIn/amountOut the competitor
 * moved through the pool. (v4SwapFromLog collapses this to a lossy sizeRaw for direction/matching;
 * loss-attribution and quote-fidelity reconciliation need the actual signed amounts.)
 */
export function v4SwapFillFromLog(log: any): V4SwapFill | null {
  try {
    const parsed = V4_SWAP_IFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
    if (!parsed) return null;
    const poolId = lower(String(parsed.args[0]));
    const amount0 = toBigInt(parsed.args[2]);
    const amount1 = toBigInt(parsed.args[3]);
    if (amount0 === 0n && amount1 === 0n) return null;
    // Swapper receives token0 (amount0 > 0) and pays token1 => oneForZero; else zeroForOne.
    const zeroForOne = amount0 < 0n;
    return {
      poolId,
      logIndex: quantityToNumber(log?.logIndex) ?? 0,
      amount0,
      amount1,
      zeroForOne,
    };
  } catch {
    return null;
  }
}

export function curveSwapFromLog(log: any): DecodedSwap | null {
  const base = baseSwapFields(log, lower(String(log?.address ?? "")));
  if (!base) return null;
  try {
    const parsed = CURVE_SWAP_IFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
    if (!parsed) return null;
    const soldId = toBigInt(parsed.args[1]);
    const tokensSold = toBigInt(parsed.args[2]);
    const boughtId = toBigInt(parsed.args[3]);
    const tokensBought = toBigInt(parsed.args[4]);
    // Direction convention: sold_id < bought_id => "0for1", otherwise "1for0".
    // Multi-token caveat: for Curve pools with >2 coins and Balancer weighted pools,
    // binary 0for1/1for0 is a lossy convention. It is deterministic and stable
    // (so opposite-direction matching still works pairwise), and the primary
    // downstream consumer (the C1c tx-shape classifier) uses swap presence on a
    // shared pool, not precise direction. Do not extend DecodedSwap with token
    // indices in this slice.
    const direction = soldId < boughtId ? "0for1" : "1for0";
    return {
      ...base,
      direction,
      sizeRaw: tokensSold + tokensBought,
    };
  } catch {
    return null;
  }
}

export function balancerV2SwapFromLog(log: any): DecodedSwap | null {
  try {
    const parsed = BALANCER_V2_SWAP_IFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
    if (!parsed) return null;
    const poolId = lower(String(parsed.args[0]));
    const base = baseSwapFields(log, poolId);
    if (!base) return null;
    const tokenIn = lower(String(parsed.args[1]));
    const tokenOut = lower(String(parsed.args[2]));
    const amountIn = toBigInt(parsed.args[3]);
    const amountOut = toBigInt(parsed.args[4]);
    // Direction convention: tokenIn.toLowerCase() < tokenOut.toLowerCase() => "0for1",
    // otherwise "1for0". For multi-token caveat, see Curve decoder above.
    const direction = tokenIn < tokenOut ? "0for1" : "1for0";
    return {
      ...base,
      direction,
      sizeRaw: amountIn + amountOut,
    };
  } catch {
    return null;
  }
}

function baseSwapFields(log: any, poolId: string): Omit<DecodedSwap, "direction" | "sizeRaw"> | null {
  const txHash = lower(String(log?.transactionHash ?? ""));
  const index = quantityToNumber(log?.transactionIndex);
  if (!txHash || !poolId || index === null) return null;
  return {
    txHash,
    index,
    logIndex: quantityToNumber(log?.logIndex) ?? 0,
    poolId,
  };
}

function signedDirection(amount0: bigint, amount1: bigint): SwapDirection | null {
  if (amount0 > 0n && amount1 < 0n) return "0for1";
  if (amount0 < 0n && amount1 > 0n) return "1for0";
  return null;
}

function v2Direction(
  amount0In: bigint,
  amount1In: bigint,
  amount0Out: bigint,
  amount1Out: bigint,
): SwapDirection | null {
  if (amount0In > 0n && amount1Out > 0n) return "0for1";
  if (amount1In > 0n && amount0Out > 0n) return "1for0";
  return null;
}

function toBigInt(value: unknown): bigint {
  return BigInt(String(value));
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function quantityToNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string") return null;
  return Number(hexToBigInt(value));
}

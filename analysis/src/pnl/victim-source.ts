import { ethers } from "ethers";
import { TOPICS, lower } from "../registry/protocols.js";
import { hexToBigInt, toQuantity, type RpcClient } from "../rpc/client.js";
import type { SenderFlowResult } from "./sender-flow.js";

export interface VictimSourceResult {
  atomic: boolean;
  source_hash: string | null;
  source_pool: string | null;
  source_index: number | null;
  backrun_index: number;
  source_flow: "public-router" | "private-orderflow" | "none" | "unknown";
  source_flow_confidence: "high" | "med" | "low" | null;
  evidence: string[];
}

export type SwapDirection = "0for1" | "1for0";

export interface BackrunLeg {
  emitter: string;
  swapTopic: string;
  direction: SwapDirection;
  poolId: string;
}

interface DecodedSwap {
  txHash: string;
  index: number;
  logIndex: number;
  direction: SwapDirection;
  poolId: string;
  sizeRaw: bigint;
}

interface BestSource {
  pool: string;
  prior: DecodedSwap;
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

export async function findVictimSource(
  rpc: RpcClient,
  backrun: {
    hash: string;
    transactionIndex: number;
    blockNumber: number;
    legs: BackrunLeg[];
  },
  classifySourceFlow: (sourceTxHash: string) => Promise<SenderFlowResult>,
): Promise<VictimSourceResult> {
  let best: BestSource | null = null;

  for (const leg of backrun.legs) {
    const pool = lower(leg.poolId);
    const poolSwaps = await rpc.getLogs({
      address: leg.emitter,
      topics: [leg.swapTopic],
      fromBlock: toQuantity(backrun.blockNumber),
      toBlock: toQuantity(backrun.blockNumber),
    });
    const wantedDirection = opposite(leg.direction);
    for (const log of poolSwaps) {
      const decoded = decodeSwapLog(log, leg.swapTopic);
      if (!decoded) continue;
      if (decoded.poolId !== pool) continue;
      if (decoded.index >= backrun.transactionIndex) continue;
      if (decoded.direction !== wantedDirection) continue;
      if (best === null || isBetterSource(decoded, best.prior)) {
        best = { pool, prior: decoded };
      }
    }
  }

  if (best === null) {
    return {
      atomic: true,
      source_hash: null,
      source_pool: null,
      source_index: null,
      backrun_index: backrun.transactionIndex,
      source_flow: "none",
      source_flow_confidence: null,
      evidence: ["no_preceding_opposite_swap"],
    };
  }

  const sourceFlow = await classifySourceFlow(best.prior.txHash);
  return {
    atomic: false,
    source_hash: best.prior.txHash,
    source_pool: best.pool,
    source_index: best.prior.index,
    backrun_index: backrun.transactionIndex,
    source_flow: classifyVictimSourceFlow(sourceFlow),
    source_flow_confidence: sourceFlow.confidence,
    evidence: ["nearest_preceding_opposite_dir_same_pool", ...sourceFlow.evidence],
  };
}

function classifyVictimSourceFlow(sourceFlow: SenderFlowResult): VictimSourceResult["source_flow"] {
  if (sourceFlow.flow === "public" && sourceFlow.signals.dest_is_public_router) return "public-router";
  if (sourceFlow.flow === "private") return "private-orderflow";
  return "unknown";
}

function isBetterSource(candidate: DecodedSwap, current: DecodedSwap): boolean {
  if (candidate.index !== current.index) return candidate.index > current.index;
  return candidate.sizeRaw > current.sizeRaw;
}

function opposite(direction: SwapDirection): SwapDirection {
  return direction === "0for1" ? "1for0" : "0for1";
}

function decodeSwapLog(log: any, swapTopic: string): DecodedSwap | null {
  const topic = lower(String(log?.topics?.[0] ?? swapTopic));
  if (topic === lower(TOPICS.univ2Swap)) return v2SwapFromLog(log);
  if (topic === lower(TOPICS.univ3Swap)) return v3SwapFromLog(log);
  if (topic === lower(TOPICS.univ4Swap)) return v4SwapFromLog(log);
  return null;
}

function v2SwapFromLog(log: any): DecodedSwap | null {
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

function v3SwapFromLog(log: any): DecodedSwap | null {
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

function v4SwapFromLog(log: any): DecodedSwap | null {
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

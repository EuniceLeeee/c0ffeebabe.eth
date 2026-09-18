import { ethers } from "ethers";
import type {
  ObservedSwapImpact,
  SwapEventLog,
  SwapObservationCapability,
} from "../../swap-observation.js";
import {
  canonicalAddress,
  CURVE_METAREGISTRY,
  CURVE_UNDERLYING_I128_SWAP_TOPIC,
  CURVE_UNDERLYING_UINT_SWAP_TOPIC,
  CURVE_UNDERLYING_META_INTERFACE,
} from "./codec.js";

const topics = [CURVE_UNDERLYING_I128_SWAP_TOPIC, CURVE_UNDERLYING_UINT_SWAP_TOPIC];
const coder = ethers.AbiCoder.defaultAbiCoder();

function decodeSwap(log: SwapEventLog) {
  const topic = log.topics[0]?.toLowerCase();
  if (!topics.includes(topic) || log.topics.length !== 2 ||
      !ethers.isHexString(log.data, 128) || !ethers.isHexString(log.topics[1], 32)) {
    throw new Error("curve-underlying malformed swap log");
  }
  const buyer = coder.decode(["address"], log.topics[1]);
  if (coder.encode(["address"], buyer).toLowerCase() !== log.topics[1].toLowerCase()) {
    throw new Error("curve-underlying noncanonical indexed buyer");
  }
  const indexType = topic === CURVE_UNDERLYING_I128_SWAP_TOPIC ? "int128" : "uint256";
  const types = [indexType, "uint256", indexType, "uint256"];
  const decoded = coder.decode(types, log.data);
  if (coder.encode(types, decoded).toLowerCase() !== log.data.toLowerCase()) {
    throw new Error("curve-underlying noncanonical swap data");
  }
  const [i, amountIn, j, amountOut] = decoded as unknown as readonly bigint[];
  if (i < 0n || i >= 8n || j < 0n || j >= 8n || i === j || amountIn <= 0n || amountOut <= 0n) {
    throw new Error("curve-underlying invalid swap indices or amounts");
  }
  return { pool: canonicalAddress(log.address), i: Number(i), j: Number(j), amountIn, amountOut };
}

// Preserve the registry's indices. Compacting holes or deduplicating coins
// would change their meaning and could select the wrong admitted direction.
function decodeCoins(data: string): readonly string[] {
  if (!ethers.isHexString(data, 8 * 32)) throw new Error("curve-underlying invalid coin array");
  const decoded = CURVE_UNDERLYING_META_INTERFACE.decodeFunctionResult("get_underlying_coins", data);
  if (CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult("get_underlying_coins", decoded).toLowerCase() !== data.toLowerCase()) {
    throw new Error("curve-underlying noncanonical coin array");
  }
  const coins = Array.from(decoded[0] as readonly string[], canonicalAddress);
  const seen = new Set<string>();
  let ended = false;
  for (const coin of coins) {
    if (coin === ethers.ZeroAddress) { ended = true; continue; }
    const key = coin.toLowerCase();
    if (ended || seen.has(key)) throw new Error("curve-underlying ambiguous coin indices");
    seen.add(key);
  }
  if (seen.size < 2) throw new Error("curve-underlying missing underlying coins");
  return coins;
}

export const curveUnderlyingReceiptObservation: SwapObservationCapability = {
  topics,
  canonicalIntakeTargets: [
    "0x99a58482bd75cbab83b27ec03ca68ff489b5788f",
    "0x16c6521dff6bab339122a0fe25a9116693265353",
  ],
  observedPoolIdentity(log) {
    try { return canonicalAddress(log.address).toLowerCase(); } catch { return null; }
  },
  // Calldata remains discovery evidence, not a directional impact. The
  // direct-call context has no query backend/control for a pinned coin read.
  // Do not restore that legacy decoder or infer indices from Graph order.
  async decodeReceiptImpacts(ctx) {
    if (ctx.matchedOwnedTriggers.length === 0) return { status: "no-match" };
    const sourceBlock = ctx.sourceGeneration.sourceBlock;
    if (!ctx.tokenQuery || sourceBlock === null || !Number.isSafeInteger(sourceBlock) || sourceBlock < 0 ||
        !ethers.isHexString(ctx.sourceGeneration.sourceBlockHash, 32)) {
      return { status: "unresolved", reason: "curve-underlying receipt requires source-bound coin reads" };
    }
    const open = () => {
      if (ctx.control.signal.aborted || !Number.isFinite(ctx.control.deadlineAtMs) ||
          Date.now() >= ctx.control.deadlineAtMs) throw new Error("curve-underlying receipt cancelled");
    };
    try {
      open();
      const ids = new Set<string>(), indexes = new Set<number>();
      // Validate the complete trigger set before any reads or partial output.
      const swaps = ctx.matchedOwnedTriggers.map(trigger => {
        if (!Number.isSafeInteger(trigger.logIndex) || trigger.logIndex < 0 || trigger.logIndex >= ctx.logs.length ||
            ids.has(trigger.triggerId) || indexes.has(trigger.logIndex)) {
          throw new Error("curve-underlying duplicate or invalid owned trigger");
        }
        const log = ctx.logs[trigger.logIndex], swap = decodeSwap(log);
        if (trigger.emitter.toLowerCase() !== swap.pool.toLowerCase() ||
            trigger.topic0.toLowerCase() !== log.topics[0].toLowerCase()) {
          throw new Error("curve-underlying owned trigger mismatch");
        }
        ids.add(trigger.triggerId); indexes.add(trigger.logIndex);
        return { trigger, swap };
      });
      const coinsByPool = new Map<string, readonly string[]>();
      const impacts: ObservedSwapImpact[] = [];
      for (const { trigger, swap } of swaps) {
        open();
        const pool = swap.pool.toLowerCase();
        const edges = ctx.graph.filter(edge => edge.adapterId === "curve-exchange-underlying" &&
          edge.target.toLowerCase() === pool && edge.instanceKey?.toLowerCase() === pool);
        if (edges.length === 0) throw new Error("curve-underlying swap has no admitted pool");
        let coins = coinsByPool.get(pool);
        if (!coins) {
          coins = decodeCoins(await ctx.tokenQuery.call({ to: CURVE_METAREGISTRY,
            data: CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData("get_underlying_coins", [swap.pool]),
            blockTag: sourceBlock }, ctx.control));
          coinsByPool.set(pool, coins);
        }
        open();
        const tokenIn = coins[swap.i], tokenOut = coins[swap.j];
        const matches = edges.filter(edge => edge.tokenIn.toLowerCase() === tokenIn.toLowerCase() &&
          edge.tokenOut.toLowerCase() === tokenOut.toLowerCase());
        if (tokenIn === ethers.ZeroAddress || tokenOut === ethers.ZeroAddress || matches.length !== 1) {
          throw new Error("curve-underlying missing or ambiguous admitted direction");
        }
        const edge = matches[0];
        impacts.push({ logIndex: trigger.logIndex, consumedTriggerIds: [trigger.triggerId], impact: {
          pool: swap.pool, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut,
          amountIn: swap.amountIn, amountOut: swap.amountOut, matchedAdapterId: edge.adapterId,
          sourceGeneration: ctx.sourceGeneration,
        } });
      }
      return { status: "resolved", impacts, mutations: [],
        consumedTriggerIds: [...ids] as [string, ...string[]] };
    } catch (error) {
      return { status: "unresolved", reason: error instanceof Error ? error.message : "curve-underlying coin binding unavailable" };
    }
  },
};

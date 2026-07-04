import { lower } from "../registry/protocols.js";
import { toQuantity, type RpcClient } from "../rpc/client.js";
import type { SenderFlowResult } from "./sender-flow.js";
import { decodeAnySwapLog, type DecodedSwap } from "./swap-log-registry.js";

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

interface BestSource {
  pool: string;
  prior: DecodedSwap;
}

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
  const sourceFlowClass = classifyVictimSourceFlow(sourceFlow);
  return {
    atomic: false,
    source_hash: best.prior.txHash,
    source_pool: best.pool,
    source_index: best.prior.index,
    backrun_index: backrun.transactionIndex,
    source_flow: sourceFlowClass,
    source_flow_confidence: victimSourceFlowConfidence(sourceFlowClass, sourceFlow),
    evidence: ["nearest_preceding_opposite_dir_same_pool", ...sourceFlow.evidence],
  };
}

function classifyVictimSourceFlow(sourceFlow: SenderFlowResult): VictimSourceResult["source_flow"] {
  if (sourceFlow.source_visibility === "seen_by_us" && sourceFlow.signals.dest_is_public_router) {
    return "public-router";
  }
  if (
    sourceFlow.source_visibility === "not_seen_by_us"
    && sourceFlow.submission_method === "bundle"
    && sourceFlow.signals.dest_has_code
    && !sourceFlow.signals.dest_is_public_router
  ) {
    return "private-orderflow";
  }
  return "unknown";
}

function victimSourceFlowConfidence(
  sourceFlowClass: VictimSourceResult["source_flow"],
  sourceFlow: SenderFlowResult,
): VictimSourceResult["source_flow_confidence"] {
  if (sourceFlowClass === "public-router") return sourceFlow.confidence;
  if (sourceFlowClass === "private-orderflow") return "low";
  return "low";
}

function isBetterSource(candidate: DecodedSwap, current: DecodedSwap): boolean {
  if (candidate.index !== current.index) return candidate.index > current.index;
  return candidate.sizeRaw > current.sizeRaw;
}

function opposite(direction: SwapDirection): SwapDirection {
  return direction === "0for1" ? "1for0" : "0for1";
}

function decodeSwapLog(log: any, _swapTopic: string): DecodedSwap | null {
  return decodeAnySwapLog(log);
}

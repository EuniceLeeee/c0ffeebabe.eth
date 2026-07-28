import { lower } from "../registry/protocols.js";
import { hexToNumber, type RpcClient } from "../rpc/client.js";
import type { SenderFlowResult } from "./sender-flow.js";
import { decodeAnySwapLog } from "./swap-log-registry.js";
import { findVictimSource, type BackrunLeg } from "./victim-source.js";

export type TxSourceShape = "victim" | "blockscan";

export async function classifyTransactionSource(
  rpc: RpcClient,
  txHash: string,
): Promise<TxSourceShape> {
  if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error(`invalid transaction hash: ${txHash}`);

  const receipt = await rpc.getReceipt(txHash);
  if (!receipt) throw new Error(`transaction receipt not found: ${txHash}`);
  if (hexToNumber(receipt.status) !== 1) throw new Error(`transaction reverted: ${txHash}`);

  const blockNumber = hexToNumber(receipt.blockNumber);
  const transactionIndex = hexToNumber(receipt.transactionIndex);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const legs = distinctBackrunLegs(logs);
  if (legs.length === 0) {
    throw new Error(`transaction has no recognized swap legs: ${txHash}`);
  }

  const source = await findVictimSource(rpc, {
    hash: lower(txHash),
    transactionIndex,
    blockNumber,
    legs,
  }, unknownSourceFlow);
  return source.atomic ? "blockscan" : "victim";
}

function distinctBackrunLegs(logs: any[]): BackrunLeg[] {
  const legs: BackrunLeg[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    const decoded = decodeAnySwapLog(log);
    const emitter = lower(String(log?.address ?? ""));
    const swapTopic = lower(String(log?.topics?.[0] ?? ""));
    if (!decoded || !emitter || !swapTopic) continue;
    const key = `${emitter}:${swapTopic}:${decoded.poolId}:${decoded.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    legs.push({
      emitter,
      swapTopic,
      direction: decoded.direction,
      poolId: decoded.poolId,
    });
  }
  return legs;
}

async function unknownSourceFlow(): Promise<SenderFlowResult> {
  return {
    submission_method: "unknown",
    source_visibility: "unknown",
    confidence: "low",
    evidence: ["source_flow_not_requested"],
    signals: {
      coinbase_transfer_wei: "0",
      priority_tip_wei: "0",
      max_priority_fee_per_gas_wei: "0",
      seen_in_our_public_feed: null,
      dest_is_public_router: false,
      dest_has_code: false,
      builder: "",
    },
  };
}

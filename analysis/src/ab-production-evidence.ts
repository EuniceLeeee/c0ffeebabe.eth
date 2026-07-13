import { classifyWinnerTxStyle } from "./cli/bundle-postmortem.js";
import type { AbExperiment } from "./ab-canary.js";
import { fetchEthUsd, priceArb } from "./pnl/arb-profit.js";
import { classifyTxShape, type RawLog } from "./pnl/tx-shape.js";
import { deriveEdgeKindsFromLogs } from "./learning/edge-kinds.js";
import { hexToBigInt, RpcClient } from "./rpc/client.js";
import { lower } from "./registry/protocols.js";

export interface ProductionSampleObservation {
  tx_hash: string;
  block_number: number;
  source_shape: "atomic_state_arb" | "backrun" | "unknown";
  winner_style: string;
  net_profit_usd: number | null;
  arb_pools: string[];
  edge_kinds: string[];
}

/** Recompute the sample classification from the local archive node at deploy time. This prevents a
 * report from relabelling a backrun (or a fake tx hash) as a standing-state atomic sample. */
export async function verifyOnchainProductionSample(
  experiment: AbExperiment,
  rpcUrl: string,
): Promise<{ errors: string[]; observation?: ProductionSampleObservation }> {
  const errors: string[] = [];
  const sample = experiment.production_evidence?.sample;
  if (!sample) return { errors: ["production sample missing"] };

  const rpc = new RpcClient(rpcUrl);
  const [tx, receipt] = await Promise.all([
    rpc.getTransaction(sample.tx_hash),
    rpc.getReceipt(sample.tx_hash),
  ]);
  if (!tx || !receipt) return { errors: ["production sample is not present on the configured archive node"] };
  const blockNumber = Number(hexToBigInt(receipt.blockNumber));
  if (Number(hexToBigInt(receipt.status)) !== 1) errors.push("production sample receipt status is not successful");
  if (blockNumber !== sample.block_number) errors.push("production sample block_number disagrees with the receipt");

  const block = await rpc.getBlockByNumber(blockNumber, true);
  const receipts = await rpc.call<Record<string, any>[]>("eth_getBlockReceipts", [receipt.blockNumber]);
  const transactions = Array.isArray(block?.transactions) ? block.transactions : [];
  const transactionByHash = new Map<string, Record<string, any>>(
    transactions
      .filter((entry: unknown): entry is Record<string, any> => typeof entry === "object" && entry !== null)
      .map((entry: Record<string, any>) => [lower(String(entry.hash ?? "")), entry]),
  );
  const sameActorTxHashes = transactions
    .filter((entry: unknown): entry is Record<string, any> => typeof entry === "object" && entry !== null)
    .filter((entry: Record<string, any>) => lower(String(entry.from ?? "")) === lower(String(tx.from ?? "")))
    .map((entry: Record<string, any>) => lower(String(entry.hash ?? "")));
  const allLogs = receipts.flatMap((entry) => rawLogs(entry, transactionByHash));
  const receiptLogs = rawLogs(receipt, transactionByHash);
  const transactionIndex = Number(hexToBigInt(receipt.transactionIndex));
  const shape = classifyTxShape({
    receiptLogs,
    txIndex: transactionIndex,
    sameBlockSwapLogs: allLogs,
    sameActorTxHashes,
  });
  if (shape.arb_pools.length === 0) errors.push("production sample has no DEX swap pool recognized by the canonical classifier");
  if (shape.shape !== "atomic_state_arb") {
    errors.push(`production sample source shape is ${shape.shape}; current B scope requires victim-independent atomic_state_arb`);
  }
  const edgeKinds = deriveEdgeKindsFromLogs(receipt.logs);
  if (!edgeKinds.includes("swap")) errors.push("production sample does not contain a recognized DEX swap edge");
  if (edgeKinds.includes("credit") || edgeKinds.includes("lp")) {
    errors.push(`production sample edge kinds [${edgeKinds.join(",")}] are outside the current no-credit/no-LP scope`);
  }
  if (experiment.production_evidence?.route_scope === "dex-dex" && edgeKinds.includes("protocol")) {
    errors.push("production sample declares dex-dex but canonical logs contain a protocol edge");
  }
  if (experiment.production_evidence?.route_scope === "dex-permissionless-protocol"
      && !edgeKinds.includes("protocol")) {
    errors.push("production sample declares dex-permissionless-protocol but canonical logs contain no protocol edge");
  }

  const ethUsd = await fetchEthUsd(rpc);
  const baseFeePerGas = block?.baseFeePerGas != null ? hexToBigInt(block.baseFeePerGas) : 0n;
  const profit = await priceArb(rpc, sample.tx_hash, tx, receipt, ethUsd, {
    entityActors: [tx?.to, tx?.from].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    allowTrace: true,
    coinbase: lower(String(block?.miner ?? "")),
    baseFeePerGas,
  });
  const style = await classifyWinnerTxStyle({
    rpc,
    txHash: sample.tx_hash,
    tx,
    receipt,
    profit,
    transactionIndex,
    blockNumber,
    prestateBlock: Math.max(0, blockNumber - 1),
    blockTimestamp: block?.timestamp != null ? Number(hexToBigInt(block.timestamp)) : null,
  });
  if (style.winner_style !== "atomic_loop") {
    errors.push(`production sample winner_style is ${style.winner_style}; current B scope requires atomic_loop`);
  }
  if (profit.netProfitUsd === null || profit.netProfitUsd <= 0) {
    errors.push("canonical tx-profit recomputation does not show positive net profit");
  }
  if (profit.profitConfidence === "unsafe" || profit.profitConfidence === "requires_decode") {
    errors.push(`canonical tx-profit confidence ${profit.profitConfidence} is insufficient for B admission`);
  }

  return {
    errors,
    observation: {
      tx_hash: lower(sample.tx_hash),
      block_number: blockNumber,
      source_shape: shape.shape,
      winner_style: style.winner_style,
      net_profit_usd: profit.netProfitUsd,
      arb_pools: shape.arb_pools,
      edge_kinds: edgeKinds,
    },
  };
}

function rawLogs(
  receipt: Record<string, any>,
  transactionByHash: Map<string, Record<string, any>>,
): RawLog[] {
  return (Array.isArray(receipt?.logs) ? receipt.logs : []).map((log: Record<string, any>) => {
    const transactionHash = lower(String(log.transactionHash ?? receipt.transactionHash ?? ""));
    return {
      address: lower(String(log.address ?? "")),
      topics: Array.isArray(log.topics) ? log.topics.map((topic: unknown) => lower(String(topic))) : [],
      data: String(log.data ?? "0x"),
      logIndex: Number(hexToBigInt(log.logIndex)),
      transactionIndex: Number(hexToBigInt(log.transactionIndex ?? receipt.transactionIndex)),
      transactionHash,
      txTo: transactionByHash.get(transactionHash)?.to ?? null,
    };
  });
}

import { decodeAnySwapLog, type DecodedSwap } from "./swap-log-registry.js";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  transactionIndex: number;
  transactionHash: string;
  txTo?: string | null;
}

export interface TxShapeInput {
  receiptLogs: RawLog[];
  txIndex: number;
  sameBlockSwapLogs: RawLog[];
}

export interface TxShapeResult {
  shape: "atomic_state_arb" | "backrun" | "unknown";
  arb_pools: string[];
  source_swap_hash?: string;
  source_router?: string | null;
}

export function classifyTxShape(input: TxShapeInput): TxShapeResult {
  const arbPools = distinctDecodedPoolIds(input.receiptLogs);
  const arbPoolSet = new Set(arbPools);

  const preceding = input.sameBlockSwapLogs
    .map((log) => ({ log, decoded: decodeAnySwapLog(log) }))
    .filter((entry): entry is { log: RawLog; decoded: DecodedSwap } =>
      entry.decoded !== null
      && arbPoolSet.has(entry.decoded.poolId)
      // Strict `<`: same-index swap logs are the arb tx's OWN logs, never a
      // preceding source.
      && entry.decoded.index < input.txIndex)
    .sort((a, b) => a.decoded.index - b.decoded.index);

  const source = preceding[0];
  return {
    shape: preceding.length > 0 ? "backrun" : "atomic_state_arb",
    arb_pools: arbPools,
    source_swap_hash: source?.decoded.txHash,
    source_router: source?.log.txTo?.toLowerCase() ?? null,
  };
}

function distinctDecodedPoolIds(logs: RawLog[]): string[] {
  const poolIds: string[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    const decoded = decodeAnySwapLog(log);
    if (!decoded || seen.has(decoded.poolId)) continue;
    seen.add(decoded.poolId);
    poolIds.push(decoded.poolId);
  }
  return poolIds;
}

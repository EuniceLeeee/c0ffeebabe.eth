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
  /** Hashes owned by the same submitting actor in this block. These swaps are
   *  useful batch context, but they are not an external transaction to backrun. */
  sameActorTxHashes?: Iterable<string>;
}

export interface TxShapeResult {
  shape: "atomic_state_arb" | "backrun" | "unknown";
  arb_pools: string[];
  source_swap_hash?: string;
  source_router?: string | null;
  same_actor_prior_swap_hashes: string[];
}

export function classifyTxShape(input: TxShapeInput): TxShapeResult {
  const arbPools = distinctDecodedPoolIds(input.receiptLogs);
  const arbPoolSet = new Set(arbPools);
  const sameActorTxHashes = new Set(
    [...(input.sameActorTxHashes ?? [])].map((hash) => hash.toLowerCase()),
  );

  const preceding = input.sameBlockSwapLogs
    .map((log) => ({ log, decoded: decodeAnySwapLog(log) }))
    .filter((entry): entry is { log: RawLog; decoded: DecodedSwap } =>
      entry.decoded !== null
      && arbPoolSet.has(entry.decoded.poolId)
      // Strict `<`: same-index swap logs are the arb tx's OWN logs, never a
      // preceding source.
      && entry.decoded.index < input.txIndex)
    .sort((a, b) =>
      a.decoded.index - b.decoded.index
      || a.decoded.logIndex - b.decoded.logIndex
    );

  const sameActorPriorSwapHashes = distinctHashes(
    preceding
      .filter((entry) => sameActorTxHashes.has(entry.decoded.txHash.toLowerCase()))
      .map((entry) => entry.decoded.txHash),
  );
  const externalPreceding = preceding.filter(
    (entry) => !sameActorTxHashes.has(entry.decoded.txHash.toLowerCase()),
  );
  // The nearest preceding external swap is the causal candidate. Earlier
  // same-pool swaps remain history, but are weaker attribution evidence.
  const source = externalPreceding.at(-1);
  return {
    shape: externalPreceding.length > 0 ? "backrun" : "atomic_state_arb",
    arb_pools: arbPools,
    source_swap_hash: source?.decoded.txHash,
    source_router: source?.log.txTo?.toLowerCase() ?? null,
    same_actor_prior_swap_hashes: sameActorPriorSwapHashes,
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

function distinctHashes(hashes: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const hash of hashes) {
    const normalized = hash.toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

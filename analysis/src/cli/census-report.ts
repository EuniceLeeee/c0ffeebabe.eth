import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchEthUsd, priceArb } from "../pnl/arb-profit.js";
import { decodeAnySwapLog } from "../pnl/swap-log-registry.js";
import { classifyTxShape, type RawLog, type TxShapeResult } from "../pnl/tx-shape.js";
import { lower, TOPICS } from "../registry/protocols.js";
import { hexToBigInt, RpcClient, toQuantity } from "../rpc/client.js";
import { parseArgs, resolveRpcUrl, writeText } from "../util.js";
import { strategyKindFromTxShape, type StrategyKind } from "../../../listener/src/searcher/strategy-taxonomy.js";
import {
  competitorScanAddresses,
  loadLiveCompetitorProfile,
  type LiveCompetitorEntity,
} from "../live-competitors.js";
import {
  classifyWinnerTxStyle,
  decodeExtraData,
  extractOtherVenues,
  resolveLandedTouchedVenues,
  isNonComparableWinnerStyle,
  loadGraphMembership,
  type GraphMembership,
  type OtherVenue,
  type TouchedVenue,
  type WinnerStyle,
} from "./bundle-postmortem.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_POOLS_DIR = resolve(REPO_ROOT, "listener/searcher/pools");
const DEFAULT_GRAPH_PATH = resolve(DEFAULT_POOLS_DIR, "runtime-graph-pools.json");
// Coverage/learning stage: a pool a competitor PROFITABLY arbed is itself the arb-relevance signal,
// so admit everything above a noise floor (filters valuation artifacts / failed-arb dust), not a
// "be picky" floor. Raise this once past the coverage phase.
const DEFAULT_MIN_PROFIT_USD = 0.1;
const DEFAULT_MAX_BLOCKS = 1000;
type TxShape = "atomic_state_arb" | "backrun" | "unknown";
export type CensusVenue = TouchedVenue | OtherVenue;

const TX_SHAPE_SWAP_TOPICS = [
  TOPICS.univ2Swap,
  TOPICS.univ3Swap,
  TOPICS.univ4Swap,
  TOPICS.curveTokenExchange,
  TOPICS.curveCryptoTokenExchange,
  TOPICS.curveTokenExchangeUnderlying,
  TOPICS.balancerV2Swap,
].map(lower);

const USAGE = `Usage: npm run census-report -- [--watch <addr[,addr]> | --watch-config <live-competitors.json>] --from-block <n> --to-block <n> [--rpc <loopback-url>] [--graph <runtime-graph-pools.json>] [--min-profit-usd <n=0.1>] [--max-blocks <n=1000>] [--out <report.json>]
RPC defaults to READONLY_RPC_URL, MAINNET_RPC_URL, then SEARCHER_LIVE_RPC_URL; remote credentials must not be passed in argv.`;

interface BlockWindow {
  from: number;
  to: number;
}

export interface CensusPerTx {
  hash: string;
  from: string;
  blockNumber?: number;
  nonce?: number;
  to?: string | null;
  selector?: string;
  blockBuilderHint?: string;
  blockFeeRecipient?: string;
  realizedUsd: number | null;
  touchedVenues: CensusVenue[];
  txIndex?: number;
  receiptLogs?: RawLog[];
  sameBlockSwapLogs?: RawLog[];
  sameActorTxHashes?: string[];
  winner_style?: WinnerStyle;
  winner_moved_price_beyond_prestate?: boolean;
  unpriced_token_in_flow?: string[];
}

export interface AnalyzedCompetitor {
  hash: string;
  from: string;
  realized_profit_usd: number;
  touchedVenues: CensusVenue[];
  tx_shape: TxShape;
  strategy_kind: StrategyKind | "unknown";
  source_swap_hash?: string;
  source_router?: string | null;
  same_actor_prior_swap_hashes: string[];
  actor_batch_id?: string;
  winner_style: WinnerStyle;
  non_comparable_winner?: boolean;
  winner_moved_price_beyond_prestate?: boolean;
  unpriced_token_in_flow?: string[];
}

export interface MatchedCompetitor {
  hash: string;
  from: string;
  block?: number;
  transaction_index?: number;
  nonce?: number;
  to?: string | null;
  selector?: string;
  realized_profit_usd: number | null;
  winner_style: WinnerStyle | "unknown";
  non_comparable_winner?: boolean;
  all_venues_in_graph: boolean;
  tx_shape: TxShape;
  strategy_kind: StrategyKind | "unknown";
  arb_pools: string[];
  source_swap_hash?: string;
  source_router?: string | null;
  same_actor_prior_swap_hashes: string[];
  actor_batch_id?: string;
  actor_batch_position?: number;
  actor_batch_size?: number;
}

export interface ActorBatchCandidate {
  classification: "actor_batch_candidate";
  batch_id: string;
  block: number;
  from: string;
  to: string | null;
  selector: string;
  tx_count: number;
  tx_hashes: string[];
  transaction_indices: number[];
  nonces: number[];
  first_transaction_index: number;
  last_transaction_index: number;
  transaction_indices_contiguous: boolean;
  nonces_contiguous: boolean;
  top_of_block: boolean;
  top_of_block_run_length: number;
  longest_contiguous_run_length: number;
  block_builder_hint?: string;
  block_fee_recipient?: string;
  shared_pools: Array<{ pool_id: string; tx_count: number }>;
  tx_shape_counts: Record<TxShape, number>;
  realized_profit_usd: {
    priced_txs: number;
    total_txs: number;
    priced_sum: number;
    complete_sum: number | null;
  };
}

export interface BlockFingerprint {
  block: number;
  builder_hint: string;
  coinbase: string;
  matched_tx_count: number;
  per_sender: Array<{
    from: string;
    tx_count: number;
    min_index: number | null;
    max_index: number | null;
    consecutive: boolean;
    top_of_block: boolean;
  }>;
}

export interface CensusReport {
  command: "census-report";
  verdict: {
    route_gap_decisive: boolean;
  };
  /** EVERY watch-matched take, unfiltered. analyzed_competitors below is the ROUTE-GAP subset
   *  (out-of-graph venue + above min-profit) — consumers doing per-block "why didn't we win"
   *  joins (census-gap) must read THIS list: an all-in-graph take is exactly the case where we
   *  could have competed, and the loss-focused filter would silently hide it. */
  matched_competitors: MatchedCompetitor[];
  analyzed_competitors: AnalyzedCompetitor[];
  /** Same-block/same-sender/same-destination/same-selector clusters. This is
   *  deliberately evidence of an actor batch candidate, not proof of a relay
   *  bundle boundary. Per-transaction receipts remain authoritative. */
  actor_batches: ActorBatchCandidate[];
  summary: {
    window: BlockWindow;
    watch: string[];
    watch_profile?: string;
    watch_entities?: LiveCompetitorEntity[];
    matched_txs: number;
    qualifying_txs: number;
    actor_batch_candidates: number;
    top_of_block_actor_batches: number;
    max_actor_batch_txs: number;
    /** Raw watch-matched sender activity. Unlike actor_batches this includes
     *  singleton, sparse, failed, and different-executor transactions. */
    block_fingerprints: BlockFingerprint[];
    skipped_below_profit: number;
    distinct_out_of_graph: {
      univ2: number;
      univ3: number;
      univ4: number;
      other: number;
    };
    net_realized_usd: number;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) usage();

  const watchProfile = args.watch
    ? undefined
    : loadLiveCompetitorProfile(args["watch-config"] ? resolveCliPath(String(args["watch-config"])) : undefined);
  const watch = args.watch
    ? parseWatch(stringArg(args, "watch"))
    : competitorScanAddresses(watchProfile!);
  const fromBlock = integerArg(args, "from-block");
  const toBlock = integerArg(args, "to-block");
  const rpcUrl = resolveRpcUrl(args);
  if (!rpcUrl) usage();
  const minProfitUsd = numberArg(args, "min-profit-usd", DEFAULT_MIN_PROFIT_USD);
  const maxBlocks = integerArg(args, "max-blocks", DEFAULT_MAX_BLOCKS);
  const outPath = args.out ? resolveCliPath(String(args.out)) : "";
  const graphPath = args.graph ? resolveCliPath(String(args.graph)) : DEFAULT_GRAPH_PATH;
  validateWindow({ from: fromBlock, to: toBlock }, maxBlocks);

  const graph = loadGraphMembership(graphPath);
  if (graph.status !== "loaded") {
    throw new Error(`Graph membership unavailable at ${graph.path}; pass --graph with a readable runtime-graph-pools.json`);
  }

  const rpc = new RpcClient(rpcUrl);
  const watchSet = new Set(watch);
  const perTx: CensusPerTx[] = [];
  const blockFingerprints: BlockFingerprint[] = [];

  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
    const block = await rpc.getBlockByNumber(blockNumber, true);
    const baseFeePerGas = block?.baseFeePerGas != null ? hexToBigInt(block.baseFeePerGas) : 0n;
    const coinbase = lower(String(block?.miner ?? ""));
    const blockBuilderHint = decodeExtraData(block?.extraData);
    const txs: any[] = Array.isArray(block?.transactions) ? block.transactions : [];
    const matches = txs.filter((tx) => txMatchesWatch(tx, watchSet));
    const ethUsd = matches.length > 0
      ? await fetchEthUsd(rpc, toQuantity(blockNumber))
      : 0;
    if (matches.length > 0) blockFingerprints.push(buildBlockFingerprint(blockNumber, block, matches));
    const actorTxHashes = actorTxHashesBySender(txs);
    const sameBlockSwapLogs = matches.length > 0
      ? await fetchSameBlockSwapLogs(rpc, blockNumber, txs)
      : [];

    for (const tx of matches) {
      const hash = lower(String(tx?.hash ?? ""));
      if (!hash) continue;
      const receipt = await rpc.getReceipt(hash);
      if (!receipt || receipt.status !== "0x1") continue;
      const profit = await priceArb(rpc, hash, tx, receipt, ethUsd, {
        entityActors: [tx?.to, tx?.from].filter((actor): actor is string => typeof actor === "string" && actor.length > 0),
        allowTrace: true,
        coinbase,
        baseFeePerGas,
      });
      const winnerStyle = await classifyWinnerTxStyle({
        rpc,
        txHash: hash,
        tx,
        receipt,
        profit,
        transactionIndex: Number(hexToBigInt(receipt?.transactionIndex ?? tx?.transactionIndex)),
        blockNumber,
        prestateBlock: Math.max(blockNumber - 1, 0),
        competitorProfile: watchProfile,
      });
      perTx.push({
        hash,
        from: lower(String(tx?.from ?? receipt?.from ?? "")),
        blockNumber,
        nonce: optionalQuantityNumber(tx?.nonce),
        to: typeof tx?.to === "string" ? lower(tx.to) : null,
        selector: selectorFromInput(tx?.input),
        blockBuilderHint: blockBuilderHint || undefined,
        blockFeeRecipient: coinbase || undefined,
        realizedUsd: profit.realizedProfitUsd,
        touchedVenues: [
          ...await resolveLandedTouchedVenues(rpc, receipt, graph, blockNumber),
          ...extractOtherVenues(receipt, graph),
        ],
        txIndex: Number(hexToBigInt(receipt?.transactionIndex ?? tx?.transactionIndex)),
        receiptLogs: receipt?.logs,
        sameBlockSwapLogs,
        sameActorTxHashes: actorTxHashes.get(lower(String(tx?.from ?? receipt?.from ?? ""))) ?? [],
        winner_style: winnerStyle.winner_style,
        winner_moved_price_beyond_prestate: winnerStyle.winner_moved_price_beyond_prestate,
        unpriced_token_in_flow: winnerStyle.unpriced_token_in_flow,
      });
    }
  }

  const report = buildCensusReport(
    perTx,
    minProfitUsd,
    { from: fromBlock, to: toBlock },
    watch,
    blockFingerprints,
  );
  if (watchProfile) {
    report.summary.watch_profile = watchProfile.profile_id;
    report.summary.watch_entities = watchProfile.entities;
  }
  const json = `${JSON.stringify(report, jsonReplacer, 2)}\n`;
  process.stdout.write(json);
  if (outPath) await writeText(outPath, json);
  console.error(renderHumanSummary(report, graph, minProfitUsd));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export function buildCensusReport(
  perTx: CensusPerTx[],
  minProfitUsd: number,
  window: BlockWindow,
  watch: string[],
  blockFingerprints: BlockFingerprint[] = [],
): CensusReport {
  const analyzed: AnalyzedCompetitor[] = [];
  const shapeByHash = classifyCensusTxShapes(perTx);
  const { batches: actorBatches, membership: actorBatchMembership } = buildActorBatchCandidates(
    perTx,
    shapeByHash,
  );
  const distinct = {
    univ2: new Set<string>(),
    univ3: new Set<string>(),
    univ4: new Set<string>(),
    other: new Set<string>(),
  };
  let skippedBelowProfit = 0;

  for (const tx of perTx) {
    const realized = tx.realizedUsd;
    if (realized === null || realized < minProfitUsd) {
      skippedBelowProfit++;
      continue;
    }
    if (!tx.touchedVenues.some((venue) => venue.in_graph === false)) continue;
    const winnerStyle = tx.winner_style ?? "unknown";
    const nonComparable = isNonComparableWinnerStyle(winnerStyle);
    const comparableAtomic = winnerStyle === "atomic_loop";
    // Keep unknown/non-comparable competitors visible for manual analysis, but
    // only a proven atomic loop may feed missing venues to route-gap closure.
    const coverageTouchedVenues = comparableAtomic
      ? tx.touchedVenues
      : tx.touchedVenues.filter((venue) => venue.in_graph !== false);
    const txShape = shapeByHash.get(lower(tx.hash)) ?? unknownTxShape();

    analyzed.push({
      hash: lower(tx.hash),
      from: lower(tx.from),
      realized_profit_usd: realized,
      touchedVenues: coverageTouchedVenues,
      tx_shape: txShape.shape,
      strategy_kind: strategyKindFromTxShape(txShape.shape),
      source_swap_hash: txShape.source_swap_hash,
      source_router: txShape.source_router,
      same_actor_prior_swap_hashes: txShape.same_actor_prior_swap_hashes,
      actor_batch_id: actorBatchMembership.get(lower(tx.hash))?.batchId,
      winner_style: winnerStyle,
      non_comparable_winner: nonComparable ? true : undefined,
      winner_moved_price_beyond_prestate: tx.winner_moved_price_beyond_prestate,
      unpriced_token_in_flow: tx.unpriced_token_in_flow,
    });
    if (!comparableAtomic) continue;
    for (const venue of tx.touchedVenues) {
      if (venue.in_graph !== false) continue;
      if (isUniVenueProtocol(venue.protocol)) {
        distinct[venue.protocol].add(lower(venue.id));
      } else {
        distinct.other.add(`${lower(venue.protocol)}:${lower(venue.id)}`);
      }
    }
  }

  const matchedCompetitors = perTx.map((tx): MatchedCompetitor => {
    const shape = shapeByHash.get(lower(tx.hash)) ?? unknownTxShape();
    const batch = actorBatchMembership.get(lower(tx.hash));
    return {
      hash: lower(tx.hash),
      from: lower(tx.from),
      block: tx.blockNumber,
      transaction_index: tx.txIndex,
      nonce: tx.nonce,
      to: typeof tx.to === "string" ? lower(tx.to) : tx.to,
      selector: tx.selector,
      realized_profit_usd: tx.realizedUsd,
      winner_style: tx.winner_style ?? "unknown",
      non_comparable_winner: tx.winner_style ? (isNonComparableWinnerStyle(tx.winner_style) || undefined) : undefined,
      all_venues_in_graph: !tx.touchedVenues.some((venue) => venue.in_graph === false),
      tx_shape: shape.shape,
      strategy_kind: strategyKindFromTxShape(shape.shape),
      arb_pools: shape.arb_pools,
      source_swap_hash: shape.source_swap_hash,
      source_router: shape.source_router,
      same_actor_prior_swap_hashes: shape.same_actor_prior_swap_hashes,
      actor_batch_id: batch?.batchId,
      actor_batch_position: batch?.position,
      actor_batch_size: batch?.size,
    };
  });

  return {
    command: "census-report",
    verdict: {
      route_gap_decisive: analyzed.some((tx) => tx.winner_style === "atomic_loop"),
    },
    matched_competitors: matchedCompetitors,
    analyzed_competitors: analyzed,
    actor_batches: actorBatches,
    summary: {
      window,
      watch: watch.map(lower),
      matched_txs: perTx.length,
      qualifying_txs: analyzed.filter((tx) => tx.winner_style === "atomic_loop").length,
      actor_batch_candidates: actorBatches.length,
      top_of_block_actor_batches: actorBatches.filter((batch) => batch.top_of_block).length,
      max_actor_batch_txs: actorBatches.reduce((max, batch) => Math.max(max, batch.tx_count), 0),
      block_fingerprints: [...blockFingerprints].sort((a, b) => a.block - b.block),
      skipped_below_profit: skippedBelowProfit,
      distinct_out_of_graph: {
        univ2: distinct.univ2.size,
        univ3: distinct.univ3.size,
        univ4: distinct.univ4.size,
        other: distinct.other.size,
      },
      net_realized_usd: analyzed.reduce(
        (sum, tx) => tx.winner_style === "atomic_loop" ? sum + tx.realized_profit_usd : sum,
        0,
      ),
    },
  };
}

export async function fetchSameBlockSwapLogs(
  rpc: Pick<RpcClient, "getLogs">,
  blockNumber: number,
  transactions: any[],
): Promise<RawLog[]> {
  const txToByHash = new Map<string, string | null>();
  for (const tx of transactions) {
    const hash = lower(String(tx?.hash ?? ""));
    if (!hash) continue;
    txToByHash.set(hash, typeof tx?.to === "string" ? lower(tx.to) : null);
  }

  const logs = await rpc.getLogs({
    fromBlock: toQuantity(blockNumber),
    toBlock: toQuantity(blockNumber),
    topics: [TX_SHAPE_SWAP_TOPICS],
  });
  return logs.map((log) => ({
    address: lower(String(log?.address ?? "")),
    topics: Array.isArray(log?.topics) ? log.topics.map((topic: unknown) => lower(String(topic))) : [],
    data: String(log?.data ?? "0x"),
    logIndex: Number(hexToBigInt(log?.logIndex)),
    transactionIndex: Number(hexToBigInt(log?.transactionIndex)),
    transactionHash: lower(String(log?.transactionHash ?? "")),
    txTo: txToByHash.get(lower(String(log?.transactionHash ?? ""))) ?? null,
  }));
}

function isUniVenueProtocol(protocol: string): protocol is TouchedVenue["protocol"] {
  return protocol === "univ2" || protocol === "univ3" || protocol === "univ4";
}

function classifyCensusTxShapes(perTx: CensusPerTx[]): Map<string, TxShapeResult> {
  const hashesByActorBlock = new Map<string, Set<string>>();
  for (const tx of perTx) {
    if (typeof tx.blockNumber !== "number") continue;
    const key = `${tx.blockNumber}:${lower(tx.from)}`;
    const hashes = hashesByActorBlock.get(key) ?? new Set<string>();
    hashes.add(lower(tx.hash));
    hashesByActorBlock.set(key, hashes);
  }

  const result = new Map<string, TxShapeResult>();
  for (const tx of perTx) {
    const sameActorTxHashes = new Set((tx.sameActorTxHashes ?? []).map(lower));
    if (typeof tx.blockNumber === "number") {
      const observed = hashesByActorBlock.get(`${tx.blockNumber}:${lower(tx.from)}`);
      for (const hash of observed ?? []) sameActorTxHashes.add(hash);
    }
    result.set(lower(tx.hash), classifyCensusTxShape(tx, sameActorTxHashes));
  }
  return result;
}

function classifyCensusTxShape(
  tx: CensusPerTx,
  sameActorTxHashes: Iterable<string>,
): TxShapeResult {
  if (
    typeof tx.txIndex !== "number"
    || !Array.isArray(tx.receiptLogs)
    || !Array.isArray(tx.sameBlockSwapLogs)
  ) {
    return unknownTxShape();
  }
  const classified = classifyTxShape({
    receiptLogs: tx.receiptLogs,
    txIndex: tx.txIndex,
    sameBlockSwapLogs: tx.sameBlockSwapLogs,
    sameActorTxHashes,
  });
  // Some supported atomic conversions (for example fixed-rate protocol legs)
  // have no AMM Swap log. Preserve those when the winner-style classifier has
  // confirmed an atomic loop, but do not label a plain transfer as an arb.
  return classified.arb_pools.length === 0 && tx.winner_style !== "atomic_loop"
    ? unknownTxShape()
    : classified;
}

function unknownTxShape(): TxShapeResult {
  return {
    shape: "unknown",
    arb_pools: [],
    source_router: null,
    same_actor_prior_swap_hashes: [],
  };
}

interface ActorBatchMembership {
  batchId: string;
  position: number;
  size: number;
}

function buildActorBatchCandidates(
  perTx: CensusPerTx[],
  shapeByHash: Map<string, TxShapeResult>,
): {
  batches: ActorBatchCandidate[];
  membership: Map<string, ActorBatchMembership>;
} {
  const grouped = new Map<string, CensusPerTx[]>();
  for (const tx of perTx) {
    if (
      typeof tx.blockNumber !== "number"
      || typeof tx.txIndex !== "number"
      || typeof tx.nonce !== "number"
      || typeof tx.selector !== "string"
      || (typeof tx.to !== "string" && tx.to !== null)
    ) {
      continue;
    }
    const key = JSON.stringify([
      tx.blockNumber,
      lower(tx.from),
      typeof tx.to === "string" ? lower(tx.to) : null,
      lower(tx.selector),
    ]);
    const entries = grouped.get(key) ?? [];
    entries.push(tx);
    grouped.set(key, entries);
  }

  const batches: ActorBatchCandidate[] = [];
  const membership = new Map<string, ActorBatchMembership>();
  for (const entries of grouped.values()) {
    const sortedGroup = [...entries].sort((a, b) => (a.txIndex ?? 0) - (b.txIndex ?? 0));
    for (const sorted of consecutiveActorRuns(sortedGroup)) {
      if (sorted.length < 2) continue;
      const first = sorted[0]!;
      const indices = sorted.map((tx) => tx.txIndex!);
      const nonces = sorted.map((tx) => tx.nonce!);
      const firstIndex = indices[0]!;
      const lastIndex = indices.at(-1)!;
      const batchId = `actor_batch:${first.blockNumber}:${lower(first.from)}:${firstIndex}-${lastIndex}`;
      const shapeCounts: Record<TxShape, number> = {
        atomic_state_arb: 0,
        backrun: 0,
        unknown: 0,
      };
      for (const tx of sorted) {
        const shape = shapeByHash.get(lower(tx.hash))?.shape ?? "unknown";
        shapeCounts[shape] += 1;
      }

      const priced = sorted.filter((tx) => tx.realizedUsd !== null);
      const pricedSum = priced.reduce((sum, tx) => sum + (tx.realizedUsd ?? 0), 0);
      const batch: ActorBatchCandidate = {
        classification: "actor_batch_candidate",
        batch_id: batchId,
        block: first.blockNumber!,
        from: lower(first.from),
        to: typeof first.to === "string" ? lower(first.to) : null,
        selector: lower(first.selector!),
        tx_count: sorted.length,
        tx_hashes: sorted.map((tx) => lower(tx.hash)),
        transaction_indices: indices,
        nonces,
        first_transaction_index: firstIndex,
        last_transaction_index: lastIndex,
        transaction_indices_contiguous: isConsecutive(indices),
        nonces_contiguous: isConsecutive(nonces),
        top_of_block: firstIndex === 0,
        top_of_block_run_length: firstIndex === 0 ? contiguousRunLength(indices) : 0,
        longest_contiguous_run_length: longestContiguousRunLength(indices),
        block_builder_hint: first.blockBuilderHint,
        block_fee_recipient: first.blockFeeRecipient,
        shared_pools: sharedPools(sorted),
        tx_shape_counts: shapeCounts,
        realized_profit_usd: {
          priced_txs: priced.length,
          total_txs: sorted.length,
          priced_sum: pricedSum,
          complete_sum: priced.length === sorted.length ? pricedSum : null,
        },
      };
      batches.push(batch);
      sorted.forEach((tx, index) => {
        membership.set(lower(tx.hash), {
          batchId,
          position: index + 1,
          size: sorted.length,
        });
      });
    }
  }

  batches.sort((a, b) => a.block - b.block || a.first_transaction_index - b.first_transaction_index);
  return { batches, membership };
}

function consecutiveActorRuns(sorted: CensusPerTx[]): CensusPerTx[][] {
  const runs: CensusPerTx[][] = [];
  let current: CensusPerTx[] = [];
  for (const tx of sorted) {
    const previous = current.at(-1);
    if (
      previous
      && (tx.txIndex !== previous.txIndex! + 1 || tx.nonce !== previous.nonce! + 1)
    ) {
      runs.push(current);
      current = [];
    }
    current.push(tx);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function sharedPools(txs: CensusPerTx[]): Array<{ pool_id: string; tx_count: number }> {
  const countByPool = new Map<string, number>();
  for (const tx of txs) {
    const pools = new Set<string>();
    for (const log of tx.receiptLogs ?? []) {
      const decoded = decodeAnySwapLog(log);
      if (decoded) pools.add(lower(decoded.poolId));
    }
    for (const pool of pools) countByPool.set(pool, (countByPool.get(pool) ?? 0) + 1);
  }
  return [...countByPool.entries()]
    .filter(([, count]) => count >= 2)
    .map(([pool_id, tx_count]) => ({ pool_id, tx_count }))
    .sort((a, b) => b.tx_count - a.tx_count || a.pool_id.localeCompare(b.pool_id));
}

function isConsecutive(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value === values[index - 1]! + 1);
}

function contiguousRunLength(values: number[]): number {
  if (values.length === 0) return 0;
  let length = 1;
  while (length < values.length && values[length] === values[length - 1]! + 1) length++;
  return length;
}

function longestContiguousRunLength(values: number[]): number {
  if (values.length === 0) return 0;
  let longest = 1;
  let current = 1;
  for (let i = 1; i < values.length; i++) {
    current = values[i] === values[i - 1]! + 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

function stringArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  usage();
}

function integerArg(args: Record<string, string | boolean>, key: string, fallback?: number): number {
  const value = args[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") usage();
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) usage();
  return parsed;
}

function numberArg(args: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") usage();
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) usage();
  return parsed;
}

function parseWatch(value: string): string[] {
  const watch = value.split(",").map((item) => lower(item.trim())).filter(Boolean);
  if (watch.length === 0 || watch.some((address) => !isAddress(address))) usage();
  return watch;
}

function validateWindow(window: BlockWindow, maxBlocks: number): void {
  if (window.from < 0 || window.to < 0 || window.from > window.to || maxBlocks < 1) usage();
  const span = window.to - window.from + 1;
  if (span > maxBlocks) {
    throw new Error(`Refusing to census-scan ${span} blocks; pass a <=${maxBlocks} block range or raise --max-blocks`);
  }
}

function txMatchesWatch(tx: any, watchSet: Set<string>): boolean {
  const from = lower(String(tx?.from ?? ""));
  const to = lower(String(tx?.to ?? ""));
  return watchSet.has(from) || watchSet.has(to);
}

export function buildBlockFingerprint(
  blockNumber: number,
  block: any,
  matches: any[],
): BlockFingerprint {
  const bySender = new Map<string, any[]>();
  for (const tx of matches) {
    const from = lower(String(tx?.from ?? ""));
    if (!from) continue;
    const senderTxs = bySender.get(from) ?? [];
    senderTxs.push(tx);
    bySender.set(from, senderTxs);
  }

  const perSender = [...bySender.entries()].map(([from, transactions]) => {
    const indices = transactions
      .map((tx) => optionalQuantityNumber(tx?.transactionIndex))
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => a - b);
    const completeIndices = indices.length === transactions.length;
    const consecutive = completeIndices && isConsecutive(indices);
    const minIndex = indices[0] ?? null;
    const maxIndex = indices.at(-1) ?? null;
    return {
      from,
      tx_count: transactions.length,
      min_index: minIndex,
      max_index: maxIndex,
      consecutive,
      top_of_block: minIndex === 0 && consecutive,
    };
  });
  perSender.sort((a, b) =>
    (a.min_index ?? Number.MAX_SAFE_INTEGER) - (b.min_index ?? Number.MAX_SAFE_INTEGER)
    || a.from.localeCompare(b.from)
  );

  return {
    block: blockNumber,
    builder_hint: decodeExtraData(block?.extraData),
    coinbase: lower(String(block?.miner ?? "")),
    matched_tx_count: matches.length,
    per_sender: perSender,
  };
}

export function renderBlockFingerprint(fingerprint: BlockFingerprint): string {
  const senders = fingerprint.per_sender.map((sender) => {
    const indexRange = sender.min_index === null
      ? "idx ?"
      : `idx ${sender.min_index}-${sender.max_index}`;
    const posture = sender.top_of_block
      ? " TOP-OF-BLOCK"
      : sender.consecutive ? " consecutive" : " spread";
    return `${sender.from.slice(0, 10)}…: ${sender.tx_count} txs ${indexRange}${posture}`;
  });
  return `block ${fingerprint.block} builder=${fingerprint.builder_hint || "?"} ${senders.join(" | ")}`;
}

function actorTxHashesBySender(transactions: any[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const tx of transactions) {
    const from = lower(String(tx?.from ?? ""));
    const hash = lower(String(tx?.hash ?? ""));
    if (!from || !hash) continue;
    const hashes = result.get(from) ?? [];
    hashes.push(hash);
    result.set(from, hashes);
  }
  return result;
}

function selectorFromInput(input: unknown): string {
  const calldata = lower(String(input ?? "0x"));
  return /^0x[0-9a-f]*$/.test(calldata) && calldata.length >= 10
    ? calldata.slice(0, 10)
    : "0x";
}

function optionalQuantityNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return undefined;
  const parsed = Number(hexToBigInt(value));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function renderHumanSummary(report: CensusReport, graph: GraphMembership, minProfitUsd: number): string {
  const { summary } = report;
  const headline = [
    "[analysis/census-report]",
    `blocks=${summary.window.from}-${summary.window.to}`,
    `watch=${summary.watch.length}`,
    `graph_entries=${graph.entries}`,
    `min_profit_usd=${minProfitUsd}`,
    `matched=${summary.matched_txs}`,
    `actor_batches=${summary.actor_batch_candidates}`,
    `top_actor_batches=${summary.top_of_block_actor_batches}`,
    `max_actor_batch_txs=${summary.max_actor_batch_txs}`,
    `qualifying=${summary.qualifying_txs}`,
    `route_gap_decisive=${String(report.verdict.route_gap_decisive)}`,
    `net_realized_usd=${summary.net_realized_usd.toFixed(2)}`,
  ].join(" ");
  return [headline, ...summary.block_fingerprints.map(renderBlockFingerprint)].join("\n");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Set ? [...value] : typeof value === "bigint" ? value.toString() : value;
}

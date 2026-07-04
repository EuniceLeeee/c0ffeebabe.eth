import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import {
  classifyWinnerTxStyle,
  extractTouchedVenues,
  isNonComparableWinnerStyle,
  loadGraphMembership,
  type GraphMembership,
  type TouchedVenue,
  type WinnerStyle,
} from "./bundle-postmortem.js";
import {
  type LearningCase,
  type PrimaryGap,
  upsertCase,
} from "../learning/learning-case.js";
import { fetchEthUsd, priceArb, type ArbProfit } from "../pnl/arb-profit.js";
import { ADDR, lower, short } from "../registry/protocols.js";
import { hexToBigInt, RpcClient, toQuantity } from "../rpc/client.js";
import { mapLimit, parseArgs, uniq, writeText } from "../util.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_RPC_URL = "http://127.0.0.1:8545";
const DEFAULT_GRAPH_PATH = resolve(REPO_ROOT, "listener/searcher/pools/runtime-graph-pools.json");
const DEFAULT_BLOCKS = 120;

type Json = Record<string, any>;

export interface FunnelDrop {
  stage?: string;
  reason: string;
  error?: string;
}

export interface FunnelVictimState {
  victim_hash: string;
  seen: boolean;
  sim_ok: boolean;
  submitted: boolean;
  bid?: string;
  drops: FunnelDrop[];
  victim_source?: string;
  opportunity_ids: string[];
}

export interface FunnelHintState {
  hash: string;
  seen: boolean;
  drops: FunnelDrop[];
  event_types: string[];
}

export interface FunnelIndex {
  run_id?: string;
  events: number;
  indexed_victims: number;
  victims: Map<string, FunnelVictimState>;
  hints: Map<string, FunnelHintState>;
  mempool_allowlist: Set<string> | null;
}

export interface OnchainScanTx {
  hash: string;
  from?: string;
  to?: string | null;
  transactionIndex?: number;
}

export interface OnchainScanReceipt {
  transactionHash?: string;
  blockNumber?: string | number;
  transactionIndex?: string | number;
  from?: string;
  to?: string | null;
  status?: string | number;
  logs?: Json[];
  gasUsed?: string;
  effectiveGasPrice?: string;
}

export interface OnchainScanBlock {
  number: number;
  timestamp?: number;
  baseFeePerGas?: string;
  miner?: string;
  transactions: OnchainScanTx[];
  receipts: OnchainScanReceipt[];
}

export interface OnchainScanLearningInput {
  competitor_tx: string;
  source_block: number;
  target_block: number;
  primary_gap: PrimaryGap;
  comparable: boolean;
  strategy_kind: LearningCase["strategy_kind"];
  our_opportunity_id?: string;
  gap_detail?: string;
  edge_kinds?: LearningCase["edge_kinds"];
  evidence: Record<string, unknown>;
  created_at?: string;
}

export interface OnchainCaseReport {
  block: number;
  victim_tx: string;
  victim_index: number;
  winner_tx: string;
  winner_index: number;
  primary_gap: PrimaryGap;
  comparable: boolean;
  winner_style?: WinnerStyle;
  non_comparable_reason?: string;
  source_not_seen_reason?: SourceNotSeenReason;
  source_not_seen_drop_reason?: string;
  source_not_seen_hint_hash?: string;
  source_not_seen_note?: string;
  winner_profit_wei: string | null;
  winner_profit_usd: number | null;
  touched_venues: TouchedVenue[];
  missing_venues: TouchedVenue[];
  funnel?: FunnelVictimState;
  learning_case: LearningCase;
}

export type SourceNotSeenReason =
  | "pool_not_in_graph"
  | "to_not_admissible"
  | "not_received"
  | "received_but_dropped";

export interface WinnerProfit {
  winner_profit_wei: string | null;
  winner_profit_usd: number | null;
}

export interface WinnerProfitRollup {
  cases: number;
  priced_cases: number;
  median_usd: number | null;
  p90_usd: number | null;
  dust_share: number | null;
}

export interface OnchainLossScanResult {
  start_block: number;
  end_block: number;
  scanned_blocks: number;
  competed_backruns: number;
  cases: OnchainCaseReport[];
  summary: Partial<Record<PrimaryGap, number>>;
  source_not_seen_reasons: Partial<Record<SourceNotSeenReason, number>>;
  winner_profit_by_primary_gap: Partial<Record<PrimaryGap, WinnerProfitRollup>>;
}

export interface OnchainLossScanOptions {
  fromBlock: number;
  toBlock: number;
  fetchBlock: (blockNumber: number) => Promise<OnchainScanBlock>;
  funnel: FunnelIndex;
  graph: GraphMembership;
  ourExecutorPrefixes?: string[];
  classifyWinnerStyle?: OnchainWinnerStyleClassifier;
  priceWinner?: OnchainWinnerProfitPricer;
  ethUsd?: number;
  concurrency?: number;
  now?: () => string;
}

export type OnchainWinnerStyleClassifier = (input: {
  block: OnchainScanBlock;
  winner: JoinedTx;
  victim: JoinedTx;
}) => Promise<WinnerStyle | undefined> | WinnerStyle | undefined;

export type OnchainWinnerProfitPricer = (input: {
  block: OnchainScanBlock;
  winner: JoinedTx;
  victim: JoinedTx;
}) => Promise<WinnerProfit> | WinnerProfit;

export interface JoinedTx {
  hash: string;
  from: string;
  to: string | null;
  index: number;
  receipt: OnchainScanReceipt;
  pools: string[];
  touchedVenues: TouchedVenue[];
}

const USAGE = `Usage: npm run onchain-loss-scan -- --events <jsonl> [--rpc <url>] [--blocks <n>] [--graph <runtime-graph-pools.json>] [--our-executor <0x prefix>] [--write] [--out <report.json>]`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) usage();

  const eventsPath = stringArg(args, "events");
  const rpcUrl = stringArg(args, "rpc", false) || DEFAULT_RPC_URL;
  const blocks = numberArg(args, "blocks", DEFAULT_BLOCKS);
  const graphPath = args.graph ? resolveCliPath(String(args.graph)) : DEFAULT_GRAPH_PATH;
  const outPath = args.out ? resolveCliPath(String(args.out)) : "";
  const write = Boolean(args.write);
  const ourExecutorPrefixes = parsePrefixes(args["our-executor"]);

  if (!eventsPath || blocks <= 0) usage();

  const loaded = await readJsonlSkippingBad(resolveCliPath(eventsPath));
  const funnel = buildFunnelIndex(loaded.events);
  const graph = loadGraphMembership(graphPath);
  const rpc = new RpcClient(rpcUrl);
  const winnerAnalysis = makeRpcWinnerAnalysis(rpc);
  const head = Number(hexToBigInt(await rpc.call<string>("eth_blockNumber", [])));
  const startBlock = Math.max(0, head - blocks + 1);
  const result = await scanOnchainLosses({
    fromBlock: startBlock,
    toBlock: head,
    fetchBlock: (blockNumber) => fetchBlockFromRpc(rpc, blockNumber),
    funnel,
    graph,
    ourExecutorPrefixes,
    classifyWinnerStyle: winnerAnalysis.classifyWinnerStyle,
    priceWinner: winnerAnalysis.priceWinner,
  });

  const storedCases = write
    ? result.cases.map((item) => upsertCase(item.learning_case))
    : [];
  const report = {
    command: "onchain-loss-scan",
    rpc: rpcUrl,
    events: {
      path: resolveCliPath(eventsPath),
      parsed: loaded.parsed,
      skipped_unparsable: loaded.skipped,
      run_id: funnel.run_id ?? null,
      indexed_victims: funnel.indexed_victims,
    },
    graph: {
      status: graph.status,
      path: graph.path,
      entries: graph.entries,
    },
    write,
    stored_cases: storedCases.length,
    ...result,
  };

  console.log(renderSummary(report));
  if (outPath) await writeJson(outPath, report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export function learningCaseFromOnchainScan(input: OnchainScanLearningInput): LearningCase {
  const createdAt = input.created_at ?? "1970-01-01T00:00:00.000Z";
  return {
    learning_case_id: learningCaseId({
      strategy_kind: input.strategy_kind,
      trigger: "competitor_not_seen",
      competitor_tx: input.competitor_tx,
      source_block: input.source_block,
      primary_gap: input.primary_gap,
    }),
    status: input.strategy_kind === "unknown" || input.primary_gap === "manual_required"
      ? "manual_required"
      : "open",
    strategy_kind: input.strategy_kind,
    edge_kinds: input.edge_kinds ?? ["swap"],
    trigger: "competitor_not_seen",
    competitor_tx: input.competitor_tx,
    our_opportunity_id: input.our_opportunity_id,
    source_block: input.source_block,
    target_block: input.target_block,
    comparable: input.comparable,
    primary_gap: input.primary_gap,
    gap_detail: input.gap_detail,
    evidence: input.evidence,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function buildFunnelIndex(events: Json[]): FunnelIndex {
  const runId = latestRunId(events);
  const scoped = runId ? events.filter((event) => String(event?.run_id ?? "") === runId) : events;
  const victims = new Map<string, FunnelVictimState>();
  const hints = new Map<string, FunnelHintState>();

  for (const event of scoped) {
    const eventType = optionalString(event.type) ?? "unknown";
    const drop = eventType === "pipeline_dropped" ? dropFromEvent(event) : undefined;
    for (const hash of collectEventHashes(event)) {
      const hint = getHintEntry(hints, hash);
      hint.event_types = uniq([...hint.event_types, eventType]);
      if (eventType === "opportunity_seen") hint.seen = true;
      if (drop) hint.drops.push(drop);
    }

    const victim = normalizeHash(optionalString(event.victim_hash ?? event.victimHash));
    if (!victim) continue;
    const entry = getFunnelEntry(victims, victim);
    const opportunityId = optionalString(event.opportunity_id ?? event.opportunityId);
    if (opportunityId) entry.opportunity_ids = uniq([...entry.opportunity_ids, opportunityId]);

    if (eventType === "opportunity_seen") {
      entry.seen = true;
    } else if (eventType === "simulation_result") {
      entry.seen = true;
      entry.sim_ok = entry.sim_ok || event.ok === true;
    } else if (eventType === "bundle_submitted") {
      entry.seen = true;
      entry.sim_ok = true;
      entry.submitted = true;
      const bid = optionalString(event.bid);
      if (bid) entry.bid = bid;
    } else if (drop) {
      entry.drops.push(drop);
      const source = optionalString(event.victim_source ?? event.victimSource);
      if (source) entry.victim_source = source;
    }
  }

  return {
    run_id: runId,
    events: scoped.length,
    indexed_victims: victims.size,
    victims,
    hints,
    mempool_allowlist: latestMempoolAllowlist(scoped) ?? latestMempoolAllowlist(events),
  };
}

export async function scanOnchainLosses(options: OnchainLossScanOptions): Promise<OnchainLossScanResult> {
  const prefixes = (options.ourExecutorPrefixes ?? []).map(lower).filter(Boolean);
  const cases: OnchainCaseReport[] = [];
  const concurrency = options.concurrency ?? 4;
  const range = blockRange(options.fromBlock, options.toBlock);
  const priceWinner = options.priceWinner ?? makeLogOnlyWinnerProfitPricer(options.ethUsd);

  await mapLimit(range, concurrency, async (blockNumber) => {
    const block = await options.fetchBlock(blockNumber);
    cases.push(...await scanBlock(
      block,
      options.funnel,
      options.graph,
      prefixes,
      options.now,
      options.classifyWinnerStyle,
      priceWinner,
    ));
  });

  cases.sort((a, b) => a.block - b.block || a.winner_index - b.winner_index);
  return {
    start_block: options.fromBlock,
    end_block: options.toBlock,
    scanned_blocks: range.length,
    competed_backruns: cases.length,
    cases,
    summary: summarizeCases(cases),
    source_not_seen_reasons: summarizeSourceNotSeenReasons(cases),
    winner_profit_by_primary_gap: summarizeWinnerProfitByGap(cases),
  };
}

async function scanBlock(
  block: OnchainScanBlock,
  funnel: FunnelIndex,
  graph: GraphMembership,
  ourExecutorPrefixes: string[],
  now?: () => string,
  classifyWinnerStyle?: OnchainWinnerStyleClassifier,
  priceWinner?: OnchainWinnerProfitPricer,
): Promise<OnchainCaseReport[]> {
  const joined = joinBlockTxs(block, graph);
  const out: OnchainCaseReport[] = [];

  for (let i = 0; i < joined.length; i++) {
    const winner = joined[i];
    if (!winner || winner.pools.length < 2) continue;
    if (isOurExecutorTx(winner, ourExecutorPrefixes)) continue;
    const victim = nearestPriorSharingPool(joined, i, winner.pools);
    if (!victim) continue;
    const winnerStyle = classifyWinnerStyle
      ? await classifyWinnerStyle({ block, winner, victim })
      : undefined;
    const winnerProfit = priceWinner
      ? await priceWinner({ block, winner, victim })
      : emptyWinnerProfit();
    out.push(caseFromCompetedBackrun(block, winner, victim, funnel, now, winnerStyle, winnerProfit));
  }

  return out;
}

function caseFromCompetedBackrun(
  block: OnchainScanBlock,
  winner: JoinedTx,
  victim: JoinedTx,
  funnel: FunnelIndex,
  now?: () => string,
  winnerStyle?: WinnerStyle,
  winnerProfit: WinnerProfit = emptyWinnerProfit(),
): OnchainCaseReport {
  const funnelMatch = findFunnelMatch(funnel, victim.hash);
  const funnelEntry = funnelMatch.entry;
  const nonComparable = classifyNonComparable(winner, victim, winnerStyle);
  const missingVenues = winner.touchedVenues.filter((venue) => venue.in_graph === false);
  const primary_gap = nonComparable.primary_gap
    ?? classifyPrimaryGap(funnelEntry, missingVenues);
  const comparable = nonComparable.primary_gap === undefined;
  const sourceNotSeen = primary_gap === "source_not_seen"
    ? classifySourceNotSeenReason(victim, funnel)
    : undefined;
  const strategy_kind: LearningCase["strategy_kind"] = comparable ? "backrun" : "unknown";
  const createdAt = now ? now() : timestampFromBlock(block);
  const touchedVenues = winner.touchedVenues.map(reportVenue);
  const missingVenueEvidence = missingVenues.map(reportVenue);
  const learningCase = learningCaseFromOnchainScan({
    competitor_tx: winner.hash,
    source_block: block.number - 1,
    target_block: block.number,
    primary_gap,
    comparable,
    strategy_kind,
    our_opportunity_id: funnelEntry?.opportunity_ids[0],
    gap_detail: gapDetail(primary_gap, nonComparable.reason, funnelEntry, sourceNotSeen),
    edge_kinds: ["swap"],
    created_at: createdAt,
    evidence: {
      winner_tx: winner.hash,
      winner_index: winner.index,
      winner_from: winner.from,
      winner_to: winner.to,
      winner_pools: winner.pools,
      victim_tx: victim.hash,
      victim_index: victim.index,
      victim_from: victim.from,
      victim_to: victim.to,
      victim_pools: victim.pools,
      victim_source: funnelEntry?.victim_source,
      source_not_seen_reason: sourceNotSeen?.reason,
      source_not_seen_drop_reason: sourceNotSeen?.drop_reason,
      source_not_seen_hint_hash: sourceNotSeen?.hint_hash,
      source_not_seen_note: sourceNotSeen?.note,
      source_block_choice: "target_block_minus_1",
      winner_style: winnerStyle,
      winner_profit_wei: winnerProfit.winner_profit_wei,
      winner_profit_usd: winnerProfit.winner_profit_usd,
      non_comparable_reason: nonComparable.reason,
      touched_venues: touchedVenues,
      missing_venues: missingVenueEvidence,
      funnel: funnelEntry ? {
        seen: funnelEntry.seen,
        sim_ok: funnelEntry.sim_ok,
        submitted: funnelEntry.submitted,
        bid: funnelEntry.bid,
        drops: funnelEntry.drops,
      } : null,
    },
  });

  return {
    block: block.number,
    victim_tx: victim.hash,
    victim_index: victim.index,
    winner_tx: winner.hash,
    winner_index: winner.index,
    primary_gap,
    comparable,
    winner_style: winnerStyle,
    non_comparable_reason: nonComparable.reason,
    source_not_seen_reason: sourceNotSeen?.reason,
    source_not_seen_drop_reason: sourceNotSeen?.drop_reason,
    source_not_seen_hint_hash: sourceNotSeen?.hint_hash,
    source_not_seen_note: sourceNotSeen?.note,
    winner_profit_wei: winnerProfit.winner_profit_wei,
    winner_profit_usd: winnerProfit.winner_profit_usd,
    touched_venues: winner.touchedVenues,
    missing_venues: missingVenues,
    funnel: funnelEntry,
    learning_case: learningCase,
  };
}

function classifyNonComparable(
  winner: JoinedTx,
  victim: JoinedTx,
  winnerStyle?: WinnerStyle,
): { primary_gap?: PrimaryGap; reason?: string; winner_style?: WinnerStyle } {
  if (victim.from && winner.from && victim.from === winner.from) {
    return {
      primary_gap: "scan_not_triggered",
      reason: "atomic_self_victim",
      winner_style: "unknown",
    };
  }
  if (victim.pools.length >= 2) {
    return {
      primary_gap: "scan_not_triggered",
      reason: "atomic_prior_tx_is_multi_pool_arb",
      winner_style: "unknown",
    };
  }

  if (winnerStyle && isNonComparableWinnerStyle(winnerStyle)) {
    return {
      primary_gap: "non_comparable_winner",
      reason: winnerStyle,
      winner_style: winnerStyle,
    };
  }
  return {};
}

function classifyPrimaryGap(
  funnelEntry: FunnelVictimState | undefined,
  missingVenues: TouchedVenue[],
): PrimaryGap {
  if (!funnelEntry?.seen) return "source_not_seen";
  if (missingVenues.length > 0) return "venue_missing";
  if (funnelEntry.submitted) return "outbid";
  return primaryGapFromDrops(funnelEntry.drops);
}

function primaryGapFromDrops(drops: FunnelDrop[]): PrimaryGap {
  for (const drop of [...drops].reverse()) {
    const key = `${drop.stage ?? ""}/${drop.reason} ${drop.error ?? ""}`.toLowerCase();
    if (key.includes("no_candidate") || key.includes("path") || key.includes("plan")) return "path_not_found";
    if (key.includes("quote-timeout") || key.includes("quote_failed") || key.includes("quote failed")) return "quote_failed";
    if (key.includes("sim-revert") || key.includes("sim_failed") || key.includes("simulate") || key.includes("revm")) return "sim_failed";
    if (key.includes("below_ev") || key.includes("below-final") || key.includes("below_final") || key.includes("no-profitable")) return "below_ev";
    if (key.includes("gas")) return "gas_underwater";
    if (key.includes("sizing") || key.includes("amount")) return "sizing_failed";
  }
  return "manual_required";
}

function gapDetail(
  primaryGap: PrimaryGap,
  nonComparableReason: string | undefined,
  funnelEntry: FunnelVictimState | undefined,
  sourceNotSeen?: SourceNotSeenAttribution,
): string | undefined {
  if (nonComparableReason) return nonComparableReason;
  if (primaryGap === "source_not_seen") {
    if (!sourceNotSeen) return "no_opportunity_seen_for_landed_victim";
    return sourceNotSeen.drop_reason
      ? `${sourceNotSeen.reason}:${sourceNotSeen.drop_reason}`
      : sourceNotSeen.reason;
  }
  if (primaryGap === "outbid") return funnelEntry?.bid ? `submitted_bid_wei=${funnelEntry.bid}` : "bundle_submitted";
  const lastDrop = funnelEntry?.drops.at(-1);
  return lastDrop ? `${lastDrop.stage ?? "unknown"}/${lastDrop.reason}` : undefined;
}

async function fetchBlockFromRpc(rpc: RpcClient, blockNumber: number): Promise<OnchainScanBlock> {
  const [block, rawReceipts] = await Promise.all([
    rpc.getBlockByNumber(blockNumber, true),
    rpc.call<unknown[]>("eth_getBlockReceipts", [toQuantity(blockNumber)]),
  ]);
  if (!block) throw new Error(`block ${blockNumber} not found`);
  return {
    number: blockNumber,
    timestamp: quantityToNumber(block.timestamp),
    baseFeePerGas: optionalString(block.baseFeePerGas),
    miner: optionalString(block.miner),
    transactions: normalizeBlockTransactions(block.transactions),
    receipts: parseRpcReceipts(rawReceipts),
  };
}

function makeRpcWinnerAnalysis(rpc: RpcClient): {
  classifyWinnerStyle: OnchainWinnerStyleClassifier;
  priceWinner: OnchainWinnerProfitPricer;
} {
  let ethUsd: Promise<number> | null = null;
  const profitCache = new Map<string, Promise<{ profit: ArbProfit; ethUsd: number }>>();

  const getEthUsd = (): Promise<number> => {
    ethUsd ??= fetchEthUsd(rpc);
    return ethUsd;
  };
  const getProfit = (block: OnchainScanBlock, winner: JoinedTx): Promise<{ profit: ArbProfit; ethUsd: number }> => {
    const existing = profitCache.get(winner.hash);
    if (existing) return existing;
    const promise = (async () => {
      const mark = await getEthUsd();
      const tx = txForPricing(winner);
      const profit = await priceArb(rpc, winner.hash, tx, winner.receipt, mark, {
        entityActors: winnerProfitActors(winner),
        allowTrace: true,
        coinbase: lower(block.miner ?? ""),
        baseFeePerGas: hexToBigInt(block.baseFeePerGas),
      });
      return { profit, ethUsd: mark };
    })();
    profitCache.set(winner.hash, promise);
    return promise;
  };

  const classifyWinnerStyle: OnchainWinnerStyleClassifier = async ({ block, winner }) => {
    try {
      const tx = txForPricing(winner);
      const { profit } = await getProfit(block, winner);
      const style = await classifyWinnerTxStyle({
        rpc,
        txHash: winner.hash,
        tx,
        receipt: winner.receipt,
        profit,
        transactionIndex: winner.index,
        blockNumber: block.number,
        prestateBlock: Math.max(block.number - 1, 0),
      });
      return style.winner_style;
    } catch {
      return undefined;
    }
  };

  const priceWinner: OnchainWinnerProfitPricer = async ({ block, winner }) => {
    try {
      const { profit, ethUsd: mark } = await getProfit(block, winner);
      return winnerProfitFromArbProfit(profit, mark);
    } catch {
      return emptyWinnerProfit();
    }
  };

  return { classifyWinnerStyle, priceWinner };
}

function makeLogOnlyWinnerProfitPricer(ethUsd?: number): OnchainWinnerProfitPricer {
  const mark = Number.isFinite(ethUsd) && ethUsd !== undefined ? ethUsd : null;
  return async ({ winner }) => {
    try {
      const profit = await priceArb({} as RpcClient, winner.hash, txForPricing(winner), winner.receipt, mark ?? 0, {
        entityActors: winnerProfitActors(winner),
        allowTrace: false,
      });
      return winnerProfitFromArbProfit(profit, mark);
    } catch {
      return emptyWinnerProfit();
    }
  };
}

function txForPricing(winner: JoinedTx): { hash: string; from: string; to: string | null } {
  return {
    hash: winner.hash,
    from: winner.from,
    to: winner.to,
  };
}

function winnerProfitActors(winner: JoinedTx): string[] {
  return [winner.to, winner.from].filter((actor): actor is string => Boolean(actor));
}

function winnerProfitFromArbProfit(profit: ArbProfit, ethUsd: number | null): WinnerProfit {
  const wethDeltas = profit.pricedDeltas.filter((delta) => lower(delta.token) === lower(ADDR.WETH));
  const wethWei = wethDeltas.reduce((sum, delta) => sum + delta.raw, 0n);
  const nativeWei = profit.nativeTraceUsed ? ethFloatToWei(profit.ethDeltaEth) : 0n;
  const ethWethWei = wethWei + nativeWei;
  const hasEthWethSignal = wethDeltas.length > 0 || nativeWei !== 0n;
  const realizedUsd = ethUsd === null && wethDeltas.length > 0 ? null : profit.realizedProfitUsd;
  const ethWethUsd = ethUsd !== null && hasEthWethSignal
    ? Number(ethWethWei) / 1e18 * ethUsd
    : null;

  return {
    winner_profit_wei: hasEthWethSignal ? ethWethWei.toString() : null,
    winner_profit_usd: realizedUsd ?? ethWethUsd,
  };
}

function ethFloatToWei(value: number): bigint {
  if (!Number.isFinite(value) || value === 0) return 0n;
  return BigInt(Math.round(value * 1e18));
}

function emptyWinnerProfit(): WinnerProfit {
  return {
    winner_profit_wei: null,
    winner_profit_usd: null,
  };
}

function normalizeBlockTransactions(value: unknown): OnchainScanTx[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tx, index): OnchainScanTx | null => {
      if (typeof tx === "string") {
        return { hash: lower(tx), transactionIndex: index };
      }
      if (!isRecord(tx)) return null;
      const hash = normalizeHash(optionalString(tx.hash));
      if (!hash) return null;
      return {
        hash,
        from: lower(optionalString(tx.from) ?? ""),
        to: optionalString(tx.to) ? lower(optionalString(tx.to)) : null,
        transactionIndex: quantityToNumber(tx.transactionIndex) ?? index,
      } satisfies OnchainScanTx;
    })
    .filter((tx): tx is OnchainScanTx => tx !== null);
}

function parseRpcReceipts(value: unknown): OnchainScanReceipt[] {
  if (!Array.isArray(value)) throw new Error("eth_getBlockReceipts returned a non-array value");
  return value.map((receipt) => {
    if (!isRecord(receipt)) return { logs: [] };
    return {
      transactionHash: optionalString(receipt.transactionHash),
      blockNumber: optionalString(receipt.blockNumber),
      transactionIndex: optionalString(receipt.transactionIndex),
      from: optionalString(receipt.from),
      to: optionalString(receipt.to) ?? null,
      status: optionalString(receipt.status),
      gasUsed: optionalString(receipt.gasUsed),
      effectiveGasPrice: optionalString(receipt.effectiveGasPrice),
      logs: Array.isArray(receipt.logs)
        ? receipt.logs.filter(isRecord).map((log) => log as Json)
        : [],
    };
  });
}

function joinBlockTxs(block: OnchainScanBlock, graph: GraphMembership): JoinedTx[] {
  const txByHash = new Map(block.transactions.map((tx) => [lower(tx.hash), tx]));
  const out: JoinedTx[] = [];

  for (let fallbackIndex = 0; fallbackIndex < block.receipts.length; fallbackIndex++) {
    const receipt = block.receipts[fallbackIndex];
    const hash = normalizeHash(optionalString(receipt.transactionHash)) ?? normalizeHash(block.transactions[fallbackIndex]?.hash);
    if (!hash) continue;
    const tx = txByHash.get(hash) ?? block.transactions[fallbackIndex];
    const index = quantityToNumber(receipt.transactionIndex) ?? tx?.transactionIndex ?? fallbackIndex;
    const from = lower(optionalString(tx?.from ?? receipt.from) ?? "");
    const toValue = optionalString(tx?.to ?? receipt.to);
    const to = toValue ? lower(toValue) : null;
    const touchedVenues = extractTouchedVenues(receipt, graph);
    out.push({
      hash,
      from,
      to,
      index,
      receipt,
      pools: uniq(touchedVenues.map((venue) => lower(venue.id))),
      touchedVenues,
    });
  }

  return out.sort((a, b) => a.index - b.index);
}

function nearestPriorSharingPool(txs: JoinedTx[], winnerPosition: number, winnerPools: string[]): JoinedTx | null {
  const winnerPoolSet = new Set(winnerPools);
  for (let i = winnerPosition - 1; i >= 0; i--) {
    const candidate = txs[i];
    if (candidate?.pools.some((pool) => winnerPoolSet.has(pool))) return candidate;
  }
  return null;
}

function isOurExecutorTx(tx: JoinedTx, prefixes: string[]): boolean {
  if (prefixes.length === 0) return false;
  return prefixes.some((prefix) =>
    (tx.from && tx.from.startsWith(prefix)) || (tx.to && tx.to.startsWith(prefix))
  );
}

function reportVenue(venue: TouchedVenue): Record<string, unknown> {
  return {
    protocol: venue.protocol,
    id: venue.id,
    emitter: venue.emitter,
    in_graph: venue.in_graph,
  };
}

function summarizeCases(cases: OnchainCaseReport[]): Partial<Record<PrimaryGap, number>> {
  const out: Partial<Record<PrimaryGap, number>> = {};
  for (const item of cases) out[item.primary_gap] = (out[item.primary_gap] ?? 0) + 1;
  return out;
}

function summarizeSourceNotSeenReasons(cases: OnchainCaseReport[]): Partial<Record<SourceNotSeenReason, number>> {
  const out: Partial<Record<SourceNotSeenReason, number>> = {};
  for (const item of cases) {
    if (item.primary_gap !== "source_not_seen" || !item.source_not_seen_reason) continue;
    out[item.source_not_seen_reason] = (out[item.source_not_seen_reason] ?? 0) + 1;
  }
  return out;
}

function summarizeWinnerProfitByGap(cases: OnchainCaseReport[]): Partial<Record<PrimaryGap, WinnerProfitRollup>> {
  const groups = new Map<PrimaryGap, OnchainCaseReport[]>();
  for (const item of cases) groups.set(item.primary_gap, [...(groups.get(item.primary_gap) ?? []), item]);

  const out: Partial<Record<PrimaryGap, WinnerProfitRollup>> = {};
  for (const [gap, items] of groups) {
    const profits = items
      .map((item) => item.winner_profit_usd)
      .filter((profit): profit is number => typeof profit === "number" && Number.isFinite(profit))
      .sort((a, b) => a - b);
    out[gap] = {
      cases: items.length,
      priced_cases: profits.length,
      median_usd: median(profits),
      p90_usd: percentileNearestRank(profits, 0.9),
      dust_share: profits.length === 0
        ? null
        : profits.filter((profit) => profit < 1).length / profits.length,
    };
  }
  return out;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[mid] ?? null;
  return ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
}

function percentileNearestRank(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * q) - 1));
  return values[index] ?? null;
}

function blockRange(fromBlock: number, toBlock: number): number[] {
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
    throw new Error(`Invalid block range ${fromBlock}..${toBlock}`);
  }
  return Array.from({ length: toBlock - fromBlock + 1 }, (_, i) => fromBlock + i);
}

function learningCaseId(parts: {
  strategy_kind: string;
  trigger: string;
  competitor_tx?: string;
  source_block?: number;
  cycle_fingerprint?: string;
  primary_gap: PrimaryGap;
}): string {
  return ethers.id([
    parts.strategy_kind,
    parts.trigger,
    parts.competitor_tx ?? "",
    parts.source_block ?? "",
    parts.cycle_fingerprint ?? "",
    parts.primary_gap,
  ].join("|"));
}

async function readJsonlSkippingBad(path: string): Promise<{ events: Json[]; parsed: number; skipped: number }> {
  const text = await readFile(path, "utf8");
  const events: Json[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      skipped++;
    }
  }
  return { events, parsed: events.length, skipped };
}

function latestRunId(events: Json[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const runId = optionalString(events[i]?.run_id);
    if (runId) return runId;
  }
  return undefined;
}

function getFunnelEntry(victims: Map<string, FunnelVictimState>, victim: string): FunnelVictimState {
  const existing = victims.get(victim);
  if (existing) return existing;
  const entry: FunnelVictimState = {
    victim_hash: victim,
    seen: false,
    sim_ok: false,
    submitted: false,
    drops: [],
    opportunity_ids: [],
  };
  victims.set(victim, entry);
  return entry;
}

function getHintEntry(hints: Map<string, FunnelHintState>, hash: string): FunnelHintState {
  const existing = hints.get(hash);
  if (existing) return existing;
  const entry: FunnelHintState = {
    hash,
    seen: false,
    drops: [],
    event_types: [],
  };
  hints.set(hash, entry);
  return entry;
}

function dropFromEvent(event: Json): FunnelDrop {
  return {
    stage: optionalString(event.stage),
    reason: optionalString(event.reason) ?? "unknown",
    error: optionalString(event.error),
  };
}

function collectEventHashes(event: Json): string[] {
  const out = new Set<string>();
  for (const key of [
    "victim_hash",
    "victimHash",
    "tx_hash",
    "txHash",
    "transactionHash",
    "pending_hash",
    "pendingHash",
    "hash",
  ]) {
    addHash(out, event[key]);
  }
  addHash(out, event.tx?.hash);
  if (Array.isArray(event.hashes)) {
    for (const hash of event.hashes) addHash(out, hash);
  }
  return [...out];
}

function addHash(out: Set<string>, value: unknown): void {
  const hash = normalizeHash(optionalString(value));
  if (hash) out.add(hash);
}

function latestMempoolAllowlist(events: Json[]): Set<string> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== "mempool_filter_config") continue;
    const raw = event.to_addresses ?? event.toAddresses ?? event.allowlist ?? event.mempool_allowlist;
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.map((item) => normalizeAddress(optionalString(item))).filter((item): item is string => Boolean(item)));
  }
  return null;
}

interface FunnelMatch {
  entry?: FunnelVictimState;
  hint_hash?: string;
}

interface SourceNotSeenAttribution {
  reason: SourceNotSeenReason;
  drop_reason?: string;
  hint_hash?: string;
  note?: string;
}

function findFunnelMatch(funnel: FunnelIndex, realHash: string): FunnelMatch {
  for (const hash of hashAliases(realHash)) {
    const entry = funnel.victims.get(hash);
    if (entry) return { entry, hint_hash: hash };
  }
  return {};
}

function classifySourceNotSeenReason(victim: JoinedTx, funnel: FunnelIndex): SourceNotSeenAttribution {
  const missingVictimPools = victim.touchedVenues.filter((venue) => venue.in_graph === false);
  if (missingVictimPools.length > 0) return { reason: "pool_not_in_graph" };

  if (funnel.mempool_allowlist && (!victim.to || !funnel.mempool_allowlist.has(lower(victim.to)))) {
    return { reason: "to_not_admissible" };
  }

  const hint = findHintEvidence(funnel, victim.hash);
  if (hint) {
    const lastDrop = hint.drops.at(-1);
    return {
      reason: "received_but_dropped",
      drop_reason: lastDrop ? `${lastDrop.stage ?? "unknown"}/${lastDrop.reason}` : undefined,
      hint_hash: hint.hash,
    };
  }

  return {
    reason: "not_received",
    note: "not_further_separable_without_external_mempool_archive",
  };
}

function findHintEvidence(funnel: FunnelIndex, realHash: string): FunnelHintState | undefined {
  for (const hash of hashAliases(realHash)) {
    const hint = funnel.hints.get(hash);
    if (hint && (hint.event_types.length > 0 || hint.drops.length > 0 || hint.seen)) return hint;
  }
  return undefined;
}

function hashAliases(realHash: string): string[] {
  const out = [realHash];
  try {
    out.push(lower(ethers.keccak256(realHash)));
  } catch {
    // A normalized tx hash is valid BytesLike; keep the real hash if this ever fails.
  }
  return uniq(out);
}

function renderSummary(report: {
  events: { path: string; run_id: string | null; parsed: number; skipped_unparsable: number; indexed_victims: number };
  graph: { status: string; path: string; entries: number };
  start_block: number;
  end_block: number;
  scanned_blocks: number;
  competed_backruns: number;
  summary: Partial<Record<PrimaryGap, number>>;
  source_not_seen_reasons: Partial<Record<SourceNotSeenReason, number>>;
  winner_profit_by_primary_gap: Partial<Record<PrimaryGap, WinnerProfitRollup>>;
  cases: OnchainCaseReport[];
  write: boolean;
  stored_cases: number;
}): string {
  const lines = [
    "onchain-loss-scan",
    `blocks: ${report.start_block}..${report.end_block} scanned=${report.scanned_blocks}`,
    `events: path=${report.events.path} run_id=${report.events.run_id ?? "all"} parsed=${report.events.parsed} indexed_victims=${report.events.indexed_victims}`,
    `graph: ${report.graph.status}${report.graph.status === "loaded" ? ` entries=${report.graph.entries}` : ""} path=${report.graph.path}`,
    "ATTRIBUTION SUMMARY",
  ];

  const gaps = Object.entries(report.summary).sort(([a], [b]) => a.localeCompare(b));
  if (gaps.length === 0) lines.push("  none: 0");
  else for (const [gap, count] of gaps) lines.push(`  ${gap}: ${count}`);

  const reasons = Object.entries(report.source_not_seen_reasons).sort(([a], [b]) => a.localeCompare(b));
  if (reasons.length > 0) {
    lines.push("  source_not_seen_reasons:");
    for (const [reason, count] of reasons) lines.push(`    ${reason}: ${count}`);
  }

  const profitRollups = Object.entries(report.winner_profit_by_primary_gap).sort(([a], [b]) => a.localeCompare(b));
  if (profitRollups.length > 0) {
    lines.push("  winner_profit_by_primary_gap:");
    for (const [gap, rollup] of profitRollups) {
      lines.push(
        `    ${gap}: cases=${rollup.cases} priced=${rollup.priced_cases} ` +
        `median=${formatUsd(rollup.median_usd)} p90=${formatUsd(rollup.p90_usd)} ` +
        `dust_share=${formatShare(rollup.dust_share)}`,
      );
    }
  }

  lines.push(`competed_backruns: ${report.competed_backruns}`);
  for (const item of report.cases) {
    const missing = item.missing_venues.map((venue) => `${venue.protocol}:${short(venue.id)}`).join(",");
    lines.push(
      `case block=${item.block} winner=${short(item.winner_tx)} victim=${short(item.victim_tx)} ` +
      `gap=${item.primary_gap} comparable=${String(item.comparable)} ` +
      `winner_index=${item.winner_index} victim_index=${item.victim_index}` +
      `${item.source_not_seen_reason ? ` source_not_seen_reason=${item.source_not_seen_reason}` : ""}` +
      `${item.source_not_seen_note ? ` source_not_seen_note=${item.source_not_seen_note}` : ""}` +
      `${item.winner_profit_usd !== null ? ` winner_profit_usd=${formatUsd(item.winner_profit_usd)}` : ""}` +
      `${missing ? ` missing=${missing}` : ""}`,
    );
  }
  lines.push(report.write ? `write: upserted=${report.stored_cases}` : "write: dry-run (pass --write to upsert)");
  return lines.join("\n");
}

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

function stringArg(args: Record<string, string | boolean>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) usage();
  return "";
}

function numberArg(args: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePrefixes(value: string | boolean | undefined): string[] {
  if (!value || value === true) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((item) => lower(item.trim()))
    .filter((item) => item.startsWith("0x") && item.length > 2);
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function normalizeAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = lower(value);
  return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : undefined;
}

function normalizeHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = lower(value);
  return /^0x[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function quantityToNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string") return undefined;
  return Number(hexToBigInt(value));
}

function timestampFromBlock(block: OnchainScanBlock): string {
  if (block.timestamp !== undefined && block.timestamp >= 0) return new Date(block.timestamp * 1000).toISOString();
  return "1970-01-01T00:00:00.000Z";
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatUsd(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : `$${value.toFixed(2)}`;
}

function formatShare(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(3);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, jsonReplacer, 2)}\n`);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Map
    ? Object.fromEntries(value)
    : value instanceof Set
      ? [...value]
      : typeof value === "bigint"
        ? value.toString()
        : value;
}

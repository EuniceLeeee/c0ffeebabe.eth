import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { actionsFromLogs } from "../actions/from-logs.js";
import { canonicalSequence, pathTemplate } from "../actions/canonicalize.js";
import { runCompetitorScan } from "../competitor-scan.js";
import { roughValueUsd } from "../pnl/raw-delta.js";
import { aggregateNetProfit, priceArb, fetchEthUsd, type PricedLeg, type V4Swap } from "../pnl/arb-profit.js";
import { ADDR, lower, short, TOPICS } from "../registry/protocols.js";
import { resolveV4PoolKeys } from "../registry/v4-poolkeys.js";
import { isPublicRouter } from "../registry/routers.js";
import { RpcClient, toQuantity } from "../rpc/client.js";
import { mapLimit, parseArgs, uniq, writeText } from "../util.js";
import {
  blockScanActivityAtBlock,
  blockScanSourceBlockForTarget,
  type BlockScanActivity,
  type BlockScanLogStatus,
} from "./bundle-postmortem.js";
import {
  findVenueByFactory,
  findVenueBySeed,
  findVenueCapability,
  type VenueId,
} from "../../../listener/src/searcher/venues/capability.js";

// Declared before the top-level `await main()` (below) so they are initialized when the
// CLI entrypoint runs — a const in the temporal dead zone would ReferenceError at runtime.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_POOLS_DIR = resolve(REPO_ROOT, "listener/searcher/pools");
const DEFAULT_BLOCKSCAN_LOG = "/var/log/mev-live.log";
const UNIV4_POOL_MANAGER = lower(ADDR.UNIV4_POOL_MANAGER);
const UNIV4_SWAP_TOPIC = lower(TOPICS.univ4Swap);

let args: Record<string, string | boolean> = {};
let eventsPath = "";
let graphPoolsPath = "";
let activePoolsPath = "";
let rpcUrl = "";
let v4ArchiveRpcUrl = "";
let fromBlockArg: number | undefined;
let toBlockArg: number | undefined;
let priceTrace = false;
let output: string | undefined;
let watch: string[] = [];
let competitorScan = false;
let notSeenScan = false;
let maxBlocks = 200;
let blockScanLogPath = DEFAULT_BLOCKSCAN_LOG;
let blockScanLog: WatchBlockScanLog = { path: DEFAULT_BLOCKSCAN_LOG, text: null, error: "not loaded" };
let blockScanActivityBySource = new Map<number, BlockScanActivity>();
let rpc: RpcClient;
let events: any[] = [];
let routingGraphPools: Set<string> | null = null;
let activeV4PoolIds = new Set<string>();

async function main(): Promise<void> {
  args = parseArgs(process.argv.slice(2));
  eventsPath = args.events ? String(args.events) : "";
  graphPoolsPath = args["graph-pools"] ? resolveCliPath(String(args["graph-pools"])) : defaultGraphPoolsPath();
  activePoolsPath = args["active-pools"]
    ? resolveCliPath(String(args["active-pools"]))
    : defaultActivePoolsPath(graphPoolsPath);
  rpcUrl = String(args.rpc ?? process.env.READONLY_RPC_URL ?? process.env.MAINNET_RPC_URL ?? "");
  v4ArchiveRpcUrl = typeof args["v4-archive-rpc"] === "string"
    ? String(args["v4-archive-rpc"])
    : String(process.env.MAINNET_RPC_URL ?? "");
  fromBlockArg = args["from-block"] ? Number(args["from-block"]) : undefined;
  toBlockArg = args["to-block"] ? Number(args["to-block"]) : undefined;
  priceTrace = Boolean(args["price-trace"]);
  output = args.output ? String(args.output) : undefined;
  watch = parseWatch(args.watch);
  competitorScan = Boolean(args["competitor-scan"]);
  notSeenScan = Boolean(args["not-seen-scan"]);
  maxBlocks = Number(args["max-blocks"] ?? 200);
  blockScanLogPath = args["blockscan-log"]
    ? resolveCliPath(String(args["blockscan-log"]))
    : DEFAULT_BLOCKSCAN_LOG;

  if (!eventsPath) {
    console.error(
      "Usage: pnpm analysis live-loss --events ./analysis/events/searcher.jsonl " +
        "(--competitor-scan | --watch <addr[,addr]>) --rpc <url> [--blockscan-log /var/log/mev-live.log]",
    );
    process.exit(1);
  }

  rpc = new RpcClient(rpcUrl);
  events = await readJsonl(eventsPath);
  routingGraphPools = readRoutingGraphPools(graphPoolsPath);
  activeV4PoolIds = readActiveV4PoolIds(activePoolsPath);
  if (competitorScan) {
    await runCompetitorScan({ eventsPath, events, rpc, notSeenScan });
    process.exit(0);
  }
  if (watch.length > 0) {
    blockScanLog = await readWatchBlockScanLog(blockScanLogPath);
    blockScanActivityBySource = new Map();
    if (blockScanLog.error) {
      console.error(
        `[analysis/live-loss/watch] blockscan_log=${blockScanLog.path} unavailable: ${blockScanLog.error}`,
      );
    }
    await runWatchMode();
    process.exit(0);
  }
  console.error("Usage error: pass --competitor-scan or --watch <addr[,addr]>.");
  process.exit(1);
}

// LP action topic sets — MUST be declared before the top-level `await main()` entrypoint below:
// top-level await pauses module evaluation, so any const declared after it stays in the TDZ when the
// watch path (classifyLpAction) runs inside main() → ReferenceError. (Regression from 6ff3d4d, which
// placed these after the entrypoint; keep every main()-reachable const above the guard.)
const LP_MINT_TOPICS = new Set([
  lower(TOPICS.univ2Mint),
  lower(TOPICS.univ3Mint),
]);
const LP_BURN_TOPICS = new Set([
  lower(TOPICS.univ2Burn),
  lower(TOPICS.univ3Burn),
]);
const LP_ACTION_TOPICS = new Set([...LP_MINT_TOPICS, ...LP_BURN_TOPICS]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export type WatchPrimaryReason =
  | "not_seen"
  | "seen_but_lost"
  | "blockscan_ran_no_jsonl_signal"
  | "unknown_without_blockscan_evidence";

export type WatchPrimaryReasonBasis =
  | "backrun_event_overlap"
  | "blockscan_source_pass_complete"
  | "blockscan_source_pass_absent"
  | "blockscan_evidence_unavailable_or_incomplete";

export interface WatchBlockScanLog {
  path: string;
  text: string | null;
  error?: string;
}

export interface WatchBlockScanAudit {
  target_block: number;
  source_block: number;
  log_path: string;
  status: BlockScanLogStatus | "log_unavailable";
  ran: boolean;
  detail_complete: boolean;
  solve_ring_count: number;
  solve_ring_token_count: number;
  competitor_token_count: number;
  candidate_ring_token_overlap_count: number;
  candidate_ring_token_overlap_tokens: string[];
  any_submission_in_source_pass: boolean;
  route_match_proven: false;
  log_min_source_block?: number;
  log_max_source_block?: number;
  log_error?: string;
  limitations: string[];
}

export interface WatchVisibilityDecision {
  primaryReason: WatchPrimaryReason;
  primaryReasonBasis: WatchPrimaryReasonBasis;
}

export interface WatchReport {
  block: number;
  competitorTx: string;
  competitorAddr: string[];
  primaryReason: WatchPrimaryReason;
  primaryReasonBasis: WatchPrimaryReasonBasis;
  seenScope: "same_pool" | "same_token" | "block_only" | "none";
  seenScopeLane: "backrun_events";
  blockscan_lane: WatchBlockScanAudit;
  canonicalSequence: string[];
  pathTemplate: string;
  pools: string[];
  tokens: string[];
  pool_in_seen_events: boolean;
  pool_in_routing_graph: boolean | null;
  gap_type: GapType | null;
  venue_gap_type: VenueGapType | null;
  venue_gaps: VenueGap[];
  competitorEdge: string[];
  protocols: string[];
  roughProfit: number | null;      // ERC20-only, WETH@0 (legacy; kept for continuity)
  realized_profit_usd: number | null; // ERC20(incl WETH@ethUsd) + native ETH (v4-aware)
  builder_payment_eth: number | null;
  builder_payment_usd: number | null;
  lp_action: boolean;
  jit_lp: boolean;
  profit_confidence: string;
  unpriced_deltas: number;
  unpriced_delta_symbols: string[];
  eth_profit_usd: number;
  v4_swaps: number;
  v4_pools: number;
  v4_pool_ids: string[];
  v4_swaps_detail: V4Swap[];
  trace_used: boolean;
  nextAction: string[];
  rawDeltas: unknown[];
}

type GapType = "graph_gap" | "detection_gap" | "unknown";
export type VenueGapType = "venue_class_gap" | "pool_gap" | "execution_adapter_gap" | "detection_gap" | "unknown";

export interface VenueGap {
  pool: string;
  venue: VenueId | "unknown";
  factory: string | null;
  gap_type: VenueGapType;
  pool_in_routing_graph: boolean | null;
  discoverable: boolean | null;
  quotable: boolean | null;
  buildable: boolean | null;
  supported_in_prod: boolean | null;
}

export interface VenueIdentityFixture {
  address: string;
  venue: VenueId | "unknown";
  factory?: string | null;
}

export interface SeenSet {
  pools: Set<string>;
  tokens: Set<string>;
  any: boolean;
}

export interface PoolIdentity {
  pool: string;
  venue?: VenueId | "unknown";
  factory?: string | null;
}

export interface NonceCheckResult {
  ok: boolean;
  missing: number;
}

export function nonceCheck(nonceDelta: number, matchedFrom: number): NonceCheckResult {
  const missing = Math.max(0, nonceDelta - matchedFrom);
  return { ok: missing === 0, missing };
}

export function classifyLpAction(logs: any[]): { lp_action: boolean; jit_lp: boolean } {
  let hasMint = false;
  let hasBurn = false;
  for (const log of logs ?? []) {
    const topic0 = lower(String(log?.topics?.[0] ?? ""));
    if (!LP_ACTION_TOPICS.has(topic0)) continue;
    if (LP_MINT_TOPICS.has(topic0)) hasMint = true;
    if (LP_BURN_TOPICS.has(topic0)) hasBurn = true;
  }
  return { lp_action: hasMint || hasBurn, jit_lp: hasMint && hasBurn };
}

async function readJsonl(path: string): Promise<any[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid JSONL at ${path}:${i + 1}: ${(err as Error).message}`);
      }
    });
}

export function defaultBlockScanLogPath(): string {
  return DEFAULT_BLOCKSCAN_LOG;
}

export async function readWatchBlockScanLog(path = defaultBlockScanLogPath()): Promise<WatchBlockScanLog> {
  try {
    return { path, text: await readFile(path, "utf8") };
  } catch (err) {
    return {
      path,
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildWatchBlockScanAudit(
  targetBlock: number,
  competitorTokens: Iterable<string>,
  log: WatchBlockScanLog,
  activityCache?: Map<number, BlockScanActivity>,
): WatchBlockScanAudit {
  const sourceBlock = blockScanSourceBlockForTarget(targetBlock);
  const tokens = new Set(
    [...competitorTokens]
      .map(lower)
      .filter((token) => isAddress(token)),
  );
  const limitations = [
    "solve-ring token overlap is a candidate-level clue, not proof that the competitor route was seen",
    "submission text is source-pass-wide and cannot be attributed to this competitor transaction",
    "blockscan is an atomic standing-state lane; seenScope is derived separately from backrun JSONL events",
  ];

  if (log.text === null) {
    return {
      target_block: targetBlock,
      source_block: sourceBlock,
      log_path: log.path,
      status: "log_unavailable",
      ran: false,
      detail_complete: false,
      solve_ring_count: 0,
      solve_ring_token_count: 0,
      competitor_token_count: tokens.size,
      candidate_ring_token_overlap_count: 0,
      candidate_ring_token_overlap_tokens: [],
      any_submission_in_source_pass: false,
      route_match_proven: false,
      log_error: log.error ?? "log unavailable",
      limitations,
    };
  }

  let activity = activityCache?.get(sourceBlock);
  if (!activity) {
    activity = blockScanActivityAtBlock(log.text, sourceBlock);
    activityCache?.set(sourceBlock, activity);
  }
  const overlap = [...tokens]
    .filter((token) => activity.scannedTokens.has(token))
    .sort();
  return {
    target_block: targetBlock,
    source_block: sourceBlock,
    log_path: log.path,
    status: activity.status,
    ran: activity.ran,
    detail_complete: activity.detailComplete,
    solve_ring_count: activity.ringCount,
    solve_ring_token_count: activity.scannedTokens.size,
    competitor_token_count: tokens.size,
    candidate_ring_token_overlap_count: overlap.length,
    candidate_ring_token_overlap_tokens: overlap,
    any_submission_in_source_pass: activity.anySubmitted,
    route_match_proven: false,
    log_min_source_block: activity.minBlock,
    log_max_source_block: activity.maxBlock,
    limitations,
  };
}

export function classifyWatchVisibility(
  seenScope: WatchReport["seenScope"],
  blockScan: WatchBlockScanAudit,
): WatchVisibilityDecision {
  if (seenScope === "same_pool" || seenScope === "same_token") {
    return {
      primaryReason: "seen_but_lost",
      primaryReasonBasis: "backrun_event_overlap",
    };
  }
  if (blockScan.status === "complete") {
    return {
      primaryReason: "blockscan_ran_no_jsonl_signal",
      primaryReasonBasis: "blockscan_source_pass_complete",
    };
  }
  if (blockScan.status === "not_running" || blockScan.status === "skipped_busy") {
    return {
      primaryReason: "not_seen",
      primaryReasonBasis: "blockscan_source_pass_absent",
    };
  }
  return {
    primaryReason: "unknown_without_blockscan_evidence",
    primaryReasonBasis: "blockscan_evidence_unavailable_or_incomplete",
  };
}

export function isWatchNotSeen(reason: WatchPrimaryReason): boolean {
  return reason === "not_seen";
}

export function defaultGraphPoolsPath(): string {
  return resolve(DEFAULT_POOLS_DIR, "runtime-graph-pools.json");
}

export function defaultActivePoolsPath(graphPath = defaultGraphPoolsPath()): string {
  return resolve(dirname(graphPath), "active-pools.json");
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

export function readRoutingGraphPools(path = defaultGraphPoolsPath()): Set<string> | null {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8"));
    const arr = Array.isArray(j) ? j : j.pools || [];
    return new Set(
      arr
        .map((pool: any) => String(pool.address || pool).toLowerCase())
        .filter(isAddress),
    );
  } catch {
    return null;
  }
}

export function readActiveV4PoolIds(path = defaultActivePoolsPath()): Set<string> {
  try {
    if (!existsSync(path)) return new Set();
    const j = JSON.parse(readFileSync(path, "utf8"));
    const arr = Array.isArray(j) ? j : j.pools || [];
    return new Set(
      arr
        .filter((pool: any) => isUniv4Adapter(pool?.adapter))
        .map((pool: any) => lower(String(pool?.poolId ?? "")))
        .filter(isBytes32),
    );
  } catch {
    return new Set();
  }
}

function inferBlocks(items: any[]): number[] {
  const blocks = uniq(items.map((e) => Number(e.target_block ?? e.block)).filter((n) => Number.isFinite(n)));
  if (blocks.length === 0) throw new Error("No target_block values found in JSONL");
  return blocks.sort((a, b) => a - b);
}

function parseWatch(value: string | boolean | undefined): string[] {
  if (!value || value === true) return [];
  return uniq(String(value)
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^0x[a-fA-F0-9]{40}$/.test(x))
    .map(lower));
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isBytes32(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function isUniv4Adapter(value: unknown): boolean {
  const adapter = String(value ?? "").toLowerCase();
  return adapter === "univ4" || adapter.startsWith("univ4");
}

async function runWatchMode(): Promise<void> {
  const range = inferWatchRange(events);
  const seenByBlock = buildBackrunSeenByBlock(events);
  const watchSet = new Set(watch);
  const notSeenByGapType: Record<GapType, number> = {
    graph_gap: 0,
    detection_gap: 0,
    unknown: 0,
  };
  const notSeenByVenueGapType: Record<VenueGapType, number> = {
    venue_class_gap: 0,
    pool_gap: 0,
    execution_adapter_gap: 0,
    detection_gap: 0,
    unknown: 0,
  };
  const primaryReasonCounts: Record<WatchPrimaryReason, number> = {
    not_seen: 0,
    seen_but_lost: 0,
    blockscan_ran_no_jsonl_signal: 0,
    unknown_without_blockscan_evidence: 0,
  };
  const ethUsd = await fetchEthUsd(rpc);
  const allowTrace = priceTrace || rpc.isLocal();
  const pricedTxs: PricedLeg[] = [];
  const writtenReports: Array<{ outBase: string; report: WatchReport }> = [];
  const coinbaseByBlock = new Map<number, string | null>();
  const matchedFromByBot = new Map(watch.map((bot) => [bot, 0]));
  let written = 0;
  let builderPaymentTotalEth = 0;
  let builderPaymentTotalUsd = 0;
  let builderPaymentPricedTxs = 0;
  console.error(
    `[analysis/live-loss/watch] blocks=${range.from}-${range.to} watch=${watch.length} ethUsd=${ethUsd.toFixed(0)} ` +
      `price_trace=${allowTrace ? "on" : "off"} blockscan_log=${blockScanLog.path}`,
  );

  for (let blockNumber = range.from; blockNumber <= range.to; blockNumber++) {
    const block = await rpc.getBlockByNumber(blockNumber, true);
    const coinbase = cachedBlockCoinbase(coinbaseByBlock, blockNumber, block);
    const baseFeePerGas = block?.baseFeePerGas != null ? BigInt(block.baseFeePerGas) : undefined;
    const txs: any[] = Array.isArray(block.transactions) ? block.transactions : [];
    const matches = txs.filter((tx) => {
      const actors = [tx.from, tx.to].filter(Boolean).map(lower);
      return actors.some((actor) => watchSet.has(actor));
    });
    if (matches.length === 0) continue;
    for (const tx of matches) {
      const from = lower(tx?.from ?? "");
      if (watchSet.has(from)) matchedFromByBot.set(from, (matchedFromByBot.get(from) ?? 0) + 1);
    }

    console.error(`[analysis/live-loss/watch] block=${blockNumber} matches=${matches.length}`);
    await mapLimit(matches, 4, async (tx) => {
      const receipt = await rpc.getReceipt(tx.hash);
      if (!receipt || receipt.status !== "0x1") return;
      const report = await buildWatchReport(blockNumber, tx, receipt, seenByBlock);
      primaryReasonCounts[report.primaryReason]++;
      if (isWatchNotSeen(report.primaryReason) && report.gap_type) notSeenByGapType[report.gap_type]++;
      if (isWatchNotSeen(report.primaryReason) && report.venue_gap_type) notSeenByVenueGapType[report.venue_gap_type]++;
      const entityActors = inferWatchEntityActors(tx, report.competitorAddr);
      const profit = await priceArb(rpc, tx.hash, tx, receipt, ethUsd, {
        entityActors,
        allowTrace,
        coinbase: coinbase ?? undefined,
        baseFeePerGas,
      });
      report.realized_profit_usd = profit.realizedProfitUsd;
      report.builder_payment_eth = profit.builderPaymentEth;
      report.builder_payment_usd = profit.builderPaymentUsd;
      report.profit_confidence = profit.profitConfidence;
      report.unpriced_deltas = profit.unpricedDeltas.length;
      report.unpriced_delta_symbols = uniq(profit.unpricedDeltas.map((delta) => delta.symbol));
      report.eth_profit_usd = profit.ethProfitUsd;
      report.v4_swaps = profit.v4Swaps.length;
      report.v4_pools = profit.v4PoolIds.length;
      report.v4_pool_ids = profit.v4PoolIds;
      report.v4_swaps_detail = profit.v4Swaps;
      report.trace_used = profit.nativeTraceUsed;
      pricedTxs.push({
        bot: lower(report.competitorAddr[0] ?? ""),
        block: blockNumber,
        realized: profit.realizedProfitUsd,
        unsafe: profit.profitConfidence === "unsafe",
        hasV4: profit.v4Swaps.length > 0,
      });
      if (profit.builderPaymentEth !== null && profit.builderPaymentUsd !== null) {
        builderPaymentTotalEth += profit.builderPaymentEth;
        builderPaymentTotalUsd += profit.builderPaymentUsd;
        builderPaymentPricedTxs++;
      }
      const outBase = watchOutputBase(blockNumber, tx.hash);
      await writeText(resolve(`${outBase}.md`), renderWatchMarkdown(report));
      await writeText(resolve(`${outBase}.json`), JSON.stringify(report, jsonReplacer, 2));
      writtenReports.push({ outBase, report });
      written++;
      console.error(`[analysis/live-loss/watch] wrote ${outBase}.md`);
    });
  }
  await emitNonceCompletenessChecks(range, matchedFromByBot);
  await enrichWrittenV4Reports(writtenReports);
  console.error(`[analysis/live-loss/watch] reports=${written}`);
  console.error(
    `[analysis/live-loss/watch] primary_reasons not_seen=${primaryReasonCounts.not_seen} ` +
      `seen_but_lost=${primaryReasonCounts.seen_but_lost} ` +
      `blockscan_ran_no_jsonl_signal=${primaryReasonCounts.blockscan_ran_no_jsonl_signal} ` +
      `unknown_without_blockscan_evidence=${primaryReasonCounts.unknown_without_blockscan_evidence}`,
  );
  console.error(
    `[analysis/live-loss/watch] not_seen_gap_types graph_gap=${notSeenByGapType.graph_gap} ` +
      `detection_gap=${notSeenByGapType.detection_gap} unknown=${notSeenByGapType.unknown}`,
  );
  console.error(
    `[analysis/live-loss/watch] not_seen_venue_gap_types venue_class_gap=${notSeenByVenueGapType.venue_class_gap} ` +
      `pool_gap=${notSeenByVenueGapType.pool_gap} execution_adapter_gap=${notSeenByVenueGapType.execution_adapter_gap} ` +
      `detection_gap=${notSeenByVenueGapType.detection_gap} unknown=${notSeenByVenueGapType.unknown}`,
  );
  const netProfit = aggregateNetProfit(pricedTxs);
  console.error(
    `[analysis/live-loss/watch] net_per_block total=${netProfit.total.toFixed(0)} ` +
      `via_v4=${netProfit.viaV4.toFixed(0)} (ethUsd=${ethUsd.toFixed(0)})`,
  );
  console.error(
    `[analysis/live-loss/watch] builder_payment_total=${builderPaymentTotalEth.toFixed(6)} ETH ` +
      `($${builderPaymentTotalUsd.toFixed(2)}) priced_txs=${builderPaymentPricedTxs}`,
  );
}

async function emitNonceCompletenessChecks(
  range: { from: number; to: number },
  matchedFromByBot: Map<string, number>,
): Promise<void> {
  const startTag = toQuantity(range.from - 1);
  const endTag = toQuantity(range.to);
  for (const bot of watch) {
    try {
      const [nonceStartHex, nonceEndHex] = await Promise.all([
        rpc.call<string | null>("eth_getTransactionCount", [bot, startTag]),
        rpc.call<string | null>("eth_getTransactionCount", [bot, endTag]),
      ]);
      const nonceStart = parseRpcQuantity(nonceStartHex);
      const nonceEnd = parseRpcQuantity(nonceEndHex);
      if (nonceStart === null || nonceEnd === null || nonceEnd < nonceStart) {
        console.error(`[analysis/live-loss/watch] nonce_check bot=${bot} unavailable`);
        continue;
      }
      const nonceDelta = nonceEnd - nonceStart;
      const matchedFrom = matchedFromByBot.get(bot) ?? 0;
      const check = nonceCheck(nonceDelta, matchedFrom);
      const status = check.ok ? "OK" : `MISMATCH(-${check.missing})`;
      console.error(
        `[analysis/live-loss/watch] nonce_check bot=${bot} nonce_delta=${nonceDelta} ` +
          `matched_from=${matchedFrom} ${status}`,
      );
    } catch {
      console.error(`[analysis/live-loss/watch] nonce_check bot=${bot} unavailable`);
    }
  }
}

function parseRpcQuantity(value: string | null | undefined): number | null {
  if (!value || typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  return Number(BigInt(value));
}

function cachedBlockCoinbase(cache: Map<number, string | null>, blockNumber: number, block: any): string | null {
  if (cache.has(blockNumber)) return cache.get(blockNumber) ?? null;
  const coinbase = lower(block?.miner ?? "");
  const value = coinbase || null;
  cache.set(blockNumber, value);
  return value;
}

async function enrichWrittenV4Reports(items: Array<{ outBase: string; report: WatchReport }>): Promise<void> {
  const poolIds = uniq(items.flatMap(({ report }) => report.v4_pool_ids.map(lower))).filter(Boolean);
  if (poolIds.length === 0) return;
  if (!v4ArchiveRpcUrl) {
    console.error(
      `[analysis/live-loss/watch] v4_poolkeys skipped: set --v4-archive-rpc or MAINNET_RPC_URL to resolve ${poolIds.length} pool ids`,
    );
    return;
  }

  let poolKeys: Map<string, { currency0: string; currency1: string }>;
  try {
    poolKeys = await resolveV4PoolKeys(poolIds, new RpcClient(v4ArchiveRpcUrl));
  } catch (err) {
    console.error(`[analysis/live-loss/watch] v4_poolkeys failed: ${(err as Error).message}`);
    return;
  }

  let rewrote = 0;
  for (const { outBase, report } of items) {
    if (report.v4_swaps_detail.length === 0) continue;
    report.v4_swaps_detail = report.v4_swaps_detail.map((swap) => {
      const key = poolKeys.get(lower(swap.poolId));
      return key ? { ...swap, currency0: key.currency0, currency1: key.currency1 } : swap;
    });
    await writeText(resolve(`${outBase}.md`), renderWatchMarkdown(report));
    await writeText(resolve(`${outBase}.json`), JSON.stringify(report, jsonReplacer, 2));
    rewrote++;
  }
  console.error(
    `[analysis/live-loss/watch] v4_poolkeys requested=${poolIds.length} resolved=${poolKeys.size} rewrote=${rewrote}`,
  );
}

function inferWatchRange(items: any[]): { from: number; to: number } {
  const blocks = inferBlocks(items);
  const from = fromBlockArg ?? blocks[0];
  const to = toBlockArg ?? blocks[blocks.length - 1];
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new Error(`Invalid watch block range: ${from}-${to}`);
  }
  const span = to - from + 1;
  if (span > maxBlocks) {
    throw new Error(`Refusing to watch-scan ${span} blocks; pass a <=${maxBlocks} block range with --from-block/--to-block or raise --max-blocks`);
  }
  return { from, to };
}

function inferWatchEntityActors(tx: any, matched: string[]): string[] {
  const matchedSet = new Set(matched.map(lower).filter(Boolean));
  const actors = new Set(matchedSet);
  const from = lower(tx?.from ?? "");
  const to = lower(tx?.to ?? "");
  if (from && matchedSet.has(from)) actors.add(from);
  if (to) {
    if (isPublicRouter(to)) actors.delete(to);
    else actors.add(to);
  }
  return [...actors];
}

export function buildBackrunSeenByBlock(items: any[]): Map<number, SeenSet> {
  const out = new Map<number, SeenSet>();
  for (const e of items) {
    // block-scan-arb is the standing-state atomic lane. Keep it out of the
    // legacy/backrun seen scope so the two production paths remain auditable.
    if (e?.opportunity_kind === "block-scan-arb") continue;
    const block = Number(e.target_block ?? e.block);
    if (!Number.isFinite(block)) continue;
    const seen = out.get(block) ?? { pools: new Set<string>(), tokens: new Set<string>(), any: false };
    seen.any = true;
    if (e.pool) seen.pools.add(lower(String(e.pool)));
    for (const token of Array.isArray(e.tokens) ? e.tokens : []) {
      if (String(token).startsWith("0x")) seen.tokens.add(lower(String(token)));
    }
    out.set(block, seen);
  }
  return out;
}

async function buildWatchReport(
  block: number,
  tx: any,
  receipt: any,
  seenByBlock: Map<number, SeenSet>,
): Promise<WatchReport> {
  const matched = uniq([tx.from, tx.to].filter(Boolean).map(lower).filter((actor) => watch.includes(actor)));
  const actors = uniq([tx.from, tx.to, ...matched].filter(Boolean));
  const logResult = actionsFromLogs(receipt, actors);
  const sequence = canonicalSequence(logResult.actions);
  const poolIdentities = extractPoolIdentities(receipt);
  const pools = poolIdentities.map((pool) => pool.pool);
  const tokens = logResult.tokens.map(lower);
  const seen = seenByBlock.get(block) ?? { pools: new Set<string>(), tokens: new Set<string>(), any: false };
  const samePool = pools.some((pool) => seen.pools.has(pool));
  const sameToken = tokens.some((token) => seen.tokens.has(token));
  const seenScope = samePool ? "same_pool" : sameToken ? "same_token" : seen.any ? "block_only" : "none";
  const blockScanAudit = buildWatchBlockScanAudit(
    block,
    tokens,
    blockScanLog,
    blockScanActivityBySource,
  );
  const visibility = classifyWatchVisibility(seenScope, blockScanAudit);
  const primaryReason = visibility.primaryReason;
  const poolInSeenEvents = pools.some((pool) => seen.pools.has(pool));
  const graphPools = routingGraphPools;
  const poolInRoutingGraph = summarizePoolMembership(poolIdentities, graphPools, activeV4PoolIds);
  const venueGaps = await classifyVenueGapsForIdentities(poolIdentities, graphPools, activeV4PoolIds);
  const gapType = isWatchNotSeen(primaryReason) ? classifyGapType(poolInRoutingGraph) : null;
  const venueGapType = isWatchNotSeen(primaryReason) ? summarizeVenueGapType(venueGaps) : null;
  const lpAction = classifyLpAction(receipt.logs ?? []);

  return {
    block,
    competitorTx: tx.hash,
    competitorAddr: matched,
    primaryReason,
    primaryReasonBasis: visibility.primaryReasonBasis,
    seenScope,
    seenScopeLane: "backrun_events",
    blockscan_lane: blockScanAudit,
    canonicalSequence: sequence,
    pathTemplate: pathTemplate(sequence),
    pools,
    tokens,
    pool_in_seen_events: poolInSeenEvents,
    pool_in_routing_graph: poolInRoutingGraph,
    gap_type: gapType,
    venue_gap_type: venueGapType,
    venue_gaps: venueGaps,
    competitorEdge: competitorEdges(sequence),
    protocols: logResult.protocols,
    roughProfit: roughValueUsd(logResult.rawDeltas),
    realized_profit_usd: null, // filled by priceArb in runWatchMode (needs rpc + ethUsd)
    builder_payment_eth: null,
    builder_payment_usd: null,
    lp_action: lpAction.lp_action,
    jit_lp: lpAction.jit_lp,
    profit_confidence: "requires_decode",
    unpriced_deltas: 0,
    unpriced_delta_symbols: [],
    eth_profit_usd: 0,
    v4_swaps: 0,
    v4_pools: 0,
    v4_pool_ids: [],
    v4_swaps_detail: [],
    trace_used: false,
    nextAction: watchNextActions(primaryReason, seenScope, pools, blockScanAudit),
    rawDeltas: logResult.rawDeltas,
  };
}

function classifyGapType(poolInRoutingGraph: boolean | null): GapType {
  if (poolInRoutingGraph === null) return "unknown";
  return poolInRoutingGraph ? "detection_gap" : "graph_gap";
}

const factoryIface = new ethers.Interface(["function factory() view returns (address)"]);
const BYTECODE_SIGNATURES: Array<{ selector: string; venue: VenueId }> = [
  { selector: ethers.id("redeemSharesInKind(address,uint256,address[],uint256[])").slice(2, 10), venue: "enzyme" },
  { selector: ethers.id("redeemSharesInKind(address,uint256,address[],uint256[],address[])").slice(2, 10), venue: "enzyme" },
  { selector: ethers.id("smardexSwapCallback(int256,int256,bytes)").slice(2, 10), venue: "smardex" },
  { selector: ethers.id("getAmountOut(address,uint256)").slice(2, 10), venue: "ousd" },
];

export function classifyVenueGapsFromFixtures(
  fixtures: VenueIdentityFixture[],
  graphPools: Set<string> | null,
  v4PoolIds: Set<string> = new Set(),
): VenueGap[] {
  return fixtures.map((fixture) =>
    classifyResolvedVenue(fixture.address, fixture.venue, fixture.factory ?? null, graphPools, v4PoolIds),
  );
}

export function classifyVenueGapsFromLogFixtures(
  logs: any[],
  graphPools: Set<string> | null,
  v4PoolIds: Set<string> = new Set(),
): VenueGap[] {
  return extractPoolIdentities({ logs }).map((identity) =>
    classifyResolvedVenue(identity.pool, identity.venue ?? "unknown", identity.factory ?? null, graphPools, v4PoolIds),
  );
}

async function classifyVenueGapsForIdentities(
  identities: PoolIdentity[],
  graphPools: Set<string> | null,
  v4PoolIds: Set<string>,
): Promise<VenueGap[]> {
  return mapLimit(identities, 8, async (identity) => {
    if (identity.venue) {
      return classifyResolvedVenue(identity.pool, identity.venue, identity.factory ?? null, graphPools, v4PoolIds);
    }
    if (!isAddress(identity.pool)) {
      return classifyResolvedVenue(identity.pool, "unknown", null, graphPools, v4PoolIds);
    }
    const resolved = await resolveVenueForAddress(identity.pool);
    return classifyResolvedVenue(identity.pool, resolved.venue, resolved.factory, graphPools, v4PoolIds);
  });
}

async function resolveVenueForAddress(address: string): Promise<{ venue: VenueId | "unknown"; factory: string | null }> {
  const seeded = findVenueBySeed(address);
  if (seeded) return { venue: seeded.venue, factory: null };

  const factory = await probeFactory(address);
  if (factory) {
    const byFactory = findVenueByFactory(factory);
    if (byFactory) return { venue: byFactory.venue, factory };
    return { venue: "unknown", factory };
  }

  const signatureVenue = await resolveVenueByBytecode(address);
  return { venue: signatureVenue ?? "unknown", factory: null };
}

async function probeFactory(address: string): Promise<string | null> {
  try {
    const result = await rpc.call<string>("eth_call", [{ to: address, data: factoryIface.encodeFunctionData("factory") }, "latest"]);
    if (!result || result === "0x") return null;
    return ethers.getAddress("0x" + result.slice(-40));
  } catch {
    return null;
  }
}

async function resolveVenueByBytecode(address: string): Promise<VenueId | null> {
  try {
    const code = (await rpc.getCode(address)).toLowerCase();
    if (!code || code === "0x") return null;
    for (const sig of BYTECODE_SIGNATURES) {
      if (code.includes(sig.selector)) return sig.venue;
    }
    return null;
  } catch {
    return null;
  }
}

function classifyResolvedVenue(
  pool: string,
  venue: VenueId | "unknown",
  factory: string | null,
  graphPools: Set<string> | null,
  v4PoolIds: Set<string>,
): VenueGap {
  const normalizedPool = lower(pool);
  const poolInRoutingGraph = venue === "univ4"
    ? v4PoolIds.has(normalizedPool)
    : graphPools ? graphPools.has(normalizedPool) : null;
  const capability = venue === "unknown" ? null : findVenueCapability(venue);
  if (!capability) {
    return {
      pool: normalizedPool,
      venue: "unknown",
      factory,
      gap_type: "unknown",
      pool_in_routing_graph: poolInRoutingGraph,
      discoverable: null,
      quotable: null,
      buildable: null,
      supported_in_prod: null,
    };
  }

  const supportedInProd = capability.discoverable && capability.quotable && capability.buildable;
  let gapType: VenueGapType;
  if (!supportedInProd || !capability.discoverable) {
    gapType = capability.discoverable && (!capability.quotable || !capability.buildable)
      ? "execution_adapter_gap"
      : "venue_class_gap";
  } else if (!capability.quotable || !capability.buildable) {
    gapType = "execution_adapter_gap";
  } else if (poolInRoutingGraph === null) {
    gapType = "unknown";
  } else {
    gapType = poolInRoutingGraph ? "detection_gap" : "pool_gap";
  }

  return {
    pool: normalizedPool,
    venue: capability.venue,
    factory,
    gap_type: gapType,
    pool_in_routing_graph: poolInRoutingGraph,
    discoverable: capability.discoverable,
    quotable: capability.quotable,
    buildable: capability.buildable,
    supported_in_prod: supportedInProd,
  };
}

function summarizeVenueGapType(gaps: VenueGap[]): VenueGapType | null {
  if (gaps.length === 0) return "unknown";
  for (const kind of ["venue_class_gap", "execution_adapter_gap", "pool_gap", "detection_gap", "unknown"] as const) {
    if (gaps.some((gap) => gap.gap_type === kind)) return kind;
  }
  return "unknown";
}

export function extractPoolIdentities(receipt: any): PoolIdentity[] {
  const pools = new Map<string, PoolIdentity>();
  for (const log of receipt.logs ?? []) {
    const topic0 = lower(String(log?.topics?.[0] ?? ""));
    if (topic0 === UNIV4_SWAP_TOPIC) {
      const poolId = lower(String(log?.topics?.[1] ?? ""));
      if (isBytes32(poolId)) {
        pools.set(`univ4:${poolId}`, { pool: poolId, venue: "univ4", factory: null });
      }
      continue;
    }

    const address = lower(log?.address);
    if (!isAddress(address) || address === UNIV4_POOL_MANAGER) continue;
    pools.set(address, { pool: address });
  }
  return [...pools.values()];
}

function summarizePoolMembership(
  pools: PoolIdentity[],
  graphPools: Set<string> | null,
  v4PoolIds: Set<string>,
): boolean | null {
  let sawUnknownMembership = false;
  for (const pool of pools) {
    const normalizedPool = lower(pool.pool);
    if (pool.venue === "univ4") {
      if (v4PoolIds.has(normalizedPool)) return true;
      continue;
    }
    if (graphPools === null) {
      sawUnknownMembership = true;
      continue;
    }
    if (graphPools.has(normalizedPool)) return true;
  }
  return sawUnknownMembership ? null : false;
}

function watchNextActions(
  primaryReason: WatchReport["primaryReason"],
  seenScope: WatchReport["seenScope"],
  pools: string[],
  blockScan: WatchBlockScanAudit,
): string[] {
  if (primaryReason === "not_seen") {
    if (pools.length > 0) {
      return [
        `source block ${blockScan.source_block} had no blockscan pass (${blockScan.status}); ` +
          "check blockscan scheduling plus backrun pool universe and detector coverage",
      ];
    }
    return [
      `source block ${blockScan.source_block} had no blockscan pass (${blockScan.status}); ` +
        "decode watched tx deeper because no pool address was recovered from logs",
    ];
  }
  if (primaryReason === "blockscan_ran_no_jsonl_signal") {
    return [
      "inspect blockscan candidate/quote rejection telemetry; solve-ring token overlap alone does not prove the competitor route was seen",
    ];
  }
  if (primaryReason === "unknown_without_blockscan_evidence") {
    return [
      `recover a complete blockscan source-pass log for block ${blockScan.source_block} before assigning not_seen ` +
        `(current status: ${blockScan.status})`,
    ];
  }
  if (seenScope === "same_pool") return ["compare planner output, solver drop reason, bid, and latency for the same pool"];
  if (seenScope === "same_token") return ["check whether our pool graph missed the competitor venue for the same token set"];
  return ["block had other seen opportunities; inspect detector matching before assigning a path gap"];
}

function watchOutputBase(block: number, txHash: string): string {
  const dir = output && !output.endsWith(".md") && !output.endsWith(".json") ? output : "outputs/live-loss";
  return `${dir}/watch-${block}-${lower(txHash).slice(2, 12)}`;
}

function poolId8(poolId: string): string {
  return poolId.startsWith("0x") ? poolId.slice(0, 10) : poolId.slice(0, 8);
}

function renderWatchMarkdown(report: WatchReport): string {
  const lines: string[] = [];
  lines.push("# Live Loss Watch Report");
  lines.push("");
  lines.push(`Block: \`${report.block}\``);
  lines.push(`Competitor tx: \`${report.competitorTx}\``);
  lines.push(`Competitor addr: ${report.competitorAddr.map((x) => `\`${x}\``).join(", ") || "n/a"}`);
  lines.push("");
  lines.push("## Loss");
  lines.push("");
  lines.push(`- primary_reason: \`${report.primaryReason}\``);
  lines.push(`- primary_reason_basis: \`${report.primaryReasonBasis}\``);
  lines.push(`- seen_scope: \`${report.seenScope}\` (lane: \`${report.seenScopeLane}\`)`);
  lines.push(`- path_template: \`${report.pathTemplate}\``);
  lines.push(`- canonical_sequence: \`${report.canonicalSequence.join(" -> ") || "unknown"}\``);
  lines.push(`- competitor_edge: ${report.competitorEdge.map((x) => `\`${x}\``).join(", ") || "n/a"}`);
  lines.push(`- rough_profit: ${report.roughProfit == null ? "n/a" : report.roughProfit.toFixed(6)}`);
  lines.push(`- realized_profit_usd: ${report.realized_profit_usd == null ? "n/a" : report.realized_profit_usd.toFixed(2)} (valuation-artifact-prone; see builder_payment)`);
  if (report.lp_action) {
    lines.push(
      `- lp_action: true jit_lp: ${report.jit_lp} — ` +
        "realized_profit_usd is valuation-artifact-prone here; trust rough_profit / builder_payment",
    );
  }
  lines.push(`- builder_payment: ${formatBuilderPayment(report)} [robust profit floor]`);
  lines.push(`- profit_confidence: \`${report.profit_confidence}\``);
  const unpricedSymbols = report.unpriced_delta_symbols.map((x) => `\`${x}\``).join(", ");
  lines.push(`- unpriced_deltas: ${report.unpriced_deltas}${unpricedSymbols ? ` (${unpricedSymbols})` : ""}`);
  lines.push(`- eth_profit_usd: ${report.eth_profit_usd.toFixed(2)}`);
  lines.push(`- trace_used: ${report.trace_used}`);
  lines.push(`- v4: swaps=${report.v4_swaps} pools=${report.v4_pool_ids.length}`);
  lines.push(`- v4_pool_ids: ${report.v4_pool_ids.map((x) => `\`${x}\``).join(", ") || "n/a"}`);
  if (report.v4_swaps_detail.length > 0) {
    const swaps = report.v4_swaps_detail
      .map((swap) => {
        const pair = swap.currency0 && swap.currency1
          ? `pair=\`${swap.currency0}/${swap.currency1}\``
          : "pair=`requires_poolkey_index`";
        return `\`${poolId8(swap.poolId)}\` ${pair} a0=${swap.amount0}/a1=${swap.amount1} fee=${swap.fee}`;
      })
      .join("; ");
    lines.push(`- v4_swaps: ${swaps}`);
  }
  lines.push("");
  lines.push("## Footprint");
  lines.push("");
  lines.push(`- pools: ${report.pools.map((x) => `\`${short(x)}\``).join(", ") || "n/a"}`);
  lines.push(`- tokens: ${report.tokens.map((x) => `\`${short(x)}\``).join(", ") || "n/a"}`);
  lines.push(`- pool_in_seen_events: \`${report.pool_in_seen_events}\``);
  lines.push(`- pool_in_routing_graph: \`${report.pool_in_routing_graph}\``);
  lines.push(`- gap_type: \`${report.gap_type ?? "n/a"}\``);
  lines.push(`- venue_gap_type: \`${report.venue_gap_type ?? "n/a"}\``);
  lines.push(`- protocols: ${report.protocols.join(", ") || "n/a"}`);
  lines.push("");
  lines.push("## Blockscan Lane Audit");
  lines.push("");
  lines.push(`- target_block: \`${report.blockscan_lane.target_block}\``);
  lines.push(`- source_block: \`${report.blockscan_lane.source_block}\``);
  lines.push(`- status: \`${report.blockscan_lane.status}\``);
  lines.push(`- ran: \`${report.blockscan_lane.ran}\``);
  lines.push(`- detail_complete: \`${report.blockscan_lane.detail_complete}\``);
  lines.push(`- solve_ring_count: ${report.blockscan_lane.solve_ring_count}`);
  lines.push(`- solve_ring_token_count: ${report.blockscan_lane.solve_ring_token_count}`);
  lines.push(`- competitor_token_count: ${report.blockscan_lane.competitor_token_count}`);
  lines.push(
    `- candidate_ring_token_overlap_count: ${report.blockscan_lane.candidate_ring_token_overlap_count}`,
  );
  lines.push(
    `- candidate_ring_token_overlap_tokens: ${report.blockscan_lane.candidate_ring_token_overlap_tokens.map((x) => `\`${x}\``).join(", ") || "n/a"}`,
  );
  lines.push(`- any_submission_in_source_pass: \`${report.blockscan_lane.any_submission_in_source_pass}\``);
  lines.push(`- route_match_proven: \`${report.blockscan_lane.route_match_proven}\``);
  lines.push(`- log_path: \`${report.blockscan_lane.log_path}\``);
  if (report.blockscan_lane.log_error) lines.push(`- log_error: \`${report.blockscan_lane.log_error}\``);
  for (const limitation of report.blockscan_lane.limitations) lines.push(`- limitation: ${limitation}`);
  if (report.venue_gaps.length > 0) {
    lines.push("");
    lines.push("## Venue Gaps");
    lines.push("");
    for (const gap of report.venue_gaps) {
      const factory = gap.factory ? ` factory=${short(gap.factory)}` : "";
      lines.push(
        `- ${short(gap.pool)} venue=\`${gap.venue}\` gap=\`${gap.gap_type}\`` +
          ` graph=\`${gap.pool_in_routing_graph}\`${factory}`,
      );
    }
  }
  lines.push("");
  lines.push("## Next Action");
  lines.push("");
  for (const action of report.nextAction) lines.push(`- ${action}`);
  return `${lines.join("\n")}\n`;
}

function formatBuilderPayment(report: WatchReport): string {
  if (report.builder_payment_eth === null || report.builder_payment_usd === null) return "n/a";
  return `${report.builder_payment_eth.toFixed(6)} ETH ($${report.builder_payment_usd.toFixed(2)})`;
}

function competitorEdges(seq: string[]): string[] {
  const out: string[] = [];
  if (seq.includes("credit.borrow") || seq.includes("credit.deposit_collateral")) out.push("borrow_leg");
  if (seq.includes("position.lp.mint") || seq.includes("position.lp.burn")) out.push("lp_leg");
  if (seq.some((x) => x.startsWith("peg."))) out.push("peg_or_redeem_leg");
  if (seq.includes("trade.swap")) out.push("same_token_or_pool_execution");
  return out;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { actionsFromLogs } from "../actions/from-logs.js";
import { actionsFromTrace } from "../actions/from-trace.js";
import { canonicalSequence, pathTemplate } from "../actions/canonicalize.js";
import { runCompetitorScan } from "../competitor-scan.js";
import { decodeTransfer, formatTokenAmount } from "../decode/erc20.js";
import { roughValueUsd } from "../pnl/raw-delta.js";
import { priceArb, fetchEthUsd, type V4Swap } from "../pnl/arb-profit.js";
import { ADDR, TOPICS, lower, short } from "../registry/protocols.js";
import { isPublicRouter } from "../registry/routers.js";
import { RpcClient, hexToBigInt, hexToNumber } from "../rpc/client.js";
import type { Action, TokenDelta, TxSummary } from "../types.js";
import { mapLimit, parseArgs, uniq, writeText } from "../util.js";
import {
  renderLiveLossMarkdown,
  type LiveLossCompetitor,
  type LiveLossOpportunity,
  type LiveLossReport,
} from "../report/live-loss-report.js";

const args = parseArgs(process.argv.slice(2));
const eventsPath = args.events ? String(args.events) : "";
const graphPoolsPath = args["graph-pools"] ? String(args["graph-pools"]) : "searcher/pools/runtime-graph-pools.json";
const rpcUrl = String(args.rpc ?? process.env.READONLY_RPC_URL ?? process.env.MAINNET_RPC_URL ?? "");
const blockArg = args.block ? Number(args.block) : undefined;
const fromBlockArg = args["from-block"] ? Number(args["from-block"]) : undefined;
const toBlockArg = args["to-block"] ? Number(args["to-block"]) : undefined;
const traceTop = Number(args["trace-top"] ?? 3);
const priceTrace = Boolean(args["price-trace"]);
const output = args.output ? String(args.output) : undefined;
const opportunityArg = args.opportunity ? String(args.opportunity) : undefined;
const watch = parseWatch(args.watch);
const coverage = Boolean(args.coverage);
const competitorScan = Boolean(args["competitor-scan"]);
const notSeenScan = Boolean(args["not-seen-scan"]);
const maxBlocks = Number(args["max-blocks"] ?? 200);
const mempoolFilterArg = args["mempool-filter"] ? String(args["mempool-filter"]) : undefined;

if (!eventsPath) {
  console.error("Usage: pnpm analysis live-loss --events ./analysis/events/searcher.jsonl --block 123 --rpc <url>");
  process.exit(1);
}

const rpc = new RpcClient(rpcUrl);
const events = await readJsonl(eventsPath);
const routingGraphPools: Set<string> | null = (() => {
  try {
    if (!existsSync(graphPoolsPath)) return null;
    const j = JSON.parse(readFileSync(graphPoolsPath, "utf8"));
    const arr = Array.isArray(j) ? j : j.pools || [];
    return new Set(
      arr
        .map((pool: any) => String(pool.address || pool).toLowerCase())
        .filter(isAddress),
    );
  } catch {
    return null;
  }
})();
if (competitorScan) {
  await runCompetitorScan({ eventsPath, events, rpc, notSeenScan });
  process.exit(0);
}
if (watch.length > 0) {
  if (coverage) await runCoverageMode();
  else await runWatchMode();
  process.exit(0);
}
const targetBlocks = blockArg === undefined ? inferBlocks(events) : [blockArg];
for (const targetBlock of targetBlocks) {
  await analyzeBlock(targetBlock);
}

interface WatchReport {
  block: number;
  competitorTx: string;
  competitorAddr: string[];
  primaryReason: "not_seen" | "seen_but_lost";
  seenScope: "same_pool" | "same_token" | "block_only" | "none";
  canonicalSequence: string[];
  pathTemplate: string;
  pools: string[];
  tokens: string[];
  pool_in_seen_events: boolean;
  pool_in_routing_graph: boolean | null;
  gap_type: GapType | null;
  competitorEdge: string[];
  protocols: string[];
  roughProfit: number | null;      // ERC20-only, WETH@0 (legacy; kept for continuity)
  realized_profit_usd: number | null; // ERC20(incl WETH@ethUsd) + native ETH (v4-aware)
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

interface SeenSet {
  pools: Set<string>;
  tokens: Set<string>;
  any: boolean;
}

interface SeenIndex {
  byBlock: Map<number, SeenSet>;
  victimHashes: Set<string>;
  opportunitySeen: number;
  submitted: number;
  included: number;
}

interface CoverageTxAnalysis {
  block: number;
  tx: any;
  receipt: any;
  matched: string[];
  actors: string[];
  pools: string[];
  tokens: string[];
  protocols: string[];
  rawDeltas: TokenDelta[];
  canonicalSequence: string[];
  pathTemplate: string;
  roughProfit: number | null;
}

interface SandwichEvidence {
  preTx: string;
  victimTx: string;
  victimTo: string | null;
  postTx: string;
  sharedPool: string;
  inventoryClosed: boolean;
  profitEstimate: number | null;
}

interface CoverageMatch {
  competitorTx: string;
  block: number;
  index: number;
  actor: string[];
  classification: string;
  ourVisibility: {
    exactVictimSeen: boolean;
    sameBlockSeen: boolean;
    samePoolSeen: boolean;
    sameTokenPairSeen: boolean;
    poolInRoutingGraph: boolean | null;
    gapType: GapType | null;
    primaryNotSeenReason: string | null;
    secondaryReasons: string[];
    victimTo: string | null;
    matchedWatchRule: string | null;
    victimInMempoolFilter: boolean | null;
    mempoolFilterSource: string;
  };
  pathSummary: {
    canonicalSequence: string[];
    pathTemplate: string;
    legs: Array<{
      type: string;
      tokens: string[];
      venues: string[];
      amounts: string[];
      confidence: "logs" | "trace";
    }>;
    funding: string;
    protocols: string[];
  };
  sandwichEvidence?: SandwichEvidence;
  postStateOpportunityCandidate: "yes" | "no" | "requires_replay";
  ourGap: string[];
  nextAction: string[];
}

interface CoverageReport {
  run: {
    eventsFile: string;
    blockRange: [number, number];
    durationBlocks: number;
  };
  ourCoverage: {
    opportunitySeen: number;
    uniqueVictimsSeen: number;
    uniqueBlocksSeen: number;
    submitted: number;
    included: number;
  };
  competitorCoverage: {
    watchlist: Array<{ address: string; role: string }>;
    executedTotal: number;
    executedBlocks: number;
    exactVictimSeenByUs: number;
    sameBlockSeenByUs: number;
    samePoolSeenByUs: number;
    sameTokenPairSeenByUs: number;
    notSeenByUs: number;
    notSeenByGapType: Record<GapType, number>;
  };
  mempoolFilter: {
    source: string;
    exact: boolean;
    addressCount: number;
  };
  classificationBreakdown: Record<string, number>;
  representativeMatches: CoverageMatch[];
  completeness: {
    scannedBlocks: number;
    totalBlocks: number;
    completenessPct: number;
    partial: boolean;
    omittedBlocks: number[];
  };
  outputJson: string;
  outputMarkdown: string;
}

interface MempoolFilterIndex {
  addresses: Set<string>;
  source: string;
  exact: boolean;
}

interface WatchPricedTx {
  bot: string;
  block: number;
  realized: number | null;
  unsafe: boolean;
  hasV4: boolean;
}

interface BlockAnalysisContext {
  targetBlock: number;
  block: any;
  blockTxs: any[];
  baseFeePerGas: bigint;
  txIndexByHash: Map<string, number>;
  txLookupCache: Map<string, any | null>;
  traceCache: Map<string, Action[]>;
  receipts: { tx: any; receipt: any }[];
  opportunityCount: number;
}

async function analyzeBlock(targetBlock: number): Promise<void> {
  const blockEvents = events.filter((e) => Number(e.target_block ?? e.block ?? targetBlock) === targetBlock);
  if (blockEvents.length === 0) throw new Error(`No events found for block ${targetBlock}`);

  // Group by opportunity_id — one block can hold several distinct opportunities
  // (different victim/pool/tokens). Merging them all into one record would
  // fabricate a frankenstein opportunity (victim from one, pool from another),
  // which is exactly what opportunity_id was added to prevent.
  const groups = new Map<string, any[]>();
  for (const e of blockEvents) {
    const id = lower(String(e.opportunity_id ?? e.opportunityId ?? e.victim_hash ?? e.victimHash ?? "unknown"));
    const arr = groups.get(id) ?? [];
    arr.push(e);
    groups.set(id, arr);
  }
  let entries = [...groups.entries()];
  if (opportunityArg) {
    const want = lower(opportunityArg);
    entries = entries.filter(([id]) => id === want || id.startsWith(want));
    if (entries.length === 0) return;
  }
  console.error(
    `[analysis/live-loss] block=${targetBlock} events=${blockEvents.length} opportunities=${entries.length} traceTop=${traceTop}`,
  );

  // Fetch block + receipts ONCE, shared across every opportunity in this block.
  const block = await rpc.getBlockByNumber(targetBlock, true);
  const blockTxs: any[] = Array.isArray(block.transactions) ? block.transactions : [];
  const baseFeePerGas = hexToBigInt(block.baseFeePerGas);
  const txIndexByHash = new Map<string, number>();
  for (let i = 0; i < blockTxs.length; i++) txIndexByHash.set(lower(blockTxs[i].hash), i);
  const ctx: BlockAnalysisContext = {
    targetBlock,
    block,
    blockTxs,
    baseFeePerGas,
    txIndexByHash,
    txLookupCache: new Map<string, any | null>(),
    traceCache: new Map<string, Action[]>(),
    receipts: await mapLimit(blockTxs, 8, async (tx) => {
      const receipt = await rpc.getReceipt(tx.hash);
      return { tx, receipt };
    }),
    opportunityCount: entries.length,
  };

  for (const [oppId, oppEvents] of entries) {
    await analyzeOpportunity(ctx, oppId, oppEvents);
  }
}

async function analyzeOpportunity(ctx: BlockAnalysisContext, oppId: string, oppEvents: any[]): Promise<void> {
  const opportunity = aggregateOpportunity(oppEvents);
  const victimIndex = opportunity.victim ? ctx.txIndexByHash.get(lower(opportunity.victim)) ?? null : null;
  const victimLanded = victimIndex !== null;
  opportunity.included = opportunity.included || (await isOurTxIncluded(ctx, opportunity));

  const competitors = ctx.receipts
    .filter(({ tx, receipt }) => receipt?.status === "0x1" && !isOurOrVictim(tx.hash, opportunity))
    .map(({ tx, receipt }) => analyzeCompetitor(tx, receipt, opportunity, victimIndex, ctx.baseFeePerGas))
    .filter((x): x is LiveLossCompetitor => x !== null)
    .sort((a, b) => scoreCompetitor(b) - scoreCompetitor(a));

  const traced = await traceCompetitors(ctx, competitors.slice(0, Math.max(0, traceTop)), ctx.block?.miner);
  for (const [hash, traceActions] of traced.entries()) {
    const c = competitors.find((x) => lower(x.txHash) === hash);
    if (!c || traceActions.length === 0) continue;
    const merged = mergeKinds(c.canonicalSequence, traceActions);
    c.canonicalSequence = merged;
    c.pathTemplate = pathTemplate(merged);
    c.competitorEdge = competitorEdges(merged);
  }

  const loss = decideLoss(opportunity, victimLanded, competitors);
  // Single selected/only opportunity honors --output; multiple opportunities in
  // one block each get a distinct file so they don't overwrite each other.
  const single = targetBlocks.length === 1 && ctx.opportunityCount === 1;
  const outBase =
    single && output ? output : `outputs/live-loss/${ctx.targetBlock}-${oppId.slice(2, 12)}.md`;
  const mdPath = outBase.endsWith(".md") ? outBase : `${outBase}.md`;
  const jsonPath = mdPath.replace(/\.md$/, ".json");

  const report: LiveLossReport = {
    block: ctx.targetBlock,
    opportunityId: oppId,
    ourOpportunity: opportunity,
    victimStatus: { landed: victimLanded, victimIndex },
    competitors,
    loss,
    stats: {
      blockTx: ctx.blockTxs.length,
      receiptsAnalyzed: ctx.receipts.length,
      competitorsFound: competitors.length,
      unknownCompetitors: competitors.filter((x) => x.pathTemplate.startsWith("unknown")).length,
      tracedTx: traced.size,
    },
    outputJson: jsonPath,
    outputMarkdown: mdPath,
  };

  await writeText(resolve(mdPath), renderLiveLossMarkdown(report));
  await writeText(resolve(jsonPath), JSON.stringify(report, jsonReplacer, 2));
  console.error(`[analysis/live-loss] wrote ${mdPath}`);
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

async function buildMempoolFilterIndex(items: any[], explicitSource?: string): Promise<MempoolFilterIndex> {
  if (explicitSource) {
    const addresses = parseAddressList(await readAddressListSource(explicitSource));
    return { addresses: new Set(addresses), source: "--mempool-filter", exact: true };
  }

  const fromEvents: string[] = [];
  for (const e of items) {
    if (e.type !== "mempool_filter_config") continue;
    const raw = e.to_addresses ?? e.toAddresses ?? e.addresses;
    if (Array.isArray(raw)) fromEvents.push(...raw.map(String));
  }
  const eventAddresses = parseAddressList(fromEvents.join("\n"));
  if (eventAddresses.length > 0) {
    return { addresses: new Set(eventAddresses), source: "events:mempool_filter_config", exact: true };
  }

  return { addresses: new Set(), source: "none", exact: false };
}

async function readAddressListSource(source: string): Promise<string> {
  try {
    return await readFile(resolve(source), "utf8");
  } catch {
    return source;
  }
}

function parseAddressList(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return parseAddressListFromJson(parsed);
    } catch {
      // Fall through to token parsing; malformed JSON should still surface as
      // zero addresses instead of crashing a coverage run.
    }
  }
  return uniq((trimmed.match(/0x[a-fA-F0-9]{40}/g) ?? []).map(lower));
}

function parseAddressListFromJson(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniq(value.filter((x): x is string => typeof x === "string").filter(isAddress).map(lower));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["to_addresses", "toAddresses", "addresses"]) {
      const raw = obj[key];
      if (Array.isArray(raw)) return parseAddressListFromJson(raw);
    }
  }
  return [];
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function runWatchMode(): Promise<void> {
  const range = inferWatchRange(events);
  const seenByBlock = buildSeenByBlock(events);
  const watchSet = new Set(watch);
  const notSeenByGapType: Record<GapType, number> = {
    graph_gap: 0,
    detection_gap: 0,
    unknown: 0,
  };
  const ethUsd = await fetchEthUsd(rpc);
  const allowTrace = priceTrace || rpc.isLocal();
  const pricedTxs: WatchPricedTx[] = [];
  let written = 0;
  console.error(
    `[analysis/live-loss/watch] blocks=${range.from}-${range.to} watch=${watch.length} ethUsd=${ethUsd.toFixed(0)} price_trace=${allowTrace ? "on" : "off"}`,
  );

  for (let blockNumber = range.from; blockNumber <= range.to; blockNumber++) {
    const block = await rpc.getBlockByNumber(blockNumber, true);
    const txs: any[] = Array.isArray(block.transactions) ? block.transactions : [];
    const matches = txs.filter((tx) => {
      const actors = [tx.from, tx.to].filter(Boolean).map(lower);
      return actors.some((actor) => watchSet.has(actor));
    });
    if (matches.length === 0) continue;

    console.error(`[analysis/live-loss/watch] block=${blockNumber} matches=${matches.length}`);
    await mapLimit(matches, 4, async (tx) => {
      const receipt = await rpc.getReceipt(tx.hash);
      if (!receipt || receipt.status !== "0x1") return;
      const report = buildWatchReport(blockNumber, tx, receipt, seenByBlock);
      if (report.primaryReason === "not_seen" && report.gap_type) notSeenByGapType[report.gap_type]++;
      const entityActors = inferWatchEntityActors(tx, report.competitorAddr);
      const profit = await priceArb(rpc, tx.hash, tx, receipt, ethUsd, { entityActors, allowTrace });
      report.realized_profit_usd = profit.realizedProfitUsd;
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
      const outBase = watchOutputBase(blockNumber, tx.hash);
      await writeText(resolve(`${outBase}.md`), renderWatchMarkdown(report));
      await writeText(resolve(`${outBase}.json`), JSON.stringify(report, jsonReplacer, 2));
      written++;
      console.error(`[analysis/live-loss/watch] wrote ${outBase}.md`);
    });
  }
  console.error(`[analysis/live-loss/watch] reports=${written}`);
  console.error(
    `[analysis/live-loss/watch] not_seen_gap_types graph_gap=${notSeenByGapType.graph_gap} ` +
      `detection_gap=${notSeenByGapType.detection_gap} unknown=${notSeenByGapType.unknown}`,
  );
  const blockNets = new Map<string, { net: number; hasV4: boolean }>();
  for (const tx of pricedTxs) {
    const key = `${tx.bot}:${tx.block}`;
    const group = blockNets.get(key) ?? { net: 0, hasV4: false };
    if (!tx.unsafe && tx.realized !== null) group.net += tx.realized;
    if (tx.hasV4) group.hasV4 = true;
    blockNets.set(key, group);
  }
  let netTotalUsd = 0;
  let netV4Usd = 0;
  for (const group of blockNets.values()) {
    netTotalUsd += group.net;
    if (group.hasV4) netV4Usd += group.net;
  }
  console.error(
    `[analysis/live-loss/watch] net_per_block total=${netTotalUsd.toFixed(0)} ` +
      `via_v4=${netV4Usd.toFixed(0)} (ethUsd=${ethUsd.toFixed(0)})`,
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

async function runCoverageMode(): Promise<void> {
  const range = inferWatchRange(events);
  const seen = buildSeenIndex(events);
  const mempoolFilter = await buildMempoolFilterIndex(events, mempoolFilterArg);
  const totalBlocks = range.to - range.from + 1;
  const omittedBlocks: number[] = [];
  const matches: CoverageMatch[] = [];
  const watchSet = new Set(watch);
  const matchedBlocks = new Set<number>();
  console.error(
    `[analysis/live-loss/coverage] blocks=${range.from}-${range.to} watch=${watch.length} ` +
      `maxBlocks=${maxBlocks} mempoolFilter=${mempoolFilter.source}:${mempoolFilter.addresses.size}`,
  );

  for (let blockNumber = range.from; blockNumber <= range.to; blockNumber++) {
    try {
      const block = await rpc.getBlockByNumber(blockNumber, true);
      const txs: any[] = Array.isArray(block.transactions) ? block.transactions : [];
      const watchTxs = txs.filter((tx) => txMatchesWatch(tx, watchSet));
      if (watchTxs.length === 0) continue;
      matchedBlocks.add(blockNumber);
      console.error(`[analysis/live-loss/coverage] block=${blockNumber} watch_matches=${watchTxs.length}`);

      const receiptCache = new Map<string, any>();
      const getReceiptCached = async (hash: string): Promise<any> => {
        const key = lower(hash);
        if (receiptCache.has(key)) return receiptCache.get(key);
        const receipt = await rpc.getReceipt(hash);
        receiptCache.set(key, receipt);
        return receipt;
      };

      const analyses = (await mapLimit(watchTxs, 4, async (tx) => {
        const receipt = await getReceiptCached(tx.hash);
        if (!receipt || receipt.status !== "0x1") return null;
        return analyzeCoverageTx(blockNumber, tx, receipt, watchSet);
      })).filter((x): x is CoverageTxAnalysis => x !== null);

      const sandwichByTx = await detectLocalSandwiches(blockNumber, txs, analyses, getReceiptCached);
      for (const item of analyses) {
        matches.push(buildCoverageMatch(item, seen, mempoolFilter, sandwichByTx.get(lower(item.tx.hash))));
      }
    } catch (err) {
      omittedBlocks.push(blockNumber);
      console.error(`[analysis/live-loss/coverage] block=${blockNumber} failed: ${(err as Error).message}`);
    }
  }

  const scannedBlocks = totalBlocks - omittedBlocks.length;
  const outputBase = coverageOutputBase(range);
  const report = buildCoverageReport({
    range,
    seen,
    mempoolFilter,
    matches,
    matchedBlocks,
    scannedBlocks,
    totalBlocks,
    omittedBlocks,
    outputBase,
  });
  await writeText(resolve(`${outputBase}.md`), renderCoverageMarkdown(report));
  await writeText(resolve(`${outputBase}.json`), JSON.stringify(report, jsonReplacer, 2));
  console.error(`[analysis/live-loss/coverage] wrote ${outputBase}.md`);
  console.error(
    `[analysis/live-loss/coverage] not_seen_gap_types ` +
      `graph_gap=${report.competitorCoverage.notSeenByGapType.graph_gap} ` +
      `detection_gap=${report.competitorCoverage.notSeenByGapType.detection_gap} ` +
      `unknown=${report.competitorCoverage.notSeenByGapType.unknown}`,
  );
}

function buildSeenIndex(items: any[]): SeenIndex {
  const byBlock = buildSeenByBlock(items);
  const victimHashes = new Set<string>();
  let opportunitySeen = 0;
  let submitted = 0;
  let included = 0;
  for (const e of items) {
    if (e.type === "opportunity_seen") opportunitySeen++;
    if (e.type === "bundle_submitted" || e.submitted === true) submitted++;
    if (e.type === "tx_included" || e.included === true) included++;
    const victim = e.victim_hash ?? e.victimHash;
    if (victim) victimHashes.add(lower(String(victim)));
  }
  return { byBlock, victimHashes, opportunitySeen, submitted, included };
}

function txMatchesWatch(tx: any, watchSet: Set<string>): boolean {
  return [tx.from, tx.to].filter(Boolean).map(lower).some((actor) => watchSet.has(actor));
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

function analyzeCoverageTx(
  block: number,
  tx: any,
  receipt: any,
  watchSet: Set<string>,
): CoverageTxAnalysis {
  const matched = uniq([tx.from, tx.to].filter(Boolean).map(lower).filter((actor) => watchSet.has(actor)));
  const actors = uniq([tx.from, tx.to, ...matched].filter(Boolean).map(String));
  const logResult = actionsFromLogs(receipt, actors);
  const sequence = canonicalSequence(logResult.actions);
  return {
    block,
    tx,
    receipt,
    matched,
    actors,
    pools: extractPoolAddresses(receipt),
    tokens: logResult.tokens.map(lower),
    protocols: logResult.protocols,
    rawDeltas: logResult.rawDeltas,
    canonicalSequence: sequence,
    pathTemplate: pathTemplate(sequence),
    roughProfit: roughValueUsd(logResult.rawDeltas),
  };
}

async function detectLocalSandwiches(
  block: number,
  blockTxs: any[],
  items: CoverageTxAnalysis[],
  getReceipt: (hash: string) => Promise<any>,
): Promise<Map<string, SandwichEvidence>> {
  const out = new Map<string, SandwichEvidence>();
  const sorted = [...items].sort((a, b) => txIndex(a.tx) - txIndex(b.tx));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const pre = sorted[i];
      const post = sorted[j];
      if (!sameActor(pre.tx, post.tx)) continue;
      const commonPools = pre.pools.filter((pool) => post.pools.includes(pool));
      if (commonPools.length === 0) continue;
      if (!inventoryCloses(pre.rawDeltas, post.rawDeltas)) continue;

      const preIndex = txIndex(pre.tx);
      const postIndex = txIndex(post.tx);
      if (postIndex <= preIndex + 1) continue;

      for (const pool of commonPools) {
        const victim = await findVictimBetween(blockTxs, preIndex, postIndex, pool, getReceipt);
        if (!victim) continue;
        const evidence: SandwichEvidence = {
          preTx: pre.tx.hash,
          victimTx: victim.tx.hash,
          victimTo: victim.tx.to ?? null,
          postTx: post.tx.hash,
          sharedPool: pool,
          inventoryClosed: true,
          profitEstimate: roughValueUsd(combineDeltas(pre.rawDeltas, post.rawDeltas)),
        };
        out.set(lower(pre.tx.hash), evidence);
        out.set(lower(post.tx.hash), evidence);
        break;
      }
    }
  }
  if (out.size > 0) {
    console.error(`[analysis/live-loss/coverage] block=${block} sandwich_legs=${out.size}`);
  }
  return out;
}

async function findVictimBetween(
  blockTxs: any[],
  preIndex: number,
  postIndex: number,
  pool: string,
  getReceipt: (hash: string) => Promise<any>,
): Promise<{ tx: any; receipt: any } | null> {
  for (let i = preIndex + 1; i < postIndex; i++) {
    const tx = blockTxs[i];
    if (!tx?.hash) continue;
    const receipt = await getReceipt(tx.hash);
    if (receipt?.status === "0x1" && receiptTouches(receipt, pool)) return { tx, receipt };
  }
  return null;
}

function buildCoverageMatch(
  item: CoverageTxAnalysis,
  seen: SeenIndex,
  mempoolFilter: MempoolFilterIndex,
  sandwichEvidence?: SandwichEvidence,
): CoverageMatch {
  const seenSet = seen.byBlock.get(item.block) ?? { pools: new Set<string>(), tokens: new Set<string>(), any: false };
  const samePoolSeen = item.pools.some((pool) => seenSet.pools.has(pool));
  const sameTokenPairSeen = item.tokens.some((token) => seenSet.tokens.has(token));
  const exactVictimSeen = sandwichEvidence ? seen.victimHashes.has(lower(sandwichEvidence.victimTx)) : false;
  const sameBlockSeen = seenSet.any;
  const poolInRoutingGraph = routingGraphPools ? item.pools.some((pool) => routingGraphPools.has(lower(pool))) : null;
  const notSeen =
    !exactVictimSeen &&
    !sameBlockSeen &&
    !samePoolSeen &&
    !sameTokenPairSeen;
  const gapType = notSeen ? classifyGapType(poolInRoutingGraph) : null;
  const victimTo = sandwichEvidence?.victimTo ? lower(sandwichEvidence.victimTo) : null;
  const victimInMempoolFilter = victimTo ? mempoolFilter.addresses.has(victimTo) : null;
  const hasExtraNonSandwichLeg = Boolean(
    sandwichEvidence && item.pools.some((pool) => pool !== sandwichEvidence.sharedPool),
  );
  const classification = classifyCoverageTx(item, sandwichEvidence, hasExtraNonSandwichLeg);
  const reasons = coverageReasons(classification, {
    exactVictimSeen,
    sameBlockSeen,
    samePoolSeen,
    sameTokenPairSeen,
    hasVictim: Boolean(sandwichEvidence?.victimTx),
    victimTo,
    victimInMempoolFilter,
    mempoolFilterExact: mempoolFilter.exact,
  });
  return {
    competitorTx: item.tx.hash,
    block: item.block,
    index: txIndex(item.tx),
    actor: item.matched,
    classification,
    ourVisibility: {
      exactVictimSeen,
      sameBlockSeen,
      samePoolSeen,
      sameTokenPairSeen,
      poolInRoutingGraph,
      gapType,
      primaryNotSeenReason: reasons.primary,
      secondaryReasons: reasons.secondary,
      victimTo,
      matchedWatchRule: victimTo && victimInMempoolFilter ? `toAddress:${victimTo}` : null,
      victimInMempoolFilter,
      mempoolFilterSource: mempoolFilter.source,
    },
    pathSummary: buildPathSummary(item, sandwichEvidence),
    sandwichEvidence,
    postStateOpportunityCandidate: sandwichEvidence && hasExtraNonSandwichLeg ? "requires_replay" : "no",
    ourGap: coverageGaps(classification, sameBlockSeen, samePoolSeen, sameTokenPairSeen, hasExtraNonSandwichLeg),
    nextAction: coverageNextActions(classification, reasons.primary, hasExtraNonSandwichLeg),
  };
}

function classifyCoverageTx(
  item: CoverageTxAnalysis,
  sandwichEvidence: SandwichEvidence | undefined,
  hasExtraNonSandwichLeg: boolean,
): string {
  if (sandwichEvidence && hasExtraNonSandwichLeg) return "mixed";
  if (sandwichEvidence) return "sandwich_excluded";
  if (item.canonicalSequence.length === 0) return "unknown_opaque";
  if (item.pathTemplate === "unknown_opaque") return "unknown_opaque";
  if (item.pathTemplate === "unknown_replayable") return "unknown_replayable";
  return "standing_or_atomic";
}

function coverageReasons(
  classification: string,
  visibility: {
    exactVictimSeen: boolean;
    sameBlockSeen: boolean;
    samePoolSeen: boolean;
    sameTokenPairSeen: boolean;
    hasVictim: boolean;
    victimTo: string | null;
    victimInMempoolFilter: boolean | null;
    mempoolFilterExact: boolean;
  },
): { primary: string | null; secondary: string[] } {
  const reasons: string[] = [];
  if (!visibility.hasVictim && classification !== "sandwich_excluded" && classification !== "mixed") {
    reasons.push("standing_not_victim_triggered");
  }
  if (
    visibility.hasVictim &&
    !visibility.exactVictimSeen &&
    visibility.mempoolFilterExact &&
    visibility.victimTo &&
    visibility.victimInMempoolFilter === false
  ) {
    reasons.push("router_not_watched");
  }
  if (!visibility.sameBlockSeen) reasons.push("unknown");
  if (visibility.sameBlockSeen && !visibility.samePoolSeen) reasons.push("pool_not_in_graph");
  if (visibility.sameBlockSeen && !visibility.sameTokenPairSeen) reasons.push("token_pair_not_in_universe");
  if (visibility.samePoolSeen && !visibility.exactVictimSeen) reasons.push("seen_pool_but_no_plan");

  const priority = [
    "standing_not_victim_triggered",
    "router_not_watched",
    "private_or_builder_only",
    "pool_not_in_graph",
    "token_pair_not_in_universe",
    "seen_pool_but_no_plan",
    "unknown",
  ];
  const uniqReasons = uniq(reasons);
  const primary = priority.find((reason) => uniqReasons.includes(reason)) ?? null;
  return { primary, secondary: uniqReasons.filter((reason) => reason !== primary) };
}

function buildPathSummary(item: CoverageTxAnalysis, sandwichEvidence?: SandwichEvidence): CoverageMatch["pathSummary"] {
  const legs: CoverageMatch["pathSummary"]["legs"] = [];
  if (sandwichEvidence) {
    legs.push({
      type: "sandwich_excluded",
      tokens: item.tokens,
      venues: [sandwichEvidence.sharedPool],
      amounts: amountsForPools(item, [sandwichEvidence.sharedPool]),
      confidence: "logs",
    });
  }
  const nonSandwichPools = sandwichEvidence
    ? item.pools.filter((pool) => pool !== sandwichEvidence.sharedPool)
    : item.pools;
  if (nonSandwichPools.length > 0 || !sandwichEvidence) {
    legs.push({
      type: inferCoverageLegType(item),
      tokens: item.tokens,
      venues: nonSandwichPools.length > 0 ? nonSandwichPools : item.pools,
      amounts: amountsForPools(item, nonSandwichPools.length > 0 ? nonSandwichPools : item.pools),
      confidence: "logs",
    });
  }
  return {
    canonicalSequence: item.canonicalSequence,
    pathTemplate: sandwichEvidence && nonSandwichPools.length > 0 ? "mixed" : item.pathTemplate,
    legs,
    funding: item.canonicalSequence.includes("fund.flashloan") ? "flashloan" : "self_or_inventory",
    protocols: item.protocols,
  };
}

function inferCoverageLegType(item: CoverageTxAnalysis): string {
  if (item.canonicalSequence.includes("credit.borrow") || item.canonicalSequence.includes("credit.deposit_collateral")) {
    return "credit_wrapper_loop";
  }
  if (item.canonicalSequence.includes("position.lp.mint") || item.canonicalSequence.includes("position.lp.burn")) {
    return "lp_positioned";
  }
  if (item.canonicalSequence.some((x) => x.startsWith("peg.")) || item.canonicalSequence.includes("wrap")) {
    return "peg_or_wrapper_loop";
  }
  if (item.canonicalSequence.filter((x) => x === "trade.swap").length >= 2) return "swap_loop";
  if (item.canonicalSequence.includes("trade.swap")) return "swap";
  return "unknown";
}

function amountsForPools(item: CoverageTxAnalysis, pools: string[]): string[] {
  const poolSet = new Set(pools.map(lower));
  const actorSet = new Set(item.actors.map(lower));
  const deltas = new Map<string, bigint>();
  for (const log of item.receipt.logs ?? []) {
    const transfer = decodeTransfer(log);
    if (!transfer) continue;
    const fromPool = poolSet.has(lower(transfer.from));
    const toPool = poolSet.has(lower(transfer.to));
    if (!fromPool && !toPool) continue;
    const fromActor = actorSet.has(lower(transfer.from));
    const toActor = actorSet.has(lower(transfer.to));
    if (!fromActor && !toActor) continue;
    const key = lower(transfer.token);
    const delta = (deltas.get(key) ?? 0n) + (toActor ? transfer.amount : -transfer.amount);
    deltas.set(key, delta);
  }
  const out = [...deltas.entries()]
    .filter(([, raw]) => raw !== 0n)
    .map(([token, raw]) => formatTokenAmount(token, raw));
  return out.length > 0 ? out : item.rawDeltas.map((delta) => formatTokenAmount(delta.token, delta.raw));
}

function coverageGaps(
  classification: string,
  sameBlockSeen: boolean,
  samePoolSeen: boolean,
  sameTokenPairSeen: boolean,
  hasExtraNonSandwichLeg: boolean,
): string[] {
  const gaps: string[] = [];
  if (!sameBlockSeen) gaps.push("visibility_gap");
  else {
    if (!samePoolSeen) gaps.push("pool_or_router_coverage_gap");
    if (!sameTokenPairSeen) gaps.push("token_universe_gap");
  }
  if (classification === "mixed" || hasExtraNonSandwichLeg) gaps.push("review_non_sandwich_legs");
  if (classification === "standing_or_atomic") gaps.push("standing_strategy_outside_victim_trigger");
  return gaps;
}

function coverageNextActions(
  classification: string,
  primaryReason: string | null,
  hasExtraNonSandwichLeg: boolean,
): string[] {
  if (primaryReason === "router_not_watched") {
    const actions = ["add victim_to/router to filtered mempool toAddress list, then re-run coverage"];
    if (classification === "mixed" || hasExtraNonSandwichLeg) {
      actions.push("exclude sandwich leg", "replay non-sandwich legs before calling it a path gap");
    } else if (classification === "sandwich_excluded") {
      actions.push("count visibility gap, but exclude from pure backrun loss sample");
    }
    return actions;
  }
  if (classification === "mixed" || hasExtraNonSandwichLeg) {
    return ["exclude sandwich leg", "replay non-sandwich legs before calling it a path gap"];
  }
  if (classification === "sandwich_excluded") {
    return ["count visibility gap, but exclude from pure backrun loss sample"];
  }
  if (primaryReason === "standing_not_victim_triggered") {
    return ["treat as standing/inventory strategy; do not assign to mempool victim coverage"];
  }
  if (primaryReason === "pool_not_in_graph") return ["inspect impacted pools and graph universe coverage"];
  if (primaryReason === "token_pair_not_in_universe") return ["inspect token pair filters and token universe"];
  if (primaryReason === "seen_pool_but_no_plan") return ["inspect planner/template constraints for seen pool"];
  return ["manual review competitor path and visibility root cause"];
}

function buildCoverageReport(input: {
  range: { from: number; to: number };
  seen: SeenIndex;
  mempoolFilter: MempoolFilterIndex;
  matches: CoverageMatch[];
  matchedBlocks: Set<number>;
  scannedBlocks: number;
  totalBlocks: number;
  omittedBlocks: number[];
  outputBase: string;
}): CoverageReport {
  const breakdown: Record<string, number> = {
    sandwich_excluded: 0,
    sandwich_suspect: 0,
    non_sandwich_path_candidate: 0,
    standing_or_atomic: 0,
    directional_suspect: 0,
    unknown_replayable: 0,
    unknown_opaque: 0,
    mixed: 0,
  };
  for (const m of input.matches) {
    if (m.classification === "mixed") {
      breakdown.mixed++;
      breakdown.sandwich_excluded++;
      breakdown.non_sandwich_path_candidate++;
    } else if (m.classification in breakdown) {
      breakdown[m.classification]++;
    } else {
      breakdown.unknown_opaque++;
    }
  }
  const exactVictimSeenByUs = input.matches.filter((m) => m.ourVisibility.exactVictimSeen).length;
  const sameBlockSeenByUs = input.matches.filter((m) => m.ourVisibility.sameBlockSeen).length;
  const samePoolSeenByUs = input.matches.filter((m) => m.ourVisibility.samePoolSeen).length;
  const sameTokenPairSeenByUs = input.matches.filter((m) => m.ourVisibility.sameTokenPairSeen).length;
  const notSeenMatches = input.matches.filter((m) =>
    !m.ourVisibility.exactVictimSeen &&
    !m.ourVisibility.sameBlockSeen &&
    !m.ourVisibility.samePoolSeen &&
    !m.ourVisibility.sameTokenPairSeen
  );
  const notSeenByGapType: Record<GapType, number> = {
    graph_gap: 0,
    detection_gap: 0,
    unknown: 0,
  };
  for (const m of notSeenMatches) {
    notSeenByGapType[m.ourVisibility.gapType ?? "unknown"]++;
  }
  const completenessPct = input.totalBlocks === 0 ? 100 : (input.scannedBlocks / input.totalBlocks) * 100;
  return {
    run: {
      eventsFile: eventsPath,
      blockRange: [input.range.from, input.range.to],
      durationBlocks: input.totalBlocks,
    },
    ourCoverage: {
      opportunitySeen: input.seen.opportunitySeen,
      uniqueVictimsSeen: input.seen.victimHashes.size,
      uniqueBlocksSeen: input.seen.byBlock.size,
      submitted: input.seen.submitted,
      included: input.seen.included,
    },
    competitorCoverage: {
      watchlist: watch.map((address) => ({ address, role: "watch" })),
      executedTotal: input.matches.length,
      executedBlocks: input.matchedBlocks.size,
      exactVictimSeenByUs,
      sameBlockSeenByUs,
      samePoolSeenByUs,
      sameTokenPairSeenByUs,
      notSeenByUs: notSeenMatches.length,
      notSeenByGapType,
    },
    mempoolFilter: {
      source: input.mempoolFilter.source,
      exact: input.mempoolFilter.exact,
      addressCount: input.mempoolFilter.addresses.size,
    },
    classificationBreakdown: breakdown,
    representativeMatches: input.matches
      .sort((a, b) => bScoreCoverageMatch(b) - bScoreCoverageMatch(a))
      .slice(0, 100),
    completeness: {
      scannedBlocks: input.scannedBlocks,
      totalBlocks: input.totalBlocks,
      completenessPct,
      partial: input.omittedBlocks.length > 0,
      omittedBlocks: input.omittedBlocks,
    },
    outputJson: `${input.outputBase}.json`,
    outputMarkdown: `${input.outputBase}.md`,
  };
}

function bScoreCoverageMatch(m: CoverageMatch): number {
  return (
    (m.classification === "mixed" ? 1000 : 0) +
    (m.classification === "sandwich_excluded" ? 500 : 0) +
    (m.classification === "standing_or_atomic" ? 250 : 0) +
    (m.ourVisibility.sameBlockSeen ? 25 : 0) +
    (m.ourVisibility.samePoolSeen ? 50 : 0)
  );
}

function renderCoverageMarkdown(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push("# Live Competitor Coverage Report");
  lines.push("");
  lines.push(`Events: \`${report.run.eventsFile}\``);
  lines.push(`Block range: \`${report.run.blockRange[0]}-${report.run.blockRange[1]}\``);
  lines.push("");
  lines.push("## Our Coverage");
  lines.push("");
  lines.push(`- opportunity_seen: \`${report.ourCoverage.opportunitySeen}\``);
  lines.push(`- unique_victims_seen: \`${report.ourCoverage.uniqueVictimsSeen}\``);
  lines.push(`- unique_blocks_seen: \`${report.ourCoverage.uniqueBlocksSeen}\``);
  lines.push(`- submitted: \`${report.ourCoverage.submitted}\``);
  lines.push(`- included: \`${report.ourCoverage.included}\``);
  lines.push("");
  lines.push("## Competitor Coverage");
  lines.push("");
  lines.push(`- watchlist: ${report.competitorCoverage.watchlist.map((w) => `\`${w.address}\``).join(", ")}`);
  lines.push(`- executed_total: \`${report.competitorCoverage.executedTotal}\``);
  lines.push(`- executed_blocks: \`${report.competitorCoverage.executedBlocks}\``);
  lines.push(`- exact_victim_seen_by_us: \`${report.competitorCoverage.exactVictimSeenByUs}\``);
  lines.push(`- same_block_seen_by_us: \`${report.competitorCoverage.sameBlockSeenByUs}\``);
  lines.push(`- same_pool_seen_by_us: \`${report.competitorCoverage.samePoolSeenByUs}\``);
  lines.push(`- same_token_pair_seen_by_us: \`${report.competitorCoverage.sameTokenPairSeenByUs}\``);
  lines.push(`- not_seen_by_us: \`${report.competitorCoverage.notSeenByUs}\``);
  lines.push(
    `- not_seen_by_gap_type: graph_gap=\`${report.competitorCoverage.notSeenByGapType.graph_gap}\` ` +
      `detection_gap=\`${report.competitorCoverage.notSeenByGapType.detection_gap}\` ` +
      `unknown=\`${report.competitorCoverage.notSeenByGapType.unknown}\``,
  );
  lines.push(`- mempool_filter_source: \`${report.mempoolFilter.source}\``);
  lines.push(`- mempool_filter_exact: \`${report.mempoolFilter.exact}\``);
  lines.push(`- mempool_filter_address_count: \`${report.mempoolFilter.addressCount}\``);
  lines.push("");
  lines.push("## Classification Breakdown");
  lines.push("");
  for (const [k, v] of Object.entries(report.classificationBreakdown)) {
    if (v > 0) lines.push(`- ${k}: \`${v}\``);
  }
  lines.push("");
  lines.push("## Completeness");
  lines.push("");
  lines.push(`- scanned_blocks: \`${report.completeness.scannedBlocks}\``);
  lines.push(`- total_blocks: \`${report.completeness.totalBlocks}\``);
  lines.push(`- completeness_pct: \`${report.completeness.completenessPct.toFixed(2)}\``);
  lines.push(`- partial: \`${report.completeness.partial}\``);
  lines.push(`- omitted_blocks: ${report.completeness.omittedBlocks.map((b) => `\`${b}\``).join(", ") || "n/a"}`);
  lines.push("");
  lines.push("## Representative Matches");
  lines.push("");
  for (const m of report.representativeMatches.slice(0, 30)) {
    lines.push(`### \`${m.competitorTx}\``);
    lines.push("");
    lines.push(`- block/index: \`${m.block}/${m.index}\``);
    lines.push(`- actor: ${m.actor.map((x) => `\`${x}\``).join(", ") || "n/a"}`);
    lines.push(`- classification: \`${m.classification}\``);
    lines.push(`- primary_not_seen_reason: \`${m.ourVisibility.primaryNotSeenReason ?? "n/a"}\``);
    lines.push(`- exact_victim_seen: \`${m.ourVisibility.exactVictimSeen}\``);
    lines.push(`- same_block_seen: \`${m.ourVisibility.sameBlockSeen}\``);
    lines.push(`- same_pool_seen: \`${m.ourVisibility.samePoolSeen}\``);
    lines.push(`- same_token_pair_seen: \`${m.ourVisibility.sameTokenPairSeen}\``);
    lines.push(`- pool_in_routing_graph: \`${m.ourVisibility.poolInRoutingGraph}\``);
    lines.push(`- gap_type: \`${m.ourVisibility.gapType ?? "n/a"}\``);
    lines.push(`- victim_to: ${m.ourVisibility.victimTo ? `\`${m.ourVisibility.victimTo}\`` : "`n/a`"}`);
    lines.push(`- victim_in_mempool_filter: \`${m.ourVisibility.victimInMempoolFilter ?? "n/a"}\``);
    lines.push(`- mempool_filter_source: \`${m.ourVisibility.mempoolFilterSource}\``);
    lines.push(`- matched_watch_rule: ${m.ourVisibility.matchedWatchRule ? `\`${m.ourVisibility.matchedWatchRule}\`` : "`n/a`"}`);
    lines.push(`- path_template: \`${m.pathSummary.pathTemplate}\``);
    lines.push(`- canonical_sequence: \`${m.pathSummary.canonicalSequence.join(" -> ") || "unknown"}\``);
    if (m.sandwichEvidence) {
      lines.push(`- sandwich: pre=\`${m.sandwichEvidence.preTx}\` victim=\`${m.sandwichEvidence.victimTx}\` post=\`${m.sandwichEvidence.postTx}\` pool=\`${m.sandwichEvidence.sharedPool}\``);
      lines.push(`- post_state_opportunity_candidate: \`${m.postStateOpportunityCandidate}\``);
    }
    lines.push(`- legs:`);
    for (const leg of m.pathSummary.legs) {
      lines.push(`  - type=\`${leg.type}\` venues=${leg.venues.map((x) => `\`${short(x)}\``).join(", ") || "n/a"} tokens=${leg.tokens.map((x) => `\`${short(x)}\``).join(", ") || "n/a"}`);
      if (leg.amounts.length > 0) lines.push(`    amounts=${leg.amounts.map((x) => `\`${x}\``).join(", ")}`);
    }
    lines.push(`- our_gap: ${m.ourGap.map((x) => `\`${x}\``).join(", ") || "n/a"}`);
    lines.push(`- next_action:`);
    for (const action of m.nextAction) lines.push(`  - ${action}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function coverageOutputBase(range: { from: number; to: number }): string {
  if (output) {
    if (output.endsWith(".md")) return output.slice(0, -3);
    if (output.endsWith(".json")) return output.slice(0, -5);
    return output.replace(/\/$/, "") + `/coverage-${range.from}-${range.to}`;
  }
  return `outputs/live-loss/coverage-${range.from}-${range.to}`;
}

function txIndex(tx: any): number {
  return hexToNumber(tx.transactionIndex ?? tx.transaction_index ?? "0x0");
}

function sameActor(a: any, b: any): boolean {
  const sameSender = lower(a.from) && lower(a.from) === lower(b.from);
  const sameExecutor = lower(a.to) && lower(a.to) === lower(b.to);
  return Boolean(sameSender || sameExecutor);
}

function inventoryCloses(pre: TokenDelta[], post: TokenDelta[]): boolean {
  const preMap = deltaMap(pre);
  const postMap = deltaMap(post);
  let closed = 0;
  for (const [token, a] of preMap.entries()) {
    const b = postMap.get(token) ?? 0n;
    if (a === 0n || b === 0n) continue;
    if ((a > 0n && b > 0n) || (a < 0n && b < 0n)) continue;
    const max = absBigint(a) > absBigint(b) ? absBigint(a) : absBigint(b);
    const net = absBigint(a + b);
    if (max > 0n && net * 100n <= max) closed++;
  }
  return closed >= 2;
}

function deltaMap(items: TokenDelta[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const d of items) out.set(lower(d.token), (out.get(lower(d.token)) ?? 0n) + d.raw);
  return out;
}

function combineDeltas(a: TokenDelta[], b: TokenDelta[]): TokenDelta[] {
  const meta = new Map<string, TokenDelta>();
  for (const d of [...a, ...b]) {
    const key = lower(d.token);
    const prev = meta.get(key);
    meta.set(key, { ...d, token: key, raw: (prev?.raw ?? 0n) + d.raw });
  }
  return [...meta.values()].filter((d) => d.raw !== 0n);
}

function absBigint(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function buildSeenByBlock(items: any[]): Map<number, SeenSet> {
  const out = new Map<number, SeenSet>();
  for (const e of items) {
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

function buildWatchReport(
  block: number,
  tx: any,
  receipt: any,
  seenByBlock: Map<number, SeenSet>,
): WatchReport {
  const matched = uniq([tx.from, tx.to].filter(Boolean).map(lower).filter((actor) => watch.includes(actor)));
  const actors = uniq([tx.from, tx.to, ...matched].filter(Boolean));
  const logResult = actionsFromLogs(receipt, actors);
  const sequence = canonicalSequence(logResult.actions);
  const pools = extractPoolAddresses(receipt);
  const tokens = logResult.tokens.map(lower);
  const seen = seenByBlock.get(block) ?? { pools: new Set<string>(), tokens: new Set<string>(), any: false };
  const samePool = pools.some((pool) => seen.pools.has(pool));
  const sameToken = tokens.some((token) => seen.tokens.has(token));
  const seenScope = samePool ? "same_pool" : sameToken ? "same_token" : seen.any ? "block_only" : "none";
  const decoded = pools.length > 0 || tokens.length > 0;
  const primaryReason = decoded
    ? (samePool || sameToken ? "seen_but_lost" : "not_seen")
    : (seen.any ? "seen_but_lost" : "not_seen");
  const poolInSeenEvents = pools.some((pool) => seen.pools.has(pool));
  const poolInRoutingGraph = routingGraphPools ? pools.some((p) => routingGraphPools.has(lower(p))) : null;
  const gapType = primaryReason === "not_seen" ? classifyGapType(poolInRoutingGraph) : null;

  return {
    block,
    competitorTx: tx.hash,
    competitorAddr: matched,
    primaryReason,
    seenScope,
    canonicalSequence: sequence,
    pathTemplate: pathTemplate(sequence),
    pools,
    tokens,
    pool_in_seen_events: poolInSeenEvents,
    pool_in_routing_graph: poolInRoutingGraph,
    gap_type: gapType,
    competitorEdge: competitorEdges(sequence),
    protocols: logResult.protocols,
    roughProfit: roughValueUsd(logResult.rawDeltas),
    realized_profit_usd: null, // filled by priceArb in runWatchMode (needs rpc + ethUsd)
    profit_confidence: "requires_decode",
    unpriced_deltas: 0,
    unpriced_delta_symbols: [],
    eth_profit_usd: 0,
    v4_swaps: 0,
    v4_pools: 0,
    v4_pool_ids: [],
    v4_swaps_detail: [],
    trace_used: false,
    nextAction: watchNextActions(primaryReason, seenScope, pools),
    rawDeltas: logResult.rawDeltas,
  };
}

function classifyGapType(poolInRoutingGraph: boolean | null): GapType {
  if (poolInRoutingGraph === null) return "unknown";
  return poolInRoutingGraph ? "detection_gap" : "graph_gap";
}

function extractPoolAddresses(receipt: any): string[] {
  const poolTopics = new Set([
    TOPICS.univ2Swap,
    TOPICS.univ3Swap,
    TOPICS.curveTokenExchange,
    TOPICS.curveTokenExchangeUnderlying,
    TOPICS.univ2Mint,
    TOPICS.univ2Burn,
    TOPICS.univ3Mint,
    TOPICS.univ3Burn,
  ].map(lower));
  const pools = (receipt.logs ?? [])
    .filter((log: any) => poolTopics.has(lower(log.topics?.[0])))
    .map((log: any) => lower(log.address))
    .filter((addr: string) => /^0x[a-f0-9]{40}$/.test(addr));
  return uniq(pools);
}

function watchNextActions(
  primaryReason: WatchReport["primaryReason"],
  seenScope: WatchReport["seenScope"],
  pools: string[],
): string[] {
  if (primaryReason === "not_seen") {
    if (pools.length > 0) return ["check pool universe, pending detector coverage, and token filters for watched competitor pool"];
    return ["decode watched tx deeper; no pool address was recovered from logs"];
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
  lines.push(`- seen_scope: \`${report.seenScope}\``);
  lines.push(`- path_template: \`${report.pathTemplate}\``);
  lines.push(`- canonical_sequence: \`${report.canonicalSequence.join(" -> ") || "unknown"}\``);
  lines.push(`- competitor_edge: ${report.competitorEdge.map((x) => `\`${x}\``).join(", ") || "n/a"}`);
  lines.push(`- rough_profit: ${report.roughProfit == null ? "n/a" : report.roughProfit.toFixed(6)}`);
  lines.push(`- realized_profit_usd: ${report.realized_profit_usd == null ? "n/a" : report.realized_profit_usd.toFixed(2)}`);
  lines.push(`- profit_confidence: \`${report.profit_confidence}\``);
  const unpricedSymbols = report.unpriced_delta_symbols.map((x) => `\`${x}\``).join(", ");
  lines.push(`- unpriced_deltas: ${report.unpriced_deltas}${unpricedSymbols ? ` (${unpricedSymbols})` : ""}`);
  lines.push(`- eth_profit_usd: ${report.eth_profit_usd.toFixed(2)}`);
  lines.push(`- trace_used: ${report.trace_used}`);
  lines.push(`- v4: swaps=${report.v4_swaps} pools=${report.v4_pool_ids.length}`);
  lines.push(`- v4_pool_ids: ${report.v4_pool_ids.map((x) => `\`${x}\``).join(", ") || "n/a"}`);
  if (report.v4_swaps_detail.length > 0) {
    const swaps = report.v4_swaps_detail
      .map((swap) => `\`${poolId8(swap.poolId)}\` a0=${swap.amount0}/a1=${swap.amount1} fee=${swap.fee}`)
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
  lines.push(`- protocols: ${report.protocols.join(", ") || "n/a"}`);
  lines.push("");
  lines.push("## Next Action");
  lines.push("");
  for (const action of report.nextAction) lines.push(`- ${action}`);
  return `${lines.join("\n")}\n`;
}

function aggregateOpportunity(items: any[]): LiveLossOpportunity {
  const last = <T>(xs: T[]): T | undefined => xs.length ? xs[xs.length - 1] : undefined;
  const victim = last(items.map((e) => e.victim_hash ?? e.victimHash).filter(Boolean));
  const pool = last(items.map((e) => e.pool).filter(Boolean));
  const tokens = uniq(items.flatMap((e) => Array.isArray(e.tokens) ? e.tokens : []).map(String));
  const pathId = last(items.map((e) => e.path_id ?? e.pathId).filter(Boolean));
  const templateId = last(items.map((e) => e.template_id ?? e.templateId).filter(Boolean));
  const simulatedProfit = last(items.map((e) => e.simulated_profit ?? e.simulatedProfit).filter(Boolean));
  const drop = last(items.filter((e) => e.type === "pipeline_dropped"));
  const submissionTargetBlock = last(items
    .map((e) => e.submission_target_block ?? e.submissionTargetBlock)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x)));
  const bid = last(items.map((e) => e.bid).filter(Boolean));
  const buildersSent = uniq(items.flatMap((e) => Array.isArray(e.builders_sent) ? e.builders_sent : []));
  const ourTxHashes = uniq(items
    .map((e) => e.tx_hash ?? e.txHash ?? e.bundle_tx_hash ?? e.bundleTxHash)
    .filter(Boolean)
    .map((x) => lower(String(x))));
  return {
    victim: victim ? String(victim) : undefined,
    pool: pool ? String(pool) : undefined,
    tokens,
    pathId: pathId ? String(pathId) : undefined,
    templateId: templateId ? String(templateId) : undefined,
    simulatedProfit: simulatedProfit ? String(simulatedProfit) : undefined,
    submissionTargetBlock,
    dropStage: drop?.stage ? String(drop.stage) : undefined,
    dropReason: drop?.reason ? String(drop.reason) : undefined,
    dropError: drop?.error ? String(drop.error) : undefined,
    submitted: items.some((e) => e.type === "bundle_submitted" || e.submitted === true),
    bid: bid ? String(bid) : undefined,
    buildersSent,
    included: items.some((e) => e.type === "tx_included" || e.included === true),
    ourTxHashes,
  };
}

async function isOurTxIncluded(ctx: BlockAnalysisContext, opportunity: LiveLossOpportunity): Promise<boolean> {
  if (opportunity.ourTxHashes.length === 0) return false;
  for (const h of opportunity.ourTxHashes) {
    const hash = lower(h);
    if (ctx.txIndexByHash.has(hash)) return true;
    const tx = await getTxByHash(ctx, hash);
    if (tx?.blockNumber != null) return true;
  }
  return false;
}

async function getTxByHash(ctx: BlockAnalysisContext, hash: string): Promise<any | null> {
  const key = lower(hash);
  if (ctx.txLookupCache.has(key)) return ctx.txLookupCache.get(key) ?? null;
  try {
    const tx = await rpc.getTransaction(key);
    ctx.txLookupCache.set(key, tx ?? null);
    return tx ?? null;
  } catch (err) {
    ctx.txLookupCache.set(key, null);
    console.error(`[analysis/live-loss] tx lookup failed ${key}: ${(err as Error).message}`);
    return null;
  }
}

function isOurOrVictim(hash: string, opportunity: LiveLossOpportunity): boolean {
  const h = lower(hash);
  if (opportunity.victim && h === lower(opportunity.victim)) return true;
  return opportunity.ourTxHashes.includes(h);
}

function analyzeCompetitor(
  tx: any,
  receipt: any,
  opportunity: LiveLossOpportunity,
  victimIndex: number | null,
  baseFeePerGas: bigint,
): LiveLossCompetitor | null {
  const summary: TxSummary = {
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    blockNumber: hexToNumber(receipt.blockNumber),
    transactionIndex: hexToNumber(receipt.transactionIndex),
    gasUsed: hexToBigInt(receipt.gasUsed),
    effectiveGasPrice: hexToBigInt(receipt.effectiveGasPrice ?? tx.gasPrice),
    status: true,
  };
  const actors = uniq([summary.from, summary.to ?? ""].filter(Boolean));
  const logResult = actionsFromLogs(receipt, actors);
  const seq = canonicalSequence(logResult.actions);
  const samePool = Boolean(opportunity.pool && receiptTouches(receipt, opportunity.pool));
  const sameTokens = intersects(logResult.tokens, normalizeTokens(opportunity.tokens));
  if (victimIndex !== null && summary.transactionIndex <= victimIndex) return null;
  const sameVictim = victimIndex !== null && summary.transactionIndex > victimIndex && samePool;
  if (!samePool && !sameTokens && !sameVictim) return null;
  if (seq.length === 0 && !samePool && !sameTokens) return null;
  const priorityWei = summary.effectiveGasPrice > baseFeePerGas ? summary.effectiveGasPrice - baseFeePerGas : 0n;
  const effectiveBidEstimateEth = Number(priorityWei * summary.gasUsed) / 1e18;
  return {
    txHash: summary.hash,
    index: summary.transactionIndex,
    from: summary.from,
    to: summary.to,
    sameVictim,
    samePool,
    sameTokens,
    canonicalSequence: seq,
    pathTemplate: pathTemplate(seq),
    roughProfit: roughValueUsd(logResult.rawDeltas),
    effectiveBidEstimateEth,
    competitorEdge: competitorEdges(seq),
    tokens: logResult.tokens,
    protocols: logResult.protocols,
    rawDeltas: logResult.rawDeltas,
  };
}

function receiptTouches(receipt: any, address: string): boolean {
  const needle = lower(address);
  return (receipt.logs ?? []).some((log: any) => lower(log.address) === needle);
}

function normalizeTokens(tokens: string[]): string[] {
  const bySymbol: Record<string, string> = {
    WETH: ADDR.WETH,
    ETH: ADDR.WETH,
    USDC: ADDR.USDC,
    DAI: ADDR.DAI,
    USDT: ADDR.USDT,
    WSTUSR: ADDR.WSTUSR,
    DOLA: ADDR.DOLA,
    SUSDS: ADDR.SUSDS,
  };
  return tokens
    .map((t) => bySymbol[t.toUpperCase()] ?? t)
    .filter((t) => t.startsWith("0x"))
    .map(lower);
}

function intersects(a: string[], b: string[]): boolean {
  const set = new Set(a.map(lower));
  return b.some((x) => set.has(lower(x)));
}

function competitorEdges(seq: string[]): string[] {
  const out: string[] = [];
  if (seq.includes("credit.borrow") || seq.includes("credit.deposit_collateral")) out.push("borrow_leg");
  if (seq.includes("position.lp.mint") || seq.includes("position.lp.burn")) out.push("lp_leg");
  if (seq.some((x) => x.startsWith("peg."))) out.push("peg_or_redeem_leg");
  if (seq.includes("trade.swap")) out.push("same_token_or_pool_execution");
  return out;
}

function scoreCompetitor(c: LiveLossCompetitor): number {
  return (
    (c.sameVictim ? 1000 : 0) +
    (c.samePool ? 500 : 0) +
    (c.sameTokens ? 100 : 0) +
    c.competitorEdge.length * 25 +
    (c.roughProfit ?? 0)
  );
}

async function traceCompetitors(
  ctx: BlockAnalysisContext,
  items: LiveLossCompetitor[],
  miner?: string,
): Promise<Map<string, Action[]>> {
  const out = new Map<string, Action[]>();
  for (const c of items) {
    const key = lower(c.txHash);
    const cached = ctx.traceCache.get(key);
    if (cached) {
      out.set(key, cached);
      continue;
    }
    try {
      const trace = await rpc.traceTransaction(c.txHash);
      const actions = actionsFromTrace(trace, miner, [c.from, c.to ?? ""]);
      ctx.traceCache.set(key, actions);
      out.set(key, actions);
    } catch (err) {
      ctx.traceCache.set(key, []);
      console.error(`[analysis/live-loss] trace failed ${c.txHash}: ${(err as Error).message}`);
    }
  }
  return out;
}

function mergeKinds(seq: string[], traceActions: Action[]): string[] {
  return canonicalSequence([
    ...seq.map((kind, order) => ({
      kind: kind as Action["kind"],
      evidence: "logs-derived action",
      confidence: "medium" as const,
      order,
    })),
    ...traceActions.map((a, i) => ({ ...a, order: seq.length + i })),
  ]);
}

function decideLoss(
  opportunity: LiveLossOpportunity,
  victimLanded: boolean,
  competitors: LiveLossCompetitor[],
): LiveLossReport["loss"] {
  const evidence: string[] = [];
  const secondary = new Set<string>();
  if (!victimLanded) {
    return {
      primaryReason: "victim_not_landed",
      secondaryReasons: [],
      confidence: opportunity.victim ? "high" : "low",
      evidence: [opportunity.victim ? "victim hash absent from target block" : "no victim hash in event"],
      nextAction: ["verify opportunity event target block"],
    };
  }
  if (!opportunity.submitted) {
    if (opportunity.dropReason) {
      return {
        primaryReason: opportunity.dropReason,
        secondaryReasons: opportunity.dropStage ? [`stage_${opportunity.dropStage}`] : [],
        confidence: "high",
        evidence: [
          `pipeline dropped at ${opportunity.dropStage ?? "unknown"}: ${opportunity.dropReason}`,
          ...(opportunity.dropError ? [opportunity.dropError] : []),
        ],
        nextAction: nextActionsForDrop(opportunity.dropStage, opportunity.dropReason),
      };
    }
    return {
      primaryReason: "not_submitted",
      secondaryReasons: [],
      confidence: "high",
      evidence: ["no bundle_submitted event found"],
      nextAction: ["inspect searcher gating reason before submit"],
    };
  }
  if (opportunity.included) {
    return {
      primaryReason: "unknown",
      secondaryReasons: ["our_tx_included"],
      confidence: "low",
      evidence: ["our tx appears included; this is not a missed opportunity"],
      nextAction: ["compare realized pnl against simulation"],
    };
  }
  if (competitors.length === 0) {
    if (isDryRunOpportunity(opportunity)) {
      return {
        primaryReason: "unknown",
        secondaryReasons: ["dry_run_no_inclusion_truth"],
        confidence: "low",
        evidence: ["dry-run submission was not broadcast; inclusion and bid conclusions are disabled"],
        nextAction: ["use this report for path/not_seen/simulation gap only"],
      };
    }
    return {
      primaryReason: "not_included",
      secondaryReasons: [],
      confidence: "medium",
      evidence: ["bundle submitted, our tx not included, no same victim/pool/token competitor detected"],
      nextAction: ["check builder coverage and bid policy"],
    };
  }
  const top = competitors[0];
  evidence.push(`top competitor ${top.txHash} at index ${top.index}`);
  for (const edge of top.competitorEdge) secondary.add(edgeToReason(edge));
  const primary = choosePrimaryReason(top, opportunity);
  if (primary === "bid_too_low") evidence.push("competitor priority fee estimate exceeds our bid");
  if (top.samePool) evidence.push("competitor touched same pool");
  if (top.sameTokens) evidence.push("competitor touched same token set");
  return {
    primaryReason: primary,
    secondaryReasons: [...secondary].filter((x) => x !== primary),
    confidence: top.sameVictim || top.samePool ? "medium" : "low",
    evidence,
    nextAction: nextActions(primary, top),
  };
}

function choosePrimaryReason(top: LiveLossCompetitor, opportunity: LiveLossOpportunity): string {
  if (top.competitorEdge.includes("borrow_leg")) return "competitor_borrow_leg";
  if (top.competitorEdge.includes("lp_leg")) return "competitor_lp_leg";
  if (top.competitorEdge.includes("peg_or_redeem_leg")) return "competitor_peg_or_redeem_leg";
  const bidWei = opportunity.bid ? BigInt(opportunity.bid) : null;
  if (
    !isDryRunOpportunity(opportunity) &&
    bidWei !== null &&
    top.effectiveBidEstimateEth !== null &&
    top.effectiveBidEstimateEth > Number(bidWei) / 1e18
  ) {
    return "bid_too_low";
  }
  if (top.samePool || top.sameTokens) return "competitor_faster_same_path";
  return "unknown";
}

function isDryRunOpportunity(opportunity: LiveLossOpportunity): boolean {
  return opportunity.buildersSent.some((b) => lower(b) === "dry-run");
}

function nextActionsForDrop(stage?: string, reason?: string): string[] {
  if (reason === "no_candidate_plans") {
    return ["inspect planner graph coverage, borrowable tokens, and path-template constraints"];
  }
  if (reason === "quote-timeout" || stage === "solver") {
    return ["inspect solver timeout, quote source latency, and candidate pruning"];
  }
  if (stage === "overlay") {
    return ["inspect victim state overlay, balance slots, and live backend support"];
  }
  if (stage === "submit_gate") {
    return ["inspect submit gate policy and whether the candidate is actionable in dry-run/live mode"];
  }
  return ["inspect searcher stage logs for this opportunity"];
}

function edgeToReason(edge: string): string {
  if (edge === "borrow_leg") return "competitor_borrow_leg";
  if (edge === "lp_leg") return "competitor_lp_leg";
  if (edge === "peg_or_redeem_leg") return "competitor_peg_or_redeem_leg";
  return "liquidity_consumed";
}

function nextActions(primary: string, top: LiveLossCompetitor): string[] {
  if (primary === "competitor_borrow_leg") return ["replay competitor tx", "evaluate borrow-leg template support"];
  if (primary === "competitor_lp_leg") return ["replay competitor tx", "evaluate LP-positioned template support"];
  if (primary === "competitor_peg_or_redeem_leg") return ["replay competitor tx", "evaluate peg/redeem adapter coverage"];
  if (primary === "bid_too_low") return ["compare bid curve against competitor effective bid estimate"];
  if (primary === "competitor_faster_same_path") return ["compare same-path latency, builders, and pool coverage"];
  return [`manual review ${top.txHash}`];
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

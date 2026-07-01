import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { actionsFromLogs } from "../actions/from-logs.js";
import { canonicalSequence, pathTemplate } from "../actions/canonicalize.js";
import { runCompetitorScan } from "../competitor-scan.js";
import { roughValueUsd } from "../pnl/raw-delta.js";
import { aggregateNetProfit, priceArb, fetchEthUsd, type PricedLeg, type V4Swap } from "../pnl/arb-profit.js";
import { TOPICS, lower, short } from "../registry/protocols.js";
import { resolveV4PoolKeys } from "../registry/v4-poolkeys.js";
import { isPublicRouter } from "../registry/routers.js";
import { RpcClient } from "../rpc/client.js";
import { mapLimit, parseArgs, uniq, writeText } from "../util.js";

const args = parseArgs(process.argv.slice(2));
const eventsPath = args.events ? String(args.events) : "";
const graphPoolsPath = args["graph-pools"] ? String(args["graph-pools"]) : "searcher/pools/runtime-graph-pools.json";
const rpcUrl = String(args.rpc ?? process.env.READONLY_RPC_URL ?? process.env.MAINNET_RPC_URL ?? "");
const v4ArchiveRpcUrl = typeof args["v4-archive-rpc"] === "string"
  ? String(args["v4-archive-rpc"])
  : String(process.env.MAINNET_RPC_URL ?? "");
const fromBlockArg = args["from-block"] ? Number(args["from-block"]) : undefined;
const toBlockArg = args["to-block"] ? Number(args["to-block"]) : undefined;
const priceTrace = Boolean(args["price-trace"]);
const output = args.output ? String(args.output) : undefined;
const watch = parseWatch(args.watch);
const competitorScan = Boolean(args["competitor-scan"]);
const notSeenScan = Boolean(args["not-seen-scan"]);
const maxBlocks = Number(args["max-blocks"] ?? 200);

if (!eventsPath) {
  console.error("Usage: pnpm analysis live-loss --events ./analysis/events/searcher.jsonl (--competitor-scan | --watch <addr[,addr]>) --rpc <url>");
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
  await runWatchMode();
  process.exit(0);
}
console.error("Usage error: pass --competitor-scan or --watch <addr[,addr]>.");
process.exit(1);

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
  const pricedTxs: PricedLeg[] = [];
  const writtenReports: Array<{ outBase: string; report: WatchReport }> = [];
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
      writtenReports.push({ outBase, report });
      written++;
      console.error(`[analysis/live-loss/watch] wrote ${outBase}.md`);
    });
  }
  await enrichWrittenV4Reports(writtenReports);
  console.error(`[analysis/live-loss/watch] reports=${written}`);
  console.error(
    `[analysis/live-loss/watch] not_seen_gap_types graph_gap=${notSeenByGapType.graph_gap} ` +
      `detection_gap=${notSeenByGapType.detection_gap} unknown=${notSeenByGapType.unknown}`,
  );
  const netProfit = aggregateNetProfit(pricedTxs);
  console.error(
    `[analysis/live-loss/watch] net_per_block total=${netProfit.total.toFixed(0)} ` +
      `via_v4=${netProfit.viaV4.toFixed(0)} (ethUsd=${ethUsd.toFixed(0)})`,
  );
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
  lines.push(`- protocols: ${report.protocols.join(", ") || "n/a"}`);
  lines.push("");
  lines.push("## Next Action");
  lines.push("");
  for (const action of report.nextAction) lines.push(`- ${action}`);
  return `${lines.join("\n")}\n`;
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

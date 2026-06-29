import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { actionsFromLogs } from "../actions/from-logs.js";
import { actionsFromTrace } from "../actions/from-trace.js";
import { canonicalSequence, pathTemplate } from "../actions/canonicalize.js";
import { roughValueUsd } from "../pnl/raw-delta.js";
import { ADDR, TOPICS, lower, short } from "../registry/protocols.js";
import { RpcClient, hexToBigInt, hexToNumber } from "../rpc/client.js";
import type { Action, TxSummary } from "../types.js";
import { mapLimit, parseArgs, uniq, writeText } from "../util.js";
import {
  renderLiveLossMarkdown,
  type LiveLossCompetitor,
  type LiveLossOpportunity,
  type LiveLossReport,
} from "../report/live-loss-report.js";

const args = parseArgs(process.argv.slice(2));
const eventsPath = args.events ? String(args.events) : "";
const rpcUrl = String(args.rpc ?? process.env.READONLY_RPC_URL ?? process.env.MAINNET_RPC_URL ?? "");
const blockArg = args.block ? Number(args.block) : undefined;
const fromBlockArg = args["from-block"] ? Number(args["from-block"]) : undefined;
const toBlockArg = args["to-block"] ? Number(args["to-block"]) : undefined;
const traceTop = Number(args["trace-top"] ?? 3);
const output = args.output ? String(args.output) : undefined;
const opportunityArg = args.opportunity ? String(args.opportunity) : undefined;
const watch = parseWatch(args.watch);

if (!eventsPath) {
  console.error("Usage: pnpm analysis live-loss --events ./analysis/events/searcher.jsonl --block 123 --rpc <url>");
  process.exit(1);
}

const rpc = new RpcClient(rpcUrl);
const events = await readJsonl(eventsPath);
if (watch.length > 0) {
  await runWatchMode();
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
  poolInOurGraph: boolean;
  competitorEdge: string[];
  protocols: string[];
  roughProfit: number | null;
  nextAction: string[];
  rawDeltas: unknown[];
}

interface SeenSet {
  pools: Set<string>;
  tokens: Set<string>;
  any: boolean;
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

async function runWatchMode(): Promise<void> {
  const range = inferWatchRange(events);
  const seenByBlock = buildSeenByBlock(events);
  const watchSet = new Set(watch);
  let written = 0;
  console.error(
    `[analysis/live-loss/watch] blocks=${range.from}-${range.to} watch=${watch.length} traceTop=disabled`,
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
      const outBase = watchOutputBase(blockNumber, tx.hash);
      await writeText(resolve(`${outBase}.md`), renderWatchMarkdown(report));
      await writeText(resolve(`${outBase}.json`), JSON.stringify(report, jsonReplacer, 2));
      written++;
      console.error(`[analysis/live-loss/watch] wrote ${outBase}.md`);
    });
  }
  console.error(`[analysis/live-loss/watch] reports=${written}`);
}

function inferWatchRange(items: any[]): { from: number; to: number } {
  const blocks = inferBlocks(items);
  const from = fromBlockArg ?? blocks[0];
  const to = toBlockArg ?? blocks[blocks.length - 1];
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new Error(`Invalid watch block range: ${from}-${to}`);
  }
  const span = to - from + 1;
  if (span > 200) {
    throw new Error(`Refusing to watch-scan ${span} blocks; pass a <=200 block range with --from-block/--to-block`);
  }
  return { from, to };
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
    poolInOurGraph: pools.some((pool) => seen.pools.has(pool)),
    competitorEdge: competitorEdges(sequence),
    protocols: logResult.protocols,
    roughProfit: roughValueUsd(logResult.rawDeltas),
    nextAction: watchNextActions(primaryReason, seenScope, pools),
    rawDeltas: logResult.rawDeltas,
  };
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
  lines.push("");
  lines.push("## Footprint");
  lines.push("");
  lines.push(`- pools: ${report.pools.map((x) => `\`${short(x)}\``).join(", ") || "n/a"}`);
  lines.push(`- tokens: ${report.tokens.map((x) => `\`${short(x)}\``).join(", ") || "n/a"}`);
  lines.push(`- pool_in_our_graph: \`${report.poolInOurGraph}\``);
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

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { actionsFromLogs } from "../actions/from-logs.js";
import { actionsFromTrace } from "../actions/from-trace.js";
import { canonicalSequence, pathTemplate } from "../actions/canonicalize.js";
import { roughValueUsd } from "../pnl/raw-delta.js";
import { ADDR, lower } from "../registry/protocols.js";
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
const rpcUrl = String(args.rpc ?? process.env.READONLY_RPC_URL ?? "");
const blockArg = args.block ? Number(args.block) : undefined;
const traceTop = Number(args["trace-top"] ?? 3);
const output = args.output ? String(args.output) : undefined;

if (!eventsPath) {
  console.error("Usage: pnpm analysis live-loss --events ./analysis/events/searcher.jsonl --block 123 --rpc <url>");
  process.exit(1);
}

const rpc = new RpcClient(rpcUrl);
const events = await readJsonl(eventsPath);
const targetBlock = blockArg ?? inferBlock(events);
const blockEvents = events.filter((e) => Number(e.target_block ?? e.block ?? targetBlock) === targetBlock);
if (blockEvents.length === 0) throw new Error(`No events found for block ${targetBlock}`);

console.error(`[analysis/live-loss] block=${targetBlock} events=${blockEvents.length} traceTop=${traceTop}`);

const opportunity = aggregateOpportunity(blockEvents);
const block = await rpc.getBlockByNumber(targetBlock, true);
const blockTxs: any[] = Array.isArray(block.transactions) ? block.transactions : [];
const baseFeePerGas = hexToBigInt(block.baseFeePerGas);
const txIndexByHash = new Map<string, number>();
for (let i = 0; i < blockTxs.length; i++) txIndexByHash.set(lower(blockTxs[i].hash), i);

const victimIndex = opportunity.victim ? txIndexByHash.get(lower(opportunity.victim)) ?? null : null;
const victimLanded = victimIndex !== null;
const ourIncluded = opportunity.included || opportunity.ourTxHashes.some((h) => txIndexByHash.has(lower(h)));
opportunity.included = ourIncluded;

const receipts = await mapLimit(blockTxs, 8, async (tx) => {
  const receipt = await rpc.getReceipt(tx.hash);
  return { tx, receipt };
});

const competitors = receipts
  .filter(({ tx, receipt }) => receipt?.status === "0x1" && !isOurOrVictim(tx.hash, opportunity))
  .map(({ tx, receipt }) => analyzeCompetitor(tx, receipt, opportunity, victimIndex, baseFeePerGas))
  .filter((x): x is LiveLossCompetitor => x !== null)
  .sort((a, b) => scoreCompetitor(b) - scoreCompetitor(a));

const traced = await traceCompetitors(competitors.slice(0, Math.max(0, traceTop)), block?.miner);
for (const [hash, traceActions] of traced.entries()) {
  const c = competitors.find((x) => lower(x.txHash) === hash);
  if (!c || traceActions.length === 0) continue;
  const merged = mergeKinds(c.canonicalSequence, traceActions);
  c.canonicalSequence = merged;
  c.pathTemplate = pathTemplate(merged);
  c.competitorEdge = competitorEdges(merged);
}

const loss = decideLoss(opportunity, victimLanded, competitors);
const outBase = output ?? `outputs/live-loss/${targetBlock}.md`;
const mdPath = outBase.endsWith(".md") ? outBase : `${outBase}.md`;
const jsonPath = mdPath.replace(/\.md$/, ".json");

const report: LiveLossReport = {
  block: targetBlock,
  ourOpportunity: opportunity,
  victimStatus: { landed: victimLanded, victimIndex },
  competitors,
  loss,
  stats: {
    blockTx: blockTxs.length,
    receiptsAnalyzed: receipts.length,
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
console.error(`[analysis/live-loss] wrote ${jsonPath}`);

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

function inferBlock(items: any[]): number {
  const blocks = uniq(items.map((e) => Number(e.target_block ?? e.block)).filter((n) => Number.isFinite(n)));
  if (blocks.length !== 1) throw new Error("--block is required when JSONL has zero or multiple target blocks");
  return blocks[0];
}

function aggregateOpportunity(items: any[]): LiveLossOpportunity {
  const last = <T>(xs: T[]): T | undefined => xs.length ? xs[xs.length - 1] : undefined;
  const victim = last(items.map((e) => e.victim_hash ?? e.victimHash).filter(Boolean));
  const pool = last(items.map((e) => e.pool).filter(Boolean));
  const tokens = uniq(items.flatMap((e) => Array.isArray(e.tokens) ? e.tokens : []).map(String));
  const pathId = last(items.map((e) => e.path_id ?? e.pathId).filter(Boolean));
  const templateId = last(items.map((e) => e.template_id ?? e.templateId).filter(Boolean));
  const simulatedProfit = last(items.map((e) => e.simulated_profit ?? e.simulatedProfit).filter(Boolean));
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
    submitted: items.some((e) => e.type === "bundle_submitted" || e.submitted === true),
    bid: bid ? String(bid) : undefined,
    buildersSent,
    included: items.some((e) => e.type === "tx_included" || e.included === true),
    ourTxHashes,
  };
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

async function traceCompetitors(items: LiveLossCompetitor[], miner?: string): Promise<Map<string, Action[]>> {
  const out = new Map<string, Action[]>();
  for (const c of items) {
    try {
      const trace = await rpc.traceTransaction(c.txHash);
      out.set(lower(c.txHash), actionsFromTrace(trace, miner, [c.from, c.to ?? ""]));
    } catch (err) {
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
  if (bidWei !== null && top.effectiveBidEstimateEth !== null && top.effectiveBidEstimateEth > Number(bidWei) / 1e18) {
    return "bid_too_low";
  }
  if (top.samePool || top.sameTokens) return "competitor_faster_same_path";
  return "unknown";
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

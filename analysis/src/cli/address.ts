import { resolve } from "node:path";
import { RpcClient, hexToBigInt, hexToNumber } from "../rpc/client.js";
import { txHashesForAddress } from "../rpc/txlist.js";
import { actionsFromLogs } from "../actions/from-logs.js";
import { actionsFromTrace } from "../actions/from-trace.js";
import { canonicalSequence, pathTemplate, strategyType } from "../actions/canonicalize.js";
import { buildEntityCluster, actorForTx } from "../cluster/entity.js";
import { clusterStrategies } from "../cluster/strategy.js";
import { renderMarkdown, type AddressReport } from "../report/address-report.js";
import { gasPaidEth, roughValueUsd } from "../pnl/raw-delta.js";
import { lower, short } from "../registry/protocols.js";
import type { Action, TxAnalysis, TxSummary } from "../types.js";
import { mapLimit, parseArgs, uniq, writeText } from "../util.js";

const args = parseArgs(process.argv.slice(2));
const seed = String(args.seed ?? "");
const rpcUrl = String(args.rpc ?? process.env.READONLY_RPC_URL ?? "");
const limit = Number(args.limit ?? 100);
const traceTop = Number(args["trace-top"] ?? 5);
const chain = String(args.chain ?? "mainnet");
const output = args.output ? String(args.output) : undefined;
const forceTrace = String(args["force-trace"] ?? "")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

if (!seed || !seed.startsWith("0x")) {
  console.error("Usage: pnpm analysis address --seed 0x... --rpc <url> [--limit 100] [--trace-top 5]");
  process.exit(1);
}

const rpc = new RpcClient(rpcUrl);
console.error(`[analysis/address] seed=${seed} limit=${limit} traceTop=${traceTop}`);

const hashes = await txHashesForAddress(rpc, seed, limit);
console.error(`[analysis/address] fetched ${hashes.length} tx hashes`);

const txPairs = await mapLimit(hashes, 8, async (hash) => {
  const [tx, receipt] = await Promise.all([rpc.getTransaction(hash), rpc.getReceipt(hash)]);
  if (!tx || !receipt || receipt.status !== "0x1") return null;
  const summary: TxSummary = {
    hash,
    from: tx.from,
    to: tx.to,
    blockNumber: hexToNumber(receipt.blockNumber),
    transactionIndex: hexToNumber(receipt.transactionIndex),
    gasUsed: hexToBigInt(receipt.gasUsed),
    effectiveGasPrice: hexToBigInt(receipt.effectiveGasPrice ?? tx.gasPrice),
    status: true,
  };
  return { summary, tx, receipt };
});

const pairs = txPairs.filter((x): x is NonNullable<typeof x> => x !== null)
  .sort((a, b) => b.summary.blockNumber - a.summary.blockNumber || b.summary.transactionIndex - a.summary.transactionIndex);

const cluster = buildEntityCluster(seed, pairs.map((x) => x.summary));
const preliminary = pairs.map((pair) => analyzeLogsOnly(pair, seed, cluster));
const traceTargets = chooseTraceTargets(preliminary, traceTop, forceTrace);
console.error(`[analysis/address] tracing ${traceTargets.size} representative/high-value txs`);

const traced = new Map<string, Action[]>();
for (const tx of preliminary.filter((x) => traceTargets.has(lower(x.tx.hash)))) {
  try {
    const block = await rpc.getBlockByNumber(tx.tx.blockNumber, false);
    const trace = await rpc.traceTransaction(tx.tx.hash);
    traced.set(lower(tx.tx.hash), actionsFromTrace(trace, block?.miner, [seed, tx.actor]));
  } catch (err) {
    console.error(`[analysis/address] trace failed ${tx.tx.hash}: ${(err as Error).message}`);
  }
}

const analyses = preliminary.map((tx) => {
  const traceActions = traced.get(lower(tx.tx.hash));
  const allActions = traceActions?.length ? mergeTraceAndLogs(tx.actionsFromLogs, traceActions) : tx.actionsFromLogs;
  const seq = canonicalSequence(allActions);
  return {
    ...tx,
    actionsFromTrace: traceActions,
    canonicalSequence: seq,
    pathTemplate: pathTemplate(seq),
    strategyType: strategyType(seq, false),
    traceReason: traceActions ? traceReasonFor(tx) : undefined,
  };
});

const strategies = clusterStrategies(analyses);
const unknownReplayable = analyses.filter((x) => x.pathTemplate === "unknown_replayable");
const outBase = output ?? `outputs/address/${lower(seed)}.md`;
const jsonPath = outBase.endsWith(".md") ? outBase.replace(/\.md$/, ".json") : `${outBase}.json`;
const mdPath = outBase.endsWith(".md") ? outBase : `${outBase}.md`;

const report: AddressReport = {
  seed,
  chain,
  range: `latest ${hashes.length} tx hashes via Alchemy-compatible txlist`,
  entityCluster: cluster,
  totalTx: hashes.length,
  analyzedTx: analyses.length,
  tracedTx: traced.size,
  strategyClusters: strategies,
  txs: analyses,
  unknownReplayable,
  excluded: {
    sandwich: 0,
    directionalSuspect: analyses.filter((x) => x.pathTemplate === "unknown_opaque").length,
    standing: analyses.filter((x) => x.strategyType === "atomic/standing").length,
    routerOrSolverFp: 0,
  },
  outputJson: jsonPath,
  outputMarkdown: mdPath,
};

const markdown = renderMarkdown(report);
await writeText(resolve(mdPath), markdown);
await writeText(resolve(jsonPath), JSON.stringify(report, jsonReplacer, 2));

console.error(`[analysis/address] wrote ${mdPath}`);
console.error(`[analysis/address] wrote ${jsonPath}`);

function analyzeLogsOnly(pair: { summary: TxSummary; receipt: any }, seedAddr: string, entity: typeof cluster): TxAnalysis {
  const actor = actorForTx(seedAddr, pair.summary, entity);
  const actors = uniq([seedAddr, actor, pair.summary.from, pair.summary.to ?? ""].filter(Boolean));
  const logResult = actionsFromLogs(pair.receipt, actors);
  const seq = canonicalSequence(logResult.actions);
  const gasEth = gasPaidEth(pair.summary.gasUsed, pair.summary.effectiveGasPrice);
  const roughUsd = roughValueUsd(logResult.rawDeltas);
  return {
    tx: pair.summary,
    actor,
    candidateLabel: candidateLabel(pair.summary, logResult.actions),
    actionsFromLogs: logResult.actions,
    canonicalSequence: seq,
    pathTemplate: pathTemplate(seq),
    strategyType: strategyType(seq, false),
    tokens: logResult.tokens,
    venues: logResult.venues,
    protocols: logResult.protocols,
    rawDeltas: logResult.rawDeltas,
    roughPnlUsd: roughUsd,
    gasPaidEth: gasEth,
    netExInternalBribeUsd: roughUsd,
  };
}

function candidateLabel(tx: TxSummary, actions: Action[]): string {
  if (tx.to && actions.length === 0) return "execution_candidate";
  if (actions.length > 0) return "path_candidate";
  return "unknown";
}

function chooseTraceTargets(txs: TxAnalysis[], max: number, forced: string[]): Set<string> {
  const forcedSet = new Set(forced);
  const scored = txs.map((tx) => ({
    tx,
    score:
      (forcedSet.has(lower(tx.tx.hash)) ? 10_000 : 0) +
      (tx.pathTemplate.startsWith("unknown") ? 100 : 0) +
      (tx.canonicalSequence.includes("position.lp.mint") ? 100 : 0) +
      (tx.canonicalSequence.includes("credit.borrow") ? 100 : 0) +
      (tx.netExInternalBribeUsd ?? 0) +
      tx.actionsFromLogs.length,
  }));
  const chosen = new Set<string>();
  for (const item of scored.sort((a, b) => b.score - a.score).slice(0, max)) {
    chosen.add(lower(item.tx.tx.hash));
  }
  for (const f of forcedSet) chosen.add(f);
  return chosen;
}

function traceReasonFor(tx: TxAnalysis): string {
  if (tx.pathTemplate.startsWith("unknown")) return "unknown_replayable/opaque";
  if (tx.canonicalSequence.includes("position.lp.mint")) return "LP mint/burn + swap";
  if (tx.canonicalSequence.includes("credit.borrow")) return "borrow/repay + swap";
  return "representative/high-value";
}

function mergeTraceAndLogs(logs: Action[], trace: Action[]): Action[] {
  const out = [...logs];
  const offset = logs.length ? Math.max(...logs.map((a) => a.order)) + 1 : 0;
  for (const t of trace) out.push({ ...t, order: t.order + offset });
  return out;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

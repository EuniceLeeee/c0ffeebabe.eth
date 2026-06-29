import type { StrategyCluster, TxAnalysis } from "../types.js";
import type { EntityCluster } from "../cluster/entity.js";
import { describeEdges } from "../cluster/entity.js";
import { formatTokenAmount } from "../decode/erc20.js";
import { short } from "../registry/protocols.js";

export interface AddressReport {
  seed: string;
  chain: string;
  range: string;
  entityCluster: EntityCluster;
  totalTx: number;
  analyzedTx: number;
  tracedTx: number;
  strategyClusters: StrategyCluster[];
  txs: TxAnalysis[];
  unknownReplayable: TxAnalysis[];
  excluded: {
    sandwich: number;
    directionalSuspect: number;
    standing: number;
    routerOrSolverFp: number;
  };
  outputJson: string;
  outputMarkdown: string;
}

export function renderMarkdown(report: AddressReport): string {
  const lines: string[] = [];
  lines.push(`# Address Path Profile`);
  lines.push("");
  lines.push(`Seed: \`${report.seed}\``);
  lines.push(`Chain: \`${report.chain}\``);
  lines.push(`Range: ${report.range}`);
  lines.push("");
  lines.push(`## Entity Cluster`);
  lines.push("");
  lines.push(`Confidence: \`${report.entityCluster.confidence}\``);
  lines.push(`Overmerge risk: \`${report.entityCluster.overmergeRisk}\``);
  lines.push("");
  lines.push(`Members:`);
  for (const m of report.entityCluster.members) lines.push(`- \`${m}\``);
  lines.push("");
  lines.push(`Merge evidence:`);
  for (const e of describeEdges(report.entityCluster.edges)) lines.push(`- ${e}`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- total tx fetched: ${report.totalTx}`);
  lines.push(`- analyzed tx: ${report.analyzedTx}`);
  lines.push(`- traced tx: ${report.tracedTx}`);
  lines.push(`- strategy clusters: ${report.strategyClusters.length}`);
  lines.push(`- unknown_replayable: ${report.unknownReplayable.length}`);
  lines.push(`- excluded standing: ${report.excluded.standing}`);
  lines.push("");
  lines.push(`## Strategy Clusters`);
  lines.push("");
  for (const c of report.strategyClusters) {
    lines.push(`### ${c.id}: ${c.pathTemplate}`);
    lines.push("");
    lines.push(`- tx_count: ${c.txCount}`);
    lines.push(`- representative_tx: \`${c.representativeTx}\``);
    lines.push(`- strategy_type: \`${c.strategyType}\``);
    lines.push(`- funding: \`${c.funding}\``);
    lines.push(`- our_support: \`${c.ourSupport}\``);
    lines.push(`- rough_pnl_usd: ${fmt(c.roughPnlUsd)}`);
    lines.push(`- canonical_sequence: \`${c.canonicalSequence.join(" -> ")}\``);
    lines.push(`- tokens: ${c.tokens.map((x) => `\`${short(x)}\``).join(", ") || "n/a"}`);
    lines.push(`- protocols: ${c.protocols.join(", ") || "n/a"}`);
    lines.push(`- our_gap:`);
    for (const g of c.ourGap) lines.push(`  - ${g}`);
    lines.push(`- next_action:`);
    for (const a of c.nextAction) lines.push(`  - ${a}`);
    lines.push("");
  }
  lines.push(`## Unknown Replayable`);
  lines.push("");
  if (report.unknownReplayable.length === 0) {
    lines.push(`None detected in this run.`);
  } else {
    for (const tx of report.unknownReplayable.slice(0, 10)) {
      lines.push(`- \`${tx.tx.hash}\`: ${tx.canonicalSequence.join(" -> ")}; rough_pnl_usd=${fmt(tx.netExInternalBribeUsd)}`);
    }
  }
  lines.push("");
  lines.push(`## Representative Transactions`);
  lines.push("");
  for (const tx of report.txs.filter((t) => report.strategyClusters.some((c) => c.representativeTx === t.tx.hash))) {
    lines.push(`### \`${tx.tx.hash}\``);
    lines.push("");
    lines.push(`- actor: \`${tx.actor}\``);
    lines.push(`- block/index: ${tx.tx.blockNumber}/${tx.tx.transactionIndex}`);
    lines.push(`- path_template: \`${tx.pathTemplate}\``);
    lines.push(`- trace_reason: ${tx.traceReason ?? "logs-only"}`);
    lines.push(`- sequence: \`${tx.canonicalSequence.join(" -> ")}\``);
    lines.push(`- raw_deltas:`);
    for (const d of tx.rawDeltas) lines.push(`  - ${formatTokenAmount(d.token, d.raw)}`);
    lines.push(`- evidence:`);
    for (const a of [...tx.actionsFromLogs, ...(tx.actionsFromTrace ?? [])].slice(0, 30)) {
      lines.push(`  - ${a.kind}: ${a.evidence}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function fmt(x: number | null): string {
  return x == null ? "n/a" : x.toFixed(4);
}

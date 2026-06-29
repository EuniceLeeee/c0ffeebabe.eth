import { formatTokenAmount } from "../decode/erc20.js";
import { short } from "../registry/protocols.js";
import type { TokenDelta } from "../types.js";

export interface LiveLossOpportunity {
  victim?: string;
  pool?: string;
  tokens: string[];
  pathId?: string;
  templateId?: string;
  simulatedProfit?: string;
  submissionTargetBlock?: number;
  dropStage?: string;
  dropReason?: string;
  dropError?: string;
  submitted: boolean;
  bid?: string;
  buildersSent: string[];
  included: boolean;
  ourTxHashes: string[];
}

export interface LiveLossCompetitor {
  txHash: string;
  index: number;
  from: string;
  to: string | null;
  sameVictim: boolean;
  samePool: boolean;
  sameTokens: boolean;
  canonicalSequence: string[];
  pathTemplate: string;
  roughProfit: number | null;
  effectiveBidEstimateEth: number | null;
  competitorEdge: string[];
  tokens: string[];
  protocols: string[];
  rawDeltas: TokenDelta[];
}

export interface LiveLossReport {
  block: number;
  opportunityId?: string;
  ourOpportunity: LiveLossOpportunity;
  victimStatus: {
    landed: boolean;
    victimIndex: number | null;
  };
  competitors: LiveLossCompetitor[];
  loss: {
    primaryReason: string;
    secondaryReasons: string[];
    confidence: "high" | "medium" | "low";
    evidence: string[];
    nextAction: string[];
  };
  stats: {
    blockTx: number;
    receiptsAnalyzed: number;
    competitorsFound: number;
    unknownCompetitors: number;
    tracedTx: number;
  };
  outputJson: string;
  outputMarkdown: string;
}

export function renderLiveLossMarkdown(report: LiveLossReport): string {
  const lines: string[] = [];
  lines.push(`# Live Loss Report`);
  lines.push("");
  lines.push(`Block: \`${report.block}\``);
  if (report.opportunityId) lines.push(`Opportunity: \`${report.opportunityId}\``);
  lines.push("");
  lines.push(`## Our Opportunity`);
  lines.push("");
  lines.push(`- victim: ${fmtHash(report.ourOpportunity.victim)}`);
  lines.push(`- pool: ${fmtHash(report.ourOpportunity.pool)}`);
  lines.push(`- tokens: ${report.ourOpportunity.tokens.map((x) => `\`${shortOrSymbol(x)}\``).join(", ") || "n/a"}`);
  lines.push(`- path_id: \`${report.ourOpportunity.pathId ?? "unknown"}\``);
  lines.push(`- template_id: \`${report.ourOpportunity.templateId ?? "unknown"}\``);
  lines.push(`- simulated_profit: \`${report.ourOpportunity.simulatedProfit ?? "unknown"}\``);
  lines.push(`- submission_target_block: \`${report.ourOpportunity.submissionTargetBlock ?? "unknown"}\``);
  lines.push(`- drop_stage: \`${report.ourOpportunity.dropStage ?? "unknown"}\``);
  lines.push(`- drop_reason: \`${report.ourOpportunity.dropReason ?? "unknown"}\``);
  lines.push(`- drop_error: \`${report.ourOpportunity.dropError ?? "unknown"}\``);
  lines.push(`- submitted: \`${report.ourOpportunity.submitted}\``);
  lines.push(`- bid: \`${report.ourOpportunity.bid ?? "unknown"}\``);
  lines.push(`- builders_sent: ${redactedBuilders(report.ourOpportunity.buildersSent).join(", ") || "n/a"}`);
  lines.push(`- included: \`${report.ourOpportunity.included}\``);
  lines.push("");
  lines.push(`## Victim Status`);
  lines.push("");
  lines.push(`- landed: \`${report.victimStatus.landed}\``);
  lines.push(`- victim_index: \`${report.victimStatus.victimIndex ?? "n/a"}\``);
  lines.push("");
  lines.push(`## Loss`);
  lines.push("");
  lines.push(`- primary_reason: \`${report.loss.primaryReason}\``);
  lines.push(`- secondary_reasons: ${report.loss.secondaryReasons.map((x) => `\`${x}\``).join(", ") || "n/a"}`);
  lines.push(`- confidence: \`${report.loss.confidence}\``);
  lines.push(`- evidence:`);
  for (const e of report.loss.evidence) lines.push(`  - ${e}`);
  lines.push(`- next_action:`);
  for (const a of report.loss.nextAction) lines.push(`  - ${a}`);
  lines.push("");
  lines.push(`## Competitors`);
  lines.push("");
  if (report.competitors.length === 0) {
    lines.push(`None detected by same victim/pool/token rules.`);
  } else {
    for (const c of report.competitors.slice(0, 20)) {
      lines.push(`### \`${c.txHash}\``);
      lines.push("");
      lines.push(`- index: ${c.index}`);
      lines.push(`- from: \`${c.from}\``);
      lines.push(`- to: ${fmtHash(c.to ?? undefined)}`);
      lines.push(`- same_victim: \`${c.sameVictim}\``);
      lines.push(`- same_pool: \`${c.samePool}\``);
      lines.push(`- same_tokens: \`${c.sameTokens}\``);
      lines.push(`- path_template: \`${c.pathTemplate}\``);
      lines.push(`- canonical_sequence: \`${c.canonicalSequence.join(" -> ")}\``);
      lines.push(`- rough_profit: ${fmtNumber(c.roughProfit)}`);
      lines.push(`- effective_bid_estimate_eth: ${fmtNumber(c.effectiveBidEstimateEth)}`);
      lines.push(`- competitor_edge: ${c.competitorEdge.map((x) => `\`${x}\``).join(", ") || "n/a"}`);
      lines.push(`- tokens: ${c.tokens.map((x) => `\`${shortOrSymbol(x)}\``).join(", ") || "n/a"}`);
      lines.push(`- protocols: ${c.protocols.join(", ") || "n/a"}`);
      lines.push(`- raw_deltas:`);
      for (const d of c.rawDeltas) lines.push(`  - ${formatTokenAmount(d.token, d.raw)}`);
      lines.push("");
    }
  }
  lines.push(`## Stats`);
  lines.push("");
  lines.push(`- block_tx: ${report.stats.blockTx}`);
  lines.push(`- receipts_analyzed: ${report.stats.receiptsAnalyzed}`);
  lines.push(`- competitors_found: ${report.stats.competitorsFound}`);
  lines.push(`- unknown_competitors: ${report.stats.unknownCompetitors}`);
  lines.push(`- traced_tx: ${report.stats.tracedTx}`);
  return `${lines.join("\n")}\n`;
}

function fmtHash(x?: string): string {
  return x ? `\`${x}\`` : "`unknown`";
}

function shortOrSymbol(x: string): string {
  return x.startsWith("0x") ? short(x) : x;
}

function fmtNumber(x: number | null): string {
  return x == null ? "n/a" : x.toFixed(6);
}

function redactedBuilders(builders: string[]): string[] {
  return builders.map((b) => `\`${hashish(b)}\``);
}

function hashish(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `builder#${(h >>> 0).toString(16)}`;
}

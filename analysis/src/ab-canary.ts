import fs from "node:fs";
import path from "node:path";

export type AbVerdict = "win" | "lose" | "inconclusive";
export type ScriptAssessment = "supports" | "contradicts" | "inconclusive";
export type FinalVerdict = "win" | "lose" | "needs_escalation";
export type ChangeClass = "performance" | "correctness" | "capability";

type BlockRecord = {
  block: number;
  stage: Record<string, number>;
  summary: Record<string, number>;
  events: Record<string, number>;
  bestNet: string | null;
  solveResults: string[];
  rings: Set<string>;
  budgetExceeded: boolean;
  catchupWarm: boolean;
  fullWarm: boolean;
};

export type AbCompareOptions = {
  goal?: "improvement" | "equivalence";
  metric: string;
  direction: "lower" | "higher";
  aggregate: "mean" | "p50" | "p95";
  minPairedBlocks: number;
  warmupBlocks: number;
  minImprovementPct: number;
  minAbsoluteDelta: number;
  maxRegressionPct: number;
  requireOutputMatch: boolean;
};

export type AbCompareResult = {
  schema_version: 1;
  comparison_goal: "improvement" | "equivalence";
  metric: string;
  direction: "lower" | "higher";
  aggregate: "mean" | "p50" | "p95";
  paired_blocks: number;
  paired_block_range: { from: number; to: number } | null;
  warmup_blocks_excluded: number;
  a_value: number | null;
  b_value: number | null;
  absolute_delta: number | null;
  improvement_pct: number | null;
  output_mismatches: number;
  output_mismatch_blocks: number[];
  ring_set_mismatch_blocks: number[];
  budget_censored_blocks: number[];
  catchup_censored_blocks: number[];
  full_warm_censored_blocks: number[];
  require_output_match: boolean;
  script_assessment: ScriptAssessment;
  reasons: string[];
};

const SUMMARY_RE = /\[searcher\/blockscan\]\s+block=(\d+)\s+scannedPairs=(\d+)\s+candidates=(\d+)\s+quotePositive=(\d+)\s+bestNet=(null|-?\d+)\s+warmedV2V3=(\d+)\s+protocolMids=(\d+)\s+skippedVenues=(\d+)\s+ms=(\d+)/;
const STAGE_RE = /\[searcher\/blockscan\]\s+block=(\d+)\s+stage\s+(.+)$/;
const BLOCK_RE = /\[searcher\/blockscan\]\s+block=(\d+)\b/;
const PASS_START_RE = /\[searcher\/blockscan\]\s+block=(\d+)\s+(?:warm=|warmedV2V3=)/;
const INCREMENTAL_WARM_RE = /\[searcher\/blockscan\]\s+block=(\d+)\s+warm=incremental\b.*\brange=(\d+)-(\d+)\b/;
const FULL_WARM_RE = /\[searcher\/blockscan\]\s+block=(\d+)\s+warm=full\b/;
const SOLVE_RE = /\[searcher\/blockscan\]\s+(?:block=(\d+)\s+)?solve ring=(\S+)\s+net=(null|-?\d+)(?:\s+error=(\S+))?/;
const BUDGET_RE = /\[searcher\/blockscan\]\s+block=(\d+)\s+pass_budget_exceeded\b/;
const EVENT_PATTERNS: [string, RegExp][] = [
  ["blacklistSkip", /\[searcher\/blockscan\]\s+(?:block=\d+\s+)?blacklist skip ring=/],
  ["solvePositive", /\[searcher\/blockscan\]\s+(?:block=\d+\s+)?solve ring=.*\snet=[1-9]\d*\b/],
  ["finalSimRejected", /\[searcher\/blockscan\]\s+(?:block=\d+\s+)?final sim rejected ring=/],
  ["phantomRejected", /\[searcher\/blockscan\]\s+(?:block=\d+\s+)?reject phantom ring=/],
  ["standingPositionRejected", /\[searcher\/blockscan\]\s+(?:block=\d+\s+)?reject standing-position ring=/],
  ["belowEvSkipped", /\[searcher\/blockscan\]\s+(?:block=\d+\s+)?skip below-EV ring=/],
  ["evOk", /\[searcher\/blockscan\]\s+(?:block=\d+\s+)?EV ok:/],
  ["submitted", /\[searcher\/blockscan\]\s+(?:block=\d+\s+)?submitted\s+atomic\s+via\b/],
  ["submitFailed", /\[searcher\/blockscan\]\s+(?:block=\d+\s+)?submit (?:failed|error) ring=/],
];

export function parseBlockScanLog(text: string): Map<number, BlockRecord> {
  const records = new Map<number, BlockRecord>();
  const get = (block: number): BlockRecord => {
    const existing = records.get(block);
    if (existing) return existing;
    const created: BlockRecord = {
      block,
      stage: {},
      summary: {},
      events: {},
      bestNet: null,
      solveResults: [],
      rings: new Set(),
      budgetExceeded: false,
      catchupWarm: false,
      fullWarm: false,
    };
    records.set(block, created);
    return created;
  };

  let currentBlock: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const passStart = line.match(PASS_START_RE);
    if (passStart) currentBlock = Number(passStart[1]);
    const incrementalWarm = line.match(INCREMENTAL_WARM_RE);
    if (incrementalWarm) {
      const block = Number(incrementalWarm[1]);
      const from = Number(incrementalWarm[2]);
      const to = Number(incrementalWarm[3]);
      get(block).catchupWarm = from !== to || to !== block;
    }
    const fullWarm = line.match(FULL_WARM_RE);
    if (fullWarm) get(Number(fullWarm[1])).fullWarm = true;
    const budget = line.match(BUDGET_RE);
    if (budget) get(Number(budget[1])).budgetExceeded = true;
    const summary = line.match(SUMMARY_RE);
    if (summary) {
      const block = Number(summary[1]);
      // Real solve/event lines omit the block number. Keep them attached to the
      // active warm pass; a concurrent `block=N+1 skipped=busy` is not a pass switch.
      // Setting this on summaries also keeps legacy/synthetic logs parseable.
      currentBlock = block;
      const record = get(block);
      record.summary = {
        scannedPairs: Number(summary[2]),
        candidates: Number(summary[3]),
        quotePositive: Number(summary[4]),
        warmedV2V3: Number(summary[6]),
        protocolMids: Number(summary[7]),
        skippedVenues: Number(summary[8]),
        ms: Number(summary[9]),
      };
      record.bestNet = summary[5] === "null" ? null : summary[5];
      if (currentBlock === null) currentBlock = block;
    }

    const stage = line.match(STAGE_RE);
    if (stage) {
      const block = Number(stage[1]);
      const record = get(block);
      for (const match of stage[2].matchAll(/([A-Za-z0-9_]+)=(-?\d+)ms/g)) {
        record.stage[match[1]] = Number(match[2]);
      }
    }
    const explicitBlock = line.match(BLOCK_RE);
    const solve = line.match(SOLVE_RE);
    const attributedBlock = solve?.[1]
      ? Number(solve[1])
      : explicitBlock && !/skipped=busy\b/.test(line) ? Number(explicitBlock[1]) : currentBlock;
    if (attributedBlock !== null) {
      const record = get(attributedBlock);
      if (solve) {
        record.rings.add(solve[2]);
        record.solveResults.push(`${solve[2]}|${solve[3]}|${solve[4] ?? ""}`);
      }
      for (const [name, pattern] of EVENT_PATTERNS) {
        if (pattern.test(line)) record.events[name] = (record.events[name] ?? 0) + 1;
      }
    }
    if (stage && currentBlock === Number(stage[1])) currentBlock = null;
  }
  return records;
}

function metricValue(record: BlockRecord, metric: string): number | null {
  if (metric.startsWith("stage.")) return record.stage[metric.slice("stage.".length)] ?? null;
  if (metric.startsWith("summary.")) return record.summary[metric.slice("summary.".length)] ?? null;
  if (metric.startsWith("event.")) return record.events[metric.slice("event.".length)] ?? 0;
  if (metric === "total_ms") return record.stage.total ?? record.summary.ms ?? null;
  if (metric.endsWith("_ms")) return record.stage[metric.slice(0, -3)] ?? null;
  return record.summary[metric] ?? null;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function aggregate(values: number[], kind: AbCompareOptions["aggregate"]): number {
  if (kind === "mean") return values.reduce((sum, value) => sum + value, 0) / values.length;
  return percentile(values, kind === "p50" ? 0.5 : 0.95);
}

function outputsMatch(a: BlockRecord, b: BlockRecord): boolean {
  const fields = ["scannedPairs", "candidates", "quotePositive", "protocolMids", "skippedVenues"];
  const eventNames = new Set([...Object.keys(a.events), ...Object.keys(b.events)]);
  return fields.every((field) => a.summary[field] === b.summary[field])
    && [...eventNames].every((field) => (a.events[field] ?? 0) === (b.events[field] ?? 0))
    && a.bestNet === b.bestNet
    && sorted(a.solveResults).join("\n") === sorted(b.solveResults).join("\n");
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function ringSetsMatch(a: BlockRecord, b: BlockRecord): boolean {
  return sorted(a.rings).join("\n") === sorted(b.rings).join("\n");
}

export function compareBlockScanLogs(
  aText: string,
  bText: string,
  options: AbCompareOptions,
): AbCompareResult {
  const a = parseBlockScanLog(aText);
  const b = parseBlockScanLog(bText);
  const goal = options.goal ?? "improvement";
  const common = [...a.keys()].filter((block) => b.has(block)).sort((x, y) => x - y);
  const completePairs = common.flatMap((block) => {
    const ar = a.get(block)!;
    const br = b.get(block)!;
    const av = metricValue(ar, options.metric);
    const bv = metricValue(br, options.metric);
    return av === null || bv === null ? [] : [{ block, ar, br, av, bv }];
  });
  const budgetCensored = completePairs
    .filter(({ ar, br }) => ar.budgetExceeded || br.budgetExceeded)
    .map(({ block }) => block);
  const catchupCensored = completePairs
    .filter(({ ar, br }) => ar.catchupWarm || br.catchupWarm)
    .map(({ block }) => block);
  const fullWarmCensored = completePairs
    .filter(({ ar, br }) => ar.fullWarm || br.fullWarm)
    .map(({ block }) => block);
  const uncensored = completePairs.filter(({ ar, br }) =>
    !ar.budgetExceeded && !br.budgetExceeded
    && !ar.catchupWarm && !br.catchupWarm
    && !ar.fullWarm && !br.fullWarm);
  const pairs = uncensored.slice(Math.max(0, options.warmupBlocks));
  const reasons: string[] = [];
  if (budgetCensored.length > 0) {
    reasons.push(`excluded ${budgetCensored.length} budget-censored paired blocks`);
  }
  if (catchupCensored.length > 0) {
    reasons.push(`excluded ${catchupCensored.length} catch-up paired blocks with unequal cache history`);
  }
  if (fullWarmCensored.length > 0) {
    reasons.push(`excluded ${fullWarmCensored.length} full-warm paired blocks`);
  }
  const outputMismatchBlocks = pairs.filter(({ ar, br }) => !outputsMatch(ar, br)).map(({ block }) => block);
  const ringSetMismatchBlocks = pairs.filter(({ ar, br }) => !ringSetsMatch(ar, br)).map(({ block }) => block);
  const outputMismatches = outputMismatchBlocks.length;
  let scriptAssessment: ScriptAssessment = "inconclusive";
  let aValue: number | null = null;
  let bValue: number | null = null;
  let absoluteDelta: number | null = null;
  let improvementPct: number | null = null;

  if (pairs.length < options.minPairedBlocks) {
    reasons.push(`paired blocks ${pairs.length} < required ${options.minPairedBlocks}`);
  } else if (options.requireOutputMatch && outputMismatches > 0) {
    scriptAssessment = "contradicts";
    reasons.push(`output mismatch on ${outputMismatches}/${pairs.length} paired blocks`);
  } else if (goal === "equivalence" && !options.requireOutputMatch) {
    reasons.push("equivalence comparison requires requireOutputMatch=true");
  } else {
    aValue = aggregate(pairs.map((pair) => pair.av), options.aggregate);
    bValue = aggregate(pairs.map((pair) => pair.bv), options.aggregate);
    absoluteDelta = options.direction === "lower" ? aValue - bValue : bValue - aValue;
    improvementPct = aValue === 0 ? null : (absoluteDelta / Math.abs(aValue)) * 100;
    if (goal === "equivalence") {
      scriptAssessment = "supports";
      reasons.push(`semantic outputs and solved-ring sets matched on ${pairs.length} paired blocks`);
    } else {
      const absolutePass = absoluteDelta > 0 && absoluteDelta >= options.minAbsoluteDelta;
      const percentPass = options.minImprovementPct <= 0
        || (improvementPct !== null && improvementPct >= options.minImprovementPct);
      const absoluteRegression = options.minAbsoluteDelta > 0
        && Math.abs(absoluteDelta) >= options.minAbsoluteDelta;
      const percentRegression = improvementPct !== null
        && improvementPct <= -Math.abs(options.maxRegressionPct);
      const regressed = absoluteDelta < 0 && (percentRegression || absoluteRegression);
      if (absolutePass && percentPass) {
        scriptAssessment = "supports";
        reasons.push(`primary metric improved by ${absoluteDelta} (${improvementPct?.toFixed(2) ?? "n/a"}%)`);
      } else if (regressed) {
        scriptAssessment = "contradicts";
        reasons.push(`primary metric regressed by ${Math.abs(improvementPct ?? 0).toFixed(2)}%`);
      } else {
        reasons.push("measured delta did not cross the predeclared win or loss threshold");
      }
    }
  }

  return {
    schema_version: 1,
    comparison_goal: goal,
    metric: options.metric,
    direction: options.direction,
    aggregate: options.aggregate,
    paired_blocks: pairs.length,
    paired_block_range: pairs.length === 0
      ? null
      : { from: pairs[0].block, to: pairs[pairs.length - 1].block },
    warmup_blocks_excluded: Math.min(uncensored.length, Math.max(0, options.warmupBlocks)),
    a_value: aValue,
    b_value: bValue,
    absolute_delta: absoluteDelta,
    improvement_pct: improvementPct,
    output_mismatches: outputMismatches,
    output_mismatch_blocks: outputMismatchBlocks,
    ring_set_mismatch_blocks: ringSetMismatchBlocks,
    budget_censored_blocks: budgetCensored,
    catchup_censored_blocks: catchupCensored,
    full_warm_censored_blocks: fullWarmCensored,
    require_output_match: options.requireOutputMatch,
    script_assessment: scriptAssessment,
    reasons,
  };
}

export type AbExperiment = {
  schema_version: 1 | 2 | 3;
  experiment_id: string;
  problem_id: string;
  branch: string;
  base_commit: string;
  challenger_commit: string;
  change_class: ChangeClass;
  hypothesis: string;
  input_mode: "shared" | "challenger";
  lane_mode?: "blockscan-only" | "dual";
  infrastructure_shakedown?: boolean;
  expected_runtime_view_delta?: boolean;
  allowed_config_delta: string[];
  a: {
    commit: string;
    config_hash: string;
    universe_hash: string;
    discovery_to_block?: number;
    blockscan_view_hash?: string;
    blockscan_graph_hash?: string;
  };
  b: {
    commit: string;
    config_hash: string;
    universe_hash: string;
    discovery_to_block?: number;
    blockscan_view_hash?: string;
    blockscan_graph_hash?: string;
  };
  window: { min_paired_blocks: number; warmup_blocks: number };
  fairness: {
    same_block_window: boolean;
    paired_blocks: number;
    champion_restart_delta: number;
    champion_pid_changed: boolean;
    challenger_restarts: number;
    a_universe_hash_after: string;
    b_universe_hash_after: string;
    a_blockscan_view_hash_after?: string;
    b_blockscan_view_hash_after?: string;
    a_blockscan_graph_hash_after?: string;
    b_blockscan_graph_hash_after?: string;
  };
  deterministic_gate: { result: "pass" | "fail" | "not_applicable"; evidence: string };
  production_evidence?: {
    searcher_behavior_change: boolean;
    strategy_kind: "block-scan" | "backrun";
    trigger_kind: "standing-state" | "victim-swap" | "oracle-update";
    route_scope: "dex-dex" | "dex-permissionless-protocol";
    position_conserving: boolean;
    posture: {
      victim_dependent: boolean;
      keeper: boolean;
      inventory: boolean;
      private_path: boolean;
      credit: boolean;
      sandwich: boolean;
      jit_lp: boolean;
    };
    sample: {
      tx_hash: string;
      block_number: number;
      expected_net_profit_usd: number;
      evidence: string;
      victim_tx_hash?: string;
      oracle_route_edge_index?: number;
      expected_route?: Array<{
        adapterId: string;
        tokenIn: string;
        tokenOut: string;
        target?: string;
        poolId?: string;
      }>;
    };
    classification_review: { verdict: "pass" | "fail"; reviewer: string; evidence: string };
    baseline_stage: "not_admitted" | "path_found" | "final_sim_success";
    challenger_stage: "not_admitted" | "path_found" | "final_sim_success";
    replay: {
      result: "pass" | "fail";
      cwd: "listener" | "analysis";
      argv: string[];
      evidence: string;
    };
  };
  analysis: {
    agent_manual_author: string;
    agent_manual_verdict: AbVerdict;
    agent_manual_evidence: string;
    script_exit_code: number;
    script_assessment: ScriptAssessment;
    script_artifact: string;
    reconciliation: "agree" | "disagree" | "inconclusive";
    adversarial_review?: { verdict: AbVerdict; evidence: string; reviewer: string };
  };
  final_verdict: FinalVerdict;
  branch_action: "pending_merge" | "pending_delete" | "merged_deleted" | "deleted_unmerged" | "retained" | "resolved_deleted";
  b_stopped: boolean;
  evidence_bundle: string;
  merge_commit?: string;
  mergeability?: {
    current_main_commit: string;
    tested_base_is_current: boolean;
    evidence: string;
  };
  resolution?: {
    resolved_by_commit: string;
    evidence: string;
  };
};

const PRODUCTION_STAGE_ORDER = new Map([
  ["not_admitted", 0],
  ["path_found", 1],
  ["final_sim_success", 2],
]);

/** Pre-deploy veto for the current production phase. Historical schema-v2 reports remain readable, but
 * every new B deployment must use schema v3 and bind its behavior change to one real, profitable,
 * victim-independent block-scan sample in the current DEX / permissionless-protocol scope. */
export interface AbProductionCandidateContext {
  experimentId?: string;
  branch?: string;
  baseCommit?: string;
  expectedRuntimeViewDelta?: boolean;
  inputMode?: "shared" | "challenger";
  allowedConfigDelta?: string[];
  laneMode?: "blockscan-only" | "dual";
  shakedown?: boolean;
}

export function validateAbProductionCandidate(
  experiment: AbExperiment,
  context: AbProductionCandidateContext = {},
): string[] {
  const errors: string[] = [];
  if (!experiment || typeof experiment !== "object") return ["ab_experiment must be a JSON object"];
  if (experiment.schema_version !== 3) {
    errors.push("candidate deployment requires schema_version=3 production evidence");
    return errors;
  }
  if (context.experimentId !== undefined && experiment.experiment_id !== context.experimentId) {
    errors.push("candidate report experiment_id does not match the deployment request");
  }
  if (context.branch !== undefined && experiment.branch !== context.branch) {
    errors.push("candidate report branch does not match the deployment request");
  }
  if (context.baseCommit !== undefined && experiment.base_commit !== context.baseCommit) {
    errors.push("candidate report base_commit does not match the deployed champion");
  }
  if (context.expectedRuntimeViewDelta !== undefined
      && experiment.expected_runtime_view_delta !== context.expectedRuntimeViewDelta) {
    errors.push("candidate report expected_runtime_view_delta does not match the deployment request");
  }
  if (context.inputMode !== undefined && experiment.input_mode !== context.inputMode) {
    errors.push("candidate report input_mode does not match the deployment request");
  }
  if (context.allowedConfigDelta !== undefined) {
    const declared = [...(experiment.allowed_config_delta ?? [])].sort();
    const requested = [...context.allowedConfigDelta].sort();
    if (JSON.stringify(declared) !== JSON.stringify(requested)) {
      errors.push("candidate report allowed_config_delta does not match the deployment request");
    }
  }
  if (context.laneMode !== undefined && experiment.lane_mode !== context.laneMode) {
    errors.push("candidate report lane_mode does not match the deployment request");
  }
  if (context.shakedown === true) {
    if (experiment.infrastructure_shakedown !== true) {
      errors.push("infrastructure shakedown deployment requires infrastructure_shakedown=true");
    }
    if (experiment.deterministic_gate?.result !== "not_applicable") {
      errors.push("infrastructure shakedown deterministic_gate must be not_applicable");
    }
    if (experiment.production_evidence !== undefined) {
      errors.push("infrastructure shakedown must not claim production_evidence");
    }
    if (experiment.input_mode !== "shared") {
      errors.push("infrastructure shakedown requires input_mode=shared");
    }
    if ((experiment.allowed_config_delta ?? []).length !== 0) {
      errors.push("infrastructure shakedown requires allowed_config_delta=[]");
    }
    if (experiment.expected_runtime_view_delta !== false) {
      errors.push("infrastructure shakedown requires expected_runtime_view_delta=false");
    }
    return errors;
  }
  if (experiment.infrastructure_shakedown === true) {
    errors.push("production challenger cannot declare infrastructure_shakedown=true");
  }
  if (experiment.deterministic_gate?.result !== "pass") {
    errors.push("candidate deployment requires deterministic_gate.result=pass");
  }

  const evidence = experiment.production_evidence;
  if (!evidence || typeof evidence !== "object") {
    errors.push("production_evidence is required before deploying B");
    return errors;
  }
  if (evidence.searcher_behavior_change !== true) {
    errors.push("production_evidence.searcher_behavior_change must be true; tooling/docs/analysis-only work cannot deploy as B");
  }
  if (evidence.strategy_kind !== "block-scan" && evidence.strategy_kind !== "backrun") {
    errors.push("production candidate strategy_kind must be block-scan|backrun");
  }
  if (evidence.strategy_kind === "block-scan" && evidence.trigger_kind !== "standing-state") {
    errors.push("block-scan candidate trigger_kind must be standing-state");
  }
  if (evidence.strategy_kind === "backrun"
      && evidence.trigger_kind !== "victim-swap"
      && evidence.trigger_kind !== "oracle-update") {
    errors.push("backrun candidate trigger_kind must be victim-swap|oracle-update");
  }
  if (evidence.strategy_kind === "backrun" && (context.laneMode ?? experiment.lane_mode) !== "dual") {
    errors.push("backrun candidate requires lane_mode=dual");
  }
  if (evidence.strategy_kind === "backrun" && evidence.challenger_stage !== "final_sim_success") {
    errors.push("backrun challenger must reach final_sim_success on the pinned victim counterfactual");
  }
  if (evidence.route_scope !== "dex-dex" && evidence.route_scope !== "dex-permissionless-protocol") {
    errors.push("production_evidence.route_scope must be dex-dex|dex-permissionless-protocol");
  }
  if (evidence.position_conserving !== true) {
    errors.push("production candidate must be position-conserving inside the transaction");
  }

  const posture = evidence.posture;
  const expectedVictimDependent = evidence.strategy_kind === "backrun";
  if (!posture || posture.victim_dependent !== expectedVictimDependent) {
    errors.push(`production_evidence.posture.victim_dependent must be ${expectedVictimDependent}`);
  }
  for (const key of ["keeper", "inventory", "private_path", "credit", "sandwich", "jit_lp"] as const) {
    if (!posture || posture[key] !== false) errors.push(`production_evidence.posture.${key} must be false`);
  }

  const sample = evidence.sample;
  if (!sample || typeof sample !== "object") {
    errors.push("production_evidence.sample is required");
  } else {
    if (!/^0x[a-f0-9]{64}$/i.test(sample.tx_hash ?? "")) {
      errors.push("production_evidence.sample.tx_hash must be a full on-chain transaction hash");
    }
    if (!Number.isSafeInteger(sample.block_number) || sample.block_number <= 0) {
      errors.push("production_evidence.sample.block_number must be a positive safe integer");
    }
    if (!Number.isFinite(sample.expected_net_profit_usd) || sample.expected_net_profit_usd <= 0) {
      errors.push("production_evidence.sample.expected_net_profit_usd must be > 0");
    }
    if (!nonEmpty(sample.evidence)) {
      errors.push("production_evidence.sample.evidence missing/placeholder");
    }
    if (evidence.strategy_kind === "backrun") {
      if (!/^0x[a-f0-9]{64}$/i.test(sample.victim_tx_hash ?? "")) {
        errors.push("backrun production sample requires a full victim_tx_hash");
      }
      if (!Array.isArray(sample.expected_route) || sample.expected_route.length < 2 || sample.expected_route.length > 8) {
        errors.push("backrun production sample requires expected_route with 2..8 edges");
      } else {
        for (const [index, edge] of sample.expected_route.entries()) {
          if (!nonEmpty(edge?.adapterId) || !nonEmpty(edge?.tokenIn) || !nonEmpty(edge?.tokenOut)) {
            errors.push(`backrun expected_route[${index}] requires adapterId/tokenIn/tokenOut`);
          }
        }
      }
      if (evidence.trigger_kind === "oracle-update"
          && (!Number.isSafeInteger(sample.oracle_route_edge_index)
            || sample.oracle_route_edge_index! < 0
            || sample.oracle_route_edge_index! >= (sample.expected_route?.length ?? 0))) {
        errors.push("oracle-update sample requires oracle_route_edge_index within expected_route");
      }
    }
  }

  const before = PRODUCTION_STAGE_ORDER.get(evidence.baseline_stage);
  const after = PRODUCTION_STAGE_ORDER.get(evidence.challenger_stage);
  if (before === undefined) errors.push("production_evidence.baseline_stage invalid");
  if (after === undefined) errors.push("production_evidence.challenger_stage invalid");
  if (before !== undefined && after !== undefined && after <= before) {
    errors.push("the same +EV sample must advance at least one production stage before B deployment");
  }
  if (!evidence.replay || evidence.replay.result !== "pass") {
    errors.push("production_evidence.replay.result must be pass");
  } else {
    const expectedReplay = evidence.strategy_kind === "backrun"
      ? ["node", "--import", "tsx", "src/searcher/test/backrun-hunt.ts"]
      : ["node", "--import", "tsx", "src/searcher/test/blockscan-hunt.ts"];
    if (evidence.replay.cwd !== "listener"
        || JSON.stringify(evidence.replay.argv) !== JSON.stringify(expectedReplay)) {
      errors.push(`production_evidence.replay must use the trusted direct-node ${evidence.strategy_kind} harness`);
    }
    if (!nonEmpty(evidence.replay.evidence)) errors.push("production_evidence.replay.evidence missing/placeholder");
  }
  if (!evidence.classification_review || evidence.classification_review.verdict !== "pass") {
    errors.push("production_evidence.classification_review.verdict must be pass from a fresh non-author reviewer");
  } else {
    if (!nonEmpty(evidence.classification_review.reviewer)) {
      errors.push("production_evidence.classification_review.reviewer missing/placeholder");
    }
    if (!nonEmpty(evidence.classification_review.evidence)) {
      errors.push("production_evidence.classification_review.evidence missing/placeholder");
    }
    if (String(evidence.classification_review.reviewer).trim().toLowerCase()
        === String(experiment.analysis?.agent_manual_author ?? "").trim().toLowerCase()) {
      errors.push("production classification reviewer must differ from agent_manual_author");
    }
  }
  return errors;
}

export function parseAbExperiment(md: string): AbExperiment {
  const match = md.match(/```ab_experiment\s*\n([\s\S]*?)\n```/);
  if (!match) throw new Error("missing ```ab_experiment JSON block");
  try {
    return JSON.parse(match[1]) as AbExperiment;
  } catch (error) {
    throw new Error(`invalid ab_experiment JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && !/[<>]/.test(value);
}

function sha(value: unknown, length: 40 | 64): boolean {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "i").test(value);
}

function scriptAlignsWithManual(manual: AbVerdict, script: ScriptAssessment): boolean {
  return (manual === "win" && script === "supports") || (manual === "lose" && script === "contradicts");
}

function expectedReconciliation(manual: AbVerdict, script: ScriptAssessment): AbExperiment["analysis"]["reconciliation"] {
  if (manual === "inconclusive" || script === "inconclusive") return "inconclusive";
  return scriptAlignsWithManual(manual, script) ? "agree" : "disagree";
}

function resolvedVerdict(experiment: AbExperiment): AbVerdict {
  const manual = experiment.analysis.agent_manual_verdict;
  const script = experiment.analysis.script_assessment;
  const review = experiment.analysis.adversarial_review;
  const mandatoryReview = experiment.change_class === "capability" && manual === "win";
  if (!mandatoryReview && manual !== "inconclusive" && scriptAlignsWithManual(manual, script)) return manual;
  return review?.verdict ?? "inconclusive";
}

export function validateAbExperiment(
  experiment: AbExperiment,
  reportPath: string,
  phase: "decision" | "close",
): string[] {
  const errors: string[] = [];
  if (!experiment || typeof experiment !== "object") return ["ab_experiment must be a JSON object"];
  if (!experiment.analysis || typeof experiment.analysis !== "object") return ["analysis object missing"];
  if (!experiment.a || !experiment.b || !experiment.window || !experiment.fairness || !experiment.deterministic_gate) {
    return ["a/b/window/fairness/deterministic_gate objects are all required"];
  }
  const requiredText: [string, unknown][] = [
    ["experiment_id", experiment.experiment_id],
    ["problem_id", experiment.problem_id],
    ["hypothesis", experiment.hypothesis],
    ["agent_manual_author", experiment.analysis?.agent_manual_author],
    ["agent_manual_evidence", experiment.analysis?.agent_manual_evidence],
    ["deterministic_gate.evidence", experiment.deterministic_gate?.evidence],
    ["evidence_bundle", experiment.evidence_bundle],
  ];
  for (const [name, value] of requiredText) if (!nonEmpty(value)) errors.push(`${name} missing/placeholder`);
  if (experiment.schema_version !== 1 && experiment.schema_version !== 2 && experiment.schema_version !== 3) {
    errors.push("schema_version must be 1|2|3");
  }
  if (experiment.schema_version === 1 && experiment.final_verdict !== "needs_escalation") {
    errors.push("schema_version>=2 is required for every decisive A/B verdict");
  }
  if (!(<string[]>["performance", "correctness", "capability"]).includes(experiment.change_class)) {
    errors.push("change_class must be performance|correctness|capability");
  }
  if (!(<string[]>["shared", "challenger"]).includes(experiment.input_mode)) {
    errors.push("input_mode must be shared|challenger");
  }
  if (experiment.schema_version === 3
      && experiment.lane_mode !== "blockscan-only"
      && experiment.lane_mode !== "dual") {
    errors.push("schema_version=3 lane_mode must be blockscan-only|dual");
  }
  if (!(<string[]>["win", "lose", "inconclusive"]).includes(experiment.analysis?.agent_manual_verdict)) {
    errors.push("agent_manual_verdict must be win|lose|inconclusive");
  }
  if (!(<string[]>["supports", "contradicts", "inconclusive"]).includes(experiment.analysis?.script_assessment)) {
    errors.push("script_assessment must be supports|contradicts|inconclusive");
  }
  if (!(<string[]>["agree", "disagree", "inconclusive"]).includes(experiment.analysis?.reconciliation)) {
    errors.push("reconciliation must be agree|disagree|inconclusive");
  }
  if (!(<string[]>["win", "lose", "needs_escalation"]).includes(experiment.final_verdict)) {
    errors.push("final_verdict must be win|lose|needs_escalation");
  }
  if (!(<string[]>["pass", "fail", "not_applicable"]).includes(experiment.deterministic_gate?.result)) {
    errors.push("deterministic_gate.result must be pass|fail|not_applicable");
  }
  if (!/^ab\/[a-z0-9][a-z0-9._/-]*$/i.test(experiment.branch ?? "")) errors.push("branch must match ab/*");
  for (const [name, value] of [
    ["base_commit", experiment.base_commit],
    ["challenger_commit", experiment.challenger_commit],
    ["a.commit", experiment.a?.commit],
    ["b.commit", experiment.b?.commit],
  ] as [string, unknown][]) if (!sha(value, 40)) errors.push(`${name} must be a full 40-char commit SHA`);
  for (const [name, value] of [
    ["a.config_hash", experiment.a?.config_hash],
    ["a.universe_hash", experiment.a?.universe_hash],
    ["b.config_hash", experiment.b?.config_hash],
    ["b.universe_hash", experiment.b?.universe_hash],
  ] as [string, unknown][]) if (!sha(value, 64)) errors.push(`${name} must be a sha256 hex digest`);
  if (experiment.a?.commit !== experiment.base_commit) errors.push("A commit must equal base_commit");
  if (experiment.b?.commit !== experiment.challenger_commit) errors.push("B commit must equal challenger_commit");
  if (!experiment.b_stopped) errors.push("B must be stopped before decision/close");

  if (!Number.isInteger(experiment.window?.min_paired_blocks) || experiment.window.min_paired_blocks < 1) {
    errors.push("window.min_paired_blocks must be a positive integer");
  }
  if (!Number.isInteger(experiment.window?.warmup_blocks) || experiment.window.warmup_blocks < 0) {
    errors.push("window.warmup_blocks must be a non-negative integer");
  }
  if (!Number.isInteger(experiment.analysis?.script_exit_code)) {
    errors.push("analysis.script_exit_code must be an integer captured from the canonical comparison command");
  }

  const manual = experiment.analysis?.agent_manual_verdict;
  const script = experiment.analysis?.script_assessment;
  const expectedReconcile = expectedReconciliation(manual, script);
  if (experiment.analysis?.reconciliation !== expectedReconcile) {
    errors.push(`analysis.reconciliation must be ${expectedReconcile} for manual=${manual} script=${script}`);
  }
  if (experiment.analysis?.script_exit_code !== 0) {
    if (script !== "inconclusive") errors.push("a failed comparison command must report script_assessment=inconclusive");
    if (experiment.final_verdict !== "needs_escalation") errors.push("a failed comparison command requires needs_escalation");
  }
  const needsAdversarialReview = !scriptAlignsWithManual(manual, script)
    || manual === "inconclusive"
    || (experiment.change_class === "capability" && experiment.final_verdict === "win");
  if (needsAdversarialReview && !experiment.analysis?.adversarial_review) {
    errors.push("manual/script conflict, inconclusive evidence, or capability win requires a fresh non-author adversarial review");
  }
  const review = experiment.analysis?.adversarial_review;
  if (review) {
    if (!(<string[]>["win", "lose", "inconclusive"]).includes(review.verdict)) {
      errors.push("adversarial_review.verdict must be win|lose|inconclusive");
    }
    if (!nonEmpty(review.evidence) || !nonEmpty(review.reviewer)) {
      errors.push("adversarial_review requires non-placeholder evidence and reviewer");
    }
    if (String(review.reviewer ?? "").trim().toLowerCase()
        === String(experiment.analysis.agent_manual_author ?? "").trim().toLowerCase()) {
      errors.push("adversarial reviewer must be different from agent_manual_author");
    }
  }
  const fairness = experiment.fairness;
  const runtimeFairnessErrors: string[] = [];
  if (experiment.schema_version >= 2) {
    if (typeof experiment.expected_runtime_view_delta !== "boolean") {
      runtimeFairnessErrors.push("expected_runtime_view_delta must be predeclared for schema_version>=2");
    }
    for (const [name, value] of [
      ["a.discovery_to_block", experiment.a?.discovery_to_block],
      ["b.discovery_to_block", experiment.b?.discovery_to_block],
    ] as [string, unknown][]) {
      if (!Number.isSafeInteger(value) || Number(value) < 0) {
        runtimeFairnessErrors.push(`${name} must be a non-negative safe integer`);
      }
    }
    if (experiment.a?.discovery_to_block !== experiment.b?.discovery_to_block) {
      runtimeFairnessErrors.push("A/B discovery_to_block must match");
    }
    for (const [name, value] of [
      ["a.blockscan_view_hash", experiment.a?.blockscan_view_hash],
      ["b.blockscan_view_hash", experiment.b?.blockscan_view_hash],
      ["a.blockscan_graph_hash", experiment.a?.blockscan_graph_hash],
      ["b.blockscan_graph_hash", experiment.b?.blockscan_graph_hash],
      ["fairness.a_blockscan_view_hash_after", fairness?.a_blockscan_view_hash_after],
      ["fairness.b_blockscan_view_hash_after", fairness?.b_blockscan_view_hash_after],
      ["fairness.a_blockscan_graph_hash_after", fairness?.a_blockscan_graph_hash_after],
      ["fairness.b_blockscan_graph_hash_after", fairness?.b_blockscan_graph_hash_after],
    ] as [string, unknown][]) {
      if (!sha(value, 64)) runtimeFairnessErrors.push(`${name} must be a 64-char runtime hash`);
    }
    if (fairness?.a_blockscan_view_hash_after !== experiment.a?.blockscan_view_hash
        || fairness?.b_blockscan_view_hash_after !== experiment.b?.blockscan_view_hash
        || fairness?.a_blockscan_graph_hash_after !== experiment.a?.blockscan_graph_hash
        || fairness?.b_blockscan_graph_hash_after !== experiment.b?.blockscan_graph_hash) {
      runtimeFairnessErrors.push("runtime view/graph hashes must stay stable throughout the measured window");
    }
    if (experiment.expected_runtime_view_delta === false
        && (experiment.a?.blockscan_view_hash !== experiment.b?.blockscan_view_hash
          || experiment.a?.blockscan_graph_hash !== experiment.b?.blockscan_graph_hash)) {
      runtimeFairnessErrors.push("A/B runtime view and graph hashes must match unless a delta was predeclared");
    }
    if (experiment.expected_runtime_view_delta === true && experiment.change_class === "performance") {
      runtimeFairnessErrors.push("performance experiments cannot predeclare a runtime view delta");
    }
    if (experiment.expected_runtime_view_delta === true && experiment.final_verdict === "win"
        && experiment.deterministic_gate?.result !== "pass") {
      runtimeFairnessErrors.push("a winning runtime-view delta requires deterministic_gate.result=pass");
    }
  }
  errors.push(...runtimeFairnessErrors);
  const resolved = resolvedVerdict(experiment);
  const fairnessHardVeto = fairness?.same_block_window !== true
    || fairness?.champion_pid_changed === true
    || fairness?.champion_restart_delta !== 0
    || fairness?.challenger_restarts !== 0
    || fairness?.paired_blocks < experiment.window.min_paired_blocks
    || !sha(fairness?.a_universe_hash_after, 64)
    || !sha(fairness?.b_universe_hash_after, 64)
    || fairness?.a_universe_hash_after !== experiment.a?.universe_hash
    || fairness?.b_universe_hash_after !== experiment.b?.universe_hash
    || runtimeFairnessErrors.length > 0;
  const hardVeto = experiment.deterministic_gate?.result === "fail"
    || experiment.analysis?.script_exit_code !== 0
    || fairnessHardVeto
    || experiment.mergeability?.tested_base_is_current === false;
  if (experiment.mergeability !== undefined) {
    if (!sha(experiment.mergeability.current_main_commit, 40)) {
      errors.push("mergeability.current_main_commit must be a full 40-char commit SHA");
    }
    if (typeof experiment.mergeability.tested_base_is_current !== "boolean") {
      errors.push("mergeability.tested_base_is_current must be boolean");
    } else if (experiment.mergeability.tested_base_is_current
        !== (experiment.mergeability.current_main_commit === experiment.base_commit)) {
      errors.push("mergeability.tested_base_is_current disagrees with current_main_commit vs base_commit");
    }
    if (!nonEmpty(experiment.mergeability.evidence)) {
      errors.push("mergeability.evidence missing/placeholder");
    }
  }
  if (experiment.schema_version >= 2 && experiment.final_verdict === "win"
      && experiment.mergeability === undefined) {
    errors.push("schema_version>=2 final win requires mergeability evidence for current origin/main vs tested base");
  }
  if (experiment.schema_version === 3 && experiment.final_verdict === "win") {
    errors.push(...validateAbProductionCandidate(
      experiment,
      experiment.infrastructure_shakedown === true ? { shakedown: true } : {},
    ));
  }
  const resolvedArchive = phase === "close" && experiment.branch_action === "resolved_deleted";
  if (experiment.final_verdict === "win" && resolved !== "win") errors.push("final win is not supported by reconciled/adjudicated evidence");
  if (experiment.final_verdict === "win" && experiment.mergeability?.tested_base_is_current === false) {
    errors.push("final win requires current origin/main to equal the tested base; retain and retest instead");
  }
  if (experiment.final_verdict === "lose" && resolved !== "lose") errors.push("final lose is not supported by reconciled/adjudicated evidence");
  if (experiment.final_verdict === "needs_escalation" && resolved !== "inconclusive" && !hardVeto && !resolvedArchive) {
    errors.push("needs_escalation requires an inconclusive reconciled/adjudicated verdict");
  }

  if (experiment.change_class !== "performance" && experiment.deterministic_gate?.result !== "pass"
      && experiment.final_verdict === "win") {
    errors.push("correctness/capability win requires deterministic_gate.result=pass");
  }
  if (experiment.deterministic_gate?.result === "fail" && experiment.final_verdict === "win") {
    errors.push("a failing deterministic gate can never merge");
  }
  if (experiment.input_mode === "shared" && experiment.a?.universe_hash !== experiment.b?.universe_hash) {
    errors.push("shared input_mode requires identical universe hashes");
  }
  if (experiment.a?.config_hash !== experiment.b?.config_hash) {
    errors.push("normalized A/B config hashes must match; exclude only declared allowed_config_delta keys before hashing");
  }

  if (!fairness || typeof fairness.same_block_window !== "boolean") {
    errors.push("fairness.same_block_window must be recorded");
  }
  if (typeof fairness?.champion_pid_changed !== "boolean") {
    errors.push("fairness.champion_pid_changed must be recorded");
  }
  for (const [name, value] of [
    ["fairness.paired_blocks", fairness?.paired_blocks],
    ["fairness.champion_restart_delta", fairness?.champion_restart_delta],
    ["fairness.challenger_restarts", fairness?.challenger_restarts],
  ] as [string, unknown][]) {
    if (!Number.isInteger(value) || Number(value) < 0) errors.push(`${name} must be a non-negative integer`);
  }
  if (experiment.final_verdict !== "needs_escalation") {
    for (const [name, value] of [
      ["fairness.a_universe_hash_after", fairness?.a_universe_hash_after],
      ["fairness.b_universe_hash_after", fairness?.b_universe_hash_after],
    ] as [string, unknown][]) if (!sha(value, 64)) errors.push(`${name} must be a sha256 hex digest`);
    if (!fairness?.same_block_window) errors.push("decisive verdict requires a same-block A/B window");
    if (fairness?.champion_pid_changed) errors.push("decisive verdict requires champion PID stability");
    if (fairness?.champion_restart_delta !== 0 || fairness?.challenger_restarts !== 0) {
      errors.push("decisive verdict requires zero A/B restarts during the measured window");
    }
    if (fairness?.a_universe_hash_after !== experiment.a?.universe_hash
        || fairness?.b_universe_hash_after !== experiment.b?.universe_hash) {
      errors.push("decisive verdict requires stable A/B universe inputs throughout the window");
    }
  }
  if (!Array.isArray(experiment.allowed_config_delta)
      || experiment.allowed_config_delta.some((key) => !/^SEARCHER_[A-Z0-9_]+$/.test(key))) {
    errors.push("allowed_config_delta must be an array of SEARCHER_* keys");
  }

  const artifactPath = experiment.analysis?.script_artifact;
  if (experiment.analysis?.script_exit_code === 0 && nonEmpty(artifactPath)) {
    const resolvedPath = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.resolve(path.dirname(reportPath), artifactPath);
    if (!fs.existsSync(resolvedPath)) {
      errors.push(`script_artifact not found: ${artifactPath}`);
    } else {
      try {
        const artifact = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as AbCompareResult;
        if (artifact.script_assessment !== experiment.analysis.script_assessment) {
          errors.push("script_assessment disagrees with script_artifact");
        }
        if (fairness?.paired_blocks !== artifact.paired_blocks) {
          errors.push("fairness.paired_blocks disagrees with script_artifact");
        }
        if (experiment.final_verdict !== "needs_escalation"
            && artifact.paired_blocks < experiment.window.min_paired_blocks) {
          errors.push(`paired blocks ${artifact.paired_blocks} < required ${experiment.window.min_paired_blocks}`);
        }
        if (experiment.change_class === "performance" && experiment.final_verdict === "win"
            && (!artifact.require_output_match || artifact.output_mismatches !== 0)) {
          errors.push("performance win requires output-match guard with zero mismatches");
        }
      } catch (error) {
        errors.push(`invalid script_artifact: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (experiment.analysis?.script_exit_code === 0) {
    errors.push("successful comparison command requires script_artifact");
  }

  const expectedAction = phase === "decision"
    ? { win: "pending_merge", lose: "pending_delete", needs_escalation: "retained" }
    : { win: "merged_deleted", lose: "deleted_unmerged", needs_escalation: "retained|resolved_deleted" };
  const actionAllowed = experiment.final_verdict === "needs_escalation" && phase === "close"
    ? experiment.branch_action === "retained" || experiment.branch_action === "resolved_deleted"
    : experiment.branch_action === expectedAction[experiment.final_verdict];
  if (!actionAllowed) {
    errors.push(`branch_action must be ${expectedAction[experiment.final_verdict]} for ${experiment.final_verdict} in ${phase} phase`);
  }
  if (experiment.branch_action === "resolved_deleted") {
    if (phase !== "close" || experiment.final_verdict !== "needs_escalation") {
      errors.push("resolved_deleted is only valid when closing a previously escalated experiment");
    }
    if (!sha(experiment.resolution?.resolved_by_commit, 40)) {
      errors.push("resolved_deleted requires resolution.resolved_by_commit");
    }
    if (!nonEmpty(experiment.resolution?.evidence)) {
      errors.push("resolved_deleted requires non-placeholder resolution.evidence");
    }
  } else if (experiment.resolution !== undefined) {
    errors.push("resolution is only valid with branch_action=resolved_deleted");
  }
  if (phase === "close" && experiment.final_verdict === "win" && !sha(experiment.merge_commit, 40)) {
    errors.push("closed win requires merge_commit");
  }
  return errors;
}

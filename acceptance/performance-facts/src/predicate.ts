import {
  decodePartitionedPerformanceFactBundle,
  createPerformanceAcceptanceReceipt,
  hashCandidateBearingHeadSetRoot,
  hashCandidatePathTimingSampleRoot,
  hashFullHeadTimingSampleRoot,
  hashHeadTerminalReceipt,
  hashMetricRecomputationRoot,
  hashPerformanceGenerationSegmentRoot,
  derivePerformanceGenerationSegments,
  hashOrphanReplacementLineageRoot,
  hashOrderedEligibleHeadRecordsRoot,
  hashOrderedCandidateTerminalReceiptRoot,
  hashOrderedHeadTerminalReceiptRoot,
  hashPerformanceWindowCommitment,
  hashPerformanceSemanticReceiptSetRoot,
  hashPerformanceWindowReceipt,
  hashProcessLogAnchor,
  hashCpuMemoryEventLoopRoot,
  hashQueueTelemetryRoot,
  hashResourceSampleRoot,
  hashTimingSampleRoot,
  hashWorkerRestartRoot,
  isHealthyPerformanceOutcome,
  type CandidateSetV1,
  type CandidateTerminalReceiptV1,
  type EligibleHeadRecordV1,
  type HeadOrphanReplacementLineageV1,
  type HeadTerminalReceiptV1,
  type PerformanceAcceptanceReceiptV1,
  type PerformanceMetricSampleV1,
  type PerformanceGenerationSegmentV1,
  type PerformanceWindowCommitmentV1,
  type PerformanceWindowReceiptV1,
  type ProductionPerformanceProfileV1,
} from "./schema.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  PERFORMANCE_PREDICATE_SPEC,
  PERFORMANCE_PREDICATE_SPEC_DIGEST,
} from "./spec.ts";
import {
  unwrapPerformanceFacts,
  type PerformancePredicateInputV1,
  type PerformanceRuntimeFactsV1,
} from "./schema.ts";

export type PerformancePredicateVerdict = "pass" | "fail" | "invalid";

export type PerformanceReasonCode =
  | "malformed-fact"
  | "qualified-observation-missing"
  | "qualified-observation-mismatch"
  | "profile-mismatch"
  | "window-commitment-mismatch"
  | "window-start-invalid"
  | "target-count-invalid"
  | "empty-denominator"
  | "ordinal-duplicate"
  | "ordinal-gap"
  | "canonical-chain-mismatch"
  | "head-anchor-mismatch"
  | "generation-segment-mismatch"
  | "lineage-mismatch"
  | "terminal-duplicate"
  | "terminal-missing"
  | "terminal-anchor-mismatch"
  | "terminal-outcome-unhealthy"
  | "candidate-set-mismatch"
  | "candidate-terminal-mismatch"
  | "candidate-sample-missing"
  | "candidate-sample-count-mismatch"
  | "timing-count-mismatch"
  | "metric-mismatch"
  | "root-mismatch"
  | "excluded-head"
  | "queue-telemetry-invalid"
  | "permit-conservation-invalid"
  | "worker-restart-invalid"
  | "required-six-step-missing"
  | "required-six-step-cardinality"
  | "budget-exceeded"
  | "percentile-invalid"
  | "caller-verdict-ignored";

export interface PerformanceReasonV1 {
  readonly code: PerformanceReasonCode;
  readonly path: string;
}

export interface PerformancePercentileValuesV1 {
  readonly headCompletionP50Us: string;
  readonly headCompletionP95Us: string;
  readonly headCompletionP99Us: string;
  readonly candidatePathP50Us: string | null;
  readonly candidatePathP95Us: string | null;
  readonly candidatePathP99Us: string | null;
  readonly sourceCoarseP95Us: string;
  readonly sourceCoarseP99Us: string;
  readonly coarseP95Us: string;
  readonly coarseP99Us: string;
  readonly plannerExactProgramP95Us: string | null;
  readonly plannerExactProgramP99Us: string | null;
  readonly finalSimulationQueueP95Us: string | null;
  readonly finalSimulationQueueP99Us: string | null;
  readonly finalSimulationServiceP95Us: string | null;
  readonly finalSimulationServiceP99Us: string | null;
  readonly finalSimulationQueueServiceP99Us: string | null;
  readonly cpuP95BasisPoints: string;
  readonly cpuP99BasisPoints: string;
  readonly eventLoopP95Us: string;
  readonly eventLoopP99Us: string;
}

export interface PerformancePredicateResultV1 {
  readonly verdict: PerformancePredicateVerdict;
  readonly reasons: readonly PerformanceReasonV1[];
  readonly percentiles: PerformancePercentileValuesV1 | null;
  readonly acceptanceReceipt: PerformanceAcceptanceReceiptV1 | null;
}

function add(reasons: PerformanceReasonV1[], code: PerformanceReasonCode, path: string): void {
  if (!reasons.some((reason) => reason.code === code && reason.path === path)) reasons.push(Object.freeze({ code, path }));
}

function bigint(value: string): bigint {
  return BigInt(value);
}

function same(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function processAnchorHash(commitment: PerformanceWindowCommitmentV1): Hash {
  return hashProcessLogAnchor(commitment.processLogAnchor);
}

function orderedByOrdinal<T extends { readonly ordinal: string }>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => Number(bigint(left.ordinal) - bigint(right.ordinal)));
}

function rank(values: readonly string[], quantile: string): string {
  if (values.length === 0) throw new TypeError("cannot rank an empty sample");
  const [whole, fraction = ""] = quantile.split(".");
  const numerator = BigInt(`${whole}${fraction}`);
  const denominator = 10n ** BigInt(fraction.length);
  const rankIndex = (BigInt(values.length) * numerator + denominator - 1n) / denominator;
  if (rankIndex < 1n || rankIndex > BigInt(values.length)) throw new TypeError("percentile rank is outside sample");
  const sorted = [...values].sort((left, right) => (bigint(left) < bigint(right) ? -1 : bigint(left) > bigint(right) ? 1 : 0));
  return sorted[Number(rankIndex - 1n)]!;
}

export function nearestRankPercentile(values: readonly string[], quantile: "0.50" | "0.95" | "0.99"): string {
  return rank(values, quantile);
}

function maxValue(values: readonly string[]): string {
  return values.reduce((max, value) => bigint(value) > bigint(max) ? value : max, "0");
}

function decodeBundle(raw: unknown, reasons: PerformanceReasonV1[]): {
  readonly profile: ProductionPerformanceProfileV1;
  readonly commitment: PerformanceWindowCommitmentV1;
  readonly heads: readonly EligibleHeadRecordV1[];
  readonly lineages: readonly HeadOrphanReplacementLineageV1[];
  readonly candidateSets: readonly CandidateSetV1[];
  readonly candidateTerminals: readonly CandidateTerminalReceiptV1[];
  readonly metrics: readonly PerformanceMetricSampleV1[];
  readonly terminals: readonly HeadTerminalReceiptV1[];
  readonly generationSegments: readonly PerformanceGenerationSegmentV1[];
  readonly windowReceipt: PerformanceWindowReceiptV1;
} | null {
  try {
    return decodePartitionedPerformanceFactBundle(raw as object);
  } catch {
    add(reasons, "malformed-fact", "$.facts");
    return null;
  }
}

function checkQualifiedEnvelope(input: PerformanceRuntimeFactsV1, reasons: PerformanceReasonV1[]): void {
  if (input.refs.length === 0 || input.claims.length === 0 || input.observations.length === 0) {
    add(reasons, "qualified-observation-missing", "$.observations");
    return;
  }
  const ids = input.observations.flatMap((observation) => [...observation.rawFactIds, ...observation.qualifiedClaimIds]);
  if (ids.length === 0 || new Set(ids).size !== ids.length) add(reasons, "qualified-observation-mismatch", "$.observations");
}

function checkWindowAndAnchors(
  profile: ProductionPerformanceProfileV1,
  commitment: PerformanceWindowCommitmentV1,
  heads: readonly EligibleHeadRecordV1[],
  lineages: readonly HeadOrphanReplacementLineageV1[],
  terminals: readonly HeadTerminalReceiptV1[],
  windowReceipt: PerformanceWindowReceiptV1,
  reasons: PerformanceReasonV1[],
): void {
  if (profile.profileHash !== commitment.performanceProfileHash) add(reasons, "profile-mismatch", "$.commitment.performanceProfileHash");
  if (commitment.targetCount !== "100" || profile.targetCount !== "100") add(reasons, "target-count-invalid", "$.targetCount");
  if (bigint(commitment.committedMonotonicNs) < 0n) add(reasons, "window-start-invalid", "$.commitment.committedMonotonicNs");
  if (windowReceipt.windowCommitmentHash !== hashPerformanceWindowCommitment(commitment)) add(reasons, "window-commitment-mismatch", "$.windowReceipt.windowCommitmentHash");
  if (windowReceipt.excludedHeads.length !== 0) add(reasons, "excluded-head", "$.windowReceipt.excludedHeads");
  if (windowReceipt.headCount !== "100") add(reasons, "target-count-invalid", "$.windowReceipt.headCount");
  if (heads.length === 0) add(reasons, "empty-denominator", "$.heads");
  if (heads.length !== 100) add(reasons, "timing-count-mismatch", "$.heads");
  const sortedHeads = orderedByOrdinal(heads);
  const seenOrdinals = new Set<string>();
  for (const [index, head] of sortedHeads.entries()) {
    const expectedOrdinal = (index + 1).toString();
    if (head.ordinal !== expectedOrdinal) add(reasons, seenOrdinals.has(head.ordinal) ? "ordinal-duplicate" : "ordinal-gap", `$.heads[${index}].ordinal`);
    seenOrdinals.add(head.ordinal);
    if (head.windowId !== commitment.windowId || head.processLogAnchorHash !== processAnchorHash(commitment) || head.providerRoot !== commitment.providerRoot || head.hardwareProfileRoot !== commitment.hardwareProfileRoot) add(reasons, "head-anchor-mismatch", `$.heads[${index}]`);
    if (index > 0) {
      const previous = sortedHeads[index - 1]!;
      if (bigint(head.canonicalHead.number) !== bigint(previous.canonicalHead.number) + 1n || head.canonicalHead.parentHash !== previous.canonicalHead.hash || head.canonicalHead.chainId !== previous.canonicalHead.chainId) add(reasons, "canonical-chain-mismatch", `$.heads[${index}].canonicalHead`);
    }
  }
  const lineageOrdinals = new Set<string>();
  const activeIds = new Set(sortedHeads.map((head) => head.headRecordId));
  const headById = new Map(sortedHeads.map((head) => [head.headRecordId, head]));
  for (const [index, lineage] of lineages.entries()) {
    const replacement = headById.get(lineage.replacementHeadRecordId);
    if (lineage.windowId !== commitment.windowId || lineage.replacementHeadRecordId === lineage.orphanHeadRecordId || activeIds.has(lineage.orphanHeadRecordId) || replacement === undefined || replacement.ordinal !== lineage.ordinal || lineageOrdinals.has(lineage.ordinal)) add(reasons, "lineage-mismatch", `$.lineages[${index}]`);
    lineageOrdinals.add(lineage.ordinal);
  }
  if (terminals.length !== 100) add(reasons, "terminal-missing", "$.terminals");
  const terminalOrdinals = new Set<string>();
  for (const [index, terminal] of orderedByOrdinal(terminals).entries()) {
    const expected = (index + 1).toString();
    if (terminal.ordinal !== expected || terminalOrdinals.has(terminal.ordinal)) add(reasons, terminalOrdinals.has(terminal.ordinal) ? "terminal-duplicate" : "terminal-missing", `$.terminals[${index}].ordinal`);
    terminalOrdinals.add(terminal.ordinal);
    const head = sortedHeads.find((candidate) => candidate.ordinal === terminal.ordinal);
    if (terminal.windowId !== commitment.windowId || terminal.processLogAnchorHash !== processAnchorHash(commitment) || terminal.performanceProfileHash !== commitment.performanceProfileHash || terminal.providerRoot !== commitment.providerRoot || terminal.hardwareProfileRoot !== commitment.hardwareProfileRoot || head === undefined || terminal.canonicalHead.hash !== head.canonicalHead.hash || terminal.canonicalHead.parentHash !== head.canonicalHead.parentHash || terminal.generationId !== head.generationId || terminal.graphRoot !== head.graphRoot || terminal.readyRecordHash !== head.readyRecordHash || terminal.generationSourceCoverageRoot !== head.generationSourceCoverageRoot || terminal.sourceCoverageRoot !== head.sourceCoverageRoot || head !== undefined && terminal.acceptedMonotonicNs !== head.acceptedMonotonicNs) add(reasons, "terminal-anchor-mismatch", `$.terminals[${index}]`);
  }
  const firstHead = sortedHeads[0];
  if (firstHead !== undefined && bigint(commitment.committedMonotonicNs) >= bigint(firstHead.acceptedMonotonicNs)) add(reasons, "window-start-invalid", "$.commitment.committedMonotonicNs");
  const lastTerminal = orderedByOrdinal(terminals).reduce((latest, terminal) => latest === null || bigint(terminal.terminalMonotonicNs) > bigint(latest.terminalMonotonicNs) ? terminal : latest, null as HeadTerminalReceiptV1 | null);
  if (lastTerminal !== null && (windowReceipt.windowEndMonotonicNs !== lastTerminal.terminalMonotonicNs || windowReceipt.windowStartMonotonicNs !== commitment.committedMonotonicNs)) add(reasons, "window-start-invalid", "$.windowReceipt.windowEndMonotonicNs");
  if (windowReceipt.orderedEligibleHeadRecordRoot !== hashOrderedEligibleHeadRecordsRoot(sortedHeads)) add(reasons, "root-mismatch", "$.windowReceipt.orderedEligibleHeadRecordRoot");
  if (windowReceipt.orderedHeadTerminalReceiptRoot !== hashOrderedHeadTerminalReceiptRoot(orderedByOrdinal(terminals))) add(reasons, "root-mismatch", "$.windowReceipt.orderedHeadTerminalReceiptRoot");
  if (windowReceipt.orphanReplacementLineageRoot !== hashOrphanReplacementLineageRoot(lineages)) add(reasons, "root-mismatch", "$.windowReceipt.orphanReplacementLineageRoot");
}

function checkCandidatesAndMetrics(
  profile: ProductionPerformanceProfileV1,
  commitment: PerformanceWindowCommitmentV1,
  heads: readonly EligibleHeadRecordV1[],
  lineages: readonly HeadOrphanReplacementLineageV1[],
  candidateSets: readonly CandidateSetV1[],
  candidateTerminals: readonly CandidateTerminalReceiptV1[],
  metrics: readonly PerformanceMetricSampleV1[],
  terminals: readonly HeadTerminalReceiptV1[],
  generationSegments: readonly PerformanceGenerationSegmentV1[],
  windowReceipt: PerformanceWindowReceiptV1,
  reasons: PerformanceReasonV1[],
): PerformancePercentileValuesV1 | null {
  const headByOrdinal = new Map(heads.map((head) => [head.ordinal, head]));
  const setByOrdinal = new Map<string, CandidateSetV1>();
  for (const [index, set] of candidateSets.entries()) {
    if (setByOrdinal.has(set.ordinal) || set.windowId !== commitment.windowId) add(reasons, "candidate-set-mismatch", `$.candidateSets[${index}]`);
    setByOrdinal.set(set.ordinal, set);
    const head = headByOrdinal.get(set.ordinal);
    if (head === undefined || head.candidateSetRoot !== set.candidateSetRoot || head.candidateCount !== set.candidateIds.length.toString()) add(reasons, "candidate-set-mismatch", `$.candidateSets[${index}]`);
  }
  if (setByOrdinal.size !== 100) add(reasons, "candidate-set-mismatch", "$.candidateSets");
  const candidateTerminalsByOrdinal = new Map<string, CandidateTerminalReceiptV1[]>();
  const seenCandidateReceipts = new Set<Hash>();
  for (const [index, candidate] of candidateTerminals.entries()) {
    if (seenCandidateReceipts.has(candidate.receiptId)) add(reasons, "candidate-terminal-mismatch", `$.candidateTerminals[${index}]`);
    seenCandidateReceipts.add(candidate.receiptId);
    const list = candidateTerminalsByOrdinal.get(candidate.ordinal) ?? [];
    list.push(candidate);
    candidateTerminalsByOrdinal.set(candidate.ordinal, list);
    const set = setByOrdinal.get(candidate.ordinal);
    if (set === undefined || !set.candidateIds.includes(candidate.candidateId)) add(reasons, "candidate-terminal-mismatch", `$.candidateTerminals[${index}]`);
  }
  const metricByOrdinal = new Map<string, PerformanceMetricSampleV1>();
  const terminalByOrdinal = new Map<string, HeadTerminalReceiptV1>();
  for (const terminal of terminals) terminalByOrdinal.set(terminal.ordinal, terminal);
  for (const [index, metric] of metrics.entries()) {
    if (metricByOrdinal.has(metric.ordinal) || metric.windowId !== commitment.windowId) add(reasons, "metric-mismatch", `$.metrics[${index}]`);
    metricByOrdinal.set(metric.ordinal, metric);
    const head = headByOrdinal.get(metric.ordinal);
    const terminal = terminalByOrdinal.get(metric.ordinal);
    if (head === undefined || terminal === undefined || metric.metricSampleId !== terminal.metricSampleId || metric.processLogAnchorHash !== head.processLogAnchorHash || metric.generationId !== head.generationId || metric.graphRoot !== head.graphRoot || metric.readyRecordHash !== head.readyRecordHash || metric.generationSourceCoverageRoot !== head.generationSourceCoverageRoot || metric.sourceCoverageRoot !== head.sourceCoverageRoot || metric.providerRoot !== commitment.providerRoot || metric.hardwareProfileRoot !== commitment.hardwareProfileRoot) add(reasons, "metric-mismatch", `$.metrics[${index}]`);
    const candidates = setByOrdinal.get(metric.ordinal)?.candidateIds ?? [];
    const candidateList = candidateTerminalsByOrdinal.get(metric.ordinal) ?? [];
    const candidateIds = new Set(candidates);
    const candidateTerminalIds = new Set(candidateList.map((candidate) => candidate.candidateId));
    if (head !== undefined && head.candidateBearing !== (candidateIds.size > 0)) add(reasons, "candidate-set-mismatch", `$.heads[${metric.ordinal}].candidateBearing`);
    for (const candidate of candidateList) {
      if (
        candidate.windowId !== commitment.windowId
        || candidate.ordinal !== metric.ordinal
        || head === undefined
        || candidate.headRecordId !== head.headRecordId
        || (candidate.sixStepCompleted && (candidate.outcome !== "verified" || candidate.sixStepMode !== "dry-run" || candidate.sixStepEvidenceRoot === null || candidate.sixStepCompletionRoot === null))
        || (!candidate.sixStepCompleted && (candidate.sixStepMode !== null || candidate.sixStepEvidenceRoot !== null || candidate.sixStepCompletionRoot !== null))
      ) add(reasons, "candidate-terminal-mismatch", `$.candidateTerminals[${metric.ordinal}]`);
    }
    if (terminal !== undefined && terminal.healthy) {
      const exactCandidateTerminals = candidateTerminalIds.size === candidateIds.size && candidateList.length === candidates.length && [...candidateIds].every((candidateId) => candidateTerminalIds.has(candidateId));
      if (terminal.outcome === "complete-no-candidate" && (candidateIds.size !== 0 || candidateList.length !== 0)) add(reasons, "candidate-terminal-mismatch", `$.terminals[${metric.ordinal}].outcome`);
      if (terminal.outcome === "complete-candidates-terminal" && (candidateIds.size === 0 || !exactCandidateTerminals)) add(reasons, "candidate-terminal-mismatch", `$.terminals[${metric.ordinal}].outcome`);
    }
    if (candidates.length > 0 && metric.candidatePathDurationUs === null) add(reasons, "candidate-sample-missing", `$.metrics[${index}].candidatePathDurationUs`);
    if (candidates.length === 0 && metric.candidatePathDurationUs !== null) add(reasons, "candidate-sample-count-mismatch", `$.metrics[${index}].candidatePathDurationUs`);
    if (candidateList.some(candidate => candidate.sixStepCompleted)
      && (metric.queueTelemetry.length === 0 || metric.permitAccounting.length === 0 || metric.resourceSamples.length === 0)) {
      add(reasons, "queue-telemetry-invalid", `$.metrics[${index}]`);
    }
    if (terminal !== undefined && terminal.orderedCandidateTerminalReceiptRoot !== hashOrderedCandidateTerminalReceiptRoot(candidateList)) add(reasons, "candidate-terminal-mismatch", `$.terminals[${metric.ordinal}].orderedCandidateTerminalReceiptRoot`);
    if (terminal !== undefined && (head === undefined || metric.headStartMonotonicNs !== head.acceptedMonotonicNs || metric.headStartMonotonicNs !== terminal.acceptedMonotonicNs || metric.headTerminalMonotonicNs !== terminal.terminalMonotonicNs || metric.headDurationUs !== terminal.headDurationUs)) add(reasons, "metric-mismatch", `$.metrics[${index}].timingAnchors`);
    if (terminal !== undefined && (terminal.timingSampleRoot !== hashTimingSampleRoot(metric) || terminal.queueTelemetryRoot !== hashQueueTelemetryRoot(metric.queueTelemetry) || terminal.resourceSampleRoot !== hashResourceSampleRoot(metric.resourceSamples) || terminal.cpuMemoryEventLoopRoot !== hashCpuMemoryEventLoopRoot(metric.cpuMemoryEventLoop) || terminal.workerRestartRoot !== hashWorkerRestartRoot(metric.workerRestart) || terminal.rawReceiptSetRoot !== metric.rawReceiptSetRoot)) add(reasons, "metric-mismatch", `$.metrics[${index}].receiptRoots`);
    checkQueueCaps(profile, metric, index, reasons);
  }
  if (metricByOrdinal.size !== 100 || metrics.length !== 100) add(reasons, "timing-count-mismatch", "$.metrics");
  const orderedMetrics = orderedByOrdinal(metrics);
  const candidateBearingHeads = heads.filter((head) => head.candidateBearing);
  const candidateMetrics = orderedMetrics.filter((metric) => metric.candidatePathDurationUs !== null);
  if (candidateMetrics.length !== candidateBearingHeads.length) add(reasons, "candidate-sample-count-mismatch", "$.candidatePathTimingSampleRoot");
  if (windowReceipt.candidateBearingHeadSetRoot !== hashCandidateBearingHeadSetRoot(orderedByOrdinal(heads))) add(reasons, "root-mismatch", "$.windowReceipt.candidateBearingHeadSetRoot");
  if (windowReceipt.fullHeadTimingSampleRoot !== hashFullHeadTimingSampleRoot(orderedMetrics)) add(reasons, "root-mismatch", "$.windowReceipt.fullHeadTimingSampleRoot");
  if (windowReceipt.candidatePathTimingSampleRoot !== hashCandidatePathTimingSampleRoot(orderedMetrics)) add(reasons, "root-mismatch", "$.windowReceipt.candidatePathTimingSampleRoot");
  if (windowReceipt.metricRecomputationRoot !== hashMetricRecomputationRoot(orderedMetrics)) add(reasons, "root-mismatch", "$.windowReceipt.metricRecomputationRoot");
  if (windowReceipt.rawReceiptSetRoot !== hashPerformanceSemanticReceiptSetRoot({
    profile,
    commitment,
    heads,
    lineages,
    candidateSets,
    candidateTerminals,
    metrics,
    terminals,
    generationSegments,
  })) add(reasons, "root-mismatch", "$.windowReceipt.rawReceiptSetRoot");
  if (orderedMetrics.length === 0) return null;
  try {
    return Object.freeze({
      headCompletionP50Us: rank(orderedMetrics.map((metric) => metric.headDurationUs), "0.50"),
      headCompletionP95Us: rank(orderedMetrics.map((metric) => metric.headDurationUs), "0.95"),
      headCompletionP99Us: rank(orderedMetrics.map((metric) => metric.headDurationUs), "0.99"),
      candidatePathP50Us: candidateMetrics.length === 0 ? null : rank(candidateMetrics.map((metric) => metric.candidatePathDurationUs!), "0.50"),
      candidatePathP95Us: candidateMetrics.length === 0 ? null : rank(candidateMetrics.map((metric) => metric.candidatePathDurationUs!), "0.95"),
      candidatePathP99Us: candidateMetrics.length === 0 ? null : rank(candidateMetrics.map((metric) => metric.candidatePathDurationUs!), "0.99"),
      sourceCoarseP95Us: rank(orderedMetrics.map((metric) => metric.sourceCoarseDurationUs), "0.95"),
      sourceCoarseP99Us: rank(orderedMetrics.map((metric) => metric.sourceCoarseDurationUs), "0.99"),
      coarseP95Us: rank(orderedMetrics.map((metric) => metric.coarseDurationUs), "0.95"),
      coarseP99Us: rank(orderedMetrics.map((metric) => metric.coarseDurationUs), "0.99"),
      plannerExactProgramP95Us: candidateMetrics.length === 0 ? null : rank(candidateMetrics.map((metric) => metric.plannerExactProgramDurationUs), "0.95"),
      plannerExactProgramP99Us: candidateMetrics.length === 0 ? null : rank(candidateMetrics.map((metric) => metric.plannerExactProgramDurationUs), "0.99"),
      finalSimulationQueueP95Us: candidateMetrics.length === 0 ? null : rank(candidateMetrics.map((metric) => metric.finalSimulationQueueWaitUs), "0.95"),
      finalSimulationQueueP99Us: candidateMetrics.length === 0 ? null : rank(candidateMetrics.map((metric) => metric.finalSimulationQueueWaitUs), "0.99"),
      finalSimulationServiceP95Us: candidateMetrics.length === 0 ? null : rank(candidateMetrics.map((metric) => metric.finalSimulationServiceUs), "0.95"),
      finalSimulationServiceP99Us: candidateMetrics.length === 0 ? null : rank(candidateMetrics.map((metric) => metric.finalSimulationServiceUs), "0.99"),
      finalSimulationQueueServiceP99Us: candidateMetrics.length === 0 ? null : rank(candidateMetrics.map((metric) => (bigint(metric.finalSimulationQueueWaitUs) + bigint(metric.finalSimulationServiceUs)).toString()), "0.99"),
      cpuP95BasisPoints: rank(orderedMetrics.map((metric) => metric.cpuMemoryEventLoop.cpuUtilizationBasisPoints), "0.95"),
      cpuP99BasisPoints: rank(orderedMetrics.map((metric) => metric.cpuMemoryEventLoop.cpuUtilizationBasisPoints), "0.99"),
      eventLoopP95Us: rank(orderedMetrics.map((metric) => metric.cpuMemoryEventLoop.eventLoopLagUs), "0.95"),
      eventLoopP99Us: rank(orderedMetrics.map((metric) => metric.cpuMemoryEventLoop.eventLoopLagUs), "0.99"),
    });
  } catch {
    add(reasons, "percentile-invalid", "$.metrics");
    return null;
  }
}

function checkGenerationSegments(
  commitment: PerformanceWindowCommitmentV1,
  heads: readonly EligibleHeadRecordV1[],
  terminals: readonly HeadTerminalReceiptV1[],
  metrics: readonly PerformanceMetricSampleV1[],
  generationSegments: readonly PerformanceGenerationSegmentV1[],
  windowReceipt: PerformanceWindowReceiptV1,
  reasons: PerformanceReasonV1[],
): void {
  try {
    const expected = derivePerformanceGenerationSegments({
      windowId: commitment.windowId,
      heads: orderedByOrdinal(heads),
      terminals: orderedByOrdinal(terminals),
      metrics: orderedByOrdinal(metrics),
    });
    if (!same(generationSegments, expected)) add(reasons, "generation-segment-mismatch", "$.generationSegments");
    if (windowReceipt.generationSegmentRoot !== hashPerformanceGenerationSegmentRoot(generationSegments)) {
      add(reasons, "generation-segment-mismatch", "$.windowReceipt.generationSegmentRoot");
    }
  } catch {
    add(reasons, "generation-segment-mismatch", "$.generationSegments");
  }
}

function checkQueueCaps(profile: ProductionPerformanceProfileV1, metric: PerformanceMetricSampleV1, index: number, reasons: PerformanceReasonV1[]): void {
  const queueProfile = profile.queueProfile;
  const queueCap = (resource: PerformanceMetricSampleV1["queueTelemetry"][number]["resource"]): bigint | null => {
    if (resource === "revm-heavy") return bigint(queueProfile.revmWaitingQueue);
    if (resource === "final-sim") return bigint(queueProfile.finalSimulationQueue);
    return null;
  };
  for (const [queueIndex, entry] of metric.queueTelemetry.entries()) {
    const cap = queueCap(entry.resource);
    if (cap !== null && (bigint(entry.current) > cap || bigint(entry.max) > cap)) add(reasons, "queue-telemetry-invalid", `$.metrics[${index}].queueTelemetry[${queueIndex}]`);
  }

  const activeByOwnerAndResource = new Map<string, bigint>();
  let logicalActive = 0n;
  for (const [permitIndex, entry] of metric.permitAccounting.entries()) {
    const active = bigint(entry.active);
    logicalActive += active;
    const cap = entry.resource === "rpc"
      ? bigint(queueProfile.perFamilyRpcActive)
      : entry.resource === "revm-heavy"
        ? bigint(queueProfile.revmHeavyWorkers)
        : bigint(queueProfile.finalSimulationWorkers);
    const key = `${entry.ownerRef}\u0000${entry.resource}`;
    const ownerActive = (activeByOwnerAndResource.get(key) ?? 0n) + active;
    activeByOwnerAndResource.set(key, ownerActive);
    if (ownerActive > cap) add(reasons, "queue-telemetry-invalid", `$.metrics[${index}].permitAccounting[${permitIndex}]`);
  }
  if (logicalActive > bigint(queueProfile.attestationLogicalWorkers)) add(reasons, "queue-telemetry-invalid", `$.metrics[${index}].permitAccounting`);

  for (const [sampleIndex, sample] of metric.resourceSamples.entries()) {
    const cap = sample.resource === "revm-heavy"
      ? bigint(queueProfile.revmHeavyWorkers)
      : sample.resource === "final-sim"
        ? bigint(queueProfile.finalSimulationWorkers)
        : null;
    if (cap !== null && (bigint(sample.current) > cap || bigint(sample.capacity) > cap || bigint(sample.max) > cap)) add(reasons, "queue-telemetry-invalid", `$.metrics[${index}].resourceSamples[${sampleIndex}]`);
  }
  if (bigint(metric.workerRestart.workerCount) > bigint(queueProfile.revmHeavyWorkers)) add(reasons, "worker-restart-invalid", `$.metrics[${index}].workerRestart.workerCount`);
}

function checkBudgets(
  profile: ProductionPerformanceProfileV1,
  values: PerformancePercentileValuesV1 | null,
  terminals: readonly HeadTerminalReceiptV1[],
  metrics: readonly PerformanceMetricSampleV1[],
  candidateHeads: number,
  reasons: PerformanceReasonV1[],
): void {
  if (values === null) return;
  const budget = profile.budgets;
  const checks: [string, string, string][] = [
    ["headCompletionP95Us", values.headCompletionP95Us, budget.headCompletionP95Us],
    ["headCompletionP99Us", values.headCompletionP99Us, budget.headCompletionP99Us],
    ["sourceCoarseP95Us", values.sourceCoarseP95Us, budget.sourceCoarseP95Us],
    ["sourceCoarseP99Us", values.sourceCoarseP99Us, budget.sourceCoarseP99Us],
    ["coarseP95Us", values.coarseP95Us, budget.coarseP95Us],
    ["coarseP99Us", values.coarseP99Us, budget.coarseP99Us],
    ["cpuP95BasisPoints", values.cpuP95BasisPoints, budget.cpuP95BasisPoints],
    ["cpuP99BasisPoints", values.cpuP99BasisPoints, budget.cpuP99BasisPoints],
    ["eventLoopP95Us", values.eventLoopP95Us, budget.eventLoopP95Us],
    ["eventLoopP99Us", values.eventLoopP99Us, budget.eventLoopP99Us],
  ];
  if (candidateHeads > 0 && values.plannerExactProgramP95Us !== null && values.plannerExactProgramP99Us !== null) {
    checks.push(["plannerExactProgramP95Us", values.plannerExactProgramP95Us, budget.plannerExactProgramP95Us]);
    checks.push(["plannerExactProgramP99Us", values.plannerExactProgramP99Us, budget.plannerExactProgramP99Us]);
    checks.push(["finalSimulationQueueP95Us", values.finalSimulationQueueP95Us!, budget.finalSimulationQueueP95Us]);
    checks.push(["finalSimulationQueueP99Us", values.finalSimulationQueueP99Us!, budget.finalSimulationQueueP99Us]);
    checks.push(["finalSimulationServiceP95Us", values.finalSimulationServiceP95Us!, budget.finalSimulationServiceP95Us]);
    checks.push(["finalSimulationServiceP99Us", values.finalSimulationServiceP99Us!, budget.finalSimulationServiceP99Us]);
    checks.push(["finalSimulationQueueServiceP99Us", values.finalSimulationQueueServiceP99Us!, budget.finalSimulationQueueServiceP99Us]);
  }
  for (const [name, actual, limit] of checks) if (bigint(actual) > bigint(limit)) add(reasons, "budget-exceeded", `$.percentiles.${name}`);
  for (const terminal of terminals) if (bigint(terminal.headDurationUs) > bigint(budget.headHardDeadlineUs)) add(reasons, "budget-exceeded", `$.terminals.${terminal.ordinal}.headDurationUs`);
  for (const metric of metrics) {
    if (metric.candidatePathDurationUs !== null && bigint(metric.finalSimulationQueueWaitUs) + bigint(metric.finalSimulationServiceUs) > bigint(budget.finalSimulationHardDeadlineUs)) {
      add(reasons, "budget-exceeded", `$.metrics.${metric.ordinal}.finalSimulationHardDeadlineUs`);
    }
  }
}

function acceptanceReceipt(
  profile: ProductionPerformanceProfileV1,
  commitment: PerformanceWindowCommitmentV1,
  windowReceipt: PerformanceWindowReceiptV1,
  terminals: readonly HeadTerminalReceiptV1[],
  verdict: "pass" | "fail" | "invalid",
): PerformanceAcceptanceReceiptV1 {
  return createPerformanceAcceptanceReceipt({
    predicateSpecDigest: PERFORMANCE_PREDICATE_SPEC_DIGEST,
    windowCommitmentHash: hashPerformanceWindowCommitment(commitment),
    windowReceiptHash: hashPerformanceWindowReceipt(windowReceipt),
    orderedHeadTerminalReceiptRoot: windowReceipt.orderedHeadTerminalReceiptRoot,
    headCount: "100",
    healthyHeadCount: terminals.filter((terminal) => terminal.healthy).length.toString(),
    candidateBearingHeadSetRoot: windowReceipt.candidateBearingHeadSetRoot,
    fullHeadTimingSampleRoot: windowReceipt.fullHeadTimingSampleRoot,
    candidatePathTimingSampleRoot: windowReceipt.candidatePathTimingSampleRoot,
    metricRecomputationRoot: windowReceipt.metricRecomputationRoot,
    generationSegmentRoot: windowReceipt.generationSegmentRoot,
    rawReceiptSetRoot: windowReceipt.rawReceiptSetRoot,
    verdict,
  });
}

/** Pure evaluator. It never consumes a producer-supplied verdict. */
export function evaluatePerformancePredicate(input: PerformancePredicateInputV1): PerformancePredicateResultV1 {
  const reasons: PerformanceReasonV1[] = [];
  const unwrapped = unwrapPerformanceFacts(input);
  if (unwrapped === null) {
    add(reasons, "malformed-fact", "$.facts");
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze(reasons), percentiles: null, acceptanceReceipt: null });
  }
  if (unwrapped.envelope) checkQualifiedEnvelope(input as PerformanceRuntimeFactsV1, reasons);
  const decoded = decodeBundle(unwrapped.bundle, reasons);
  if (decoded === null) return Object.freeze({ verdict: "invalid", reasons: Object.freeze(reasons), percentiles: null, acceptanceReceipt: null });
  checkWindowAndAnchors(decoded.profile, decoded.commitment, decoded.heads, decoded.lineages, decoded.terminals, decoded.windowReceipt, reasons);
  const candidateHeads = decoded.heads.filter((head) => head.candidateBearing).length;
  const percentiles = checkCandidatesAndMetrics(decoded.profile, decoded.commitment, decoded.heads, decoded.lineages, decoded.candidateSets, decoded.candidateTerminals, decoded.metrics, decoded.terminals, decoded.generationSegments, decoded.windowReceipt, reasons);
  checkGenerationSegments(decoded.commitment, decoded.heads, decoded.terminals, decoded.metrics, decoded.generationSegments, decoded.windowReceipt, reasons);
  checkBudgets(decoded.profile, percentiles, decoded.terminals, decoded.metrics, candidateHeads, reasons);
  if (decoded.windowReceipt.healthyHeadCount !== decoded.terminals.filter((terminal) => terminal.healthy).length.toString()) add(reasons, "root-mismatch", "$.windowReceipt.healthyHeadCount");
  if (decoded.terminals.some((terminal) => !terminal.healthy)) for (const terminal of decoded.terminals) if (!terminal.healthy) add(reasons, "terminal-outcome-unhealthy", `$.terminals.${terminal.ordinal}.outcome`);
  const sixStepCandidateCount = decoded.candidateTerminals.filter((candidate) => candidate.sixStepCompleted).length;
  if (decoded.profile.requireSixStepDryRunCandidate && sixStepCandidateCount === 0) add(reasons, "required-six-step-missing", "$.candidateTerminals");
  if (decoded.profile.requireSixStepDryRunCandidate && sixStepCandidateCount > 1) add(reasons, "required-six-step-cardinality", "$.candidateTerminals");
  const verdict: PerformancePredicateVerdict = reasons.some((reason) => reason.code === "malformed-fact" || reason.code === "qualified-observation-missing" || reason.code === "qualified-observation-mismatch" || reason.code === "root-mismatch" || reason.code === "ordinal-duplicate" || reason.code === "ordinal-gap" || reason.code === "terminal-missing" || reason.code === "terminal-duplicate" || reason.code === "candidate-sample-missing" || reason.code === "candidate-sample-count-mismatch" || reason.code === "timing-count-mismatch" || reason.code === "excluded-head" || reason.code === "lineage-mismatch" || reason.code === "head-anchor-mismatch" || reason.code === "generation-segment-mismatch" || reason.code === "terminal-anchor-mismatch" || reason.code === "metric-mismatch" || reason.code === "candidate-set-mismatch" || reason.code === "candidate-terminal-mismatch" || reason.code === "window-commitment-mismatch" || reason.code === "canonical-chain-mismatch" || reason.code === "required-six-step-cardinality") ? "invalid" : reasons.length > 0 ? "fail" : "pass";
  const receipt = verdict === "invalid" ? null : acceptanceReceipt(decoded.profile, decoded.commitment, decoded.windowReceipt, decoded.terminals, verdict);
  return Object.freeze({ verdict, reasons: Object.freeze(reasons), percentiles, acceptanceReceipt: receipt });
}

export { PERFORMANCE_PREDICATE_SPEC };

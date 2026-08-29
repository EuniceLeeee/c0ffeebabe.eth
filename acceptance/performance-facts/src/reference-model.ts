import {
  decodeCandidateSet,
  decodeCandidateTerminalReceipt,
  decodeEligibleHeadRecord,
  decodeHeadOrphanReplacementLineage,
  decodeHeadTerminalReceipt,
  decodePerformanceMetricSample,
  decodePerformanceWindowCommitment,
  decodePerformanceWindowReceipt,
  decodeProductionPerformanceProfile,
  decodePerformanceFactBundle,
  hashCandidateBearingHeadSetRoot,
  hashCandidatePathTimingSampleRoot,
  hashFullHeadTimingSampleRoot,
  hashMetricRecomputationRoot,
  hashPerformanceGenerationSegmentRoot,
  hashEligibleHeadRecord,
  hashHeadTerminalReceipt,
  hashPerformanceMetricSample,
  hashOrphanReplacementLineageRoot,
  hashOrderedEligibleHeadRecordsRoot,
  hashOrderedCandidateTerminalReceiptRoot,
  hashOrderedHeadTerminalReceiptRoot,
  hashPerformanceWindowCommitment,
  hashProcessLogAnchor,
  hashCpuMemoryEventLoopRoot,
  hashQueueTelemetryRoot,
  hashResourceSampleRoot,
  hashTimingSampleRoot,
  hashWorkerRestartRoot,
  hashRawReceiptSetRoot,
  isHealthyPerformanceOutcome,
  type CandidateSetV1,
  type CandidateTerminalReceiptV1,
  type EligibleHeadRecordV1,
  type HeadOrphanReplacementLineageV1,
  type HeadTerminalReceiptV1,
  type PerformanceMetricSampleV1,
  type PerformanceGenerationSegmentV1,
  type PerformancePredicateInputV1,
  type PerformanceWindowCommitmentV1,
  type PerformanceWindowReceiptV1,
  type ProductionPerformanceProfileV1,
} from "./schema.ts";
import { encodeCanonicalJson, hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { isPerformanceFactBundle, unwrapPerformanceFacts } from "./schema.ts";

export type PerformanceReferenceVerdict = "pass" | "fail" | "invalid";

export interface PerformanceReferenceResultV1 {
  readonly verdict: PerformanceReferenceVerdict;
  readonly reasons: readonly string[];
  readonly percentiles: Readonly<Record<string, string | null>> | null;
}

function add(reasons: string[], value: string): void {
  if (!reasons.includes(value)) reasons.push(value);
}

function bi(value: string): bigint {
  return BigInt(value);
}

function ordered<T extends { readonly ordinal: string }>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => Number(bi(left.ordinal) - bi(right.ordinal)));
}

function rank(values: readonly string[], q: bigint, denominator = 100n): string | null {
  if (values.length === 0) return null;
  const rankValue = (BigInt(values.length) * q + denominator - 1n) / denominator;
  const sorted = [...values].sort((left, right) => bi(left) < bi(right) ? -1 : bi(left) > bi(right) ? 1 : 0);
  return sorted[Number(rankValue - 1n)] ?? null;
}

function anchorHash(commitment: PerformanceWindowCommitmentV1): string {
  return hashProcessLogAnchor(commitment.processLogAnchor);
}

interface DecodedReferenceFactsV1 {
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
}

function decodeFacts(value: unknown): DecodedReferenceFactsV1 | null {
  try {
    const bundle = decodePerformanceFactBundle(value as object);
    return Object.freeze(bundle);
  } catch {
    return null;
  }
}

/**
 * Qualification-only independent oracle.  It deliberately does not import
 * the runtime predicate or collector; all joins and nearest-rank arithmetic
 * are replayed from decoded facts.
 */
export function evaluatePerformanceReferenceModel(input: PerformancePredicateInputV1): PerformanceReferenceResultV1 {
  const reasons: string[] = [];
  const unwrapped = unwrapPerformanceFacts(input);
  if (unwrapped === null) return { verdict: "invalid", reasons: ["facts-envelope-missing"], percentiles: null };
  if (unwrapped.envelope) {
    const envelope = input as import("./schema.ts").PerformanceRuntimeFactsV1;
    if (envelope.refs.length === 0 || envelope.claims.length === 0 || envelope.observations.length === 0) add(reasons, "qualified-observation-missing");
    if (envelope.observations.some((observation) => observation.rawFactIds.length === 0 || observation.qualifiedClaimIds.length === 0)) add(reasons, "qualified-observation-mismatch");
  }
  const facts = decodeFacts(unwrapped.bundle);
  if (facts === null) return { verdict: "invalid", reasons: [...reasons, "fact-decode"], percentiles: null };
  const { profile, commitment, heads, lineages, candidateSets, candidateTerminals, metrics, terminals, generationSegments, windowReceipt } = facts;
  if (profile.profileHash !== commitment.performanceProfileHash) add(reasons, "profile-root");
  if (commitment.targetCount !== "100" || heads.length !== 100 || terminals.length !== 100 || metrics.length !== 100 || candidateSets.length !== 100) add(reasons, "exact-100");
  const sortedHeads = ordered(heads);
  for (const [index, head] of sortedHeads.entries()) {
    if (head.ordinal !== (index + 1).toString()) add(reasons, "head-ordinal");
    if (index > 0) {
      const previous = sortedHeads[index - 1]!;
      if (bi(head.canonicalHead.number) !== bi(previous.canonicalHead.number) + 1n || head.canonicalHead.parentHash !== previous.canonicalHead.hash) add(reasons, "canonical-chain");
    }
    if (head.processLogAnchorHash !== anchorHash(commitment) || head.windowId !== commitment.windowId || head.providerRoot !== commitment.providerRoot || head.hardwareProfileRoot !== commitment.hardwareProfileRoot) add(reasons, "head-anchor");
  }
  const activeIds = new Set(sortedHeads.map((head) => head.headRecordId));
  const lineageOrdinals = new Set<string>();
  for (const lineage of lineages) {
    if (lineage.windowId !== commitment.windowId || activeIds.has(lineage.orphanHeadRecordId) || !activeIds.has(lineage.replacementHeadRecordId) || lineageOrdinals.has(lineage.ordinal)) add(reasons, "orphan-replacement");
    lineageOrdinals.add(lineage.ordinal);
  }
  const sortedTerminals = ordered(terminals);
  const terminalByOrdinal = new Map(sortedTerminals.map((terminal) => [terminal.ordinal, terminal]));
  const setByOrdinal = new Map(candidateSets.map((set) => [set.ordinal, set]));
  const metricByOrdinal = new Map(metrics.map((metric) => [metric.ordinal, metric]));
  const candidateByOrdinal = new Map<string, CandidateTerminalReceiptV1[]>();
  for (const candidate of candidateTerminals) candidateByOrdinal.set(candidate.ordinal, [...(candidateByOrdinal.get(candidate.ordinal) ?? []), candidate]);
  for (const head of sortedHeads) {
    const terminal = terminalByOrdinal.get(head.ordinal);
    const set = setByOrdinal.get(head.ordinal);
    const metric = metricByOrdinal.get(head.ordinal);
    if (terminal === undefined || set === undefined || metric === undefined) {
      add(reasons, "missing-terminal-or-metric");
      continue;
    }
    const candidates = candidateByOrdinal.get(head.ordinal) ?? [];
    if (set.candidateSetRoot !== head.candidateSetRoot || set.candidateIds.length.toString() !== head.candidateCount) add(reasons, "candidate-set-root");
    if (terminal.orderedCandidateTerminalReceiptRoot !== hashOrderedCandidateTerminalReceiptRoot(candidates)) add(reasons, "candidate-terminal-root");
    const candidateIds = new Set(set.candidateIds);
    const terminalCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
    if (terminalCandidateIds.size !== candidates.length || candidates.some((candidate) =>
      !candidateIds.has(candidate.candidateId)
      || candidate.windowId !== commitment.windowId
      || candidate.ordinal !== head.ordinal
      || candidate.headRecordId !== head.headRecordId
      || candidate.sixStepCompleted && (candidate.outcome !== "verified" || candidate.sixStepMode !== "unsigned-dry-run" || candidate.sixStepEvidenceRoot === null || candidate.sixStepCompletionRoot === null)
      || !candidate.sixStepCompleted && (candidate.sixStepMode !== null || candidate.sixStepEvidenceRoot !== null || candidate.sixStepCompletionRoot !== null)
    )) add(reasons, "candidate-terminal-lineage");
    if (terminal.outcome === "complete-candidates-terminal" && (candidateIds.size === 0 || terminalCandidateIds.size !== candidateIds.size || [...candidateIds].some((candidateId) => !terminalCandidateIds.has(candidateId)))) add(reasons, "candidate-terminal-lineage");
    if (terminal.outcome === "complete-no-candidate" && (candidateIds.size !== 0 || candidates.length !== 0)) add(reasons, "candidate-terminal-lineage");
    if (head.candidateBearing !== (set.candidateIds.length > 0)) add(reasons, "candidate-bearing");
    if (head.candidateBearing !== (metric.candidatePathDurationUs !== null)) add(reasons, "candidate-sample-count");
    if (candidates.some((candidate) => candidate.sixStepCompleted)
      && (metric.queueTelemetry.length === 0 || metric.permitAccounting.length === 0 || metric.resourceSamples.length === 0)) add(reasons, "queue-telemetry");
    if (terminal.metricSampleId !== metric.metricSampleId || terminal.headDurationUs !== metric.headDurationUs || terminal.generationId !== head.generationId || metric.generationId !== head.generationId || terminal.graphRoot !== head.graphRoot || metric.graphRoot !== head.graphRoot || terminal.readyRecordHash !== head.readyRecordHash || metric.readyRecordHash !== head.readyRecordHash || terminal.generationSourceCoverageRoot !== head.generationSourceCoverageRoot || metric.generationSourceCoverageRoot !== head.generationSourceCoverageRoot || terminal.sourceCoverageRoot !== head.sourceCoverageRoot || metric.sourceCoverageRoot !== head.sourceCoverageRoot || terminal.timingSampleRoot !== hashTimingSampleRoot(metric) || terminal.queueTelemetryRoot !== hashQueueTelemetryRoot(metric.queueTelemetry) || terminal.resourceSampleRoot !== hashResourceSampleRoot(metric.resourceSamples) || terminal.cpuMemoryEventLoopRoot !== hashCpuMemoryEventLoopRoot(metric.cpuMemoryEventLoop) || terminal.workerRestartRoot !== hashWorkerRestartRoot(metric.workerRestart) || terminal.rawReceiptSetRoot !== metric.rawReceiptSetRoot) add(reasons, "metric-binding");
    if (!isHealthyPerformanceOutcome(terminal.outcome)) add(reasons, "unhealthy-terminal");
  }
  const expectedSegments: PerformanceGenerationSegmentV1[] = [];
  const seenGenerationIds = new Map<string, string>();
  let segmentStart = 0;
  for (let index = 0; index < sortedHeads.length; index += 1) {
    const head = sortedHeads[index]!;
    const terminal = sortedTerminals[index];
    const metric = ordered(metrics)[index];
    if (terminal === undefined || metric === undefined) break;
    const identity = JSON.stringify([head.generationId, head.graphRoot, head.readyRecordHash, head.generationSourceCoverageRoot]);
    const known = seenGenerationIds.get(head.generationId);
    if (known !== undefined && known !== identity) add(reasons, "generation-identity-splice");
    seenGenerationIds.set(head.generationId, identity);
    const next = sortedHeads[index + 1];
    const nextIdentity = next === undefined ? null : JSON.stringify([next.generationId, next.graphRoot, next.readyRecordHash, next.generationSourceCoverageRoot]);
    if (identity === nextIdentity) continue;
    if (expectedSegments.some(segment => segment.generationId === head.generationId)) add(reasons, "generation-rejoin");
    const segmentHeads = sortedHeads.slice(segmentStart, index + 1);
    const segmentTerminals = sortedTerminals.slice(segmentStart, index + 1);
    const segmentMetrics = ordered(metrics).slice(segmentStart, index + 1);
    const payload = {
      schemaVersion: 1 as const,
      kind: "aloha.performance-generation-segment" as const,
      windowId: commitment.windowId,
      segmentOrdinal: (expectedSegments.length + 1).toString(),
      firstHeadOrdinal: (segmentStart + 1).toString(),
      lastHeadOrdinal: (index + 1).toString(),
      generationId: head.generationId,
      graphRoot: head.graphRoot,
      readyRecordHash: head.readyRecordHash,
      generationSourceCoverageRoot: head.generationSourceCoverageRoot,
      orderedHeadRecordRoot: hashDomain("aloha/performance-generation-segment-head-root/v1", segmentHeads.map(hashEligibleHeadRecord)),
      orderedTerminalReceiptRoot: hashDomain("aloha/performance-generation-segment-terminal-root/v1", segmentTerminals.map(hashHeadTerminalReceipt)),
      orderedMetricSampleRoot: hashDomain("aloha/performance-generation-segment-metric-root/v1", segmentMetrics.map(hashPerformanceMetricSample)),
    };
    expectedSegments.push(Object.freeze({
      ...payload,
      segmentId: hashDomain("aloha/performance-generation-segment/v1", payload),
    }));
    segmentStart = index + 1;
  }
  if (encodeCanonicalJson(generationSegments) !== encodeCanonicalJson(expectedSegments)) add(reasons, "generation-segments");
  if (windowReceipt.generationSegmentRoot !== hashPerformanceGenerationSegmentRoot(generationSegments)) add(reasons, "generation-segment-root");
  if (windowReceipt.excludedHeads.length !== 0) add(reasons, "excluded-heads");
  if (windowReceipt.windowCommitmentHash !== hashPerformanceWindowCommitment(commitment)) add(reasons, "window-commitment");
  if (windowReceipt.orderedEligibleHeadRecordRoot !== hashOrderedEligibleHeadRecordsRoot(sortedHeads)) add(reasons, "head-root");
  if (windowReceipt.orderedHeadTerminalReceiptRoot !== hashOrderedHeadTerminalReceiptRoot(sortedTerminals)) add(reasons, "terminal-root");
  if (windowReceipt.orphanReplacementLineageRoot !== hashOrphanReplacementLineageRoot(lineages)) add(reasons, "lineage-root");
  const orderedMetrics = ordered(metrics);
  if (windowReceipt.fullHeadTimingSampleRoot !== hashFullHeadTimingSampleRoot(orderedMetrics)) add(reasons, "full-timing-root");
  if (windowReceipt.candidatePathTimingSampleRoot !== hashCandidatePathTimingSampleRoot(orderedMetrics)) add(reasons, "candidate-timing-root");
  if (windowReceipt.metricRecomputationRoot !== hashMetricRecomputationRoot(orderedMetrics)) add(reasons, "metric-root");
  const candidateMetrics = orderedMetrics.filter((metric) => metric.candidatePathDurationUs !== null);
  if (candidateMetrics.length !== sortedHeads.filter((head) => head.candidateBearing).length) add(reasons, "candidate-denominator");
  const percentiles = Object.freeze({
    headP50: rank(orderedMetrics.map((metric) => metric.headDurationUs), 50n),
    headP95: rank(orderedMetrics.map((metric) => metric.headDurationUs), 95n),
    headP99: rank(orderedMetrics.map((metric) => metric.headDurationUs), 99n),
    candidateP50: rank(candidateMetrics.map((metric) => metric.candidatePathDurationUs!), 50n),
    candidateP95: rank(candidateMetrics.map((metric) => metric.candidatePathDurationUs!), 95n),
    candidateP99: rank(candidateMetrics.map((metric) => metric.candidatePathDurationUs!), 99n),
    sourceCoarseP95: rank(orderedMetrics.map((metric) => metric.sourceCoarseDurationUs), 95n),
    sourceCoarseP99: rank(orderedMetrics.map((metric) => metric.sourceCoarseDurationUs), 99n),
    coarseP95: rank(orderedMetrics.map((metric) => metric.coarseDurationUs), 95n),
    coarseP99: rank(orderedMetrics.map((metric) => metric.coarseDurationUs), 99n),
    plannerExactP95: rank(candidateMetrics.map((metric) => metric.plannerExactProgramDurationUs), 95n),
    plannerExactP99: rank(candidateMetrics.map((metric) => metric.plannerExactProgramDurationUs), 99n),
    finalQueueP95: rank(candidateMetrics.map((metric) => metric.finalSimulationQueueWaitUs), 95n),
    finalQueueP99: rank(candidateMetrics.map((metric) => metric.finalSimulationQueueWaitUs), 99n),
    finalServiceP95: rank(candidateMetrics.map((metric) => metric.finalSimulationServiceUs), 95n),
    finalServiceP99: rank(candidateMetrics.map((metric) => metric.finalSimulationServiceUs), 99n),
    finalQueueServiceP99: rank(candidateMetrics.map((metric) => (bi(metric.finalSimulationQueueWaitUs) + bi(metric.finalSimulationServiceUs)).toString()), 99n),
    cpuP95: rank(orderedMetrics.map((metric) => metric.cpuMemoryEventLoop.cpuUtilizationBasisPoints), 95n),
    cpuP99: rank(orderedMetrics.map((metric) => metric.cpuMemoryEventLoop.cpuUtilizationBasisPoints), 99n),
    eventLoopP95: rank(orderedMetrics.map((metric) => metric.cpuMemoryEventLoop.eventLoopLagUs), 95n),
    eventLoopP99: rank(orderedMetrics.map((metric) => metric.cpuMemoryEventLoop.eventLoopLagUs), 99n),
  });
  if (percentiles.headP95 !== null && bi(percentiles.headP95) > bi(profile.budgets.headCompletionP95Us)) add(reasons, "head-p95-budget");
  if (percentiles.headP99 !== null && bi(percentiles.headP99) > bi(profile.budgets.headCompletionP99Us)) add(reasons, "head-p99-budget");
  const budgetChecks = [
    [percentiles.sourceCoarseP95, profile.budgets.sourceCoarseP95Us, "source-coarse-p95-budget"],
    [percentiles.sourceCoarseP99, profile.budgets.sourceCoarseP99Us, "source-coarse-p99-budget"],
    [percentiles.coarseP95, profile.budgets.coarseP95Us, "coarse-p95-budget"],
    [percentiles.coarseP99, profile.budgets.coarseP99Us, "coarse-p99-budget"],
    [percentiles.cpuP95, profile.budgets.cpuP95BasisPoints, "cpu-p95-budget"],
    [percentiles.cpuP99, profile.budgets.cpuP99BasisPoints, "cpu-p99-budget"],
    [percentiles.eventLoopP95, profile.budgets.eventLoopP95Us, "event-loop-p95-budget"],
    [percentiles.eventLoopP99, profile.budgets.eventLoopP99Us, "event-loop-p99-budget"],
    [percentiles.plannerExactP95, profile.budgets.plannerExactProgramP95Us, "planner-p95-budget"],
    [percentiles.plannerExactP99, profile.budgets.plannerExactProgramP99Us, "planner-p99-budget"],
    [percentiles.finalQueueP95, profile.budgets.finalSimulationQueueP95Us, "final-queue-p95-budget"],
    [percentiles.finalQueueP99, profile.budgets.finalSimulationQueueP99Us, "final-queue-p99-budget"],
    [percentiles.finalServiceP95, profile.budgets.finalSimulationServiceP95Us, "final-service-p95-budget"],
    [percentiles.finalServiceP99, profile.budgets.finalSimulationServiceP99Us, "final-service-p99-budget"],
    [percentiles.finalQueueServiceP99, profile.budgets.finalSimulationQueueServiceP99Us, "final-queue-service-p99-budget"],
  ] as const;
  for (const [actual, limit, reason] of budgetChecks) if (actual !== null && bi(actual) > bi(limit)) add(reasons, reason);
  if (terminals.some((terminal) => bi(terminal.headDurationUs) > bi(profile.budgets.headHardDeadlineUs))) add(reasons, "head-hard-deadline");
  if (candidateMetrics.some((metric) => bi(metric.finalSimulationQueueWaitUs) + bi(metric.finalSimulationServiceUs) > bi(profile.budgets.finalSimulationHardDeadlineUs))) add(reasons, "final-simulation-hard-deadline");
  const sixStepCandidateCount = candidateTerminals.filter((candidate) => candidate.sixStepCompleted).length;
  if (profile.requireSixStepDryRunCandidate && sixStepCandidateCount === 0) add(reasons, "six-step-candidate-missing");
  if (profile.requireSixStepDryRunCandidate && sixStepCandidateCount > 1) add(reasons, "six-step-candidate-cardinality");
  const structural = reasons.some((reason) => ["facts-envelope-missing", "fact-decode", "exact-100", "head-ordinal", "canonical-chain", "head-anchor", "orphan-replacement", "missing-terminal-or-metric", "candidate-set-root", "candidate-terminal-root", "candidate-terminal-lineage", "candidate-sample-count", "metric-binding", "generation-identity-splice", "generation-rejoin", "generation-segments", "generation-segment-root", "excluded-heads", "window-commitment", "head-root", "terminal-root", "lineage-root", "full-timing-root", "candidate-timing-root", "metric-root", "candidate-denominator", "six-step-candidate-cardinality"].includes(reason));
  const verdict: PerformanceReferenceVerdict = structural ? "invalid" : reasons.length > 0 ? "fail" : "pass";
  return Object.freeze({ verdict, reasons: Object.freeze(reasons), percentiles });
}

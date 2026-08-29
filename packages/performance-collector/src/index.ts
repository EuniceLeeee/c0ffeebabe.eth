export {
  PRODUCTION_EVIDENCE_NAMESPACES,
  observeProductionPerformanceDatabaseV1,
  type ObservedProductionEventV1,
  type RawAppendRowV1,
  type RawPerformanceObservationStatusV1,
  type RawPerformanceObservationV1,
} from "./raw-sqlite-observer.ts";

import {
  assertHash,
  assertExactKeys,
  encodeCanonicalBytes,
  decodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createCandidateTerminalReceipt,
  createEligibleHeadRecord,
  createHeadOrphanReplacementLineage,
  createHeadTerminalReceipt,
  createPerformanceEvent,
  derivePerformanceGenerationSegments,
  createPerformanceMetricSample,
  createPerformanceWindowReceipt,
  decodeCandidateSet,
  decodeProductionPerformanceProfile,
  decodePerformanceWindowCommitment,
  hashCandidateBearingHeadSetRoot,
  hashCandidatePathTimingSampleRoot,
  hashFullHeadTimingSampleRoot,
  hashMetricRecomputationRoot,
  hashPerformanceGenerationSegmentRoot,
  hashOrphanReplacementLineageRoot,
  hashOrderedCandidateTerminalReceiptRoot,
  hashOrderedEligibleHeadRecordsRoot,
  hashOrderedHeadTerminalReceiptRoot,
  hashPerformanceWindowCommitment,
  hashPerformanceSemanticReceiptSetRoot,
  hashProcessLogAnchor,
  hashQueueTelemetryRoot,
  hashResourceSampleRoot,
  hashCpuMemoryEventLoopRoot,
  hashWorkerRestartRoot,
  hashTimingSampleRoot,
  hashRawReceiptSetRoot,
  hashPerformanceSixStepCompletionLineage,
  isHealthyPerformanceOutcome,
  type CandidateSetV1,
  type CandidateTerminalReceiptV1,
  type EligibleHeadRecordV1,
  type HeadOrphanReplacementLineageV1,
  type HeadTerminalReceiptV1,
  type PerformanceFactBundleV1,
  type PerformanceEventV1,
  type PerformanceHeadOutcomeV1,
  type PerformanceMetricSampleV1,
  type PerformanceGenerationSegmentV1,
  type PerformanceWindowCommitmentV1,
  type PerformanceWindowReceiptV1,
  type ProductionPerformanceProfileV1,
} from "../../../specs/performance/src/index.ts";
import {
  abortPerformanceHeadTerminalEvidenceClaim,
  claimPerformanceHeadTerminalEvidence,
  commitPerformanceHeadTerminalEvidenceClaim,
  readClaimedPerformanceHeadTerminalEvidence,
  type PerformanceHeadTerminalEvidenceCapabilityV1,
} from "./internal/head-terminal-evidence.ts";

export type { PerformanceHeadTerminalEvidenceCapabilityV1 } from "./internal/head-terminal-evidence.ts";

export interface PerformanceAppendRequestV1 {
  readonly sequence: string;
  readonly eventId: Hash;
  readonly contentSha256: Hash;
  readonly bytes: Uint8Array;
}

export interface PerformanceAppendReceiptV1 {
  readonly sequence: string;
  readonly eventId: Hash;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly offsetStart: string;
  readonly offsetEnd: string;
  readonly fsynced: true;
}

/** The collector owns semantics; this capability only persists exact bytes. */
export interface PerformanceAppendPortV1 {
  appendFsyncMonotonic(request: PerformanceAppendRequestV1): Promise<PerformanceAppendReceiptV1>;
}

export type PerformanceMonotonicClockV1 = () => bigint;

function defaultMonotonicClock(): bigint {
  return process.hrtime.bigint();
}

function zeroHash(): Hash {
  return `0x${"0".repeat(64)}` as Hash;
}

function positiveHash(value: Hash, path: string): void {
  assertHash(value, path);
  if (value === zeroHash()) throw new TypeError(`zero hash is not allowed at ${path}`);
}

function decimal(value: string): bigint {
  return BigInt(value);
}

function durationUs(startNs: bigint, endNs: bigint): string {
  if (endNs < startNs || (endNs - startNs) % 1000n !== 0n) throw new TypeError("monotonic timestamps must produce integral non-negative microseconds");
  return ((endNs - startNs) / 1000n).toString();
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    const leftBytes = encodeCanonicalBytes(left);
    const rightBytes = encodeCanonicalBytes(right);
    if (leftBytes.length !== rightBytes.length) return false;
    return leftBytes.every((value, index) => value === rightBytes[index]);
  } catch {
    return false;
  }
}

function canonicalClone<T>(value: T): T {
  return decodeCanonicalBytes(encodeCanonicalBytes(value)) as T;
}

export interface PerformanceCanonicalHeadInputV1 {
  readonly canonicalHead: EligibleHeadRecordV1["canonicalHead"];
}

export interface PerformanceServingGenerationV1 {
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly generationSourceCoverageRoot: Hash;
}

const PERFORMANCE_CANONICAL_HEAD_INPUT_KEYS = Object.freeze(["canonicalHead"] as const);

/**
 * The header collector admits only the canonical anchor. Coverage and
 * candidates are produced after the head enters the lanes and are bound by
 * `bindEligibleHeadFacts` before a terminal can be sealed.
 */
export interface PerformanceEligibleHeadAnchorV1 {
  readonly admissionId: Hash;
  readonly windowId: Hash;
  readonly ordinal: string;
  readonly canonicalHead: EligibleHeadRecordV1["canonicalHead"];
  readonly acceptedMonotonicNs: string;
  readonly processLogAnchorHash: Hash;
  readonly providerRoot: Hash;
  readonly hardwareProfileRoot: Hash;
}

/** A source scan/coverage receipt supplied after the head is admitted. */
export interface PerformanceCoverageReceiptV1 {
  readonly coverageReceiptId: Hash;
  readonly windowId: Hash;
  readonly ordinal: string;
  readonly canonicalHead: EligibleHeadRecordV1["canonicalHead"];
  readonly sourceCoverageRoot: Hash;
}

export type PerformanceCoverageReceiptDraftV1 = Omit<PerformanceCoverageReceiptV1, "coverageReceiptId">;

const PERFORMANCE_COVERAGE_RECEIPT_DRAFT_KEYS = Object.freeze(["windowId", "ordinal", "canonicalHead", "sourceCoverageRoot"] as const);
const PERFORMANCE_COVERAGE_RECEIPT_KEYS = Object.freeze(["coverageReceiptId", ...PERFORMANCE_COVERAGE_RECEIPT_DRAFT_KEYS] as const);

function coverageReceiptPayload(value: PerformanceCoverageReceiptV1): PerformanceCoverageReceiptDraftV1 {
  const { coverageReceiptId: _coverageReceiptId, ...payload } = value;
  return payload;
}

export function createPerformanceCoverageReceipt(
  draft: PerformanceCoverageReceiptDraftV1,
): PerformanceCoverageReceiptV1 {
  assertExactKeys(draft, PERFORMANCE_COVERAGE_RECEIPT_DRAFT_KEYS, "performanceCoverageReceipt");
  const normalized = {
    ...draft,
    canonicalHead: canonicalClone(draft.canonicalHead),
  };
  positiveHash(normalized.windowId, "coverage.windowId");
  positiveHash(normalized.sourceCoverageRoot, "coverage.sourceCoverageRoot");
  const intermediate = { ...normalized, coverageReceiptId: zeroHash() };
  const coverageReceiptId = hashDomain("aloha/performance-coverage-receipt/v1", coverageReceiptPayload(intermediate));
  return Object.freeze({ ...normalized, coverageReceiptId });
}

function decodeCoverageReceipt(value: PerformanceCoverageReceiptV1): PerformanceCoverageReceiptV1 {
  assertExactKeys(value, PERFORMANCE_COVERAGE_RECEIPT_KEYS, "performanceCoverageReceipt");
  const normalized = canonicalClone(value);
  const expected = hashDomain("aloha/performance-coverage-receipt/v1", coverageReceiptPayload(normalized));
  positiveHash(normalized.coverageReceiptId, "coverage.coverageReceiptId");
  positiveHash(normalized.windowId, "coverage.windowId");
  positiveHash(normalized.sourceCoverageRoot, "coverage.sourceCoverageRoot");
  if (normalized.coverageReceiptId !== expected) throw new TypeError("coverage receipt identity mismatch");
  return normalized;
}

export interface PerformanceHeadFactsV1 {
  readonly coverage: PerformanceCoverageReceiptV1;
  readonly candidateSet: CandidateSetV1;
  readonly serving: PerformanceServingGenerationV1;
}

type PerformanceEligibleHeadAnchorPayloadV1 = Omit<PerformanceEligibleHeadAnchorV1, "admissionId">;

function anchorPayload(value: PerformanceEligibleHeadAnchorV1): PerformanceEligibleHeadAnchorPayloadV1 {
  const { admissionId: _admissionId, ...payload } = value;
  return payload;
}

function createEligibleHeadAnchor(payload: PerformanceEligibleHeadAnchorPayloadV1): PerformanceEligibleHeadAnchorV1 {
  const normalized = {
    ...payload,
    canonicalHead: canonicalClone(payload.canonicalHead),
  };
  const admissionId = hashDomain("aloha/performance-eligible-head-anchor/v1", normalized);
  return Object.freeze({ ...normalized, admissionId });
}

function verifyEligibleHeadAnchor(value: PerformanceEligibleHeadAnchorV1): void {
  assertExactKeys(value, [
    "admissionId", "windowId", "ordinal", "canonicalHead", "acceptedMonotonicNs",
    "processLogAnchorHash", "providerRoot", "hardwareProfileRoot",
  ], "performanceEligibleHeadAnchor");
  positiveHash(value.admissionId, "eligibleHead.admissionId");
  const expected = hashDomain("aloha/performance-eligible-head-anchor/v1", anchorPayload(value));
  if (value.admissionId !== expected) throw new TypeError("eligible head anchor identity mismatch");
}

export interface PerformanceWindowCollectorOpenInputV1 {
  readonly commitment: PerformanceWindowCommitmentV1;
  readonly profile: ProductionPerformanceProfileV1;
  readonly append: PerformanceAppendPortV1;
  readonly clock?: PerformanceMonotonicClockV1;
}

export interface PerformanceCollectorSnapshotV1 {
  readonly bundle: PerformanceFactBundleV1 | null;
  readonly commitment: PerformanceWindowCommitmentV1;
  readonly heads: readonly EligibleHeadRecordV1[];
  readonly lineages: readonly HeadOrphanReplacementLineageV1[];
  readonly candidateSets: readonly CandidateSetV1[];
  readonly candidateTerminals: readonly CandidateTerminalReceiptV1[];
  readonly metrics: readonly PerformanceMetricSampleV1[];
  readonly terminals: readonly HeadTerminalReceiptV1[];
  readonly generationSegments: readonly PerformanceGenerationSegmentV1[];
  readonly windowReceipt: PerformanceWindowReceiptV1 | null;
  readonly rawEventIds: readonly Hash[];
  readonly rawEvents: readonly PerformanceEventV1[];
}

interface OpenHeadStateV1 {
  readonly anchor: PerformanceEligibleHeadAnchorV1;
  readonly record: EligibleHeadRecordV1 | null;
  readonly candidateSet: CandidateSetV1 | null;
  readonly orphan: OpenHeadStateV1 | null;
  readonly lineage: HeadOrphanReplacementLineageV1 | null;
  readonly logStartOffset: string;
}

/**
 * Owner-side collector for the performance denominator.  No method accepts a
 * caller ordinal, window end, healthy bit, duration, or verdict.  Ordinals,
 * timestamps, health, roots, and the final receipt are derived here.
 */
export class PerformanceWindowCollectorV1 {
  readonly #commitment: PerformanceWindowCommitmentV1;
  readonly #profile: ProductionPerformanceProfileV1;
  readonly #append: PerformanceAppendPortV1;
  readonly #clock: PerformanceMonotonicClockV1;
  readonly #heads: OpenHeadStateV1[] = [];
  readonly #headByAdmissionId = new Map<Hash, OpenHeadStateV1>();
  readonly #headById = new Map<Hash, OpenHeadStateV1>();
  readonly #terminalByAdmissionId = new Map<Hash, HeadTerminalReceiptV1>();
  readonly #terminalByHeadId = new Map<Hash, HeadTerminalReceiptV1>();
  readonly #indeterminateTerminalHeadIds = new Set<Hash>();
  readonly #lineages: HeadOrphanReplacementLineageV1[] = [];
  readonly #candidateTerminals: CandidateTerminalReceiptV1[] = [];
  readonly #metrics: PerformanceMetricSampleV1[] = [];
  readonly #terminals: HeadTerminalReceiptV1[] = [];
  readonly #rawEventIds: Hash[] = [];
  readonly #rawEvents: PerformanceEventV1[] = [];
  #nextSequence = 0n;
  #tail: Promise<void> = Promise.resolve();
  #windowReceipt: PerformanceWindowReceiptV1 | null = null;

  private constructor(input: PerformanceWindowCollectorOpenInputV1) {
    this.#commitment = decodePerformanceWindowCommitment(input.commitment);
    this.#profile = decodeProductionPerformanceProfile(input.profile);
    if (this.#profile.profileHash !== this.#commitment.performanceProfileHash) throw new Error("performance profile does not match window commitment");
    this.#append = input.append;
    this.#clock = input.clock ?? defaultMonotonicClock;
  }

  static async open(input: PerformanceWindowCollectorOpenInputV1): Promise<PerformanceWindowCollectorV1> {
    const collector = new PerformanceWindowCollectorV1(input);
    await collector.#enqueue(async () => {
      await collector.#appendEvent("window-commitment", collector.#commitment);
    });
    return collector;
  }

  get commitment(): PerformanceWindowCommitmentV1 {
    return this.#commitment;
  }

  get complete(): boolean {
    return this.#windowReceipt !== null;
  }

  async acceptCanonicalHead(input: PerformanceCanonicalHeadInputV1): Promise<PerformanceEligibleHeadAnchorV1> {
    return this.#enqueue(async () => {
      if (this.#windowReceipt !== null) throw new Error("performance window is already complete");
      if (this.#heads.length >= 100) throw new Error("performance window already has 100 eligible head ordinals");
      assertExactKeys(input, PERFORMANCE_CANONICAL_HEAD_INPUT_KEYS, "performanceCanonicalHeadInput");
      const ordinal = (this.#heads.length + 1).toString();
      const acceptedMonotonicNs = this.#clock().toString();
      const anchor = createEligibleHeadAnchor({
        windowId: this.#commitment.windowId,
        ordinal,
        canonicalHead: input.canonicalHead,
        acceptedMonotonicNs,
        processLogAnchorHash: hashProcessLogAnchor(this.#commitment.processLogAnchor),
        providerRoot: this.#commitment.providerRoot,
        hardwareProfileRoot: this.#commitment.hardwareProfileRoot,
      });
      const state = Object.freeze({ anchor, record: null, candidateSet: null, orphan: null, lineage: null, logStartOffset: "0" });
      this.#heads.push(state);
      this.#headByAdmissionId.set(anchor.admissionId, state);
      return anchor;
    });
  }

  /** Bind the actual source coverage and exact candidate set after admission. */
  async bindEligibleHeadFacts(
    eligibleHead: PerformanceEligibleHeadAnchorV1,
    facts: PerformanceHeadFactsV1,
  ): Promise<EligibleHeadRecordV1> {
    return this.#enqueue(async () => {
      if (this.#windowReceipt !== null) throw new Error("performance window is already complete");
      assertExactKeys(facts, ["coverage", "candidateSet", "serving"], "performanceHeadFacts");
      verifyEligibleHeadAnchor(eligibleHead);
      const state = this.#headByAdmissionId.get(eligibleHead.admissionId);
      if (state === undefined || !sameJson(state.anchor, eligibleHead)) throw new Error("eligible head anchor does not match collector state");
      if (state.record !== null) throw new Error("eligible head facts are already bound");
      const coverage = decodeCoverageReceipt(facts.coverage);
      if (typeof facts.serving.generationId !== "string" || facts.serving.generationId.length === 0) throw new TypeError("serving generationId is required");
      positiveHash(facts.serving.graphRoot, "serving.graphRoot");
      positiveHash(facts.serving.readyRecordHash, "serving.readyRecordHash");
      positiveHash(facts.serving.generationSourceCoverageRoot, "serving.generationSourceCoverageRoot");
      if (coverage.windowId !== this.#commitment.windowId || coverage.ordinal !== state.anchor.ordinal || !sameJson(coverage.canonicalHead, state.anchor.canonicalHead)) throw new Error("coverage receipt does not bind eligible head anchor");
      const candidateSet = decodeCandidateSet(facts.candidateSet);
      if (candidateSet.windowId !== this.#commitment.windowId || candidateSet.ordinal !== state.anchor.ordinal) throw new Error("candidate set does not bind eligible head anchor");
      const head = createEligibleHeadRecord({
        windowId: state.anchor.windowId,
        ordinal: state.anchor.ordinal,
        canonicalHead: state.anchor.canonicalHead,
        acceptedMonotonicNs: state.anchor.acceptedMonotonicNs,
        processLogAnchorHash: state.anchor.processLogAnchorHash,
        generationId: facts.serving.generationId,
        graphRoot: facts.serving.graphRoot,
        readyRecordHash: facts.serving.readyRecordHash,
        providerRoot: state.anchor.providerRoot,
        hardwareProfileRoot: state.anchor.hardwareProfileRoot,
        generationSourceCoverageRoot: facts.serving.generationSourceCoverageRoot,
        sourceCoverageRoot: coverage.sourceCoverageRoot,
        candidateSetRoot: candidateSet.candidateSetRoot,
        candidateCount: candidateSet.candidateIds.length.toString(),
        candidateBearing: candidateSet.candidateIds.length > 0,
      } as EligibleHeadRecordV1);
      const headAppend = await this.#appendEvent("eligible-head", head);
      await this.#appendEvent("candidate-set", candidateSet);
      const lineage = state.orphan === null ? null : this.#lineageForReplacement(state.orphan, head);
      if (lineage !== null) {
        await this.#appendEvent("orphan-replacement", lineage);
        this.#lineages.push(lineage);
      }
      const bound = Object.freeze({ ...state, record: head, candidateSet, lineage, logStartOffset: headAppend.offsetStart });
      const index = this.#heads.indexOf(state);
      if (index >= 0) this.#heads[index] = bound;
      this.#headByAdmissionId.set(eligibleHead.admissionId, bound);
      this.#headById.set(head.headRecordId, bound);
      return head;
    });
  }

  #lineageForReplacement(orphan: OpenHeadStateV1, replacement: EligibleHeadRecordV1): HeadOrphanReplacementLineageV1 {
    if (orphan.record === null) throw new Error("orphan head facts are missing before replacement binding");
    return createHeadOrphanReplacementLineage({
      windowId: this.#commitment.windowId,
      ordinal: replacement.ordinal,
      orphanHeadRecordId: orphan.record.headRecordId,
      orphanCanonicalHead: orphan.record.canonicalHead,
      orphanObservationRoot: orphan.record.headRecordId,
      replacementHeadRecordId: replacement.headRecordId,
      replacementCanonicalHead: replacement.canonicalHead,
      replacementObservationRoot: replacement.headRecordId,
    });
  }

  /** Replace an observed orphan without accepting a caller-selected ordinal. */
  async replaceCanonicalHead(orphan: PerformanceEligibleHeadAnchorV1, input: PerformanceCanonicalHeadInputV1): Promise<PerformanceEligibleHeadAnchorV1> {
    return this.#enqueue(async () => {
      if (this.#windowReceipt !== null) throw new Error("performance window is already complete");
      verifyEligibleHeadAnchor(orphan);
      const oldState = this.#headByAdmissionId.get(orphan.admissionId);
      if (oldState === undefined || !sameJson(oldState.anchor, orphan)) throw new Error("orphan head is not owned by this window");
      if (this.#terminalByAdmissionId.has(orphan.admissionId)) throw new Error("cannot replace a terminal head");
      if (oldState.orphan !== null) throw new Error("head already has an orphan replacement");
      if (oldState.record === null || oldState.candidateSet === null) throw new Error("cannot replace an unbound head");
      assertExactKeys(input, PERFORMANCE_CANONICAL_HEAD_INPUT_KEYS, "performanceCanonicalHeadInput");
      const ordinal = oldState.anchor.ordinal;
      const acceptedMonotonicNs = this.#clock().toString();
      const replacement = createEligibleHeadAnchor({
        windowId: this.#commitment.windowId,
        ordinal,
        canonicalHead: input.canonicalHead,
        acceptedMonotonicNs,
        processLogAnchorHash: hashProcessLogAnchor(this.#commitment.processLogAnchor),
        providerRoot: this.#commitment.providerRoot,
        hardwareProfileRoot: this.#commitment.hardwareProfileRoot,
      });
      if (replacement.admissionId === orphan.admissionId) throw new Error("replacement anchor must differ from orphan anchor");
      const index = this.#heads.indexOf(oldState);
      if (index < 0) throw new Error("orphan head is not in the active ordinal set");
      const state = Object.freeze({ anchor: replacement, record: null, candidateSet: null, orphan: oldState, lineage: null, logStartOffset: "0" });
      this.#headByAdmissionId.delete(orphan.admissionId);
      this.#headByAdmissionId.set(replacement.admissionId, state);
      if (oldState.record !== null) this.#headById.delete(oldState.record.headRecordId);
      this.#heads[index] = state;
      return replacement;
    });
  }

  async sealTerminal(
    headRecordId: Hash,
    evidenceCapability: PerformanceHeadTerminalEvidenceCapabilityV1,
  ): Promise<HeadTerminalReceiptV1> {
    return this.#enqueue(async () => {
      if (this.#windowReceipt !== null) throw new Error("performance window is already complete");
      const state = this.#headById.get(headRecordId);
      if (state === undefined || state.record === null || state.record.headRecordId !== headRecordId || state.candidateSet === null) throw new Error("head facts are not bound to this window");
      if (this.#terminalByHeadId.has(headRecordId)) throw new Error("head already has a terminal receipt");
      if (this.#indeterminateTerminalHeadIds.has(headRecordId)) throw new Error("head terminal durable append is indeterminate and cannot be retried");
      const head = state.record;
      const claim = claimPerformanceHeadTerminalEvidence(evidenceCapability, {
        windowId: this.#commitment.windowId,
        headRecordId,
        candidateSetRoot: state.candidateSet.candidateSetRoot,
      });
      let durableAppendAttempted = false;
      let claimFinalized = false;
      try {
      const input = readClaimedPerformanceHeadTerminalEvidence(claim);
      const candidateIds = new Set(state.candidateSet.candidateIds);
      if (isHealthyPerformanceOutcome(input.outcome)) {
        if (input.outcome === "complete-no-candidate" && candidateIds.size !== 0) throw new Error("complete-no-candidate requires an empty candidate set");
        if (input.outcome === "complete-candidates-terminal" && (candidateIds.size === 0 || input.candidateTerminals.length !== candidateIds.size)) throw new Error("complete-candidates-terminal requires every candidate terminal");
      }
      if (candidateIds.size > 0 && input.candidatePathDurationUs === null) throw new Error("candidate-bearing heads require a candidate-path timing sample");
      const seenCandidates = new Set<Hash>();
      const candidateTerminals: CandidateTerminalReceiptV1[] = [];
      for (const candidate of input.candidateTerminals) {
        if (!candidateIds.has(candidate.candidateId) || seenCandidates.has(candidate.candidateId)) throw new Error("candidate terminal set does not exactly match candidate set");
        if (candidate.sixStepCompletion !== null && candidate.outcome !== "verified") throw new Error("six-step completion requires a verified unsigned dry-run candidate");
        seenCandidates.add(candidate.candidateId);
        candidateTerminals.push(createCandidateTerminalReceipt({
          windowId: this.#commitment.windowId,
          ordinal: head.ordinal,
          headRecordId: head.headRecordId,
          candidateId: candidate.candidateId,
          outcome: candidate.outcome,
          correlationRoot: input.correlationRoot,
          sixStepCompleted: candidate.sixStepCompletion !== null,
          sixStepMode: candidate.sixStepCompletion?.mode ?? null,
          sixStepEvidenceRoot: candidate.sixStepCompletion?.evidenceRoot ?? null,
          sixStepCompletionRoot: candidate.sixStepCompletion === null ? null : hashPerformanceSixStepCompletionLineage({
            windowId: this.#commitment.windowId,
            headRecordId: head.headRecordId,
            candidateId: candidate.candidateId,
            correlationRoot: input.correlationRoot,
            mode: candidate.sixStepCompletion.mode,
            evidenceRoot: candidate.sixStepCompletion.evidenceRoot,
          }),
          timingUs: candidate.timingUs,
          evidenceRoot: candidate.evidenceRoot,
        } as Omit<CandidateTerminalReceiptV1, "receiptId" | "schemaVersion" | "kind">));
      }
      candidateTerminals.sort((left, right) => left.receiptId.localeCompare(right.receiptId));
      if (isHealthyPerformanceOutcome(input.outcome) && seenCandidates.size !== candidateIds.size) throw new Error("healthy candidate terminal is missing a candidate");
      const terminalMonotonicNs = this.#clock();
      const headDuration = durationUs(BigInt(head.acceptedMonotonicNs), terminalMonotonicNs);
      const boundaryRoot = hashRawBoundary(head, state.candidateSet, input.outcome);
      const metric = createPerformanceMetricSample({
        windowId: this.#commitment.windowId,
        ordinal: head.ordinal,
        processLogAnchorHash: head.processLogAnchorHash,
        generationId: head.generationId,
        graphRoot: head.graphRoot,
        readyRecordHash: head.readyRecordHash,
        providerRoot: head.providerRoot,
        hardwareProfileRoot: head.hardwareProfileRoot,
        generationSourceCoverageRoot: head.generationSourceCoverageRoot,
        sourceCoverageRoot: head.sourceCoverageRoot,
        headStartMonotonicNs: head.acceptedMonotonicNs,
        headTerminalMonotonicNs: terminalMonotonicNs.toString(),
        headDurationUs: headDuration,
        candidatePathDurationUs: input.candidatePathDurationUs,
        sourceCoarseDurationUs: input.sourceCoarseDurationUs,
        coarseDurationUs: input.coarseDurationUs,
        plannerExactProgramDurationUs: input.plannerExactProgramDurationUs,
        finalSimulationQueueWaitUs: input.finalSimulationQueueWaitUs,
        finalSimulationServiceUs: input.finalSimulationServiceUs,
        overheadDurationUs: input.overheadDurationUs,
        queueTelemetry: input.queueTelemetry,
        permitAccounting: input.permitAccounting,
        resourceSamples: input.resourceSamples,
        cpuMemoryEventLoop: input.cpuMemoryEventLoop,
        workerRestart: input.workerRestart,
        rawReceiptSetRoot: boundaryRoot,
      });
      durableAppendAttempted = true;
      const metricAppend = await this.#appendEvent("metric-sample", metric);
      let lastFactOffset = metricAppend.offsetEnd;
      for (const candidateTerminal of candidateTerminals) {
        const candidateAppend = await this.#appendEvent("candidate-terminal", candidateTerminal);
        lastFactOffset = candidateAppend.offsetEnd;
      }
      const terminal = createHeadTerminalReceipt({
        windowId: this.#commitment.windowId,
        ordinal: head.ordinal,
        canonicalHead: head.canonicalHead,
        supersededOrphanObservationRoot: state.lineage?.orphanObservationRoot ?? null,
        processLogAnchorHash: head.processLogAnchorHash,
        generationId: head.generationId,
        graphRoot: head.graphRoot,
        readyRecordHash: head.readyRecordHash,
        performanceProfileHash: this.#commitment.performanceProfileHash,
        providerRoot: head.providerRoot,
        hardwareProfileRoot: head.hardwareProfileRoot,
        generationSourceCoverageRoot: head.generationSourceCoverageRoot,
        sourceCoverageRoot: head.sourceCoverageRoot,
        candidateSetRoot: head.candidateSetRoot,
        orderedCandidateTerminalReceiptRoot: hashOrderedCandidateTerminalReceiptRoot(candidateTerminals),
        outcome: input.outcome,
        acceptedMonotonicNs: head.acceptedMonotonicNs,
        terminalMonotonicNs: terminalMonotonicNs.toString(),
        logRangeStartOffset: state.logStartOffset,
        logRangeEndOffset: lastFactOffset,
        headDurationUs: headDuration,
        metricSampleId: metric.metricSampleId,
        timingSampleRoot: hashTimingSampleRoot(metric),
        workReceiptRoot: input.workReceiptRoot,
        queueTelemetryRoot: hashQueueTelemetryRoot(metric.queueTelemetry),
        resourceSampleRoot: hashResourceSampleRoot(metric.resourceSamples),
        cpuMemoryEventLoopRoot: hashCpuMemoryEventLoopRoot(metric.cpuMemoryEventLoop),
        workerRestartRoot: hashWorkerRestartRoot(metric.workerRestart),
        rawReceiptSetRoot: boundaryRoot,
      });
      await this.#appendEvent("head-terminal", terminal);
      commitPerformanceHeadTerminalEvidenceClaim(claim);
      claimFinalized = true;
      this.#metrics.push(metric);
      this.#candidateTerminals.push(...candidateTerminals);
      this.#terminals.push(terminal);
      this.#terminalByAdmissionId.set(state.anchor.admissionId, terminal);
      this.#terminalByHeadId.set(headRecordId, terminal);
      if (this.#terminals.length === 100) await this.#sealWindow();
      return terminal;
      } catch (error) {
        if (!claimFinalized) {
          if (durableAppendAttempted) {
            commitPerformanceHeadTerminalEvidenceClaim(claim);
            this.#indeterminateTerminalHeadIds.add(headRecordId);
          } else {
            abortPerformanceHeadTerminalEvidenceClaim(claim);
          }
        }
        throw error;
      }
    });
  }

  snapshot(): PerformanceCollectorSnapshotV1 {
    const heads = this.#heads.flatMap((state) => state.record === null ? [] : [state.record]);
    const candidateSets = this.#heads.flatMap((state) => state.candidateSet === null ? [] : [state.candidateSet]);
    const generationSegments = this.#windowReceipt === null ? [] : derivePerformanceGenerationSegments({
      windowId: this.#commitment.windowId,
      heads,
      terminals: this.#terminals,
      metrics: this.#metrics,
    });
    return Object.freeze({
      bundle: this.#windowReceipt === null ? null : Object.freeze({
        profile: this.#profile,
        commitment: this.#commitment,
        heads: Object.freeze(heads),
        lineages: Object.freeze([...this.#lineages]),
        candidateSets: Object.freeze(candidateSets),
        candidateTerminals: Object.freeze([...this.#candidateTerminals]),
        metrics: Object.freeze([...this.#metrics]),
        terminals: Object.freeze([...this.#terminals]),
        generationSegments,
        windowReceipt: this.#windowReceipt,
      }),
      commitment: this.#commitment,
      heads: Object.freeze(heads),
      lineages: Object.freeze([...this.#lineages]),
      candidateSets: Object.freeze(candidateSets),
      candidateTerminals: Object.freeze([...this.#candidateTerminals]),
      metrics: Object.freeze([...this.#metrics]),
      terminals: Object.freeze([...this.#terminals]),
      generationSegments,
      windowReceipt: this.#windowReceipt,
      rawEventIds: Object.freeze([...this.#rawEventIds]),
      rawEvents: Object.freeze([...this.#rawEvents]),
    });
  }

  async #sealWindow(): Promise<void> {
    if (this.#heads.length !== 100 || this.#terminals.length !== 100) throw new Error("performance window cannot seal before exactly 100 heads and terminals");
    const heads = this.#heads.map((state) => {
      if (state.record === null || state.candidateSet === null) throw new Error("performance window cannot seal with unbound head facts");
      return state.record;
    });
    const candidateSets = this.#heads.map((state) => {
      if (state.candidateSet === null) throw new Error("performance window cannot seal with unbound candidate facts");
      return state.candidateSet;
    });
    const endNs = BigInt(this.#terminals.reduce((latest, terminal) => decimal(terminal.terminalMonotonicNs) > decimal(latest) ? terminal.terminalMonotonicNs : latest, this.#commitment.committedMonotonicNs));
    const generationSegments = derivePerformanceGenerationSegments({
      windowId: this.#commitment.windowId,
      heads,
      terminals: this.#terminals,
      metrics: this.#metrics,
    });
    for (const segment of generationSegments) await this.#appendEvent("generation-segment", segment);
    const windowReceipt = createPerformanceWindowReceipt({
      windowId: this.#commitment.windowId,
      windowCommitmentHash: hashPerformanceWindowCommitment(this.#commitment),
      orderedEligibleHeadRecordRoot: hashOrderedEligibleHeadRecordsRoot(heads),
      orderedHeadTerminalReceiptRoot: hashOrderedHeadTerminalReceiptRoot(this.#terminals),
      orphanReplacementLineageRoot: hashOrphanReplacementLineageRoot(this.#lineages),
      candidateBearingHeadSetRoot: hashCandidateBearingHeadSetRoot(heads),
      fullHeadTimingSampleRoot: hashFullHeadTimingSampleRoot(this.#metrics),
      candidatePathTimingSampleRoot: hashCandidatePathTimingSampleRoot(this.#metrics),
      metricRecomputationRoot: hashMetricRecomputationRoot(this.#metrics),
      generationSegmentRoot: hashPerformanceGenerationSegmentRoot(generationSegments),
      rawReceiptSetRoot: hashPerformanceSemanticReceiptSetRoot({
        profile: this.#profile,
        commitment: this.#commitment,
        heads,
        lineages: this.#lineages,
        candidateSets,
        candidateTerminals: this.#candidateTerminals,
        metrics: this.#metrics,
        terminals: this.#terminals,
        generationSegments,
      }),
      headCount: "100",
      healthyHeadCount: this.#terminals.filter((terminal) => terminal.healthy).length.toString(),
      excludedHeads: [],
      windowStartMonotonicNs: this.#commitment.committedMonotonicNs,
      windowEndMonotonicNs: endNs.toString(),
      windowDurationUs: durationUs(BigInt(this.#commitment.committedMonotonicNs), endNs),
    });
    await this.#appendEvent("window-receipt", windowReceipt);
    this.#windowReceipt = windowReceipt;
  }

  async #appendEvent(eventType: Parameters<typeof createPerformanceEvent>[0]["eventType"], payload: Record<string, unknown>): Promise<PerformanceAppendReceiptV1> {
    const sequence = this.#nextSequence.toString();
    const event = createPerformanceEvent({
      eventType,
      sequence,
      windowId: this.#commitment.windowId,
      payload: payload as never,
    });
    const bytes = encodeCanonicalBytes(event);
    const request: PerformanceAppendRequestV1 = Object.freeze({
      sequence,
      eventId: event.eventId,
      contentSha256: sha256Hex(bytes),
      bytes,
    });
    const acknowledgement = await this.#append.appendFsyncMonotonic(request);
    if (acknowledgement.fsynced !== true || acknowledgement.sequence !== sequence || acknowledgement.eventId !== request.eventId || acknowledgement.contentSha256 !== request.contentSha256 || BigInt(acknowledgement.offsetEnd) - BigInt(acknowledgement.offsetStart) !== BigInt(acknowledgement.byteLength)) throw new Error("performance append acknowledgement does not bind exact bytes");
    this.#rawEventIds.push(event.eventId);
    this.#rawEvents.push(event);
    this.#nextSequence += 1n;
    return acknowledgement;
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function hashRawBoundary(head: EligibleHeadRecordV1, candidateSet: CandidateSetV1, outcome: PerformanceHeadOutcomeV1): Hash {
  return hashRawReceiptSetRoot([head.headRecordId, candidateSet.setId, hashDomain("aloha/performance-head-outcome/v1", outcome)]);
}

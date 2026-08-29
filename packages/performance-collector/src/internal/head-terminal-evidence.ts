import {
  assertExactKeys,
  assertHash,
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type {
  CandidateTerminalReceiptV1,
  CpuMemoryEventLoopSampleV1,
  PerformanceHeadOutcomeV1,
  PermitAccountingV1,
  QueueTelemetryV1,
  ResourceSampleV1,
  WorkerRestartSampleV1,
} from "../../../../specs/performance/src/index.ts";

declare const performanceHeadTerminalEvidenceBrand: unique symbol;

/** Opaque, identity-bearing evidence. Structural lookalikes are never accepted. */
export interface PerformanceHeadTerminalEvidenceCapabilityV1 {
  readonly [performanceHeadTerminalEvidenceBrand]: never;
}

export interface PerformanceSixStepCompletionEvidenceV1 {
  readonly mode: "unsigned-dry-run";
  readonly evidenceRoot: Hash;
}

export interface PerformanceCandidateTerminalEvidenceV1 {
  readonly candidateId: Hash;
  readonly outcome: CandidateTerminalReceiptV1["outcome"];
  readonly timingUs: string;
  readonly evidenceRoot: Hash;
  readonly sixStepCompletion: PerformanceSixStepCompletionEvidenceV1 | null;
}

export interface PerformanceHeadTerminalEvidenceDraftV1 {
  readonly windowId: Hash;
  readonly headRecordId: Hash;
  readonly candidateSetRoot: Hash;
  readonly correlationRoot: Hash;
  readonly outcome: PerformanceHeadOutcomeV1;
  readonly candidatePathDurationUs: string | null;
  readonly sourceCoarseDurationUs: string;
  readonly coarseDurationUs: string;
  readonly plannerExactProgramDurationUs: string;
  readonly finalSimulationQueueWaitUs: string;
  readonly finalSimulationServiceUs: string;
  readonly overheadDurationUs: string;
  readonly candidateTerminals: readonly PerformanceCandidateTerminalEvidenceV1[];
  readonly workReceiptRoot: Hash;
  readonly queueTelemetry: readonly QueueTelemetryV1[];
  readonly permitAccounting: readonly PermitAccountingV1[];
  readonly resourceSamples: readonly ResourceSampleV1[];
  readonly cpuMemoryEventLoop: CpuMemoryEventLoopSampleV1;
  readonly workerRestart: WorkerRestartSampleV1;
}

interface PerformanceHeadTerminalEvidenceBindingV1 {
  readonly owner: object;
  readonly evidence: PerformanceHeadTerminalEvidenceDraftV1;
  state: "available" | "claimed" | "consumed";
  activeClaim: PerformanceHeadTerminalEvidenceClaimV1 | null;
}

/** Opaque two-phase claim. Durable consumers commit only after the exact
 * terminal bytes are fsync-acknowledged; a pre-append failure may abort and
 * retry the same owner-issued evidence without minting replacement facts. */
export type PerformanceHeadTerminalEvidenceClaimV1 = object;

interface PerformanceHeadTerminalEvidenceClaimStateV1 {
  readonly binding: PerformanceHeadTerminalEvidenceBindingV1;
  state: "active" | "committed" | "aborted";
}

const TERMINAL_EVIDENCE_KEYS = Object.freeze([
  "windowId",
  "headRecordId",
  "candidateSetRoot",
  "correlationRoot",
  "outcome",
  "candidatePathDurationUs",
  "sourceCoarseDurationUs",
  "coarseDurationUs",
  "plannerExactProgramDurationUs",
  "finalSimulationQueueWaitUs",
  "finalSimulationServiceUs",
  "overheadDurationUs",
  "candidateTerminals",
  "workReceiptRoot",
  "queueTelemetry",
  "permitAccounting",
  "resourceSamples",
  "cpuMemoryEventLoop",
  "workerRestart",
] as const);
const CANDIDATE_TERMINAL_EVIDENCE_KEYS = Object.freeze([
  "candidateId",
  "outcome",
  "timingUs",
  "evidenceRoot",
  "sixStepCompletion",
] as const);
const SIX_STEP_COMPLETION_KEYS = Object.freeze(["mode", "evidenceRoot"] as const);

const bindings = new WeakMap<object, PerformanceHeadTerminalEvidenceBindingV1>();
const claims = new WeakMap<object, PerformanceHeadTerminalEvidenceClaimStateV1>();

function positiveHash(value: Hash, path: string): void {
  assertHash(value, path);
  if (value === `0x${"0".repeat(64)}`) throw new TypeError(`zero hash is not allowed at ${path}`);
}

function clone<T>(value: T): T {
  return decodeCanonicalBytes(encodeCanonicalBytes(value)) as T;
}

function validateDraft(value: PerformanceHeadTerminalEvidenceDraftV1): PerformanceHeadTerminalEvidenceDraftV1 {
  assertExactKeys(value, TERMINAL_EVIDENCE_KEYS, "performanceHeadTerminalEvidence");
  positiveHash(value.windowId, "performanceHeadTerminalEvidence.windowId");
  positiveHash(value.headRecordId, "performanceHeadTerminalEvidence.headRecordId");
  positiveHash(value.candidateSetRoot, "performanceHeadTerminalEvidence.candidateSetRoot");
  positiveHash(value.correlationRoot, "performanceHeadTerminalEvidence.correlationRoot");
  positiveHash(value.workReceiptRoot, "performanceHeadTerminalEvidence.workReceiptRoot");
  for (const [index, candidate] of value.candidateTerminals.entries()) {
    assertExactKeys(candidate, CANDIDATE_TERMINAL_EVIDENCE_KEYS, `performanceHeadTerminalEvidence.candidateTerminals[${index}]`);
    positiveHash(candidate.candidateId, `performanceHeadTerminalEvidence.candidateTerminals[${index}].candidateId`);
    positiveHash(candidate.evidenceRoot, `performanceHeadTerminalEvidence.candidateTerminals[${index}].evidenceRoot`);
    if (candidate.sixStepCompletion !== null) {
      assertExactKeys(candidate.sixStepCompletion, SIX_STEP_COMPLETION_KEYS, `performanceHeadTerminalEvidence.candidateTerminals[${index}].sixStepCompletion`);
      if (candidate.sixStepCompletion.mode !== "unsigned-dry-run") throw new TypeError("six-step completion must be an unsigned dry run");
      positiveHash(candidate.sixStepCompletion.evidenceRoot, `performanceHeadTerminalEvidence.candidateTerminals[${index}].sixStepCompletion.evidenceRoot`);
      if (candidate.outcome !== "verified") throw new TypeError("only a verified candidate may carry six-step completion evidence");
    }
  }
  return clone(value);
}

export interface PerformanceHeadTerminalEvidenceOwnerV1 {
  issue(draft: PerformanceHeadTerminalEvidenceDraftV1): PerformanceHeadTerminalEvidenceCapabilityV1;
}

/**
 * Package-internal owner seam. It is deliberately absent from the package
 * public export map; release composition must own the only production caller.
 */
export function createInternalPerformanceHeadTerminalEvidenceOwner(): PerformanceHeadTerminalEvidenceOwnerV1 {
  const owner = Object.freeze({});
  return Object.freeze({
    issue(draft: PerformanceHeadTerminalEvidenceDraftV1): PerformanceHeadTerminalEvidenceCapabilityV1 {
      const capability = Object.freeze({});
      bindings.set(capability, {
        owner,
        evidence: validateDraft(draft),
        state: "available",
        activeClaim: null,
      });
      return capability as PerformanceHeadTerminalEvidenceCapabilityV1;
    },
  });
}

export function claimPerformanceHeadTerminalEvidence(
  capability: PerformanceHeadTerminalEvidenceCapabilityV1,
  expected: {
    readonly windowId: Hash;
    readonly headRecordId: Hash;
    readonly candidateSetRoot: Hash;
  },
): PerformanceHeadTerminalEvidenceClaimV1 {
  if (typeof capability !== "object" || capability === null) throw new TypeError("head-terminal evidence capability was not issued");
  const binding = bindings.get(capability as object);
  if (binding === undefined) throw new TypeError("head-terminal evidence capability was not issued");
  if (binding.state === "consumed") throw new TypeError("head-terminal evidence capability was already consumed");
  if (binding.state === "claimed") throw new TypeError("head-terminal evidence capability is already claimed");
  const evidence = binding.evidence;
  if (evidence.windowId !== expected.windowId) throw new TypeError("head-terminal evidence capability belongs to another window");
  if (evidence.headRecordId !== expected.headRecordId) throw new TypeError("head-terminal evidence capability belongs to another head");
  if (evidence.candidateSetRoot !== expected.candidateSetRoot) throw new TypeError("head-terminal evidence capability belongs to another candidate set");
  const claim = Object.freeze(Object.create(null)) as PerformanceHeadTerminalEvidenceClaimV1;
  binding.state = "claimed";
  binding.activeClaim = claim;
  claims.set(claim, { binding, state: "active" });
  return claim;
}

export function readClaimedPerformanceHeadTerminalEvidence(
  claim: PerformanceHeadTerminalEvidenceClaimV1,
): PerformanceHeadTerminalEvidenceDraftV1 {
  if (typeof claim !== "object" || claim === null) throw new TypeError("head-terminal evidence claim is invalid");
  const state = claims.get(claim);
  if (state === undefined || state.state !== "active" || state.binding.activeClaim !== claim || state.binding.state !== "claimed") {
    throw new TypeError("head-terminal evidence claim is not active");
  }
  return clone(state.binding.evidence);
}

export function commitPerformanceHeadTerminalEvidenceClaim(
  claim: PerformanceHeadTerminalEvidenceClaimV1,
): void {
  if (typeof claim !== "object" || claim === null) throw new TypeError("head-terminal evidence claim is invalid");
  const state = claims.get(claim);
  if (state === undefined || state.state !== "active" || state.binding.activeClaim !== claim || state.binding.state !== "claimed") {
    throw new TypeError("head-terminal evidence claim is not active");
  }
  state.state = "committed";
  state.binding.state = "consumed";
  state.binding.activeClaim = null;
}

export function abortPerformanceHeadTerminalEvidenceClaim(
  claim: PerformanceHeadTerminalEvidenceClaimV1,
): void {
  if (typeof claim !== "object" || claim === null) throw new TypeError("head-terminal evidence claim is invalid");
  const state = claims.get(claim);
  if (state === undefined || state.state !== "active" || state.binding.activeClaim !== claim || state.binding.state !== "claimed") {
    throw new TypeError("head-terminal evidence claim is not active");
  }
  state.state = "aborted";
  state.binding.state = "available";
  state.binding.activeClaim = null;
}

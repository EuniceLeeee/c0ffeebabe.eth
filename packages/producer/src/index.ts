import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  deepFreeze,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import type {
  CanonicalHead,
  ProducerSessionV1,
} from "../../canonical-source/src/index.ts";
import type {
  RouteAccountingEntryV1,
  RouteAccountingV1,
  RouteCandidateTerminalTimingFactsV1,
  SearchTerminalCapabilityV1,
} from "../../search-pipeline/src/index.ts";
import {
  assertIssuedCurrentSourceRpcPhysicalFactsV1,
  currentSourceRpcLogicalScopeFactsRoot,
  type CurrentSourceRpcLogicalScopeFactsV1,
  type CurrentSourceRpcPhysicalFactsV1,
} from "../../current-source-rpc/src/index.ts";
import { performanceLaneCandidateRefV1 } from "../../../specs/performance/src/index.ts";
import {
  assertIssuedProducerLaneFactsV1,
  assertIssuedProducerLaneFailureObservationV1,
  assertIssuedProducerLanePortV1,
  assertIssuedProducerBackrunIntakeV1,
  assertIssuedProducerPerformancePortV1,
  assertIssuedProducerHeadFactsCapabilityV1,
  assertIssuedProducerHeadTerminalCapabilityV1,
  assertIssuedProducerCurrentSourceHeadPortV1,
  assertIssuedProducerSessionOwnerV1,
  assertIssuedProducerTerminalPortV1,
  readIssuedProducerLaneFactsV1,
  readIssuedProducerLaneFailureObservationV1,
  readIssuedProducerLaneCandidateTerminalObservationsV1,
  readIssuedProducerLanePlannerEnumerationV1,
  readIssuedProducerBackrunIntakeV1,
  readIssuedProducerHeadFactsCapabilityV1,
  readIssuedProducerHeadTerminalCapabilityV1,
  issueProducerHeadFactsCapabilityV1,
  issueProducerHeadTerminalCapabilityV1,
  producerHeadFactsRootV1,
  producerLaneFactsIdentityRootV1,
  producerLaneFailureObservationRootV1,
  producerLaneTerminalSetRootV1,
  producerOrderedHashRootV1,
} from "./internal/owners.ts";

export type { CanonicalHead, ProducerSessionV1 } from "../../canonical-source/src/index.ts";
export {
  assertIssuedProducerBoundTriggerV1,
  assertIssuedProducerBackrunIntakeV1,
  assertIssuedProducerIngressPortV1,
  assertIssuedProducerIngressTriggerV1,
  assertIssuedProducerLaneFactsV1,
  assertIssuedProducerLaneFailureObservationV1,
  assertIssuedProducerLanePortV1,
  assertIssuedProducerPerformancePortV1,
  assertIssuedProducerHeadFactsCapabilityV1,
  assertIssuedProducerHeadTerminalCapabilityV1,
  assertIssuedProducerCurrentSourceHeadPortV1,
  assertIssuedProducerSessionOwnerV1,
  assertIssuedProducerTerminalPortV1,
  issueProducerBoundTriggerV1,
  issueProducerLanePortV1,
  issueProducerSessionOwnerV1,
  readIssuedProducerBoundTriggerV1,
  readIssuedProducerBackrunIntakeV1,
  readIssuedProducerLaneFactsV1,
  readIssuedProducerLaneFailureObservationV1,
  readIssuedProducerLaneCandidateTerminalObservationsV1,
  readIssuedProducerLanePlannerEnumerationV1,
  readIssuedProducerNoInputLaneDenominatorV1,
  readIssuedProducerLaneSearchTerminalCapabilityV1,
  readIssuedProducerFinalFullFamilyTerminalSetV1,
  readIssuedProducerHeadFactsCapabilityV1,
  readIssuedProducerHeadSchedulerCompletionV1,
  readIssuedProducerHeadTerminalCapabilityV1,
  producerHeadFactsRootV1,
  producerLaneFactsIdentityRootV1,
  producerLaneFailureObservationRootV1,
  producerLaneTerminalSetRootV1,
  producerOrderedHashRootV1,
} from "./internal/owners.ts";
export {
  createRethProducerIngressPortV1,
  RethProducerIngressSourceV1,
  type RethProducerIngressConfigV1,
} from "./internal/reth-intake.ts";

export type ProducerLaneKindV1 = "blockscan" | "backrun";

declare const producerIngressTriggerBrand: unique symbol;
declare const producerBoundTriggerBrand: unique symbol;
declare const producerIngressSourceBrand: unique symbol;
declare const producerBackrunIntakeBrand: unique symbol;
declare const producerCurrentSourceHeadPortBrand: unique symbol;
declare const producerHeadFactsCapabilityBrand: unique symbol;
declare const producerHeadTerminalCapabilityBrand: unique symbol;

/**
 * Opaque ingress token.  A caller may submit only a token issued by the
 * producer ingress owner; the lane never consumes a trigger-shaped DTO.
 */
export interface ProducerIngressTriggerV1 {
  readonly [producerIngressTriggerBrand]: never;
}

/**
 * Opaque trigger after the producer owner has joined it to the exact
 * canonical head, session generation, and Graph root.
 */
export interface ProducerBoundTriggerV1 {
  readonly [producerBoundTriggerBrand]: never;
}

/** Opaque source capability issued by the candidate-owned Reth intake. */
export interface ProducerIngressSourceV1 {
  readonly [producerIngressSourceBrand]: never;
}

/**
 * Opaque result of one release-owned public-pending observation.  A null or a
 * caller-shaped object is never evidence that the backrun lane had no input.
 */
export interface ProducerBackrunIntakeV1 {
  readonly [producerBackrunIntakeBrand]: never;
}

/**
 * Head-level completion port issued only by the current-source owner.  It
 * seals the shared physical transport once, after both logical lanes settle.
 */
export interface ProducerCurrentSourceHeadPortV1<Session extends ProducerSessionV1 = ProducerSessionV1> {
  readonly [producerCurrentSourceHeadPortBrand]: never;
  readonly closeHead: (session: Session) => Promise<CurrentSourceRpcPhysicalFactsV1>;
}

export interface ProducerPendingSnapshotV1 {
  readonly pendingNumber: string;
  readonly parentHash: Hash;
  readonly orderedTransactionHashes: readonly Hash[];
  readonly orderedTransactionHashesRoot: Hash;
  readonly transactionCount: string;
  readonly snapshotHash: Hash;
}

export type ProducerBackrunIntakeFactsV1 =
  | Readonly<{
      readonly kind: "pending-transaction";
      readonly head: CanonicalHead;
      readonly snapshot: ProducerPendingSnapshotV1;
      readonly txHash: Hash;
      readonly pendingEvidenceHash: Hash;
      readonly correlationId: Hash;
      readonly affectedEdgeIds: readonly Hash[];
      readonly trigger: ProducerIngressTriggerV1;
      readonly input: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      readonly kind: "observed-empty";
      readonly head: CanonicalHead;
      readonly snapshot: ProducerPendingSnapshotV1;
      readonly absenceEvidenceHash: Hash;
      readonly correlationId: Hash;
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly head: CanonicalHead;
      readonly snapshot: ProducerPendingSnapshotV1 | null;
      readonly reasonCode: "pending-observation-disabled" | "pending-block-unavailable" | "pending-set-not-single";
      readonly evidenceHash: Hash;
      readonly correlationId: Hash;
    }>;

export interface ProducerIngressTriggerSpecV1 {
  readonly lane: ProducerLaneKindV1;
  readonly head: CanonicalHead;
  /** Canonical head-event identity for blockscan; real transaction hash for backrun. */
  readonly triggerRef: Hash;
  /** A transaction exists only for the public-pending backrun lane. */
  readonly txHash: Hash | null;
  readonly correlationId: Hash;
  readonly affectedEdgeIds: readonly Hash[];
  /** Present only for a public-pending backrun; null for blockscan. */
  readonly pendingEvidenceHash: Hash | null;
}

/**
 * A release-owned intake observation.  The observer supplies the payloads
 * discovered from the canonical head; it does not supply an ingress token.
 * The ingress owner below derives the opaque lane tokens from these facts.
 */
export interface ProducerIngressObservationV1 {
  readonly head: CanonicalHead;
  readonly blockscan: Readonly<{
    readonly input: Record<string, unknown>;
  }>;
  readonly backrun:
    | Readonly<{
        readonly kind: "pending-transaction";
        readonly snapshot: ProducerPendingSnapshotV1;
        readonly txHash: Hash;
        readonly affectedEdgeIds: readonly Hash[];
        readonly pendingEvidenceHash: Hash;
        readonly input: Record<string, unknown>;
      }>
    | Readonly<{
        readonly kind: "observed-empty";
        readonly snapshot: ProducerPendingSnapshotV1;
        readonly absenceEvidenceHash: Hash;
      }>
    | Readonly<{
        readonly kind: "unavailable";
        readonly snapshot: ProducerPendingSnapshotV1 | null;
        readonly reasonCode: "pending-observation-disabled" | "pending-block-unavailable" | "pending-set-not-single";
        readonly evidenceHash: Hash;
      }>;
}

/**
 * Owner-issued intake port.  Production code can ask it for the next
 * canonical-head envelope, but cannot mint a token or provide trigger facts
 * directly to ProducerRuntime.
 */
export interface ProducerIngressPortV1 {
  readonly observe: (input: {
    readonly head: CanonicalHead;
    readonly signal: AbortSignal;
  }) => Promise<ProducerHeadInputV1 | null>;
}

export interface ProducerBoundTriggerFactsV1 {
  readonly lane: ProducerLaneKindV1;
  readonly headHash: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly txHash: Hash | null;
  readonly correlationId: Hash;
  readonly triggerRef: Hash;
  readonly pendingEvidenceHash: Hash | null;
  readonly affectedEdgeIds: readonly Hash[];
  readonly affectedEdgeIdsRoot: Hash;
}

export interface ProducerSessionOwnerV1<Session extends ProducerSessionV1 = ProducerSessionV1> {
  readonly withProducerSession: <Result>(
    head: CanonicalHead,
    run: (session: Session) => Promise<Result>,
    signal?: AbortSignal,
  ) => Promise<Result>;
}

export interface ProducerLaneRunInputV1<Session extends ProducerSessionV1 = ProducerSessionV1> {
  readonly kind: ProducerLaneKindV1;
  readonly session: Session;
  readonly head: CanonicalHead;
  readonly revision: string;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly input: unknown | null;
  readonly signal: AbortSignal;
}

export type ProducerLaneOutcomeKindV1 =
  | "completed"
  | "no-input"
  | "retryable"
  | "failed"
  | "cancelled";

export interface ProducerLaneOutcomeV1 {
  readonly kind: ProducerLaneOutcomeKindV1;
  readonly reasonCode?: string;
  /** The only accepted lane facts are producer-owner issued capabilities. */
  readonly facts?: ProducerLaneFactsV1;
  /** A closed source scope for a non-success outcome; never success evidence. */
  readonly failureObservation?: ProducerLaneFailureObservationV1;
}

/** Unbranded result accepted only by the producer-owned lane wrapper. */
export type ProducerLaneRunDraftV1 =
  | Readonly<{
      readonly kind: "terminal";
      readonly trigger: ProducerBoundTriggerV1;
      readonly terminalCapability: unknown;
      readonly pendingSnapshotHash: Hash | null;
      readonly currentSource: ProducerCurrentSourceLogicalFactsV1;
    }>
  | Readonly<{
      readonly kind: "no-input";
      readonly absence: ProducerBackrunIntakeV1;
      readonly currentSource: ProducerCurrentSourceLogicalFactsV1;
    }>
  | Readonly<{
      readonly kind: "retryable" | "failed" | "cancelled";
      readonly reasonCode: string;
      /** Explicitly null when the lane never closed a current-source scope. */
      readonly currentSource: ProducerCurrentSourceLogicalFactsV1 | null;
    }>;

export interface ProducerLaneRunnerV1<Session extends ProducerSessionV1 = ProducerSessionV1> {
  readonly kind: ProducerLaneKindV1;
  readonly run: (
    input: ProducerLaneRunInputV1<Session>,
  ) => Promise<ProducerLaneRunDraftV1> | ProducerLaneRunDraftV1;
}

export interface ProducerLanePortV1<Session extends ProducerSessionV1 = ProducerSessionV1> {
  readonly kind: ProducerLaneKindV1;
  readonly run: (
    input: ProducerLaneRunInputV1<Session>,
  ) => Promise<ProducerLaneOutcomeV1> | ProducerLaneOutcomeV1;
}

export type ProducerLaneTerminalKindV1 =
  | "dry-run"
  | "route-set-terminal"
  | "no-input"
  | "retryable"
  | "invalidProgram"
  | "chainProvenRejected";

/** Exact aliases of the search-pipeline terminal denominator; Producer does
 * not maintain a legacy-shaped accounting facade. */
export type ProducerLaneAccountingEntryV1 = RouteAccountingEntryV1;
export type ProducerLaneAccountingLegV1 = RouteAccountingEntryV1["legs"][number];
export type ProducerLaneAccountingV1 = RouteAccountingV1;

export type ProducerCurrentSourceLogicalFactsV1 = CurrentSourceRpcLogicalScopeFactsV1;
export type ProducerCurrentSourcePhysicalFactsV1 = CurrentSourceRpcPhysicalFactsV1;

export type ProducerCandidateTerminalObservationV1 = Readonly<{
  readonly kind: "aloha.producer-candidate-terminal-observation-v1";
  readonly lane: ProducerLaneKindV1;
  readonly headHash: Hash;
  readonly correlationId: RouteCandidateTerminalTimingFactsV1["correlationId"];
  readonly generationId: RouteCandidateTerminalTimingFactsV1["generationId"];
  readonly graphRoot: RouteCandidateTerminalTimingFactsV1["graphRoot"];
  readonly planningProblemHash: RouteCandidateTerminalTimingFactsV1["planningProblemHash"];
  readonly enumerationRoot: RouteCandidateTerminalTimingFactsV1["enumerationRoot"];
  readonly admissionPolicyHash: RouteCandidateTerminalTimingFactsV1["admissionPolicyHash"];
  readonly candidateId: RouteCandidateTerminalTimingFactsV1["candidateId"];
  readonly disposition: RouteCandidateTerminalTimingFactsV1["disposition"];
  readonly terminalKind: RouteCandidateTerminalTimingFactsV1["terminalKind"];
  readonly performanceOutcome: "verified" | "simulation-reverted" | "chain-proven-rejected" | "policy-rejected" | "retryable" | "invalid-program";
  readonly performanceCandidateRef: Hash;
  readonly routeHash: RouteCandidateTerminalTimingFactsV1["routeHash"];
  readonly reasonCode: RouteCandidateTerminalTimingFactsV1["reasonCode"];
  readonly evidenceHash: RouteCandidateTerminalTimingFactsV1["evidenceHash"];
  readonly policyTerminal: RouteCandidateTerminalTimingFactsV1["policyTerminal"];
  readonly terminalLineageHash: RouteCandidateTerminalTimingFactsV1["terminalLineageHash"];
  readonly sixStepEvidenceRoot: RouteCandidateTerminalTimingFactsV1["sixStepEvidenceRoot"];
  readonly startedMonotonicNs: RouteCandidateTerminalTimingFactsV1["startedMonotonicNs"];
  readonly finishedMonotonicNs: RouteCandidateTerminalTimingFactsV1["finishedMonotonicNs"];
  readonly timingUs: RouteCandidateTerminalTimingFactsV1["timingUs"];
  readonly timingRoot: RouteCandidateTerminalTimingFactsV1["timingRoot"];
  readonly observationRoot: Hash;
}>;

/**
 * Owner-issued observation for a lane that closed its current-source scope but
 * did not produce a semantic terminal. It deliberately carries no trigger,
 * accounting, candidate, lineage, or coverage authority.
 */
export interface ProducerLaneFailureObservationV1 {
  readonly kind: "aloha.producer-lane-failure-observation-v1";
  readonly lane: ProducerLaneKindV1;
  readonly headHash: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly outcome: "retryable" | "failed" | "cancelled";
  readonly reasonCode: string;
  readonly currentSource: ProducerCurrentSourceLogicalFactsV1;
  readonly complete: false;
}

/**
 * A lane fact is issued by the producer owner after route accounting and
 * current-source work have completed. The WeakMap capability in owners.ts
 * is the authority; a structural clone is not accepted by ProducerRuntime.
 */
export interface ProducerLaneFactsV1 {
  readonly kind: "aloha.producer-lane-facts-v1";
  readonly lane: ProducerLaneKindV1;
  readonly headHash: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly triggerRef: Hash;
  readonly txHash: Hash | null;
  readonly correlationId: Hash;
  readonly pendingEvidenceHash: Hash | null;
  readonly pendingSnapshotHash: Hash | null;
  readonly affectedEdgeIdsRoot: Hash;
  readonly outcome: ProducerLaneOutcomeKindV1;
  readonly terminalKind: ProducerLaneTerminalKindV1;
  /** Owner-preserved route terminal evidence; central code does not decode it. */
  readonly terminalOutcome: unknown;
  readonly accounting: ProducerLaneAccountingV1 | null;
  readonly coverageRoot: Hash;
  readonly candidateIds: readonly Hash[];
  readonly currentSource: ProducerCurrentSourceLogicalFactsV1;
  readonly terminalLineageHash: Hash;
  readonly complete: boolean;
}

/** Owner-preserved denominator evidence for a completed observed-empty
 * backrun lane. It is readable only for the exact issued lane-facts object. */
export interface ProducerNoInputLaneDenominatorV1 {
  readonly pendingSnapshot: ProducerPendingSnapshotV1;
  readonly absenceEvidenceHash: Hash;
  readonly terminalLineageHash: Hash;
  readonly currentSource: ProducerCurrentSourceLogicalFactsV1;
}

export interface ProducerHeadFactsV1 {
  readonly kind: "aloha.producer-head-facts-v1";
  readonly headHash: Hash;
  readonly generationId: string | null;
  readonly graphRoot: Hash | null;
  readonly laneFacts: readonly ProducerLaneFactsV1[];
  readonly laneFailureObservations: readonly ProducerLaneFailureObservationV1[];
  /** Exact lane-qualified all-enumerated denominator across issued lane accounting. */
  readonly candidateRefs: readonly Hash[];
  /** Shared physical work is sealed exactly once for the head, never copied into lanes. */
  readonly currentSourcePhysical: ProducerCurrentSourcePhysicalFactsV1 | null;
  readonly sourceCoverageRoot: Hash;
  readonly complete: boolean;
}

/** Opaque owner-issued handle for the exact frozen facts of one head. */
export interface ProducerHeadFactsCapabilityV1 {
  readonly [producerHeadFactsCapabilityBrand]: never;
}

/** Opaque owner-issued handle for one terminal and its optional head facts. */
export interface ProducerHeadTerminalCapabilityV1 {
  readonly [producerHeadTerminalCapabilityBrand]: never;
}

export interface ProducerHeadTerminalEvidenceV1 {
  readonly terminal: ProducerTerminalV1;
  /** Explicitly null when the head never entered a producer session. */
  readonly facts: ProducerHeadFactsCapabilityV1 | null;
}

/** Fixed full-family projection of one exact completed Producer head. */
export interface ProducerFinalFullFamilyTerminalSetV1 {
  readonly blockscanSearchTerminalCapability: SearchTerminalCapabilityV1;
  readonly producerHeadFactsRoot: Hash;
  readonly laneTerminalSetRoot: Hash;
}

export interface ProducerEligibleHeadInputV1 {
  readonly head: CanonicalHead;
  readonly revision: string;
}

export interface ProducerEligibleHeadBindingV1 {
  readonly admissionId: Hash;
  readonly ordinal: string;
  readonly headHash: Hash;
  readonly revision: string;
}

export interface ProducerPerformancePortV1<EligibleHeadHandle = unknown> {
  readonly acceptEligibleHead: (
    input: ProducerEligibleHeadInputV1,
  ) => Promise<EligibleHeadHandle> | EligibleHeadHandle;
  /** Owner projection of the opaque admitted handle; never caller input. */
  readonly readEligibleHeadBinding: (eligibleHead: EligibleHeadHandle) => ProducerEligibleHeadBindingV1;
  /** Atomically bind the provisional admission to the actual owner-issued
   * startup session before either search lane starts. */
  readonly bindEligibleHeadSession: (input: {
    readonly eligibleHead: EligibleHeadHandle;
    readonly session: ProducerSessionV1;
  }) => Promise<EligibleHeadHandle | void> | EligibleHeadHandle | void;
  readonly bindEligibleHeadFacts: (input: {
    readonly eligibleHead: EligibleHeadHandle;
    readonly facts: ProducerHeadFactsCapabilityV1;
  }) => Promise<EligibleHeadHandle | void> | EligibleHeadHandle | void;
  readonly sealHeadTerminal: (input: {
    readonly eligibleHead: EligibleHeadHandle;
    readonly terminal: ProducerHeadTerminalCapabilityV1;
  }) => Promise<unknown> | unknown;
}

export interface ProducerTerminalPortV1 {
  readonly appendTerminal: (input: {
    readonly terminal: ProducerHeadTerminalCapabilityV1;
  }) => Promise<unknown> | unknown;
}

export type ProducerTerminalStatusV1 =
  | "completed"
  | "failed"
  | "cancelled"
  | "dropped"
  | "rejected";

export type ProducerTerminalReasonV1 =
  | "completed"
  | "completed-with-no-backrun-input"
  | "scheduler_coalesced"
  | "shutdown_pending_dropped"
  | "shutdown_active_cancelled"
  | "same_height_reorg"
  | "explicit_invalidation"
  | "startup_session_failed"
  | "lane_failed"
  | "lane_retryable"
  | "performance_append_failed"
  | "terminal_append_failed"
  | "shutdown_rejected";

export interface ProducerLaneTerminalSummaryV1 {
  readonly kind: ProducerLaneKindV1;
  readonly outcome: ProducerLaneOutcomeKindV1;
  readonly reasonCode: string | null;
}

export interface ProducerTerminalV1 {
  readonly kind: "aloha.producer-terminal-v1";
  readonly terminalId: Hash;
  readonly acceptedId: Hash;
  readonly sequence: string;
  readonly ordinal: string;
  readonly head: CanonicalHead;
  readonly revision: string;
  readonly status: ProducerTerminalStatusV1;
  readonly reason: ProducerTerminalReasonV1;
  readonly generationId: string | null;
  readonly graphRoot: Hash | null;
  readonly laneOutcomes: readonly ProducerLaneTerminalSummaryV1[];
}

export interface ProducerHeadInputV1 {
  readonly head: CanonicalHead;
  readonly revision?: string;
  readonly sourceHeadSeenAtMs?: number;
  readonly sourceHeadSeenMonotonicMs?: number;
  readonly blockscanInput: unknown;
  readonly backrunInput: unknown | null;
}

export interface ProducerSubmissionResultV1 {
  readonly accepted: boolean;
  readonly acceptedId: Hash;
  readonly terminal: ProducerHeadTerminalCapabilityV1 | null;
}

export interface ProducerRuntimeTelemetryV1 {
  readonly state: "accepting" | "draining" | "closed";
  readonly submitted: number;
  readonly accepted: number;
  readonly started: number;
  readonly completed: number;
  readonly dropped: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly terminalCount: number;
  readonly active: CanonicalHead | null;
  readonly pending: CanonicalHead | null;
  readonly fatal: boolean;
}

interface InternalItem<Session extends ProducerSessionV1> {
  readonly input: Required<Pick<ProducerHeadInputV1, "head" | "blockscanInput" | "backrunInput">> & {
    readonly revision: string;
    readonly sourceHeadSeenAtMs: number;
    readonly sourceHeadSeenMonotonicMs: number;
  };
  readonly sequence: string;
  readonly acceptedId: Hash;
  eligibleBinding: ProducerEligibleHeadBindingV1 | null;
  readonly controller: AbortController;
  readonly sessionOwner: ProducerSessionOwnerV1<Session>;
  cancellationReason: ProducerTerminalReasonV1 | null;
  terminalEmitted: boolean;
  executionPromise: Promise<void> | null;
  eligibleHead: unknown;
}

export interface ProducerRuntimeOptionsV1<Session extends ProducerSessionV1> {
  readonly sessionOwner: ProducerSessionOwnerV1<Session>;
  readonly blockscan: ProducerLanePortV1<Session>;
  readonly backrun: ProducerLanePortV1<Session>;
  readonly currentSource: ProducerCurrentSourceHeadPortV1<Session>;
  readonly performance: ProducerPerformancePortV1<unknown>;
  readonly terminal: ProducerTerminalPortV1;
}

function exactHead(value: unknown, path: string): CanonicalHead {
  assertPlainObject(value, path);
  assertExactKeys(value, ["chainId", "number", "hash", "parentHash", "stateRoot"], path);
  const record = value as Record<string, unknown>;
  return deepFreeze({
    chainId: assertNonEmptyString(record.chainId, `${path}.chainId`),
    number: assertDecimalString(record.number, `${path}.number`),
    hash: assertHash(record.hash, `${path}.hash`),
    parentHash: assertHash(record.parentHash, `${path}.parentHash`),
    stateRoot: assertHash(record.stateRoot, `${path}.stateRoot`),
  });
}

function exactRevision(value: unknown, path: string): string {
  const revision = assertDecimalString(value, path);
  return revision;
}

function sameHead(left: CanonicalHead, right: CanonicalHead): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.parentHash === right.parentHash
    && left.stateRoot === right.stateRoot;
}

function sameSourceView(left: ProducerCurrentSourcePhysicalFactsV1["source"], right: CanonicalHead): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function compareHeadItems(
  left: Pick<InternalItem<ProducerSessionV1>, "input" | "acceptedId">,
  right: Pick<InternalItem<ProducerSessionV1>, "input" | "acceptedId">,
): number {
  const leftNumber = BigInt(left.input.head.number);
  const rightNumber = BigInt(right.input.head.number);
  if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
  const leftRevision = BigInt(left.input.revision);
  const rightRevision = BigInt(right.input.revision);
  if (leftRevision !== rightRevision) return leftRevision < rightRevision ? -1 : 1;
  if (left.acceptedId === right.acceptedId) return 0;
  return left.acceptedId < right.acceptedId ? -1 : 1;
}

function validObservation(value: number | undefined, path: string): number {
  const result = value ?? (path.endsWith("Ms") ? Date.now() : performance.now());
  if (!Number.isFinite(result) || result < 0) throw new TypeError(`${path} must be a finite non-negative number`);
  return result;
}

function asReason(value: string | undefined, fallback: ProducerTerminalReasonV1): ProducerTerminalReasonV1 {
  if (value === "lane_retryable") return value;
  if (value === "lane_failed") return value;
  return fallback;
}

function terminalId(input: {
  readonly acceptedId: Hash;
  readonly sequence: string;
  readonly ordinal: string;
  readonly status: ProducerTerminalStatusV1;
  readonly reason: ProducerTerminalReasonV1;
  readonly head: CanonicalHead;
  readonly revision: string;
  readonly generationId: string | null;
  readonly graphRoot: Hash | null;
  readonly laneOutcomes: readonly ProducerLaneTerminalSummaryV1[];
}): Hash {
  return hashDomain("aloha/producer-terminal/v1", input);
}

function exactLaneOutcome(value: unknown, path: string): ProducerLaneOutcomeV1 {
  if (value === null || typeof value !== "object") throw new TypeError(`${path} must be an object`);
  const result = value as Record<string, unknown>;
  const kind = result.kind;
  if (kind !== "completed" && kind !== "no-input" && kind !== "retryable" && kind !== "failed" && kind !== "cancelled") {
    throw new TypeError(`${path}.kind is invalid`);
  }
  if (result.reasonCode !== undefined && typeof result.reasonCode !== "string") throw new TypeError(`${path}.reasonCode is invalid`);
  let facts: ProducerLaneFactsV1 | undefined;
  if (Object.prototype.hasOwnProperty.call(result, "facts")) {
    assertIssuedProducerLaneFactsV1(result.facts);
    facts = result.facts;
  }
  let failureObservation: ProducerLaneFailureObservationV1 | undefined;
  if (Object.prototype.hasOwnProperty.call(result, "failureObservation")) {
    assertIssuedProducerLaneFailureObservationV1(result.failureObservation);
    failureObservation = readIssuedProducerLaneFailureObservationV1(result.failureObservation);
  }
  if (facts !== undefined && failureObservation !== undefined) throw new TypeError(`${path} cannot carry success and failure facts`);
  assertExactKeys(result, [
    "kind",
    ...(result.reasonCode === undefined ? [] : ["reasonCode"]),
    ...(facts === undefined ? [] : ["facts"]),
    ...(failureObservation === undefined ? [] : ["failureObservation"]),
  ], path);
  return Object.freeze({
    kind,
    ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
    ...(facts === undefined ? {} : { facts }),
    ...(failureObservation === undefined ? {} : { failureObservation }),
  });
}

function reasonForOutcomes(outcomes: readonly ProducerLaneOutcomeV1[]): ProducerTerminalReasonV1 {
  if (outcomes.some(value => value.kind === "failed")) return "lane_failed";
  if (outcomes.some(value => value.kind === "retryable")) return "lane_retryable";
  if (outcomes.every(value => value.kind === "no-input" || value.kind === "completed")) {
    return outcomes.some(value => value.kind === "no-input") ? "completed-with-no-backrun-input" : "completed";
  }
  return "lane_failed";
}

function mergeProducerLaneFactsV1(input: {
  readonly head: CanonicalHead;
  readonly generationId: string | null;
  readonly graphRoot: Hash | null;
  readonly laneOutcomes: readonly ProducerLaneOutcomeV1[];
  readonly currentSourcePhysical: ProducerCurrentSourcePhysicalFactsV1 | null;
  readonly allowComplete?: boolean;
}): ProducerHeadFactsV1 {
  const factsByLane: ProducerLaneFactsV1[] = [];
  const failuresByLane: ProducerLaneFailureObservationV1[] = [];
  for (const [index, lane] of (["blockscan", "backrun"] as const).entries()) {
    const outcome = input.laneOutcomes[index];
    if (outcome === undefined) continue;
    if (outcome.facts !== undefined) {
      try {
        assertIssuedProducerLaneFactsV1(outcome.facts);
        const facts = readIssuedProducerLaneFactsV1(outcome.facts);
        if (facts.lane !== lane || facts.headHash !== input.head.hash) continue;
        if (input.generationId !== null && facts.generationId !== input.generationId) continue;
        if (input.graphRoot !== null && facts.graphRoot !== input.graphRoot) continue;
        if (facts.outcome !== outcome.kind) continue;
        factsByLane.push(facts);
      } catch {
        // A missing, cloned, or mismatched lane fact is evidence of an
        // incomplete head, never a reason to treat the lane as no-candidate.
      }
    }
    if (outcome.failureObservation !== undefined) {
      try {
        assertIssuedProducerLaneFailureObservationV1(outcome.failureObservation);
        const observation = readIssuedProducerLaneFailureObservationV1(outcome.failureObservation);
        if (observation.lane !== lane || observation.headHash !== input.head.hash) continue;
        if (input.generationId !== null && observation.generationId !== input.generationId) continue;
        if (input.graphRoot !== null && observation.graphRoot !== input.graphRoot) continue;
        if (observation.outcome !== outcome.kind || observation.reasonCode !== outcome.reasonCode) continue;
        failuresByLane.push(observation);
      } catch {
        // A missing, cloned, or mismatched failure observation remains
        // incomplete and cannot be promoted into lane coverage.
      }
    }
  }
  factsByLane.sort((left, right) => (left.lane === right.lane ? 0 : left.lane === "blockscan" ? -1 : 1));
  failuresByLane.sort((left, right) => (left.lane === right.lane ? 0 : left.lane === "blockscan" ? -1 : 1));
  const candidateRefs = factsByLane.flatMap(facts => facts.accounting?.entries.map(entry => performanceLaneCandidateRefV1(
    facts.lane,
    entry.candidateId,
  )) ?? []).sort() as Hash[];
  if (new Set(candidateRefs).size !== candidateRefs.length) throw new TypeError("producer head candidate refs are not unique");
  const allLanesPresent = factsByLane.length === 2
    && factsByLane[0]?.lane === "blockscan"
    && factsByLane[1]?.lane === "backrun";
  const observedCurrentSourceByLane = (["blockscan", "backrun"] as const).flatMap(lane => {
    const facts = factsByLane.find(value => value.lane === lane);
    if (facts !== undefined) return [facts.currentSource];
    const failure = failuresByLane.find(value => value.lane === lane);
    return failure === undefined ? [] : [failure.currentSource];
  });
  const allLaneScopesObserved = observedCurrentSourceByLane.length === 2
    && observedCurrentSourceByLane[0]?.lane === "blockscan"
    && observedCurrentSourceByLane[1]?.lane === "backrun";
  let currentSourcePhysical: ProducerCurrentSourcePhysicalFactsV1 | null = null;
  try {
    if (input.currentSourcePhysical !== null) {
      assertIssuedCurrentSourceRpcPhysicalFactsV1(input.currentSourcePhysical);
      if (!sameSourceView(input.currentSourcePhysical.source, input.head)) {
        throw new TypeError("producer current-source physical facts do not match head");
      }
      currentSourcePhysical = input.currentSourcePhysical;
    }
  } catch {
    currentSourcePhysical = null;
  }
  const currentSourceJoined = currentSourcePhysical !== null
    && allLaneScopesObserved
    && currentSourcePhysical.logicalScopeFactsRoot === currentSourceRpcLogicalScopeFactsRoot(
      observedCurrentSourceByLane,
    );
  const complete = input.generationId !== null
    && input.graphRoot !== null
    && allLanesPresent
    && currentSourceJoined
    && input.laneOutcomes.length === 2
    && input.laneOutcomes[0]?.kind === "completed"
    && (input.laneOutcomes[1]?.kind === "completed" || input.laneOutcomes[1]?.kind === "no-input")
    && factsByLane.every(facts => facts.complete)
    && input.allowComplete !== false;
  const sourceCoverageRoot = hashDomain("aloha/producer-head-source-coverage/v2", {
    head: input.head,
    generationId: input.generationId,
    graphRoot: input.graphRoot,
    lanes: ([("blockscan" as const), ("backrun" as const)]).map(lane => {
      const facts = factsByLane.find(value => value.lane === lane);
      const failure = failuresByLane.find(value => value.lane === lane);
      return facts === undefined
        ? {
          lane,
          outcome: input.laneOutcomes[lane === "blockscan" ? 0 : 1]?.kind ?? null,
          reasonCode: input.laneOutcomes[lane === "blockscan" ? 0 : 1]?.reasonCode ?? null,
          laneFactsRoot: null,
          failureObservationRoot: failure === undefined ? null : producerLaneFailureObservationRootV1(failure),
        }
        : {
          lane,
          outcome: facts.outcome,
          laneFactsRoot: producerLaneFactsIdentityRootV1(facts),
          failureObservationRoot: null,
          complete: facts.complete,
        };
    }),
    candidateRefCount: String(candidateRefs.length),
    candidateRefsRoot: producerOrderedHashRootV1("aloha/producer-head-candidate-refs/v1", candidateRefs),
    currentSourcePhysicalRoot: currentSourcePhysical === null
      ? null
      : hashDomain("aloha/current-source-rpc-physical-facts/v1", currentSourcePhysical),
    currentSourceJoined,
    complete,
  });
  return Object.freeze({
    kind: "aloha.producer-head-facts-v1",
    headHash: input.head.hash,
    generationId: input.generationId,
    graphRoot: input.graphRoot,
    laneFacts: Object.freeze([...factsByLane]),
    laneFailureObservations: Object.freeze([...failuresByLane]),
    candidateRefs: Object.freeze(candidateRefs),
    currentSourcePhysical,
    sourceCoverageRoot,
    complete,
  });
}

export class ProducerRuntimeV1<Session extends ProducerSessionV1 = ProducerSessionV1> {
  readonly #options: ProducerRuntimeOptionsV1<Session>;
  #state: "accepting" | "draining" | "closed" = "accepting";
  #active: InternalItem<Session> | null = null;
  #pending: InternalItem<Session> | null = null;
  #latestSubmitted: InternalItem<Session> | null = null;
  #sequence = 0n;
  #submitted = 0;
  #accepted = 0;
  #started = 0;
  #completed = 0;
  #dropped = 0;
  #failed = 0;
  #cancelled = 0;
  #terminals: ProducerHeadTerminalCapabilityV1[] = [];
  #fatal: unknown = null;
  #controlTail: Promise<void> = Promise.resolve();
  #shutdownPromise: Promise<void> | null = null;
  #idlePromise: Promise<void>;
  #resolveIdle!: () => void;
  #idlePending = false;

  constructor(options: ProducerRuntimeOptionsV1<Session>) {
    if (options === null || typeof options !== "object") throw new TypeError("producer runtime options are required");
    assertIssuedProducerSessionOwnerV1(options.sessionOwner);
    assertIssuedProducerLanePortV1(options.blockscan);
    assertIssuedProducerLanePortV1(options.backrun);
    if (options.blockscan.kind !== "blockscan" || options.backrun.kind !== "backrun") throw new TypeError("both producer lanes are required");
    assertIssuedProducerCurrentSourceHeadPortV1(options.currentSource);
    assertIssuedProducerPerformancePortV1(options.performance);
    assertIssuedProducerTerminalPortV1(options.terminal);
    this.#options = options;
    this.#idlePromise = Promise.resolve();
  }

  async submit(raw: ProducerHeadInputV1): Promise<ProducerSubmissionResultV1> {
    const input = this.#normalizeInput(raw);
    return this.#enqueue(async () => this.#submit(input));
  }

  async invalidateHead(rawHead: CanonicalHead, reason: "same_height_reorg" | "explicit_invalidation" = "explicit_invalidation"): Promise<void> {
    const head = exactHead(rawHead, "invalidate.head");
    await this.#enqueue(async () => {
      const targets: InternalItem<Session>[] = [];
      if (this.#active !== null && this.#matchesInvalidation(this.#active, head, reason)) targets.push(this.#active);
      if (this.#pending !== null && this.#matchesInvalidation(this.#pending, head, reason)) targets.push(this.#pending);
      for (const target of targets) {
        target.cancellationReason = reason;
        target.controller.abort(reason);
        if (this.#pending === target) {
          this.#pending = null;
          await this.#emitTerminal(target, "cancelled", reason, [], null, null, null);
        }
      }
      this.#resolveIdleIfClosed();
    });
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise !== null) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      await this.#enqueue(async () => {
        if (this.#state === "closed") return;
        this.#state = "draining";
        if (this.#pending !== null) {
          const pending = this.#pending;
          this.#pending = null;
          this.#dropped += 1;
          try {
            await this.#emitTerminal(pending, "dropped", "shutdown_pending_dropped", [], null, null, null);
          } finally {
            if (this.#active !== null) {
              this.#active.cancellationReason ??= "shutdown_active_cancelled";
              this.#active.controller.abort("shutdown");
            }
          }
        } else if (this.#active !== null) {
          this.#active.cancellationReason ??= "shutdown_active_cancelled";
          this.#active.controller.abort("shutdown");
        }
        this.#resolveIdleIfClosed();
      });
      await this.#idlePromise;
      await this.#enqueue(async () => {
        this.#state = "closed";
        this.#resolveIdleIfClosed();
      });
    })();
    return this.#shutdownPromise;
  }

  async waitForIdle(): Promise<void> {
    await this.#controlTail;
    if (this.#active === null && this.#pending === null) return;
    await this.#idlePromise;
  }

  telemetry(): ProducerRuntimeTelemetryV1 {
    return Object.freeze({
      state: this.#state,
      submitted: this.#submitted,
      accepted: this.#accepted,
      started: this.#started,
      completed: this.#completed,
      dropped: this.#dropped,
      failed: this.#failed,
      cancelled: this.#cancelled,
      terminalCount: this.#terminals.length,
      active: this.#active?.input.head ?? null,
      pending: this.#pending?.input.head ?? null,
      fatal: this.#fatal !== null,
    });
  }

  terminals(): readonly ProducerHeadTerminalCapabilityV1[] {
    return Object.freeze([...this.#terminals]);
  }

  get accepting(): boolean {
    return this.#state === "accepting" && this.#fatal === null;
  }

  #normalizeInput(raw: ProducerHeadInputV1): InternalItem<Session>["input"] {
    if (raw === null || typeof raw !== "object") throw new TypeError("producer head input is required");
    const allowedKeys = new Set(["head", "revision", "sourceHeadSeenAtMs", "sourceHeadSeenMonotonicMs", "blockscanInput", "backrunInput"]);
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== "string" || !allowedKeys.has(key)) throw new TypeError(`producer head input contains unknown field ${String(key)}`);
    }
    const head = exactHead(raw.head, "producer.head");
    const revision = exactRevision(raw.revision ?? "0", "producer.revision");
    return Object.freeze({
      head,
      revision,
      sourceHeadSeenAtMs: validObservation(raw.sourceHeadSeenAtMs, "sourceHeadSeenAtMs"),
      sourceHeadSeenMonotonicMs: validObservation(raw.sourceHeadSeenMonotonicMs, "sourceHeadSeenMonotonicMs"),
      blockscanInput: raw.blockscanInput,
      backrunInput: raw.backrunInput,
    });
  }

  async #submit(input: InternalItem<Session>["input"]): Promise<ProducerSubmissionResultV1> {
    this.#submitted += 1;
    const sequence = (++this.#sequence).toString();
    const acceptedId = hashDomain("aloha/producer-admission/v1", {
      sequence,
      head: input.head,
      revision: input.revision,
    });
    const item: InternalItem<Session> = {
      input,
      sequence,
      acceptedId,
      eligibleBinding: null,
      controller: new AbortController(),
      sessionOwner: this.#options.sessionOwner,
      cancellationReason: null,
      terminalEmitted: false,
      executionPromise: null,
      eligibleHead: undefined,
    };
    if (this.#state !== "accepting" || this.#fatal !== null) {
      const terminal = await this.#emitTerminal(item, "rejected", "shutdown_rejected", [], null, null, null);
      return Object.freeze({ accepted: false, acceptedId, terminal });
    }
    try {
      const eligibleHead = await this.#options.performance.acceptEligibleHead({
        head: item.input.head,
        revision: item.input.revision,
      });
      const binding = this.#options.performance.readEligibleHeadBinding(eligibleHead);
      if (binding.headHash !== item.input.head.hash || binding.revision !== item.input.revision) {
        throw new TypeError("producer performance admission binding mismatch");
      }
      item.eligibleHead = eligibleHead;
      item.eligibleBinding = binding;
    } catch (error) {
      this.#enterFatal(error);
      const terminal = await this.#emitTerminal(
        item,
        "failed",
        "performance_append_failed",
        [],
        null,
        null,
        null,
      );
      return Object.freeze({ accepted: false, acceptedId, terminal });
    }
    if (this.#active !== null && this.#sameHeightReorg(this.#active, item)) {
      await this.#cancelActiveForReorg();
    }
    if (this.#pending !== null && this.#sameHeightReorg(this.#pending, item)) {
      const pending = this.#pending;
      this.#pending = null;
      this.#dropped += 1;
      pending.cancellationReason = "same_height_reorg";
      pending.controller.abort("same-height-reorg");
      await this.#emitTerminal(pending, "cancelled", "same_height_reorg", [], null, null, null);
    }
    if (this.#latestSubmitted !== null && compareHeadItems(item, this.#latestSubmitted) <= 0) {
      this.#dropped += 1;
      const terminal = await this.#emitTerminal(item, "dropped", "scheduler_coalesced", [], null, null, null);
      return Object.freeze({ accepted: false, acceptedId, terminal });
    }
    this.#latestSubmitted = item;
    if (this.#active !== null) {
      if (this.#pending !== null) {
        const previous = this.#pending;
        if (compareHeadItems(item, previous) <= 0) {
          this.#dropped += 1;
          const terminal = await this.#emitTerminal(item, "dropped", "scheduler_coalesced", [], null, null, null);
          return Object.freeze({ accepted: false, acceptedId, terminal });
        }
        this.#pending = null;
        this.#dropped += 1;
        await this.#emitTerminal(previous, "dropped", "scheduler_coalesced", [], null, null, null);
      }
      this.#pending = item;
      this.#accepted += 1;
      return Object.freeze({ accepted: true, acceptedId, terminal: null });
    }
    this.#accepted += 1;
    this.#markBusy();
    this.#active = item;
    this.#startActive(item);
    return Object.freeze({ accepted: true, acceptedId, terminal: null });
  }

  async #cancelActiveForReorg(): Promise<void> {
    if (this.#active === null) return;
    this.#active.cancellationReason = "same_height_reorg";
    this.#active.controller.abort("same-height-reorg");
  }

  #sameHeightReorg(left: InternalItem<Session>, right: InternalItem<Session>): boolean {
    return left.input.head.number === right.input.head.number && !sameHead(left.input.head, right.input.head);
  }

  #matchesInvalidation(item: InternalItem<Session>, head: CanonicalHead, reason: "same_height_reorg" | "explicit_invalidation"): boolean {
    return reason === "same_height_reorg"
      ? item.input.head.number === head.number && !sameHead(item.input.head, head)
      : item.input.head.number === head.number && sameHead(item.input.head, head);
  }

  #startActive(item: InternalItem<Session>): void {
    this.#started += 1;
    item.executionPromise = this.#execute(item);
    void item.executionPromise;
  }

  async #execute(item: InternalItem<Session>): Promise<void> {
    let laneOutcomes: ProducerLaneOutcomeV1[] = [];
    let generationId: string | null = null;
    let graphRoot: Hash | null = null;
    let currentSourcePhysical: ProducerCurrentSourcePhysicalFactsV1 | null = null;
    let status: ProducerTerminalStatusV1 = "completed";
    let reason: ProducerTerminalReasonV1 = "completed";
    let facts: ProducerHeadFactsV1 | undefined;
    let factsCapability: ProducerHeadFactsCapabilityV1 | null = null;
    let performanceBindAttempted = false;
    // Provisional admission itself is durable. Even when startup never opens
    // a session, the performance owner must receive the exact incomplete
    // terminal instead of silently losing this denominator head.
    let performanceBound = item.eligibleHead !== undefined;
    try {
      const runResult = await item.sessionOwner.withProducerSession(item.input.head, async session => {
        generationId = session.generationId;
        graphRoot = session.lease.binding.graphRoot;
        const sessionBoundEligibleHead = await this.#options.performance.bindEligibleHeadSession({
          eligibleHead: item.eligibleHead,
          session,
        });
        if (sessionBoundEligibleHead !== undefined) item.eligibleHead = sessionBoundEligibleHead;
        if (item.controller.signal.aborted) throw new ProducerCancelledError();
        const requestBase = {
          session,
          head: item.input.head,
          revision: item.input.revision,
          generationId: session.generationId,
          graphRoot: session.lease.binding.graphRoot,
          signal: item.controller.signal,
        } as const;
        const results = await Promise.all([
          this.#runLane(this.#options.blockscan, { ...requestBase, kind: "blockscan", input: item.input.blockscanInput }),
          this.#runLane(this.#options.backrun, { ...requestBase, kind: "backrun", input: item.input.backrunInput }),
        ]);
        try {
          const sealed = await this.#options.currentSource.closeHead(session);
          assertIssuedCurrentSourceRpcPhysicalFactsV1(sealed);
          currentSourcePhysical = sealed;
        } catch {
          currentSourcePhysical = null;
        }
        // Lane completion and the physical current-source receipt are not a
        // canonical-head verdict.  Re-fence the owning session at the last
        // point before its results leave the session owner and can become a
        // complete head fact.
        await session.assertCurrent(item.controller.signal);
        return results;
      }, item.controller.signal);
      laneOutcomes = runResult;
      facts = mergeProducerLaneFactsV1({
        head: item.input.head,
        generationId,
        graphRoot,
        laneOutcomes,
        currentSourcePhysical,
        allowComplete: !item.controller.signal.aborted && item.cancellationReason === null,
      });
      factsCapability = issueProducerHeadFactsCapabilityV1(facts);
      performanceBindAttempted = true;
      const boundEligibleHead = await this.#options.performance.bindEligibleHeadFacts({ eligibleHead: item.eligibleHead, facts: factsCapability });
      if (boundEligibleHead !== undefined) item.eligibleHead = boundEligibleHead;
      performanceBound = true;
      reason = reasonForOutcomes(laneOutcomes);
      status = laneOutcomes.some(value => value.kind === "failed" || value.kind === "retryable") ? "failed" : "completed";
      if (status === "completed" && !facts.complete) {
        status = "failed";
        reason = "lane_failed";
      }
      if (item.controller.signal.aborted || item.cancellationReason !== null) {
        status = "cancelled";
        reason = item.cancellationReason ?? "explicit_invalidation";
      }
    } catch (error) {
      status = item.cancellationReason !== null || item.controller.signal.aborted ? "cancelled" : "failed";
      reason = item.cancellationReason ?? "startup_session_failed";
      if (error instanceof ProducerCancelledError && item.cancellationReason === null) reason = "explicit_invalidation";
    }
    if (item.eligibleHead !== undefined && !performanceBindAttempted && generationId !== null) {
      facts = mergeProducerLaneFactsV1({
        head: item.input.head,
        generationId,
        graphRoot,
        laneOutcomes,
        currentSourcePhysical,
        allowComplete: false,
      });
      factsCapability = issueProducerHeadFactsCapabilityV1(facts);
      try {
        performanceBindAttempted = true;
        const boundEligibleHead = await this.#options.performance.bindEligibleHeadFacts({ eligibleHead: item.eligibleHead, facts: factsCapability });
        if (boundEligibleHead !== undefined) item.eligibleHead = boundEligibleHead;
        performanceBound = true;
      } catch {
        status = "failed";
        reason = "performance_append_failed";
        this.#enterFatal(new Error("producer performance fact bind failed"));
      }
    }
    let terminalCapability = this.#issueTerminal(item, status, reason, laneOutcomes, generationId, graphRoot, factsCapability);
    if (item.eligibleHead !== undefined && performanceBound) {
      try {
        await this.#options.performance.sealHeadTerminal({
          eligibleHead: item.eligibleHead,
          terminal: terminalCapability,
        });
      } catch (error) {
        this.#enterFatal(error);
        // A rejected acknowledgement cannot distinguish a pre-append failure
        // from a durable append whose acknowledgement was lost. Preserve the
        // exact terminal capability and never retry under a different identity.
      }
    }
    await this.#enqueue(async () => {
      await this.#finishActive(item, terminalCapability);
    });
  }

  async #runLane(
    lane: ProducerLanePortV1<Session>,
    input: ProducerLaneRunInputV1<Session>,
  ): Promise<ProducerLaneOutcomeV1> {
    try {
      const backrunIntake = input.kind === "backrun"
        ? (() => {
          try { return readIssuedProducerBackrunIntakeV1(input.input); }
          catch { return null; }
        })()
        : null;
      if (input.kind === "backrun" && backrunIntake === null) {
        return Object.freeze({ kind: "failed", reasonCode: "backrun-intake-not-owner-issued" });
      }
      const result = exactLaneOutcome(await lane.run(input), `producer.${input.kind}.outcome`);
      if (result.facts !== undefined) assertIssuedProducerLaneFactsV1(result.facts);
      if (backrunIntake?.kind === "observed-empty" && result.kind !== "no-input") {
        return Object.freeze({ kind: "failed", reasonCode: "missing-explicit-no-input-fact" });
      }
      if (backrunIntake?.kind !== "observed-empty" && result.kind === "no-input") {
        return Object.freeze({ kind: "failed", reasonCode: "no-input-without-observed-absence" });
      }
      if (backrunIntake?.kind === "unavailable" && result.kind !== "retryable" && result.kind !== "failed") {
        return Object.freeze({ kind: "failed", reasonCode: "unavailable-pending-observation-was-treated-as-complete" });
      }
      return result;
    } catch (error) {
      if (input.signal.aborted) return Object.freeze({ kind: "cancelled", reasonCode: "aborted" });
      return Object.freeze({ kind: "failed", reasonCode: error instanceof Error ? error.message : "lane-failed" });
    }
  }

  #buildTerminal(
    item: InternalItem<Session>,
    status: ProducerTerminalStatusV1,
    reason: ProducerTerminalReasonV1,
    laneOutcomes: readonly ProducerLaneOutcomeV1[],
    generationId: string | null,
    graphRoot: Hash | null,
  ): ProducerTerminalV1 {
    const laneSummary = Object.freeze([
      {
        kind: "blockscan" as const,
        outcome: laneOutcomes[0]?.kind ?? "failed" as const,
        reasonCode: laneOutcomes[0]?.reasonCode ?? null,
      },
      {
        kind: "backrun" as const,
        outcome: laneOutcomes[1]?.kind ?? "failed" as const,
        reasonCode: laneOutcomes[1]?.reasonCode ?? null,
      },
    ]);
    const base = {
      acceptedId: item.acceptedId,
      sequence: item.sequence,
      ordinal: item.eligibleBinding?.ordinal ?? "0",
      head: item.input.head,
      revision: item.input.revision,
      status,
      reason,
      generationId,
      graphRoot,
      laneOutcomes: laneSummary,
    } as const;
    return Object.freeze({ kind: "aloha.producer-terminal-v1" as const, terminalId: terminalId(base), ...base });
  }

  #issueTerminal(
    item: InternalItem<Session>,
    status: ProducerTerminalStatusV1,
    reason: ProducerTerminalReasonV1,
    laneOutcomes: readonly ProducerLaneOutcomeV1[],
    generationId: string | null,
    graphRoot: Hash | null,
    facts: ProducerHeadFactsCapabilityV1 | null,
  ): ProducerHeadTerminalCapabilityV1 {
    return issueProducerHeadTerminalCapabilityV1({
      terminal: this.#buildTerminal(item, status, reason, laneOutcomes, generationId, graphRoot),
      facts,
    });
  }

  async #emitTerminal(
    item: InternalItem<Session> | (InternalItem<Session> & { readonly eligibleHead?: unknown }),
    status: ProducerTerminalStatusV1,
    reason: ProducerTerminalReasonV1,
    laneOutcomes: readonly ProducerLaneOutcomeV1[],
    generationId: string | null,
    graphRoot: Hash | null,
    facts: ProducerHeadFactsCapabilityV1 | null,
  ): Promise<ProducerHeadTerminalCapabilityV1> {
    if (item.terminalEmitted) throw new Error("producer terminal already emitted");
    let finalStatus = status;
    let finalReason = reason;
    let finalFacts = facts;
    let performanceBound = false;
    if (item.eligibleHead !== undefined) {
      if (finalFacts === null) {
        finalFacts = issueProducerHeadFactsCapabilityV1(mergeProducerLaneFactsV1({
          head: item.input.head,
          generationId,
          graphRoot,
          laneOutcomes,
          currentSourcePhysical: null,
          allowComplete: false,
        }));
      }
      try {
        const rebound = await this.#options.performance.bindEligibleHeadFacts({
          eligibleHead: item.eligibleHead,
          facts: finalFacts,
        });
        if (rebound !== undefined) item.eligibleHead = rebound;
        performanceBound = true;
      } catch (error) {
        finalStatus = "failed";
        finalReason = "performance_append_failed";
        this.#enterFatal(error);
      }
    }
    let terminal = this.#issueTerminal(
      item,
      finalStatus,
      finalReason,
      laneOutcomes,
      generationId,
      graphRoot,
      finalFacts,
    );
    if (item.eligibleHead !== undefined && performanceBound) {
      try {
        await this.#options.performance.sealHeadTerminal({ eligibleHead: item.eligibleHead, terminal });
      } catch (error) {
        this.#enterFatal(error);
        // Seal failure is an uncertain commit. Keep the same capability for
        // the producer journal so a durable performance append cannot diverge.
      }
    }
    await this.#appendTerminal(item, terminal);
    return terminal;
  }

  async #appendTerminal(
    item: InternalItem<Session>,
    terminal: ProducerHeadTerminalCapabilityV1,
  ): Promise<void> {
    if (item.terminalEmitted) throw new Error("producer terminal already emitted");
    assertIssuedProducerHeadTerminalCapabilityV1(terminal);
    try {
      await this.#options.terminal.appendTerminal({ terminal });
    } catch (error) {
      const priorFatal = this.#fatal;
      this.#enterFatal(error);
      if (priorFatal !== null && priorFatal !== error) {
        throw new AggregateError(
          [priorFatal, error],
          "producer terminal append failed after an earlier fatal error",
          { cause: priorFatal },
        );
      }
      throw error;
    }
    item.terminalEmitted = true;
    this.#terminals.push(terminal);
    const evidence = readIssuedProducerHeadTerminalCapabilityV1(terminal);
    if (evidence.terminal.status === "failed") this.#failed += 1;
    if (evidence.terminal.status === "cancelled") this.#cancelled += 1;
  }

  async #finishActive(
    item: InternalItem<Session>,
    terminal: ProducerHeadTerminalCapabilityV1,
  ): Promise<void> {
    if (this.#active !== item) return;
    if (item.terminalEmitted) throw new Error("producer active terminal already emitted");
    try {
      await this.#appendTerminal(item, terminal);
      if (readIssuedProducerHeadTerminalCapabilityV1(terminal).terminal.status === "completed") this.#completed += 1;
      if (this.#fatal !== null && this.#pending !== null) {
        const pending = this.#pending;
        this.#pending = null;
        this.#dropped += 1;
        await this.#emitTerminal(pending, "failed", "performance_append_failed", [], null, null, null);
      }
    } catch (error) {
      this.#enterFatal(error);
      throw error;
    } finally {
      this.#active = null;
      if (this.#fatal === null && this.#state === "accepting" && this.#pending !== null) {
        const next = this.#pending;
        this.#pending = null;
        this.#markBusy();
        this.#active = next;
        this.#startActive(next);
      }
      this.#resolveIdleIfClosed();
    }
  }

  #enterFatal(error: unknown): void {
    if (this.#fatal === null) this.#fatal = error;
    if (this.#state === "accepting") this.#state = "draining";
    this.#active?.controller.abort("producer-fatal");
    this.#pending?.controller.abort("producer-fatal");
  }

  #resolveIdleIfClosed(): void {
    if (this.#active === null && this.#pending === null && this.#idlePending) {
      const resolve = this.#resolveIdle;
      this.#idlePending = false;
      resolve();
    }
  }

  #markBusy(): void {
    if (this.#idlePending) return;
    this.#idlePending = true;
    this.#idlePromise = new Promise<void>(resolve => { this.#resolveIdle = resolve; });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#controlTail.then(operation);
    this.#controlTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

class ProducerCancelledError extends Error {}

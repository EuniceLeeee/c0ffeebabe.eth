import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodePerformanceAdmissionOrphanReplacementLineage,
  decodePerformanceWindowCommitment,
  encodeHardwareProfileObservationV1,
  PERFORMANCE_ELIGIBILITY_RULE_HASH,
  PERFORMANCE_TARGET_COUNT,
  hashProcessLogAnchor,
  type HardwareProfileObservationV1,
  type PerformanceWindowCommitmentV1,
  type PerformanceAdmissionOrphanReplacementLineageV1,
  type ProductionPerformanceProfileV1,
} from "../../../../specs/performance/src/index.ts";
import {
  abortProcessResourceObservationClaim,
  claimProcessResourceObservation,
  commitProcessResourceObservationClaim,
  ProcessResourceObserver,
  ProcessResourceObservationSamplePendingError,
  readClaimedProcessResourceObservation,
  type ProcessResourceObservationCapabilityV1,
  type ProcessResourceObservationClaimCapabilityV1,
  type ProcessResourceObservationHandleV1,
  type ProcessResourceObservationV1,
  type ProcessResourceObservationReaderPortV1,
  type ProcessResourceScopeCapabilityV1,
} from "../../../../packages/process-resource-observer/src/index.ts";
import { createProcessResourceScopeOwner } from "../../../../packages/process-resource-observer/src/internal/scope-owner.ts";
import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
  SchedulerPerformanceCursorCapabilityV1,
  SchedulerPerformanceRangeCapabilityV1,
  SchedulerPerformanceRangeFactV1,
  SchedulerWorkCompletionCapabilityV1,
  SchedulerWorkCompletionFactV1,
  SchedulerWorkCompletionHandleV1,
} from "../../../../packages/scheduler/src/index.ts";
import {
  acknowledgeQualifiedSchedulerPerformanceRange,
  issueQualifiedSharedSchedulerPerformanceReaderPort,
  openQualifiedSchedulerPerformanceCursor,
  readQualifiedSchedulerPerformanceRange,
  readQualifiedSchedulerWorkCompletionCapability,
  readQualifiedSchedulerWorkCompletionHandle,
  sealQualifiedSchedulerPerformanceRange,
  type QualifiedSharedSchedulerPerformanceReaderPortV1,
  type QualifiedSharedSchedulerRuntimePortV1,
} from "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts";
import {
  issueRevmWorkerResourceObservationPort,
} from "../../../../runtime/revm-workers/src/internal/resource-observation.ts";
import { RevmWorkerPool } from "../../../../runtime/revm-workers/src/lifecycle.ts";
import {
  readIssuedProducerHeadSchedulerCompletionV1,
  readIssuedProducerHeadTerminalCapabilityV1,
  type ProducerHeadTerminalCapabilityV1,
} from "../../../../packages/producer/src/index.ts";
import {
  assertIssuedStartupRuntime,
  type StartupRuntimeV1,
} from "../../../../packages/startup-runtime/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import {
  readRuntimeReleasePerformancePolicyPortV1,
  type RuntimeReleasePerformancePolicyPortV1,
} from "./performance-policy-owner.ts";

export type RuntimeReleasePerformanceWindowCapabilityV1 = object;
export type RuntimeReleasePerformanceHeadHandleV1 = object;
export type RuntimeReleasePerformanceHeadCapabilityV1 = object;
export type RuntimeReleasePerformanceHeadClaimCapabilityV1 = object;

/**
 * The release-owned physical resource scope is still active but does not yet
 * contain a real event-loop sample. Consumers may yield and retry sealHead on
 * the same handle; no scheduler range or head capability has been sealed.
 */
export class RuntimeReleasePerformanceHeadSamplePendingError extends Error {
  constructor() {
    super("runtime-release performance head is awaiting an event-loop sample");
    this.name = "RuntimeReleasePerformanceHeadSamplePendingError";
  }
}

export interface RuntimeReleasePerformanceHeadFactsV1 {
  readonly schedulerRange: SchedulerPerformanceRangeFactV1;
  readonly schedulerCompletions: readonly SchedulerWorkCompletionFactV1[];
  readonly selectedSchedulerCompletion: SchedulerWorkCompletionFactV1 | null;
  readonly resource: ProcessResourceObservationV1;
}

export interface RuntimeReleasePerformanceWindowFactsV1 {
  readonly profile: ProductionPerformanceProfileV1;
  readonly eligibilityRuleHash: Hash;
  readonly providerRoot: Hash;
  readonly hardwareProfile: HardwareProfileObservationV1;
  readonly profileArtifactSha256: Hash;
  readonly hardwareArtifactSha256: Hash;
}

export interface RuntimeReleasePerformanceServingV1 {
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly sourceCoverageRoot: Hash;
}

export interface RuntimeReleasePerformanceRuntimeServiceV1 {
  readonly readWindowBasis: () => RuntimeReleasePerformanceWindowFactsV1;
  readonly openWindow: (input: {
    readonly startup: StartupRuntimeV1;
    readonly commitment: PerformanceWindowCommitmentV1;
  }) => RuntimeReleasePerformanceWindowCapabilityV1;
  readonly openHead: (
    window: RuntimeReleasePerformanceWindowCapabilityV1,
    input: { readonly admissionId: Hash; readonly headHash: Hash; readonly ordinal: string; readonly revision: "0"; readonly serving: RuntimeReleasePerformanceServingV1 },
  ) => RuntimeReleasePerformanceHeadHandleV1;
  readonly openReplacementHead: (
    window: RuntimeReleasePerformanceWindowCapabilityV1,
    lineage: PerformanceAdmissionOrphanReplacementLineageV1,
    serving: RuntimeReleasePerformanceServingV1,
  ) => RuntimeReleasePerformanceHeadHandleV1;
  readonly readWindow: (
    window: RuntimeReleasePerformanceWindowCapabilityV1,
  ) => RuntimeReleasePerformanceWindowFactsV1;
  readonly sealHead: (
    window: RuntimeReleasePerformanceWindowCapabilityV1,
    head: RuntimeReleasePerformanceHeadHandleV1,
  ) => RuntimeReleasePerformanceHeadCapabilityV1;
  readonly claimHead: (
    window: RuntimeReleasePerformanceWindowCapabilityV1,
    head: RuntimeReleasePerformanceHeadCapabilityV1,
    input: { readonly terminal: ProducerHeadTerminalCapabilityV1 },
  ) => RuntimeReleasePerformanceHeadClaimCapabilityV1;
  readonly readClaim: (claim: RuntimeReleasePerformanceHeadClaimCapabilityV1) => RuntimeReleasePerformanceHeadFactsV1;
  readonly readClaimBinding: (claim: RuntimeReleasePerformanceHeadClaimCapabilityV1) => RuntimeReleasePerformanceHeadClaimBindingV1;
  readonly commitClaim: (claim: RuntimeReleasePerformanceHeadClaimCapabilityV1) => void;
  readonly abortClaim: (claim: RuntimeReleasePerformanceHeadClaimCapabilityV1) => void;
}

export interface RuntimeReleasePerformanceHeadClaimBindingV1 {
  readonly admissionId: Hash;
  readonly headHash: Hash;
  readonly ordinal: string;
  readonly revision: string;
  readonly terminalId: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly readyRecordHash: Hash;
}

interface ServiceStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly authorityVersion: bigint;
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly schedulerIssuer: QualifiedExecutorAuthorityIssuer;
  readonly schedulerCapability: QualifiedExecutorAuthorityCapability;
  readonly schedulerReader: QualifiedSharedSchedulerPerformanceReaderPortV1;
  readonly windowFacts: RuntimeReleasePerformanceWindowFactsV1;
  readonly workerResourcePort: ReturnType<typeof issueRevmWorkerResourceObservationPort>;
  window: RuntimeReleasePerformanceWindowCapabilityV1 | null;
}

interface WindowStateV1 {
  readonly service: RuntimeReleasePerformanceRuntimeServiceV1;
  readonly startup: StartupRuntimeV1;
  readonly commitment: PerformanceWindowCommitmentV1;
  nextOrdinal: bigint;
  activeHead: RuntimeReleasePerformanceHeadHandleV1 | null;
  pendingHead: RuntimeReleasePerformanceHeadCapabilityV1 | null;
  lastCommittedHead: Readonly<{
    admissionId: Hash;
    headHash: Hash;
    ordinal: string;
    revision: string;
    terminalId: Hash;
  }> | null;
}

interface HeadStateV1 {
  readonly window: RuntimeReleasePerformanceWindowCapabilityV1;
  readonly admissionId: Hash;
  readonly headHash: Hash;
  readonly ordinal: string;
  readonly revision: string;
  readonly replacementLineageId: Hash | null;
  readonly serving: RuntimeReleasePerformanceServingV1;
  readonly observer: ProcessResourceObserver;
  readonly resourceReader: ProcessResourceObservationReaderPortV1;
  readonly scope: ProcessResourceScopeCapabilityV1;
  readonly observationHandle: ProcessResourceObservationHandleV1;
  readonly schedulerCursor: SchedulerPerformanceCursorCapabilityV1;
  sealed: boolean;
}

interface SealedHeadStateV1 {
  readonly window: RuntimeReleasePerformanceWindowCapabilityV1;
  readonly admissionId: Hash;
  readonly headHash: Hash;
  readonly ordinal: string;
  readonly revision: string;
  readonly replacementLineageId: Hash | null;
  readonly serving: RuntimeReleasePerformanceServingV1;
  readonly resourceReader: ProcessResourceObservationReaderPortV1;
  readonly schedulerRange: SchedulerPerformanceRangeCapabilityV1;
  readonly resource: ProcessResourceObservationCapabilityV1;
  claim: RuntimeReleasePerformanceHeadClaimCapabilityV1 | null;
  consumed: boolean;
}

interface ClaimStateV1 {
  readonly service: RuntimeReleasePerformanceRuntimeServiceV1;
  readonly head: RuntimeReleasePerformanceHeadCapabilityV1;
  readonly terminalId: Hash;
  readonly resourceClaim: ProcessResourceObservationClaimCapabilityV1;
  readonly selectedSchedulerCompletion: SchedulerWorkCompletionCapabilityV1 | null;
  status: "active" | "committed" | "aborted";
}

const services = new WeakMap<object, ServiceStateV1>();
const windows = new WeakMap<object, WindowStateV1>();
const heads = new WeakMap<object, HeadStateV1>();
const sealedHeads = new WeakMap<object, SealedHeadStateV1>();
const claims = new WeakMap<object, ClaimStateV1>();
const ZERO_HASH = `0x${"0".repeat(64)}`;

function nonZeroHash(value: unknown, path: string): Hash {
  const hash = assertHash(value, path);
  if (hash === ZERO_HASH) throw new TypeError(`${path} must be non-zero`);
  return hash;
}

function exactServing(value: RuntimeReleasePerformanceServingV1, path: string): RuntimeReleasePerformanceServingV1 {
  assertExactKeys(value, ["generationId", "graphRoot", "readyRecordHash", "sourceCoverageRoot"], path);
  if (typeof value.generationId !== "string" || value.generationId.length === 0) {
    throw new TypeError(`${path}.generationId must be non-empty`);
  }
  return Object.freeze({
    generationId: value.generationId,
    graphRoot: nonZeroHash(value.graphRoot, `${path}.graphRoot`),
    readyRecordHash: nonZeroHash(value.readyRecordHash, `${path}.readyRecordHash`),
    sourceCoverageRoot: nonZeroHash(value.sourceCoverageRoot, `${path}.sourceCoverageRoot`),
  });
}

function sameServing(left: RuntimeReleasePerformanceServingV1, right: RuntimeReleasePerformanceServingV1): boolean {
  return left.generationId === right.generationId
    && left.graphRoot === right.graphRoot
    && left.readyRecordHash === right.readyRecordHash
    && left.sourceCoverageRoot === right.sourceCoverageRoot;
}

function servingFromStartup(
  startup: StartupRuntimeV1,
  serving: RuntimeReleasePerformanceServingV1,
): RuntimeReleasePerformanceServingV1 {
  const proposed = exactServing(serving, "runtimeReleasePerformanceServing");
  const issued = startup.readServingGeneration(proposed.generationId);
  const resolved = exactServing({
    generationId: issued.generationId,
    graphRoot: issued.graphRoot,
    readyRecordHash: issued.readyRecordHash,
    sourceCoverageRoot: issued.sourceCoverageRoot,
  }, "runtimeReleasePerformanceStartupServing");
  if (!sameServing(proposed, resolved)) throw new TypeError("performance head serving does not match startup authority");
  return resolved;
}

function currentService(service: RuntimeReleasePerformanceRuntimeServiceV1): ServiceStateV1 {
  const state = services.get(service);
  if (state === undefined) throw new TypeError("runtime-release performance service is not owner-issued");
  const current = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (current.version !== state.authorityVersion
    || current.binding.bindingId !== state.bindingId
    || runtimeReleaseBindingProvenanceHash(current.binding) !== state.releaseProvenanceHash) {
    throw new TypeError("runtime-release performance service is stale");
  }
  return state;
}

function currentWindow(
  service: RuntimeReleasePerformanceRuntimeServiceV1,
  value: RuntimeReleasePerformanceWindowCapabilityV1,
): WindowStateV1 {
  currentService(service);
  const state = windows.get(value);
  if (state === undefined || state.service !== service) throw new TypeError("performance window is not owner-issued by this release");
  return state;
}

function activeClaim(
  service: RuntimeReleasePerformanceRuntimeServiceV1,
  value: RuntimeReleasePerformanceHeadClaimCapabilityV1,
): ClaimStateV1 {
  const serviceState = currentService(service);
  const claim = claims.get(value);
  if (claim === undefined || claim.service !== service || claim.status !== "active") throw new TypeError("performance head claim is not active");
  const sealed = sealedHeads.get(claim.head);
  if (sealed === undefined || sealed.claim !== value || sealed.consumed) throw new TypeError("performance head claim is stale");
  // Validate the qualified reader binding before returning any fact.
  readQualifiedSchedulerPerformanceRange(
    serviceState.schedulerReader,
    sealed.schedulerRange,
    serviceState.schedulerIssuer,
    serviceState.schedulerCapability,
  );
  return claim;
}

function openPerformanceHead(
  service: RuntimeReleasePerformanceRuntimeServiceV1,
  window: RuntimeReleasePerformanceWindowCapabilityV1,
  windowState: WindowStateV1,
  input: Readonly<{
    admissionId: Hash;
    headHash: Hash;
    ordinal: string;
    revision: string;
    replacementLineageId: Hash | null;
    serving: RuntimeReleasePerformanceServingV1;
  }>,
): RuntimeReleasePerformanceHeadHandleV1 {
  const serviceState = currentService(service);
  const serving = servingFromStartup(windowState.startup, input.serving);
  const scopeOwner = createProcessResourceScopeOwner({
    processLogAnchorHash: hashProcessLogAnchor(windowState.commitment.processLogAnchor),
    windowId: windowState.commitment.windowId,
    generationId: serving.generationId,
  });
  const observer = new ProcessResourceObserver({
    scopeReaderPort: scopeOwner.scopeReaderPort,
    workerResourcePort: serviceState.workerResourcePort,
  });
  const resourceReader = observer.issueReaderPort();
  const scope = scopeOwner.issueHeadScope({ admissionId: input.admissionId, ordinal: input.ordinal });
  const schedulerCursor = openQualifiedSchedulerPerformanceCursor(
    serviceState.schedulerReader,
    serviceState.schedulerIssuer,
    serviceState.schedulerCapability,
  );
  const observationHandle = observer.open(scope);
  const head = Object.freeze(Object.create(null)) as RuntimeReleasePerformanceHeadHandleV1;
  heads.set(head, {
    window,
    admissionId: input.admissionId,
    headHash: input.headHash,
    ordinal: input.ordinal,
    revision: input.revision,
    replacementLineageId: input.replacementLineageId,
    serving,
    observer,
    resourceReader,
    scope,
    observationHandle,
    schedulerCursor,
    sealed: false,
  });
  windowState.activeHead = head;
  return head;
}

export function issueRuntimeReleasePerformanceRuntimeService(input: {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly schedulerRuntime: QualifiedSharedSchedulerRuntimePortV1;
  readonly schedulerIssuer: QualifiedExecutorAuthorityIssuer;
  readonly schedulerCapability: QualifiedExecutorAuthorityCapability;
  readonly workerPool: RevmWorkerPool;
  readonly providerRoot: Hash;
  readonly policy: RuntimeReleasePerformancePolicyPortV1;
}): RuntimeReleasePerformanceRuntimeServiceV1 {
  assertExactKeys(input, [
    "authority", "schedulerRuntime", "schedulerIssuer", "schedulerCapability", "workerPool", "providerRoot",
    "policy",
  ], "runtimeReleasePerformanceOwner");
  if (!(input.workerPool instanceof RevmWorkerPool)) throw new TypeError("runtime-release performance owner requires the real REVM pool");
  const authorityState = assertActiveRuntimeReleaseAuthorityState(input.authority);
  const policy = readRuntimeReleasePerformancePolicyPortV1(input.authority, input.policy);
  const { performanceProfile: profile, hardwareProfile } = policy;
  const releaseProvenanceHash = runtimeReleaseBindingProvenanceHash(authorityState.binding);
  const providerRoot = nonZeroHash(input.providerRoot, "runtimeReleasePerformanceOwner.providerRoot");
  if (policy.providerRoot !== providerRoot) {
    throw new TypeError("runtime-release deployment performance basis mismatch");
  }
  const schedulerReader = issueQualifiedSharedSchedulerPerformanceReaderPort({
    runtimePort: input.schedulerRuntime,
    issuer: input.schedulerIssuer,
    capability: input.schedulerCapability,
  });
  const workerResourcePort = issueRevmWorkerResourceObservationPort(input.workerPool);
  const windowFacts = Object.freeze({
    profile,
    eligibilityRuleHash: PERFORMANCE_ELIGIBILITY_RULE_HASH,
    providerRoot,
    hardwareProfile,
    profileArtifactSha256: policy.profileArtifactSha256,
    hardwareArtifactSha256: policy.hardwareArtifactSha256,
  });
  let service: RuntimeReleasePerformanceRuntimeServiceV1;
  service = Object.freeze({
    readWindowBasis() {
      currentService(service);
      return windowFacts;
    },
    openWindow(windowInput: Parameters<RuntimeReleasePerformanceRuntimeServiceV1["openWindow"]>[0]) {
      const state = currentService(service);
      assertExactKeys(windowInput, ["startup", "commitment"], "runtimeReleasePerformanceWindow");
      assertIssuedStartupRuntime(windowInput.startup);
      if (state.window !== null) throw new TypeError("runtime-release performance window is already open");
      if (windowInput.startup.releaseBindingId !== state.bindingId
        || windowInput.startup.ready.releaseProvenanceHash !== state.releaseProvenanceHash) {
        throw new TypeError("performance window startup release mismatch");
      }
      const commitment = decodePerformanceWindowCommitment(windowInput.commitment);
      if (commitment.eligibilityRuleHash !== windowFacts.eligibilityRuleHash
        || commitment.performanceProfileHash !== windowFacts.profile.profileHash
        || commitment.providerRoot !== windowFacts.providerRoot
        || commitment.hardwareProfileRoot !== windowFacts.hardwareProfile.profileRoot
        || commitment.targetCount !== PERFORMANCE_TARGET_COUNT
        || commitment.releaseBindingId !== state.bindingId
        || commitment.releaseProvenanceHash !== state.releaseProvenanceHash
        || commitment.processLogAnchor.commitSha !== authorityState.binding.candidateReleaseCommit) {
        throw new TypeError("performance window commitment does not match the release-owned basis");
      }
      const window = Object.freeze(Object.create(null)) as RuntimeReleasePerformanceWindowCapabilityV1;
      windows.set(window, {
        service,
        startup: windowInput.startup,
        commitment,
        nextOrdinal: 1n,
        activeHead: null,
        pendingHead: null,
        lastCommittedHead: null,
      });
      state.window = window;
      return window;
    },
    openHead(
      window: RuntimeReleasePerformanceWindowCapabilityV1,
      headInput: Parameters<RuntimeReleasePerformanceRuntimeServiceV1["openHead"]>[1],
    ) {
      const windowState = currentWindow(service, window);
      assertExactKeys(headInput, ["admissionId", "headHash", "ordinal", "revision", "serving"], "runtimeReleasePerformanceHead");
      if (windowState.activeHead !== null || windowState.pendingHead !== null) throw new TypeError("performance head is already active or awaiting durable acknowledgement");
      const ordinal = assertDecimalString(headInput.ordinal, "runtimeReleasePerformanceHead.ordinal");
      if (BigInt(ordinal) !== windowState.nextOrdinal || BigInt(ordinal) > BigInt(PERFORMANCE_TARGET_COUNT)) {
        throw new TypeError("performance head ordinal is not the next committed denominator position");
      }
      const headHash = nonZeroHash(headInput.headHash, "runtimeReleasePerformanceHead.headHash");
      if (headInput.revision !== "0") throw new TypeError("initial performance head revision must be zero");
      if (ordinal === "1" && headHash !== windowState.commitment.windowStartAnchor.hash) {
        throw new TypeError("first performance head does not match the committed window start anchor");
      }
      const head = openPerformanceHead(service, window, windowState, {
        admissionId: nonZeroHash(headInput.admissionId, "runtimeReleasePerformanceHead.admissionId"),
        headHash,
        ordinal,
        revision: "0",
        replacementLineageId: null,
        serving: headInput.serving,
      });
      windowState.nextOrdinal += 1n;
      return head;
    },
    openReplacementHead(
      window: RuntimeReleasePerformanceWindowCapabilityV1,
      rawLineage: Parameters<RuntimeReleasePerformanceRuntimeServiceV1["openReplacementHead"]>[1],
      serving: Parameters<RuntimeReleasePerformanceRuntimeServiceV1["openReplacementHead"]>[2],
    ) {
      const windowState = currentWindow(service, window);
      if (windowState.activeHead !== null || windowState.pendingHead !== null) {
        throw new TypeError("performance replacement requires the orphan scope to be fully committed");
      }
      const lineage = decodePerformanceAdmissionOrphanReplacementLineage(rawLineage);
      const orphan = windowState.lastCommittedHead;
      if (orphan === null
        || orphan.admissionId !== lineage.orphanAdmissionId
        || orphan.headHash !== lineage.orphanCanonicalHead.hash
        || orphan.ordinal !== lineage.ordinal
        || orphan.revision !== lineage.orphanRevision
        || orphan.terminalId !== lineage.orphanProducerTerminalId
        || BigInt(lineage.ordinal) !== windowState.nextOrdinal - 1n) {
        throw new TypeError("performance replacement does not bind the last committed orphan scope");
      }
      return openPerformanceHead(service, window, windowState, {
        admissionId: lineage.replacementAdmissionId,
        headHash: lineage.replacementCanonicalHead.hash,
        ordinal: lineage.ordinal,
        revision: lineage.replacementRevision,
        replacementLineageId: lineage.lineageId,
        serving,
      });
    },
    readWindow(window: RuntimeReleasePerformanceWindowCapabilityV1) {
      currentWindow(service, window);
      return windowFacts;
    },
    sealHead(window: RuntimeReleasePerformanceWindowCapabilityV1, head: RuntimeReleasePerformanceHeadHandleV1) {
      const serviceState = currentService(service);
      const windowState = currentWindow(service, window);
      const headState = heads.get(head);
      if (headState === undefined || headState.window !== window || windowState.activeHead !== head || headState.sealed) {
        throw new TypeError("performance head handle is not active in this window");
      }
      // Resource seal is retryable until the event-loop observer has at least
      // one sample.  The scheduler range is sealed only after it succeeds.
      let resource: ProcessResourceObservationCapabilityV1;
      try {
        resource = headState.observer.seal(headState.observationHandle, headState.scope);
      } catch (error) {
        if (error instanceof ProcessResourceObservationSamplePendingError) {
          throw new RuntimeReleasePerformanceHeadSamplePendingError();
        }
        throw error;
      }
      const schedulerRange = sealQualifiedSchedulerPerformanceRange(
        serviceState.schedulerReader,
        headState.schedulerCursor,
        serviceState.schedulerIssuer,
        serviceState.schedulerCapability,
      );
      headState.sealed = true;
      windowState.activeHead = null;
      const capability = Object.freeze(Object.create(null)) as RuntimeReleasePerformanceHeadCapabilityV1;
      sealedHeads.set(capability, {
        window,
        admissionId: headState.admissionId,
        headHash: headState.headHash,
        ordinal: headState.ordinal,
        revision: headState.revision,
        replacementLineageId: headState.replacementLineageId,
        serving: headState.serving,
        resourceReader: headState.resourceReader,
        schedulerRange,
        resource,
        claim: null,
        consumed: false,
      });
      windowState.pendingHead = capability;
      return capability;
    },
    claimHead(
      window: RuntimeReleasePerformanceWindowCapabilityV1,
      head: RuntimeReleasePerformanceHeadCapabilityV1,
      claimInput: Parameters<RuntimeReleasePerformanceRuntimeServiceV1["claimHead"]>[2],
    ) {
      const serviceState = currentService(service);
      const windowState = currentWindow(service, window);
      assertExactKeys(claimInput, ["terminal"], "runtimeReleasePerformanceHeadClaim");
      const sealed = sealedHeads.get(head);
      if (sealed === undefined || sealed.window !== window || windowState.pendingHead !== head || sealed.consumed) throw new TypeError("performance head is not pending in this window");
      if (sealed.claim !== null) throw new TypeError("performance head is already claimed");
      const observedRange = readQualifiedSchedulerPerformanceRange(
        serviceState.schedulerReader,
        sealed.schedulerRange,
        serviceState.schedulerIssuer,
        serviceState.schedulerCapability,
      );
      const terminalEvidence = readIssuedProducerHeadTerminalCapabilityV1(claimInput.terminal);
      if (terminalEvidence.terminal.head.hash !== sealed.headHash
        || terminalEvidence.terminal.ordinal !== sealed.ordinal
        || terminalEvidence.terminal.revision !== sealed.revision
        || terminalEvidence.terminal.generationId !== sealed.serving.generationId
        || terminalEvidence.terminal.graphRoot !== sealed.serving.graphRoot) {
        throw new TypeError("performance head Producer terminal binding mismatch");
      }
      const selectedHandle = readIssuedProducerHeadSchedulerCompletionV1(claimInput.terminal) as SchedulerWorkCompletionHandleV1 | null;
      const selected = selectedHandle === null
        ? null
        : readQualifiedSchedulerWorkCompletionHandle(
          serviceState.schedulerReader,
          selectedHandle,
          serviceState.schedulerIssuer,
          serviceState.schedulerCapability,
        );
      if (selected !== null && !observedRange.completions.includes(selected)) throw new TypeError("scheduler completion is outside the sealed head range");
      const resourceClaim = claimProcessResourceObservation(sealed.resourceReader, sealed.resource);
      const claim = Object.freeze(Object.create(null)) as RuntimeReleasePerformanceHeadClaimCapabilityV1;
      sealed.claim = claim;
      claims.set(claim, {
        service,
        head,
        terminalId: terminalEvidence.terminal.terminalId,
        resourceClaim,
        selectedSchedulerCompletion: selected,
        status: "active",
      });
      return claim;
    },
    readClaim(claimValue: RuntimeReleasePerformanceHeadClaimCapabilityV1) {
      const serviceState = currentService(service);
      const claim = activeClaim(service, claimValue);
      const sealed = sealedHeads.get(claim.head)!;
      const observedRange = readQualifiedSchedulerPerformanceRange(
        serviceState.schedulerReader,
        sealed.schedulerRange,
        serviceState.schedulerIssuer,
        serviceState.schedulerCapability,
      );
      const selectedSchedulerCompletion = claim.selectedSchedulerCompletion === null
        ? null
        : readQualifiedSchedulerWorkCompletionCapability(
          serviceState.schedulerReader,
          claim.selectedSchedulerCompletion,
          serviceState.schedulerIssuer,
          serviceState.schedulerCapability,
        );
      const schedulerCompletions = Object.freeze(observedRange.completions.map(completion =>
        readQualifiedSchedulerWorkCompletionCapability(
          serviceState.schedulerReader,
          completion,
          serviceState.schedulerIssuer,
          serviceState.schedulerCapability,
        )));
      const resource = readClaimedProcessResourceObservation(sealed.resourceReader, claim.resourceClaim);
      return Object.freeze({ schedulerRange: observedRange.fact, schedulerCompletions, selectedSchedulerCompletion, resource });
    },
    readClaimBinding(claimValue: RuntimeReleasePerformanceHeadClaimCapabilityV1) {
      const claim = activeClaim(service, claimValue);
      const sealed = sealedHeads.get(claim.head)!;
      return Object.freeze({
        admissionId: sealed.admissionId,
        headHash: sealed.headHash,
        ordinal: sealed.ordinal,
        revision: sealed.revision,
        terminalId: claim.terminalId,
        generationId: sealed.serving.generationId,
        graphRoot: sealed.serving.graphRoot,
        readyRecordHash: sealed.serving.readyRecordHash,
      });
    },
    commitClaim(claimValue: RuntimeReleasePerformanceHeadClaimCapabilityV1) {
      const serviceState = currentService(service);
      const claim = activeClaim(service, claimValue);
      const sealed = sealedHeads.get(claim.head)!;
      const windowState = windows.get(sealed.window)!;
      // Both commits are synchronous and prevalidated above, so no release
      // rotation or writer await can split this process-local acknowledgement.
      commitProcessResourceObservationClaim(sealed.resourceReader, claim.resourceClaim);
      acknowledgeQualifiedSchedulerPerformanceRange(
        serviceState.schedulerReader,
        sealed.schedulerRange,
        serviceState.schedulerIssuer,
        serviceState.schedulerCapability,
      );
      claim.status = "committed";
      sealed.claim = null;
      sealed.consumed = true;
      windowState.pendingHead = null;
      windowState.lastCommittedHead = Object.freeze({
        admissionId: sealed.admissionId,
        headHash: sealed.headHash,
        ordinal: sealed.ordinal,
        revision: sealed.revision,
        terminalId: claim.terminalId,
      });
    },
    abortClaim(claimValue: RuntimeReleasePerformanceHeadClaimCapabilityV1) {
      const claim = activeClaim(service, claimValue);
      const sealed = sealedHeads.get(claim.head)!;
      const windowState = windows.get(sealed.window)!;
      abortProcessResourceObservationClaim(sealed.resourceReader, claim.resourceClaim);
      claim.status = "aborted";
      sealed.claim = null;
    },
  });
  services.set(service, {
    authority: input.authority,
    authorityVersion: authorityState.version,
    bindingId: authorityState.binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(authorityState.binding),
    schedulerIssuer: input.schedulerIssuer,
    schedulerCapability: input.schedulerCapability,
    schedulerReader,
    workerResourcePort,
    windowFacts,
    window: null,
  });
  return service;
}

export function assertIssuedRuntimeReleasePerformanceRuntimeService(
  value: unknown,
): asserts value is RuntimeReleasePerformanceRuntimeServiceV1 {
  if (value === null || typeof value !== "object") throw new TypeError("runtime-release performance service is not owner-issued");
  currentService(value as RuntimeReleasePerformanceRuntimeServiceV1);
}

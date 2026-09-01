import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  readIssuedSearchTerminalCapabilityV1,
  readIssuedSearchTerminalSixStepArtifactCapabilitiesV1,
  readIssuedSearchTerminalSixStepTraceV1,
  searchTerminalEvidenceHashV2,
  type ProductionSixStepArtifactCapabilitiesV1,
  type SearchTerminalCapabilityV1,
  type SearchTerminalSixStepTraceV1,
} from "../../../../packages/search-pipeline/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import type { RuntimeReleaseStrategyRuntimeServiceV1 } from "./strategy-runtime-owner.ts";
import { assertIssuedRuntimeReleaseStrategyRuntimeService } from "./strategy-runtime-owner.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import { readRuntimeReleaseEconomicEvaluatorBindingV1 } from "./economic-safety-owner.ts";
import type {
  EconomicSafetyFinalizationServiceV1,
  EconomicSafetyObjectiveTemplateV1,
  EconomicSafetyActionOwnerPolicyV1,
  EconomicSafetyValuationOwnerDescriptorV1,
} from "../../../economics-safety/src/index.ts";
import type { EconomicSafetyExecutorQualificationV1 } from "../../../economics-safety/src/evaluator.ts";
import type { SafetyProfileV1 } from "../../../../specs/economic-safety-profile/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";
import { readActiveSignedRuntimeAuthorityDescriptorV1 } from "./runtime-authority-descriptor-owner.ts";

export type RuntimeReleaseSixStepTerminalBindingCapabilityV1 = object;

export interface EconomicEvaluatorBindingObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.six-step-economic-evaluator-binding-observation-v1";
  readonly runtimeBindingId: Hash;
  readonly candidateReleaseCommit: string;
  readonly releaseProvenanceHash: Hash;
  readonly authorityRoot: Hash;
  readonly implementationHash: Hash;
  readonly policyRoot: Hash;
  readonly evaluatorExportIdentityHash: Hash;
  readonly objectiveTemplates: readonly EconomicSafetyObjectiveTemplateV1[];
  readonly actionOwners: readonly EconomicSafetyActionOwnerPolicyV1[];
  readonly valuationOwners: readonly EconomicSafetyValuationOwnerDescriptorV1[];
  readonly executorQualification: EconomicSafetyExecutorQualificationV1;
  readonly safetyProfile: SafetyProfileV1;
  readonly observationRoot: Hash;
}

export interface RuntimeReleaseSixStepTerminalBindingV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-release-six-step-terminal-binding-v1";
  readonly runtimeBindingId: Hash;
  readonly candidateReleaseCommit: string;
  readonly releaseProvenanceHash: Hash;
  readonly economicEvaluatorAuthorityRoot: Hash;
  readonly economicEvaluatorImplementationHash: Hash;
  readonly economicEvaluatorBindingObservation: EconomicEvaluatorBindingObservationV1;
  readonly definitionCatalogRoot: Hash;
  readonly strategyCompositionRoot: Hash;
  readonly searchTerminalHash: Hash;
  readonly terminalLineageHash: Hash;
  readonly traceRoot: Hash;
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly graphRoot: Hash;
  readonly currentSource: SearchTerminalSixStepTraceV1["resolved"]["source"];
  readonly planningProblemHash: Hash;
  readonly routeCandidateId: Hash;
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly trace: SearchTerminalSixStepTraceV1;
  readonly bindingRoot: Hash;
}

export interface RuntimeReleaseSixStepTerminalBindingServiceV1 {
  readonly bindSuccessfulTerminal: (
    terminal: SearchTerminalCapabilityV1,
  ) => RuntimeReleaseSixStepTerminalBindingCapabilityV1;
}

interface ServiceStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly version: bigint;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly economicEvaluatorAuthorityRoot: Hash;
  readonly economicEvaluatorImplementationHash: Hash;
  readonly economicEvaluatorPolicyRoot: Hash;
  readonly economicEvaluatorExportIdentityHash: Hash;
  readonly economicEvaluatorObjectiveTemplates: readonly EconomicSafetyObjectiveTemplateV1[];
  readonly economicEvaluatorActionOwners: readonly EconomicSafetyActionOwnerPolicyV1[];
  readonly economicEvaluatorValuationOwners: readonly EconomicSafetyValuationOwnerDescriptorV1[];
  readonly economicEvaluatorExecutorQualification: EconomicSafetyExecutorQualificationV1;
  readonly economicEvaluatorSafetyProfile: SafetyProfileV1;
  readonly economicEvaluatorAvailable: boolean;
  readonly candidateReleaseCommit: string;
  readonly definitionCatalogRoot: Hash;
  readonly strategyCompositionRoot: Hash;
  readonly consumedTerminals: WeakSet<object>;
}

interface CapabilityStateV1 extends Omit<ServiceStateV1, "consumedTerminals"> {
  readonly binding: RuntimeReleaseSixStepTerminalBindingV1;
  readonly artifacts: ProductionSixStepArtifactCapabilitiesV1;
}

const services = new WeakMap<object, ServiceStateV1>();
const capabilities = new WeakMap<object, CapabilityStateV1>();

function currentRelease(state: Omit<ServiceStateV1, "consumedTerminals">): void {
  const current = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (current.version !== state.version
    || current.binding.bindingId !== state.runtimeBindingId
    || current.binding.candidateReleaseCommit !== state.candidateReleaseCommit
    || runtimeReleaseBindingProvenanceHash(current.binding) !== state.releaseProvenanceHash) {
    throw new TypeError("runtime-release Six-Step terminal authority is stale after rotation");
  }
}

function currentService(value: RuntimeReleaseSixStepTerminalBindingServiceV1): ServiceStateV1 {
  const state = services.get(value);
  if (state === undefined) throw new TypeError("runtime-release Six-Step terminal service is not owner-issued");
  currentRelease(state);
  return state;
}

function currentCapability(
  value: RuntimeReleaseSixStepTerminalBindingCapabilityV1,
): CapabilityStateV1 {
  if (value === null || typeof value !== "object" || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError("runtime-release Six-Step terminal binding capability is invalid");
  }
  const state = capabilities.get(value);
  if (state === undefined) throw new TypeError("runtime-release Six-Step terminal binding capability was not issued");
  currentRelease(state);
  return state;
}

function canonicalRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be a canonical object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function economicEvaluatorObservation(state: ServiceStateV1): EconomicEvaluatorBindingObservationV1 {
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.six-step-economic-evaluator-binding-observation-v1" as const,
    runtimeBindingId: state.runtimeBindingId,
    candidateReleaseCommit: state.candidateReleaseCommit,
    releaseProvenanceHash: state.releaseProvenanceHash,
    authorityRoot: state.economicEvaluatorAuthorityRoot,
    implementationHash: state.economicEvaluatorImplementationHash,
    policyRoot: state.economicEvaluatorPolicyRoot,
    evaluatorExportIdentityHash: state.economicEvaluatorExportIdentityHash,
    objectiveTemplates: state.economicEvaluatorObjectiveTemplates,
    actionOwners: state.economicEvaluatorActionOwners,
    valuationOwners: state.economicEvaluatorValuationOwners,
    executorQualification: state.economicEvaluatorExecutorQualification,
    safetyProfile: state.economicEvaluatorSafetyProfile,
  });
  return deepFreeze({
    ...payload,
    observationRoot: hashDomain("aloha/six-step-economic-evaluator-binding-observation/v1", payload),
  });
}

function sameSource(
  left: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: string; readonly stateRoot: string }>,
  right: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: string; readonly stateRoot: string }>,
): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function sealBinding(
  state: ServiceStateV1,
  terminalCapability: SearchTerminalCapabilityV1,
): RuntimeReleaseSixStepTerminalBindingV1 {
  const terminal = readIssuedSearchTerminalCapabilityV1(terminalCapability);
  if (terminal.kind !== "unsigned-dry-run") {
    throw new TypeError("runtime-release Six-Step binding requires a successful unsigned dry-run terminal");
  }
  const trace = readIssuedSearchTerminalSixStepTraceV1(terminalCapability);
  const leaseBinding = canonicalRecord(trace.resolved.binding, "sixStepTerminal.trace.resolved.binding");
  const program = canonicalRecord(trace.resolved.executionProgram, "sixStepTerminal.trace.resolved.executionProgram");
  const simulation = canonicalRecord(trace.resolved.finalSimulation, "sixStepTerminal.trace.resolved.finalSimulation");
  const economicSafety = canonicalRecord(trace.resolved.economicSafety, "sixStepTerminal.trace.resolved.economicSafety");
  const planningProblem = canonicalRecord(trace.planningProblem, "sixStepTerminal.trace.planningProblem");
  const routeCandidate = canonicalRecord(trace.routeCandidate, "sixStepTerminal.trace.routeCandidate");
  assertExactKeys(leaseBinding, [
    "generationId", "readyRecordHash", "generationRefreshPolicyHash", "cutoff",
    "definitionCatalogRoot", "instanceCatalogRoot", "graphRoot", "runtimeAuthority", "releaseProvenanceHash",
    "candidatePartitionProofStorageHash", "nominationClosureRoot", "nominationClosureStorageHash",
  ], "sixStepTerminal.trace.resolved.binding");
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(leaseBinding.runtimeAuthority);
  const expectedRuntimeAuthority = projectRuntimeAuthorityDescriptorV1(
    readActiveSignedRuntimeAuthorityDescriptorV1(state.authority),
  );
  if (leaseBinding.releaseProvenanceHash !== state.releaseProvenanceHash
    || encodeCanonicalJson(runtimeAuthority) !== encodeCanonicalJson(expectedRuntimeAuthority)
    || leaseBinding.definitionCatalogRoot !== state.definitionCatalogRoot
    || leaseBinding.generationId !== terminal.receipt.generationId
    || leaseBinding.readyRecordHash !== terminal.receipt.readyRecordHash
    || leaseBinding.graphRoot !== terminal.receipt.graphRoot
    || trace.strategyCompositionRoot !== state.strategyCompositionRoot
    || trace.resolved.correlationId !== terminal.receipt.correlationId
    || trace.resolved.routeCandidateId !== terminal.receipt.candidateId
    || trace.planningProblemHash !== planningProblem.problemHash
    || trace.planningProblemHash !== routeCandidate.planningProblemHash
    || trace.resolved.routeCandidateId !== routeCandidate.candidateId
    || !sameSource(trace.resolved.source, terminal.receipt.source)
    || program.programHash !== terminal.receipt.programHash
    || simulation.receiptHash !== terminal.receipt.finalSimulationReceiptHash
    || economicSafety.authorityRoot !== state.economicEvaluatorAuthorityRoot
    || economicSafety.implementationHash !== state.economicEvaluatorImplementationHash
    || economicSafety.releaseProvenanceHash !== state.releaseProvenanceHash) {
    throw new TypeError("runtime-release Six-Step terminal lineage mismatch");
  }
  const searchTerminalHash = searchTerminalEvidenceHashV2(terminal);
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-six-step-terminal-binding-v1" as const,
    runtimeBindingId: state.runtimeBindingId,
    candidateReleaseCommit: state.candidateReleaseCommit,
    releaseProvenanceHash: state.releaseProvenanceHash,
    economicEvaluatorAuthorityRoot: state.economicEvaluatorAuthorityRoot,
    economicEvaluatorImplementationHash: state.economicEvaluatorImplementationHash,
    economicEvaluatorBindingObservation: economicEvaluatorObservation(state),
    definitionCatalogRoot: state.definitionCatalogRoot,
    strategyCompositionRoot: state.strategyCompositionRoot,
    searchTerminalHash,
    terminalLineageHash: terminal.receipt.lineageHash,
    traceRoot: trace.traceRoot,
    correlationId: trace.resolved.correlationId,
    generationId: terminal.receipt.generationId,
    readyRecordHash: terminal.receipt.readyRecordHash,
    graphRoot: terminal.receipt.graphRoot,
    currentSource: trace.resolved.source,
    planningProblemHash: trace.planningProblemHash,
    routeCandidateId: trace.resolved.routeCandidateId,
    programHash: assertHash(program.programHash, "sixStepTerminal.programHash"),
    finalSimulationReceiptHash: assertHash(simulation.receiptHash, "sixStepTerminal.finalSimulationReceiptHash"),
    trace,
  });
  return deepFreeze({
    ...payload,
    bindingRoot: hashDomain("aloha/runtime-release-six-step-terminal-binding/v1", payload as unknown as CanonicalJson),
  });
}

export function issueRuntimeReleaseSixStepTerminalBindingServiceV1(
  authority: RuntimeReleaseAuthorityV1,
  strategyRuntime: RuntimeReleaseStrategyRuntimeServiceV1,
  economicSafety: EconomicSafetyFinalizationServiceV1,
): RuntimeReleaseSixStepTerminalBindingServiceV1 {
  const current = assertActiveRuntimeReleaseAuthorityState(authority);
  assertIssuedRuntimeReleaseStrategyRuntimeService(strategyRuntime);
  const strategy = strategyRuntime.readMetadata();
  const economicEvaluator = readRuntimeReleaseEconomicEvaluatorBindingV1(authority, economicSafety);
  const releaseProvenanceHash = runtimeReleaseBindingProvenanceHash(current.binding);
  if (strategy.releaseProvenanceHash !== releaseProvenanceHash) {
    throw new TypeError("runtime-release Six-Step Strategy service belongs to another release");
  }
  const state: ServiceStateV1 = Object.freeze({
    authority,
    version: current.version,
    runtimeBindingId: current.binding.bindingId,
    releaseProvenanceHash,
    economicEvaluatorAuthorityRoot: economicEvaluator.authorityRoot,
    economicEvaluatorImplementationHash: economicEvaluator.implementationHash,
    economicEvaluatorPolicyRoot: economicEvaluator.policyRoot,
    economicEvaluatorExportIdentityHash: economicEvaluator.evaluatorExportIdentityHash,
    economicEvaluatorObjectiveTemplates: economicEvaluator.templates,
    economicEvaluatorActionOwners: economicEvaluator.actionOwners,
    economicEvaluatorValuationOwners: economicEvaluator.valuationOwners,
    economicEvaluatorExecutorQualification: economicEvaluator.executorQualification,
    economicEvaluatorSafetyProfile: economicEvaluator.safetyProfile,
    economicEvaluatorAvailable: economicEvaluator.available,
    candidateReleaseCommit: current.binding.candidateReleaseCommit,
    definitionCatalogRoot: strategy.definitionCatalogRoot,
    strategyCompositionRoot: strategy.compositionRoot,
    consumedTerminals: new WeakSet<object>(),
  });
  let service: RuntimeReleaseSixStepTerminalBindingServiceV1;
  service = Object.freeze({
    bindSuccessfulTerminal(terminal: SearchTerminalCapabilityV1) {
      const active = currentService(service);
      if (!active.economicEvaluatorAvailable) throw new TypeError("runtime-release economic evaluator binding is unavailable");
      if (terminal === null || typeof terminal !== "object") throw new TypeError("search terminal capability is required");
      if (active.consumedTerminals.has(terminal)) throw new TypeError("search terminal Six-Step binding was already issued");
      const binding = sealBinding(active, terminal);
      const artifacts = readIssuedSearchTerminalSixStepArtifactCapabilitiesV1(terminal);
      active.consumedTerminals.add(terminal);
      const capability = Object.freeze(Object.create(null)) as RuntimeReleaseSixStepTerminalBindingCapabilityV1;
      capabilities.set(capability, Object.freeze({
        authority: active.authority,
        version: active.version,
        runtimeBindingId: active.runtimeBindingId,
        releaseProvenanceHash: active.releaseProvenanceHash,
        economicEvaluatorAuthorityRoot: active.economicEvaluatorAuthorityRoot,
        economicEvaluatorImplementationHash: active.economicEvaluatorImplementationHash,
        economicEvaluatorPolicyRoot: active.economicEvaluatorPolicyRoot,
        economicEvaluatorExportIdentityHash: active.economicEvaluatorExportIdentityHash,
        economicEvaluatorObjectiveTemplates: active.economicEvaluatorObjectiveTemplates,
        economicEvaluatorActionOwners: active.economicEvaluatorActionOwners,
        economicEvaluatorValuationOwners: active.economicEvaluatorValuationOwners,
        economicEvaluatorExecutorQualification: active.economicEvaluatorExecutorQualification,
        economicEvaluatorSafetyProfile: active.economicEvaluatorSafetyProfile,
        economicEvaluatorAvailable: active.economicEvaluatorAvailable,
        candidateReleaseCommit: active.candidateReleaseCommit,
        definitionCatalogRoot: active.definitionCatalogRoot,
        strategyCompositionRoot: active.strategyCompositionRoot,
        binding,
        artifacts,
      }));
      return capability;
    },
  });
  services.set(service, state);
  return service;
}

export function readRuntimeReleaseSixStepTerminalArtifactCapabilitiesV1(
  capability: RuntimeReleaseSixStepTerminalBindingCapabilityV1,
): ProductionSixStepArtifactCapabilitiesV1 {
  return currentCapability(capability).artifacts;
}

export function assertIssuedRuntimeReleaseSixStepTerminalBindingServiceV1(
  value: unknown,
): asserts value is RuntimeReleaseSixStepTerminalBindingServiceV1 {
  currentService(value as RuntimeReleaseSixStepTerminalBindingServiceV1);
}

export function readRuntimeReleaseSixStepTerminalBindingCapabilityV1(
  capability: RuntimeReleaseSixStepTerminalBindingCapabilityV1,
): RuntimeReleaseSixStepTerminalBindingV1 {
  const binding = currentCapability(capability).binding;
  const { bindingRoot: _bindingRoot, ...payload } = binding;
  if (binding.bindingRoot !== hashDomain("aloha/runtime-release-six-step-terminal-binding/v1", payload as unknown as CanonicalJson)) {
    throw new TypeError("runtime-release Six-Step terminal binding root mismatch");
  }
  if (encodeCanonicalJson(binding.trace).length === 0 || binding.trace.traceRoot !== binding.traceRoot) {
    throw new TypeError("runtime-release Six-Step terminal trace mismatch");
  }
  assertNonEmptyString(binding.candidateReleaseCommit, "sixStepTerminal.candidateReleaseCommit");
  return binding;
}

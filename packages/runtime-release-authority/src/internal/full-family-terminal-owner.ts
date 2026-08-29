import {
  assertExactKeys,
  deepFreeze,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  readIssuedProducerFinalFullFamilyTerminalSetV1,
  readIssuedProducerHeadTerminalCapabilityV1,
  type ProducerHeadTerminalCapabilityV1,
} from "../../../../packages/producer/src/index.ts";
import {
  readFinalDurableWindowBindingV1,
  type FinalDurableWindowCapabilityV1,
} from "../../../../packages/final-durable-window/src/index.ts";
import {
  readIssuedNativeFullFamilyAuditV1,
  readIssuedSearchTerminalCapabilityV1,
  readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1,
  type NativeFullFamilyAuditV1,
  type SearchTerminalCapabilityV1,
} from "../../../../packages/search-pipeline/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import {
  readGeneratedFamilyRuntimeFactoryMetadata,
  type GeneratedFamilyRuntimeFactoryV1,
} from "../../../family-composition/src/internal/generated-runtime-composition.ts";
import { sourcePlanIdentity, type SourcePlanRefV1 } from "../../../discovery/src/index.ts";
import { assertIssuedStartupRuntime, type StartupRuntimeV1 } from "../../../startup-runtime/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";

export type RuntimeReleaseFullFamilyTerminalBindingCapabilityV1 = object;

export interface RuntimeReleaseFullFamilyGeneratedMetadataV1 {
  readonly releaseIntentRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly runtimeDescriptorRoot: Hash;
  readonly families: readonly Readonly<{
    readonly familyId: string;
    readonly familyDefinitionHash: Hash;
    readonly sourcePlanRoot: Hash;
    readonly sourcePlanRefs: readonly SourcePlanRefV1[];
  }>[];
}

export interface RuntimeReleaseFullFamilyTerminalBindingV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-release-full-family-terminal-binding-v1";
  readonly runtimeBindingId: Hash;
  readonly candidateReleaseCommit: string;
  readonly releaseProvenanceHash: Hash;
  readonly finalDurableWindowId: Hash;
  readonly producerTerminalId: Hash;
  readonly producerHeadFactsRoot: Hash;
  readonly producerTerminalBindingRoot: Hash;
  readonly laneTerminalSetRoot: Hash;
  readonly searchTerminalHash: Hash;
  readonly terminalKind: "unsigned-dry-run" | "route-set-terminal";
  readonly terminalLineageHash: Hash;
  readonly nativeAuditRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  /** Release-owner projection from the exact generated runtime factory. */
  readonly generatedRuntime: RuntimeReleaseFullFamilyGeneratedMetadataV1;
  readonly readyCutoff: NativeFullFamilyAuditV1["binding"]["readyCutoff"];
  readonly actualCurrentSource: NativeFullFamilyAuditV1["binding"]["actualCurrentSource"];
  readonly audit: NativeFullFamilyAuditV1;
  readonly bindingRoot: Hash;
}

export interface RuntimeReleaseFullFamilyTerminalBindingServiceV1 {
  readonly bindFinalHead: (input: Readonly<{
    readonly headTerminal: ProducerHeadTerminalCapabilityV1;
    readonly finalDurableWindow: FinalDurableWindowCapabilityV1;
    readonly startup: StartupRuntimeV1;
  }>) => RuntimeReleaseFullFamilyTerminalBindingCapabilityV1;
}

interface ServiceStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly version: bigint;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: string;
  readonly generatedRuntime: RuntimeReleaseFullFamilyGeneratedMetadataV1;
  readonly consumedHeadTerminals: WeakSet<object>;
}

interface CapabilityStateV1 extends Omit<ServiceStateV1, "consumedHeadTerminals"> {
  readonly binding: RuntimeReleaseFullFamilyTerminalBindingV1;
}

const serviceStates = new WeakMap<object, ServiceStateV1>();
const capabilityStates = new WeakMap<object, CapabilityStateV1>();

function sameSource(
  left: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: string; readonly stateRoot: string }>,
  right: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: string; readonly stateRoot: string }>,
): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function currentService(value: RuntimeReleaseFullFamilyTerminalBindingServiceV1): ServiceStateV1 {
  const state = serviceStates.get(value);
  if (state === undefined) throw new TypeError("runtime-release full-family terminal service is not owner-issued");
  const current = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (current.version !== state.version
    || current.binding.bindingId !== state.runtimeBindingId
    || runtimeReleaseBindingProvenanceHash(current.binding) !== state.releaseProvenanceHash
    || current.binding.candidateReleaseCommit !== state.candidateReleaseCommit) {
    throw new TypeError("runtime-release full-family terminal service is stale after rotation");
  }
  return state;
}

function currentCapability(
  value: RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
): CapabilityStateV1 {
  if (value === null || typeof value !== "object" || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError("runtime-release full-family terminal binding capability is invalid");
  }
  const state = capabilityStates.get(value);
  if (state === undefined) throw new TypeError("runtime-release full-family terminal binding capability was not issued");
  const current = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (current.version !== state.version
    || current.binding.bindingId !== state.runtimeBindingId
    || runtimeReleaseBindingProvenanceHash(current.binding) !== state.releaseProvenanceHash
    || current.binding.candidateReleaseCommit !== state.candidateReleaseCommit) {
    throw new TypeError("runtime-release full-family terminal binding capability is stale after rotation");
  }
  return state;
}

function sealBinding(
  service: ServiceStateV1,
  headTerminalCapability: ProducerHeadTerminalCapabilityV1,
  finalDurableWindowCapability: FinalDurableWindowCapabilityV1,
  startup: StartupRuntimeV1,
): RuntimeReleaseFullFamilyTerminalBindingV1 {
  const finalWindow = readFinalDurableWindowBindingV1(finalDurableWindowCapability);
  assertIssuedStartupRuntime(startup);
  const ready = startup.readServingGeneration(finalWindow.serving.generationId);
  const headTerminal = readIssuedProducerHeadTerminalCapabilityV1(headTerminalCapability);
  const terminalSet = readIssuedProducerFinalFullFamilyTerminalSetV1(headTerminalCapability);
  const expectedTerminalBindingRoot = hashDomain("aloha/searcher-production-evidence-terminal-binding/v1", {
    terminalId: headTerminal.terminal.terminalId,
    headFactsRoot: terminalSet.producerHeadFactsRoot,
  });
  if (finalWindow.release.bindingId !== service.runtimeBindingId
    || finalWindow.release.releaseProvenanceHash !== service.releaseProvenanceHash
    || finalWindow.release.candidateReleaseCommit !== service.candidateReleaseCommit
    || startup.releaseBindingId !== service.runtimeBindingId
    || startup.candidateReleaseCommit !== service.candidateReleaseCommit
    || ready.releaseProvenanceHash !== service.releaseProvenanceHash
    || ready.definitionCatalogRoot !== service.generatedRuntime.definitionCatalogRoot
    || ready.generationId !== finalWindow.serving.generationId
    || ready.readyRecordHash !== finalWindow.serving.readyRecordHash
    || ready.graphRoot !== finalWindow.serving.graphRoot
    || ready.sourceCoverageRoot !== finalWindow.serving.sourceCoverageRoot
    || finalWindow.terminalId !== headTerminal.terminal.terminalId
    || finalWindow.terminalBindingRoot !== expectedTerminalBindingRoot
    || finalWindow.head.chainId !== headTerminal.terminal.head.chainId
    || finalWindow.head.number !== headTerminal.terminal.head.number
    || finalWindow.head.hash !== headTerminal.terminal.head.hash
    || finalWindow.head.parentHash !== headTerminal.terminal.head.parentHash
    || finalWindow.head.stateRoot !== headTerminal.terminal.head.stateRoot
    || finalWindow.revision !== headTerminal.terminal.revision
    || finalWindow.serving.generationId !== headTerminal.terminal.generationId
    || finalWindow.serving.graphRoot !== headTerminal.terminal.graphRoot) {
    throw new TypeError("final durable window/Producer terminal binding mismatch");
  }
  const terminalCapability: SearchTerminalCapabilityV1 = terminalSet.blockscanSearchTerminalCapability;
  const terminal = readIssuedSearchTerminalCapabilityV1(terminalCapability);
  const audit = readIssuedNativeFullFamilyAuditV1(
    readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1(terminalCapability),
  );
  const receipt = terminal.receipt;
  const accounting = terminal.kind === "unsigned-dry-run" ? terminal.accounting : terminal.receipt.accounting;
  if (audit.binding.releaseProvenanceHash !== service.releaseProvenanceHash) {
    throw new TypeError("search terminal audit belongs to another runtime release");
  }
  if (audit.binding.correlationId !== receipt.correlationId
    || audit.binding.generationId !== receipt.generationId
    || audit.binding.readyRecordHash !== receipt.readyRecordHash
    || finalWindow.serving.readyRecordHash !== receipt.readyRecordHash
    || audit.binding.graphRoot !== receipt.graphRoot
    || !sameSource(audit.binding.readyCutoff, receipt.cutoff)
    || !sameSource(audit.binding.actualCurrentSource, receipt.source)
    || audit.binding.planningProblemHash !== accounting.planningProblemHash
    || audit.binding.plannerEnumerationRoot !== accounting.enumerationRoot
    || audit.expectedCandidateCount !== String(accounting.entries.length)) {
    throw new TypeError("search terminal/native full-family audit binding mismatch");
  }
  const searchTerminalHash = hashDomain("aloha/search-terminal-evidence/v1", terminal);
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-full-family-terminal-binding-v1" as const,
    runtimeBindingId: service.runtimeBindingId,
    candidateReleaseCommit: service.candidateReleaseCommit,
    releaseProvenanceHash: service.releaseProvenanceHash,
    finalDurableWindowId: finalWindow.finalDurableWindowId,
    producerTerminalId: headTerminal.terminal.terminalId,
    producerHeadFactsRoot: terminalSet.producerHeadFactsRoot,
    producerTerminalBindingRoot: expectedTerminalBindingRoot,
    laneTerminalSetRoot: terminalSet.laneTerminalSetRoot,
    searchTerminalHash,
    terminalKind: terminal.kind,
    terminalLineageHash: receipt.lineageHash,
    nativeAuditRoot: audit.auditRoot,
    readyRecordHash: receipt.readyRecordHash,
    generationId: receipt.generationId,
    graphRoot: receipt.graphRoot,
    generatedRuntime: service.generatedRuntime,
    readyCutoff: receipt.cutoff,
    actualCurrentSource: receipt.source,
    audit,
  });
  return deepFreeze({
    ...payload,
    bindingRoot: hashDomain("aloha/runtime-release-full-family-terminal-binding/v1", payload),
  });
}

export function issueRuntimeReleaseFullFamilyTerminalBindingServiceV1(
  authority: RuntimeReleaseAuthorityV1,
  generatedFactory: GeneratedFamilyRuntimeFactoryV1,
): RuntimeReleaseFullFamilyTerminalBindingServiceV1 {
  const current = assertActiveRuntimeReleaseAuthorityState(authority);
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(generatedFactory);
  const generatedRuntime: RuntimeReleaseFullFamilyGeneratedMetadataV1 = deepFreeze({
    releaseIntentRoot: metadata.releaseIntentRoot,
    definitionCatalogRoot: metadata.definitionCatalogRoot,
    runtimeDescriptorRoot: metadata.descriptorRoot,
    families: metadata.families.map(family => ({
      familyId: family.familyId,
      familyDefinitionHash: family.familyDefinitionHash,
      sourcePlanRoot: family.sourcePlanRoot,
      sourcePlanRefs: [...family.sourcePlanRefs].sort((left, right) =>
        sourcePlanIdentity(left).localeCompare(sourcePlanIdentity(right))),
    })),
  });
  const state: ServiceStateV1 = Object.freeze({
    authority,
    version: current.version,
    runtimeBindingId: current.binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(current.binding),
    candidateReleaseCommit: current.binding.candidateReleaseCommit,
    generatedRuntime,
    consumedHeadTerminals: new WeakSet<object>(),
  });
  let service: RuntimeReleaseFullFamilyTerminalBindingServiceV1;
  service = Object.freeze({
    bindFinalHead(input: Readonly<{
      readonly headTerminal: ProducerHeadTerminalCapabilityV1;
      readonly finalDurableWindow: FinalDurableWindowCapabilityV1;
      readonly startup: StartupRuntimeV1;
    }>) {
      const active = currentService(service);
      assertExactKeys(input, ["headTerminal", "finalDurableWindow", "startup"], "fullFamilyTerminal.bindFinalHead");
      if (input.headTerminal === null || typeof input.headTerminal !== "object"
        || input.finalDurableWindow === null || typeof input.finalDurableWindow !== "object"
        || input.startup === null || typeof input.startup !== "object") {
        throw new TypeError("final Producer head, durable window, and Startup runtime capabilities are required");
      }
      if (active.consumedHeadTerminals.has(input.headTerminal)) {
        throw new TypeError("Producer head Full-Family binding was already issued");
      }
      const binding = sealBinding(active, input.headTerminal, input.finalDurableWindow, input.startup);
      active.consumedHeadTerminals.add(input.headTerminal);
      const capability = Object.freeze(Object.create(null)) as RuntimeReleaseFullFamilyTerminalBindingCapabilityV1;
      capabilityStates.set(capability, Object.freeze({
        authority: active.authority,
        version: active.version,
        runtimeBindingId: active.runtimeBindingId,
        releaseProvenanceHash: active.releaseProvenanceHash,
        candidateReleaseCommit: active.candidateReleaseCommit,
        generatedRuntime: active.generatedRuntime,
        binding,
      }));
      return capability;
    },
  });
  serviceStates.set(service, state);
  return service;
}

export function readRuntimeReleaseFullFamilyTerminalBindingCapabilityV1(
  capability: RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
): RuntimeReleaseFullFamilyTerminalBindingV1 {
  return currentCapability(capability).binding;
}

export function assertIssuedRuntimeReleaseFullFamilyTerminalBindingServiceV1(
  value: unknown,
): asserts value is RuntimeReleaseFullFamilyTerminalBindingServiceV1 {
  currentService(value as RuntimeReleaseFullFamilyTerminalBindingServiceV1);
}

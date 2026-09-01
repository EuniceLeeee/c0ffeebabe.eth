import {
  assertGeneratedStrategyRuntimeFactory,
  issueGeneratedStrategyRuntimeAuthorityCapability,
  issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability,
  readGeneratedStrategyRuntimeFactoryMetadata,
  type GeneratedStrategyRuntimeFactoryV1,
} from "../../../../packages/strategy-composition/src/internal/generated-runtime-composition.ts";
import {
  assertIssuedStrategyPlanningProblem,
  type IssuedStrategyPlanningProblemV1,
  type StrategyGraphBindingV1,
  type StrategyGraphEdgeV1,
  type StrategyPlanningLaneV1,
} from "../../../../packages/strategy-composition/src/index.ts";
import { issueStrategyPlanningTriggerCapabilityV1 } from "../../../../packages/strategy-composition/src/internal/trigger-owner.ts";
import {
  readIssuedProducerBoundTriggerV1,
  type ProducerBoundTriggerV1,
} from "../../../../packages/producer/src/index.ts";
import { assertHash, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import {
  assertActiveRuntimeReleaseAuthorityState,
} from "./state.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import { readActiveSignedRuntimeAuthorityDescriptorV1 } from "./runtime-authority-descriptor-owner.ts";
import {
  decodeUnsignedDryRunRuntimeAuthorityDescriptorV1,
  type UnsignedDryRunRuntimeAuthorityDescriptorV1,
} from "../../../../packages/runtime-authority/src/index.ts";

/**
 * The application receives this owner-issued service, never a raw generated
 * factory, structural StrategyRuntimeComposition, or Strategy trigger issuer.
 * The service consumes the Producer owner's opaque trigger and closes the
 * generated factory over the verified runtime-release capability.
 */
export interface RuntimeReleaseStrategyRuntimeMetadataV1 {
  readonly definitionCatalogRoot: Hash;
  readonly strategyCatalogRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly compositionRoot: Hash;
}

export interface RuntimeReleaseStrategyEvidenceExpectationV1 {
  readonly releaseProvenanceHash: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly strategyCatalogRoot: Hash;
  readonly strategyCompositionRoot: Hash;
  readonly strategyIssuerClosureRoot: Hash;
  readonly entries: ReturnType<typeof readGeneratedStrategyRuntimeFactoryMetadata>["strategies"];
}

export interface RuntimeReleaseStrategyPlanningRequestV1 {
  readonly trigger: ProducerBoundTriggerV1;
  readonly binding: StrategyGraphBindingV1;
  readonly edges: readonly StrategyGraphEdgeV1[];
  readonly expectedLane: StrategyPlanningLaneV1;
  readonly objectiveRef: Hash;
  readonly entryAssetRef: Hash;
  readonly returnAssetRef: Hash;
  readonly expectedCorrelationId: Hash;
  readonly expectedHeadHash: Hash;
}

export interface RuntimeReleaseStrategyPlanningResultV1 {
  readonly planningProblem: IssuedStrategyPlanningProblemV1;
  readonly strategyCompositionRoot: Hash;
}

export interface RuntimeReleaseStrategyRuntimeServiceV1 {
  readonly readMetadata: () => RuntimeReleaseStrategyRuntimeMetadataV1;
  readonly readEvidenceExpectation: () => RuntimeReleaseStrategyEvidenceExpectationV1;
  readonly issuePlanningProblem: (
    input: RuntimeReleaseStrategyPlanningRequestV1,
  ) => RuntimeReleaseStrategyPlanningResultV1;
}

function issuePlanningProblemFromComposition(
  composition: ReturnType<GeneratedStrategyRuntimeFactoryV1>,
  assertCurrent: () => void,
  input: RuntimeReleaseStrategyPlanningRequestV1,
  runtimeMembershipHash: Hash,
  releaseProvenanceHash?: Hash,
): RuntimeReleaseStrategyPlanningResultV1 {
  assertCurrent();
  const producerTrigger = readIssuedProducerBoundTriggerV1(input.trigger);
  const expectedHeadHash = assertHash(input.expectedHeadHash, "strategyRuntime.expectedHeadHash");
  const expectedCorrelationId = assertHash(input.expectedCorrelationId, "strategyRuntime.expectedCorrelationId");
  const objectiveRef = assertHash(input.objectiveRef, "strategyRuntime.objectiveRef");
  const entryAssetRef = assertHash(input.entryAssetRef, "strategyRuntime.entryAssetRef");
  const returnAssetRef = assertHash(input.returnAssetRef, "strategyRuntime.returnAssetRef");
  if (entryAssetRef !== returnAssetRef) throw new TypeError("Strategy closed-loop objective asset boundary mismatch");
  if (producerTrigger.lane !== input.expectedLane) throw new TypeError("Strategy producer trigger lane mismatch");
  if (producerTrigger.headHash !== expectedHeadHash) throw new TypeError("Strategy producer trigger head mismatch");
  if (producerTrigger.correlationId !== expectedCorrelationId) throw new TypeError("Strategy producer trigger correlation mismatch");
  if (producerTrigger.generationId !== input.binding.generationId) throw new TypeError("Strategy producer trigger generation mismatch");
  if (producerTrigger.graphRoot !== input.binding.graphRoot) throw new TypeError("Strategy producer trigger Graph mismatch");
  if (input.binding.sourceHash !== expectedHeadHash) throw new TypeError("Strategy Graph binding head mismatch");
  const trigger = issueStrategyPlanningTriggerCapabilityV1({
    binding: input.binding,
    lane: producerTrigger.lane,
    triggerRef: producerTrigger.triggerRef,
    objectiveRef,
    entryAssetRef,
    returnAssetRef,
    affectedEdgeIds: producerTrigger.affectedEdgeIds,
    correlationId: producerTrigger.correlationId,
  });
  const matches = composition.issuePlanningProblems({ binding: input.binding, edges: input.edges, trigger })
    .filter(problem => problem.lane === input.expectedLane
      && problem.objectiveRef === objectiveRef
      && problem.entryAssetRef === entryAssetRef
      && problem.returnAssetRef === returnAssetRef
      && problem.triggerCorrelationId === expectedCorrelationId
      && problem.triggerHeadHash === expectedHeadHash);
  if (matches.length !== 1) throw new TypeError("Strategy planning problem is not uniquely issued for producer trigger");
  const planningProblem = matches[0]!;
  assertIssuedStrategyPlanningProblem(planningProblem);
  if (planningProblem.strategyCompositionRoot !== composition.compositionRoot
    || planningProblem.strategyIssuerClosureRoot !== composition.issuerClosureRoot
    || planningProblem.readyRecordHash !== input.binding.readyRecordHash
    || (planningProblem.runtimeMembershipHash ?? planningProblem.releaseProvenanceHash) !== runtimeMembershipHash
    || (releaseProvenanceHash === undefined
      ? Object.prototype.hasOwnProperty.call(planningProblem, "releaseProvenanceHash")
      : planningProblem.releaseProvenanceHash !== releaseProvenanceHash)) {
    throw new TypeError("Strategy planning problem runtime membership mismatch");
  }
  assertCurrent();
  return Object.freeze({ planningProblem, strategyCompositionRoot: composition.compositionRoot });
}

const issued = new WeakMap<object, {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly version: bigint;
  readonly bindingId: string;
}>();

const unsignedIssued = new WeakMap<object, { readonly assertCurrent: () => void }>();

export function issueRuntimeReleaseStrategyRuntimeService(
  authorityValue: unknown,
  factoryValue: unknown,
): RuntimeReleaseStrategyRuntimeServiceV1 {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const state = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  assertGeneratedStrategyRuntimeFactory(factoryValue);
  const factory = factoryValue as GeneratedStrategyRuntimeFactoryV1;
  const factoryMetadata = readGeneratedStrategyRuntimeFactoryMetadata(factory);
  if (factoryMetadata.proposedCapabilitySetRoot !== state.binding.qualifiedCapabilityRefsRoot) {
    throw new TypeError("generated Strategy runtime factory is not bound to the signed capability set");
  }
  const releaseProvenanceHash = runtimeReleaseBindingProvenanceHash(state.binding);
  const runtimeAuthority = readActiveSignedRuntimeAuthorityDescriptorV1(authority);
  const version = state.version;
  const capability = issueGeneratedStrategyRuntimeAuthorityCapability({
    factory,
    qualifiedCapabilityRefsRoot: state.binding.qualifiedCapabilityRefsRoot,
    runtimeAuthority,
    assertCurrent: () => {
      const current = assertActiveRuntimeReleaseAuthorityState(authority);
      if (current.version !== version || current.binding.bindingId !== state.binding.bindingId) {
        throw new TypeError("generated Strategy runtime authority stale after runtime release rotation");
      }
    },
  });
  const assertCurrent = () => {
    const current = assertActiveRuntimeReleaseAuthorityState(authority);
    if (current.version !== version || current.binding.bindingId !== state.binding.bindingId) {
      throw new TypeError("generated Strategy runtime authority stale after runtime release rotation");
    }
  };
  const composition = factory(capability);
  if (typeof composition.definitionCatalogRoot !== "string") {
    throw new TypeError("generated Strategy runtime composition is invalid");
  }
  const runtimeMetadata: RuntimeReleaseStrategyRuntimeMetadataV1 = Object.freeze({
    definitionCatalogRoot: composition.definitionCatalogRoot,
    strategyCatalogRoot: factoryMetadata.strategyCatalogRoot,
    releaseProvenanceHash,
    compositionRoot: composition.compositionRoot,
  });
  const evidenceExpectation: RuntimeReleaseStrategyEvidenceExpectationV1 = Object.freeze({
    releaseProvenanceHash,
    definitionCatalogRoot: composition.definitionCatalogRoot,
    strategyCatalogRoot: factoryMetadata.strategyCatalogRoot,
    strategyCompositionRoot: composition.compositionRoot,
    strategyIssuerClosureRoot: composition.issuerClosureRoot,
    entries: factoryMetadata.strategies,
  });
  const service: RuntimeReleaseStrategyRuntimeServiceV1 = Object.freeze({
    readMetadata() {
      assertCurrent();
      return runtimeMetadata;
    },
    readEvidenceExpectation() {
      assertCurrent();
      return evidenceExpectation;
    },
    issuePlanningProblem(input: RuntimeReleaseStrategyPlanningRequestV1) {
      return issuePlanningProblemFromComposition(
        composition,
        assertCurrent,
        input,
        releaseProvenanceHash,
        releaseProvenanceHash,
      );
    },
  });
  issued.set(service, Object.freeze({ authority, version, bindingId: state.binding.bindingId }));
  return service;
}

export interface UnsignedDryRunStrategyRuntimeMetadataV1 {
  readonly definitionCatalogRoot: Hash;
  readonly strategyCatalogRoot: Hash;
  readonly runtimeMembershipHash: Hash;
  readonly compositionRoot: Hash;
}

export interface UnsignedDryRunStrategyEvidenceExpectationV1 {
  readonly runtimeMembershipHash: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly strategyCatalogRoot: Hash;
  readonly strategyCompositionRoot: Hash;
  readonly strategyIssuerClosureRoot: Hash;
  readonly entries: ReturnType<typeof readGeneratedStrategyRuntimeFactoryMetadata>["strategies"];
}

export interface UnsignedDryRunStrategyRuntimeServiceV1 {
  readonly readMetadata: () => UnsignedDryRunStrategyRuntimeMetadataV1;
  readonly readEvidenceExpectation: () => UnsignedDryRunStrategyEvidenceExpectationV1;
  readonly issuePlanningProblem: RuntimeReleaseStrategyRuntimeServiceV1["issuePlanningProblem"];
}

export function issueUnsignedDryRunStrategyRuntimeService(input: {
  readonly runtimeAuthority: UnsignedDryRunRuntimeAuthorityDescriptorV1;
  readonly factory: GeneratedStrategyRuntimeFactoryV1;
  readonly assertCurrent: () => void;
}): UnsignedDryRunStrategyRuntimeServiceV1 {
  if (input === null || typeof input !== "object" || typeof input.assertCurrent !== "function") {
    throw new TypeError("unsigned dry-run Strategy runtime authority is unavailable");
  }
  const runtimeAuthority = decodeUnsignedDryRunRuntimeAuthorityDescriptorV1(input.runtimeAuthority);
  assertGeneratedStrategyRuntimeFactory(input.factory);
  const factoryMetadata = readGeneratedStrategyRuntimeFactoryMetadata(input.factory);
  const capability = issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability({
    factory: input.factory,
    declaredCapabilitySetRoot: factoryMetadata.proposedCapabilitySetRoot,
    runtimeAuthority,
    assertCurrent: input.assertCurrent,
  });
  const composition = input.factory(capability);
  const runtimeMembershipHash = assertHash(
    composition.runtimeMembershipHash,
    "unsignedStrategyRuntime.runtimeMembershipHash",
  );
  const metadata = Object.freeze({
    definitionCatalogRoot: composition.definitionCatalogRoot,
    strategyCatalogRoot: factoryMetadata.strategyCatalogRoot,
    runtimeMembershipHash,
    compositionRoot: composition.compositionRoot,
  });
  const expectation = Object.freeze({
    runtimeMembershipHash,
    definitionCatalogRoot: composition.definitionCatalogRoot,
    strategyCatalogRoot: factoryMetadata.strategyCatalogRoot,
    strategyCompositionRoot: composition.compositionRoot,
    strategyIssuerClosureRoot: composition.issuerClosureRoot,
    entries: factoryMetadata.strategies,
  });
  const service: UnsignedDryRunStrategyRuntimeServiceV1 = Object.freeze({
    readMetadata() {
      input.assertCurrent();
      return metadata;
    },
    readEvidenceExpectation() {
      input.assertCurrent();
      return expectation;
    },
    issuePlanningProblem(request: RuntimeReleaseStrategyPlanningRequestV1) {
      return issuePlanningProblemFromComposition(
        composition,
        input.assertCurrent,
        request,
        runtimeMembershipHash,
      );
    },
  });
  unsignedIssued.set(service, Object.freeze({ assertCurrent: input.assertCurrent }));
  return service;
}

export function assertIssuedUnsignedDryRunStrategyRuntimeService(
  value: unknown,
): asserts value is UnsignedDryRunStrategyRuntimeServiceV1 {
  if (value === null || typeof value !== "object") throw new TypeError("unsigned dry-run Strategy runtime service is not owner-issued");
  const state = unsignedIssued.get(value);
  if (state === undefined) throw new TypeError("unsigned dry-run Strategy runtime service is not owner-issued");
  state.assertCurrent();
}

export function assertIssuedRuntimeReleaseStrategyRuntimeService(
  value: unknown,
): asserts value is RuntimeReleaseStrategyRuntimeServiceV1 {
  if (value === null || typeof value !== "object" || !issued.has(value)) {
    throw new TypeError("runtime-release Strategy runtime service is not owner-issued");
  }
  const state = issued.get(value)!;
  const current = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (current.version !== state.version || current.binding.bindingId !== state.bindingId) {
    throw new TypeError("runtime-release Strategy runtime service is stale");
  }
}

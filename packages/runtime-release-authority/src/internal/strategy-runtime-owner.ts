import {
  assertGeneratedStrategyRuntimeFactory,
  issueGeneratedStrategyRuntimeAuthorityCapability,
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
import {
  decodeRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityDescriptorV1,
} from "../../../../packages/runtime-authority/src/index.ts";

/**
 * The application receives this owner-issued service, never a raw generated
 * factory, structural StrategyRuntimeComposition, or Strategy trigger issuer.
 * The service consumes the Producer owner's opaque trigger and closes the
 * generated factory over the exact runtime capability.
 */
export interface StrategyRuntimePlanningRequestV1 {
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

export interface StrategyRuntimePlanningResultV1 {
  readonly planningProblem: IssuedStrategyPlanningProblemV1;
  readonly strategyCompositionRoot: Hash;
}

function issuePlanningProblemFromComposition(
  composition: ReturnType<GeneratedStrategyRuntimeFactoryV1>,
  assertCurrent: () => void,
  input: StrategyRuntimePlanningRequestV1,
  runtimeMembershipHash: Hash,
): StrategyRuntimePlanningResultV1 {
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
    || planningProblem.runtimeMembershipHash !== runtimeMembershipHash) {
    throw new TypeError("Strategy planning problem runtime membership mismatch");
  }
  assertCurrent();
  return Object.freeze({ planningProblem, strategyCompositionRoot: composition.compositionRoot });
}

const issued = new WeakMap<object, { readonly assertCurrent: () => void }>();

export interface StrategyRuntimeMetadataV1 {
  readonly definitionCatalogRoot: Hash;
  readonly strategyCatalogRoot: Hash;
  readonly runtimeMembershipHash: Hash;
  readonly compositionRoot: Hash;
}

export interface StrategyEvidenceExpectationV1 {
  readonly runtimeMembershipHash: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly strategyCatalogRoot: Hash;
  readonly strategyCompositionRoot: Hash;
  readonly strategyIssuerClosureRoot: Hash;
  readonly entries: ReturnType<typeof readGeneratedStrategyRuntimeFactoryMetadata>["strategies"];
}

export interface StrategyRuntimeServiceV1 {
  readonly readMetadata: () => StrategyRuntimeMetadataV1;
  readonly readEvidenceExpectation: () => StrategyEvidenceExpectationV1;
  readonly issuePlanningProblem: (
    input: StrategyRuntimePlanningRequestV1,
  ) => StrategyRuntimePlanningResultV1;
}

export function issueStrategyRuntimeService(input: {
  readonly runtimeAuthority: RuntimeAuthorityDescriptorV1;
  readonly factory: GeneratedStrategyRuntimeFactoryV1;
  readonly assertCurrent: () => void;
}): StrategyRuntimeServiceV1 {
  if (input === null || typeof input !== "object" || typeof input.assertCurrent !== "function") {
    throw new TypeError("Runtime Strategy runtime authority is unavailable");
  }
  const runtimeAuthority = decodeRuntimeAuthorityDescriptorV1(input.runtimeAuthority);
  assertGeneratedStrategyRuntimeFactory(input.factory);
  const factoryMetadata = readGeneratedStrategyRuntimeFactoryMetadata(input.factory);
  const capability = issueGeneratedStrategyRuntimeAuthorityCapability({
    factory: input.factory,
    declaredCapabilitySetRoot: factoryMetadata.proposedCapabilitySetRoot,
    runtimeAuthority,
    assertCurrent: input.assertCurrent,
  });
  const composition = input.factory(capability);
  const runtimeMembershipHash = assertHash(
    composition.runtimeMembershipHash,
    "strategyRuntime.runtimeMembershipHash",
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
  const service: StrategyRuntimeServiceV1 = Object.freeze({
    readMetadata() {
      input.assertCurrent();
      return metadata;
    },
    readEvidenceExpectation() {
      input.assertCurrent();
      return expectation;
    },
    issuePlanningProblem(request: StrategyRuntimePlanningRequestV1) {
      return issuePlanningProblemFromComposition(
        composition,
        input.assertCurrent,
        request,
        runtimeMembershipHash,
      );
    },
  });
  issued.set(service, Object.freeze({ assertCurrent: input.assertCurrent }));
  return service;
}

export function assertIssuedStrategyRuntimeService(
  value: unknown,
): asserts value is StrategyRuntimeServiceV1 {
  if (value === null || typeof value !== "object") throw new TypeError("Runtime Strategy runtime service is not owner-issued");
  const state = issued.get(value);
  if (state === undefined) throw new TypeError("Runtime Strategy runtime service is not owner-issued");
  state.assertCurrent();
}

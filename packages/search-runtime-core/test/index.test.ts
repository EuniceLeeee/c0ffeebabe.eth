import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, encodeCanonicalJson, hashDomain, type CanonicalJson, type Hash } from "../../canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../asset-ref/src/index.ts";
import type { GraphLeaseBindingV1, GraphRouteHandle, GraphViewLeaseV1, RuntimeGraphEdgeV1, IssuedRouteHandle } from "../../graph/src/index.ts";
import type {
  FamilySearchActionArtifactV1,
  FamilySearchAdapterV1,
  FamilySearchAmountEnvelopeV1,
  FamilySearchCoarseArtifactV1,
  FamilySearchExactArtifactV1,
  FamilySearchRouteLegBindingV1,
  FamilySearchStateArtifactV1,
} from "../../family-sdk/search-runtime/index.ts";
import { familySearchAmount, familySearchArtifactHash, familySearchObjective, familySearchPayloadHash, familySearchRouteBindingHash } from "../../family-sdk/search-runtime/index.ts";
import { asFamilyId, type GeneratedFamilyEntryV1, type StageCapabilityRefV1 } from "../../family-sdk/runtime-refs/index.ts";
import { asCapabilityId, asCapabilityVersion, asOwnerRef, asSchemaRef } from "../../capability-contracts/src/index.ts";
import type { FamilySourcePlanNominationProgramV1, FamilySourcePlanRuntimeV1, FamilyStageDefinitionV1, RuntimeStageExecutorV1 } from "../../family-sdk/runtime/index.ts";
import type { FamilySearchAdapterFactoryV1 } from "../../family-sdk/search-runtime/index.ts";
import type { ProgramInterpretationDraftV1 } from "../../capability-interpreters/src/index.ts";
import { decodeExecutorExecuteCalldata, decodePackedCallProgram, encodePackedCallProgram } from "../../execution-program/src/index.ts";
import {
  readIssuedNativeFullFamilyAuditV1,
  readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1,
  runSearchPipeline,
  type CurrentSourceSessionV1,
  type RoutePipelineInputV1,
} from "../../search-pipeline/src/index.ts";
import {
  createGeneratedFamilyRuntimeComposition,
  generatedFamilyCoarseProjectionDescriptorV1,
  nominationProgramProposalLeafDigest,
  nominationProgramRoot,
  nominationProgramSetRoot,
  runtimeAdapterLeafDigest,
  sourcePlanLeafDigest,
  type GeneratedFamilyRuntimeDescriptorV1,
} from "../../family-composition/src/index.ts";
import {
  installGeneratedFamilyCoarseProjectionOwnerV1,
  readGeneratedFamilyCoarseProjectionCapabilityV1,
} from "../../family-composition/src/internal/coarse-runtime-owner.ts";
import { issueQualifiedCoarseProjectionOwnerCapabilityV1 } from "../../coarse-economics/src/internal/qualification-owner.ts";
import { issueCoarseProjectionServiceV1 } from "../../coarse-economics/src/internal/owner.ts";
import type { CoarseProjectionCapabilityV1 } from "../../coarse-economics/src/index.ts";
import {
  sealGeneratedStrategyRuntimeDescriptor,
  strategyPlanningTemplateHash,
  type GeneratedStrategyRuntimeEntryV1,
  type StrategyGraphEdgeV1,
} from "../../strategy-composition/src/index.ts";
import {
  createGeneratedStrategyRuntimeFactory,
  issueGeneratedStrategyRuntimeAuthorityCapability,
} from "../../strategy-composition/src/internal/generated-runtime-composition.ts";
import { issueStrategyPlanningTriggerCapabilityV1 } from "../../strategy-composition/src/internal/trigger-owner.ts";
import { compileStrategy } from "../../strategy-sdk/src/index.ts";
import { enumerateClosedLoopPlanningProblem } from "../../planner/src/index.ts";
import {
  ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER,
  ROUTE_CYCLE_STRATEGY,
} from "../../../strategies/route-cycle/src/index.ts";
import { createGeneratedSearchRuntimePorts } from "../src/index.ts";
import { sealEmptyNominationClosureFixture } from "../../../specs/nomination-authority/test/fixture.ts";
import { createContractEconomicSafetyService } from "../../search-pipeline/test/economic-safety-fixture.ts";
import { createProductionSixStepTailFixture } from "../../search-pipeline/test/production-six-step-fixture.ts";

const h = (value: string): Hash => hashDomain("test/search-runtime-core", value);
const source = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const nomination = sealEmptyNominationClosureFixture({
  cutoff: Object.freeze({ chainId: "1", number: "99", hash: h("cutoff"), stateRoot: h("cutoff-state") }),
  familyId: "search-runtime-core-fixture-family",
  familyDefinitionHash: h("nomination-family-definition"),
  sourcePlanIdentity: h("nomination-source-plan-identity"),
  sourcePlanLeafDigest: h("nomination-source-plan-leaf"),
  nominationProgramRoot: h("nomination-program"),
  nominationProgramProposalLeafDigest: h("nomination-program-proposal"),
  qualificationRoot: h("nomination-qualification"),
  recentObservationRoot: h("nomination-recent-observation"),
  sourceExecutionSetRoot: h("nomination-source-execution-set"),
  sourceCoverageRoot: h("nomination-source-coverage"),
  persistedExecutionRoot: h("nomination-persisted-execution"),
  resultPartitionRoot: h("nomination-result-partition"),
});
const binding: GraphLeaseBindingV1 = Object.freeze({
  generationId: "generation-core-test",
  readyRecordHash: h("ready"),
  generationRefreshPolicyHash: h("policy"),
  cutoff: Object.freeze({ chainId: "1", number: "99", hash: h("cutoff"), stateRoot: h("cutoff-state") }),
  definitionCatalogRoot: h("definitions"),
  instanceCatalogRoot: h("instances"),
  graphRoot: h("graph"),
  releaseProvenanceHash: h("release"),
  candidatePartitionProofStorageHash: h("partition-proof"),
  nominationClosureRoot: nomination.closure.root,
  nominationClosureStorageHash: nomination.storageHash,
});

let issuedHandles: IssuedRouteHandle[] = [];
const asset = (value: string) => erc20AssetPortBindingV1("1", `0x${h(value).slice(-40)}`);

const edges: RuntimeGraphEdgeV1[] = [
  Object.freeze({
    edgeId: h("edge-a"),
    inputAssetPorts: Object.freeze([
      { ...asset("asset-unused-in"), portRef: h("port-a-unused-in"), ordinal: "0" },
      { ...asset("asset-a"), portRef: h("port-a-in"), ordinal: "1" },
    ]),
    outputAssetPorts: Object.freeze([
      { ...asset("asset-unused-out"), portRef: h("port-a-unused-out"), ordinal: "0" },
      { ...asset("asset-b"), portRef: h("port-a-out"), ordinal: "1" },
    ]),
    opaqueTransitionRef: h("transition-a"),
    constraintRefs: Object.freeze([]),
    owningFamilyId: "opaque-family",
    owningFamilyDefinitionHash: h("family-definition"),
    owningInstanceKey: "opaque-instance-a",
    instancePublicationHash: h("publication-a"),
    staticProjectionHash: h("projection-a"),
    projectionHash: h("projection-a-runtime"),
    rehydrationRef: Object.freeze({
      familyDefinitionHash: h("family-definition"),
      instanceKey: "opaque-instance-a",
      instancePublicationHash: h("publication-a"),
      staticProjectionMemoHash: h("projection-memo-a"),
      requestedArtifactDependencyRoot: h("dependencies-a"),
    }),
    routeHandle: Object.freeze(Object.create(null)) as GraphRouteHandle,
  }),
  Object.freeze({
    edgeId: h("edge-b"),
    inputAssetPorts: Object.freeze([{ ...asset("asset-b"), portRef: h("port-b-in"), ordinal: "0" }]),
    outputAssetPorts: Object.freeze([{ ...asset("asset-a"), portRef: h("port-b-out"), ordinal: "0" }]),
    opaqueTransitionRef: h("transition-b"),
    constraintRefs: Object.freeze([]),
    owningFamilyId: "opaque-family",
    owningFamilyDefinitionHash: h("family-definition"),
    owningInstanceKey: "opaque-instance-b",
    instancePublicationHash: h("publication-b"),
    staticProjectionHash: h("projection-b"),
    projectionHash: h("projection-b-runtime"),
    rehydrationRef: Object.freeze({
      familyDefinitionHash: h("family-definition"),
      instanceKey: "opaque-instance-b",
      instancePublicationHash: h("publication-b"),
      staticProjectionMemoHash: h("projection-memo-b"),
      requestedArtifactDependencyRoot: h("dependencies-b"),
    }),
    routeHandle: Object.freeze(Object.create(null)) as GraphRouteHandle,
  }),
];

function routeBinding(instanceKey: string): FamilySearchRouteLegBindingV1 {
  const identityMemo = Object.freeze({ kind: "opaque-identity", instanceKey });
  return Object.freeze({
    familyId: "opaque-family" as FamilySearchRouteLegBindingV1["familyId"],
    familyDefinitionHash: h("family-definition"),
    instanceKey,
    identityMemo,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
    instancePublicationHash: h(`publication-${instanceKey}`),
    staticProjectionMemoHash: h(`memo-${instanceKey}`),
    requestedArtifactDependencyRoot: h(`dependencies-${instanceKey}`),
    staticProjectionHash: h(`static-${instanceKey}`),
    projectionHash: h(`projection-${instanceKey}`),
    authoritySessionHash: h("authority-session"),
  });
}

const objectivePayload = Object.freeze({
  numeraireAssetRef: asset("asset-a").assetRef,
  minNetGain: "1",
  maxGas: "1000000",
  maxValueAtRisk: "1000000000000000000",
});
const objective = familySearchObjective({ objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload), payload: objectivePayload });
const amountSeed = Object.freeze({ amountIn: "100", recipient: "0xrecipient" });
const execution = Object.freeze({ transactionOrigin: "0xcaller", executorAddress: amountSeed.recipient });

function issuePlanningProblem() {
  const catalogEntry = compileStrategy(ROUTE_CYCLE_STRATEGY, []).entry;
  const issuerClosureRoot = h("strategy-issuer-closure");
  const entryBase = {
    catalogEntry,
    issuerModulePath: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.modulePath,
    issuerExportName: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.exportName,
    issuerClosureRoot,
    planningTemplateHash: strategyPlanningTemplateHash(catalogEntry.planningTemplate),
  };
  const entry: GeneratedStrategyRuntimeEntryV1 = Object.freeze({
    ...entryBase,
    leafDigest: hashDomain("aloha/generated-strategy-runtime-leaf/v1", {
      strategyId: catalogEntry.strategyId,
      strategyDefinitionHash: catalogEntry.strategyDefinitionHash,
      definitionCatalogLeafDigest: catalogEntry.definitionCatalogLeafDigest,
      issuerModulePath: entryBase.issuerModulePath,
      issuerExportName: entryBase.issuerExportName,
      issuerClosureRoot,
      planningTemplateHash: entryBase.planningTemplateHash,
    }),
  });
  const descriptor = sealGeneratedStrategyRuntimeDescriptor({
    schemaVersion: 1,
    releaseIntentRoot: h("strategy-release"),
    definitionCatalogRoot: binding.definitionCatalogRoot,
    proposedCapabilitySetRoot: h("strategy-capabilities"),
    strategies: [entry],
  });
  const factory = createGeneratedStrategyRuntimeFactory({
    descriptor,
    issuers: [ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER],
  });
  const capability = issueGeneratedStrategyRuntimeAuthorityCapability({
    factory,
    qualifiedCapabilityRefsRoot: descriptor.proposedCapabilitySetRoot,
    releaseProvenanceHash: binding.releaseProvenanceHash,
    assertCurrent: () => {},
  });
  const composition = factory(capability);
  const strategyBinding = {
    generationId: binding.generationId,
    definitionCatalogRoot: binding.definitionCatalogRoot,
    graphRoot: binding.graphRoot,
    readyRecordHash: binding.readyRecordHash,
    releaseProvenanceHash: binding.releaseProvenanceHash,
    sourceHash: h("block"),
  } as const;
  const strategyEdges: readonly StrategyGraphEdgeV1[] = Object.freeze(edges.map(edge => Object.freeze({
    edgeId: edge.edgeId,
    opaqueTransitionRef: edge.opaqueTransitionRef,
    inputAssetPorts: Object.freeze(edge.inputAssetPorts.map(port => Object.freeze({
      assetRef: port.assetRef,
      portRef: port.portRef,
      ordinal: port.ordinal,
    }))),
    outputAssetPorts: Object.freeze(edge.outputAssetPorts.map(port => Object.freeze({
      assetRef: port.assetRef,
      portRef: port.portRef,
      ordinal: port.ordinal,
    }))),
  })));
  return composition.issuePlanningProblems({
    binding: strategyBinding,
    edges: strategyEdges,
    trigger: issueStrategyPlanningTriggerCapabilityV1({
      binding: strategyBinding,
      lane: "blockscan",
      triggerRef: h("strategy-trigger"),
      objectiveRef: objective.objectiveRef,
      entryAssetRef: objectivePayload.numeraireAssetRef,
      returnAssetRef: objectivePayload.numeraireAssetRef,
      affectedEdgeIds: [],
      correlationId: h("correlation"),
    }),
  })[0]!;
}

const planningProblem = issuePlanningProblem();
const plannedCandidate = enumerateClosedLoopPlanningProblem({ problem: planningProblem }).candidates[0]!;

function sourceSession(): CurrentSourceSessionV1 {
  return Object.freeze({ sessionId: h("source-session"), source, assertCurrent: () => {} });
}

function lease(): GraphViewLeaseV1 {
  return {
    binding,
    edges: Object.freeze(edges),
    assertActive: () => {},
    resolveRouteHandle: async (edgeId: Hash) => issuedHandles[edges.findIndex(edge => edge.edgeId === edgeId)]!,
    release: () => {},
    leaseId: h("lease"),
    released: false,
  } as unknown as GraphViewLeaseV1;
}

function adapter(onExact?: (instanceKey: string, amountIn: string) => void, onAction?: (instanceKey: string, amountIn: string) => void): FamilySearchAdapterV1 {
  return {
    readState: async ({ route, currentSource, readPort }) => {
      const result = await readPort.read({
        request: {
          kind: "family-search.current-source-read",
          requestId: h(`read-${route.instanceKey}`),
          source: currentSource.source,
          target: route.instanceKey,
          data: "0x0902f1ac",
          responseEncoding: "abi-reserves",
        },
      });
      if (result.kind === "unavailable") return { kind: "unavailable", stage: "state", reasonCode: result.reasonCode, evidenceHash: h("state-unavailable") };
      const state: FamilySearchStateArtifactV1 = {
        kind: "state",
        status: "verified",
        source,
        routeBindingHash: familySearchRouteBindingHash(route),
        payload: { kind: "opaque-state" },
        payloadHash: h(`state-payload-${route.instanceKey}`),
        artifactHash: h(`state-artifact-${route.instanceKey}`),
        factsRoot: h(`state-facts-${route.instanceKey}`),
        sourceRequestId: result.requestId,
      };
      return { kind: "verified", artifact: state };
    },
    projectCoarse: ({ route, objective: requestedObjective, amount: requestedAmount, state }) => {
      const outputAmount = requestedAmount.amountIn === "100" ? "90" : "80";
      const coarse: FamilySearchCoarseArtifactV1 = {
        kind: "coarse",
        status: "rankable",
        source,
        routeBindingHash: familySearchRouteBindingHash(route),
        objectiveRef: requestedObjective.objectiveRef,
        amountHash: hashDomain("aloha/family-search-amount/v1", requestedAmount),
        payload: { kind: "opaque-coarse" },
        payloadHash: h(`coarse-payload-${route.instanceKey}`),
        artifactHash: h(`coarse-artifact-${route.instanceKey}`),
        projectionHash: h(`coarse-projection-${route.instanceKey}`),
        stateFactsRoot: state.factsRoot,
        input: { assetRef: requestedAmount.inputAssetRef, amount: requestedAmount.amountIn },
        output: { assetRef: requestedAmount.outputAssetRef, amount: outputAmount },
        conservativeOutputUpperBound: outputAmount,
        inputCapacityUpperBound: requestedAmount.amountIn,
        rankKey: h(`rank-${route.instanceKey}`),
        reasonCode: null,
      };
      return { kind: "verified", artifact: coarse };
    },
    evaluateExact: ({ route, objective: requestedObjective, amount: requestedAmount, coarse }) => {
      onExact?.(route.instanceKey, requestedAmount.amountIn);
      const exact: FamilySearchExactArtifactV1 = {
        kind: "exact",
        status: "verified",
        source,
        routeBindingHash: familySearchRouteBindingHash(route),
        objectiveRef: requestedObjective.objectiveRef,
        amountHash: hashDomain("aloha/family-search-amount/v1", requestedAmount),
        payload: { kind: "opaque-exact" },
        payloadHash: h(`exact-payload-${route.instanceKey}`),
        artifactHash: h(`exact-artifact-${route.instanceKey}`),
        evaluationHash: h(`evaluation-${route.instanceKey}`),
        stateFactsRoot: coarse.stateFactsRoot,
        inputs: [{ assetRef: requestedAmount.inputAssetRef, amount: requestedAmount.amountIn }],
        outputs: [{ assetRef: requestedAmount.outputAssetRef, amount: requestedAmount.amountIn === "100" ? "77" : "66" }],
        obligationRoot: h(`obligations-${route.instanceKey}`),
        reasonCode: null,
      };
      return { kind: "verified", artifact: exact };
    },
    buildAction: ({ route, objective: requestedObjective, amount: requestedAmount, exact }) => {
      onAction?.(route.instanceKey, requestedAmount.amountIn);
      const payload = { kind: "opaque-action" } as const;
      const payloadHash = familySearchPayloadHash("action", payload);
      const routeBindingHash = familySearchRouteBindingHash(route);
      const amountHash = hashDomain("aloha/family-search-amount/v1", requestedAmount);
      const action: FamilySearchActionArtifactV1 = {
        kind: "action",
        status: "ready",
        source,
        routeBindingHash,
        objectiveRef: requestedObjective.objectiveRef,
        amountHash,
        payload,
        payloadHash,
        artifactHash: familySearchArtifactHash({
          kind: "action",
          source,
          routeBindingHash,
          objectiveRef: requestedObjective.objectiveRef,
          amountHash,
          payloadHash,
        }),
        actionHash: h(`action-${route.instanceKey}`),
        exactEvaluationHash: exact.evaluationHash,
        actionOwnerId: "opaque-action-owner",
        actionOwnerRef: h("action-owner"),
        opaqueBytes: encodePackedCallProgram([{
          target: route.instanceKey.endsWith("a") ? "0x3333333333333333333333333333333333333333" : "0x4444444444444444444444444444444444444444",
          value: "0",
          calldata: route.instanceKey.endsWith("a") ? "0xabcd" : "0xef01",
        }]),
        effectTransport: {
          caller: { ref: { kind: "observed-sender" }, executionMode: "impersonated-call-frame" },
          preCalls: [],
          observeTokenBalances: [{
            token: "0x5555555555555555555555555555555555555555",
            account: { kind: "observed-sender" },
          }],
          observeLogs: true,
        },
        inputs: exact.inputs,
        outputs: exact.outputs,
        obligationRoot: exact.obligationRoot,
      };
      return { kind: "verified", artifact: action };
    },
    run: async () => ({ kind: "invalidProgram", stage: "action", code: "run-not-used" }),
  };
}

const familyId = asFamilyId("opaque-family");
const familyDefinitionHash = h("family-definition");
const stages = ["nomination", "identity", "materialization", "projection", "rehydration"] as const;

function generatedComposition(
  onExact?: (instanceKey: string, amountIn: string) => void,
  onAction?: (instanceKey: string, amountIn: string) => void,
): ReturnType<typeof createGeneratedFamilyRuntimeComposition> {
  const lifecycleRefs = Object.fromEntries(stages.map((stage, index) => [stage, {
    familyId,
    familyDefinitionHash,
    stage,
    capabilityId: asCapabilityId(`opaque.${stage}`),
    version: asCapabilityVersion("1.0.0"),
    schemaHash: asSchemaRef(h(`schema-${index}`)),
    interpreterHash: h(`interpreter-${index}`),
    ownerRef: asOwnerRef(h(`owner-${index}`)),
  }])) as GeneratedFamilyEntryV1["lifecycleRefs"];
  const sourcePlan: FamilySourcePlanRuntimeV1 = Object.freeze({
    sourcePlanId: "opaque-family.fixed-cutoff-50-block",
    completeness: "nomination-only",
    historyStartBlock: null,
    schemaHash: h("source-plan-schema"),
    async execute() { throw new Error("source-plan-not-used-by-search-runtime-core"); },
  });
  const nominationProgram: FamilySourcePlanNominationProgramV1 = Object.freeze({
    kind: "aloha.family-source-plan-nomination-program",
    version: 1,
    schemaHash: sourcePlan.schemaHash,
    async evaluate() { return Object.freeze([]); },
  });
  const sourcePlanRef = Object.freeze({
    ownerRef: h("source-plan-owner"),
    sourcePlanRef: h("source-plan-ref"),
    familyDefinitionHash,
    completeness: sourcePlan.completeness,
    historyStartBlock: sourcePlan.historyStartBlock,
  });
  const coarseCapabilityRef = Object.freeze({
    familyId,
    familyDefinitionHash,
    stage: "capability" as const,
    capabilityId: asCapabilityId("opaque.coarse"),
    version: asCapabilityVersion("1.0.0"),
    schemaHash: asSchemaRef(h("coarse-schema")),
    interpreterHash: h("coarse-interpreter"),
    ownerRef: asOwnerRef(h("coarse-owner")),
  });
  const entry: GeneratedFamilyEntryV1 = {
    familyId,
    familyDefinitionHash,
    issuerRef: asOwnerRef(h("issuer")),
    authorityRef: h("authority") as GeneratedFamilyEntryV1["authorityRef"],
    lifecycleRefs,
    extensionRefs: [coarseCapabilityRef],
    actionOwnerRefs: [],
    factContractRefs: [],
    sourcePlanRefs: [sourcePlanRef],
    definitionCatalogLeafDigest: h("leaf"),
    capabilityCatalogRoot: h("capabilities"),
  };
  const generatedStages = stages.map(stage => ({
    stage,
    modulePath: `families/opaque/${stage}.ts`,
    exportName: `${stage}RuntimeDefinition`,
    closureRoot: lifecycleRefs[stage].interpreterHash,
    stageRef: lifecycleRefs[stage],
  })).sort((left, right) => left.stage.localeCompare(right.stage));
  const stageDefinitionRoot = hashDomain(
    "aloha/family-runtime-definition-set/v1",
    [...generatedStages].sort((left, right) => left.stage.localeCompare(right.stage)),
  );
  const adapterDeclaration = {
    role: "search/v1",
    modulePath: "families/opaque/search/adapter.ts",
    exportName: "createOpaqueSearchAdapter",
    closureRoot: h("adapter-closure"),
    capabilityRefs: { coarse: coarseCapabilityRef },
    actionOwnerRefs: {},
  } as const;
  const adapterLeafDigest = runtimeAdapterLeafDigest(adapterDeclaration);
  const sourcePlanDescriptorBase = {
    sourcePlanId: sourcePlan.sourcePlanId,
    modulePath: "families/opaque/source-plan.ts",
    exportName: "OPAQUE_SOURCE_PLAN",
    closureRoot: h("source-plan-closure"),
    schemaHash: sourcePlan.schemaHash,
    planRef: sourcePlanRef,
  };
  const sourcePlanDescriptor = {
    ...sourcePlanDescriptorBase,
    leafDigest: sourcePlanLeafDigest(sourcePlanDescriptorBase),
  };
  const nominationProposalBase = {
    program: {
      modulePath: "families/opaque/nomination-program.ts",
      exportName: "OPAQUE_NOMINATION_PROGRAM",
      closureRoot: h("nomination-program-closure"),
      schemaHash: nominationProgram.schemaHash,
    },
    mutationCorpus: {
      modulePath: "families/opaque/nomination-mutations.ts",
      exportName: "OPAQUE_NOMINATION_MUTATIONS",
      closureRoot: h("nomination-mutations-closure"),
    },
    independentOracle: {
      modulePath: "families/opaque/nomination-oracle.ts",
      exportName: "OPAQUE_NOMINATION_ORACLE",
      closureRoot: h("nomination-oracle-closure"),
    },
  };
  const nominationProposalWithoutLeaf = {
    ...nominationProposalBase,
    nominationProgramRoot: nominationProgramRoot(nominationProposalBase),
  };
  const nominationProgramProposal = {
    ...nominationProposalWithoutLeaf,
    proposalLeafDigest: nominationProgramProposalLeafDigest(sourcePlanDescriptor.leafDigest, nominationProposalWithoutLeaf),
  };
  const qualifiedSourcePlanDescriptor = { ...sourcePlanDescriptor, nominationProgramProposal };
  const family = {
    entry,
    publicEntry: { modulePath: "families/opaque/public.ts", exportName: "PUBLIC_ENTRY", closureRoot: h("public-closure") },
    stages: generatedStages,
    extensions: [{
      modulePath: "families/opaque/coarse.ts",
      exportName: "OPAQUE_COARSE_CAPABILITY",
      closureRoot: h("coarse-extension-closure"),
      capabilityRef: coarseCapabilityRef,
    }],
    actionOwners: [],
    sourcePlans: [qualifiedSourcePlanDescriptor],
    runtimeAdapters: [{ ...adapterDeclaration, leafDigest: adapterLeafDigest }],
    runtimeAdapterRoot: hashDomain("aloha/family-runtime-adapter-set/v1", [adapterLeafDigest]),
    sourcePlanRoot: hashDomain("aloha/family-source-plan-set/v1", [sourcePlanDescriptor.leafDigest]),
    stageDefinitionRoot,
  };
  const descriptorWithoutRoot = {
    schemaVersion: 1 as const,
    releaseIntentRoot: h("release-intent"),
    definitionCatalogRoot: h("definitions"),
    proposedCapabilitySetRoot: h("proposed-capability-set"),
    nominationProgramSetRoot: nominationProgramSetRoot([nominationProgramProposal.proposalLeafDigest]),
    families: [family],
  };
  const descriptor: GeneratedFamilyRuntimeDescriptorV1 = {
    ...descriptorWithoutRoot,
    descriptorRoot: hashDomain("aloha/generated-family-runtime-descriptor/v1", descriptorWithoutRoot),
  };
  const definitions: readonly FamilyStageDefinitionV1[] = Object.freeze(generatedStages.map(stage => Object.freeze({
    stage: stage.stage,
    capabilityId: stage.stageRef.capabilityId,
    version: stage.stageRef.version,
    schemaHash: stage.stageRef.schemaHash,
    payloadCodec: Object.freeze({
      schemaRef: stage.stageRef.schemaHash,
      decodeExact(value: unknown): CanonicalJson { return decodeCanonicalJson(encodeCanonicalJson(value)); },
    }),
    dependencyIds: Object.freeze([]),
    outputSchemaRef: h(`${stage.stage}-output`),
    implementationClosureHash: h(`${stage.stage}-implementation`),
    outputCodecHash: h(`${stage.stage}-codec`),
    outputCodec: Object.freeze({ decodeExact(value: unknown): CanonicalJson { return decodeCanonicalJson(encodeCanonicalJson(value)); } }),
    prepareIssueValue: ({ candidate, cutoff, identityMemo, materializationOutput }: Parameters<FamilyStageDefinitionV1["prepareIssueValue"]>[0]) => ({ candidate, cutoff, identityMemo, materializationOutput }),
    interpret(_input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 { return Object.freeze({ kind: "invalidProgram", code: "test-only" }); },
  })));
  const authority = {
    familyDefinitionHash,
    definitionBindingRoot: stageDefinitionRoot,
    binding: {
      familyId,
      familyDefinitionHash,
      releaseAuthorityRoot: h("release-authority"),
      programAuthorityHash: h("program-authority"),
      executorAuthorityRoot: h("executor-authority"),
      workerEpoch: "opaque-epoch",
      executorSessionHash: h("authority-session"),
    },
    executors: stages.map(stage => ({
      stage,
      executor: {
        async execute() { return []; },
      },
    })),
  };
  const composition = createGeneratedFamilyRuntimeComposition({
    descriptor,
    authorities: [authority],
    definitions: [definitions],
    extensions: [[Object.freeze({})]],
    actionOwners: [[]],
    runtimeAdapters: [[(({ composition: _composition }) => {
      void _composition;
      return adapter(onExact, onAction);
    }) satisfies FamilySearchAdapterFactoryV1]],
  });
  const coarseDescriptor = generatedFamilyCoarseProjectionDescriptorV1(descriptor.families[0]!);
  if (coarseDescriptor === null) throw new TypeError("fixture generated coarse descriptor is missing");
  const releaseMembershipRoot = h("coarse-release-membership");
  const coarseOwner = issueQualifiedCoarseProjectionOwnerCapabilityV1({
    releaseProvenanceHash: binding.releaseProvenanceHash,
    releaseMembershipRoot,
    descriptor: coarseDescriptor.ownerDescriptor,
    port: Object.freeze({
      read: (capability: CoarseProjectionCapabilityV1) => readGeneratedFamilyCoarseProjectionCapabilityV1(composition, capability),
      verifyConservativeBound: () => { throw new TypeError("rank-only"); },
    }),
  });
  installGeneratedFamilyCoarseProjectionOwnerV1(composition, {
    familyDefinitionHash,
    ownerDescriptor: coarseDescriptor.ownerDescriptor,
    service: issueCoarseProjectionServiceV1({ owner: coarseOwner }),
    releaseProvenanceHash: binding.releaseProvenanceHash,
    releaseMembershipRoot,
    assertCurrent: () => {},
  });
  const handles = ["opaque-instance-a", "opaque-instance-b"].map(instanceKey => {
    const binding = routeBinding(instanceKey);
    return composition.entries[0]!.owner.routeHandles.issueRouteHandle(
      {
        familyId,
        familyDefinitionHash,
        instanceKey,
        identityMemo: binding.identityMemo,
        identityMemoHash: binding.identityMemoHash,
        instancePublicationHash: binding.instancePublicationHash,
        staticProjectionMemoHash: binding.staticProjectionMemoHash,
        requestedArtifactDependencyRoot: binding.requestedArtifactDependencyRoot,
      },
      { staticProjectionHash: binding.staticProjectionHash, projectionHash: binding.projectionHash },
      {
        familyDefinitionHash,
        instanceKey,
        instancePublicationHash: binding.instancePublicationHash,
        staticProjectionMemoHash: binding.staticProjectionMemoHash,
        requestedArtifactDependencyRoot: binding.requestedArtifactDependencyRoot,
      },
    );
  });
  issuedHandles = handles as unknown as IssuedRouteHandle[];
  return composition;
}

test("generated search ports consume exact non-first Graph ports and compose ordered opaque actions", async () => {
  let readCount = 0;
  let programBytes = "";
  let executionEvidence: import("../../search-pipeline/src/index.ts").ExecutionProgramSixStepEvidenceV1 | undefined;
  const exactCalls: Array<readonly [string, string]> = [];
  const actionCalls: Array<readonly [string, string]> = [];
  const core = createGeneratedSearchRuntimePorts({
    composition: generatedComposition((instanceKey, amountIn) => exactCalls.push([instanceKey, amountIn]), (instanceKey, amountIn) => actionCalls.push([instanceKey, amountIn])),
    sourceRead: {
      read: ({ request }) => {
        readCount += 1;
        return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: "0xopaque" };
      },
    },
    amountSeed,
    execution,
  });
  const finalSimulation = {
    simulate: ({ program }: { readonly program: { readonly programBytes: string } }) => {
      programBytes = program.programBytes;
      return { kind: "retryable" as const, stage: "final-sim" as const, code: "worker-unavailable" };
    },
  };
  const executionProgram = {
    ...core.executionProgram,
    compile: async (input: Parameters<typeof core.executionProgram.compile>[0]) => {
      const compiled = await core.executionProgram.compile(input);
      if (compiled.kind === "compiled") {
        assert.ok(compiled.sixStepEvidence);
        assert.ok(core.executionProgram.sixStepEvidenceAuthority);
        executionEvidence = core.executionProgram.sixStepEvidenceAuthority.read(compiled.sixStepEvidence);
        assert.throws(
          () => core.executionProgram.sixStepEvidenceAuthority!.read({ ...compiled.sixStepEvidence! }),
          /was not issued/,
        );
      }
      return compiled;
    },
  };
  const ports = {
    ...core,
    executionProgram,
    finalSimulation,
    economicSafety: createContractEconomicSafetyService(binding.releaseProvenanceHash, h),
    sixStepArtifacts: createProductionSixStepTailFixture([]),
  } as never;
  const result = await runSearchPipeline(ports, {
    lease: lease(),
    planningProblem,
    strategyCompositionRoot: planningProblem.strategyCompositionRoot,
    objective,
    currentSource: sourceSession(),
    correlationId: h("correlation"),
    deadlineAtMs: performance.now() + 1_000,
    callerId: "search-runtime-core-test",
    admission: { topK: 1, boundedUnrankedBudget: 0 },
  } satisfies RoutePipelineInputV1);
  assert.equal(result.kind, "route-set-terminal", JSON.stringify(result));
  assert.equal(result.receipt.outcome, "retryable", JSON.stringify(result));
  assert.equal(result.receipt.accounting.selected, 1, JSON.stringify(result.receipt.accounting));
  assert.equal(result.receipt.accounting.entries[0]?.candidateId, plannedCandidate.candidateId);
  assert.equal(result.receipt.accounting.entries[0]?.terminalKind, "retryable");
  const nativeAuditCapability = readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1(result.terminalCapability);
  const nativeAudit = readIssuedNativeFullFamilyAuditV1(nativeAuditCapability);
  assert.equal(nativeAudit.binding.sourceSessionId, h("source-session"));
  assert.equal(nativeAudit.binding.readyRecordHash, binding.readyRecordHash);
  assert.deepEqual(nativeAudit.binding.readyCutoff, binding.cutoff);
  assert.deepEqual(nativeAudit.binding.actualCurrentSource, source);
  assert.equal(nativeAudit.expectedCandidateCount, "1");
  assert.equal(nativeAudit.expectedLegCount, "2");
  assert.equal(nativeAudit.observedReceiptCount, "2");
  assert.equal(nativeAudit.missingLegKeys.length, 0);
  assert.equal(nativeAudit.expectedProjectedEdgeCount, "2");
  assert.equal(nativeAudit.observedProjectedEdgeCount, "2");
  assert.deepEqual(nativeAudit.projectedEdges.map(edge => edge.edgeId), edges.map(edge => edge.edgeId));
  assert.equal(nativeAudit.projectedEdges.every(edge => !Object.prototype.hasOwnProperty.call(edge.edge, "routeHandle")), true);
  assert.deepEqual(nativeAudit.projectedEdges.map(edge => edge.edge.projectionHash), edges.map(edge => edge.projectionHash));
  assert.deepEqual(nativeAudit.missingProjectedEdgeIds, []);
  const coarseLegs = nativeAudit.coarseRoutes[0]?.legs ?? [];
  assert.equal(coarseLegs.length, 2);
  assert.equal(coarseLegs.every(leg => leg.receipt?.projection.status === "rankable"), true);
  for (const [index, leg] of coarseLegs.entries()) {
    const observation = leg.familyObservation as Record<string, unknown>;
    const stateOutcome = observation.stateOutcome as Record<string, unknown>;
    const coarseOutcome = observation.coarseOutcome as Record<string, unknown>;
    const stateArtifact = stateOutcome.artifact as FamilySearchStateArtifactV1;
    const coarseArtifact = coarseOutcome.artifact as FamilySearchCoarseArtifactV1;
    assert.equal(observation.kind, "aloha.family-runtime-coarse-projection-observation-v1");
    assert.equal(observation.legIndex, String(index));
    assert.equal(observation.projectionId, leg.receipt?.projection.projectionId);
    assert.equal(stateOutcome.kind, "verified");
    assert.deepEqual(stateArtifact.payload, { kind: "opaque-state" });
    assert.equal(coarseOutcome.kind, "verified");
    assert.deepEqual(coarseArtifact.payload, { kind: "opaque-coarse" });
    assert.equal(coarseArtifact.artifactHash, h(`coarse-artifact-${edges[index]!.owningInstanceKey}`));
  }
  assert.equal(nativeAudit.expectedActionLineageCount, "1");
  assert.equal(nativeAudit.observedActionLineageCount, "1");
  assert.deepEqual(nativeAudit.missingActionCandidateIds, []);
  assert.equal(nativeAudit.actionLineage[0]?.executionProgramOwnerEvidence.evidenceRoot, executionEvidence?.evidenceRoot);
  assert.deepEqual(nativeAudit.actionLineage[0]?.executionProgramOwnerEvidence.ownerObservation, executionEvidence?.ownerObservation);
  assert.throws(
    () => readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1({ ...result.terminalCapability }),
    /was not issued/,
  );
  assert.throws(
    () => readIssuedNativeFullFamilyAuditV1({ ...nativeAuditCapability }),
    /was not issued/,
  );
  assert.equal(readCount, 4);
  assert.ok(executionEvidence);
  assert.equal(executionEvidence.correlationId, h("correlation"));
  assert.equal(executionEvidence.programHash.length, 66);
  const ownerFacts = executionEvidence.facts as Record<string, unknown>;
  assert.equal(ownerFacts.kind, "aloha.search-runtime.execution-program-owner-facts-v1");
  assert.equal((ownerFacts.actionOwners as readonly unknown[]).length, 2);
  assert.deepEqual(ownerFacts.routeAssetReferences, [asset("asset-a"), asset("asset-b")]
    .map(reference => ({ identity: reference.assetIdentity, assetRef: reference.assetRef }))
    .sort((left, right) => left.assetRef.localeCompare(right.assetRef)));
  assert.equal(Object.prototype.hasOwnProperty.call(ownerFacts, "actionArtifacts"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ownerFacts, "effectTransport"), false);
  const ownerObservation = executionEvidence.ownerObservation as Record<string, unknown>;
  assert.equal(ownerObservation.kind, "aloha.search-runtime.execution-program-owner-observation-v1");
  assert.equal((ownerObservation.actionArtifacts as readonly unknown[]).length, 2);
  assert.equal((ownerObservation.actionArtifacts as readonly FamilySearchActionArtifactV1[]).every(action => action.kind === "action" && action.status === "ready"), true);
  assert.deepEqual(ownerObservation.effectTransport, {
    caller: { ref: { kind: "observed-sender" }, executionMode: "impersonated-call-frame" },
    preCalls: [],
    observeTokenBalances: [{
      token: "0x5555555555555555555555555555555555555555",
      account: { kind: "observed-sender" },
    }],
    observeLogs: true,
  });
  assert.equal((ownerObservation.actionArtifacts as readonly FamilySearchActionArtifactV1[]).every(action => action.effectTransport?.caller.executionMode === "impersonated-call-frame"), true);
  assert.equal((ownerFacts.callSequence as readonly unknown[]).length, 2);
  const expectedInstances = plannedCandidate.legs.map(leg => edges.find(edge => edge.edgeId === leg.edgeId)!.owningInstanceKey);
  assert.deepEqual(exactCalls, [[expectedInstances[0], "100"], [expectedInstances[1], "77"]]);
  assert.deepEqual(actionCalls, exactCalls);
  const edgeALeg = plannedCandidate.legs.find(leg => leg.edgeId === edges[0]!.edgeId)!;
  assert.equal(edgeALeg.inputPortRef, edges[0]!.inputAssetPorts[1]!.portRef);
  assert.equal(edgeALeg.outputPortRef, edges[0]!.outputAssetPorts[1]!.portRef);
  const packed = decodeExecutorExecuteCalldata(programBytes);
  const instructions = decodePackedCallProgram(packed);
  assert.deepEqual(instructions.map(instruction => instruction.target), expectedInstances.map(instanceKey => instanceKey.endsWith("a")
    ? "0x3333333333333333333333333333333333333333"
    : "0x4444444444444444444444444444444444444444"));
  assert.deepEqual(instructions.map(instruction => instruction.calldata), expectedInstances.map(instanceKey => instanceKey.endsWith("a") ? "0xabcd" : "0xef01"));
});

test("native audit retains the raw unavailable state outcome and leaves later coarse legs missing", async () => {
  let readCount = 0;
  const core = createGeneratedSearchRuntimePorts({
    composition: generatedComposition(),
    sourceRead: {
      read: ({ request }) => {
        readCount += 1;
        return {
          kind: "unavailable" as const,
          requestId: request.requestId,
          source: request.source,
          reasonCode: "fixture-current-source-unavailable",
        };
      },
    },
    amountSeed,
    execution,
  });
  const result = await runSearchPipeline({
    ...core,
    finalSimulation: { simulate: () => { throw new Error("must not reach final simulation"); } },
  } as never, {
    lease: lease(),
    planningProblem,
    strategyCompositionRoot: planningProblem.strategyCompositionRoot,
    objective,
    currentSource: sourceSession(),
    correlationId: h("correlation"),
    deadlineAtMs: performance.now() + 1_000,
    callerId: "search-runtime-core-test",
    admission: { topK: 1, boundedUnrankedBudget: 0 },
  } satisfies RoutePipelineInputV1);
  assert.equal(result.kind, "route-set-terminal", JSON.stringify(result));
  const audit = readIssuedNativeFullFamilyAuditV1(
    readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1(result.terminalCapability),
  );
  assert.equal(audit.expectedLegCount, "2");
  assert.equal(audit.observedReceiptCount, "1");
  assert.equal(audit.missingLegKeys.length, 1);
  const first = audit.coarseRoutes[0]?.legs[0];
  const second = audit.coarseRoutes[0]?.legs[1];
  assert.equal(first?.receipt?.projection.status, "unavailable");
  assert.match(first?.receipt?.projection.reasonCode ?? "", /^state:/);
  const observation = first?.familyObservation as Record<string, unknown>;
  assert.equal(observation.kind, "aloha.family-runtime-coarse-projection-observation-v1");
  assert.equal((observation.stateOutcome as Record<string, unknown>).kind, "unavailable");
  assert.equal((observation.stateOutcome as Record<string, unknown>).reasonCode, "fixture-current-source-unavailable");
  assert.equal(observation.coarseOutcome, null);
  assert.equal(second?.receipt, null);
  assert.equal(second?.familyObservation, null);
  assert.equal(audit.expectedActionLineageCount, "0");
  assert.equal(audit.observedActionLineageCount, "0");
  assert.equal(readCount, 1);
});

test("caller-recomputed planning problems fail before route admission", async () => {
  const core = createGeneratedSearchRuntimePorts({ composition: generatedComposition(), sourceRead: { read: () => { throw new Error("not reached"); } }, amountSeed, execution });
  const result = await runSearchPipeline({
    ...core,
    finalSimulation: { simulate: () => { throw new Error("not reached"); } },
  } as never, {
    lease: lease(),
    planningProblem: { ...planningProblem },
    strategyCompositionRoot: planningProblem.strategyCompositionRoot,
    objective,
    currentSource: sourceSession(),
    correlationId: h("forged-correlation"),
    deadlineAtMs: performance.now() + 1_000,
    callerId: "search-runtime-core-test",
    admission: { topK: 0, boundedUnrankedBudget: 1 },
  } satisfies RoutePipelineInputV1);
  assert.deepEqual(result, { kind: "invalidProgram", stage: "input", code: "planning-problem-not-issued" });
});

test("runtime amount seed rejects removed callback and every unknown field", () => {
  assert.throws(() => createGeneratedSearchRuntimePorts({
    composition: generatedComposition(),
    sourceRead: { read: () => { throw new Error("not reached"); } },
    amountSeed: { ...amountSeed, callbackDataHex: "0x1234" } as never,
    execution,
  }), /unknown field/);
});

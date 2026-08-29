import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type CanonicalJson, type Hash } from "../../canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../asset-ref/src/index.ts";
import type { GraphLeaseBindingV1, GraphRouteHandle, GraphViewLeaseV1, IssuedRouteHandle, RuntimeGraphEdgeV1 } from "../../graph/src/index.ts";
import { enumerateClosedLoopPlanningProblem } from "../../planner/src/index.ts";
import {
  issueCoarseRouteAssessmentV1,
  readIssuedCoarseRouteBindingV1,
  readQualifiedCoarseProjectionReceiptV1,
  readQualifiedCoarseProjectionV1,
  sealCoarseEdgeProjectionV1,
  type CoarseProjectionCapabilityV1,
  type IssuedCoarseRouteAssessmentV1,
  type IssuedCoarseRouteBindingV1,
  type QualifiedCoarseProjectionV1,
} from "../../coarse-economics/src/index.ts";
import { issueCoarseProjectionServiceV1 } from "../../coarse-economics/src/internal/owner.ts";
import { issueQualifiedCoarseProjectionOwnerCapabilityV1 } from "../../coarse-economics/src/internal/qualification-owner.ts";
import {
  runSearchPipeline,
  decodeNativeFullFamilyAuditV1,
  encodeNativeFullFamilyAuditBodyV1,
  nativeFullFamilyAuditSequenceRootV1,
  nativeFullFamilyAuditSemanticRootV1,
  routeAccountingRootV1,
  routeSetTerminalLineageHashV2,
  searchTerminalEvidenceHashV2,
  readIssuedSearchTerminalCapabilityV1,
  readIssuedSearchTerminalCandidateTimingsV1,
  readIssuedSearchTerminalCoarseTimingV1,
  readIssuedNativeFullFamilyAuditV1,
  readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1,
  readIssuedSearchTerminalSchedulerResourceJoinV1,
  readIssuedSearchTerminalSixStepTraceV1,
  readIssuedSearchTerminalSixStepArtifactCapabilitiesV1,
  routeBindingHash,
  sealExecutionProgram,
  sealUnsignedDryRunReceipt,
  type CurrentSourceSessionV1,
  type NativeFullFamilyAuditSectionV1,
  type RoutePipelineInputV1,
  type RoutePipelinePortsV1,
  type SearchObjectiveV1,
  type SearchSchedulerResourceJoinCapabilityV1,
  type SourceViewV1,
} from "../src/index.ts";
import { issueRouteCyclePlanningProblem } from "./issued-strategy.ts";
import { sealEmptyNominationClosureFixture } from "../../../specs/nomination-authority/test/fixture.ts";
import { createContractEconomicSafetyService } from "./economic-safety-fixture.ts";
import type { ExecutionProgramSixStepEvidenceV1, FinalSimulationSixStepEvidenceV1 } from "../src/index.ts";
import { createRouteCoarseAttemptEvidenceOwnerV1 } from "../src/internal/coarse-attempt-evidence-owner.ts";
import { createProductionSixStepTailFixture } from "./production-six-step-fixture.ts";
import { readProductionSixStepArtifactMaterialV1 } from "../../evidence-emitter/src/index.ts";

const h = (value: string): Hash => hashDomain("test/route-pipeline", value);
const asset = (value: string) => erc20AssetPortBindingV1("1", `0x${h(`asset-${value}`).slice(-40)}`);
const noRejectionAuthority = Object.freeze({ read: () => { throw new TypeError("rejection-not-issued"); } });

const source: SourceViewV1 = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const releaseMembershipRoot = h("release-membership");
const nomination = sealEmptyNominationClosureFixture({
  cutoff: Object.freeze({ chainId: "1", number: "99", hash: h("cutoff"), stateRoot: h("cutoff-state") }),
  familyId: "route-pipeline-fixture-family",
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
  generationId: "generation-1",
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
const objectivePayload = Object.freeze({
  numeraireAssetRef: h("edge-ab") < h("edge-ba") ? asset("a").assetRef : asset("b").assetRef,
  minNetGain: "2",
  maxGas: "1000000",
  maxValueAtRisk: "1000000000000000000",
});
const objectiveRef = hashDomain("aloha/search-objective/v1", objectivePayload);
const actionObligation = h("action-obligation");
const programObligationRoot = hashDomain("aloha/search-runtime-obligation-root/v1", [actionObligation]);
const executionEvidence = new WeakMap<object, ExecutionProgramSixStepEvidenceV1>();
const finalEvidence = new WeakMap<object, FinalSimulationSixStepEvidenceV1>();

function issueExecutionEvidence(routeHash: Hash, routeBinding: Hash, exactHash: Hash, programHash: Hash): object {
  const actionOwnerRef = h("program-issuer");
  const facts = Object.freeze({
    kind: "aloha.search-runtime.execution-program-owner-facts-v1",
    callerMode: "top-level",
    preCalls: Object.freeze([]),
    observationPairs: Object.freeze([]),
    observeLogs: false,
    callSequence: Object.freeze([]),
    actionOwners: Object.freeze([Object.freeze({
      familyDefinitionHash: h("action-family"),
      routeBindingHash: routeBinding,
      actionOwnerId: "route-pipeline-action-owner",
      actionOwnerRef,
      actionHash: h("action"),
      actionArtifactHash: h("action-artifact"),
      exactEvaluationHash: exactHash,
      payload: Object.freeze({ obligationRoot: actionObligation }),
      payloadHash: h("action-payload"),
      inputs: Object.freeze([]),
      outputs: Object.freeze([]),
      obligationRoot: actionObligation,
    })]),
    obligationRoot: programObligationRoot,
    declaredObligations: Object.freeze([{ obligationRef: actionObligation, ownerRef: actionOwnerRef, policy: "must-satisfy" as const }]),
  });
  const body = { schemaVersion: 1 as const, kind: "aloha.execution-program-six-step-evidence-v1" as const, correlationId: h("correlation"), generationId: binding.generationId, source, routeHash, exactHash, programHash, facts };
  const capability = Object.freeze(Object.create(null));
  executionEvidence.set(capability, Object.freeze({ ...body, evidenceRoot: hashDomain("aloha/execution-program-six-step-evidence/v1", body) }));
  return capability;
}

function issueFinalEvidence(programHash: Hash, receiptHash: Hash): object {
  const facts = Object.freeze({ kind: "contract-final-owner", workerReceipt: Object.freeze({ executionReceiptHash: h("execution-receipt") }) });
  const body = { schemaVersion: 1 as const, kind: "aloha.final-simulation-six-step-evidence-v1" as const, correlationId: h("correlation"), generationId: binding.generationId, source, programHash, finalSimulationReceiptHash: receiptHash, facts };
  const capability = Object.freeze(Object.create(null));
  finalEvidence.set(capability, Object.freeze({ ...body, evidenceRoot: hashDomain("aloha/final-simulation-six-step-evidence/v1", body) }));
  return capability;
}

const executionEvidenceAuthority = Object.freeze({ read: (capability: object) => {
  const value = executionEvidence.get(capability);
  if (value === undefined) throw new TypeError("execution evidence was not issued");
  return value;
} });
const finalEvidenceAuthority = Object.freeze({ read: (capability: object) => {
  const value = finalEvidence.get(capability);
  if (value === undefined) throw new TypeError("final evidence was not issued");
  return value;
} });

const handles = new Map<Hash, { readonly graph: GraphRouteHandle; readonly issued: IssuedRouteHandle }>();

function edge(id: string, from: string, to: string): RuntimeGraphEdgeV1 {
  const edgeId = h(`edge-${id}`);
  const graph = Object.freeze(Object.create(null)) as GraphRouteHandle;
  const issued = Object.freeze({ opaque: Object.freeze(Object.create(null)) });
  handles.set(edgeId, { graph, issued });
  return Object.freeze({
    edgeId,
    inputAssetPorts: Object.freeze([{ ...asset(from), portRef: h(`port-${id}-in`), ordinal: "0" }]),
    outputAssetPorts: Object.freeze([{ ...asset(to), portRef: h(`port-${id}-out`), ordinal: "0" }]),
    opaqueTransitionRef: h(`transition-${id}`),
    constraintRefs: Object.freeze([h(`constraint-${id}`)]),
    owningFamilyId: `opaque-owner-${id}`,
    owningFamilyDefinitionHash: h(`owner-definition-${id}`),
    owningInstanceKey: `opaque-instance-${id}`,
    instancePublicationHash: h(`publication-${id}`),
    staticProjectionHash: h(`static-projection-${id}`),
    projectionHash: h(`projection-${id}`),
    rehydrationRef: Object.freeze({
      familyDefinitionHash: h(`owner-definition-${id}`),
      instanceKey: `opaque-instance-${id}`,
      instancePublicationHash: h(`publication-${id}`),
      staticProjectionMemoHash: h(`projection-memo-${id}`),
      requestedArtifactDependencyRoot: h(`requested-dependencies-${id}`),
    }),
    routeHandle: graph,
  });
}

const edges = Object.freeze([
  edge("ab", "a", "b"), edge("ba", "b", "a"),
  edge("ac", "a", "c"), edge("ca", "c", "a"),
  edge("ad", "a", "d"), edge("da", "d", "a"),
  edge("ae", "a", "e"), edge("ea", "e", "a"),
]);

const planningProblem = issueRouteCyclePlanningProblem({
  generationId: binding.generationId,
  definitionCatalogRoot: binding.definitionCatalogRoot,
  graphRoot: binding.graphRoot,
  edges,
  releaseProvenanceHash: binding.releaseProvenanceHash,
  readyRecordHash: binding.readyRecordHash,
  sourceHash: h("block"),
  correlationId: h("correlation"),
  objectiveRef,
  entryAssetRef: objectivePayload.numeraireAssetRef,
});
const candidates = enumerateClosedLoopPlanningProblem({ problem: planningProblem }).candidates;
assert.equal(candidates.length, 4);
const [boundedCandidate, rankableCandidate, notProbedCandidate, unrankedCandidate] = candidates;
assert.ok(boundedCandidate && rankableCandidate && notProbedCandidate && unrankedCandidate);

function lease(): GraphViewLeaseV1 {
  return {
    binding,
    edges,
    assertActive: async () => {},
    resolveRouteHandle: async (edgeId: Hash, graph: GraphRouteHandle) => {
      const handlesForEdge = handles.get(edgeId);
      if (handlesForEdge === undefined || handlesForEdge.graph !== graph) throw new Error("unexpected graph handle");
      return handlesForEdge.issued;
    },
    release: () => {},
    leaseId: h("lease"),
    released: false,
  } as unknown as GraphViewLeaseV1;
}

function sourceSession(): CurrentSourceSessionV1 {
  return Object.freeze({ sessionId: h("source-session"), source, assertCurrent: () => {} });
}

function input(): RoutePipelineInputV1 {
  return {
    lease: lease(),
    planningProblem,
    strategyCompositionRoot: planningProblem.strategyCompositionRoot,
    objective: { objectiveRef, payload: objectivePayload },
    currentSource: sourceSession(),
    correlationId: h("correlation"),
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
    callerId: "route-pipeline-test-caller",
    admission: { topK: 1, boundedUnrankedBudget: 1 },
  };
}

function ownerIssuedProjections(
  capability: IssuedCoarseRouteBindingV1,
  prune: boolean,
  options: Readonly<{ readonly limit?: number; readonly unavailableIndex?: number }> = {},
): readonly QualifiedCoarseProjectionV1[] {
  const route = readIssuedCoarseRouteBindingV1(capability);
  return route.legs.slice(0, options.limit ?? route.legs.length).map((leg, index) => {
    const ownerRef = h(`${route.routeHash}:coarse-owner:${index}`);
    const finalAmount = prune ? "100" : "110";
    const outputAmount = index === route.legs.length - 1 ? finalAmount : "100";
    const unavailable = options.unavailableIndex === index;
    const projection = sealCoarseEdgeProjectionV1({
      edgeId: leg.edgeId,
      transitionRef: leg.transitionRef,
      routeBindingHash: route.routeBindingHash,
      generationId: route.generationId,
      graphRoot: route.graphRoot,
      source: route.source,
      objectiveRef: route.objectiveRef,
      ownerRef,
      capabilityDigest: h(`${route.routeHash}:capability:${index}`),
      dependencyRoot: h(`${route.routeHash}:dependency:${index}`),
      stateFactsRoot: h(`${route.routeHash}:state:${index}`),
      sampleInput: { assetRef: leg.inputAssetRef, amount: "100" },
      estimatedOutput: unavailable ? null : { assetRef: leg.outputAssetRef, amount: outputAmount },
      conservativeOutputUpperBound: unavailable ? null : {
        assetRef: leg.outputAssetRef,
        amount: outputAmount,
        proofProgramRef: h(`${route.routeHash}:proof-program:${index}`),
        proofRoot: h(`${route.routeHash}:proof:${index}`),
      },
      inputCapacityUpperBound: unavailable ? null : "100",
      status: unavailable ? "unavailable" : "rankable",
      reasonCode: unavailable ? "owner-read-unavailable" : null,
    });
    const projectionCapability = Object.freeze(Object.create(null)) as CoarseProjectionCapabilityV1;
    const proofCapability = Object.freeze(Object.create(null));
    const owner = issueQualifiedCoarseProjectionOwnerCapabilityV1({
      releaseProvenanceHash: route.releaseProvenanceHash,
      releaseMembershipRoot,
      descriptor: Object.freeze({
        ownerRef,
        capabilityId: "coarse-projection",
        capabilityVersion: "1.0.0",
        schemaRef: h(`${route.routeHash}:schema:${index}`),
        interpreterHash: h(`${route.routeHash}:interpreter:${index}`),
        implementationHash: h(`${route.routeHash}:implementation:${index}`),
        boundVerifierHash: h(`${route.routeHash}:verifier:${index}`),
      }),
      port: {
        read: value => {
          if (value !== projectionCapability) throw new TypeError("projection capability not issued");
          return Object.freeze({ projection, boundProofCapability: unavailable ? null : proofCapability });
        },
        verifyConservativeBound: value => {
          if (value !== proofCapability) throw new TypeError("bound proof capability not issued");
          return Object.freeze({ verificationFactRoot: h(`${route.routeHash}:verification:${index}`) });
        },
      },
    });
    return readQualifiedCoarseProjectionV1({
      service: issueCoarseProjectionServiceV1({ owner }),
      capability: projectionCapability,
    });
  });
}

function ownerIssuedAssessment(
  capability: IssuedCoarseRouteBindingV1,
  prune: boolean,
  observe?: (projections: readonly QualifiedCoarseProjectionV1[]) => void,
): IssuedCoarseRouteAssessmentV1 {
  const projections = ownerIssuedProjections(capability, prune);
  observe?.(projections);
  return issueCoarseRouteAssessmentV1({ binding: capability, projections });
}

function familyObservationFixture(
  capability: IssuedCoarseRouteBindingV1,
  projection: QualifiedCoarseProjectionV1,
): CanonicalJson {
  const route = readIssuedCoarseRouteBindingV1(capability);
  const receipt = readQualifiedCoarseProjectionReceiptV1(projection);
  const legIndex = route.legs.findIndex(leg => leg.edgeId === receipt.projection.edgeId);
  if (legIndex < 0) throw new TypeError("fixture coarse projection is outside route binding");
  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.family-runtime-coarse-projection-observation-v1" as const,
    familyId: `fixture-family-${legIndex}`,
    familyDefinitionHash: h(`fixture-family-definition-${legIndex}`),
    releaseMembershipRoot: receipt.releaseMembershipRoot,
    binding: route,
    legIndex: String(legIndex),
    routeHandleBindingHash: h(`${route.routeHash}:route-handle:${legIndex}`),
    amountHash: h(`${route.routeHash}:amount:${legIndex}`),
    projectionId: receipt.projection.projectionId,
    stateOutcome: Object.freeze({ kind: "fixture-state-outcome", edgeId: receipt.projection.edgeId }),
    coarseOutcome: receipt.projection.status === "unavailable"
      ? null
      : Object.freeze({ kind: "fixture-coarse-outcome", projectionId: receipt.projection.projectionId }),
  });
  return Object.freeze({
    ...body,
    observationRoot: hashDomain("aloha/family-runtime-coarse-projection-observation/v1", body),
  }) as unknown as CanonicalJson;
}

function ports(): RoutePipelinePortsV1<object, object, object, object> {
  const attemptOwner = createRouteCoarseAttemptEvidenceOwnerV1();
  return {
    route: {
      resolve: ({ candidate, selections }) => {
        const legs = selections.map(selection => ({
          edgeId: selection.edgeId,
          ownerRef: h(`owner-${selection.edgeId}`),
          issuedHandle: selection.issuedHandle,
        }));
        return { routeHash: h(`route-${candidate.candidateId}`), legs, routeBindingHash: routeBindingHash(legs) };
      },
    },
    coarse: {
      assess: ({ binding: coarseBinding }) => {
        const route = readIssuedCoarseRouteBindingV1(coarseBinding);
        attemptOwner.start(coarseBinding);
        if (route.candidateId === boundedCandidate!.candidateId) return ownerIssuedAssessment(coarseBinding, true, projections => {
          for (const projection of projections) {
            attemptOwner.observe(coarseBinding, projection, familyObservationFixture(coarseBinding, projection));
          }
        });
        return null;
      },
      attemptEvidenceAuthority: attemptOwner.authority,
    },
    planner: { rejectionAuthority: noRejectionAuthority, plan: () => ({ kind: "retryable", stage: "planner", code: "test-failure" }) },
    exact: { rejectionAuthority: noRejectionAuthority, evaluate: () => { throw new Error("must not reach exact"); } },
    executionProgram: { rejectionAuthority: noRejectionAuthority, compile: () => { throw new Error("must not reach execution"); } },
    finalSimulation: { rejectionAuthority: noRejectionAuthority, simulate: () => { throw new Error("must not reach simulation"); } },
    economicSafety: createContractEconomicSafetyService(binding.releaseProvenanceHash, h),
    sixStepArtifacts: createProductionSixStepTailFixture([]),
    unsignedDryRun: { issue: () => { throw new Error("must not issue"); } },
  };
}

function successfulPortsWithSchedulerJoin(_preferredCandidateId: Hash): Readonly<{
  ports: RoutePipelinePortsV1<object, object, object, object>;
  handles: object[];
}> {
  const base = ports();
  const seeds = new WeakMap<object, Readonly<{
    correlationId: Hash;
    generationId: string;
    source: SourceViewV1;
    programHash: Hash;
    finalSimulationReceiptHash: Hash;
    schedulerCompletion: object;
  }>>();
  const handles: object[] = [];
  return Object.freeze({
    handles,
    ports: {
      ...base,
      planner: {
        rejectionAuthority: noRejectionAuthority,
        plan: ({ route }) => ({ kind: "planned", routeHash: route.routeHash, source, plan: Object.freeze({}), planHash: h(`plan-${route.routeHash}`) }),
      },
      exact: {
        rejectionAuthority: noRejectionAuthority,
        evaluate: ({ route }) => ({ kind: "verified", routeHash: route.routeHash, source, exact: Object.freeze({}), exactHash: h(`exact-${route.routeHash}`) }),
      },
      executionProgram: {
        rejectionAuthority: noRejectionAuthority,
        sixStepEvidenceAuthority: executionEvidenceAuthority,
        compile: ({ route, exactHash }) => {
          const program = sealExecutionProgram({
            kind: "execution-program",
            generationId: binding.generationId,
            source,
            routeHash: route.routeHash,
            programBytes: "0xopaque-program",
            payloadHash: h(`program-${route.routeHash}`),
            issuerRef: h("program-issuer"),
            obligationRoot: programObligationRoot,
          });
          return { kind: "compiled", program, sixStepEvidence: issueExecutionEvidence(route.routeHash, route.routeBindingHash, exactHash, program.programHash) };
        },
      },
      finalSimulation: {
        rejectionAuthority: noRejectionAuthority,
        sixStepEvidenceAuthority: finalEvidenceAuthority,
        schedulerJoinAuthority: {
          read: capability => {
            const value = seeds.get(capability);
            if (value === undefined) throw new TypeError("scheduler join seed was not issued");
            return value;
          },
        },
        simulate: ({ program, correlationId }) => {
          const finalSimulationReceiptHash = h(`simulation-${program.routeHash}`);
          const schedulerCompletion = Object.freeze(Object.create(null));
          const schedulerJoinSeed = Object.freeze(Object.create(null));
          handles.push(schedulerCompletion);
          seeds.set(schedulerJoinSeed, Object.freeze({
            correlationId,
            generationId: program.generationId,
            source: program.source,
            programHash: program.programHash,
            finalSimulationReceiptHash,
            schedulerCompletion,
          }));
          return {
            kind: "passed",
            receipt: {
              kind: "final-simulation-passed",
              generationId: binding.generationId,
              source,
              simulation: Object.freeze({}),
              programHash: program.programHash,
              effectsHash: h("effects"),
              receiptHash: finalSimulationReceiptHash,
            },
            schedulerJoinSeed,
            sixStepEvidence: issueFinalEvidence(program.programHash, finalSimulationReceiptHash),
          };
        },
      },
      unsignedDryRun: { issue: sealUnsignedDryRunReceipt },
    },
  });
}

test("route coordinator preserves selected/pruned/notProbed/failed denominator", async () => {
  const result = await runSearchPipeline(ports(), input());
  assert.equal(result.kind, "route-set-terminal", JSON.stringify(result));
  assert.equal(result.receipt.outcome, "retryable");
  assert.equal(result.receipt.accounting.total, 4);
  assert.equal(result.receipt.accounting.selected, 2);
  assert.equal(result.receipt.accounting.pruned, 0, JSON.stringify(result.receipt.accounting.entries));
  assert.equal(result.receipt.accounting.notProbed, 2);
  assert.equal(result.receipt.accounting.failed, 0);
  assert.equal(result.receipt.accounting.planningProblemHash, planningProblem.problemHash);
  assert.equal(result.receipt.accounting.enumerationTruncated, false);
  assert.equal(result.receipt.accounting.entries.every(entry => (
    entry.legs.length >= 2
    && entry.legs[0]!.inputAssetRef === objectivePayload.numeraireAssetRef
    && entry.legs.at(-1)!.outputAssetRef === objectivePayload.numeraireAssetRef
  )), true, JSON.stringify(result.receipt.accounting.entries));
  assert.equal(result.receipt.accounting.entries.filter(entry => entry.disposition === "selected").every(entry => entry.terminalKind === "retryable"), true);
  assert.equal(result.receipt.accounting.selected + result.receipt.accounting.pruned + result.receipt.accounting.notProbed + result.receipt.accounting.failed, result.receipt.accounting.total);
  assert.equal(result.receipt.signer, null);
  assert.equal(result.receipt.transactionHash, null);
  assert.ok(rankableCandidate && notProbedCandidate);
  const auditCapability = readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1(result.terminalCapability);
  const audit = readIssuedNativeFullFamilyAuditV1(auditCapability);
  const expectedLegs = result.receipt.accounting.entries.reduce((sum, entry) => sum + entry.legs.length, 0);
  assert.equal(audit.expectedCandidateCount, result.receipt.accounting.total.toString());
  assert.equal(audit.expectedLegCount, expectedLegs.toString());
  assert.equal(audit.observedReceiptCount, boundedCandidate.legs.length.toString());
  assert.equal(audit.missingLegKeys.length, expectedLegs - boundedCandidate.legs.length);
  const observedProjectedEdgeIds = new Set(audit.coarseRoutes.flatMap(route => route.legs.flatMap(leg => (
    leg.receipt === null ? [] : [leg.edgeId]
  ))));
  assert.equal(audit.expectedProjectedEdgeCount, edges.length.toString());
  assert.equal(audit.observedProjectedEdgeCount, observedProjectedEdgeIds.size.toString());
  assert.deepEqual(audit.projectedEdges.map(edge => edge.edgeId), edges.map(edge => edge.edgeId));
  assert.deepEqual(audit.missingProjectedEdgeIds, edges.flatMap(edge => (
    observedProjectedEdgeIds.has(edge.edgeId) ? [] : [edge.edgeId]
  )));
  assert.equal(audit.binding.sourceSessionId, h("source-session"));
  assert.deepEqual(audit.binding.readyCutoff, binding.cutoff);
  assert.deepEqual(audit.binding.actualCurrentSource, source);
  assert.throws(() => readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1({ ...result.terminalCapability }), /was not issued/);
  assert.throws(() => readIssuedNativeFullFamilyAuditV1({ ...auditCapability }), /was not issued/);

  const otherSession = await runSearchPipeline(ports(), {
    ...input(),
    currentSource: Object.freeze({ ...sourceSession(), sessionId: h("other-source-session") }),
  });
  assert.equal(otherSession.kind, "route-set-terminal");
  const otherAudit = readIssuedNativeFullFamilyAuditV1(
    readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1(otherSession.terminalCapability),
  );
  assert.equal(otherAudit.binding.sourceSessionId, h("other-source-session"));
  assert.notEqual(otherAudit.binding.bindingRoot, audit.binding.bindingRoot);
  assert.notEqual(otherAudit.auditRoot, audit.auditRoot);
});

test("native audit chunks all 30k projected edges without sampling and rejects broken chains", async () => {
  const result = await runSearchPipeline(ports(), input());
  assert.equal(result.kind, "route-set-terminal");
  const base = readIssuedNativeFullFamilyAuditV1(
    readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1(result.terminalCapability),
  );
  const { routeHandle: _routeHandle, ...template } = edges[0]!;
  const projectedEdges = Object.freeze(Array.from({ length: 30_000 }, (_, index) => {
    const edgeId = h(`30k-projected-edge-${index}`);
    const persisted = Object.freeze({ ...template, edgeId });
    const body = Object.freeze({
      searchAuditBindingRoot: base.binding.bindingRoot,
      edge: persisted,
      edgeId,
      owningFamilyId: persisted.owningFamilyId,
      owningFamilyDefinitionHash: persisted.owningFamilyDefinitionHash,
      owningInstanceKey: persisted.owningInstanceKey,
      instancePublicationHash: persisted.instancePublicationHash,
      projectionHash: persisted.projectionHash,
    });
    return Object.freeze({
      ...body,
      factRoot: hashDomain("aloha/native-full-family-projected-edge-fact/v1", body),
    });
  }));
  const missingProjectedEdgeIds = Object.freeze(projectedEdges.map(edgeFact => edgeFact.edgeId));
  const empty = (purpose: Parameters<typeof nativeFullFamilyAuditSequenceRootV1>[0]) =>
    nativeFullFamilyAuditSequenceRootV1(purpose, []);
  const encoded = encodeNativeFullFamilyAuditBodyV1(Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.native-full-family-audit-v1" as const,
    binding: base.binding,
    expectedCandidateCount: "0",
    expectedLegCount: "0",
    observedReceiptCount: "0",
    missingLegKeys: Object.freeze([]),
    expectedProjectedEdgeCount: "30000",
    observedProjectedEdgeCount: "0",
    missingProjectedEdgeIds,
    expectedActionLineageCount: "0",
    observedActionLineageCount: "0",
    missingActionCandidateIds: Object.freeze([]),
    denominatorRoot: empty("denominator"),
    observedReceiptRoot: empty("observed-receipts"),
    missingLegRoot: empty("missing-legs"),
    projectedEdgeDenominatorRoot: nativeFullFamilyAuditSequenceRootV1(
      "projected-edge-denominator",
      projectedEdges.map(edgeFact => edgeFact.factRoot),
    ),
    missingProjectedEdgeRoot: nativeFullFamilyAuditSequenceRootV1("missing-projected-edges", missingProjectedEdgeIds),
    actionDenominatorRoot: empty("action-denominator"),
    actionObservedRoot: empty("action-observed"),
    coarseRoutes: Object.freeze([]),
    projectedEdges,
    actionLineage: Object.freeze([]),
  }));
  assert.ok(encoded.manifestBytes.byteLength <= 500_000);
  assert.ok(encoded.chunks.length > 2);
  assert.equal(encoded.chunks.every(chunk => chunk.bytes.byteLength <= 500_000), true);
  assert.deepEqual(Object.keys(encoded.chunks[0]!.ref), ["contentSha256"]);
  assert.deepEqual(Object.keys(encoded.chunks[0]!.chunk), ["schemaVersion", "kind", "entries", "nextChunkRef"]);
  assert.equal("chunkRoot" in encoded.chunks[0]!.chunk, false);
  assert.equal("chunkClosureRoot" in encoded.manifest.sections[0]!, false);
  const topologyOnlyChange = Object.freeze({
    ...encoded.manifest,
    sections: Object.freeze(encoded.manifest.sections.map(section => Object.freeze({
      ...section,
      chunkCount: section.firstChunkRef === null ? section.chunkCount : String(BigInt(section.chunkCount) + 1n),
    }))),
  });
  assert.equal(nativeFullFamilyAuditSemanticRootV1(topologyOnlyChange), encoded.audit.auditRoot);
  assert.notEqual(nativeFullFamilyAuditSemanticRootV1(Object.freeze({
    ...encoded.manifest,
    sections: Object.freeze(encoded.manifest.sections.map((section, index) => index === 0
      ? Object.freeze({ ...section, sectionRoot: h("changed-native-audit-section-root") })
      : section)),
  })), encoded.audit.auditRoot);
  const bytesByHash = new Map(encoded.chunks.map(chunk => [chunk.ref.contentSha256, chunk.bytes]));
  const chunksByHash = new Map(encoded.chunks.map(chunk => [chunk.ref.contentSha256, chunk]));
  const sectionChunks = (section: NativeFullFamilyAuditSectionV1) => {
    const output: typeof encoded.chunks[number][] = [];
    let ref = encoded.manifest.sections.find(value => value.section === section)!.firstChunkRef;
    while (ref !== null) {
      const chunk = chunksByHash.get(ref.contentSha256)!;
      output.push(chunk);
      ref = chunk.chunk.nextChunkRef;
    }
    return output;
  };
  const materialized = decodeNativeFullFamilyAuditV1(encoded.manifestBytes, ref => bytesByHash.get(ref.contentSha256)!);
  assert.equal(materialized.projectedEdges.length, 30_000);

  const projectedChunks = sectionChunks("projected-edges");
  assert.ok(projectedChunks.length > 2);
  assert.throws(
    () => decodeNativeFullFamilyAuditV1(encoded.manifestBytes, ref => {
      if (ref.contentSha256 === projectedChunks[1]!.ref.contentSha256) throw new TypeError("missing");
      return bytesByHash.get(ref.contentSha256)!;
    }),
    /missing/,
  );
  assert.throws(
    () => decodeNativeFullFamilyAuditV1(encoded.manifestBytes, ref => (
      ref.contentSha256 === projectedChunks[0]!.ref.contentSha256
        ? projectedChunks[1]!.bytes
        : bytesByHash.get(ref.contentSha256)!
    )),
    /content mismatch/,
  );
  assert.throws(
    () => decodeNativeFullFamilyAuditV1(encoded.manifestBytes, ref => (
      ref.contentSha256 === projectedChunks[1]!.ref.contentSha256
        ? projectedChunks[0]!.bytes
        : bytesByHash.get(ref.contentSha256)!
    )),
    /content mismatch/,
  );
  const other = encodeNativeFullFamilyAuditBodyV1({
    ...(() => { const { auditRoot: _auditRoot, ...body } = encoded.audit; return body; })(),
    missingActionCandidateIds: Object.freeze([h("cross-audit")]),
    expectedActionLineageCount: "1",
    actionDenominatorRoot: nativeFullFamilyAuditSequenceRootV1("action-denominator", [h("cross-audit")]),
  });
  const otherChunksByHash = new Map(other.chunks.map(chunk => [chunk.ref.contentSha256, chunk]));
  const crossRef = other.manifest.sections.find(value => value.section === "missing-action-candidate-ids")!.firstChunkRef!;
  const crossChunk = otherChunksByHash.get(crossRef.contentSha256)!;
  assert.throws(
    () => decodeNativeFullFamilyAuditV1(encoded.manifestBytes, ref => (
      ref.contentSha256 === projectedChunks[0]!.ref.contentSha256 ? crossChunk.bytes : bytesByHash.get(ref.contentSha256)!
    )),
    /content mismatch/,
  );
  const { auditRoot: _encodedAuditRoot, ...encodedBody } = encoded.audit;
  const oversizedActionBody = Object.freeze({
    searchAuditBindingRoot: base.binding.bindingRoot,
    candidateId: h("oversized-action-candidate"),
    routeHash: h("oversized-action-route"),
    orderedEdgeIds: Object.freeze([]),
    executionProgramOwnerEvidence: Object.freeze({
      oversizedOwnerObservation: Object.freeze(Array.from({ length: 100 }, () => "x".repeat(6_000))),
    }),
  });
  assert.throws(
    () => encodeNativeFullFamilyAuditBodyV1({
      ...encodedBody,
      actionLineage: Object.freeze([Object.freeze({
        ...oversizedActionBody,
        factRoot: hashDomain("aloha/native-full-family-action-lineage-fact/v1", oversizedActionBody),
      })]) as never,
    }),
    /chunk exceeds observer artifact byte cap/,
  );

  const accountingEntries = Object.freeze(Array.from({ length: 30_000 }, (_, index) => Object.freeze({
    candidateId: h(`30k-accounting-candidate-${index}`),
    legs: Object.freeze([]),
    disposition: "notProbed" as const,
    terminalKind: "not-run" as const,
    routeHash: null,
    reasonCode: null,
    evidenceHash: null,
    policyTerminal: null,
  })).sort((left, right) => left.candidateId.localeCompare(right.candidateId)));
  const accountingBody = Object.freeze({
    planningProblemHash: base.binding.planningProblemHash,
    enumerationRoot: base.binding.plannerEnumerationRoot,
    admissionPolicyHash: result.receipt.accounting.admissionPolicyHash,
    enumerationTruncated: false,
    observedUniqueCountLowerBound: "30000",
    total: 30_000,
    selected: 0,
    pruned: 0,
    notProbed: 30_000,
    failed: 0,
    entries: accountingEntries,
  });
  const accounting = Object.freeze({ ...accountingBody, root: routeAccountingRootV1(accountingBody) });
  const { accounting: _oldAccounting, accountingRoot: _oldAccountingRoot, lineageHash: _oldLineage, ...fixedReceipt } = result.receipt;
  const terminalBody = Object.freeze({ ...fixedReceipt, accounting, accountingRoot: accounting.root });
  const terminal = Object.freeze({
    kind: "route-set-terminal" as const,
    receipt: Object.freeze({ ...terminalBody, lineageHash: routeSetTerminalLineageHashV2(terminalBody) }),
  });
  assert.match(searchTerminalEvidenceHashV2(terminal), /^0x[0-9a-f]{64}$/);
  assert.throws(
    () => searchTerminalEvidenceHashV2(Object.freeze({
      ...terminal,
      receipt: Object.freeze({
        ...terminal.receipt,
        accounting: Object.freeze({ ...accounting, entries: accounting.entries.slice(1), total: 29_999, notProbed: 29_999 }),
      }),
    })),
    /root\/count closure mismatch/,
  );
  assert.throws(
    () => searchTerminalEvidenceHashV2(Object.freeze({
      ...terminal,
      receipt: Object.freeze({
        ...terminal.receipt,
        accounting: Object.freeze({
          ...accounting,
          entries: Object.freeze([Object.freeze({ ...accounting.entries[0]!, reasonCode: "changed" }), ...accounting.entries.slice(1)]),
        }),
      }),
    })),
    /root\/count closure mismatch/,
  );
});

test("qualified per-edge absolute bounds remain rank-only without a route-domain proof", async () => {
  const result = await runSearchPipeline(ports(), input());
  assert.equal(result.kind, "route-set-terminal");
  assert.equal(result.receipt.outcome, "retryable");
  assert.equal(result.receipt.accounting.pruned, 0);
  assert.equal(result.receipt.accounting.selected, 2);
  assert.equal(result.receipt.accounting.entries.find(entry => entry.candidateId === boundedCandidate.candidateId)?.disposition, "selected");
  assert.equal(result.receipt.accounting.total, 4);
  assert.equal(result.receipt.accounting.selected + result.receipt.accounting.pruned + result.receipt.accounting.notProbed + result.receipt.accounting.failed, 4);
});

test("native audit retains unavailable receipts and leaves the unpropagated suffix explicitly missing", async () => {
  const base = ports();
  const attemptOwner = createRouteCoarseAttemptEvidenceOwnerV1();
  const result = await runSearchPipeline({
    ...base,
    coarse: {
      assess: ({ binding: coarseBinding }) => {
        attemptOwner.start(coarseBinding);
        const projections = ownerIssuedProjections(coarseBinding, false, { limit: 1, unavailableIndex: 0 });
        for (const projection of projections) {
          attemptOwner.observe(coarseBinding, projection, familyObservationFixture(coarseBinding, projection));
        }
        return null;
      },
      attemptEvidenceAuthority: attemptOwner.authority,
    },
  }, input());
  assert.equal(result.kind, "route-set-terminal", JSON.stringify(result));
  const audit = readIssuedNativeFullFamilyAuditV1(
    readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1(result.terminalCapability),
  );
  const expectedLegCount = audit.coarseRoutes.reduce((sum, route) => sum + route.legs.length, 0);
  assert.equal(audit.expectedLegCount, expectedLegCount.toString());
  assert.equal(audit.observedReceiptCount, audit.coarseRoutes.length.toString());
  assert.equal(audit.missingLegKeys.length, expectedLegCount - audit.coarseRoutes.length);
  for (const route of audit.coarseRoutes) {
    assert.equal(route.legs[0]?.receipt?.projection.status, "unavailable");
    assert.equal(route.legs[0]?.receipt?.projection.reasonCode, "owner-read-unavailable");
    assert.equal(route.legs.slice(1).every(leg => leg.receipt === null), true);
  }
});

test("a coarse attempt receipt spliced from another route fails closed", async () => {
  const base = ports();
  const attemptOwner = createRouteCoarseAttemptEvidenceOwnerV1();
  let first: QualifiedCoarseProjectionV1 | null = null;
  let firstObservation: CanonicalJson | null = null;
  const result = await runSearchPipeline({
    ...base,
    coarse: {
      assess: ({ binding: coarseBinding }) => {
        attemptOwner.start(coarseBinding);
        if (first === null) {
          first = ownerIssuedProjections(coarseBinding, false, { limit: 1 })[0]!;
          firstObservation = familyObservationFixture(coarseBinding, first);
          attemptOwner.observe(coarseBinding, first, firstObservation);
        } else {
          if (firstObservation === null) throw new TypeError("fixture coarse observation is missing");
          attemptOwner.observe(coarseBinding, first, firstObservation);
        }
        return null;
      },
      attemptEvidenceAuthority: attemptOwner.authority,
    },
  }, input());
  assert.deepEqual(result, { kind: "invalidProgram", stage: "route", code: "coarse attempt receipt 0 lineage mismatch" });
});

test("a structural coarse attempt reader cannot replace the owner-issued authority", async () => {
  const base = ports();
  const result = await runSearchPipeline({
    ...base,
    coarse: {
      ...base.coarse,
      attemptEvidenceAuthority: Object.freeze({ readAttempt() { return null; } }) as never,
    },
  }, input());
  assert.deepEqual(result, { kind: "invalidProgram", stage: "route", code: "coarse attempt evidence authority was not owner-issued" });
});

test("a structural coarse result has no assessment authority and stays bounded-unranked", async () => {
  const base = ports();
  const result = await runSearchPipeline({
    ...base,
    coarse: {
      assess: () => ({ kind: "caller-authored-coarse-result" }) as never,
    },
  }, input());
  assert.equal(result.kind, "route-set-terminal");
  assert.equal(result.receipt.outcome, "retryable");
  assert.equal(result.receipt.accounting.pruned, 0);
  assert.equal(result.receipt.accounting.failed, 0);
});

test("a non-empty zero-budget denominator is retryable, never complete-no-candidate", async () => {
  const result = await runSearchPipeline(ports(), { ...input(), admission: { topK: 0, boundedUnrankedBudget: 0 } });
  assert.equal(result.kind, "route-set-terminal");
  assert.equal(result.receipt.outcome, "retryable");
  assert.equal(result.receipt.accounting.pruned, 0);
  assert.equal(result.receipt.accounting.notProbed, 4);
  const excluded = result.receipt.accounting.entries.filter(entry => entry.terminalKind === "policyRejected");
  assert.equal(excluded.length, 4);
  assert.equal(excluded.every(entry => entry.policyTerminal?.planningProblemHash === planningProblem.problemHash), true);
  assert.equal(excluded.every(entry => entry.policyTerminal?.enumerationRoot === result.receipt.accounting.enumerationRoot), true);
  assert.equal(excluded.every(entry => entry.policyTerminal?.admissionPolicyHash === result.receipt.accounting.admissionPolicyHash), true);
  assert.equal(excluded.every(entry => entry.policyTerminal?.candidateId === entry.candidateId), true);
  assert.equal(excluded.every(entry => entry.policyTerminal?.routeHash === entry.routeHash), true);
  const issued = readIssuedSearchTerminalCapabilityV1(result.terminalCapability);
  assert.strictEqual(issued.receipt, result.receipt);
});

test("only a genuinely empty non-truncated planner denominator is complete-no-candidate", async () => {
  const emptyProblem = issueRouteCyclePlanningProblem({
    generationId: binding.generationId,
    definitionCatalogRoot: binding.definitionCatalogRoot,
    graphRoot: binding.graphRoot,
    edges: [],
    releaseProvenanceHash: binding.releaseProvenanceHash,
    readyRecordHash: binding.readyRecordHash,
    sourceHash: h("block"),
    correlationId: h("correlation"),
    objectiveRef,
    entryAssetRef: objectivePayload.numeraireAssetRef,
  });
  const emptyLease = { ...lease(), edges: Object.freeze([]) } as unknown as RoutePipelineInputV1["lease"];
  const result = await runSearchPipeline(ports(), {
    ...input(),
    lease: emptyLease,
    planningProblem: emptyProblem,
    strategyCompositionRoot: emptyProblem.strategyCompositionRoot,
  });
  assert.equal(result.kind, "route-set-terminal");
  assert.equal(result.receipt.outcome, "complete-no-candidate");
  assert.equal(result.receipt.accounting.total, 0);
  assert.equal(result.receipt.accounting.enumerationTruncated, false);
});

test("an empty denominator cannot become complete-no-candidate after the source fence expires", async () => {
  const emptyProblem = issueRouteCyclePlanningProblem({
    generationId: binding.generationId,
    definitionCatalogRoot: binding.definitionCatalogRoot,
    graphRoot: binding.graphRoot,
    edges: [],
    releaseProvenanceHash: binding.releaseProvenanceHash,
    readyRecordHash: binding.readyRecordHash,
    sourceHash: h("block"),
    correlationId: h("correlation"),
    objectiveRef,
    entryAssetRef: objectivePayload.numeraireAssetRef,
  });
  let fenceCount = 0;
  const currentSource = Object.freeze({
    sessionId: h("empty-source-session"),
    source,
    assertCurrent: () => {
      fenceCount += 1;
      if (fenceCount > 1) throw new TypeError("empty-source-stale");
    },
  });
  const result = await runSearchPipeline(ports(), {
    ...input(),
    lease: { ...lease(), edges: Object.freeze([]) } as unknown as RoutePipelineInputV1["lease"],
    planningProblem: emptyProblem,
    strategyCompositionRoot: emptyProblem.strategyCompositionRoot,
    currentSource,
  });
  assert.deepEqual(result, { kind: "retryable", stage: "route", code: "search-context-unavailable" });
  assert.ok(fenceCount >= 2);
});

test("route resolution failure is post-fenced before an invalid terminal is returned", async () => {
  let stale = false;
  const currentSource = Object.freeze({
    sessionId: h("route-failure-source-session"),
    source,
    assertCurrent: () => {
      if (stale) throw new TypeError("route-failure-source-stale");
    },
  });
  const base = ports();
  const result = await runSearchPipeline({
    ...base,
    route: {
      resolve: () => {
        stale = true;
        throw new TypeError("route-owner-failed");
      },
    },
  }, { ...input(), currentSource });
  assert.deepEqual(result, { kind: "retryable", stage: "route", code: "search-context-unavailable" });
});

test("terminal authority survives no DTO rewrite and rejects structural capability clones", async () => {
  const result = await runSearchPipeline(ports(), { ...input(), admission: { topK: 0, boundedUnrankedBudget: 0 } });
  assert.equal(result.kind, "route-set-terminal");
  const authoritative = readIssuedSearchTerminalCapabilityV1(result.terminalCapability);
  assert.equal(authoritative.kind, "route-set-terminal");
  assert.equal(authoritative.receipt.accounting.total, 4);
  const forgedDto = {
    ...result,
    receipt: {
      ...result.receipt,
      accounting: { ...result.receipt.accounting, entries: [], total: 0, selected: 0, pruned: 0, notProbed: 0, failed: 0, root: h("forged-accounting") },
      accountingRoot: h("forged-accounting"),
      lineageHash: h("forged-lineage"),
    },
  };
  const forgedRead = readIssuedSearchTerminalCapabilityV1(forgedDto.terminalCapability);
  assert.equal(forgedRead.kind, "route-set-terminal");
  if (forgedRead.kind !== "route-set-terminal") throw new Error("route terminal authority changed kind");
  assert.equal(forgedRead.receipt.accounting.total, 4);
  assert.throws(() => readIssuedSearchTerminalCapabilityV1({ ...result.terminalCapability }), /was not issued/);
  assert.equal(result.schedulerResourceJoin, null);
  assert.equal(readIssuedSearchTerminalSchedulerResourceJoinV1(result.terminalCapability), null);
  assert.throws(() => readIssuedSearchTerminalSixStepTraceV1(result.terminalCapability), /was not issued/);
});

test("successful terminal retains the exact semantic-to-scheduler join without changing canonical receipts", async () => {
  const firstFixture = successfulPortsWithSchedulerJoin(rankableCandidate!.candidateId);
  const first = await runSearchPipeline(firstFixture.ports, { ...input(), admission: { topK: 0, boundedUnrankedBudget: 1 } });
  assert.equal(first.kind, "unsigned-dry-run");
  assert.ok(first.schedulerResourceJoin);
  const firstJoin = readIssuedSearchTerminalSchedulerResourceJoinV1(first.terminalCapability);
  assert.notEqual(firstJoin, null);
  assert.equal(firstJoin!.correlationId, first.receipt.correlationId);
  assert.equal(firstJoin!.generationId, first.receipt.generationId);
  assert.deepEqual(firstJoin!.source, first.receipt.source);
  assert.equal(firstJoin!.programHash, first.receipt.programHash);
  assert.equal(firstJoin!.finalSimulationReceiptHash, first.receipt.finalSimulationReceiptHash);
  assert.equal(firstJoin!.unsignedDryRunCandidateId, first.receipt.candidateId);
  assert.equal(firstJoin!.unsignedDryRunLineageHash, first.receipt.lineageHash);
  assert.strictEqual(firstJoin!.schedulerCompletion, firstFixture.handles[0]);
  const firstTrace = readIssuedSearchTerminalSixStepTraceV1(first.terminalCapability);
  const firstArtifacts = readIssuedSearchTerminalSixStepArtifactCapabilitiesV1(first.terminalCapability);
  assert.equal(firstArtifacts.stage1.length, first.receipt.orderedEdgeIds.length);
  assert.equal(firstArtifacts.stage2.length, first.receipt.orderedEdgeIds.length);
  assert.deepEqual(
    [firstArtifacts.stage3, firstArtifacts.stage4, firstArtifacts.stage5, firstArtifacts.stage6]
      .map(capability => readProductionSixStepArtifactMaterialV1(capability).artifactSetRoot),
    firstTrace.resolved.productionArtifactSetRoots,
  );
  const coarseTiming = readIssuedSearchTerminalCoarseTimingV1(first.terminalCapability);
  const candidateTimings = readIssuedSearchTerminalCandidateTimingsV1(first.terminalCapability);
  assert.equal(coarseTiming.correlationId, first.receipt.correlationId);
  assert.equal(coarseTiming.generationId, first.receipt.generationId);
  assert.equal(coarseTiming.planningProblemHash, first.accounting.planningProblemHash);
  assert.equal(coarseTiming.enumerationRoot, first.accounting.enumerationRoot);
  assert.equal(coarseTiming.admissionPolicyHash, first.accounting.admissionPolicyHash);
  assert.ok(BigInt(coarseTiming.finishedMonotonicNs) >= BigInt(coarseTiming.startedMonotonicNs));
  assert.equal(BigInt(coarseTiming.durationUs), (BigInt(coarseTiming.finishedMonotonicNs) - BigInt(coarseTiming.startedMonotonicNs)) / 1_000n);
  assert.equal(firstTrace.resolved.routeCandidateId, first.receipt.candidateId);
  assert.equal(firstTrace.resolved.correlationId, first.receipt.correlationId);
  assert.equal(firstTrace.resolved.source.hash, first.receipt.source.hash);
  assert.equal(firstTrace.planningProblemHash, planningProblem.problemHash);
  assert.equal(firstTrace.admission.accountingRoot, first.accounting.root);
  assert.equal(candidateTimings.length, first.accounting.total);
  assert.deepEqual(candidateTimings.map(value => value.candidateId), first.accounting.entries.map(value => value.candidateId));
  const passedTiming = candidateTimings.find(value => value.terminalKind === "passed")!;
  assert.equal(passedTiming.terminalLineageHash, first.receipt.lineageHash);
  assert.equal(passedTiming.evidenceHash, first.receipt.lineageHash);
  assert.equal(passedTiming.sixStepEvidenceRoot, firstTrace.traceRoot);
  for (const timing of candidateTimings) {
    assert.ok(BigInt(timing.finishedMonotonicNs) >= BigInt(timing.startedMonotonicNs));
    assert.equal(BigInt(timing.timingUs), (BigInt(timing.finishedMonotonicNs) - BigInt(timing.startedMonotonicNs)) / 1_000n);
  }
  assert.deepEqual(firstTrace.selectedGraphLegs.map(leg => leg.edgeId), first.receipt.orderedEdgeIds);
  assert.deepEqual(firstTrace.selectedGraphLegs.map(leg => leg.instancePublicationHash), first.receipt.orderedEdgeIds.map(edgeId => edges.find(edge => edge.edgeId === edgeId)!.instancePublicationHash));
  for (const timing of Object.values(firstTrace.resolved.timings)) {
    assert.ok(BigInt(timing.finishedMonotonicNs) >= BigInt(timing.startedMonotonicNs));
    assert.equal(BigInt(timing.durationUs), (BigInt(timing.finishedMonotonicNs) - BigInt(timing.startedMonotonicNs)) / 1_000n);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(first.receipt, "schedulerCompletion"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first.receipt, "sixStepTrace"), false);
  assert.equal(JSON.stringify(first.receipt).includes("schedulerCompletion"), false);
  assert.equal(JSON.stringify(first.receipt).includes("six-step-trace"), false);
  assert.throws(
    () => readIssuedSearchTerminalSchedulerResourceJoinV1({ ...first.terminalCapability }),
    /was not issued/,
  );
  assert.throws(
    () => readIssuedSearchTerminalSixStepTraceV1({ ...first.terminalCapability }),
    /was not issued/,
  );
  assert.throws(
    () => readIssuedSearchTerminalSixStepArtifactCapabilitiesV1({ ...first.terminalCapability }),
    /was not issued/,
  );
  assert.throws(
    () => readIssuedSearchTerminalCoarseTimingV1({ ...first.terminalCapability }),
    /was not issued/,
  );
  assert.throws(
    () => readIssuedSearchTerminalCandidateTimingsV1({ ...first.terminalCapability }),
    /was not issued/,
  );

});

test("native action denominator reports missing owner evidence at the execution-program boundary", async () => {
  const fixture = successfulPortsWithSchedulerJoin(rankableCandidate!.candidateId);
  const executionProgram = fixture.ports.executionProgram;
  const result = await runSearchPipeline({
    ...fixture.ports,
    executionProgram: {
      rejectionAuthority: executionProgram.rejectionAuthority,
      compile: async (inputValue: Parameters<typeof executionProgram.compile>[0]) => {
        const compiled = await executionProgram.compile(inputValue);
        if (compiled.kind !== "compiled") return compiled;
        return Object.freeze({ kind: "compiled" as const, program: compiled.program });
      },
    },
  }, { ...input(), admission: { topK: 0, boundedUnrankedBudget: 1 } });
  assert.equal(result.kind, "route-set-terminal", JSON.stringify(result));
  const selected = result.receipt.accounting.entries.filter(entry => entry.disposition === "selected");
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.terminalKind, "invalidProgram");
  assert.equal(selected[0]?.reasonCode, "execution-program:owner-evidence-missing");
  const audit = readIssuedNativeFullFamilyAuditV1(
    readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1(result.terminalCapability),
  );
  assert.equal(audit.expectedActionLineageCount, "0");
  assert.equal(audit.observedActionLineageCount, "0");
  assert.deepEqual(audit.missingActionCandidateIds, []);
  assert.deepEqual(audit.actionLineage, []);
});

test("incomplete, cloned, or semantically rebound final-sim seeds cannot issue a terminal scheduler join", async () => {
  const fixture = successfulPortsWithSchedulerJoin(rankableCandidate!.candidateId);
  const baseFinalSimulation = fixture.ports.finalSimulation;
  const cases: readonly RoutePipelinePortsV1<object, object, object, object>["finalSimulation"][] = [
    {
      rejectionAuthority: noRejectionAuthority,
      schedulerJoinAuthority: baseFinalSimulation.schedulerJoinAuthority,
      simulate: async inputValue => {
        const passed = await baseFinalSimulation.simulate(inputValue);
        if (passed.kind !== "passed") return passed;
        return { ...passed, schedulerJoinSeed: { ...passed.schedulerJoinSeed! } };
      },
    },
    {
      ...baseFinalSimulation,
      schedulerJoinAuthority: undefined,
    },
    {
      ...baseFinalSimulation,
      schedulerJoinAuthority: {
        read: capability => ({
          ...baseFinalSimulation.schedulerJoinAuthority!.read(capability),
          finalSimulationReceiptHash: h("rebound-final-simulation"),
        }),
      },
    },
  ];
  for (const finalSimulation of cases) {
    const result = await runSearchPipeline({ ...fixture.ports, finalSimulation }, { ...input(), admission: { topK: 0, boundedUnrankedBudget: 1 } });
    assert.equal(result.kind, "route-set-terminal");
    assert.equal(result.schedulerResourceJoin, null);
    assert.equal(result.receipt.accounting.entries.some(entry => entry.terminalKind === "passed"), false);
  }
});

test("a later dry-run success retains an earlier admitted retryable candidate", async () => {
  const base = ports();
  let plannerAttempt = 0;
  const result = await runSearchPipeline({
    ...base,
    planner: {
      rejectionAuthority: noRejectionAuthority,
      plan: ({ route }) => {
        plannerAttempt += 1;
        if (plannerAttempt === 1) return { kind: "retryable", stage: "planner", code: "temporary-resource" };
        return { kind: "planned", routeHash: route.routeHash, source, plan: Object.freeze({}), planHash: h("plan") };
      },
    },
    exact: {
      rejectionAuthority: noRejectionAuthority,
      evaluate: ({ route }) => ({ kind: "verified", routeHash: route.routeHash, source, exact: Object.freeze({}), exactHash: h("exact") }),
    },
    executionProgram: {
      rejectionAuthority: noRejectionAuthority,
      sixStepEvidenceAuthority: executionEvidenceAuthority,
      compile: ({ route, exactHash }) => {
        const program = sealExecutionProgram({
          kind: "execution-program",
          generationId: binding.generationId,
          source,
          routeHash: route.routeHash,
          programBytes: "0xopaque-program",
          payloadHash: h("program-payload"),
          issuerRef: h("program-issuer"),
          obligationRoot: programObligationRoot,
        });
        return { kind: "compiled", program, sixStepEvidence: issueExecutionEvidence(route.routeHash, route.routeBindingHash, exactHash, program.programHash) };
      },
    },
    finalSimulation: {
      rejectionAuthority: noRejectionAuthority,
      sixStepEvidenceAuthority: finalEvidenceAuthority,
      simulate: ({ program }) => {
        const receiptHash = h("simulation-receipt");
        return { kind: "passed", receipt: {
          kind: "final-simulation-passed",
          generationId: binding.generationId,
          source,
          simulation: Object.freeze({}),
          programHash: program.programHash,
          effectsHash: h("effects"),
          receiptHash,
        }, sixStepEvidence: issueFinalEvidence(program.programHash, receiptHash) };
      },
    },
    unsignedDryRun: { issue: sealUnsignedDryRunReceipt },
  }, { ...input(), admission: { topK: 0, boundedUnrankedBudget: 2 } });
  assert.equal(result.kind, "unsigned-dry-run");
  assert.equal(result.accounting.selected, 2);
  assert.equal(result.accounting.entries.filter(entry => entry.terminalKind === "retryable").length, 1);
  const passed = result.accounting.entries.filter(entry => entry.terminalKind === "passed");
  assert.equal(passed.length, 1);
  assert.equal(result.receipt.candidateId, passed[0]?.candidateId);
});

test("first-eligible short-circuit issues a winner-bound post-success policy terminal", async () => {
  const base = ports();
  const result = await runSearchPipeline({
    ...base,
    planner: {
      rejectionAuthority: noRejectionAuthority,
      plan: ({ route }) => ({ kind: "planned", routeHash: route.routeHash, source, plan: Object.freeze({}), planHash: h(`plan-${route.routeHash}`) }),
    },
    exact: {
      rejectionAuthority: noRejectionAuthority,
      evaluate: ({ route }) => ({ kind: "verified", routeHash: route.routeHash, source, exact: Object.freeze({}), exactHash: h(`exact-${route.routeHash}`) }),
    },
    executionProgram: {
      rejectionAuthority: noRejectionAuthority,
      sixStepEvidenceAuthority: executionEvidenceAuthority,
      compile: ({ route, exactHash }) => {
        const program = sealExecutionProgram({
          kind: "execution-program",
          generationId: binding.generationId,
          source,
          routeHash: route.routeHash,
          programBytes: "0xopaque-program",
          payloadHash: h(`program-${route.routeHash}`),
          issuerRef: h("program-issuer"),
          obligationRoot: programObligationRoot,
        });
        return { kind: "compiled", program, sixStepEvidence: issueExecutionEvidence(route.routeHash, route.routeBindingHash, exactHash, program.programHash) };
      },
    },
    finalSimulation: {
      rejectionAuthority: noRejectionAuthority,
      sixStepEvidenceAuthority: finalEvidenceAuthority,
      simulate: ({ program }) => {
        const receiptHash = h(`simulation-${program.routeHash}`);
        return { kind: "passed", receipt: {
          kind: "final-simulation-passed",
          generationId: binding.generationId,
          source,
          simulation: Object.freeze({}),
          programHash: program.programHash,
          effectsHash: h("effects"),
          receiptHash,
        }, sixStepEvidence: issueFinalEvidence(program.programHash, receiptHash) };
      },
    },
    unsignedDryRun: { issue: sealUnsignedDryRunReceipt },
  }, { ...input(), admission: { topK: 0, boundedUnrankedBudget: 2 } });
  assert.equal(result.kind, "unsigned-dry-run");
  const remaining = result.accounting.entries.filter(entry => entry.reasonCode === "post-success:first-eligible");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.terminalKind, "policyRejected");
  assert.equal(remaining[0]?.policyTerminal?.kind, "aloha.route-post-success-policy-terminal-v1");
  if (remaining[0]?.policyTerminal?.kind !== "aloha.route-post-success-policy-terminal-v1") throw new Error("post-success terminal is missing");
  assert.equal(remaining[0].policyTerminal.winnerCandidateId, result.receipt.candidateId);
  assert.equal(remaining[0].policyTerminal.winnerTerminalLineageHash, result.receipt.lineageHash);
  assert.equal(remaining[0].evidenceHash, remaining[0].policyTerminal.receiptHash);
  const authoritative = readIssuedSearchTerminalCapabilityV1(result.terminalCapability);
  assert.equal(authoritative.kind, "unsigned-dry-run");
  assert.equal(authoritative.accounting.entries.some(entry => entry.terminalKind === "not-run"), false);
});

test("objective payload mutation is rejected before route or coarse admission", async () => {
  const base = ports();
  let routeCalled = false;
  let coarseCalled = false;
  const result = await runSearchPipeline({
    ...base,
    route: {
      resolve: inputValue => {
        routeCalled = true;
        return base.route.resolve(inputValue);
      },
    },
    coarse: {
      assess: inputValue => {
        coarseCalled = true;
        return base.coarse.assess(inputValue);
      },
    },
  }, {
    ...input(),
    objective: { objectiveRef, payload: { ...objectivePayload, minNetGain: "3" } },
  });
  assert.deepEqual(result, { kind: "invalidProgram", stage: "input", code: "objective-hash-mismatch" });
  assert.equal(routeCalled, false);
  assert.equal(coarseCalled, false);
});

test("coarse owner receives the exact current-source capability and canonical objective profile", async () => {
  const base = ports();
  let fenceCount = 0;
  const currentSource = Object.freeze({
    sessionId: h("exact-coarse-source-session"),
    source,
    assertCurrent: () => { fenceCount += 1; },
  });
  const sourceClone = { ...currentSource, assertCurrent: () => { throw new Error("source clone must not run"); } };
  const pipelineInput = { ...input(), currentSource };
  let received: CurrentSourceSessionV1 | null = null;
  const receivedObjective: { value: SearchObjectiveV1 | null } = { value: null };
  const result = await runSearchPipeline({
    ...base,
    coarse: {
      assess: async ({ currentSource: ownerSource, objective }) => {
        received = ownerSource;
        receivedObjective.value = objective;
        await ownerSource.assertCurrent();
        assert.strictEqual(ownerSource.source, source);
        await ownerSource.assertCurrent();
        return null;
      },
    },
  }, pipelineInput);
  assert.equal(result.kind, "route-set-terminal");
  assert.strictEqual(received, currentSource);
  assert.notStrictEqual(receivedObjective.value, pipelineInput.objective);
  assert.equal(receivedObjective.value?.objectiveRef, objectiveRef);
  assert.deepEqual(receivedObjective.value?.payload, objectivePayload);
  assert.notStrictEqual(received, sourceClone);
  assert.ok(fenceCount >= 3);

  let coarseCalled = false;
  const wrongSource = Object.freeze({ ...source, hash: h("wrong-coarse-source") });
  const rejected = await runSearchPipeline({
    ...base,
    coarse: { assess: () => { coarseCalled = true; return null; } },
  }, {
    ...input(),
    currentSource: Object.freeze({ sessionId: h("wrong-source-session"), source: wrongSource, assertCurrent: () => {} }),
  });
  assert.deepEqual(rejected, { kind: "invalidProgram", stage: "input", code: "planning-problem-binding-mismatch" });
  assert.equal(coarseCalled, false);
});

test("planning problem from another active Strategy composition cannot enter the route pipeline", async () => {
  const base = ports();
  let routeCalled = false;
  const result = await runSearchPipeline({
    ...base,
    route: {
      resolve: value => {
        routeCalled = true;
        return base.route.resolve(value);
      },
    },
  }, {
    ...input(),
    strategyCompositionRoot: h("foreign-strategy-composition"),
  });
  assert.deepEqual(result, { kind: "invalidProgram", stage: "input", code: "planning-problem-binding-mismatch" });
  assert.equal(routeCalled, false);
});

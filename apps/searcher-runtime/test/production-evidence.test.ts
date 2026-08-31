import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeCanonicalBytes, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetReferenceV1 } from "../../../packages/asset-ref/src/index.ts";
import { createSqliteDurableStore } from "../../../packages/durable-store/src/index.ts";
import type { CanonicalHead, ProducerSessionV1, ProducerTerminalV1 } from "../../../packages/producer/src/index.ts";
import {
  issueProducerHeadFactsCapabilityV1,
  issueProducerHeadTerminalCapabilityV1,
} from "../../../packages/producer/src/internal/owners.ts";
import { issueStartupRuntime } from "../../../packages/startup-runtime/src/internal/runtime-owner.ts";
import { createContractEconomicSafetyService } from "../../../packages/search-pipeline/test/economic-safety-fixture.ts";
import type { RuntimeAnchorReceiptV1 } from "../src/deployment.ts";
import {
  assertIssuedSearcherProductionEvidenceOwnerV1,
  decodeProductionExecutionRouteAssetReferencesV1,
  issueSearcherProductionEvidenceOwnerV1,
  missingExternalRuntimeAnchorEvidenceV1,
  readSearcherProductionEvidenceHighCardinalityV1,
  SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES,
} from "../src/production-evidence.ts";
import {
  exactProductionPlanningProblemV1,
  exactProductionRouteCandidateV1,
  validateProductionCandidateEvidenceJoinV1,
  validateProductionPlanningContextJoinV1,
  validateProductionPassedCandidateSixStepJoinV1,
  validateProductionResolvedRouteBindingV1,
  validateProductionStage2EdgeMembershipV1,
  validateProductionStrategyQualificationV1,
} from "../src/internal/production-evidence-validation.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const release = Object.freeze({ bindingId: h("1"), releaseProvenanceHash: h("2"), candidateReleaseCommit: "a".repeat(40) });
const economicSafety = createContractEconomicSafetyService(release.releaseProvenanceHash, h);
const graphRoot = h("3");
const head: CanonicalHead = Object.freeze({ chainId: "1", number: "101", hash: h("4"), parentHash: h("5"), stateRoot: h("6") });
const sessionCapability = Object.freeze(Object.create(null)) as ProducerSessionV1;

test("production evidence owner requires the exact owner-issued economic-safety release authority", t => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-economic-authority-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "evidence.sqlite");
  assert.throws(
    () => issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor() } as never),
    /economicSafety/,
  );
  assert.throws(
    () => issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor(), economicSafety: Object.freeze({ binding() { return {}; } }) as never }),
    /not owner-issued/,
  );
  assert.throws(
    () => issueSearcherProductionEvidenceOwnerV1({
      databasePath,
      release,
      runtimeAnchor: runtimeAnchor(),
      economicSafety: createContractEconomicSafetyService(h("foreign-release"), h),
    }),
    /economic-safety release mismatch/,
  );
  assert.throws(
    () => issueSearcherProductionEvidenceOwnerV1({
      databasePath,
      release,
      runtimeAnchor: runtimeAnchor(),
      economicSafety,
      strategyRuntime: Object.freeze({ readEvidenceExpectation() { return {}; } }) as never,
    }),
    /Strategy runtime service is not owner-issued/,
  );
});

test("production Six-Step route asset references exact-cover action assets and reject schema/root splices", () => {
  const assetA = erc20AssetReferenceV1("1", "0x1111111111111111111111111111111111111111");
  const assetB = erc20AssetReferenceV1("1", "0x2222222222222222222222222222222222222222");
  const references = Object.freeze([assetA, assetB].sort((left, right) => left.assetRef.localeCompare(right.assetRef)));
  const actionOwners = Object.freeze([
    Object.freeze({ inputs: Object.freeze([{ assetRef: assetA.assetRef, amount: "10" }]), outputs: Object.freeze([{ assetRef: assetB.assetRef, amount: "9" }]) }),
    Object.freeze({ inputs: Object.freeze([{ assetRef: assetB.assetRef, amount: "9" }]), outputs: Object.freeze([{ assetRef: assetA.assetRef, amount: "11" }]) }),
  ]);
  assert.deepEqual(decodeProductionExecutionRouteAssetReferencesV1(references, actionOwners, "1"), references);
  assert.throws(
    () => decodeProductionExecutionRouteAssetReferencesV1([{ ...references[0], producerVerdict: "pass" }, references[1]], actionOwners, "1"),
    /unknown field/,
  );
  assert.throws(
    () => decodeProductionExecutionRouteAssetReferencesV1([references[1], references[0]], actionOwners, "1"),
    /strictly ordered/,
  );
  assert.throws(
    () => decodeProductionExecutionRouteAssetReferencesV1([references[0], references[0]], actionOwners, "1"),
    /strictly ordered/,
  );
  assert.throws(
    () => decodeProductionExecutionRouteAssetReferencesV1(references, actionOwners, "2"),
    /chain id mismatch/,
  );
  assert.throws(
    () => decodeProductionExecutionRouteAssetReferencesV1([references[0]], actionOwners, "1"),
    /does not exact-cover/,
  );
  assert.throws(
    () => decodeProductionExecutionRouteAssetReferencesV1(references, [{ inputs: [{ assetRef: assetA.assetRef, amount: "10", verdict: "pass" }], outputs: [{ assetRef: assetB.assetRef, amount: "9" }] }], "1"),
    /unknown field/,
  );
  assert.throws(
    () => decodeProductionExecutionRouteAssetReferencesV1([{ ...assetA, assetRef: h("f") }, assetB].sort((left, right) => left.assetRef.localeCompare(right.assetRef)), actionOwners, "1"),
    /does not match identity/,
  );
});

test("production candidate evidence join distinguishes passed lineage from accounting evidence", () => {
  const lineageHash = h("a");
  const sixStepEvidenceRoot = h("b");
  const passedEntry = Object.freeze({ terminalKind: "passed" as const, evidenceHash: null, reasonCode: null });
  const passedObservation = Object.freeze({
    terminalKind: "passed" as const,
    evidenceHash: lineageHash,
    terminalLineageHash: lineageHash,
    sixStepEvidenceRoot,
  });
  assert.doesNotThrow(() => validateProductionCandidateEvidenceJoinV1(passedEntry, passedObservation));
  assert.throws(
    () => validateProductionCandidateEvidenceJoinV1({ ...passedEntry, evidenceHash: h("c") }, passedObservation),
    /passed candidate lineage evidence splice/,
  );
  assert.throws(
    () => validateProductionCandidateEvidenceJoinV1({ ...passedEntry, reasonCode: "forged-pass" }, passedObservation),
    /passed candidate lineage evidence splice/,
  );
  assert.throws(
    () => validateProductionCandidateEvidenceJoinV1(passedEntry, { ...passedObservation, evidenceHash: h("d") }),
    /passed candidate lineage evidence splice/,
  );
  assert.throws(
    () => validateProductionCandidateEvidenceJoinV1(passedEntry, { ...passedObservation, terminalLineageHash: h("d") }),
    /passed candidate lineage evidence splice/,
  );
  assert.throws(
    () => validateProductionCandidateEvidenceJoinV1(passedEntry, { ...passedObservation, sixStepEvidenceRoot: null }),
    /passed candidate lineage evidence splice/,
  );

  const rejectedEvidence = h("e");
  const rejectedEntry = Object.freeze({ terminalKind: "chainProvenRejected" as const, evidenceHash: rejectedEvidence, reasonCode: "chain-rejected" });
  const rejectedObservation = Object.freeze({
    terminalKind: "chainProvenRejected" as const,
    evidenceHash: rejectedEvidence,
    terminalLineageHash: null,
    sixStepEvidenceRoot: null,
  });
  assert.doesNotThrow(() => validateProductionCandidateEvidenceJoinV1(rejectedEntry, rejectedObservation));
  assert.throws(
    () => validateProductionCandidateEvidenceJoinV1(rejectedEntry, { ...rejectedObservation, terminalLineageHash: lineageHash }),
    /non-passed candidate evidence splice/,
  );
  assert.throws(
    () => validateProductionCandidateEvidenceJoinV1(rejectedEntry, { ...rejectedObservation, sixStepEvidenceRoot }),
    /non-passed candidate evidence splice/,
  );
});

test("production passed candidate exact-joins the selected Six-Step lineage", () => {
  const sixStep = Object.freeze({
    candidateId: h("1"),
    correlationId: h("2"),
    generationId: "generation-1",
    graphRoot: h("f"),
    planningProblemHash: h("3"),
    enumerationRoot: h("4"),
    admissionPolicyHash: h("5"),
    accountingRoot: h("6"),
    routeHash: h("7"),
    unsignedDryRunLineageHash: h("8"),
    stage36Root: h("9"),
  });
  const candidate = Object.freeze({
    candidateId: sixStep.candidateId,
    correlationId: sixStep.correlationId,
    generationId: sixStep.generationId,
    graphRoot: sixStep.graphRoot,
    planningProblemHash: sixStep.planningProblemHash,
    enumerationRoot: sixStep.enumerationRoot,
    admissionPolicyHash: sixStep.admissionPolicyHash,
    routeHash: sixStep.routeHash,
    terminalLineageHash: sixStep.unsignedDryRunLineageHash,
    sixStepEvidenceRoot: sixStep.stage36Root,
  });
  assert.doesNotThrow(() => validateProductionPassedCandidateSixStepJoinV1({ candidate, accountingRoot: sixStep.accountingRoot, sixStep }));
  assert.throws(
    () => validateProductionPassedCandidateSixStepJoinV1({ candidate: { ...candidate, terminalLineageHash: h("a") }, accountingRoot: sixStep.accountingRoot, sixStep }),
    /passed candidate Six-Step splice/,
  );
  assert.throws(
    () => validateProductionPassedCandidateSixStepJoinV1({ candidate: { ...candidate, sixStepEvidenceRoot: h("b") }, accountingRoot: sixStep.accountingRoot, sixStep }),
    /passed candidate Six-Step splice/,
  );
  assert.throws(
    () => validateProductionPassedCandidateSixStepJoinV1({ candidate: { ...candidate, generationId: "generation-2" }, accountingRoot: sixStep.accountingRoot, sixStep }),
    /passed candidate Six-Step splice/,
  );
  assert.throws(
    () => validateProductionPassedCandidateSixStepJoinV1({ candidate, accountingRoot: h("c"), sixStep }),
    /passed candidate Six-Step splice/,
  );
});

test("production planner witness rejects a self-consistent route-body replacement outside the accounting entry", () => {
  const problemBody = Object.freeze({
    kind: "closed-loop" as const,
    objectiveRef: h("1"),
    entryAssetRef: h("2"),
    returnAssetRef: h("2"),
    minLegs: "2",
    maxLegs: "4",
    candidateLimit: "16",
    edgeReuse: "forbid" as const,
    requiredAnchorEdgeIds: Object.freeze([]),
    constraintSchemaRefs: Object.freeze([h("3")]),
    strategyId: "strategy-1",
    strategyDefinitionHash: h("4"),
    strategyCatalogLeafDigest: h("5"),
    definitionCatalogRoot: h("6"),
    generationId: "generation-1",
    graphRoot: h("7"),
    triggerRef: h("8"),
    lane: "blockscan" as const,
    triggerCorrelationId: h("9"),
    triggerHeadHash: h("a"),
    requiredCapabilityPredicates: Object.freeze([{ capabilityId: "swap", minimumVersion: "1", schemaRefs: Object.freeze([h("b")]) }]),
    strategyCompositionRoot: h("c"),
    strategyIssuerClosureRoot: h("d"),
    releaseProvenanceHash: h("e"),
    readyRecordHash: h("f"),
  });
  const problemValue = Object.freeze({ ...problemBody, problemHash: hashDomain("aloha/strategy-planning-problem/v1", problemBody) });
  const problem = exactProductionPlanningProblemV1(problemValue, "problem");
  const strategyEntry = Object.freeze({
    strategyId: problem.strategyId,
    strategyDefinitionHash: problem.strategyDefinitionHash,
    catalogEntry: Object.freeze({
      definitionCatalogLeafDigest: problem.strategyCatalogLeafDigest,
      planningTemplate: Object.freeze({
        minLegs: problem.minLegs,
        maxLegs: problem.maxLegs,
        candidateLimit: problem.candidateLimit,
        edgeReuse: problem.edgeReuse,
        constraintSchemaRefs: problem.constraintSchemaRefs,
      }),
      requiredCapabilityRefs: Object.freeze([{ capabilityId: "swap", version: "1", schemaHash: h("b") }]),
    }),
  });
  const strategyExpectation = Object.freeze({
    releaseProvenanceHash: problem.releaseProvenanceHash,
    definitionCatalogRoot: problem.definitionCatalogRoot,
    strategyCatalogRoot: h("a"),
    strategyCompositionRoot: problem.strategyCompositionRoot,
    strategyIssuerClosureRoot: problem.strategyIssuerClosureRoot,
    entries: Object.freeze([strategyEntry]),
  });
  assert.doesNotThrow(() => validateProductionStrategyQualificationV1(problem, strategyExpectation as never));
  assert.throws(
    () => validateProductionStrategyQualificationV1(problem, null),
    /qualification expectation is unavailable/,
  );
  assert.doesNotThrow(() => validateProductionStrategyQualificationV1(problem, {
    ...strategyExpectation,
    entries: Object.freeze([...strategyExpectation.entries, Object.freeze({
      ...strategyEntry,
      strategyId: "unrelated-strategy",
      strategyDefinitionHash: h("f"),
    })]),
  } as never));
  assert.throws(() => validateProductionStrategyQualificationV1(problem, {
    ...strategyExpectation,
    entries: Object.freeze([Object.freeze({ ...strategyEntry, strategyDefinitionHash: h("f") })]),
  } as never), /qualification expectation mismatch/);
  const legs = Object.freeze([
    Object.freeze({ edgeId: h("1"), transitionRef: h("2"), inputAssetRef: h("2"), inputPortRef: h("3"), outputAssetRef: h("4"), outputPortRef: h("5") }),
    Object.freeze({ edgeId: h("6"), transitionRef: h("7"), inputAssetRef: h("4"), inputPortRef: h("8"), outputAssetRef: h("2"), outputPortRef: h("9") }),
  ]);
  const sealCandidate = (candidateLegs: typeof legs, planningProblem = problem) => {
    const identity = { planningProblemHash: planningProblem.problemHash, objectiveRef: planningProblem.objectiveRef, entryAssetRef: planningProblem.entryAssetRef, returnAssetRef: planningProblem.returnAssetRef, legs: candidateLegs };
    return Object.freeze({
      candidateId: hashDomain("aloha/planner-route-candidate/v1", identity),
      planningProblemHash: planningProblem.problemHash,
      legs: candidateLegs,
      loopIntent: Object.freeze({
        kind: "closed-loop" as const,
        entryAssetRef: planningProblem.entryAssetRef,
        returnAssetRef: planningProblem.returnAssetRef,
        objectiveRef: planningProblem.objectiveRef,
        constraintSchemaRefs: planningProblem.constraintSchemaRefs,
        legs: Object.freeze(candidateLegs.map(leg => Object.freeze({
          fromAssetRef: leg.inputAssetRef,
          toAssetRef: leg.outputAssetRef,
          selectionRef: hashDomain("aloha/planner-route-selection/v1", leg),
          requiredCapabilityPredicates: planningProblem.requiredCapabilityPredicates,
        }))),
      }),
      orderKey: hashDomain("aloha/planner-route-order/v1", identity),
    });
  };
  const candidate = sealCandidate(legs);
  const entry = Object.freeze({
    candidateId: candidate.candidateId,
    legs,
    disposition: "selected" as const,
    terminalKind: "passed" as const,
    routeHash: h("a"),
    reasonCode: null,
    evidenceHash: null,
    policyTerminal: null,
  });
  assert.doesNotThrow(() => exactProductionRouteCandidateV1(candidate, problem, entry, "candidate"));
  const replacedLegs = Object.freeze([
    Object.freeze({ ...legs[0], transitionRef: h("f") }),
    legs[1],
  ]) as typeof legs;
  const selfConsistentReplacement = sealCandidate(replacedLegs);
  assert.throws(
    () => exactProductionRouteCandidateV1(selfConsistentReplacement, problem, entry, "candidate"),
    /does not exact-join the passed accounting entry/,
  );

  const exactProblem = (overrides: Record<string, unknown>) => {
    const body = Object.freeze({ ...problemBody, ...overrides });
    return exactProductionPlanningProblemV1(
      Object.freeze({ ...body, problemHash: hashDomain("aloha/strategy-planning-problem/v1", body) }),
      "mutatedProblem",
    );
  };
  assert.throws(() => exactProblem({ minLegs: "5", maxLegs: "4" }), /planner bounds/);
  assert.throws(() => exactProblem({ candidateLimit: "100001" }), /planner bounds/);

  const oneLegMaximum = exactProblem({ minLegs: "1", maxLegs: "1" });
  const outOfBoundsCandidate = sealCandidate(legs, oneLegMaximum);
  const outOfBoundsEntry = Object.freeze({ ...entry, candidateId: outOfBoundsCandidate.candidateId });
  assert.throws(
    () => exactProductionRouteCandidateV1(outOfBoundsCandidate, oneLegMaximum, outOfBoundsEntry, "candidate"),
    /outside the planning bounds/,
  );

  const anchoredProblem = exactProblem({ requiredAnchorEdgeIds: Object.freeze([h("f")]) });
  const anchorlessCandidate = sealCandidate(legs, anchoredProblem);
  const anchorlessEntry = Object.freeze({ ...entry, candidateId: anchorlessCandidate.candidateId });
  assert.throws(
    () => exactProductionRouteCandidateV1(anchorlessCandidate, anchoredProblem, anchorlessEntry, "candidate"),
    /required anchor/,
  );

  validateProductionPlanningContextJoinV1({
    problem,
    candidateCorrelationId: problem.triggerCorrelationId,
    resolvedCorrelationId: problem.triggerCorrelationId,
    resolvedObjectiveRef: problem.objectiveRef,
  });
  const changedTriggerProblem = exactProblem({ triggerCorrelationId: h("e") });
  const changedTriggerCandidate = sealCandidate(legs, changedTriggerProblem);
  const changedTriggerEntry = Object.freeze({ ...entry, candidateId: changedTriggerCandidate.candidateId });
  assert.doesNotThrow(() => exactProductionRouteCandidateV1(changedTriggerCandidate, changedTriggerProblem, changedTriggerEntry, "candidate"));
  assert.throws(() => validateProductionPlanningContextJoinV1({
    problem: changedTriggerProblem,
    candidateCorrelationId: problem.triggerCorrelationId,
    resolvedCorrelationId: problem.triggerCorrelationId,
    resolvedObjectiveRef: changedTriggerProblem.objectiveRef,
  }), /trigger\/objective splice/);
  const changedObjectiveProblem = exactProblem({ objectiveRef: h("d") });
  const changedObjectiveCandidate = sealCandidate(legs, changedObjectiveProblem);
  const changedObjectiveEntry = Object.freeze({ ...entry, candidateId: changedObjectiveCandidate.candidateId });
  assert.doesNotThrow(() => exactProductionRouteCandidateV1(changedObjectiveCandidate, changedObjectiveProblem, changedObjectiveEntry, "candidate"));
  assert.throws(() => validateProductionPlanningContextJoinV1({
    problem: changedObjectiveProblem,
    candidateCorrelationId: changedObjectiveProblem.triggerCorrelationId,
    resolvedCorrelationId: changedObjectiveProblem.triggerCorrelationId,
    resolvedObjectiveRef: problem.objectiveRef,
  }), /trigger\/objective splice/);
});

test("production Stage2 edge witness exact-binds transition and input/output ports", () => {
  const inputPort = Object.freeze({
    assetIdentity: Object.freeze({ kind: "erc20", chainId: "1", address: "0x1111111111111111111111111111111111111111" }),
    assetRef: h("1"),
    portRef: h("2"),
    ordinal: "0",
  });
  const outputPort = Object.freeze({
    assetIdentity: Object.freeze({ kind: "erc20", chainId: "1", address: "0x2222222222222222222222222222222222222222" }),
    assetRef: h("3"),
    portRef: h("4"),
    ordinal: "0",
  });
  const edgePayload = Object.freeze({
    inputAssetPorts: Object.freeze([inputPort]),
    outputAssetPorts: Object.freeze([outputPort]),
    opaqueTransitionRef: h("5"),
    constraintRefs: Object.freeze([h("6")]),
    owningFamilyId: "family-1",
    owningFamilyDefinitionHash: h("7"),
    owningInstanceKey: "instance-1",
    instancePublicationHash: h("8"),
    staticProjectionHash: h("9"),
    projectionHash: h("a"),
    rehydrationRef: Object.freeze({
      familyDefinitionHash: h("7"),
      instanceKey: "instance-1",
      instancePublicationHash: h("8"),
      staticProjectionMemoHash: h("b"),
      requestedArtifactDependencyRoot: h("c"),
    }),
  });
  const edge = Object.freeze({
    edgeId: hashDomain("aloha/persisted-graph-edge/v1", edgePayload),
    ...edgePayload,
  });
  const leg = Object.freeze({
    edgeId: edge.edgeId,
    transitionRef: edgePayload.opaqueTransitionRef,
    inputAssetRef: inputPort.assetRef,
    inputPortRef: inputPort.portRef,
    outputAssetRef: outputPort.assetRef,
    outputPortRef: outputPort.portRef,
  });
  assert.doesNotThrow(() => validateProductionStage2EdgeMembershipV1(edge, leg, "edge"));
  assert.throws(
    () => validateProductionStage2EdgeMembershipV1(edge, { ...leg, transitionRef: h("d") }, "edge"),
    /does not contain the passed route leg/,
  );
  assert.throws(
    () => validateProductionStage2EdgeMembershipV1(edge, { ...leg, inputPortRef: h("d") }, "edge"),
    /does not contain the passed route leg/,
  );
  assert.throws(
    () => validateProductionStage2EdgeMembershipV1(edge, { ...leg, outputPortRef: h("d") }, "edge"),
    /does not contain the passed route leg/,
  );
  assert.throws(
    () => validateProductionStage2EdgeMembershipV1({ ...edge, opaqueTransitionRef: h("d") }, leg, "edge"),
    /does not contain the passed route leg/,
  );
});

test("production resolved route exact-binds planner legs to execution action owners", () => {
  const candidate = Object.freeze({
    candidateId: h("1"),
    orderKey: h("2"),
    planningProblemHash: h("3"),
    legs: Object.freeze([
      Object.freeze({ edgeId: h("4"), transitionRef: h("5"), inputAssetRef: h("6"), inputPortRef: h("7"), outputAssetRef: h("8"), outputPortRef: h("9") }),
      Object.freeze({ edgeId: h("a"), transitionRef: h("b"), inputAssetRef: h("8"), inputPortRef: h("c"), outputAssetRef: h("6"), outputPortRef: h("d") }),
    ]),
  });
  const actionOwners = Object.freeze([
    Object.freeze({ familyDefinitionHash: h("e"), routeBindingHash: h("1") }),
    Object.freeze({ familyDefinitionHash: h("f"), routeBindingHash: h("2") }),
  ]);
  const routeLegs = Object.freeze(candidate.legs.map((leg, index) => Object.freeze({
    edgeId: leg.edgeId,
    ownerRef: hashDomain("aloha/search-runtime-route-owner/v1", actionOwners[index]!),
  })));
  const routeHash = hashDomain("aloha/search-runtime-route/v1", {
    candidateId: candidate.candidateId,
    legs: candidate.legs.map((leg, index) => ({ ...leg, routeBindingHash: actionOwners[index]!.routeBindingHash })),
  });
  const routeBinding = Object.freeze({
    routeHash,
    routeBindingHash: hashDomain("aloha/route-binding/v1", { legs: routeLegs }),
    legs: routeLegs,
  });
  const coarseSource = Object.freeze({ chainId: "1", number: "10", hash: h("4"), stateRoot: h("5") });
  const context = Object.freeze({
    candidate: candidate as never,
    problem: Object.freeze({ problemHash: candidate.planningProblemHash }) as never,
    generationId: "generation-1",
    graphRoot: h("3"),
    source: Object.freeze({ ...coarseSource, parentHash: h("canonical-parent") }),
    objectiveRef: h("6"),
    releaseProvenanceHash: h("7"),
    actionOwners,
    path: "routeBinding",
  });
  const projected = validateProductionResolvedRouteBindingV1({
    value: routeBinding,
    ...context,
  });
  assert.deepEqual(projected.source, coarseSource);
  assert.equal("parentHash" in projected.source, false);

  const routeBLegs = Object.freeze([
    Object.freeze({ ...routeLegs[0], ownerRef: h("d") }),
    routeLegs[1],
  ]);
  const selfConsistentRouteB = Object.freeze({
    ...routeBinding,
    routeBindingHash: hashDomain("aloha/route-binding/v1", { legs: routeBLegs }),
    legs: routeBLegs,
  });
  assert.throws(
    () => validateProductionResolvedRouteBindingV1({ value: selfConsistentRouteB, ...context }),
    /does not join the planned leg\/action owner/,
  );
  assert.throws(
    () => validateProductionResolvedRouteBindingV1({ value: { ...routeBinding, routeHash: h("d") }, ...context }),
    /routeHash mismatch/,
  );
  assert.throws(
    () => validateProductionResolvedRouteBindingV1({ value: routeBinding, ...context, candidate: { ...candidate, candidateId: h("d") } as never }),
    /routeHash mismatch/,
  );
});

function runtimeAnchor(invocationId = "invocation-1"): RuntimeAnchorReceiptV1 {
  return Object.freeze({
    kind: "aloha.searcher-runtime-anchor-v1",
    bindingId: release.bindingId,
    releaseProvenanceHash: release.releaseProvenanceHash,
    manifestHash: h("7"),
    manifestArtifactSha256: h("8"),
    runtimeArtifactRoot: h("9"),
    implementationClosureDigest: h("a"),
    candidateReleaseCommit: release.candidateReleaseCommit,
    entrypointSha256: h("b"),
    nodeExecutableSha256: h("c"),
    bundleModulePath: "/opt/aloha/release.mjs",
    bundleModuleSha256: h("d"),
    serviceName: "aloha-searcher",
    systemdUnit: "aloha-searcher.service",
    bootId: "boot-1",
    invocationId,
    logDevice: "8",
    logInode: "9",
    pid: invocationId === "invocation-1" ? "42" : "43",
    processStartTicks: invocationId === "invocation-1" ? "7" : "8",
    dryRun: true,
  });
}

function startup() {
  const ready = {
    releaseProvenanceHash: release.releaseProvenanceHash,
    readyRecordHash: h("e"),
    sourceCoverageRoot: h("f"),
    definitionCatalogRoot: h("d"),
  } as never;
  const serving = Object.freeze({
    ready,
    generationId: "generation-1",
    graphRoot,
    readyRecordHash: h("e"),
    sourceCoverageRoot: h("f"),
    definitionCatalogRoot: h("d"),
    releaseProvenanceHash: release.releaseProvenanceHash,
  });
  return issueStartupRuntime({
    ready,
    familyRuntimeComposition: {} as never,
    generationId: "generation-1",
    graphRoot,
    releaseBindingId: release.bindingId,
    candidateReleaseCommit: release.candidateReleaseCommit,
    canonicalSourceAuthority: {} as never,
    readActiveGeneration: () => serving,
    readServingGeneration: generationId => {
      if (generationId !== serving.generationId) throw new Error("unknown generation");
      return serving;
    },
    readProducerSessionGeneration: session => {
      if (session !== sessionCapability) throw new Error("unknown producer session");
      return serving;
    },
    async withProducerSession() { throw new Error("not used by production-evidence contract tests"); },
    async waitForGenerationIdle() {},
    async close() {},
  });
}

function terminal(input: {
  readonly ordinal: string;
  readonly facts: ReturnType<typeof issueProducerHeadFactsCapabilityV1> | null;
  readonly source?: CanonicalHead;
  readonly generationId?: string;
  readonly graphRoot?: Hash;
}) {
  const terminalWithoutId = Object.freeze({
    acceptedId: h(input.ordinal === "1" ? "a" : "b"),
    sequence: input.ordinal,
    ordinal: input.ordinal,
    status: "failed" as const,
    reason: "lane_failed" as const,
    head: input.source ?? head,
    revision: "0",
    generationId: input.generationId ?? "generation-1",
    graphRoot: input.graphRoot ?? graphRoot,
    laneOutcomes: Object.freeze([]),
  });
  const value: ProducerTerminalV1 = Object.freeze({
    kind: "aloha.producer-terminal-v1",
    terminalId: hashDomain("aloha/producer-terminal/v1", terminalWithoutId),
    ...terminalWithoutId,
  });
  return issueProducerHeadTerminalCapabilityV1({ terminal: value, facts: input.facts });
}

test("eligible admission freezes serving only from the owner-issued session opened after promotion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-promotion-race-"));
  const databasePath = join(directory, "evidence.sqlite");
  const session = Object.freeze(Object.create(null)) as ProducerSessionV1;
  const generationA = Object.freeze({
    ready: { releaseProvenanceHash: release.releaseProvenanceHash, readyRecordHash: h("a"), sourceCoverageRoot: h("b"), definitionCatalogRoot: h("c") } as never,
    generationId: "generation-a",
    graphRoot: h("d"),
    readyRecordHash: h("a"),
    sourceCoverageRoot: h("b"),
    definitionCatalogRoot: h("c"),
    releaseProvenanceHash: release.releaseProvenanceHash,
  });
  const generationB = Object.freeze({
    ready: { releaseProvenanceHash: release.releaseProvenanceHash, readyRecordHash: h("5"), sourceCoverageRoot: h("6"), definitionCatalogRoot: h("c") } as never,
    generationId: "generation-b",
    graphRoot: h("7"),
    readyRecordHash: h("5"),
    sourceCoverageRoot: h("6"),
    definitionCatalogRoot: h("c"),
    releaseProvenanceHash: release.releaseProvenanceHash,
  });
  const promotedStartup = issueStartupRuntime({
    ready: generationA.ready,
    familyRuntimeComposition: {} as never,
    generationId: generationA.generationId,
    graphRoot: generationA.graphRoot,
    releaseBindingId: release.bindingId,
    candidateReleaseCommit: release.candidateReleaseCommit,
    canonicalSourceAuthority: {} as never,
    readActiveGeneration: () => generationA,
    readServingGeneration: generationId => {
      if (generationId === generationA.generationId) return generationA;
      if (generationId === generationB.generationId) return generationB;
      throw new Error("unknown generation");
    },
    readProducerSessionGeneration: value => {
      if (value !== session) throw new Error("unknown producer session");
      return generationB;
    },
    async withProducerSession() { throw new Error("not used by promotion race fact test"); },
    async waitForGenerationIdle() {},
    async close() {},
  });
  const owner = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor(), economicSafety });
  const ports = owner.bindServing(promotedStartup);
  const eligible = await ports.performance.acceptEligibleHead({ head, revision: "0" });
  await ports.performance.bindEligibleHeadSession({ eligibleHead: eligible, session });
  const facts = issueProducerHeadFactsCapabilityV1({
    kind: "aloha.producer-head-facts-v1",
    headHash: head.hash,
    generationId: generationB.generationId,
    graphRoot: generationB.graphRoot,
    laneFacts: Object.freeze([]),
    laneFailureObservations: Object.freeze([]),
    candidateRefs: Object.freeze([]),
    currentSourcePhysical: null,
    sourceCoverageRoot: h("8"),
    complete: false,
  });
  await ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts });
  const terminalCapability = terminal({
    ordinal: "1",
    facts,
    generationId: generationB.generationId,
    graphRoot: generationB.graphRoot,
  });
  await ports.performance.sealHeadTerminal({ eligibleHead: eligible, terminal: terminalCapability });
  await ports.terminal.appendTerminal({ terminal: terminalCapability });
  owner.close();

  const durable = createSqliteDurableStore(databasePath);
  durable.bindStoreRole("searcher-production-evidence");
  const events = Object.values(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES).flatMap(namespace =>
    durable.readAppendLog(namespace).map(row => decodeCanonicalBytes(row.bytes) as Record<string, unknown>),
  );
  durable.close();
  const eligibleEvent = events.find(event => event.eventType === "eligible-head");
  assert.ok(eligibleEvent);
  assert.equal(eligibleEvent.serving, null, "durable admission must remain generation-neutral before session open");
  const served = events.filter(event => event.eventType !== "eligible-head");
  assert.ok(served.length > 0);
  for (const event of served) {
    assert.deepEqual(event.serving, {
      generationId: generationB.generationId,
      graphRoot: generationB.graphRoot,
      readyRecordHash: generationB.readyRecordHash,
      sourceCoverageRoot: generationB.sourceCoverageRoot,
    });
  }
  assert.equal(events.some(event => (event.serving as { generationId?: string } | null)?.generationId === generationA.generationId), false);
});

test("offline runtime composition reports incomplete facts until an external live anchor receipt exists", () => {
  const evidence = missingExternalRuntimeAnchorEvidenceV1();
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    kind: "aloha.searcher-production-evidence-status",
    factStatus: "incomplete",
    reasonCode: "external-runtime-anchor-missing",
    runtimeAnchorReceipt: null,
  });
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal("verdict" in evidence, false);
});

test("owner persists eligible, coverage, candidate, terminal and incomplete performance facts from opaque Producer capabilities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-"));
  const databasePath = join(directory, "evidence.sqlite");
  const owner = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor(), economicSafety });
  assertIssuedSearcherProductionEvidenceOwnerV1(owner);
  const ports = owner.bindServing(startup());
  const eligible = await ports.performance.acceptEligibleHead({ head, revision: "0" });
  await ports.performance.bindEligibleHeadSession({ eligibleHead: eligible, session: sessionCapability });
  const facts = issueProducerHeadFactsCapabilityV1({
    kind: "aloha.producer-head-facts-v1",
    headHash: head.hash,
    generationId: "generation-1",
    graphRoot,
    laneFacts: Object.freeze([]),
    laneFailureObservations: Object.freeze([]),
    candidateRefs: Object.freeze([]),
    currentSourcePhysical: null,
    sourceCoverageRoot: h("d"),
    complete: false,
  });
  assert.throws(
    () => ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts: structuredClone(facts) }),
    /not owner-issued/,
  );
  await ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts });
  const terminalCapability = terminal({ ordinal: "1", facts });
  await ports.performance.sealHeadTerminal({ eligibleHead: eligible, terminal: terminalCapability });
  assert.equal(ports.sixStep.readCompleteAppend(terminalCapability), null);
  assert.throws(() => ports.sixStep.readCompleteAppend({ ...terminalCapability } as never), /not owner-issued/);
  await ports.terminal.appendTerminal({ terminal: terminalCapability });

  const replay = owner.replay();
  assert.equal(replay.eventCount, "5");
  assert.equal(replay.eligibleHeadCount, "1");
  assert.equal(replay.headCoverageCount, "1");
  assert.equal(replay.candidateSetCount, "1");
  assert.equal(replay.performanceFactsCompleteCount, "0");
  assert.equal(replay.performanceFactsIncompleteCount, "1");
  assert.equal(replay.producerTerminalCount, "1");
  assert.deepEqual(replay.incompleteAdmissionIds, []);
  owner.close();

  const highCardinality = readSearcherProductionEvidenceHighCardinalityV1(databasePath);
  assert.equal(highCardinality.routeDenominators.length, 0);
  assert.equal(highCardinality.candidateSets.length, 1);
  assert.equal(highCardinality.candidateSets[0]!.payload.candidateTerminalObservations.length, 0);
  assert.equal(highCardinality.candidateSets[0]!.payload.candidateRefs.length, 0);

  const persisted = createSqliteDurableStore(databasePath);
  persisted.bindStoreRole("searcher-production-evidence");
  const rows = persisted.readAppendLog(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.performance);
  assert.equal(rows.length, 1);
  const event = decodeCanonicalBytes(rows[0]!.bytes) as Record<string, unknown>;
  assert.equal(event.eventType, "performance-facts-incomplete");
  const payload = event.payload as Record<string, unknown>;
  assert.equal(payload.factStatus, "incomplete");
  assert.equal("verdict" in payload, false);
  persisted.close();
});

test("terminal cannot replace the exact head-facts capability with an equivalent reissue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-facts-identity-"));
  const owner = issueSearcherProductionEvidenceOwnerV1({ databasePath: join(directory, "evidence.sqlite"), release, runtimeAnchor: runtimeAnchor(), economicSafety });
  const ports = owner.bindServing(startup());
  const eligible = await ports.performance.acceptEligibleHead({ head, revision: "0" });
  await ports.performance.bindEligibleHeadSession({ eligibleHead: eligible, session: sessionCapability });
  const factsValue = Object.freeze({
    kind: "aloha.producer-head-facts-v1" as const,
    headHash: head.hash,
    generationId: "generation-1",
    graphRoot,
    laneFacts: Object.freeze([]),
    laneFailureObservations: Object.freeze([]),
    candidateRefs: Object.freeze([]),
    currentSourcePhysical: null,
    sourceCoverageRoot: h("d"),
    complete: false,
  });
  const boundFacts = issueProducerHeadFactsCapabilityV1(factsValue);
  const equivalentReissue = issueProducerHeadFactsCapabilityV1(factsValue);
  await ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts: boundFacts });

  await assert.rejects(
    async () => { await ports.performance.sealHeadTerminal({ eligibleHead: eligible, terminal: terminal({ ordinal: "1", facts: equivalentReissue }) }); },
    /replaced the bound head facts capability/,
  );
  const exactTerminal = terminal({ ordinal: "1", facts: boundFacts });
  await ports.performance.sealHeadTerminal({ eligibleHead: eligible, terminal: exactTerminal });
  await ports.terminal.appendTerminal({ terminal: exactTerminal });
  assert.equal(owner.replay().performanceFactsIncompleteCount, "1");
  owner.close();
});

test("an owner-issued Producer terminal cannot enter as an orphan before this owner seals its performance binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-orphan-terminal-"));
  const owner = issueSearcherProductionEvidenceOwnerV1({ databasePath: join(directory, "evidence.sqlite"), release, runtimeAnchor: runtimeAnchor(), economicSafety });
  const ports = owner.bindServing(startup());
  const orphan = terminal({ ordinal: "1", facts: null });
  await assert.rejects(
    async () => { await ports.terminal.appendTerminal({ terminal: orphan }); },
    /not bound to a persisted performance terminal/,
  );
  assert.equal(owner.replay().producerTerminalCount, "0");
  owner.close();
});

test("restart retains history but reports each exact runtime-anchor partition independently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-restart-"));
  const databasePath = join(directory, "evidence.sqlite");
  const first = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor(), economicSafety });
  const firstPorts = first.bindServing(startup());
  const firstEligible = await firstPorts.performance.acceptEligibleHead({ head, revision: "0" });
  await firstPorts.performance.bindEligibleHeadSession({ eligibleHead: firstEligible, session: sessionCapability });
  const firstTerminal = terminal({ ordinal: "1", facts: null });
  await firstPorts.performance.sealHeadTerminal({ eligibleHead: firstEligible, terminal: firstTerminal });
  await firstPorts.terminal.appendTerminal({ terminal: firstTerminal });
  const firstReplay = first.replay();
  assert.equal(firstReplay.eventCount, "3");
  assert.equal(firstReplay.partitionCount, "1");
  first.close();

  const second = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor("invocation-2"), economicSafety });
  assert.equal(second.replay().eventCount, "0");
  assert.equal(second.replay().eligibleHeadCount, "0");
  assert.equal(second.replay().partitionCount, "1");
  const secondPorts = second.bindServing(startup());
  assert.equal(secondPorts.sixStep.readCompleteAppend(firstTerminal), null);
  const nextHead: CanonicalHead = Object.freeze({ ...head, number: "102", hash: h("b"), parentHash: head.hash });
  const secondEligible = await secondPorts.performance.acceptEligibleHead({ head: nextHead, revision: "0" });
  await secondPorts.performance.bindEligibleHeadSession({ eligibleHead: secondEligible, session: sessionCapability });
  const secondTerminal = terminal({ ordinal: "1", facts: null, source: nextHead });
  await secondPorts.performance.sealHeadTerminal({ eligibleHead: secondEligible, terminal: secondTerminal });
  await secondPorts.terminal.appendTerminal({ terminal: secondTerminal });
  const secondReplay = second.replay();
  assert.equal(secondReplay.eventCount, "3");
  assert.equal(secondReplay.eligibleHeadCount, "1");
  assert.equal(secondReplay.performanceFactsCompleteCount, "0");
  assert.equal(secondReplay.performanceFactsIncompleteCount, "1");
  assert.equal(secondReplay.producerTerminalCount, "1");
  assert.equal(secondReplay.partitionCount, "2");
  assert.notEqual(secondReplay.eventRoot, firstReplay.eventRoot);
  second.close();

  const historical = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor(), economicSafety });
  const historicalReplay = historical.replay();
  assert.equal(historicalReplay.eventRoot, firstReplay.eventRoot);
  assert.equal(historicalReplay.currentPartitionId, firstReplay.currentPartitionId);
  assert.deepEqual(
    historicalReplay.partitions.find(partition => partition.partitionId === firstReplay.currentPartitionId),
    firstReplay.partitions[0],
  );
  historical.close();
});

test("restart preserves an admitted partial head instead of deleting it from the denominator", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-partial-"));
  const databasePath = join(directory, "evidence.sqlite");
  const first = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor(), economicSafety });
  const ports = first.bindServing(startup());
  const eligible = await ports.performance.acceptEligibleHead({ head, revision: "0" });
  await ports.performance.bindEligibleHeadSession({ eligibleHead: eligible, session: sessionCapability });
  const facts = issueProducerHeadFactsCapabilityV1({
    kind: "aloha.producer-head-facts-v1",
    headHash: head.hash,
    generationId: "generation-1",
    graphRoot,
    laneFacts: Object.freeze([]),
    laneFailureObservations: Object.freeze([]),
    candidateRefs: Object.freeze([]),
    currentSourcePhysical: null,
    sourceCoverageRoot: h("d"),
    complete: false,
  });
  await ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts });
  const before = first.replay();
  assert.equal(before.eventCount, "3");
  assert.equal(before.incompleteAdmissionIds.length, 1);
  first.close();

  const second = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor("invocation-2"), economicSafety });
  const afterRestart = second.replay();
  assert.equal(afterRestart.eventCount, "0");
  assert.equal(afterRestart.partitionCount, "1");
  assert.deepEqual(afterRestart.partitions[0], before.partitions[0]);
  assert.equal(afterRestart.partitions[0]?.headCoverageCount, "1");
  assert.equal(afterRestart.partitions[0]?.candidateSetCount, "1");
  assert.equal(afterRestart.partitions[0]?.performanceFactsIncompleteCount, "0");
  second.close();
});

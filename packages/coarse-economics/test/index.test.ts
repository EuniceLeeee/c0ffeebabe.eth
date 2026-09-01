import assert from "node:assert/strict";
import test from "node:test";
import { encodeCanonicalJson, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  enumerateClosedLoopPlanningProblem,
  type IssuedPlanningEnumerationV1,
  type PlannedRouteCandidateV1,
  type PlanningEnumerationV1,
} from "../../planner/src/index.ts";
import {
  sealGeneratedStrategyRuntimeDescriptor,
  strategyPlanningTemplateHash,
  type GeneratedStrategyRuntimeEntryV1,
  type IssuedStrategyPlanningProblemV1,
  type StrategyGraphEdgeV1,
} from "../../strategy-composition/src/index.ts";
import {
  createGeneratedStrategyRuntimeFactory,
  issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability,
} from "../../strategy-composition/src/internal/generated-runtime-composition.ts";
import { issueStrategyPlanningTriggerCapabilityV1 } from "../../strategy-composition/src/internal/trigger-owner.ts";
import { compileStrategy, defineStrategy } from "../../strategy-sdk/src/index.ts";
import { ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER, ROUTE_CYCLE_STRATEGY } from "../../../strategies/route-cycle/src/index.ts";
import {
  admitCoarseRoutesV1,
  coarseAdmissionAccountingRootV1,
  coarseEnumerationRootV1,
  issueCoarseRouteAssessmentV1,
  readIssuedCoarseRouteAssessmentV1,
  readIssuedCoarseRouteBindingV1,
  readIssuedCoarseEnumerationBindingV1,
  readQualifiedCoarseProjectionReceiptV1,
  readQualifiedCoarseProjectionV1,
  sealCoarseEdgeProjectionV1,
  type CoarseAdmissionObjectiveV1,
  type CoarseAdmissionPolicyV1,
  type CoarseProjectionCapabilityV1,
  type CoarseRouteBindingV1,
  type IssuedCoarseRouteAssessmentV1,
  type IssuedCoarseRouteBindingV1,
  type QualifiedCoarseProjectionV1,
} from "../src/index.ts";
import { issueCoarseProjectionServiceV1 } from "../src/internal/owner.ts";
import {
  issueQualifiedCoarseProjectionOwnerCapabilityV1,
  type CoarseProjectionOwnerDescriptorV1,
} from "../src/internal/qualification-owner.ts";
import { issueCoarseEnumerationBindingV1, issueCoarseRouteBindingV1 } from "../src/internal/search-owner.ts";
import {
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";

const h = (label: string): Hash => hashDomain("test/coarse-economics/v3", label);
const source = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const assetA = h("asset-a");
const assetB = h("asset-b");
const releaseProvenanceHash = null;
const releaseMembershipRoot = h("release-membership");
const runtimeAuthorityDescriptor = createUnsignedDryRunRuntimeAuthorityDescriptorV1({
  authorityClass: "dry-run",
  runtimeBindingId: h("runtime-binding"),
  implementationCommit: "a".repeat(40),
});
const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(runtimeAuthorityDescriptor);
const objectiveBody = Object.freeze({ numeraireAssetRef: assetA, minNetGain: "0", maxGas: "1000000", maxValueAtRisk: "1000000000" });
const objective: CoarseAdmissionObjectiveV1 = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", objectiveBody), ...objectiveBody });

const strategyCatalogEntry = compileStrategy(ROUTE_CYCLE_STRATEGY, []).entry;
const strategyIssuerClosureRoot = h("strategy-issuer");
const strategyEntryBody = {
  catalogEntry: strategyCatalogEntry,
  issuerModulePath: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.modulePath,
  issuerExportName: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.exportName,
  issuerClosureRoot: strategyIssuerClosureRoot,
  planningTemplateHash: strategyPlanningTemplateHash(strategyCatalogEntry.planningTemplate),
};
const strategyEntry: GeneratedStrategyRuntimeEntryV1 = Object.freeze({
  ...strategyEntryBody,
  leafDigest: hashDomain("aloha/generated-strategy-runtime-leaf/v1", {
    strategyId: strategyCatalogEntry.strategyId,
    strategyDefinitionHash: strategyCatalogEntry.strategyDefinitionHash,
    definitionCatalogLeafDigest: strategyCatalogEntry.definitionCatalogLeafDigest,
    issuerModulePath: strategyEntryBody.issuerModulePath,
    issuerExportName: strategyEntryBody.issuerExportName,
    issuerClosureRoot: strategyIssuerClosureRoot,
    planningTemplateHash: strategyEntryBody.planningTemplateHash,
  }),
});
const strategyDescriptor = sealGeneratedStrategyRuntimeDescriptor({
  schemaVersion: 1,
  releaseIntentRoot: h("strategy-release"),
  definitionCatalogRoot: h("definition-catalog"),
  proposedCapabilitySetRoot: h("strategy-capabilities"),
  strategies: [strategyEntry],
});
const strategyFactory = createGeneratedStrategyRuntimeFactory({
  descriptor: strategyDescriptor,
  issuers: [ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER],
});
const strategyComposition = strategyFactory(issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability({
  factory: strategyFactory,
  declaredCapabilitySetRoot: strategyDescriptor.proposedCapabilitySetRoot,
  runtimeAuthority: runtimeAuthorityDescriptor,
  assertCurrent: () => {},
}));

function graphEdge(label: string, inputAssetRef: Hash, outputAssetRef: Hash): StrategyGraphEdgeV1 {
  return Object.freeze({
    edgeId: h(`${label}:edge`),
    opaqueTransitionRef: h(`${label}:transition`),
    inputAssetPorts: Object.freeze([{ assetRef: inputAssetRef, portRef: h(`${label}:input-port`), ordinal: "0" }]),
    outputAssetPorts: Object.freeze([{ assetRef: outputAssetRef, portRef: h(`${label}:output-port`), ordinal: "0" }]),
  });
}

function planningProblem(graphRoot: Hash, edges: readonly StrategyGraphEdgeV1[], objectiveRef = objective.objectiveRef): IssuedStrategyPlanningProblemV1 {
  const binding = Object.freeze({
    generationId: "generation-1",
    definitionCatalogRoot: strategyDescriptor.definitionCatalogRoot,
    graphRoot,
    readyRecordHash: h("ready"),
    runtimeAuthority,
    runtimeMembershipHash: strategyComposition.runtimeMembershipHash,
    sourceHash: source.hash,
  });
  return strategyComposition.issuePlanningProblems({
    binding,
    edges,
    trigger: issueStrategyPlanningTriggerCapabilityV1({
      binding,
      lane: "blockscan",
      triggerRef: h(`trigger:${graphRoot}`),
      objectiveRef,
      entryAssetRef: assetA,
      returnAssetRef: assetA,
      affectedEdgeIds: [],
      correlationId: h(`correlation:${graphRoot}`),
    }),
  })[0]!;
}

function plannerEnumeration(twoCycles = false, objectiveValue = objective): IssuedPlanningEnumerationV1 {
  const edges = [graphEdge("ab", assetA, assetB), graphEdge("ba", assetB, assetA)];
  if (twoCycles) {
    const assetC = h("asset-c");
    edges.push(graphEdge("ac", assetA, assetC), graphEdge("ca", assetC, assetA));
  }
  const graphRoot = h(twoCycles ? "graph-two" : "graph-one");
  return enumerateClosedLoopPlanningProblem({ problem: planningProblem(graphRoot, edges, objectiveValue.objectiveRef) });
}

function emptyPlannerEnumeration(): IssuedPlanningEnumerationV1 {
  const graphRoot = h("graph-empty");
  return enumerateClosedLoopPlanningProblem({ problem: planningProblem(graphRoot, []) });
}

function highCardinalityPlannerEnumeration(): IssuedPlanningEnumerationV1 {
  const definition = defineStrategy({
    ...ROUTE_CYCLE_STRATEGY,
    planningTemplate: { ...ROUTE_CYCLE_STRATEGY.planningTemplate, candidateLimit: "30000" },
  });
  const catalogEntry = compileStrategy(definition, []).entry;
  const planningHash = strategyPlanningTemplateHash(catalogEntry.planningTemplate);
  const entryBody = {
    catalogEntry,
    issuerModulePath: definition.planningProblemIssuer.modulePath,
    issuerExportName: definition.planningProblemIssuer.exportName,
    issuerClosureRoot: strategyIssuerClosureRoot,
    planningTemplateHash: planningHash,
  };
  const runtimeEntry: GeneratedStrategyRuntimeEntryV1 = Object.freeze({
    ...entryBody,
    leafDigest: hashDomain("aloha/generated-strategy-runtime-leaf/v1", {
      strategyId: catalogEntry.strategyId,
      strategyDefinitionHash: catalogEntry.strategyDefinitionHash,
      definitionCatalogLeafDigest: catalogEntry.definitionCatalogLeafDigest,
      issuerModulePath: entryBody.issuerModulePath,
      issuerExportName: entryBody.issuerExportName,
      issuerClosureRoot: entryBody.issuerClosureRoot,
      planningTemplateHash: planningHash,
    }),
  });
  const descriptor = sealGeneratedStrategyRuntimeDescriptor({
    schemaVersion: 1,
    releaseIntentRoot: strategyDescriptor.releaseIntentRoot,
    definitionCatalogRoot: strategyDescriptor.definitionCatalogRoot,
    proposedCapabilitySetRoot: strategyDescriptor.proposedCapabilitySetRoot,
    strategies: [runtimeEntry],
  });
  const issuer = Object.freeze({ ...ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER, planningTemplateHash: planningHash });
  const factory = createGeneratedStrategyRuntimeFactory({ descriptor, issuers: [issuer] });
  const composition = factory(issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability({
    factory,
    declaredCapabilitySetRoot: descriptor.proposedCapabilitySetRoot,
    runtimeAuthority: runtimeAuthorityDescriptor,
    assertCurrent: () => {},
  }));
  const graphRoot = h("graph-high-cardinality");
  const binding = Object.freeze({
    generationId: "generation-1",
    definitionCatalogRoot: descriptor.definitionCatalogRoot,
    graphRoot,
    readyRecordHash: h("ready"),
    runtimeAuthority,
    runtimeMembershipHash: composition.runtimeMembershipHash,
    sourceHash: source.hash,
  });
  const edges = [
    ...Array.from({ length: 174 }, (_, index) => graphEdge(`high-forward-${index}`, assetA, assetB)),
    ...Array.from({ length: 173 }, (_, index) => graphEdge(`high-backward-${index}`, assetB, assetA)),
  ];
  const problem = composition.issuePlanningProblems({
    binding,
    edges,
    trigger: issueStrategyPlanningTriggerCapabilityV1({
      binding,
      lane: "blockscan",
      triggerRef: h("trigger:high-cardinality"),
      objectiveRef: objective.objectiveRef,
      entryAssetRef: assetA,
      returnAssetRef: assetA,
      affectedEdgeIds: [],
      correlationId: h("correlation:high-cardinality"),
    }),
  })[0]!;
  return enumerateClosedLoopPlanningProblem({ problem });
}

interface RouteFixture {
  readonly value: CoarseRouteBindingV1;
  readonly capability: IssuedCoarseRouteBindingV1;
}

function route(candidate: PlannedRouteCandidateV1, graphRoot: Hash, ownerRef: Hash, objectiveValue = objective): RouteFixture {
  const legs = candidate.legs.map(leg => Object.freeze({
    edgeId: leg.edgeId,
    transitionRef: leg.transitionRef,
    inputAssetRef: leg.inputAssetRef,
    inputPortRef: leg.inputPortRef,
    outputAssetRef: leg.outputAssetRef,
    outputPortRef: leg.outputPortRef,
  }));
  const value: CoarseRouteBindingV1 = Object.freeze({
    candidateId: candidate.candidateId,
    orderKey: candidate.orderKey,
    planningProblemHash: candidate.planningProblemHash,
    routeHash: h(`${candidate.candidateId}:route`),
    routeBindingHash: h(`${candidate.candidateId}:route-binding`),
    dependencySetRef: h(`${candidate.candidateId}:dependencies`),
    ownerRefs: Object.freeze([ownerRef]),
    generationId: "generation-1",
    graphRoot,
    source,
    objectiveRef: objectiveValue.objectiveRef,
    runtimeAuthority,
    releaseProvenanceHash,
    legs: Object.freeze(legs),
  });
  return Object.freeze({ value, capability: issueCoarseRouteBindingV1(value) });
}

function descriptor(ownerRef: Hash, label: string): CoarseProjectionOwnerDescriptorV1 {
  return Object.freeze({
    ownerRef,
    capabilityId: "coarse-projection",
    capabilityVersion: "1.0.0",
    schemaRef: h(`${label}:schema`),
    interpreterHash: h(`${label}:interpreter`),
    implementationHash: h(`${label}:implementation`),
    boundVerifierHash: h(`${label}:bound-verifier`),
  });
}

function qualify(
  projection: ReturnType<typeof sealCoarseEdgeProjectionV1>,
  label: string,
  options: { wrongOwner?: boolean; wrongProof?: boolean; membershipRoot?: Hash } = {},
): QualifiedCoarseProjectionV1 {
  const capability = Object.freeze(Object.create(null)) as CoarseProjectionCapabilityV1;
  const proofCapability = Object.freeze(Object.create(null));
  const owner = issueQualifiedCoarseProjectionOwnerCapabilityV1({
    releaseMembershipRoot: options.membershipRoot ?? releaseMembershipRoot,
    descriptor: descriptor(options.wrongOwner ? h(`${label}:wrong-owner`) : projection.ownerRef, label),
    port: {
      read(value) {
        if (value !== capability) throw new TypeError("projection capability not issued");
        return Object.freeze({ projection, boundProofCapability: projection.conservativeOutputUpperBound === null ? null : options.wrongProof ? Object.freeze({}) : proofCapability });
      },
      verifyConservativeBound(value, input) {
        if (value !== proofCapability) throw new TypeError("bound proof capability not issued");
        assert.equal(input.projectionId, projection.projectionId);
        assert.equal(input.stateFactsRoot, projection.stateFactsRoot);
        return Object.freeze({ verificationFactRoot: h(`${label}:verification-fact`) });
      },
    },
  });
  const service = issueCoarseProjectionServiceV1({ owner });
  return readQualifiedCoarseProjectionV1({ service, capability });
}

function assessment(binding: RouteFixture, options: { unavailable?: boolean; finalAmount?: string; bounded?: boolean; spliceTransition?: boolean; spliceMembership?: boolean } = {}): IssuedCoarseRouteAssessmentV1 {
  return issueCoarseRouteAssessmentV1({ binding: binding.capability, projections: projectionEvidence(binding, options) });
}

function projectionEvidence(
  binding: RouteFixture,
  options: { unavailable?: boolean; finalAmount?: string; bounded?: boolean; spliceTransition?: boolean; spliceMembership?: boolean } = {},
): readonly QualifiedCoarseProjectionV1[] {
  const finalAmount = options.finalAmount ?? "110";
  const projections = binding.value.legs.map((leg, index) => {
    const unavailable = options.unavailable === true && index === binding.value.legs.length - 1;
    const inputAmount = index === 0 ? "100" : "120";
    const outputAmount = index === binding.value.legs.length - 1 ? finalAmount : "120";
    const ownerRef = h(`${binding.value.routeHash}:projection-owner:${index}`);
    const projection = sealCoarseEdgeProjectionV1({
      edgeId: leg.edgeId,
      transitionRef: options.spliceTransition === true && index === 0 ? h("spliced-transition") : leg.transitionRef,
      routeBindingHash: binding.value.routeBindingHash,
      generationId: binding.value.generationId,
      graphRoot: binding.value.graphRoot,
      source,
      objectiveRef: binding.value.objectiveRef,
      ownerRef,
      capabilityDigest: h(`${binding.value.routeHash}:capability:${index}`),
      dependencyRoot: h(`${binding.value.routeHash}:dependency:${index}`),
      stateFactsRoot: h(`${binding.value.routeHash}:state:${index}`),
      sampleInput: { assetRef: leg.inputAssetRef, amount: inputAmount },
      estimatedOutput: unavailable ? null : { assetRef: leg.outputAssetRef, amount: outputAmount },
      conservativeOutputUpperBound: unavailable || options.bounded === false ? null : {
        assetRef: leg.outputAssetRef,
        amount: index === binding.value.legs.length - 1 ? (BigInt(finalAmount) + 5n).toString() : "130",
        proofProgramRef: h(`proof-program:${index}`),
        proofRoot: h(`proof:${index}`),
      },
      inputCapacityUpperBound: unavailable || options.bounded === false ? null : index === 0 ? "100" : "130",
      status: unavailable ? "unavailable" : "rankable",
      reasonCode: unavailable ? "owner-read-unavailable" : null,
    });
    return qualify(projection, `${binding.value.routeHash}:${index}`, {
      membershipRoot: options.spliceMembership === true && index === binding.value.legs.length - 1 ? h("spliced-membership-root") : undefined,
    });
  });
  return Object.freeze(projections);
}

function enumeration(
  planner: IssuedPlanningEnumerationV1,
  routes: readonly RouteFixture[],
  assessments: readonly (IssuedCoarseRouteAssessmentV1 | null)[],
  policy: CoarseAdmissionPolicyV1 = Object.freeze({ rankedLimit: 1, boundedUnrankedLimit: 1 }),
  objectiveValue = objective,
) {
  return issueCoarseEnumerationBindingV1({
    plannerEnumeration: planner,
    generationId: "generation-1",
    source,
    runtimeAuthority,
    releaseProvenanceHash,
    objective: objectiveValue,
    policy,
    candidates: Object.freeze(routes.map((binding, index) => Object.freeze({ binding: binding.capability, assessment: assessments[index] ?? null }))),
  });
}

test("release-qualified opaque owner rejects fake callbacks, shape clones, wrong owner leaves, and wrong proof capabilities", () => {
  const planner = plannerEnumeration();
  const binding = route(planner.candidates[0]!, planner.graphRoot, h("route-owner"));
  const leg = binding.value.legs[0]!;
  const projection = sealCoarseEdgeProjectionV1({
    edgeId: leg.edgeId,
    transitionRef: leg.transitionRef,
    routeBindingHash: binding.value.routeBindingHash,
    generationId: binding.value.generationId,
    graphRoot: binding.value.graphRoot,
    source,
    objectiveRef: binding.value.objectiveRef,
    ownerRef: h("projection-owner"),
    capabilityDigest: h("projection-capability"),
    dependencyRoot: h("projection-dependency"),
    stateFactsRoot: h("projection-state"),
    sampleInput: { assetRef: leg.inputAssetRef, amount: "100" },
    estimatedOutput: { assetRef: leg.outputAssetRef, amount: "110" },
    conservativeOutputUpperBound: { assetRef: leg.outputAssetRef, amount: "120", proofProgramRef: h("proof-program"), proofRoot: h("proof") },
    inputCapacityUpperBound: "100",
    status: "rankable",
    reasonCode: null,
  });
  assert.throws(() => issueCoarseProjectionServiceV1({ owner: { read: () => projection } }), /not issued/);
  const qualifiedOwner = issueQualifiedCoarseProjectionOwnerCapabilityV1({
    releaseMembershipRoot,
    descriptor: descriptor(projection.ownerRef, "clone-owner"),
    port: {
      read: () => Object.freeze({ projection, boundProofCapability: Object.freeze({}) }),
      verifyConservativeBound: () => Object.freeze({ verificationFactRoot: h("clone-owner:fact") }),
    },
  });
  assert.throws(() => issueCoarseProjectionServiceV1({ owner: { ...qualifiedOwner } }), /not issued/);
  const fakeService = { read: () => projection };
  assert.throws(() => readQualifiedCoarseProjectionV1({ service: fakeService, capability: {} }), /not owner-issued/);
  assert.throws(() => qualify(projection, "wrong-owner", { wrongOwner: true }), /ownerRef/);
  assert.throws(() => qualify(projection, "wrong-proof", { wrongProof: true }), /proof capability not issued/);

  const qualified = qualify(projection, "valid");
  const receipt = readQualifiedCoarseProjectionReceiptV1(qualified);
  assert.equal(receipt.releaseMembershipRoot, releaseMembershipRoot);
  assert.equal(receipt.boundVerification?.releaseMembershipRoot, releaseMembershipRoot);
  assert.equal(receipt.boundVerification?.ownerQualificationLeafDigest, receipt.ownerQualificationLeafDigest);
  assert.equal(receipt.boundVerification?.verifierHash, receipt.ownerDescriptor.boundVerifierHash);
  assert.throws(() => readQualifiedCoarseProjectionReceiptV1({ ...qualified }), /not issued/);
});

test("route, projection, and assessment identities reject clones and semantic splices", () => {
  const planner = plannerEnumeration();
  const binding = route(planner.candidates[0]!, planner.graphRoot, h("route-owner"));
  const issued = assessment(binding);
  assert.equal(readIssuedCoarseRouteBindingV1(binding.capability).routeHash, binding.value.routeHash);
  assert.equal(readIssuedCoarseRouteAssessmentV1(issued).routeHash, binding.value.routeHash);
  assert.throws(() => readIssuedCoarseRouteBindingV1({ ...binding.capability }), /not issued/);
  assert.throws(() => readIssuedCoarseRouteAssessmentV1({ ...issued }), /not issued/);
  assert.throws(() => assessment(binding, { spliceTransition: true }), /does not bind the route/);
  assert.throws(() => assessment(binding, { spliceMembership: true }), /one release membership root/);

  const splicedObjectiveBody = Object.freeze({ ...objectiveBody, minNetGain: "20" });
  const splicedObjective = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", splicedObjectiveBody), ...splicedObjectiveBody });
  assert.throws(() => enumeration(planner, [binding], [issued], undefined, splicedObjective), /planning problem|binding mismatch/);

  const cloneAdmission = admitCoarseRoutesV1({ enumeration: enumeration(planner, [binding], [{ ...issued }]) });
  assert.equal(cloneAdmission.provenPruned, "0");
  assert.equal(cloneAdmission.entries[0]!.disposition, "bounded-unranked-selected");
});

test("complete denominator is joined to the planner-issued capability, not a caller-retained root", () => {
  const planner = plannerEnumeration(true);
  const routes = planner.candidates.map((candidate, index) => route(candidate, planner.graphRoot, h(`owner:${index}`)));
  const assessments = routes.map(value => assessment(value, { unavailable: true }));
  assert.throws(() => enumeration(planner, routes.slice(1), assessments.slice(1)), /denominator does not match/);

  const retainedRootClone = Object.freeze({ ...planner, candidates: Object.freeze(planner.candidates.slice(1)) }) as IssuedPlanningEnumerationV1;
  assert.equal((retainedRootClone as PlanningEnumerationV1).enumerationRoot, planner.enumerationRoot);
  assert.throws(() => enumeration(retainedRootClone, routes.slice(1), assessments.slice(1)), /not issued/);

  const wrongRoute = { ...routes[0]!, capability: { ...routes[0]!.capability }, value: { ...routes[0]!.value, routeHash: h("spliced-route") } };
  assert.throws(() => enumeration(planner, [wrongRoute, ...routes.slice(1)], assessments), /not issued by the search owner|does not match/);

  for (const [field, replacement] of [
    ["transitionRef", h("spliced-transition")],
    ["inputPortRef", h("spliced-input-port")],
    ["outputPortRef", h("spliced-output-port")],
  ] as const) {
    const first = routes[0]!;
    const splicedValue = Object.freeze({
      ...first.value,
      legs: Object.freeze(first.value.legs.map((leg, index) => index === 0 ? Object.freeze({ ...leg, [field]: replacement }) : leg)),
    });
    const spliced = Object.freeze({ value: splicedValue, capability: issueCoarseRouteBindingV1(splicedValue) });
    assert.throws(
      () => enumeration(planner, [spliced, ...routes.slice(1)], [assessment(spliced), ...assessments.slice(1)]),
      /does not match the planner-issued route/,
      field,
    );
  }
});

test("complete-no-candidate is reserved for a genuinely empty denominator", () => {
  const empty = emptyPlannerEnumeration();
  const emptyAdmission = admitCoarseRoutesV1({ enumeration: enumeration(empty, [], [], { rankedLimit: 0, boundedUnrankedLimit: 0 }) });
  assert.equal(emptyAdmission.denominator, "0");
  assert.equal(emptyAdmission.outcome, "complete-no-candidate");

  const planner = plannerEnumeration();
  const binding = route(planner.candidates[0]!, planner.graphRoot, h("nonempty-owner"));
  const nonempty = admitCoarseRoutesV1({ enumeration: enumeration(planner, [binding], [assessment(binding)], { rankedLimit: 0, boundedUnrankedLimit: 0 }) });
  assert.equal(nonempty.denominator, "1");
  assert.equal(nonempty.notProbed, "1");
  assert.equal(nonempty.outcome, "retryable-incomplete");
});

test("generation-local least-served selection does not starve equal-boundary owners", () => {
  const planner = plannerEnumeration(true);
  const owners = [h("fair-owner-a"), h("fair-owner-b")];
  const selected = new Map<Hash, number>(owners.map(ownerRef => [ownerRef, 0]));
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const routes = planner.candidates.map((candidate, index) => route(candidate, planner.graphRoot, owners[index]!));
    const admission = admitCoarseRoutesV1({ enumeration: enumeration(
      planner,
      routes,
      routes.map(value => assessment(value, { unavailable: true })),
      { rankedLimit: 0, boundedUnrankedLimit: 1 },
    ) });
    const selectedEntry = admission.entries.find(entry => entry.disposition === "bounded-unranked-selected")!;
    const ownerRef = routes.find(value => value.value.candidateId === selectedEntry.candidateId)!.value.ownerRefs[0]!;
    selected.set(ownerRef, selected.get(ownerRef)! + 1);
  }
  assert.deepEqual([...selected.values()].sort((left, right) => left - right), [6, 6]);
});

test("per-edge absolute output caps remain rank-only without a route-domain profit proof", () => {
  const basePlanner = plannerEnumeration();
  const pruneObjectiveBody = Object.freeze({ ...objectiveBody, numeraireAssetRef: basePlanner.candidates[0]!.legs[0]!.inputAssetRef, minNetGain: "20" });
  const pruneObjective = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", pruneObjectiveBody), ...pruneObjectiveBody });
  const planner = plannerEnumeration(false, pruneObjective);
  const binding = route(planner.candidates[0]!, planner.graphRoot, h("prune-owner"), pruneObjective);
  const bounded = assessment(binding);
  assert.equal(readIssuedCoarseRouteAssessmentV1(bounded).profitUpperBound, null);
  const retained = admitCoarseRoutesV1({ enumeration: enumeration(planner, [binding], [bounded], { rankedLimit: 1, boundedUnrankedLimit: 0 }, pruneObjective) });
  assert.equal(retained.provenPruned, "0");
  assert.equal(retained.rankedSelected, "1");
  assert.equal(retained.entries[0]!.disposition, "ranked-selected");
  assert.equal(retained.entries[0]!.pruneReceipt, null);

  const unboundedBinding = route(planner.candidates[0]!, planner.graphRoot, h("unbounded-owner"), pruneObjective);
  const unbounded = admitCoarseRoutesV1({ enumeration: enumeration(planner, [unboundedBinding], [assessment(unboundedBinding, { bounded: false })], { rankedLimit: 0, boundedUnrankedLimit: 0 }, pruneObjective) });
  assert.equal(unbounded.provenPruned, "0");
  assert.equal(unbounded.outcome, "retryable-incomplete");
});

test("coarse roots commit ordered identities, entry roots, duplicates, and scalar counts", () => {
  const planner = plannerEnumeration(true);
  const routes = planner.candidates.map((candidate, index) => route(candidate, planner.graphRoot, h(`root-owner:${index}`)));
  const capability = enumeration(planner, routes, [null, null], { rankedLimit: 0, boundedUnrankedLimit: 0 });
  const binding = readIssuedCoarseEnumerationBindingV1(capability);
  assert.equal(coarseEnumerationRootV1(binding), binding.coarseEnumerationRoot);

  const mutatedRouteValue = Object.freeze({ ...routes[0]!.value, dependencySetRef: h("mutated-dependency") });
  const mutatedRoute = issueCoarseRouteBindingV1(mutatedRouteValue);
  assert.notEqual(coarseEnumerationRootV1({
    ...binding,
    candidates: [{ ...binding.candidates[0]!, binding: mutatedRoute }, binding.candidates[1]!],
  }), binding.coarseEnumerationRoot);
  assert.notEqual(coarseEnumerationRootV1({ ...binding, candidates: [...binding.candidates].reverse() }), binding.coarseEnumerationRoot);
  assert.notEqual(coarseEnumerationRootV1({ ...binding, candidates: [binding.candidates[0]!, binding.candidates[0]!] }), binding.coarseEnumerationRoot);
  assert.notEqual(coarseEnumerationRootV1({ ...binding, candidates: [...binding.candidates, binding.candidates[0]!] }), binding.coarseEnumerationRoot);
  assert.notEqual(coarseEnumerationRootV1({ ...binding, observedUniqueCountLowerBound: "3" }), binding.coarseEnumerationRoot);
  const assessed = assessment(routes[0]!);
  const assessedRoot = coarseEnumerationRootV1({
    ...binding,
    candidates: [{ ...binding.candidates[0]!, assessment: assessed }, binding.candidates[1]!],
  });
  assert.notEqual(assessedRoot, binding.coarseEnumerationRoot);
  assert.notEqual(coarseEnumerationRootV1({
    ...binding,
    candidates: [{ ...binding.candidates[0]!, assessment: assessment(routes[0]!, { finalAmount: "111" }) }, binding.candidates[1]!],
  }), assessedRoot);
  assert.notEqual(coarseEnumerationRootV1({
    ...binding,
    candidates: [{ ...binding.candidates[0]!, assessment: Object.freeze({}) }, binding.candidates[1]!],
  }), binding.coarseEnumerationRoot);
  assert.throws(
    () => enumeration(planner, [routes[1]!, routes[0]!], [null, null]),
    /does not match the planner-issued identity/,
  );
  assert.throws(
    () => enumeration(planner, [routes[0]!, routes[0]!], [null, null]),
    /does not match the planner-issued identity/,
  );

  const admission = admitCoarseRoutesV1({ enumeration: capability });
  assert.equal(coarseAdmissionAccountingRootV1(admission), admission.accountingRoot);
  assert.throws(() => coarseAdmissionAccountingRootV1({
    ...admission,
    entries: [{ ...admission.entries[0]!, entryRoot: h("mutated-entry-root") }, admission.entries[1]!],
  }), /entryRoot mismatch/);
  assert.throws(() => coarseAdmissionAccountingRootV1({
    ...admission,
    entries: [{ ...admission.entries[0]!, reasonCode: "mutated-reason" }, admission.entries[1]!],
  }), /entryRoot mismatch/);
  assert.throws(() => coarseAdmissionAccountingRootV1({
    ...admission,
    entries: [{ ...admission.entries[0]!, assessmentId: h("mutated-assessment") }, admission.entries[1]!],
  }), /entryRoot mismatch/);
  assert.notEqual(coarseAdmissionAccountingRootV1({ ...admission, entries: [...admission.entries].reverse() }), admission.accountingRoot);
  assert.notEqual(coarseAdmissionAccountingRootV1({
    ...admission,
    observedUniqueCountLowerBound: "1",
    denominator: "1",
    notProbed: "1",
    entries: [admission.entries[0]!],
  }), admission.accountingRoot);
  assert.throws(() => coarseAdmissionAccountingRootV1({ ...admission, entries: [admission.entries[0]!, admission.entries[0]!] }), /duplicates/);
  assert.throws(() => coarseAdmissionAccountingRootV1({ ...admission, entries: [...admission.entries, admission.entries[0]!] }), /duplicates/);
  assert.throws(() => coarseAdmissionAccountingRootV1({ ...admission, denominator: "3" }), /scalar accounting/);
  assert.throws(() => coarseAdmissionAccountingRootV1({ ...admission, selectedCandidateIds: [admission.entries[0]!.candidateId] }), /selected denominator/);
  assert.throws(() => coarseAdmissionAccountingRootV1({ ...admission, outcome: "complete-candidates-terminal" }), /outcome/);
});

test("30k coarse denominator, nonzero owner-fair selection, and accounting stay bounded", () => {
  const planner = highCardinalityPlannerEnumeration();
  assert.equal(planner.candidates.length, 30_000);
  const routes = planner.candidates.map((candidate, index) => route(candidate, planner.graphRoot, h(`high-cardinality-owner:${index % 64}`)));
  const capability = enumeration(
    planner,
    routes,
    Array.from({ length: routes.length }, () => null),
    { rankedLimit: 0, boundedUnrankedLimit: 30_000 },
  );
  const binding = readIssuedCoarseEnumerationBindingV1(capability);
  assert.equal(binding.candidates.length, 30_000);
  assert.equal(coarseEnumerationRootV1(binding), binding.coarseEnumerationRoot);
  const admission = admitCoarseRoutesV1({ enumeration: capability });
  assert.equal(admission.denominator, "30000");
  assert.equal(admission.entries.length, 30_000);
  assert.equal(admission.boundedUnrankedSelected, "30000");
  assert.equal(admission.selectedCandidateIds.length, 30_000);
  assert.equal(coarseAdmissionAccountingRootV1(admission), admission.accountingRoot);
  assert.throws(() => encodeCanonicalJson(binding), /array exceeds policy/);
  assert.throws(() => encodeCanonicalJson(admission), /array exceeds policy/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { erc20AssetRefV1 } from "../../asset-ref/src/index.ts";
import { encodeCanonicalJson, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  sealGeneratedStrategyRuntimeDescriptor,
  strategyPlanningTemplateHash,
  type GeneratedStrategyRuntimeEntryV1,
  type IssuedStrategyPlanningProblemV1,
  type StrategyGraphBindingV1,
  type StrategyGraphEdgeV1,
} from "../../strategy-composition/src/index.ts";
import {
  createGeneratedStrategyRuntimeFactory,
  issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability,
} from "../../strategy-composition/src/internal/generated-runtime-composition.ts";
import { compileStrategy, defineStrategy } from "../../strategy-sdk/src/index.ts";
import {
  ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER,
  ROUTE_CYCLE_STRATEGY,
} from "../../../strategies/route-cycle/src/index.ts";
import { issueStrategyPlanningTriggerCapabilityV1 } from "../../strategy-composition/src/internal/trigger-owner.ts";
import {
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import {
  enumerateClosedLoopPlanningProblem,
  planningEnumerationRootV1,
  readIssuedPlanningEnumerationV1,
} from "../src/index.ts";

const h = (domain: string, value: unknown): Hash => hashDomain(domain, value);
const asset = (id: string): Hash => h("test/planner/asset/v1", id);
const planningObjectiveRef = h("aloha/search-objective/v1", { kind: "planner-test" });

const catalogEntry = compileStrategy(ROUTE_CYCLE_STRATEGY, []).entry;
const issuerClosureRoot = h("test/planner/issuer-closure/v1", "route-cycle");
const entryBody = {
  catalogEntry,
  issuerModulePath: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.modulePath,
  issuerExportName: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.exportName,
  issuerClosureRoot,
  planningTemplateHash: strategyPlanningTemplateHash(catalogEntry.planningTemplate),
};
const entry: GeneratedStrategyRuntimeEntryV1 = Object.freeze({
  ...entryBody,
  leafDigest: h("aloha/generated-strategy-runtime-leaf/v1", {
    strategyId: catalogEntry.strategyId,
    strategyDefinitionHash: catalogEntry.strategyDefinitionHash,
    definitionCatalogLeafDigest: catalogEntry.definitionCatalogLeafDigest,
    issuerModulePath: entryBody.issuerModulePath,
    issuerExportName: entryBody.issuerExportName,
    issuerClosureRoot,
    planningTemplateHash: entryBody.planningTemplateHash,
  }),
});
const descriptor = sealGeneratedStrategyRuntimeDescriptor({
  schemaVersion: 1,
  releaseIntentRoot: h("test/planner/release/v1", 1),
  definitionCatalogRoot: h("test/planner/catalog/v1", 1),
  proposedCapabilitySetRoot: h("test/planner/capabilities/v1", []),
  strategies: [entry],
});
const runtimeAuthorityDescriptor = createUnsignedDryRunRuntimeAuthorityDescriptorV1({
  authorityClass: "dry-run",
  runtimeBindingId: h("test/planner/runtime-binding/v1", 1),
  implementationCommit: "a".repeat(40),
});
const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(runtimeAuthorityDescriptor);

function openComposition(
  runtimeDescriptor = descriptor,
  issuer = ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER,
  assertCurrent: () => void = () => {},
) {
  const factory = createGeneratedStrategyRuntimeFactory({
    descriptor: runtimeDescriptor,
    issuers: [issuer],
  });
  const capability = issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability({
    factory,
    declaredCapabilitySetRoot: runtimeDescriptor.proposedCapabilitySetRoot,
    runtimeAuthority: runtimeAuthorityDescriptor,
    assertCurrent,
  });
  return factory(capability);
}

const composition = openComposition();
const binding: StrategyGraphBindingV1 = Object.freeze({
  generationId: "generation-1",
  definitionCatalogRoot: descriptor.definitionCatalogRoot,
  graphRoot: h("test/planner/graph/v1", 1),
  readyRecordHash: h("test/planner/ready/v1", 1),
  runtimeMembershipHash: composition.runtimeMembershipHash,
  runtimeAuthority,
  sourceHash: h("test/planner/source/v1", 1),
});

function edge(id: string, inputs: readonly string[], outputs: readonly string[]): StrategyGraphEdgeV1 {
  return edgeWithAssetRefs(id, inputs.map(asset), outputs.map(asset));
}

function edgeWithAssetRefs(id: string, inputs: readonly Hash[], outputs: readonly Hash[]): StrategyGraphEdgeV1 {
  return Object.freeze({
    edgeId: h("test/planner/edge/v1", id),
    opaqueTransitionRef: h("test/planner/transition/v1", id),
    inputAssetPorts: Object.freeze(inputs.map((value, index) => Object.freeze({
      assetRef: value,
      portRef: h("test/planner/port/v1", `${id}:in:${index}`),
      ordinal: index.toString(),
    }))),
    outputAssetPorts: Object.freeze(outputs.map((value, index) => Object.freeze({
      assetRef: value,
      portRef: h("test/planner/port/v1", `${id}:out:${index}`),
      ordinal: index.toString(),
    }))),
  });
}

function problem(
  edges: readonly StrategyGraphEdgeV1[],
  affectedEdgeIds: readonly Hash[] = [],
  objectiveEntryAssetRef?: Hash,
  objectiveRef: Hash = planningObjectiveRef,
): IssuedStrategyPlanningProblemV1 {
  const entryAssetRef = objectiveEntryAssetRef ?? (affectedEdgeIds.length === 0
    ? edges[0]
    : edges.find(value => affectedEdgeIds.includes(value.edgeId)))?.inputAssetPorts[0]?.assetRef ?? asset("missing-entry");
  return composition.issuePlanningProblems({
    binding,
    edges,
    trigger: issueStrategyPlanningTriggerCapabilityV1({
      binding,
      lane: affectedEdgeIds.length === 0 ? "blockscan" : "backrun",
      triggerRef: h("test/planner/trigger/v1", affectedEdgeIds.length === 0 ? "head" : "tx"),
      objectiveRef,
      entryAssetRef,
      returnAssetRef: entryAssetRef,
      affectedEdgeIds,
      correlationId: h("test/planner/correlation/v1", affectedEdgeIds.length === 0 ? "head" : "tx"),
    }),
  })[0]!;
}

function problemWithCandidateLimit(
  edges: readonly StrategyGraphEdgeV1[],
  candidateLimit: string,
  entryAssetRef: Hash,
): IssuedStrategyPlanningProblemV1 {
  const limitedDefinition = defineStrategy({
    ...ROUTE_CYCLE_STRATEGY,
    planningTemplate: { ...ROUTE_CYCLE_STRATEGY.planningTemplate, candidateLimit },
  });
  const limitedCatalogEntry = compileStrategy(limitedDefinition, []).entry;
  const planningTemplateHash = strategyPlanningTemplateHash(limitedCatalogEntry.planningTemplate);
  const limitedEntryBody = {
    catalogEntry: limitedCatalogEntry,
    issuerModulePath: limitedDefinition.planningProblemIssuer.modulePath,
    issuerExportName: limitedDefinition.planningProblemIssuer.exportName,
    issuerClosureRoot,
    planningTemplateHash,
  };
  const limitedEntry: GeneratedStrategyRuntimeEntryV1 = Object.freeze({
    ...limitedEntryBody,
    leafDigest: h("aloha/generated-strategy-runtime-leaf/v1", {
      strategyId: limitedCatalogEntry.strategyId,
      strategyDefinitionHash: limitedCatalogEntry.strategyDefinitionHash,
      definitionCatalogLeafDigest: limitedCatalogEntry.definitionCatalogLeafDigest,
      issuerModulePath: limitedEntryBody.issuerModulePath,
      issuerExportName: limitedEntryBody.issuerExportName,
      issuerClosureRoot,
      planningTemplateHash,
    }),
  });
  const limitedDescriptor = sealGeneratedStrategyRuntimeDescriptor({
    schemaVersion: 1,
    releaseIntentRoot: descriptor.releaseIntentRoot,
    definitionCatalogRoot: descriptor.definitionCatalogRoot,
    proposedCapabilitySetRoot: descriptor.proposedCapabilitySetRoot,
    strategies: [limitedEntry],
  });
  const limitedIssuer = Object.freeze({
    ...ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER,
    planningTemplateHash,
  });
  const limitedComposition = openComposition(limitedDescriptor, limitedIssuer);
  const limitedBinding = Object.freeze({
    ...binding,
    runtimeMembershipHash: limitedComposition.runtimeMembershipHash,
  });
  return limitedComposition.issuePlanningProblems({
    binding: limitedBinding,
    edges,
    trigger: issueStrategyPlanningTriggerCapabilityV1({
      binding: limitedBinding,
      lane: "blockscan",
      triggerRef: h("test/planner/trigger/v1", `limit:${candidateLimit}`),
      objectiveRef: planningObjectiveRef,
      entryAssetRef,
      returnAssetRef: entryAssetRef,
      affectedEdgeIds: [],
      correlationId: h("test/planner/correlation/v1", `limit:${candidateLimit}`),
    }),
  })[0]!;
}

test("enumerates one canonical directed cycle and binds exact asset ports", () => {
  const edges = [edge("ab", ["a", "unused"], ["b"]), edge("ba", ["b"], ["a"])];
  const result = enumerateClosedLoopPlanningProblem({ problem: problem(edges) });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.truncated, false);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.legs.length, 2);
  assert.equal(candidate.loopIntent.entryAssetRef, candidate.legs[0]!.inputAssetRef);
  assert.equal(candidate.loopIntent.returnAssetRef, candidate.legs[0]!.inputAssetRef);
  assert.deepEqual(
    candidate.loopIntent.legs.map(leg => [leg.fromAssetRef, leg.toAssetRef]),
    candidate.legs.map(leg => [leg.inputAssetRef, leg.outputAssetRef]),
  );
  for (let index = 0; index < candidate.legs.length; index += 1) {
    assert.equal(candidate.legs[index]!.outputAssetRef, candidate.legs[(index + 1) % candidate.legs.length]!.inputAssetRef);
  }
  const byEdge = new Map(candidate.legs.map(leg => [leg.edgeId, leg]));
  assert.deepEqual(byEdge.get(edges[0]!.edgeId), {
    edgeId: edges[0]!.edgeId,
    transitionRef: edges[0]!.opaqueTransitionRef,
    inputAssetRef: asset("a"),
    inputPortRef: edges[0]!.inputAssetPorts[0]!.portRef,
    outputAssetRef: asset("b"),
    outputPortRef: edges[0]!.outputAssetPorts[0]!.portRef,
  });
  assert.deepEqual(byEdge.get(edges[1]!.edgeId), {
    edgeId: edges[1]!.edgeId,
    transitionRef: edges[1]!.opaqueTransitionRef,
    inputAssetRef: asset("b"),
    inputPortRef: edges[1]!.inputAssetPorts[0]!.portRef,
    outputAssetRef: asset("a"),
    outputPortRef: edges[1]!.outputAssetPorts[0]!.portRef,
  });
});

test("enumerates the generated problem under unsigned dry-run authority", () => {
  const edges = [edge("unsigned-ab", ["a"], ["b"]), edge("unsigned-ba", ["b"], ["a"])];
  const planningProblem = problem(edges);
  const result = enumerateClosedLoopPlanningProblem({ problem: planningProblem });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.planningProblem.runtimeAuthority.authorityClass, "dry-run");
  assert.equal(typeof result.planningProblem.runtimeMembershipHash, "string");
  assert.equal(Object.prototype.hasOwnProperty.call(result.planningProblem, "releaseProvenanceHash"), false);
});

test("family-independent AssetRefs close a cross-Family cycle but never cross chains", () => {
  const tokenA = "0x1111111111111111111111111111111111111111";
  const tokenB = "0x2222222222222222222222222222222222222222";
  const chainOneA = erc20AssetRefV1("1", tokenA);
  const chainOneB = erc20AssetRefV1("1", tokenB);
  const chainTenB = erc20AssetRefV1("10", tokenB);
  const familyAEdge = edgeWithAssetRefs("family-a:a-to-b", [chainOneA], [chainOneB]);
  const familyBEdge = edgeWithAssetRefs("family-b:b-to-a", [chainOneB], [chainOneA]);

  const closed = enumerateClosedLoopPlanningProblem({
    problem: problem([familyAEdge, familyBEdge]),
  });
  assert.equal(closed.candidates.length, 1);
  assert.deepEqual(
    new Set(closed.candidates[0]!.legs.map(leg => leg.edgeId)),
    new Set([familyAEdge.edgeId, familyBEdge.edgeId]),
  );
  assert.notEqual(familyAEdge.outputAssetPorts[0]!.portRef, familyBEdge.inputAssetPorts[0]!.portRef);
  assert.equal(familyAEdge.outputAssetPorts[0]!.assetRef, familyBEdge.inputAssetPorts[0]!.assetRef);

  const wrongChainFamilyB = edgeWithAssetRefs("family-b:chain-ten-b-to-a", [chainTenB], [chainOneA]);
  const open = enumerateClosedLoopPlanningProblem({
    problem: problem([familyAEdge, wrongChainFamilyB]),
  });
  assert.equal(open.candidates.length, 0);
});

test("transition and exact input/output ports are load-bearing candidate facts", () => {
  const baseEdges = [edge("ab", ["a"], ["b"]), edge("ba", ["b"], ["a"])];
  const transitionEdges = [
    Object.freeze({ ...baseEdges[0]!, opaqueTransitionRef: h("test/planner/transition/v1", "ab-mutated") }),
    baseEdges[1]!,
  ];
  const inputPortEdges = [
    Object.freeze({
      ...baseEdges[0]!,
      inputAssetPorts: Object.freeze([Object.freeze({
        ...baseEdges[0]!.inputAssetPorts[0]!,
        portRef: h("test/planner/port/v1", "ab:mutated-input"),
      })]),
    }),
    baseEdges[1]!,
  ];
  const outputPortEdges = [
    Object.freeze({
      ...baseEdges[0]!,
      outputAssetPorts: Object.freeze([Object.freeze({
        ...baseEdges[0]!.outputAssetPorts[0]!,
        portRef: h("test/planner/port/v1", "ab:mutated-output"),
      })]),
    }),
    baseEdges[1]!,
  ];
  const enumerate = (graphEdges: readonly StrategyGraphEdgeV1[]) =>
    enumerateClosedLoopPlanningProblem({ problem: problem(graphEdges) });
  const base = enumerate(baseEdges);
  const transitionChanged = enumerate(transitionEdges);
  const inputPortChanged = enumerate(inputPortEdges);
  const outputPortChanged = enumerate(outputPortEdges);
  for (const changed of [transitionChanged, inputPortChanged, outputPortChanged]) {
    assert.notEqual(changed.candidates[0]!.candidateId, base.candidates[0]!.candidateId);
    assert.notEqual(changed.candidates[0]!.orderKey, base.candidates[0]!.orderKey);
    assert.notDeepEqual(
      changed.candidates[0]!.loopIntent.legs.map(leg => leg.selectionRef),
      base.candidates[0]!.loopIntent.legs.map(leg => leg.selectionRef),
    );
    assert.notEqual(changed.enumerationRoot, base.enumerationRoot);
  }
});

test("enumeration retains the complete owner-issued Strategy binding for downstream joins", () => {
  const edges = [edge("ab", ["a"], ["b"]), edge("ba", ["b"], ["a"])];
  const planningProblem = problem(edges);
  const enumeration = enumerateClosedLoopPlanningProblem({ problem: planningProblem });
  assert.equal(enumeration.planningProblem, planningProblem);
  assert.deepEqual({
    generationId: enumeration.planningProblem.generationId,
    runtimeMembershipHash: enumeration.planningProblem.runtimeMembershipHash,
    objectiveRef: enumeration.planningProblem.objectiveRef,
    readyRecordHash: enumeration.planningProblem.readyRecordHash,
    strategyCompositionRoot: enumeration.planningProblem.strategyCompositionRoot,
    strategyIssuerClosureRoot: enumeration.planningProblem.strategyIssuerClosureRoot,
    triggerHeadHash: enumeration.planningProblem.triggerHeadHash,
  }, {
    generationId: binding.generationId,
    runtimeMembershipHash: binding.runtimeMembershipHash,
    objectiveRef: planningObjectiveRef,
    readyRecordHash: binding.readyRecordHash,
    strategyCompositionRoot: composition.compositionRoot,
    strategyIssuerClosureRoot: composition.issuerClosureRoot,
    triggerHeadHash: binding.sourceHash,
  });
});

test("backrun anchor scope keeps only cycles affected by the trigger", () => {
  const first = [edge("ab", ["a"], ["b"]), edge("ba", ["b"], ["a"])];
  const second = [edge("cd", ["c"], ["d"]), edge("dc", ["d"], ["c"])];
  const edges = [...first, ...second];
  const result = enumerateClosedLoopPlanningProblem({ problem: problem(edges, [second[0]!.edgeId]) });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.legs.some(leg => leg.edgeId === second[0]!.edgeId), true);
  assert.equal(result.candidates[0]!.legs.some(leg => leg.edgeId === first[0]!.edgeId), false);
});

test("candidate bound is deterministic and reports truncation instead of silent loss", () => {
  const edges = [
    edge("ab", ["a"], ["b"]), edge("ba", ["b"], ["a"]),
    edge("ac", ["a"], ["c"]), edge("ca", ["c"], ["a"]),
  ];
  const constrained = problemWithCandidateLimit(edges, "1", asset("a"));
  const first = enumerateClosedLoopPlanningProblem({ problem: constrained });
  const reversed = problemWithCandidateLimit([...edges].reverse(), "1", asset("a"));
  const second = enumerateClosedLoopPlanningProblem({ problem: reversed });
  assert.equal(first.candidates.length, 1);
  assert.equal(first.truncated, true);
  assert.equal(first.observedUniqueCountLowerBound, "2");
  assert.equal(first.enumerationRoot, second.enumerationRoot);
});

test("objective entry selects executable rotation and prevents cross-objective substitution", () => {
  const edges = [edge("ab", ["a"], ["b"]), edge("ba", ["b"], ["a"])];
  const objectiveA = h("aloha/search-objective/v1", { entry: "a" });
  const objectiveB = h("aloha/search-objective/v1", { entry: "b" });
  const problemA = problem(edges, [], asset("a"), objectiveA);
  const problemB = problem(edges, [], asset("b"), objectiveB);
  const enumerationA = enumerateClosedLoopPlanningProblem({ problem: problemA });
  const enumerationB = enumerateClosedLoopPlanningProblem({ problem: problemB });
  const candidateA = enumerationA.candidates[0]!;
  const candidateB = enumerationB.candidates[0]!;

  assert.deepEqual(candidateA.legs.map(leg => leg.edgeId), [edges[0]!.edgeId, edges[1]!.edgeId]);
  assert.deepEqual(candidateB.legs.map(leg => leg.edgeId), [edges[1]!.edgeId, edges[0]!.edgeId]);
  assert.equal(candidateA.loopIntent.entryAssetRef, asset("a"));
  assert.equal(candidateB.loopIntent.entryAssetRef, asset("b"));
  assert.notEqual(problemA.problemHash, problemB.problemHash);
  assert.notEqual(candidateA.candidateId, candidateB.candidateId);
  assert.notEqual(candidateA.orderKey, candidateB.orderKey);

  const substituted = Object.freeze({
    ...enumerationB,
    candidates: Object.freeze([candidateA]),
  });
  assert.throws(
    () => readIssuedPlanningEnumerationV1(substituted),
    /planner enumeration was not issued by the planner owner/,
  );
});

test("closed-loop objective return asset mismatch fails before planning", () => {
  assert.throws(() => issueStrategyPlanningTriggerCapabilityV1({
    binding,
    lane: "blockscan",
    triggerRef: h("test/planner/trigger/v1", "mismatched-return"),
    objectiveRef: planningObjectiveRef,
    entryAssetRef: asset("a"),
    returnAssetRef: asset("b"),
    affectedEdgeIds: [],
    correlationId: h("test/planner/correlation/v1", "mismatched-return"),
  }), /must return to its entry asset/);
});

test("forged problem, extra fields and duplicate Graph edges fail closed", () => {
  const edges = [edge("ab", ["a"], ["b"]), edge("ba", ["b"], ["a"])];
  const valid = problem(edges);
  assert.throws(() => enumerateClosedLoopPlanningProblem({ problem: { ...valid, graphRoot: h("test/planner/forged/v1", "graph") } as never }), /not issued/);
  assert.throws(() => enumerateClosedLoopPlanningProblem({ problem: { ...valid, extra: true } as never }), /not issued/);
  assert.throws(() => enumerateClosedLoopPlanningProblem({
    problem: JSON.parse(JSON.stringify(valid)) as never,
  }), /not issued/);
  assert.throws(() => problem([edges[0]!, edges[0]!]), /Graph edge set is invalid/);
});

test("planner re-fences the Strategy owner capability after release rotation", () => {
  let current = true;
  const rotatingComposition = openComposition(descriptor, ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER, () => {
    if (!current) throw new TypeError("test Strategy release rotated");
  });
  const edges = [edge("ab", ["a"], ["b"]), edge("ba", ["b"], ["a"])];
  const [issued] = rotatingComposition.issuePlanningProblems({
    binding,
    edges,
    trigger: issueStrategyPlanningTriggerCapabilityV1({
      binding,
      lane: "blockscan",
      triggerRef: h("test/planner/trigger/v1", "rotation"),
      objectiveRef: planningObjectiveRef,
      entryAssetRef: asset("a"),
      returnAssetRef: asset("a"),
      affectedEdgeIds: [],
      correlationId: h("test/planner/correlation/v1", "rotation"),
    }),
  });
  assert.ok(issued);
  const enumeration = enumerateClosedLoopPlanningProblem({ problem: issued });
  assert.equal(enumeration.candidates.length, 1);
  current = false;
  assert.throws(
    () => enumerateClosedLoopPlanningProblem({ problem: issued }),
    /Strategy release rotated/,
  );
  assert.throws(() => readIssuedPlanningEnumerationV1(enumeration), /Strategy release rotated/);
});

test("complete enumeration is an owner-issued capability and a spliced clone is not", () => {
  const edges = [
    edge("ab", ["a"], ["b"]), edge("ba", ["b"], ["a"]),
    edge("ac", ["a"], ["c"]), edge("ca", ["c"], ["a"]),
  ];
  const planningProblem = problem(edges);
  const issued = enumerateClosedLoopPlanningProblem({ problem: planningProblem });
  assert.equal(readIssuedPlanningEnumerationV1(issued), issued);
  assert.equal(issued.candidates.length, 2);
  assert.throws(() => enumerateClosedLoopPlanningProblem({
    problem: planningProblem,
    edges: edges.slice(0, 2),
  } as never), /unknown field "edges"/);

  const spliced = Object.freeze({
    ...issued,
    candidates: Object.freeze(issued.candidates.slice(0, 1)),
  });
  assert.equal(spliced.enumerationRoot, issued.enumerationRoot);
  assert.throws(
    () => readIssuedPlanningEnumerationV1(spliced),
    /planner enumeration was not issued by the planner owner/,
  );
  assert.throws(
    () => readIssuedPlanningEnumerationV1(JSON.parse(JSON.stringify(issued))),
    /planner enumeration was not issued by the planner owner/,
  );
});

test("enumeration root commits ordered candidate identity and scalar counts without materializing route payloads", () => {
  const issued = enumerateClosedLoopPlanningProblem({ problem: problem([
    edge("ab", ["a"], ["b"]), edge("ba", ["b"], ["a"]),
    edge("ac", ["a"], ["c"]), edge("ca", ["c"], ["a"]),
  ]) });
  const first = issued.candidates[0]!;
  const second = issued.candidates[1]!;
  const root = planningEnumerationRootV1(issued);
  const inaccessiblePayload = new Proxy(first, {
    get(target, property, receiver) {
      if (property === "legs" || property === "loopIntent") throw new Error("high-cardinality payload was read");
      return Reflect.get(target, property, receiver);
    },
  });
  const inaccessibleProblem = new Proxy(issued.planningProblem, {
    get() { throw new Error("planning problem payload was read"); },
  });
  assert.equal(planningEnumerationRootV1({
    ...issued,
    planningProblem: inaccessibleProblem,
    candidates: [inaccessiblePayload, second],
  }), root);
  assert.notEqual(planningEnumerationRootV1({
    ...issued,
    candidates: [{ ...first, candidateId: h("test/planner/mutation/v1", "candidate") }, second],
  }), root);
  assert.notEqual(planningEnumerationRootV1({ ...issued, candidates: [second, first] }), root);
  assert.notEqual(planningEnumerationRootV1({ ...issued, candidates: [first, first] }), root);
  assert.notEqual(planningEnumerationRootV1({ ...issued, candidates: [first, second, first] }), root);
  assert.notEqual(planningEnumerationRootV1({ ...issued, observedUniqueCountLowerBound: "3" }), root);
});

test("30k planner denominator remains owner-readable while canonical wire encoding stays explicitly out of scope", () => {
  const forwardCount = 174;
  const backwardCount = 173;
  const entry = asset("high-cardinality-entry");
  const intermediate = asset("high-cardinality-intermediate");
  const edges = [
    ...Array.from({ length: forwardCount }, (_, index) => edgeWithAssetRefs(`high-forward-${index}`, [entry], [intermediate])),
    ...Array.from({ length: backwardCount }, (_, index) => edgeWithAssetRefs(`high-backward-${index}`, [intermediate], [entry])),
  ];
  const issued = enumerateClosedLoopPlanningProblem({
    problem: problemWithCandidateLimit(edges, "30000", entry),
  });
  assert.equal(issued.candidates.length, 30_000);
  assert.equal(issued.truncated, true);
  assert.equal(issued.observedUniqueCountLowerBound, "30001");
  assert.equal(readIssuedPlanningEnumerationV1(issued), issued);
  assert.equal(planningEnumerationRootV1(issued), issued.enumerationRoot);
  assert.throws(() => encodeCanonicalJson(issued), /array exceeds policy/);
});

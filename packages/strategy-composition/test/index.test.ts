import assert from "node:assert/strict";
import { test } from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import { compileStrategy } from "../../strategy-sdk/src/index.ts";
import {
  assertGeneratedStrategyRuntimeComposition,
  assertIssuedStrategyPlanningInput,
  assertIssuedStrategyPlanningProblem,
  createGeneratedStrategyRuntimeComposition,
  readIssuedStrategyPlanningInputV1,
  readIssuedStrategyPlanningProblemV1,
  sealGeneratedStrategyRuntimeDescriptor,
  strategyPlanningTemplateHash,
  type GeneratedStrategyRuntimeEntryV1,
  type StrategyGraphBindingV1,
  type StrategyGraphEdgeV1,
} from "../src/index.ts";
import {
  assertGeneratedStrategyRuntimeFactory,
  createGeneratedStrategyRuntimeFactory,
  issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability,
  readGeneratedStrategyRuntimeFactoryMetadata,
} from "../src/internal/generated-runtime-composition.ts";
import { issueStrategyPlanningTriggerCapabilityV1 } from "../src/internal/trigger-owner.ts";
import {
  ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER,
  ROUTE_CYCLE_STRATEGY,
} from "../../../strategies/route-cycle/src/index.ts";

const h = (domain: string, value: unknown): Hash => hashDomain(domain, value);
const implementationCommit = "a".repeat(40);
const unsignedRuntimeAuthority = createUnsignedDryRunRuntimeAuthorityDescriptorV1({
  authorityClass: "dry-run",
  runtimeBindingId: h("test/strategy-composition/runtime-binding/v1", 1),
  implementationCommit,
});
const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(unsignedRuntimeAuthority);

const catalogEntry = compileStrategy(ROUTE_CYCLE_STRATEGY, []).entry;
const issuerClosureRoot = h("test/strategy-composition/issuer-closure/v1", "route-cycle");
const runtimeEntryBase = {
  catalogEntry,
  issuerModulePath: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.modulePath,
  issuerExportName: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.exportName,
  issuerClosureRoot,
  planningTemplateHash: strategyPlanningTemplateHash(catalogEntry.planningTemplate),
};
const runtimeEntry: GeneratedStrategyRuntimeEntryV1 = Object.freeze({
  ...runtimeEntryBase,
  leafDigest: h("aloha/generated-strategy-runtime-leaf/v1", {
    strategyId: catalogEntry.strategyId,
    strategyDefinitionHash: catalogEntry.strategyDefinitionHash,
    definitionCatalogLeafDigest: catalogEntry.definitionCatalogLeafDigest,
    issuerModulePath: runtimeEntryBase.issuerModulePath,
    issuerExportName: runtimeEntryBase.issuerExportName,
    issuerClosureRoot,
    planningTemplateHash: runtimeEntryBase.planningTemplateHash,
  }),
});

const descriptor = sealGeneratedStrategyRuntimeDescriptor({
  schemaVersion: 1,
  releaseIntentRoot: h("test/strategy-composition/release/v1", "release"),
  definitionCatalogRoot: h("test/strategy-composition/catalog/v1", "global"),
  proposedCapabilitySetRoot: h("test/strategy-composition/capabilities/v1", []),
  strategies: [runtimeEntry],
});

const objectiveRef = (id: string): Hash => h("aloha/search-objective/v1", { id });

const trigger = (
  lane: "blockscan" | "backrun",
  id: string,
  affectedEdgeIds: readonly Hash[] = [],
  objective = objectiveRef("default"),
) => issueStrategyPlanningTriggerCapabilityV1({
  binding,
  lane,
  triggerRef: h("test/strategy-composition/trigger/v1", id),
  objectiveRef: objective,
  entryAssetRef: h("test/strategy-composition/asset/v1", "a"),
  returnAssetRef: h("test/strategy-composition/asset/v1", "a"),
  affectedEdgeIds,
  correlationId: h("test/strategy-composition/correlation/v1", id),
});

const edge = (id: string, from: string, to: string): StrategyGraphEdgeV1 => ({
  edgeId: h("test/strategy-composition/edge/v1", id),
  opaqueTransitionRef: h("test/strategy-composition/transition/v1", id),
  inputAssetPorts: [{ assetRef: h("test/strategy-composition/asset/v1", from), portRef: h("test/strategy-composition/port/v1", `${id}:in`), ordinal: "0" }],
  outputAssetPorts: [{ assetRef: h("test/strategy-composition/asset/v1", to), portRef: h("test/strategy-composition/port/v1", `${id}:out`), ordinal: "0" }],
});

const edges = Object.freeze([edge("a", "base", "quote"), edge("b", "quote", "base")]);

function openTestComposition(input: {
  readonly descriptor?: typeof descriptor;
  readonly issuers?: readonly typeof ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER[];
  readonly assertCurrent?: () => void;
} = {}) {
  const selectedDescriptor = input.descriptor ?? descriptor;
  const factory = createGeneratedStrategyRuntimeFactory({
    descriptor: selectedDescriptor,
    issuers: input.issuers ?? [ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER],
  });
  const capability = issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability({
    factory,
    declaredCapabilitySetRoot: selectedDescriptor.proposedCapabilitySetRoot,
    runtimeAuthority: unsignedRuntimeAuthority,
    assertCurrent: input.assertCurrent ?? (() => {}),
  });
  return Object.freeze({ factory, capability, composition: factory(capability) });
}

const binding: StrategyGraphBindingV1 = Object.freeze({
  generationId: "generation-1",
  definitionCatalogRoot: descriptor.definitionCatalogRoot,
  graphRoot: h("test/strategy-composition/graph/v1", 1),
  readyRecordHash: h("test/strategy-composition/ready/v1", 1),
  runtimeMembershipHash: openTestComposition().composition.runtimeMembershipHash,
  runtimeAuthority,
  sourceHash: h("test/strategy-composition/head/v1", 1),
});

test("generated Strategy issues a Graph-bound blockscan problem without fixture assets", () => {
  const { composition } = openTestComposition();
  const problems = composition.issuePlanningProblems({
    binding,
    edges,
    trigger: trigger("blockscan", "head"),
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.kind, "closed-loop");
  assert.equal(problems[0]!.runtimeMembershipHash, binding.runtimeMembershipHash);
  assert.deepEqual(problems[0]!.runtimeAuthority, runtimeAuthority);
  assert.equal(problems[0]!.generationId, binding.generationId);
  assert.equal(problems[0]!.graphRoot, binding.graphRoot);
  assert.equal(problems[0]!.objectiveRef, objectiveRef("default"));
  assert.deepEqual(problems[0]!.requiredAnchorEdgeIds, []);
  assert.equal(problems[0]!.entryAssetRef, h("test/strategy-composition/asset/v1", "a"));
  assert.equal(problems[0]!.returnAssetRef, h("test/strategy-composition/asset/v1", "a"));
});

test("backrun problem preserves the exact affected-edge scope", () => {
  const { composition } = openTestComposition();
  const problems = composition.issuePlanningProblems({
    binding,
    edges,
    trigger: trigger("backrun", "tx", [edges[1]!.edgeId]),
  });
  assert.deepEqual(problems[0]!.requiredAnchorEdgeIds, [edges[1]!.edgeId]);
  assert.throws(() => issueStrategyPlanningTriggerCapabilityV1({
    binding,
    lane: "backrun",
    triggerRef: h("test/strategy-composition/trigger/v1", "empty"),
    objectiveRef: objectiveRef("default"),
    entryAssetRef: h("test/strategy-composition/asset/v1", "a"),
    returnAssetRef: h("test/strategy-composition/asset/v1", "a"),
    affectedEdgeIds: [],
    correlationId: h("test/strategy-composition/correlation/v1", "empty"),
  }), /requires affected Graph edges/);
});

test("one generated Strategy binds each runtime planning problem to the trigger's exact objective", () => {
  const { composition } = openTestComposition();
  const firstObjectiveRef = objectiveRef("first");
  const secondObjectiveRef = objectiveRef("second");
  const [first] = composition.issuePlanningProblems({ binding, edges, trigger: trigger("blockscan", "first", [], firstObjectiveRef) });
  const [second] = composition.issuePlanningProblems({ binding, edges, trigger: trigger("blockscan", "second", [], secondObjectiveRef) });
  assert.equal(first?.objectiveRef, firstObjectiveRef);
  assert.equal(second?.objectiveRef, secondObjectiveRef);
  assert.equal(first?.strategyCatalogLeafDigest, second?.strategyCatalogLeafDigest);
});

test("forged issuer and descriptor/template mutations are rejected", () => {
  assert.throws(() => openTestComposition({
    descriptor,
    issuers: [{ ...ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER, strategyId: "forged" }],
  }), /issuer identity mismatch/);
  assert.throws(() => openTestComposition({
    descriptor: { ...descriptor, descriptorRoot: h("test/strategy-composition/forged/v1", "descriptor") },
  }), /descriptor root mismatch/);
  const { composition } = openTestComposition({
    issuers: [{
      ...ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER,
      issue(input) {
        return { ...ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER.issue(input), maxLegs: "99" };
      },
    }],
  });
  assert.throws(() => composition.issuePlanningProblems({
    binding,
    edges,
    trigger: trigger("blockscan", "forged"),
  }), /changed its generated planning template/);
  const { composition: objectiveSplicingComposition } = openTestComposition({
    issuers: [{
      ...ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER,
      issue(input) {
        return { ...ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER.issue(input), objectiveRef: objectiveRef("spliced") };
      },
    }],
  });
  assert.throws(() => objectiveSplicingComposition.issuePlanningProblems({
    binding,
    edges,
    trigger: trigger("blockscan", "objective"),
  }), /changed the trigger objective/);
});

test("planning problems are process-local issued values, not caller-recomputed hashes", () => {
  const { composition } = openTestComposition();
  const [problem] = composition.issuePlanningProblems({
    binding,
    edges,
    trigger: trigger("blockscan", "auth"),
  });
  assert.ok(problem);
  assert.doesNotThrow(() => assertIssuedStrategyPlanningProblem(problem));
  assert.throws(() => assertIssuedStrategyPlanningProblem({ ...problem }), /not issued/);
});

test("trigger capability cannot be cloned or replayed across head/release bindings", () => {
  const { composition } = openTestComposition();
  const issued = trigger("blockscan", "authentic");
  assert.throws(() => composition.issuePlanningProblems({
    binding,
    edges,
    trigger: { ...issued } as never,
  }), /not owner-issued/);
  const foreignBinding = Object.freeze({ ...binding, sourceHash: h("test/strategy-composition/head/v1", "foreign") });
  const foreign = issueStrategyPlanningTriggerCapabilityV1({
    binding: foreignBinding,
    lane: "blockscan",
    triggerRef: h("test/strategy-composition/trigger/v1", "foreign"),
    objectiveRef: objectiveRef("default"),
    entryAssetRef: h("test/strategy-composition/asset/v1", "a"),
    returnAssetRef: h("test/strategy-composition/asset/v1", "a"),
    affectedEdgeIds: [],
    correlationId: h("test/strategy-composition/correlation/v1", "foreign"),
  });
  assert.throws(() => composition.issuePlanningProblems({ binding, edges, trigger: foreign }), /binding mismatch/);
});

test("trigger owner snapshots its exact binding instead of retaining caller-mutable state", () => {
  const { composition } = openTestComposition();
  const mutableBinding = { ...binding };
  const issued = issueStrategyPlanningTriggerCapabilityV1({
    binding: mutableBinding,
    lane: "blockscan",
    triggerRef: h("test/strategy-composition/trigger/v1", "snapshot"),
    objectiveRef: objectiveRef("snapshot"),
    entryAssetRef: h("test/strategy-composition/asset/v1", "a"),
    returnAssetRef: h("test/strategy-composition/asset/v1", "a"),
    affectedEdgeIds: [],
    correlationId: h("test/strategy-composition/correlation/v1", "snapshot"),
  });
  mutableBinding.sourceHash = h("test/strategy-composition/head/v1", "mutated-after-issue");
  assert.equal(composition.issuePlanningProblems({ binding, edges, trigger: issued }).length, 1);
  assert.throws(
    () => composition.issuePlanningProblems({ binding: mutableBinding, edges, trigger: issued }),
    /binding mismatch/,
  );
});

test("planning owner snapshots transition and both port sets before issuing capability", () => {
  const { composition } = openTestComposition();
  const mutableEdge = {
    edgeId: h("test/strategy-composition/edge/v1", "mutable"),
    opaqueTransitionRef: h("test/strategy-composition/transition/v1", "original"),
    inputAssetPorts: [{
      assetRef: h("test/strategy-composition/asset/v1", "base"),
      portRef: h("test/strategy-composition/port/v1", "original-input"),
      ordinal: "0",
    }],
    outputAssetPorts: [{
      assetRef: h("test/strategy-composition/asset/v1", "quote"),
      portRef: h("test/strategy-composition/port/v1", "original-output"),
      ordinal: "0",
    }],
  };
  const original = {
    transitionRef: mutableEdge.opaqueTransitionRef,
    inputPortRef: mutableEdge.inputAssetPorts[0]!.portRef,
    outputPortRef: mutableEdge.outputAssetPorts[0]!.portRef,
  };
  const [problem] = composition.issuePlanningProblems({
    binding,
    edges: [mutableEdge],
    trigger: trigger("blockscan", "edge-snapshot"),
  });
  assert.ok(problem);
  mutableEdge.opaqueTransitionRef = h("test/strategy-composition/transition/v1", "mutated");
  mutableEdge.inputAssetPorts[0]!.portRef = h("test/strategy-composition/port/v1", "mutated-input");
  mutableEdge.outputAssetPorts[0]!.portRef = h("test/strategy-composition/port/v1", "mutated-output");
  const issued = readIssuedStrategyPlanningProblemV1(problem);
  assert.deepEqual({
    transitionRef: issued.edges[0]!.opaqueTransitionRef,
    inputPortRef: issued.edges[0]!.inputAssetPorts[0]!.portRef,
    outputPortRef: issued.edges[0]!.outputAssetPorts[0]!.portRef,
  }, original);
});

test("generated Strategy factory closes exact issuer imports and fails closed without release capability", () => {
  const factory = createGeneratedStrategyRuntimeFactory({
    descriptor,
    issuers: [ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER],
  });
  assert.doesNotThrow(() => assertGeneratedStrategyRuntimeFactory(factory));
  const metadata = readGeneratedStrategyRuntimeFactoryMetadata(factory);
  assert.equal(metadata.definitionCatalogRoot, descriptor.definitionCatalogRoot);
  assert.equal(metadata.strategyCatalogRoot, hashDomain("aloha/strategy-definition-catalog/v1", [catalogEntry.definitionCatalogLeafDigest]));
  assert.equal(metadata.descriptorRoot, descriptor.descriptorRoot);
  assert.throws(() => factory({} as never), /production authority is unavailable/);
  assert.throws(() => assertGeneratedStrategyRuntimeFactory((() => ({})) as never), /not generated/);
  assert.throws(() => createGeneratedStrategyRuntimeComposition({
    descriptor,
    issuers: [ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER],
    runtimeMembershipHash: binding.runtimeMembershipHash,
  } as never), /production authority is unavailable/);
  const first = openTestComposition();
  const secondFactory = createGeneratedStrategyRuntimeFactory({
    descriptor,
    issuers: [ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER],
  });
  assert.throws(() => first.factory({ ...first.capability } as never), /production authority is unavailable/);
  assert.throws(() => secondFactory(first.capability), /bound to another generated factory/);
  assert.throws(
    () => assertGeneratedStrategyRuntimeComposition({ ...first.composition }),
    /not generated and release-authenticated/,
  );
});

test("issued planning capability is fenced by release rotation", () => {
  let current = true;
  const { composition } = openTestComposition({
    assertCurrent() {
      if (!current) throw new TypeError("test release rotated");
    },
  });
  const [problem] = composition.issuePlanningProblems({
    binding,
    edges,
    trigger: trigger("blockscan", "rotation"),
  });
  assert.ok(problem);
  assert.doesNotThrow(() => assertGeneratedStrategyRuntimeComposition(composition));
  assert.doesNotThrow(() => assertIssuedStrategyPlanningProblem(problem));
  current = false;
  assert.throws(() => assertGeneratedStrategyRuntimeComposition(composition), /release rotated/);
  assert.throws(() => assertIssuedStrategyPlanningProblem(problem), /release rotated/);
  assert.throws(() => composition.issuePlanningProblems({
    binding,
    edges,
    trigger: trigger("blockscan", "stale-composition"),
  }), /release rotated/);
});

test("unsigned dry-run binds the exact generated Strategy membership", () => {
  const factory = createGeneratedStrategyRuntimeFactory({
    descriptor,
    issuers: [ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER],
  });
  const unsignedAuthority = createUnsignedDryRunRuntimeAuthorityDescriptorV1({
    authorityClass: "dry-run",
    runtimeBindingId: h("test/strategy-composition/unsigned-runtime-binding/v1", 1),
    implementationCommit: "b".repeat(40),
  });
  const capability = issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability({
    factory,
    declaredCapabilitySetRoot: descriptor.proposedCapabilitySetRoot,
    runtimeAuthority: unsignedAuthority,
    assertCurrent() {},
  });
  const composition = factory(capability);
  const unsignedBinding: StrategyGraphBindingV1 = Object.freeze({
    generationId: "generation-unsigned",
    definitionCatalogRoot: descriptor.definitionCatalogRoot,
    graphRoot: binding.graphRoot,
    readyRecordHash: binding.readyRecordHash,
    runtimeMembershipHash: composition.runtimeMembershipHash,
    runtimeAuthority: projectRuntimeAuthorityDescriptorV1(unsignedAuthority),
    sourceHash: binding.sourceHash,
  });
  const issuedTrigger = issueStrategyPlanningTriggerCapabilityV1({
    binding: unsignedBinding,
    lane: "blockscan",
    triggerRef: h("test/strategy-composition/trigger/v1", "unsigned"),
    objectiveRef: objectiveRef("default"),
    entryAssetRef: h("test/strategy-composition/asset/v1", "a"),
    returnAssetRef: h("test/strategy-composition/asset/v1", "a"),
    affectedEdgeIds: [],
    correlationId: h("test/strategy-composition/correlation/v1", "unsigned"),
  });
  const [problem] = composition.issuePlanningProblems({ binding: unsignedBinding, edges, trigger: issuedTrigger });
  assert.equal(problem?.runtimeMembershipHash, composition.runtimeMembershipHash);
  assert.equal(problem?.runtimeAuthority.authorityClass, "dry-run");
  assert.equal(Object.prototype.hasOwnProperty.call(composition, "releaseProvenanceHash"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(problem!, "releaseProvenanceHash"), false);
  assert.throws(() => issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability({
    factory,
    declaredCapabilitySetRoot: h("test/strategy-composition/foreign-capability/v1", 1),
    runtimeAuthority: unsignedAuthority,
    assertCurrent() {},
  }), /declared capability set/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asCapabilityId,
  asCapabilityVersion,
  asOwnerRef,
  asSchemaRef,
  type CapabilityRefV1,
} from "../../capability-contracts/src/index.ts";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  compileStrategy,
  defineStrategy,
  encodeStrategyDefinition,
  normalizeStrategyDefinition,
  sealStrategyCatalog,
  type StrategyAuthoringDefinitionV1,
  validateStrategyCatalog,
} from "../src/index.ts";
import { ROUTE_CYCLE_STRATEGY } from "../../../strategies/route-cycle/src/index.ts";

const hash = (domain: string, value: unknown): Hash => hashDomain(domain, value);

function qualifiedRefs(): readonly CapabilityRefV1[] {
  return Object.freeze(ROUTE_CYCLE_STRATEGY.requiredCapabilityPredicates.map(predicate => Object.freeze({
    capabilityId: predicate.capabilityId,
    version: predicate.minimumVersion,
    schemaHash: asSchemaRef(predicate.schemaRefs[0]!),
    interpreterHash: hash("test/strategy-interpreter/v1", predicate.capabilityId),
    ownerRef: asOwnerRef(hash("test/strategy-owner/v1", predicate.capabilityId)),
  })));
}

test("strategy authoring is protocol-neutral and canonical", () => {
  const normalized = defineStrategy({
    ...ROUTE_CYCLE_STRATEGY,
    requiredCapabilityPredicates: [...ROUTE_CYCLE_STRATEGY.requiredCapabilityPredicates].reverse(),
  });
  assert.deepEqual(normalized.requiredCapabilityPredicates, ROUTE_CYCLE_STRATEGY.requiredCapabilityPredicates);
  assert.equal(encodeStrategyDefinition(normalized), encodeStrategyDefinition(ROUTE_CYCLE_STRATEGY));
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.planningTemplate), true);
});

test("compiler resolves only qualified capability refs and emits data-only leaf", () => {
  const result = compileStrategy(ROUTE_CYCLE_STRATEGY, qualifiedRefs());
  assert.equal(result.entry.strategyId, "route-cycle");
  assert.equal(result.entry.planningTemplate.kind, "closed-loop-template");
  assert.equal(result.entry.requiredCapabilityRefs.length, 0);
  assert.equal(Object.values(result.entry).some(value => typeof value === "function"), false);
  validateStrategyCatalog(sealStrategyCatalog([result.entry]));
});

test("planning-template mutation changes only the Strategy leaf closure", () => {
  const before = compileStrategy(ROUTE_CYCLE_STRATEGY, []).entry;
  const after = compileStrategy(defineStrategy({
    ...ROUTE_CYCLE_STRATEGY,
    planningTemplate: { ...ROUTE_CYCLE_STRATEGY.planningTemplate, maxLegs: "5" },
  }), []).entry;
  assert.notEqual(before.strategyDefinitionHash, after.strategyDefinitionHash);
  assert.equal(before.requestedCapabilityDependencyRoot, after.requestedCapabilityDependencyRoot);
  assert.notEqual(before.definitionCatalogLeafDigest, after.definitionCatalogLeafDigest);
});

test("adding an unrelated future strategy changes catalog root, not an existing strategy leaf", () => {
  const existing = compileStrategy(ROUTE_CYCLE_STRATEGY, qualifiedRefs()).entry;
  const future = compileStrategy(defineStrategy({
    ...ROUTE_CYCLE_STRATEGY,
    strategyId: "future-independent",
    pluginCodeHash: hash("test/future-strategy-code/v1", "future-independent"),
    modulePath: "strategies/future-independent/src/index.ts",
    exportName: "FUTURE_INDEPENDENT_STRATEGY",
    planningProblemIssuer: {
      ...ROUTE_CYCLE_STRATEGY.planningProblemIssuer,
      modulePath: "strategies/future-independent/src/index.ts",
      exportName: "FUTURE_INDEPENDENT_PLANNING_PROBLEM_ISSUER",
      ownerRef: asOwnerRef(hash("test/future-issuer/v1", "future-independent")),
    },
  }), qualifiedRefs()).entry;
  const before = sealStrategyCatalog([existing]);
  const after = sealStrategyCatalog([existing, future]);
  assert.equal(after.entries.find(entry => entry.strategyId === existing.strategyId)?.definitionCatalogLeafDigest, existing.definitionCatalogLeafDigest);
  assert.notEqual(after.strategyCatalogRoot, before.strategyCatalogRoot);
});

test("strategy compiler rejects absent or non-exact capability versions", () => {
  const capabilityId = asCapabilityId("generic-state-read");
  const schemaRef = asSchemaRef(hash("test/strategy-schema/v1", capabilityId));
  const definition = defineStrategy({
    ...ROUTE_CYCLE_STRATEGY,
    requiredCapabilityPredicates: [{ capabilityId, minimumVersion: asCapabilityVersion("1.0.0"), schemaRefs: [schemaRef] }],
  });
  assert.throws(() => compileStrategy(definition, []), /missing capability ref/);
  const ref: CapabilityRefV1 = Object.freeze({
    capabilityId,
    version: asCapabilityVersion("1.0.1"),
    schemaHash: schemaRef,
    interpreterHash: hash("test/strategy-interpreter/v1", capabilityId),
    ownerRef: asOwnerRef(hash("test/strategy-owner/v1", capabilityId)),
  });
  assert.throws(() => compileStrategy(definition, [ref]), /exactly satisfy/);
});

test("planning template rejects fixture assets and invalid bounds", () => {
  const definition = structuredClone(ROUTE_CYCLE_STRATEGY) as unknown as StrategyAuthoringDefinitionV1;
  assert.throws(() => normalizeStrategyDefinition({
    ...definition,
    planningTemplate: { ...definition.planningTemplate, minLegs: "5", maxLegs: "4" },
  }), /invalid closed-loop planning leg bounds/);
  assert.throws(() => normalizeStrategyDefinition({
    ...definition,
    planningTemplate: { ...definition.planningTemplate, entryAssetRef: hash("test/fixture-asset/v1", "x") } as never,
  }), /non-exact keys/);
  assert.throws(() => normalizeStrategyDefinition({
    ...definition,
    planningTemplate: { ...definition.planningTemplate, objectiveRef: hash("test/legacy-objective/v1", "x") } as never,
  }), /non-exact keys/);
});

test("catalog rejects forged leaf and duplicate strategy id", () => {
  const entry = compileStrategy(ROUTE_CYCLE_STRATEGY, qualifiedRefs()).entry;
  assert.throws(() => sealStrategyCatalog([{ ...entry, implementationClosureRoot: hash("test/forged/v1", "x") }]), /leaf digest mismatch/);
  assert.throws(() => sealStrategyCatalog([entry, entry]), /duplicate strategy id/);
});

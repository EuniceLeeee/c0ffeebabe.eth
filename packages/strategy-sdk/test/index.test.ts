import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
  assert.equal(Object.isFrozen(normalized.loopIntent), true);
});

test("compiler resolves only qualified capability refs and emits data-only leaf", () => {
  const result = compileStrategy(ROUTE_CYCLE_STRATEGY, qualifiedRefs());
  assert.equal(result.entry.strategyId, "route-cycle");
  assert.equal(result.entry.loopIntent.kind, "closed-loop");
  assert.equal(result.entry.requiredCapabilityRefs.length, 2);
  assert.equal(result.entry.requiredCapabilityRefs.some(ref => ref.capabilityId === "graph-transition"), true);
  assert.equal(Object.values(result.entry).some(value => typeof value === "function"), false);
  validateStrategyCatalog(sealStrategyCatalog([result.entry]));
});

test("capability mutation changes only the strategy dependency/leaf closure", () => {
  const refs = [...qualifiedRefs()];
  const before = compileStrategy(ROUTE_CYCLE_STRATEGY, refs).entry;
  refs[0] = Object.freeze({ ...refs[0]!, interpreterHash: hash("test/changed-interpreter/v1", refs[0]!.capabilityId) });
  const after = compileStrategy(ROUTE_CYCLE_STRATEGY, refs).entry;
  assert.notEqual(before.strategyDefinitionHash, after.strategyDefinitionHash);
  assert.notEqual(before.requestedCapabilityDependencyRoot, after.requestedCapabilityDependencyRoot);
  assert.notEqual(before.definitionCatalogLeafDigest, after.definitionCatalogLeafDigest);
  assert.equal(before.loopIntent.entryAssetRef, after.loopIntent.entryAssetRef);
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
      exportName: "FUTURE_INDEPENDENT_STRATEGY",
      ownerRef: asOwnerRef(hash("test/future-issuer/v1", "future-independent")),
    },
  }), qualifiedRefs()).entry;
  const before = sealStrategyCatalog([existing]);
  const after = sealStrategyCatalog([existing, future]);
  assert.equal(after.entries.find(entry => entry.strategyId === existing.strategyId)?.definitionCatalogLeafDigest, existing.definitionCatalogLeafDigest);
  assert.notEqual(after.strategyCatalogRoot, before.strategyCatalogRoot);
});

test("strategy compiler rejects absent or non-exact capability versions", () => {
  const refs = qualifiedRefs();
  assert.throws(() => compileStrategy(ROUTE_CYCLE_STRATEGY, refs.slice(1)), /missing capability ref/);
  const changed = refs.map(ref => ref.capabilityId === "graph-transition"
    ? { ...ref, version: "1.0.1" as typeof ref.version }
    : ref);
  assert.throws(() => compileStrategy(ROUTE_CYCLE_STRATEGY, changed), /exactly satisfy/);
});

test("every per-leg capability predicate is an exact subset of the top-level closure", () => {
  const definition = structuredClone(ROUTE_CYCLE_STRATEGY) as unknown as StrategyAuthoringDefinitionV1;
  const firstLeg = definition.loopIntent.legs[0]!;
  assert.throws(() => normalizeStrategyDefinition({
    ...definition,
    loopIntent: {
      ...definition.loopIntent,
      legs: [{
        ...firstLeg,
        requiredCapabilityPredicates: [{
          ...firstLeg.requiredCapabilityPredicates[0]!,
          minimumVersion: asCapabilityVersion("2.0.0"),
        }],
      }, ...definition.loopIntent.legs.slice(1)],
    },
  }), /exactly match a top-level declaration/);
});

test("catalog rejects forged leaf and duplicate strategy id", () => {
  const entry = compileStrategy(ROUTE_CYCLE_STRATEGY, qualifiedRefs()).entry;
  assert.throws(() => sealStrategyCatalog([{ ...entry, implementationClosureRoot: hash("test/forged/v1", "x") }]), /leaf digest mismatch/);
  assert.throws(() => sealStrategyCatalog([entry, entry]), /duplicate strategy id/);
});

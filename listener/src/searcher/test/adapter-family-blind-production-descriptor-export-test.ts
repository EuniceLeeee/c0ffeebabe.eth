import assert from "node:assert/strict";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  createVerifiedGraphView,
} from "../venues/blockscan-state-capability.js";
import { PRODUCTION_ADAPTER_FAMILIES } from
  "../venues/production-registry.js";
import {
  buildProductionBlindHistoricalPrewarmPlan,
  exportProductionBlindRequirements,
  type BlindProductionDescriptorRegistry,
} from "./adapter-family-blind-production-descriptor-export.js";

const TOKEN0 = "0x0000000000000000000000000000000000000001";
const TOKEN1 = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000011";
const sourceHash = `0x${"11".repeat(32)}`;
const graph = createVerifiedGraphView({
  id: "full-production-fixture",
  generation: 7,
  sourceBlock: 100,
  sourceBlockHash: sourceHash,
  completenessWatermark: 100,
  perSourceCoverage: [{
    familyId: "univ2-standard",
    sourceId: "fixture-full-source",
    sourceFingerprint: "fixture-full-source-v1",
    completeThroughBlock: 100,
    completeThroughHash: sourceHash,
  }],
  edges: [
    {
      adapterId: "univ2-swap",
      target: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
      v2FeeBps: 30n,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
    },
    {
      adapterId: "univ2-swap",
      target: POOL,
      tokenIn: TOKEN1,
      tokenOut: TOKEN0,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
      v2FeeBps: 30n,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
    },
  ],
  familyIdForEdge: () => "univ2-standard",
});
const activeFamilyIds = PRODUCTION_ADAPTER_FAMILIES.list()
  .map((family) => family.id);

const exported = exportProductionBlindRequirements({
  graph,
  activeFamilyIds,
  fundingAssets: [TOKEN0, TOKEN1],
});
assert.equal(exported.graphViewSha256.length, 64);
assert.equal(exported.activeFamilySetSha256.length, 64);
assert.equal(exported.fundingAssetSetSha256.length, 64);
assert.equal(exported.requirementSetSha256.length, 64);
for (const domain of [
  "graphState",
  "funding",
  "executionDependencies",
  "finalSimulation",
] as const) {
  assert(
    exported.requirements.some((requirement) =>
      requirement.domain === domain
    ),
    `missing derived ${domain} requirement`,
  );
}
assert(
  exported.requirements
    .filter((requirement) => requirement.domain === "finalSimulation")
    .every((requirement) => requirement.support.status === "unsupported"),
  "final-sim must remain explicitly unsupported until a real exporter exists",
);

assert.throws(
  () => exportProductionBlindRequirements({
    graph,
    activeFamilyIds: activeFamilyIds.slice(1),
    fundingAssets: [TOKEN0],
  }),
  /not the full production registry/,
  "a caller cannot shrink the active family set",
);

const missingPricingFamilyRegistry: BlindProductionDescriptorRegistry = {
  list: () => PRODUCTION_ADAPTER_FAMILIES.list(),
  routes: () => PRODUCTION_ADAPTER_FAMILIES.routes(),
  blockScanStateFamilies: () =>
    PRODUCTION_ADAPTER_FAMILIES.blockScanStateFamilies().filter(
      (family) => family.familyId !== "univ2-standard",
    ),
  fundingStateFamilies: () =>
    PRODUCTION_ADAPTER_FAMILIES.fundingStateFamilies(),
  isBlockScanPricedEdge: (edge) =>
    PRODUCTION_ADAPTER_FAMILIES.isBlockScanPricedEdge(edge),
};
assert.throws(
  () => exportProductionBlindRequirements({
    graph,
    activeFamilyIds,
    fundingAssets: [TOKEN0],
    registry: missingPricingFamilyRegistry,
  }),
  /has 0 active pricing owners/,
  "a registered graph family cannot be omitted from descriptor export",
);

assert.throws(
  () => buildProductionBlindHistoricalPrewarmPlan({
    base: {
      number: 99,
      hash: `0x${"22".repeat(32)}`,
      stateRoot: `0x${"33".repeat(32)}`,
    },
    source: {
      number: 100,
      hash: `0x${"55".repeat(32)}`,
      stateRoot: `0x${"44".repeat(32)}`,
    },
    inputs: {
      resolvedConfigSha256: hash("config"),
      universeSha256: hash("universe"),
      activeFamilyManifestSha256: hash("families"),
      baseGraphViewSha256: hash("base-graph"),
    },
    exporter: {
      implementationSha256: hash("exporter"),
      sourceClosureSha256: hash("exporter-closure"),
      requirementSetSha256: exported.requirementSetSha256,
    },
    graph,
    activeFamilyIds,
    fundingAssets: [TOKEN0, TOKEN1],
    materializations: [],
  }),
  /GraphView is not pinned to the source anchor/,
  "an unrelated GraphView cannot authorize a prewarm plan",
);

assert.throws(
  () => buildProductionBlindHistoricalPrewarmPlan({
    base: {
      number: 99,
      hash: `0x${"22".repeat(32)}`,
      stateRoot: `0x${"33".repeat(32)}`,
    },
    source: {
      number: 100,
      hash: sourceHash,
      stateRoot: `0x${"44".repeat(32)}`,
    },
    inputs: {
      resolvedConfigSha256: hash("config"),
      universeSha256: hash("universe"),
      activeFamilyManifestSha256: hash("families"),
      baseGraphViewSha256: hash("base-graph"),
    },
    exporter: {
      implementationSha256: hash("exporter"),
      sourceClosureSha256: hash("exporter-closure"),
      requirementSetSha256: exported.requirementSetSha256,
    },
    graph,
    activeFamilyIds,
    fundingAssets: [TOKEN0, TOKEN1],
    materializations: [],
  }),
  /unsupported production dependencies:.*finalSimulation/,
  "strict production prewarm must fail instead of pretending final-sim coverage",
);

console.log("adapter family blind production descriptor export: ok");

function hash(value: string): string {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}

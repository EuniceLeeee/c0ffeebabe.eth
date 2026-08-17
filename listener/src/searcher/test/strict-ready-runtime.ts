import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveStrictReadyRuntime } from "../strict-ready-runtime.js";
import { assertProducerGenerationPublicationAllowed } from
  "../producer-generation-freeze.js";
import {
  hashReadyCatalogSnapshot,
  hashReadyGraphSnapshot,
} from "../universe-rebuild-runner.js";
import type { ReadyUniverseGeneration } from
  "../universe-rebuild-checkpoint.js";

const SOURCE = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 7,
});

function ready(): ReadyUniverseGeneration {
  const graphSnapshot = Object.freeze({
    format: "strict-rebuild-graph-v1",
    edges: Object.freeze([Object.freeze({
      canonicalEdgeId: "edge:strict:1",
      instanceKey: "instance:1",
      adapterId: "univ2-swap",
      target: "0x" + "11".repeat(20),
      tokenIn: "0x" + "22".repeat(20),
      tokenOut: "0x" + "33".repeat(20),
      slotKind: "swap",
      score: 0,
    })]),
  });
  const catalogSnapshot = Object.freeze({
    format: "strict-rebuild-catalog-v1",
    instances: Object.freeze([Object.freeze({
      familyInstanceKey: "family-instance:1",
    })]),
  });
  return Object.freeze({
    generation: 1,
    cutoff: SOURCE,
    universeRange: Object.freeze({
      fromBlock: SOURCE.number - 14_399,
      toBlock: SOURCE.number,
    }),
    universeHash: "u",
    catalogHash: hashReadyCatalogSnapshot(catalogSnapshot),
    activeInstanceKeys: Object.freeze(["family-instance:1"]),
    publicationSetHash: "p",
    observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    appliedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    sourceCoverage: Object.freeze([Object.freeze({
      familyId: "univ2-standard",
      sourceId: "startup-universe",
      completeThroughBlock: SOURCE.number,
      completeThroughHash: SOURCE.hash,
    })]),
    graphSnapshot,
    graphHash: hashReadyGraphSnapshot(graphSnapshot),
    catalogSnapshot,
  });
}

assert.throws(
  () => resolveStrictReadyRuntime(null),
  /requires a committed readyGeneration/,
  "no ready generation must fail closed",
);
const resolved = resolveStrictReadyRuntime(ready());
assert.equal(resolved.graph.length, 1);
assert.equal(resolved.graph[0]?.canonicalEdgeId, "edge:strict:1");
assert.throws(
  () => resolveStrictReadyRuntime(Object.freeze({
    ...ready(),
    graphHash: "tampered",
  })),
  /root mismatch/,
  "Graph content/root mismatch must fail closed",
);
assert.throws(
  () => resolveStrictReadyRuntime(Object.freeze({
    ...ready(),
    appliedThrough: Object.freeze({
      number: SOURCE.number - 1,
      hash: SOURCE.hash,
    }),
  })),
  /applied cursor/,
  "cursor cannot advance ready before the exact cutoff",
);
assert.throws(
  () => assertProducerGenerationPublicationAllowed(true),
  /producer generation freeze/,
  "producer-time discovery/topology publication must be impossible",
);
assert.doesNotThrow(() =>
  assertProducerGenerationPublicationAllowed(false)
);

const mainSource = await readFile(new URL("../main.ts", import.meta.url), "utf8");
for (const forbidden of [
  "buildTokenGraphWithResults",
  "POOL_REGISTRY",
  "active-pool-discovery",
  "strict edges merged into runtime graph",
  "strict startup edges merged into runtime graph",
  "runStrictLivePublicationChain",
  "scanActivePoolsDetailed",
  "indexFactoryPools",
  "createDurableDiscoveryContinuityComposition",
  "CheckpointDiscoveryInventoryEnumerator",
  "publishStrictCatalogFromLifecycle",
  "setProductionStrictViewsProvider",
  "SEARCHER_STRICT_CATALOG_CONSUMER",
  "SEARCHER_STRICT_SOLVER_CONSUMER",
  "AdapterFamilyGraphViewCoordinator",
  "ProtocolDiscoveryCoverageCoordinator",
  "createDexGraphCoverageState",
  "protocolDiscoverySourceFingerprints",
  "new AdapterRuntimeCoordinator(",
  "new BlockScanStateCoordinator(",
  "live-discovery-coordinator",
]) {
  assert.equal(
    mainSource.includes(forbidden),
    false,
    "production main must not retain old/continuous Graph authority: " + forbidden,
  );
}
assert(mainSource.includes("resolveStrictReadyRuntime(readyUniverse)"));
assert(mainSource.includes("new StrictProductionRuntimeRoot({"));
assert(mainSource.includes("new StrictReadyGraphViewCoordinator({"));
assert(mainSource.includes("new StrictCurrentRuntimeCoordinator("));
assert(mainSource.includes("frozenTopology: frozenProducerTopology"));
assert(mainSource.includes("for (const edge of graph)"));

console.log("strict ready runtime PASS");

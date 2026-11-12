import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveStrictReadyRuntime } from "../strict-ready-runtime.js";
import { assertProducerGenerationPublicationAllowed } from
  "../producer-generation-freeze.js";
import {
  hashReadyCatalogSnapshot,
  hashReadyGraphSnapshot,
  hashReadyPublicationSet,
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
    publicationSetHash: hashReadyPublicationSet(catalogSnapshot),
    candidateAccounting: Object.freeze({
      total: 1,
      verified: 1,
      terminalRejected: 0,
      retryable: 0,
      remainingUnaccounted: 0 as const,
    }),
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
    publicationSetHash: "tampered",
  })),
  /root mismatch/,
  "publication-set content/root mismatch must fail closed",
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

// Complete scope removal may publish an explicitly empty Ready. It must not
// make a missing source-coverage record acceptable for any nonempty runtime.
const emptyGraph = Object.freeze({ format: "strict-rebuild-graph-v1", edges: Object.freeze([]) });
const emptyCatalog = Object.freeze({ format: "strict-rebuild-catalog-v1", instances: Object.freeze([]) });
const emptyReady: ReadyUniverseGeneration = Object.freeze({
  ...ready(),
  familyPartitions: Object.freeze({}),
  sourceCoverage: Object.freeze([]),
  activeInstanceKeys: Object.freeze([]),
  candidateAccounting: Object.freeze({ total: 0, verified: 0, terminalRejected: 0, retryable: 0,
    remainingUnaccounted: 0 as const }),
  graphSnapshot: emptyGraph,
  graphHash: hashReadyGraphSnapshot(emptyGraph),
  catalogSnapshot: emptyCatalog,
  catalogHash: hashReadyCatalogSnapshot(emptyCatalog),
  publicationSetHash: hashReadyPublicationSet(emptyCatalog),
});
assert.deepEqual(resolveStrictReadyRuntime(emptyReady).graph, []);
const disabledPartition = {
  enabled: false, candidatesByKey: {}, outcomesByCandidateKey: {}, candidateSetHash: "empty",
  discoveryDefinitionHash: "historical", sourceReceipts: [],
};
assert.deepEqual(resolveStrictReadyRuntime({ ...emptyReady,
  familyPartitions: { removed: disabledPartition } }).graph, [], "disabled history is outside the current scope");
for (const mutation of [
  { familyPartitions: undefined },
  { familyPartitions: { active: { ...disabledPartition, enabled: true } } },
  { familyUpdateScope: { parentCheckpointFingerprint: "parent", familyIds: ["active"] } },
  { activeInstanceKeys: ["unpublished-active-memo"] },
  { candidateAccounting: { ...emptyReady.candidateAccounting, total: 1, retryable: 1 } },
  { candidateAccounting: { ...emptyReady.candidateAccounting, verified: 1 } },
  { candidateAccounting: { ...emptyReady.candidateAccounting, terminalRejected: 1 } },
  { candidateAccounting: { ...emptyReady.candidateAccounting, covered: 1 } },
  { candidateAccounting: { ...emptyReady.candidateAccounting, activationExcluded: 1 } },
  { graphSnapshot: ready().graphSnapshot, graphHash: ready().graphHash },
  { catalogSnapshot: ready().catalogSnapshot, catalogHash: ready().catalogHash,
    publicationSetHash: ready().publicationSetHash },
  { observedThrough: { ...emptyReady.observedThrough, number: SOURCE.number - 1 } },
]) assert.throws(() => resolveStrictReadyRuntime({ ...emptyReady, ...mutation }), /source coverage is incomplete/,
  "only an explicit, internally empty scope may have no source coverage");
assert.throws(() => resolveStrictReadyRuntime({ ...emptyReady, graphHash: "tampered" }), /root mismatch/,
  "empty publications still require their exact original roots");

const mainSource = await readFile(new URL("../main.ts", import.meta.url), "utf8");
for (const forbidden of [
  "buildTokenGraphWithResults",
  "POOL_REGISTRY",
  "active-pool-discovery",
  "venues/production-registry",
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

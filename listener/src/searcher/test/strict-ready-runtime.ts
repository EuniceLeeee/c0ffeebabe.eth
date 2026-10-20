import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertReadyCheckpointPublicationCurrent,
  resolveStrictReadyRuntime,
} from "../strict-ready-runtime.js";
import { assertProducerGenerationPublicationAllowed } from
  "../producer-generation-freeze.js";
import {
  hashReadyCatalogSnapshot,
  hashReadyGraphSnapshot,
  hashReadyPublicationSet,
} from "../universe-rebuild-runner.js";
import {
  buildReadyCatalogSnapshot,
  durableVerifiedMemoFingerprint,
  type DurableRetryableQueueEntry,
  type DurableVerifiedMemo,
  type ReadyUniverseGeneration,
  type StartupCheckpointEnvelope,
} from "../universe-rebuild-checkpoint.js";

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

function memo(key: string, familyId = "univ2-standard"): DurableVerifiedMemo {
  const value: DurableVerifiedMemo = {
    familyCandidateKey: key, familyInstanceKey: `instance:${key}`,
    familyId, candidateKey: key, instanceKey: key,
    candidateFingerprint: key, familyDefinitionHash: "definition",
    validity: { policy: "immutable-code", authorityFingerprint: "authority", proofSource: SOURCE },
    verifiedIdentity: { key }, compiledDescriptor: { key }, staticProjection: { key },
    evidenceFingerprint: key, candidateSnapshot: { key, familyId }, memoFingerprint: "",
  };
  return { ...value, memoFingerprint: durableVerifiedMemoFingerprint(value) };
}

function checkpoint(published: readonly DurableVerifiedMemo[]): StartupCheckpointEnvelope {
  const catalogSnapshot = buildReadyCatalogSnapshot(published);
  return {
    revision: 1,
    verifiedMemos: Object.fromEntries(published.map(value => [value.familyCandidateKey, value])),
    inProgressRun: null, retryableAttemptsByCandidateKey: {}, checkpointFingerprint: "fixture",
    readyGeneration: {
      ...ready(), catalogSnapshot,
      activeInstanceKeys: published.map(value => value.familyInstanceKey),
      catalogHash: hashReadyCatalogSnapshot(catalogSnapshot),
      publicationSetHash: hashReadyPublicationSet(catalogSnapshot),
      candidateAccounting: { total: published.length + 1, verified: published.length,
        terminalRejected: 0, retryable: 1, remainingUnaccounted: 0 },
    },
  };
}

function queued(value: DurableVerifiedMemo): DurableRetryableQueueEntry {
  return { status: "retryable", familyCandidateKey: value.familyCandidateKey,
    familyId: value.familyId, candidateSnapshot: value.candidateSnapshot,
    stage: "identity", failureCode: "rpc", reasonCode: "transient",
    attemptCount: 2, lastAttemptAt: "2026-10-08T00:00:00Z", runId: "completed-run", cutoff: SOURCE };
}

const oldMemo = memo("old");
const newMemo = memo("new");
const original = checkpoint([oldMemo]);
const retry = queued(newMemo);
const withRetry = { ...original, revision: 9,
  retryableAttemptsByCandidateKey: { new: retry } };
assert.doesNotThrow(() => assertReadyCheckpointPublicationCurrent(withRetry),
  "remaining retryables and changed attempt counters do not require republishing Graph");

// Independent probe success: the run is already complete, but the old Graph
// and its hashes are still valid. The admission comparison must catch it.
const afterProbe: StartupCheckpointEnvelope = { ...original, revision: 10,
  verifiedMemos: { old: oldMemo, new: newMemo } };
assert.equal(afterProbe.inProgressRun, null);
assert.doesNotThrow(() => resolveStrictReadyRuntime(afterProbe.readyGeneration));
assert.throws(() => assertReadyCheckpointPublicationCurrent(afterProbe), /added=1 removed=0 changed=0/);
assert.doesNotThrow(() => assertReadyCheckpointPublicationCurrent(checkpoint([oldMemo, newMemo])),
  "republishing the new admitted set restores synchronization");

const changedMemo = { ...oldMemo, evidenceFingerprint: "replacement-proof" };
changedMemo.memoFingerprint = durableVerifiedMemoFingerprint(changedMemo);
assert.throws(() => assertReadyCheckpointPublicationCurrent({ ...original,
  verifiedMemos: { old: changedMemo } }), /added=0 removed=0 changed=1/,
  "same count and instance key cannot hide changed evidence");
assert.throws(() => assertReadyCheckpointPublicationCurrent({ ...original,
  verifiedMemos: {} }), /added=0 removed=1 changed=0/,
  "revoked admission cannot keep using its published edge");
const historicalAlias = { ...memo("alias"),
  familyInstanceKey: oldMemo.familyInstanceKey, instanceKey: oldMemo.instanceKey };
historicalAlias.memoFingerprint = durableVerifiedMemoFingerprint(historicalAlias);
assert.doesNotThrow(() => assertReadyCheckpointPublicationCurrent({ ...original,
  verifiedMemos: { old: oldMemo, alias: historicalAlias } }),
  "a non-selected historical candidate alias does not add a Graph instance");
assert.throws(() => assertReadyCheckpointPublicationCurrent({ ...original,
  verifiedMemos: { alias: historicalAlias } }), /removed=1/,
  "an alias cannot hide revocation of the catalog-selected proof");

const retainedOldProof = { ...withRetry, verifiedMemos: { old: oldMemo, new: newMemo } };
assert.doesNotThrow(() => assertReadyCheckpointPublicationCurrent(retainedOldProof),
  "a retained historical memo with an unresolved retry is not a newly admitted instance");
const run: NonNullable<StartupCheckpointEnvelope["inProgressRun"]> = {
  runId: "retry-run", cutoff: SOURCE, fromBlock: SOURCE.number,
  universeHash: "fixture", candidateSetHash: "fixture", candidateCount: 1,
  candidatesByKey: { new: newMemo.candidateSnapshot }, sourceReceipts: [],
  observedThrough: SOURCE, appliedThrough: null, outcomesByCandidateKey: {},
};
assert.doesNotThrow(() => assertReadyCheckpointPublicationCurrent({ ...withRetry, inProgressRun: run }),
  "run presence is not a substitute for an admission-set comparison");
assert.throws(() => assertReadyCheckpointPublicationCurrent({ ...retainedOldProof,
  inProgressRun: { ...run, outcomesByCandidateKey: { new: {
    status: "verified", familyCandidateKey: "new", familyInstanceKey: newMemo.familyInstanceKey,
    memoFingerprint: newMemo.memoFingerprint,
  } } } }), /added=1/,
  "current verified outcome takes precedence over the queue awaiting promotion cleanup");
assert.throws(() => assertReadyCheckpointPublicationCurrent({ ...original,
  inProgressRun: { ...run, outcomesByCandidateKey: { old: queued(oldMemo) } } }), /changed=1/,
  "new non-verified outcome cannot leave an old published admission usable");

const disabledMemo = memo("disabled", "fixture-disabled");
assert.doesNotThrow(() => assertReadyCheckpointPublicationCurrent({ ...original,
  verifiedMemos: { old: oldMemo, disabled: disabledMemo },
  readyGeneration: { ...original.readyGeneration!, familyPartitions: {
    "fixture-disabled": { enabled: false, candidatesByKey: {}, candidateSetHash: "fixture",
      discoveryDefinitionHash: "fixture", outcomesByCandidateKey: {}, sourceReceipts: [] },
  } },
}), "explicitly disabled Family evidence is not an unpublished active instance");
// Proof-only inheritance may retain installed disabled Families without a
// Ready partition. The full production activation map is the current authority.
const installedActivation = new Map<string, boolean>([
  ["univ2-standard", true], ["fixture-disabled", false],
]);
const activation = (familyId: string) => installedActivation.get(familyId);
const inheritedDisabled = { ...original,
  verifiedMemos: { old: oldMemo, disabled: disabledMemo } };
assert.doesNotThrow(() => assertReadyCheckpointPublicationCurrent(inheritedDisabled, activation));
assert.throws(() => assertReadyCheckpointPublicationCurrent(inheritedDisabled), /added=1/,
  "no current activation view cannot silently exclude an unpublished proof");
const historicallyDisabled = { ...inheritedDisabled, readyGeneration: {
  ...original.readyGeneration!, familyPartitions: {
    "fixture-disabled": { enabled: false, candidatesByKey: {}, candidateSetHash: "fixture",
      discoveryDefinitionHash: "fixture", outcomesByCandidateKey: {}, sourceReceipts: [] },
  },
} };
installedActivation.set("fixture-disabled", true);
assert.throws(() => assertReadyCheckpointPublicationCurrent(historicallyDisabled, activation), /added=1/,
  "newly enabled Family cannot inherit an old disabled-partition exemption");
installedActivation.delete("fixture-disabled");
assert.throws(() => assertReadyCheckpointPublicationCurrent(historicallyDisabled, activation), /added=1/,
  "unknown Family remains strict even with an old disabled partition");
assert.throws(() => assertReadyCheckpointPublicationCurrent(inheritedDisabled, activation), /added=1/,
  "unknown unpartitioned Family is not implicitly disabled");
installedActivation.set("fixture-disabled", false);
const publishedDisabled = checkpoint([disabledMemo]);
assert.throws(() => assertReadyCheckpointPublicationCurrent({ ...publishedDisabled,
  verifiedMemos: {} }, activation), /removed=1/,
  "current disablement cannot hide a missing published proof");
assert.throws(() => assertReadyCheckpointPublicationCurrent({ ...publishedDisabled,
  verifiedMemos: { disabled: { ...disabledMemo, memoFingerprint: "changed" } } }, activation), /changed=1/,
  "current disablement cannot hide replacement of a published proof");
assert.throws(() => assertReadyCheckpointPublicationCurrent(afterProbe, activation), /added=1/,
  "an enabled Family probe success still requires republishing");

const fundingMemo = memo("funding", "fixture-funding");
assert.throws(() => assertReadyCheckpointPublicationCurrent({ ...original,
  verifiedMemos: { old: oldMemo, funding: fundingMemo } }), /added=1/,
  "Funding is compared through the Ready catalog, not required to have a swap edge");

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
assert.equal(mainSource.split("assertReadyCheckpointPublicationCurrent(rebuildEnvelope, familyId => readyPublicationActivation.get(familyId))").length - 1, 2,
  "check reused Ready before refresh and the final checkpoint before runtime creation");
assert(mainSource.includes("new Map<string, boolean>(PRODUCTION_FAMILY_ACTIVATIONS"));
assert(mainSource.includes("assertReadyFamilyActivation(activeReadyMemos, rebuildWiring.isFamilyEnabled)"));
assert(mainSource.includes("new StrictProductionRuntimeRoot({"));
assert(mainSource.includes("new StrictReadyGraphViewCoordinator({"));
assert(mainSource.includes("new StrictCurrentRuntimeCoordinator("));
assert(mainSource.includes("frozenTopology: frozenProducerTopology"));
assert(mainSource.includes("for (const edge of graph)"));

console.log("strict ready runtime PASS");

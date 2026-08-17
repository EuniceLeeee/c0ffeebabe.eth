import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AdapterRuntimeSnapshot } from "../adapter-runtime-coordinator.js";
import { FlashFundingSnapshot } from "../adapter-runtime-coordinator.js";
import {
  pinProviderCallsToBlock,
} from "../pool-discovery-read-backend.js";
import {
  POOL_UNIVERSE_BUILD_MANIFEST_PROFILE,
} from "../pool-universe.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  blockScanEdgeKey,
  blockScanStateKey,
  createVerifiedGraphView,
  deterministicHash,
  exactSetHash,
  type PublishedFamilyStateValue,
  type StateFreshnessProof,
} from "../venues/blockscan-state-capability.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";
import {
  BLIND_SCHEMA_VERSION,
  sha256Canonical,
  type ConversionCandidate,
} from "./adapter-family-blind-contract.js";
import {
  buildConversionFreshnessPlan,
  CONVERSION_REVEAL_PROFILE,
  type ConversionFreshnessCandidateEvidence,
  type ConversionFreshnessReveal,
} from "./conversion-freshness-oracle.js";
import {
  captureConversionProductionEvidence,
  compareConversionProductionEvidence,
  conversionProductionDeliveryId,
  conversionProductionGraphArtifactSha256,
  conversionRuntimeWithTargetMidsRestored,
  conversionProductionScannerConfigSha256,
  type ConversionProductionExpectation,
} from "./conversion-freshness-production-evidence.js";
import {
  freezeConversionProductionInputs,
  resolveConversionProductionFullConfig,
  validateConversionProductionInputs,
} from "./conversion-freshness-production-full-live.js";
import {
  productionUniverseRegistrySourceFingerprints,
  validateConversionUniverseBuildManifest,
} from "./conversion-freshness-universe-manifest.js";
import { wstethFreshnessPrivatePredicate } from
  "./fixtures/conversion-freshness-wsteth.js";

const attemptNonce = "ab".repeat(32);
const baseBlock = 1_000;
const sourceBlock = 1_001;
const baseHash = `0x${"11".repeat(32)}`;
const sourceHash = `0x${"22".repeat(32)}`;
const protocolTarget = "0x00000000000000000000000000000000000000a1";
const swapTarget = "0x00000000000000000000000000000000000000b2";
const tokenA = "0x00000000000000000000000000000000000000c3";
const tokenB = "0x00000000000000000000000000000000000000d4";
const unit = 10n ** 18n;
const rawEdges: readonly TokenEdge[] = [
  {
    adapterId: "wsteth-wrap",
    target: protocolTarget,
    tokenIn: tokenA,
    tokenOut: tokenB,
    slotKind: "protocol",
    protocolAction: "wrap",
    ...deriveEdgeTaxonomy("protocol", "wrap"),
  },
  {
    adapterId: "univ2-swap",
    target: swapTarget,
    tokenIn: tokenB,
    tokenOut: tokenA,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
  },
];

const targetStateKey = blockScanStateKey(
  "protocol:wsteth",
  protocolTarget.toLowerCase(),
);
const base = runtime(baseBlock, baseHash, 1, 0.8);
const source = runtime(sourceBlock, sourceHash, 2, 0.9);
const protocolEdgeKey = blockScanEdgeKey(base.graph.edges[0]);
const swapEdgeKey = blockScanEdgeKey(base.graph.edges[1]);
const reveal = selectedReveal();
const graphArtifactSha256 = conversionProductionGraphArtifactSha256(base);
assert.throws(
  () => captureConversionProductionEvidence({
    delivery: {
      attemptNonce,
      baseDeliveryId: "00".repeat(32),
      sourceDeliveryId: conversionProductionDeliveryId({
        attemptNonce,
        phase: "source",
        blockHash: sourceHash,
      }),
      graphScope: "production-full",
      graphArtifactSha256,
    },
    base,
    source,
    scannerConfig: scannerConfig(),
  }),
  /base delivery is not bound/,
);
const sealed = captureConversionProductionEvidence({
  delivery: {
    attemptNonce,
    baseDeliveryId: conversionProductionDeliveryId({
      attemptNonce,
      phase: "base",
      blockHash: baseHash,
    }),
    sourceDeliveryId: conversionProductionDeliveryId({
      attemptNonce,
      phase: "source",
      blockHash: sourceHash,
    }),
    graphScope: "production-full",
    graphArtifactSha256,
  },
  base,
  source,
  scannerConfig: scannerConfig(),
});
assert.equal(sealed.raw.scanner.baseCandidates.length, 0);
assert.equal(sealed.raw.scanner.sourceCandidates.length, 1);
assert.equal(sealed.raw.selectionMode, "production");
assert.equal(sealed.raw.forcedSelectionCount, 0);
const rawText = JSON.stringify(sealed.raw).toLowerCase();
for (const privateValue of [
  protocolTarget,
  swapTarget,
  tokenA,
  tokenB,
  String(baseBlock),
  String(sourceBlock),
]) {
  assert.equal(
    rawText.includes(privateValue.toLowerCase()),
    false,
    `sealed producer evidence leaked ${privateValue}`,
  );
}

const expectation: ConversionProductionExpectation = {
  selectedCandidateId: reveal.selected!.id,
  selectedEvidenceSha256: reveal.selected!.evidenceSha256,
  graphArtifactSha256,
  scannerConfigSha256:
    conversionProductionScannerConfigSha256(scannerConfig()),
  sourceWithoutTargetUpdateOutcome: "ran",
  targetStateKey,
  edgeRateBindings: [{
    edgeKey: protocolEdgeKey,
    rateReadId: "conversion-rate",
    amountInRaw: unit.toString(),
  }],
  candidateOracle: {
    base: [],
    sourceWithoutTargetUpdate: [],
    source: [{
      rank: 1,
      edgeKeys: [protocolEdgeKey, swapEdgeKey],
    }],
  },
};
const comparison = compareConversionProductionEvidence({
  reveal,
  sealed,
  expectation,
});
assert.equal(comparison.freshnessEvidence, "selected");
assert.deepEqual(comparison.reasons, []);
assert.deepEqual(comparison.checks, {
  selectedOracleBound: true,
  topologyUnchanged: true,
  sourceStateDirectRead: true,
    sourceStateChanged: true,
    currentMidsMatchOracle: true,
    scannerOutcomesRan: true,
    candidateOracleMatches: true,
  naturalCandidateOrRankChanged: true,
});

const sourceWithUnrelatedChange = runtime(
  sourceBlock,
  sourceHash,
  2,
  0.9,
  { swapMid: 1.3 },
);
const targetOnlyCounterfactual = conversionRuntimeWithTargetMidsRestored({
  base,
  source: sourceWithUnrelatedChange,
  targetEdges: [base.graph.edges[0]],
});
assert.equal(
  targetOnlyCounterfactual.pricing.mids.get(protocolEdgeKey)?.mid,
  base.pricing.mids.get(protocolEdgeKey)?.mid,
  "counterfactual did not restore the target family to N-1",
);
assert.equal(
  targetOnlyCounterfactual.pricing.mids.get(swapEdgeKey)?.mid,
  sourceWithUnrelatedChange.pricing.mids.get(swapEdgeKey)?.mid,
  "counterfactual rewound an unrelated family",
);
assert.equal(
  targetOnlyCounterfactual.pricing.mids.get(protocolEdgeKey)?.edges,
  sourceWithUnrelatedChange.pricing.mids.get(protocolEdgeKey)?.edges,
  "counterfactual replaced canonical source-N edge identity",
);

const noDeltaSource = runtime(sourceBlock, sourceHash, 2, 0.81);
const noDelta = captureConversionProductionEvidence({
  delivery: {
    attemptNonce,
    baseDeliveryId: sealed.raw.delivery.baseDeliveryId,
    sourceDeliveryId: sealed.raw.delivery.sourceDeliveryId,
    graphScope: "production-full",
    graphArtifactSha256,
  },
  base,
  source: noDeltaSource,
  scannerConfig: scannerConfig(),
});
const missing = compareConversionProductionEvidence({
  reveal: selectedReveal("810000000000000000"),
  sealed: noDelta,
  expectation: {
    ...expectation,
    selectedCandidateId: selectedReveal("810000000000000000").selected!.id,
    selectedEvidenceSha256:
      selectedReveal("810000000000000000").selected!.evidenceSha256,
    candidateOracle: {
      base: [],
      source: [],
      sourceWithoutTargetUpdate: [],
    },
  },
});
assert.equal(missing.freshnessEvidence, "missing");
assert(missing.reasons.includes("no_natural_candidate_or_rank_change"));

const budgetRaw = {
  ...sealed.raw,
  scanner: {
    ...sealed.raw.scanner,
    sourceOutcome: "budget_exceeded" as const,
  },
};
const budgetMissing = compareConversionProductionEvidence({
  reveal,
  sealed: {
    raw: budgetRaw,
    rawSha256: sha256Canonical(budgetRaw),
  },
  expectation,
});
assert.equal(budgetMissing.freshnessEvidence, "missing");
assert(budgetMissing.reasons.includes("scanner_outcome_not_ran"));

const counterfactualBudgetMissing = compareConversionProductionEvidence({
  reveal,
  sealed,
  expectation: {
    ...expectation,
    sourceWithoutTargetUpdateOutcome: "budget_exceeded",
  },
});
assert.equal(counterfactualBudgetMissing.freshnessEvidence, "missing");
assert(counterfactualBudgetMissing.reasons.includes("scanner_outcome_not_ran"));

assert.throws(
  () => captureConversionProductionEvidence({
    delivery: {
      attemptNonce,
      baseDeliveryId: sealed.raw.delivery.baseDeliveryId,
      sourceDeliveryId: sealed.raw.delivery.sourceDeliveryId,
      graphScope: "production-full",
      graphArtifactSha256,
    },
    base,
    source: runtime(sourceBlock, sourceHash, 2, 0.9, {
      completeness: "degraded",
    }),
    scannerConfig: scannerConfig(),
  }),
  /source runtime is degraded/,
  "production-full capture accepted a degraded runtime",
);

const unprovenSource = runtime(sourceBlock, sourceHash, 2, 0.9, {
  provenance: "immutable-fork",
});
const unprovenSealed = captureConversionProductionEvidence({
  delivery: {
    attemptNonce,
    baseDeliveryId: sealed.raw.delivery.baseDeliveryId,
    sourceDeliveryId: sealed.raw.delivery.sourceDeliveryId,
    graphScope: "production-full",
    graphArtifactSha256,
  },
  base,
  source: unprovenSource,
  scannerConfig: scannerConfig(),
});
const unproven = compareConversionProductionEvidence({
  reveal,
  sealed: unprovenSealed,
  expectation,
});
assert.equal(unproven.freshnessEvidence, "missing");
assert(
  unproven.reasons.includes("source_state_not_direct_read"),
  "production freshness accepted a source read without canonical EIP-1898 provenance",
);

assert.throws(
  () => compareConversionProductionEvidence({
    reveal,
    sealed,
    expectation: {
      ...expectation,
      scannerConfigSha256: "00".repeat(32),
    },
  }),
  /scanner config mismatch/,
  "production freshness accepted a different scanner configuration",
);

assert.throws(
  () => compareConversionProductionEvidence({
    reveal,
    sealed: { ...sealed, rawSha256: "00".repeat(32) },
    expectation,
  }),
  /raw hash/,
);

assertUniverseManifestContract();
assertResolvedConfigContract();
assertFrozenProductionInputsContract();
await assertPinnedUniverseProviderContract();

console.log("conversion-freshness-production-evidence PASS");

function assertResolvedConfigContract(): void {
  const config = resolveConversionProductionFullConfig({
    SEARCHER_FORCE_INCLUDE_POOLIDS_PATH:
      resolve(tmpdir(), "conversion-no-force-include.json"),
    SEARCHER_POOL_UNIVERSE_TOP_N: "20000",
    SEARCHER_BLOCKSCAN_MAX_CANDIDATES: "321",
    SEARCHER_ENABLE_PROTOCOL_EDGES: "1",
    BOTVM_ADDRESS: protocolTarget,
  });
  assert.equal(config.universeTopN, 20_000);
  assert.equal(config.universeHighSpreadPairQuota, 150);
  assert.equal(config.pairCompletion, true);
  assert.equal(config.blockscanExtraPools, 6_000);
  assert.equal(config.scanner.maxCandidates, 321);
  assert.equal(config.scanner.budgetMs, 1_500);
  assert.equal(config.scanner.pinnedOutsideBudget, false);
  assert.equal(config.protocolEdgesEnabled, true);
  assert.equal(config.protocolDiscoveryShadow, false);
  assert.equal(config.probeExecutor.toLowerCase(), protocolTarget.toLowerCase());
  assert.throws(
    () => resolveConversionProductionFullConfig({
      SEARCHER_POOL_UNIVERSE_TOP_N: "not-a-number",
      BOTVM_ADDRESS: protocolTarget,
    }),
    /SEARCHER_POOL_UNIVERSE_TOP_N/,
  );
}

function assertFrozenProductionInputsContract(): void {
  const directory = mkdtempSync(resolve(tmpdir(), "conversion-inputs-"));
  const pinned = resolve(directory, "pinned.json");
  const force = resolve(directory, "force.json");
  const queue = resolve(directory, "queue.json");
  writeFileSync(pinned, JSON.stringify({ pools: [] }));
  writeFileSync(force, JSON.stringify([]));
  writeFileSync(queue, JSON.stringify({ queue: [] }));
  try {
    const manifest = freezeConversionProductionInputs({
      artifactDirectory: directory,
      env: {
        BOTVM_ADDRESS: protocolTarget,
        SEARCHER_ENABLE_PROTOCOL_EDGES: "1",
        SEARCHER_PINNED_WARM_POOLS: pinned,
        SEARCHER_FORCE_INCLUDE_POOLIDS_PATH: force,
        SEARCHER_PROTOCOL_DISCOVERY_CACHE_PATH:
          resolve(directory, "missing-cache.json"),
        POOL_UNIVERSE_DISCOVERY_QUEUE_PATH: queue,
      },
    });
    validateConversionProductionInputs(
      manifest,
      sha256Canonical(manifest),
    );
    const frozenPinned = manifest.files.find(
      (file) => file.role === "pinned-warm-pools",
    )!;
    writeFileSync(frozenPinned.frozenPath, JSON.stringify({ pools: [{}] }));
    assert.throws(
      () => validateConversionProductionInputs(
        manifest,
        sha256Canonical(manifest),
      ),
      /frozen input changed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function assertPinnedUniverseProviderContract(): Promise<void> {
  const requests: Array<{
    readonly method: string;
    readonly params: readonly unknown[];
  }> = [];
  const fakeProvider = {
    async send(method: string, params: readonly unknown[]) {
      requests.push({ method, params });
      return method === "eth_getCode" ? "0x6000" : "0x";
    },
  } as unknown as Parameters<typeof pinProviderCallsToBlock>[0];
  const blockHash = `0x${"aa".repeat(32)}`;
  const pinned = pinProviderCallsToBlock(fakeProvider, 123, blockHash);
  await pinned.call({
    to: "0x0000000000000000000000000000000000000001",
    data: "0x1234",
  });
  await pinned.getCode(
    "0x0000000000000000000000000000000000000002",
  );
  await pinned.send("eth_call", [{
    to: "0x0000000000000000000000000000000000000003",
    data: "0xabcd",
  }, "latest"]);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert(
      request.method === "eth_call" || request.method === "eth_getCode",
      "pinned universe provider emitted an unexpected RPC",
    );
    assert.deepEqual(request.params[1], {
      blockHash,
      requireCanonical: true,
    });
  }
}

function assertUniverseManifestContract(): void {
  const directory = mkdtempSync(resolve(tmpdir(), "conversion-universe-manifest-"));
  const path = resolve(directory, "universe.manifest.json");
  const universePath = resolve(directory, "universe.json");
  const source = {
    number: 2_000_000,
    hash: `0x${"77".repeat(32)}`,
    stateRoot: `0x${"88".repeat(32)}`,
  };
  const universeSha256 = "99".repeat(32);
  const manifest = {
    schemaVersion: 1,
    profile: POOL_UNIVERSE_BUILD_MANIFEST_PROFILE,
    chainId: 1,
    source,
    inputs: {
      fromBlock: source.number - 30 * 7_200,
      toBlock: source.number,
      lookbackBlocks: 30 * 7_200,
      minSwaps: 1,
      maxPools: null,
      logBatch: 1_000,
      topicScanMode: "union",
      arbRelevance: true,
      relevanceOversample: 2,
      v4BackfillLookbackBlocks: 5_000_000,
      discoveryQueue: {
        profile: "frozen-discovery-queue-v1",
        exists: true,
        contentSha256: "aa".repeat(32),
        entries: 0,
      },
    },
    registry: {
      sourceFingerprints: productionUniverseRegistrySourceFingerprints(),
    },
    output: {
      contentSha256: universeSha256,
      pools: 12_345,
    },
  };
  try {
    writeFileSync(universePath, JSON.stringify({
      registry: {
        sourceFingerprints: productionUniverseRegistrySourceFingerprints(),
      },
    }));
    writeFileSync(path, JSON.stringify(manifest));
    assert.match(
      validateConversionUniverseBuildManifest({
        manifestPath: path,
        universePath,
        universeSha256,
        universePools: 12_345,
        expectedDiscoveryQueueExists: true,
        expectedDiscoveryQueueSha256: "aa".repeat(32),
        expectedSource: source,
      }),
      /^[0-9a-f]{64}$/,
    );
    writeFileSync(path, JSON.stringify({
      ...manifest,
      inputs: { ...manifest.inputs, maxPools: 20_000 },
    }));
    assert.throws(
      () => validateConversionUniverseBuildManifest({
        manifestPath: path,
        universePath,
        universeSha256,
        universePools: 12_345,
        expectedDiscoveryQueueExists: true,
        expectedDiscoveryQueueSha256: "aa".repeat(32),
        expectedSource: source,
      }),
      "production-full manifest accepted a capped universe",
    );
    writeFileSync(path, JSON.stringify({
      ...manifest,
      registry: { sourceFingerprints: [] },
    }));
    assert.throws(
      () => validateConversionUniverseBuildManifest({
        manifestPath: path,
        universePath,
        universeSha256,
        universePools: 12_345,
        expectedDiscoveryQueueExists: true,
        expectedDiscoveryQueueSha256: "aa".repeat(32),
        expectedSource: source,
      }),
      /different family registry/,
      "production-full manifest accepted a different family registry",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runtime(
  block: number,
  hash: string,
  generation: number,
  protocolMid: number,
  options: {
    readonly completeness?: AdapterRuntimeSnapshot["completeness"];
    readonly provenance?: "eip1898" | "immutable-fork";
    readonly swapMid?: number;
  } = {},
): AdapterRuntimeSnapshot {
  const graph = createVerifiedGraphView({
    id: "conversion-production-contract",
    generation,
    sourceBlock: block,
    sourceBlockHash: hash,
    completenessWatermark: block,
    perSourceCoverage: [{
      familyId: "fixture",
      sourceId: "fixture",
      sourceFingerprint: "fixture-v1",
      completeThroughBlock: block,
      completeThroughHash: hash,
    }],
    edges: rawEdges,
    familyIdForEdge: (edge) =>
      edge.slotKind === "protocol" ? "protocol:wsteth" : "univ2-standard",
  });
  const mids = new Map<string, RouteVenueMid>([
    [
      blockScanEdgeKey(graph.edges[0]),
      mid(graph.edges[0], protocolMid),
    ],
    [
      blockScanEdgeKey(graph.edges[1]),
      mid(graph.edges[1], options.swapMid ?? 1.2),
    ],
  ]);
  const readKey = `${targetStateKey}\u001fconversion-rate`;
  const freshness: StateFreshnessProof = {
    kind: "direct-read",
    source: { number: block, hash, generation },
    provenance: options.provenance === "immutable-fork"
      ? {
          kind: "immutable-fork",
          source: { number: block, hash, generation },
          forkId: "fixture-fork",
        }
      : {
          kind: "eip1898",
          source: { number: block, hash, generation },
          requireCanonical: true,
        },
  };
  const stateValue: PublishedFamilyStateValue = Object.freeze({
    familyId: "protocol:wsteth",
    snapshotFingerprint: deterministicHash({ protocolMid }),
    deriveMids: () => new Map([[blockScanEdgeKey(graph.edges[0]), mids.values().next().value!]]),
  });
  const stateByStateKey = new Map([
    [
      targetStateKey,
      Object.freeze({
        familyId: "protocol:wsteth",
        stateKey: protocolTarget.toLowerCase(),
        source: { number: block, hash, generation },
        snapshot: stateValue,
        requiredReadKeys: ["conversion-rate"],
        freshnessByReadKey: new Map([["conversion-rate", freshness]]),
        refreshMode: "unproven-direct" as const,
        backrunInvalidations: Object.freeze([]),
      }),
    ],
  ]);
  const edgeKeys = [...mids.keys()].sort();
  const pricing: BlockScanStateSnapshot = Object.freeze({
    generation,
    sourceBlock: block,
    sourceBlockHash: hash,
    graph,
    mids,
    coverageByReadKey: new Map([[readKey, { status: "resolved" as const }]]),
    coverageByEdgeKey: new Map(edgeKeys.map((edgeKey) => [
      edgeKey,
      { status: "resolved" as const },
    ])),
    freshnessByReadKey: new Map([[readKey, freshness]]),
    stateByStateKey,
    resolvedFamilyIds: ["protocol:wsteth", "univ2-standard"],
    incompleteFamilyIds: [],
    coverage: {
      expectedStateKeys: [targetStateKey],
      resolvedStateKeys: [targetStateKey],
      unresolvedStateKeys: [],
      expectedReadKeys: [readKey],
      resolvedReadKeys: [readKey],
      unresolvedReadKeys: [],
      expectedEdgeKeys: edgeKeys,
      resolvedEdgeKeys: edgeKeys,
      unavailableEdgeKeys: [],
      unresolvedEdgeKeys: [],
      expectedStateKeyHash: exactSetHash([targetStateKey]),
      resolvedStateKeyHash: exactSetHash([targetStateKey]),
      unresolvedStateKeyHash: exactSetHash([]),
      expectedReadKeyHash: exactSetHash([readKey]),
      resolvedReadKeyHash: exactSetHash([readKey]),
      unresolvedReadKeyHash: exactSetHash([]),
      expectedEdgeKeyHash: exactSetHash(edgeKeys),
      resolvedEdgeKeyHash: exactSetHash(edgeKeys),
      unavailableEdgeKeyHash: exactSetHash([]),
      unresolvedEdgeKeyHash: exactSetHash([]),
    },
    laneTelemetry: [],
  });
  const emptyHash = exactSetHash([]);
  const funding = new FlashFundingSnapshot(
    generation,
    block,
    hash,
    {
      expectedKeys: [],
      resolvedKeys: [],
      unresolvedKeys: [],
      expectedHash: emptyHash,
      resolvedHash: emptyHash,
      unresolvedHash: emptyHash,
    },
    new Map(),
    new Map(),
    new Map(),
  );
  return Object.freeze({
    completeness: options.completeness ?? "complete",
    generation,
    sourceBlock: block,
    sourceBlockHash: hash,
    graph,
    pricing,
    funding,
  });
}

function mid(edge: TokenEdge, value: number): RouteVenueMid {
  return Object.freeze({
    kind: edge.slotKind === "protocol" ? "protocol" : "v2",
    pool: edge.target,
    edges: Object.freeze([edge]) as TokenEdge[],
    mid: value,
    feeBps: 0,
    reserveA: 10_000n * unit,
    reserveB: BigInt(Math.floor(value * 10_000)) * unit,
    depthProxy: Number(10_000n * unit),
  });
}

function scannerConfig() {
  return {
    maxHops: 3,
    minSpreadBps: 0,
    maxCandidates: 20,
    budgetMs: 10_000,
    pricedTokens: new Map([[tokenA.toLowerCase(), {
      maxBorrow: 1_000n * unit,
    }]]),
    pinnedOutsideBudget: true,
  };
}

function selectedReveal(
  after = "900000000000000000",
): ConversionFreshnessReveal {
  const predicate = wstethFreshnessPrivatePredicate();
  const plan = buildConversionFreshnessPlan({
    predicate,
    fromBlock: baseBlock,
    toBlock: sourceBlock,
    minEligibleCardinality: 32,
    productionInputsSha256: "ab".repeat(32),
    secret: { seed: "seed", salt: "salt" },
  });
  const evidence: ConversionFreshnessCandidateEvidence = {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: "conversion-freshness-candidate-evidence-v1",
    predicateSha256: plan.predicateSha256,
    protocol: "private-protocol",
    instanceAddress: protocolTarget,
    eventSourceAddress: protocolTarget,
    eventTopic0: `0x${"33".repeat(32)}`,
    eventEvidenceSha256: "44".repeat(32),
    eventCount: 1,
    base: {
      number: baseBlock,
      hash: baseHash,
      parentHash: `0x${"10".repeat(32)}`,
      stateRoot: `0x${"55".repeat(32)}`,
    },
    source: {
      number: sourceBlock,
      hash: sourceHash,
      parentHash: baseHash,
      stateRoot: `0x${"66".repeat(32)}`,
    },
    topology: [],
    rates: [{
      id: "conversion-rate",
      beforeRaw: `0x${(800_000_000_000_000_000n).toString(16).padStart(64, "0")}`,
      afterRaw: `0x${BigInt(after).toString(16).padStart(64, "0")}`,
      before: "800000000000000000",
      after,
      changed: after !== "800000000000000000",
    }],
    topologyUnchanged: true,
    rateChangedAtSource: true,
  };
  const candidate: ConversionCandidate = {
    id: sha256Canonical({ sourceBlock, evidence }),
    sourceBlock,
    evidenceSha256: sha256Canonical(evidence),
  };
  return {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: CONVERSION_REVEAL_PROFILE,
    plan,
    reveal: { seed: "seed", salt: "salt" },
    freshnessEvidence: "selected",
    eligibleSetSha256: sha256Canonical([candidate]),
    selected: candidate,
    selectedEvidence: evidence,
  };
}

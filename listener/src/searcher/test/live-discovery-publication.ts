import assert from "node:assert/strict";
import {
  DiscoveryBackfillLane,
  type DiscoveryBackfillSource,
} from "../discovery-backfill-lane.js";
import {
  assertLiveDiscoveryPublicationState,
  cloneLiveDiscoveryPublicationState,
  deriveLiveDiscoveryGraphCompleteThrough,
  describeLiveDiscoveryPublicationState,
  type DiscoveryCoverageAnchor,
  type LiveDiscoveryPublicationState,
} from "../live-discovery-publication.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import {
  createProtocolDiscoveryEvidenceCache,
} from "../protocol-discovery-cache.js";
import { discoveryFamilySourceKey } from "../discovery-source-watermark.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

const OBSERVED = discoveryFamilySourceKey(
  "protocol:fixture",
  "observed-interaction",
);
const ADDRESS = discoveryFamilySourceKey(
  "protocol:fixture",
  "dex-token-domain",
);
const POOL_A = address(0xa1);
const POOL_B = address(0xb2);
const FACTORY = address(0xfa);
const TOKEN_A = address(0x11);
const TOKEN_B = address(0x22);
const TX_HASH = blockHash(0xabc);

await deepCloneDetachesEveryNestedContainer();
canonicalFingerprintCoversEveryPublicationClass();
coverageIsDerivedFromExactAnchors();
invalidOrDuplicatedCursorStateFailsClosed();
await laneRejectsAStaleAggregateBase();

console.log(
  "[live-discovery-publication] aggregate clone/fingerprint/stale-base: " +
    "PASS (5/5)",
);

async function deepCloneDetachesEveryNestedContainer(): Promise<void> {
  const source = stateAt(100);
  const clone = cloneLiveDiscoveryPublicationState(source);
  const cloneBefore = describeLiveDiscoveryPublicationState(clone);

  source.strategyViews.backrun[0]!.score = 777;
  source.backrunGraph[0]!.v2FeeBps = 9_999n;
  mutableSet(source.tokenIndex.get(TOKEN_A)!).add(address(0x33));
  mutableMap(source.protocolEvidenceCache.runtime.recentProcessedTxs)
    .set(blockHash(0xdef), 100);
  source.retryableDexGraphPools.get("retry:graph")!.score = 999;
  mutableSet(source.suppressedDexPoolKeys!).add("stale:late");

  const evidence = source.protocolEvidenceCache.verifiedCandidates
    .get("univ2|fixture")!.candidate.evidence![0] as {
      nested: Map<string, { amount: bigint }>;
    };
  evidence.nested.get("quote")!.amount = 222n;
  evidence.nested.set("late", { amount: 333n });

  assert.deepEqual(
    describeLiveDiscoveryPublicationState(clone),
    cloneBefore,
    "mutating the source must not mutate the detached publication",
  );
  assert.notEqual(
    describeLiveDiscoveryPublicationState(source).baseFingerprint,
    cloneBefore.baseFingerprint,
  );
  assert.notStrictEqual(clone.strategyViews, source.strategyViews);
  assert.notStrictEqual(clone.backrunGraph, source.backrunGraph);
  assert.notStrictEqual(clone.tokenIndex, source.tokenIndex);
  assert.equal(clone.suppressedDexPoolKeys?.has("stale:late"), false);
  assert.notStrictEqual(
    clone.protocolEvidenceCache,
    source.protocolEvidenceCache,
  );
  const clonedEvidence = clone.protocolEvidenceCache.verifiedCandidates
    .get("univ2|fixture")!.candidate.evidence![0] as {
      nested: Map<string, { amount: bigint }>;
    };
  assert.equal(clonedEvidence.nested.get("quote")!.amount, 111n);
  assert.equal(clonedEvidence.nested.has("late"), false);
}

function canonicalFingerprintCoversEveryPublicationClass(): void {
  const base = stateAt(100);
  const expected = describeLiveDiscoveryPublicationState(base);

  const insertionReordered = cloneLiveDiscoveryPublicationState(base);
  const reorderedState: LiveDiscoveryPublicationState = {
    ...insertionReordered,
    tokenIndex: reverseMapWithReversedSets(insertionReordered.tokenIndex),
    poolAddressMap: reverseMap(insertionReordered.poolAddressMap),
    knownPoolKeys: reverseSet(insertionReordered.knownPoolKeys),
    knownPoolAddresses: reverseSet(insertionReordered.knownPoolAddresses),
    retryableDexGraphPools: reverseMap(
      insertionReordered.retryableDexGraphPools,
    ),
    retryableDexIdentityPools: reverseMap(
      insertionReordered.retryableDexIdentityPools,
    ),
    protocolFamilySourceCoverage: reverseMap(
      insertionReordered.protocolFamilySourceCoverage,
    ),
  };
  assert.deepEqual(
    describeLiveDiscoveryPublicationState(reorderedState),
    expected,
    "Map/Set insertion order must not enter a canonical fingerprint",
  );

  const orderedGraph = cloneLiveDiscoveryPublicationState(base);
  const reorderedGraphState: LiveDiscoveryPublicationState = {
    ...orderedGraph,
    backrunGraph: [...orderedGraph.backrunGraph].reverse(),
  };
  assert.notEqual(
    describeLiveDiscoveryPublicationState(reorderedGraphState)
      .baseFingerprint,
    expected.baseFingerprint,
    "graph array order is execution state and must remain significant",
  );

  const bigintState = cloneLiveDiscoveryPublicationState(base);
  bigintState.backrunGraph[0]!.v2FeeBps = 31n;
  assert.notEqual(
    describeLiveDiscoveryPublicationState(bigintState).baseFingerprint,
    expected.baseFingerprint,
    "bigint edge fields must enter the fingerprint losslessly",
  );

  const viewState = cloneLiveDiscoveryPublicationState(base);
  viewState.strategyViews.backrun[0]!.score = 1234;
  assertBaseChanged(viewState, expected.baseFingerprint, "strategy view");

  const indexState = cloneLiveDiscoveryPublicationState(base);
  mutableSet(indexState.tokenIndex.get(TOKEN_A)!).add(address(0x44));
  assertBaseChanged(indexState, expected.baseFingerprint, "token index");

  const ownershipState = cloneLiveDiscoveryPublicationState(base);
  mutableOwnership(ownershipState).version++;
  ownershipState.protocolEvidenceCache.routeOwnership = {
    ...ownershipState.protocolEvidenceCache.routeOwnership,
    version: ownershipState.protocolOwnership.version,
  };
  assertBaseChanged(
    ownershipState,
    expected.baseFingerprint,
    "protocol ownership",
  );

  const evidenceState = cloneLiveDiscoveryPublicationState(base);
  evidenceState.protocolEvidenceCache.runtime.recentProcessedTxs.set(
    blockHash(0x777),
    99,
  );
  assertBaseChanged(
    evidenceState,
    expected.baseFingerprint,
    "protocol evidence cache",
  );

  const retryState = cloneLiveDiscoveryPublicationState(base);
  mutableMap(retryState.retryableDexGraphPools).set(
    "retry:new",
    pool(address(0xcc), 12),
  );
  assertBaseChanged(
    retryState,
    expected.baseFingerprint,
    "DEX retry state",
  );

  const suppressionState = cloneLiveDiscoveryPublicationState(base);
  mutableSet(suppressionState.suppressedDexPoolKeys!).add("stale:new");
  assertBaseChanged(
    suppressionState,
    expected.baseFingerprint,
    "DEX stale-row tombstone",
  );
}

function coverageIsDerivedFromExactAnchors(): void {
  const base = stateAt(100);
  assert.equal(deriveLiveDiscoveryGraphCompleteThrough(base), 100);
  assert.equal(
    "protocolGraphCompleteThrough" in base,
    false,
    "a duplicated protocol completeness scalar must not exist",
  );

  const familyBehind = cloneLiveDiscoveryPublicationState(base);
  mutableMap(familyBehind.protocolFamilySourceCoverage).set(
    ADDRESS,
    anchor(99),
  );
  assert.equal(deriveLiveDiscoveryGraphCompleteThrough(familyBehind), 99);
  assert.notEqual(
    describeLiveDiscoveryPublicationState(familyBehind)
      .coverageFingerprint,
    describeLiveDiscoveryPublicationState(base).coverageFingerprint,
  );

  const noProtocolSources: LiveDiscoveryPublicationState = {
    ...cloneLiveDiscoveryPublicationState(base),
    protocolFamilySourceCoverage: new Map(),
  };
  assert.equal(
    deriveLiveDiscoveryGraphCompleteThrough(noProtocolSources),
    100,
    "an empty active protocol source set must not degrade DEX-only coverage",
  );

  const dexBehind = cloneLiveDiscoveryPublicationState(base);
  const dexBehindState: LiveDiscoveryPublicationState = {
    ...dexBehind,
    dexGraphCoverage: {
      sourceCompleteThrough: 100,
      graphCompleteThrough: 98,
    },
    dexGraphAnchor: anchor(98),
  };
  assert.equal(deriveLiveDiscoveryGraphCompleteThrough(dexBehindState), 98);
}

function invalidOrDuplicatedCursorStateFailsClosed(): void {
  const staleCursor = cloneLiveDiscoveryPublicationState(stateAt(100));
  staleCursor.protocolEvidenceCache.runtime.observedCursor = 99;
  staleCursor.protocolEvidenceCache.runtime.observedCursorHash =
    blockHash(99);
  assert.throws(
    () => assertLiveDiscoveryPublicationState(staleCursor),
    /observed cursor does not match/,
  );

  const unanchored = cloneLiveDiscoveryPublicationState(stateAt(100));
  const invalid: LiveDiscoveryPublicationState = {
    ...unanchored,
    dexGraphAnchor: {
      completeThroughBlock: 100,
      completeThroughHash: null,
    },
  };
  assert.throws(
    () => describeLiveDiscoveryPublicationState(invalid),
    /requires a lowercase canonical block hash/,
  );
}

async function laneRejectsAStaleAggregateBase(): Promise<void> {
  const base = stateAt(100);
  const next = advanceTo(base, 101);
  const source = sourceAt(101);
  const lane = new DiscoveryBackfillLane<
    LiveDiscoveryPublicationState,
    LiveDiscoveryPublicationState
  >({
    maxBlocksPerJob: 8,
    maxPreparationMs: 5_000,
    maxConcurrency: 2,
    describeState: describeLiveDiscoveryPublicationState,
    prepare: async () => next,
    validateTransition: (_plan, prepared) => ({
      state: prepared,
      source,
    }),
  });
  assert.deepEqual(
    lane.schedule({
      id: "aggregate:101",
      range: { fromBlock: 101, toBlock: 101 },
      source,
    }, base),
    { scheduled: true, jobId: 1 },
  );
  await waitFor(() => lane.readyDescriptor() !== null);

  const current = cloneLiveDiscoveryPublicationState(base);
  current.protocolEvidenceCache.runtime.recentProcessedTxs.set(
    blockHash(0xbeef),
    100,
  );
  const result = lane.takeForHotHead({
    targetSource: source,
    currentState: current,
    canonicalPreparedSource: { revision: 7, source },
    currentCanonicalRevision: 7,
  });
  assert.equal(result.status, "degraded");
  if (result.status !== "degraded") {
    throw new Error("expected a stale aggregate publication");
  }
  assert.equal(result.reason, "stale_base");
}

function stateAt(block: number): LiveDiscoveryPublicationState {
  const poolA = pool(POOL_A, 10);
  const poolB = pool(POOL_B, 9);
  const edgeA = edge(POOL_A, TOKEN_A, TOKEN_B, 30n);
  const edgeB = edge(POOL_B, TOKEN_B, TOKEN_A, 25n);
  const evidenceCache = createProtocolDiscoveryEvidenceCache(1);
  evidenceCache.runtime.observedCursor = block;
  evidenceCache.runtime.observedCursorHash = blockHash(block);
  evidenceCache.runtime.observedSourceFingerprint = "sources:v1";
  evidenceCache.runtime.discoverySourceFingerprints.set(
    "protocol:fixture",
    "matcher:v1",
  );
  evidenceCache.runtime.recentProcessedTxs.set(TX_HASH, block - 1);
  evidenceCache.verifiedCandidates.set("univ2|fixture", {
    adapterId: "protocol:fixture",
    candidate: {
      pool: { ...poolA },
      source: "fixture",
      evidence: [{
        nested: new Map([["quote", { amount: 111n }]]),
      }],
    },
  });

  return {
    revision: 0,
    strategyViews: {
      backrun: [poolA, poolB],
      blockscan: [poolA, poolB],
      versions: {
        strategy_view_version: "view:v1",
        backrun_view_hash: "backrun:v1",
        blockscan_view_hash: "blockscan:v1",
        pool_universe_generated_at: "2026-07-24T00:00:00.000Z",
        overrides_hash: "overrides:v1",
      },
    },
    backrunGraph: [edgeA, edgeB],
    blockscanGraph: [edgeA, edgeB],
    tokenIndex: new Map([
      [TOKEN_A, new Set([TOKEN_B])],
      [TOKEN_B, new Set([TOKEN_A])],
    ]),
    poolAddressMap: new Map([
      [POOL_A, "univ2"],
      [POOL_B, "univ2"],
    ]),
    flashTokens: [TOKEN_A, TOKEN_B],
    knownPoolKeys: new Set(["pool:a", "pool:b"]),
    knownPoolAddresses: new Set([POOL_A, POOL_B]),
    suppressedDexPoolKeys: new Set(["stale:fixture"]),
    protocolOwnership: {
      version: 0,
      admissions: new Map(),
    },
    protocolEvidenceCache: evidenceCache,
    retryableDexGraphPools: new Map([
      ["retry:graph", pool(address(0xd1), 2)],
      ["retry:graph-2", pool(address(0xd2), 1)],
    ]),
    retryableDexIdentityPools: new Map([
      ["retry:identity", pool(address(0xe1), 0)],
      ["retry:identity-2", pool(address(0xe2), 0)],
    ]),
    dexGraphCoverage: {
      sourceCompleteThrough: block,
      graphCompleteThrough: block,
    },
    dexSourceAnchor: anchor(block),
    dexGraphAnchor: anchor(block),
    landedCoverage: [{
      familyId: "univ2-standard",
      sourceId: "univ2-swap",
      sourceFingerprint: "event:v1",
      eventId: "univ2-swap",
      consumed: true,
      complete: true,
      issues: [],
    }],
    protocolFamilySourceCoverage: new Map([
      [OBSERVED, anchor(block)],
      [ADDRESS, anchor(block)],
    ]),
    protocolObservedCursor: anchor(block),
  };
}

function advanceTo(
  input: LiveDiscoveryPublicationState,
  block: number,
): LiveDiscoveryPublicationState {
  const next = cloneLiveDiscoveryPublicationState(input);
  next.protocolEvidenceCache.runtime.observedCursor = block;
  next.protocolEvidenceCache.runtime.observedCursorHash = blockHash(block);
  return {
    ...next,
    revision: input.revision + 1,
    dexGraphCoverage: {
      sourceCompleteThrough: block,
      graphCompleteThrough: block,
    },
    dexSourceAnchor: anchor(block),
    dexGraphAnchor: anchor(block),
    protocolFamilySourceCoverage: new Map([
      [OBSERVED, anchor(block)],
      [ADDRESS, anchor(block)],
    ]),
    protocolObservedCursor: anchor(block),
  };
}

function pool(poolAddress: string, score: number): PoolEntry {
  return {
    address: poolAddress,
    adapter: "univ2",
    venueId: "univ2",
    factory: FACTORY,
    identitySource: "factory-call",
    token0: TOKEN_A,
    token1: TOKEN_B,
    score,
  };
}

function edge(
  target: string,
  tokenIn: string,
  tokenOut: string,
  fee: bigint,
): TokenEdge {
  return {
    adapterId: "univ2-swap",
    target,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
    poolToken0: TOKEN_A,
    poolToken1: TOKEN_B,
    v2FeeBps: fee,
  };
}

function anchor(block: number): DiscoveryCoverageAnchor {
  return block < 0
    ? { completeThroughBlock: -1, completeThroughHash: null }
    : {
        completeThroughBlock: block,
        completeThroughHash: blockHash(block),
      };
}

function sourceAt(number: number): DiscoveryBackfillSource {
  return { number, hash: blockHash(number) };
}

function blockHash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function mutableSet<T>(value: ReadonlySet<T>): Set<T> {
  return value as Set<T>;
}

function mutableMap<K, V>(value: ReadonlyMap<K, V>): Map<K, V> {
  return value as Map<K, V>;
}

function mutableOwnership(
  state: LiveDiscoveryPublicationState,
): { version: number } {
  return state.protocolOwnership as { version: number };
}

function reverseMap<K, V>(
  value: ReadonlyMap<K, V>,
): ReadonlyMap<K, V> {
  return new Map([...value].reverse());
}

function reverseSet<T>(value: ReadonlySet<T>): ReadonlySet<T> {
  return new Set([...value].reverse());
}

function reverseMapWithReversedSets(
  value: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    [...value]
      .reverse()
      .map(([key, peers]) => [key, reverseSet(peers)] as const),
  );
}

function assertBaseChanged(
  state: LiveDiscoveryPublicationState,
  baseFingerprint: string,
  label: string,
): void {
  assert.notEqual(
    describeLiveDiscoveryPublicationState(state).baseFingerprint,
    baseFingerprint,
    `${label} mutation must invalidate the publication base`,
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for discovery publication test");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

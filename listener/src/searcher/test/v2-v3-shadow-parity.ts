import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  BlockScanStateCoordinator,
  type BlockScanStateCoverage,
  type BlockScanStateReadBackend,
  type BlockScanStateSnapshot,
} from "../blockscan-state-coordinator.js";
import { JsonRpcBlockScanStateReadBackend } from "../blockscan-state-read-backend.js";
import type { QuoteRequest } from "../live-state-backend.js";
import {
  buildTokenGraphWithResults,
  type PoolEntry,
  type TokenEdge,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import {
  DEFAULT_POOL_UNIVERSE_PATH,
  loadPoolUniverse,
  type PoolUniverseEntry,
} from "../pool-universe.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { PoolStateUpdater } from "../solver/pool-state-updater.js";
import {
  blockScanEdgeKey,
  blockScanStateKey,
  canonicalEdgeId,
  createVerifiedGraphView,
  deterministicHash,
  exactSetHash,
  type BlockSource,
  type RegisteredBlockScanStateFamily,
} from "../venues/blockscan-state-capability.js";
import {
  readV2WarmMid,
  readV3WarmMid,
  type RouteVenueMid,
} from "../venues/mid-readers.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";

export const V2_V3_SHADOW_PARITY_PROFILE =
  "v2-v3-shadow-parity-v1" as const;
export const V2_V3_SHADOW_MID_RELATIVE_TOLERANCE = 1e-12;

type ShadowFamilyId = "univ2-standard" | "univ3-standard";

export interface ShadowBlockHeader extends BlockSource {
  readonly parentHash: string;
}

export interface SelectedV2V3Pool {
  readonly familyId: ShadowFamilyId;
  readonly rank: number;
  readonly pool: PoolUniverseEntry;
  readonly edges: readonly TokenEdge[];
}

interface NormalizedState {
  readonly stateKey: string;
  readonly familyId: ShadowFamilyId;
  readonly value: Readonly<Record<string, string | number | boolean | null>>;
}

interface NormalizedMid {
  readonly edgeKey: string;
  readonly kind: string;
  readonly pool: string;
  readonly mid: number;
  readonly feeBps: number;
  readonly reserveA: string | null;
  readonly reserveB: string | null;
  readonly sqrtABX96: string | null;
  readonly liquidity: string | null;
  readonly depthProxy: number;
}

interface NormalizedCoverage {
  readonly expectedStateKeys: readonly string[];
  readonly resolvedStateKeys: readonly string[];
  readonly unresolvedStateKeys: readonly string[];
  readonly expectedReadKeys: readonly string[];
  readonly resolvedReadKeys: readonly string[];
  readonly unresolvedReadKeys: readonly string[];
  readonly expectedEdgeKeys: readonly string[];
  readonly resolvedEdgeKeys: readonly string[];
  readonly unresolvedEdgeKeys: readonly string[];
  readonly expectedStateKeyHash: string;
  readonly resolvedStateKeyHash: string;
  readonly unresolvedStateKeyHash: string;
  readonly expectedReadKeyHash: string;
  readonly resolvedReadKeyHash: string;
  readonly unresolvedReadKeyHash: string;
  readonly expectedEdgeKeyHash: string;
  readonly resolvedEdgeKeyHash: string;
  readonly unresolvedEdgeKeyHash: string;
}

export interface V2V3ShadowParityBlock {
  readonly source: ShadowBlockHeader;
  readonly changedStateKeys: readonly string[];
  readonly unchangedStateKeys: readonly string[];
  readonly legacy: {
    readonly snapshotHash: string;
    readonly midHash: string;
    readonly snapshots: readonly NormalizedState[];
    readonly mids: readonly NormalizedMid[];
    readonly coverage: NormalizedCoverage;
    readonly provenance: {
      readonly kind: "canonical-header-sandwich";
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
    };
    readonly timingMs: number;
  };
  readonly coordinator: {
    readonly status: "complete" | "degraded" | "incomplete";
    readonly snapshotHash: string | null;
    readonly midHash: string | null;
    readonly snapshots: readonly NormalizedState[];
    readonly mids: readonly NormalizedMid[];
    readonly coverage: NormalizedCoverage;
    readonly freshness: readonly {
      readonly readKey: string;
      readonly kind: "direct-read" | "carry-forward";
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
    }[];
    readonly issues: readonly string[];
    readonly timingMs: number;
  };
  readonly parity: {
    readonly snapshotsExact: boolean;
    readonly midsWithinTolerance: boolean;
    readonly coverageExact: boolean;
    readonly unresolvedExact: boolean;
    readonly provenanceBoundToSameSource: boolean;
    readonly failures: readonly string[];
  };
}

export interface V2V3ShadowParityArtifact {
  readonly schemaVersion: 1;
  readonly profile: typeof V2_V3_SHADOW_PARITY_PROFILE;
  readonly status: "pass" | "fail";
  readonly input: {
    readonly chainId: number;
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly expectedSingleHash: string | null;
    readonly rpcTransport: "json-rpc";
    readonly universe: {
      readonly contentSha256: string;
      readonly rowCount: number;
    };
    readonly selection: {
      readonly poolsPerFamily: number;
      readonly candidateLimitPerFamily: number;
      readonly midRelativeTolerance: number;
    };
  };
  readonly selectedPools: readonly {
    readonly rank: number;
    readonly familyId: ShadowFamilyId;
    readonly adapter: string;
    readonly pool: string;
    readonly score: number | null;
    readonly lastSwapBlock: number | null;
    readonly edgeKeys: readonly string[];
  }[];
  readonly blocks: readonly V2V3ShadowParityBlock[];
  readonly summary: {
    readonly blocks: number;
    readonly changedStateKeys: readonly string[];
    readonly unchangedStateKeys: readonly string[];
    readonly failures: readonly string[];
    readonly changeCoverage:
      | "not-applicable"
      | "changed-and-unchanged"
      | "missing-changed"
      | "missing-unchanged";
  };
  readonly syntheticEvidence: {
    readonly test: "src/searcher/test/v2-v3-incremental-state.ts";
    readonly command: "npm run searcher:v2-v3-incremental-state";
    readonly covers: readonly [
      "forced-same-height-reorg",
      "univ3-mint-burn-tick-invalidation",
      "missing-log-full-refresh",
    ];
  };
}

export interface CompareV2V3ShadowRangeInput {
  readonly chainId: number;
  readonly headers: readonly ShadowBlockHeader[];
  readonly selectedPools: readonly SelectedV2V3Pool[];
  readonly legacyProvider: ethers.JsonRpcProvider;
  readonly coordinatorBackend: BlockScanStateReadBackend;
  readonly universeContentSha256: string;
  readonly universeRowCount: number;
  readonly poolsPerFamily: number;
  readonly candidateLimitPerFamily: number;
  readonly expectedSingleHash?: string;
  readonly timeoutMs?: number;
  readonly verifyHeader?: (
    expected: ShadowBlockHeader,
  ) => Promise<ShadowBlockHeader>;
}

/**
 * Registry-derived selection only. Addresses affect deterministic ranking but
 * are never an admission allowlist or target fixture.
 */
export function selectV2V3UniverseCandidates(
  pools: readonly PoolUniverseEntry[],
  candidateLimitPerFamily: number,
): ReadonlyMap<ShadowFamilyId, readonly { rank: number; pool: PoolUniverseEntry }[]> {
  if (
    !Number.isSafeInteger(candidateLimitPerFamily) ||
    candidateLimitPerFamily <= 0
  ) {
    throw new Error("candidateLimitPerFamily must be a positive integer");
  }
  const routeRegistry = PRODUCTION_ADAPTER_FAMILIES.routes();
  const ranked = pools
    .map((pool, index) => ({
      pool,
      inputIndex: index,
      familyId: routeRegistry.findForPool(pool.adapter)?.id ?? null,
    }))
    .filter(
      (item): item is typeof item & { familyId: ShadowFamilyId } =>
        item.familyId === "univ2-standard" ||
        item.familyId === "univ3-standard",
    )
    .sort((a, b) =>
      (b.pool.score ?? 0) - (a.pool.score ?? 0) ||
      (b.pool.lastSwapBlock ?? -1) - (a.pool.lastSwapBlock ?? -1) ||
      a.pool.address.toLowerCase().localeCompare(b.pool.address.toLowerCase()) ||
      a.inputIndex - b.inputIndex
    );
  const out = new Map<
    ShadowFamilyId,
    Array<{ rank: number; pool: PoolUniverseEntry }>
  >([
    ["univ2-standard", []],
    ["univ3-standard", []],
  ]);
  const familyRanks = new Map<ShadowFamilyId, number>([
    ["univ2-standard", 0],
    ["univ3-standard", 0],
  ]);
  for (const item of ranked) {
    const familyRank = (familyRanks.get(item.familyId) ?? 0) + 1;
    familyRanks.set(item.familyId, familyRank);
    const family = out.get(item.familyId)!;
    if (family.length < candidateLimitPerFamily) {
      family.push(Object.freeze({ rank: familyRank, pool: item.pool }));
    }
  }
  return new Map(
    [...out].map(([familyId, entries]) => [
      familyId,
      Object.freeze(entries),
    ]),
  );
}

export async function compareV2V3ShadowRange(
  input: CompareV2V3ShadowRangeInput,
): Promise<V2V3ShadowParityArtifact> {
  assertHeaders(input.headers);
  assertSelectedCohort(input.selectedPools, input.poolsPerFamily);
  const selectedPools = canonicalizeSelectedPools(input.selectedPools);
  const timeoutMs = input.timeoutMs ?? 120_000;
  const families = selectedStateFamilies();
  const edges = Object.freeze(
    selectedPools.flatMap((selected) => selected.edges),
  );
  const legacyCache = new PoolStateCache();
  const legacyUpdater = new PoolStateUpdater(
    input.legacyProvider,
    legacyCache,
    { maxPools: selectedPools.length },
  );
  const coordinator = new BlockScanStateCoordinator(
    input.coordinatorBackend,
    { familyTimeoutMs: timeoutMs },
  );
  const blocks: V2V3ShadowParityBlock[] = [];
  let previousCoordinatorStates: readonly NormalizedState[] | null = null;

  for (let index = 0; index < input.headers.length; index++) {
    const header = input.headers[index];
    await verifyExpectedHeader(input, header);
    const legacyStarted = Date.now();
    await legacyUpdater.update(
      header.number,
      legacyQuoteRequests(selectedPools),
      { awaitTicks: false, maxTickPools: 0 },
    );
    seedVerifiedV3StaticMetadata(
      legacyCache,
      selectedPools,
      header.number,
    );
    const legacyStates = normalizeLegacyStates(
      legacyCache,
      selectedPools,
      header.number,
    );
    const legacyMids = normalizeLegacyMids(
      legacyCache,
      selectedPools,
      header.number,
    );
    const legacyCoverage = buildLegacyCoverage(
      selectedPools,
      legacyStates,
      legacyMids,
    );
    await verifyExpectedHeader(input, header);
    const legacyTimingMs = Date.now() - legacyStarted;

    const graph = createVerifiedGraphView({
      id: `${V2_V3_SHADOW_PARITY_PROFILE}:${input.universeContentSha256}`,
      generation: index + 1,
      sourceBlock: header.number,
      sourceBlockHash: header.hash,
      completenessWatermark: header.number,
      perSourceCoverage: selectedFamilyIds(selectedPools).map(
        (familyId) => Object.freeze({
          familyId,
          sourceId: `shadow-production-universe:${familyId}`,
          sourceFingerprint: deterministicHash({
            profile: V2_V3_SHADOW_PARITY_PROFILE,
            universeContentSha256: input.universeContentSha256,
            selectedPools: selectedPools
              .filter((selected) => selected.familyId === familyId)
              .map((selected) => selected.pool.address.toLowerCase())
              .sort(),
          }),
          completeThroughBlock: header.number,
          completeThroughHash: header.hash,
        }),
      ),
      edges,
      familyIdForEdge: familyIdForEdge,
    });
    const coordinatorStarted = Date.now();
    const prepared = await coordinator.prepare({
      graph,
      families,
      deadlineAtMs: Date.now() + timeoutMs,
    });
    await verifyExpectedHeader(input, header);
    const coordinatorTimingMs = Date.now() - coordinatorStarted;
    const coordinatorSnapshot =
      prepared.status === "incomplete" ? null : prepared.snapshot;
    const coordinatorStates = coordinatorSnapshot
      ? normalizeCoordinatorStates(coordinatorSnapshot, selectedPools)
      : Object.freeze([]) as readonly NormalizedState[];
    const coordinatorMids = coordinatorSnapshot
      ? normalizeMidMap(coordinatorSnapshot.mids)
      : Object.freeze([]) as readonly NormalizedMid[];
    const coordinatorCoverage = normalizeCoordinatorCoverage(
      prepared.coverage,
    );
    const changes = classifyStateChanges(
      previousCoordinatorStates,
      coordinatorStates,
    );
    if (coordinatorSnapshot) previousCoordinatorStates = coordinatorStates;
    const failures = compareBlockParity({
      legacyStates,
      coordinatorStates,
      legacyMids,
      coordinatorMids,
      legacyCoverage,
      coordinatorCoverage,
      coordinatorSnapshot,
      expected: header,
    });
    blocks.push(Object.freeze({
      source: header,
      changedStateKeys: changes.changed,
      unchangedStateKeys: changes.unchanged,
      legacy: Object.freeze({
        snapshotHash: deterministicHash(legacyStates),
        midHash: deterministicHash(legacyMids),
        snapshots: legacyStates,
        mids: legacyMids,
        coverage: legacyCoverage,
        provenance: Object.freeze({
          kind: "canonical-header-sandwich" as const,
          sourceBlock: header.number,
          sourceBlockHash: header.hash,
        }),
        timingMs: legacyTimingMs,
      }),
      coordinator: Object.freeze({
        status: prepared.status,
        snapshotHash: coordinatorSnapshot
          ? deterministicHash(coordinatorStates)
          : null,
        midHash: coordinatorSnapshot
          ? deterministicHash(coordinatorMids)
          : null,
        snapshots: coordinatorStates,
        mids: coordinatorMids,
        coverage: coordinatorCoverage,
        freshness: normalizeFreshness(coordinatorSnapshot),
        issues: Object.freeze(
          prepared.issues.map((issue) =>
            [
              issue.kind,
              issue.familyId ?? "",
              issue.stateKey ?? "",
              issue.message,
            ].join(":")
          ).sort(),
        ),
        timingMs: coordinatorTimingMs,
      }),
      parity: Object.freeze({
        snapshotsExact:
          deterministicHash(legacyStates) ===
          deterministicHash(coordinatorStates),
        midsWithinTolerance: midsWithinTolerance(
          legacyMids,
          coordinatorMids,
        ),
        coverageExact: coverageCoreEqual(
          legacyCoverage,
          coordinatorCoverage,
        ),
        unresolvedExact: unresolvedEqual(
          legacyCoverage,
          coordinatorCoverage,
        ),
        provenanceBoundToSameSource:
          coordinatorSnapshot !== null &&
          coordinatorSnapshot.sourceBlock === header.number &&
          coordinatorSnapshot.sourceBlockHash.toLowerCase() ===
            header.hash.toLowerCase(),
        failures: Object.freeze(failures),
      }),
    }));
  }

  const changedStateKeys = sortedUnique(
    blocks.flatMap((block) => block.changedStateKeys),
  );
  const unchangedStateKeys = sortedUnique(
    blocks.flatMap((block) => block.unchangedStateKeys),
  );
  const failures = blocks.flatMap((block) =>
    block.parity.failures.map(
      (failure) => `block ${block.source.number}: ${failure}`,
    )
  );
  const changeCoverage =
    input.headers.length <= 1
      ? "not-applicable"
      : changedStateKeys.length === 0
        ? "missing-changed"
        : unchangedStateKeys.length === 0
          ? "missing-unchanged"
          : "changed-and-unchanged";
  if (changeCoverage === "missing-changed") {
    failures.push("continuous range did not exercise a changed state key");
  } else if (changeCoverage === "missing-unchanged") {
    failures.push("continuous range did not exercise an unchanged state key");
  }

  return Object.freeze({
    schemaVersion: 1,
    profile: V2_V3_SHADOW_PARITY_PROFILE,
    status: failures.length === 0 ? "pass" : "fail",
    input: Object.freeze({
      chainId: input.chainId,
      fromBlock: input.headers[0].number,
      toBlock: input.headers[input.headers.length - 1].number,
      expectedSingleHash: input.expectedSingleHash?.toLowerCase() ?? null,
      rpcTransport: "json-rpc" as const,
      universe: Object.freeze({
        contentSha256: input.universeContentSha256,
        rowCount: input.universeRowCount,
      }),
      selection: Object.freeze({
        poolsPerFamily: input.poolsPerFamily,
        candidateLimitPerFamily: input.candidateLimitPerFamily,
        midRelativeTolerance: V2_V3_SHADOW_MID_RELATIVE_TOLERANCE,
      }),
    }),
    selectedPools: Object.freeze(
      selectedPools
        .map((selected) => Object.freeze({
          rank: selected.rank,
          familyId: selected.familyId,
          adapter: selected.pool.adapter,
          pool: selected.pool.address.toLowerCase(),
          score: selected.pool.score ?? null,
          lastSwapBlock: selected.pool.lastSwapBlock ?? null,
          edgeKeys: Object.freeze(
            selected.edges.map(blockScanEdgeKey).sort(),
          ),
        }))
        .sort((a, b) =>
          a.familyId.localeCompare(b.familyId) ||
          a.rank - b.rank ||
          a.pool.localeCompare(b.pool)
        ),
    ),
    blocks: Object.freeze(blocks),
    summary: Object.freeze({
      blocks: blocks.length,
      changedStateKeys,
      unchangedStateKeys,
      failures: Object.freeze(failures),
      changeCoverage,
    }),
    syntheticEvidence: Object.freeze({
      test: "src/searcher/test/v2-v3-incremental-state.ts" as const,
      command: "npm run searcher:v2-v3-incremental-state" as const,
      covers: Object.freeze([
        "forced-same-height-reorg",
        "univ3-mint-burn-tick-invalidation",
        "missing-log-full-refresh",
      ]) as readonly [
        "forced-same-height-reorg",
        "univ3-mint-burn-tick-invalidation",
        "missing-log-full-refresh",
      ],
    }),
  });
}

export interface RunV2V3ShadowParityLiveInput {
  readonly rpcUrl: string;
  readonly universePath: string;
  readonly outPath: string;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly expectedSingleHash?: string;
  readonly poolsPerFamily: number;
  readonly candidateLimitPerFamily: number;
  readonly timeoutMs: number;
}

export async function runV2V3ShadowParityLive(
  input: RunV2V3ShadowParityLiveInput,
): Promise<V2V3ShadowParityArtifact> {
  const provider = new ethers.JsonRpcProvider(input.rpcUrl, undefined, {
    staticNetwork: true,
  });
  const [network, headers] = await Promise.all([
    provider.getNetwork(),
    readHeaderRange(provider, input.fromBlock, input.toBlock),
  ]);
  if (input.expectedSingleHash) {
    if (headers.length !== 1) {
      throw new Error("--source-hash is valid only for a single source block");
    }
    if (
      headers[0].hash.toLowerCase() !== input.expectedSingleHash.toLowerCase()
    ) {
      throw new Error(
        `source hash mismatch for block ${headers[0].number}`,
      );
    }
  }
  const universeRaw = readFileSync(input.universePath);
  const universeContentSha256 = createHash("sha256")
    .update(universeRaw)
    .digest("hex");
  const universe = loadPoolUniverse(input.universePath, {
    missingOk: false,
    maxPools: 0,
    minScore: 0,
  });
  const ranked = selectV2V3UniverseCandidates(
    universe,
    input.candidateLimitPerFamily,
  );
  const candidateRows = [
    ...(ranked.get("univ2-standard") ?? []),
    ...(ranked.get("univ3-standard") ?? []),
  ];
  const sourceBlock = headers[0].number;
  const graphBackend: TokenQueryBackend = {
    call(req, control) {
      return provider.call(
        { ...req, blockTag: sourceBlock },
      ).then(String);
    },
  };
  const graph = await buildTokenGraphWithResults(
    graphBackend,
    candidateRows.map((entry) => entry.pool),
    {
      quiet: true,
      deadlineAtMs: Date.now() + input.timeoutMs,
      familyTimeoutMs: input.timeoutMs,
    },
  );
  const rankByPool = new Map(
    candidateRows.map((entry) => [
      poolSelectionKey(entry.pool),
      entry.rank,
    ]),
  );
  const selected: SelectedV2V3Pool[] = [];
  for (const success of graph.successful) {
    const familyId = familyIdForPool(success.pool);
    if (!familyId) continue;
    if (
      selected.filter((entry) => entry.familyId === familyId).length >=
        input.poolsPerFamily
    ) {
      continue;
    }
    selected.push(Object.freeze({
      familyId,
      rank: rankByPool.get(poolSelectionKey(success.pool)) ?? 0,
      pool: success.pool as PoolUniverseEntry,
      edges: Object.freeze(success.edges),
    }));
  }
  assertSelectedCohort(selected, input.poolsPerFamily);
  const backend = new JsonRpcBlockScanStateReadBackend(input.rpcUrl, {
    multicallMode: "rpc-batch",
  });
  return compareV2V3ShadowRange({
    chainId: Number(network.chainId),
    headers,
    selectedPools: Object.freeze(selected),
    legacyProvider: provider,
    coordinatorBackend: backend,
    universeContentSha256,
    universeRowCount: universe.length,
    poolsPerFamily: input.poolsPerFamily,
    candidateLimitPerFamily: input.candidateLimitPerFamily,
    expectedSingleHash: input.expectedSingleHash,
    timeoutMs: input.timeoutMs,
    verifyHeader: async (expected) => {
      const observed = await readHeader(provider, expected.number);
      return observed;
    },
  });
}

export function writeCanonicalShadowArtifact(
  outPath: string,
  artifact: V2V3ShadowParityArtifact,
): string {
  const absolute = resolve(outPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const bytes = `${canonicalJson(artifact)}\n`;
  writeFileSync(absolute, bytes, { encoding: "utf8", mode: 0o600 });
  chmodSync(absolute, 0o600);
  return createHash("sha256").update(bytes).digest("hex");
}

export function v2V3ShadowParityExitCode(
  artifact: Pick<V2V3ShadowParityArtifact, "status">,
): 0 | 1 {
  return artifact.status === "pass" ? 0 : 1;
}

function selectedStateFamilies(): readonly RegisteredBlockScanStateFamily[] {
  const selected = PRODUCTION_ADAPTER_FAMILIES
    .blockScanStateFamilies()
    .filter(
      (family) =>
        family.familyId === "univ2-standard" ||
        family.familyId === "univ3-standard",
    );
  if (selected.length !== 2) {
    throw new Error(
      `expected exactly two V2/V3 state families, found ${selected.length}`,
    );
  }
  return Object.freeze(selected);
}

function canonicalizeSelectedPools(
  selectedPools: readonly SelectedV2V3Pool[],
): readonly SelectedV2V3Pool[] {
  return Object.freeze(
    selectedPools.map((selected) => Object.freeze({
      ...selected,
      edges: Object.freeze(
        selected.edges.map((edge) => Object.freeze({
          ...edge,
          canonicalEdgeId: canonicalEdgeId(selected.familyId, edge),
        })),
      ),
    })),
  );
}

function legacyQuoteRequests(
  selectedPools: readonly SelectedV2V3Pool[],
): QuoteRequest[] {
  return selectedPools.map((selected): QuoteRequest => {
    const edge = selected.edges[0];
    if (!edge) throw new Error(`pool ${selected.pool.address} has no edge`);
    return {
      adapterId: edge.adapterId,
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn: 1n,
      poolToken0: edge.poolToken0,
      poolToken1: edge.poolToken1,
    };
  });
}

/**
 * The old mid reader requires tick metadata even though its coarse mid only
 * uses slot0/liquidity. The shadow harness seeds verified immutable metadata
 * from the graph and leaves tick invalidation to the existing dedicated
 * incremental-state test referenced in the artifact.
 */
function seedVerifiedV3StaticMetadata(
  cache: PoolStateCache,
  selectedPools: readonly SelectedV2V3Pool[],
  blockNumber: number,
): void {
  for (const selected of selectedPools) {
    if (selected.familyId !== "univ3-standard") continue;
    const edge = selected.edges[0];
    if (
      !edge?.poolToken0 ||
      !edge.poolToken1 ||
      edge.v3Fee === undefined ||
      edge.v3TickSpacing === undefined
    ) {
      throw new Error(
        `V3 graph edge ${selected.pool.address} lacks immutable metadata`,
      );
    }
    cache.seedV3Ticks({
      pool: edge.target,
      token0: edge.poolToken0,
      token1: edge.poolToken1,
      fee: BigInt(edge.v3Fee),
      tickSpacing: edge.v3TickSpacing,
      tickBitmap: new Map(),
      ticks: new Map(),
      blockNumber,
    });
  }
}

function normalizeLegacyStates(
  cache: PoolStateCache,
  selectedPools: readonly SelectedV2V3Pool[],
  blockNumber: number,
): readonly NormalizedState[] {
  const states: NormalizedState[] = [];
  for (const selected of selectedPools) {
    const edge = selected.edges[0];
    const rawStateKey = edge.target.toLowerCase();
    const stateKey = blockScanStateKey(selected.familyId, rawStateKey);
    if (selected.familyId === "univ2-standard") {
      const state = cache.snapshotV2(edge.target, blockNumber);
      if (!state) continue;
      states.push(normalizedV2State(stateKey, state));
    } else {
      const state = cache.snapshotV3Live(edge.target, blockNumber);
      if (!state) continue;
      states.push(normalizedV3State(stateKey, state, edge));
    }
  }
  return Object.freeze(states.sort((a, b) => a.stateKey.localeCompare(b.stateKey)));
}

function normalizeCoordinatorStates(
  snapshot: BlockScanStateSnapshot,
  selectedPools: readonly SelectedV2V3Pool[],
): readonly NormalizedState[] {
  const edgeByStateKey = new Map(
    selectedPools.map((selected) => [
      blockScanStateKey(
        selected.familyId,
        selected.edges[0].target.toLowerCase(),
      ),
      selected.edges[0],
    ]),
  );
  const states: NormalizedState[] = [];
  for (const [stateKey, published] of snapshot.stateByStateKey) {
    const seed = published.snapshot.projectBackrunState?.(published.source);
    const edge = edgeByStateKey.get(stateKey);
    if (!seed || !edge) continue;
    if (seed.kind === "v2") {
      states.push(normalizedV2State(stateKey, seed.state));
    } else if (seed.kind === "v3-live") {
      states.push(normalizedV3State(stateKey, seed.state, edge));
    }
  }
  return Object.freeze(states.sort((a, b) => a.stateKey.localeCompare(b.stateKey)));
}

function normalizedV2State(
  stateKey: string,
  state: {
    readonly pool: string;
    readonly token0: string;
    readonly token1: string;
    readonly reserve0: bigint;
    readonly reserve1: bigint;
    readonly feeBps: bigint;
    readonly blockTimestampLast?: number;
    readonly blockNumber: number;
  },
): NormalizedState {
  return Object.freeze({
    stateKey,
    familyId: "univ2-standard" as const,
    value: Object.freeze({
      pool: state.pool.toLowerCase(),
      token0: state.token0.toLowerCase(),
      token1: state.token1.toLowerCase(),
      reserve0: state.reserve0.toString(),
      reserve1: state.reserve1.toString(),
      feeBps: state.feeBps.toString(),
      blockTimestampLast: state.blockTimestampLast ?? null,
      blockNumber: state.blockNumber,
    }),
  });
}

function normalizedV3State(
  stateKey: string,
  state: {
    readonly pool: string;
    readonly sqrtPriceX96: bigint;
    readonly tick: number;
    readonly liquidity: bigint;
    readonly observationIndex?: number;
    readonly observationCardinality?: number;
    readonly observationCardinalityNext?: number;
    readonly feeProtocol?: number;
    readonly unlocked?: boolean;
    readonly blockNumber: number;
  },
  edge: TokenEdge,
): NormalizedState {
  return Object.freeze({
    stateKey,
    familyId: "univ3-standard" as const,
    value: Object.freeze({
      pool: state.pool.toLowerCase(),
      token0: edge.poolToken0!.toLowerCase(),
      token1: edge.poolToken1!.toLowerCase(),
      fee: String(edge.v3Fee),
      tickSpacing: edge.v3TickSpacing!,
      sqrtPriceX96: state.sqrtPriceX96.toString(),
      tick: state.tick,
      liquidity: state.liquidity.toString(),
      observationIndex: state.observationIndex ?? null,
      observationCardinality: state.observationCardinality ?? null,
      observationCardinalityNext: state.observationCardinalityNext ?? null,
      feeProtocol: state.feeProtocol ?? null,
      unlocked: state.unlocked ?? null,
      blockNumber: state.blockNumber,
    }),
  });
}

function normalizeLegacyMids(
  cache: PoolStateCache,
  selectedPools: readonly SelectedV2V3Pool[],
  blockNumber: number,
): readonly NormalizedMid[] {
  const mids = new Map<string, RouteVenueMid>();
  for (const selected of selectedPools) {
    for (const edge of selected.edges) {
      const mid = selected.familyId === "univ2-standard"
        ? readV2WarmMid({
            cache,
            sourceBlock: blockNumber,
            a: edge.tokenIn.toLowerCase(),
            b: edge.tokenOut.toLowerCase(),
            pool: edge.target,
            edges: [edge],
          })
        : readV3WarmMid({
            cache,
            sourceBlock: blockNumber,
            a: edge.tokenIn.toLowerCase(),
            b: edge.tokenOut.toLowerCase(),
            pool: edge.target,
            edges: [edge],
          });
      if (mid) mids.set(blockScanEdgeKey(edge), mid);
    }
  }
  return normalizeMidMap(mids);
}

function normalizeMidMap(
  mids: ReadonlyMap<string, RouteVenueMid>,
): readonly NormalizedMid[] {
  return Object.freeze(
    [...mids.entries()]
      .map(([edgeKey, mid]) => Object.freeze({
        edgeKey,
        kind: mid.kind,
        pool: mid.pool.toLowerCase(),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: mid.reserveA?.toString() ?? null,
        reserveB: mid.reserveB?.toString() ?? null,
        sqrtABX96: mid.sqrtABX96?.toString() ?? null,
        liquidity: mid.liquidity?.toString() ?? null,
        depthProxy: mid.depthProxy,
      }))
      .sort((a, b) => a.edgeKey.localeCompare(b.edgeKey)),
  );
}

function buildLegacyCoverage(
  selectedPools: readonly SelectedV2V3Pool[],
  states: readonly NormalizedState[],
  mids: readonly NormalizedMid[],
): NormalizedCoverage {
  const expectedStateKeys = selectedPools.map((selected) =>
    blockScanStateKey(
      selected.familyId,
      selected.edges[0].target.toLowerCase(),
    )
  );
  const resolvedStateKeys = states.map((state) => state.stateKey);
  const resolvedStateSet = new Set(resolvedStateKeys);
  const expectedReadKeys = selectedPools.flatMap((selected) => {
    const pool = selected.edges[0].target.toLowerCase();
    const stateKey = blockScanStateKey(selected.familyId, pool);
    return selected.familyId === "univ2-standard"
      ? [`${stateKey}\u001freserves:${pool}`]
      : [
          `${stateKey}\u001fslot0:${pool}`,
          `${stateKey}\u001fliquidity:${pool}`,
        ];
  });
  const resolvedReadKeys = selectedPools.flatMap((selected) => {
    const pool = selected.edges[0].target.toLowerCase();
    const stateKey = blockScanStateKey(selected.familyId, pool);
    if (!resolvedStateSet.has(stateKey)) return [];
    return selected.familyId === "univ2-standard"
      ? [`${stateKey}\u001freserves:${pool}`]
      : [
          `${stateKey}\u001fslot0:${pool}`,
          `${stateKey}\u001fliquidity:${pool}`,
        ];
  });
  const expectedEdgeKeys = selectedPools.flatMap((selected) =>
    selected.edges.map(blockScanEdgeKey)
  );
  const resolvedEdgeKeys = mids.map((mid) => mid.edgeKey);
  return makeCoverage({
    expectedStateKeys,
    resolvedStateKeys,
    expectedReadKeys,
    resolvedReadKeys,
    expectedEdgeKeys,
    resolvedEdgeKeys,
  });
}

function normalizeCoordinatorCoverage(
  coverage: BlockScanStateCoverage,
): NormalizedCoverage {
  return makeCoverage({
    expectedStateKeys: coverage.expectedStateKeys,
    resolvedStateKeys: coverage.resolvedStateKeys,
    expectedReadKeys: coverage.expectedReadKeys,
    resolvedReadKeys: coverage.resolvedReadKeys,
    expectedEdgeKeys: coverage.expectedEdgeKeys,
    resolvedEdgeKeys: coverage.resolvedEdgeKeys,
  });
}

function makeCoverage(input: {
  readonly expectedStateKeys: readonly string[];
  readonly resolvedStateKeys: readonly string[];
  readonly expectedReadKeys: readonly string[];
  readonly resolvedReadKeys: readonly string[];
  readonly expectedEdgeKeys: readonly string[];
  readonly resolvedEdgeKeys: readonly string[];
}): NormalizedCoverage {
  const expectedStateKeys = sortedUnique(input.expectedStateKeys);
  const resolvedStateKeys = sortedUnique(input.resolvedStateKeys);
  const expectedReadKeys = sortedUnique(input.expectedReadKeys);
  const resolvedReadKeys = sortedUnique(input.resolvedReadKeys);
  const expectedEdgeKeys = sortedUnique(input.expectedEdgeKeys);
  const resolvedEdgeKeys = sortedUnique(input.resolvedEdgeKeys);
  const unresolvedStateKeys = difference(expectedStateKeys, resolvedStateKeys);
  const unresolvedReadKeys = difference(expectedReadKeys, resolvedReadKeys);
  const unresolvedEdgeKeys = difference(expectedEdgeKeys, resolvedEdgeKeys);
  return Object.freeze({
    expectedStateKeys,
    resolvedStateKeys,
    unresolvedStateKeys,
    expectedReadKeys,
    resolvedReadKeys,
    unresolvedReadKeys,
    expectedEdgeKeys,
    resolvedEdgeKeys,
    unresolvedEdgeKeys,
    expectedStateKeyHash: exactSetHash(expectedStateKeys),
    resolvedStateKeyHash: exactSetHash(resolvedStateKeys),
    unresolvedStateKeyHash: exactSetHash(unresolvedStateKeys),
    expectedReadKeyHash: exactSetHash(expectedReadKeys),
    resolvedReadKeyHash: exactSetHash(resolvedReadKeys),
    unresolvedReadKeyHash: exactSetHash(unresolvedReadKeys),
    expectedEdgeKeyHash: exactSetHash(expectedEdgeKeys),
    resolvedEdgeKeyHash: exactSetHash(resolvedEdgeKeys),
    unresolvedEdgeKeyHash: exactSetHash(unresolvedEdgeKeys),
  });
}

function compareBlockParity(input: {
  readonly legacyStates: readonly NormalizedState[];
  readonly coordinatorStates: readonly NormalizedState[];
  readonly legacyMids: readonly NormalizedMid[];
  readonly coordinatorMids: readonly NormalizedMid[];
  readonly legacyCoverage: NormalizedCoverage;
  readonly coordinatorCoverage: NormalizedCoverage;
  readonly coordinatorSnapshot: BlockScanStateSnapshot | null;
  readonly expected: ShadowBlockHeader;
}): string[] {
  const failures: string[] = [];
  if (
    deterministicHash(input.legacyStates) !==
    deterministicHash(input.coordinatorStates)
  ) {
    failures.push("legacy/coordinator normalized snapshots differ");
  }
  if (!midsWithinTolerance(input.legacyMids, input.coordinatorMids)) {
    failures.push(
      `legacy/coordinator mids differ beyond relative tolerance ` +
        `${V2_V3_SHADOW_MID_RELATIVE_TOLERANCE}`,
    );
  }
  if (!coverageCoreEqual(input.legacyCoverage, input.coordinatorCoverage)) {
    failures.push("legacy/coordinator expected/resolved coverage differs");
  }
  if (!unresolvedEqual(input.legacyCoverage, input.coordinatorCoverage)) {
    failures.push("legacy/coordinator unresolved sets differ");
  }
  if (!input.coordinatorSnapshot) {
    failures.push("coordinator did not publish a snapshot");
  } else if (
    input.coordinatorSnapshot.sourceBlock !== input.expected.number ||
    input.coordinatorSnapshot.sourceBlockHash.toLowerCase() !==
      input.expected.hash.toLowerCase()
  ) {
    failures.push("coordinator snapshot provenance is not source-bound");
  }
  return failures;
}

function coverageCoreEqual(
  a: NormalizedCoverage,
  b: NormalizedCoverage,
): boolean {
  return (
    a.expectedStateKeyHash === b.expectedStateKeyHash &&
    a.resolvedStateKeyHash === b.resolvedStateKeyHash &&
    a.expectedReadKeyHash === b.expectedReadKeyHash &&
    a.resolvedReadKeyHash === b.resolvedReadKeyHash &&
    a.expectedEdgeKeyHash === b.expectedEdgeKeyHash &&
    a.resolvedEdgeKeyHash === b.resolvedEdgeKeyHash
  );
}

function unresolvedEqual(
  a: NormalizedCoverage,
  b: NormalizedCoverage,
): boolean {
  return (
    a.unresolvedStateKeyHash === b.unresolvedStateKeyHash &&
    a.unresolvedReadKeyHash === b.unresolvedReadKeyHash &&
    a.unresolvedEdgeKeyHash === b.unresolvedEdgeKeyHash
  );
}

function midsWithinTolerance(
  legacy: readonly NormalizedMid[],
  coordinator: readonly NormalizedMid[],
): boolean {
  if (legacy.length !== coordinator.length) return false;
  for (let index = 0; index < legacy.length; index++) {
    const a = legacy[index];
    const b = coordinator[index];
    if (
      a.edgeKey !== b.edgeKey ||
      a.kind !== b.kind ||
      a.pool !== b.pool ||
      a.feeBps !== b.feeBps ||
      a.reserveA !== b.reserveA ||
      a.reserveB !== b.reserveB ||
      a.sqrtABX96 !== b.sqrtABX96 ||
      a.liquidity !== b.liquidity ||
      a.depthProxy !== b.depthProxy
    ) {
      return false;
    }
    const scale = Math.max(Math.abs(a.mid), Math.abs(b.mid), Number.MIN_VALUE);
    if (
      !Number.isFinite(a.mid) ||
      !Number.isFinite(b.mid) ||
      Math.abs(a.mid - b.mid) / scale >
        V2_V3_SHADOW_MID_RELATIVE_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}

function normalizeFreshness(
  snapshot: BlockScanStateSnapshot | null,
): readonly {
  readonly readKey: string;
  readonly kind: "direct-read" | "carry-forward";
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
}[] {
  if (!snapshot) return Object.freeze([]);
  return Object.freeze(
    [...snapshot.freshnessByReadKey.entries()]
      .map(([readKey, proof]) => Object.freeze({
        readKey,
        kind: proof.kind,
        sourceBlock: proof.source.number,
        sourceBlockHash: proof.source.hash.toLowerCase(),
      }))
      .sort((a, b) => a.readKey.localeCompare(b.readKey)),
  );
}

function classifyStateChanges(
  previous: readonly NormalizedState[] | null,
  current: readonly NormalizedState[],
): {
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
} {
  if (!previous) {
    return Object.freeze({
      changed: Object.freeze([]),
      unchanged: Object.freeze([]),
    });
  }
  const previousByKey = new Map(
    previous.map((state) => [state.stateKey, stateEconomicHash(state)]),
  );
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const state of current) {
    const prior = previousByKey.get(state.stateKey);
    if (prior === stateEconomicHash(state)) unchanged.push(state.stateKey);
    else changed.push(state.stateKey);
  }
  return Object.freeze({
    changed: sortedUnique(changed),
    unchanged: sortedUnique(unchanged),
  });
}

function stateEconomicHash(state: NormalizedState): string {
  const { blockNumber: _blockNumber, ...economic } = state.value;
  return deterministicHash(economic);
}

function familyIdForEdge(edge: TokenEdge): string {
  const matches = PRODUCTION_ADAPTER_FAMILIES
    .routes()
    .list()
    .filter((family) => family.edgeAdapterIds.includes(edge.adapterId));
  if (matches.length !== 1) {
    throw new Error(
      `edge adapter ${edge.adapterId} has ${matches.length} route owners`,
    );
  }
  return matches[0].id;
}

function familyIdForPool(pool: PoolEntry): ShadowFamilyId | null {
  const id = PRODUCTION_ADAPTER_FAMILIES.routes().findForPool(pool.adapter)?.id;
  return id === "univ2-standard" || id === "univ3-standard" ? id : null;
}

function selectedFamilyIds(
  selectedPools: readonly SelectedV2V3Pool[],
): readonly ShadowFamilyId[] {
  return Object.freeze(
    [...new Set(selectedPools.map((selected) => selected.familyId))].sort(),
  );
}

function poolSelectionKey(pool: PoolEntry): string {
  return `${pool.adapter}\u001f${pool.address.toLowerCase()}\u001f${pool.poolId?.toLowerCase() ?? ""}`;
}

function assertSelectedCohort(
  selected: readonly SelectedV2V3Pool[],
  poolsPerFamily: number,
): void {
  if (!Number.isSafeInteger(poolsPerFamily) || poolsPerFamily <= 0) {
    throw new Error("poolsPerFamily must be a positive integer");
  }
  for (const familyId of [
    "univ2-standard",
    "univ3-standard",
  ] as const) {
    const count = selected.filter((entry) => entry.familyId === familyId).length;
    if (count !== poolsPerFamily) {
      throw new Error(
        `shadow cohort needs ${poolsPerFamily} ${familyId} pools, found ${count}`,
      );
    }
  }
  for (const entry of selected) {
    if (entry.edges.length === 0) {
      throw new Error(`selected pool ${entry.pool.address} has no graph edges`);
    }
  }
}

function assertHeaders(headers: readonly ShadowBlockHeader[]): void {
  if (headers.length === 0) throw new Error("shadow range has no headers");
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index];
    if (!Number.isSafeInteger(header.number) || header.number < 0) {
      throw new Error(`invalid source block ${header.number}`);
    }
    if (!ethers.isHexString(header.hash, 32)) {
      throw new Error(`invalid source hash for block ${header.number}`);
    }
    if (!ethers.isHexString(header.parentHash, 32)) {
      throw new Error(`invalid parent hash for block ${header.number}`);
    }
    if (index > 0) {
      const previous = headers[index - 1];
      if (
        header.number !== previous.number + 1 ||
        header.parentHash.toLowerCase() !== previous.hash.toLowerCase()
      ) {
        throw new Error(
          `non-canonical header sequence ${previous.number}->${header.number}`,
        );
      }
    }
  }
}

async function verifyExpectedHeader(
  input: CompareV2V3ShadowRangeInput,
  expected: ShadowBlockHeader,
): Promise<void> {
  if (!input.verifyHeader) return;
  const observed = await input.verifyHeader(expected);
  if (
    observed.number !== expected.number ||
    observed.hash.toLowerCase() !== expected.hash.toLowerCase() ||
    observed.parentHash.toLowerCase() !== expected.parentHash.toLowerCase()
  ) {
    throw new Error(`canonical source changed at block ${expected.number}`);
  }
}

async function readHeaderRange(
  provider: ethers.JsonRpcProvider,
  fromBlock: number,
  toBlock: number,
): Promise<readonly ShadowBlockHeader[]> {
  const headers: ShadowBlockHeader[] = [];
  for (let block = fromBlock; block <= toBlock; block++) {
    headers.push(await readHeader(provider, block));
  }
  assertHeaders(headers);
  return Object.freeze(headers);
}

async function readHeader(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
): Promise<ShadowBlockHeader> {
  const block = await provider.getBlock(blockNumber);
  if (!block?.hash || !block.parentHash) {
    throw new Error(`RPC did not return canonical header ${blockNumber}`);
  }
  return Object.freeze({
    number: blockNumber,
    hash: block.hash.toLowerCase(),
    parentHash: block.parentHash.toLowerCase(),
    generation: blockNumber,
  });
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function difference(
  expected: readonly string[],
  resolved: readonly string[],
): readonly string[] {
  const found = new Set(resolved);
  return Object.freeze(expected.filter((value) => !found.has(value)));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) {
        throw new Error(`canonical JSON rejects undefined at ${key}`);
      }
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

interface CliOptions {
  readonly rpcUrl: string;
  readonly universePath: string;
  readonly outPath: string;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly expectedSingleHash?: string;
  readonly poolsPerFamily: number;
  readonly candidateLimitPerFamily: number;
  readonly timeoutMs: number;
}

function parseCli(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${name}`);
    }
    values.set(name, value);
  }
  const rpcUrl =
    values.get("--rpc-url") ??
    process.env.MAINNET_RPC_URL ??
    process.env.RPC_URL ??
    "";
  if (!rpcUrl) throw new Error("--rpc-url or MAINNET_RPC_URL is required");
  const outPath = values.get("--out");
  if (!outPath) throw new Error("--out is required");
  const single = values.get("--source-block");
  const from = single ?? values.get("--from-block");
  const to = single ?? values.get("--to-block");
  if (!from || !to) {
    throw new Error(
      "use --source-block N or --from-block N --to-block M",
    );
  }
  const fromBlock = positiveSafeInteger(from, "from block", true);
  const toBlock = positiveSafeInteger(to, "to block", true);
  if (toBlock < fromBlock) throw new Error("to block precedes from block");
  const poolsPerFamily = positiveSafeInteger(
    values.get("--pools-per-family") ?? "2",
    "pools per family",
  );
  const candidateLimitPerFamily = positiveSafeInteger(
    values.get("--candidate-limit-per-family") ??
      String(Math.max(8, poolsPerFamily * 8)),
    "candidate limit per family",
  );
  if (candidateLimitPerFamily < poolsPerFamily) {
    throw new Error("candidate limit must be >= pools per family");
  }
  const timeoutMs = positiveSafeInteger(
    values.get("--timeout-ms") ?? "120000",
    "timeout",
  );
  const expectedSingleHash = values.get("--source-hash");
  if (
    expectedSingleHash !== undefined &&
    !ethers.isHexString(expectedSingleHash, 32)
  ) {
    throw new Error("--source-hash must be bytes32");
  }
  return Object.freeze({
    rpcUrl,
    universePath: resolve(
      values.get("--universe") ?? DEFAULT_POOL_UNIVERSE_PATH,
    ),
    outPath: resolve(outPath),
    fromBlock,
    toBlock,
    expectedSingleHash,
    poolsPerFamily,
    candidateLimitPerFamily,
    timeoutMs,
  });
}

function positiveSafeInteger(
  value: string,
  label: string,
  allowZero = false,
): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (allowZero ? parsed < 0 : parsed <= 0)
  ) {
    throw new Error(`${label} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const artifact = await runV2V3ShadowParityLive(options);
  const sha256 = writeCanonicalShadowArtifact(options.outPath, artifact);
  console.log(
    `[v2-v3-shadow-parity] status=${artifact.status} ` +
      `blocks=${artifact.summary.blocks} sha256=${sha256} out=${options.outPath}`,
  );
  process.exitCode = v2V3ShadowParityExitCode(artifact);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(
      `[v2-v3-shadow-parity] failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}

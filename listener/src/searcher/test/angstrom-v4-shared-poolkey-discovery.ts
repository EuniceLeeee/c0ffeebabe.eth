import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "../venues/admission.js";
import {
  filterStartupActivePoolIncumbents,
  mergeStartupActivePoolDiscovery,
  scanActivePoolsDetailed,
} from "../active-pool-discovery.js";
import {
  discoverLandedPools,
  isLandedPoolDiscoverySourceMismatchError,
  LandedPoolDiscoverySourceMismatchError,
  type LandedPoolDiscoveryLog,
  type LandedPoolDiscoveryLogFilter,
  type LandedPoolMaterializationContext,
  type LandedPoolSharedIdentityCapability,
  type LandedPoolSharedIdentityMaterializer,
} from "../venues/landed-pool-discovery.js";
import {
  materializeSharedLandedPoolIdentity,
  materializeSharedLandedPoolIdentityMembers,
} from "../venues/landed-pool-shared-identity.js";
import {
  buildTokenGraphWithResults,
  type PoolEntry,
} from "../planner/token-graph.js";
import {
  applyRuntimePoolRefreshDelta,
  prepareRuntimePoolRefresh,
  selectRefreshCandidates,
} from "../runtime-pool-refresh.js";
import {
  buildStrategyViews,
} from "../strategy-views.js";
import { angstromV4Adapter } from "../venues/swaps/angstrom-v4.js";
import {
  ANGSTROM_MAINNET_HOOK,
} from "../venues/swaps/angstrom-attestation.js";
import {
  UNIV4_INITIALIZE_TOPIC,
  UNIV4_SWAP_TOPIC,
} from "../venues/landed-event-registry.js";
import { univ4Adapter } from "../venues/swaps/univ4.js";
import {
  resolveV4InitsBackward,
} from "../venues/swaps/univ4-pool-discovery.js";
import {
  v4PoolId,
} from "../venues/swaps/univ4-common.js";
import type { SwapAdapter } from "../venues/route-leg-adapter.js";
import { routeInstanceKey } from "../venues/route-instance-identity.js";
import {
  poolProjectionRowKey,
  poolRegistryKey,
} from "../pool-universe.js";

const poolManager = ethers.getAddress(ADDR.UNISWAP_V4_POOL_MANAGER);
const currency0 = ethers.getAddress(
  "0x0000000000000000000000000000000000000011",
);
const currency1 = ethers.getAddress(
  "0x0000000000000000000000000000000000000022",
);
const fee = 100;
const tickSpacing = 1;

interface FixtureKey {
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: string;
}

interface DiscoveryCounters {
  poolKeyCalls: number;
  initializeScans: number;
  swapScans: number;
}

function fixtureKey(hooks: string): FixtureKey {
  return {
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks: ethers.getAddress(hooks),
  };
}

function swapLog(key: FixtureKey): LandedPoolDiscoveryLog {
  return {
    address: poolManager,
    topics: [
      UNIV4_SWAP_TOPIC,
      v4PoolId(key),
      ethers.zeroPadValue(ethers.ZeroAddress, 32),
    ],
    data: "0x",
    blockNumber: 100,
  };
}

function topicIncludes(
  filter: LandedPoolDiscoveryLogFilter,
  topic: string,
): boolean {
  const first = filter.topics[0];
  if (typeof first === "string") {
    return first.toLowerCase() === topic.toLowerCase();
  }
  return Array.isArray(first) &&
    first.some((item) => item.toLowerCase() === topic.toLowerCase());
}

function discoveryBackend(
  key: FixtureKey,
  counters: DiscoveryCounters,
  options: {
    readonly includeSwap: boolean;
    readonly resolvePoolKey: boolean;
  },
) {
  return {
    async getLogs(filter: LandedPoolDiscoveryLogFilter) {
      if (topicIncludes(filter, UNIV4_SWAP_TOPIC)) {
        counters.swapScans++;
        return options.includeSwap ? [swapLog(key)] : [];
      }
      if (topicIncludes(filter, UNIV4_INITIALIZE_TOPIC)) {
        counters.initializeScans++;
        return [];
      }
      return [];
    },
    async call() {
      counters.poolKeyCalls++;
      return options.resolvePoolKey
        ? ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "uint24", "int24", "address"],
            [
              key.currency0,
              key.currency1,
              key.fee,
              key.tickSpacing,
              key.hooks,
            ],
          )
        : "0x";
    },
  };
}

async function discover(
  families: readonly SwapAdapter[],
  key: FixtureKey,
  mode: "per-event" | "union",
  counters: DiscoveryCounters,
  options: {
    readonly includeSwap: boolean;
    readonly resolvePoolKey: boolean;
    readonly retainedPools?: readonly PoolEntry[];
    readonly retryablePools?: readonly PoolEntry[];
  },
) {
  const registry = new AdapterFamilyRegistry([...families]);
  return discoverLandedPools({
    registry: registry.landedPoolDiscovery(),
    backend: discoveryBackend(key, counters, options),
    fromBlock: 100,
    toBlock: 100,
    batchSize: 10,
    minSwaps: 1,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    topicScanMode: mode,
    strict: true,
    ...(options.retainedPools === undefined
      ? {}
      : { retainedPools: options.retainedPools }),
    ...(options.retryablePools === undefined
      ? {}
      : { retryablePools: options.retryablePools }),
  });
}

async function assertSharedResolution(
  mode: "per-event" | "union",
): Promise<void> {
  const key = fixtureKey(ANGSTROM_MAINNET_HOOK);
  const standardCounters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const standard = await discover(
    [univ4Adapter],
    key,
    mode,
    standardCounters,
    { includeSwap: true, resolvePoolKey: true },
  );
  const sharedCounters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const sharedRegistry = new AdapterFamilyRegistry([
    univ4Adapter,
    angstromV4Adapter,
  ]);
  const sharedDescriptors = sharedRegistry
    .landedPoolDiscovery()
    .list()
    .filter((descriptor) =>
      descriptor.event.id === "univ4-swap" ||
      descriptor.event.id === "angstrom-v4-swap"
    );
  assert.equal(sharedDescriptors.length, 2);
  assert.equal(
    sharedDescriptors[0]?.sharedIdentityGroupKey,
    sharedDescriptors[1]?.sharedIdentityGroupKey,
  );
  assert.notEqual(
    sharedDescriptors[0]?.sourceFingerprint,
    sharedDescriptors[1]?.sourceFingerprint,
    "family projection version/owner must remain bound in source identity",
  );
  const shared = await discover(
    [univ4Adapter, angstromV4Adapter],
    key,
    mode,
    sharedCounters,
    { includeSwap: true, resolvePoolKey: true },
  );

  assert.equal(
    sharedCounters.poolKeyCalls,
    1,
    `${mode}: two V4 projections must share one PoolKey resolver call`,
  );
  assert.equal(
    sharedCounters.initializeScans,
    1,
    `${mode}: two V4 projections must share one Initialize scan`,
  );
  assert.equal(
    sharedCounters.swapScans,
    1,
    `${mode}: two V4 projections must share one physical Swap scan`,
  );
  const standardPool = standard.materializedPools.find(
    (pool) => pool.adapter === "univ4",
  );
  const sharedStandardPool = shared.materializedPools.find(
    (pool) => pool.adapter === "univ4",
  );
  assert.ok(standardPool);
  assert.deepEqual(
    sharedStandardPool,
    standardPool,
    `${mode}: adding a family projection must not mutate the standard row`,
  );
  const graphBackend = {
    async call() {
      throw new Error("inline V4 PoolKey must not read");
    },
  };
  const standardGraph = await buildTokenGraphWithResults(
    graphBackend,
    [standardPool],
    { quiet: true },
  );
  const sharedStandardGraph = await buildTokenGraphWithResults(
    graphBackend,
    [sharedStandardPool!],
    { quiet: true },
  );
  assert.deepEqual(
    sharedStandardGraph.edges,
    standardGraph.edges,
    `${mode}: adding a family projection must not mutate the standard graph`,
  );
  const angstromPool = shared.materializedPools.find(
    (pool) => pool.adapter === "angstrom-v4",
  );
  assert.ok(angstromPool);
  assert.equal(angstromPool.poolId, standardPool.poolId);
  assert.equal(angstromPool.hooks, standardPool.hooks);
  assert.equal(
    shared.coverage.filter((item) => item.complete).length,
    2,
  );
}

async function assertUnknownHookIsolated(): Promise<void> {
  const unknownSwapHook =
    "0x00000000000000000000000000000000000000cc";
  const key = fixtureKey(unknownSwapHook);
  const counters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const result = await discover(
    [univ4Adapter, angstromV4Adapter],
    key,
    "union",
    counters,
    { includeSwap: true, resolvePoolKey: true },
  );
  assert.equal(result.materializedPools.length, 1);
  assert.equal(result.materializedPools[0]?.adapter, "univ4");
  await assert.rejects(
    () =>
      new AdapterFamilyRegistry([univ4Adapter, angstromV4Adapter])
        .routes()
        .buildEdges(result.materializedPools[0]!, {
          async call() {
            throw new Error("inline PoolKey must not read");
          },
        }),
    /excludes swap-affecting hooks/,
  );
}

async function assertSharedRetry(
  mode: "per-event" | "union",
): Promise<void> {
  const key = fixtureKey(ANGSTROM_MAINNET_HOOK);
  const firstCounters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const incomplete = await discover(
    [univ4Adapter, angstromV4Adapter],
    key,
    mode,
    firstCounters,
    { includeSwap: true, resolvePoolKey: false },
  );
  assert.equal(firstCounters.poolKeyCalls, 1);
  assert.equal(incomplete.materializedPools.length, 0);
  assert.equal(
    incomplete.retryablePools.length,
    2,
    "one unresolved identity must project a retry to every subscriber",
  );
  assert.deepEqual(
    new Set(incomplete.retryablePools.map((pool) => pool.adapter)),
    new Set(["univ4", "angstrom-v4"]),
  );
  assert.deepEqual(
    new Set(incomplete.retryablePools.map((pool) =>
      (pool as PoolEntry & { readonly source?: string }).source
    )),
    new Set([
      "landed-event-retry:univ4-swap",
      "landed-event-retry:angstrom-v4-swap",
    ]),
    "each family retry must retain family-owned provenance",
  );

  const retryCounters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const healed = await discover(
    [univ4Adapter, angstromV4Adapter],
    key,
    mode,
    retryCounters,
    {
      includeSwap: false,
      resolvePoolKey: true,
      retryablePools: incomplete.retryablePools,
    },
  );
  assert.equal(
    retryCounters.poolKeyCalls,
    1,
    "two projected retries must dedupe to one physical PoolKey resolution",
  );
  assert.equal(healed.retryablePools.length, 0);
  assert.deepEqual(
    new Set(healed.materializedPools.map((pool) => pool.adapter)),
    new Set(["univ4", "angstrom-v4"]),
  );
}

function projectionVersionAdapter(version: string): SwapAdapter {
  const poolDiscovery = univ4Adapter.poolDiscovery;
  const sharedIdentity = poolDiscovery?.sharedIdentity;
  if (!poolDiscovery || !sharedIdentity) {
    throw new Error("univ4 fixture requires shared identity");
  }
  return Object.freeze({
    ...univ4Adapter,
    poolDiscovery: Object.freeze({
      ...poolDiscovery,
      sharedIdentity: Object.freeze({
        ...sharedIdentity,
        projection: Object.freeze({
          ...sharedIdentity.projection,
          version,
        }),
      }),
    }),
  }) as SwapAdapter;
}

function brokenAngstromProjection(): SwapAdapter {
  const poolDiscovery = angstromV4Adapter.poolDiscovery;
  const sharedIdentity = poolDiscovery?.sharedIdentity;
  if (!poolDiscovery || !sharedIdentity) {
    throw new Error("angstrom fixture requires shared identity");
  }
  return Object.freeze({
    ...angstromV4Adapter,
    poolDiscovery: Object.freeze({
      ...poolDiscovery,
      sharedIdentity: Object.freeze({
        ...sharedIdentity,
        projection: Object.freeze({
          ...sharedIdentity.projection,
          version: "angstrom-v4-mutating-projection-fixture-v1",
          projectPool(candidate: PoolEntry) {
            // Deliberately mutate the shared input before the healthy sibling.
            // The production coordinator must pass an isolated frozen snapshot.
            candidate.currency0 = ethers.ZeroAddress;
            return candidate;
          },
        }),
      }),
    }),
  }) as SwapAdapter;
}

function foreignOwnerAngstromProjection(): SwapAdapter {
  const poolDiscovery = angstromV4Adapter.poolDiscovery;
  const sharedIdentity = poolDiscovery?.sharedIdentity;
  if (!poolDiscovery || !sharedIdentity) {
    throw new Error("angstrom fixture requires shared identity");
  }
  return Object.freeze({
    ...angstromV4Adapter,
    poolDiscovery: Object.freeze({
      ...poolDiscovery,
      sharedIdentity: Object.freeze({
        ...sharedIdentity,
        projection: Object.freeze({
          ...sharedIdentity.projection,
          version: "angstrom-v4-foreign-owner-fixture-v1",
          projectPool(candidate: PoolEntry) {
            return {
              ...candidate,
              adapter: "univ4",
            };
          },
        }),
      }),
    }),
  }) as SwapAdapter;
}

function adapterWithSharedKernel(
  adapter: SwapAdapter,
  materializer: LandedPoolSharedIdentityMaterializer,
): SwapAdapter {
  const poolDiscovery = adapter.poolDiscovery;
  const sharedIdentity = poolDiscovery?.sharedIdentity;
  if (!poolDiscovery || !sharedIdentity) {
    throw new Error("shared-kernel fixture requires shared identity");
  }
  return Object.freeze({
    ...adapter,
    poolDiscovery: Object.freeze({
      ...poolDiscovery,
      sharedIdentity: Object.freeze({
        ...sharedIdentity,
        materializer,
      }),
    }),
  }) as SwapAdapter;
}

async function assertSharedKernelFailureIsGlobal(
  mode: "per-event" | "union",
): Promise<void> {
  const base = univ4Adapter.poolDiscovery?.sharedIdentity?.materializer;
  if (!base) throw new Error("univ4 fixture requires identity kernel");
  let kernelCalls = 0;
  const failingKernel = Object.freeze({
    ...base,
    async materialize() {
      kernelCalls++;
      throw new Error("shared kernel source-pinned failure");
    },
  });
  const counters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  await assert.rejects(
    () =>
      discover(
        [
          adapterWithSharedKernel(univ4Adapter, failingKernel),
          adapterWithSharedKernel(angstromV4Adapter, failingKernel),
        ],
        fixtureKey(ANGSTROM_MAINNET_HOOK),
        mode,
        counters,
        { includeSwap: true, resolvePoolKey: true },
      ),
    /shared kernel source-pinned failure/,
  );
  assert.equal(kernelCalls, 1);
  assert.equal(counters.swapScans, 1);
}

async function assertStrictProjectionIsolation(
  mode: "per-event" | "union",
): Promise<void> {
  const key = fixtureKey(ANGSTROM_MAINNET_HOOK);
  const baselineCounters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const baseline = await discover(
    [univ4Adapter],
    key,
    mode,
    baselineCounters,
    { includeSwap: true, resolvePoolKey: true },
  );
  const counters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const broken = brokenAngstromProjection();
  const projectionOrder = new AdapterFamilyRegistry([broken, univ4Adapter])
    .landedPoolDiscovery()
    .list()
    .filter((descriptor) => descriptor.sharedIdentityGroupKey !== null)
    .map((descriptor) => descriptor.event.id);
  assert.equal(
    projectionOrder[0],
    "angstrom-v4-swap",
    "mutation fixture must execute the broken projection before its sibling",
  );
  const result = await discover(
    [broken, univ4Adapter],
    key,
    mode,
    counters,
    { includeSwap: true, resolvePoolKey: true },
  );
  assert.deepEqual(
    {
      swapScans: counters.swapScans,
      initializeScans: counters.initializeScans,
      poolKeyCalls: counters.poolKeyCalls,
    },
    { swapScans: 1, initializeScans: 1, poolKeyCalls: 1 },
    `${mode}: a broken first projection must not duplicate physical work`,
  );
  const standardPool = result.materializedPools.find(
    (pool) => pool.adapter === "univ4",
  );
  assert.deepEqual(
    standardPool,
    baseline.materializedPools[0],
    `${mode}: strict projection failure must preserve the healthy row`,
  );
  assert.equal(
    result.coverage.find((coverage) =>
      coverage.familyId === univ4Adapter.id
    )?.complete,
    true,
  );
  assert.equal(
    result.coverage.find((coverage) =>
      coverage.familyId === angstromV4Adapter.id
    )?.complete,
    false,
  );
  assert.equal(result.retryablePools.length, 1);
  assert.equal(result.retryablePools[0]?.adapter, "angstrom-v4");
  assert.equal(
    (
      result.retryablePools[0] as
        | (PoolEntry & { readonly source?: string })
        | undefined
    )?.source,
    "landed-event-retry:angstrom-v4-swap",
  );

  const healthySharedCounters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const healthyShared = await discover(
    [univ4Adapter, angstromV4Adapter],
    key,
    mode,
    healthySharedCounters,
    { includeSwap: true, resolvePoolKey: true },
  );
  const currentPools = [...healthyShared.materializedPools];
  const graphBackend = {
    async call() {
      throw new Error("inline PoolKey graph projection must not read");
    },
  };
  const currentGraph = await buildTokenGraphWithResults(
    graphBackend,
    currentPools,
    { quiet: true },
  );
  assert(
    currentGraph.edges.some((edge) =>
      new AdapterFamilyRegistry([univ4Adapter, angstromV4Adapter])
        .routes()
        .forEdge(edge.adapterId).id === angstromV4Adapter.id
    ),
    "isolation fixture requires incumbent Angstrom edges",
  );
  const registry = new AdapterFamilyRegistry([univ4Adapter, broken]);
  const incompleteFamilyIds = new Set(
    result.coverage
      .filter((coverage) => !coverage.complete)
      .map((coverage) => coverage.familyId),
  );
  const projection = await prepareRuntimePoolRefresh({
    backend: graphBackend,
    freshPools: [],
    currentBackrunPools: currentPools,
    currentBackrunGraph: currentGraph.edges,
    currentBlockscanGraph: currentGraph.edges,
    buildStrategyViews: (pools, suppressed = new Set<string>()) =>
      buildStrategyViews(
        pools,
        currentPools.filter((pool) =>
          !suppressed.has(poolProjectionRowKey(pool))
        ),
        [],
        {
        blockscanMaxPools: 10,
        poolUniverseGeneratedAt: "2026-07-29T00:00:00.000Z",
        },
      ),
    isolatedFamilyIds: incompleteFamilyIds,
    familyIdForPool: (pool) =>
      registry.routes().findForPool(pool.adapter)?.id ?? null,
    familyIdForEdge: (edge) =>
      registry.routes().forEdge(edge.adapterId).id,
  });
  assert.equal(
    projection.delta.isolatedPoolKeys?.length,
    1,
    `${mode}: publication delta must carry the exact bad-family pool key`,
  );
  assert(
    (projection.delta.isolatedEdgeKeys?.length ?? 0) > 0,
    `${mode}: publication delta must carry bad-family edge keys for CAS rebase`,
  );
  for (
    const pools of [
      projection.strategyViews.backrun,
      projection.strategyViews.blockscan,
    ]
  ) {
    assert.equal(
      pools.some((pool) => pool.adapter === "angstrom-v4"),
      false,
      `${mode}: bad family incumbent pools must be quarantined`,
    );
    assert.equal(
      pools.some((pool) => pool.adapter === "univ4"),
      true,
      `${mode}: healthy standard pool must survive quarantine`,
    );
  }
  for (
    const edges of [
      projection.backrunGraph,
      projection.blockscanGraph ?? [],
    ]
  ) {
    assert.equal(
      edges.some((edge) =>
        registry.routes().forEdge(edge.adapterId).id ===
          angstromV4Adapter.id
      ),
      false,
      `${mode}: bad family incumbent edges must be quarantined`,
    );
  }

  const startupDiscovery = {
    pools: result.materializedPools,
    coverage: result.coverage,
    cacheRevalidation: result.cacheRevalidation,
  };
  const startupPools = mergeStartupActivePoolDiscovery(
    currentPools,
    startupDiscovery,
    (pool) => registry.routes().findForPool(pool.adapter)?.id ?? null,
  );
  const startupSupplements = filterStartupActivePoolIncumbents(
    currentPools,
    startupDiscovery,
    (pool) => registry.routes().findForPool(pool.adapter)?.id ?? null,
  );
  for (const pools of [startupPools, startupSupplements]) {
    assert.equal(
      pools.some((pool) => pool.adapter === "angstrom-v4"),
      false,
      `${mode}: startup publication must quarantine the incomplete family`,
    );
    assert.equal(
      pools.some((pool) => pool.adapter === "univ4"),
      true,
      `${mode}: startup publication must retain the healthy sibling`,
    );
  }
}

async function assertForeignProjectionOwnerIsolated(
  mode: "per-event" | "union",
): Promise<void> {
  const counters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const result = await discover(
    [univ4Adapter, foreignOwnerAngstromProjection()],
    fixtureKey(ANGSTROM_MAINNET_HOOK),
    mode,
    counters,
    { includeSwap: true, resolvePoolKey: true },
  );
  assert.equal(counters.poolKeyCalls, 1);
  assert.equal(
    result.materializedPools.filter((pool) => pool.adapter === "univ4").length,
    1,
    `${mode}: foreign projection output must not impersonate its sibling`,
  );
  assert.equal(
    result.coverage.find((item) => item.familyId === univ4Adapter.id)?.complete,
    true,
  );
  const foreignCoverage = result.coverage.find((item) =>
    item.familyId === angstromV4Adapter.id
  );
  assert.equal(foreignCoverage?.complete, false);
  assert.match(
    foreignCoverage?.issues.join("\n") ?? "",
    /foreign pool adapter/,
  );
}

async function assertConflictingCacheRevalidated(
  mode: "per-event" | "union",
): Promise<void> {
  const key = fixtureKey(ANGSTROM_MAINNET_HOOK);
  const seedCounters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const seed = await discover(
    [univ4Adapter, angstromV4Adapter],
    key,
    mode,
    seedCounters,
    { includeSwap: true, resolvePoolKey: true },
  );
  const standard = seed.materializedPools.find(
    (pool) => pool.adapter === "univ4",
  );
  const angstrom = seed.materializedPools.find(
    (pool) => pool.adapter === "angstrom-v4",
  );
  assert.ok(standard);
  assert.ok(angstrom);
  const poisonedAngstrom: PoolEntry = {
    ...angstrom,
    currency1: ethers.getAddress(
      "0x0000000000000000000000000000000000000099",
    ),
  };
  const counters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const healed = await discover(
    [univ4Adapter, angstromV4Adapter],
    key,
    mode,
    counters,
    {
      includeSwap: false,
      resolvePoolKey: true,
      retainedPools: [standard, poisonedAngstrom],
    },
  );
  assert.equal(
    counters.poolKeyCalls,
    1,
    `${mode}: conflicting family cache rows require one physical revalidation`,
  );
  assert.equal(healed.retryablePools.length, 0);
  assert.deepEqual(
    new Set(healed.materializedPools.map((pool) => pool.adapter)),
    new Set(["univ4", "angstrom-v4"]),
  );
  assert(
    healed.materializedPools.every((pool) =>
      pool.currency1?.toLowerCase() === key.currency1.toLowerCase()
    ),
    `${mode}: source result must replace every conflicting cache claim`,
  );

  const unresolvedCounters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const unresolved = await discover(
    [univ4Adapter, angstromV4Adapter],
    key,
    mode,
    unresolvedCounters,
    {
      includeSwap: false,
      resolvePoolKey: false,
      retainedPools: [standard, poisonedAngstrom],
    },
  );
  assert.equal(unresolvedCounters.poolKeyCalls, 1);
  assert.equal(unresolved.materializedPools.length, 0);
  assert.equal(unresolved.retryablePools.length, 2);
  assert(
    unresolved.coverage.every((coverage) => !coverage.complete),
    `${mode}: failed cache revalidation must remain family-attributed incomplete`,
  );

  await assertProductionConflictReplacement(
    mode,
    key,
    standard,
    angstrom,
    poisonedAngstrom,
  );
}

function productionDiscoveryProvider(
  key: FixtureKey,
  counters: DiscoveryCounters,
): ethers.JsonRpcProvider {
  const backend = discoveryBackend(key, counters, {
    includeSwap: false,
    resolvePoolKey: true,
  });
  return {
    async send(method: string, params: readonly unknown[]) {
      if (method !== "eth_getLogs") {
        throw new Error(`unexpected production discovery RPC ${method}`);
      }
      const filter = params[0] as {
        readonly address?: string;
        readonly topics: LandedPoolDiscoveryLogFilter["topics"];
        readonly fromBlock: string;
        readonly toBlock: string;
      };
      return backend.getLogs({
        ...(filter.address === undefined ? {} : { address: filter.address }),
        topics: filter.topics,
        fromBlock: Number(BigInt(filter.fromBlock)),
        toBlock: Number(BigInt(filter.toBlock)),
      });
    },
    call: backend.call,
    async getCode() {
      return "0x";
    },
  } as unknown as ethers.JsonRpcProvider;
}

async function assertProductionConflictReplacement(
  mode: "per-event" | "union",
  key: FixtureKey,
  standard: PoolEntry,
  canonicalAngstrom: PoolEntry,
  poisonedAngstrom: PoolEntry,
): Promise<void> {
  const counters = {
    poolKeyCalls: 0,
    initializeScans: 0,
    swapScans: 0,
  };
  const knownPoolKeys = new Set([
    poolRegistryKey(standard),
    poolRegistryKey(poisonedAngstrom),
  ]);
  const production = await scanActivePoolsDetailed(
    productionDiscoveryProvider(key, counters),
    0,
    Number.POSITIVE_INFINITY,
    100,
    {
      retainedPools: [standard, poisonedAngstrom],
      knownPoolKeys,
      identityBlockTag: 100,
      topicScanMode: mode,
      strict: true,
    },
  );
  assert.equal(
    counters.poolKeyCalls,
    1,
    `${mode}: production wrapper must preserve once-only PoolKey revalidation`,
  );
  assert.deepEqual(
    new Set(production.pools.map((pool) => pool.adapter)),
    new Set(["univ4", "angstrom-v4"]),
    `${mode}: revalidated rows must bypass the known-pool fast path`,
  );
  assert.deepEqual(
    new Set(production.cacheRevalidation.stalePoolKeys),
    new Set([
      poolProjectionRowKey(standard),
      poolProjectionRowKey(poisonedAngstrom),
    ]),
  );

  const registry = new AdapterFamilyRegistry([
    univ4Adapter,
    angstromV4Adapter,
  ]);
  const ownerForPool = (pool: PoolEntry): string | null =>
    registry.routes().findForPool(pool.adapter)?.id ?? null;
  const startupPools = mergeStartupActivePoolDiscovery(
    [standard, poisonedAngstrom],
    production,
    ownerForPool,
  );
  assert.equal(startupPools.length, 2);
  assert(
    startupPools.every((pool) =>
      pool.currency1?.toLowerCase() === key.currency1.toLowerCase()
    ),
    `${mode}: startup path must replace, not first-win, stale cache rows`,
  );

  const graphBackend = {
    async call() {
      throw new Error("inline PoolKey graph projection must not read");
    },
  };
  const incumbentGraph = await buildTokenGraphWithResults(
    graphBackend,
    [standard, canonicalAngstrom],
    { quiet: true },
  );
  const candidates = selectRefreshCandidates(
    [],
    [...production.pools],
    knownPoolKeys,
    new Set(production.cacheRevalidation.revalidatedPoolKeys),
  );
  assert.equal(
    candidates.length,
    2,
    `${mode}: production refresh selection must retain revalidated known rows`,
  );
  const buildViews = (
    pools: PoolEntry[],
    suppressed: ReadonlySet<string> = new Set<string>(),
  ) =>
    buildStrategyViews(
      pools,
      [standard, poisonedAngstrom].filter((pool) =>
        !suppressed.has(poolProjectionRowKey(pool))
      ),
      [],
      {
        blockscanMaxPools: 10,
        poolUniverseGeneratedAt: "2026-07-29T00:00:00.000Z",
      },
    );
  const projection = await prepareRuntimePoolRefresh({
    backend: graphBackend,
    freshPools: candidates,
    knownPoolKeys,
    currentBackrunPools: [standard, poisonedAngstrom],
    currentBlockscanPools: [standard, poisonedAngstrom],
    currentBackrunGraph: incumbentGraph.edges,
    currentBlockscanGraph: incumbentGraph.edges,
    buildStrategyViews: buildViews,
    replacedPoolKeys: new Set(
      production.cacheRevalidation.stalePoolKeys,
    ),
    revalidatedPoolKeys: new Set(
      production.cacheRevalidation.revalidatedPoolKeys,
    ),
    familyIdForPool: ownerForPool,
    familyIdForEdge: (edge) =>
      registry.routes().forEdge(edge.adapterId).id,
    instanceKeyForPool: (pool) =>
      routeInstanceKey(registry.routes().forPool(pool.adapter), pool),
  });
  assert.equal(projection.delta.replacedPoolKeys?.length, 2);
  assert(
    (projection.delta.replacedEdgeKeys?.length ?? 0) > 0,
    `${mode}: production delta must remove stale instance edges`,
  );
  assert(
    projection.strategyViews.backrun.every((pool) =>
      pool.currency1?.toLowerCase() === key.currency1.toLowerCase()
    ),
    `${mode}: runtime publication must atomically publish canonical rows`,
  );
  assert(
    production.pools.every((pool) =>
      projection.knownPoolKeys.has(poolProjectionRowKey(pool))
    ),
    `${mode}: canonical replacement rows must remain known after stale-key deletion`,
  );
  assert(
    projection.strategyViews.blockscan.every((pool) =>
      pool.currency1?.toLowerCase() === key.currency1.toLowerCase()
    ),
    `${mode}: supplemental universe must not reintroduce a stale row`,
  );
  const unrelatedRefresh = applyRuntimePoolRefreshDelta({
    delta: {
      attemptedPools: [],
      successfulBuilds: [],
      failedPools: [],
    },
    currentBackrunPools: projection.strategyViews.backrun,
    currentBackrunGraph: projection.backrunGraph,
    currentBlockscanGraph: projection.blockscanGraph,
    knownPoolKeys: projection.knownPoolKeys,
    suppressedPoolKeys: projection.suppressedPoolKeys,
    buildStrategyViews: buildViews,
  });
  assert(
    unrelatedRefresh.strategyViews.blockscan.every((pool) =>
      pool.currency1?.toLowerCase() === key.currency1.toLowerCase()
    ),
    `${mode}: a later unrelated refresh must retain stale-row tombstones`,
  );
}

function assertProjectionVersionFingerprint(): void {
  const first = new AdapterFamilyRegistry([
    projectionVersionAdapter("projection-fingerprint-v1"),
  ]).landedPoolDiscovery().list()[0];
  const second = new AdapterFamilyRegistry([
    projectionVersionAdapter("projection-fingerprint-v2"),
  ]).landedPoolDiscovery().list()[0];
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.event.id, second.event.id);
  assert.equal(first.event.discovery.poolAdapter, second.event.discovery.poolAdapter);
  assert.notEqual(
    first.sourceFingerprint,
    second.sourceFingerprint,
    "projectionVersion alone must invalidate discovery source evidence",
  );
}

async function assertAdaptiveSourceMismatchIsImmediate(): Promise<void> {
  let reads = 0;
  await assert.rejects(
    () =>
      resolveV4InitsBackward(
        {
          async getLogs() {
            reads++;
            throw new LandedPoolDiscoverySourceMismatchError(
              "fixture source mismatch",
            );
          },
        },
        poolManager,
        UNIV4_INITIALIZE_TOPIC,
        [ethers.keccak256(ethers.toUtf8Bytes("missing-pool"))],
        100,
        100,
        100,
      ),
    (error) => isLandedPoolDiscoverySourceMismatchError(error),
  );
  assert.equal(
    reads,
    1,
    "typed source mismatch must bypass adaptive range splitting",
  );
}

function directContext(): LandedPoolMaterializationContext {
  const event = new AdapterFamilyRegistry([univ4Adapter])
    .landedEvents()
    .eventsForFamily(univ4Adapter.id)[0]!;
  return {
    familyId: univ4Adapter.id,
    event,
    logs: [],
    retainedPools: [],
    retryablePools: [],
    isKnownPool: () => false,
    fromBlock: 100,
    toBlock: 100,
    minSwaps: 1,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    historicalResolution: "complete",
    backend: {
      async getLogs() {
        return [];
      },
      async call() {
        throw new Error("projection fixture must not call");
      },
    },
    async scanLogs() {
      return { logs: [], complete: true, issues: [] };
    },
  };
}

async function assertProjectionIntegrity(): Promise<void> {
  const key = fixtureKey(ANGSTROM_MAINNET_HOOK);
  const pool: PoolEntry & {
    readonly swapCount30d: number;
    readonly lastSwapBlock: number;
  } = {
    address: poolManager,
    adapter: "univ4",
    poolId: v4PoolId(key),
    currency0: key.currency0,
    currency1: key.currency1,
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
    fixedTokenIn: key.currency0,
    fixedTokenOut: key.currency1,
    score: 3,
    swapCount30d: 3,
    lastSwapBlock: 100,
  };
  const materializer = Object.freeze({
    id: "projection-integrity-fixture",
    version: "v1",
    identityKey: (candidate: PoolEntry) => candidate.poolId!,
    revalidationPool: (candidate: PoolEntry) => candidate,
    async materialize() {
      return { pools: [pool], complete: true };
    },
  });
  const projection = (
    mutate: (candidate: PoolEntry) => PoolEntry,
  ): LandedPoolSharedIdentityCapability => ({
    materializer,
    projection: {
      version: "bad-v1",
      toIdentityPool: (candidate) => candidate,
      projectPool: mutate,
      projectRetry: (candidate) => candidate,
    },
  });
  await assert.rejects(
    () =>
      materializeSharedLandedPoolIdentity(
        projection((candidate) => ({
          ...candidate,
          poolId: ethers.ZeroHash,
        })),
        directContext(),
      ),
    /mutated|conflicting poolId/,
  );
  await assert.rejects(
    () =>
      materializeSharedLandedPoolIdentity(
        projection((candidate) => ({
          ...candidate,
          score: (candidate.score ?? 0) + 1,
        })),
        directContext(),
      ),
    /mutated score/,
  );

  let materializeCalls = 0;
  const isolatingMaterializer = Object.freeze({
    ...materializer,
    async materialize() {
      materializeCalls++;
      return { pools: [pool], complete: true };
    },
  });
  const healthy: LandedPoolSharedIdentityCapability = {
    materializer: isolatingMaterializer,
    projection: {
      version: "healthy-v1",
      toIdentityPool: (candidate) => candidate,
      projectPool: (candidate) => candidate,
      projectRetry: (candidate) => candidate,
    },
  };
  const broken: LandedPoolSharedIdentityCapability = {
    materializer: isolatingMaterializer,
    projection: {
      version: "broken-v1",
      toIdentityPool: (candidate) => candidate,
      projectPool: (candidate) => ({
        ...candidate,
        score: (candidate.score ?? 0) + 1,
      }),
      projectRetry: (candidate) => candidate,
    },
  };
  const outcomes = await materializeSharedLandedPoolIdentityMembers([
    {
      id: "healthy",
      context: directContext(),
      sharedIdentity: healthy,
    },
    {
      id: "broken",
      context: directContext(),
      sharedIdentity: broken,
    },
  ]);
  assert.equal(materializeCalls, 1);
  const healthyOutcome = outcomes.get("healthy");
  const brokenOutcome = outcomes.get("broken");
  assert.equal(healthyOutcome?.scope, "success");
  assert.deepEqual(
    healthyOutcome?.scope === "success"
      ? healthyOutcome.result.pools
      : [],
    [pool],
  );
  assert.equal(brokenOutcome?.scope, "projection");
  assert.match(
    String(
      brokenOutcome?.scope === "projection"
        ? brokenOutcome.error
        : "",
    ),
    /mutated score/,
    "a broken family projection must fail only its own outcome",
  );
}

await assertSharedResolution("per-event");
await assertSharedResolution("union");
await assertUnknownHookIsolated();
await assertSharedRetry("per-event");
await assertSharedRetry("union");
await assertStrictProjectionIsolation("per-event");
await assertStrictProjectionIsolation("union");
await assertForeignProjectionOwnerIsolated("per-event");
await assertForeignProjectionOwnerIsolated("union");
await assertSharedKernelFailureIsGlobal("per-event");
await assertSharedKernelFailureIsGlobal("union");
await assertConflictingCacheRevalidated("per-event");
await assertConflictingCacheRevalidated("union");
assertProjectionVersionFingerprint();
await assertAdaptiveSourceMismatchIsImmediate();
await assertProjectionIntegrity();

console.log("angstrom-v4-shared-poolkey-discovery PASS");

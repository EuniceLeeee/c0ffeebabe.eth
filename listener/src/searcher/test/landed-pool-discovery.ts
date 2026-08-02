import { ethers } from "ethers";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import {
  defineSwapLandedEvents,
  LandedEventRegistry,
  singletonIndexedAddressEmitter,
  singletonIndexedBytes32Emitter,
} from "../venues/landed-event-registry.js";
import {
  createAddressLandedPoolMaterializer,
  discoverLandedPools,
  LandedPoolDiscoveryRegistry,
  type LandedPoolActivity,
  type LandedPoolDiscoveryLog,
  type LandedPoolDiscoveryReadBackend,
  type LandedPoolMaterializationCapability,
} from "../venues/landed-pool-discovery.js";
import { isKnownDexPoolProjection } from "../active-pool-discovery.js";
import { selectMatureDexActivity } from "../build-active-pool-universe.js";
import { poolProjectionRowKey } from "../pool-universe.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_IDENTITY_RESOLVERS,
} from "../venues/production-registry.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "../venues/admission.js";
import { poolAdapterId } from "../venues/registry-ids.js";
import type { PoolEntry } from "../planner/token-graph.js";
import type { SwapAdapter } from "../venues/route-leg-adapter.js";
import {
  FLUID_DEX_SWAP_TOPIC,
  fluidDexAdapter,
} from "../venues/swaps/fluid-dex.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { retainVerifiedSwapFamilyInstances } from "../venues/swap-family-inventory.js";
import { curveUnderlyingAdapter } from "../venues/swaps/curve-underlying.js";
import { CURVE_METAREGISTRY } from "../venues/curve-underlying.js";
import {
  EKUBO_CORE,
  EKUBO_CORE_SWAP_DATA_BYTES,
  EKUBO_ROUTER,
} from "../venues/swaps/ekubo/abi.js";
import {
  EKUBO_IDENTITY_SOURCE,
  EKUBO_POOL_ADAPTER_ID,
  EKUBO_VENUE_ID,
} from "../venues/swaps/ekubo/ids.js";
import {
  createEkuboPoolKeyBinding,
  ekuboPoolId,
  normalizeEkuboPoolKey,
} from "../venues/swaps/ekubo/pool-key.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const singleton = ethers.getAddress(
  "0x000000000000000000000000000000000000D100",
);
const pool = ethers.getAddress(
  "0x000000000000000000000000000000000000D200",
);
const addressTopic = ethers.id("CustomAddressSwap(address,uint256)");
const bytesTopic = ethers.id("CustomBytesSwap(bytes32,uint256)");
const poolId = `0x${"ab".repeat(32)}`;
const addressAdapter = poolAdapterId("test-singleton-address-pool");
const bytesAdapter = poolAdapterId("test-singleton-bytes32-pool");
const base = PRODUCTION_ADAPTER_FAMILIES.swaps()[0];
const {
  matureDexUniverseDiscovery: _baseMatureDexUniverseDiscovery,
  ...nonMatureBase
} = base;

function family(input: {
  readonly id: `custom-swap:${string}`;
  readonly poolAdapter: typeof addressAdapter;
  readonly topic: string;
  readonly eventId: string;
  readonly emitter:
    | ReturnType<typeof singletonIndexedAddressEmitter>
    | ReturnType<typeof singletonIndexedBytes32Emitter>;
  readonly materialization?: "generic" | "family";
  readonly poolDiscovery?: LandedPoolMaterializationCapability;
  readonly matureDexUniverseDiscovery?: true;
}): SwapAdapter {
  const landedEvents = defineSwapLandedEvents({
    swaps: [{
      id: input.eventId,
      topic: input.topic,
      emitter: input.emitter,
      ...(input.materialization === undefined
        ? {}
        : { materialization: input.materialization }),
      discovery: {
        poolAdapter: input.poolAdapter,
        label: input.id,
      },
      invalidatesWarmState: true,
    }],
    mutations: [],
  });
  return {
    ...nonMatureBase,
    id: input.id,
    ...(input.matureDexUniverseDiscovery === true
      ? { matureDexUniverseDiscovery: true as const }
      : {}),
    poolAdapters: [input.poolAdapter],
    identityPolicies: [{
      poolAdapter: input.poolAdapter,
      policy: "trusted-singleton-seed",
      canonicalAddress: singleton,
      canonicalVenueId: "univ4",
      canonicalIdentitySource: "seed",
    }],
    landedEvents,
    ...(input.poolDiscovery === undefined
      ? {}
      : { poolDiscovery: input.poolDiscovery }),
    observation: {
      ...base.observation,
      topics: [input.topic],
      canonicalIntakeTargets: [singleton],
    },
    victimModel: {
      id: `pool-swap:${input.eventId}`,
      mode: "detect-only",
    },
  };
}

function log(
  topic: string,
  indexed: string,
): LandedPoolDiscoveryLog {
  return {
    address: singleton,
    topics: [topic, indexed],
    data: "0x",
    blockNumber: 100,
  };
}

async function testBoundedProductionUnionBatching(): Promise<void> {
  const fromBlock = 100;
  const toBlock = fromBlock + 511;
  const emptyFilters: Array<{
    readonly fromBlock: number;
    readonly toBlock: number;
  }> = [];
  const empty = await discoverLandedPools({
    registry: PRODUCTION_ADAPTER_FAMILIES.landedPoolDiscovery(),
    backend: {
      async getLogs(filter) {
        emptyFilters.push(filter);
        return [];
      },
      async call() {
        throw new Error("an empty bounded source must not require identity reads");
      },
    },
    fromBlock,
    toBlock,
    batchSize: 50,
    minSwaps: 1,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    topicScanMode: "union",
    historicalResolution: "complete",
    strict: true,
  });
  assert(
    empty.coverage.every((item) => item.complete) &&
      emptyFilters.length === 3 &&
      emptyFilters.every((filter) =>
        filter.fromBlock === fromBlock && filter.toBlock === toBlock
      ),
    "a 512-block production union must use one topic scan, one anonymous scan, and one V4 Initialize scan",
  );

  const poolKey = normalizeEkuboPoolKey({
    token0: ethers.getAddress(
      "0x0000000000000000000000000000000000000001",
    ),
    token1: ethers.getAddress(
      "0x0000000000000000000000000000000000000002",
    ),
    config: ethers.ZeroHash,
  });
  const retainedPoolId = ekuboPoolId(poolKey);
  const retainedEkubo: PoolEntry = Object.freeze({
    address: ethers.getAddress(EKUBO_ROUTER),
    receiptEmitters: [ethers.getAddress(EKUBO_CORE)],
    adapter: EKUBO_POOL_ADAPTER_ID,
    venueId: EKUBO_VENUE_ID,
    identitySource: EKUBO_IDENTITY_SOURCE,
    token0: poolKey.token0,
    token1: poolKey.token1,
    poolId: retainedPoolId,
    routeBinding: createEkuboPoolKeyBinding(poolKey),
  });
  const anonymousSwapData = ethers.concat([
    singleton,
    retainedPoolId,
    ethers.ZeroHash,
    ethers.ZeroHash,
  ]);
  assert(
    (anonymousSwapData.length - 2) / 2 === EKUBO_CORE_SWAP_DATA_BYTES,
    "Ekubo batching fixture must have the canonical anonymous log width",
  );
  const activeFilters: Array<{
    readonly fromBlock: number;
    readonly toBlock: number;
  }> = [];
  const active = await discoverLandedPools({
    registry: PRODUCTION_ADAPTER_FAMILIES.landedPoolDiscovery(),
    backend: {
      async getLogs(filter) {
        activeFilters.push(filter);
        if (
          filter.address?.toLowerCase() === EKUBO_CORE.toLowerCase() &&
          filter.topics.length === 0
        ) {
          return [{
            address: EKUBO_CORE,
            topics: [],
            data: anonymousSwapData,
            blockNumber: fromBlock,
          }];
        }
        return [];
      },
      async call() {
        throw new Error("retained Ekubo identity must not require RPC calls");
      },
    },
    fromBlock,
    toBlock,
    batchSize: 50,
    minSwaps: 1,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    retainedPools: [retainedEkubo],
    topicScanMode: "union",
    historicalResolution: "complete",
    strict: true,
  });
  assert(
    active.coverage.every((item) => item.complete) &&
      active.materializedPools.some((item) =>
        item.adapter === EKUBO_POOL_ADAPTER_ID &&
        item.poolId === retainedPoolId
      ) &&
      activeFilters.length === 4 &&
      activeFilters.every((filter) =>
        filter.fromBlock === fromBlock && filter.toBlock === toBlock
      ),
    "an active Ekubo chunk must add only one bounded Initialize request",
  );
}

async function testBoundedUnionSplitFallback(): Promise<void> {
  const fromBlock = 100;
  const toBlock = fromBlock + 511;
  const ranges: string[] = [];
  let rejectedWideRange = false;
  const result = await discoverLandedPools({
    registry: addressRegistry.landedPoolDiscovery(),
    backend: {
      async getLogs(filter) {
        ranges.push(`${filter.fromBlock}-${filter.toBlock}`);
        if (
          !rejectedWideRange &&
          filter.fromBlock === fromBlock &&
          filter.toBlock === toBlock
        ) {
          rejectedWideRange = true;
          throw new Error("fixture provider range limit");
        }
        return [{
          ...log(addressTopic, ethers.zeroPadValue(pool, 32)),
          blockNumber: filter.fromBlock,
        }];
      },
      async call() {
        throw new Error("split fallback fixture must not call");
      },
    },
    fromBlock,
    toBlock,
    batchSize: 50,
    minSwaps: 1,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    topicScanMode: "union",
    strict: true,
  });
  assert(
    result.coverage.every((item) => item.complete) &&
      result.activity.get(pool.toLowerCase())?.count === 2 &&
      ranges.length === 3 &&
      ranges.includes(`${fromBlock}-${toBlock}`) &&
      ranges.includes(`${fromBlock}-${fromBlock + 255}`) &&
      ranges.includes(`${fromBlock + 256}-${toBlock}`),
    "a provider range failure must bisect the complete 512-block source without dropping either half",
  );
}

async function testBoundedUnionCancellation(): Promise<void> {
  const fromBlock = 100;
  const toBlock = fromBlock + 511;
  const controller = new AbortController();
  const reason = new Error("fixture bounded union cancelled");
  let requestCount = 0;
  let observedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pending = discoverLandedPools({
    registry: addressRegistry.landedPoolDiscovery(),
    backend: {
      async getLogs(_filter, control) {
        requestCount++;
        observedSignal = control?.signal;
        markStarted();
        return await new Promise<never>((_resolve, reject) => {
          const signal = control?.signal;
          if (!signal) {
            reject(new Error("bounded union request omitted AbortSignal"));
            return;
          }
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
      async call() {
        throw new Error("cancelled bounded union must not call");
      },
    },
    fromBlock,
    toBlock,
    batchSize: 50,
    minSwaps: 1,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    topicScanMode: "union",
    signal: controller.signal,
    strict: true,
  });
  await started;
  controller.abort(reason);
  let observed: unknown = null;
  try {
    await pending;
  } catch (error) {
    observed = error;
  }
  assert(
    observed === reason &&
      observedSignal === controller.signal &&
      requestCount === 1,
    "cancelling a coalesced request must abort its transport and must not start split retries",
  );
}

const addressFamily = family({
  id: "custom-swap:singleton-address-discovery",
  poolAdapter: addressAdapter,
  topic: addressTopic,
  eventId: "custom-singleton-address",
  emitter: singletonIndexedAddressEmitter(singleton, 1),
  matureDexUniverseDiscovery: true,
});
const addressRegistry = new AdapterFamilyRegistry([addressFamily]);
const addressResult = await discoverLandedPools({
  registry: addressRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs() {
      return [log(addressTopic, ethers.zeroPadValue(pool, 32))];
    },
    async call() {
      throw new Error("generic address discovery must not call");
    },
  },
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  strict: true,
});
assert(
  addressResult.activity.get(pool.toLowerCase())
    ?.adapterCounts.get(addressAdapter) === 1,
  "registered singleton-address family must enter discovery without a central branch",
);
assert(
  addressResult.coverage.length === 1 &&
    addressResult.coverage[0].consumed &&
    addressResult.coverage[0].complete,
  "singleton-address coverage requires the registered descriptor to be consumed",
);

await testBoundedProductionUnionBatching();
await testBoundedUnionSplitFallback();
await testBoundedUnionCancellation();

const syntheticToken0 = ethers.getAddress(
  "0x000000000000000000000000000000000000D301",
);
const syntheticToken1 = ethers.getAddress(
  "0x000000000000000000000000000000000000D302",
);
let syntheticMaterializationCalls = 0;
const syntheticAddressMaterializer = createAddressLandedPoolMaterializer({
  version: "synthetic-address-family-v1",
  eventIds: ["custom-family-address"],
  async materializePool(candidate) {
    syntheticMaterializationCalls++;
    return {
      address: candidate.address,
      adapter: candidate.poolAdapter,
      token0: syntheticToken0,
      token1: syntheticToken1,
    };
  },
});
const syntheticAddressFamily: SwapAdapter = {
  ...family({
    id: "custom-swap:family-owned-address-discovery",
    poolAdapter: addressAdapter,
    topic: addressTopic,
    eventId: "custom-family-address",
    emitter: singletonIndexedAddressEmitter(singleton, 1),
    materialization: "family",
    poolDiscovery: syntheticAddressMaterializer,
  }),
  async buildEdges(candidate) {
    if (!candidate.token0 || !candidate.token1) {
      throw new Error("synthetic family metadata missing");
    }
    const taxonomy = deriveEdgeTaxonomy("swap");
    return [
      {
        adapterId: "univ2-swap",
        target: candidate.address,
        tokenIn: candidate.token0,
        tokenOut: candidate.token1,
        poolToken0: candidate.token0,
        poolToken1: candidate.token1,
        slotKind: "swap",
        ...taxonomy,
      },
      {
        adapterId: "univ2-swap",
        target: candidate.address,
        tokenIn: candidate.token1,
        tokenOut: candidate.token0,
        poolToken0: candidate.token0,
        poolToken1: candidate.token1,
        slotKind: "swap",
        ...taxonomy,
      },
    ];
  },
};
const syntheticAddressRegistry = new AdapterFamilyRegistry([
  syntheticAddressFamily,
]);
const syntheticAddressResult = await discoverLandedPools({
  registry: syntheticAddressRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs() {
      return [log(addressTopic, ethers.zeroPadValue(pool, 32))];
    },
    async call() {
      throw new Error("synthetic metadata materializer must not call");
    },
  },
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  strict: true,
});
assert(
  syntheticAddressResult.activity.size === 0 &&
    syntheticAddressResult.materializedPools.length === 1 &&
    syntheticAddressResult.materializedPools[0].address === pool &&
    syntheticAddressResult.materializedPools[0].adapter === addressAdapter &&
    syntheticAddressResult.materializedPools[0].token0 === syntheticToken0 &&
    syntheticAddressResult.materializedPools[0].token1 === syntheticToken1 &&
    syntheticAddressResult.materializedPools[0].score === 1,
  "a newly registered non-V2/V3 address family must materialize without a central enrichment branch",
);
const syntheticEdges = await syntheticAddressRegistry.routes().buildEdges(
  syntheticAddressResult.materializedPools[0],
  {
    async call() {
      throw new Error("synthetic graph projection must use family metadata");
    },
  },
);
assert(
  syntheticEdges.length === 2 &&
    syntheticEdges[0].tokenIn === syntheticToken0 &&
    syntheticEdges[1].tokenIn === syntheticToken1,
  "the registered synthetic family must project its materialized pool into graph edges",
);

const slowAdapter = poolAdapterId("test-slow-landed-family");
const healthyAdapter = poolAdapterId("test-healthy-landed-family");
const slowTopic = ethers.id("SlowFamilySwap(address)");
const slowAlternateTopic = ethers.id("SlowFamilyAlternateSwap(address)");
const healthyTopic = ethers.id("HealthyFamilySwap(address)");
let slowFamilyAborted = false;
let healthyStartedBeforeSlowAbort = false;
let slowFamilyShouldTimeout = true;
let slowFamilyCalls = 0;
const slowMaterializer = createAddressLandedPoolMaterializer({
  version: "slow-family-timeout-v1",
  eventIds: ["slow-family-swap", "slow-family-alternate-swap"],
  materializationTimeoutMs: 30,
  async materializePool(candidate, context) {
    slowFamilyCalls++;
    if (!slowFamilyShouldTimeout) {
      return {
        address: candidate.address,
        adapter: candidate.poolAdapter,
        token0: syntheticToken0,
        token1: syntheticToken1,
      };
    }
    return await new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        slowFamilyAborted = true;
        reject(context.signal?.reason ?? new Error("slow family aborted"));
      };
      context.signal?.addEventListener("abort", onAbort, { once: true });
      if (context.signal?.aborted) onAbort();
    });
  },
});
const healthyMaterializer = createAddressLandedPoolMaterializer({
  version: "healthy-family-v1",
  eventIds: ["healthy-family-swap"],
  materializationTimeoutMs: 30,
  async materializePool(candidate) {
    healthyStartedBeforeSlowAbort = !slowFamilyAborted;
    return {
      address: candidate.address,
      adapter: candidate.poolAdapter,
      token0: syntheticToken0,
      token1: syntheticToken1,
    };
  },
});
const slowFamilyBase = family({
  id: "custom-swap:slow-landed-family",
  poolAdapter: slowAdapter,
  topic: slowTopic,
  eventId: "slow-family-swap",
  emitter: singletonIndexedAddressEmitter(singleton, 1),
  materialization: "family",
  poolDiscovery: slowMaterializer,
});
const slowFamily = {
  ...slowFamilyBase,
  landedEvents: defineSwapLandedEvents({
    swaps: [
      slowFamilyBase.landedEvents.swaps[0],
      {
        ...slowFamilyBase.landedEvents.swaps[0],
        id: "slow-family-alternate-swap",
        topic: slowAlternateTopic,
      },
    ],
    mutations: [],
  }),
  observation: {
    ...slowFamilyBase.observation,
    topics: [slowTopic, slowAlternateTopic],
  },
} satisfies SwapAdapter;
const healthyFamily = family({
  id: "custom-swap:healthy-landed-family",
  poolAdapter: healthyAdapter,
  topic: healthyTopic,
  eventId: "healthy-family-swap",
  emitter: singletonIndexedAddressEmitter(singleton, 1),
  materialization: "family",
  poolDiscovery: healthyMaterializer,
});
const isolatedRegistry = new LandedPoolDiscoveryRegistry(
  [slowFamily, healthyFamily],
  new LandedEventRegistry([slowFamily, healthyFamily]),
);
const isolatedResult = await discoverLandedPools({
  registry: isolatedRegistry,
  backend: {
    async getLogs() {
      return [
        log(slowTopic, ethers.zeroPadValue(pool, 32)),
        log(healthyTopic, ethers.zeroPadValue(pool, 32)),
      ];
    },
    async call() {
      throw new Error("isolated materializers must not use the fallback backend");
    },
  },
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  topicScanMode: "union",
  strict: true,
});
assert(
  slowFamilyAborted &&
    healthyStartedBeforeSlowAbort &&
    isolatedResult.coverage.some((item) =>
      item.familyId === slowFamily.id && !item.complete
    ) &&
    isolatedResult.coverage
      .filter((item) => item.familyId === healthyFamily.id)
      .every((item) => item.complete) &&
    isolatedResult.retryablePools.length === 1 &&
    isolatedResult.retryablePools[0].adapter === slowAdapter &&
    isolatedResult.materializedPools.some((item) =>
      item.adapter === healthyAdapter
    ),
  "a timed-out family must stay incomplete while a healthy sibling publishes",
);
slowFamilyShouldTimeout = false;
const recoveredIsolatedResult = await discoverLandedPools({
  registry: isolatedRegistry,
  backend: {
    async getLogs() {
      return [];
    },
    async call() {
      throw new Error("recovery must stay inside the family materializer");
    },
  },
  fromBlock: 101,
  toBlock: 101,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  retryablePools: isolatedResult.retryablePools,
  topicScanMode: "union",
  strict: true,
});
assert(
  slowFamilyCalls === 2 &&
    recoveredIsolatedResult.retryablePools.length === 0 &&
    recoveredIsolatedResult.coverage.every((item) => item.complete) &&
    recoveredIsolatedResult.materializedPools.some((item) =>
      item.adapter === slowAdapter &&
      (item as PoolEntry & { readonly lastSwapBlock?: number })
        .lastSwapBlock === 100
    ),
  "an event-bound retry must recover once without fabricating current-block activity",
);

const materializerCallsBeforeRawFailure = slowFamilyCalls;
let rawSourceFailureRejected = false;
try {
  await discoverLandedPools({
    registry: isolatedRegistry,
    backend: {
      async getLogs() {
        throw new Error("raw log transport unavailable");
      },
      async call() {
        throw new Error("raw source failure must not reach materialization");
      },
    },
    fromBlock: 102,
    toBlock: 102,
    batchSize: 10,
    minSwaps: 1,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    topicScanMode: "union",
    strict: true,
  });
} catch (error) {
  rawSourceFailureRejected =
    error instanceof Error &&
    error.message.includes("landed-pool source incomplete");
}
assert(
  rawSourceFailureRejected &&
    slowFamilyCalls === materializerCallsBeforeRawFailure,
  "strict raw landed-log failure must abort source publication before any family materializer",
);

const knownSyntheticPool = syntheticAddressResult.materializedPools[0];
const unknownSyntheticPool = ethers.getAddress(
  "0x000000000000000000000000000000000000D203",
);
const knownSyntheticResult = await discoverLandedPools({
  registry: syntheticAddressRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs() {
      return [
        log(addressTopic, ethers.zeroPadValue(pool, 32)),
        log(addressTopic, ethers.zeroPadValue(unknownSyntheticPool, 32)),
      ];
    },
    async call() {
      throw new Error("known family instance must reuse admitted metadata");
    },
  },
  fromBlock: 101,
  toBlock: 101,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  retainedPools: [knownSyntheticPool],
  isKnownPool: (candidate) => candidate === knownSyntheticPool,
  strict: true,
});
assert(
  syntheticMaterializationCalls === 2 &&
    knownSyntheticResult.materializedPools.length === 2 &&
    knownSyntheticResult.materializedPools.some((item) =>
      item.address === pool
    ) &&
    knownSyntheticResult.materializedPools.some((item) =>
      item.address === unknownSyntheticPool
    ) &&
    knownSyntheticResult.coverage.every((item) => item.complete),
  "known family instances skip repeated probes while unknown siblings still materialize",
);

const ownerQualifiedKnownPool = Object.freeze({
  ...knownSyntheticPool,
  discoveryOwnerAdapterId: syntheticAddressFamily.id,
});
const ownerQualifiedKnownKeys = new Set([
  poolProjectionRowKey(ownerQualifiedKnownPool),
]);
const ownerQualifiedKnownResult = await discoverLandedPools({
  registry: syntheticAddressRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs() {
      return [log(addressTopic, ethers.zeroPadValue(pool, 32))];
    },
    async call() {
      throw new Error(
        "owner-qualified known family instance must not repeat identity RPC",
      );
    },
  },
  fromBlock: 102,
  toBlock: 102,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  retainedPools: [ownerQualifiedKnownPool],
  isKnownPool: (candidate) =>
    isKnownDexPoolProjection(candidate, ownerQualifiedKnownKeys),
  strict: true,
});
assert(
  syntheticMaterializationCalls === 2 &&
    ownerQualifiedKnownResult.materializedPools.length === 1 &&
    ownerQualifiedKnownResult.materializedPools[0]
      .discoveryOwnerAdapterId === syntheticAddressFamily.id &&
    ownerQualifiedKnownResult.coverage.every((item) => item.complete),
  "owner-qualified swap-family rows must reuse their verified projection key",
);

let missingAddressMaterializerRejected = false;
try {
  new AdapterFamilyRegistry([family({
    id: "custom-swap:missing-address-materializer",
    poolAdapter: addressAdapter,
    topic: addressTopic,
    eventId: "custom-missing-address-materializer",
    emitter: singletonIndexedAddressEmitter(singleton, 1),
  })]);
} catch {
  missingAddressMaterializerRejected = true;
}
assert(
  missingAddressMaterializerRejected,
  "a non-mature address family without a typed materializer must fail at registry startup",
);

const bytesMaterializer = Object.freeze({
  version: "custom-bytes32-v1",
  eventIds: ["custom-singleton-bytes32"],
  async materialize(context) {
    return {
      pools: context.logs.map(() => ({
        address: singleton,
        adapter: bytesAdapter,
        poolId,
        fixedTokenIn: pool,
        fixedTokenOut: singleton,
      })),
      complete: true,
    };
  },
} satisfies LandedPoolMaterializationCapability);
const bytesFamily = family({
  id: "custom-swap:singleton-bytes32-discovery",
  poolAdapter: bytesAdapter,
  topic: bytesTopic,
  eventId: "custom-singleton-bytes32",
  emitter: singletonIndexedBytes32Emitter(singleton, 1),
  materialization: "family",
  poolDiscovery: bytesMaterializer,
});
const bytesRegistry = new AdapterFamilyRegistry([bytesFamily]);
const bytesResult = await discoverLandedPools({
  registry: bytesRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs() {
      return [log(bytesTopic, poolId)];
    },
    async call() {
      throw new Error("fixture materializer must not call");
    },
  },
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  strict: true,
});
assert(
  bytesResult.materializedPools.length === 1 &&
    bytesResult.materializedPools[0].poolId === poolId,
  "registered bytes32 family materializer must enter the universe automatically",
);

let missingMaterializerRejected = false;
try {
  new AdapterFamilyRegistry([family({
    id: "custom-swap:missing-bytes32-materializer",
    poolAdapter: bytesAdapter,
    topic: bytesTopic,
    eventId: "custom-missing-bytes32",
    emitter: singletonIndexedBytes32Emitter(singleton, 1),
  })]);
} catch {
  missingMaterializerRejected = true;
}
assert(
  missingMaterializerRejected,
  "bytes32 singleton without a family materializer must fail at registry startup",
);

const incompleteMaterializer = {
  ...bytesMaterializer,
  version: "custom-bytes32-incomplete-v1",
  async materialize() {
    return { pools: [], complete: false, issues: ["metadata unavailable"] };
  },
} satisfies LandedPoolMaterializationCapability;
const incompleteRegistry = new AdapterFamilyRegistry([family({
  id: "custom-swap:incomplete-bytes32-discovery",
  poolAdapter: bytesAdapter,
  topic: bytesTopic,
  eventId: "custom-singleton-bytes32",
  emitter: singletonIndexedBytes32Emitter(singleton, 1),
  materialization: "family",
  poolDiscovery: incompleteMaterializer,
})]);
const incomplete = await discoverLandedPools({
  registry: incompleteRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs() {
      return [log(bytesTopic, poolId)];
    },
    async call() {
      return "0x";
    },
  },
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
});
assert(
  incomplete.coverage[0]?.complete === false,
  "unresolved materialization must not silently publish source completeness",
);
let strictOpaqueRetryRejected = false;
try {
  await discoverLandedPools({
    registry: incompleteRegistry.landedPoolDiscovery(),
    backend: {
      async getLogs() {
        return [log(bytesTopic, poolId)];
      },
      async call() {
        return "0x";
      },
    },
    fromBlock: 100,
    toBlock: 100,
    batchSize: 10,
    minSwaps: 1,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    strict: true,
  });
} catch (error) {
  strictOpaqueRetryRejected =
    error instanceof Error &&
    error.message.includes("incomplete without retry proof");
}
assert(
  strictOpaqueRetryRejected,
  "strict opaque materialization may not advance without a typed retry proof",
);

const fluidPool = ethers.getAddress(
  "0x000000000000000000000000000000000000F100",
);
const fluidFactory = ethers.getAddress(
  "0x000000000000000000000000000000000000F200",
);
const fluidToken0 = ethers.getAddress(
  "0x000000000000000000000000000000000000F301",
);
const fluidToken1 = ethers.getAddress(
  "0x000000000000000000000000000000000000F302",
);
const fluidOther = ethers.getAddress(
  "0x000000000000000000000000000000000000F400",
);
const fluidWord = `0x${"00".repeat(32)}`;
const fluidConstants = new ethers.Interface([
  "function constantsView() view returns ((uint256 dexId,address liquidity,address factory,(address shift,address admin,address colOperations,address debtOperations,address perfectOperationsAndSwapOut) implementations,address deployerContract,address token0,address token1,bytes32 supplyToken0Slot,bytes32 borrowToken0Slot,bytes32 supplyToken1Slot,bytes32 borrowToken1Slot,bytes32 exchangePriceToken0Slot,bytes32 exchangePriceToken1Slot,uint256 oracleMapping) constantsView_)",
]);
const fluidFactoryView = new ethers.Interface([
  "function getDexAddress(uint256 dexId) view returns (address)",
]);
const fluidRegistry = new AdapterFamilyRegistry([fluidDexAdapter]);
const fluidResult = await discoverLandedPools({
  registry: fluidRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs() {
      return [{
        address: fluidPool,
        topics: [FLUID_DEX_SWAP_TOPIC],
        data: "0x",
        blockNumber: 101,
      }];
    },
    async call(req) {
      const target = ethers.getAddress(req.to);
      const selector = req.data.slice(0, 10).toLowerCase();
      if (
        target === fluidPool &&
        selector === fluidConstants.getFunction("constantsView")!.selector
      ) {
        return fluidConstants.encodeFunctionResult("constantsView", [[
          7n,
          fluidOther,
          fluidFactory,
          [fluidOther, fluidOther, fluidOther, fluidOther, fluidOther],
          fluidOther,
          fluidToken0,
          fluidToken1,
          fluidWord,
          fluidWord,
          fluidWord,
          fluidWord,
          fluidWord,
          fluidWord,
          0n,
        ]]);
      }
      if (
        target === fluidFactory &&
        selector === fluidFactoryView.getFunction("getDexAddress")!.selector
      ) {
        return fluidFactoryView.encodeFunctionResult(
          "getDexAddress",
          [fluidPool],
        );
      }
      throw new Error(`unexpected Fluid materialization call ${target}`);
    },
    async getCode(address) {
      return [fluidToken0, fluidToken1].includes(ethers.getAddress(address))
        ? "0x60006000"
        : "0x";
    },
  },
  fromBlock: 101,
  toBlock: 101,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  strict: true,
});
assert(
  fluidResult.activity.size === 0 &&
    fluidResult.materializedPools.length === 1 &&
    fluidResult.materializedPools[0].address === fluidPool &&
    fluidResult.materializedPools[0].adapter === "fluid-dex" &&
    fluidResult.materializedPools[0].token0 === fluidToken0 &&
    fluidResult.materializedPools[0].token1 === fluidToken1 &&
    fluidResult.materializedPools[0].factory === fluidFactory,
  "Fluid event metadata must be owned by the registered Fluid family materializer",
);

const largeSliceLogCount = 150_000;
const largeSlice = await discoverLandedPools({
  registry: addressRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs() {
      const logs: LandedPoolDiscoveryLog[] = [];
      for (let index = 0; index < largeSliceLogCount; index += 1) {
        logs.push(log(addressTopic, ethers.zeroPadValue(pool, 32)));
      }
      return logs;
    },
    async call() {
      throw new Error("large generic discovery must not call");
    },
  },
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  strict: true,
});
assert(
  largeSlice.logCountsByEventId.get("custom-singleton-address") ===
    largeSliceLogCount &&
    largeSlice.activity.get(pool.toLowerCase())?.count === largeSliceLogCount,
  "a production-sized log slice must aggregate without a call-stack limit",
);

const largeMaterializedSlice = await discoverLandedPools({
  registry: bytesRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs() {
      const logs: LandedPoolDiscoveryLog[] = [];
      for (let index = 0; index < largeSliceLogCount; index += 1) {
        logs.push(log(bytesTopic, poolId));
      }
      return logs;
    },
    async call() {
      throw new Error("large family discovery must not call");
    },
  },
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  topicScanMode: "union",
  strict: true,
});
assert(
  largeMaterializedSlice.materializedPools.length === largeSliceLogCount &&
    largeMaterializedSlice.logCountsByEventId.get(
      "custom-singleton-bytes32",
    ) === largeSliceLogCount,
  "a production-sized family materialization must aggregate without a call-stack limit",
);

const streamed = await discoverLandedPools({
  registry: addressRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs(filter) {
      return [{
        ...log(addressTopic, ethers.zeroPadValue(pool, 32)),
        blockNumber: filter.fromBlock,
      }];
    },
    async call() {
      throw new Error("streamed generic discovery must not call");
    },
  },
  fromBlock: 100,
  toBlock: 102,
  batchSize: 1,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  strict: true,
});
assert(
  streamed.logCountsByEventId.get("custom-singleton-address") === 3 &&
    streamed.activity.get(pool.toLowerCase())?.count === 3 &&
    streamed.activity.get(pool.toLowerCase())?.lastSwapBlock === 102,
  "generic address discovery must fold every response slice exactly once",
);

const unionFamily: SwapAdapter = {
  ...base,
  id: "custom-swap:union-discovery",
  poolAdapters: [addressAdapter, bytesAdapter],
  identityPolicies: [
    {
      poolAdapter: addressAdapter,
      policy: "trusted-singleton-seed",
      canonicalAddress: singleton,
      canonicalVenueId: "univ4",
      canonicalIdentitySource: "seed",
    },
    {
      poolAdapter: bytesAdapter,
      policy: "trusted-singleton-seed",
      canonicalAddress: singleton,
      canonicalVenueId: "univ4",
      canonicalIdentitySource: "seed",
    },
  ],
  landedEvents: defineSwapLandedEvents({
    swaps: [
      {
        id: "custom-singleton-address",
        topic: addressTopic,
        emitter: singletonIndexedAddressEmitter(singleton, 1),
        discovery: {
          poolAdapter: addressAdapter,
          label: "custom-address-union",
        },
        invalidatesWarmState: true,
      },
      {
        id: "custom-singleton-bytes32",
        topic: bytesTopic,
        emitter: singletonIndexedBytes32Emitter(singleton, 1),
        materialization: "family",
        discovery: {
          poolAdapter: bytesAdapter,
          label: "custom-bytes-union",
        },
        invalidatesWarmState: true,
      },
    ],
    mutations: [],
  }),
  poolDiscovery: bytesMaterializer,
  observation: {
    ...base.observation,
    topics: [addressTopic, bytesTopic],
    canonicalIntakeTargets: [singleton],
  },
  victimModel: {
    id: "pool-swap:custom-union",
    mode: "detect-only",
  },
};
const unionRegistry = new AdapterFamilyRegistry([unionFamily]);
const unionFilters: unknown[] = [];
const unionFixtureLogs = [
  log(addressTopic, ethers.zeroPadValue(pool, 32)),
  log(bytesTopic, poolId),
  {
    ...log(bytesTopic, poolId),
    address: ethers.getAddress(
      "0x000000000000000000000000000000000000D999",
    ),
  },
];
const fixtureBackend = (
  recordFilters: boolean,
): LandedPoolDiscoveryReadBackend => ({
  async getLogs(filter) {
    if (recordFilters) unionFilters.push(filter);
    const topic0 = filter.topics[0];
    const acceptedTopics = new Set(
      Array.isArray(topic0) ? topic0 : [topic0],
    );
    return unionFixtureLogs.filter((entry) =>
      acceptedTopics.has(entry.topics[0]) &&
      (
        filter.address === undefined ||
        entry.address.toLowerCase() === filter.address.toLowerCase()
      )
    );
  },
  async call() {
    throw new Error("union fixture materializer must not call");
  },
});
const perEventEquivalent = await discoverLandedPools({
  registry: unionRegistry.landedPoolDiscovery(),
  backend: fixtureBackend(false),
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  topicScanMode: "per-event",
  strict: true,
});
const unionResult = await discoverLandedPools({
  registry: unionRegistry.landedPoolDiscovery(),
  backend: fixtureBackend(true),
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  topicScanMode: "union",
  strict: true,
});
assert(
  unionFilters.length === 1 &&
    Array.isArray(
      (unionFilters[0] as { topics: readonly unknown[] }).topics[0],
    ),
  "union scan must consume all registered event topics in one range read",
);
assert(
  unionResult.activity.get(pool.toLowerCase())
      ?.adapterCounts.get(addressAdapter) === 1 &&
    unionResult.materializedPools.length === 1 &&
    unionResult.logCountsByEventId.get("custom-singleton-address") === 1 &&
    unionResult.logCountsByEventId.get("custom-singleton-bytes32") === 1,
  "union scan must dispatch generic/materialized logs exactly once and reject foreign singleton emitters",
);
assert(
  JSON.stringify(discoverySummary(unionResult)) ===
    JSON.stringify(discoverySummary(perEventEquivalent)),
  "union and per-event discovery must publish identical ordered output",
);

let activeUnionSlices = 0;
let maxActiveUnionSlices = 0;
const parallelUnion = await discoverLandedPools({
  registry: addressRegistry.landedPoolDiscovery(),
  backend: {
    async getLogs(filter) {
      activeUnionSlices++;
      maxActiveUnionSlices = Math.max(
        maxActiveUnionSlices,
        activeUnionSlices,
      );
      try {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, filter.fromBlock === 100 ? 15 : 1)
        );
        return [{
          ...log(addressTopic, ethers.zeroPadValue(pool, 32)),
          blockNumber: filter.fromBlock,
        }];
      } finally {
        activeUnionSlices--;
      }
    },
    async call() {
      throw new Error("parallel generic discovery must not call");
    },
  },
  fromBlock: 100,
  toBlock: 612,
  batchSize: 128,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  topicScanMode: "union",
  strict: true,
});
assert(
  maxActiveUnionSlices === 4 &&
    parallelUnion.activity.get(pool.toLowerCase())?.count === 5 &&
    parallelUnion.activity.get(pool.toLowerCase())?.lastSwapBlock === 612,
  "union ranges above the bounded catch-up unit must still read slices concurrently and fold deterministically",
);

const mixedActivity = new Map<string, LandedPoolActivity>([
  ["v2-only", {
    address: pool,
    adapterCounts: new Map<PoolEntry["adapter"], number>([["univ2", 4]]),
    count: 4,
    lastSwapBlock: 100,
  }],
  ["family-only", {
    address: singleton,
    adapterCounts: new Map<PoolEntry["adapter"], number>([[addressAdapter, 9]]),
    count: 9,
    lastSwapBlock: 101,
  }],
  ["mixed", {
    address: syntheticToken0,
    adapterCounts: new Map<PoolEntry["adapter"], number>([
      ["univ3", 3],
      [addressAdapter, 7],
    ]),
    count: 10,
    lastSwapBlock: 102,
  }],
]);
const matureActivity = selectMatureDexActivity(
  mixedActivity,
  new Set<PoolEntry["adapter"]>(["univ2", "univ3"]),
);
assert(
  matureActivity.size === 2 &&
    matureActivity.get("v2-only")?.count === 4 &&
    !matureActivity.has("family-only") &&
    matureActivity.get("mixed")?.count === 3 &&
    matureActivity.get("mixed")?.adapterCounts.size === 1 &&
    matureActivity.get("mixed")?.adapterCounts.get("univ3") === 3,
  "central enrichment must retain only mature V2/V3 activity even for a malformed mixed input",
);

const retainedCurvePool = ethers.getAddress(
  "0x000000000000000000000000000000000000C100",
);
const retainedCurveToken0 = ethers.getAddress(
  "0x000000000000000000000000000000000000C101",
);
const retainedCurveToken1 = ethers.getAddress(
  "0x000000000000000000000000000000000000C102",
);
const retainedCurveMetaIface = new ethers.Interface([
  "function get_registry_handlers_from_pool(address pool) view returns (address[10])",
]);
const retainedCurvePoolIface = new ethers.Interface([
  "function underlying_coins(int128 i) view returns (address)",
  "function get_dy_underlying(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
let retainedCurveReads = 0;
const retainedCurveBackend = {
  async call(req: { to: string; data: string }): Promise<string> {
    retainedCurveReads++;
    const target = ethers.getAddress(req.to);
    if (target === ethers.getAddress(CURVE_METAREGISTRY)) {
      return retainedCurveMetaIface.encodeFunctionResult(
        "get_registry_handlers_from_pool",
        [Array.from({ length: 10 }, () => ethers.ZeroAddress)],
      );
    }
    if (target !== retainedCurvePool) {
      throw new Error(`unexpected retained Curve target ${target}`);
    }
    if (
      req.data.slice(0, 10) ===
        retainedCurvePoolIface.getFunction("get_dy_underlying")!.selector
    ) {
      return retainedCurvePoolIface.encodeFunctionResult(
        "get_dy_underlying",
        [1n],
      );
    }
    const [index] = retainedCurvePoolIface.decodeFunctionData(
      "underlying_coins",
      req.data,
    );
    if (index === 0n || index === 1n) {
      return retainedCurvePoolIface.encodeFunctionResult(
        "underlying_coins",
        [index === 0n ? retainedCurveToken0 : retainedCurveToken1],
      );
    }
    throw Object.assign(new Error("curve coin index out of range"), {
      code: "CALL_EXCEPTION",
    });
  },
};
const retainedCurve = await retainVerifiedSwapFamilyInstances({
  families: [curveUnderlyingAdapter],
  identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  backend: retainedCurveBackend,
  priorPools: [{
    address: retainedCurvePool,
    adapter: "curve-underlying",
    underlyingCoins: [retainedCurveToken0, retainedCurveToken1],
    score: 1,
    swapCount30d: 1,
    lastSwapBlock: 90,
  }],
  freshPools: [],
});
assert(
  retainedCurve.candidates === 1 &&
    retainedCurve.pools.length === 1 &&
    retainedCurve.pools[0].address === retainedCurvePool &&
    retainedCurve.pools[0].score === 0 &&
    retainedCurve.pools[0].swapCount30d === 0 &&
    retainedCurve.pools[0].topologyRetained === true &&
    retainedCurve.pools[0].identitySource ===
      "curve-underlying-provisional",
  "a current-N re-attested low-frequency Curve family instance must remain topology without a fake activity score",
);
const readsAfterRetention = retainedCurveReads;
const freshlyObservedCurve = await retainVerifiedSwapFamilyInstances({
  families: [curveUnderlyingAdapter],
  identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  backend: retainedCurveBackend,
  priorPools: retainedCurve.pools,
  freshPools: [{
    address: retainedCurvePool,
    adapter: "curve-underlying",
    score: 2,
  }],
});
assert(
  freshlyObservedCurve.candidates === 0 &&
    freshlyObservedCurve.pools.length === 0 &&
    retainedCurveReads === readsAfterRetention,
  "fresh family activity must replace inventory without a duplicate identity read",
);

const nonUnderlyingCurveAddress = ethers.getAddress(
  "0x000000000000000000000000000000000000C200",
);
const curveUnderlyingEvent = curveUnderlyingAdapter.landedEvents.swaps[0];
const curveUnderlyingRegistry = new AdapterFamilyRegistry([
  curveUnderlyingAdapter,
]);
const falseUnderlyingEventBackend: LandedPoolDiscoveryReadBackend = {
  async getLogs(filter) {
    const topic0 = filter.topics[0];
    const accepted = new Set(Array.isArray(topic0) ? topic0 : [topic0]);
    return accepted.has(curveUnderlyingEvent.topic!)
      ? [{
          address: nonUnderlyingCurveAddress,
          topics: [curveUnderlyingEvent.topic!],
          data: "0x",
          blockNumber: 100,
        }]
      : [];
  },
  async call() {
    throw Object.assign(new Error("execution reverted"), {
      code: "CALL_EXCEPTION",
    });
  },
};
const falseUnderlyingEvent = await discoverLandedPools({
  registry: curveUnderlyingRegistry.landedPoolDiscovery(),
  backend: falseUnderlyingEventBackend,
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  topicScanMode: "union",
  strict: true,
});
assert(
  falseUnderlyingEvent.materializedPools.length === 0 &&
    falseUnderlyingEvent.coverage.every((item) => item.complete),
  "a canonical non-underlying ABI rejection must not poison strict landed coverage",
);

const transportIncomplete = await discoverLandedPools({
  registry: curveUnderlyingRegistry.landedPoolDiscovery(),
  backend: {
    ...falseUnderlyingEventBackend,
    async call() {
      throw Object.assign(new Error("connection reset"), {
        code: "NETWORK_ERROR",
      });
    },
  },
  fromBlock: 100,
  toBlock: 100,
  batchSize: 10,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  topicScanMode: "union",
  strict: true,
});
assert(
  transportIncomplete.materializedPools.length === 0 &&
    transportIncomplete.retryablePools.length === 1 &&
    transportIncomplete.coverage.some((item) =>
      !item.complete &&
      item.issues.length > 0
    ),
  "transport failure must stay explicit and fail closed for its owning family",
);

const productionRetryRegistry =
  PRODUCTION_ADAPTER_FAMILIES.landedPoolDiscovery();
assert(
  productionRetryRegistry.consumesAddressRetries("curve") &&
    productionRetryRegistry.consumesAddressRetries("curve-underlying") &&
    productionRetryRegistry.consumesAddressRetries("dodo-v2") &&
    productionRetryRegistry.consumesAddressRetries("fluid-dex") &&
    !productionRetryRegistry.consumesAddressRetries("balancer-v3") &&
    !productionRetryRegistry.consumesAddressRetries("univ4") &&
    productionRetryRegistry.consumesMaterializationRetries("univ4"),
  "address and opaque materializers should own only their typed retry routing",
);

console.log("landed-pool-discovery PASS (23/23)");

function discoverySummary(result: Awaited<ReturnType<typeof discoverLandedPools>>) {
  return {
    activity: [...result.activity].map(([key, item]) => [
      key,
      {
        address: item.address,
        adapters: [...item.adapterCounts],
        count: item.count,
        lastSwapBlock: item.lastSwapBlock,
      },
    ]),
    materializedPools: result.materializedPools,
    coverage: result.coverage,
    logCounts: [...result.logCountsByEventId],
  };
}

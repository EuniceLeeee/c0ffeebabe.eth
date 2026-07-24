import { ethers } from "ethers";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import {
  defineSwapLandedEvents,
  singletonIndexedAddressEmitter,
  singletonIndexedBytes32Emitter,
} from "../venues/landed-event-registry.js";
import {
  createAddressLandedPoolMaterializer,
  discoverLandedPools,
  type LandedPoolActivity,
  type LandedPoolDiscoveryLog,
  type LandedPoolDiscoveryReadBackend,
  type LandedPoolMaterializationCapability,
} from "../venues/landed-pool-discovery.js";
import { selectMatureDexActivity } from "../build-active-pool-universe.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "../venues/admission.js";
import { poolAdapterId } from "../venues/registry-ids.js";
import type { PoolEntry } from "../planner/token-graph.js";
import type { SwapAdapter } from "../venues/route-leg-adapter.js";
import {
  FLUID_DEX_SWAP_TOPIC,
  fluidDexAdapter,
} from "../venues/swaps/fluid-dex.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

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

const syntheticToken0 = ethers.getAddress(
  "0x000000000000000000000000000000000000D301",
);
const syntheticToken1 = ethers.getAddress(
  "0x000000000000000000000000000000000000D302",
);
const syntheticAddressMaterializer = createAddressLandedPoolMaterializer({
  version: "synthetic-address-family-v1",
  eventIds: ["custom-family-address"],
  async materializePool(candidate) {
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

console.log("landed-pool-discovery PASS (11/11)");

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

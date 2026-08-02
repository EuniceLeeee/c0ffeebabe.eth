import { ethers } from "ethers";
import { indexFactoryPools, scanActivePools } from "../active-pool-discovery.js";
import {
  CURVE_METAREGISTRY,
  assertIdentityResolverCoverage,
  attestPoolIdentities,
  factoryIdentityResolver,
  IdentityResolverRegistry,
  resolvePoolIdentity,
  type IdentityPoolEntry,
} from "../venues/identity.js";
import { resolveCurveUnderlyingMetadata } from "../venues/curve-underlying.js";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
} from "../venues/production-registry.js";
import {
  factoryDiscoverySourcesForPoolAdapters,
  findVenueByFactory,
  VENUE_IDENTITY_CATALOG,
} from "../venues/capability.js";
import { findV2LineageByFactory, V2_LINEAGES } from "../venues/v2-lineage.js";
import { v2FeeBpsForFactory } from "../solver/v2-fee.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "../venues/admission.js";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const factoryIface = new ethers.Interface([
  "function factory() view returns (address)",
  "function getPair(address tokenA,address tokenB) view returns (address)",
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);
const v2IdentityIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
]);
const v3IdentityIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const curveMetaRegistryIface = new ethers.Interface([
  "function get_registry_handlers_from_pool(address pool) view returns (address[10])",
  "function get_pool_from_lp_token(address token) view returns (address)",
  "function get_underlying_coins(address pool) view returns (address[8])",
  "function get_coins(address pool) view returns (address[8])",
]);
const curvePoolIface = new ethers.Interface([
  "function coins(uint256 i) view returns (address)",
]);
const curveUnderlyingPoolIface = new ethers.Interface([
  "function underlying_coins(int128 i) view returns (address)",
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);
const balancerV3VaultIface = new ethers.Interface([
  "function isPoolRegistered(address pool) view returns (bool)",
]);

const UNIV2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const SUSHI_V2_FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
const REPLAYED_V3_FORK_FACTORY = "0x075C42cD233a1c723c0F18f6dd575c8d679FEA85";
const PANORAMA_FACTORY = "0x82Eeb5A22A25310ac15352197d92d6C17A49602e";
const PANCAKE_V2_FACTORY = "0x1097053fd2ea711dad45caccc45eff7548fcb362";
const UNMEASURED_V2_LINEAGE = V2_LINEAGES.find(
  (descriptor) => descriptor.measuredFeeRule === null,
)!;
const UNKNOWN_FACTORY = address(0xfac7);
const CURVE_HANDLER = address(0xc0de);

const UNI_PAIR = address(0x101);
const SUSHI_PAIR = address(0x102);
const V3_FORK_POOL = "0x05dEf6d34631BbDd35e212CB749caCAEbf8c963D";
const PANORAMA_POOL = "0xf6de222adc615e298eebc39814490e90abe4aa13";
const UNKNOWN_PAIR = address(0x104);
const CURVE_POOL = address(0x105);
const UNREGISTERED_CURVE_POOL = address(0x106);
const FAKE_V4_MANAGER = address(0x107);
const PSM_SEED = address(0x108);
const FAKE_PSM = address(0x109);
const BALANCER_V3_POOL = address(0x10a);
const FAKE_BALANCER_V3_POOL = address(0x10b);
const PANCAKE_V2_PAIR = address(0x10c);
const CURVE_TOKEN0 = address(0x10d);
const CURVE_TOKEN1 = address(0x10e);
const FAKE_V3_POOL = address(0x10f);
const PROVISIONAL_V3_TOKEN0 = address(0x110);
const PROVISIONAL_V3_TOKEN1 = address(0x111);
const UNMEASURED_V2_PAIR = address(0x112);
const V2_TOKEN0 = address(0x122);
const V2_TOKEN1 = address(0x123);

const V2_SWAP_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const V3_SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const CURVE_SWAP_TOPIC = ethers.id("TokenExchange(address,int128,uint256,int128,uint256)");
const BALANCER_V3_SWAP_TOPIC = ethers.id(
  "Swap(address,address,address,uint256,uint256,uint256,uint256)",
);
const V2_PAIR_CREATED_TOPIC = ethers.id("PairCreated(address,address,address,uint256)");
const V3_POOL_CREATED_TOPIC = ethers.id(
  "PoolCreated(address,address,uint24,int24,address)",
);
const UNRELATED_FACTORY_TOPIC = ethers.id("UnrelatedFactoryEvent(address)");

class FakeProvider {
  readonly factoryCalls: string[] = [];
  readonly factoryIndexCalls: string[] = [];
  factoryIndexRequestCount = 0;
  readonly curveCalls: string[] = [];
  readonly factories = new Map<string, string>([
    [UNI_PAIR.toLowerCase(), UNIV2_FACTORY],
    [SUSHI_PAIR.toLowerCase(), SUSHI_V2_FACTORY],
    [V3_FORK_POOL.toLowerCase(), REPLAYED_V3_FORK_FACTORY],
    [PANORAMA_POOL.toLowerCase(), PANORAMA_FACTORY],
    [UNKNOWN_PAIR.toLowerCase(), UNKNOWN_FACTORY],
    [PANCAKE_V2_PAIR.toLowerCase(), PANCAKE_V2_FACTORY],
    [UNMEASURED_V2_PAIR.toLowerCase(), UNMEASURED_V2_LINEAGE.factory],
    [FAKE_V3_POOL.toLowerCase(), UNKNOWN_FACTORY],
  ]);
  readonly registeredCurvePools = new Set([CURVE_POOL.toLowerCase()]);
  readonly v2PairsByFactory = new Map<string, string>([
    [UNIV2_FACTORY.toLowerCase(), UNI_PAIR],
    [SUSHI_V2_FACTORY.toLowerCase(), SUSHI_PAIR],
    [PANCAKE_V2_FACTORY.toLowerCase(), PANCAKE_V2_PAIR],
    [UNMEASURED_V2_LINEAGE.factory.toLowerCase(), UNMEASURED_V2_PAIR],
    [UNKNOWN_FACTORY.toLowerCase(), UNKNOWN_PAIR],
  ]);

  constructor(private readonly rejectFactoryUnion = false) {}

  async getBlockNumber(): Promise<number> {
    throw new Error("pinned test must not query the head");
  }

  async send(
    method: string,
    args: Array<{
      address?: string | string[];
      topics?: Array<string | string[]>;
    }>,
  ): Promise<Array<{
    address: string;
    data?: string;
    topics?: string[];
    blockNumber?: string;
  }>> {
    assert(method === "eth_getLogs", `unexpected RPC method ${method}`);
    const requestedAddresses = (Array.isArray(args[0]?.address)
      ? args[0].address
      : args[0]?.address === undefined
        ? []
        : [args[0].address]
    ).map((address) => address.toLowerCase());
    const topic0 = args[0]?.topics?.[0];
    const requestedTopics = (Array.isArray(topic0)
      ? topic0
      : topic0 === undefined
        ? []
        : [topic0]
    ).map((topic) => topic.toLowerCase());
    const factoryDiscoveryRequest = requestedTopics.some((topic) =>
      topic === V2_PAIR_CREATED_TOPIC.toLowerCase() ||
      topic === V3_POOL_CREATED_TOPIC.toLowerCase()
    );
    if (factoryDiscoveryRequest) {
      this.factoryIndexRequestCount++;
      this.factoryIndexCalls.push(...requestedAddresses);
      if (this.rejectFactoryUnion && requestedAddresses.length > 1) {
        throw new Error("provider rejects multi-address log filters");
      }
      const logs: Array<{ address: string; data: string; topics: string[] }> = [];
      const encodedPair = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256"],
        [PANCAKE_V2_PAIR, 1n],
      );
      if (
        requestedAddresses.includes(PANCAKE_V2_FACTORY.toLowerCase()) &&
        requestedTopics.includes(V2_PAIR_CREATED_TOPIC.toLowerCase())
      ) {
        logs.push({
          address: PANCAKE_V2_FACTORY,
          data: encodedPair,
          topics: [V2_PAIR_CREATED_TOPIC],
        }, {
          address: UNKNOWN_FACTORY,
          data: encodedPair,
          topics: [V2_PAIR_CREATED_TOPIC],
        }, {
          address: PANCAKE_V2_FACTORY,
          data: encodedPair,
          topics: [UNRELATED_FACTORY_TOPIC],
        });
      }
      if (
        requestedAddresses.includes(REPLAYED_V3_FORK_FACTORY.toLowerCase()) &&
        requestedTopics.includes(V3_POOL_CREATED_TOPIC.toLowerCase())
      ) {
        logs.push({
          address: REPLAYED_V3_FORK_FACTORY,
          data: ethers.AbiCoder.defaultAbiCoder().encode(
            ["int24", "address"],
            [60, V3_FORK_POOL],
          ),
          topics: [V3_POOL_CREATED_TOPIC],
        });
      }
      return logs;
    }
    if (requestedTopics.includes(V2_SWAP_TOPIC.toLowerCase())) {
      return [UNI_PAIR, UNI_PAIR, SUSHI_PAIR, PANORAMA_POOL, UNKNOWN_PAIR]
        .map((address) => ({
          address,
          topics: [V2_SWAP_TOPIC],
          data: "0x",
          blockNumber: "0x3e8",
        }));
    }
    if (requestedTopics.includes(V3_SWAP_TOPIC.toLowerCase())) {
      return [{
        address: V3_FORK_POOL,
        topics: [V3_SWAP_TOPIC],
        data: "0x",
        blockNumber: "0x3e8",
      }];
    }
    if (requestedTopics.includes(CURVE_SWAP_TOPIC.toLowerCase())) {
      return [CURVE_POOL, UNREGISTERED_CURVE_POOL].map((address) => ({
        address,
        topics: [CURVE_SWAP_TOPIC],
        data: "0x",
        blockNumber: "0x3e8",
      }));
    }
    if (requestedTopics.includes(BALANCER_V3_SWAP_TOPIC.toLowerCase())) {
      return [{
        address: ADDR.BALANCER_V3_VAULT,
        topics: [
          BALANCER_V3_SWAP_TOPIC,
          ethers.zeroPadValue(BALANCER_V3_POOL, 32),
          ethers.zeroPadValue(ADDR.ROCKSOLID_RETH, 32),
          ethers.zeroPadValue(ADDR.RETH, 32),
        ],
        data: "0x",
        blockNumber: "0x3e8",
      }];
    }
    return [];
  }

  async call(req: { to: string; data: string }): Promise<string> {
    const target = req.to.toLowerCase();
    const selector = req.data.slice(0, 10).toLowerCase();
    if (
      selector === factoryIface.getFunction("getPair")!.selector &&
      this.v2PairsByFactory.has(target)
    ) {
      return factoryIface.encodeFunctionResult("getPair", [
        this.v2PairsByFactory.get(target)!,
      ]);
    }
    if (
      target === REPLAYED_V3_FORK_FACTORY.toLowerCase() &&
      selector === factoryIface.getFunction("getPool")!.selector
    ) {
      const [tokenA, tokenB, fee] = factoryIface.decodeFunctionData(
        "getPool",
        req.data,
      );
      const tokens = [String(tokenA).toLowerCase(), String(tokenB).toLowerCase()]
        .sort();
      const expected = [
        PROVISIONAL_V3_TOKEN0.toLowerCase(),
        PROVISIONAL_V3_TOKEN1.toLowerCase(),
      ].sort();
      return factoryIface.encodeFunctionResult("getPool", [
        tokens[0] === expected[0] &&
          tokens[1] === expected[1] &&
          BigInt(fee) === 3_000n
          ? V3_FORK_POOL
          : ethers.ZeroAddress,
      ]);
    }
    if (target === V3_FORK_POOL.toLowerCase()) {
      if (selector === v3IdentityIface.getFunction("token0")!.selector) {
        return v3IdentityIface.encodeFunctionResult("token0", [
          PROVISIONAL_V3_TOKEN0,
        ]);
      }
      if (selector === v3IdentityIface.getFunction("token1")!.selector) {
        return v3IdentityIface.encodeFunctionResult("token1", [
          PROVISIONAL_V3_TOKEN1,
        ]);
      }
      if (selector === v3IdentityIface.getFunction("fee")!.selector) {
        return v3IdentityIface.encodeFunctionResult("fee", [3_000]);
      }
    }
    if (
      target === UNKNOWN_PAIR.toLowerCase() ||
      target === FAKE_V3_POOL.toLowerCase()
    ) {
      if (selector === v3IdentityIface.getFunction("token0")!.selector) {
        return v3IdentityIface.encodeFunctionResult("token0", [
          PROVISIONAL_V3_TOKEN0,
        ]);
      }
      if (selector === v3IdentityIface.getFunction("token1")!.selector) {
        return v3IdentityIface.encodeFunctionResult("token1", [
          PROVISIONAL_V3_TOKEN1,
        ]);
      }
      if (selector === v3IdentityIface.getFunction("fee")!.selector) {
        return v3IdentityIface.encodeFunctionResult("fee", [3_000]);
      }
      if (selector === v3IdentityIface.getFunction("tickSpacing")!.selector) {
        return v3IdentityIface.encodeFunctionResult("tickSpacing", [60]);
      }
      if (selector === v3IdentityIface.getFunction("slot0")!.selector) {
        if (target === FAKE_V3_POOL.toLowerCase()) {
          throw Object.assign(new Error("slot0 execution reverted"), {
            code: "CALL_EXCEPTION",
          });
        }
        return v3IdentityIface.encodeFunctionResult("slot0", [
          0n,
          0,
          0,
          0,
          0,
          0,
          true,
        ]);
      }
      if (selector === v3IdentityIface.getFunction("liquidity")!.selector) {
        return v3IdentityIface.encodeFunctionResult("liquidity", [0n]);
      }
    }
    if (
      [
        UNI_PAIR,
        SUSHI_PAIR,
        PANCAKE_V2_PAIR,
        UNMEASURED_V2_PAIR,
        UNKNOWN_PAIR,
      ].some((pair) => pair.toLowerCase() === target)
    ) {
      if (selector === v2IdentityIface.getFunction("token0")!.selector) {
        return v2IdentityIface.encodeFunctionResult("token0", [V2_TOKEN0]);
      }
      if (selector === v2IdentityIface.getFunction("token1")!.selector) {
        return v2IdentityIface.encodeFunctionResult("token1", [V2_TOKEN1]);
      }
      if (selector === v2IdentityIface.getFunction("getReserves")!.selector) {
        return v2IdentityIface.encodeFunctionResult("getReserves", [
          1_000_000n,
          2_000_000n,
          1,
        ]);
      }
    }
    if (
      target === CURVE_POOL.toLowerCase() &&
      selector ===
        curvePoolIface.getFunction("coins")!.selector
    ) {
      const [index] = curvePoolIface.decodeFunctionData("coins", req.data);
      if (BigInt(index) > 1n) {
        throw Object.assign(new Error("curve coin index out of range"), {
          code: "CALL_EXCEPTION",
        });
      }
      return curvePoolIface.encodeFunctionResult(
        "coins",
        [BigInt(index) === 0n ? CURVE_TOKEN0 : CURVE_TOKEN1],
      );
    }
    if (target === CURVE_METAREGISTRY.toLowerCase()) {
      const decoded = curveMetaRegistryIface.decodeFunctionData(
        "get_registry_handlers_from_pool",
        req.data,
      );
      const pool = String(decoded[0]).toLowerCase();
      this.curveCalls.push(pool);
      const handlers = Array.from({ length: 10 }, () => ethers.ZeroAddress);
      if (this.registeredCurvePools.has(pool)) handlers[0] = CURVE_HANDLER;
      return curveMetaRegistryIface.encodeFunctionResult(
        "get_registry_handlers_from_pool",
        [handlers],
      );
    }
    if (target === ADDR.BALANCER_V3_VAULT.toLowerCase()) {
      const decoded = balancerV3VaultIface.decodeFunctionData("isPoolRegistered", req.data);
      const pool = String(decoded[0]).toLowerCase();
      return balancerV3VaultIface.encodeFunctionResult("isPoolRegistered", [
        pool === BALANCER_V3_POOL.toLowerCase(),
      ]);
    }

    assert(req.data.slice(0, 10) === factoryIface.getFunction("factory")!.selector, "expected factory() call");
    this.factoryCalls.push(target);
    const factory = this.factories.get(target);
    if (!factory) throw new Error("factory unavailable");
    return factoryIface.encodeFunctionResult("factory", [factory]);
  }
}

async function testV2LineageDescriptor(): Promise<void> {
  const factories = V2_LINEAGES.map((descriptor) => descriptor.factory.toLowerCase());
  assert(new Set(factories).size === factories.length, "V2 lineage factories must be unique");
  for (const descriptor of V2_LINEAGES) {
    const identity = findVenueByFactory(descriptor.factory);
    assert(identity?.venue === descriptor.venue, `${descriptor.venue} identity provenance`);
    assert(
      identity.compatibility === "standard" &&
        identity.poolAdapter === "univ2",
      `${descriptor.venue} V2 pool-shape identity`,
    );
    const routeSupported = PRODUCTION_ADAPTER_FAMILIES.routes().findForPool(
      "univ2",
    ) !== null;
    if (descriptor.measuredFeeRule && routeSupported) {
      assert(descriptor.measuredFeeRule !== null, `${descriptor.venue} production fee must be measured`);
      assert(
        v2FeeBpsForFactory(descriptor.factory) === descriptor.measuredFeeRule.feeBps,
        `${descriptor.venue} fee projection`,
      );
    }
  }

  const pancake = findV2LineageByFactory(PANCAKE_V2_FACTORY);
  assert(pancake?.venue === "pancake-v2", "Pancake V2 lineage identity");
  assert(
    PRODUCTION_ADAPTER_FAMILIES.routes().findForPool("univ2") !== null,
    "Pancake V2 execution support must come from the route registry",
  );
  assert(pancake.measuredFeeRule?.feeBps === 25n, "Pancake V2 measured fee");
  const productionFactorySources = factoryDiscoverySourcesForPoolAdapters(
    PRODUCTION_ADAPTER_FAMILIES.matureDexUniversePoolAdapters(),
  );
  assert(
    productionFactorySources.some((source) =>
      source.discovery.factories.some(
        (factory) => factory.toLowerCase() === PANCAKE_V2_FACTORY.toLowerCase(),
      )
    ),
    "measured V2 identity must join the registered mature family",
  );
  assert(
    productionFactorySources.some((source) =>
      source.discovery.factories.some(
        (factory) =>
          factory.toLowerCase() === UNMEASURED_V2_LINEAGE.factory.toLowerCase(),
      )
    ),
    "unmeasured V2 identity must remain a factory discovery source",
  );
  const registryWithoutV2 = new AdapterFamilyRegistry(
    PRODUCTION_ADAPTER_FAMILIES.list().filter(
      (family) => family.id !== "univ2-standard",
    ),
  );
  const withoutV2Family = factoryDiscoverySourcesForPoolAdapters(
    registryWithoutV2.matureDexUniversePoolAdapters(),
  );
  assert(
    withoutV2Family.every((source) => source.poolAdapter !== "univ2"),
    "an unregistered mature family must contribute no factory sources",
  );

  const provider = new FakeProvider();
  const identity = await resolvePoolIdentity(provider, PANCAKE_V2_PAIR, "univ2", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  });
  assert(identity.ok && identity.venueId === "pancake-v2", "Pancake V2 strict identity");
  assert(identity.ok && identity.adapter === "univ2", "Pancake V2 execution adapter");

  const indexed = await indexFactoryPools(provider as never, 1, 1_000);
  const pancakePool = indexed.find((pool) => pool.address === PANCAKE_V2_PAIR);
  assert(pancakePool?.adapter === "univ2", "Pancake V2 factory pool execution adapter");
  assert(
    indexed.filter((pool) => pool.address === PANCAKE_V2_PAIR).length === 1,
    "unknown factories and wrong topics must fail closed",
  );
  assert(pancakePool.venueId === "pancake-v2", "Pancake V2 factory pool venue identity");
  assert(
    pancakePool.factory?.toLowerCase() === PANCAKE_V2_FACTORY.toLowerCase(),
    "Pancake V2 factory provenance",
  );
  assert(
    provider.factoryIndexCalls.includes(PANCAKE_V2_FACTORY.toLowerCase()),
    "Pancake V2 factory must enter factory indexing",
  );
  assert(
    provider.factoryIndexRequestCount === 1,
    "all registered factories must share one log query per source batch",
  );
  const indexedV3 = indexed.find((pool) => pool.address === V3_FORK_POOL);
  assert(indexedV3?.adapter === "univ3", "union factory query must retain V3 pools");
  assert(
    indexed.indexOf(pancakePool) < indexed.indexOf(indexedV3),
    "union factory results must retain deterministic family order",
  );

  const fallbackProvider = new FakeProvider(true);
  const fallbackIndexed = await indexFactoryPools(
    fallbackProvider as never,
    1,
    1_000,
  );
  assert(
    fallbackIndexed.some((pool) => pool.address === PANCAKE_V2_PAIR) &&
      fallbackIndexed.some((pool) => pool.address === V3_FORK_POOL),
    "rejected union filters must fall back without losing V2 or V3 pools",
  );
  assert(
    fallbackProvider.factoryIndexRequestCount > 2,
    "union fallback must retry individual factories",
  );
  const unmeasured = await resolvePoolIdentity(
    provider,
    UNMEASURED_V2_PAIR,
    "univ2",
    { identityRegistry: PRODUCTION_IDENTITY_RESOLVERS },
  );
  assert(
    unmeasured.ok &&
      unmeasured.adapter === "univ2" &&
      v2FeeBpsForFactory(UNMEASURED_V2_LINEAGE.factory) === 30n,
    "known reverse-bound V2 lineage without a measured fee must use the default quote fee",
  );
  console.log("[venue-identity] V2 lineage identity/discovery/fee projection: PASS");
}

async function testResolverRejectsSelectorLookalikes(): Promise<void> {
  const provider = new FakeProvider();
  const malformedFactory = await resolvePoolIdentity(
    { call: async () => "0x" },
    address(0x112),
    "univ2",
    { identityRegistry: PRODUCTION_IDENTITY_RESOLVERS },
  );
  assert(
    !malformedFactory.ok && malformedFactory.reason === "behavior_mismatch",
    "successful factory call with malformed return is permanent negative proof",
  );
  const transportFailure = await resolvePoolIdentity(
    {
      call: async () => {
        throw new Error("transport unavailable");
      },
    },
    address(0x113),
    "univ2",
    { identityRegistry: PRODUCTION_IDENTITY_RESOLVERS },
  );
  assert(
    !transportFailure.ok &&
      transportFailure.reason === "identity_call_failed",
    "transport failure remains retryable",
  );
  const nonUnderlyingCurve = await resolvePoolIdentity(
    {
      call: async () => {
        throw Object.assign(new Error("execution reverted"), {
          code: "CALL_EXCEPTION",
        });
      },
    },
    address(0x114),
    "curve-underlying",
    {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    },
  );
  assert(
    !nonUnderlyingCurve.ok &&
      nonUnderlyingCurve.reason === "behavior_mismatch",
    "canonical underlying ABI rejection must be terminal negative evidence",
  );
  const metadataOnlyUnderlying = await resolvePoolIdentity(
    {
      async call(req: { to: string; data: string }): Promise<string> {
        if (
          ethers.getAddress(req.to) === ethers.getAddress(CURVE_METAREGISTRY)
        ) {
          return curveMetaRegistryIface.encodeFunctionResult(
            "get_registry_handlers_from_pool",
            [Array.from({ length: 10 }, () => ethers.ZeroAddress)],
          );
        }
        if (
          req.data.slice(0, 10) ===
            curveUnderlyingPoolIface.getFunction("underlying_coins")!.selector
        ) {
          const [index] = curveUnderlyingPoolIface.decodeFunctionData(
            "underlying_coins",
            req.data,
          );
          if (BigInt(index) > 1n) {
            throw Object.assign(new Error("coin index out of range"), {
              code: "CALL_EXCEPTION",
            });
          }
          return curveUnderlyingPoolIface.encodeFunctionResult(
            "underlying_coins",
            [BigInt(index) === 0n ? CURVE_TOKEN0 : CURVE_TOKEN1],
          );
        }
        throw Object.assign(new Error("execution selector unavailable"), {
          code: "CALL_EXCEPTION",
        });
      },
    },
    address(0x119),
    "curve-underlying",
    {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    },
  );
  assert(
    !metadataOnlyUnderlying.ok &&
      metadataOnlyUnderlying.reason === "behavior_mismatch",
    "metadata without an executable underlying direction must be terminal",
  );
  const compatibleMetaPool = address(0x116);
  const compatibleMetaCoin = address(0x201);
  const compatibleBaseLp = address(0x202);
  const compatibleBasePool = address(0x203);
  const compatibleBaseCoins = [
    address(0x204),
    address(0x205),
    address(0x206),
  ];
  const coinsBackedUnderlyingBackend = {
    async call(req: { to: string; data: string }): Promise<string> {
      const selector = req.data.slice(0, 10);
      if (
        ethers.getAddress(req.to) === ethers.getAddress(CURVE_METAREGISTRY)
      ) {
        if (
          selector === curveMetaRegistryIface.getFunction(
            "get_registry_handlers_from_pool",
          )!.selector
        ) {
          throw Object.assign(new Error("execution reverted"), {
            code: "CALL_EXCEPTION",
          });
        }
        if (
          selector === curveMetaRegistryIface.getFunction(
            "get_pool_from_lp_token",
          )!.selector
        ) {
          const [token] = curveMetaRegistryIface.decodeFunctionData(
            "get_pool_from_lp_token",
            req.data,
          );
          return curveMetaRegistryIface.encodeFunctionResult(
            "get_pool_from_lp_token",
            [
              ethers.getAddress(String(token)) === compatibleBaseLp
                ? compatibleBasePool
                : ethers.ZeroAddress,
            ],
          );
        }
        if (
          selector === curveMetaRegistryIface.getFunction(
            "get_underlying_coins",
          )!.selector
        ) {
          const [pool] = curveMetaRegistryIface.decodeFunctionData(
            "get_underlying_coins",
            req.data,
          );
          if (ethers.getAddress(String(pool)) !== compatibleBasePool) {
            throw Object.assign(new Error("no registry"), {
              code: "CALL_EXCEPTION",
            });
          }
          return curveMetaRegistryIface.encodeFunctionResult(
            "get_underlying_coins",
            [[
              ...compatibleBaseCoins,
              ...Array.from({ length: 5 }, () => ethers.ZeroAddress),
            ]],
          );
        }
        throw Object.assign(new Error(`unsupported registry selector ${selector}`), {
          code: "CALL_EXCEPTION",
        });
      }
      if (
        selector ===
          curveUnderlyingPoolIface.getFunction("underlying_coins")!.selector
      ) {
        throw Object.assign(new Error("execution reverted"), {
          code: "CALL_EXCEPTION",
        });
      }
      if (selector === curvePoolIface.getFunction("coins")!.selector) {
        const [index] = curvePoolIface.decodeFunctionData(
          "coins",
          req.data,
        );
        if (BigInt(index) > 1n) {
          throw Object.assign(new Error("coin index out of range"), {
            code: "CALL_EXCEPTION",
          });
        }
        return curvePoolIface.encodeFunctionResult(
          "coins",
          [
            BigInt(index) === 0n
              ? compatibleMetaCoin
              : compatibleBaseLp,
          ],
        );
      }
      if (
        selector ===
          curveUnderlyingPoolIface.getFunction("get_dy_underlying")!.selector
      ) {
        const [i, j, amountIn] =
          curveUnderlyingPoolIface.decodeFunctionData(
            "get_dy_underlying",
            req.data,
          );
        if (BigInt(i) > 3n || BigInt(j) > 3n) {
          throw Object.assign(new Error("unsupported quote"), {
            code: "CALL_EXCEPTION",
          });
        }
        return curveUnderlyingPoolIface.encodeFunctionResult(
          "get_dy_underlying",
          [BigInt(amountIn) < 10n ** 18n ? 0n : 1n],
        );
      }
      throw Object.assign(new Error(`unsupported selector ${selector}`), {
        code: "CALL_EXCEPTION",
      });
    },
  };
  const expandedMetaPool = await resolveCurveUnderlyingMetadata(
    coinsBackedUnderlyingBackend,
    compatibleMetaPool,
    { allowDirectPoolFallback: true },
  );
  assert(
    JSON.stringify(expandedMetaPool.coins) === JSON.stringify([
      compatibleMetaCoin,
      ...compatibleBaseCoins,
    ]),
    "Curve metapool LP token must expand to the underlying index domain",
  );
  const coinsBackedUnderlyingCurve = await resolvePoolIdentity(
    coinsBackedUnderlyingBackend,
    compatibleMetaPool,
    "curve-underlying",
    {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    },
  );
  assert(
    coinsBackedUnderlyingCurve.ok &&
      coinsBackedUnderlyingCurve.adapter === "curve-underlying",
    "coins + adaptive get_dy_underlying behavior must admit compatible venues",
  );
  const unprovenCoinsDomain = await resolvePoolIdentity(
    {
      async call(req: { to: string; data: string }): Promise<string> {
        if (
          ethers.getAddress(req.to) ===
            ethers.getAddress(CURVE_METAREGISTRY) &&
          req.data.slice(0, 10) ===
            curveMetaRegistryIface.getFunction(
              "get_pool_from_lp_token",
            )!.selector
        ) {
          return curveMetaRegistryIface.encodeFunctionResult(
            "get_pool_from_lp_token",
            [ethers.ZeroAddress],
          );
        }
        return coinsBackedUnderlyingBackend.call(req);
      },
    },
    address(0x117),
    "curve-underlying",
    {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    },
  );
  assert(
    !unprovenCoinsDomain.ok &&
      unprovenCoinsDomain.reason === "behavior_mismatch",
    "coins + quote without a uniquely proven base-LP slot must fail closed",
  );
  const ambiguousLpDomain = await resolvePoolIdentity(
    {
      async call(req: { to: string; data: string }): Promise<string> {
        if (
          ethers.getAddress(req.to) ===
            ethers.getAddress(CURVE_METAREGISTRY) &&
          req.data.slice(0, 10) ===
            curveMetaRegistryIface.getFunction(
              "get_pool_from_lp_token",
            )!.selector
        ) {
          return curveMetaRegistryIface.encodeFunctionResult(
            "get_pool_from_lp_token",
            [compatibleBasePool],
          );
        }
        return coinsBackedUnderlyingBackend.call(req);
      },
    },
    address(0x118),
    "curve-underlying",
    {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    },
  );
  assert(
    !ambiguousLpDomain.ok &&
      ambiguousLpDomain.reason === "behavior_mismatch",
    "multiple LP-token slots must not guess the underlying index layout",
  );
  let transientCurveAttempts = 0;
  const transientThenHealthyCurveBackend = {
    async call(req: { to: string; data: string }): Promise<string> {
      transientCurveAttempts++;
      if (transientCurveAttempts === 1) {
        throw Object.assign(new Error("connection reset"), {
          code: "NETWORK_ERROR",
        });
      }
      if (
        ethers.getAddress(req.to) === ethers.getAddress(CURVE_METAREGISTRY)
      ) {
        return curveMetaRegistryIface.encodeFunctionResult(
          "get_registry_handlers_from_pool",
          [Array.from({ length: 10 }, () => ethers.ZeroAddress)],
        );
      }
      if (
        req.data.slice(0, 10) ===
          curveUnderlyingPoolIface.getFunction("get_dy_underlying")!.selector
      ) {
        return curveUnderlyingPoolIface.encodeFunctionResult(
          "get_dy_underlying",
          [1n],
        );
      }
      const [index] = curveUnderlyingPoolIface.decodeFunctionData(
        "underlying_coins",
        req.data,
      );
      if (BigInt(index) > 1n) {
        throw Object.assign(new Error("curve coin index out of range"), {
          code: "CALL_EXCEPTION",
        });
      }
      return curveUnderlyingPoolIface.encodeFunctionResult(
        "underlying_coins",
        [BigInt(index) === 0n ? CURVE_TOKEN0 : CURVE_TOKEN1],
      );
    },
  };
  const transientCurve = await resolvePoolIdentity(
    transientThenHealthyCurveBackend,
    address(0x115),
    "curve-underlying",
    {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    },
  );
  assert(
    !transientCurve.ok &&
      transientCurve.reason === "identity_call_failed",
    "Curve-underlying transport failure must remain retryable",
  );
  const recoveredCurve = await resolvePoolIdentity(
    transientThenHealthyCurveBackend,
    address(0x115),
    "curve-underlying",
    {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    },
  );
  assert(
    recoveredCurve.ok &&
      recoveredCurve.adapter === "curve-underlying",
    "Curve-underlying transport rejection must not poison the backend cache",
  );
  const panorama = await resolvePoolIdentity(provider, PANORAMA_POOL, "univ2", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  });
  assert(!panorama.ok, "Panoramaswap must not reuse univ2 from the Swap topic");
  assert(panorama.reason === "unsupported_venue", `Panoramaswap reason=${panorama.reason}`);
  assert(panorama.venueId === "panoramaswap-v1", `Panoramaswap venue=${panorama.venueId}`);

  const unknown = await resolvePoolIdentity(provider, UNKNOWN_PAIR, "univ2", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  });
  assert(!unknown.ok && unknown.reason === "unknown_factory", "unknown factory must fail closed");

  const corrected = await resolvePoolIdentity(provider, UNI_PAIR, "univ3", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  });
  assert(corrected.ok, "known factory must resolve despite a wrong event-derived adapter hint");
  assert(corrected.adapter === "univ2", "factory must select the canonical runtime adapter");

  const provisionalV2 = await resolvePoolIdentity(provider, UNKNOWN_PAIR, "univ2", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  });
  assert(
    provisionalV2.ok &&
      provisionalV2.identitySource === "factory-call-provisional" &&
      provisionalV2.factory?.toLowerCase() === UNKNOWN_FACTORY.toLowerCase(),
    "reverse-bound provisional V2 must be admitted independently of fee measurement",
  );
  const mismatchedV2Pool = address(0x124);
  const mismatchedV2Factory = address(0x125);
  const reverseMismatchedV2 = await resolvePoolIdentity({
    call: async ({ to, data }) => {
      const selector = data.slice(0, 10);
      if (to.toLowerCase() === mismatchedV2Pool.toLowerCase()) {
        if (selector === factoryIface.getFunction("factory")!.selector) {
          return factoryIface.encodeFunctionResult("factory", [mismatchedV2Factory]);
        }
        if (selector === v2IdentityIface.getFunction("token0")!.selector) {
          return v2IdentityIface.encodeFunctionResult("token0", [V2_TOKEN0]);
        }
        if (selector === v2IdentityIface.getFunction("token1")!.selector) {
          return v2IdentityIface.encodeFunctionResult("token1", [V2_TOKEN1]);
        }
        if (selector === v2IdentityIface.getFunction("getReserves")!.selector) {
          return v2IdentityIface.encodeFunctionResult("getReserves", [1n, 1n, 1]);
        }
      }
      if (
        to.toLowerCase() === mismatchedV2Factory.toLowerCase() &&
        selector === factoryIface.getFunction("getPair")!.selector
      ) {
        return factoryIface.encodeFunctionResult("getPair", [address(0x126)]);
      }
      throw new Error(`unexpected V2 reverse-binding call ${to}:${selector}`);
    },
  }, mismatchedV2Pool, "univ2", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  });
  assert(
    !reverseMismatchedV2.ok && reverseMismatchedV2.reason === "behavior_mismatch",
    "a provisional V2 selector lookalike without factory reverse-binding must fail closed",
  );
  const provisionalV3 = await resolvePoolIdentity(provider, UNKNOWN_PAIR, "univ3", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  });
  assert(
    provisionalV3.ok && provisionalV3.identitySource === "factory-call-provisional",
    "standard-shape V3 must pass provisional behavior proof",
  );
  const fakeV3 = await resolvePoolIdentity(provider, FAKE_V3_POOL, "univ3", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  });
  assert(
    !fakeV3.ok && fakeV3.reason === "behavior_mismatch",
    "canonical slot0 revert is permanent negative proof for provisional V3",
  );
  const mismatchedV3Pool = address(0x120);
  const otherV3Pool = address(0x121);
  const canonicalV3Factory = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
  const reverseMismatch = await resolvePoolIdentity({
    call: async ({ to, data }) => {
      const selector = data.slice(0, 10);
      if (to.toLowerCase() === mismatchedV3Pool.toLowerCase()) {
        if (selector === factoryIface.getFunction("factory")!.selector) {
          return factoryIface.encodeFunctionResult("factory", [canonicalV3Factory]);
        }
        if (selector === v3IdentityIface.getFunction("token0")!.selector) {
          return v3IdentityIface.encodeFunctionResult("token0", [PROVISIONAL_V3_TOKEN0]);
        }
        if (selector === v3IdentityIface.getFunction("token1")!.selector) {
          return v3IdentityIface.encodeFunctionResult("token1", [PROVISIONAL_V3_TOKEN1]);
        }
        if (selector === v3IdentityIface.getFunction("fee")!.selector) {
          return v3IdentityIface.encodeFunctionResult("fee", [3_000]);
        }
      }
      if (
        to.toLowerCase() === canonicalV3Factory.toLowerCase() &&
        selector === factoryIface.getFunction("getPool")!.selector
      ) {
        return factoryIface.encodeFunctionResult("getPool", [otherV3Pool]);
      }
      throw new Error(`unexpected reverse-mismatch identity call ${to}:${selector}`);
    },
  }, mismatchedV3Pool, "univ3", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  });
  assert(
    !reverseMismatch.ok && reverseMismatch.reason === "behavior_mismatch",
    "known V3 factory must not admit a target that factory.getPool does not bind",
  );
  console.log("[venue-identity] selector lookalikes fail closed: PASS");
}

async function testRuntimeScanUsesIdentity(): Promise<void> {
  const provider = new FakeProvider();
  const pools = await scanActivePools(provider as never, 10, 20, 1_000);
  const byAddress = new Map(pools.map((pool) => [pool.address.toLowerCase(), pool]));

  assert(byAddress.has(UNI_PAIR.toLowerCase()), "official UniV2 pair should be admitted");
  assert(byAddress.get(UNI_PAIR.toLowerCase())?.venueId === "univ2", "UniV2 venue identity");
  assert(byAddress.has(SUSHI_PAIR.toLowerCase()), "SushiV2 pair should be admitted");
  assert(
    byAddress.get(SUSHI_PAIR.toLowerCase())?.venueId === "sushiswap-v2",
    "Sushi venue identity must remain distinct from its reused univ2 adapter",
  );
  assert(byAddress.has(V3_FORK_POOL.toLowerCase()), "replayed V3 fork should be admitted");
  assert(
    byAddress.get(V3_FORK_POOL.toLowerCase())?.venueId === "univ3-fork-075c",
    "V3 fork venue identity",
  );
  assert(byAddress.has(CURVE_POOL.toLowerCase()), "MetaRegistry Curve pool should be admitted");
  assert(
    byAddress.get(CURVE_POOL.toLowerCase())?.venueId === "curve",
    "MetaRegistry proves Curve venue identity",
  );
  assert(byAddress.has(BALANCER_V3_POOL.toLowerCase()), "registered Balancer V3 pool should be admitted");
  assert(
    byAddress.get(BALANCER_V3_POOL.toLowerCase())?.venueId === "balancer-v3",
    "Balancer V3 Vault proves pool identity",
  );
  assert(!byAddress.has(PANORAMA_POOL.toLowerCase()), "Panoramaswap must remain outside runtime graph");
  assert(!byAddress.has(UNKNOWN_PAIR.toLowerCase()), "unknown V2 factory must remain outside runtime graph");
  assert(
    !byAddress.has(UNREGISTERED_CURVE_POOL.toLowerCase()),
    "unregistered Curve-shaped emitter must remain outside runtime graph",
  );
  assert(provider.factoryCalls.includes(PANORAMA_POOL.toLowerCase()), "scanner must query Panoramaswap factory");
  assert(
    provider.curveCalls.includes(UNREGISTERED_CURVE_POOL.toLowerCase()),
    "scanner must query Curve MetaRegistry",
  );
  assert(
    provider.curveCalls.filter(
      (address) => address === CURVE_POOL.toLowerCase(),
    ).length === 1,
    "family materialization must own Curve identity without a second central attestation",
  );
  assert(
    provider.curveCalls.filter(
      (address) => address === UNREGISTERED_CURVE_POOL.toLowerCase(),
    ).length === 1,
    "a family-local permanent Curve rejection must not be centrally retried",
  );
  console.log("[venue-identity] runtime scan identity gate: PASS");
}

async function testBalancerV3Identity(): Promise<void> {
  const provider = new FakeProvider();
  const registered = await resolvePoolIdentity(provider, BALANCER_V3_POOL, "balancer-v3", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  });
  assert(registered.ok, "registered Balancer V3 pool should pass identity attestation");
  assert(registered.adapter === "balancer-v3", "Balancer V3 runtime adapter mismatch");
  assert(registered.identitySource === "balancer-v3-vault", "Balancer V3 identity provenance missing");

  const fake = await resolvePoolIdentity(provider, FAKE_BALANCER_V3_POOL, "balancer-v3", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  });
  assert(!fake.ok, "unregistered Balancer V3 pool must fail closed");
  assert(fake.reason === "balancer_v3_unregistered", `Balancer V3 rejection reason=${fake.reason}`);
  console.log("[venue-identity] Balancer V3 Vault registration gate: PASS");
}

async function testPersistedMetadataCannotBypassNodeIdentity(): Promise<void> {
  const provider = new FakeProvider();
  const result = await attestPoolIdentities(provider, [{
    address: PANORAMA_POOL,
    adapter: "univ2",
    venueId: "univ2" as const,
    factory: UNIV2_FACTORY,
    identitySource: "factory-call" as const,
  }], { identityRegistry: PRODUCTION_IDENTITY_RESOLVERS });
  assert(result.accepted.length === 0, "forged persisted identity must not be admitted");
  assert(result.rejected[0]?.venueId === "panoramaswap-v1", "node factory must replace stale metadata");
  assert(
    provider.factoryCalls.includes(PANORAMA_POOL.toLowerCase()),
    "runtime attestation must call factory() even when metadata exists",
  );

  const corrected = await attestPoolIdentities(provider, [{
    address: UNI_PAIR,
    adapter: "univ3",
    venueId: "univ3" as const,
  }], { identityRegistry: PRODUCTION_IDENTITY_RESOLVERS });
  assert(corrected.accepted.length === 1, "known factory should correct stale adapter metadata");
  assert(corrected.accepted[0]?.adapter === "univ2", "persisted adapter must yield to factory identity");
  assert(corrected.accepted[0]?.venueId === "univ2", "persisted venue must yield to factory identity");
  console.log("[venue-identity] persisted metadata bypass: PASS");
}

async function testCurveIdentityDoesNotChooseAdapter(): Promise<void> {
  const provider = new FakeProvider();
  const identity = await resolvePoolIdentity(provider, CURVE_POOL, "curve-nr", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  });
  assert(identity.ok, "registered Curve pool should pass identity attestation");
  assert(identity.adapter === "curve-nr", "curated adapter must remain unchanged");
  assert(identity.venueId === "curve", "MetaRegistry must not pretend to identify an adapter subtype");
  console.log("[venue-identity] Curve venue/adapter separation: PASS");
}

async function testV4ManagerIdentity(): Promise<void> {
  const provider = new FakeProvider();
  const canonical = await attestPoolIdentities(provider, [{
    address: ADDR.UNISWAP_V4_POOL_MANAGER,
    adapter: "univ4",
  }], { identityRegistry: PRODUCTION_IDENTITY_RESOLVERS });
  assert(canonical.accepted.length === 1, "canonical v4 manager must be admitted");
  assert(canonical.accepted[0]?.venueId === "univ4", "v4 canonical venue identity");
  assert(canonical.accepted[0]?.identitySource === "v4-manager", "v4 identity provenance");

  const result = await attestPoolIdentities(provider, [{
    address: FAKE_V4_MANAGER,
    adapter: "univ4",
  }], { identityRegistry: PRODUCTION_IDENTITY_RESOLVERS });
  assert(result.accepted.length === 0, "arbitrary v4 manager must not be admitted");
  assert(result.rejected[0]?.reason === "adapter_mismatch", "v4 rejection reason");
  console.log("[venue-identity] v4 manager identity: PASS");
}

async function testProtocolAdaptersRequireExactEnabledSeeds(): Promise<void> {
  const provider = new FakeProvider();
  const candidates: IdentityPoolEntry[] = [
    { address: PSM_SEED, adapter: "psm" },
    { address: FAKE_PSM, adapter: "psm" },
  ];
  const result = await attestPoolIdentities(provider, candidates, {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
    seedEntries: [{ address: PSM_SEED, adapter: "psm", venueId: "psm" }],
  });
  assert(result.accepted.length === 1, "exact enabled protocol seed should be admitted");
  assert(result.accepted[0]?.address === PSM_SEED, "wrong protocol seed admitted");
  assert(result.accepted[0]?.venueId === "psm", "family-owned seed venue metadata missing");
  assert(result.accepted[0]?.identitySource === "seed", "protocol seed provenance missing");
  assert(result.rejected[0]?.address === FAKE_PSM, "arbitrary protocol target must be rejected");
  assert(result.rejected[0]?.reason === "untrusted_seed", "protocol rejection reason");
  assert(
    VENUE_IDENTITY_CATALOG.every((entry) =>
      entry.discovery.mode === "factory" ||
      entry.discovery.mode === "pool-registry"
    ),
    "protocol families must not depend on a central singleton seed catalog",
  );
  console.log("[venue-identity] protocol family works without central seed catalog: PASS");
}

function testIdentityRegistryConformance(): void {
  assertIdentityResolverCoverage(
    PRODUCTION_ADAPTER_FAMILIES.routes().list(),
    PRODUCTION_IDENTITY_RESOLVERS,
  );
  let missingPolicyError = "";
  try {
    assertIdentityResolverCoverage([
      ...PRODUCTION_ADAPTER_FAMILIES.routes().list(),
      { id: "compat:synthetic", poolAdapters: ["synthetic-pool-adapter"] },
    ], PRODUCTION_IDENTITY_RESOLVERS);
  } catch (error) {
    missingPolicyError = error instanceof Error ? error.message : String(error);
  }
  assert(
    missingPolicyError.includes("missing=[synthetic-pool-adapter]"),
    "synthetic route adapter without identity policy must fail explicitly",
  );
  const fluidOrdinary = PRODUCTION_IDENTITY_RESOLVERS.list().find(
    (descriptor) => descriptor.poolAdapter === "fluid-dex",
  );
  assert(
    fluidOrdinary?.policy === "trusted-singleton-seed" &&
      fluidOrdinary.canonicalAddress === undefined,
    "ordinary Fluid DEX intake must not bypass active family admission",
  );
  const fluidDiscovery = PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS.list().find(
    (descriptor) => descriptor.poolAdapter === "fluid-dex",
  );
  assert(
    fluidDiscovery?.policy === "onchain-resolver",
    "Fluid DEX discovery must derive its family-owned dynamic resolver",
  );
  console.log("[venue-identity] route/identity registry conformance: PASS");
}

async function testRouteRegistryOwnsProductionSupport(): Promise<void> {
  assert(PRODUCTION_IDENTITY_RESOLVERS.supportsRoutePool("univ2"), "registered route pool support");
  assert(
    PRODUCTION_IDENTITY_RESOLVERS.supportsRoutePool("fluid-dex"),
    "registered Fluid execution family must own route support",
  );
  assert(
    !PRODUCTION_IDENTITY_RESOLVERS.supportsRoutePool("synthetic-pool-adapter"),
    "unknown identity must not imply route support",
  );

  const executionDisabled = new IdentityResolverRegistry([
    { poolAdapter: "univ2", policy: "onchain-resolver", resolve: factoryIdentityResolver },
  ], () => false);
  const result = await resolvePoolIdentity(new FakeProvider(), UNI_PAIR, "univ2", {
    identityRegistry: executionDisabled,
  });
  assert(!result.ok && result.reason === "unsupported_venue", "route support must own admission");
  console.log("[venue-identity] route registry owns production support: PASS");
}

function address(n: number): string {
  return ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
}

await testResolverRejectsSelectorLookalikes();
await testRuntimeScanUsesIdentity();
await testPersistedMetadataCannotBypassNodeIdentity();
await testCurveIdentityDoesNotChooseAdapter();
await testV4ManagerIdentity();
await testProtocolAdaptersRequireExactEnabledSeeds();
await testBalancerV3Identity();
testIdentityRegistryConformance();
await testRouteRegistryOwnsProductionSupport();
await testV2LineageDescriptor();
console.log("venue-identity PASS (10/10)");

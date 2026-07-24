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
import { ADDR } from "../../shared/constants/addresses.js";
import {
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
} from "../venues/production-registry.js";
import { findVenueByFactory } from "../venues/capability.js";
import { findV2LineageByFactory, V2_LINEAGES } from "../venues/v2-lineage.js";
import { v2FeeBpsForFactory } from "../solver/v2-fee.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "../venues/admission.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const factoryIface = new ethers.Interface(["function factory() view returns (address)"]);
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
]);
const curvePoolIface = new ethers.Interface([
  "function coins(uint256 i) view returns (address)",
]);
const balancerV3VaultIface = new ethers.Interface([
  "function isPoolRegistered(address pool) view returns (bool)",
]);

const UNIV2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const SUSHI_V2_FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
const REPLAYED_V3_FORK_FACTORY = "0x075C42cD233a1c723c0F18f6dd575c8d679FEA85";
const PANORAMA_FACTORY = "0x82Eeb5A22A25310ac15352197d92d6C17A49602e";
const PANCAKE_V2_FACTORY = "0x1097053fd2ea711dad45caccc45eff7548fcb362";
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

const V2_SWAP_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const V3_SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const CURVE_SWAP_TOPIC = ethers.id("TokenExchange(address,int128,uint256,int128,uint256)");
const BALANCER_V3_SWAP_TOPIC = ethers.id(
  "Swap(address,address,address,uint256,uint256,uint256,uint256)",
);
const V2_PAIR_CREATED_TOPIC = ethers.id("PairCreated(address,address,address,uint256)");

class FakeProvider {
  readonly factoryCalls: string[] = [];
  readonly factoryIndexCalls: string[] = [];
  readonly curveCalls: string[] = [];
  readonly factories = new Map<string, string>([
    [UNI_PAIR.toLowerCase(), UNIV2_FACTORY],
    [SUSHI_PAIR.toLowerCase(), SUSHI_V2_FACTORY],
    [V3_FORK_POOL.toLowerCase(), REPLAYED_V3_FORK_FACTORY],
    [PANORAMA_POOL.toLowerCase(), PANORAMA_FACTORY],
    [UNKNOWN_PAIR.toLowerCase(), UNKNOWN_FACTORY],
    [PANCAKE_V2_PAIR.toLowerCase(), PANCAKE_V2_FACTORY],
    [FAKE_V3_POOL.toLowerCase(), UNKNOWN_FACTORY],
  ]);
  readonly registeredCurvePools = new Set([CURVE_POOL.toLowerCase()]);

  async getBlockNumber(): Promise<number> {
    throw new Error("pinned test must not query the head");
  }

  async send(
    method: string,
    args: Array<{ address?: string; topics?: string[] }>,
  ): Promise<Array<{
    address: string;
    data?: string;
    topics?: string[];
    blockNumber?: string;
  }>> {
    assert(method === "eth_getLogs", `unexpected RPC method ${method}`);
    const requestAddress = args[0]?.address?.toLowerCase();
    const topic = args[0]?.topics?.[0]?.toLowerCase();
    if (topic === V2_PAIR_CREATED_TOPIC.toLowerCase() && requestAddress) {
      this.factoryIndexCalls.push(requestAddress);
      if (requestAddress !== PANCAKE_V2_FACTORY.toLowerCase()) return [];
      return [{
        address: PANCAKE_V2_FACTORY,
        data: ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "uint256"],
          [PANCAKE_V2_PAIR, 1n],
        ),
        topics: [V2_PAIR_CREATED_TOPIC],
      }];
    }
    if (topic === V2_SWAP_TOPIC.toLowerCase()) {
      return [UNI_PAIR, UNI_PAIR, SUSHI_PAIR, PANORAMA_POOL, UNKNOWN_PAIR]
        .map((address) => ({
          address,
          topics: [V2_SWAP_TOPIC],
          data: "0x",
          blockNumber: "0x3e8",
        }));
    }
    if (topic === V3_SWAP_TOPIC.toLowerCase()) {
      return [{
        address: V3_FORK_POOL,
        topics: [V3_SWAP_TOPIC],
        data: "0x",
        blockNumber: "0x3e8",
      }];
    }
    if (topic === CURVE_SWAP_TOPIC.toLowerCase()) {
      return [CURVE_POOL, UNREGISTERED_CURVE_POOL].map((address) => ({
        address,
        topics: [CURVE_SWAP_TOPIC],
        data: "0x",
        blockNumber: "0x3e8",
      }));
    }
    if (topic === BALANCER_V3_SWAP_TOPIC.toLowerCase()) {
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
      target === CURVE_POOL.toLowerCase() &&
      selector ===
        curvePoolIface.getFunction("coins")!.selector
    ) {
      const [index] = curvePoolIface.decodeFunctionData("coins", req.data);
      if (BigInt(index) > 1n) throw new Error("curve coin index out of range");
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
    const capability = findVenueByFactory(descriptor.factory);
    assert(capability?.venue === descriptor.venue, `${descriptor.venue} capability provenance`);
    assert(
      capability.runtimeAdapter === descriptor.runtimeAdapter,
      `${descriptor.venue} execution family projection`,
    );
    const routeSupported = PRODUCTION_ADAPTER_FAMILIES.routes().findForPool(
      descriptor.runtimeAdapter,
    ) !== null;
    if (descriptor.discoverable && descriptor.quotable && descriptor.buildable && routeSupported) {
      assert(descriptor.measuredFeeRule !== null, `${descriptor.venue} production fee must be measured`);
      assert(
        v2FeeBpsForFactory(descriptor.factory) === descriptor.measuredFeeRule.feeBps,
        `${descriptor.venue} fee projection`,
      );
    }
  }

  const pancake = findV2LineageByFactory(PANCAKE_V2_FACTORY);
  assert(pancake?.venue === "pancake-v2", "Pancake V2 lineage identity");
  assert(pancake.discoverable, "Pancake V2 factory discovery flag");
  assert(
    PRODUCTION_ADAPTER_FAMILIES.routes().findForPool(pancake.runtimeAdapter) !== null,
    "Pancake V2 execution support must come from the route registry",
  );
  assert(pancake.measuredFeeRule?.feeBps === 25n, "Pancake V2 measured fee");

  const provider = new FakeProvider();
  const identity = await resolvePoolIdentity(provider, PANCAKE_V2_PAIR, "univ2", {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  });
  assert(identity.ok && identity.venueId === "pancake-v2", "Pancake V2 strict identity");
  assert(identity.ok && identity.adapter === "univ2", "Pancake V2 execution adapter");

  const indexed = await indexFactoryPools(provider as never, 1, 1_000);
  const pancakePool = indexed.find((pool) => pool.address === PANCAKE_V2_PAIR);
  assert(pancakePool?.adapter === "univ2", "Pancake V2 factory pool execution adapter");
  assert(pancakePool.venueId === "pancake-v2", "Pancake V2 factory pool venue identity");
  assert(
    pancakePool.factory?.toLowerCase() === PANCAKE_V2_FACTORY.toLowerCase(),
    "Pancake V2 factory provenance",
  );
  assert(
    provider.factoryIndexCalls.includes(PANCAKE_V2_FACTORY.toLowerCase()),
    "Pancake V2 factory must enter factory indexing",
  );
  console.log("[venue-identity] V2 lineage identity/discovery/fee projection: PASS");
}

async function testResolverRejectsSelectorLookalikes(): Promise<void> {
  const provider = new FakeProvider();
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
    !provisionalV2.ok && provisionalV2.reason === "unmeasured_v2_fee",
    "provisional V2 without a measured fee rule must fail closed",
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
    seedEntries: [{ address: PSM_SEED, adapter: "psm" }],
  });
  assert(result.accepted.length === 1, "exact enabled protocol seed should be admitted");
  assert(result.accepted[0]?.address === PSM_SEED, "wrong protocol seed admitted");
  assert(result.accepted[0]?.identitySource === "seed", "protocol seed provenance missing");
  assert(result.rejected[0]?.address === FAKE_PSM, "arbitrary protocol target must be rejected");
  assert(result.rejected[0]?.reason === "untrusted_seed", "protocol rejection reason");
  console.log("[venue-identity] protocol exact-seed gate: PASS");
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

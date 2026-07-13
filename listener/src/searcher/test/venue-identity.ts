import { ethers } from "ethers";
import { scanActivePools } from "../active-pool-discovery.js";
import {
  CURVE_METAREGISTRY,
  attestPoolIdentities,
  resolvePoolIdentity,
  type IdentityPoolEntry,
} from "../venues/identity.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const factoryIface = new ethers.Interface(["function factory() view returns (address)"]);
const curveMetaRegistryIface = new ethers.Interface([
  "function get_registry_handlers_from_pool(address pool) view returns (address[10])",
]);

const UNIV2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const SUSHI_V2_FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
const REPLAYED_V3_FORK_FACTORY = "0x075C42cD233a1c723c0F18f6dd575c8d679FEA85";
const PANORAMA_FACTORY = "0x82Eeb5A22A25310ac15352197d92d6C17A49602e";
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

const V2_SWAP_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const V3_SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const CURVE_SWAP_TOPIC = ethers.id("TokenExchange(address,int128,uint256,int128,uint256)");

class FakeProvider {
  readonly factoryCalls: string[] = [];
  readonly curveCalls: string[] = [];
  readonly factories = new Map<string, string>([
    [UNI_PAIR.toLowerCase(), UNIV2_FACTORY],
    [SUSHI_PAIR.toLowerCase(), SUSHI_V2_FACTORY],
    [V3_FORK_POOL.toLowerCase(), REPLAYED_V3_FORK_FACTORY],
    [PANORAMA_POOL.toLowerCase(), PANORAMA_FACTORY],
    [UNKNOWN_PAIR.toLowerCase(), UNKNOWN_FACTORY],
  ]);
  readonly registeredCurvePools = new Set([CURVE_POOL.toLowerCase()]);

  async getBlockNumber(): Promise<number> {
    throw new Error("pinned test must not query the head");
  }

  async send(method: string, args: Array<{ topics?: string[] }>): Promise<Array<{ address: string }>> {
    assert(method === "eth_getLogs", `unexpected RPC method ${method}`);
    const topic = args[0]?.topics?.[0]?.toLowerCase();
    if (topic === V2_SWAP_TOPIC.toLowerCase()) {
      return [UNI_PAIR, UNI_PAIR, SUSHI_PAIR, PANORAMA_POOL, UNKNOWN_PAIR]
        .map((address) => ({ address }));
    }
    if (topic === V3_SWAP_TOPIC.toLowerCase()) return [{ address: V3_FORK_POOL }];
    if (topic === CURVE_SWAP_TOPIC.toLowerCase()) {
      return [{ address: CURVE_POOL }, { address: UNREGISTERED_CURVE_POOL }];
    }
    return [];
  }

  async call(req: { to: string; data: string }): Promise<string> {
    const target = req.to.toLowerCase();
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

    assert(req.data.slice(0, 10) === factoryIface.getFunction("factory")!.selector, "expected factory() call");
    this.factoryCalls.push(target);
    const factory = this.factories.get(target);
    if (!factory) throw new Error("factory unavailable");
    return factoryIface.encodeFunctionResult("factory", [factory]);
  }
}

async function testResolverRejectsSelectorLookalikes(): Promise<void> {
  const provider = new FakeProvider();
  const panorama = await resolvePoolIdentity(provider, PANORAMA_POOL, "univ2");
  assert(!panorama.ok, "Panoramaswap must not reuse univ2 from the Swap topic");
  assert(panorama.reason === "unsupported_venue", `Panoramaswap reason=${panorama.reason}`);
  assert(panorama.venueId === "panoramaswap-v1", `Panoramaswap venue=${panorama.venueId}`);

  const unknown = await resolvePoolIdentity(provider, UNKNOWN_PAIR, "univ2");
  assert(!unknown.ok && unknown.reason === "unknown_factory", "unknown factory must fail closed");

  const corrected = await resolvePoolIdentity(provider, UNI_PAIR, "univ3");
  assert(corrected.ok, "known factory must resolve despite a wrong event-derived adapter hint");
  assert(corrected.adapter === "univ2", "factory must select the canonical runtime adapter");
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

async function testPersistedMetadataCannotBypassNodeIdentity(): Promise<void> {
  const provider = new FakeProvider();
  const result = await attestPoolIdentities(provider, [{
    address: PANORAMA_POOL,
    adapter: "univ2",
    venueId: "univ2" as const,
    factory: UNIV2_FACTORY,
    identitySource: "factory-call" as const,
  }]);
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
  }]);
  assert(corrected.accepted.length === 1, "known factory should correct stale adapter metadata");
  assert(corrected.accepted[0]?.adapter === "univ2", "persisted adapter must yield to factory identity");
  assert(corrected.accepted[0]?.venueId === "univ2", "persisted venue must yield to factory identity");
  console.log("[venue-identity] persisted metadata bypass: PASS");
}

async function testCurveIdentityDoesNotChooseAdapter(): Promise<void> {
  const provider = new FakeProvider();
  const identity = await resolvePoolIdentity(provider, CURVE_POOL, "curve-nr");
  assert(identity.ok, "registered Curve pool should pass identity attestation");
  assert(identity.adapter === "curve-nr", "curated adapter must remain unchanged");
  assert(identity.venueId === "curve", "MetaRegistry must not pretend to identify an adapter subtype");
  console.log("[venue-identity] Curve venue/adapter separation: PASS");
}

async function testV4ManagerIdentity(): Promise<void> {
  const provider = new FakeProvider();
  const result = await attestPoolIdentities(provider, [{
    address: FAKE_V4_MANAGER,
    adapter: "univ4",
  }]);
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
    seedEntries: [{ address: PSM_SEED, adapter: "psm" }],
  });
  assert(result.accepted.length === 1, "exact enabled protocol seed should be admitted");
  assert(result.accepted[0]?.address === PSM_SEED, "wrong protocol seed admitted");
  assert(result.accepted[0]?.identitySource === "seed", "protocol seed provenance missing");
  assert(result.rejected[0]?.address === FAKE_PSM, "arbitrary protocol target must be rejected");
  assert(result.rejected[0]?.reason === "untrusted_seed", "protocol rejection reason");
  console.log("[venue-identity] protocol exact-seed gate: PASS");
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
console.log("venue-identity PASS (6/6)");

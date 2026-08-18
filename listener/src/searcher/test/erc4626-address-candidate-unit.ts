import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import {
  createCanonicalProtocolIdentityAttester,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryProjection,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { protocolDiscoveryCandidateAddressHints } from "../protocol-discovery-runtime.js";
import { createFixtureStrictSimulationTransport } from "../architecture-migration-fixture-replay.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { PRODUCTION_STRICT_VERIFIED_ACTORS } from "../venues/production-verified-actors.js";
import { scanProtocolDiscoveryRange } from "../observed-protocol-discovery.js";
import { createProtocolDiscoveryEvidenceCache } from "../protocol-discovery-cache.js";
import { buildStrategyViews } from "../strategy-views.js";
import {
  buildTokenPaths,
  type PoolEntry,
} from "../planner/token-graph.js";
import { STRICT_EMPTY_PROTOCOL_IDENTITY_TEST_REGISTRY } from "./strict-family-test-compat.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import type {
  ProtocolConversionAdapter,
  ProtocolDiscoveryContext,
} from "../venues/route-leg-adapter.js";

/**
 * ERC4626 execution-family address-candidate unit.
 *
 * A synthetic address that is already supplied as a candidate must pass the
 * shared matcher -> identity -> route-probe -> projection chain. This is a
 * family capability unit only: it deliberately does not prove that production
 * DEX-universe or observed-flow discovery can source the address.
 */

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const EXPECTED_HINTS = Object.freeze([
  "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
  "0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055",
  "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB",
  "0xbEef047a543E45807105E51A8BBEFCc5950fcfBa",
  "0xac3E018457B222d93114458476f3E3416Abbe38F",
  "0x7Bc3485026Ac48b6cf9BaF0A377477Fff5703Af8",
  "0xD4fa2D31b7968E448877f69A96DE69f5de8cD23E",
  "0xc441d0Bd70DBcF711f4BbA19AeA3deff47ce1C48",
  "0x395dA89bDb9431621A75DF4e2E3B993Acc2CaB3D",
  "0x056B269Eb1f75477a8666ae8C7fE01b64dD55eCc",
  "0xe3DA4B83C9dd4c4D185ecE42077462b3F35c454a",
  "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367",
  "0x6aD038cA6C04e885630851278ca0a856Ad9a66Cc",
  "0x6d134cAAD0CA29Cd6ea145f6C0DC766076690547",
  "0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7",
  "0xC255910618158F48FA461874471Aa24AEfbDC23A",
  "0xC71Ea051a5F82c67ADcF634c36FFE6334793D24C",
  "0x43680aBF18cf54898Be84C6eF78237CFBD441883",
  "0x4825eFF24F9B7b76EEAFA2ecc6A1D5dFCb3c1c3f",
  "0xB8280955aE7b5207AF4CDbdCd775135Bd38157fE",
] as const);
const VAULT = ethers.getAddress(EXPECTED_HINTS[0]);
const ASSET = ethers.getAddress("0x2222222222222222222222222222222222222222");
const CODE = "0x60006000";
const ZERO_WORD = `0x${"0".repeat(64)}`;
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function deposit(uint256,address) returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
]);

// A pinned mock state: the candidate vault answers the ERC4626 ABI
// consistently, its asset() resolves to a token already in the graph, and the
// redeem execution surface accepts the zero-amount probe.
const context: ProtocolDiscoveryContext = {
  blockNumber: 1000,
  fromBlock: 1000,
  toBlock: 1000,
  chainId: "1",
  // Provenance hints are deliberately absent: only an actually connected
  // asset makes the verified route loop-closable.
  graphTokens: [ASSET],
  retainedInstances: [],
  backend: {
    async call(req) {
      if (req.to.toLowerCase() !== VAULT.toLowerCase()) {
        throw Object.assign(new Error("not the candidate vault"), { code: "CALL_EXCEPTION" });
      }
      const selector = req.data.slice(0, 10);
      if (selector === ERC4626.getFunction("asset")!.selector) {
        return ERC4626.encodeFunctionResult("asset", [ASSET]);
      }
      for (const fn of ["totalAssets", "totalSupply"] as const) {
        if (selector === ERC4626.getFunction(fn)!.selector) {
          return ERC4626.encodeFunctionResult(fn, [1_000_000n]);
        }
      }
      for (const fn of ["convertToShares", "previewDeposit"] as const) {
        if (selector === ERC4626.getFunction(fn)!.selector) {
          const amount = BigInt(ERC4626.decodeFunctionData(fn, req.data)[0]);
          return ERC4626.encodeFunctionResult(fn, [amount * 9n / 10n]);
        }
      }
      for (const fn of ["convertToAssets", "previewRedeem"] as const) {
        if (selector === ERC4626.getFunction(fn)!.selector) {
          const amount = BigInt(ERC4626.decodeFunctionData(fn, req.data)[0]);
          return ERC4626.encodeFunctionResult(fn, [amount * 10n / 9n]);
        }
      }
      for (const fn of ["deposit", "redeem"] as const) {
        if (selector === ERC4626.getFunction(fn)!.selector) {
          return ERC4626.encodeFunctionResult(fn, [0n]);
        }
      }
      throw new Error(`unexpected selector ${selector}`);
    },
    async getCode(address) {
      // The vault and its asset both have code on the fork; unrelated addresses
      // do not, so the scanner's negative path stays exercised.
      return [VAULT, ASSET].some((known) => known.toLowerCase() === address.toLowerCase())
        ? CODE
        : "0x";
    },
    async getStorageAt() { return ZERO_WORD; },
    async getLogs() { return []; },
    async getTransactionReceipt() { throw new Error("address-candidate unit must not need a receipt"); },
    async traceTransaction() { throw new Error("address-candidate unit must not need a trace"); },
  },
};

const expectedHints = [...EXPECTED_HINTS].map((address) => address.toLowerCase()).sort();
const candidateAddressHints = protocolDiscoveryCandidateAddressHints([erc4626Adapter]);
assert(
  JSON.stringify(candidateAddressHints) === JSON.stringify(expectedHints),
  "registry-owned ERC4626 provenance hint set must stay frozen at 20 addresses",
);

const baseDiscovery = erc4626Adapter.discovery;
if (!baseDiscovery?.candidateFromAddress) {
  throw new Error("FAIL: ERC4626 address matcher missing");
}
let matcherCalls = 0;
let identityCalls = 0;
let probeCalls = 0;
const instrumentedAdapter = {
  ...erc4626Adapter,
  discovery: {
    ...baseDiscovery,
    async candidateFromAddress(candidate, candidateContext) {
      matcherCalls++;
      return baseDiscovery.candidateFromAddress!(candidate, candidateContext);
    },
    async probeCandidate(instance, candidateContext) {
      probeCalls++;
      return baseDiscovery.probeCandidate(instance, candidateContext);
    },
  },
} satisfies ProtocolConversionAdapter;

// The shared runtime contributes only addresses. The scanner must still call
// the family matcher before any identity, probe, verified route, or edge exists.
const evidenceCache = createProtocolDiscoveryEvidenceCache(1n);
const scan = await scanProtocolDiscoveryRange({
  adapters: [instrumentedAdapter],
  context,
  candidateAddresses: candidateAddressHints,
  evidenceCache,
});
assert(scan.sourceComplete, "address-candidate scan must complete");
assert(
  scan.candidatesByAdapter.get(instrumentedAdapter.id)?.length === 1,
  "scanner must dispatch the hinted address to the ERC4626 family",
);
assert(matcherCalls === 1, `hint must enter candidateFromAddress exactly once, got ${matcherCalls}`);
const matchedCandidate = scan.candidatesByAdapter.get(instrumentedAdapter.id)?.[0];
assert(
  matchedCandidate?.pool.verifiedRoutes === undefined,
  "address hint/matcher output must not carry executable verified routes",
);

// 4) Full admission chain: identity attest -> route probe -> verified edges.
const fixtureIdentityRuntime = createStrictCentralAdapterRuntime({
  provider: context.backend as never,
  simulator: createFixtureStrictSimulationTransport({
    depositSharesRatio: [9n, 10n],
    redeemAssetsRatio: [10n, 9n],
  }),
  generationFence: Object.freeze({
    kind: "catalog-relative" as const,
    assertCurrent: () => undefined,
    verifyCanonicalSource: () => true,
  }),
  verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
});
const canonicalIdentity = createCanonicalProtocolIdentityAttester({
  identityRuntime: fixtureIdentityRuntime,
});
const result = await runProtocolDiscovery({
  adapters: [instrumentedAdapter],
  context,
  protocolEdgesEnabled: true,
  attestIdentity: async (adapter, candidate, candidateContext) => {
    identityCalls++;
    return canonicalIdentity(adapter, candidate, candidateContext);
  },
  candidatesByAdapter: scan.candidatesByAdapter,
  sourceComplete: scan.sourceComplete,
  sourceErrors: scan.sourceErrors,
});
assert(identityCalls === 1, `hint must pass identity exactly once, got ${identityCalls}`);
assert(probeCalls === 1, `hint must pass behavior probe exactly once, got ${probeCalls}`);
assert(result.wouldAdmit.length === 1, "family discovery must admit the supplied candidate vault");
assert(
  typeof result.wouldAdmit[0].instance.pool.identitySource === "string" &&
    result.wouldAdmit[0].instance.pool.identitySource.length > 0,
  "admission must carry a reverse-verified identity credential",
);
assert(result.wouldAdmit[0].edges.length === 2, "candidate vault must emit deposit+redeem edges");

// Only after matcher + identity + probe may the projected graph expose both
// verified family directions.
const projection = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result,
  currentBackrunPools: [],
  currentBackrunGraph: [],
  currentKnownPoolKeys: new Set(),
  buildStrategyViews: (pools: PoolEntry[]) => buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 100,
    poolUniverseGeneratedAt: "test",
  }),
});
assert(
  projection.staticSuppressed.length === 0,
  "migrated standard ERC4626 hint must not be blocked by static ownership",
);
assert(
  buildTokenPaths(projection.backrunGraph, ASSET, VAULT, { maxHops: 2 }).length > 0,
  "projected vault must be routable asset -> vault",
);
assert(
  buildTokenPaths(projection.backrunGraph, VAULT, ASSET, { maxHops: 2 }).length > 0,
  "projected vault must be routable vault -> asset",
);

// 6) The projected pool carries verifiedRoutes, so a graph rebuild cannot
//    regrow a probe-rejected leg from the seed.
const rediscovered = projection.strategyViews.backrun.find(
  (pool: PoolEntry) => pool.address.toLowerCase() === VAULT.toLowerCase(),
);
assert(
  rediscovered?.verifiedRoutes?.length === 2,
  "rediscovered vault must carry its verified routes for fail-closed rebuilds",
);

console.log(`erc4626-address-candidate-unit PASS (family matcher/probe projected ${VAULT})`);
export {};

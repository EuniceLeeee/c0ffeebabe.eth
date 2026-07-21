import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import {
  createCanonicalProtocolIdentityAttester,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryProjection,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { scanProtocolDiscoveryRange } from "../observed-protocol-discovery.js";
import { createProtocolDiscoveryEvidenceCache } from "../protocol-discovery-cache.js";
import { buildStrategyViews } from "../strategy-views.js";
import { buildTokenPaths, type PoolEntry } from "../planner/token-graph.js";
import { PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS } from "../venues/production-registry.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import type { ProtocolDiscoveryContext } from "../venues/route-leg-adapter.js";

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

const VAULT = ethers.getAddress("0x1111111111111111111111111111111111111111");
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
  graphTokens: [ASSET, VAULT],
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

// The candidate source is intentionally outside this unit. Once supplied, the
// shared scanner dispatches it to the execution-family matcher.
const evidenceCache = createProtocolDiscoveryEvidenceCache(1n);
const scan = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context,
  candidateAddresses: [VAULT],
  evidenceCache,
});
assert(scan.sourceComplete, "address-candidate scan must complete");
assert(
  scan.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1,
  "scanner must dispatch the supplied address to the ERC4626 family",
);

// 4) Full admission chain: identity attest -> route probe -> verified edges.
const result = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context,
  protocolEdgesEnabled: true,
  attestIdentity: createCanonicalProtocolIdentityAttester({
    identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
  }),
  candidatesByAdapter: scan.candidatesByAdapter,
  sourceComplete: scan.sourceComplete,
  sourceErrors: scan.sourceErrors,
});
assert(result.wouldAdmit.length === 1, "family discovery must admit the supplied candidate vault");
assert(
  result.wouldAdmit[0].instance.pool.identitySource === "erc4626-standard",
  "admission must carry a reverse-verified identity credential",
);
assert(result.wouldAdmit[0].edges.length === 2, "candidate vault must emit deposit+redeem edges");

// The projected graph exposes both verified family directions. This is not a
// production path-discovery assertion because the candidate was supplied.
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

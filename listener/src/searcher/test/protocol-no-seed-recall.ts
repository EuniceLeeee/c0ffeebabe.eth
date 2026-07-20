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
import { buildTokenPaths, POOL_REGISTRY, type PoolEntry } from "../planner/token-graph.js";
import { PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS } from "../venues/production-registry.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import { ERC4626_LEGACY_RECALL_VAULTS } from "../venues/protocols/erc4626-legacy-recall.js";
import type { ProtocolDiscoveryContext } from "../venues/route-leg-adapter.js";

/**
 * No-seed replay — deterministic half (impl spec §四 acceptance 11).
 *
 * With every standard ERC4626 static seed physically removed from
 * POOL_REGISTRY, a legacy-recall vault must be REDISCOVERED purely from the DEX
 * address source: scanner self-enumerate -> identity attest -> route probe ->
 * loop-closable edge in graph -> path_found. The final_sim_success half of
 * acceptance 11 additionally requires a mainnet fork and runs in the
 * blockscan-hunt no-seed mode (SEARCHER_NO_SEED_REPLAY=1); this test proves the
 * archive-free discovery chain the fork replay depends on, against a pinned
 * mock backend.
 */

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

// 1) Physical removal is real: no standard ERC4626 seed remains.
assert(
  !POOL_REGISTRY.some((pool) => pool.adapter === "erc4626" && !pool.nonStandardRedeem),
  "no-seed precondition: standard ERC4626 seeds must be absent from POOL_REGISTRY",
);
assert(ERC4626_LEGACY_RECALL_VAULTS.length > 0, "recall answer key must be non-empty");

// 2) The recall answer key is NOT a candidate source: it only supplies the
//    address to probe; discovery must independently reverse-verify identity.
const VAULT = ethers.getAddress(ERC4626_LEGACY_RECALL_VAULTS[0].address);
const ASSET = ethers.getAddress(ERC4626_LEGACY_RECALL_VAULTS[0].asset);
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

// A pinned mock of the fork state: the recall vault answers the ERC4626 ABI
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
        throw Object.assign(new Error("not the recall vault"), { code: "CALL_EXCEPTION" });
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
    async getTransactionReceipt() { throw new Error("no-seed recall must not need a receipt"); },
    async traceTransaction() { throw new Error("no-seed recall must not need a trace"); },
  },
};

// 3) DEX address source only (no Withdraw event, no seed): the scanner probes
//    the recall address as a graph token and self-enumerates the vault.
const evidenceCache = createProtocolDiscoveryEvidenceCache(1n);
const scan = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context,
  candidateAddresses: [VAULT],
  evidenceCache,
});
assert(scan.sourceComplete, "no-seed DEX address scan must complete");
assert(
  scan.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1,
  "scanner must self-enumerate the recall vault from the DEX address source",
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
assert(result.wouldAdmit.length === 1, "no-seed discovery must admit the recall vault");
assert(
  result.wouldAdmit[0].instance.pool.identitySource === "erc4626-standard",
  "recall admission must carry a reverse-verified identity credential, not a seed",
);
assert(result.wouldAdmit[0].edges.length === 2, "recall vault must emit deposit+redeem edges");

// 5) Edge in graph -> path_found: the projected graph exposes a routable loop
//    leg through the rediscovered vault.
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
  "path_found: rediscovered vault must be routable asset -> vault",
);
assert(
  buildTokenPaths(projection.backrunGraph, VAULT, ASSET, { maxHops: 2 }).length > 0,
  "path_found: rediscovered vault must be routable vault -> asset",
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

console.log(
  `protocol-no-seed-recall PASS (recall vault ${VAULT} rediscovered seedless; ` +
    "final_sim_success requires the blockscan-hunt no-seed fork mode)",
);
export {};

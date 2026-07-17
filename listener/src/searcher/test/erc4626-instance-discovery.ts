import { ethers } from "ethers";
import {
  createCanonicalProtocolIdentityAttester,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryProjection,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { buildTokenPaths, POOL_REGISTRY, type TokenEdge } from "../planner/token-graph.js";
import { buildStrategyViews } from "../strategy-views.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
} from "../venues/production-registry.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import type { ProtocolDiscoveryContext } from "../venues/route-leg-adapter.js";

const VAULT = "0x1111111111111111111111111111111111111111";
const ASSET = "0x2222222222222222222222222222222222222222";
const RECEIVER = "0x3333333333333333333333333333333333333333";
const STATIC_TARGET = "0x4444444444444444444444444444444444444444";
const TX_HASH = `0x${"ab".repeat(32)}`;
const CODE = "0x60006000";
const ZERO_WORD = `0x${"0".repeat(64)}`;
const WITHDRAW = ethers.id(
  "Withdraw(address,address,address,uint256,uint256)",
).toLowerCase();
const TRANSFER = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
]);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function topicAddress(address: string): string {
  return ethers.zeroPadValue(address, 32).toLowerCase();
}

function createContext(implementationWord = ZERO_WORD): ProtocolDiscoveryContext {
  const withdrawLog = {
    address: VAULT,
    topics: [WITHDRAW, topicAddress(RECEIVER), topicAddress(RECEIVER), topicAddress(RECEIVER)],
    data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [100n, 90n]),
    transactionHash: TX_HASH,
    blockNumber: 123,
  };
  const transferLog = {
    address: ASSET,
    topics: [TRANSFER, topicAddress(VAULT), topicAddress(RECEIVER)],
    data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100n]),
    transactionHash: TX_HASH,
    blockNumber: 123,
  };
  return {
    blockNumber: 123,
    fromBlock: 100,
    toBlock: 123,
    candidateTokens: [VAULT],
    graphTokens: [ASSET, VAULT],
    retainedInstances: [],
    backend: {
      async call(req) {
        if (req.to.toLowerCase() !== VAULT.toLowerCase()) throw new Error("not a vault");
        const selector = req.data.slice(0, 10);
        if (selector === ERC4626.getFunction("asset")!.selector) {
          return ERC4626.encodeFunctionResult("asset", [ASSET]);
        }
        for (const fn of [
          "totalAssets",
          "totalSupply",
          "convertToShares",
          "convertToAssets",
          "previewDeposit",
          "previewRedeem",
        ]) {
          if (selector === ERC4626.getFunction(fn)!.selector) {
            return ERC4626.encodeFunctionResult(fn, [100n]);
          }
        }
        throw new Error(`unknown selector ${selector}`);
      },
      async getCode(address) {
        return [VAULT, ASSET].some((item) => item.toLowerCase() === address.toLowerCase())
          ? CODE
          : "0x";
      },
      async getStorageAt() { return implementationWord; },
      async getCodeAt(address) {
        return [VAULT, ASSET].some((item) => item.toLowerCase() === address.toLowerCase())
          ? CODE
          : "0x";
      },
      async getStorageAtBlock() { return ZERO_WORD; },
      async getLogs() { return [withdrawLog]; },
      async getTransactionReceipt() {
        return { status: 1, logs: [withdrawLog, transferLog] };
      },
      async traceTransaction() {
        return {
          to: VAULT,
          input: new ethers.Interface([
            "function redeem(uint256,address,address)",
          ]).encodeFunctionData("redeem", [90n, RECEIVER, RECEIVER]),
        };
      },
    },
  };
}

const attester = createCanonicalProtocolIdentityAttester({
  identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
});
assert(
  !POOL_REGISTRY.some((pool) => pool.address.toLowerCase() === VAULT.toLowerCase()),
  "scanner target must not exist in the production registry",
);

const ordinaryIntake = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: createContext(),
  protocolEdgesEnabled: true,
  attestIdentity: createCanonicalProtocolIdentityAttester({
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  }),
});
assert(
  ordinaryIntake.wouldAdmit.length === 0,
  "ordinary production identity must not let unseeded ERC4626 bypass discovery payout probe",
);

const first = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: createContext(),
  protocolEdgesEnabled: true,
  attestIdentity: attester,
});
assert(first.wouldAdmit.length === 1, "scanner must self-enumerate one unseeded vault");
assert(first.wouldAdmit[0].edges.length === 2, "verified vault must emit deposit+redeem routes");
assert(
  first.wouldAdmit[0].instance.pool.identitySource === "erc4626-standard",
  "canonical identity credential must be retained",
);

const staticEdge: TokenEdge = {
  adapterId: "psm",
  target: STATIC_TARGET,
  tokenIn: ASSET,
  tokenOut: RECEIVER,
  slotKind: "protocol",
  protocolAction: "convert",
  ...deriveEdgeTaxonomy("protocol", "convert"),
};
const buildViews = (pools: any[]) => buildStrategyViews(pools, [], [], {
  blockscanMaxPools: 100,
  poolUniverseGeneratedAt: "test",
});
const fallbackProjection = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result: first,
  currentBackrunPools: [{ address: VAULT, adapter: "erc4626", fixedTokenIn: ASSET }],
  currentBackrunGraph: [...first.wouldAdmit[0].edges],
  currentKnownPoolKeys: new Set([VAULT.toLowerCase()]),
  buildStrategyViews: buildViews,
});
assert(
  fallbackProjection.ownership.admissions.size === 0,
  "an independently attested compatibility address must not become discovery-owned",
);
assert(
  fallbackProjection.backrunGraph.length === 2,
  "discovery must not replace or duplicate a same-address compatibility route",
);
const projection = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result: first,
  currentBackrunPools: [{
    address: STATIC_TARGET,
    adapter: "psm",
    fixedTokenIn: ASSET,
    fixedTokenOut: RECEIVER,
    fixedSlotKind: "protocol",
    fixedProtocolAction: "convert",
  }],
  currentBackrunGraph: [staticEdge],
  currentBlockscanGraph: [staticEdge],
  currentKnownPoolKeys: new Set([STATIC_TARGET.toLowerCase()]),
  buildStrategyViews: buildViews,
});
assert(projection.backrunGraph.length === 3, "atomic projection must include two discovered edges");
assert(
  buildTokenPaths(projection.backrunGraph, ASSET, VAULT, { maxHops: 2 }).length > 0,
  "admitted graph must expose a path through the discovered protocol route",
);

const changedBase = createContext(`0x${"1".padStart(64, "0")}`);
const changedContext: ProtocolDiscoveryContext = {
  ...changedBase,
  retainedInstances: [...projection.ownership.admissions.values()].map((item) => item.instance),
  candidateTokens: [],
};
const invalidated = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: changedContext,
  protocolEdgesEnabled: true,
  attestIdentity: attester,
});
assert(invalidated.wouldAdmit.length === 0, "implementation change must invalidate old payout evidence");
const removed = prepareProtocolDiscoveryProjection({
  currentOwnership: projection.ownership,
  result: invalidated,
  currentBackrunPools: projection.strategyViews.backrun,
  currentBackrunGraph: projection.backrunGraph,
  currentBlockscanGraph: projection.blockscanGraph,
  currentKnownPoolKeys: projection.knownPoolKeys,
  buildStrategyViews: buildViews,
});
assert(removed.ownership.admissions.size === 0, "lifecycle must remove invalid discovery ownership");
assert(removed.backrunGraph.length === 1, "lifecycle removal must leave static graph edge intact");
assert(removed.backrunGraph[0].target === STATIC_TARGET, "declared/static edge must never be removed");

console.log("erc4626-instance-discovery PASS");

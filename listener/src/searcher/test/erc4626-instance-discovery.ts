import { ethers } from "ethers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../shared/adapters/index.js";
import {
  createCanonicalProtocolIdentityAttester,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryProjection,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { scanProtocolDiscoveryRange } from "../observed-protocol-discovery.js";
import {
  cachedProtocolCandidates,
  createProtocolDiscoveryEvidenceCache,
  loadProtocolDiscoveryEvidenceCache,
  protocolAddressCacheKey,
  reconcileProtocolDiscoveryEvidenceCache,
  recordVerifiedProtocolCandidates,
  saveProtocolDiscoveryEvidenceCache,
} from "../protocol-discovery-cache.js";
import {
  protocolCandidateAddressesFromDexGraph,
  protocolCandidateAddressesFromDexUniverse,
} from "../protocol-discovery-runtime.js";
import { buildTokenPaths, POOL_REGISTRY, type TokenEdge } from "../planner/token-graph.js";
import { buildStrategyViews } from "../strategy-views.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
} from "../venues/production-registry.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import type {
  ProtocolConversionAdapter,
  ProtocolDiscoveryContext,
} from "../venues/route-leg-adapter.js";

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
  "function deposit(uint256,address) returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
]);
const ERC20 = new ethers.Interface(["function transfer(address,uint256)"]);
const REDEEM = new ethers.Interface(["function redeem(uint256,address,address)"]);

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
  const shareBurnLog = {
    address: VAULT,
    topics: [TRANSFER, topicAddress(RECEIVER), ZERO_WORD],
    data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [90n]),
    transactionHash: TX_HASH,
    blockNumber: 123,
  };
  return {
    blockNumber: 123,
    fromBlock: 100,
    toBlock: 123,
    graphTokens: [ASSET, VAULT],
    retainedInstances: [],
    backend: {
      async call(req) {
        if (req.to.toLowerCase() !== VAULT.toLowerCase()) {
          throw Object.assign(new Error("not a vault"), { code: "CALL_EXCEPTION" });
        }
        const selector = req.data.slice(0, 10);
        if (selector === ERC4626.getFunction("asset")!.selector) {
          return ERC4626.encodeFunctionResult("asset", [ASSET]);
        }
        for (const fn of ["totalAssets", "totalSupply"] as const) {
          if (selector === ERC4626.getFunction(fn)!.selector) {
            return ERC4626.encodeFunctionResult(fn, [100n]);
          }
        }
        for (const fn of [
          "convertToShares",
          "convertToAssets",
          "previewDeposit",
          "previewRedeem",
        ] as const) {
          if (selector === ERC4626.getFunction(fn)!.selector) {
            const amount = BigInt(ERC4626.decodeFunctionData(fn, req.data)[0]);
            const converted = fn === "convertToShares" || fn === "previewDeposit"
              ? amount * 9n / 10n
              : amount * 10n / 9n;
            return ERC4626.encodeFunctionResult(fn, [converted]);
          }
        }
        for (const fn of ["deposit", "redeem"] as const) {
          if (selector === ERC4626.getFunction(fn)!.selector) {
            return ERC4626.encodeFunctionResult(fn, [0n]);
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
      async getLogs() { return [withdrawLog]; },
      async getTransactionReceipt() {
        return { status: 1, logs: [withdrawLog, transferLog, shareBurnLog] };
      },
      async traceTransaction() {
        return {
          to: VAULT,
          input: REDEEM.encodeFunctionData("redeem", [90n, RECEIVER, RECEIVER]),
          calls: [{
            to: ASSET,
            input: ERC20.encodeFunctionData("transfer", [RECEIVER, 100n]),
          }],
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

const ordinaryContext = createContext();
const ordinaryScan = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: ordinaryContext,
});
const ordinaryIntake = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: ordinaryContext,
  protocolEdgesEnabled: true,
  attestIdentity: createCanonicalProtocolIdentityAttester({
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
  }),
  candidatesByAdapter: ordinaryScan.candidatesByAdapter,
  sourceComplete: ordinaryScan.sourceComplete,
  sourceErrors: ordinaryScan.sourceErrors,
});
assert(
  ordinaryIntake.wouldAdmit.length === 0,
  "ordinary production identity must not let unseeded ERC4626 bypass discovery payout probe",
);

const mismatchedPayoutBase = createContext();
const mismatchedPayoutContext: ProtocolDiscoveryContext = {
  ...mismatchedPayoutBase,
  backend: {
    ...mismatchedPayoutBase.backend,
    async call(req) {
      if (req.data.slice(0, 10) === ERC4626.getFunction("previewRedeem")!.selector) {
        const shares = BigInt(ERC4626.decodeFunctionData("previewRedeem", req.data)[0]);
        return ERC4626.encodeFunctionResult("previewRedeem", [shares]);
      }
      return mismatchedPayoutBase.backend.call(req);
    },
  },
};
const mismatchedPayout = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: mismatchedPayoutContext,
});
const mismatchedPayoutResult = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: mismatchedPayoutContext,
  protocolEdgesEnabled: true,
  attestIdentity: attester,
  candidatesByAdapter: mismatchedPayout.candidatesByAdapter,
  sourceComplete: mismatchedPayout.sourceComplete,
  sourceErrors: mismatchedPayout.sourceErrors,
});
assert(mismatchedPayout.sourceComplete, "receipt/preview disagreement is a semantic probe rejection");
assert(
  mismatchedPayoutResult.wouldAdmit.length === 0,
  "same-block observed payout must agree with current pinned previewRedeem before admission",
);

const firstContext = createContext();
const firstScan = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: firstContext,
});
const first = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: firstContext,
  protocolEdgesEnabled: true,
  attestIdentity: attester,
  candidatesByAdapter: firstScan.candidatesByAdapter,
  sourceComplete: firstScan.sourceComplete,
  sourceErrors: firstScan.sourceErrors,
});
assert(first.wouldAdmit.length === 1, "scanner must self-enumerate one unseeded vault");
assert(first.wouldAdmit[0].edges.length === 2, "verified vault must emit deposit+redeem routes");
assert(
  first.wouldAdmit[0].instance.pool.identitySource === "erc4626-standard",
  "canonical identity credential must be retained",
);

const addressCache = createProtocolDiscoveryEvidenceCache(1n);
const addressBase = createContext();
const addressContext: ProtocolDiscoveryContext = {
  ...addressBase,
  backend: {
    ...addressBase.backend,
    async getLogs() { return []; },
    async getTransactionReceipt() { throw new Error("address discovery must not read a receipt"); },
    async traceTransaction() { throw new Error("address discovery must not read a trace"); },
  },
};
const addressScan = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: addressContext,
  candidateAddresses: [VAULT],
  evidenceCache: addressCache,
});
assert(addressScan.sourceComplete, "DEX address source must complete without a Withdraw event");
assert(addressScan.addressStats.probes === 1, "new DEX token must receive one family address probe");
assert(
  addressScan.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1,
  "DEX address matcher must discover a dormant standard vault",
);
const addressOnly = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: addressContext,
  protocolEdgesEnabled: true,
  attestIdentity: attester,
  candidatesByAdapter: addressScan.candidatesByAdapter,
  sourceComplete: addressScan.sourceComplete,
  sourceErrors: addressScan.sourceErrors,
});
assert(addressOnly.wouldAdmit.length === 1, "address-only evidence must admit one standard vault");
assert(addressOnly.wouldAdmit[0].edges.length === 2, "address-only vault must emit both graph edges");

const permanentIdentityContext: ProtocolDiscoveryContext = {
  ...addressContext,
  backend: {
    ...addressContext.backend,
    async call(req) {
      if (req.data.slice(0, 10) === ERC4626.getFunction("totalAssets")!.selector) {
        throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
      }
      return addressContext.backend.call(req);
    },
  },
};
const permanentIdentityFailure = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: permanentIdentityContext,
  protocolEdgesEnabled: true,
  attestIdentity: createCanonicalProtocolIdentityAttester({
    identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
  }),
  candidatesByAdapter: addressScan.candidatesByAdapter,
});
assert(
  permanentIdentityFailure.evaluationComplete &&
    permanentIdentityFailure.evaluatedInstanceKeys.size === 1,
  "permanent ERC4626 ABI failure must evict a stale route instead of retrying forever",
);
const transientIdentityContext: ProtocolDiscoveryContext = {
  ...addressContext,
  backend: {
    ...addressContext.backend,
    async call(req) {
      if (req.data.slice(0, 10) === ERC4626.getFunction("totalAssets")!.selector) {
        throw Object.assign(new Error("local reth timed out"), { code: "TIMEOUT" });
      }
      return addressContext.backend.call(req);
    },
  },
};
const transientIdentityFailure = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: transientIdentityContext,
  protocolEdgesEnabled: true,
  attestIdentity: createCanonicalProtocolIdentityAttester({
    identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
  }),
  candidatesByAdapter: addressScan.candidatesByAdapter,
});
assert(
  !transientIdentityFailure.evaluationComplete &&
    transientIdentityFailure.evaluatedInstanceKeys.size === 0,
  "transient local-reth failure must retain prior ownership for retry",
);

const dexCandidateAddresses = protocolCandidateAddressesFromDexGraph([
  {
    adapterId: "univ2",
    target: RECEIVER,
    tokenIn: VAULT,
    tokenOut: ASSET,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
  },
  addressOnly.wouldAdmit[0].edges[0],
]);
assert(
  dexCandidateAddresses.length === 2 &&
    dexCandidateAddresses.includes(VAULT.toLowerCase()) &&
    dexCandidateAddresses.includes(ASSET.toLowerCase()),
  "DEX candidate source must use swap tokens and ignore protocol rows as credentials",
);
const fullUniverseCandidates = protocolCandidateAddressesFromDexUniverse([
  { address: RECEIVER, adapter: "univ2", token0: VAULT, token1: ASSET },
  {
    address: STATIC_TARGET,
    adapter: "curve-underlying",
    underlyingCoins: [RECEIVER],
  },
  {
    address: STATIC_TARGET,
    adapter: "psm",
    fixedTokenIn: STATIC_TARGET,
    fixedTokenOut: VAULT,
  },
], new Set(["univ2", "curve-underlying"]));
assert(
  fullUniverseCandidates.length === 3 &&
    fullUniverseCandidates.includes(VAULT.toLowerCase()) &&
    fullUniverseCandidates.includes(ASSET.toLowerCase()) &&
    fullUniverseCandidates.includes(RECEIVER.toLowerCase()) &&
    !fullUniverseCandidates.includes(STATIC_TARGET.toLowerCase()),
  "full DEX universe metadata must contribute tokens without protocol fixed-token self-seeding",
);
const aliasAdapter = {
  ...erc4626Adapter,
  id: "protocol:erc4626-test-alias",
} satisfies ProtocolConversionAdapter;
const ambiguousAddress = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter, aliasAdapter],
  context: addressContext,
  candidateAddresses: [VAULT],
  evidenceCache: createProtocolDiscoveryEvidenceCache(),
});
assert(ambiguousAddress.sourceComplete, "deterministic ambiguity must not pin the source cursor");
assert(
  ambiguousAddress.candidatesByAdapter.size === 2,
  "scanner must preserve distinct matches for coordinator-level target quarantine",
);
assert(ambiguousAddress.addressStats.ambiguous === 1, "address ambiguity must be explicit");
const ambiguousResult = await runProtocolDiscovery({
  adapters: [erc4626Adapter, aliasAdapter],
  context: addressContext,
  protocolEdgesEnabled: true,
  attestIdentity: attester,
  candidatesByAdapter: ambiguousAddress.candidatesByAdapter,
  sourceComplete: ambiguousAddress.sourceComplete,
  sourceErrors: ambiguousAddress.sourceErrors,
});
assert(ambiguousResult.wouldAdmit.length === 0, "cross-adapter target ambiguity must admit no edge");

const timeoutAdapter = {
  ...erc4626Adapter,
  id: "protocol:erc4626-test-timeout",
  discovery: {
    ...erc4626Adapter.discovery,
    addressMatcherVersion: "test-timeout-v1",
    async candidateFromAddress() {
      throw Object.assign(new Error("matcher timed out"), { code: "TIMEOUT" });
    },
  },
} satisfies ProtocolConversionAdapter;
const undecidedAddress = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter, timeoutAdapter],
  context: addressContext,
  candidateAddresses: [VAULT],
  evidenceCache: createProtocolDiscoveryEvidenceCache(),
});
assert(!undecidedAddress.addressSourceComplete, "matcher timeout must keep address source retryable");
assert(
  undecidedAddress.candidatesByAdapter.size === 0,
  "one successful matcher must not admit while another family is undecided",
);

let nonVaultCalls = 0;
let nonVaultCode = CODE;
let nonVaultImplementation = ZERO_WORD;
const negativeContext: ProtocolDiscoveryContext = {
  ...addressContext,
  backend: {
    ...addressContext.backend,
    async call(req) {
      if (req.to.toLowerCase() === ASSET.toLowerCase()) nonVaultCalls++;
      return addressContext.backend.call(req);
    },
    async getCode(address) {
      if (address.toLowerCase() === ASSET.toLowerCase()) return nonVaultCode;
      return addressContext.backend.getCode(address);
    },
    async getStorageAt(address, position) {
      if (address.toLowerCase() === ASSET.toLowerCase()) return nonVaultImplementation;
      return addressContext.backend.getStorageAt(address, position);
    },
  },
};
const negativeFirst = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: negativeContext,
  candidateAddresses: [ASSET],
  evidenceCache: addressCache,
});
assert(negativeFirst.sourceComplete, "ordinary non-vault is a semantic negative");
assert(negativeFirst.addressStats.negatives === 1, "non-vault result must be negative-cached");
assert(nonVaultCalls === 1, "first non-vault pass must call the family matcher once");
const negativeSecond = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: negativeContext,
  candidateAddresses: [ASSET],
  evidenceCache: addressCache,
});
assert(negativeSecond.addressStats.cacheHits === 1, "same code hash must reuse negative cache");
assert(nonVaultCalls === 1, "negative cache must suppress repeated asset() calls");
nonVaultImplementation = `0x${"1".padStart(64, "0")}`;
const negativeImplementationChanged = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: negativeContext,
  candidateAddresses: [ASSET],
  evidenceCache: addressCache,
});
assert(
  negativeImplementationChanged.addressStats.probes === 1,
  "proxy implementation-word change must invalidate negative cache",
);
assert(Number(nonVaultCalls) === 2, "implementation change must re-run the family matcher");
nonVaultCode = "0x60016001";
const negativeChanged = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: negativeContext,
  candidateAddresses: [ASSET],
  evidenceCache: addressCache,
});
assert(negativeChanged.addressStats.probes === 1, "code-hash change must invalidate negative cache");
assert(Number(nonVaultCalls) === 3, "changed code must re-run the family matcher");
const negativeExpired = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: { ...negativeContext, blockNumber: 7_324, toBlock: 7_324 },
  candidateAddresses: [ASSET],
  evidenceCache: addressCache,
});
assert(negativeExpired.addressStats.probes === 1, "negative evidence must expire after its block TTL");
assert(Number(nonVaultCalls) === 4, "expired negative must retry even when code fingerprints are stable");

recordVerifiedProtocolCandidates(addressCache, addressOnly.wouldAdmit);
const cacheDir = mkdtempSync(join(tmpdir(), "mev-protocol-cache-"));
const cachePath = join(cacheDir, "cache.json");
try {
  saveProtocolDiscoveryEvidenceCache(cachePath, addressCache);
  const reloaded = loadProtocolDiscoveryEvidenceCache(cachePath, 1n);
  assert(reloaded.addressEntries.size >= 2, "positive and negative address evidence must persist");
  assert(reloaded.verifiedCandidates.size === 1, "verified admission evidence must persist");
  const wrongChain = loadProtocolDiscoveryEvidenceCache(cachePath, 10n);
  assert(
    wrongChain.addressEntries.size === 0 && wrongChain.verifiedCandidates.size === 0,
    "persisted evidence must never cross chain boundaries",
  );
  const fromDisk = await runProtocolDiscovery({
    adapters: [erc4626Adapter],
    context: addressContext,
    protocolEdgesEnabled: true,
    attestIdentity: attester,
    candidatesByAdapter: cachedProtocolCandidates(reloaded),
  });
  assert(fromDisk.wouldAdmit.length === 1, "reloaded evidence must survive current-state re-attestation");
  const rejectedDisk = await runProtocolDiscovery({
    adapters: [erc4626Adapter],
    context: addressContext,
    protocolEdgesEnabled: true,
    async attestIdentity() { return null; },
    candidatesByAdapter: cachedProtocolCandidates(reloaded),
  });
  assert(rejectedDisk.wouldAdmit.length === 0, "disk cache must never bypass identity attestation");

  const vaultKey = protocolAddressCacheKey(erc4626Adapter.id, VAULT);
  reconcileProtocolDiscoveryEvidenceCache(reloaded, {
    evaluatedInstanceKeys: new Set([vaultKey]),
    wouldAdmit: [],
  });
  assert(!reloaded.verifiedCandidates.has(vaultKey), "failed re-probe must evict verified evidence");
  assert(!reloaded.addressEntries.has(vaultKey), "failed re-probe must evict positive address evidence");
  const rematched = await scanProtocolDiscoveryRange({
    adapters: [erc4626Adapter],
    context: addressContext,
    candidateAddresses: [VAULT],
    evidenceCache: reloaded,
  });
  assert(rematched.addressStats.probes === 1, "evicted positive evidence must re-run the matcher");
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}

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
  backend: {
    ...changedBase.backend,
    async getLogs() { return []; },
  },
};
const changedScan = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: changedContext,
});
const invalidated = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: changedContext,
  protocolEdgesEnabled: true,
  attestIdentity: attester,
  candidatesByAdapter: changedScan.candidatesByAdapter,
  sourceComplete: changedScan.sourceComplete,
  sourceErrors: changedScan.sourceErrors,
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

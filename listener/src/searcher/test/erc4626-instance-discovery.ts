import { ethers } from "ethers";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../shared/adapters/index.js";
import {
  createCanonicalProtocolIdentityAttester,
  deriveVerifiedRouteClaims,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryFamilyInvalidation,
  prepareProtocolDiscoveryProjection,
  protocolEdgeKey,
  protocolInstanceKey,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { scanProtocolDiscoveryRange } from "../observed-protocol-discovery.js";
import { createFixtureStrictSimulationTransport } from "../architecture-migration-fixture-replay.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { PRODUCTION_STRICT_VERIFIED_ACTORS } from "../venues/production-verified-actors.js";
import {
  cachedProtocolCandidates,
  cloneProtocolDiscoveryEvidenceCache,
  createProtocolDiscoveryEvidenceCache,
  invalidateProtocolObservedHistory,
  loadProtocolDiscoveryEvidenceCache,
  protocolAddressCacheKey,
  protocolObservedCursorAnchorMatches,
  pruneRecentProcessedProtocolTxs,
  reconcileProtocolDiscoveryEvidenceCache,
  recordProtocolRouteOwnership,
  recordVerifiedProtocolCandidates,
  saveProtocolDiscoveryEvidenceCache,
  setProtocolObservedCursor,
  updateProtocolObservedSourceFingerprint,
} from "../protocol-discovery-cache.js";
import {
  protocolCandidateAddressesFromDexGraph,
  protocolCandidateAddressesFromDexUniverse,
} from "../protocol-discovery-runtime.js";
import { mergePoolRegistries } from "../pool-registry-merge.js";
import { poolRegistryKey } from "../pool-universe.js";
import { buildTokenPaths, POOL_REGISTRY, type TokenEdge } from "../planner/token-graph.js";
import { buildStrategyViews } from "../strategy-views.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  STRICT_EMPTY_POOL_IDENTITY_TEST_REGISTRY,
  STRICT_EMPTY_PROTOCOL_IDENTITY_TEST_REGISTRY,
} from "./strict-family-test-compat.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import {
  ERC4626_FORK_PROBE_HOLDER,
  ERC4626_FORK_PROBE_RECEIVER,
  probeErc4626Candidate,
  type Erc4626PayoutEvidence,
} from "../venues/protocols/erc4626-discovery.js";
import type {
  AttestedProtocolInstance,
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
  "function balanceOf(address) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function deposit(uint256,address) returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
  "event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
]);
const DEPOSIT = ERC4626.getEvent("Deposit")!.topicHash.toLowerCase();
const ERC20 = new ethers.Interface([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256)",
]);
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

const fixtureIdentityRuntime = createStrictCentralAdapterRuntime({
  provider: createContext().backend as never,
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
const attester = createCanonicalProtocolIdentityAttester({
  identityRuntime: fixtureIdentityRuntime,
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
  // Ordinary production identity has no simulation runtime: the family's
  // active proof stays fail-closed and an unseeded vault must not bypass
  // the discovery payout probe.
  attestIdentity: createCanonicalProtocolIdentityAttester(),
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
console.log("[debug] wouldAdmit=", first.wouldAdmit.length);
assert(first.wouldAdmit.length === 1, "scanner must self-enumerate one unseeded vault");
assert(first.wouldAdmit[0].edges.length === 2, "verified vault must emit deposit+redeem routes");
assert(
  typeof first.wouldAdmit[0].instance.pool.identitySource === "string" &&
    first.wouldAdmit[0].instance.pool.identitySource.length > 0,
  "canonical identity credential must be retained",
);
{
  const claims = first.wouldAdmit[0].claims;
  console.log("[debug] claims=", JSON.stringify(claims.map((c) => ({ f: c.authorityFingerprint, cls: c.authorityClass, str: c.authorityStrength, pid: c.producerAdapterId, srk: c.semanticRouteKey.slice(0, 80) }))));
  assert(claims.length === 2, "every verified edge must carry one route claim");
  assert(
    new Set(claims.map((claim) => claim.semanticRouteKey)).size === 2,
    "deposit and redeem routes must have distinct semantic keys",
  );
  assert(
    claims.every((claim) =>
      claim.producerAdapterId === erc4626Adapter.id &&
      claim.authorityFingerprint.split("|")[0]!.length > 0 &&
      claim.authorityClass === "canonical-onchain" &&
      claim.authorityStrength === 300 &&
      claim.executionFingerprint === claim.edge.executionVariantKey &&
      claim.semanticRouteKey.includes(VAULT.toLowerCase()) &&
      !claim.semanticRouteKey.includes(claim.edgeAdapterId)
    ),
    "claims must bind identity root and execution shape without leaking selectors into semantics",
  );
}

// Composite projection key (core 7): a second logical instance at one address
// keeps its own registry row, ownership key, and cache slot.
{
  const plain = { address: VAULT, adapter: "erc4626" as const, fixedTokenIn: ASSET };
  const secondPair = {
    address: VAULT,
    adapter: "erc4626" as const,
    fixedTokenIn: RECEIVER,
    logicalInstanceId: "pair-b",
  };
  assert(
    poolRegistryKey(plain) === VAULT.toLowerCase() &&
      poolRegistryKey(secondPair) === `${VAULT.toLowerCase()}:pair-b`,
    "logical instance id must extend the registry key without changing plain pools",
  );
  const mergedSameAddress = mergePoolRegistries([plain], [secondPair]);
  assert(
    mergedSameAddress.length === 2,
    "a second logical instance at one address must survive registry dedup",
  );
  assert(
    protocolInstanceKey(erc4626Adapter.id, plain) !==
      protocolInstanceKey(erc4626Adapter.id, secondPair),
    "discovery ownership keys must separate logical instances at one address",
  );
  assert(
    protocolInstanceKey(erc4626Adapter.id, VAULT) ===
      protocolInstanceKey(erc4626Adapter.id, plain),
    "plain pools keep the address-level instance key",
  );
}

// Evidence priority (acceptance 4): current-block evidence is checked in full
// and an older matching payout can never shadow a fresh contradiction; without
// current-block evidence, the newest historical fingerprint match drives the
// sample and only the adapter-owned round-trip invariant guards drift.
{
  const CODE_HASH = ethers.keccak256(CODE).toLowerCase();
  const payoutAt = (blockNumber: number, assets: bigint, shares: bigint): Erc4626PayoutEvidence => ({
    kind: "erc4626-withdraw-payout",
    txHash: TX_HASH,
    blockNumber,
    asset: ASSET,
    receiver: RECEIVER,
    assets,
    shares,
    codeHash: CODE_HASH,
    implementationWord: ZERO_WORD,
  });
  const evidenceInstance = (evidence: readonly unknown[]): AttestedProtocolInstance => ({
    pool: {
      address: VAULT,
      adapter: "erc4626",
      fixedTokenIn: ASSET,
      identitySource: "erc4626-standard",
    },
    sources: ["observed-calltrace"],
    selectors: [],
    evidence: [...evidence],
  });
  const priorityContext = createContext();
  const shadowed = await probeErc4626Candidate(
    evidenceInstance([payoutAt(100, 100n, 90n), payoutAt(123, 50n, 90n)]),
    priorityContext,
  ).then(() => null, (error: unknown) => error);
  assert(
    shadowed instanceof Error && /same-block previewRedeem disagrees/.test(shadowed.message),
    "older evidence must not shadow a contradicting same-block payout",
  );
  const consistent = await probeErc4626Candidate(
    evidenceInstance([payoutAt(100, 100n, 90n), payoutAt(123, 100n, 90n)]),
    priorityContext,
  );
  assert(consistent.length === 2, "consistent same-block evidence must admit both routes");
  const historicalOnly = await probeErc4626Candidate(
    evidenceInstance([payoutAt(90, 100n, 90n), payoutAt(110, 100n, 90n)]),
    priorityContext,
  );
  assert(
    historicalOnly.length === 2,
    "historical payout evidence must admit without comparing payout absolutes",
  );
  const inflatingBase = createContext();
  const inflatingContext: ProtocolDiscoveryContext = {
    ...inflatingBase,
    backend: {
      ...inflatingBase.backend,
      async call(req) {
        const selector = req.data.slice(0, 10);
        for (const fn of ["convertToShares", "previewDeposit"] as const) {
          if (selector === ERC4626.getFunction(fn)!.selector) {
            const amount = BigInt(ERC4626.decodeFunctionData(fn, req.data)[0]);
            return ERC4626.encodeFunctionResult(fn, [amount]);
          }
        }
        for (const fn of ["convertToAssets", "previewRedeem"] as const) {
          if (selector === ERC4626.getFunction(fn)!.selector) {
            const amount = BigInt(ERC4626.decodeFunctionData(fn, req.data)[0]);
            return ERC4626.encodeFunctionResult(fn, [amount * 2n]);
          }
        }
        return inflatingBase.backend.call(req);
      },
    },
  };
  const inflated = await probeErc4626Candidate(
    evidenceInstance([payoutAt(100, 200n, 100n)]),
    inflatingContext,
  ).then(() => null, (error: unknown) => error);
  assert(
    inflated instanceof Error && /round-trip preview inflates value/.test(inflated.message),
    "cross-block drift must be caught by the adapter-owned round-trip invariant",
  );
}

// C2 second evidence (core 8 / acceptance 10): without an observed payout, a
// dormant vault's redeem route must prove a NONZERO redeem on the pinned fork
// state (state-override simulation, decoded receipt, payout == previewRedeem).
{
  const CODE_HASH = ethers.keccak256(CODE).toLowerCase();
  const HOLDER_SLOT0 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256"],
    [ERC4626_FORK_PROBE_HOLDER, 0n],
  ));
  const ASSET_HOLDER_SLOT0 = HOLDER_SLOT0;
  const addressOnlyInstance = (): AttestedProtocolInstance => ({
    pool: {
      address: VAULT,
      adapter: "erc4626",
      fixedTokenIn: ASSET,
      identitySource: "erc4626-standard",
    },
    sources: ["dex-universe-address"],
    selectors: [],
    evidence: [{
      kind: "erc4626-address-probe",
      asset: ASSET,
      sampleAssets: 1_000_000n,
      sampleShares: 900_000n,
      codeHash: CODE_HASH,
      implementationWord: ZERO_WORD,
    }],
  });
  const simulatedVaultContext = (behavior: {
    payoutFactor?: bigint;
    revertRedeem?: boolean;
    totalSupply?: bigint;
  }): { context: ProtocolDiscoveryContext; counters: { balanceOf: number; redeem: number } } => {
    const counters = { balanceOf: 0, redeem: 0 };
    const totalSupply = behavior.totalSupply ?? 100n;
    const base = createContext();
    const context: ProtocolDiscoveryContext = {
      ...base,
      backend: {
        ...base.backend,
        async call(req) {
          const selector = req.data.slice(0, 10);
          if (
            req.to.toLowerCase() === ASSET.toLowerCase() &&
            selector === ERC20.getFunction("balanceOf")!.selector
          ) {
            return ERC20.encodeFunctionResult("balanceOf", [0n]);
          }
          if (
            req.to.toLowerCase() === VAULT.toLowerCase() &&
            selector === ERC4626.getFunction("totalSupply")!.selector
          ) {
            return ERC4626.encodeFunctionResult("totalSupply", [totalSupply]);
          }
          if (
            req.to.toLowerCase() === VAULT.toLowerCase() &&
            selector === ERC4626.getFunction("balanceOf")!.selector
          ) {
            return ERC4626.encodeFunctionResult("balanceOf", [0n]);
          }
          return base.backend.call(req);
        },
        async simulateCalls(req) {
          if (req.calls.length === 5) {
            const holder = req.calls[0].from;
            const [assets, receiver] = ERC4626.decodeFunctionData("deposit", req.calls[1].data);
            const assetAmount = BigInt(assets);
            const shares = assetAmount * 9n / 10n;
            if (String(receiver).toLowerCase() !== holder.toLowerCase()) {
              return req.calls.map(() => ({ status: 0, returnData: "0x", logs: [] }));
            }
            return [
              { status: 1, returnData: ERC20.encodeFunctionResult("approve", [true]), logs: [] },
              {
                status: 1,
                returnData: ERC4626.encodeFunctionResult("deposit", [shares]),
                logs: [
                  {
                    address: ASSET,
                    topics: [TRANSFER, topicAddress(holder), topicAddress(VAULT)],
                    data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [assetAmount]),
                    blockNumber: 123,
                  },
                  {
                    address: VAULT,
                    topics: [TRANSFER, ZERO_WORD, topicAddress(holder)],
                    data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [shares]),
                    blockNumber: 123,
                  },
                  {
                    address: VAULT,
                    topics: [DEPOSIT, topicAddress(holder), topicAddress(holder)],
                    data: ethers.AbiCoder.defaultAbiCoder().encode(
                      ["uint256", "uint256"],
                      [assetAmount, shares],
                    ),
                    blockNumber: 123,
                  },
                ],
              },
              { status: 1, returnData: ERC20.encodeFunctionResult("balanceOf", [0n]), logs: [] },
              { status: 1, returnData: ERC4626.encodeFunctionResult("balanceOf", [shares]), logs: [] },
              {
                status: 1,
                returnData: ERC4626.encodeFunctionResult("totalSupply", [totalSupply + shares]),
                logs: [],
              },
            ];
          }
          const call = req.calls[0];
          const selector = call.data.slice(0, 10).toLowerCase();
          const fundedRaw = req.stateOverrides?.[call.to]?.stateDiff?.[
            call.to.toLowerCase() === ASSET.toLowerCase() ? ASSET_HOLDER_SLOT0 : HOLDER_SLOT0
          ];
          const funded = fundedRaw === undefined ? 0n : BigInt(fundedRaw);
          if (
            selector === ERC4626.getFunction("balanceOf")!.selector ||
            selector === ERC20.getFunction("balanceOf")!.selector
          ) {
            counters.balanceOf++;
            return [{
              status: 1,
              returnData: ERC4626.encodeFunctionResult("balanceOf", [funded]),
              logs: [],
            }];
          }
          if (selector === ERC4626.getFunction("redeem")!.selector) {
            counters.redeem++;
            const [shares, receiver, owner] = ERC4626.decodeFunctionData("redeem", call.data);
            const sharesValue = BigInt(shares);
            if (behavior.revertRedeem || funded < sharesValue || totalSupply < sharesValue) {
              return [{ status: 0, returnData: "0x", logs: [] }];
            }
            const paid = sharesValue * 10n / 9n * (behavior.payoutFactor ?? 1n);
            return [{
              status: 1,
              returnData: ERC4626.encodeFunctionResult("redeem", [paid]),
              logs: [
                {
                  address: VAULT,
                  topics: [
                    WITHDRAW,
                    topicAddress(String(owner)),
                    topicAddress(String(receiver)),
                    topicAddress(String(owner)),
                  ],
                  data: ethers.AbiCoder.defaultAbiCoder().encode(
                    ["uint256", "uint256"],
                    [paid, sharesValue],
                  ),
                  blockNumber: 123,
                },
                {
                  address: ASSET,
                  topics: [TRANSFER, topicAddress(VAULT), topicAddress(String(receiver))],
                  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [paid]),
                  blockNumber: 123,
                },
                {
                  address: VAULT,
                  topics: [TRANSFER, topicAddress(String(owner)), ZERO_WORD],
                  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [sharesValue]),
                  blockNumber: 123,
                },
              ],
            }];
          }
          return [{ status: 0, returnData: "0x", logs: [] }];
        },
      },
    };
    return { context, counters };
  };

  const honest = simulatedVaultContext({});
  const honestEdges = await probeErc4626Candidate(addressOnlyInstance(), honest.context);
  assert(
    honestEdges.length === 2 &&
      honestEdges.some((edge) => edge.adapterId === "erc4626-redeem"),
    "nonzero fork redeem evidence must admit the dormant redeem route",
  );
  assert(
    honest.counters.redeem === 1 && honest.counters.balanceOf >= 1,
    "fork evidence must execute one nonzero redeem simulation",
  );

  const lying = simulatedVaultContext({ payoutFactor: 2n });
  const lyingEdges = await probeErc4626Candidate(addressOnlyInstance(), lying.context);
  assert(
    lyingEdges.length === 1 && lyingEdges[0].adapterId === "erc4626-deposit",
    "a payout inconsistent with previewRedeem must fail the redeem route closed",
  );

  const reverting = simulatedVaultContext({ revertRedeem: true });
  const revertingEdges = await probeErc4626Candidate(addressOnlyInstance(), reverting.context);
  assert(
    revertingEdges.length === 1 && revertingEdges[0].adapterId === "erc4626-deposit",
    "a reverting fork redeem must fail the redeem route closed",
  );

  const empty = simulatedVaultContext({ totalSupply: 0n });
  const emptyEdges = await probeErc4626Candidate(addressOnlyInstance(), empty.context);
  assert(
    emptyEdges.length === 1 && emptyEdges[0].adapterId === "erc4626-deposit",
    "an empty vault cannot prove a nonzero redeem and must not ship the route",
  );
  assert(
    ERC4626_FORK_PROBE_RECEIVER.toLowerCase() !== ERC4626_FORK_PROBE_HOLDER.toLowerCase(),
    "fork probe receiver and holder must stay distinct for causal payout checks",
  );
}

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

for (const [label, sharesPerAsset] of [
  ["18-dec shares over 6-dec asset", true],
  ["low-dec shares under 18-dec asset", false],
] as const) {
  const skewFactor = 10n ** 12n;
  const skewContext: ProtocolDiscoveryContext = {
    ...addressContext,
    backend: {
      ...addressContext.backend,
      async call(req) {
        const selector = req.data.slice(0, 10);
        for (const fn of ["convertToShares", "previewDeposit"] as const) {
          if (selector === ERC4626.getFunction(fn)!.selector) {
            const amount = BigInt(ERC4626.decodeFunctionData(fn, req.data)[0]);
            return ERC4626.encodeFunctionResult(
              fn,
              [sharesPerAsset ? amount * skewFactor : amount / skewFactor],
            );
          }
        }
        for (const fn of ["convertToAssets", "previewRedeem"] as const) {
          if (selector === ERC4626.getFunction(fn)!.selector) {
            const amount = BigInt(ERC4626.decodeFunctionData(fn, req.data)[0]);
            return ERC4626.encodeFunctionResult(
              fn,
              [sharesPerAsset ? amount / skewFactor : amount * skewFactor],
            );
          }
        }
        return addressContext.backend.call(req);
      },
    },
  };
  const skewScan = await scanProtocolDiscoveryRange({
    adapters: [erc4626Adapter],
    context: skewContext,
    candidateAddresses: [VAULT],
    evidenceCache: createProtocolDiscoveryEvidenceCache(1n),
  });
  const skewResult = await runProtocolDiscovery({
    adapters: [erc4626Adapter],
    context: skewContext,
    protocolEdgesEnabled: true,
    attestIdentity: attester,
    candidatesByAdapter: skewScan.candidatesByAdapter,
    sourceComplete: skewScan.sourceComplete,
    sourceErrors: skewScan.sourceErrors,
  });
  assert(
    skewResult.wouldAdmit.length === 1 && skewResult.wouldAdmit[0].edges.length === 2,
    `${label} must survive address evidence and both route probes`,
  );
}

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
  attestIdentity: attester,
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
const transientIdentityRuntime = createStrictCentralAdapterRuntime({
  provider: transientIdentityContext.backend as never,
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
const transientIdentityFailure = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: transientIdentityContext,
  protocolEdgesEnabled: true,
  attestIdentity: createCanonicalProtocolIdentityAttester({
    identityRuntime: transientIdentityRuntime,
  }),
  candidatesByAdapter: addressScan.candidatesByAdapter,
});
console.log("[debug] transient evalComplete=", transientIdentityFailure.evaluationComplete, " keys=", transientIdentityFailure.evaluatedInstanceKeys.size);
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
const overlappingAddress = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter, aliasAdapter],
  context: addressContext,
  candidateAddresses: [VAULT],
  evidenceCache: createProtocolDiscoveryEvidenceCache(),
});
assert(overlappingAddress.sourceComplete, "deterministic overlap must not pin the source cursor");
assert(
  overlappingAddress.candidatesByAdapter.size === 2,
  "scanner must preserve distinct matches for coordinator-level route arbitration",
);
assert(
  overlappingAddress.addressStats.matches === 1 &&
    overlappingAddress.addressStats.overlapAddresses === 1,
  "cross-family shortlist overlap must be counted once without becoming a source error",
);
assert(
  overlappingAddress.sourceErrors.length === 0,
  "cross-family shortlist overlap must defer conflict decisions to post-probe arbitration",
);
const ambiguousResult = await runProtocolDiscovery({
  adapters: [erc4626Adapter, aliasAdapter],
  context: addressContext,
  protocolEdgesEnabled: true,
  attestIdentity: attester,
  candidatesByAdapter: overlappingAddress.candidatesByAdapter,
  sourceComplete: overlappingAddress.sourceComplete,
  sourceErrors: overlappingAddress.sourceErrors,
});
// Equivalent full verifications (same semantic routes, same execution
// fingerprints) deduplicate instead of killing the target: both claimants stay
// verified, the edge identity is shared, and arbitration reports the tie
// explicitly as co-owned rather than picking by registration or lexical order.
assert(
  ambiguousResult.wouldAdmit.length === 2,
  "equivalent cross-adapter claims must both stay verified",
);
{
  const [firstAdmission, secondAdmission] = ambiguousResult.wouldAdmit;
  const firstKeys = [...firstAdmission.edges.map(protocolEdgeKey)].sort().join(";");
  const secondKeys = [...secondAdmission.edges.map(protocolEdgeKey)].sort().join(";");
  assert(
    firstKeys === secondKeys,
    "equivalent claims must share one edge identity that deduplicates at merge",
  );
  assert(
    ambiguousResult.events.some((event) =>
      event.stage === "arbitration" &&
      event.verdict === "would_admit" &&
      event.adapterId === "co-owned" &&
      /equivalent_route_claims/.test(event.reason ?? "")
    ),
    "equivalent-claim dedup must be reported with explicit authority outcome",
  );
}

// Authority ordering is family-owned typed data. The shared arbitrator must
// not recognize either the custom family id or an identity-source string.
const lowerAuthorityAdapter = {
  ...erc4626Adapter,
  id: "protocol:test-custom-authority-low",
  discoveryIdentityAuthority: { class: "provisional", strength: 17 },
} satisfies ProtocolConversionAdapter;
const higherAuthorityAdapter = {
  ...erc4626Adapter,
  id: "protocol:test-custom-authority-high",
  discoveryIdentityAuthority: { class: "canonical-onchain", strength: 419 },
} satisfies ProtocolConversionAdapter;
new AdapterFamilyRegistry([lowerAuthorityAdapter]);
new AdapterFamilyRegistry([higherAuthorityAdapter]);
const authorityCandidates = addressScan.candidatesByAdapter.get(erc4626Adapter.id) ?? [];
const customAuthorityResult = await runProtocolDiscovery({
  adapters: [lowerAuthorityAdapter, higherAuthorityAdapter],
  context: addressContext,
  protocolEdgesEnabled: true,
  attestIdentity: attester,
  candidatesByAdapter: new Map([
    [lowerAuthorityAdapter.id, authorityCandidates],
    [higherAuthorityAdapter.id, authorityCandidates],
  ]),
});
assert(
  customAuthorityResult.events.some((event) =>
    event.stage === "arbitration" &&
    event.verdict === "would_admit" &&
    event.adapterId === higherAuthorityAdapter.id &&
    /equivalent_route_claims/.test(event.reason ?? "")
  ),
  "custom family authority strength must decide equivalence without a central protocol rank table",
);

// Non-equivalent execution fingerprints on ONE semantic route are a
// verification-looseness red flag: the contested route is isolated for every
// claimant (other routes keep flowing) and the alert is explicit.
const execAdapter = {
  ...erc4626Adapter,
  id: "protocol:erc4626-test-exec",
  edgeAdapterIds: ["test-exec-redeem"],
  discovery: {
    candidateSources: [],
    eventTopics: [],
    callSelectors: [],
    async probeCandidate(instance: AttestedProtocolInstance) {
      return [{
        adapterId: "test-exec-redeem",
        target: instance.pool.address,
        tokenIn: instance.pool.address,
        tokenOut: instance.pool.fixedTokenIn ?? ASSET,
        slotKind: "protocol" as const,
        protocolAction: "redeem" as const,
        ...deriveEdgeTaxonomy("protocol", "redeem"),
      }];
    },
  },
} satisfies ProtocolConversionAdapter;
const execArbitration = await runProtocolDiscovery({
  adapters: [erc4626Adapter, execAdapter],
  context: addressContext,
  protocolEdgesEnabled: true,
  attestIdentity: attester,
  candidatesByAdapter: new Map([
    [erc4626Adapter.id, addressScan.candidatesByAdapter.get(erc4626Adapter.id) ?? []],
    [execAdapter.id, [{
      pool: { address: VAULT, adapter: "erc4626" as const, fixedTokenIn: ASSET },
      source: "test-exec-source",
    }]],
  ]),
});
assert(
  execArbitration.wouldAdmit.length === 1 &&
    execArbitration.wouldAdmit[0].adapterId === erc4626Adapter.id &&
    execArbitration.wouldAdmit[0].edges.length === 1 &&
    execArbitration.wouldAdmit[0].edges[0].adapterId === "erc4626-deposit",
  "non-equivalent claims must isolate only the contested route",
);
assert(
  execArbitration.events.filter((event) =>
    event.stage === "arbitration" &&
    event.verdict === "rejected" &&
    /non_equivalent_execution_fingerprints/.test(event.reason ?? "")
  ).length === 2,
  "non-equivalent route claims must alert for every claimant",
);

// Core 5: a retained instance re-enters ONLY its owning family's candidate
// set. A sibling family sharing the pool adapter kind must not inherit it.
const siblingAdapter = {
  ...erc4626Adapter,
  id: "protocol:erc4626-test-sibling",
} satisfies ProtocolConversionAdapter;
const ownerScopedRetained = await runProtocolDiscovery({
  adapters: [erc4626Adapter, siblingAdapter],
  context: {
    ...addressContext,
    retainedInstances: [
      { ...addressOnly.wouldAdmit[0].instance, ownerAdapterId: erc4626Adapter.id },
    ],
  },
  protocolEdgesEnabled: true,
  attestIdentity: attester,
});
assert(
  ownerScopedRetained.wouldAdmit.length === 1 &&
    ownerScopedRetained.wouldAdmit[0].adapterId === erc4626Adapter.id,
  "owner-scoped retained instance must re-verify under its own family only",
);

const timeoutAdapter = {
  ...erc4626Adapter,
  id: "protocol:erc4626-test-timeout",
  discovery: {
    ...erc4626Adapter.discovery,
    addressMatcherVersion: "test-timeout-v1",
    async candidateFromAddress() {
      return new Promise<never>(() => {});
    },
  },
} satisfies ProtocolConversionAdapter;
const undecidedAddress = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter, timeoutAdapter],
  context: addressContext,
  candidateAddresses: [VAULT],
  evidenceCache: createProtocolDiscoveryEvidenceCache(),
  familyGuardOptions: { timeoutMs: 5, failureThreshold: 1 },
});
assert(!undecidedAddress.addressSourceComplete, "matcher timeout must keep address source retryable");
assert(
  undecidedAddress.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1 &&
    !undecidedAddress.candidatesByAdapter.has(timeoutAdapter.id),
  "timed-out address matcher must not suppress a healthy sibling candidate",
);
assert(
  undecidedAddress.sourceErrors.some((error) =>
    error.adapterId === timeoutAdapter.id && error.retryable
  ),
  "timed-out address matcher must leave only its family source retryable",
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
assert(negativeFirst.addressStats.negatives === 1, "non-vault result must remain a semantic negative");
assert(nonVaultCalls === 1, "first non-vault pass must call the family matcher once");
const negativeSecond = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: negativeContext,
  candidateAddresses: [ASSET],
  evidenceCache: addressCache,
});
assert(
  negativeSecond.addressStats.cacheHits === 0 &&
    negativeSecond.addressStats.probes === 1,
  "same code hash alone must never authorize cross-block matcher reuse",
);
assert(Number(nonVaultCalls) === 2, "default cache policy must re-run mutable asset() behavior");
nonVaultImplementation = `0x${"1".padStart(64, "0")}`;
const negativeImplementationChanged = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: negativeContext,
  candidateAddresses: [ASSET],
  evidenceCache: addressCache,
});
assert(
  negativeImplementationChanged.addressStats.probes === 1,
  "proxy implementation-word change must still run the current matcher",
);
assert(Number(nonVaultCalls) === 3, "implementation change must re-run the family matcher");
nonVaultCode = "0x60016001";
const negativeChanged = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: negativeContext,
  candidateAddresses: [ASSET],
  evidenceCache: addressCache,
});
assert(negativeChanged.addressStats.probes === 1, "code-hash change must run the current matcher");
assert(Number(nonVaultCalls) === 4, "changed code must re-run the family matcher");
const negativeLaterBlock = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: { ...negativeContext, blockNumber: 7_324, toBlock: 7_324 },
  candidateAddresses: [ASSET],
  evidenceCache: addressCache,
});
assert(
  negativeLaterBlock.addressStats.probes === 1 &&
    negativeLaterBlock.addressStats.cacheHits === 0,
  "block age/TTL must never be used as proof of matcher-output stability",
);
assert(Number(nonVaultCalls) === 5, "later-block negative must re-run without a family fingerprint");

recordVerifiedProtocolCandidates(addressCache, addressOnly.wouldAdmit);
const observedFingerprint = `0x${"12".repeat(32)}`;
const observedFamilyFingerprints = new Map([[erc4626Adapter.id, `0x${"56".repeat(32)}`]]);
assert(
  updateProtocolObservedSourceFingerprint(
    addressCache,
    observedFingerprint,
    observedFamilyFingerprints,
  ),
  "first observed-source fingerprint must invalidate the legacy cursor",
);
assert(
  addressCache.verifiedCandidates.size === 0 &&
    addressCache.routeOwnership.admissions.length === 0,
  "a new matcher registry must invalidate evidence admitted under old semantics",
);
recordVerifiedProtocolCandidates(addressCache, addressOnly.wouldAdmit);
const observedCursorHash = `0x${"ab".repeat(32)}`;
setProtocolObservedCursor(addressCache, 123, observedCursorHash);
addressCache.runtime.recentProcessedTxs.set(TX_HASH.toLowerCase(), 123);
assert(
  !updateProtocolObservedSourceFingerprint(
    addressCache,
    observedFingerprint,
    observedFamilyFingerprints,
  ) &&
    addressCache.runtime.observedCursor === 123 &&
    addressCache.runtime.observedCursorHash === observedCursorHash &&
    addressCache.runtime.recentProcessedTxs.size === 1,
  "unchanged observed-source fingerprint must preserve cursor and tx dedupe",
);
const addressMatcherChangedCache =
  cloneProtocolDiscoveryEvidenceCache(addressCache);
assert(
  !updateProtocolObservedSourceFingerprint(
    addressMatcherChangedCache,
    observedFingerprint,
    new Map([[erc4626Adapter.id, `0x${"57".repeat(32)}`]]),
  ) &&
    addressMatcherChangedCache.runtime.observedCursor === 123 &&
    addressMatcherChangedCache.runtime.observedCursorHash ===
      observedCursorHash,
  "an address/family fingerprint change must not erase unchanged observed-history authority",
);
recordProtocolRouteOwnership(addressCache, {
  version: 7,
  admissions: new Map([[
    protocolAddressCacheKey(erc4626Adapter.id, VAULT),
    { adapterId: erc4626Adapter.id, instance: addressOnly.wouldAdmit[0].instance },
  ]]),
});
const cacheDir = mkdtempSync(join(tmpdir(), "mev-protocol-cache-"));
const cachePath = join(cacheDir, "cache.json");
try {
  saveProtocolDiscoveryEvidenceCache(cachePath, addressCache);
  const unanchored = cloneProtocolDiscoveryEvidenceCache(addressCache);
  unanchored.runtime.observedCursorHash = null;
  let unanchoredSaveRejected = false;
  try {
    saveProtocolDiscoveryEvidenceCache(`${cachePath}.unanchored`, unanchored);
  } catch {
    unanchoredSaveRejected = true;
  }
  assert(
    unanchoredSaveRejected,
    "cache persistence must reject a cursor whose canonical hash is missing",
  );
  const reloaded = loadProtocolDiscoveryEvidenceCache(cachePath, 1n);
  assert(
    reloaded.addressEntries.size === 0,
    "a family without an explicit dependency policy must not persist unusable address evidence",
  );
  assert(reloaded.verifiedCandidates.size === 1, "verified admission evidence must persist");
  assert(reloaded.runtime.observedCursor === 123, "observed event cursor must survive a restart");
  assert(
    reloaded.runtime.observedCursorHash === observedCursorHash,
    "observed event cursor hash must survive a restart",
  );
  assert(
    protocolObservedCursorAnchorMatches(
      reloaded,
      123,
      observedCursorHash,
    ) &&
      !protocolObservedCursorAnchorMatches(
        reloaded,
        123,
        `0x${"cd".repeat(32)}`,
      ),
    "restart cursor authority must be bound to the canonical block hash",
  );
  assert(
    reloaded.runtime.observedSourceFingerprint === observedFingerprint,
    "observed-source fingerprint must survive a restart",
  );
  assert(
    reloaded.runtime.discoverySourceFingerprints.get(erc4626Adapter.id) ===
      observedFamilyFingerprints.get(erc4626Adapter.id),
    "per-family discovery fingerprint must survive a restart",
  );
  assert(
    reloaded.runtime.recentProcessedTxs.get(TX_HASH.toLowerCase()) === 123,
    "recently processed observed txs must survive a restart",
  );
  assert(
    reloaded.routeOwnership.version === 7 && reloaded.routeOwnership.admissions.length === 1,
    "route ownership snapshot must survive a restart",
  );
  const reloadedInstance = reloaded.routeOwnership.admissions[0].instance;
  assert(
    reloadedInstance.evidence.some((item) =>
      typeof (item as { sampleAssets?: unknown }).sampleAssets === "bigint"
    ),
    "persisted ownership evidence must round-trip bigint fields",
  );
  const retainedFromDisk = await runProtocolDiscovery({
    adapters: [erc4626Adapter],
    context: { ...addressContext, retainedInstances: [reloadedInstance] },
    protocolEdgesEnabled: true,
    attestIdentity: attester,
  });
  assert(
    retainedFromDisk.wouldAdmit.length === 1,
    "reloaded ownership must re-enter as a retained candidate and re-verify",
  );
  const retainedRejected = await runProtocolDiscovery({
    adapters: [erc4626Adapter],
    context: { ...addressContext, retainedInstances: [reloadedInstance] },
    protocolEdgesEnabled: true,
    async attestIdentity() { return null; },
  });
  assert(
    retainedRejected.wouldAdmit.length === 0,
    "reloaded ownership must never route without passing identity attestation",
  );

  const legacyAdapterId = "protocol:eigenpie";
  const legacyTarget = "0x2222222222222222222222222222222222222222";
  const legacyTokenIn = "0x3333333333333333333333333333333333333333";
  const legacyTokenOut = "0x4444444444444444444444444444444444444444";
  const legacyPool = {
    address: legacyTarget,
    adapter: "eigenpie-deposit-router",
    fixedTokenIn: legacyTokenIn,
    fixedTokenOut: legacyTokenOut,
    fixedSlotKind: "protocol",
    fixedProtocolAction: "wrap",
    logicalInstanceId: `${legacyTokenIn.toLowerCase()}>${legacyTokenOut.toLowerCase()}`,
    venueId: "unknown",
    identitySource: "eigenpie-compatible-call-surface",
  };
  const legacyEvidence = [{
    kind: "eigenpie-deposit-observation",
    txHash: `0x${"45".repeat(32)}`,
    blockNumber: 100,
    tokenIn: legacyTokenIn,
    tokenOut: legacyTokenOut,
    amountIn: { __mev_protocol_bigint__: "1000000000000000000" },
    amountOut: { __mev_protocol_bigint__: "990000000000000000" },
  }];
  const savedSchemaFive = JSON.parse(
    readFileSync(cachePath, "utf8"),
  ) as Record<string, unknown>;
  const legacyPath = join(cacheDir, "schema-4.json");
  writeFileSync(
    legacyPath,
    `${JSON.stringify({
      ...savedSchemaFive,
      schema_version: 4,
      address_entries: savedSchemaFive.address_entries,
      verified_candidates: [{
        adapterId: legacyAdapterId,
        candidate: {
          pool: legacyPool,
          source: "persisted-verified-evidence",
          selector: "0x2ebe07c8",
          evidence: legacyEvidence,
        },
      }],
      observed_cursor: 456,
      observed_cursor_hash: null,
      observed_source_fingerprint: `0x${"67".repeat(32)}`,
      discovery_source_fingerprints: [{
        adapterId: legacyAdapterId,
        fingerprint: `0x${"68".repeat(32)}`,
      }],
      recent_processed_txs: [{
        txHash: `0x${"69".repeat(32)}`,
        blockNumber: 455,
      }],
      route_ownership: {
        version: 9,
        admissions: [{
          adapterId: legacyAdapterId,
          instance: {
            pool: legacyPool,
            sources: ["retained-instance", "observed-calltrace"],
            selectors: ["0x2ebe07c8"],
            evidence: legacyEvidence,
            ownerAdapterId: legacyAdapterId,
          },
        }],
      },
    }, null, 2)}\n`,
  );
  const legacyReloaded = loadProtocolDiscoveryEvidenceCache(
    legacyPath,
    1n,
  );
  assert(
    legacyReloaded.verifiedCandidates.size === 1 &&
      legacyReloaded.routeOwnership.version === 9 &&
      legacyReloaded.routeOwnership.admissions.length === 1 &&
      cachedProtocolCandidates(legacyReloaded).get(legacyAdapterId)?.length === 1,
    "schema-4 Eigenpie-like route records must survive only as retained candidates",
  );
  assert(
    legacyReloaded.addressEntries.size === 0 &&
      legacyReloaded.runtime.observedCursor === null &&
      legacyReloaded.runtime.observedCursorHash === null &&
      legacyReloaded.runtime.observedSourceFingerprint === null &&
      legacyReloaded.runtime.discoverySourceFingerprints.size === 0 &&
      legacyReloaded.runtime.recentProcessedTxs.size === 0 &&
      legacyReloaded.runtime.observedContiguousAuthority === null,
    "schema-4 address/cache/cursor authority must be discarded",
  );
  const migratedObservedFingerprint = `0x${"70".repeat(32)}`;
  const migratedFamilyFingerprint = `0x${"71".repeat(32)}`;
  assert(
    updateProtocolObservedSourceFingerprint(
      legacyReloaded,
      migratedObservedFingerprint,
      new Map([[legacyAdapterId, migratedFamilyFingerprint]]),
    ) &&
      legacyReloaded.verifiedCandidates.size === 1 &&
      legacyReloaded.routeOwnership.admissions.length === 1,
    "binding a schema-4 import to the current registry must preserve only re-attestation candidates",
  );
  const migratedPath = join(cacheDir, "schema-5-migrated.json");
  saveProtocolDiscoveryEvidenceCache(migratedPath, legacyReloaded);
  const migratedRaw = JSON.parse(
    readFileSync(migratedPath, "utf8"),
  ) as { schema_version?: unknown };
  assert(
    migratedRaw.schema_version === 5,
    "saving a schema-4 retained-candidate import must emit schema 5",
  );
  const migratedReloaded = loadProtocolDiscoveryEvidenceCache(
    migratedPath,
    1n,
  );
  assert(
    migratedReloaded.verifiedCandidates.size === 1 &&
      migratedReloaded.routeOwnership.admissions.length === 1 &&
      migratedReloaded.addressEntries.size === 0,
    "schema-5 migration output must preserve only the retained route records",
  );
  const wrongChainLegacy = loadProtocolDiscoveryEvidenceCache(
    legacyPath,
    10n,
  );
  assert(
    wrongChainLegacy.verifiedCandidates.size === 0 &&
      wrongChainLegacy.routeOwnership.admissions.length === 0,
    "schema-4 retained candidates must never cross chains",
  );
  const malformedLegacyPath = join(cacheDir, "schema-4-malformed.json");
  writeFileSync(
    malformedLegacyPath,
    `${JSON.stringify({
      schema_version: 4,
      chain_id: "1",
      verified_candidates: [{
        adapterId: legacyAdapterId,
        candidate: {
          pool: { ...legacyPool, address: "not-an-address" },
          source: "persisted-verified-evidence",
          evidence: legacyEvidence,
        },
      }],
      route_ownership: {
        version: 1,
        admissions: [],
      },
    })}\n`,
  );
  const malformedLegacy = loadProtocolDiscoveryEvidenceCache(
    malformedLegacyPath,
    1n,
  );
  assert(
    malformedLegacy.verifiedCandidates.size === 0 &&
      malformedLegacy.routeOwnership.admissions.length === 0,
    "malformed schema-4 retained candidates must fail closed",
  );

  pruneRecentProcessedProtocolTxs(reloaded, 300, 100);
  assert(
    reloaded.runtime.recentProcessedTxs.size === 0,
    "recent observed txs must expire by block age",
  );
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

  const reorged = cloneProtocolDiscoveryEvidenceCache(reloaded);
  invalidateProtocolObservedHistory(
    reorged,
    new Set([erc4626Adapter.id]),
  );
  assert(
    reorged.runtime.observedCursor === null &&
      reorged.runtime.observedCursorHash === null &&
      reorged.runtime.recentProcessedTxs.size === 0 &&
      reorged.verifiedCandidates.size === 0 &&
      reorged.routeOwnership.admissions.length === 0,
    "a cursor-anchor reorg must clear observed completeness and its derived ownership",
  );

  assert(
    updateProtocolObservedSourceFingerprint(
      reloaded,
      `0x${"34".repeat(32)}`,
      new Map([[erc4626Adapter.id, `0x${"78".repeat(32)}`]]),
    ) &&
      reloaded.runtime.observedCursor === null &&
      reloaded.runtime.recentProcessedTxs.size === 0 &&
      Number(reloaded.verifiedCandidates.size) === 0 &&
      Number(reloaded.routeOwnership.admissions.length) === 0,
    "changed observed-source fingerprint must drop stale verified ownership",
  );

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

const targetedCache = createProtocolDiscoveryEvidenceCache(1n);
const firstFamily = "protocol:first-dynamic";
const unchangedFamily = "protocol:unchanged-dynamic";
updateProtocolObservedSourceFingerprint(
  targetedCache,
  `0x${"90".repeat(32)}`,
  new Map([
    [firstFamily, `0x${"91".repeat(32)}`],
    [unchangedFamily, `0x${"92".repeat(32)}`],
  ]),
);
recordVerifiedProtocolCandidates(targetedCache, [
  { adapterId: firstFamily, instance: addressOnly.wouldAdmit[0].instance },
  { adapterId: unchangedFamily, instance: addressOnly.wouldAdmit[0].instance },
]);
recordProtocolRouteOwnership(targetedCache, {
  version: 1,
  admissions: new Map([
    [firstFamily, { adapterId: firstFamily, instance: addressOnly.wouldAdmit[0].instance }],
    [unchangedFamily, { adapterId: unchangedFamily, instance: addressOnly.wouldAdmit[0].instance }],
  ]),
});
updateProtocolObservedSourceFingerprint(
  targetedCache,
  `0x${"93".repeat(32)}`,
  new Map([
    [firstFamily, `0x${"94".repeat(32)}`],
    [unchangedFamily, `0x${"92".repeat(32)}`],
  ]),
);
assert(
  [...targetedCache.verifiedCandidates.values()].map(({ adapterId }) => adapterId)
    .join(",") === unchangedFamily &&
    targetedCache.routeOwnership.admissions.length === 1 &&
    targetedCache.routeOwnership.admissions[0].adapterId === unchangedFamily,
  "a matcher rollout must retain ownership for unchanged observed-only families",
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
assert(
  fallbackProjection.staticSuppressed.length === 1 &&
    fallbackProjection.staticSuppressed[0].adapterId === erc4626Adapter.id,
  "static venue winning the adjudication must be reported, never silent",
);
const logicalClaim = {
  ...first,
  wouldAdmit: [{
    ...first.wouldAdmit[0],
    instance: {
      ...first.wouldAdmit[0].instance,
      pool: { ...first.wouldAdmit[0].instance.pool, logicalInstanceId: "pair-static" },
    },
  }],
};
const logicalFallbackProjection = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result: logicalClaim,
  currentBackrunPools: [{ address: VAULT, adapter: "erc4626", fixedTokenIn: ASSET }],
  currentBackrunGraph: [...first.wouldAdmit[0].edges],
  currentKnownPoolKeys: new Set([VAULT.toLowerCase()]),
  buildStrategyViews: buildViews,
});
assert(
  logicalFallbackProjection.ownership.admissions.size === 0 &&
    logicalFallbackProjection.staticSuppressed.length === 1,
  "an equivalent logical pair must preserve the verified incumbent route",
);
const distinctEdge: TokenEdge = {
  ...first.wouldAdmit[0].edges[0],
  tokenOut: RECEIVER,
};
const distinctAdmission = {
  ...first.wouldAdmit[0],
  edges: [distinctEdge],
  claims: deriveVerifiedRouteClaims(
    erc4626Adapter.id,
    first.wouldAdmit[0].instance,
    [distinctEdge],
    firstContext.chainId,
    erc4626Adapter.discoveryIdentityAuthority,
  ),
};
const sameAddressDistinctRoute = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result: { ...first, wouldAdmit: [distinctAdmission] },
  currentBackrunPools: [{ address: VAULT, adapter: "erc4626", fixedTokenIn: ASSET }],
  currentBackrunGraph: [...first.wouldAdmit[0].edges],
  currentKnownPoolKeys: new Set([VAULT.toLowerCase()]),
  buildStrategyViews: buildViews,
});
assert(
  sameAddressDistinctRoute.ownership.admissions.size === 1 &&
    sameAddressDistinctRoute.backrunGraph.length === 3 &&
    sameAddressDistinctRoute.staticSuppressed.length === 0,
  "address equality must not suppress a separately verified semantic route",
);
const distinctRouteRemoved = prepareProtocolDiscoveryProjection({
  currentOwnership: sameAddressDistinctRoute.ownership,
  result: { ...first, wouldAdmit: [] },
  currentBackrunPools: sameAddressDistinctRoute.strategyViews.backrun,
  currentBackrunGraph: sameAddressDistinctRoute.backrunGraph,
  currentKnownPoolKeys: sameAddressDistinctRoute.knownPoolKeys,
  buildStrategyViews: buildViews,
});
assert(
  distinctRouteRemoved.backrunGraph.length === 2 &&
    distinctRouteRemoved.strategyViews.backrun.length === 1,
  "revoking a same-address discovered route must preserve the incumbent pool and edges",
);
const conflictingEdge: TokenEdge = {
  ...first.wouldAdmit[0].edges[0],
  adapterId: "conflicting-erc4626-execution",
  executionVariantKey: "conflicting-erc4626-execution",
};
const conflictingAdmission = {
  ...first.wouldAdmit[0],
  edges: [conflictingEdge],
  claims: deriveVerifiedRouteClaims(
    erc4626Adapter.id,
    first.wouldAdmit[0].instance,
    [conflictingEdge],
    firstContext.chainId,
    erc4626Adapter.discoveryIdentityAuthority,
  ),
};
const sameRouteConflict = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result: { ...first, wouldAdmit: [conflictingAdmission] },
  currentBackrunPools: [{ address: VAULT, adapter: "erc4626", fixedTokenIn: ASSET }],
  currentBackrunGraph: [first.wouldAdmit[0].edges[0]],
  currentKnownPoolKeys: new Set([VAULT.toLowerCase()]),
  buildStrategyViews: buildViews,
});
assert(
  sameRouteConflict.ownership.admissions.size === 0 &&
    sameRouteConflict.backrunGraph.length === 0 &&
    sameRouteConflict.staticConflicted.length === 1,
  "non-equivalent execution claims for one semantic route must quarantine both sides",
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

// Acceptance 9 (retention half): a TRANSIENT identity/probe failure keeps the
// prior admission and its edges through the projection; only deterministic
// failures revoke (covered by the lifecycle removal above).
const transientBase = createContext();
const transientRetainedContext: ProtocolDiscoveryContext = {
  ...transientBase,
  retainedInstances: [...projection.ownership.admissions.values()]
    .map((item) => ({ ...item.instance, ownerAdapterId: item.adapterId })),
  backend: {
    ...transientBase.backend,
    async getLogs() { return []; },
    async call() {
      throw Object.assign(new Error("local reth timed out"), { code: "TIMEOUT" });
    },
  },
};
const transientResult = await runProtocolDiscovery({
  adapters: [erc4626Adapter],
  context: transientRetainedContext,
  protocolEdgesEnabled: true,
  attestIdentity: attester,
});
assert(
  !transientResult.evaluationComplete && transientResult.wouldAdmit.length === 0,
  "transient retained re-verification must stay incomplete",
);
const transientProjection = prepareProtocolDiscoveryProjection({
  currentOwnership: projection.ownership,
  result: transientResult,
  currentBackrunPools: projection.strategyViews.backrun,
  currentBackrunGraph: projection.backrunGraph,
  currentBlockscanGraph: projection.blockscanGraph,
  currentKnownPoolKeys: projection.knownPoolKeys,
  buildStrategyViews: buildViews,
});
assert(
  transientProjection.ownership.admissions.size === 1,
  "transient failure must retain prior route ownership",
);
assert(
  transientProjection.backrunGraph.length === 3,
  "transient failure must not revoke previously verified edges",
);

const healthyDynamicTarget = "0x5555555555555555555555555555555555555555";
const healthyDynamicAdapterId = "protocol:healthy-dynamic";
const observedAdmission = first.wouldAdmit[0];
const healthyDynamicEdges = observedAdmission.edges.map((edge) => ({
  ...edge,
  target: healthyDynamicTarget,
}));
const healthyDynamicInstance = {
  ...observedAdmission.instance,
  ownerAdapterId: healthyDynamicAdapterId,
  pool: {
    ...observedAdmission.instance.pool,
    address: healthyDynamicTarget,
  },
};
const healthyDynamicAdmission = {
  ...observedAdmission,
  adapterId: healthyDynamicAdapterId,
  instance: healthyDynamicInstance,
  edges: healthyDynamicEdges,
  claims: deriveVerifiedRouteClaims(
    healthyDynamicAdapterId,
    healthyDynamicInstance,
    healthyDynamicEdges,
    firstContext.chainId,
    erc4626Adapter.discoveryIdentityAuthority,
  ),
};
const mixedOwnership = {
  version: 7,
  admissions: new Map([
    [
      protocolInstanceKey(
        observedAdmission.adapterId,
        observedAdmission.instance.pool,
      ),
      observedAdmission,
    ],
    [
      protocolInstanceKey(
        healthyDynamicAdmission.adapterId,
        healthyDynamicAdmission.instance.pool,
      ),
      healthyDynamicAdmission,
    ],
  ]),
};
const observedHistoryInvalidation =
  prepareProtocolDiscoveryFamilyInvalidation({
    currentOwnership: mixedOwnership,
    invalidatedAdapterIds: new Set([observedAdmission.adapterId]),
    currentBackrunPools: [
      {
        address: STATIC_TARGET,
        adapter: "psm",
        fixedTokenIn: ASSET,
        fixedTokenOut: RECEIVER,
        fixedSlotKind: "protocol",
        fixedProtocolAction: "convert",
      },
      {
        ...observedAdmission.instance.pool,
        discoveryOwnerAdapterId: observedAdmission.adapterId,
      },
      {
        ...healthyDynamicAdmission.instance.pool,
        discoveryOwnerAdapterId: healthyDynamicAdmission.adapterId,
      },
    ],
    currentBackrunGraph: [
      staticEdge,
      ...observedAdmission.edges,
      ...healthyDynamicAdmission.edges,
    ],
    currentBlockscanGraph: [
      staticEdge,
      ...observedAdmission.edges,
      ...healthyDynamicAdmission.edges,
    ],
    currentKnownPoolKeys: new Set([
      STATIC_TARGET.toLowerCase(),
      VAULT.toLowerCase(),
      healthyDynamicTarget.toLowerCase(),
    ]),
    buildStrategyViews: buildViews,
  });
assert(
  observedHistoryInvalidation.projection.ownership.admissions.size === 1 &&
    [...observedHistoryInvalidation.projection.ownership.admissions.values()]
      .every(({ adapterId }) => adapterId === healthyDynamicAdapterId),
  "cursor reorg invalidation must revoke only the affected dynamic family",
);
assert(
  observedHistoryInvalidation.projection.backrunGraph.length === 3 &&
    observedHistoryInvalidation.projection.backrunGraph
      .every((edge) => edge.target.toLowerCase() !== VAULT.toLowerCase()) &&
    observedHistoryInvalidation.projection.backrunGraph
      .some((edge) => edge.target.toLowerCase() === STATIC_TARGET.toLowerCase()) &&
    observedHistoryInvalidation.projection.backrunGraph
      .filter((edge) =>
        edge.target.toLowerCase() === healthyDynamicTarget.toLowerCase()
      ).length === 2,
  "cursor reorg invalidation must remove stale edges while preserving static and healthy siblings",
);
assert(
  observedHistoryInvalidation.projection.blockscanGraph?.length === 3,
  "cursor reorg invalidation must update the block-scan graph in the same projection",
);

console.log("erc4626-instance-discovery PASS");

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { angstromV4SwapActionAdapter } from "../../adapters/angstrom-v4.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND } from
  "../runtime-evidence.js";
import type { UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../venues/adapter-request-program.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { angstromV4StrictFamilyPlugin } from "../venues/swaps/angstrom-v4-family-plugin.js";
import {
  ANGSTROM_INITIALIZE_PATTERN_ID,
  ANGSTROM_SWAP_CALL_PATTERN_ID,
} from "../venues/swaps/angstrom-v4-family/codec.js";
import {
  angstromRuntimeEvidenceHash,
  requireAngstromRuntimeEvidence,
} from "../venues/swaps/angstrom-v4-family/evidence.js";
import {
  ANGSTROM_ADAPTER_SWAP_ABI,
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_MAINNET_HOOK,
} from "../venues/swaps/angstrom-attestation.js";
import {
  blockScanMulticallIface,
} from "../venues/swaps/blockscan-state-shared.js";
import {
  UNIV4_POOL_MANAGER_INTERFACE,
  UNIV4_QUOTER_INTERFACE,
  UNIV4_STATE_VIEW_INTERFACE,
} from "../venues/swaps/univ4-abi.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_100,
  hash: `0x${"cd".repeat(32)}`,
  generation: 9,
});
const TX_HASH = `0x${"ef".repeat(32)}`;
const TOKEN0 = "0x1000000000000000000000000000000000000011";
const TOKEN1 = "0x2000000000000000000000000000000000000022";
const EXECUTOR = "0x3000000000000000000000000000000000000033";
const CONTROLLER = "0x4000000000000000000000000000000000000044";
const VALIDATOR = "0x5000000000000000000000000000000000000055";
const KEY = Object.freeze({
  currency0: TOKEN0,
  currency1: TOKEN1,
  fee: 0x80_0000,
  tickSpacing: 10,
  hooks: ANGSTROM_MAINNET_HOOK,
});
const POOL_ID = v4PoolId(KEY);
const Q96 = 1n << 96n;
const LIQUIDITY = 1_000_000_000_000_000_000_000_000n;
const UNLOCK_DATA = ethers.concat([VALIDATOR, "0x01"]);
const ADAPTER_INTERFACE = new ethers.Interface(ANGSTROM_ADAPTER_SWAP_ABI);

const adapterCall = ADAPTER_INTERFACE.encodeFunctionData("swap", [
  KEY,
  true,
  1_000_000n,
  900_000n,
  [{ blockNumber: BigInt(SOURCE.number), unlockData: UNLOCK_DATA }],
  EXECUTOR,
  (1n << 256n) - 1n,
]);
const callObservation: UnifiedObservation = Object.freeze({
  kind: "call",
  source: SOURCE,
  target: ANGSTROM_MAINNET_ADAPTER,
  data: adapterCall,
  transactionHash: TX_HASH,
});
const candidate = angstromV4StrictFamilyPlugin.discovery.decodeCandidate({
  observation: callObservation,
  matchedPatternId: ANGSTROM_SWAP_CALL_PATTERN_ID,
});
assert(candidate !== null);
assert.equal(candidate.poolId, POOL_ID);

const identityVariant = angstromV4StrictFamilyPlugin.identity.variants[0];
assert.deepEqual(
  identityVariant.decide({ candidate, step: 0 }),
  { status: "continue" },
);
assert.deepEqual(
  identityVariant.decide({
    candidate: { ...candidate, adapter: EXECUTOR },
    step: 0,
  }),
  { status: "chain-proven-rejected", reasonCode: "foreign_angstrom_adapter", evidenceRequestIds: [] },
);
assert.deepEqual(
  identityVariant.decide({
    candidate: { ...candidate, manager: EXECUTOR },
    step: 0,
  }),
  { status: "chain-proven-rejected", reasonCode: "foreign_pool_manager", evidenceRequestIds: [] },
);
assert.deepEqual(
  identityVariant.decide({
    candidate: {
      ...candidate,
      poolId: v4PoolId({ ...KEY, hooks: EXECUTOR }),
      poolKey: { ...KEY, hooks: EXECUTOR },
    },
    step: 0,
  }),
  { status: "chain-proven-rejected", reasonCode: "foreign_hook_fail_closed", evidenceRequestIds: [] },
);
const staticEvidence = {
  phase: "pool-hook-static" as const,
  managerCodeHash: `0x${"11".repeat(32)}`,
  adapterCodeHash: `0x${"22".repeat(32)}`,
  hookCodeHash: `0x${"33".repeat(32)}`,
  sqrtPriceX96: Q96,
  liquidity: LIQUIDITY,
  controller: CONTROLLER,
};
assert.deepEqual(
  identityVariant.decide({ candidate, step: 1, evidence: staticEvidence }),
  { status: "continue" },
);
const verified = identityVariant.decide({
  candidate,
  step: 2,
  evidence: {
    ...staticEvidence,
    phase: "controller-reverse",
    canonicalHook: ANGSTROM_MAINNET_HOOK,
  },
});
assert.equal(verified.status, "verified");
if (verified.status !== "verified") throw new Error("angstrom identity fixture");

const draft = angstromV4StrictFamilyPlugin.instance.compileDraft(verified.identity);
const descriptor = angstromV4StrictFamilyPlugin.instance.finalizeDescriptor({
  identity: verified.identity,
  draft,
  sharedBindings: [],
});
const routes = angstromV4StrictFamilyPlugin.routes.project({ descriptor });
assert.equal(routes.length, 2);
assert.deepEqual(
  descriptor.runtimeRequirements.map((requirement) => requirement.kind),
  ["source-state", "head-evidence", "extension-policy", "opaque-payload"],
);
assert.notEqual(
  hashCanonical(angstromV4StrictFamilyPlugin.pricing.snapshotCompatibilityProjection({
    descriptor,
    routes,
  })),
  hashCanonical(angstromV4StrictFamilyPlugin.pricing.snapshotCompatibilityProjection({
    descriptor,
    routes: [routes[0]],
  })),
  "Angstrom precision compatibility stays direction-bound",
);

const pricingDraft = angstromV4StrictFamilyPlugin.pricing.compileDraft({
  descriptor,
  stateKey: POOL_ID,
  routes,
});
const pricingDescriptor =
  angstromV4StrictFamilyPlugin.pricing.finalizePricingDescriptor({
    draft: pricingDraft,
    sharedBindings: [],
  });
const currentInput = { descriptor: pricingDescriptor, routes, source: SOURCE };
assert.equal(
  angstromV4StrictFamilyPlugin.pricing.current.buildRequests(currentInput).length,
  2,
);
const coreResults = [
  success(
    "current-slot0",
    UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult(
      "getSlot0",
      [Q96, 0, 0, KEY.fee],
    ),
  ),
  success(
    "current-liquidity",
    UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult(
      "getLiquidity",
      [LIQUIDITY],
    ),
  ),
];
const snapshot = angstromV4StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: coreResults,
  dependentEvidence: [],
});
assert.equal(snapshot.source.hash, SOURCE.hash);
const mids = angstromV4StrictFamilyPlugin.pricing.current.deriveMids({
  descriptor: pricingDescriptor,
  snapshot,
  routes,
});
const unavailable =
  angstromV4StrictFamilyPlugin.pricing.current.classifyUnavailable!({
    descriptor: pricingDescriptor,
    snapshot,
    routes,
  });
assert.equal(mids.size + unavailable.size, 2);
assert.throws(
  () => angstromV4StrictFamilyPlugin.pricing.current.decodeSnapshot({
    descriptor: pricingDescriptor,
    initialResults: [
      { id: "current-slot0", ok: false, source: SOURCE, failure: "deadline" },
      coreResults[1],
    ],
    dependentEvidence: [],
  }),
  /unresolved: deadline/,
);

const payload = ethers.AbiCoder.defaultAbiCoder().encode(
  ["tuple(uint64 blockNumber,bytes unlockData)[]"],
  [[{ blockNumber: BigInt(SOURCE.number), unlockData: UNLOCK_DATA }]],
);
const payloadHash = ethers.keccak256(payload);
const runtimeEvidence = Object.freeze({
  evidenceId: "angstrom-current-head",
  familyId: angstromV4StrictFamilyPlugin.manifest.familyId,
  instanceKey: descriptor.instanceKey,
  kind: "angstrom-empty-block-attestation",
  scope: "transaction" as const,
  source: SOURCE,
  txHash: TX_HASH,
  evidenceHash: angstromRuntimeEvidenceHash({
    txHash: TX_HASH,
    source: SOURCE,
    payloadHash,
  }),
  sealedPayloadRef: payload,
});
const pendingRuntimeEvidence = Object.freeze({
  ...runtimeEvidence,
  kind: PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND,
  evidenceHash: ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "bytes32", "uint256", "bytes32", "bytes32"],
      [
        runtimeEvidence.familyId,
        TX_HASH,
        SOURCE.number,
        SOURCE.hash,
        payloadHash,
      ],
    ),
  ),
});
assert.equal(
  requireAngstromRuntimeEvidence({
    descriptor,
    source: SOURCE,
    runtimeEvidence: [pendingRuntimeEvidence],
  }).payloadHash,
  payloadHash,
  "Angstrom must validate the generic strict pending envelope before use",
);
const amountIn = 1_000_000n;
const exactInput = {
  descriptor,
  route: routes[0],
  amountIn,
  source: SOURCE,
  executor: EXECUTOR,
  runtimeEvidence: [runtimeEvidence],
};
const exactRequestMethod = angstromV4StrictFamilyPlugin.exact.methods(exactInput)[1];
assert.equal(exactRequestMethod.kind, "request-program");
if (exactRequestMethod.kind !== "request-program") {
  throw new Error("Angstrom exact request program missing");
}
const exactRequest = exactRequestMethod.program.buildRequests(exactInput)[0];
const amountOut = 900_000n;
const quoterReturn = UNIV4_QUOTER_INTERFACE.encodeFunctionResult(
  "quoteExactInputSingle",
  [amountOut, 80_000n],
);
const exact = exactRequestMethod.program.decode({
  programInput: exactInput,
  initialResults: [success(
    exactRequest.id,
    blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{
      success: true,
      returnData: quoterReturn,
    }]]),
  )],
  dependentEvidence: [],
});
assert.equal(exact.amountOut, amountOut);
const fragment = angstromV4StrictFamilyPlugin.execution.buildFragment({
  descriptor,
  route: routes[0],
  amountIn,
  quotedAmountOut: amountOut,
  minAmountOut: amountOut,
  exactEvidence: exact.evidence,
  executor: EXECUTOR,
  runtimeEvidence: [runtimeEvidence],
});
assert.equal(fragment.nodes[0].adapterId, "angstrom-v4-swap");
assert.deepEqual(
  angstromV4StrictFamilyPlugin.actionAdapters[0].encode(
    fragment.nodes[0],
    EXECUTOR,
    new Uint8Array(),
  ),
  angstromV4SwapActionAdapter.encode(
    fragment.nodes[0],
    EXECUTOR,
    new Uint8Array(),
  ),
);
assert.throws(
  () => angstromV4StrictFamilyPlugin.execution.buildFragment({
    descriptor,
    route: routes[0],
    amountIn,
    quotedAmountOut: amountOut,
    minAmountOut: amountOut,
    exactEvidence: exact.evidence,
    executor: EXECUTOR,
    runtimeEvidence: [{
      ...runtimeEvidence,
      source: { ...SOURCE, number: SOURCE.number + 1 },
    }],
  }),
  /stale or foreign/,
);

const observedCall = angstromV4StrictFamilyPlugin.swap.observation.decode({
  observation: callObservation,
});
assert.equal(observedCall.length, 1);
assert.equal(
  (observedCall[0].canonicalPayload as { readonly amountIn: bigint }).amountIn,
  amountIn,
);
const swapLog = UNIV4_POOL_MANAGER_INTERFACE.encodeEventLog(
  UNIV4_POOL_MANAGER_INTERFACE.getEvent("Swap")!,
  [POOL_ID, ANGSTROM_MAINNET_ADAPTER, -amountIn, amountOut, Q96, LIQUIDITY, 0, KEY.fee],
);
const swapObservation: UnifiedObservation = Object.freeze({
  kind: "log",
  source: SOURCE,
  address: ADDR.UNISWAP_V4_POOL_MANAGER,
  topics: Object.freeze(swapLog.topics),
  data: swapLog.data,
});
const observedLog = angstromV4StrictFamilyPlugin.swap.observation.decode({
  observation: swapObservation,
});
assert.equal(observedLog.length, 1);
assert.equal(
  Object.hasOwn(observedLog[0].canonicalPayload as object, "amountOut"),
  false,
  "PoolManager pre-afterSwap delta is not published as Angstrom exact output",
);
const impact = {
  pool: ADDR.UNISWAP_V4_POOL_MANAGER,
  tokenIn: TOKEN0,
  tokenOut: TOKEN1,
  amountIn,
  exactPostState: {
    poolId: POOL_ID,
    sqrtPriceX96: Q96,
    tick: 0,
    liquidity: LIQUIDITY,
    lpFee: KEY.fee,
  },
};
assert.equal(
  angstromV4StrictFamilyPlugin.swap.replay!.applyLocal({
    descriptor,
    route: routes[0],
    preState: {},
    impact,
    source: SOURCE,
  }),
  null,
);
assert.equal(
  (angstromV4StrictFamilyPlugin.swap.replay!.exactPostState!({
    descriptor,
    route: routes[0],
    impact,
    source: SOURCE,
  }) as { readonly kind: string } | null)?.kind,
  "v4",
);

const initialize = UNIV4_POOL_MANAGER_INTERFACE.encodeEventLog(
  UNIV4_POOL_MANAGER_INTERFACE.getEvent("Initialize")!,
  [POOL_ID, TOKEN0, TOKEN1, KEY.fee, KEY.tickSpacing, KEY.hooks, Q96, 0],
);
assert.notEqual(
  angstromV4StrictFamilyPlugin.swap.poolMaterialization!.candidateBinding({
    observation: {
      kind: "log",
      source: SOURCE,
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      topics: initialize.topics,
      data: initialize.data,
    },
  }),
  null,
);
const foreignKey = { ...KEY, hooks: EXECUTOR };
const foreignInitialize = UNIV4_POOL_MANAGER_INTERFACE.encodeEventLog(
  UNIV4_POOL_MANAGER_INTERFACE.getEvent("Initialize")!,
  [
    v4PoolId(foreignKey),
    TOKEN0,
    TOKEN1,
    KEY.fee,
    KEY.tickSpacing,
    EXECUTOR,
    Q96,
    0,
  ],
);
assert.equal(
  angstromV4StrictFamilyPlugin.swap.poolMaterialization!.candidateBinding({
    observation: {
      kind: "log",
      source: SOURCE,
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      topics: foreignInitialize.topics,
      data: foreignInitialize.data,
    },
  }),
  null,
);
assert.equal(
  angstromV4StrictFamilyPlugin.discovery.decodeCandidate({
    observation: {
      kind: "log",
      source: SOURCE,
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      topics: initialize.topics,
      data: initialize.data,
    },
    matchedPatternId: ANGSTROM_INITIALIZE_PATTERN_ID,
  })?.poolId,
  POOL_ID,
);

const summary = definedFamilyPluginContractSummary(
  angstromV4StrictFamilyPlugin,
);
assert.deepEqual(summary.ownedActionAdapterIds, ["angstrom-v4-swap"]);
console.log("angstrom-v4 strict Family plugin tests passed");

function success(
  id: string,
  data: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: Object.freeze({ kind: "fixture", fingerprint: id }),
    completion: "returned" as const,
    data,
  });
}

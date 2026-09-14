import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { createAdapterFamilyExactQuoteCache } from "../adapter-family-exact-quote-cache.js";
import { executeAdapterFamilyLifecycleBatch, executeFamilyExactQuote, buildFamilyExecutionFragment } from "../venues/adapter-family-runtime.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from "../venues/family-capability-catalog.js";
import { angstromV4SwapActionAdapter } from "../../adapters/angstrom-v4.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND } from
  "../runtime-evidence.js";
import type { V4PoolKey } from "../planner/token-graph.js";
import { instanceKey } from "../venues/adapter-family-identifiers.js";
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
  angstromRuntimeEvidenceFromObservation,
  requireAngstromRuntimeEvidence,
} from "../venues/swaps/angstrom-v4-family/evidence.js";
import {
  ANGSTROM_ADAPTER_SWAP_ABI,
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_MAINNET_HOOK,
  decodeAngstromExecutionEvidence,
  type AngstromAttestationInput,
} from "../venues/swaps/angstrom-attestation.js";
import {
  blockScanMulticallIface,
} from "../venues/swaps/blockscan-state-shared.js";
import {
  UNIV4_POOL_MANAGER_INTERFACE,
  UNIV4_QUOTER_INTERFACE,
  UNIV4_STATE_VIEW_INTERFACE,
  ANGSTROM_HOOK_STATE_INTERFACE,
  ANGSTROM_CONTROLLER_INTERFACE,
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
  ["source-state", "extension-policy"],
);
assert.deepEqual(descriptor.runtimeRequirements, [
  { kind: "source-state", freshness: "pinned-block" },
  { kind: "extension-policy", mode: "quote-and-final-sim", extensionBinding: ANGSTROM_MAINNET_HOOK },
]);
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
console.log("angstrom-v4 existing strict Family fixtures passed");

// Offline signatures from the existing attestation test signer. These are
// semantic fixtures, never validator-authority or historical/live evidence.
const observationSigner = new ethers.Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412e5b41436b2d59d",
);
async function signedObservationProof(blockNumber: bigint): Promise<AngstromAttestationInput> {
  const signature = await observationSigner.signTypedData(
    { name: "Angstrom", version: "v1", chainId: 1n, verifyingContract: ANGSTROM_MAINNET_HOOK },
    { AttestAngstromBlockEmpty: [{ name: "block_number", type: "uint64" }] },
    { block_number: blockNumber },
  );
  return { blockNumber, unlockData: ethers.concat([observationSigner.address, signature]) };
}
const currentProof = await signedObservationProof(BigInt(SOURCE.number));
const previousProof = await signedObservationProof(BigInt(SOURCE.number - 1));
const nextProof = await signedObservationProof(BigInt(SOURCE.number + 1));
const wrongSignerProof = {
  ...currentProof,
  unlockData: ethers.concat([VALIDATOR, ethers.dataSlice(currentProof.unlockData, 20)]),
};
function observationWithProofs(
  proofs: readonly AngstromAttestationInput[],
  key: V4PoolKey = KEY,
  zeroForOne = true,
): Extract<UnifiedObservation, { readonly kind: "call" }> {
  return {
    kind: "call",
    source: SOURCE,
    target: ANGSTROM_MAINNET_ADAPTER,
    transactionHash: TX_HASH,
    data: ADAPTER_INTERFACE.encodeFunctionData("swap", [
      key, zeroForOne, amountIn, amountOut, proofs, EXECUTOR, (1n << 256n) - 1n,
    ]),
  };
}
function observationEvidence(proofs: readonly AngstromAttestationInput[]) {
  return angstromV4StrictFamilyPlugin.discovery.runtimeEvidenceFromObservation!({
    observation: observationWithProofs(proofs), source: SOURCE,
  });
}

test("Angstrom observation producer binds a consumable current-source instance", () => {
  const emitted = observationEvidence([currentProof]);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].instanceKey, descriptor.instanceKey);
  assert.equal(emitted[0].txHash, TX_HASH);
  assert.deepEqual(emitted[0].source, SOURCE);
  assert(Object.isFrozen(emitted) && Object.isFrozen(emitted[0]));
  const bound = requireAngstromRuntimeEvidence({ descriptor, source: SOURCE, runtimeEvidence: emitted });
  assert.equal(bound.attestations.length, 1);
  assert.equal(bound.attestations[0].unlockData, currentProof.unlockData);
  assert.equal(bound.attestations[0].eoaSignatureValid, true);
  const otherKey = { ...KEY, tickSpacing: KEY.tickSpacing + 1 };
  const otherEvidence = angstromRuntimeEvidenceFromObservation({
    observation: observationWithProofs([currentProof], otherKey), source: SOURCE,
  });
  assert.equal(otherEvidence[0].instanceKey,
    `${ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase()}\u001f${v4PoolId(otherKey)}`);
  assert.throws(() => requireAngstromRuntimeEvidence({
    descriptor, source: SOURCE, runtimeEvidence: otherEvidence,
  }), /escaped its instance/, "a different observed PoolKey must not borrow this instance");
});

test("Angstrom stale-first bundle selects the valid current-source proof", () => {
  for (const bundle of [
    [previousProof, currentProof, nextProof],
    [nextProof, previousProof, currentProof],
    [wrongSignerProof, currentProof],
    [currentProof, currentProof],
  ]) {
    const emitted = observationEvidence(bundle);
    assert.equal(emitted.length, 1);
    const proofs = decodeAngstromExecutionEvidence(emitted[0].sealedPayloadRef);
    assert.deepEqual(proofs.map(proof => proof.blockNumber), [BigInt(SOURCE.number)]);
    assert.equal(proofs[0].unlockData, currentProof.unlockData);
    assert.doesNotThrow(() => requireAngstromRuntimeEvidence({
      descriptor, source: SOURCE, runtimeEvidence: emitted,
    }));
  }
});

test("Angstrom observation producer never promotes an invalid or wrong-block signature", () => {
  for (const bundle of [
    [], [previousProof], [nextProof], [previousProof, nextProof],
    [wrongSignerProof],
    [{ ...currentProof, unlockData: previousProof.unlockData }],
    [{ ...currentProof, unlockData: "0x" }],
    [{ ...currentProof, unlockData: UNLOCK_DATA }],
    [{ ...currentProof, unlockData: ethers.concat([VALIDATOR, `0x${"ab".repeat(103)}`]) }],
  ]) {
    assert.deepEqual(observationEvidence(bundle), [], "no unusable proof may be emitted");
  }
});

test("Angstrom observation producer preserves call, transaction and source identity", () => {
  const observation = observationWithProofs([currentProof]);
  const invalid: UnifiedObservation[] = [
    { ...observation, transactionHash: undefined },
    { ...observation, transactionHash: "0x01" },
    { ...observation, target: EXECUTOR },
    { ...observation, data: "0x" },
    observationWithProofs([currentProof], { ...KEY, hooks: EXECUTOR }),
    observationWithProofs([currentProof], { ...KEY, currency0: ethers.ZeroAddress }),
    observationWithProofs([currentProof], { ...KEY, currency0: TOKEN1, currency1: TOKEN0 }),
    ...[
      { ...SOURCE, number: SOURCE.number + 1 },
      { ...SOURCE, hash: `0x${"ab".repeat(32)}` },
      { ...SOURCE, generation: SOURCE.generation + 1 },
    ].map(source => ({ ...observation, source })),
    swapObservation,
  ];
  for (const observation of invalid) {
    assert.deepEqual(angstromRuntimeEvidenceFromObservation({ observation, source: SOURCE }), []);
  }
});

test("Angstrom observed evidence rejects instance, transaction, source and payload drift", () => {
  const emitted = observationEvidence([currentProof]);
  assert.equal(emitted.length, 1);
  assert.doesNotThrow(() => requireAngstromRuntimeEvidence({ descriptor, source: SOURCE, runtimeEvidence: emitted }));
  for (const changed of [
    { ...emitted[0], instanceKey: instanceKey(`${descriptor.instanceKey}-foreign`) },
    { ...emitted[0], txHash: `0x${"ab".repeat(32)}` },
    { ...emitted[0], scope: "head" as const },
    { ...emitted[0], sealedPayloadRef: payload },
    ...[
      { ...SOURCE, number: SOURCE.number + 1 },
      { ...SOURCE, hash: `0x${"ab".repeat(32)}` },
      { ...SOURCE, generation: SOURCE.generation + 1 },
    ].map(source => ({ ...emitted[0], source })),
  ]) {
    assert.throws(() => requireAngstromRuntimeEvidence({ descriptor, source: SOURCE, runtimeEvidence: [changed] }));
  }
  assert.throws(() => requireAngstromRuntimeEvidence({ descriptor, source: SOURCE, runtimeEvidence: [] }), /exactly one/);
  assert.throws(() => requireAngstromRuntimeEvidence({ descriptor, source: SOURCE, runtimeEvidence: [...emitted, ...emitted] }), /exactly one/);
});

test("Angstrom observed proof reaches both directional quoter and execution hook data unchanged", () => {
  for (const route of routes) {
    const runtimeEvidence = angstromRuntimeEvidenceFromObservation({
      observation: observationWithProofs([previousProof, currentProof], KEY, route.direction === "zero-for-one"),
      source: SOURCE,
    });
    const programInput = { ...exactInput, route, runtimeEvidence };
    const method = angstromV4StrictFamilyPlugin.exact.methods(programInput)[1];
    if (method.kind !== "request-program") throw new Error("missing Angstrom chain quote");
    assert.equal(method.chainAmountQuote, true);
    const request = method.program.buildRequests(programInput)[0];
    if (request.kind !== "eth-call") throw new Error("missing Angstrom quoter call");
    const calls = blockScanMulticallIface.decodeFunctionData("aggregate3", request.data)[0];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, descriptor.immutableBinding.quoter);
    const params = UNIV4_QUOTER_INTERFACE.decodeFunctionData("quoteExactInputSingle", calls[0].callData)[0];
    assert.equal(params.hookData, currentProof.unlockData);
    assert.equal(params.poolKey.hooks, ANGSTROM_MAINNET_HOOK);
    assert.equal(params.exactAmount, amountIn);
    assert.equal(params.zeroForOne, route.direction === "zero-for-one");
    const exact = method.program.decode({
      programInput,
      initialResults: [success(request.id, blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{
        success: true, returnData: quoterReturn,
      }]]))],
      dependentEvidence: [],
    });
    const fragment = angstromV4StrictFamilyPlugin.execution.buildFragment({
      descriptor, route, amountIn, quotedAmountOut: exact.amountOut, minAmountOut: exact.amountOut,
      exactEvidence: exact.evidence, executor: EXECUTOR, runtimeEvidence,
    });
    assert.equal(fragment.nodes[0].target, ANGSTROM_MAINNET_ADAPTER);
    assert.equal(fragment.nodes[0].params.hooks, ANGSTROM_MAINNET_HOOK);
    assert.deepEqual(fragment.nodes[0].params.attestationBlockNumbers, [BigInt(SOURCE.number)]);
    assert.deepEqual(fragment.nodes[0].params.attestationUnlockData, [currentProof.unlockData]);
    assert.throws(() => method.program.decode({
      programInput,
      initialResults: [success(request.id, blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{
        success: false, returnData: "0x",
      }]]))],
      dependentEvidence: [],
    }), /no verified attestation/, "failed hook-aware quote must not fall back to local pricing");
  }
});

test("Angstrom strict pending authority checks remain required and independent of synchronous projection", async () => {
  const hookState = new ethers.Interface(["function extsload(uint256 slot) view returns (uint256)"]);
  const controller = new ethers.Interface(["function ANGSTROM() view returns (address)"]);
  const signerSlot = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256"], [observationSigner.address, 1n],
  )));
  async function observe(proofs: readonly AngstromAttestationInput[], node: bigint, hook = ANGSTROM_MAINNET_HOOK) {
    let reads = 0;
    const emitted = await angstromV4StrictFamilyPlugin.discovery.pendingRuntimeEvidenceFromObservation!({
      observation: observationWithProofs(proofs), source: SOURCE,
      async call(read) {
        reads++;
        if (read.to.toLowerCase() === ANGSTROM_MAINNET_HOOK.toLowerCase()) {
          assert.equal(BigInt(hookState.decodeFunctionData("extsload", read.data)[0]), 0n);
          return hookState.encodeFunctionResult("extsload", [BigInt(CONTROLLER)]);
        }
        if (read.to.toLowerCase() === CONTROLLER.toLowerCase()) {
          assert.equal(read.data, controller.encodeFunctionData("ANGSTROM"));
          return controller.encodeFunctionResult("ANGSTROM", [hook]);
        }
        assert.equal(reads, 3, "node membership must follow both reverse-binding reads");
        const calls = blockScanMulticallIface.decodeFunctionData("aggregate3", read.data)[0];
        assert.equal(calls.length, 1);
        assert.equal(calls[0].target.toLowerCase(), ANGSTROM_MAINNET_HOOK.toLowerCase());
        assert.equal(BigInt(hookState.decodeFunctionData("extsload", calls[0].callData)[0]), signerSlot);
        return blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{
          success: true, returnData: hookState.encodeFunctionResult("extsload", [node]),
        }]]);
      },
    });
    return { emitted, reads };
  }
  const authorized = await observe([previousProof, currentProof], 1n);
  assert.equal(authorized.reads, 3);
  const bound = requireAngstromRuntimeEvidence({
    descriptor, source: SOURCE, runtimeEvidence: authorized.emitted,
  });
  assert.equal(bound.attestations[0].unlockData, currentProof.unlockData);
  assert.equal(authorized.emitted[0].instanceKey, undefined,
    "the unchanged pending capability remains explicitly family-scoped");
  const unauthorized = await observe([currentProof], 0n);
  assert.equal(unauthorized.reads, 3);
  assert.deepEqual(unauthorized.emitted, [], "valid EOA signature alone is not current node authority");
  const stale = await observe([previousProof], 1n);
  assert.equal(stale.reads, 0);
  assert.deepEqual(stale.emitted, []);
  await assert.rejects(observe([currentProof], 1n, EXECUTOR), /does not govern canonical hook/);
});

test("Angstrom empty evidence selects an isolated source-unlocked chain quote", () => {
  for (const route of routes) {
    const input = { ...exactInput, route, amountIn: 123457n, runtimeEvidence: [] };
    const method = angstromV4StrictFamilyPlugin.exact.methods(input)[1];
    assert.equal(method.id, "source-unlocked-quoter");
    assert.equal(method.kind, "request-program");
    if (method.kind !== "request-program") throw new Error("missing chain quote");
    assert.equal(method.chainAmountQuote, true);
    const requests = method.program.buildRequests(input);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw new Error("missing quoter call");
    const calls = blockScanMulticallIface.decodeFunctionData("aggregate3", request.data)[0];
    assert.equal(calls.length, 1, "no sibling may unlock state for the quote");
    assert.equal(calls[0].target, descriptor.immutableBinding.quoter);
    const params = UNIV4_QUOTER_INTERFACE.decodeFunctionData("quoteExactInputSingle", calls[0].callData)[0];
    assert.equal(params.hookData, "0x");
    assert.equal(params.exactAmount, input.amountIn);
    assert.equal(params.zeroForOne, route.direction === "zero-for-one");
    assert.equal(v4PoolId(params.poolKey), POOL_ID);
    const quote = method.program.decode({ programInput: input, dependentEvidence: [],
      initialResults: [success(request.id, blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{
        success: true, returnData: quoterReturn,
      }]]))] });
    assert.equal(quote.amountOut, amountOut);
    assert.equal(quote.evidence.kind, "angstrom-v4-source-unlocked-quoter");
    assert.deepEqual(quote.evidence.source, SOURCE);
    for (const key of ["txHash", "payloadHash", "runtimeEvidenceHash", "attestationEvidenceHashes"]) {
      assert.equal(key in quote.evidence, false, "unsigned quote must not invent signed evidence");
    }
    const fragment = angstromV4StrictFamilyPlugin.execution.buildFragment({
      descriptor, route, amountIn: input.amountIn, quotedAmountOut: quote.amountOut,
      minAmountOut: quote.amountOut, exactEvidence: quote.evidence, executor: EXECUTOR, runtimeEvidence: [],
    });
    assert.equal(fragment.nodes[0].params.unlockMode, "source-unlocked");
    assert.equal(fragment.nodes[0].params.sourceBlock, BigInt(SOURCE.number));
    const bytes = angstromV4SwapActionAdapter.encode(fragment.nodes[0], EXECUTOR, new Uint8Array());
    assert.equal(bytes[0], 0x00, "value-zero real adapter CALL");
    const encoded = ADAPTER_INTERFACE.decodeFunctionData("swap", ethers.hexlify(bytes.slice(24)));
    assert.equal(encoded[4].length, 1);
    assert.equal(encoded[4][0].blockNumber, BigInt(SOURCE.number), "never B+1");
    assert.equal(encoded[4][0].unlockData, "0x");
    assert.equal(encoded[5], EXECUTOR);
  }
});

function unsignedMethod(input = { ...exactInput, runtimeEvidence: [] as typeof exactInput.runtimeEvidence }) {
  const method = angstromV4StrictFamilyPlugin.exact.methods(input)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing chain quote");
  return method;
}

test("Angstrom unsigned decode rejects locked, malformed, reverted, empty and foreign-source results", () => {
  const input = { ...exactInput, runtimeEvidence: [] };
  const method = unsignedMethod(input);
  const id = method.program.buildRequests(input)[0].id;
  const aggregate = (rows: { success: boolean; returnData: string }[]) =>
    success(id, blockScanMulticallIface.encodeFunctionResult("aggregate3", [rows]));
  const good = aggregate([{ success: true, returnData: quoterReturn }]);
  const bad: readonly AdapterRequestResult[][] = [
    [], [good, good],
    [aggregate([])], [aggregate([{ success: true, returnData: quoterReturn }, { success: true, returnData: quoterReturn }])],
    [aggregate([{ success: false, returnData: quoterReturn }])],
    ...["0x", "0x1234", UNIV4_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [0n, 1n]),
      UNIV4_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [1n << 128n, 1n])]
      .map(returnData => [aggregate([{ success: true, returnData }])]),
    [{ ...good, completion: "reverted-as-declared" }],
    [{ ...good, id: "foreign" }],
    [{ id, ok: false, source: SOURCE, failure: "rpc" }],
    ...[{ ...SOURCE, number: SOURCE.number + 1 }, { ...SOURCE, hash: ethers.ZeroHash },
      { ...SOURCE, generation: SOURCE.generation + 1 }].map(source => [{ ...good, source }]),
  ];
  for (const initialResults of bad) assert.throws(() => method.program.decode({
    programInput: input, initialResults, dependentEvidence: [],
  }));
});

test("Angstrom poisoned nonempty evidence cannot select or borrow the unsigned program", () => {
  const unsigned = { ...exactInput, runtimeEvidence: [] };
  const program = unsignedMethod(unsigned).program;
  const id = program.buildRequests(unsigned)[0].id;
  for (const runtimeEvidence of [
    [{ ...exactInput.runtimeEvidence[0], kind: "foreign" }],
    [{ ...exactInput.runtimeEvidence[0], source: { ...SOURCE, number: SOURCE.number - 1 } }],
    [{ ...exactInput.runtimeEvidence[0], sealedPayloadRef: "0x" }],
    [{ ...exactInput.runtimeEvidence[0], evidenceHash: ethers.ZeroHash }],
    [exactInput.runtimeEvidence[0], exactInput.runtimeEvidence[0]],
  ]) {
    const input = { ...exactInput, runtimeEvidence };
    assert.throws(() => angstromV4StrictFamilyPlugin.exact.methods(input));
    assert.throws(() => angstromV4StrictFamilyPlugin.exact.cacheCompatibilityProjection(input));
    assert.throws(() => program.buildRequests(input));
    assert.throws(() => program.decode({ programInput: input, dependentEvidence: [], initialResults: [success(id,
      blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{ success: true, returnData: quoterReturn }]]))] }));
  }
  assert.throws(() => exactRequestMethod.program.buildRequests(unsigned), /exactly one/,
    "a signed program cannot silently become unsigned either");
});

test("Angstrom unsigned cache binds mode, source, immutable bindings and executor", () => {
  const input = { ...exactInput, runtimeEvidence: [] };
  const fingerprint = (i: typeof input) => hashCanonical(angstromV4StrictFamilyPlugin.exact.cacheCompatibilityProjection(i));
  const base = fingerprint(input);
  assert.notEqual(base, hashCanonical(angstromV4StrictFamilyPlugin.exact.cacheCompatibilityProjection(exactInput)));
  for (const source of [{ ...SOURCE, number: SOURCE.number + 1 }, { ...SOURCE, hash: ethers.ZeroHash },
    { ...SOURCE, generation: SOURCE.generation + 1 }]) assert.notEqual(base, fingerprint({ ...input, source }));
  for (const field of ["managerCodeHash", "adapterCodeHash", "hookCodeHash"] as const) {
    assert.notEqual(base, fingerprint({ ...input, descriptor: { ...descriptor,
      immutableBinding: { ...descriptor.immutableBinding, [field]: ethers.ZeroHash } } }));
  }
  assert.notEqual(base, fingerprint({ ...input, executor: CONTROLLER }));
  assert.notEqual(base, fingerprint({ ...input, route: routes[1] }));
});

test("Angstrom local zero remains local, has no unsigned unlock authority, and signed zero stays compatible", () => {
  for (const runtimeEvidence of [[], exactInput.runtimeEvidence]) {
    const input = { ...exactInput, amountIn: 0n, runtimeEvidence };
    const methods = angstromV4StrictFamilyPlugin.exact.methods(input);
    const method = methods[0];
    assert.equal(method.kind, "local");
    if (method.kind !== "local") throw new Error("missing local zero");
    const attempt = method.quote(input);
    assert.equal(attempt.status, "quoted");
    if (attempt.status !== "quoted") throw new Error("missing zero quote");
    assert.equal(attempt.result.amountOut, 0n);
    assert.equal(attempt.result.evidence.kind, runtimeEvidence.length === 0
      ? "angstrom-v4-unsigned-local-zero" : "angstrom-v4-tx-bound-quoter");
    assert.deepEqual(unsignedMethod(input).program.buildRequests(input), []);
    assert.throws(() => angstromV4StrictFamilyPlugin.execution.buildFragment({
      descriptor, route: routes[0], amountIn: 0n, quotedAmountOut: 0n, minAmountOut: 0n,
      exactEvidence: attempt.result.evidence, executor: EXECUTOR, runtimeEvidence,
    }));
    assert.equal(method.quote({ ...input, amountIn: 1n }).status, "not-applicable");
  }
});

// Test-local catalog identities and mocked chain bytes exercise the existing
// issuer/lifecycle, not a production manifest or historical acceptance claim.
async function issuedAngstromFixture() {
  const plugin = angstromV4StrictFamilyPlugin;
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({
    familyId: plugin.manifest.familyId, capability, contractVersion: "s1-v1",
    contentHash: ethers.id(`angstrom-fixture:${capability}`).slice(2),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: "a".repeat(40),
  }));
  const catalog = new FamilyCapabilityCatalog({
    modules: [{ sourceFile: "fixture/angstrom.production.ts", plugin,
      definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) },
  });
  const family = catalog.forFamily(plugin.manifest.familyId);
  const state = { source: SOURCE, quotes: 0, unlocked: true, afterQuote: () => {} };
  const cache = createAdapterFamilyExactQuoteCache({ capacity: 32 });
  const runtime = { ...createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: CONTROLLER,
    generationFence: { assertCurrent(g, s) { assert.equal(g, state.source.generation); assert.deepEqual(s, state.source); } },
    provider: {
      getCode: async (_address, block) => { assert.equal(block, state.source.number); return "0x6000"; },
      getStorage: async () => { throw new Error("unexpected storage read"); },
      call: async (request, block) => {
        assert.equal(block, state.source.number);
        const selector = request.data.slice(0, 10);
        for (const [abi, name, values] of [
          [UNIV4_STATE_VIEW_INTERFACE, "getSlot0", [Q96, 0, 0, KEY.fee]],
          [UNIV4_STATE_VIEW_INTERFACE, "getLiquidity", [LIQUIDITY]],
          [ANGSTROM_HOOK_STATE_INTERFACE, "extsload", [BigInt(CONTROLLER)]],
          [ANGSTROM_CONTROLLER_INTERFACE, "ANGSTROM", [ANGSTROM_MAINNET_HOOK]],
        ] as const) if (selector === abi.getFunction(name)!.selector) return abi.encodeFunctionResult(name, values);
        assert.equal(selector, blockScanMulticallIface.getFunction("aggregate3")!.selector);
        const calls = blockScanMulticallIface.decodeFunctionData("aggregate3", request.data)[0];
        assert.equal(calls.length, 1);
        assert.equal(calls[0].target, descriptor.immutableBinding.quoter);
        const params = UNIV4_QUOTER_INTERFACE.decodeFunctionData("quoteExactInputSingle", calls[0].callData)[0];
        assert.equal(params.poolKey.hooks, ANGSTROM_MAINNET_HOOK);
        state.quotes++;
        state.afterQuote();
        return blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{
          success: state.unlocked,
          returnData: state.unlocked ? UNIV4_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [params.exactAmount - 1n, 90000n]) : "0x12345678",
        }]]);
      },
    },
  }), exactQuoteCache: cache };
  async function prepare(source = SOURCE) {
    state.source = source;
    const lifecycle = await executeAdapterFamilyLifecycleBatch({ family,
      matches: [{ observation: { ...callObservation, source }, matchedPatternId: ANGSTROM_SWAP_CALL_PATTERN_ID }],
      source, generation: source.generation, runtime, publisher: { publish: () => {} },
    });
    assert(lifecycle.publication, JSON.stringify(lifecycle.outcomes));
    assert.equal(lifecycle.publication.instances.length, 1);
    const route = lifecycle.publication.instances[0].routeHandles[0];
    assert(route);
    return { family, route, source, generation: source.generation, runtime,
      executor: EXECUTOR, runtimeEvidence: [], amountIn: 123457n, requireChainAmountQuote: true };
  }
  return { state, cache, catalog, prepare, input: await prepare() };
}

test("Angstrom actual issued Exact caches only identical source/mode/amount and produces the owning fragment", async () => {
  const f = await issuedAngstromFixture();
  const quote = await executeFamilyExactQuote(f.input);
  assert.equal(quote.status, "resolved");
  if (quote.status !== "resolved") throw new Error("missing issued quote");
  assert.equal(quote.amountIn, 123457n); assert.equal(quote.amountOut, 123456n);
  assert.equal(f.state.quotes, 1);
  assert.equal((await executeFamilyExactQuote(f.input)).status, "resolved");
  assert.equal(f.state.quotes, 1, "same source/input reuses issued work cache");
  const changed = await executeFamilyExactQuote({ ...f.input, amountIn: 1001n });
  assert.equal(changed.status, "resolved");
  assert(changed.status === "resolved"); assert.equal(changed.amountOut, 1000n);
  assert.equal(f.state.quotes, 2, "amount change must physically quote");
  const signed = await executeFamilyExactQuote({ ...f.input, runtimeEvidence: exactInput.runtimeEvidence });
  assert.equal(signed.status, "resolved"); assert.equal(f.state.quotes, 3, "signed mode cannot borrow unsigned bytes");
  const executionInput = { family: f.input.family, actionOwnership: f.catalog, route: f.input.route,
    exact: quote, minAmountOut: 120000n, executor: EXECUTOR, runtimeEvidence: [] };
  const execution = buildFamilyExecutionFragment(executionInput);
  assert.equal(execution.status, "resolved");
  assert(execution.status === "resolved");
  const bytes = angstromV4SwapActionAdapter.encode(execution.fragment.nodes[0], EXECUTOR, new Uint8Array());
  const encoded = ADAPTER_INTERFACE.decodeFunctionData("swap", ethers.hexlify(bytes.slice(24)));
  assert.equal(encoded[4][0].blockNumber, BigInt(SOURCE.number)); assert.equal(encoded[4][0].unlockData, "0x");
  assert.equal(buildFamilyExecutionFragment({ ...executionInput, exact: { ...quote } }).status, "failed", "copied handle is not authority");
  assert.equal(buildFamilyExecutionFragment({ ...executionInput, executor: VALIDATOR }).status, "failed");
  const before = f.state.quotes;
  assert.notEqual((await executeFamilyExactQuote({ ...f.input,
    source: { ...SOURCE, hash: ethers.ZeroHash } })).status, "resolved");
  assert.equal(f.state.quotes, before, "foreign source rejected before work");
  const next = await f.prepare({ ...SOURCE, number: SOURCE.number + 1, generation: SOURCE.generation + 1 });
  assert.equal((await executeFamilyExactQuote(next)).status, "resolved");
  assert.equal(f.state.quotes, before + 1, "B+1 needs its own hook-aware quote");
  assert.notEqual(buildFamilyExecutionFragment({ ...executionInput, route: next.route }).status,
    "resolved", "B quote cannot become authority for a B+1 route handle");
  const old = buildFamilyExecutionFragment(executionInput);
  assert(old.status === "resolved");
  assert.equal(old.fragment.nodes[0].params.sourceBlock, BigInt(SOURCE.number),
    "compiling old evidence still emits B; actual adapter/final-sim lock checks remain mandatory");
  const reorg = await f.prepare({ ...next.source, hash: ethers.ZeroHash, generation: next.generation + 1 });
  assert.equal((await executeFamilyExactQuote(reorg)).status, "resolved");
  assert.equal(f.state.quotes, before + 2, "same-height reorg cannot reuse old hash's quote");
});

test("Angstrom issued work rejects poisoned evidence and controls before I/O, never caches failed hook results", async () => {
  const f = await issuedAngstromFixture();
  for (const poisonedEvidence of [[{ ...runtimeEvidence, evidenceHash: ethers.ZeroHash }],
    [{ ...runtimeEvidence, source: { ...SOURCE, number: SOURCE.number - 1 } }]]) {
    assert.notEqual((await executeFamilyExactQuote({ ...f.input, runtimeEvidence: poisonedEvidence })).status, "resolved");
  }
  const cancelled = new AbortController(); cancelled.abort();
  for (const control of [{ signal: cancelled.signal }, { deadlineAtMs: Date.now() - 1 }]) {
    assert.equal((await executeFamilyExactQuote({ ...f.input, control })).status, "unresolved");
  }
  assert.equal(f.state.quotes, 0);
  f.state.unlocked = false;
  assert.notEqual((await executeFamilyExactQuote(f.input)).status, "resolved");
  assert.notEqual((await executeFamilyExactQuote(f.input)).status, "resolved");
  assert.equal(f.state.quotes, 2); assert.equal(f.cache.snapshot().stores, 0);
  const during = new AbortController(); f.state.unlocked = true;
  f.state.afterQuote = () => during.abort();
  assert.equal((await executeFamilyExactQuote({ ...f.input, control: { signal: during.signal } })).status, "unresolved");
  assert.equal(f.cache.snapshot().stores, 0);
});

test("Angstrom unsigned declaration and execution preserve amount, binding and zero-only boundaries", () => {
  const input = { ...exactInput, runtimeEvidence: [] };
  const method = unsignedMethod(input);
  const quote = method.program.decode({ programInput: input, dependentEvidence: [], initialResults: [success(
    method.program.buildRequests(input)[0].id,
    blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{ success: true, returnData: quoterReturn }]]),
  )] });
  for (const amountIn of [-1n, 1n << 128n]) {
    assert.throws(() => angstromV4StrictFamilyPlugin.exact.methods({ ...input, amountIn }));
    assert.throws(() => method.program.buildRequests({ ...input, amountIn }));
  }
  for (const change of [
    { executor: ethers.ZeroAddress }, { source: { ...SOURCE, number: -1 } },
    { source: { ...SOURCE, number: 1.5 } }, { source: { ...SOURCE, hash: "0x1234" } },
    { route: { ...routes[0], manager: EXECUTOR } },
    { route: { ...routes[0], tokenOut: EXECUTOR } },
  ]) assert.throws(() => angstromV4StrictFamilyPlugin.exact.methods({ ...input, ...change }));
  const execution = { descriptor, route: input.route, amountIn: input.amountIn, quotedAmountOut: quote.amountOut,
    minAmountOut: quote.amountOut, executor: EXECUTOR, runtimeEvidence: [], exactEvidence: quote.evidence };
  assert(quote.evidence.kind === "angstrom-v4-source-unlocked-quoter");
  for (const changed of [
    { ...execution, amountIn: input.amountIn + 1n },
    { ...execution, quotedAmountOut: quote.amountOut + 1n },
    { ...execution, executor: CONTROLLER },
    { ...execution, runtimeEvidence: exactInput.runtimeEvidence },
    { ...execution, descriptor: { ...descriptor, immutableBinding: { ...descriptor.immutableBinding, hookCodeHash: ethers.ZeroHash } } },
    { ...execution, exactEvidence: { ...quote.evidence, kind: "angstrom-v4-unsigned-local-zero" as const } },
  ]) assert.throws(() => angstromV4StrictFamilyPlugin.execution.buildFragment(changed));
});

test("Angstrom a source fence change during issued quote prevents output and cache publication", async () => {
  const f = await issuedAngstromFixture();
  f.state.afterQuote = () => { f.state.source = { ...SOURCE, generation: SOURCE.generation + 1 }; };
  assert.equal((await executeFamilyExactQuote(f.input)).status, "unresolved");
  assert.equal(f.state.quotes, 1);
  assert.equal(f.cache.snapshot().stores, 0);
});

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

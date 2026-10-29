import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { definedFamilyPluginContractSummary } from
  "../../../adapter-family-plugin.js";
import {
  METAFACTORY_DEAD_ADDRESS,
  METAFACTORY_ERC20_INTERFACE,
  METAFACTORY_INTERFACE,
  METAFACTORY_NATIVE_ANCHOR_CODE_HASH,
  METAFACTORY_ROBOT_CODE_HASH,
  METAFACTORY_RUNTIME_CODE_HASH,
  metafactoryRedeemAmount,
  metafactorySelector,
} from "../codec.js";
import { metafactoryDiscovery } from "../discovery.js";
import { metafactoryExact } from "../exact.js";
import { metafactoryExecution } from "../execution.js";
import { metafactoryIdentity } from "../identity.js";
import { metafactoryInstance } from "../instance.js";
import {
  METAFACTORY_ACTION_ID,
  METAFACTORY_FAMILY_ID,
  METAFACTORY_LINEAGE_ID,
  metafactoryFamilyManifest,
} from "../manifest.js";
import { metafactoryPricing } from "../pricing.js";
import { metafactoryRoutes } from "../routes.js";
import { metafactoryFamilyOwnedAction } from "../action.js";
import { assertMetafactoryInvocation } from "../binding.js";
import {
  activation,
  plugin,
} from "../../../production-families/metafactory.production.js";
import type {
  MetafactoryComposterEvidence,
  MetafactoryDescriptor,
  MetafactoryExactEvidence,
  MetafactoryRoute,
} from "../types.js";

// ---- Pinned mainnet sample ------------------------------------------------
// tx 0xbc7223c2…0af7 (N=26244712): the executor composts 2655542356342977559
// ROBOT and the composter pays exactly 1135019301456866 wei of native ETH.
const N = 26244712;
const BLOCK_HASH =
  "0x437e273550182b05f4d656e3afe50b9b665e828984b217838cf1a0d7abbd13a5";
const TARGET = ethers.getAddress("0x585aba689bf7293fe66e9fded9eec9d0e732b180");
const ROBOT = ethers.getAddress("0xfb5453340c03db5ade474b27e68b6a9c6b2823eb");
const WETH = ethers.getAddress(ADDR.WETH);
const EXECUTOR = ethers.getAddress("0xe08d97e151473a848c3d9ca3f323cb720472d015");
const OTHER = ethers.getAddress("0x1000000000000000000000000000000000000002");
const OBSERVED_AMOUNT = 2655542356342977559n;
const OBSERVED_ETH = 1135019301456866n;
const TOTAL_ETH_ALLOCATED = 106485649019911000000n;
const CIRCULATING_SUPPLY = 249138627820764000000000n;
const ONE_ROBOT = 10n ** 18n;
const REDEMPTION_END = 1776734987n;
const REDEEM_TOPIC =
  "0x4cbaede2de574837e61a98a30aa5d7353c76facef958abbb7768c4c46ff612d9";
// Observed call: compostAndRedeem(2655542356342977559, address(0)).
const OBSERVED_CALLDATA =
  "0x94f820c4" +
  "00000000000000000000000000000000000000000000000024da61b413d3b417" +
  "0000000000000000000000000000000000000000000000000000000000000000";
// Observed Redeem log: (tokensComposted, totalComposted, ethRedeemed, passport).
const OBSERVED_REDEEM_DATA =
  "0x" +
  "00000000000000000000000000000000000000000000000024da61b413d3b417" +
  "000000000000000000000000000000000000000000000000602ec813326d074b33" +
  "0000000000000000000000000000000000000000000000000004084b4646cbe2" +
  "000000000000000000000000e08d97e151473a848c3d9ca3f323cb720472d015";

const runtime = JSON.parse(readFileSync(
  new URL("./fixtures/runtime.json", import.meta.url), "utf8")) as {
    blockNumber: number;
    blockHash: string;
    contracts: Record<
      string,
      { address: string; codeHash: string; bytes: number; code: string }
    >;
  };
const source = { number: N, hash: BLOCK_HASH, generation: N };
const candidate = {
  candidateKind: "metafactory-composter" as const,
  target: TARGET,
  observedAmount: OBSERVED_AMOUNT,
};
const response = (
  id: string,
  data: string,
): Extract<AdapterRequestResult, { ok: true }> => ({
  id,
  data,
  source,
  ok: true,
  completion: "returned",
  provenance: {
    kind: "fixture",
    fingerprint: "offline-runtime-fixture-not-chain-evidence",
  },
});

// ---- 1. Manifest, production registration and opt-in activation ----------
assert.equal(runtime.blockNumber, N, "runtime fixture must be pinned at N");
assert.equal(runtime.blockHash, BLOCK_HASH, "runtime fixture block hash");
for (const [name, expected] of [
  ["composter", METAFACTORY_RUNTIME_CODE_HASH],
  ["robot", METAFACTORY_ROBOT_CODE_HASH],
  ["weth", METAFACTORY_NATIVE_ANCHOR_CODE_HASH],
] as const) {
  assert.equal(
    ethers.keccak256(runtime.contracts[name].code),
    expected,
    `${name} pinned runtime code hash`,
  );
}
assert.equal(String(METAFACTORY_FAMILY_ID), "protocol:metafactory");
assert.equal(
  String(METAFACTORY_LINEAGE_ID),
  "metafactory:v1-composter-pro-rata-eth-v1",
);
assert.equal(metafactoryFamilyManifest.domain, "protocol");
assert.deepEqual(
  [...metafactoryFamilyManifest.ownedActionAdapterIds],
  [METAFACTORY_ACTION_ID],
);
assert.deepEqual(
  [...metafactoryFamilyManifest.allowedTaxonomy],
  [{ slotKind: "protocol", protocolAction: "convert" }],
);
assert.equal(metafactoryFamilyManifest.requiresProtocolEdgesFlag, false);
assert.equal(activation.defaultEnabled, false, "family must stay opt-in");
assert.equal(activation.envKey, "SEARCHER_FAMILY_METAFACTORY_ENABLED");
assert.equal(activation.enabled, false, "live default is unchanged");
const summary = definedFamilyPluginContractSummary(plugin);
assert.equal(String(summary.familyId), "protocol:metafactory");
assert.equal(summary.domain, "protocol");
assert.deepEqual(
  [...summary.suppliedActionAdapterIds],
  [METAFACTORY_ACTION_ID],
);
assert.equal(metafactoryFamilyOwnedAction.descriptor.edgeKind, "protocol");
assert.equal(metafactoryFamilyOwnedAction.descriptor.action, "convert");
assert.equal(metafactoryFamilyOwnedAction.descriptor.canSendValue, false);

// ---- 2. Pro-rata math reproduces the observed transaction ratio ----------
assert.equal(
  metafactoryRedeemAmount(
    OBSERVED_AMOUNT, TOTAL_ETH_ALLOCATED, CIRCULATING_SUPPLY),
  OBSERVED_ETH,
  "local pro-rata math must reproduce the observed ethRedeemed",
);
assert.equal(
  metafactoryRedeemAmount(ONE_ROBOT, TOTAL_ETH_ALLOCATED, CIRCULATING_SUPPLY),
  427415250502700n,
  "one ROBOT pricing sample",
);
// uint256 floor division only; the contract never rounds up.
assert.equal(metafactoryRedeemAmount(2n, 3n, 2n), 3n);
assert.equal(metafactoryRedeemAmount(1n, 1n, 2n), 0n);
assert.throws(() => metafactoryRedeemAmount(1n, 1n, 0n), /not redeemable/);
assert.throws(
  () => metafactoryRedeemAmount((1n << 256n) - 1n, 2n, 1n),
  /overflow/,
);

// ---- 3. Identity: pinned runtime + token binding, and rejection ----------
const variant = metafactoryIdentity.variants[0];
const composterRequests = variant.buildRequests({ candidate, step: 0 });
assert.equal(composterRequests.length, 8);
const composterGetters: Record<string, [string, readonly unknown[]]> = {
  "identity-robot": ["robotToken", [ROBOT]],
  "identity-dead": ["DEAD_ADDRESS", [METAFACTORY_DEAD_ADDRESS]],
  "identity-paused": ["paused", [false]],
  "identity-activated": ["redemptionActivated", [true]],
  "identity-total-allocated": ["totalEthAllocated", [TOTAL_ETH_ALLOCATED]],
  "identity-circulating-supply": ["circulatingSupply", [CIRCULATING_SUPPLY]],
  "identity-redemption-end": ["redemptionEndTime", [REDEMPTION_END]],
};
const withComposterResults = (
  override?: (id: string, data: string) => string,
) => composterRequests.map((request) => {
  let data = request.id === "identity-code"
    ? runtime.contracts.composter.code
    : METAFACTORY_INTERFACE.encodeFunctionResult(
      composterGetters[request.id][0],
      [...composterGetters[request.id][1]],
    );
  if (override !== undefined) data = override(request.id, data);
  return response(request.id, data);
});
const composterEvidence = variant.decode({
  step: { candidate, step: 0 },
  results: withComposterResults(),
}) as MetafactoryComposterEvidence;
assert.equal(composterEvidence.phase, "composter");
assert.equal(composterEvidence.valid, true);
assert.equal(composterEvidence.codeHash, METAFACTORY_RUNTIME_CODE_HASH);
assert.equal(composterEvidence.robotToken, ROBOT);
assert.equal(composterEvidence.deadAddress, METAFACTORY_DEAD_ADDRESS);
assert.equal(composterEvidence.circulatingSupply, CIRCULATING_SUPPLY);
assert.equal(
  variant.decide({ candidate, evidence: composterEvidence, step: 1 }).status,
  "continue",
  "structural proof alone must not admit an executable route",
);

// A different runtime is rejected, never silently accepted.
const forged = variant.decode({
  step: { candidate, step: 0 },
  results: withComposterResults((id, data) =>
    id === "identity-code" ? "0x6001600055" : data),
}) as MetafactoryComposterEvidence;
assert.equal(forged.valid, false);
assert.equal(
  variant.decide({ candidate, evidence: forged, step: 1 }).status,
  "chain-proven-rejected",
);
// A mutating protocol state (pause) is retryable, never a terminal verdict.
const paused = variant.decode({
  step: { candidate, step: 0 },
  results: withComposterResults((id, data) => id === "identity-paused"
    ? METAFACTORY_INTERFACE.encodeFunctionResult("paused", [true])
    : data),
}) as MetafactoryComposterEvidence;
assert.equal(paused.valid, true);
assert.equal(
  variant.decide({ candidate, evidence: paused, step: 1 }).status,
  "retryable",
);

const tokenRequests = variant.buildRequests({
  candidate, evidence: composterEvidence, step: 1,
});
assert.equal(tokenRequests.length, 3);
const tokenResults = tokenRequests.map((request) => {
  if (request.id === "identity-robot-code") {
    return response(request.id, runtime.contracts.robot.code);
  }
  if (request.id === "identity-native-anchor-code") {
    return response(request.id, runtime.contracts.weth.code);
  }
  return response(request.id, METAFACTORY_ERC20_INTERFACE
    .encodeFunctionResult("decimals", [18]));
});
const tokenEvidence = variant.decode({
  step: { candidate, evidence: composterEvidence, step: 1 },
  results: tokenResults,
});
assert.equal(tokenEvidence.phase, "tokens");
assert.equal(tokenEvidence.valid, true);
const decision = variant.decide({
  candidate, evidence: tokenEvidence, step: 2,
});
assert.equal(decision.status, "verified");
if (decision.status !== "verified") throw new Error("unreachable");
assert.equal(decision.identity.tokenIn, ROBOT);
assert.equal(decision.identity.nativeAnchor, WETH);
assert.equal(decision.identity.oneToken, ONE_ROBOT);
assert.equal(decision.identity.codeHash, METAFACTORY_RUNTIME_CODE_HASH);
assert.equal(decision.identity.provenance.length, 1);
// Substituting another ERC20 for ROBOT fails the token binding.
const wrongRobot = variant.decode({
  step: { candidate, evidence: composterEvidence, step: 1 },
  results: tokenResults.map((item) => item.id === "identity-robot-code"
    ? response(item.id, runtime.contracts.weth.code)
    : item),
});
assert.equal(wrongRobot.valid, false);
assert.equal(
  variant.decide({ candidate, evidence: wrongRobot, step: 2 }).status,
  "chain-proven-rejected",
);
// Evidence from a foreign block is refused.
assert.throws(() => variant.decode({
  step: { candidate, evidence: composterEvidence, step: 1 },
  results: tokenResults.map((item) => ({
    ...item, source: { ...source, number: N + 1 },
  })),
}), /foreign/);

// ---- 4. Instance and route projection ------------------------------------
const draft = metafactoryInstance.compileDraft(decision.identity);
const descriptor = metafactoryInstance.finalizeDescriptor({
  identity: decision.identity, draft, sharedBindings: [],
}) as MetafactoryDescriptor;
assert.equal(descriptor.instanceKey, draft.instanceKey);
assert.equal(descriptor.oneToken, ONE_ROBOT);
assert.equal(descriptor.nativeAnchor, WETH);

const routes = metafactoryRoutes.project({ descriptor }) as
  readonly MetafactoryRoute[];
assert.equal(routes.length, 1);
const route = routes[0];
assert.equal(route.adapterId, "metafactory-compost-redeem");
assert.equal(route.direction, "compost-redeem");
assert.equal(route.tokenIn, ROBOT);
assert.equal(route.tokenOut, WETH, "graph denomination is the native anchor");
assert.deepEqual(route.executionAssets, { input: "erc20", output: "native" });
assert.equal(route.taxonomy.slotKind, "protocol");
assert.equal(route.taxonomy.protocolAction, "convert");
assert.equal(route.instanceKey, descriptor.instanceKey);
assert.doesNotThrow(() => assertMetafactoryInvocation(descriptor, route));
assert.throws(
  () => assertMetafactoryInvocation(descriptor, { ...route, tokenOut: ROBOT }),
  /not a verified compost redemption/,
);
assert.equal(
  metafactoryRoutes.projectGraph({ descriptor, route }).centralScoreKey,
  route.routeKey,
);

// ---- 5. Pricing reads source state and derives a protocol mid ------------
const pricingDescriptor = metafactoryPricing.compileDraft({
  descriptor, stateKey: descriptor.instanceKey, routes: [route],
});
const pricingRequests = metafactoryPricing.current.buildRequests({
  descriptor: pricingDescriptor, routes: [route], source,
});
assert.deepEqual(pricingRequests.map((request) => request.id), [
  "current-eth-allocated",
  "current-circulating-supply",
  "current-amount-quote",
]);
assert.equal(
  ethers.dataSlice(pricingRequests[2].data, 4),
  ethers.zeroPadValue(ethers.toBeHex(ONE_ROBOT), 32),
  "pricing samples exactly one ROBOT through the composter view",
);
const pricingResults = [
  response("current-eth-allocated", ethers.toBeHex(TOTAL_ETH_ALLOCATED, 32)),
  response("current-circulating-supply", ethers.toBeHex(CIRCULATING_SUPPLY, 32)),
  response("current-amount-quote", ethers.toBeHex(427415250502700n, 32)),
];
const snapshot = metafactoryPricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: pricingResults,
  dependentEvidence: [],
});
assert.equal(snapshot.totalEthAllocated, TOTAL_ETH_ALLOCATED);
assert.equal(snapshot.circulatingSupply, CIRCULATING_SUPPLY);
assert.equal(snapshot.quotes[route.routeKey].amountIn, ONE_ROBOT);
assert.equal(snapshot.quotes[route.routeKey].amountOut, 427415250502700n);
const mids = metafactoryPricing.current.deriveMids({
  descriptor: pricingDescriptor, snapshot, routes: [route],
});
const mid = mids.get(route.routeKey)!;
assert.equal(mid.kind, "protocol");
assert.equal(mid.edges[0].tokenIn, ROBOT);
assert.equal(mid.edges[0].tokenOut, WETH);
assert.equal(mid.edges[0].protocolAction, "convert");
assert.equal(mid.mid, Number(427415250502700n) / Number(ONE_ROBOT));
// A chain quote that contradicts the bound pro-rata rate is refused.
assert.throws(() => metafactoryPricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: [
    pricingResults[0],
    pricingResults[1],
    response("current-amount-quote", ethers.toBeHex(427415250502701n, 32)),
  ],
  dependentEvidence: [],
}), /disagrees/);
// Unset terms publish no mid instead of a fabricated price.
const unsetSnapshot = metafactoryPricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: [
    response("current-eth-allocated", ethers.toBeHex(0n, 32)),
    response("current-circulating-supply", ethers.toBeHex(0n, 32)),
    response("current-amount-quote", "0x"),
  ],
  dependentEvidence: [],
});
assert.deepEqual(unsetSnapshot.quotes, {});
assert.equal(
  metafactoryPricing.current.classifyUnavailable({
    snapshot: unsetSnapshot, routes: [route],
  }).get(route.routeKey),
  "metafactory_redemption_terms_unset",
);

// ---- 6. Exact quote: same math, requested amount, chain cross-check ------
const exactInput = {
  descriptor,
  route,
  amountIn: OBSERVED_AMOUNT,
  source,
  executor: EXECUTOR,
  runtimeEvidence: [],
};
const method = metafactoryExact.methods(exactInput)[0];
assert.equal(method.kind, "request-program");
if (method.kind !== "request-program") throw new Error("unreachable");
assert.equal(method.chainAmountQuote, true);
assert.deepEqual(method.program.buildRequests(exactInput).map((r) => r.id), [
  "exact-eth-allocated",
  "exact-circulating-supply",
  "exact-amount-quote",
]);
const exactResults = [
  response("exact-eth-allocated", ethers.toBeHex(TOTAL_ETH_ALLOCATED, 32)),
  response("exact-circulating-supply", ethers.toBeHex(CIRCULATING_SUPPLY, 32)),
  response("exact-amount-quote", ethers.toBeHex(OBSERVED_ETH, 32)),
];
const quoted = method.program.decode({
  programInput: exactInput, initialResults: exactResults, dependentEvidence: [],
});
assert.equal(quoted.amountOut, OBSERVED_ETH, "observed ROBOT -> ETH ratio");
const exactEvidence = quoted.evidence as MetafactoryExactEvidence;
assert.equal(exactEvidence.kind, "metafactory-pro-rata-eth-quote");
assert.equal(exactEvidence.totalEthAllocated, TOTAL_ETH_ALLOCATED);
assert.equal(exactEvidence.circulatingSupply, CIRCULATING_SUPPLY);
assert.throws(() => method.program.decode({
  programInput: exactInput,
  initialResults: [
    exactResults[0],
    exactResults[1],
    response("exact-amount-quote", ethers.toBeHex(OBSERVED_ETH + 1n, 32)),
  ],
  dependentEvidence: [],
}), /disagrees/);
assert.throws(() => method.program.decode({
  programInput: exactInput,
  initialResults: exactResults.map((item) => ({
    ...item, source: { ...source, hash: ethers.id("other-block") },
  })),
  dependentEvidence: [],
}), /foreign/);

// ---- 7. Runtime leg: raw ERC20 -> native operation, settlement bounds ----
const leg = metafactoryExecution.buildRuntimeLeg({
  descriptor, route, executor: EXECUTOR, runtimeEvidence: [],
});
assert(leg, "runtime leg must construct");
assert.equal(leg.actionAdapterId, "metafactory-compost-redeem");
assert.match(leg.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
const programHex = leg.program.toLowerCase();
assert(
  programHex.includes(metafactorySelector("compostAndRedeem").slice(2)),
  "runtime leg calls compostAndRedeem",
);
assert(
  programHex.includes(METAFACTORY_ERC20_INTERFACE
    .getFunction("approve")!.selector.slice(2)),
  "runtime leg approves ROBOT",
);
assert(
  programHex.includes(ROBOT.slice(2).toLowerCase()),
  "approval targets the ROBOT token",
);
// The composter pays msg.sender only: an executor direct-output is supported,
// any third-party recipient stays on the quoted path.
const executorSettlement = metafactoryExecution.buildRuntimeLeg({
  descriptor,
  route,
  executor: EXECUTOR,
  settlement: { kind: "direct-output", recipient: EXECUTOR },
  runtimeEvidence: [],
});
assert.equal(executorSettlement?.settlement?.directOutput, true);
assert.equal(metafactoryExecution.buildRuntimeLeg({
  descriptor,
  route,
  executor: EXECUTOR,
  settlement: { kind: "direct-output", recipient: OTHER },
  runtimeEvidence: [],
}), null);
assert.equal(metafactoryExecution.buildRuntimeLeg({
  descriptor,
  route,
  executor: EXECUTOR,
  settlement: { kind: "deferred-input", paymentProgram: "0x01", paymentAmount: 1n },
  runtimeEvidence: [],
}), null);

const fragment = metafactoryExecution.buildFragment({
  descriptor,
  route,
  amountIn: OBSERVED_AMOUNT,
  quotedAmountOut: OBSERVED_ETH,
  minAmountOut: 0n,
  exactEvidence,
  executor: EXECUTOR,
  runtimeEvidence: [],
});
assert.equal(fragment.nodes.length, 1);
assert.equal(fragment.nodes[0].adapterId, "metafactory-compost-redeem");
assert.equal(fragment.nodes[0].target, TARGET);
assert.equal(fragment.nodes[0].tokenIn, ROBOT);
assert.equal(fragment.nodes[0].tokenOut, WETH);
assert.equal(fragment.nodes[0].amount, OBSERVED_AMOUNT);
assert.deepEqual(fragment.nodes[0].children, []);
assert.throws(() => metafactoryExecution.buildFragment({
  descriptor,
  route,
  amountIn: OBSERVED_AMOUNT,
  quotedAmountOut: OBSERVED_ETH + 1n,
  minAmountOut: 0n,
  exactEvidence,
  executor: EXECUTOR,
  runtimeEvidence: [],
}), /incompatible exact evidence/);

// ---- 8. Action encoding ---------------------------------------------------
const node = {
  adapterId: METAFACTORY_ACTION_ID,
  target: TARGET,
  tokenIn: ROBOT,
  tokenOut: WETH,
  amount: OBSERVED_AMOUNT,
  params: {},
  children: [],
};
const encoded = ethers.hexlify(
  metafactoryFamilyOwnedAction.encode(node, EXECUTOR, new Uint8Array()));
const APPROVE = METAFACTORY_ERC20_INTERFACE.getFunction("approve")!.selector;
const REDEEM = metafactorySelector("compostAndRedeem");
// Walk the BotVM CALL opcodes: [0x00][target:20][payload_len:3][payload:N].
const script = ethers.getBytes(encoded);
const calls: { target: string; data: string }[] = [];
for (let offset = 0; offset < script.length;) {
  assert.equal(script[offset], 0x00, "action encodes plain CALL opcodes");
  const target = ethers.getAddress(
    ethers.hexlify(script.slice(offset + 1, offset + 21)));
  const length =
    (script[offset + 21] << 16) | (script[offset + 22] << 8) | script[offset + 23];
  const data = ethers.hexlify(
    script.slice(offset + 24, offset + 24 + length));
  calls.push({ target, data });
  offset += 24 + length;
}
assert.equal(calls.length, 4, "approve, approve, redeem, approve");
assert.deepEqual(
  calls.map((call) => call.data.slice(0, 10)),
  [APPROVE, APPROVE, REDEEM, APPROVE],
);
assert.deepEqual(calls.map((call) => call.target), [ROBOT, ROBOT, TARGET, ROBOT]);
const firstApproval = METAFACTORY_ERC20_INTERFACE.decodeFunctionData(
  "approve", calls[0].data);
assert.equal(firstApproval[0], TARGET);
assert.equal(BigInt(firstApproval[1]), 0n);
const secondApproval = METAFACTORY_ERC20_INTERFACE.decodeFunctionData(
  "approve", calls[1].data);
assert.equal(secondApproval[0], TARGET);
assert.equal(BigInt(secondApproval[1]), OBSERVED_AMOUNT);
const redeem = METAFACTORY_INTERFACE.decodeFunctionData(
  "compostAndRedeem", calls[2].data);
assert.equal(BigInt(redeem[0]), OBSERVED_AMOUNT);
assert.equal(redeem[1], ethers.ZeroAddress,
  "passportRecipient is the observed zero address; ETH goes to msg.sender");
const cleared = METAFACTORY_ERC20_INTERFACE.decodeFunctionData(
  "approve", calls[3].data);
assert.equal(BigInt(cleared[1]), 0n);
assert.throws(
  () => metafactoryFamilyOwnedAction.encode(
    { ...node, amount: 0n }, EXECUTOR, new Uint8Array()),
  /invalid compost redemption action/,
);
assert.equal(metafactoryFamilyOwnedAction.matchTrace(TARGET, REDEEM), true);
assert.equal(metafactoryFamilyOwnedAction.matchTrace(TARGET, APPROVE), false);

// ---- 9. Discovery from the real call and the real Redeem log -------------
const callCandidate = metafactoryDiscovery.decodeCandidate({
  observation: {
    kind: "call",
    source,
    target: TARGET,
    data: OBSERVED_CALLDATA,
    sender: EXECUTOR,
    transactionHash:
      "0xbc7223c28f592b70fd17b8ff9522efc244a1cffb2c73aec9a0dd4c1b820a0af7",
  },
  matchedPatternId: "metafactory-compost-redeem-call",
});
assert.equal(callCandidate?.target, TARGET);
assert.equal(callCandidate?.observedAmount, OBSERVED_AMOUNT);
assert.equal(metafactoryDiscovery.decodeCandidate({
  observation: {
    kind: "call", source, target: TARGET, data: "0xdeadbeef", sender: EXECUTOR,
  },
  matchedPatternId: "metafactory-compost-redeem-call",
}), null);
const logCandidate = metafactoryDiscovery.decodeCandidate({
  observation: {
    kind: "log",
    source,
    address: TARGET,
    topics: [REDEEM_TOPIC, ethers.zeroPadValue(EXECUTOR, 32).toLowerCase()],
    data: OBSERVED_REDEEM_DATA,
  },
  matchedPatternId: "metafactory-redeem-log",
});
assert.equal(logCandidate?.target, TARGET);
assert.equal(logCandidate?.observedAmount, OBSERVED_AMOUNT);
assert.equal(logCandidate?.observedAmount, callCandidate?.observedAmount);
assert.equal(
  metafactoryDiscovery.candidateKey(callCandidate!),
  TARGET.toLowerCase(),
);
assert.deepEqual(
  [...metafactoryDiscovery.callPatterns!].map((pattern) => pattern.selector),
  [REDEEM.slice(0, 10)],
);
assert.deepEqual(
  [...metafactoryDiscovery.logPatterns!].map((pattern) => pattern.topic),
  [REDEEM_TOPIC],
);

console.log(
  "metafactory family contract PASS: manifest+registration (opt-in), observed " +
  `${OBSERVED_AMOUNT} ROBOT -> ${OBSERVED_ETH} wei ETH pro-rata at N=${N}, ` +
  "identity runtime/token binding and rejection, ROBOT->WETH native route, " +
  "source pricing mid, exact chain cross-check, runtime leg with temporary " +
  "approval and settlement bounds, action encoding, discovery from the real " +
  "call and Redeem log",
);

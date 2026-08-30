import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { decodePackedCallProgram, encodePackedCallProgram } from "../../../packages/execution-program/src/index.ts";
import {
  encodeFluidDexApproveCall,
  encodeSwapInCall,
  FLUID_DEX_MAX_UINT256,
} from "../src/abi.ts";
import {
  FLUID_DEX_ACTION_MUTATION_CORPUS_ROOT,
  FLUID_DEX_ACTION_MUTATION_EXECUTION_IDS,
  FLUID_DEX_ACTION_PORT,
  buildFluidDexSearchAction,
} from "../src/action.ts";

const h = (value: string): Hash => hashDomain("aloha/fluid-dex/action-contract-test/v1", value);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const routeBody = { instanceKey: "0x5555555555555555555555555555555555555555", inputAsset: "0x1111111111111111111111111111111111111111", outputAsset: "0x2222222222222222222222222222222222222222" };
const route = Object.freeze({ ...routeBody, routeBindingHash: hashDomain("aloha/fluid-dex/route-binding/v1", routeBody) });
const quoteBody = { cutoff, routeBindingHash: route.routeBindingHash, amountIn: "100", observedAmountOut: "97" };
const quote = Object.freeze({ ...quoteBody, quoteHash: hashDomain("aloha/fluid-dex/quote/v1", quoteBody) });
const recipient = "0x8888888888888888888888888888888888888888";
const rawBody = { cutoff, target: route.instanceKey, calldata: encodeSwapInCall(true, quote.amountIn, quote.observedAmountOut, recipient), exactQuoteHash: quote.quoteHash };
const rawAction = Object.freeze({ ...rawBody, actionHash: hashDomain("aloha/fluid-dex/action/v1", rawBody) });
const stateFactsRoot = h("facts");
const exactEvaluationHash = hashDomain("aloha/fluid-dex/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateFactsRoot, actionHash: rawAction.actionHash });
const obligationRoot = hashDomain("aloha/fluid-dex/search-obligation/v1", { evaluationHash: exactEvaluationHash, quoteHash: quote.quoteHash });
const input = Object.freeze({ rawAction, quote, route, token0: route.inputAsset, token1: route.outputAsset, swap0to1: true, recipient, stateFactsRoot, inputs: [{ assetRef: erc20AssetRefV1("1", route.inputAsset), amount: "100" }], outputs: [{ assetRef: erc20AssetRefV1("1", route.outputAsset), amount: "97" }], exactEvaluationHash, obligationRoot });
const action = buildFluidDexSearchAction(input);

function proofRoot(value: typeof action): Hash {
  return hashDomain("aloha/fluid-dex/action-obligation-postcondition/v2", {
    rawActionHash: value.rawAction.actionHash,
    routeBindingHash: value.route.routeBindingHash,
    token0: value.token0,
    token1: value.token1,
    exactEvaluationHash: value.exactEvaluationHash,
    obligationRoot: value.obligationRoot,
    inputs: value.inputs,
    outputs: value.outputs,
    stateFactsRoot: value.stateFactsRoot,
    swap0to1: value.swap0to1,
    recipient: value.recipient,
    opaqueBytes: value.opaqueBytes,
    effectTransport: value.effectTransport,
  });
}

function reRoot(changes: Record<string, unknown>): unknown {
  const candidate = { ...action, ...changes } as typeof action;
  const obligationProofRoot = proofRoot(candidate);
  const { actionHash: ignored, ...withoutHash } = { ...candidate, obligationProofRoot };
  void ignored;
  return { ...withoutHash, actionHash: hashDomain("aloha/fluid-dex/search-action/v2", withoutHash) };
}

function mutateCall(index: number, changes: Record<string, unknown>): string {
  const calls = decodePackedCallProgram(action.opaqueBytes).map(call => ({ ...call }));
  calls[index] = { ...calls[index]!, ...changes } as typeof calls[number];
  return encodePackedCallProgram(calls);
}

test("Fluid action owner emits and exactly verifies force-approve then swap with effect scope", () => {
  const decoded = FLUID_DEX_ACTION_PORT.decode(action);
  assert.equal(decoded.actionHash, action.actionHash);
  assert.equal(FLUID_DEX_ACTION_PORT.build(input).actionHash, action.actionHash);
  assert.equal(FLUID_DEX_ACTION_PORT.verifyObligations(action).subjectRoot, obligationRoot);
  const calls = decodePackedCallProgram(action.opaqueBytes);
  assert.deepEqual(calls, [
    { target: route.inputAsset, value: "0", calldata: encodeFluidDexApproveCall(route.instanceKey, 0n) },
    { target: route.inputAsset, value: "0", calldata: encodeFluidDexApproveCall(route.instanceKey, FLUID_DEX_MAX_UINT256) },
    { target: route.instanceKey, value: "0", calldata: rawAction.calldata },
  ]);
  assert.deepEqual(action.effectTransport, {
    caller: { ref: { kind: "observed-sender" }, executionMode: "top-level" },
    preCalls: [],
    observeTokenBalances: [
      { token: route.inputAsset, account: { kind: "observed-sender" } },
      { token: route.inputAsset, account: recipient },
      { token: route.inputAsset, account: route.instanceKey },
      { token: route.outputAsset, account: route.instanceKey },
      { token: route.outputAsset, account: recipient },
      { token: route.outputAsset, account: { kind: "observed-sender" } },
    ],
    observeLogs: true,
  });
});

test("Fluid action qualification mutations reject program, transport, lineage, and injected fields", () => {
  const reject = (value: unknown) => assert.throws(() => FLUID_DEX_ACTION_PORT.decode(value));
  const flippedRawBody = { ...rawBody, calldata: encodeSwapInCall(false, quote.amountIn, quote.observedAmountOut, recipient) };
  const flippedRawAction = { ...flippedRawBody, actionHash: hashDomain("aloha/fluid-dex/action/v1", flippedRawBody) };
  const flippedEvaluationHash = hashDomain("aloha/fluid-dex/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateFactsRoot, actionHash: flippedRawAction.actionHash });
  const flippedObligationRoot = hashDomain("aloha/fluid-dex/search-obligation/v1", { evaluationHash: flippedEvaluationHash, quoteHash: quote.quoteHash });
  const flippedProgram = encodePackedCallProgram([
    { target: route.inputAsset as `0x${string}`, value: "0", calldata: encodeFluidDexApproveCall(route.instanceKey, 0n) as `0x${string}` },
    { target: route.inputAsset as `0x${string}`, value: "0", calldata: encodeFluidDexApproveCall(route.instanceKey, FLUID_DEX_MAX_UINT256) as `0x${string}` },
    { target: route.instanceKey as `0x${string}`, value: "0", calldata: flippedRawAction.calldata as `0x${string}` },
  ]);
  const mutations = [
    { id: "metadata-splice", value: { ...action, actionImplementationHash: h("implementation-splice") } },
    { id: "state-facts-root-splice", value: { ...action, stateFactsRoot: h("facts-splice") } },
    { id: "input-amount-splice", value: { ...action, inputs: [{ ...action.inputs[0]!, amount: "101" }] } },
    { id: "input-asset-splice", value: { ...action, inputs: [{ ...action.inputs[0]!, assetRef: h("foreign-input-asset") }] } },
    { id: "output-amount-splice", value: { ...action, outputs: [{ ...action.outputs[0]!, amount: "98" }] } },
    { id: "output-asset-splice", value: { ...action, outputs: [{ ...action.outputs[0]!, assetRef: h("foreign-output-asset") }] } },
    { id: "quote-splice", value: { ...action, quote: { ...action.quote, amountIn: "101" } } },
    { id: "raw-action-splice", value: { ...action, rawAction: { ...action.rawAction, actionHash: h("raw-splice") } } },
    { id: "evaluation-splice", value: { ...action, exactEvaluationHash: h("evaluation-splice") } },
    { id: "obligation-root-splice", value: { ...action, obligationRoot: h("obligation-splice") } },
    { id: "obligation-proof-splice", value: { ...action, obligationProofRoot: h("proof-splice") } },
    { id: "packed-program-splice", value: reRoot({ opaqueBytes: `${action.opaqueBytes}00` }) },
    { id: "approval-token-splice", value: reRoot({ opaqueBytes: mutateCall(0, { target: route.outputAsset }) }) },
    { id: "approval-spender-splice", value: reRoot({ opaqueBytes: mutateCall(0, { calldata: encodeFluidDexApproveCall(recipient, 0n) }) }) },
    { id: "approval-zero-splice", value: reRoot({ opaqueBytes: mutateCall(0, { calldata: encodeFluidDexApproveCall(route.instanceKey, 1n) }) }) },
    { id: "approval-max-splice", value: reRoot({ opaqueBytes: mutateCall(1, { calldata: encodeFluidDexApproveCall(route.instanceKey, FLUID_DEX_MAX_UINT256 - 1n) }) }) },
    { id: "swap-call-splice", value: reRoot({ opaqueBytes: mutateCall(2, { target: recipient }) }) },
    { id: "effect-caller-splice", value: reRoot({ effectTransport: { ...action.effectTransport, caller: { ...action.effectTransport.caller, executionMode: "impersonated-call-frame" } } }) },
    { id: "effect-observation-splice", value: reRoot({ effectTransport: { ...action.effectTransport, observeTokenBalances: action.effectTransport.observeTokenBalances.slice(0, -1) } }) },
    { id: "effect-log-splice", value: reRoot({ effectTransport: { ...action.effectTransport, observeLogs: false } }) },
    { id: "final-action-splice", value: { ...action, actionHash: h("action-splice") } },
    { id: "top-level-field-injection", value: { ...action, unexpected: true } },
    { id: "quote-field-injection", value: { ...action, quote: { ...action.quote, unexpected: true } } },
    { id: "route-field-injection", value: { ...action, route: { ...action.route, unexpected: true } } },
    { id: "raw-action-field-injection", value: { ...action, rawAction: { ...action.rawAction, unexpected: true } } },
    { id: "quote-cutoff-field-injection", value: { ...action, quote: { ...action.quote, cutoff: { ...action.quote.cutoff, unexpected: true } } } },
    { id: "raw-cutoff-field-injection", value: { ...action, rawAction: { ...action.rawAction, cutoff: { ...action.rawAction.cutoff, unexpected: true } } } },
    { id: "token-order-splice", value: { ...action, token0: action.token1 } },
    { id: "direction-reroot", value: reRoot({ rawAction: flippedRawAction, swap0to1: false, exactEvaluationHash: flippedEvaluationHash, obligationRoot: flippedObligationRoot, opaqueBytes: flippedProgram }) },
  ] as const;
  assert.deepEqual(mutations.map(mutation => mutation.id), FLUID_DEX_ACTION_MUTATION_EXECUTION_IDS);
  assert.equal(FLUID_DEX_ACTION_MUTATION_CORPUS_ROOT, hashDomain("aloha/fluid-dex/action-verifier-mutations/v2", { executionIds: FLUID_DEX_ACTION_MUTATION_EXECUTION_IDS }));
  for (const mutation of mutations) reject(mutation.value);

  const cutoffRawBody = { ...rawBody, cutoff: { ...cutoff, number: "101" } };
  const cutoffRaw = { ...cutoffRawBody, actionHash: hashDomain("aloha/fluid-dex/action/v1", cutoffRawBody) };
  reject(reRoot({ rawAction: cutoffRaw }));
  const poolRecipientRawBody = { ...rawBody, calldata: encodeSwapInCall(true, quote.amountIn, quote.observedAmountOut, route.instanceKey) };
  const poolRecipientRaw = { ...poolRecipientRawBody, actionHash: hashDomain("aloha/fluid-dex/action/v1", poolRecipientRawBody) };
  assert.throws(() => buildFluidDexSearchAction({ ...input, recipient: route.instanceKey, rawAction: poolRecipientRaw }), /recipient must not be the pool/);
});

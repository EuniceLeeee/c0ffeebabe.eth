import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { UNIV4_POOL_MANAGER, encodeSwapCall, poolIdForKey } from "../src/abi.ts";
import { UNIV4_ACTION_MUTATION_CORPUS_ROOT, UNIV4_ACTION_MUTATION_EXECUTION_IDS, UNIV4_ACTION_PORT, buildUniv4SearchAction } from "../src/action.ts";

const h = (value: string): Hash => hashDomain("aloha/univ4/action-contract-test/v1", value);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const poolKey = Object.freeze({ currency0: "0x1111111111111111111111111111111111111111", currency1: "0x2222222222222222222222222222222222222222", fee: "3000", tickSpacing: "60", hooks: "0x3333333333333333333333333333333333333333" });
const routeBody = { instanceKey: poolIdForKey(poolKey), inputAsset: poolKey.currency0, outputAsset: poolKey.currency1 };
const route = Object.freeze({ ...routeBody, routeBindingHash: hashDomain("aloha/univ4/route-binding/v1", routeBody) });
const quoteBody = { cutoff, routeBindingHash: route.routeBindingHash, amountIn: "100", observedAmountOut: "97" };
const quote = Object.freeze({ ...quoteBody, quoteHash: hashDomain("aloha/univ4/quote/v1", quoteBody) });
const rawBody = { cutoff, target: UNIV4_POOL_MANAGER.toLowerCase(), calldata: encodeSwapCall(poolKey, true, quote.amountIn), exactQuoteHash: quote.quoteHash };
const rawAction = Object.freeze({ ...rawBody, actionHash: hashDomain("aloha/univ4/action/v1", rawBody) });
const stateFactsRoot = h("facts");
const exactEvaluationHash = hashDomain("aloha/univ4/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateFactsRoot });
const obligationRoot = hashDomain("aloha/univ4/search-obligation/v1", { evaluationHash: exactEvaluationHash, quoteHash: quote.quoteHash });
const action = buildUniv4SearchAction({ rawAction, quote, route, poolKey, zeroForOne: true, stateFactsRoot, inputs: [{ assetRef: erc20AssetRefV1("1", poolKey.currency0), amount: "100" }], outputs: [{ assetRef: erc20AssetRefV1("1", poolKey.currency1), amount: "97" }], exactEvaluationHash, obligationRoot });

test("UniV4 action owner exactly verifies its semantic payload and obligation proof", () => {
  assert.equal(UNIV4_ACTION_PORT.decode(action).actionHash, action.actionHash);
  assert.equal(UNIV4_ACTION_PORT.verifyObligations(action).subjectRoot, obligationRoot);
  const reject = (value: unknown) => assert.throws(() => UNIV4_ACTION_PORT.decode(value));
  const mutationCorpus = [
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
    { id: "final-action-splice", value: { ...action, actionHash: h("action-splice") } },
    { id: "top-level-field-injection", value: { ...action, unexpected: true } },
    { id: "quote-field-injection", value: { ...action, quote: { ...action.quote, unexpected: true } } },
    { id: "route-field-injection", value: { ...action, route: { ...action.route, unexpected: true } } },
    { id: "raw-action-field-injection", value: { ...action, rawAction: { ...action.rawAction, unexpected: true } } },
    { id: "quote-cutoff-field-injection", value: { ...action, quote: { ...action.quote, cutoff: { ...action.quote.cutoff, unexpected: true } } } },
    { id: "raw-cutoff-field-injection", value: { ...action, rawAction: { ...action.rawAction, cutoff: { ...action.rawAction.cutoff, unexpected: true } } } },
  ] as const;
  assert.deepEqual(mutationCorpus.map(mutation => mutation.id), UNIV4_ACTION_MUTATION_EXECUTION_IDS);
  assert.equal(UNIV4_ACTION_MUTATION_CORPUS_ROOT, hashDomain("aloha/univ4/action-verifier-mutations/v1", { executionIds: UNIV4_ACTION_MUTATION_EXECUTION_IDS }));
  for (const mutation of mutationCorpus) reject(mutation.value);
  reject({ ...action, route: { ...action.route, inputAsset: poolKey.currency1 } });
  reject({ ...action, zeroForOne: false });
  const foreignRouteBody = { ...routeBody, instanceKey: h("foreign-pool") };
  const foreignRoute = { ...foreignRouteBody, routeBindingHash: hashDomain("aloha/univ4/route-binding/v1", foreignRouteBody) };
  const foreignQuoteBody = { ...quoteBody, routeBindingHash: foreignRoute.routeBindingHash };
  const foreignQuote = { ...foreignQuoteBody, quoteHash: hashDomain("aloha/univ4/quote/v1", foreignQuoteBody) };
  const foreignRawBody = { ...rawBody, exactQuoteHash: foreignQuote.quoteHash };
  const foreignRaw = { ...foreignRawBody, actionHash: hashDomain("aloha/univ4/action/v1", foreignRawBody) };
  const foreignEvaluation = hashDomain("aloha/univ4/search-exact-evaluation/v1", { quoteHash: foreignQuote.quoteHash, stateFactsRoot });
  const foreignObligation = hashDomain("aloha/univ4/search-obligation/v1", { evaluationHash: foreignEvaluation, quoteHash: foreignQuote.quoteHash });
  const foreignProof = hashDomain("aloha/univ4/action-obligation-postcondition/v1", { rawActionHash: foreignRaw.actionHash, routeBindingHash: foreignRoute.routeBindingHash, exactEvaluationHash: foreignEvaluation, obligationRoot: foreignObligation, inputs: action.inputs, outputs: action.outputs, stateFactsRoot, poolKey, zeroForOne: true });
  const foreignPayload = { ...action, route: foreignRoute, quote: foreignQuote, rawAction: foreignRaw, exactEvaluationHash: foreignEvaluation, obligationRoot: foreignObligation, obligationProofRoot: foreignProof };
  const { actionHash: ignoredForeign, ...foreignBody } = foreignPayload;
  void ignoredForeign;
  reject({ ...foreignBody, actionHash: hashDomain("aloha/univ4/search-action/v1", foreignBody) });
  const cutoffRawBody = { ...rawBody, cutoff: { ...cutoff, number: "101" } };
  const cutoffRaw = { ...cutoffRawBody, actionHash: hashDomain("aloha/univ4/action/v1", cutoffRawBody) };
  const cutoffProof = hashDomain("aloha/univ4/action-obligation-postcondition/v1", { rawActionHash: cutoffRaw.actionHash, routeBindingHash: route.routeBindingHash, exactEvaluationHash, obligationRoot, inputs: action.inputs, outputs: action.outputs, stateFactsRoot, poolKey, zeroForOne: true });
  const cutoffPayload = { ...action, rawAction: cutoffRaw, obligationProofRoot: cutoffProof };
  const { actionHash: ignoredCutoff, ...cutoffBody } = cutoffPayload;
  void ignoredCutoff;
  reject({ ...cutoffBody, actionHash: hashDomain("aloha/univ4/search-action/v1", cutoffBody) });
});

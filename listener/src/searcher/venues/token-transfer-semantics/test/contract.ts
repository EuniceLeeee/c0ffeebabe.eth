import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { getAddress, keccak256, TypedDataEncoder, zeroPadValue } from "ethers";
import { identifyTokenTransferModel, tokenTransferReceived } from "../index.js";
import { univ2StrictFamilyPlugin as family } from "../../swaps/univ2-family-plugin.js";
import { UNIV2_FACTORY_INTERFACE as factoryAbi, UNIV2_PAIR_INTERFACE as pairAbi,
  UNIV2_TOKEN_INTERFACE as tokenAbi } from "../../swaps/univ2-family/codec.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import type { UniV2Candidate } from "../../swaps/univ2-family/types.js";
import { quoteV2ExactInput } from "../../../solver/v2-constant-product-math.js";

const fixture = JSON.parse(readFileSync(new URL("./bear-runtime.json", import.meta.url), "utf8"));
const runtime = "0x" + gunzipSync(Buffer.from(fixture.runtimeGzipBase64, "base64")).toString("hex");
const BEAR = getAddress(fixture.token);
const TON = getAddress("0x582d872a1b094fc48f5de31d3b73f2d9be47def1");
const POOL = getAddress("0xdcb004ed28d585d23d63f965e203d16a822eda33");
const FACTORY = getAddress("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f");
const EXECUTOR = getAddress("0x6666666666666666666666666666666666666666");
const source: CanonicalSource = { number: 26029368,
  hash: "0x9e1bb0fa8981ff45975e804044a1aea9334e683b5fa9d8e1a225b22234ef8923", generation: 1 };
const ok = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({ id, data, ok: true, source,
  completion: "returned", provenance: { kind: "fixture", fingerprint: "btbb-parent-trace-v1" } });
const reverted = (id: string): AdapterRequestResult => ({ ...ok(id, "0x"), completion: "reverted-as-declared" });

function admitted() {
  const variant = family.identity.variants[0];
  const candidate: UniV2Candidate = { candidateKind: "univ2-pair", pool: POOL,
    sourceKind: "pair-call", hintedFactory: null, hintedToken0: null, hintedToken1: null };
  const first = variant.decode({ step: { candidate, step: 0 }, results: [
    ok("pair-factory", pairAbi.encodeFunctionResult("factory", [FACTORY])),
    ok("pair-token0", pairAbi.encodeFunctionResult("token0", [BEAR])),
    ok("pair-token1", pairAbi.encodeFunctionResult("token1", [TON])),
  ] });
  const evidence = variant.decode({ step: { candidate, step: 1, evidence: first }, results: [
    ok("factory-get-pair", factoryAbi.encodeFunctionResult("getPair", [POOL])),
    ...["model-surface-0", "model-surface-1", "model-amplification", "model-decimals-0", "model-decimals-1"].map(reverted),
    ok("transfer-code-0", runtime), ok("transfer-code-1", "0x6000"),
  ] });
  const decision = variant.decide({ candidate, step: 2, evidence });
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw Error("identity not verified");
  const descriptor = family.instance.finalizeDescriptor({ identity: decision.identity,
    draft: family.instance.compileDraft(decision.identity), sharedBindings: [] });
  return { descriptor, routes: family.routes.project({ descriptor }) };
}
const { descriptor, routes } = admitted();
function quote(amountIn: bigint, reverse = false, reserve0 = 2432273785195304663393969n, reserve1 = 57123817443n) {
  const input = { descriptor, route: routes[reverse ? 1 : 0], amountIn, source,
    executor: EXECUTOR, runtimeEvidence: [] };
  const method = family.exact.methods(input)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw Error("missing production Exact");
  assert.equal(method.stateOnlyReads, true);
  assert.equal(method.program.buildRequests(input).length, 2, "no per-amount tax simulation/balance reads added");
  const result = method.program.decode({ programInput: input, dependentEvidence: [], initialResults: [
    ok("exact-reserves", pairAbi.encodeFunctionResult("getReserves", [reserve0, reserve1, 0])),
    ok("exact-input-balance", tokenAbi.encodeFunctionResult("balanceOf", [reverse ? reserve1 : reserve0])),
  ] });
  return { input, result };
}

test("complete verified runtime identifies transfer semantics, not token address", () => {
  assert.equal(keccak256(runtime), fixture.codeHash);
  const model = identifyTokenTransferModel(BEAR, runtime);
  assert.equal(model.kind, "verified-transfer-tax");
  assert.equal(identifyTokenTransferModel(BEAR, "0x6000").kind, "nominal-unverified");
  assert.equal(identifyTokenTransferModel(BEAR, runtime.slice(0, -2) + "00").kind, "nominal-unverified");
  let relocated = runtime;
  for (const [offset, word] of [[4694, zeroPadValue(EXECUTOR, 32)], [4778,
    TypedDataEncoder.hashDomain({ name: "BTB Bear", version: "1", chainId: 1, verifyingContract: EXECUTOR })]] as const) {
    const start = 2 + offset * 2;
    relocated = relocated.slice(0, start) + word.slice(2) + relocated.slice(start + 64);
  }
  assert.equal(identifyTokenTransferModel(EXECUTOR, relocated).kind, "verified-transfer-tax");
  assert.equal(identifyTokenTransferModel(BEAR, relocated).kind, "nominal-unverified");
  for (const n of [0n, 1n, 99n, 100n, 101n, 163328322790475095979823n]) {
    assert.equal(tokenTransferReceived(model, n, POOL), n - n / 100n);
    assert.equal(tokenTransferReceived(model, n, BEAR), n);
  }
  assert.throws(() => tokenTransferReceived(model, 1n << 255n), /overflow/);
});

test("historical failed amount uses observed pool credit; original amount matches original trace output", () => {
  const { input, result } = quote(163328322790475095979823n);
  assert.equal(result.evidence.receivedAmountIn, 161695039562570345020025n);
  assert.equal(result.amountOut, 3550794580n);
  assert.equal(quoteV2ExactInput(result.evidence.reserveIn, result.evidence.reserveOut, input.amountIn, 30n), 3584410631n);
  assert.equal(quote(134844496078197091206672n).result.amountOut, 2963677197n);
  const fragment = family.execution.buildFragment({ ...input, exactEvidence: result.evidence,
    quotedAmountOut: result.amountOut, minAmountOut: result.amountOut });
  assert.equal(fragment.requirements[0].kind, "transfer-to-pool");
  assert.deepEqual(fragment.requirements[0], { kind: "transfer-to-pool", token: BEAR, pool: POOL, amount: input.amountIn });
  assert.equal(fragment.nodes[0].params.amount1Out, result.amountOut);
  assert.throws(() => family.execution.buildFragment({ ...input, exactEvidence: {
    ...result.evidence, receivedAmountIn: input.amountIn }, quotedAmountOut: result.amountOut, minAmountOut: result.amountOut }), /incompatible/);
});

test("output tax: pair sends gross; subsequent hop receives net", () => {
  const { input, result } = quote(100000000n, true);
  const gross = quoteV2ExactInput(57123817443n, 2432273785195304663393969n, input.amountIn, 30n);
  assert.equal(result.evidence.poolAmountOut, gross);
  assert.equal(result.amountOut, gross - gross / 100n);
  const fragment = family.execution.buildFragment({ ...input, exactEvidence: result.evidence,
    quotedAmountOut: result.amountOut, minAmountOut: result.amountOut });
  assert.equal(fragment.nodes[0].params.amount0Out, gross);
  assert.throws(() => family.execution.buildFragment({ ...input,
    exactEvidence: { ...result.evidence, poolAmountOut: result.amountOut },
    quotedAmountOut: result.amountOut, minAmountOut: result.amountOut }), /incompatible/);
});

test("input capacity counts net credit, including one-unit tax rounding", () => {
  const max = (1n << 112n) - 1n;
  assert.equal(quote(100n, false, max - 99n, max).result.evidence.unavailableReason, undefined);
  assert.equal(quote(100n, false, max - 99n, max).result.evidence.receivedAmountIn, 99n);
  assert.equal(quote(101n, false, max - 99n, max).result.evidence.unavailableReason, "input-reserve-capacity");
});

test("Exact cache separates transfer-tax recipient semantics, not arbitrary actor changes", () => {
  const { input } = quote(100000000n, true);
  const ordinary = family.exact.cacheCompatibilityProjection(input);
  assert.notDeepEqual(ordinary, family.exact.cacheCompatibilityProjection({ ...input, executor: BEAR }));
  assert.deepEqual(ordinary, family.exact.cacheCompatibilityProjection({ ...input, executor: TON }));
});

test("tax model is part of route and Exact cache binding; mids include both directional taxes", () => {
  const draft = family.pricing.compileDraft({ descriptor, routes, stateKey: descriptor.instanceKey });
  const priced = family.pricing.finalizePricingDescriptor({ draft, sharedBindings: [] });
  const snapshot = { source, reserve0: 1000000n, reserve1: 2000000n,
    balance0: 1000000n, balance1: 2000000n, blockTimestampLast: 0 };
  const mids = family.pricing.current.deriveMids({ descriptor: priced, snapshot, routes });
  assert(Math.abs(mids.get(routes[0].routeKey)!.mid - 2 * 0.99) < 1e-12);
  assert(Math.abs(mids.get(routes[1].routeKey)!.mid - 0.5 * 0.99) < 1e-12);
  const plain = { ...descriptor, tokenTransfers: undefined };
  assert.notEqual(family.routes.project({ descriptor: plain })[0].bindingRef.fingerprint, routes[0].bindingRef.fingerprint);
  const input = quote(10000n).input;
  assert.notDeepEqual(family.exact.cacheCompatibilityProjection(input),
    family.exact.cacheCompatibilityProjection({ ...input, descriptor: plain }));
  assert.equal(family.pricing.liveStateProjection!.project({ descriptor: priced, snapshot }), null,
    "legacy postimpact math cannot silently ignore taxes");
});

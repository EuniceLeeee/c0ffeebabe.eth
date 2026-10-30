import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, Interface, toBeHex } from "ethers";
import { compileDeclarativeCreditDomain, validateDeclarativeCreditDomain } from "../venues/declarative-credit-domain.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";

const op = (op: string, ...args: any[]) => ({ op, args });
const uint = (n: number) => op("uint", String(n));
const source = { number: 123, hash: toBeHex(123, 32), generation: 2 };
const executor = toBeHex(10, 20), vault = toBeHex(11, 20), tokenIn = toBeHex(12, 20), tokenOut = toBeHex(13, 20);
const signature = "function open(uint256,int256,int256,address) returns(uint256,int256,int256)";
const abi = new Interface([signature, "function rate() view returns(uint256)"]);
const descriptor = { familyId: "credit:fixture", lineageId: "credit:fixture:v1", instanceKey: vault, provenance: [], runtimeRequirements: [], vault } as any;
const route = { familyId: descriptor.familyId, lineageId: descriptor.lineageId, instanceKey: vault, routeKey: "fixture:route",
  tokenIn, tokenOut, taxonomy: { slotKind: "lend" }, bindingRef: { bindingKey: vault, fingerprint: "binding" }, runtimeRequirements: [], lifecycle: "standing-position" } as any;
const input = { descriptor, route, collateralAmount: 1000n, debtBps: 8500n, source, executor, runtimeEvidence: [] };
const row = (id: string, data: string, effects?: any) => ({ id, source, ok: true as const, completion: "returned" as const, data,
  provenance: { kind: "synthetic-unit-fixture", fingerprint: "not-chain-proof" }, ...(effects ? { effects } : {}) });
const data = (id: string) => op("get", op("returned", id), "data");
const definition: any = {
  version: 1, activeBehaviorProof: "required",
  position: { lifecycle: "standing-position", finalSafety: "position-and-repayment-required", key: op("hash", { route: "$route.routeKey", target: "$descriptor.vault" }) },
  risk: { debtBpsCandidates: ["8500", "9500", "10000"], blocksPrefixInversion: true,
    inputChecks: [{ assert: op("eq", op("length", "$runtimeEvidence"), 0), error: "pending transition unproven" }],
    evidence: { version: 1, steps: [
      { id: "rate", requirements: { transports: ["eth-call"] }, requests: [{ id: "rate", kind: "eth-call", to: "$descriptor.vault", completion: "return-data", data: op("encode", "vault", "rate", []) }],
        result: op("word", data("rate")) },
      { id: "position", requirements: { transports: ["effect-delta-simulation"], caller: "executor", effects: ["return-data", "token-delta"] },
        requests: [{ id: "open-position", kind: "effect-delta-simulation", call: { caller: { kind: "executor" }, to: "$descriptor.vault",
          data: op("encode", "vault", "open", [uint(0), "$collateralAmount", op("div", op("mul", "$steps.rate", "$debtBps"), uint(10000)), "$executor"]) },
          overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: "$route.tokenIn", amount: "$collateralAmount" }] }, observe: ["return-data", "token-delta"],
          observeTokenBalances: [{ token: "$route.tokenIn", account: { kind: "executor" } }, { token: "$route.tokenOut", account: { kind: "executor" } }] }],
        result: { rate: "$steps.rate", debt: op("decodeCanonical", "vault", "open", data("open-position"), 2) } },
    ], result: "$steps.position" },
    proof: { profile: "new-position-return-and-effects-v1", step: "position", requestId: "open-position", signature, target: "$descriptor.vault",
      call: { position: [0], collateral: [1], debt: [2], recipient: [3] }, returns: { position: [0], collateral: [1], debt: [2] } },
    quote: { checks: [{ assert: op("eq", "$evidence.debt", op("div", op("mul", "$evidence.rate", "$debtBps"), uint(10000))), error: "risk model mismatch" }], result: "$evidence.debt" },
  },
};
const values = compileDeclarativeValues({ abi: { vault: [signature, "function rate() view returns(uint256)"] }, constants: {}, expressions: {} });
const context = { assertInvocation(i: any) { assert.equal(i.route.routeKey, route.routeKey); assert.equal(i.descriptor.instanceKey, descriptor.instanceKey); }, environment: (i: any) => i };
function compiled(doc = definition) { return compileDeclarativeCreditDomain(doc, values, context); }
function effect(overrides: { position?: bigint; collateral?: bigint; debt?: bigint; debit?: bigint; receipt?: bigint; actor?: string } = {}) {
  const debt = overrides.debt ?? 425n;
  return row("open-position", abi.encodeFunctionResult("open", [overrides.position ?? 7n, overrides.collateral ?? 1000n, debt]), {
    tokenDeltas: [{ token: tokenIn, account: overrides.actor ?? executor, delta: overrides.debit ?? -1000n }, { token: tokenOut, account: overrides.actor ?? executor, delta: overrides.receipt ?? debt }],
  });
}
const initial = () => [row("rate", toBeHex(500, 32))];
function proof(compilation = compiled(), responses: any[] = [...initial(), effect()], at = input) {
  return compilation.definition.risk.evidence!.decode({ programInput: at, results: responses });
}

test("Credit uses declared dependency steps and retains trusted result object identities", () => {
  const c = compiled(), p = c.definition.risk.evidence!;
  assert.equal(c.definition.activeBehaviorProof, "required");
  assert.deepEqual(c.definition.risk.debtBpsCandidates, [8500n, 9500n, 10000n]);
  assert.equal(c.definition.risk.blocksPrefixInversion, true);
  assert.equal(c.definition.position.lifecycle, "standing-position");
  assert.equal(c.definition.position.finalSafety, "position-and-repayment-required");
  const first = initial();
  assert.deepEqual(p.buildRequests(input).map(r => r.id), ["rate"]);
  const bound = p.buildDependentProgram!({ programInput: input, initialResults: first, priorEvidence: [], completedRound: 0 })!;
  assert.equal(bound.requests.length, 1);
  const request = bound.requests[0] as any;
  assert.deepEqual([...abi.decodeFunctionData("open", request.call.data)], [0n, 1000n, 425n, getAddress(executor)]);
  const returned = effect(), prior = bound.decode([returned]) as any;
  assert.equal(prior.results[0], returned);
  assert.equal(p.buildDependentProgram!({ programInput: input, initialResults: first, priorEvidence: [prior], completedRound: 1 }), null);
  const e = proof(c, [...first, returned]);
  assert.equal(c.definition.risk.quoteOutputByDebtBps({ ...input, evidence: e }), 425n);
  assert.equal(c.verifyExecutionEvidence({ ...input, amountIn: 1000n, quotedAmountOut: 425n }, e), true);
  assert.equal(c.verifyExecutionEvidence({ ...input, amountIn: 1000n, quotedAmountOut: 425n }, { kind: "local-math" }), false);
  assert.equal("buildRuntimeLeg" in c.definition, false);
});

test("zero or wrong position and collateral/debt returns cannot pass token-only proof", () => {
  for (const changed of [{ position: 0n }, { collateral: 999n }, { debt: 424n }, { debt: 0n }])
    assert.throws(() => proof(compiled(), [...initial(), effect(changed)]));
});

test("actual debit, receipt and actor are independent mandatory observations", () => {
  for (const changed of [{ debit: 0n }, { debit: -999n }, { debit: -1001n }, { receipt: 424n }, { receipt: 426n }, { actor: toBeHex(99, 20) }])
    assert.throws(() => proof(compiled(), [...initial(), effect(changed)]), /debit or debt receipt/);
  const e = effect() as any;
  e.effects.tokenDeltas.push(e.effects.tokenDeltas[0]);
  assert.throws(() => proof(compiled(), [...initial(), e]), /debit or debt receipt/);
});

test("source, actor, route, ratios, amounts and decoded result cannot be rebound", () => {
  const c = compiled(), e = proof(c);
  for (const changed of [{ collateralAmount: 999n }, { debtBps: 9500n }, { descriptor: { ...descriptor, vault: toBeHex(99, 20) } },
    { route: { ...route, tokenOut: toBeHex(99, 20) } }])
    assert.throws(() => c.definition.risk.quoteOutputByDebtBps({ ...input, ...changed, evidence: e }), /binding mismatch/);
  for (const altered of [{ ...e, executor: toBeHex(99, 20) }, { ...e, source: { ...source, generation: 3 } }, { ...e, result: { debt: 10000n, rate: 500n } }])
    assert.throws(() => c.definition.risk.quoteOutputByDebtBps({ ...input, evidence: altered }));
  for (const changed of [{ executor: toBeHex(99, 20) }, { amountIn: 999n }, { quotedAmountOut: 424n }, { source: { ...source, number: 124 } }])
    assert.throws(() => c.verifyExecutionEvidence({ ...input, amountIn: 1000n, quotedAmountOut: 425n, ...changed }, e));
  for (const changed of [{ collateralAmount: 0n }, { debtBps: 1n }, { source: { ...source, hash: "0x" } }, { runtimeEvidence: [{}] }])
    assert.throws(() => c.definition.risk.evidence!.buildRequests({ ...input, ...changed } as any));
});

test("missing, duplicate, extra, failed, foreign-source and unproven simulation results reject", () => {
  for (const responses of [initial(), [...initial(), effect(), effect()], [...initial(), effect(), row("extra", "0x")],
    [...initial(), { ...effect(), source: { ...source, number: 124 } }], [...initial(), { ...effect(), provenance: undefined }],
    [...initial(), { ...effect(), completion: "reverted-as-declared" }], [...initial(), { id: "open-position", source, ok: false, failure: "rpc" }]])
    assert.throws(() => proof(compiled(), responses as any));
});

test("a declared simulation cannot use a foreign caller, recipient, target, prior position or omitted scope", () => {
  for (const mutate of [
    (r: any) => { r.call.caller = { kind: "verified-actor", evidenceId: "foreign" }; },
    (r: any) => { r.overrideIntent.caller = { kind: "none" }; },
    (r: any) => { r.call.to = toBeHex(99, 20); },
    (r: any) => { r.call.data.args[2][0] = uint(1); },
    (r: any) => { r.call.data.args[2][3] = toBeHex(99, 20); },
    (r: any) => { r.observeTokenBalances.pop(); },
    (r: any) => { r.overrideIntent.tokenBalances[0].amount = uint(1001); },
    (r: any) => { r.overrideIntent.tokenBalances.push({ token: tokenOut, amount: uint(500) }); },
    (r: any) => { r.overrideIntent.nativeBalanceWei = uint(1); },
    (r: any) => { r.call.executionMode = "impersonated-call-frame"; },
  ]) {
    const d = structuredClone(definition); mutate(d.risk.evidence.steps[1].requests[0]);
    assert.throws(() => proof(compiled(d)));
  }
});

test("quote expression cannot exceed or discount observed debt receipt", () => {
  for (const value of [424, 426, 0]) {
    const d = structuredClone(definition); d.risk.quote.result = uint(value);
    assert.throws(() => proof(compiled(d)), /must equal actual debt/);
  }
});

test("registration preserves mandatory Credit boundaries and validates paths and module data", () => {
  for (const mutate of [
    (d: any) => { d.activeBehaviorProof = "optional"; }, (d: any) => { d.position.lifecycle = "none"; },
    (d: any) => { d.position.finalSafety = "repayment-only"; }, (d: any) => { d.risk.blocksPrefixInversion = false; },
    (d: any) => { d.risk.debtBpsCandidates = ["0"]; }, (d: any) => { d.risk.debtBpsCandidates = ["10001"]; },
    (d: any) => { d.risk.debtBpsCandidates = ["8500", "8500"]; }, (d: any) => { d.risk.proof = {}; },
    (d: any) => { d.risk.debtBpsCandidates = ["9500", "8500"]; },
    (d: any) => { d.risk.proof.profile = "token-only"; }, (d: any) => { d.risk.proof.call.recipient = [1]; },
    (d: any) => { d.risk.proof.returns.position = [1]; }, (d: any) => { d.risk.proof.call.debt = [1]; },
    (d: any) => { d.risk.proof.step = "missing"; }, (d: any) => { d.risk.quote.checks = []; },
    (d: any) => { d.risk.quote.result = () => 425n; },
  ]) {
    const d = structuredClone(definition); mutate(d); assert.throws(() => validateDeclarativeCreditDomain(d));
  }
});

test("Credit declaration rejects read flows beyond the current issuer's four dependent rounds", () => {
  const d = structuredClone(definition);
  for (let index = d.risk.evidence.steps.length; index < 5; index++) {
    d.risk.evidence.steps.push({ ...structuredClone(d.risk.evidence.steps[0]), id: `extra${index}` });
  }
  assert.doesNotThrow(() => validateDeclarativeCreditDomain(d));
  d.risk.evidence.steps.push({ ...structuredClone(d.risk.evidence.steps[0]), id: "extra5" });
  assert.throws(() => validateDeclarativeCreditDomain(d), /issuer read-round budget/);
});

test("a trusted transaction origin requires a matching call-frame proof and execution context", () => {
  const d = structuredClone(definition); d.risk.evidence.steps[1].requests[0].call.executionMode = "impersonated-call-frame";
  const c = compiled(d), origin = toBeHex(50, 20), invocation = { ...input, transactionOrigin: origin };
  const e = proof(c, [...initial(), effect()], invocation);
  assert.equal(c.verifyExecutionEvidence({ ...invocation, amountIn: 1000n, quotedAmountOut: 425n }, e), true);
  assert.throws(() => c.verifyExecutionEvidence({ ...input, amountIn: 1000n, quotedAmountOut: 425n }, e), /actor or collateral/);
  assert.throws(() => proof(compiled(), [...initial(), effect()], invocation), /caller authority/);
});

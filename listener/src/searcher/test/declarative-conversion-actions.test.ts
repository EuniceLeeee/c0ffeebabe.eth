import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import definition from "../venues/protocols/erc4626-family/morpho-vault-v2.json";
import { normalizeDeclarativeVariant } from "../venues/declarative-variant.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";

const doc = normalizeDeclarativeVariant(definition), values = compileDeclarativeValues(doc);
const vault = "0x1111111111111111111111111111111111111111", asset = "0x2222222222222222222222222222222222222222";
const actor = definition.constants.actor;
const source = { number: 1, hash: `0x${"a".repeat(64)}`, generation: 1 };
const abi = new Interface(definition.abi.vault), events = new Interface(definition.abi.events);
const surface = { vault, share: vault, asset, source };
const samples = [
  { direction: "deposit", amount: 10n, expected: 5n },
  { direction: "redeem", amount: 5n, expected: 10n },
  { direction: "mint", amount: 5n, expected: 10n },
  { direction: "withdraw", amount: 10n, expected: 5n },
];

test("conversion admission supports declared action count and rejects duplicate actions", () => {
  const requests = values.evaluate(doc.identity.stages.probe.requests, { evidence: { surface, morpho: surface, samples } });
  assert.equal(requests.length, 4);
  for (const request of requests) {
    const call = abi.parseTransaction({ data: request.call.data })!;
    const sample = samples.find(s => s.direction === call.name)!;
    assert.equal(call.args[0], sample.amount);
    assert.equal(request.overrideIntent.tokenBalances[0].amount, ["deposit", "mint"].includes(call.name) ? 10n : 5n);
    assert.equal(request.overrideIntent.tokenBalances[0].token, ["deposit", "mint"].includes(call.name) ? asset : vault);
  }
  const bad = structuredClone(definition); bad.admission.samples.directions.push("mint");
  assert.throws(() => normalizeDeclarativeVariant(bad), /invalid conversion admission/);
});

test("all four actions require independent debit, receipt and supply effects", () => {
  for (const sample of samples) {
    const deposit = ["deposit", "mint"].includes(sample.direction);
    const log = events.encodeEventLog(events.getEvent(deposit ? "Deposit" : "Withdraw")!,
      deposit ? [actor, actor, 10n, 5n] : [actor, actor, actor, 10n, 5n]);
    const result = { data: abi.encodeFunctionResult(sample.direction, [sample.expected]), effects: {
      tokenDeltas: [{ token: vault, account: actor, delta: deposit ? 5n : -5n }, { token: asset, account: actor, delta: deposit ? -10n : 10n }],
      totalSupplyDeltas: [{ token: vault, delta: deposit ? 5n : -5n }], logs: [{ address: vault, ...log }],
    } };
    assert.equal(values.run(doc.programs.verifyEffects, { sample, surface, result }), true);
    const bad = structuredClone(result); bad.effects.tokenDeltas[deposit ? 1 : 0]!.delta = 0n;
    assert.throws(() => values.run(doc.programs.verifyEffects, { sample, surface, result: bad }), /token effect mismatch/);
  }
});

test("mint Exact quote uses assets in, shares out, never previewMint(assetBudget)", () => {
  const requests = values.evaluate(doc.readPrograms.quote.requests, { descriptor: { vault }, direction: "mint", amountIn: 10n, requestId: "q" });
  const call = abi.parseTransaction({ data: requests[0].data })!;
  assert.equal(call.name, "previewDeposit"); assert.equal(call.args[0], 10n);
});

import { toBeHex } from "ethers";
import { buildDeclarativeRuntimeLeg } from "../venues/declarative-execution.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

test("mint runtime uses asset budget and preserves old inventory; unspent input is rejected", () => {
  const executor = "0x3333333333333333333333333333333333333333";
  const built = buildDeclarativeRuntimeLeg(doc.execution, { descriptor: { vault, share: vault, asset },
    route: { adapterId: "erc4626-mint", target: vault, tokenIn: asset, tokenOut: vault, direction: "mint" },
    direction: "mint", executor, source }, values)!;
  const erc20 = new Interface(["function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)",
    "function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)"]);
  const run = (input: bigint) => {
    let assets = input + 100n, shares = 13n, supply = 1000n, allowance = 0n;
    inspectRuntime(built.program, input, { nativeBalance: () => 0n, allowance() {}, call(call) {
      const view = erc20.parseTransaction({ data: call.data });
      if (view?.name === "balanceOf") return toBeHex(call.target.toLowerCase() === asset ? assets : shares, 32);
      if (view?.name === "totalSupply") return toBeHex(supply, 32);
      if (view?.name === "allowance") return toBeHex(allowance, 32);
      if (view?.name === "approve") { allowance = BigInt(view.args[1]); return toBeHex(1n, 32); }
      const action = abi.parseTransaction({ data: call.data })!;
      if (action.name === "previewDeposit") return toBeHex(BigInt(action.args[0]) / 2n, 32);
      assert.equal(action.name, "mint"); assert.equal(action.args[0], input / 2n);
      const output = BigInt(action.args[0]), cost = output * 2n;
      assets -= cost; shares += output; supply += output; allowance -= cost;
      return toBeHex(cost, 32);
    } });
    assert.equal(assets, 100n); assert.equal(shares, 13n + input / 2n);
  };
  run(10n);
  assert.throws(() => run(11n), /mismatch|assert|check/i);
});

import { compileDeclarativeIdentity } from "../venues/declarative-identity.js";

test("four-action admission emits unique requests through the production identity compiler", () => {
  const identity = compileDeclarativeIdentity({ version: 1, abi: doc.abi, constants: doc.constants,
    expressions: doc.expressions ?? {}, programs: doc.programs, identity: doc.identity } as any,
    { id: definition.id, familyId: "protocol:erc4626", lineageId: definition.lineageId } as any);
  const requests = identity.buildRequests({ candidate: { vault }, step: 2,
    evidence: { phase: "surface", surface, samples } } as any);
  assert.equal(new Set(requests.map(r => r.id)).size, requests.length);
  for (const sample of samples) {
    const rows = requests.filter(r => r.id === `morphoV2-preview-${sample.direction}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "eth-call");
    const parsed = abi.parseTransaction({ data: (rows[0] as any).data })!;
    assert.equal(parsed.name, `preview${sample.direction[0]!.toUpperCase()}${sample.direction.slice(1)}`);
    assert.equal(parsed.args[0], sample.amount);
  }
});

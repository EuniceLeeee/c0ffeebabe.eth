import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Interface, hexlify, getBytes, toBeHex, MaxUint256 } from "ethers";
import { normalizeSelectorNativeExecutionDefinition } from "../venues/selector-native-definition.js";
import { createSelectorNativeRuntime } from "../venues/selector-native-runtime.js";
import { inspectRuntime, RuntimeProgramGuardError, type RuntimeCall } from "./runtime-program-testkit.js";

// Independent VM interpretation of migrated author JSON, not chain evidence.
const a = (n: number) => toBeHex(n, 20), h = (n: number) => toBeHex(n, 32);
const target = a(100), executor = a(101), recipient = a(102), input = a(201), output = a(202), basket = a(500), proxy = a(501), vault = a(502);
const source = { number: 1000, hash: h(1000), generation: 1 };
const abi = new Interface([
  "function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)",
  "function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)",
  "function transfer(address,uint256)", "function tokenBalances(address) view returns(uint256)",
  "function swap(address,address,address) returns(uint256)", "function debond(uint256,address[],uint8[])",
  "function paused() view returns(bool)", "function treasury() view returns(address)", "function getReserves() view returns(uint256,uint256)",
  "function previewSellGem(uint256,address) view returns(uint256,uint256)", "function previewBuyGem(uint256,address) view returns(uint256,uint256)",
  "function gemToWad() view returns(uint256)", "function stableToWad() view returns(uint256)",
  "function maxPerTransaction() view returns(uint256)", "function getRemainingBlockCapacity() view returns(uint256)",
  "function sellGem(address,uint256) returns(uint256)", "function buyGem(address,uint256) returns(uint256)",
  "function getAmountNeeded(address,uint256) view returns(uint256)", "function available(address) view returns(uint256)",
  "function receiver() view returns(address)", "function take(address) returns(uint256)", "function take(address,uint256) returns(uint256)",
  "function take(address,uint256,address) returns(uint256)", "function take(address,uint256,address,bytes) returns(uint256)",
  "function redeem(address,uint256,address)", "function redeemAndWithdrawTo(address,address,uint256,uint256)",
  "function issue(address,uint256)", "function issueTo(address,address,uint256)",
  "function getComponents() view returns(address[])", "function getUnits() view returns(uint256[])",
  "function getDefaultPositionRealUnit(address) view returns(int256)", "function naturalUnit() view returns(uint256)",
  "function transferProxy() view returns(address)", "function vault() view returns(address)",
  "function getOwnerBalance(address,address) view returns(uint256)", "function entryFee() view returns(uint256)",
  "function feeRecipient() view returns(address)", "function execSubscript(bytes)",
]);
function recipe(selector: string, key: string, descriptor: Record<string, any> = {}, tokenIn = input, tokenOut = output) {
  const raw = JSON.parse(readFileSync(new URL(`../venues/selector-native/selector-${selector}-family/selector-${selector}.json`, import.meta.url), "utf8"));
  const program = raw.programs.find((p: any) => p.meta?.migrationKey === key);
  assert(program, key);
  const definition = normalizeSelectorNativeExecutionDefinition({ ...raw, programs: [program] });
  const runtime = createSelectorNativeRuntime(definition, definition.programs[0]!);
  const common = { descriptor: { target, tokenIn, tokenOut, ...descriptor },
    route: { target, tokenIn, tokenOut, adapterId: runtime.actionId }, executor, source, runtimeEvidence: [] };
  return { runtime, common, leg(settlement?: any) { const leg = runtime.buildRuntimeLeg({ ...common, ...(settlement ? { settlement } : {}) }); assert(leg); return leg; } };
}
function host(options: { tokens?: string[]; tokenIn?: string; tokenOut?: string; fee?: boolean; fault?: string; credit?: bigint; allowance?: bigint } = {}) {
  const tokens = options.tokens ?? [input], tokenIn = options.tokenIn ?? input, tokenOut = options.tokenOut ?? output;
  const balance = new Map<string, bigint>(), allowances = new Map<string, bigint>(), supplies = new Map<string, bigint>();
  const key = (token: string, actor: string) => `${token.toLowerCase()}:${actor.toLowerCase()}`;
  const get = (token: string, actor: string) => balance.get(key(token, actor)) ?? 0n;
  const set = (token: string, actor: string, amount: bigint) => { assert(amount >= 0n); balance.set(key(token, actor), amount); };
  const add = (token: string, actor: string, delta: bigint) => set(token, actor, get(token, actor) + delta);
  for (const token of new Set([tokenIn, tokenOut, basket, input, output, ...tokens])) {
    set(token, executor, 10000n); set(token, recipient, 7n); set(token, target, 100000n); supplies.set(token, 1000000n);
  }
  allowances.set(key(tokenIn, proxy), options.allowance ?? 0n);
  const accounted = new Map([[tokenIn.toLowerCase(), get(tokenIn, target)]]), calls: string[] = [];
  let entryCalls = 0;
  const result = (signature: string, values: any[]) => abi.encodeFunctionResult(signature, values);
  const call = (c: RuntimeCall): string => {
    const p = abi.parseTransaction({ data: c.data }); assert(p, c.data); calls.push(p.signature);
    const args = p.args, at = c.target.toLowerCase(), name = p.name;
    if (name === "execSubscript") {
      const script = getBytes(args[0]); assert.equal(script[0], 0x0e);
      assert.equal(Number(BigInt(hexlify(script.slice(33, 36)))), script.length - 36);
      inspectRuntime(hexlify(script.slice(36)), BigInt(hexlify(script.slice(1, 33))), { call, nativeBalance: () => 17n });
      return "0x";
    }
    if (name === "balanceOf") return result(p.signature, [get(at, args[0])]);
    if (name === "totalSupply") return result(p.signature, [supplies.get(at) ?? 0n]);
    if (name === "allowance") return result(p.signature, [allowances.get(key(at, args[1])) ?? 0n]);
    if (name === "approve") { allowances.set(key(at, args[0]), args[1]); return result(p.signature, [true]); }
    if (name === "transfer") {
      add(at, executor, -BigInt(args[1])); add(at, args[0], args[1]);
      if (options.fault === "handoff-side-theft" && at === tokenOut && tokens.length > 1) add(tokens[tokens.length - 1]!, executor, -1n);
      return "0x";
    }
    if (name === "tokenBalances") return result(p.signature, [accounted.get(String(args[0]).toLowerCase()) ?? 0n]);
    if (name === "swap") {
      entryCalls++; const amount = get(tokenIn, target) - accounted.get(tokenIn)!;
      add(tokenOut, args[2], amount * 2n); accounted.set(tokenIn, get(tokenIn, target));
      return result(p.signature, [options.fault === "false-return" ? amount * 3n : amount * 2n]);
    }
    if (name === "debond") { entryCalls++; assert.deepEqual([...args[1]], []); assert.deepEqual([...args[2]], []);
      add(tokenIn, executor, -BigInt(args[0])); add(tokenOut, executor, args[0] * 2n); return "0x"; }
    if (name === "paused") return result(p.signature, [false]);
    if (name === "treasury" || name === "feeRecipient" || name === "receiver") return result(p.signature, [a(299)]);
    if (name === "getReserves") return result(p.signature, [100000n, 100000n]);
    if (name.startsWith("preview")) return result(p.signature, [args[0] * 2n - 3n, 3n]);
    if (name === "gemToWad" || name === "stableToWad") return result(p.signature, [1n]);
    if (name === "maxPerTransaction") return result(p.signature, [0n]);
    if (name === "getRemainingBlockCapacity") return result(p.signature, [100000n]);
    if (name === "sellGem" || name === "buyGem") { entryCalls++; add(tokenIn, executor, -BigInt(args[1])); add(tokenOut, args[0], args[1] * 2n - 3n);
      return result(p.signature, [args[1] * 2n - 3n]); }
    if (name === "getAmountNeeded") return result(p.signature, [3n * 10n ** 18n]);
    if (name === "available") return result(p.signature, [50n]);
    if (name === "take") {
      entryCalls++; const quantity = args.length === 1 ? 50n : args[1] < 50n ? args[1] : 50n;
      const cost = quantity * 3n + (options.fault === "wrong-cost" ? 1n : 0n);
      add(tokenIn, executor, -cost); add(tokenOut, args.length >= 3 ? args[2] : executor, quantity);
      return result(p.signature, [quantity]);
    }
    if (name === "getComponents") {
      const data = result(p.signature, [options.fault === "membership" ? [...tokens].reverse() : tokens]);
      if (options.fault === "abi-offset") return toBeHex(64, 32) + data.slice(66);
      if (options.fault === "abi-length") return data.slice(0, 66) + toBeHex(tokens.length + 1, 32).slice(2) + data.slice(130);
      return data;
    }
    if (name === "getUnits") return result(p.signature, [tokens.map((_, i) => BigInt(i + 3))]);
    if (name === "getDefaultPositionRealUnit") return result(p.signature, [BigInt(tokens.indexOf(String(args[0]).toLowerCase()) + 1) * 10n ** 18n]);
    if (name === "naturalUnit") return result(p.signature, [2n]);
    if (name === "transferProxy") return result(p.signature, [proxy]);
    if (name === "vault") return result(p.signature, [vault]);
    if (name === "getOwnerBalance") return result(p.signature, [options.credit ?? 0n]);
    if (name === "entryFee") return result(p.signature, [options.fee ? 10n ** 17n : 0n]);
    if (name === "redeem" || name === "redeemAndWithdrawTo") {
      entryCalls++; const amount = name === "redeem" ? args[1] : args[2], receiver = name === "redeem" ? args[2] : args[1];
      add(basket, executor, -BigInt(amount)); supplies.set(basket, supplies.get(basket)! - amount);
      tokens.forEach((token, i) => add(token, receiver, (name === "redeem" ? amount * BigInt(i + 1) : amount / 2n * BigInt(i + 3))
        - (options.fault === "short-side" && i === tokens.length - 1 ? 1n : 0n)));
      return "0x";
    }
    if (name === "issue" || name === "issueTo") {
      entryCalls++; const quantity = name === "issue" ? args[1] : args[2], receiver = name === "issue" ? executor : args[0];
      const fee = options.fee ? quantity / 10n : 0n;
      add(tokenIn, executor, -(quantity / 2n * 3n)); add(basket, receiver, quantity - fee); supplies.set(basket, supplies.get(basket)! + quantity);
      return "0x";
    }
    assert.fail("undeclared fixture call " + p.signature);
  };
  return { call, get, calls, entryCalls: () => entryCalls, run(program: string, amount: bigint, readOnly = false) {
    return inspectRuntime(program, amount, { call, nativeBalance: () => 17n }, { output: readOnly, readOnly });
  } };
}
function rejects(run: () => unknown) { assert.throws(run, (e: unknown) => e instanceof RuntimeProgramGuardError); }

test("vault pretransfer uses actual receipts, preserves accounted inventory and rejects false returns", () => {
  const f = recipe("93316212", "typed:vault-spot:pretransfer-accounted"), leg = f.leg();
  const good = host(); good.run(leg.program, 17n); assert.equal(good.get(input, executor), 9983n); assert.equal(good.get(output, executor), 10034n);
  rejects(() => host({ fault: "false-return" }).run(leg.program, 17n));
});
test("weighted debond executes its amount and empty optional lists without an old identity", () => {
  const f = recipe("ee9c79da", "typed:peapods-debond:single-asset", {}, target, output), state = host({ tokenIn: target });
  state.run(f.leg().program, 17n); assert.equal(state.get(target, executor), 9983n); assert.equal(state.get(output, executor), 10034n);
});
for (const [selector, name] of [["95991276", "sellGem"], ["8d7ef9bb", "buyGem"]]) test(`PSV ${name} has transaction-local direct pricing and clear approvals`, () => {
  const f = recipe(selector!, `typed:psv:${name}`), q = host();
  assert.equal(q.run(f.leg({ kind: "quote-output", recipient }).program, 17n, true).registers[0], 31n);
  const state = host(); state.run(f.leg({ kind: "direct-output", recipient }).program, 17n);
  assert.equal(state.get(input, executor), 9983n); assert.equal(state.get(output, recipient), 38n);
});
for (const [selector, count] of [["4d44e663", 1], ["52180208", 2], ["8033d687", 3], ["66ae5880", 4]] as const)
  test(`auction take/${count} consumes computed positive cost within the input budget`, () => {
    const f = recipe(selector, `typed:yearn-auction:take-${count}`, { wantScale: 1n, soldScale: 1n, denominator: 10n ** 18n, priceProbe: 10n ** 18n });
    const amount = count === 1 ? 200n : 100n, expectedCost = count === 1 ? 150n : 99n, expectedOutput = count === 1 ? 50n : 33n;
    const leg = f.leg(); assert.equal(leg.inputMode, "maximum");
    const state = host(); state.run(leg.program, amount); assert.equal(state.get(input, executor), 10000n - expectedCost);
    assert.equal(state.get(output, executor), 10000n + expectedOutput);
    rejects(() => host({ fault: "wrong-cost" }).run(leg.program, amount));
    rejects(() => host().run(leg.program, count === 1 ? 100n : 1n));
    if (count >= 3) { const direct = host(); direct.run(f.leg({ kind: "direct-output", recipient }).program, amount);
      assert.equal(direct.get(output, recipient), 7n + expectedOutput); }
    if (count === 4) assert(f.leg({ kind: "deferred-input", paymentAmount: 1n,
      paymentProgram: "0x0100010000000000000000000000000000000000000000000000000000000000000000" }).program);
  });
for (const count of [1, 16]) test(`Basic basket/${count} guards every component and forwards only the selected fresh receipt`, () => {
  const tokens = Array.from({ length: count }, (_, i) => a(201 + i)), out = tokens[0]!;
  const f = recipe("5c833bfd", "typed:set:basic-basket", { set: basket, components: tokens, componentRows: tokens.map((token, index) => ({ token, index })) }, basket, out);
  for (const direct of [false, true]) {
    const leg = f.leg(direct ? { kind: "direct-output", recipient } : undefined), state = host({ tokens, tokenIn: basket, tokenOut: out });
    state.run(leg.program, 7n); assert.equal(state.entryCalls(), 1);
    for (const fault of ["abi-offset", "abi-length"]) rejects(() => host({ tokens, tokenIn: basket, tokenOut: out, fault }).run(leg.program, 7n));
    assert.equal(state.get(out, direct ? recipient : executor), (direct ? 7n : 10000n) + 7n);
    if (count > 1) { assert.equal(state.get(tokens[count - 1]!, executor), 10000n + BigInt(count) * 7n);
      rejects(() => host({ tokens, tokenIn: basket, tokenOut: out, fault: "short-side" }).run(leg.program, 7n));
      rejects(() => host({ tokens, tokenIn: basket, tokenOut: out, fault: "membership" }).run(leg.program, 7n));
      if (direct) rejects(() => host({ tokens, tokenIn: basket, tokenOut: out, fault: "handoff-side-theft" }).run(leg.program, 7n)); }
  }
});
for (const count of [1, 16]) test(`legacy basket/${count} preserves natural-unit divisibility and every side receipt`, () => {
  const tokens = Array.from({ length: count }, (_, i) => a(201 + i)), out = tokens[0]!;
  const f = recipe("1c2a0e40", `typed:set:legacy-redemption:${count === 1 ? "unary" : "basket"}`,
    { set: basket, components: tokens, componentRows: tokens.map((token, index) => ({ token, index })) }, basket, out);
  const leg = f.leg(), state = host({ tokens, tokenIn: basket, tokenOut: out });
  state.run(leg.program, 8n); assert.equal(state.entryCalls(), 1);
  assert.equal(state.get(out, executor), 10012n);
  rejects(() => host({ tokens, tokenIn: basket, tokenOut: out }).run(leg.program, 7n));
  rejects(() => host({ tokens, tokenIn: basket, tokenOut: out, fault: "short-side" }).run(leg.program, 8n));
  if (count === 1) {
    const direct = host({ tokens, tokenIn: basket, tokenOut: out }); direct.run(f.leg({ kind: "direct-output", recipient }).program, 8n);
    assert.equal(direct.get(out, recipient), 19n);
  } else assert.throws(() => f.leg({ kind: "direct-output", recipient }));
});
for (const to of [false, true]) for (const fee of [false, true]) test(`legacy issuance ${to ? "to" : "self"}/${fee ? "fee" : "plain"} enforces units, old credit and allowance`, () => {
  const f = recipe(to ? "73088bf7" : "867904b4", `typed:set:legacy-issue:${to ? "to" : "self"}:${fee ? "fee" : "plain"}`,
    { set: basket, components: [input], transferProxy: proxy, vault }, input, basket);
  const leg = f.leg(to ? { kind: "direct-output", recipient } : undefined), state = host({ tokenOut: basket, fee });
  state.run(leg.program, 18n); assert.equal(state.get(input, executor), 9982n);
  assert.equal(state.get(basket, to ? recipient : executor), (to ? 7n : 10000n) + (fee ? 11n : 12n));
  rejects(() => host({ tokenOut: basket, fee }).run(leg.program, 17n));
  rejects(() => host({ tokenOut: basket, fee, credit: 1n }).run(leg.program, 18n));
  rejects(() => host({ tokenOut: basket, fee, allowance: MaxUint256 }).run(leg.program, 18n));
});

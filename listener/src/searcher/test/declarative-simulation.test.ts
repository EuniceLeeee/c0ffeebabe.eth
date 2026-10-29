import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, getBytes, hexlify, toBeHex } from "ethers";
import { buildDeclarativeExecutionSimulation, decodeDeclarativeExecutionSimulationReceipt,
  declarativeExecutionSimulationRequirements, executorFromObservedSimulation } from "../venues/declarative-simulation.js";
import { buildDeclarativeRuntimeLeg, type DeclarativeConversionExecution } from "../venues/declarative-execution.js";
import { createDeclarativeRuntimeMathRegistry } from "../venues/declarative-runtime-math.js";
import { assertSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { RequiredAdapterRequestError } from "../venues/adapter-request-failure.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

const a = (n: number) => toBeHex(n, 20), INPUT = a(1), OUTPUT = a(2), TARGET = a(3), ACTOR = a(4), PROTECTED = a(5);
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const ref = (runtime: string) => ({ runtime });
const values = { evaluate(value: any, env: Record<string, any>): any {
  if (typeof value === "string" && value.startsWith("$")) return value.slice(1).split(".").reduce((v, key) => v?.[key], env);
  if (Array.isArray(value)) return value.map(item => this.evaluate(item, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.evaluate(item, env)]));
  return value;
} };
const math = createDeclarativeRuntimeMathRegistry([{ id: "fixture:ratio", version: 1, inputs: ["amount", "rate"], outputs: ["output"],
  operations: [{ name: "output", op: "mul", left: { input: "amount" }, right: { input: "rate" } }] }])
  .bind({ version: 1, entries: { ratio: { model: "fixture:ratio", version: 1 } } });
const execution: DeclarativeConversionExecution = {
  version: 2, settlement: { directOutput: true }, protectedAddresses: [INPUT, OUTPUT, TARGET, PROTECTED], requireCanonicalSource: true,
  steps: [
    { id: "state", static: true, call: { target: TARGET, signature: "function rate() view returns(uint256)", args: [], save: { rate: 0 } } },
    { id: "formula", math: { model: "ratio", inputs: { amount: ref("amountIn"), rate: ref("rate") }, outputs: { output: "expected" } } },
    { id: "action", approval: { token: INPUT, spender: TARGET, mode: "exact-clear", requireBool: true, verifyAllowance: true },
      call: { target: TARGET, signature: "function convert(uint256,uint256) returns(uint256)", args: [ref("amountIn"), ref("expected")], save: { received: 0 } } },
  ],
  effects: [
    { kind: "debit", token: INPUT, account: "$executor", equals: ref("amountIn") },
    { kind: "credit", token: OUTPUT, account: "$recipient", equals: ref("received") },
    { kind: "unchanged-token", token: PROTECTED, account: "$executor" }, { kind: "unchanged-native" },
  ],
};
const declaration = { kind: "declarative-execution-simulation" as const, id: "program-proof", amountIn: "$amountIn",
  protectedTokens: [PROTECTED], observe: ["logs" as const] };
const input = { route: { adapterId: "fixture", target: TARGET, tokenIn: INPUT, tokenOut: OUTPUT }, executor: ACTOR,
  amountIn: 17n, source, runtimeEvidence: [] };
function request() { return buildDeclarativeExecutionSimulation(declaration, input, values, execution, { math }); }
function unpack(data: string) {
  assertSubscriptCalldata(data);
  const bytes = getBytes(AbiCoder.defaultAbiCoder().decode(["bytes"], `0x${data.slice(10)}`)[0]);
  assert.equal(bytes[0], 0x0e);
  assert.equal(Number(BigInt(hexlify(bytes.slice(33, 36)))), bytes.length - 36);
  return { amount: BigInt(hexlify(bytes.slice(1, 33))), program: hexlify(bytes.slice(36)) };
}
test("simulation wraps the same runtime program with actual input and trusted symbolic caller", () => {
  const r = request(), program = unpack(r.call.data);
  assert.equal(program.amount, 17n);
  assert.equal(program.program, buildDeclarativeRuntimeLeg(execution, input, values, { math })!.program);
  assert.deepEqual(r.call.caller, { kind: "executor" }); assert.equal(r.call.to, ACTOR);
  assert.equal(r.call.executionMode, "executor-program"); assert.equal(r.preCalls, undefined);
  assert.deepEqual(r.overrideIntent, { caller: { kind: "executor" }, tokenBalances: [{ token: INPUT, amount: 17n }] });
  assert.deepEqual(r.observeTokenBalances?.map(row => row.token), [INPUT, OUTPUT, PROTECTED]);
  assert.deepEqual(r.observe, ["return-data", "revert-data", "token-delta", "native-delta", "logs"]);
  assert.equal(declarativeExecutionSimulationRequirements(declaration).caller, "executor");
  const poisoned = Object.defineProperties({ ...input }, {
    quotedAmountOut: { get() { throw new Error("quote read"); } }, exactEvidence: { get() { throw new Error("evidence read"); } },
    minAmountOut: { get() { throw new Error("minimum read"); } },
  });
  assert.equal(buildDeclarativeExecutionSimulation(declaration, poisoned, values, execution, { math }).call.data, r.call.data);
});

function run(fault?: string) {
  const r = request(), p = unpack(r.call.data);
  let balanceIn = 117n, balanceOut = 103n, protectedBalance = 107n, native = 109n, allowance = 0n;
  const abi = new Interface(["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
    "function allowance(address,address) view returns(uint256)", "function rate() view returns(uint256)", "function convert(uint256,uint256) returns(uint256)"]);
  inspectRuntime(p.program, p.amount, { nativeBalance: () => native, call(call) {
    const parsed = abi.parseTransaction({ data: call.data })!;
    if (parsed.name === "balanceOf") return toBeHex(call.target.toLowerCase() === INPUT ? balanceIn : call.target.toLowerCase() === OUTPUT ? balanceOut : protectedBalance, 32);
    if (parsed.name === "approve") { allowance = parsed.args[1]; return toBeHex(fault === "approval" ? 0n : 1n, 32); }
    if (parsed.name === "allowance") return toBeHex(allowance, 32);
    if (parsed.name === "rate") return toBeHex(2n, 32);
    assert.equal(parsed.name, "convert"); assert.equal(parsed.args[0], 17n); assert.equal(parsed.args[1], 34n); assert.equal(allowance, 17n);
    balanceIn -= fault === "zero-debit" ? 0n : fault === "under-debit" ? 16n : fault === "over-debit" ? 18n : 17n;
    balanceOut += fault === "short-output" ? 33n : 34n;
    if (fault === "old-token") protectedBalance--;
    if (fault === "old-native") native--;
    return toBeHex(34n, 32);
  } });
  assert.deepEqual([balanceIn, balanceOut, protectedBalance, native, allowance], [100n, 137n, 107n, 109n, 0n]);
}
test("executor-program executes state/math/approval/action and retains inventory guards", () => run());
for (const fault of ["approval", "zero-debit", "under-debit", "over-debit", "short-output", "old-token", "old-native"])
  test(`executor-program rejects ${fault}`, () => assert.throws(() => run(fault)));

const receipt = (): any => ({ id: declaration.id, ok: true, source, completion: "returned", data: "0x",
  provenance: { kind: "fixture", fingerprint: "sealed-receipt" }, effects: {
    tokenDeltas: [{ token: INPUT, account: ACTOR, delta: -17n }, { token: OUTPUT, account: ACTOR, delta: 34n },
      { token: PROTECTED, account: ACTOR, delta: 0n }], nativeDeltas: [{ account: ACTOR, delta: 0n }], logs: [],
  } });
const context = () => ({ request: request(), result: receipt(), source, executor: ACTOR, tokenIn: INPUT, tokenOut: OUTPUT, amountIn: 17n });
test("empty program receipt proves exact debit, actual receipt and extra/native conservation", () => {
  assert.equal(decodeDeclarativeExecutionSimulationReceipt(context()), 34n);
  assert.equal(executorFromObservedSimulation(context()), ACTOR);
});
for (const [label, mutate] of Object.entries({
  returnWord: (i: any) => { i.result.data = toBeHex(34n, 32); },
  rawCall: (i: any) => { i.request = { ...i.request, call: { ...i.request.call, executionMode: "impersonated-call-frame" } }; },
  rawCalldata: (i: any) => { i.request = { ...i.request, call: { ...i.request.call, data: "0x12345678" } }; },
  wrongActor: (i: any) => { i.executor = a(99); },
  zeroDebit: (i: any) => { i.result.effects.tokenDeltas[0].delta = 0n; },
  shortDebit: (i: any) => { i.result.effects.tokenDeltas[0].delta = -16n; },
  extraActor: (i: any) => { i.result.effects.tokenDeltas[2].account = a(99); },
  changedInventory: (i: any) => { i.result.effects.tokenDeltas[2].delta = -1n; },
  changedNative: (i: any) => { i.result.effects.nativeDeltas[0].delta = -1n; },
  duplicate: (i: any) => { i.result.effects.tokenDeltas.push(i.result.effects.tokenDeltas[0]); },
  missingNative: (i: any) => { delete i.result.effects.nativeDeltas; },
  stale: (i: any) => { i.result.source = { ...source, number: 101 }; },
  unattested: (i: any) => { i.result.provenance.fingerprint = ""; },
  revert: (i: any) => { i.result.completion = "reverted-as-declared"; },
})) test(`program receipt rejects ${label}`, () => { const i = context(); mutate(i); assert.throws(() => decodeDeclarativeExecutionSimulationReceipt(i)); });
test("transport failures preserve their retryable error type; no receipt is fabricated", () => {
  const i = context(); i.result = { id: declaration.id, ok: false, source, failure: "rpc" };
  assert.throws(() => decodeDeclarativeExecutionSimulationReceipt(i), RequiredAdapterRequestError);
});
test("actor extraction requires original executor observation and unique actual debit", () => {
  for (const mutate of [
    (i: any) => { i.request = { ...i.request, call: { ...i.request.call, caller: { kind: "observed-sender" } } }; },
    (i: any) => { i.request = { ...i.request, observeTokenBalances: [{ token: INPUT, account: ACTOR }] }; },
    (i: any) => { i.result.effects.tokenDeltas[0].delta = 0n; },
    (i: any) => { i.result.effects.tokenDeltas.push({ token: INPUT, account: a(99), delta: -17n }); },
  ]) { const i = context(); mutate(i); assert.throws(() => executorFromObservedSimulation(i)); }
});
test("JSON cannot provide script, actor authority, arbitrary funds, or external settlement", () => {
  for (const extra of [{ script: "0x01" }, { caller: { kind: "executor" } }, { preCalls: [] }, { overrideIntent: {} }, { amountIn: "0" }, { observe: ["total-supply-delta"] }, { observe: ["trace"] }])
    assert.throws(() => buildDeclarativeExecutionSimulation({ ...declaration, ...extra } as any, input, values, execution, { math }));
  assert.throws(() => buildDeclarativeExecutionSimulation(declaration, { ...input, settlement: { kind: "direct-output", recipient: a(99) } }, values, execution, { math }));
});

test("raw native declarations use the existing central strict asset boundary", () => {
  const weth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const native: DeclarativeConversionExecution = { version: 2, settlement: { directOutput: false }, protectedAddresses: [TARGET, OUTPUT],
    steps: [{ id: "action", call: { target: TARGET, signature: "function convert(uint256) returns(uint256)", args: [ref("amountIn")], value: ref("amountIn"), save: { out: 0 } } }],
    effects: [{ kind: "debit", asset: "native", account: "$executor", equals: ref("amountIn") },
      { kind: "credit", token: OUTPUT, account: "$recipient", equals: ref("out") }] };
  const i = { ...input, route: { ...input.route, tokenIn: weth, executionAssets: { input: "native", output: "erc20" } } };
  const r = buildDeclarativeExecutionSimulation(declaration, i, values, native);
  assert.deepEqual(r.executionAssetBoundary, { tokenIn: weth, tokenOut: OUTPUT, amountIn: 17n, minimum: 1n, executionAssets: i.route.executionAssets });
  assert.equal(r.overrideIntent.nativeBalanceWei, undefined);
  assert.deepEqual(r.overrideIntent.tokenBalances, [{ token: weth, amount: 17n }]);
  assert.throws(() => buildDeclarativeExecutionSimulation(declaration, { ...i, route: { ...i.route, tokenIn: INPUT } }, values, native));
});

import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, getBytes, Interface, MaxUint256, toBeHex } from "ethers";
import { RequiredAdapterRequestError } from "../venues/adapter-request-failure.js";
import { synthesizeObservedCallTemplates, OBSERVED_CALL_MAX_AMOUNT, type ObservedCallSample } from "../venues/observed-call-template.js";
import { buildObservedCallRuntimeLeg, buildObservedCallSimulation, decodeObservedCallSimulationReceipt } from "../venues/observed-call-runtime.js";
import { assertRuntimeGuardRejects, inspectRuntime } from "./runtime-program-testkit.js";

// The host below is an independent VM fixture, not an EVM or mainnet witness.
// It executes emitted bytes and checks the actual conservation guards.
const a = (n: number) => toBeHex(n, 20);
const INPUT = a(1), OUTPUT = a(2), TARGET = a(3), EXECUTOR = a(4), OLD_ACTOR = a(5), EXTRA = a(6);
const ABI = new Interface([
  "function convertUnknown(address receiver,uint256 input,uint256 mode)",
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)",
]);
const source = { number: 101, hash: toBeHex(101, 32), generation: 2 };
function sample(payment: "approval" | "prepaid" = "approval"): ObservedCallSample {
  return { target: TARGET, calldata: ABI.encodeFunctionData("convertUnknown", [OLD_ACTOR, 17n, 7n]),
    sender: OLD_ACTOR, recipient: OLD_ACTOR, tokenIn: INPUT, tokenOut: OUTPUT, amountIn: "17", amountOut: "9999",
    source: { chainId: 1, number: 100, hash: toBeHex(100, 32), transactionHash: toBeHex(88, 32), traceAddress: [0] },
    payment: payment === "approval" ? { kind: "approval", spender: TARGET } : { kind: "prepaid" } };
}
function template(payment: "approval" | "prepaid" = "approval") {
  const result = synthesizeObservedCallTemplates(sample(payment));
  if (result.status !== "candidates") throw new Error(result.reason);
  assert.equal(result.templates.length, 1);
  return result.templates[0]!;
}
const input = () => ({ template: template(), executor: EXECUTOR, source, actionAdapterId: "fixture:observed", protectedTokens: [EXTRA] });
type Fault = "zero-debit" | "short-debit" | "excess-debit" | "empty-credit" | "old-output" | "old-native" | "old-extra" | "approval-refused" | "clear-refused";
function execute(payment: "approval" | "prepaid" = "approval", amount = 23n, fault?: Fault, minimumAmountOut = 1n,
  returnPolicy?: { outputWordOffset: number; data?: string }) {
  let balanceIn = 1000n, balanceOut = 200n, balanceExtra = 300n, native = 400n, allowance = 111n, prepaid = 0n, converted = false;
  const debit = fault === "zero-debit" ? 0n : fault === "short-debit" ? amount - 1n : fault === "excess-debit" ? amount + 1n : amount;
  const actualOutput = amount * 3n + 1n;
  const leg = buildObservedCallRuntimeLeg({ ...input(), template: template(payment), minimumAmountOut,
    ...(returnPolicy ? { outputWordOffset: returnPolicy.outputWordOffset } : {}) });
  const result = inspectRuntime(leg.program, amount, { nativeBalance: () => native, call(call) {
    const parsed = ABI.parseTransaction({ data: call.data });
    assert(parsed, "fixture received unknown calldata");
    if (parsed.name === "balanceOf") {
      assert(call.static); assert.equal(parsed.args[0].toLowerCase(), EXECUTOR);
      return toBeHex(call.target.toLowerCase() === INPUT ? balanceIn : call.target.toLowerCase() === OUTPUT ? balanceOut : balanceExtra, 32);
    }
    if (parsed.name === "allowance") {
      assert(call.static); assert.equal(parsed.args[0].toLowerCase(), EXECUTOR); assert.equal(parsed.args[1].toLowerCase(), TARGET);
      return toBeHex(allowance, 32);
    }
    if (parsed.name === "approve") {
      assert.equal(call.target.toLowerCase(), INPUT); assert.equal(parsed.args[0].toLowerCase(), TARGET);
      if (!(fault === "approval-refused" && parsed.args[1] > 0n) && !(fault === "clear-refused" && converted)) allowance = parsed.args[1];
      return toBeHex(1n, 32);
    }
    if (parsed.name === "transfer") {
      assert.equal(payment, "prepaid"); assert.equal(call.target.toLowerCase(), INPUT);
      assert.equal(parsed.args[0].toLowerCase(), TARGET); assert.equal(parsed.args[1], amount);
      balanceIn -= debit; prepaid += debit; return toBeHex(1n, 32);
    }
    assert.equal(parsed.name, "convertUnknown"); assert.equal(call.target.toLowerCase(), TARGET);
    assert.equal(parsed.args[0].toLowerCase(), EXECUTOR); assert.equal(parsed.args[1], amount); assert.equal(parsed.args[2], 7n);
    assert.equal(call.static, false); assert.equal(call.value, 0n); assert.equal(call.incoming, 0); assert.equal(call.outgoing, 0);
    if (payment === "approval") { assert.equal(allowance, amount); balanceIn -= debit; }
    else { assert.equal(prepaid, debit); prepaid = 0n; }
    converted = true;
    balanceOut += fault === "empty-credit" ? 0n : fault === "old-output" ? -1n : actualOutput;
    if (fault === "old-native") native--;
    if (fault === "old-extra") balanceExtra--;
    // Generic candidates ignore returndata. An owner may additionally require
    // its returned word to equal the independently observed fresh output.
    return returnPolicy ? returnPolicy.data ?? toBeHex(actualOutput, 32) : toBeHex(123456789n, 32);
  } }, { output: true });
  assert.equal(result.registers[0], actualOutput);
  assert.equal(balanceIn, 1000n - amount); assert.equal(balanceOut, 200n + actualOutput);
  assert.equal(balanceExtra, 300n); assert.equal(native, 400n);
  if (payment === "approval") assert.equal(allowance, 0n);
  return result;
}

test("unknown selector reuses VM with changed amount/actor, actual output and exact temporary approval", () => {
  execute(); execute("approval", 41n);
});
test("prepaid conversion is compiled with an actual preceding token transfer", () => { execute("prepaid"); });
for (const fault of ["zero-debit", "short-debit", "excess-debit", "old-native", "old-extra", "approval-refused", "clear-refused"] as const)
  test(`conversion VM rejects ${fault}`, () => assertRuntimeGuardRejects(() => execute("approval", 23n, fault), "equality"));
for (const fault of ["empty-credit", "old-output"] as const)
  test(`conversion VM rejects ${fault}`, () => assertRuntimeGuardRejects(() => execute("approval", 23n, fault), "uint256-range"));
test("actual output must satisfy a caller minimum independent of historical sample", () => {
  execute("approval", 23n, undefined, 70n);
  assertRuntimeGuardRejects(() => execute("approval", 23n, undefined, 71n), "uint256-range");
});
test("owner return-word equality is captured before approval cleanup overwrites returndata", () => {
  execute("approval", 23n, undefined, 1n, { outputWordOffset: 0 });
  execute("prepaid", 23n, undefined, 1n, { outputWordOffset: 32, data: toBeHex(91n, 32) + toBeHex(70n, 32).slice(2) });
  assertRuntimeGuardRejects(() => execute("approval", 23n, undefined, 1n,
    { outputWordOffset: 0, data: toBeHex(71n, 32) }), "equality");
});
test("owner return-word equality refuses absent, truncated and shifted return words", () => {
  for (const [outputWordOffset, data] of [[0, "0x"], [0, "0x01"], [32, toBeHex(70n, 32)]] as const)
    assert.throws(() => execute("approval", 23n, undefined, 1n, { outputWordOffset, data }), /word bounds/);
  for (const outputWordOffset of [-1, 1, 32.5, 65536, Number.MAX_SAFE_INTEGER])
    assert.throws(() => buildObservedCallRuntimeLeg({ ...input(), outputWordOffset }), /output word offset/);
});
test("runtime amount bounds are checked before any external call", () => {
  const leg = buildObservedCallRuntimeLeg(input());
  for (const amount of [0n, OBSERVED_CALL_MAX_AMOUNT + 1n])
    assertRuntimeGuardRejects(() => inspectRuntime(leg.program, amount, { call: () => { throw new Error("guard missing before call"); } }, { output: true }), "uint256-range");
});
test("probed amount envelope is enforced in the VM and quote builder", () => {
  const amountBounds = { minimum: 17n, maximum: 34n };
  const leg = buildObservedCallRuntimeLeg({ ...input(), amountBounds });
  for (const amount of [16n, 35n])
    assertRuntimeGuardRejects(() => inspectRuntime(leg.program, amount, { call: () => { throw new Error("guard missing before call"); } }, { output: true }), "uint256-range");
  for (const amountIn of [16n, 35n])
    assert.throws(() => buildObservedCallSimulation({ ...simulationInput(), amountIn, amountBounds }), /probed envelope/);
  for (const amountIn of [17n, 34n]) buildObservedCallSimulation({ ...simulationInput(), amountIn, amountBounds });
  for (const bounds of [{ minimum: 0n, maximum: 34n }, { minimum: 35n, maximum: 34n }, { minimum: 1n, maximum: OBSERVED_CALL_MAX_AMOUNT + 1n }])
    assert.throws(() => buildObservedCallRuntimeLeg({ ...input(), amountBounds: bounds }));
});
test("unsupported caller/source/minimum/protected scopes fail at compilation", () => {
  for (const executor of [TARGET, INPUT, OUTPUT]) assert.throws(() => buildObservedCallRuntimeLeg({ ...input(), executor }));
  assert.throws(() => buildObservedCallRuntimeLeg({ ...input(), source: { ...source, hash: "0x00" } }));
  for (const minimumAmountOut of [0n, -1n, MaxUint256 + 1n]) assert.throws(() => buildObservedCallRuntimeLeg({ ...input(), minimumAmountOut }));
  assert.throws(() => buildObservedCallRuntimeLeg({ ...input(), protectedTokens: Array.from({ length: 9 }, (_, i) => a(i + 10)) }));
  assert.throws(() => buildObservedCallRuntimeLeg({ ...input(), protectedTokens: [EXECUTOR] }));
});

const simulationInput = () => ({ template: template(), executor: EXECUTOR, source, amountIn: 23n, protectedTokens: [EXTRA], id: "candidate-proof" });
function result(): any {
  return { id: "candidate-proof", ok: true, source, completion: "returned", data: "0x",
    provenance: { kind: "fixture", fingerprint: "fixture-observation" }, effects: {
      tokenDeltas: [{ token: INPUT, account: EXECUTOR, delta: -23n }, { token: OUTPUT, account: EXECUTOR, delta: 70n }, { token: EXTRA, account: EXECUTOR, delta: 0n }],
      nativeDeltas: [{ account: EXECUTOR, delta: 0n }], logs: [] } };
}
function receiptInput() { const i = simulationInput(); return { ...i, request: buildObservedCallSimulation(i), result: result() }; }
test("canonical symbolic request contains current amount and same runtime program", () => {
  const i = simulationInput(), r = buildObservedCallSimulation(i);
  assert.deepEqual(r.call.caller, { kind: "executor" }); assert.equal(r.call.executionMode, "executor-program"); assert.equal(r.call.to, EXECUTOR);
  assert.equal(r.preCalls, undefined);
  assert.deepEqual(r.overrideIntent.tokenBalances, [{ token: INPUT, amount: 23n }]);
  const script = getBytes(AbiCoder.defaultAbiCoder().decode(["bytes"], `0x${r.call.data.slice(10)}`)[0]);
  assert.equal(script[0], 0x0e); assert.equal(BigInt(`0x${Buffer.from(script.slice(1, 33)).toString("hex")}`), 23n);
  assert.deepEqual(script.slice(36), getBytes(buildObservedCallRuntimeLeg(input()).program));
  assert.equal(decodeObservedCallSimulationReceipt(receiptInput()), 70n);
});
for (const [name, mutate] of Object.entries({
  wrongAmount: (x: any) => { x.amountIn = 24n; },
  missingOwnerReturnGuard: (x: any) => { x.outputWordOffset = 0; },
  wrongCalldata: (x: any) => { x.request = { ...x.request, call: { ...x.request.call, data: "0x12345678" } }; },
  funding: (x: any) => { x.request = { ...x.request, overrideIntent: { ...x.request.overrideIntent, tokenBalances: [{ token: INPUT, amount: 24n }] } }; },
  noDebit: (x: any) => { x.result.effects.tokenDeltas[0].delta = 0n; },
  oldOutput: (x: any) => { x.result.effects.tokenDeltas[1].delta = 0n; },
  thirdToken: (x: any) => { x.result.effects.tokenDeltas[2].delta = -1n; },
  native: (x: any) => { x.result.effects.nativeDeltas[0].delta = -1n; },
  recipient: (x: any) => { x.result.effects.tokenDeltas[1].account = OLD_ACTOR; },
  stale: (x: any) => { x.result.source = { ...source, hash: toBeHex(55, 32) }; },
  revert: (x: any) => { x.result.completion = "reverted-as-declared"; },
  returnedOutput: (x: any) => { x.result.data = toBeHex(70n, 32); },
  missingProtection: (x: any) => { x.request = { ...x.request, observeTokenBalances: x.request.observeTokenBalances.slice(0, 2) }; },
})) test(`independent receipt refuses ${name}`, () => { const i = receiptInput(); mutate(i); assert.throws(() => decodeObservedCallSimulationReceipt(i)); });
test("transport failure cannot count as protocol rejection or successful receipt", () => {
  const i = receiptInput(); i.result = { id: i.request.id, ok: false, source, failure: "rpc" };
  assert.throws(() => decodeObservedCallSimulationReceipt(i), RequiredAdapterRequestError);
});

import assert from "node:assert/strict";
import test from "node:test";
import { Interface, hexlify, toBeHex, getBytes, keccak256 } from "ethers";
import { buildDeclarativeExecutionProgram, buildDeclarativeRuntimeLeg, buildDeclarativeQuotedFragment, declarativeSettlementCapabilities, supportsDeclarativeSettlement,
  type DeclarativeConversionExecution } from "../venues/declarative-execution.js";
import { encodeDeclarativeCall } from "../venues/declarative-call-codec.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

const a = (n: number) => toBeHex(n, 20), INPUT = a(1), OUTPUT = a(2), TARGET = a(3), EXECUTOR = a(4), MID = a(5), LAST = a(6);
const ref = (runtime: string) => ({ runtime });
const values = { evaluate(value: any, env: Record<string, any>): any {
  if (typeof value === "string" && value.startsWith("$")) return value.slice(1).split(".").reduce((v, key) => v?.[key], env);
  if (Array.isArray(value)) return value.map(item => this.evaluate(item, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.evaluate(item, env)]));
  return value;
} };
const context = { route: { adapterId: "fixture", target: TARGET, tokenIn: INPUT, tokenOut: OUTPUT },
  executor: EXECUTOR, recipient: EXECUTOR, minAmountOut: 1n, amountIn: 11n, quotedAmountOut: 46n };
const debit = (token: string, amount: any) => ({ kind: "debit", token, account: "$executor", equals: amount });
const credit = (token: string, amount?: any) => ({ kind: "credit", token, account: "$recipient", ...(amount ? { equals: amount } : {}) });
const approval = (token: string, amount: any) => ({ token, spender: TARGET, mode: "exact-clear", amount, requireBool: true, verifyAllowance: true });
const single: DeclarativeConversionExecution = {
  version: 1, settlement: { directOutput: true }, protectedAddresses: [INPUT, OUTPUT, TARGET],
  call: { target: TARGET, signature: "function convert(uint256) returns(uint256)", args: [ref("amountIn")], save: { output: 0 } },
  effects: [debit(INPUT, ref("amountIn")), credit(OUTPUT, ref("output")), { kind: "unchanged-native" }],
};
const multiple: DeclarativeConversionExecution = {
  version: 2, settlement: { directOutput: true }, protectedAddresses: [INPUT, OUTPUT, TARGET],
  steps: [
    { id: "first", call: { target: TARGET, signature: "function first(uint256) returns(uint256)", args: [ref("amountIn")], save: { middle: 0 } },
      effects: [credit(MID, ref("middle"))] },
    { id: "second", approval: approval(MID, ref("middle")),
      call: { target: TARGET, signature: "function second(uint256) returns(uint256)", args: [ref("middle")], save: { last: 0 } },
      effects: [debit(MID, ref("middle")), credit(LAST, ref("last"))] },
    { id: "third", approval: approval(LAST, ref("last")),
      call: { target: TARGET, signature: "function third(uint256) returns(uint256)", args: [ref("last")], save: { output: 0 } },
      effects: [debit(LAST, ref("last"))] },
  ],
  effects: [debit(INPUT, ref("amountIn")), credit(OUTPUT, ref("output")),
    { kind: "unchanged-token", token: MID, account: "$executor" },
    { kind: "unchanged-token", token: LAST, account: "$executor" }, { kind: "unchanged-native" }],
};
type Fault = "zero" | "under" | "over" | "short" | "middle-over" | "return" | "status";
function execute(definition: DeclarativeConversionExecution, amount: bigint, fault?: Fault) {
  const balances = new Map([[INPUT, amount + 101n], [OUTPUT, 103n], [MID, 107n], [LAST, 109n]]);
  const allowances = new Map<string, bigint>(), called: string[] = [];
  const abi = new Interface(["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
    "function allowance(address,address) view returns(uint256)", "function convert(uint256) returns(uint256)",
    "function first(uint256) returns(uint256)", "function second(uint256) returns(uint256)", "function third(uint256) returns(uint256)"]);
  const get = (t: string) => balances.get(t.toLowerCase()) ?? 0n;
  const put = (t: string, v: bigint) => balances.set(t.toLowerCase(), v);
  const p = hexlify(buildDeclarativeExecutionProgram(definition, context, values).bytes());
  inspectRuntime(p, amount, { nativeBalance: () => 17n, call(call) {
    const parsed = abi.parseTransaction({ data: call.data })!;
    if (parsed.name === "balanceOf") { assert.equal(parsed.args[0].toLowerCase(), EXECUTOR); return toBeHex(get(call.target), 32); }
    if (parsed.name === "allowance") return toBeHex(allowances.get(call.target.toLowerCase()) ?? 0n, 32);
    if (parsed.name === "approve") { allowances.set(call.target.toLowerCase(), parsed.args[1]); return toBeHex(1n, 32); }
    const n = parsed.args[0] as bigint; called.push(parsed.name);
    assert.equal(call.static, false); assert.equal(call.value, 0n);
    let output: bigint;
    if (parsed.name === "convert" || parsed.name === "first") {
      assert.equal(n, amount);
      const spent = fault === "zero" ? 0n : fault === "under" ? amount - 1n : fault === "over" ? amount + 1n : amount;
      put(INPUT, get(INPUT) - spent); output = amount * 2n;
      const token = parsed.name === "first" ? MID : OUTPUT;
      put(token, get(token) + output - (fault === "short" ? 1n : 0n));
    } else if (parsed.name === "second") {
      assert.equal(n, amount * 2n); assert.equal(allowances.get(MID), n);
      put(MID, get(MID) - n - (fault === "middle-over" ? 1n : 0n)); output = n + 1n; put(LAST, get(LAST) + output);
    } else {
      assert.equal(parsed.name, "third"); assert.equal(n, amount * 2n + 1n); assert.equal(allowances.get(LAST), n);
      put(LAST, get(LAST) - n); output = n * 2n; put(OUTPUT, get(OUTPUT) + output - (fault === "short" ? 1n : 0n));
    }
    return fault === "return" ? "0x" : abi.encodeFunctionResult(parsed.name, [output]);
  } });
  assert.equal(get(INPUT), 101n); assert.equal(get(MID), 107n); assert.equal(get(LAST), 109n);
  assert.equal(get(OUTPUT), 103n + (definition.version === 1 ? amount * 2n : (amount * 2n + 1n) * 2n));
  for (const n of allowances.values()) assert.equal(n, 0n);
  return { p, called };
}
test("one-call compatibility and JSON-defined three-step execution retain actual input and intermediate inventory", () => {
  const old = execute(single, 19n);
  assert.deepEqual(old.called, ["convert"]);
  // Independently computed with ea06b7f's unmodified v1 compiler.
  assert.equal(keccak256(old.p), "0x910bf212d3bc1eef7d9571651092eeb470cb6b7125f20314943b1a42dcc31cfb");
  assert.deepEqual(execute(multiple, 19n).called, ["first", "second", "third"]);
  assert.deepEqual(execute(multiple, 31n).called, ["first", "second", "third"]);
  const runtime = buildDeclarativeRuntimeLeg(multiple, context, values)!;
  const quoted = buildDeclarativeQuotedFragment(multiple, context, values);
  assert.equal(runtime.program, quoted.nodes[0]!.params.runtimeAmountProgram);
});
for (const fault of ["zero", "under", "over", "short", "middle-over", "return"] as const)
  test(`multistep rejects ${fault} without substituting a quoted amount`, () => assert.throws(() => execute(multiple, 19n, fault)));

test("unknown result, repeated IDs/captures, unsupported callback and empty steps reject", () => {
  const clone = () => JSON.parse(JSON.stringify(multiple));
  for (const mutate of [
    (d: any) => { d.steps = []; },
    (d: any) => { d.steps[1].id = "first"; },
    (d: any) => { d.steps[1].call.save = { middle: 0 }; },
    (d: any) => { d.steps[0].call.args = [ref("last")]; },
    (d: any) => { d.steps[0].call.save = { effect0Before: 0 }; },
    (d: any) => { d.steps[0].call.callback = {}; },
    (d: any) => { d.steps[0].call.when = false; },
    (d: any) => { d.call = d.steps[0].call; },
    (d: any) => { d.steps[0].call.args = ["$amountIn"]; },
  ]) { const d = clone(); mutate(d); assert.throws(() => buildDeclarativeExecutionProgram(d, context, values)); }
  assert.equal(buildDeclarativeRuntimeLeg(multiple, { ...context, settlement: { kind: "deferred-input" } }, values), null);
  assert.throws(() => execute(multiple, 0n));
});

function patched(signature: string, args: any[], words: Record<string, bigint>) {
  const encoded = encodeDeclarativeCall(signature, args), data = getBytes(encoded.data);
  for (const patch of encoded.patches) data.set(getBytes(toBeHex(words[patch.reference]!, 32)), patch.offset);
  const abi = new Interface([signature]); return { parsed: abi.parseTransaction({ data: hexlify(data) })!, encoded };
}
test("runtime scalar leaves use canonical nested tuple/array tail offsets", () => {
  const signature = "function complex(bytes leading,(address recipient,uint256[] amounts)[] items,uint256[2] fixedValues,string trailing)";
  const args = ["0x112233", [{ recipient: EXECUTOR, amounts: [ref("amountIn"), 7n] },
    { recipient: TARGET, amounts: [11n, ref("returned")] }], [ref("amountIn"), 13n], "end"];
  const { parsed, encoded } = patched(signature, args, { amountIn: 19n, returned: 23n });
  assert.deepEqual(Array.from(parsed.args[1][0].amounts), [19n, 7n]);
  assert.deepEqual(Array.from(parsed.args[1][1].amounts), [11n, 23n]);
  assert.deepEqual(Array.from(parsed.args[2]), [19n, 13n]);
  assert.equal(parsed.args[0], "0x112233"); assert.equal(parsed.args[3], "end");
  assert.equal(encoded.patches.length, 3);
  assert.throws(() => encodeDeclarativeCall("function bad(bytes)", [ref("blob")]));
  assert.throws(() => encodeDeclarativeCall("function bad(uint256[])", [ref("array")]));
  assert.throws(() => encodeDeclarativeCall("function bad(uint256[2])", [[ref("amountIn")]]));
});

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
function nativeRun(inputNative: boolean, spend: bigint, budget = false) {
  const amount = 19n;
  const route = { ...context.route, tokenIn: inputNative ? WETH : INPUT, tokenOut: inputNative ? OUTPUT : WETH,
    executionAssets: { input: inputNative ? "native" : "erc20", output: inputNative ? "erc20" : "native" } };
  const d: DeclarativeConversionExecution = { version: 2, settlement: { directOutput: true }, protectedAddresses: [INPUT, OUTPUT, TARGET],
    steps: [{ id: "raw", call: { target: TARGET, signature: "function raw(uint256) returns(uint256)", args: [ref("amountIn")],
      ...(inputNative ? { value: ref("amountIn") } : {}), save: { output: 0 } } }],
    effects: [
      { kind: "debit", account: "$executor", ...(inputNative ? { asset: "native" } : { token: INPUT }),
        ...(budget ? { maximum: ref("amountIn") } : { equals: ref("amountIn") }) },
      { kind: "credit", account: "$recipient", ...(inputNative ? { token: OUTPUT } : { asset: "native" }), equals: ref("output") },
    ] };
  let native = inputNative ? 101n + amount : 101n, tokenIn = 103n + amount, tokenOut = 107n;
  const p = buildDeclarativeExecutionProgram(d, { ...context, route }, values);
  assert.equal(declarativeSettlementCapabilities(d, { ...context, route }).directOutput, inputNative ? true : undefined);
  assert.equal(supportsDeclarativeSettlement(d, { ...context, route,
    settlement: { kind: "direct-output", recipient: a(77) } }), inputNative);
  assert.equal(buildDeclarativeRuntimeLeg(d, { ...context, route }, values)?.inputMode, budget ? "maximum" : undefined);
  const abi = new Interface(["function balanceOf(address) view returns(uint256)", "function raw(uint256) returns(uint256)"]);
  inspectRuntime(hexlify(p.bytes()), amount, { nativeBalance: () => native, call(call) {
    const parsed = abi.parseTransaction({ data: call.data })!;
    if (parsed.name === "balanceOf") return toBeHex(call.target.toLowerCase() === INPUT ? tokenIn : tokenOut, 32);
    assert.equal(call.value, inputNative ? amount : 0n);
    if (inputNative) { native -= spend; tokenOut += 38n; } else { tokenIn -= spend; native += 38n; }
    return abi.encodeFunctionResult("raw", [38n]);
  } });
  assert.equal(inputNative ? native : tokenIn, (inputNative ? 101n : 103n) + amount - spend);
  if (!inputNative) assert.throws(() => buildDeclarativeExecutionProgram(d, { ...context, route, recipient: a(77) }, values));
}
test("raw native boundaries and explicit input budgets retain positive debit and old inventory", () => {
  nativeRun(true, 19n); nativeRun(false, 19n); nativeRun(true, 17n, true); nativeRun(false, 17n, true);
  for (const inputNative of [true, false]) {
    assert.throws(() => nativeRun(inputNative, 0n, true));
    assert.throws(() => nativeRun(inputNative, 20n, true));
    assert.throws(() => nativeRun(inputNative, 18n));
  }
});

test("token-only v2 routes automatically protect old native balance", () => {
  const d: DeclarativeConversionExecution = { ...single, version: 2, call: undefined, steps: [{ id: "one", call: { ...single.call, value: 1 } }],
    effects: single.effects.filter(effect => effect.kind !== "unchanged-native") } as any;
  delete (d as any).call;
  const p = buildDeclarativeExecutionProgram(d, context, values);
  let native = 101n, input = 120n, output = 103n;
  const abi = new Interface(["function balanceOf(address) view returns(uint256)", "function convert(uint256) returns(uint256)"]);
  assert.throws(() => inspectRuntime(hexlify(p.bytes()), 19n, { nativeBalance: () => native, call(call) {
    const parsed = abi.parseTransaction({ data: call.data })!;
    if (parsed.name === "balanceOf") return toBeHex(call.target.toLowerCase() === INPUT ? input : output, 32);
    native -= call.value; input -= parsed.args[0]; output += 38n; return toBeHex(38n, 32);
  } }));
});

test("runtime ABI leaf references reject narrow and aligned scalar encodings", () => {
  for (const type of ["bytes4", "uint8", "int256", "address", "bool"]) {
    assert.throws(() => encodeDeclarativeCall(`function narrow(${type})`, [{ runtime: "value" }]), /uint256 or bytes32/);
  }
  assert.equal(encodeDeclarativeCall("function full(bytes32,uint256)", [{ runtime: "word" }, { runtime: "amount" }]).patches.length, 2);
});

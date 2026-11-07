import assert from "node:assert/strict";
import test from "node:test";
import { Interface, MaxUint256, hexlify, toBeHex } from "ethers";
import { buildDeclarativeExecutionProgram, buildDeclarativeQuotedFragment, buildDeclarativeRuntimeLeg,
  type DeclarativeConversionExecution } from "../venues/declarative-execution.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { encodeDeclarativeCall } from "../venues/declarative-call-codec.js";
import { inspectRuntime, assertRuntimeGuardRejects, type RuntimeProgramGuardCode } from "./runtime-program-testkit.js";

// Synthetic receipt hosts exercise the production compiler and independent VM
// interpreter. These are framework safety facts, not historical EVM acceptance.
const a = (n: number) => toBeHex(n, 20);
const INPUT = a(1), OUTPUT = a(2), SIDE = a(3), TARGET = a(4), EXECUTOR = a(5), RECEIVER = a(6);
const ref = (runtime: string) => ({ runtime });
const op = (op: string, ...args: unknown[]) => ({ op, args });
const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
const context = (external = false) => ({ route: { adapterId: "synthetic-basket", target: TARGET, tokenIn: INPUT, tokenOut: OUTPUT },
  executor: EXECUTOR, descriptor: { components: [
    { token: OUTPUT, minimum: "1", role: "route-output", account: external ? RECEIVER : EXECUTOR },
    { token: SIDE, minimum: "7", role: "side-output", account: EXECUTOR },
  ], actions: [{ id: "redeem", target: TARGET }] }, amountIn: 77n, quotedAmountOut: 154n, minAmountOut: 1n,
  ...(external ? { settlement: { kind: "direct-output", recipient: RECEIVER } } : {}) });

function definition(): DeclarativeConversionExecution {
  return { version: 2, settlement: { directOutput: true }, protectedAddresses: [TARGET, INPUT, OUTPUT, SIDE],
    steps: [op("map", "$descriptor.actions", "action", { id: "$action.id", call: {
      target: "$action.target", signature: "function redeem(uint112,address)", args: [ref("amountIn"), "$recipient"],
    } })],
    effects: [op("concat", [{ kind: "debit", token: INPUT, account: "$executor", equals: ref("amountIn") }],
      op("map", "$descriptor.components", "component", { kind: "credit", token: "$component.token",
        account: "$component.account", role: "$component.role", minimum: op("uint", "$component.minimum") }))],
  };
}
type Fault = "zero-debit" | "under-debit" | "over-debit" | "route-short" | "side-short" | "side-zero" | "side-inventory" | "wrong-recipient" | "native";
function run(program: string, amount = 77n, external = false, fault?: Fault) {
  const recipient = external ? RECEIVER : EXECUTOR, balances = new Map<string, bigint>();
  const key = (token: string, account: string) => token.toLowerCase() + ":" + account.toLowerCase();
  const balance = (token: string, account: string) => balances.get(key(token, account)) ?? 0n;
  for (const account of [EXECUTOR, RECEIVER]) {
    balances.set(key(INPUT, account), amount + 101n);
    balances.set(key(OUTPUT, account), 103n);
    balances.set(key(SIDE, account), 107n);
  }
  const abi = new Interface(["function balanceOf(address) view returns(uint256)", "function redeem(uint112,address)"]);
  let calls = 0, native = 11n;
  inspectRuntime(program, amount, { nativeBalance: () => native, call(call) {
    const parsed = abi.parseTransaction({ data: call.data })!;
    if (parsed.name === "balanceOf") return toBeHex(balance(call.target, parsed.args[0]), 32);
    assert.equal(parsed.name, "redeem"); assert.equal(parsed.args[0], amount); assert.equal(parsed.args[1].toLowerCase(), recipient);
    assert.equal(call.static, false); calls++;
    const debit = fault === "zero-debit" ? 0n : amount + (fault === "over-debit" ? 1n : fault === "under-debit" ? -1n : 0n);
    balances.set(key(INPUT, EXECUTOR), balance(INPUT, EXECUTOR) - debit);
    const paidTo = fault === "wrong-recipient" ? TARGET : recipient;
    balances.set(key(OUTPUT, paidTo), balance(OUTPUT, paidTo) + (fault === "route-short" ? 0n : amount * 2n));
    balances.set(key(SIDE, EXECUTOR), balance(SIDE, EXECUTOR) + (fault === "side-short" ? 6n : fault === "side-zero" ? 0n : 7n));
    if (fault === "side-inventory") balances.set(key(SIDE, RECEIVER), balance(SIDE, RECEIVER) - 7n);
    if (fault === "native") native--;
    return "0x";
  } });
  assert.equal(calls, 1);
  assert.equal(balance(INPUT, EXECUTOR), 101n);
  assert.equal(balance(OUTPUT, recipient), 103n + amount * 2n);
  assert.equal(balance(SIDE, EXECUTOR), 114n);
}

for (const external of [false, true]) test(`declared collection protects every fresh receipt; external=${external}`, () => {
  const input = context(external), d = definition();
  const leg = buildDeclarativeRuntimeLeg(d, input, values)!;
  const fragment = buildDeclarativeQuotedFragment(d, input, values);
  assert.equal(fragment.nodes[0]!.params.runtimeAmountProgram, leg.program);
  run(leg.program, 77n, external); run(leg.program, 91n, external);
  // Only the designated route output uses the route's minimum; the side asset
  // retains its own seven-unit threshold and never becomes next-hop output.
  run(hexlify(buildDeclarativeExecutionProgram(d, { ...input, minAmountOut: 100n }, values).bytes()), 77n, external);
});
const rejectionCodes: Record<Fault, RuntimeProgramGuardCode> = {
  "zero-debit": "uint256-range", "under-debit": "equality", "over-debit": "equality",
  "route-short": "uint256-range", "side-short": "uint256-range", "side-zero": "uint256-range",
  "side-inventory": "equality", "wrong-recipient": "uint256-range", native: "equality",
};
for (const fault of Object.keys(rejectionCodes) as Fault[])
  test(`multiple outputs reject ${fault}`, () => {
    const program = buildDeclarativeRuntimeLeg(definition(), context(true), values)!.program;
    assertRuntimeGuardRejects(() => run(program, 77n, true, fault), rejectionCodes[fault]);
  });
test("multi-output declarations reject ambiguous routes, duplicate assets and omitted side bounds", () => {
  for (const mutate of [
    (i: any) => { i.descriptor.components[1].role = "route-output"; },
    (i: any) => { i.descriptor.components[0].role = "side-output"; },
    (i: any) => { i.descriptor.components[1].token = OUTPUT; },
    (i: any) => { i.descriptor.components[1].token = INPUT; },
    (i: any) => { i.descriptor.components[1].account = TARGET; },
  ]) {
    const input = context(); mutate(input);
    assert.throws(() => buildDeclarativeRuntimeLeg(definition(), input, values));
  }
  const d: any = definition();
  d.effects = values.evaluate(d.effects, { ...context(), recipient: EXECUTOR }).flat();
  delete d.effects[2].minimum;
  assert.throws(() => buildDeclarativeRuntimeLeg(d, context(), values), /side receipt bounds/);
});
test("bounded expansion keeps VM limits and rejects unsupported native basket settlement", () => {
  const input = context();
  input.descriptor.actions = Array.from({ length: 65 }, (_, i) => ({ id: "call" + i, target: TARGET }));
  assert.throws(() => buildDeclarativeRuntimeLeg(definition(), input, values), /bounded list|budget/);
  const d: any = definition(); d.effects = Array.from({ length: 65 }, () => ({ kind: "unchanged-native" }));
  assert.throws(() => buildDeclarativeRuntimeLeg(d, context(), values), /bounded array/);
  const many: any = context(); many.descriptor.components = Array.from({ length: 20 }, (_, i) => ({
    token: i === 0 ? OUTPUT : a(100 + i), minimum: "1", role: i === 0 ? "route-output" : "side-output", account: EXECUTOR,
  }));
  assert.throws(() => buildDeclarativeRuntimeLeg(definition(), many, values), /register budget|instruction limit/);
  const native: any = context(); native.route.executionAssets = { input: "erc20", output: "native" };
  assert.throws(() => buildDeclarativeRuntimeLeg(definition(), native, values));
});

function integerProgram(type: string, named = false) {
  const d: DeclarativeConversionExecution = { version: 2, settlement: { directOutput: false }, protectedAddresses: [INPUT, OUTPUT, TARGET],
    ...(named ? { preflight: [{ target: TARGET, signature: "function word() view returns(uint256)", args: [], save: { signedWord: 0 } }] } : {}),
    steps: [{ id: "convert", call: { target: TARGET, signature: `function convert(${type})`, args: [ref(named ? "signedWord" : "amountIn")] } }],
    effects: [{ kind: "debit", token: INPUT, account: "$executor", equals: ref("amountIn") },
      { kind: "credit", token: OUTPUT, account: "$recipient" }],
  };
  return buildDeclarativeRuntimeLeg(d, context(), values)!.program;
}
function integerRun(program: string, type: string, amount: bigint, expectedWord = amount, namedWord?: bigint, rejectedCall?: { calls: number }) {
  const abi = new Interface(["function balanceOf(address) view returns(uint256)", "function word() view returns(uint256)", `function convert(${type})`]);
  let input = amount + 1n, output = 1n, calls = 0;
  inspectRuntime(program, amount, { nativeBalance: () => 0n, call(call) {
    if (!call.static && rejectedCall) rejectedCall.calls++;
    const parsed = abi.parseTransaction({ data: call.data })!;
    if (parsed.name === "balanceOf") return toBeHex(call.target.toLowerCase() === INPUT ? input : output, 32);
    if (parsed.name === "word") return toBeHex(namedWord!, 32);
    assert.equal(parsed.name, "convert"); assert.equal(parsed.args[0], expectedWord);
    input -= amount; output++; calls++; return "0x";
  } });
  assert.equal(calls, 1);
}
for (const bits of [8, 112, 128, 248]) test(`uint${bits} runtime leaf checks its full value before CALL`, () => {
  const program = integerProgram(`uint${bits}`), max = (1n << BigInt(bits)) - 1n;
  integerRun(program, `uint${bits}`, max);
  const rejected = { calls: 0 };
  assert.throws(() => integerRun(program, `uint${bits}`, max + 1n, max + 1n, undefined, rejected));
  assert.equal(rejected.calls, 0, "width guard must reject before state-changing CALL");
});
for (const bits of [8, 112, 128, 248]) test(`int${bits} runtime leaf requires canonical sign extension`, () => {
  const program = integerProgram(`int${bits}`, true), max = (1n << BigInt(bits - 1)) - 1n, min = -max - 1n;
  for (const signed of [0n, 1n, max, -1n, min])
    integerRun(program, `int${bits}`, 7n, signed, BigInt.asUintN(256, signed));
  for (const invalid of [max + 1n, BigInt.asUintN(256, min - 1n), (1n << BigInt(bits)) - 1n]) {
    const rejected = { calls: 0 };
    assert.throws(() => integerRun(program, `int${bits}`, 7n, 0n, invalid, rejected));
    assert.equal(rejected.calls, 0, "sign guard must reject before state-changing CALL");
  }
  const rejected = { calls: 0 };
  assert.throws(() => integerRun(integerProgram(`int${bits}`), `int${bits}`, max + 1n, max + 1n, undefined, rejected));
  assert.equal(rejected.calls, 0, "input cannot become a signed negative request");
});
test("checked ABI mode carries tuple widths while unchecked consumers remain fail closed", () => {
  const sig = "function nested((address,uint112)[],int128)";
  const args = [[[TARGET, ref("amountIn")]], ref("signedWord")];
  assert.throws(() => encodeDeclarativeCall(sig, args));
  const { patches } = encodeDeclarativeCall(sig, args, { checkedIntegers: true });
  assert.deepEqual(patches.map(p => [p.reference, p.bits, p.signed === true]), [["amountIn", 112, false], ["signedWord", 128, true]]);
  for (const type of ["bytes4", "address", "bool", "bytes", "uint7", "int264"])
    assert.throws(() => encodeDeclarativeCall(`function invalid(${type})`, [ref("amountIn")], { checkedIntegers: true }));
  // Existing words retain exactly the old data and patch metadata.
  assert.deepEqual(encodeDeclarativeCall("function old(uint256,int256,bytes32)", [ref("amountIn"), ref("signedWord"), toBeHex(MaxUint256, 32)]),
    encodeDeclarativeCall("function old(uint256,int256,bytes32)", [ref("amountIn"), ref("signedWord"), toBeHex(MaxUint256, 32)], { checkedIntegers: true }));
});

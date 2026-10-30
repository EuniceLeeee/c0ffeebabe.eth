import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, getBytes, hexlify, toBeHex } from "ethers";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { encodeDeclarativeCall } from "../venues/declarative-call-codec.js";
import { buildDeclarativeExecutionProgram, buildDeclarativeRuntimeLeg, declarativeSettlementCapabilities,
  supportsDeclarativeSettlement, type DeclarativeConversionExecution } from "../venues/declarative-execution.js";
import { createDeclarativeRuntimeMathRegistry, type RuntimeMathModel } from "../venues/declarative-runtime-math.js";
import { validateDeclarativeCallbackFrame } from "../venues/declarative-callback-frames.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";
const address = (n: number) => toBeHex(n, 20), INPUT = address(1), OUTPUT = address(2), POOL = address(3), EXECUTOR = address(4), RECIPIENT = address(5), INNER = address(6);
const ref = (runtime: string) => ({ runtime });
const tokenAbi = new Interface(["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)"]);
const outerSignature = "function swap(address recipient,bool direction,int256 amount,bytes data) returns(int256,int256)";
const callbackSignature = "function pay(int256 delta0,int256 delta1,bytes data)";
const outerAbi = new Interface([outerSignature]), callbackAbi = new Interface([callbackSignature]);
const values = { evaluate(value: any, env: Record<string, any>): any {
  if (typeof value === "string" && value.startsWith("$")) return value.slice(1).split(".").reduce((v, key) => v?.[key], env);
  if (Array.isArray(value)) return value.map(item => this.evaluate(item, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.evaluate(item, env)]));
  return value;
} };
const context = { route: { adapterId: "fixture", target: POOL, tokenIn: INPUT, tokenOut: OUTPUT }, executor: EXECUTOR,
  amountIn: 99n, quotedAmountOut: 99n, minAmountOut: 1n };
function definition(reverse = false): DeclarativeConversionExecution {
  return { version: 2, settlement: { directOutput: true }, protectedAddresses: [INPUT, OUTPUT, POOL],
    steps: [{ id: "swap", frame: { call: { target: POOL, signature: outerSignature, args: ["$recipient", !reverse, ref("amountIn")], dataArgument: 3 },
      callback: { signature: callbackSignature, dataArgument: 2, captures: { cap: ref("amountIn") }, arguments: [
        { index: reverse ? 1 : 0, name: "debt", encoding: "positive", maximum: ref("cap") },
        { index: reverse ? 0 : 1, name: "output", encoding: "negative", minimum: 1n },
      ], steps: [{ id: "pay", call: { target: INPUT, signature: "function transfer(address,uint256) returns(bool)", args: [POOL, ref("debt")],
        save: { paid: 0 }, checks: [{ left: ref("paid"), operator: "eq", right: 1n }] } }] } } }],
    effects: [{ kind: "debit", token: INPUT, account: "$executor", maximum: ref("amountIn") },
      { kind: "credit", token: OUTPUT, account: "$recipient", minimum: "$minAmountOut" }] };
}
function body(payload: string): string {
  const bytes = getBytes(payload); assert.equal(bytes[0], 0x0e);
  const size = Number(BigInt(hexlify(bytes.slice(33, 36)))); return hexlify(bytes.slice(36, 36 + size));
}
function execute(options: { reverse?: boolean; debt?: bigint; fault?: string; definition?: DeclarativeConversionExecution; direct?: boolean } = {}) {
  const cap = 19n, debt = options.debt ?? cap, out = 38n;
  let inputBalance = 101n + cap, outputBalance = 103n, actorOutput = 107n, poolBalance = 13n, native = 17n, payCalls = 0;
  const d = options.definition ?? definition(options.reverse), input = { ...context,
    ...(options.direct ? { settlement: { kind: "direct-output" as const, recipient: RECIPIENT } } : {}) };
  const leg = buildDeclarativeRuntimeLeg(d, input, values)!; assert.equal(leg.inputMode, "maximum");
  function token(call: RuntimeCall): string {
    const decoded = tokenAbi.parseTransaction({ data: call.data })!;
    if (decoded.name === "balanceOf") {
      const holder = decoded.args[0].toLowerCase();
      return toBeHex(call.target.toLowerCase() === INPUT ? holder === POOL ? poolBalance : inputBalance
        : options.direct && holder === EXECUTOR ? actorOutput : outputBalance, 32);
    }
    assert.equal(call.target.toLowerCase(), INPUT); assert.equal(decoded.args[0].toLowerCase(), POOL); payCalls++;
    inputBalance -= options.fault === "zero-debit" ? 0n : decoded.args[1]; poolBalance += decoded.args[1];
    return toBeHex(options.fault === "false-transfer" ? 0n : 1n, 32);
  }
  try {
    inspectRuntime(leg.program, cap, { nativeBalance: () => native, call(call) {
      if ([INPUT, OUTPUT].includes(call.target.toLowerCase())) return token(call);
      assert.equal(call.target.toLowerCase(), POOL);
      const parsed = outerAbi.parseTransaction({ data: call.data })!;
      assert.equal(parsed.args[0].toLowerCase(), options.direct ? RECIPIENT : EXECUTOR); assert.equal(parsed.args[2], cap);
      const payload = parsed.args[3]; assert.equal(BigInt(hexlify(getBytes(payload).slice(1, 33))), cap);
      assert.equal(call.outgoing, 164); assert.equal(call.incoming, 132);
      outputBalance += options.fault === "no-output" ? 0n : out;
      const signedOut = options.fault === "wrong-sign" ? out : -out;
      const incomingDebt = options.fault === "negative-debt" ? -debt : options.fault === "high-debt" ? cap + 1n : debt;
      let data = callbackAbi.encodeFunctionData("pay", options.reverse ? [signedOut, incomingDebt, payload] : [incomingDebt, signedOut, payload]);
      if (options.fault === "selector") data = `0x11223344${data.slice(10)}`;
      inspectRuntime(body(payload), cap, { calldata: data, call: token, nativeBalance: () => native });
      if (options.fault === "old-input") inputBalance--;
      if (options.fault === "native") native--;
      return outerAbi.encodeFunctionResult("swap", options.reverse ? [-out, debt] : [debt, -out]);
    } });
  } catch (error) {
    if (["negative-debt", "high-debt", "wrong-sign", "selector"].includes(options.fault ?? "") || debt === 0n)
      assert.equal(payCalls, 0, "invalid callback cannot issue payment");
    throw error;
  }
  assert.equal(inputBalance, 101n + cap - debt); assert.equal(outputBalance, 103n + out);
  assert.equal(actorOutput, 107n); assert.equal(poolBalance, 13n + debt); assert.equal(native, 17n);
}
for (const reverse of [false, true]) for (const debt of [19n, 7n])
  test(`signed callback ${reverse ? "reverse" : "forward"}, debt ${debt} remains inside actual input`, () => execute({ reverse, debt }));
test("signed callback keeps direct recipient and actor inventory separate", () => execute({ direct: true }));
for (const fault of ["negative-debt", "high-debt", "wrong-sign", "selector", "zero-debit", "no-output", "old-input", "native", "false-transfer"])
  test(`callback frame rejects ${fault}`, () => assert.throws(() => execute({ fault })));
test("callback frame rejects zero debt before payment", () => assert.throws(() => execute({ debt: 0n })));

test("input-first callback binds token address and unsigned amount", () => {
  const d: any = definition(); d.steps[0].frame.callback.signature = "function pay(address token,uint256 amount,bytes data)";
  d.steps[0].frame.callback.arguments = [{ index: 0, name: "token", encoding: "word", equals: INPUT },
    { index: 1, name: "debt", encoding: "word", minimum: 1n, maximum: ref("cap") }];
  const program = buildDeclarativeExecutionProgram(d, context, values); let paid = 0n, received = 0n;
  inspectRuntime(hexlify(program.bytes()), 19n, { nativeBalance: () => 0n, call(call) {
    if ([INPUT, OUTPUT].includes(call.target.toLowerCase())) return toBeHex(call.target.toLowerCase() === INPUT ? 100n - paid : received, 32);
    const args = outerAbi.parseTransaction({ data: call.data })!.args, cbAbi = new Interface([d.steps[0].frame.callback.signature]);
    const invoke = (token: string) => inspectRuntime(body(args[3]), 19n, { calldata: cbAbi.encodeFunctionData("pay", [token, 19n, args[3]]),
      call(inner) { const action = tokenAbi.parseTransaction({ data: inner.data })!; paid += action.args[1]; return toBeHex(1n, 32); } });
    assert.throws(() => invoke(OUTPUT)); assert.equal(paid, 0n); invoke(INPUT); received += 38n;
    return outerAbi.encodeFunctionResult("swap", [19n, -38n]);
  } });
  assert.equal(paid, 19n); assert.equal(received, 38n);
});

test("nested unlock frames use declared steps, native calls, captures and static bytes return", () => {
  const unlock = "function unlock(bytes data)", unlocked = "function unlocked(bytes data) returns(bytes)";
  const frame: any = { call: { target: POOL, signature: unlock, args: [], dataArgument: 0 },
    callback: { signature: unlocked, dataArgument: 0, arguments: [], captures: { outerCap: ref("amountIn") }, returns: { types: ["bytes"], values: ["0x"] },
      steps: [{ id: "inner", frame: { call: { target: INNER, signature: unlock, args: [], dataArgument: 0 },
        callback: { signature: unlocked, dataArgument: 0, arguments: [], captures: { innerCap: ref("outerCap") }, returns: { types: ["bytes"], values: ["0x"] },
          steps: [{ id: "settle", call: { target: INNER, signature: "function settle() payable returns(uint256)", args: [], value: ref("innerCap"),
            save: { settled: 0 }, checks: [{ left: ref("settled"), operator: "eq", right: ref("innerCap") }] } }] } } }] } };
  const d: any = { version: 2, settlement: { directOutput: false }, protectedAddresses: [POOL, INNER], steps: [{ id: "unlock", frame }],
    effects: [{ kind: "debit", asset: "native", account: "$executor", equals: ref("amountIn") }, { kind: "credit", token: OUTPUT, account: "$executor", minimum: 1n }] };
  const input = { ...context, route: { ...context.route, tokenIn: ADDR.WETH, executionAssets: { input: "native", output: "erc20" } } };
  const program = buildDeclarativeExecutionProgram(d, input, values), unlockAbi = new Interface([unlock]), cbAbi = new Interface([unlocked]);
  let native = 119n, output = 101n, frames = 0, settled = 0;
  const run = (program: string, data?: string) => inspectRuntime(program, 19n, { calldata: data, nativeBalance: () => native, call(call): string {
    if (call.target.toLowerCase() === OUTPUT) return toBeHex(output, 32);
    if (call.data.startsWith(new Interface(["function settle() payable returns(uint256)"]).getFunction("settle")!.selector)) {
      assert.equal(call.value, 19n); native -= call.value; output += 38n; settled++; return toBeHex(19n, 32);
    }
    frames++; assert.equal(call.incoming, 68); assert.equal(call.outgoing, 68);
    const payload = unlockAbi.parseTransaction({ data: call.data })!.args[0]; run(body(payload), cbAbi.encodeFunctionData("unlocked", [payload]));
    const bytes = getBytes(payload), size = Number(BigInt(hexlify(bytes.slice(33, 36))));
    assert.equal(bytes[36 + size], 0x03, "static callback return is outside the amount VM"); return AbiCoder.defaultAbiCoder().encode(["bytes"], ["0x"]);
  } });
  run(hexlify(program.bytes())); assert.equal(frames, 2); assert.equal(settled, 1); assert.equal(native, 100n); assert.equal(output, 139n);
});

test("callback existence grants no deferred settlement capability", () => {
  const d = definition(); assert.deepEqual(declarativeSettlementCapabilities(d, context), { directOutput: true });
  const input = { ...context, settlement: { kind: "deferred-input", paymentAmount: 1n, paymentProgram: "0x01" } };
  assert.equal(supportsDeclarativeSettlement(d, input), false); assert.equal(buildDeclarativeRuntimeLeg(d, input, values), null);
});
for (const [label, change] of [
  ["unknown operation", (f: any) => { f.callback.steps[0].script = "0x01"; }],
  ["missing argument", (f: any) => { f.callback.arguments.pop(); }],
  ["unsigned signed debt", (f: any) => { f.callback.arguments[0].encoding = "word"; }],
  ["duplicate argument", (f: any) => { f.callback.arguments[1].index = 0; }],
  ["shadow actual input", (f: any) => { f.callback.captures.amountIn = 1n; }],
  ["ambient parent capture", (f: any) => { delete f.callback.captures.cap; }],
  ["wrong bytes slot", (f: any) => { f.call.dataArgument = 0; }],
  ["dynamic callback field", (f: any) => { f.callback.signature = "function pay(int256,bytes[],bytes)"; }],
  ["internal selector capture", (f: any) => { f.callback.arguments[0].name = "frameSelector"; }],
  ["unknown return capture", (f: any) => { f.callback.steps[0].call.save.paid = 1; }],
  ["dynamic return", (f: any) => { f.callback.returns = { types: ["uint256"], values: [ref("debt")] }; }],
] as const) test(`callback schema rejects ${label}`, () => { const d: any = definition(); change(d.steps[0].frame); assert.throws(() => validateDeclarativeCallbackFrame(d.steps[0].frame)); });
test("callback frame cannot be mixed with a normal call", () => {
  const d: any = definition(); d.steps[0].call = { target: POOL, signature: "function x()", args: [] }; assert.throws(() => buildDeclarativeExecutionProgram(d, context, values));
});

const prefixAbi = new Interface(["function continueRoute(uint256) returns(uint256)"]);
function deferredExecution(options: { debtInput?: boolean; recipient?: "target" | "executor"; fault?: string; configure?: (definition: any) => void; runtimeWitness?: boolean } = {}) {
  const d: any = definition(), cap = 19n, debt = options.debtInput ? 7n : cap, output = 38n, paymentAmount = 11n;
  d.framedSettlement = { version: 1, recipient: options.recipient ?? "target", debtInput: true, expectedOutput: 38n };
  d.steps[0].frame.callback.steps[0].when = options.recipient === "executor" ? true : "$fundedSettlement";
  d.steps[0].frame.callback.steps.unshift({ id: "continue", continuation: { debt: ref("debt"), output: ref("output") } });
  if (options.runtimeWitness) {
    d.framedSettlement.expectedOutput = ref("parentOutput");
    d.steps.unshift({ id: "observe", static: true, call: { target: INNER, signature: "function observe(uint256) view returns(uint256)",
      args: [ref("amountIn")], save: { parentOutput: 0 } } });
  }
  options.configure?.(d);
  const recipient = options.recipient === "executor" ? EXECUTOR : POOL;
  const paymentProgram = new RuntimeAmountProgram().call(INNER, prefixAbi.encodeFunctionData("continueRoute", [0n]),
    { patches: [{ offset: 4, reg: 0 }] }).load(0, 0);
  const input = { ...context, settlement: { kind: "deferred-input" as const, paymentAmount,
    paymentProgram: hexlify(paymentProgram.bytes()), ...(options.debtInput ? { paymentInput: "debt" as const } : {}) } };
  const leg = buildDeclarativeRuntimeLeg(d, input, values)!;
  assert.equal(leg.settlement.deferredInput?.toLowerCase(), recipient); assert.equal(leg.settlement.deferredDebtInput, true);
  let inputBalance = 101n, outputBalance = 103n, poolBalance = 107n, native = 17n, continuations = 0;
  const token = (call: RuntimeCall) => {
    const parsed = tokenAbi.parseTransaction({ data: call.data })!;
    if (parsed.name === "balanceOf") return toBeHex(call.target.toLowerCase() === OUTPUT ? outputBalance
      : parsed.args[0].toLowerCase() === POOL ? poolBalance : inputBalance, 32);
    assert.equal(parsed.name, "transfer"); inputBalance -= parsed.args[1]; poolBalance += parsed.args[1]; return toBeHex(1n, 32);
  };
  inspectRuntime(leg.program, cap, { nativeBalance: () => native, call(call) {
    if ([INPUT, OUTPUT].includes(call.target.toLowerCase())) return token(call);
    if (options.runtimeWitness && call.static && call.target.toLowerCase() === INNER) {
      const parsed = new Interface(["function observe(uint256) view returns(uint256)"]).parseTransaction({ data: call.data })!;
      assert.equal(parsed.args[0], cap); return toBeHex(output, 32);
    }
    const payload = outerAbi.parseTransaction({ data: call.data })!.args[3];
    outputBalance += options.fault === "short-output" ? paymentAmount - 1n : output;
    const data = callbackAbi.encodeFunctionData("pay", [options.fault === "zero-debt" ? 0n : debt, -output, payload]);
    inspectRuntime(body(payload), cap, { calldata: data, call(inner) {
      if ([INPUT, OUTPUT].includes(inner.target.toLowerCase())) return token(inner);
      assert.equal(inner.target.toLowerCase(), INNER); continuations++;
      assert.equal(prefixAbi.parseTransaction({ data: inner.data })!.args[0], options.debtInput ? debt : paymentAmount);
      outputBalance -= options.fault === "old-output" ? paymentAmount + output : paymentAmount;
      if (options.fault !== "fake-prefix") {
        const received = options.fault === "short-prefix" ? debt - 1n : debt;
        if (options.recipient === "executor") inputBalance += received; else poolBalance += received;
      }
      if (options.fault === "old-input") inputBalance--;
      return toBeHex(debt, 32);
    }, nativeBalance: () => native });
    if (options.fault === "post-callback-input") inputBalance--;
    if (options.fault === "post-callback-output") outputBalance = 102n;
    if (options.fault === "post-callback-fresh-output") outputBalance = 104n;
    if (options.fault === "post-callback-fresh-input") inputBalance++;
    if (options.fault === "native") native--;
    return outerAbi.encodeFunctionResult("swap", [debt, -output]);
  } });
  assert.equal(continuations, 1); assert.equal(inputBalance, 101n); assert.equal(outputBalance, 103n + output - paymentAmount);
  assert.equal(poolBalance, 107n + debt); assert.equal(native, 17n);
}
for (const recipient of ["target", "executor"] as const) for (const debtInput of [false, true])
  test(`signed deferred ${recipient} receipt with ${debtInput ? "debt-sized" : "fixed"} continuation`, () => deferredExecution({ recipient, debtInput }));
for (const fault of ["short-output", "zero-debt", "old-output", "fake-prefix", "short-prefix", "old-input", "post-callback-input", "post-callback-output", "post-callback-fresh-output", "post-callback-fresh-input", "native"])
  test(`signed deferred rejects ${fault}`, () => assert.throws(() => deferredExecution({ fault })));
test("framed continuation cannot silently advertise native/debt modes", () => {
  const d: any = definition(); d.framedSettlement = { version: 1, recipient: "executor", debtInput: false, expectedOutput: 38n };
  d.steps[0].frame.callback.steps.unshift({ id: "continue", continuation: { debt: ref("debt"), output: ref("output") } });
  const request = { kind: "deferred-input", paymentAmount: 1n, paymentProgram: "0x01", paymentInput: "debt" };
  assert.equal(supportsDeclarativeSettlement(d, { ...context, settlement: request }), false);
  assert.equal(supportsDeclarativeSettlement(d, { ...context, route: { ...context.route, tokenIn: ADDR.WETH,
    executionAssets: { input: "native", output: "erc20" } }, settlement: { ...request, paymentInput: undefined } }), false);
  d.steps[0].frame.callback.steps[0].when = false;
  assert.throws(() => buildDeclarativeExecutionProgram(d, { ...context, settlement: { ...request, paymentInput: undefined } }, values));
});

test("runtime ABI full signed word does not admit narrow integer patches", () => {
  assert.equal(encodeDeclarativeCall("function signed(int256)", [ref("amountIn")]).patches[0]!.offset, 4);
  for (const type of ["int8", "int128", "uint128", "address", "bool"])
    assert.throws(() => encodeDeclarativeCall(`function wrong(${type})`, [ref("amountIn")]));
});

test("unsigned actual input cannot change signed exact-input into exact-output", () => {
  const p = buildDeclarativeExecutionProgram(definition(), context, values);
  let poolCalls = 0;
  assert.throws(() => inspectRuntime(hexlify(p.bytes()), 1n << 255n, { nativeBalance: () => 0n, call(call) {
    if (call.target.toLowerCase() === POOL) poolCalls++;
    return toBeHex(1n << 255n, 32);
  } }));
  assert.equal(poolCalls, 0);
});


test("framed continuation retains every declared gross debit/receipt constraint", () => {
  deferredExecution({ configure(d) { d.effects[0].minimum = 7n; d.effects[1].equals = 38n; d.effects[1].maximum = 38n; } });
  for (const [effect, field, amount] of [[0, "minimum", 20n], [1, "minimum", 39n], [1, "maximum", 37n], [1, "equals", 37n]] as const)
    assert.throws(() => deferredExecution({ configure(d) { d.effects[effect][field] = amount; } }));
});

const nativeAbi = new Interface(["function deposit() payable", "function withdraw(uint256)", "function take()", "function settle() payable"]);
function nativeDeferred(options: { input: boolean; beforeCallback?: boolean; fault?: string }) {
  const cap = 19n, debt = 7n, output = 38n, paymentAmount = 11n;
  const tokenIn = options.input ? ADDR.WETH : INPUT, tokenOut = options.input ? OUTPUT : ADDR.WETH;
  const d: any = definition(); d.protectedAddresses = [tokenIn, tokenOut, POOL];
  d.framedSettlement = { version: 1, recipient: "executor", debtInput: true, expectedOutput: 38n, nativeBoundary: true };
  d.effects = [{ kind: "debit", ...(options.input ? { asset: "native" } : { token: tokenIn }), account: "$executor", maximum: ref("amountIn"), minimum: 7n },
    { kind: "credit", ...(options.input ? { token: tokenOut } : { asset: "native" }), account: "$executor", equals: 38n, minimum: 2n }];
  const continueStep = { id: "continue", continuation: { debt: ref("debt"), output: ref("output") } };
  d.steps[0].frame.callback.steps = options.input ? [continueStep,
    { id: "unwrap", nativeBoundary: { kind: "unwrap-payment", debt: ref("debt") }, when: "$deferredSettlement" },
    { id: "settle", call: { target: POOL, signature: "function settle() payable", args: [], value: ref("debt") } },
  ] : [
    ...(!options.beforeCallback ? [{ id: "take", call: { target: POOL, signature: "function take()", args: [] } }] : []),
    { id: "wrap", nativeBoundary: { kind: "wrap-output" }, when: "$deferredSettlement" }, continueStep,
    { id: "pay", call: { target: tokenIn, signature: "function transfer(address,uint256) returns(bool)", args: [POOL, ref("debt")],
      save: { paid: 0 }, checks: [{ left: ref("paid"), operator: "eq", right: 1n }] } },
  ];
  if (options.fault === "skipped-boundary") d.steps[0].frame.callback.steps.find((s: any) => s.nativeBoundary).when = false;
  const paymentProgram = new RuntimeAmountProgram().call(INNER, prefixAbi.encodeFunctionData("continueRoute", [0n]), { patches: [{ offset: 4, reg: 0 }] }).load(0, 0);
  const input = { ...context, route: { ...context.route, tokenIn, tokenOut, executionAssets: {
    input: options.input ? "native" : "erc20", output: options.input ? "erc20" : "native" } },
    settlement: { kind: "deferred-input" as const, paymentAmount, paymentInput: "debt" as const, paymentProgram: hexlify(paymentProgram.bytes()) } };
  assert.equal(supportsDeclarativeSettlement(d, input), true);
  const program = buildDeclarativeExecutionProgram(d, input, values);
  let inputBalance = 101n, outputBalance = 103n, poolBalance = 107n, native = 17n, continued = 0, settled = 0;
  const wrapped = () => options.input ? inputBalance : outputBalance;
  const wrapBalance = (delta: bigint) => { if (options.input) inputBalance += delta; else outputBalance += delta; };
  function action(call: RuntimeCall): string {
    const target = call.target.toLowerCase();
    if (call.data.startsWith(tokenAbi.getFunction("balanceOf")!.selector)) {
      const account = tokenAbi.parseTransaction({ data: call.data })!.args[0].toLowerCase();
      return toBeHex(target === tokenOut.toLowerCase() ? outputBalance : account === POOL ? poolBalance : inputBalance, 32);
    }
    if (target === ADDR.WETH.toLowerCase()) {
      const parsed = nativeAbi.parseTransaction({ data: call.data })!;
      if (parsed.name === "deposit") { native -= call.value; wrapBalance(options.fault === "short-wrap" ? call.value - 1n : call.value); }
      else { assert.equal(parsed.name, "withdraw"); assert(wrapped() >= parsed.args[0]); wrapBalance(-BigInt(parsed.args[0])); native += options.fault === "short-unwrap" ? parsed.args[0] - 1n : parsed.args[0]; }
      return "0x";
    }
    if (target === INNER) {
      assert.equal(prefixAbi.parseTransaction({ data: call.data })!.args[0], debt); continued++;
      outputBalance -= options.fault === "old-output" ? output + paymentAmount : paymentAmount;
      if (options.fault !== "fake-prefix") inputBalance += debt;
      return toBeHex(debt, 32);
    }
    if (target === tokenIn.toLowerCase()) {
      const parsed = tokenAbi.parseTransaction({ data: call.data })!; assert.equal(parsed.name, "transfer");
      inputBalance -= parsed.args[1]; poolBalance += parsed.args[1]; return toBeHex(1n, 32);
    }
    assert.equal(target, POOL);
    const parsed = nativeAbi.parseTransaction({ data: call.data })!;
    if (parsed.name === "take") native += options.fault === "short-output" ? output - 1n : output;
    else { assert.equal(parsed.name, "settle"); native -= options.fault === "old-native" ? call.value + 1n : call.value; poolBalance += call.value; settled++; }
    return "0x";
  }
  inspectRuntime(hexlify(program.bytes()), cap, { nativeBalance: () => native, call(call) {
    if (call.target.toLowerCase() !== POOL || !call.data.startsWith(outerAbi.getFunction("swap")!.selector)) return action(call);
    const payload = outerAbi.parseTransaction({ data: call.data })!.args[3];
    if (options.input) outputBalance += output;
    else if (options.beforeCallback) native += options.fault === "short-output" ? output - 1n : output;
    inspectRuntime(body(payload), cap, { nativeBalance: () => native, calldata: callbackAbi.encodeFunctionData("pay", [debt, -output, payload]), call: action });
    if (options.fault === "post-native") native--;
    return outerAbi.encodeFunctionResult("swap", [debt, -output]);
  } });
  assert.equal(inputBalance, 101n); assert.equal(outputBalance, 103n + output - paymentAmount);
  assert.equal(poolBalance, 107n + debt); assert.equal(native, 17n); assert.equal(continued, 1); assert.equal(settled, options.input ? 1 : 0);
}
for (const input of [false, true]) test(`native deferred ${input ? "input unwrap/settle" : "output take/wrap"} preserves old ETH/WETH and partial debt`, () => nativeDeferred({ input }));
test("native output delivered before callback is included in the parent receipt baseline", () => nativeDeferred({ input: false, beforeCallback: true }));
for (const fault of ["fake-prefix", "old-output", "short-wrap", "short-output", "post-native", "skipped-boundary"])
  test(`native output deferred rejects ${fault}`, () => assert.throws(() => nativeDeferred({ input: false, fault })));
for (const fault of ["fake-prefix", "old-output", "short-unwrap", "old-native", "post-native", "skipped-boundary"])
  test(`native input deferred rejects ${fault}`, () => assert.throws(() => nativeDeferred({ input: true, fault })));


test("a declared signed amount uses checked VM negation without rewriting the actual input", () => {
  const model: RuntimeMathModel = { id: "fixture-negative-amount", version: 1, inputs: ["magnitude"], outputs: ["signed"],
    operations: [{ name: "signed", op: "neg", left: { input: "magnitude" }, right: { constant: "0" } }] };
  const math = createDeclarativeRuntimeMathRegistry([model]).bind({ version: 1, entries: { negative: { model: model.id, version: 1 } } });
  const d: any = definition();
  d.steps[0].frame.call.args[2] = ref("signedAmount");
  d.steps.unshift({ id: "signed", math: { model: "negative", inputs: { magnitude: ref("amountIn") }, outputs: { signed: "signedAmount" } } });
  const p = buildDeclarativeExecutionProgram(d, context, values, { math });
  let paid = 0n, received = 0n, poolCalls = 0;
  const read = (call: RuntimeCall) => toBeHex(call.target.toLowerCase() === INPUT ? 101n - paid : 103n + received, 32);
  inspectRuntime(hexlify(p.bytes()), 19n, { nativeBalance: () => 0n, call(call) {
    if ([INPUT, OUTPUT].includes(call.target.toLowerCase())) return read(call);
    poolCalls++; const parsed = outerAbi.parseTransaction({ data: call.data })!; assert.equal(parsed.args[2], -19n);
    const payload = parsed.args[3];
    inspectRuntime(body(payload), 19n, { calldata: callbackAbi.encodeFunctionData("pay", [19n, -38n, payload]), call(inner) {
      paid += tokenAbi.parseTransaction({ data: inner.data })!.args[1]; return toBeHex(1n, 32);
    } }); received = 38n; return outerAbi.encodeFunctionResult("swap", [19n, -38n]);
  } });
  assert.equal(poolCalls, 1); assert.equal(paid, 19n); assert.equal(received, 38n);
  poolCalls = 0;
  assert.throws(() => inspectRuntime(hexlify(p.bytes()), 1n << 255n, { nativeBalance: () => 0n, call(call) { if (call.target.toLowerCase() === POOL) poolCalls++; return toBeHex(1n << 255n, 32); } }));
  assert.equal(poolCalls, 0, "out-of-range signed magnitude fails before protocol invocation");
  assert.throws(() => createDeclarativeRuntimeMathRegistry([{ ...model, operations: [{ ...model.operations[0]!, right: { constant: "1" } }] }]));
});

test("continuation and native conversion cannot exist without the settlement module", () => {
  const d: any = definition(); d.steps[0].frame.callback.steps.unshift({ id: "continue", continuation: { debt: ref("debt"), output: ref("output") } });
  assert.throws(() => declarativeSettlementCapabilities(d, context), /require framedSettlement/);
});


test("framed deferred requires a parent output witness and binds callback output to it", () => {
  const d: any = definition(); d.framedSettlement = { version: 1, recipient: "target", debtInput: true };
  d.steps[0].frame.callback.steps.unshift({ id: "continue", continuation: { debt: ref("debt"), output: ref("output") } });
  assert.throws(() => declarativeSettlementCapabilities(d, context), /framed settlement/);
  assert.throws(() => deferredExecution({ configure(d) { d.framedSettlement.expectedOutput = 37n; } }));
  assert.throws(() => deferredExecution({ configure(d) { d.framedSettlement.expectedOutput = "$quotedAmountOut"; } }), /invocation-local/);
});

test("parent output witness comes from an invocation-local read and survives into callback/final receipt checks", () => deferredExecution({ runtimeWitness: true }));


for (const reserved of ["frameOpeningInput", "frameOpeningOutput", "frameOpeningNative", "frameExpectedOutput", "frameFinalOutput"])
  test(`public captures cannot overwrite internal ${reserved}`, () => {
    for (const change of [
      (d: any) => { d.steps[0].frame.call.save = { [reserved]: 0 }; },
      (d: any) => { d.preflight = [{ target: INNER, signature: "function read() view returns(uint256)", args: [], save: { [reserved]: 0 } }]; },
      (d: any) => { d.steps.unshift({ id: "read", static: true, call: { target: INNER, signature: "function read() view returns(uint256)", args: [], save: { [reserved]: 0 } } }); },
      (d: any) => { d.steps.unshift({ id: "math", math: { model: "identity", inputs: {}, outputs: { result: reserved } } }); },
      (d: any) => { d.steps[0].frame.callback.captures = { [reserved]: ref("amountIn") }; },
      (d: any) => { d.steps[0].frame.callback.arguments[0].name = reserved; },
      (d: any) => { d.steps[0].frame.callback.steps[0].call.save = { [reserved]: 0 }; },
      (d: any) => { const nested: any = definition(); nested.steps[0].frame.call.save = { [reserved]: 0 };
        d.steps[0].frame.callback.steps.unshift({ id: "nested", frame: nested.steps[0].frame }); },
      (d: any) => { d.steps[0].frame.callback.steps.unshift({ id: "math", math: { model: "identity", inputs: {}, outputs: { result: reserved } } }); },
    ]) {
      const d: any = definition(); change(d);
      assert.throws(() => declarativeSettlementCapabilities(d, context), /capture|reserved/);
      assert.throws(() => buildDeclarativeExecutionProgram(d, context, values), /capture|reserved/);
    }
  });

test("post-callback fresh output cannot be hidden by a forged opening snapshot return capture", () => {
  assert.throws(() => deferredExecution({ fault: "post-callback-fresh-output", configure(d) {
    d.steps[0].frame.call.save = { frameOpeningOutput: 0 };
  } }), /capture|reserved/);
});

test("registered math outputs cannot enter the compiler frame namespace", () => {
  const math = createDeclarativeRuntimeMathRegistry([{ id: "fixture-identity", version: 1, inputs: ["a"], outputs: ["result"],
    operations: [{ name: "result", op: "add", left: { input: "a" }, right: { constant: "0" } }] }])
    .bind({ version: 1, entries: { identity: { model: "fixture-identity", version: 1 } } });
  assert.throws(() => math.expand("identity", { a: ref("amountIn") }, { result: "frameOpeningOutput" }, "Safe"), /capture|reserved/);
});

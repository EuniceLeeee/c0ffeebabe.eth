import assert from "node:assert/strict";
import test from "node:test";
import { Interface, getBytes, hexlify, toBeHex } from "ethers";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { buildDeclarativeExecutionProgram, buildDeclarativeRuntimeLeg, declarativeSettlementCapabilities, supportsDeclarativeSettlement, type DeclarativeConversionExecution } from "../venues/declarative-execution.js";
import { createDeclarativeRuntimeMathRegistry } from "../venues/declarative-runtime-math.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

const a = (n: number) => toBeHex(n, 20), INPUT = a(1), OUTPUT = a(2), TARGET = a(3), EXECUTOR = a(4), PREFIX = a(5);
const ref = (runtime: string) => ({ runtime });
const values = { evaluate(value: any, env: Record<string, any>): any {
  if (typeof value === "string" && value.startsWith("$")) return value.slice(1).split(".").reduce((v, key) => v?.[key], env);
  if (Array.isArray(value)) return value.map(item => this.evaluate(item, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.evaluate(item, env)]));
  return value;
} };
const math = createDeclarativeRuntimeMathRegistry([{
  id: "fixture:budget", version: 1, inputs: ["cap"], outputs: ["quantity", "debt"], operations: [
    { name: "quantity", op: "mul", left: { input: "cap" }, right: { constant: "2" } },
    { name: "debt", op: "sub", left: { input: "cap" }, right: { constant: "1" } },
  ],
}]).bind({ version: 1, entries: { budget: { model: "fixture:budget", version: 1 } } });
const callbackSignature = "function onOutput(address token,address receiver,uint256 output,uint256 debt,bytes data)";
const outerSignature = "function take(address token,uint256 output,address receiver,bytes data) returns(uint256)";
const tokenAbi = new Interface(["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)",
  "function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)"]);
const outerAbi = new Interface([outerSignature]), callbackAbi = new Interface([callbackSignature]);
const prefixAbi = new Interface(["function cycle(uint256) returns(uint256)"]);
const paymentProgram = hexlify(new RuntimeAmountProgram()
  .call(PREFIX, prefixAbi.encodeFunctionData("cycle", [0n]), { patches: [{ offset: 4, reg: 0 }] }).load(0, 0).bytes());
function definition(mode: "transfer" | "approve-pull"): DeclarativeConversionExecution {
  return {
    version: 2, settlement: { directOutput: true }, protectedAddresses: [INPUT, OUTPUT, TARGET],
    steps: [
      { id: "terms", math: { model: "budget", inputs: { cap: ref("amountIn") }, outputs: { quantity: "quantity", debt: "debt" } } },
      { id: "action", call: { target: TARGET, signature: "function ordinary(uint256) returns(uint256)", args: [ref("quantity")] } },
    ],
    deferred: { stepId: "action", dataArgument: 3,
      call: { target: TARGET, signature: outerSignature, args: [OUTPUT, ref("quantity"), "$executor"], save: { delivered: 0 },
        checks: [{ left: ref("delivered"), operator: "eq", right: ref("quantity") }] },
      callback: { signature: callbackSignature, dataArgument: 4, debtArgument: 3, outputArgument: 2,
        expectedDebt: ref("debt"), expectedOutput: ref("quantity"),
        bindings: [{ argument: 0, equals: OUTPUT }, { argument: 1, equals: "$executor" }],
        payment: { mode, recipient: TARGET, requireBool: true, ...(mode === "approve-pull" ? { verifyAllowance: true } : {}) } },
    },
    effects: [
      { kind: "debit", token: INPUT, account: "$executor", maximum: ref("amountIn") },
      { kind: "credit", token: OUTPUT, account: "$recipient", equals: ref("quantity") },
      { kind: "unchanged-native" },
    ],
  };
}
const context = { route: { adapterId: "fixture", target: TARGET, tokenIn: INPUT, tokenOut: OUTPUT }, executor: EXECUTOR,
  amountIn: 1n, quotedAmountOut: 2n, minAmountOut: 1n,
  settlement: { kind: "deferred-input" as const, paymentAmount: 11n, paymentProgram } };
type Fault = "debt-zero" | "debt-high" | "debt-mismatch" | "wrong-token" | "wrong-actor" | "wrong-selector" |
  "short-output" | "no-output" | "fake-prefix" | "short-prefix" | "old-input" | "old-output" | "native" | "return" | "approve";
function execute(mode: "transfer" | "approve-pull", fault?: Fault, options: { definition?: DeclarativeConversionExecution; quotedMinimum?: bigint } = {}) {
  const cap = 19n, debt = 18n, quantity = 38n;
  let input = 101n, output = 103n, paymentReceived = 107n, native = 17n, allowance = 0n, prefixCalls = 0;
  const leg = buildDeclarativeRuntimeLeg(options.definition ?? definition(mode), context, values, { math })!;
  assert.equal(leg.inputMode, "maximum"); assert.equal(leg.settlement.deferredInput?.toLowerCase(), EXECUTOR);
  function tokenCall(call: { target: string; data: string }) {
    const parsed = tokenAbi.parseTransaction({ data: call.data })!;
    if (parsed.name === "balanceOf") {
      const account = parsed.args[0].toLowerCase();
      return toBeHex(call.target.toLowerCase() === OUTPUT ? output : account === EXECUTOR ? input : paymentReceived, 32);
    }
    if (parsed.name === "approve") { allowance = parsed.args[1]; return toBeHex(fault === "approve" ? 0n : 1n, 32); }
    if (parsed.name === "allowance") return toBeHex(allowance, 32);
    assert.equal(parsed.name, "transfer"); assert.equal(parsed.args[0].toLowerCase(), TARGET);
    input -= parsed.args[1]; paymentReceived += parsed.args[1]; return toBeHex(1n, 32);
  }
  try {
    inspectRuntime(options.quotedMinimum === undefined ? leg.program : hexlify(buildDeclarativeExecutionProgram(options.definition ?? definition(mode),
      { ...context, minAmountOut: options.quotedMinimum }, values, { math }).bytes()), cap, { nativeBalance: () => native, call(call) {
      if ([INPUT, OUTPUT].includes(call.target.toLowerCase())) return tokenCall(call);
      assert.equal(call.target.toLowerCase(), TARGET);
      const parsed = outerAbi.parseTransaction({ data: call.data })!;
      assert.equal(parsed.args[0].toLowerCase(), OUTPUT); assert.equal(parsed.args[1], quantity); assert.equal(parsed.args[2].toLowerCase(), EXECUTOR);
      // These offsets are ABI-derived, and a nonzero frame delegates sender /
      // payload authentication to the already-tested RuntimeAmountVM kernel.
      assert.equal(call.incoming, 196); assert.equal(call.outgoing, 164);
      const payload = getBytes(parsed.args[3]);
      assert.equal(payload[0], 0x0e);
      assert.equal(BigInt(hexlify(payload.slice(1, 33))), cap);
      const scriptSize = Number(BigInt(hexlify(payload.slice(33, 36))));
      assert.equal(scriptSize, payload.length - 36);
      output += fault === "no-output" ? 0n : fault === "short-output" ? quantity - 1n : quantity;
      let data = callbackAbi.encodeFunctionData("onOutput", [fault === "wrong-token" ? INPUT : OUTPUT,
        fault === "wrong-actor" ? TARGET : EXECUTOR, quantity,
        fault === "debt-zero" ? 0n : fault === "debt-high" ? cap + 1n : fault === "debt-mismatch" ? debt - 1n : debt, hexlify(payload)]);
      if (fault === "wrong-selector") data = `0x12345678${data.slice(10)}`;
      inspectRuntime(hexlify(payload.slice(36)), cap, { calldata: data, nativeBalance: () => native, call(inner) {
        if ([INPUT, OUTPUT].includes(inner.target.toLowerCase())) return tokenCall(inner);
        assert.equal(inner.target.toLowerCase(), PREFIX); prefixCalls++;
        const amount = prefixAbi.parseTransaction({ data: inner.data })!.args[0]; assert.equal(amount, 11n);
        output -= amount;
        input += fault === "fake-prefix" ? 0n : fault === "short-prefix" ? cap - 1n : cap;
        return toBeHex(cap, 32);
      } });
      if (mode === "approve-pull") { assert.equal(allowance, debt); input -= debt; paymentReceived += debt; }
      if (fault === "old-input") input--;
      if (fault === "old-output") output--;
      if (fault === "native") native--;
      return outerAbi.encodeFunctionResult("take", [fault === "return" ? quantity - 1n : quantity]);
    } });
  } catch (error) {
    if (["debt-zero", "debt-high", "debt-mismatch", "wrong-token", "wrong-actor", "wrong-selector", "short-output", "no-output"].includes(fault ?? ""))
      assert.equal(prefixCalls, 0, "invalid callback must not enter the continuation");
    throw error;
  }
  assert.equal(prefixCalls, 1); assert.equal(input, 101n + cap - debt); assert.equal(output, 103n + quantity - 11n);
  assert.equal(paymentReceived, 107n + debt); assert.equal(native, 17n); assert.equal(allowance, 0n);
}
for (const mode of ["transfer", "approve-pull"] as const) {
  test(`declarative ${mode} callback consumes fresh output, obtains measured input and preserves inventory`, () => execute(mode));
  for (const fault of ["debt-zero", "debt-high", "debt-mismatch", "wrong-token", "wrong-actor", "wrong-selector", "short-output", "no-output",
    "fake-prefix", "short-prefix", "old-input", "old-output", "native", "return"] as const)
    test(`${mode} callback rejects ${fault}`, () => assert.throws(() => execute(mode, fault)));
}
test("callback approve-pull checks token approval results", () => assert.throws(() => execute("approve-pull", "approve")));
test("deferred contracts reject unspecified ABI fields, arbitrary scripts and mutating preparation", () => {
  for (const change of [
    (d: any) => { d.deferred.callback.bindings.pop(); },
    (d: any) => { d.deferred.callback.debtArgument = 0; },
    (d: any) => { d.deferred.callback.dataArgument = 1; },
    (d: any) => { d.deferred.callback.signature = "function bad(address,uint256,uint256,bytes[],bytes)"; },
    (d: any) => { d.deferred.callback.script = "0x01"; },
    (d: any) => { d.deferred.dataArgument = 0; },
    (d: any) => { d.deferred.stepId = "terms"; },
    (d: any) => { d.steps.unshift({ id: "write", call: { target: TARGET, signature: "function write()", args: [] } }); },
  ]) { const d = definition("transfer"); change(d); assert.throws(() => buildDeclarativeExecutionProgram(d, context, values, { math })); }
  assert.equal(buildDeclarativeRuntimeLeg(definition("transfer"), { ...context, recipient: TARGET }, values, { math }), null);
  assert.equal(buildDeclarativeRuntimeLeg(definition("transfer"), { ...context,
    settlement: { ...context.settlement, paymentInput: "debt" } }, values, { math }), null);
  assert.throws(() => buildDeclarativeExecutionProgram(definition("transfer"), context, values), /math module is undefined/);
});
test("runtime math cannot overwrite actual input or an earlier capture", () => {
  for (const output of ["amountIn", "debt"]) {
    const d = definition("transfer") as any; d.steps[0].math.outputs.quantity = output;
    assert.throws(() => buildDeclarativeExecutionProgram(d, context, values, { math }));
  }
});

test("deferred gross route constraints and quoted minimum remain mandatory", () => {
  for (const change of [
    (d: any) => { d.effects[1].minimum = 999n; },
    (d: any) => { d.effects[1].equals = 999n; },
    (d: any) => { d.effects[1].maximum = 37n; },
    (d: any) => { d.effects[0].minimum = 19n; },
    (d: any) => { d.effects[0].equals = ref("amountIn"); delete d.effects[0].maximum; },
  ]) {
    const d = definition("transfer"); change(d);
    assert.throws(() => execute("transfer", undefined, { definition: d }));
  }
  assert.throws(() => execute("transfer", undefined, { quotedMinimum: 39n }));
  execute("transfer", undefined, { quotedMinimum: 38n });
});
test("malformed deferred definitions cannot advertise ordinary runtime capabilities", () => {
  for (const change of [
    (d: any) => { d.deferred = {}; },
    (d: any) => { d.deferred.callback.dataArgument = 0; },
    (d: any) => { d.deferred.callback.bindings.pop(); },
    (d: any) => { d.deferred.stepId = "wrong"; },
    (d: any) => { d.settlement.callback = true; },
  ]) {
    const d = definition("transfer"); change(d);
    assert.throws(() => declarativeSettlementCapabilities(d, context));
    assert.throws(() => supportsDeclarativeSettlement(d, { ...context, settlement: undefined }));
    assert.throws(() => buildDeclarativeRuntimeLeg(d, { ...context, settlement: undefined }, values, { math }));
  }
  const d = definition("transfer") as any; delete d.deferred; d.settlement.directOutput = false;
  assert.deepEqual(declarativeSettlementCapabilities(d, context), {});
  assert.equal(supportsDeclarativeSettlement(d, { ...context, settlement: { kind: "direct-output", recipient: TARGET } }), false);
});
test("runtime math assertions gate declared model outputs", () => {
  const d = definition("transfer") as any;
  d.steps[0].math.checks = [{ left: ref("debt"), operator: "eq", right: 18n }];
  execute("transfer", undefined, { definition: d });
  d.steps[0].math.checks[0].right = 19n;
  assert.throws(() => execute("transfer", undefined, { definition: d }));
});

test("deferred route constraints may reference the terminal returned amount", () => {
  const d = definition("transfer") as any;
  d.effects[1].equals = ref("delivered");
  execute("transfer", undefined, { definition: d });
});

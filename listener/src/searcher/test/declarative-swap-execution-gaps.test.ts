import assert from "node:assert/strict";
import test from "node:test";
import { Interface, getBytes, hexlify, toBeHex } from "ethers";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { buildDeclarativeExecutionProgram, buildDeclarativeRuntimeLeg, buildDeclarativeQuotedFragment,
  declarativeSettlementCapabilities, validateDeclarativeQuoteOutput, type DeclarativeConversionExecution } from "../venues/declarative-execution.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

// Common compiler tests with synthetic calls. This interpreter establishes
// emitted ABI/amount/guard behavior; it is not EVM or historical acceptance.
const a = (n: number) => toBeHex(n, 20), INPUT = a(1), OUTPUT = a(2), TARGET = a(3), ACTOR = a(4), WETH = a(5);
const ref = (runtime: string) => ({ runtime });
const quoteRef = (quoteOutput: string) => ({ quoteOutput });
const isBuy = { op: "eq", args: ["$route.direction", "buy"] };
const isSell = { op: "eq", args: ["$route.direction", "sell"] };
const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
const abi = new Interface([
  "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)", "function preview(uint256) view returns(uint256)",
  "function convert(uint256,uint256) returns(uint256)", "function withdraw(uint256)", "function deposit() payable",
  "function buy(uint256) payable returns(uint256)", "function sell(uint256) returns(uint256)",
]);
const approval = { token: "$route.tokenIn", spender: TARGET, mode: "exact-clear", requireBool: true, verifyAllowance: true };
const effects = [
  { kind: "debit", token: "$route.tokenIn", account: "$executor", equals: ref("amountIn") },
  { kind: "credit", token: "$route.tokenOut", account: "$recipient" },
];
const quotedDefinition = (): DeclarativeConversionExecution & { version: 2 } => ({
  version: 2, settlement: { directOutput: true }, protectedAddresses: [INPUT, OUTPUT, TARGET],
  quoteOutput: { version: 1, steps: [{ id: "read", static: true,
    call: { target: TARGET, signature: abi.getFunction("preview")!.format("full"), args: [ref("amountIn")], save: { previewed: 0 } } }],
    result: ref("previewed"), exports: { amountOut: ref("previewed") } },
  steps: [{ id: "convert", approval, call: { target: TARGET, signature: abi.getFunction("convert")!.format("full"),
    args: [ref("amountIn"), quoteRef("amountOut")] } }], effects,
});
const directionalDefinition = (): DeclarativeConversionExecution & { version: 2 } => ({
  version: 2, settlement: { directOutput: false }, protectedAddresses: [INPUT, OUTPUT, TARGET, WETH], effects,
  steps: [
    { id: "unwrap", when: isBuy, call: { target: WETH, signature: abi.getFunction("withdraw")!.format("full"), args: [ref("amountIn")] } },
    { id: "buy", when: isBuy, call: { target: TARGET, signature: abi.getFunction("buy")!.format("full"),
      args: [ref("amountIn")], value: ref("amountIn") } },
    { id: "sell", when: isSell, approval, call: { target: TARGET, signature: abi.getFunction("sell")!.format("full"),
      args: [ref("amountIn")], save: { received: 0 } } },
    { id: "wrap", when: isSell, call: { target: WETH, signature: abi.getFunction("deposit")!.format("full"), args: [], value: ref("received") } },
  ],
});
function context(direction = "plain") {
  const buy = direction === "buy", sell = direction === "sell";
  return { route: { direction, adapterId: "fixture", target: TARGET, tokenIn: buy ? WETH : INPUT, tokenOut: sell ? WETH : OUTPUT },
    executor: ACTOR, recipient: ACTOR, minAmountOut: 1n, amountIn: 19n, quotedAmountOut: 38n };
}
type Fault = "zero-debit" | "under-debit" | "over-debit" | "zero-output" | "short-output" | "old-native" | "approval";
function execute(definition: DeclarativeConversionExecution, direction = "plain", fault?: Fault,
  kind: "default" | "quote-output" = "default", amount = 19n) {
  const input = context(direction), balances = new Map([[INPUT, 101n + amount], [OUTPUT, 10n ** 24n], [WETH, 103n + amount]]);
  const initial = new Map(balances), calls: string[] = []; let native = 107n, allowance = 0n;
  const balance = (token: string) => balances.get(token.toLowerCase())!;
  const add = (token: string, n: bigint) => balances.set(token.toLowerCase(), balance(token) + n);
  const debit = fault === "zero-debit" ? 0n : fault === "under-debit" ? amount - 1n : fault === "over-debit" ? amount + 1n : amount;
  const output = fault === "zero-output" ? 0n : amount * 2n - (fault === "short-output" ? 1n : 0n);
  const cleanInput: any = { ...input, settlement: kind === "quote-output" ? { kind } : undefined };
  for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
    Object.defineProperty(cleanInput, key, { get() { throw new Error("off-chain amount/evidence read"); }, configurable: true });
  const leg = buildDeclarativeRuntimeLeg(definition, cleanInput, values)!; assert(leg);
  const observed = inspectRuntime(leg.program, amount, { nativeBalance: () => native, call(call) {
    const parsed = abi.parseTransaction({ data: call.data })!; calls.push(parsed.name);
    if (parsed.name === "balanceOf") { assert.equal(parsed.args[0].toLowerCase(), ACTOR); return toBeHex(balance(call.target), 32); }
    if (parsed.name === "allowance") return toBeHex(allowance, 32);
    if (parsed.name === "approve") { assert(!call.static); allowance = parsed.args[1]; return toBeHex(fault === "approval" ? 0n : 1n, 32); }
    if (parsed.name === "preview") { assert(call.static); assert.equal(parsed.args[0], amount); return toBeHex(amount * 2n, 32); }
    assert(!call.static);
    if (parsed.name === "withdraw") { assert.equal(call.value, 0n); add(WETH, -debit); native += debit; return "0x"; }
    if (parsed.name === "deposit") { assert.equal(call.value, output); native -= call.value; add(WETH, output); return "0x"; }
    if (parsed.name === "buy") {
      assert.equal(call.value, amount); native -= call.value; add(OUTPUT, output);
    } else if (parsed.name === "sell") {
      assert.equal(allowance, amount); assert.equal(call.value, 0n); add(INPUT, -debit); native += output;
    } else {
      assert.equal(parsed.name, "convert"); assert.equal(call.value, 0n); assert.equal(parsed.args[0], amount);
      assert.equal(parsed.args[1], amount * 2n); assert.equal(allowance, amount); add(INPUT, -debit); add(OUTPUT, output);
    }
    if (fault === "old-native") native--;
    return toBeHex(output, 32);
  } }, kind === "quote-output" ? { output: true, readOnly: true } : {});
  if (kind === "quote-output") { assert.deepEqual(balances, initial); assert.equal(native, 107n); assert.equal(observed.registers[0], amount * 2n); }
  else {
    assert.equal(balance(input.route.tokenIn), initial.get(input.route.tokenIn)! - amount);
    assert.equal(balance(input.route.tokenOut), initial.get(input.route.tokenOut)! + amount * 2n);
    assert.equal(native, 107n); assert.equal(allowance, 0n);
    const quoted = buildDeclarativeQuotedFragment(definition, { ...input, amountIn: amount, quotedAmountOut: amount * 2n }, values);
    assert.equal(quoted.nodes[0]!.params.runtimeAmountProgram, leg.program);
  }
  return { calls, leg, observed };
}

test("strict direction predicates select different call counts and ABI/native/approval paths", () => {
  const buy = execute(directionalDefinition(), "buy");
  assert.deepEqual(buy.calls.filter(x => !["balanceOf", "allowance"].includes(x)), ["withdraw", "buy"]);
  const sell = execute(directionalDefinition(), "sell");
  assert.deepEqual(sell.calls.filter(x => !["balanceOf", "allowance"].includes(x)), ["approve", "approve", "sell", "approve", "deposit"]);
  assert.notEqual(buy.leg.program, sell.leg.program);
});
for (const direction of ["buy", "sell"]) for (const fault of ["zero-debit", "under-debit", "over-debit", "zero-output", "old-native"] as const)
  test(`conditional ${direction} execution retains ${fault} guards and old inventory`, () =>
    assert.throws(() => execute(directionalDefinition(), direction, fault)));

test("step conditions must be boolean and cannot turn all calls off or refer to omitted amount inputs", () => {
  for (const when of [0, 1, "true", null, "$amountIn", { runtime: "amountIn" }]) {
    const d: any = directionalDefinition(); d.steps[0]!.when = when;
    assert.throws(() => buildDeclarativeRuntimeLeg(d, context("buy"), values), /boolean|unbound/);
  }
  assert.throws(() => buildDeclarativeRuntimeLeg(directionalDefinition(), context("unknown"), values), /state-changing/);
  const d: any = directionalDefinition(); d.steps[0]!.when = false; d.steps[1]!.static = true;
  assert.throws(() => buildDeclarativeRuntimeLeg(d, context("buy"), values), /state-changing/);
});

test("quoted and runtime step selection both reject minimum-dependent predicates", () => {
  const d: any = directionalDefinition();
  d.steps[0].when = { op: "eq", args: ["$minAmountOut", { op: "uint", args: ["1"] }] };
  for (const minAmountOut of [1n, 37n]) {
    const input = { ...context("buy"), minAmountOut };
    assert.throws(() => buildDeclarativeRuntimeLeg(d, input, values), /unbound declarative reference \$minAmountOut/);
    assert.throws(() => buildDeclarativeQuotedFragment(d, input, values), /unbound declarative reference \$minAmountOut/);
  }
});

test("inactive callback does not advertise a declared deferred capability", () => {
  const d: any = directionalDefinition();
  d.deferred = { version: 1, stepId: "absentCallback", call: {}, callback: {} };
  assert.throws(() => buildDeclarativeRuntimeLeg(d, context("buy"), values));
  assert.throws(() => declarativeSettlementCapabilities(d, context("buy"), values));
});

test("explicit quote exports are computed once from actual runtime input and consumed by execution", () => {
  for (const amount of [19n, 31n]) {
    const run = execute(quotedDefinition(), "plain", undefined, "default", amount);
    assert.equal(run.calls.filter(x => x === "preview").length, 1);
    assert.equal(run.calls.filter(x => x === "convert").length, 1);
  }
});
for (const fault of ["zero-debit", "under-debit", "over-debit", "zero-output", "short-output", "old-native", "approval"] as const)
  test(`quote export execution rejects ${fault} with large preexisting receipt balance`, () =>
    assert.throws(() => execute(quotedDefinition(), "plain", fault)));
test("zero input fails before any quote or state-changing call", () => {
  const leg = buildDeclarativeRuntimeLeg(quotedDefinition(), context(), values)!;
  let calls = 0;
  assert.throws(() => inspectRuntime(leg.program, 0n, { call() { calls++; return toBeHex(0n, 32); }, nativeBalance: () => 107n }));
  assert.equal(calls, 0);
});

test("read-only quote emits no execution or approval, including when execution predicates are all false", () => {
  const d: any = quotedDefinition(); d.steps[0]!.when = false;
  assert.deepEqual(execute(d, "plain", undefined, "quote-output").calls, ["preview"]);
});

test("unreferenced exports and inactive consumers preserve old program bytes and add no quote reads", () => {
  const d = quotedDefinition(); d.steps[0]!.call.args[1] = 38n;
  const old: any = structuredClone(d); delete old.quoteOutput;
  assert.equal(hexlify(buildDeclarativeExecutionProgram(d, context(), values).bytes()),
    hexlify(buildDeclarativeExecutionProgram(old, context(), values).bytes()));
  (d.steps as any[]).push({ id: "inactive", when: false, call: { target: TARGET,
    signature: abi.getFunction("convert")!.format("full"), args: [ref("amountIn"), quoteRef("amountOut")] } });
  assert(!execute(d).calls.includes("preview"));
});

test("exports reject undeclared/private references and cannot overwrite compiler captures", () => {
  for (const mutate of [
    (d: any) => { delete d.quoteOutput; },
    (d: any) => { d.steps[0].call.args[1] = quoteRef("missing"); },
    (d: any) => { d.steps[0].call.args[1] = ref("quoteLocalpreviewed"); },
    (d: any) => { d.steps[0].call.save = { quoteLocalpreviewed: 0 }; },
    (d: any) => { d.quoteOutput.exports.amountOut = ref("missing"); },
    (d: any) => { d.quoteOutput.exports.amountOut = ref("amountIn"); },
    (d: any) => { d.quoteOutput.exports.quoteLocalfake = ref("previewed"); },
  ]) {
    const d = quotedDefinition(); mutate(d);
    assert.throws(() => buildDeclarativeRuntimeLeg(d, context(), values));
  }
  const empty: any = quotedDefinition(); empty.quoteOutput!.exports = {};
  validateDeclarativeQuoteOutput(empty.quoteOutput);
  assert.throws(() => buildDeclarativeRuntimeLeg(empty, context(), values), /unknown quote output export/);
});

function deferredDefinition(framed: boolean): any {
  const d: any = quotedDefinition();
  if (!framed) {
    d.steps = [{ id: "take", call: { target: TARGET, signature: abi.getFunction("convert")!.format("full"), args: [ref("amountIn"), 38n] } }];
    d.deferred = { stepId: "take", dataArgument: 3,
      call: { target: TARGET, signature: "function take(address,uint256,address,bytes) returns(uint256)", args: [OUTPUT, 38n, "$executor"] },
      callback: { signature: "function onOutput(address,address,uint256,uint256,bytes)",
        dataArgument: 4, debtArgument: 3, outputArgument: 2, expectedDebt: ref("amountIn"), expectedOutput: 38n,
        bindings: [{ argument: 0, equals: OUTPUT }, { argument: 1, equals: "$executor" }],
        payment: { mode: "transfer", recipient: TARGET, requireBool: true } } };
  } else {
    d.framedSettlement = { version: 1, recipient: "executor", debtInput: true, expectedOutput: 38n };
    d.steps = [{ id: "take", frame: {
      call: { target: TARGET, signature: "function swap(address,bool,int256,bytes) returns(int256,int256)",
        args: ["$recipient", true, ref("amountIn")], dataArgument: 3 },
      callback: { signature: "function pay(int256,int256,bytes)", dataArgument: 2, captures: { cap: ref("amountIn") },
        arguments: [{ index: 0, name: "debt", encoding: "positive", maximum: ref("cap") },
          { index: 1, name: "output", encoding: "negative", minimum: 1n }],
        steps: [{ id: "continue", continuation: { debt: ref("debt"), output: ref("output") } },
          { id: "pay", call: { target: INPUT, signature: "function transfer(address,uint256) returns(bool)",
            args: [TARGET, ref("debt")], save: { paid: 0 }, checks: [{ left: ref("paid"), operator: "eq", right: 1n }] } }] } } }];
  }
  return d;
}
for (const framed of [false, true]) test(`${framed ? "framed" : "plain"} deferred preserves old bytes with unused exports`, () => {
  const d = deferredDefinition(framed), input = { ...context(),
    settlement: { kind: "deferred-input", paymentAmount: 11n, paymentProgram: "0x01000e" + "00".repeat(32) } };
  const old = structuredClone(d); delete old.quoteOutput;
  // The existing suite independently executes both deferred emitters. This
  // comparison proves an unused optional module changes no emitted call.
  assert.equal(hexlify(buildDeclarativeExecutionProgram(d, input, values).bytes()),
    hexlify(buildDeclarativeExecutionProgram(old, input, values).bytes()));
});

type DeferredFault = "witness" | "receipt" | "debt" | "old-input" | "old-output" | "native";
function executeDeferredExports(framed: boolean, fault?: DeferredFault, witnessFromQuote = false) {
  const d = deferredDefinition(framed), amount = 19n, quantity = 38n, payment = 11n, PREFIX = a(6);
  // Export consumption activates the single read-only quote. Callback receipt
  // must equal both the parent witness and this separately computed quote.
  d.effects[1].equals = framed ? quantity : quoteRef("amountOut");
  if (framed) {
    d.steps[0].frame.call.signature = "function swap(address,bool,int256,uint256,bytes) returns(int256,int256)";
    d.steps[0].frame.call.args.push(quoteRef("amountOut"));
    d.steps[0].frame.call.dataArgument = 4;
  } else d.deferred.call.args[1] = quoteRef("amountOut");
  const witness = fault === "witness" ? 37n : witnessFromQuote ? quoteRef("amountOut") : quantity;
  if (framed) d.framedSettlement.expectedOutput = witness;
  else d.deferred.callback.expectedOutput = witness;
  const prefixAbi = new Interface(["function cycle(uint256) returns(uint256)"]);
  const paymentProgram = hexlify(new RuntimeAmountProgram().call(PREFIX, prefixAbi.encodeFunctionData("cycle", [0n]),
    { patches: [{ offset: 4, reg: 0 }] }).load(0, 0).bytes());
  const input = { ...context(), settlement: { kind: "deferred-input", paymentAmount: payment, paymentProgram } };
  const leg = buildDeclarativeRuntimeLeg(d, input, values)!;
  const outer = new Interface([framed ? d.steps[0].frame.call.signature : d.deferred.call.signature]);
  const callback = new Interface([framed ? d.steps[0].frame.callback.signature : d.deferred.callback.signature]);
  const token = new Interface(["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)"]);
  let inputBalance = 101n, outputBalance = 10n ** 24n, poolBalance = 103n, native = 107n;
  const oldOutput = outputBalance; let outerCalls = 0, quoteCalls = 0, prefixCalls = 0;
  function tokenCall(call: { target: string; data: string }) {
    const tx = token.parseTransaction({ data: call.data })!;
    if (tx.name === "balanceOf") return toBeHex(call.target.toLowerCase() === OUTPUT ? outputBalance
      : tx.args[0].toLowerCase() === TARGET ? poolBalance : inputBalance, 32);
    assert.equal(tx.name, "transfer"); assert.equal(tx.args[0].toLowerCase(), TARGET);
    inputBalance -= tx.args[1]; poolBalance += tx.args[1]; return toBeHex(1n, 32);
  }
  try {
    inspectRuntime(leg.program, amount, { nativeBalance: () => native, call(call) {
      if ([INPUT, OUTPUT].includes(call.target.toLowerCase())) return tokenCall(call);
      if (call.static) {
        assert.equal(call.target.toLowerCase(), TARGET); const preview = abi.parseTransaction({ data: call.data })!;
        assert.equal(preview.name, "preview"); assert.equal(preview.args[0], amount); quoteCalls++; return toBeHex(quantity, 32);
      }
      assert.equal(call.target.toLowerCase(), TARGET); outerCalls++;
      const parsed = outer.parseTransaction({ data: call.data })!, payload = parsed.args[framed ? 4 : 3] as string;
      assert.equal(framed ? parsed.args[2] : parsed.args[1], framed ? amount : quantity);
      if (framed) assert.equal(parsed.args[3], quantity);
      outputBalance += fault === "receipt" ? quantity - 1n : quantity;
      const debt = fault === "debt" ? amount - 1n : amount;
      const calldata = callback.encodeFunctionData(framed ? "pay" : "onOutput",
        framed ? [debt, -quantity, payload] : [OUTPUT, ACTOR, quantity, debt, payload]);
      const bytes = getBytes(payload); assert.equal(bytes[0], 0x0e);
      const size = Number(BigInt(hexlify(bytes.slice(33, 36)))); assert.equal(bytes.length, size + 36);
      inspectRuntime(hexlify(bytes.slice(36)), amount, { calldata, nativeBalance: () => native, call(inner) {
        if ([INPUT, OUTPUT].includes(inner.target.toLowerCase())) return tokenCall(inner);
        assert.equal(inner.target.toLowerCase(), PREFIX); prefixCalls++;
        assert.equal(prefixAbi.parseTransaction({ data: inner.data })!.args[0], payment);
        outputBalance -= payment;
        if (fault !== "old-input") inputBalance += amount;
        return toBeHex(amount, 32);
      } });
      if (fault === "old-output") outputBalance--;
      if (fault === "native") native--;
      return outer.encodeFunctionResult(framed ? "swap" : "take", framed ? [debt, -quantity] : [quantity]);
    } });
  } catch (error) {
    if (fault === "witness") assert.equal(outerCalls, 0, "inconsistent witness must fail before external state changes");
    if (fault === "receipt" || fault === "debt") assert.equal(prefixCalls, 0, "invalid gross callback facts must not run the prefix");
    throw error;
  }
  assert.equal(quoteCalls, 1); assert.equal(outerCalls, 1); assert.equal(prefixCalls, 1);
  assert.equal(inputBalance, 101n); assert.equal(outputBalance, oldOutput + quantity - payment);
  assert.equal(poolBalance, 103n + amount); assert.equal(native, 107n);
}
for (const framed of [false, true]) {
  for (const witnessFromQuote of [false, true]) test(`${framed ? "framed" : "plain"} deferred quote binds ${witnessFromQuote ? "exported" : "independent"} parent witness to real gross receipt`, () =>
    executeDeferredExports(framed, undefined, witnessFromQuote));
  for (const fault of ["witness", "receipt", "debt", "old-input", "old-output", "native"] as const)
    test(`${framed ? "framed" : "plain"} deferred quote rejects ${fault} without old inventory substitution`, () =>
      assert.throws(() => executeDeferredExports(framed, fault)));
  test(`${framed ? "framed" : "plain"} deferred quote rejects missing and callback-local parent witnesses`, () => {
    for (const expectedOutput of [undefined, ref("output")]) {
      const d = deferredDefinition(framed); d.effects[1].equals = quoteRef("amountOut");
      if (framed) d.framedSettlement.expectedOutput = expectedOutput;
      else d.deferred.callback.expectedOutput = expectedOutput;
      assert.throws(() => buildDeclarativeRuntimeLeg(d, { ...context(), settlement: { kind: "deferred-input", paymentAmount: 11n,
        paymentProgram: "0x01000e" + "00".repeat(32) } }, values));
    }
  });
}

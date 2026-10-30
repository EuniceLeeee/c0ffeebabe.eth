import assert from "node:assert/strict";
import test from "node:test";
import { MaxUint256, getAddress, hexlify } from "ethers";
import { buildDeclarativeExecutionProgram, buildDeclarativeRuntimeLeg, buildDeclarativeQuotedFragment,
  declarativeSettlementCapabilities, validateDeclarativeQuoteOutput, type DeclarativeConversionExecution } from "../venues/declarative-execution.js";
import { createDeclarativeRuntimeMathRegistry, type RuntimeMathModel } from "../venues/declarative-runtime-math.js";
import { quoteProgram as legacyQuoteProgram } from "../venues/protocols/psv-family/runtime-quote.js";
import { ABI, WAD } from "../venues/protocols/psv-family/codec.js";
import { addr, actor, fixture, setup, reads, type Fixture } from "../venues/protocols/psv-family/test/fixtures.js";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";

// These are fixture-only pure arithmetic models. No protocol JSON migration or
// chain acceptance is performed by this test; the original PSV implementation
// is an independent observable-call/result oracle for its existing semantics.
const operators = ["add", "mul", "eq"] as const;
const models: RuntimeMathModel[] = operators.map(op => ({ id: `fixture:${op}`, version: 1,
  inputs: ["a", "b"], outputs: ["value"], operations: [{ name: "value", op, left: { input: "a" }, right: { input: "b" } }] }));
const math = createDeclarativeRuntimeMathRegistry(models).bind({ version: 1,
  entries: Object.fromEntries(operators.map(op => [op, { model: `fixture:${op}`, version: 1 }])) });
const values = { evaluate(value: any, env: Record<string, any>): any {
  if (typeof value === "string" && value.startsWith("$")) return value.slice(1).split(".").reduce((v, key) => v?.[key], env);
  if (Array.isArray(value)) return value.map(item => this.evaluate(item, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.evaluate(item, env)]));
  return value;
} };
const ref = (runtime: string) => ({ runtime });
const compare = (left: any, operator: "eq" | "gte", right: any) => ({ left, operator, right });
const same = (a: string, b: string) => getAddress(a) === getAddress(b);
const binary = (id: string, model: string, a: any, b: any, capture: string, checks?: any[]) =>
  ({ id, math: { model, inputs: { a, b }, outputs: { value: capture }, ...(checks ? { checks } : {}) } });

function declared(f: Fixture, direction: number): DeclarativeConversionExecution & { version: 2 } {
  const sell = direction === 0;
  const call = (id: string, fn: string, args: any[], save: Record<string, number>, checks?: any[]) => ({ id, static: true as const,
    call: { target: f.target, signature: ABI.getFunction(fn)!.format("full"), args, save, ...(checks ? { checks } : {}) } });
  return { version: 2, settlement: { directOutput: true }, protectedAddresses: [f.target, f.implementation, f.gem, f.stable],
    quoteOutput: { version: 1, steps: [
      call("pause", "paused", [], { paused: 0 }, [compare(ref("paused"), "eq", 0n)]),
      call("preview", sell ? "previewSellGem" : "previewBuyGem", [ref("amountIn"), "$recipient"], { net: 0, fee: 1 },
        [compare(ref("net"), "gte", 1n)]),
      binary("gross", "add", ref("net"), ref("fee"), "gross"),
      call("treasury", "treasury", [], { treasury: 0 }),
      binary("isTreasury", "eq", ref("treasury"), "$recipient", "isTreasury"),
      binary("feeCredit", "mul", ref("fee"), ref("isTreasury"), "feeCredit"),
      binary("received", "add", ref("net"), ref("feeCredit"), "received"),
      call("reserves", "getReserves", [], { reserve: sell ? 0 : 1 }, [compare(ref("reserve"), "gte", ref("gross"))]),
      binary("scaled", "mul", ref("amountIn"), 10n ** BigInt(18 - (sell ? f.gemDecimals : f.stableDecimals)), "wad"),
      call("cap", "maxPerTransaction", [], { cap: 0 }),
      binary("uncapped", "eq", ref("cap"), 0n, "uncapped"),
      binary("unlimited", "mul", ref("uncapped"), MaxUint256, "unlimited"),
      binary("maximum", "add", ref("cap"), ref("unlimited"), "maximum", [compare(ref("maximum"), "gte", ref("wad"))]),
      call("remaining", "getRemainingBlockCapacity", [], { remaining: 0 }, [compare(ref("remaining"), "gte", ref("wad"))]),
    ], result: ref("received") },
    steps: [{ id: "convert", approval: { token: "$route.tokenIn", spender: f.target, mode: "exact-clear", requireBool: true },
      call: { target: f.target, signature: ABI.getFunction(sell ? "sellGem" : "buyGem")!.format("full"), args: ["$recipient", ref("amountIn")] } }],
    effects: [{ kind: "debit", token: "$route.tokenIn", account: "$executor", equals: ref("amountIn") },
      { kind: "credit", token: "$route.tokenOut", account: "$recipient" }],
  };
}
type Fault = "short" | "zero-debit" | "under-debit" | "over-debit" | "native" | "payer-output" | "receiver-input" | "approval";
function environment(f: Fixture, direction: number, recipient: string) {
  const ready = setup(f), r = ready.rs[direction]!;
  return { ready, r, context: { ...ready.input(1n, direction), route: { ...r, adapterId: "psv", target: f.target },
    recipient, minAmountOut: 1n, quotedAmountOut: 999999n } };
}
function execute(f: Fixture, direction: number, amount: bigint, recipient: string,
  kind: "quote-output" | "direct-output" | "default", fault?: Fault, definition = declared(f, direction)) {
  const { ready, r, context } = environment(f, direction, recipient);
  const settlement = kind === "default" ? undefined : { kind, recipient };
  // Any accidental off-chain quote/input access fails even before the VM runs.
  Object.defineProperty(context, "amountIn", { get() { throw new Error("off-chain input read"); }, configurable: true });
  Object.defineProperty(context, "quotedAmountOut", { get() { throw new Error("off-chain quote read"); }, configurable: true });
  const leg = buildDeclarativeRuntimeLeg(definition, Object.assign(context, { settlement }), values, { math });
  assert(leg);
  const balances = new Map<string, bigint>();
  const key = (token: string, owner: string) => token.toLowerCase() + owner.toLowerCase();
  const get = (token: string, owner: string) => balances.get(key(token, owner)) ?? 0n;
  const add = (token: string, owner: string, amount: bigint) => { const n = get(token, owner) + amount; assert(n >= 0n); balances.set(key(token, owner), n); };
  add(r.tokenIn, actor, amount + 101n); add(r.tokenOut, actor, 103n);
  if (!same(actor, recipient)) { add(r.tokenIn, recipient, 107n); add(r.tokenOut, recipient, 10n ** 30n); }
  const initial = new Map(balances); let native = 17n, allowance = 0n, swaps = 0;
  const onCall = (call: RuntimeCall): string => {
    assert.equal(call.value, 0n);
    const c = ABI.parseTransaction({ data: call.data })!;
    if (c.name === "balanceOf") return ABI.encodeFunctionResult(c.name, [get(call.target, c.args[0])]);
    if (c.name === "approve") { assert(!call.static); allowance = c.args[1]; return ABI.encodeFunctionResult(c.name, [fault !== "approval"]); }
    if (call.static) { const result = reads(f, [{ kind: "eth-call", id: "runtime", to: call.target, data: call.data, completion: "return-data" }])[0]; assert(result.ok); return result.data; }
    assert.equal(c.name, direction === 0 ? "sellGem" : "buyGem"); assert.equal(c.args[1], amount); assert(same(c.args[0], recipient));
    assert.equal(allowance, amount); swaps++;
    const preview = direction === 0 ? "previewSellGem" : "previewBuyGem";
    const receipt = reads(f, [{ kind: "eth-call", id: "preview", to: f.target,
      data: ABI.encodeFunctionData(preview, [amount, recipient]), completion: "return-data" }])[0]; assert(receipt.ok);
    const [net, fee] = ABI.decodeFunctionResult(preview, receipt.data);
    const debit = fault === "zero-debit" ? 0n : fault === "under-debit" ? amount - 1n : fault === "over-debit" ? amount + 1n : amount;
    add(r.tokenIn, actor, -debit); add(r.tokenOut, recipient, net - (fault === "short" ? 1n : 0n)); add(r.tokenOut, f.treasury, fee);
    if (fault === "native") native--;
    if (fault === "payer-output") add(r.tokenOut, actor, -1n);
    if (fault === "receiver-input") add(r.tokenIn, recipient, -1n);
    return ABI.encodeFunctionResult(c.name, [net]);
  };
  const result = inspectRuntime(leg.program, amount, { call: onCall, nativeBalance: () => native },
    kind === "quote-output" ? { output: true, readOnly: true } : {});
  if (kind === "quote-output") {
    assert.deepEqual(balances, initial); assert.equal(swaps, 0); assert.equal(allowance, 0n);
    const old = inspectRuntime(hexlify(legacyQuoteProgram(ready.d, r, actor, recipient).bytes()), amount,
      { call: onCall }, { output: true, readOnly: true });
    assert.equal(result.registers[0], old.registers[0]);
    assert.deepEqual(result.calls.map(({ target, data, static: readOnly }) => ({ target, data, readOnly })),
      old.calls.map(({ target, data, static: readOnly }) => ({ target, data, readOnly })));
  } else { assert.equal(swaps, 1); assert.equal(allowance, 0n); assert.equal(get(r.tokenIn, actor), 101n); }
  return { result, leg, balances, initial };
}

for (const direction of [0, 1]) for (const receiver of ["self", "external", "treasury", "exempt"] as const)
  test(`same recipient-sensitive live-input quote as existing PSV: direction ${direction}, ${receiver}`, () => {
    const f = fixture(); f.tin = WAD / 10n; f.tout = WAD / 10n;
    const recipient = receiver === "self" ? actor : receiver === "treasury" ? f.treasury : addr(91);
    if (receiver === "exempt") f.exemptRecipients.add(recipient);
    execute(f, direction, 2000001n, recipient, "quote-output");
    execute(f, direction, 5000019n, recipient, "direct-output");
  });

test("the same quote program preserves decimal scaling and zero-fee behavior in both directions", () => {
  for (const [gemDecimals, stableDecimals] of [[6, 18], [18, 6]]) for (const direction of [0, 1]) {
    const f = fixture(); f.gemDecimals = gemDecimals!; f.stableDecimals = stableDecimals!;
    f.gemReserve = f.stableReserve = 10n ** 35n; f.tin = f.tout = 0n;
    const amount = 3n * 10n ** BigInt(direction === 0 ? gemDecimals! : stableDecimals!);
    execute(f, direction, amount, addr(91), "quote-output"); execute(f, direction, amount, addr(91), "direct-output");
  }
});

test("without a settlement request the quote module adds no calls or byte changes", () => {
  const f = fixture(), d = declared(f, 0), { context } = environment(f, 0, actor);
  const old = { ...d }; delete old.quoteOutput;
  assert.equal(hexlify(buildDeclarativeExecutionProgram(d, context, values, { math }).bytes()),
    hexlify(buildDeclarativeExecutionProgram(old, context, values, { math }).bytes()));
  const run = execute(f, 0, 2000001n, actor, "default");
  assert(!run.result.calls.some(call => ABI.parseTransaction({ data: call.data })!.name.startsWith("preview")));
  assert.deepEqual(declarativeSettlementCapabilities(d, context), { directOutput: true, quoteOutput: true });
  assert.equal(buildDeclarativeRuntimeLeg(old, { ...context, settlement: { kind: "quote-output" } }, values, { math }), null);
});

for (const fault of ["short", "zero-debit", "under-debit", "over-debit", "native", "payer-output", "receiver-input", "approval"] as const)
  test(`direct output rejects ${fault}; large old receipt inventory cannot cover it`, () =>
    assert.throws(() => execute(fixture(), 0, 2000001n, addr(91), "direct-output", fault)));

for (const failure of ["paused", "reserve", "cap", "remaining", "zero", "zero-output"] as const)
  test(`both quote and direct paths reject ${failure} before conversion`, () => {
    const f = fixture(); let amount = 2000001n;
    if (failure === "paused") f.paused = true;
    if (failure === "reserve") f.stableReserve = 0n;
    if (failure === "cap") f.maxPerTransaction = 1n;
    if (failure === "remaining") f.remaining = 1n;
    if (failure === "zero") amount = 0n;
    if (failure === "zero-output") f.tout = WAD;
    // Identity fixtures deliberately remain admissible; mutate dynamic state
    // after obtaining a route so these are execution tests, not admission tests.
    const { context } = environment(fixture(), 0, addr(91)), d = declared(f, 0);
    for (const kind of ["quote-output", "direct-output"]) {
      const p = buildDeclarativeRuntimeLeg(d, { ...context, settlement: { kind, recipient: addr(91) } }, values, { math })!;
      assert.throws(() => inspectRuntime(p.program, amount, { nativeBalance: () => 0n, call(call) {
        assert(call.static, "must reject before mutable call");
        const result = reads(f, [{ kind: "eth-call", id: "read", to: call.target, data: call.data, completion: "return-data" }])[0];
        assert(result.ok); return result.data;
      } }, kind === "quote-output" ? { output: true, readOnly: true } : {}));
    }
  });

test("quote declarations cannot introduce mutable calls, arbitrary opcodes, literal output or captured off-chain amounts", () => {
  const f = fixture(), base = declared(f, 0), { context } = environment(f, 0, actor);
  const mutate = (change: (d: any) => void) => { const d = structuredClone(base); change(d);
    assert.throws(() => buildDeclarativeRuntimeLeg(d, { ...context, settlement: { kind: "quote-output" } }, values, { math })); };
  for (const change of [
    (d: any) => { d.quoteOutput.steps[0].static = false; },
    (d: any) => { d.quoteOutput.steps[0].call.value = 1n; },
    (d: any) => { d.quoteOutput.steps[0].approval = {}; },
    (d: any) => { d.quoteOutput.steps[0].call.callback = {}; },
    (d: any) => { d.quoteOutput.result = { runtime: "amountIn" }; },
    (d: any) => { d.quoteOutput.steps[1].call.args[0] = "$quotedAmountOut"; },
    (d: any) => { d.quoteOutput.steps[1].call.args[0] = 19n; },
    (d: any) => { d.quoteOutput.steps[1].call.save = { amountIn: 0 }; },
    (d: any) => { d.quoteOutput.steps[2].math.outputs.value = "net"; },
    (d: any) => { d.quoteOutput.steps = Array(65).fill(d.quoteOutput.steps[0]); },
  ]) mutate(change);
  assert.throws(() => validateDeclarativeQuoteOutput({}));
  for (const result of [{}, { runtime: "missing" }, { runtime: 7 }])
    assert.throws(() => declarativeSettlementCapabilities({ ...base, quoteOutput: { ...base.quoteOutput!, result } } as any, context));
  const evil = { ...math, expand: () => [{ kind: "call", name: "evil", op: "add", left: 1n, right: 2n }] } as any;
  assert.throws(() => buildDeclarativeRuntimeLeg(base, { ...context, settlement: { kind: "quote-output" } }, values, { math: evil }));
  const wrongOpcode = { ...math, expand: () => [{ name: "evil", op: "call", left: 1n, right: 2n }] } as any;
  assert.throws(() => buildDeclarativeRuntimeLeg(base, { ...context, settlement: { kind: "quote-output" } }, values, { math: wrongOpcode }));
  assert.throws(() => buildDeclarativeQuotedFragment(base, { ...context, amountIn: 7n, settlement: { kind: "quote-output" } }, values, { math }));
});

test("quote-only capability does not grant direct output; raw-native paths stay unsupported", () => {
  const f = fixture(), base = declared(f, 0), { context } = environment(f, 0, actor);
  const quoteOnly = { ...base, settlement: { directOutput: false } };
  assert.deepEqual(declarativeSettlementCapabilities(quoteOnly, context), { quoteOutput: true });
  assert.equal(buildDeclarativeRuntimeLeg(quoteOnly, { ...context, settlement: { kind: "direct-output", recipient: addr(91) } }, values, { math }), null);
  const native = { ...context, route: { ...context.route, tokenIn: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    executionAssets: { input: "native", output: "erc20" } } };
  assert.deepEqual(declarativeSettlementCapabilities(base, native), {});
  for (const kind of ["quote-output", "direct-output"])
    assert.equal(buildDeclarativeRuntimeLeg(base, { ...native, settlement: { kind, recipient: addr(91) } }, values, { math }), null);
});

test("direct quote conservation does not permit budget debit or private quote capture clobber", () => {
  const f = fixture(), base = declared(f, 0), { context } = environment(f, 0, actor);
  const input = { ...context, settlement: { kind: "direct-output", recipient: addr(91) } };
  const budget = structuredClone(base); delete budget.effects[0].equals; budget.effects[0].maximum = ref("amountIn");
  assert.throws(() => buildDeclarativeRuntimeLeg(budget, input, values, { math }), /exact actual input/);
  const clobber = structuredClone(base); clobber.steps[0]!.call.save = { quoteLocalreceived: 0 };
  assert.throws(() => buildDeclarativeRuntimeLeg(clobber, input, values, { math }), /reserved runtime capture/);
});

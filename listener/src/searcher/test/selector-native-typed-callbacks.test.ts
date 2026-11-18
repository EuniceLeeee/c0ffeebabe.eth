import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Interface, getBytes, hexlify, toBeHex } from "ethers";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { defineSelectorFamilyModule } from "../venues/selector-family-module.js";
import { buildDeclarativeRuntimeLeg, declarativeSettlementCapabilities } from "../venues/declarative-execution.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { createDeclarativeRuntimeMathRegistry } from "../venues/declarative-runtime-math.js";
import { createSelectorNativeRuntime } from "../venues/selector-native-runtime.js";
import { selectorNativeCandidateFromCensus } from "../venues/selector-native-discovery.js";
import { selectorNativeProgramKey } from "../venues/selector-native-definition.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";

const a = (n: number) => toBeHex(n, 20), T0 = a(1), T1 = a(2), POOL = a(3), EXECUTOR = a(4), RECEIVER = a(5), PREFIX = a(6);
const erc20 = new Interface(["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)"]);
const continuation = new Interface(["function continueRoute(uint256)"]);
const variants = [
  { selector: "128acb08", callback: "algebraSwapCallback", amountIndex: 2, directionIndex: 1, enabled: true },
  { selector: "24b31a0c", callback: "swapCallback", amountIndex: 1, directionIndex: 2, enabled: false },
];
type Variant = typeof variants[number];
type Mode = "funded" | "direct" | "deferred";

function fixture(variant: Variant) {
  const raw = JSON.parse(readFileSync(new URL(`../venues/selector-native/selector-${variant.selector}-family/selector-${variant.selector}.json`, import.meta.url), "utf8"));
  const module = defineSelectorFamilyModule(raw);
  assert.equal(module.activation.defaultEnabled, variant.enabled);
  const program = (module.definition as any).programs.find((p: any) => JSON.stringify(p.execution).includes(variant.callback));
  assert.ok(program);
  const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {}, programs: {}, ...program.values });
  const math = createDeclarativeRuntimeMathRegistry(program.runtimeMath.models).bind({ version: 1, entries: program.runtimeMath.entries });
  return { module, program, values, math };
}
function execute(variant: Variant, reverse: boolean, mode: Mode, fault?: string) {
  const { module, program, values, math } = fixture(variant);
  const tokenIn = reverse ? T1 : T0, tokenOut = reverse ? T0 : T1;
  const cap = 19n, output = 38n, payment = 11n;
  let actorInput = 101n + (mode === "deferred" ? 0n : cap), actorOutput = 103n, receiverInput = 107n, receiverOutput = 109n;
  let poolInput = 113n, native = 127n, payments = 0, continuations = 0;
  const prefix = new RuntimeAmountProgram().call(PREFIX, continuation.encodeFunctionData("continueRoute", [0n]), { patches: [{ offset: 4, reg: 0 }] }).load(0, 0);
  const context = { target: POOL, descriptor: { pool: POOL, token0: T0, token1: T1 },
    route: { adapterId: `${module.plugin.manifest.familyId}:call`, target: POOL, tokenIn, tokenOut, direction: reverse ? "one-for-zero" : "zero-for-one" },
    executor: EXECUTOR, amountIn: 999n, quotedAmountOut: 999n, minAmountOut: 1n,
    source: { number: 1, hash: `0x${"11".repeat(32)}`, generation: 1 },
    ...(mode === "direct" ? { settlement: { kind: "direct-output", recipient: RECEIVER } }
      : mode === "deferred" ? { settlement: { kind: "deferred-input", paymentAmount: payment, paymentInput: "debt", paymentProgram: hexlify(prefix.bytes()) } } : {}),
  };
  const capabilities = declarativeSettlementCapabilities(program.execution, context, values);
  assert.equal(capabilities.directOutput, true); assert.equal(capabilities.deferredInput?.toLowerCase(), POOL); assert.equal(capabilities.deferredDebtInput, true);
  const leg = buildDeclarativeRuntimeLeg(program.execution, context, values, { math }); assert.ok(leg);
  const frame = reverse ? program.execution.steps[1].frame : program.execution.steps[0].frame;
  const outer = new Interface([frame.call.signature]), callback = new Interface([frame.callback.signature]);
  function token(call: RuntimeCall): string {
    const parsed = erc20.parseTransaction({ data: call.data })!;
    const target = call.target.toLowerCase(), holder = parsed.args[0].toLowerCase();
    if (parsed.name === "balanceOf") return toBeHex(target === tokenIn
      ? holder === POOL ? poolInput : holder === RECEIVER ? receiverInput : actorInput
      : holder === RECEIVER ? receiverOutput : actorOutput, 32);
    assert.equal(target, tokenIn); assert.equal(holder, POOL); payments++;
    actorInput -= parsed.args[1]; poolInput += parsed.args[1]; return toBeHex(1n, 32);
  }
  inspectRuntime(leg.program, fault === "signed-overflow" ? 1n << 255n : cap, { nativeBalance: () => native, call(call) {
    if ([T0, T1].includes(call.target.toLowerCase())) return token(call);
    assert.equal(call.target.toLowerCase(), POOL);
    const args = outer.parseTransaction({ data: call.data })!.args;
    assert.equal(args[0].toLowerCase(), mode === "direct" ? RECEIVER : EXECUTOR);
    assert.equal(args[variant.amountIndex], cap); assert.equal(args[variant.directionIndex], !reverse);
    assert.equal(call.outgoing, 196); assert.equal(call.incoming, 132);
    const payload = args[4], bytes = getBytes(payload), size = Number(BigInt(hexlify(bytes.slice(33, 36))));
    const received = fault === "short-output" ? output - 1n : output;
    if (mode === "direct") receiverOutput += received; else actorOutput += received;
    const debt = fault === "high-debt" ? cap + 1n : fault === "partial-input" ? cap - 1n : cap;
    const out = fault === "wrong-sign" ? output : -output;
    let calldata = callback.encodeFunctionData(variant.callback, reverse ? [out, debt, payload] : [debt, out, payload]);
    if (fault === "wrong-callback") calldata = `0x12345678${calldata.slice(10)}`;
    inspectRuntime(hexlify(bytes.slice(36, 36 + size)), cap, { calldata, nativeBalance: () => native, call(inner) {
      if ([T0, T1].includes(inner.target.toLowerCase())) return token(inner);
      assert.equal(inner.target.toLowerCase(), PREFIX); continuations++;
      assert.equal(continuation.parseTransaction({ data: inner.data })!.args[0], cap);
      actorOutput -= fault === "old-output" ? output + payment : payment;
      if (fault !== "fake-prefix") poolInput += cap;
      return toBeHex(cap, 32);
    } });
    if (fault === "old-input") actorInput--;
    if (fault === "recipient-input") receiverInput--;
    if (fault === "actor-output") actorOutput++;
    if (fault === "native") native--;
    return outer.encodeFunctionResult("swap", reverse ? [-output, debt] : [debt, -output]);
  } });
  assert.equal(actorInput, 101n); assert.equal(native, 127n); assert.equal(receiverInput, 107n);
  assert.equal(actorOutput, 103n + (mode === "direct" ? 0n : mode === "deferred" ? output - payment : output));
  assert.equal(receiverOutput, 109n + (mode === "direct" ? output : 0n));
  assert.equal(poolInput, 113n + cap); assert.equal(payments, mode === "deferred" ? 0 : 1); assert.equal(continuations, mode === "deferred" ? 1 : 0);
}
for (const variant of variants) {
  test(`${variant.callback}: direction binding needs only the actual token pair`, () => {
    const { module, program } = fixture(variant), definition = module.definition as any;
    const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
    const runtime = createSelectorNativeRuntime(definition, program);
    const call = new Interface([definition.signature]);
    const args = [RECEIVER, true, 7n, 0n, "0x"];
    if (variant.amountIndex === 1) [args[1], args[2]] = [args[2]!, args[1]!];
    const census = readySelectorCensusFromTransaction({ chainId: 1, blockNumber: source.number, blockHash: source.hash,
      transactionHash: toBeHex(200, 32), transactionIndex: 0, status: 1, from: RECEIVER, to: POOL,
      input: call.encodeFunctionData("swap", args), logs: [], traces: [] });
    const candidate = selectorNativeCandidateFromCensus(definition, census, census.calls[0]!.id, selectorNativeProgramKey(program));
    assert.ok(candidate);
    const first = runtime.step({ candidate, source, executor: EXECUTOR });
    assert.deepEqual(first.requests.map(request => request.id.split(":").at(-1)), ["token0", "token1"]);
    const tokenPair = new Interface(["function token0() view returns(address)", "function token1() view returns(address)"]);
    const proof = first.decode(first.requests.map((request, index) => ({ id: request.id, ok: true, source,
      completion: "returned" as const, data: tokenPair.encodeFunctionResult(`token${index}`, [index === 0 ? T0 : T1]),
      provenance: { kind: "local-fixture" as const, fingerprint: toBeHex(201 + index, 32) } })));
    const second = runtime.step({ candidate, source, executor: EXECUTOR, evidence: proof });
    assert.equal(second.requests.length, 0);
    const bound = runtime.verify(candidate, second.decode([]));
    assert.equal(bound.descriptor.token0, T0); assert.equal(bound.descriptor.token1, T1);
    assert.equal(bound.descriptor.fee, undefined); assert.equal(bound.descriptor.tickSpacing, undefined);
    assert.deepEqual(bound.innerRoutes.map((route: { tokenIn: string; tokenOut: string }) => [route.tokenIn, route.tokenOut]), [[T0, T1], [T1, T0]]);
  });
  for (const reverse of [false, true]) for (const mode of ["funded", "direct", "deferred"] as const)
    test(`${variant.callback}: ${reverse ? "reverse" : "forward"} ${mode} consumes the new working amount`, () => execute(variant, reverse, mode));
  test(`${variant.callback}: funded callback and receipt faults cannot pass`, () => {
    for (const fault of ["signed-overflow", "high-debt", "partial-input", "wrong-sign", "wrong-callback", "short-output", "old-input", "native"])
      assert.throws(() => execute(variant, false, "funded", fault), fault);
  });
  test(`${variant.callback}: direct receiver and actor inventory remain isolated`, () => {
    for (const fault of ["recipient-input", "actor-output", "short-output"])
      assert.throws(() => execute(variant, true, "direct", fault), fault);
  });
  test(`${variant.callback}: deferred input requires real prefix payment and fresh output`, () => {
    for (const fault of ["fake-prefix", "old-output", "short-output", "old-input", "partial-input"])
      assert.throws(() => execute(variant, false, "deferred", fault), fault);
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { AbiCoder, Interface, concat, getBytes, hexlify, keccak256, toBeHex } from "ethers";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { defineSelectorFamilyModule } from "../venues/selector-family-module.js";
import { buildDeclarativeRuntimeLeg, declarativeSettlementCapabilities } from "../venues/declarative-execution.js";
import { encodePackedByteSlices, encodeCallbackPayload, validateCallbackPayloadLayout } from "../venues/declarative-byte-layout.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { createSelectorNativeRuntime } from "../venues/selector-native-runtime.js";
import { selectorNativeCandidateFromCensus } from "../venues/selector-native-discovery.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";

const coder = AbiCoder.defaultAbiCoder(), a = (n: number) => toBeHex(n, 20), h = (n: number) => toBeHex(n, 32);
const T0 = a(1), T1 = a(2), ROUTER = a(3), EXECUTOR = a(4), RECIPIENT = a(5), MAKER = a(6), REGISTRY = a(7), PREFIX = a(8);
const source = { number: 100, hash: h(100), generation: 1 };
const order = [MAKER, 1n << 254n, "0x12001100"], orderHash = keccak256(coder.encode(["tuple(address,uint256,bytes)"], [order]));
const raw = JSON.parse(readFileSync(new URL("../venues/selector-native/selector-f4d2d412-family/selector-f4d2d412.json", import.meta.url), "utf8"));
const issued = defineSelectorFamilyModule(raw), definition = issued.definition as any, program = definition.programs[0];
const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {}, programs: {}, ...program.values });
const execution = { ...program.execution, quoteOutput: program.quoteOutput };
const swap = new Interface([raw.signature]), quote = new Interface([program.quoteOutput.steps[0].call.signature]);
const callback = new Interface([program.execution.deferred.callback.signature]);
const token = new Interface(["function balanceOf(address) view returns(uint256)", "function approve(address,uint256)", "function allowance(address,address) view returns(uint256)"]);
const prefixAbi = new Interface(["function continueRoute(uint256) returns(uint256)"]);

// Independent pinned format encoder, matching the old typed codec's cumulative
// uint16 slice fields. It does not call the implementation being verified.
function originalTakerData(minimum: bigint, recipient?: string, payload?: string): string {
  const slices = [toBeHex(minimum, 32), recipient ?? "0x", "0x", "0x", "0x", "0x", "0x",
    payload === undefined ? "0x" : coder.encode(["bytes"], [payload]), "0x", "0x"];
  let flags = payload === undefined ? 0x61n : 0x45n, end = 0;
  slices.forEach((slice, i) => { end += getBytes(slice).length; flags |= BigInt(end) << BigInt(16 + 16 * i); });
  return concat([toBeHex(flags, 22), ...slices]);
}
function unpack(data: string): { prefix: bigint; slices: string[] } {
  const bytes = getBytes(data), header = BigInt(hexlify(bytes.slice(0, 22))), slices: string[] = [];
  let start = 0;
  for (let i = 0; i < 10; i++) { const end = Number((header >> BigInt(16 + 16 * i)) & 65535n); assert(end >= start);
    slices.push(hexlify(bytes.slice(22 + start, 22 + end))); start = end; }
  assert.equal(bytes.length, 22 + start);
  return { prefix: header & 65535n, slices };
}
test("bounded packed bytes and nested callback wrapper preserve the original wire layout", () => {
  for (const minimum of [1n, 17n, (1n << 256n) - 1n]) for (const recipient of [undefined, RECIPIENT]) {
    const slices = [toBeHex(minimum, 32), recipient ?? "0x", ...Array(8).fill("0x")];
    assert.equal(encodePackedByteSlices({ prefixBits: 16, offsetBits: 16, prefix: 97, slices }), originalTakerData(minimum, recipient));
    for (const payload of ["0x0e", `0x${"01".repeat(113)}`]) {
      const declared: any = { kind: "packed-slices", prefixBits: 16, offsetBits: 16, prefix: 69,
        slices: slices.map((slice, i) => i === 7 ? { payload: "abi-bytes" } : slice) };
      const encoded = encodeCallbackPayload(declared, payload);
      assert.equal(encoded.data, originalTakerData(minimum, recipient, payload));
      assert.equal(encoded.payloadOffset, 22 + 32 + (recipient ? 20 : 0) + 64);
      assert.equal(hexlify(getBytes(encoded.data).slice(encoded.payloadOffset, encoded.payloadOffset + getBytes(payload).length)), payload);
    }
  }
  assert.throws(() => encodePackedByteSlices({ prefixBits: 16, offsetBits: 16, prefix: 65536, slices: ["0x"] }));
  assert.throws(() => encodePackedByteSlices({ prefixBits: 7, offsetBits: 16, prefix: 1, slices: ["0x"] }));
  assert.throws(() => encodePackedByteSlices({ prefixBits: 8, offsetBits: 8, prefix: 1, slices: [`0x${"ff".repeat(256)}`] }));
  assert.throws(() => encodePackedByteSlices({ prefixBits: 16, offsetBits: 16, prefix: 1, slices: ["0x1"] }));
  for (const slices of [[], ["0x"], [{ payload: "raw" }], [{ payload: "abi-bytes" }, { payload: "abi-bytes" }]])
    assert.throws(() => validateCallbackPayloadLayout({ kind: "packed-slices", prefixBits: 16, offsetBits: 16, prefix: 1, slices }));
  assert.throws(() => encodeCallbackPayload({ kind: "abi-bytes" }, `0x${"ff".repeat(65535)}`));
});

type Mode = "funded" | "direct" | "deferred" | "quote";
function execute(mode: Mode, reverse = false, fault?: string) {
  const inputToken = reverse ? T1 : T0, outputToken = reverse ? T0 : T1, cap = 19n, output = 38n, paymentAmount = 11n;
  let actorIn = 101n + (mode === "deferred" || mode === "quote" ? 0n : cap), actorOut = 103n, recipientIn = 107n, recipientOut = 109n;
  let native = 127n, allowance = 0n, quoteCalls = 0, swapCalls = 0, prefixCalls = 0;
  const paymentProgram = hexlify(new RuntimeAmountProgram().call(PREFIX, prefixAbi.encodeFunctionData("continueRoute", [0n]), { patches: [{ offset: 4, reg: 0 }] }).load(0, 0).bytes());
  const context = { target: ROUTER, descriptor: { target: ROUTER, registry: REGISTRY, maker: MAKER, order, strategyHash: orderHash },
    executor: EXECUTOR, source, route: { adapterId: `${issued.plugin.manifest.familyId}:call`, target: ROUTER, tokenIn: inputToken, tokenOut: outputToken },
    amountIn: 999n, quotedAmountOut: 777n, minAmountOut: 1n,
    ...(mode === "direct" ? { settlement: { kind: "direct-output", recipient: RECIPIENT } }
      : mode === "deferred" ? { settlement: { kind: "deferred-input", paymentAmount, paymentProgram } }
      : mode === "quote" ? { settlement: { kind: "quote-output" } } : {}),
  };
  const leg = buildDeclarativeRuntimeLeg(execution, context, values); assert.ok(leg);
  assert.deepEqual(declarativeSettlementCapabilities(execution, context, values), { directOutput: true, quoteOutput: true, deferredInput: EXECUTOR });
  function tokens(call: RuntimeCall): string {
    const parsed = token.parseTransaction({ data: call.data })!;
    if (parsed.name === "approve") { assert.equal(parsed.args[0].toLowerCase(), ROUTER); allowance = fault === "sticky-allowance" && parsed.args[1] === 0n ? allowance : parsed.args[1]; return "0x"; }
    if (parsed.name === "allowance") return toBeHex(allowance, 32);
    const holder = parsed.args[0].toLowerCase();
    return toBeHex(call.target.toLowerCase() === inputToken ? holder === RECIPIENT ? recipientIn : actorIn : holder === RECIPIENT ? recipientOut : actorOut, 32);
  }
  const result = inspectRuntime(leg.program, cap, { nativeBalance: () => native, call(call) {
    if ([T0, T1].includes(call.target.toLowerCase())) return tokens(call);
    assert.equal(call.target.toLowerCase(), ROUTER);
    const isQuote = call.data.startsWith(quote.getFunction("quote")!.selector), abi = isQuote ? quote : swap;
    const args = abi.parseTransaction({ data: call.data })!.args;
    assert.equal(args[1].toLowerCase(), inputToken); assert.equal(args[2].toLowerCase(), outputToken); assert.equal(args[3], cap);
    assert.equal(keccak256(coder.encode(["tuple(address,uint256,bytes)"], [args[0]])), orderHash);
    const data = args[4], packed = unpack(data);
    if (isQuote) {
      quoteCalls++; assert.equal(call.static, true); assert.equal(packed.prefix, 97n);
      assert.equal(data, originalTakerData(1n, mode === "direct" ? RECIPIENT : undefined));
      return quote.encodeFunctionResult("quote", [cap, output, fault === "quote-hash" ? h(999) : orderHash]);
    }
    swapCalls++; assert.equal(call.static, false);
    if (mode === "direct") recipientOut += fault === "short-output" ? output - 1n : output;
    else actorOut += fault === "short-output" ? output - 1n : output;
    if (mode === "deferred") {
      assert.equal(packed.prefix, 69n);
      const wrapped = packed.slices[7], payload = coder.decode(["bytes"], wrapped)[0], bytes = getBytes(payload);
      assert.equal(data, originalTakerData(1n, undefined, payload));
      const outerOffset = 4 + Number(BigInt(hexlify(getBytes(call.data).slice(132, 164)))) + 32;
      assert.equal(call.outgoing, outerOffset + 22 + 32 + 64); assert.equal(call.incoming, 356);
      assert.equal(bytes[0], 0x0e); assert.equal(BigInt(hexlify(bytes.slice(1, 33))), cap);
      let callbackData = callback.encodeFunctionData("preTransferInCallback", [fault === "maker" ? RECIPIENT : MAKER, fault === "actor" ? RECIPIENT : EXECUTOR,
        fault === "input-token" ? outputToken : inputToken, fault === "output-token" ? inputToken : outputToken,
        fault === "debt" ? cap + 1n : cap, fault === "output" ? output - 1n : output, fault === "callback-hash" ? h(999) : orderHash, wrapped]);
      if (fault === "callback-selector") callbackData = `0x12345678${callbackData.slice(10)}`;
      inspectRuntime(hexlify(bytes.slice(36)), cap, { calldata: callbackData, nativeBalance: () => native, call(inner) {
        if ([T0, T1].includes(inner.target.toLowerCase())) return tokens(inner);
        assert.equal(inner.target.toLowerCase(), PREFIX); prefixCalls++;
        assert.equal(prefixAbi.parseTransaction({ data: inner.data })!.args[0], paymentAmount);
        actorOut -= fault === "old-output" ? paymentAmount + output : paymentAmount;
        if (fault !== "fake-prefix") actorIn += fault === "short-prefix" ? cap - 1n : cap;
        return toBeHex(cap, 32);
      } });
    } else {
      assert.equal(data, originalTakerData(1n, mode === "direct" ? RECIPIENT : undefined));
      assert.equal(call.incoming, 0); assert.equal(call.outgoing, 0);
    }
    assert.equal(allowance, cap); actorIn -= cap;
    if (fault === "old-input") actorIn--;
    if (fault === "native") native--;
    if (fault === "recipient-input") recipientIn--;
    if (fault === "actor-output") actorOut++;
    return swap.encodeFunctionResult("swap", [cap, output, fault === "return-hash" ? h(999) : orderHash]);
  } }, { output: mode === "quote" });
  assert.equal(quoteCalls, mode === "funded" ? 0 : 1); assert.equal(swapCalls, mode === "quote" ? 0 : 1); assert.equal(prefixCalls, mode === "deferred" ? 1 : 0);
  if (mode === "quote") assert.equal(result.registers[0], output);
  assert.equal(actorIn, 101n); assert.equal(actorOut, 103n + (mode === "quote" || mode === "direct" ? 0n : mode === "deferred" ? output - paymentAmount : output));
  assert.equal(recipientIn, 107n); assert.equal(recipientOut, 109n + (mode === "direct" ? output : 0n)); assert.equal(native, 127n); assert.equal(allowance, 0n);
}
for (const reverse of [false, true]) for (const mode of ["funded", "direct", "deferred", "quote"] as const)
  test(`migrated packed swap: ${reverse ? "reverse" : "forward"} ${mode} keeps original amount and settlement behavior`, () => execute(mode, reverse));
test("migrated packed swap rejects callback, order commitment, short receipt and prefix faults", () => {
  for (const fault of ["maker", "actor", "input-token", "output-token", "debt", "output", "callback-hash", "callback-selector", "fake-prefix", "short-prefix", "old-output", "short-output", "old-input", "native", "return-hash", "quote-hash", "sticky-allowance"])
    assert.throws(() => execute("deferred", false, fault), fault);
  for (const fault of ["recipient-input", "actor-output", "short-output", "return-hash"])
    assert.throws(() => execute("direct", true, fault), fault);
});
test("migrated packed swap binds order parameters and physical resources without protocol identity", () => {
  assert.equal(issued.activation.defaultEnabled, false);
  const runtime = createSelectorNativeRuntime(definition, program), registry = new Interface(["function AQUA() view returns(address)"]);
  const census = readySelectorCensusFromTransaction({ chainId: 1, blockNumber: source.number, blockHash: source.hash, transactionHash: h(200), transactionIndex: 0,
    status: 1, from: RECIPIENT, to: ROUTER, input: swap.encodeFunctionData("swap", [order, T0, T1, 7n, originalTakerData(1n)]), logs: [], traces: [] });
  const candidate = selectorNativeCandidateFromCensus(definition, census, census.calls[0].id)!; assert.ok(candidate);
  assert.deepEqual(candidate.immutableParameters.map(p => p.path), [[0]]);
  const first = runtime.step({ candidate, source, executor: EXECUTOR }); assert.equal(first.requests.length, 1); assert.equal(first.requests[0].kind, "eth-call");
  const proof = first.decode([{ id: first.requests[0].id, ok: true, source, completion: "returned", data: registry.encodeFunctionResult("AQUA", [REGISTRY]),
    provenance: { kind: "local-fixture", fingerprint: h(201) } }]);
  const second = runtime.step({ candidate, source, executor: EXECUTOR, evidence: proof }); assert.equal(second.requests.length, 0);
  const bound = runtime.verify(candidate, second.decode([]));
  assert.equal(bound.descriptor.poolId, orderHash); assert.equal(bound.innerRoutes.length, 1); assert.equal(bound.innerRoutes[0].resources.length, 3);
  assert.equal(bound.innerRoutes[0].resource.target, REGISTRY); assert.equal(bound.innerRoutes[0].tokenIn.toLowerCase(), T0);
});

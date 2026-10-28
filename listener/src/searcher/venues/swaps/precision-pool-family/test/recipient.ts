import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { applyRuntimeAssetBoundary, mapRuntimeAssetSettlementRequest } from "../../../../execution-asset-boundary.js";
import { plugin } from "../../../production-families/precision-pool.production.js";
import { descriptor } from "./fixtures.js";
import { runProgram } from "./runtime-machine.js";
import { executionProgram } from "../runtime-execution.js";
import { POOL, WETH, WRAP } from "../codec.js";

const d = descriptor(), actor = "0x1000000000000000000000000000000000000011";
const receiver = "0x2000000000000000000000000000000000000022";
for (const route of plugin.routes.project({ descriptor: d })) for (const recipient of [actor, receiver])
test(`direct settlement raw ABI and shared asset boundary: ${route.zeroForOne ? "native-in" : "native-out"}/${recipient === actor ? "self" : "external"}`, () => {
  const request = { kind: "direct-output" as const, recipient };
  const mapped = mapRuntimeAssetSettlementRequest({ route, executor: actor, request }); assert(mapped);
  const raw = plugin.execution.buildRuntimeLeg({ descriptor: d, route, executor: actor, runtimeEvidence: [], settlement: mapped }); assert(raw);
  assert.deepEqual(raw.settlementRequest, mapped);
  const leg = applyRuntimeAssetBoundary({ route, executor: actor, leg: { ...raw, settlementRequest: request } });
  const input = { pool: d.pool, executor: actor, recipient, rawIn: route.zeroForOne ? d.token0 : d.token1,
    rawOut: route.zeroForOne ? d.token1 : d.token0, amountIn: 1000n, amountOut: 777n,
    nativeBaseline: 991n, oldOutput: 888888n, wrapped: true };
  const bytes = ethers.getBytes(leg.program), result = runProgram(bytes, input);
  assert.equal(result.outputDelta, input.amountOut); assert.equal(result.spent, input.amountIn);
  assert.equal(result.nativeBalance, input.nativeBaseline); assert.equal(result.allowance, 0n);
  assert.deepEqual(result.approvalAmounts, route.zeroForOne ? [] : [0n, input.amountIn, 0n]);
  if (recipient !== actor) {
    assert.equal(result.actorOutput, input.oldOutput); assert.equal(result.recipientInput, result.oldReceiverInput);
    assert.equal(result.recipientNative, result.oldReceiverNative);
  }
  const swap = result.calls.find(c => c.target.toLowerCase() === d.pool && c.data.startsWith(POOL.getFunction("swapExactIn")!.selector)); assert(swap);
  const args = POOL.decodeFunctionData("swapExactIn", swap.data);
  assert.equal(args[1], input.amountIn); assert.equal(args[3].toLowerCase(), route.zeroForOne ? recipient : actor);
  assert.equal(swap.value, route.zeroForOne ? input.amountIn : 0n);
  assert.equal(result.calls.filter(c => c.target.toLowerCase() === WETH && c.data.startsWith(WRAP.getFunction("withdraw")!.selector)).length, route.zeroForOne ? 1 : 0);
  assert.equal(result.calls.filter(c => c.target.toLowerCase() === WETH && c.data.startsWith(WRAP.getFunction("deposit")!.selector)).length, 1);
  for (const fault of [{ spent: 0n }, { spent: input.amountIn - 1n }, { spent: input.amountIn + 1n },
    { deliveredOut: 0n }, { deliveredOut: input.amountOut - 1n }, { deliveredOut: input.amountOut + 1n },
    { nativeResidue: 1n }, { hook: 1n }, { creatorFee: 1n }, { unfunded: true }])
    assert.throws(() => runProgram(bytes, { ...input, ...fault }), undefined, JSON.stringify(fault, (_k, v) => typeof v === "bigint" ? String(v) : v));
  if (!route.zeroForOne) {
    assert.throws(() => runProgram(bytes, { ...input, ignoreApprovalClear: true }), /mismatch/);
    assert.throws(() => runProgram(bytes, { ...input, wrapLoss: 1n }), /mismatch/);
    if (recipient !== actor) assert.throws(() => runProgram(bytes, { ...input, transferLoss: 1n }), /mismatch/);
  }
  if (route.zeroForOne && recipient !== actor) for (const fault of [
    { wrongRecipient: true }, { actorOutputChange: 1n }, { recipientInputChange: -1n }, { recipientNativeChange: 1n },
  ]) assert.throws(() => runProgram(bytes, { ...input, ...fault }), /mismatch|uint256/);
  for (const amountIn of [0n, 1n]) {
    if (amountIn === 0n) assert.throws(() => runProgram(bytes, { ...input, amountIn }), /uint256/);
    else assert.equal(runProgram(bytes, { ...input, amountIn }).spent, 1n);
  }
});

test("unsupported requests, raw native receiver and forged route fail closed without changing the default", () => {
  for (const route of plugin.routes.project({ descriptor: d })) {
    const input = { descriptor: d, route, executor: actor, runtimeEvidence: [] };
    const baseline = plugin.execution.buildRuntimeLeg(input); assert(baseline);
    assert.deepEqual(baseline.settlement, { directOutput: true });
    for (const settlement of [{ kind: "quote-output" as const },
      { kind: "deferred-input" as const, paymentAmount: 1n, paymentProgram: "0x0100" }])
      assert.equal(plugin.execution.buildRuntimeLeg({ ...input, settlement }), null);
    for (const recipient of [ethers.ZeroAddress, d.pool, route.tokenIn, route.tokenOut]) {
      const attempt = () => plugin.execution.buildRuntimeLeg({ ...input, settlement: { kind: "direct-output", recipient } });
      if (route.executionAssets?.output === "native") assert.equal(attempt(), null);
      else assert.throws(attempt, /invalid execution binding/);
    }
    if (route.executionAssets?.output === "native") assert.equal(plugin.execution.buildRuntimeLeg({ ...input,
      settlement: { kind: "direct-output", recipient: receiver } }), null);
    assert.throws(() => plugin.execution.buildRuntimeLeg({ ...input, route: { ...route, executionAssets: undefined } }), /incompatible route/);
    assert.deepEqual(plugin.execution.buildRuntimeLeg(input), baseline);
    const construction: any = { ...input };
    for (const field of ["amountIn", "quotedAmountOut", "minAmountOut", "exactEvidence"])
      Object.defineProperty(construction, field, { get() { throw Error("forbidden construction access " + field); } });
    assert.deepEqual(plugin.execution.buildRuntimeLeg(construction), baseline);
  }
});

test("ERC20 raw direct reuses the existing ABI without introducing a new admitted profile", () => {
  const rawIn = "0x3000000000000000000000000000000000000033", rawOut = d.token1;
  const program = executionProgram({ pool: d.pool, rawIn, rawOut, executor: actor, recipient: receiver, minimum: 1n });
  const input = { pool: d.pool, executor: actor, recipient: receiver, rawIn, rawOut, amountIn: 1000n, amountOut: 777n,
    nativeBaseline: 991n, oldOutput: 888888n };
  const result = runProgram(program, input); assert.equal(result.outputDelta, 777n); assert.equal(result.allowance, 0n);
  for (const fault of [{ nativeResidue: 1n }, { actorOutputChange: 1n }, { recipientInputChange: -1n },
    { recipientNativeChange: 1n }, { wrongRecipient: true }, { ignoreApprovalClear: true }])
    assert.throws(() => runProgram(program, { ...input, ...fault }), /mismatch|uint256/);
});

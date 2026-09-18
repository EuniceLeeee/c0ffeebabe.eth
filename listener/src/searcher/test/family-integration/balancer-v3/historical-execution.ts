import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { plugin } from "../../../venues/production-families/balancer-v3.production.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../venues/production-infra-actions.js";
import { buildExecuteCalldata } from "../../../../shared/executor/botvm-executor.js";
import { concatBytes } from "../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../types.js";
import type { PlanFragment } from "../../../venues/route-leg-adapter.js";
import type { CanonicalSource } from "../../../venues/adapter-request-program.js";
import { VAULT, ROUTER, ROUTER_ABI, PERMIT2, SWAP_ABI, queryData, same } from "../../../venues/swaps/balancer-v3-family/codec.js";

const ERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const PERMIT_ALLOWANCE = new ethers.Interface(["function allowance(address,address,address) view returns (uint160,uint48,uint48)"]);
type Rpc = (method: string, params: unknown[]) => Promise<any>;

// Test-only BotVM installation and caller prefunding. No pool/code/reserve
// overrides, no signer or sendTransaction, and no legacy registry authority.
export async function historicalExecution(input: {
  rpc: Rpc; source: CanonicalSource; header: { timestamp: string; gasLimit: string; baseFeePerGas: string };
  artifactFile: string; executor: string; tokenIn: string; tokenOut: string;
  amountIn: bigint; amountOut: bigint; fragment: PlanFragment;
}) {
  const { rpc, source, executor, tokenIn, tokenOut, amountIn, amountOut } = input;
  const pin = { blockHash: source.hash, requireCanonical: true };
  const owner = "0x1000000000000000000000000000000000000001";
  const raw = readFileSync(input.artifactFile, "utf8");
  const artifact = JSON.parse(raw);
  assert.equal(artifact.metadata ? (typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata)
    .settings.compilationTarget["src/BotVM.sol"] : undefined, "BotVM");
  let code: string = artifact.deployedBytecode.object;
  assert(ethers.isHexString(code) && code.length > 2);
  const immutables = Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
  assert.equal(immutables.length, 1, "only BotVM.owner may be patched");
  for (const reference of immutables[0]) {
    assert.equal(reference.length, 32);
    const start = 2 + reference.start * 2;
    code = code.slice(0, start) + ethers.zeroPadValue(owner, 32).slice(2) + code.slice(start + 64);
  }
  const adapters = [...plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
  const compile = (node: ResolvedPlanNode): Uint8Array => {
    const adapter = adapters.find(action => action.id === node.adapterId); assert(adapter);
    return adapter.encode(node, executor, concatBytes(...node.children.map(compile)));
  };
  assert.equal(input.fragment.requirements.length, 0);
  const script = concatBytes(...input.fragment.nodes.map(compile));
  const calldata = buildExecuteCalldata(script);
  const balanceData = ERC20.encodeFunctionData("balanceOf", [executor]);
  assert.equal(await rpc("eth_getCode", [executor, pin]), "0x", "test actor must be empty at source");
  async function balanceSlot(token: string, probe: bigint): Promise<string> {
    const access = await rpc("eth_createAccessList", [{ from: owner, to: token, data: balanceData, gas: "0x100000" }, ethers.toQuantity(source.number)]);
    const candidates: string[] = (access.accessList ?? []).filter((entry: { address: string }) => same(entry.address, token))
      .flatMap((entry: { storageKeys: string[] }) => entry.storageKeys);
    const abi = ethers.AbiCoder.defaultAbiCoder();
    for (let i = 0; i < 8; i++) candidates.push(ethers.keccak256(abi.encode(["address", "uint256"], [executor, i])));
    for (const candidate of [...new Set(candidates)].slice(0, 12)) {
      try {
        const result = await rpc("eth_call", [{ to: token, data: balanceData }, pin,
          { [token]: { stateDiff: { [candidate]: ethers.toBeHex(probe, 32) } } }]);
        if (ethers.isHexString(result, 32) && BigInt(result) === probe) return candidate;
      } catch (error) {
        if ((error as { code?: string }).code !== "CALL_EXCEPTION") throw error;
      }
    }
    throw new Error("bounded actor-balance slot verification failed");
  }
  const slot = await balanceSlot(tokenIn, amountIn);
  const outputSlot = await balanceSlot(tokenOut, amountOut);
  const stateOverrides = { [owner]: { balance: ethers.toQuantity(100n * 10n ** 18n) }, [executor]: { code },
    [tokenIn]: { stateDiff: { [slot]: ethers.toBeHex(amountIn, 32) } } };
  const transaction = { from: owner, to: executor, data: calldata, gas: "0x300000", gasPrice: input.header.baseFeePerGas };
  const trace = await rpc("debug_traceCall", [transaction, pin,
    { tracer: "callTracer", tracerConfig: { withLog: true }, timeout: "30s", stateOverrides }]);
  const frames: unknown[] = [];
  function collect(frame: any, path: string): void {
    frames.push({ path, type: frame.type, from: frame.from, to: frame.to, input: frame.input,
      output: frame.output, error: frame.error, revertReason: frame.revertReason, logs: frame.logs });
    for (const [index, child] of (frame.calls ?? []).entries()) collect(child, `${path}.${index}`);
  }
  collect(trace, "0");
  const compact = () => frames.map(rawFrame => {
    const frame = rawFrame as { path: string; type: string; from: string; to: string; input: string; output?: string; error?: string; logs?: unknown };
    return { ...frame, input: frame.input.slice(0, 10), inputHash: ethers.keccak256(frame.input) };
  });
  assert(!trace.error, "same-source encoded BotVM execution reverted; inspect retained call trace before changing execution semantics");
  function assertSettlement(root: any): bigint {
    assert(!root.error, "encoded Router execution must succeed");
    const router = root.calls?.[3];
    assert(router && same(router.to, ROUTER) && same(router.from, executor) && !router.error);
    const unlock = router.calls?.find((frame: any) => same(frame.to, VAULT) && frame.input.startsWith("0x48c89491"));
    assert(unlock && !unlock.error && same(unlock.from, ROUTER));
    const callback = unlock.calls?.find((frame: any) => same(frame.to, ROUTER) && same(frame.from, VAULT));
    assert(callback && !callback.error);
    const steps = callback.calls;
    assert.deepEqual(steps.map((step: any) => step.input.slice(0, 10)), ["0x2bfb780c", "0x36c78516", "0x15afd409", "0xae639329"]);
    assert(steps.every((step: any) => !step.error));
    const swapResult = SWAP_ABI.decodeFunctionResult("swap", steps[0].output);
    assert.equal(swapResult[1], amountIn);
    const actualOut = BigInt(swapResult[2]);
    assert.equal(BigInt(router.output), actualOut);
    const swapParams = SWAP_ABI.decodeFunctionData("swap", steps[0].input)[0];
    assert(actualOut >= swapParams.limitRaw);
    const payment = new ethers.Interface(["function transferFrom(address,address,uint160,address)"]).decodeFunctionData("transferFrom", steps[1].input);
    assert(same(steps[1].to, PERMIT2) && same(payment[0], executor) && same(payment[1], VAULT) && same(payment[3], tokenIn));
    assert.equal(payment[2], amountIn);
    assert.equal(BigInt(steps[2].output), amountIn);
    const send = new ethers.Interface(["function sendTo(address,address,uint256)"]).decodeFunctionData("sendTo", steps[3].input);
    assert(same(send[0], tokenOut) && same(send[1], executor)); assert.equal(send[2], actualOut);
    assert.equal(root.calls.length, 6, "approval cleanup must execute after the swap");
    assert(root.calls.every((frame: any) => !frame.error));
    return actualOut;
  }
  assert.equal(assertSettlement(trace), amountOut);
  // Observe actual post-state from the same call at N's exact timestamp, rather
  // than claiming eth_simulateV1's mandatory N+1 context is a same-source call.
  const diff = await rpc("debug_traceCall", [transaction, pin,
    { tracer: "prestateTracer", tracerConfig: { diffMode: true }, timeout: "30s", stateOverrides }]);
  const storage = (side: "pre" | "post", token: string, key: string): bigint =>
    BigInt(diff[side]?.[token.toLowerCase()]?.storage?.[key.toLowerCase()] ?? "0x0");
  assert.equal(storage("pre", tokenIn, slot), amountIn); assert.equal(storage("pre", tokenOut, outputSlot), 0n);
  const inputDelta = storage("post", tokenIn, slot) - storage("pre", tokenIn, slot);
  const outputDelta = storage("post", tokenOut, outputSlot) - storage("pre", tokenOut, outputSlot);
  assert.equal(inputDelta, -amountIn); assert.equal(outputDelta, amountOut, "same-source post-state must match Router quote wei-for-wei");
  const sourceFrames = compact();
  const observer = (token: string) => ({ from: ethers.ZeroAddress, to: token, data: balanceData, gas: "0x100000", gasPrice: "0x0" });
  const blockOverrides = { number: ethers.toQuantity(source.number + 1), time: ethers.toQuantity(BigInt(input.header.timestamp) + 12n),
    gasLimit: input.header.gasLimit, baseFeePerGas: input.header.baseFeePerGas };
  const allowanceCall = { from: ethers.ZeroAddress, to: tokenIn, data: ERC20.encodeFunctionData("allowance", [executor, PERMIT2]), gas: "0x100000", gasPrice: "0x0" };
  const permitAllowanceCall = { ...allowanceCall, to: PERMIT2, data: PERMIT_ALLOWANCE.encodeFunctionData("allowance", [executor, tokenIn, ROUTER]) };
  const request = { blockStateCalls: [{ blockOverrides, stateOverrides,
    calls: [observer(tokenIn), observer(tokenOut), transaction, observer(tokenIn), observer(tokenOut), allowanceCall, permitAllowanceCall] }],
    validation: false, traceTransfers: false, returnFullTransactions: false };
  const results = await rpc("eth_simulateV1", [request, pin]);
  assert.equal(results.length, 1); const calls = results[0].calls;
  assert.equal(calls.length, 7);
  assert(calls.every((call: { status: string }) => call.status === "0x1"), "shifted-time encoded execution and all balance observations must succeed");
  const balance = (index: number): bigint => { assert(ethers.isHexString(calls[index].returnData, 32)); return BigInt(calls[index].returnData); };
  assert.equal(balance(3) - balance(0), -amountIn);
  const shiftedDelta = balance(4) - balance(1);
  assert.equal(balance(5), 0n, "no ERC20 Permit2 allowance may remain");
  assert.equal(PERMIT_ALLOWANCE.decodeFunctionResult("allowance", calls[6].returnData)[0], 0n, "no Router Permit2 allowance may remain");
  const shifted = await rpc("debug_traceCall", [transaction, pin,
    { tracer: "callTracer", tracerConfig: { withLog: true }, timeout: "30s", stateOverrides, blockOverrides }]);
  const shiftedOut = assertSettlement(shifted);
  assert.equal(shiftedDelta, shiftedOut, "actual send amount must equal actual output balance delta");
  assert.notEqual(shiftedOut, amountOut, "rate-change regression must exercise a changed output");
  const shiftedQuote = await rpc("debug_traceCall", [{ from: ethers.ZeroAddress, to: ROUTER,
    data: queryData(String(input.fragment.nodes[0].params.pool), tokenIn, tokenOut, amountIn, executor), gas: "0x300000" }, pin,
    { tracer: "callTracer", timeout: "30s", blockOverrides }]);
  assert(!shiftedQuote.error, "same-context Router quote must succeed");
  assert.equal(BigInt(shiftedQuote.output), shiftedOut, "shifted-time query, execution, sendTo and received balance agree per wei");
  frames.length = 0; collect(shifted, "0");
  const nextBlock = { status: "pass", blockOverrides, actualSwapOutput: String(shiftedOut), outputDelta: String(shiftedDelta),
    inputDelta: String(-amountIn), shiftedQuote: String(BigInt(shiftedQuote.output)), sourceQuote: String(amountOut),
    outputDifferenceFromSourceQuote: String(shiftedOut - amountOut), erc20Allowance: "0", permit2Allowance: "0",
    gasUsed: String(BigInt(calls[2].gasUsed)), frames: compact() };
  // A deliberately impossible minimum must revert the whole encoded sequence.
  // This is an adversarial encoder control, not a fabricated issued Exact.
  const guarded = { ...input.fragment.nodes[0], params: { ...input.fragment.nodes[0].params, minAmountOut: amountOut + 1n } };
  const guardTrace = await rpc("debug_traceCall", [{ ...transaction, data: buildExecuteCalldata(compile(guarded)) }, pin,
    { tracer: "callTracer", timeout: "30s", stateOverrides }]);
  assert(guardTrace.error, "the on-chain minimum-output guard must reject even by one wei");
  const errors: string[] = [];
  const collectErrors = (frame: any): void => { if (frame.error) errors.push(frame.output ?? "0x"); (frame.calls ?? []).forEach(collectErrors); };
  collectErrors(guardTrace);
  assert(errors.some(data => data.startsWith(ethers.id("SwapLimit(uint256,uint256)").slice(0, 10))), "minimum failure must be Vault SwapLimit");
  return { status: "same-source-pass", backend: "debug_traceCall/callTracer+prestateTracer", source, timestamp: input.header.timestamp,
    amountIn: String(amountIn), amountOut: String(amountOut), inputDelta: String(inputDelta), outputDelta: String(outputDelta),
    sourceFrames, nextBlock, minimumOutputGuard: { status: "reverted-as-required", minimum: String(amountOut + 1n), errors }, gasUsed: String(BigInt(trace.gasUsed)), artifactSha256: createHash("sha256").update(raw).digest("hex"),
    scriptHash: ethers.keccak256(script), runtimeCodeHash: ethers.keccak256(code), callerBalanceSlot: slot,
    caveat: "same-source and changed-rate N+1 context both executed; isolated actor code/prefunding only; not Ready, full-route EV or production gap acceptance" };
}

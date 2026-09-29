// Opt-in N/N single-leg helper. The caller must obtain fragment and amounts
// through the current Ready/runtime issuer, and supply a budgeted read-only RPC.
// No edge/admission/quote is constructed here. Only the test actor is funded.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { concatBytes } from "../../../../../encoder.js";
import { buildExecuteCalldata } from "../../../../../shared/executor/botvm-executor.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { plugin } from "../../../production-families/ekubo.production.js";
import type { PlanFragment } from "../../../route-leg-adapter.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { EKUBO_ROUTER } from "../../ekubo/abi.js";
import { same } from "../codec.js";

type Rpc = (method: string, params: unknown[]) => Promise<any>;
export async function verifyHistoricalEkuboParity(input: {
  rpc: Rpc; source: CanonicalSource; header: any; artifactFile: string; workspaceRoot: string;
  executor: string; owner: string; tokenIn: string; tokenOut: string;
  amountIn: bigint; amountOut: bigint; fragment: PlanFragment;
}) {
  const { rpc, source, executor, owner, tokenIn, tokenOut, amountIn, amountOut, fragment } = input;
  assert.equal(Number(input.header.number), source.number); assert.equal(input.header.hash, source.hash);
  const artifact = JSON.parse(readFileSync(input.artifactFile, "utf8"));
  const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert.equal(metadata.settings.compilationTarget["src/BotVM.sol"], "BotVM");
  for (const [path, info] of Object.entries(metadata.sources) as [string, { keccak256: string }][]) {
    assert(path.startsWith("src/") && !path.includes(".."));
    assert.equal(ethers.keccak256(readFileSync(input.workspaceRoot + "/" + path)), info.keccak256, "artifact must match this branch's source");
  }
  const deployed = artifact.deployedBytecode ?? artifact.evm.deployedBytecode;
  let code: string = deployed.object.startsWith("0x") ? deployed.object : "0x" + deployed.object;
  const refs = Object.values(deployed.immutableReferences) as { start: number; length: number }[][];
  assert.equal(refs.length, 1, "only owner may be patched");
  for (const ref of refs[0]) {
    assert.equal(ref.length, 32); const start = 2 + ref.start * 2;
    code = code.slice(0, start) + ethers.zeroPadValue(owner, 32).slice(2) + code.slice(start + 64);
  }
  const pin = { blockHash: source.hash, requireCanonical: true };
  const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
  const balanceData = erc20.encodeFunctionData("balanceOf", [executor]);
  assert.equal(await rpc("eth_getCode", [executor, pin]), "0x", "isolated test executor must be empty at N");
  assert.equal(BigInt(await rpc("eth_call", [{ to: tokenOut, data: balanceData }, pin])), 0n, "output actor balance must start at zero");
  const slots = new Map<string, string>();
  const balanceSlot = async (token: string, probe: bigint): Promise<string> => {
    const prior = slots.get(token.toLowerCase()); if (prior) return prior;
    const access = await rpc("eth_createAccessList", [{ from: owner, to: token, data: balanceData, gas: "0x100000" }, ethers.toQuantity(source.number)]);
    const keys: string[] = (access.accessList ?? []).filter((a: any) => same(a.address, token)).flatMap((a: any) => a.storageKeys);
    for (let i = 0; i < 12; i++) keys.push(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [executor, i])));
    for (const slot of [...new Set(keys)].slice(0, 20)) {
      const out = await rpc("eth_call", [{ to: token, data: balanceData }, pin, { [token]: { stateDiff: { [slot]: ethers.toBeHex(probe, 32) } } }]);
      if (ethers.isHexString(out, 32) && BigInt(out) === probe) { slots.set(token.toLowerCase(), slot); return slot; }
    }
    throw new Error("bounded token balance-slot verification failed");
  };
  const inputSlot = await balanceSlot(tokenIn, amountIn), outputSlot = await balanceSlot(tokenOut, amountOut);
  const actions = [...plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
  const nodes: ResolvedPlanNode[] = fragment.requirements.map(r => {
    assert.equal(r.kind, "approve"); if (r.kind !== "approve") throw new Error("unsupported fragment requirement");
    return { adapterId: "erc20-approve", target: r.token, tokenIn: r.token, tokenOut: r.token, amount: r.amount,
      params: { spender: r.spender, amount: r.amount }, children: [] };
  });
  nodes.push(...fragment.nodes);
  const compile = (node: ResolvedPlanNode): Uint8Array => {
    const action = actions.find(a => a.id === node.adapterId); assert(action);
    return action.encode(node, executor, concatBytes(...node.children.map(compile)));
  };
  const script = concatBytes(...nodes.map(compile));
  const nativeBefore = 17n; // catches sweeping of pre-existing native inventory
  const overrides = { [owner]: { balance: ethers.toQuantity(10n ** 20n) }, [executor]: { code, balance: ethers.toQuantity(nativeBefore) },
    [tokenIn]: { stateDiff: { [inputSlot]: ethers.toBeHex(amountIn, 32) } } };
  const transaction = { from: owner, to: executor, data: buildExecuteCalldata(script), gas: "0x600000", gasPrice: input.header.baseFeePerGas };
  // No blockOverrides: debug_traceCall uses N state AND N timestamp/number.
  const trace = await rpc("debug_traceCall", [transaction, pin, { tracer: "callTracer", timeout: "20s", stateOverrides: overrides }]);
  assert(!trace.error, "encoded Family fragment reverted at N");
  const frames = [trace]; let routerCalls = 0;
  while (frames.length) {
    const frame = frames.pop(); assert(!frame.error, "nested execution failure");
    if (same(frame.to, EKUBO_ROUTER) && same(frame.from, executor)) routerCalls++;
    frames.push(...(frame.calls ?? []));
  }
  assert.equal(routerCalls, 1);
  const diff = await rpc("debug_traceCall", [transaction, pin, { tracer: "prestateTracer", tracerConfig: { diffMode: true }, timeout: "20s", stateOverrides: overrides }]);
  const storage = (side: "pre" | "post", token: string, slot: string) => BigInt(diff[side]?.[token.toLowerCase()]?.storage?.[slot.toLowerCase()] ?? "0x0");
  assert.equal(storage("pre", tokenIn, inputSlot), amountIn);
  assert.equal(storage("pre", tokenOut, outputSlot), 0n);
  const inputDelta = storage("post", tokenIn, inputSlot) - storage("pre", tokenIn, inputSlot);
  const outputDelta = storage("post", tokenOut, outputSlot) - storage("pre", tokenOut, outputSlot);
  const nativeAfter = BigInt(diff.post?.[executor.toLowerCase()]?.balance ?? ethers.toQuantity(nativeBefore));
  assert.equal(inputDelta, -amountIn); assert.equal(outputDelta, amountOut);
  assert.equal(nativeAfter, nativeBefore, "native conversion must not leave residual or use starting inventory");
  // Independent balance result must reject even a one-wei underreported claim.
  assert.throws(() => assert.equal(outputDelta, amountOut - 1n));
  return { source, executionBlock: source.number, timestamp: input.header.timestamp, tokenIn, tokenOut, amountIn, amountOut,
    inputDelta, outputDelta, nativeBefore, nativeAfter, signedDelta: outputDelta - amountOut,
    scriptHash: ethers.keccak256(script), runtimeHash: ethers.keccak256(code), compiler: metadata.compiler.version,
    trace, diff, scope: "isolated-actor N/N single-leg; not original transaction prestate or full-route/final-EV proof" };
}

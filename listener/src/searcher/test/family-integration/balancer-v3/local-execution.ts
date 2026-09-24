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
import { same } from "../../../venues/swaps/balancer-v3-family/codec.js";

type Rpc = (method: string, params: unknown[]) => Promise<any>;
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);

/** Test-only actor prefunding/code. The supplied RPC must enforce loopback and
 * read-only methods. No timestamp, pool, reserve or rate-provider overrides. */
export async function localExecution(input: {
  rpc: Rpc; source: CanonicalSource; timestamp: string; baseFeePerGas: string;
  artifactFile: string; executor: string; tokenIn: string; tokenOut: string;
  amountIn: bigint; amountOut: bigint; fragment: PlanFragment;
}) {
  const { rpc, source, executor, tokenIn, tokenOut, amountIn, amountOut } = input;
  const pin = { blockHash: source.hash, requireCanonical: true };
  const owner = "0x1000000000000000000000000000000000000001";
  const raw = readFileSync(input.artifactFile, "utf8"), artifact = JSON.parse(raw);
  const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert.equal(metadata?.settings.compilationTarget["src/BotVM.sol"], "BotVM");
  let code: string = artifact.deployedBytecode.object;
  assert(ethers.isHexString(code) && code.length > 2);
  const immutableGroups = Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
  assert.equal(immutableGroups.length, 1, "only BotVM.owner may be patched");
  for (const reference of immutableGroups[0]) {
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
  const balanceData = ERC20.encodeFunctionData("balanceOf", [executor]);
  assert.equal(await rpc("eth_getCode", [executor, pin]), "0x", "test actor must have no source code");
  for (const token of [tokenIn, tokenOut]) {
    assert.equal(BigInt(await rpc("eth_call", [{ to: token, data: balanceData }, pin])), 0n,
      "test actor must have no original token balance");
  }
  async function balanceSlot(token: string): Promise<string> {
    const probe = 717171717171n;
    const access = await rpc("eth_createAccessList", [{ from: owner, to: token, data: balanceData,
      gas: "0x100000" }, ethers.toQuantity(source.number)]);
    const candidates: string[] = (access.accessList ?? []).filter((entry: { address: string }) => same(entry.address, token))
      .flatMap((entry: { storageKeys: string[] }) => entry.storageKeys);
    for (let i = 0; i < 8; i++) candidates.push(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [executor, i])));
    for (const candidate of [...new Set(candidates)].slice(0, 12)) {
      try {
        const observed = await rpc("eth_call", [{ to: token, data: balanceData }, pin,
          { [token]: { stateDiff: { [candidate]: ethers.toBeHex(probe, 32) } } }]);
        if (ethers.isHexString(observed, 32) && BigInt(observed) === probe) return candidate;
      } catch (error) { if ((error as { code?: string }).code !== "CALL_EXCEPTION") throw error; }
    }
    throw new Error("bounded independent actor balance-slot verification failed");
  }
  const inputSlot = await balanceSlot(tokenIn), outputSlot = await balanceSlot(tokenOut);
  const stateOverrides = { [owner]: { balance: ethers.toQuantity(100n * 10n ** 18n) }, [executor]: { code },
    [tokenIn]: { stateDiff: { [inputSlot]: ethers.toBeHex(amountIn, 32) } } };
  const transaction = { from: owner, to: executor, data: buildExecuteCalldata(script), gas: "0x600000",
    gasPrice: input.baseFeePerGas };
  const trace = await rpc("debug_traceCall", [transaction, pin,
    { tracer: "callTracer", timeout: "30s", stateOverrides }]);
  assert(!trace.error, "same-source encoded BotVM execution reverted");
  const diff = await rpc("debug_traceCall", [transaction, pin,
    { tracer: "prestateTracer", tracerConfig: { diffMode: true }, timeout: "30s", stateOverrides }]);
  assert(diff && typeof diff.pre === "object" && typeof diff.post === "object", "actual prestate diff is required");
  const observe = (token: string, slot: string, initial: bigint) => {
    const pre = diff.pre[token.toLowerCase()]?.storage ?? {};
    const post = diff.post[token.toLowerCase()]?.storage ?? {};
    const key = slot.toLowerCase();
    const presentBefore = Object.hasOwn(pre, key), presentAfter = Object.hasOwn(post, key);
    // diffMode omits unchanged keys from BOTH sides. A missing key means zero
    // only when the OTHER side proves creation/deletion of this exact key.
    const before = presentBefore ? BigInt(pre[key]) : presentAfter ? 0n : initial;
    const after = presentAfter ? BigInt(post[key]) : presentBefore ? 0n : initial;
    assert.equal(before, initial, "trace prestate differs from independently established actor balance");
    return { before, after, changed: presentBefore || presentAfter };
  };
  const inputBalance = observe(tokenIn, inputSlot, amountIn), outputBalance = observe(tokenOut, outputSlot, 0n);
  assert(inputBalance.changed && outputBalance.changed, "both actor balance slots must actually change");
  const inputDelta = inputBalance.after - inputBalance.before;
  const outputDelta = outputBalance.after - outputBalance.before;
  assert.equal(inputDelta, -amountIn);
  assert.equal(outputDelta, amountOut, "independently observed output balance must equal local quote per wei");
  // Wrong expected output is caught above, and a one-wei-too-high minimum must
  // also reject the actual encoded operation. No modified Exact is issued.
  assert.equal(input.fragment.nodes.length, 1);
  const guarded = { ...input.fragment.nodes[0], params: { ...input.fragment.nodes[0].params, minAmountOut: amountOut + 1n } };
  const negative = await rpc("debug_traceCall", [{ ...transaction, data: buildExecuteCalldata(compile(guarded)) }, pin,
    { tracer: "callTracer", timeout: "30s", stateOverrides }]);
  assert(negative.error, "one-wei-too-high on-chain minimum must reject");
  const errors: string[] = [];
  const collect = (frame: any): void => { if (frame.error) errors.push(frame.output ?? "0x"); (frame.calls ?? []).forEach(collect); };
  collect(negative);
  assert(errors.some(value => value.startsWith(ethers.id("SwapLimit(uint256,uint256)").slice(0, 10))));
  return { status: "same-source-encoded-balance-parity-pass", source, timestamp: input.timestamp,
    amountIn: String(amountIn), amountOut: String(amountOut), inputDelta: String(inputDelta), outputDelta: String(outputDelta),
    observedBalances: { input: { before: String(inputBalance.before), after: String(inputBalance.after) },
      output: { before: String(outputBalance.before), after: String(outputBalance.after) } },
    minimumOutputGuard: "one-wei-above-rejected", scriptHash: ethers.keccak256(script), runtimeCodeHash: ethers.keccak256(code),
    artifactSha256: createHash("sha256").update(raw).digest("hex"), gasUsed: String(BigInt(trace.gasUsed)),
    caveat: "local fork at N/hash/timestamp; actor code/input balance only; not original TX pre-state or full-route final sim/EV" };
}

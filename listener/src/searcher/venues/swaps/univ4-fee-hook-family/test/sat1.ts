import assert from "node:assert/strict";
import { ethers } from "ethers";
import { createUniv4FeeHookExact } from "../exact.js";
// Keep the explicit Quoter reference mode covered alongside local tests.
const exact = createUniv4FeeHookExact("quoter");
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { plugin } from "../../../production-families/univ4-fee-hook.production.js";
import { SAT1, SAT1_HOOK_CODE_HASH, SAT1_TOKEN_CODE_HASH, hookDataFor } from "../sat1.js";
import { sat1IdentityVariant } from "../sat1-identity.js";
import { UNIV4_POOL_MANAGER_INTERFACE, UNIV4_QUOTER_INTERFACE } from "../../univ4-abi.js";
import { UNIV4_FEE_HOOK_PATTERN_IDS } from "../manifest.js";
import { v4PoolId } from "../../univ4-common.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";

const settlementAbi = new ethers.Interface(["function unlock(bytes) returns(bytes)", "function take(address,address,uint256)"]);
function quotedCalls(node: ResolvedPlanNode, amount: bigint, output: bigint, zero: boolean) {
  assert.equal(node.amount, amount);
  assert.equal(node.children.length, 0);
  assert.equal(typeof node.params.runtimeAmountProgram, "string");
  const unlock = inspectRuntime(String(node.params.runtimeAmountProgram), amount).calls[0];
  assert.equal(unlock.incoming, 68); assert.equal(unlock.outgoing, 68);
  const script = ethers.getBytes(settlementAbi.decodeFunctionData("unlock", unlock.data)[0]);
  assert.equal(script[0], 0x0e); assert.equal(BigInt(ethers.hexlify(script.slice(1, 33))), amount);
  const size = Number(BigInt(ethers.hexlify(script.slice(33, 36))));
  return inspectRuntime(ethers.hexlify(script.slice(36, 36 + size)), amount, { call(call) {
    if (call.data.startsWith(UNIV4_POOL_MANAGER_INTERFACE.getFunction("swap")!.selector)) {
      return ethers.concat((zero ? [-amount, output] : [output, -amount]).map(n => ethers.toBeHex(BigInt.asUintN(128, n), 16)));
    }
    return ethers.toBeHex(amount, 32);
  } }).calls;
}

// Source-shaped synthetic checks, not historical strict receipts.
const hook = "0x2a0a30dd78af7698e6f40212b8b8324fce2ee888", token = "0x8f66337a0c2a02202fd91dd596c411cf977c6060";
const executor = "0x1111111111111111111111111111111111111111", other = "0x2222222222222222222222222222222222222222";
const source = { number: 26029537, hash: ethers.id("sat1-synthetic"), generation: 1 };
const key = { currency0: ethers.ZeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: hook };
const poolId = v4PoolId(key);
const log = UNIV4_POOL_MANAGER_INTERFACE.encodeEventLog(UNIV4_POOL_MANAGER_INTERFACE.getEvent("Initialize")!,
  [poolId, key.currency0, key.currency1, key.fee, key.tickSpacing, hook, 1n << 96n, 0]);
const candidate = plugin.discovery.decodeCandidate({ matchedPatternId: UNIV4_FEE_HOOK_PATTERN_IDS.initialize,
  observation: { kind: "log", source, address: ADDR.UNISWAP_V4_POOL_MANAGER, topics: log.topics, data: log.data } });
assert(candidate);
const evidence = { source, managerCodeHash: ethers.id("manager-fixture"), hookCodeHash: SAT1_HOOK_CODE_HASH,
  tokenCodeHash: SAT1_TOKEN_CODE_HASH, manager: ADDR.UNISWAP_V4_POOL_MANAGER, token, minter: hook,
  genesis: 25044547n, initialized: true, sqrtPriceX96: 1n << 96n };
const decide = (proof = evidence) => sat1IdentityVariant.decide({ candidate, step: 1, evidence: proof });
const verified = decide();
assert(verified.status === "verified");
assert.equal(decide({ ...evidence, hookCodeHash: ethers.id("unknown") }).status, "chain-proven-rejected");
assert.equal(decide({ ...evidence, minter: other }).status, "chain-proven-rejected");
assert.equal(decide({ ...evidence, sqrtPriceX96: 0n }).status, "retryable");
assert.equal(decide({ ...evidence, source: { ...source, number: Number(evidence.genesis) + 99 } }).status, "retryable");
const descriptor = plugin.instance.finalizeDescriptor({ identity: verified.identity,
  draft: plugin.instance.compileDraft(verified.identity), sharedBindings: [] });
assert.equal(descriptor.hookModel, "sat1");
const buyData = hookDataFor(descriptor, executor, true);
const sellData = hookDataFor(descriptor, executor, false);
assert.equal(ethers.AbiCoder.defaultAbiCoder().decode(["address"], buyData)[0], executor);
assert.notEqual(buyData, sellData, "same-transaction buy and sell use distinct cooldown keys");
assert.equal(sellData, hookDataFor(descriptor, executor, false), "stable across quote/execution calls");
assert.notEqual(sellData, hookDataFor(descriptor, other, false), "sell identity binds executor");
assert.notEqual(sellData, hookDataFor({ ...descriptor, hook: other }, executor, false), "sell identity binds hook");
assert.equal(hookDataFor({ hookModel: undefined, hook }, executor, false), "0x", "ordinary fee-hook unchanged");
assert(descriptor.runtimeRequirements.some(r => r.kind === "extension-policy" && r.mode === "quote-and-final-sim"));
const routes = plugin.routes.project({ descriptor });
assert.equal(routes.length, 2);
const pricing = plugin.pricing.finalizePricingDescriptor({ draft: plugin.pricing.compileDraft({
  descriptor, routes, stateKey: poolId }), sharedBindings: [] });
const reads = plugin.pricing.current.buildRequests({ descriptor: pricing, routes, source });
assert.equal(reads.length, 5);
const values: Record<string, bigint | boolean> = { ethCum: 24n * 10n ** 18n, marginalPrice: 15_278_138_135_087n,
  totalMintedFair: 1_656_190n * 10n ** 18n, totalSupply: 1_700_000n * 10n ** 18n, selfDeprecated: false };
const returned = (id: string, data: string): AdapterRequestResult => ({ id, source, ok: true, completion: "returned", data,
  provenance: { kind: "fixture", fingerprint: "not-chain-evidence" } });
const results = reads.map(r => returned(r.id, SAT1.encodeFunctionResult(r.id.slice(5), [values[r.id.slice(5)]])));
const snapshot = plugin.pricing.current.decodeSnapshot({ descriptor: pricing, initialResults: results, dependentEvidence: [] });
const mids = plugin.pricing.current.deriveMids({ descriptor: pricing, routes, snapshot });
assert.equal(mids.size, 2, "zero V4 liquidity does not disable a mint/burn hook");
if (!("kind" in snapshot)) throw new Error("missing Sat1 snapshot");
for (const zero of [{ actualSupply: 0n }, { actualSupply: 0n, fairSupply: 0n, ethCum: 0n }]) {
  const empty = { ...snapshot, ...zero };
  const available = plugin.pricing.current.deriveMids({ descriptor: pricing, routes, snapshot: empty });
  assert.equal(available.size, 1, "mint buy needs no existing inventory");
  assert(available.has(routes.find(r => r.direction === "zero-for-one")!.routeKey));
  const unavailable = plugin.pricing.current.classifyUnavailable!({ descriptor: pricing, routes, snapshot: empty });
  assert.equal(unavailable.size, 1);
  assert(unavailable.has(routes.find(r => r.direction === "one-for-zero")!.routeKey));
}
assert.throws(() => plugin.pricing.current.decodeSnapshot({ descriptor: pricing,
  initialResults: results.map((r, i) => i ? r : { ...r, source: { ...source, number: 1 } }), dependentEvidence: [] }), /source/);
for (const route of routes) {
  const input = { descriptor, route, source, executor, runtimeEvidence: [], amountIn: 10n ** 15n };
  const method = exact.methods(input)[1];
  assert(method.kind === "request-program");
  const request = method.program.buildRequests(input)[0];
  assert(request.kind === "eth-call");
  const args = UNIV4_QUOTER_INTERFACE.decodeFunctionData("quoteExactInputSingle", request.data)[0];
  const zeroForOne = route.direction === "zero-for-one";
  assert.equal(args.hookData, hookDataFor(descriptor, executor, zeroForOne));
  const quote = method.program.decode({ programInput: input, dependentEvidence: [], initialResults: [returned(request.id,
    UNIV4_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [123n, 99000n]))] });
  const execution = { ...input, quotedAmountOut: quote.amountOut, exactEvidence: quote.evidence, minAmountOut: quote.amountOut };
  const fragment = plugin.execution.buildFragment(execution);
  const calls = quotedCalls(fragment.nodes[0], input.amountIn, quote.amountOut, zeroForOne);
  const emittedSwap = calls.find(c => c.data.startsWith(UNIV4_POOL_MANAGER_INTERFACE.getFunction("swap")!.selector))!;
  const call = UNIV4_POOL_MANAGER_INTERFACE.decodeFunctionData("swap", emittedSwap.data);
  const swap: ResolvedPlanNode = { adapterId: "univ4-fee-hook-swap", target: descriptor.managerBinding.manager,
    tokenIn: route.tokenIn, tokenOut: route.tokenOut, amount: input.amountIn, children: [], params: {
      currency0: call[0].currency0, currency1: call[0].currency1, fee: BigInt(call[0].fee), tickSpacing: BigInt(call[0].tickSpacing),
      hooks: call[0].hooks, zeroForOne, amountSpecified: call[1].amountSpecified, sqrtPriceLimit: call[1].sqrtPriceLimitX96,
      hookData: call[2],
    } };
  const action = plugin.actionAdapters.find(a => a.id === swap.adapterId)!;
  const encoded = action.encode(swap, executor, new Uint8Array());
  assert.equal(ethers.hexlify(encoded.slice(24)), emittedSwap.data, "legacy leaf retains the same validated hookData");
  assert.equal(call[2], hookDataFor(descriptor, executor, zeroForOne));
  assert.equal(quote.evidence.hookData, call[2]);
  const cacheProjection = exact.cacheCompatibilityProjection(input) as { hookData: string };
  assert.equal(cacheProjection.hookData, call[2]);
  const wrongData = hookDataFor(descriptor, executor, !zeroForOne);
  assert.throws(() => plugin.execution.buildFragment({ ...execution,
    exactEvidence: { ...quote.evidence, hookData: wrongData } }), /incompatible/);
  assert.throws(() => action.encode({ ...swap, params: { ...swap.params, hookData: wrongData } }, executor, new Uint8Array()), /actor/);
  assert.throws(() => action.encode({ ...swap, params: { ...swap.params, zeroForOne: "false" } }, executor, new Uint8Array()), /actor/);
  assert.throws(() => action.encode(swap, other, new Uint8Array()), /actor/);
  assert.throws(() => plugin.execution.buildFragment({ ...execution, executor: other }), /incompatible/);
  for (const minAmountOut of [-1n, quote.amountOut + 1n])
    assert.throws(() => plugin.execution.buildFragment({ ...execution, minAmountOut }), /incompatible/);
  assert.notDeepEqual(exact.cacheCompatibilityProjection(input), exact.cacheCompatibilityProjection({ ...input, executor: other }));
  if (route.direction === "zero-for-one") assert.throws(() => method.program.buildRequests({ ...input, amountIn: 6n * 10n ** 18n }), /MAX_BUY/);
}
const dependencies = plugin.pricing.dependencies({ descriptor: pricing, routes });
const index = plugin.pricing.mutation!.compile!({ entries: [{ stateKey: poolId, descriptor: pricing, routes, dependencies }] });
for (const address of [hook, token, other]) {
  const observation = { kind: "log" as const, source, address, topics: [], data: "0x" };
  const expected = address === other ? [] : [poolId];
  assert.deepEqual(index.affectedStateKeys({ observation }), expected);
  assert.deepEqual(plugin.pricing.mutation!.affectedStateKeys({ descriptor: pricing, routes, observation }), expected);
}
{
  const buy = routes.find(r => r.direction === "zero-for-one")!;
  const sell = routes.find(r => r.direction === "one-for-zero")!;
  const prefix = [{ descriptor, route: buy, amountIn: 1000n, amountOut: 2000n }];
  const input = { descriptor, route: sell, source, executor, runtimeEvidence: [], amountIn: 2000n, prefix };
  const method = exact.methods(input)[1]!;
  assert(method.kind === "request-program" && method.sequentialPrefix === true);
  const iface = new ethers.Interface([
    "function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256 amountOut,uint256 gasEstimate)",
  ]);
  const request = method.program.buildRequests(input)[0]!;
  assert(request.kind === "eth-call");
  const params = iface.decodeFunctionData("quoteExactInput", request.data)[0];
  assert.equal(params.exactAmount, 1000n, "replay starts at the original trial input, not second-leg input");
  assert.equal(params.path.length, 2);
  assert.equal(params.path[0].hookData, buyData);
  assert.equal(params.path[1].hookData, sellData);
  assert.equal(params.path[1].intermediateCurrency, ethers.ZeroAddress);
  const quote = method.program.decode({ programInput: input, dependentEvidence: [],
    initialResults: [returned(request.id, iface.encodeFunctionResult("quoteExactInput", [1010n, 170000n]))] });
  assert.equal(quote.evidence.amountIn, 2000n, "execution evidence stays bound to this leg's input");
  assert.equal(quote.amountOut, 1010n);
  const fragment = plugin.execution.buildFragment({ ...input, quotedAmountOut: quote.amountOut,
    exactEvidence: quote.evidence, minAmountOut: quote.amountOut });
  const calls = quotedCalls(fragment.nodes[0], input.amountIn, 1017n, false);
  const take = calls.find(c => c.data.startsWith(settlementAbi.getFunction("take")!.selector))!;
  assert.equal(settlementAbi.decodeFunctionData("take", take.data)[2], 1017n,
    "take consumes actual PoolManager output, not the sequential quote's 1010");
  assert(!calls.some(c => c.target.toLowerCase() === ADDR.WETH.toLowerCase()),
    "native conversion belongs to the common issuer, never a quoted wrap quantity");
  assert.deepEqual(sell.executionAssets, { input: "erc20", output: "native" });
  assert.throws(() => method.program.buildRequests({ ...input, amountIn: 2001n }), /mismatch/);
  const unsupportedDescriptor = { ...descriptor, hookModel: undefined };
  const unsupportedInput = { ...input, prefix: [{ ...prefix[0]!, descriptor: unsupportedDescriptor }] };
  const unsupportedMethods = exact.methods(unsupportedInput);
  assert.equal(unsupportedMethods.length, 1, "method declaration stays nonempty");
  assert(unsupportedMethods.every(m => m.kind !== "request-program"), "no sequential method: neutral runtime route rejection");
  assert.throws(() => method.program.buildRequests(unsupportedInput), /unsupported/);
  assert.throws(() => method.program.buildRequests({ ...input,
    prefix: [{ ...prefix[0]!, descriptor: { ...descriptor, instanceKey: "foreign" as typeof descriptor.instanceKey } }] }), /unsupported/);
  const initial = method.program.buildRequests({ ...input, prefix: undefined })[0]!;
  assert(initial.kind === "eth-call");
  assert.equal(UNIV4_QUOTER_INTERFACE.parseTransaction({ data: initial.data })!.name, "quoteExactInputSingle",
    "effective and ordinary single-leg queries remain unchanged");
  assert.notEqual(initial.data, request.data, "physical cache requests isolate starting-state and sequential quotes");
}
console.log("Sat1 nomination/identity, pricing, actor binding, sequential Quoter/settlement and refresh PASS (synthetic)");

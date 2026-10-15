import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { plugin } from "../../../production-families/univ4-fee-hook.production.js";
import { v4PoolId } from "../../univ4-common.js";
import { declareRequestProgram, physicalAdapterRequestFingerprint } from "../../../adapter-request-program.js";
import { materializeAdapterRequests } from "../../../../reth-adapter-work-runtime.js";
import { UNIV4_FEE_HOOK_ADDRESS, UNIV4_FEE_HOOK_CODE_HASH } from "../manifest.js";
import { univ4FeeHookIdentity } from "../identity.js";
import { tieredExecutorProgram, tieredActorContext } from "../tiered-exact.js";
import { createUniv4FeeHookExact } from "../exact.js";
const source = { number: 25811499, hash: ethers.id("tiered-unit-state"), generation: 1 };
const executor = "0x1000000000000000000000000000000000000002", transactionOrigin = "0x1000000000000000000000000000000000000001";
function fixture(native = false) {
  const poolKey = { currency0: native ? ethers.ZeroAddress : "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    currency1: native ? "0xdac17f958d2ee523a2206206994597c13d831ec7" : ADDR.WETH.toLowerCase(), fee: 8388608, tickSpacing: 10, hooks: UNIV4_FEE_HOOK_ADDRESS };
  const candidate = { candidateKind: "univ4-pool-key" as const, sourceKind: "pool-surface" as const,
    manager: ADDR.UNISWAP_V4_POOL_MANAGER, poolId: v4PoolId(poolKey), poolKey };
  const decision = univ4FeeHookIdentity.variants[0]!.decide({ candidate, step: 1, evidence: {
    phase: "fee-hook-active-proof", managerCodeHash: ethers.id("manager-unit"), hookCodeHash: UNIV4_FEE_HOOK_CODE_HASH,
    sqrtPriceX96: 1n << 96n, liquidity: 1000000n,
  } });
  assert.equal(decision.status, "verified"); if (decision.status !== "verified") throw new Error("unit identity");
  const descriptor = plugin.instance.finalizeDescriptor({ identity: decision.identity, draft: plugin.instance.compileDraft(decision.identity), sharedBindings: [] });
  const route = plugin.routes.project({ descriptor })[0]!;
  return { descriptor, route, amountIn: 4000000000000000n, source, executor, transactionOrigin, runtimeEvidence: [] };
}
function results(i: ReturnType<typeof fixture>) {
  return [{ id: "tiered-executor-receipt", ok: true as const, source, completion: "returned" as const, data: "0x",
    provenance: { kind: "fixture", fingerprint: "not-chain-evidence" }, effects: {
      tokenDeltas: [{ token: i.route.tokenIn, account: executor, delta: -i.amountIn }, { token: i.route.tokenOut, account: executor, delta: 9352406n }],
      nativeDeltas: [{ account: executor, delta: 0n }],
    } }];
}
test("tiered defaults to real executor receipt; diagnostic quoter explicit and prefix not ignored", () => {
  const i = fixture(), exact = createUniv4FeeHookExact();
  assert(exact.methods(i).some(m => m.id === "tiered-executor-receipt"));
  assert(!exact.methods(i).some(m => m.id === "univ4-fee-hook-quoter"));
  assert(createUniv4FeeHookExact("local", "quoter").methods(i).some(m => m.id === "univ4-fee-hook-quoter"));
  assert(!exact.methods({ ...i, prefix: [{ ...i, amountOut: 100n }] }).some(m => m.id === "tiered-executor-receipt"));
  const req = tieredExecutorProgram.buildRequests(i)[0]!; assert(req.kind === "effect-delta-simulation");
  assert.equal(req.call.executionMode, "executor-program"); assert.deepEqual(req.call.caller, { kind: "executor" }); assert.equal(req.call.to, executor);
  assert.deepEqual(req.overrideIntent.tokenBalances, [{ token: i.route.tokenIn, amount: i.amountIn }]);
  assert.equal(req.preCalls, undefined); assert.equal(req.executionAssetBoundary, undefined);
  const q = tieredExecutorProgram.decode({ programInput: i, initialResults: results(i), dependentEvidence: [] });
  assert.equal(q.amountOut, 9352406n); assert.equal(q.evidence.executor, executor); assert.equal(q.evidence.transactionOrigin, transactionOrigin);
  assert.equal(q.evidence.kind, "tiered-executor-receipt");
  assert.throws(() => tieredExecutorProgram.buildRequests({ ...i, transactionOrigin: undefined }));
  for (const n of [0n, 1n, 2n]) assert.throws(() => tieredActorContext({ executor, transactionOrigin: ethers.toBeHex(n, 20) }));
});
test("tiered rejects zero/short/excess debit, zero output, ambiguous actor, native loss and reverts", () => {
  const i = fixture();
  for (const mutate of [
    (r: any) => r.effects.tokenDeltas[0].delta = 0n,
    (r: any) => r.effects.tokenDeltas[0].delta = -i.amountIn + 1n,
    (r: any) => r.effects.tokenDeltas[0].delta = -i.amountIn - 1n,
    (r: any) => r.effects.tokenDeltas[1].delta = 0n,
    (r: any) => r.effects.tokenDeltas[1].account = transactionOrigin,
    (r: any) => r.effects.tokenDeltas.push(r.effects.tokenDeltas[0]),
    (r: any) => r.effects.nativeDeltas[0].delta = -1n,
    (r: any) => r.completion = "reverted-as-declared",
    (r: any) => r.data = ethers.toBeHex(9352406, 32),
  ]) { const r = results(i); mutate(r[0]); assert.throws(() => tieredExecutorProgram.decode({ programInput: i, initialResults: r, dependentEvidence: [] })); }
});
test("tiered cache distinguishes actor/origin/method and normalizes addresses", () => {
  const i = fixture(), exact = createUniv4FeeHookExact(), project = (x: typeof i) => exact.cacheCompatibilityProjection(x);
  assert.deepEqual(project(i), project({ ...i, executor: ethers.getAddress(i.executor), transactionOrigin: ethers.getAddress(i.transactionOrigin) }));
  assert.notDeepEqual(project(i), project({ ...i, transactionOrigin: "0x1000000000000000000000000000000000000003" }));
  assert.notDeepEqual(project(i), project({ ...i, executor: "0x1000000000000000000000000000000000000004" }));
  assert.notDeepEqual(project(i), createUniv4FeeHookExact("local", "quoter").cacheCompatibilityProjection(i));
  const a = tieredExecutorProgram.buildRequests(i)[0]!, b = tieredExecutorProgram.buildRequests({ ...i, amountIn: i.amountIn + 1n })[0]!;
  assert.notEqual(physicalAdapterRequestFingerprint(a), physicalAdapterRequestFingerprint(b));
});
test("tiered native directions declare shared boundary and never fund raw native independently", () => {
  const f = fixture(true);
  for (const route of plugin.routes.project({ descriptor: f.descriptor })) {
    const i = { ...f, route }, declared = declareRequestProgram({ requirements: () => tieredExecutorProgram.requirements(i),
      buildRequests: () => tieredExecutorProgram.buildRequests(i), decode: () => null }, i);
    const req = declared.requests[0]!; assert(req.kind === "effect-delta-simulation");
    assert(req.executionAssetBoundary); assert.equal(req.executionAssetBoundary.minimum, 1n);
    assert.equal(req.overrideIntent.nativeBalanceWei, undefined);
    const materialized = materializeAdapterRequests(declared.requests, { executor, transactionOrigin })[0]!;
    assert(materialized.kind === "effect-delta-simulation"); assert.equal("executionAssetBoundary" in materialized, false);
    assert.notEqual(materialized.call.data, req.call.data);
  }
});

test("tiered quoted fragment rejects old Quoter evidence and foreign origin/executor", () => {
  const i = fixture(), q = tieredExecutorProgram.decode({ programInput: i, initialResults: results(i), dependentEvidence: [] });
  const input = { ...i, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence };
  assert(plugin.execution.buildFragment(input).nodes.length > 0);
  assert.throws(() => plugin.execution.buildFragment({ ...input, transactionOrigin: "0x1000000000000000000000000000000000000003" }));
  assert.throws(() => plugin.execution.buildFragment({ ...input, executor: "0x1000000000000000000000000000000000000004" }));
  assert.throws(() => plugin.execution.buildFragment({ ...input, exactEvidence: { ...q.evidence, kind: "univ4-fee-hook-quoter" } }));
});

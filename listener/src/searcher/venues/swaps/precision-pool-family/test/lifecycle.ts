import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { createBoundedRequestExecutor, type AdapterRequest, type AdapterRequestResult } from "../../../adapter-request-program.js";
import { executeAdapterFamilyLifecycleBatch, executeFamilyExactQuote, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg } from "../../../adapter-family-runtime.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { executionAssetBoundaryAdapter } from "../../../../execution-asset-boundary.js";
import { plugin } from "../../../production-families/precision-pool.production.js";
import { POOL } from "../codec.js";
import { ID } from "../manifest.js";
import type { Route } from "../types.js";
import { descriptor, fixture } from "./fixtures.js";
import { runProgram } from "./runtime-machine.js";

// Real production discovery/lifecycle/issuer with explicitly synthetic transport
// answers. This is offline integration coverage, not historical admission.
const d = descriptor(), actor = "0x1000000000000000000000000000000000000011";
const receiver = "0x2000000000000000000000000000000000000022";
const source = { number: 26129175, hash: "0x" + "11".repeat(32), generation: 26129175 };
const word = (n: bigint | string) => ethers.toBeHex(BigInt(n), 32);
const output = (amount: bigint) => amount * 2n + 7n;
async function lifecycle() {
  const rounds: AdapterRequest[][] = [];
  const answer = (r: AdapterRequest): AdapterRequestResult => {
    let data: string;
    if (r.id === "pool-code") data = fixture.poolRuntime;
    else if (r.id === "factory-code") data = fixture.factoryRuntime;
    else if (r.id === "creation-blob") data = "0x00" + fixture.poolCreation.slice(2);
    else if (r.id.startsWith("token-code")) data = "0x6000";
    else if (r.id.startsWith("decimals")) data = word(18n);
    else if (r.id === "registered") data = word(1n);
    else if (r.id === "reverse") data = word(d.pool);
    else if (r.id.startsWith("pool-")) data = word(Reflect.get(d, r.id.slice(5)));
    else if (["trustedExecutor", "poolCode", "poolInitCodeHash"].includes(r.id)) data = word(Reflect.get(d, r.id));
    else if (["reserve0", "reserve1", "balance0", "balance1"].includes(r.id)) data = word(10n ** 24n);
    else if (r.id === "totalSupply") data = word(10n ** 20n);
    else if (["hookOwed0", "hookOwed1", "creatorOwed0", "creatorOwed1"].includes(r.id)) data = word(0n);
    else if (r.id === "quote" && r.kind === "eth-call") {
      const [sender, , amount] = POOL.decodeFunctionData("quoteExactIn", r.data);
      assert.equal(sender.toLowerCase(), actor); assert.deepEqual(r.caller, { kind: "executor" });
      data = POOL.encodeFunctionResult("quoteExactIn", [output(amount), true]);
    } else throw Error("unexpected PrecisionPool fixture request " + r.id);
    return { id: r.id, data, ok: true, completion: "returned", source,
      provenance: { kind: "fixture-only", fingerprint: "precision-offline-lifecycle" } };
  };
  let now = 1000;
  const runtime: any = {
    clock: { nowMs: () => now++ }, generationFence: { assertCurrent(generation: number, current: typeof source) {
      assert.equal(generation, source.generation); assert.deepEqual(current, source);
    } }, callerAuthority: { bind: () => ({ executor: actor, transactionOrigin: receiver }) },
    policy: { bind: (i: any) => ({ lane: "critical-proof", deadlineAtMs: 100000, maxAttempts: 1,
      transportPool: "state-read", fairnessKey: i.subjectKey }) }, budgets: { assertAdmitted() {} },
    scheduler: { issueExecutor: () => ({ executor: createBoundedRequestExecutor({
      assertSupported() {}, assertCallerBinding() {}, assertWithinBudget() {},
      async execute(i) { rounds.push([...i.requests]); return i.requests.map(answer); },
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    }), timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }) }) },
  };
  const observation = { kind: "call" as const, source, target: d.pool,
    data: POOL.encodeFunctionData("swapExactIn", [d.token1, 19n, 1n, actor]) };
  const matches = catalog.matches(observation).filter(m => m.familyId === ID)
    .map(m => ({ matchedPatternId: m.patternId, observation }));
  assert(matches.length > 0, "installed production entry must nominate the recorded ABI");
  const family = asPricedFamily(catalog.forFamily(ID));
  const result = await executeAdapterFamilyLifecycleBatch({ family, matches, source, generation: source.generation,
    runtime, publisher: { publish() {} } });
  assert(result.outcomes.some(o => o.stage === "identity" && o.status === "verified"),
    JSON.stringify(result.outcomes.map(o => ({ stage: o.stage, status: o.status, reason: o.reasonCode }))));
  assert.equal(result.publication?.instances.length, 1);
  const instance = result.publication!.instances[0]; assert.equal(instance.routes.length, 2);
  return { family, runtime, rounds, instance };
}
function encodeQuoted(node: any): Uint8Array {
  const inner = ethers.getBytes(ethers.concat(node.children.map(encodeQuoted)));
  const adapter = node.adapterId === executionAssetBoundaryAdapter.id ? executionAssetBoundaryAdapter
    : plugin.actionAdapters.find(a => a.id === node.adapterId);
  assert(adapter); return adapter.encode(node, actor, inner);
}

test("installed PrecisionPool lifecycle issues both routes and both quote/runtime interfaces with shared native settlement", async () => {
  const run = await lifecycle();
  for (const [index, stored] of run.instance.routes.entries()) for (const amount of [19n, 123456789n]) {
    const route = stored as Route, handle = run.instance.routeHandles[index];
    const exact = await executeFamilyExactQuote({ family: run.family, route: handle, amountIn: amount, executor: actor,
      runtimeEvidence: [], source, generation: source.generation, runtime: run.runtime, requireChainAmountQuote: true, actionOwnership: catalog });
    assert(exact.status === "resolved", exact.outcome.reasonCode); assert.equal(exact.amountOut, output(amount));
    const quoted = buildFamilyExecutionFragment({ family: run.family, route: handle, exact, minAmountOut: exact.amountOut,
      executor: actor, runtimeEvidence: [], actionOwnership: catalog });
    assert(quoted.status === "resolved", quoted.outcome.reasonCode); assert.equal(quoted.fragment.nodes.length, 1);
    const script = encodeQuoted(quoted.fragment.nodes[0]); assert.equal(script[0], 0x0e);
    const input = { pool: d.pool, executor: actor, rawIn: route.zeroForOne ? d.token0 : d.token1,
      rawOut: route.zeroForOne ? d.token1 : d.token0, amountIn: amount, amountOut: exact.amountOut,
      nativeBaseline: 991n, oldOutput: 888888n, wrapped: true };
    assert.equal(runProgram(script.slice(36), input).outputDelta, exact.amountOut);
    const count = run.rounds.length;
    const build = (settlement?: Parameters<typeof buildFamilyRuntimeAmountLeg>[0]["settlement"]) => buildFamilyRuntimeAmountLeg({
      family: run.family, route: handle, source, runtime: run.runtime, executor: actor, runtimeEvidence: [],
      actionOwnership: catalog, ...(settlement ? { settlement } : {}),
    });
    const normal = build(); assert(normal);
    const normalResult = runProgram(ethers.getBytes(normal.program), input);
    assert.equal(normalResult.outputDelta, exact.amountOut);
    assert.equal(normalResult.allowance, route.zeroForOne ? 0n : ethers.MaxUint256);
    for (const recipient of [actor, receiver]) {
      const request = { kind: "direct-output" as const, recipient }, leg = build(request); assert(leg);
      assert.deepEqual(leg.settlementRequest, request, "issuer preserves the original receiver after raw native mapping");
      const actual = runProgram(ethers.getBytes(leg.program), { ...input, recipient });
      assert.equal(actual.outputDelta, exact.amountOut); assert.equal(actual.spent, amount);
      assert.equal(actual.nativeBalance, input.nativeBaseline); assert.equal(actual.allowance, 0n);
    }
    assert.equal(build({ kind: "quote-output" }), null);
    assert.equal(build({ kind: "deferred-input", paymentAmount: 1n, paymentProgram: "0x0100" }), null);
    assert.deepEqual(build(), normal);
    assert.equal(run.rounds.length, count, "runtime/direct construction cannot execute quote or transport requests");
    assert.throws(() => buildFamilyRuntimeAmountLeg({ family: run.family, route: handle, source: { ...source, generation: source.generation + 1 },
      runtime: run.runtime, executor: actor, runtimeEvidence: [], actionOwnership: catalog }));
  }
});

// Real production issuer/lifecycle with deterministic synthetic transport.
import assert from "node:assert/strict";
import test from "node:test";
import type { CentralAdapterRuntime } from "../../../../adapter-work-intent.js";

process.env.SEARCHER_FAMILY_ALGEBRA_INTEGRAL_ENABLED = "1";
const { createBoundedRequestExecutor } = await import("../../../adapter-request-program.js");
const { EXECUTOR, SOURCE } = await import("./fixtures.js");
const { dynamicAnswer, DYNAMIC_FACTS } = await import("./dynamic-fixtures.js");
const { ALGEBRA_POOL_INTERFACE } = await import("../abi.js");
const { plugin } = await import("../../../production-families/algebra-integral.production.js");
const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } = await import("../../../production-family-composition.js");
const { runStrictFamilyLifecycle } = await import("../../../../strict-family-lifecycle-runner.js");
const { executeFamilyExactQuote } = await import("../../../adapter-family-runtime.js");
const { createAdapterFamilyExactQuoteCache } = await import("../../../../adapter-family-exact-quote-cache.js");
const ORIGIN = "0x1000000000000000000000000000000000000001";

for (const direction of ["zero-for-one", "one-for-zero"]) {
  test(`production dynamic ${direction} issues one amount-sensitive Quoter round`, async () => {
    const rounds: string[][] = [];
    const reply = dynamicAnswer();
    const cache = createAdapterFamilyExactQuoteCache();
    cache.advanceState(SOURCE);
    const runtime: CentralAdapterRuntime = {
      exactQuoteCache: cache, clock: { nowMs: () => 1000 },
      generationFence: { assertCurrent(generation, source) { assert.equal(generation, SOURCE.generation); assert.deepEqual(source, SOURCE); } },
      callerAuthority: { bind: () => ({ executor: EXECUTOR, transactionOrigin: ORIGIN }) },
      policy: { bind: input => ({ lane: "foreground", deadlineAtMs: 100000,
        maxAttempts: 1, transportPool: "state-read", fairnessKey: input.subjectKey }) },
      budgets: { assertAdmitted() {} },
      scheduler: { issueExecutor(input) { return {
        executor: createBoundedRequestExecutor({
          assertSupported: req => assert.deepEqual(req, input.requirements), assertCallerBinding() {},
          assertWithinBudget: (_family, req) => assert.deepEqual(req, input.requests),
          async execute(execution) { rounds.push(execution.requests.map(r => r.id)); return execution.requests.map(reply); },
          sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
        }), timing: () => ({ queueWaitMs: 0, transportWallMs: 0, attempts: 1 }),
      }; } },
    };
    const event = ALGEBRA_POOL_INTERFACE.encodeEventLog(ALGEBRA_POOL_INTERFACE.getEvent("Swap")!, [
      EXECUTOR, EXECUTOR, 1000n, -2000n, DYNAMIC_FACTS.sqrtPriceX96,
      DYNAMIC_FACTS.liquidity, DYNAMIC_FACTS.tick, 99n, 0n,
    ]);
    const publication = await runStrictFamilyLifecycle({ catalog, familyId: plugin.manifest.familyId,
      source: SOURCE, runtime, observations: [{ kind: "log", source: SOURCE, address: DYNAMIC_FACTS.pool,
        topics: event.topics, data: event.data,
        transactionHash: `0x${"01".repeat(32)}` }],
    });
    assert.equal(publication.instances.length, 1);
    const instance = publication.instances[0]!;
    const route = instance.routes.find(r => (r as { direction?: string }).direction === direction)!;
    const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey)!;
    rounds.length = 0;
    const quote = (amountIn: bigint) => executeFamilyExactQuote({
      family: catalog.forFamily(plugin.manifest.familyId), route: handle, amountIn,
      executor: EXECUTOR, runtimeEvidence: [], source: SOURCE,
      generation: SOURCE.generation, runtime,
    });
    for (const amount of [1000n, 2000n]) {
      const before = rounds.length;
      const outcome = await quote(amount);
      assert.equal(outcome.status, "resolved", JSON.stringify(outcome, (_k, v) => typeof v === "bigint" ? String(v) : v));
      if (outcome.status !== "resolved") throw Error("quote did not resolve");
      assert.equal(outcome.amountOut, amount * 2n);
      assert.deepEqual(rounds.slice(before), [["exact-quoter", "pool-plugin", "plugin-code", "quoter-code"]]);
    }
    const beforeRepeat = rounds.length;
    assert.equal((await quote(2000n)).status, "resolved");
    assert.equal(rounds.length, beforeRepeat, "same amount/source uses central quote cache");
  });
}

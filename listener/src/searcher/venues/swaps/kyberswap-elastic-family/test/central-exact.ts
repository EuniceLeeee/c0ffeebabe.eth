// Synthetic transport, actual production lifecycle and Exact issuer. This is
// a dependency/termination contract, not historical EVM or latency acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import type { CentralAdapterRuntime } from "../../../../adapter-work-intent.js";

// Configure before importing the production graph: transitive imports may
// initialize the catalog, even when this file imports it dynamically below.
process.env.SEARCHER_FAMILY_KYBERSWAP_ELASTIC_ENABLED = "1";
const { createBoundedRequestExecutor } = await import("../../../adapter-request-program.js");
const { answerFor, EXECUTOR, SOURCE, swapLogEvent } = await import("./fixtures.js");
const { plugin } = await import("../../../production-families/kyberswap-elastic.production.js");
const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } =
  await import("../../../production-family-composition.js");
const { runStrictFamilyLifecycle } = await import("../../../../strict-family-lifecycle-runner.js");
const { executeFamilyExactQuote } = await import("../../../adapter-family-runtime.js");
const { createAdapterFamilyExactQuoteCache } =
  await import("../../../../adapter-family-exact-quote-cache.js");

function fixtureRuntime() {
  const rounds: string[][] = [];
  const reply = answerFor();
  const exactQuoteCache = createAdapterFamilyExactQuoteCache();
  exactQuoteCache.advanceState(SOURCE);
  const runtime: CentralAdapterRuntime = {
    exactQuoteCache,
    clock: { nowMs: () => 1_000 },
    generationFence: { assertCurrent(generation, source) {
      assert.equal(generation, SOURCE.generation);
      assert.deepEqual(source, SOURCE);
    } },
    callerAuthority: { bind: () => ({ executor: EXECUTOR, transactionOrigin: EXECUTOR }) },
    policy: { bind: input => ({ lane: "foreground", deadlineAtMs: 100_000,
      maxAttempts: 1, transportPool: "state-read", fairnessKey: input.subjectKey }) },
    budgets: { assertAdmitted() {} },
    scheduler: { issueExecutor(input) {
      return {
        executor: createBoundedRequestExecutor({
          assertSupported: requirements => assert.deepEqual(requirements, input.requirements),
          assertCallerBinding() {},
          assertWithinBudget: (_family, requests) => assert.deepEqual(requests, input.requests),
          async execute(execution) {
            rounds.push(execution.requests.map(request => request.id));
            return execution.requests.map(reply);
          },
          sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
        }),
        timing: () => ({ queueWaitMs: 0, transportWallMs: 0, attempts: 1 }),
      };
    } },
  };
  return { runtime, rounds };
}

for (const direction of ["token0-in", "token1-in"] as const) {
  test(`production Exact terminates ${direction} and bounds dependent reads`, async () => {
    const { runtime, rounds } = fixtureRuntime();
    const publication = await runStrictFamilyLifecycle({
      catalog, familyId: plugin.manifest.familyId, source: SOURCE, runtime,
      observations: [{ kind: "log", source: SOURCE, ...swapLogEvent() }],
    });
    assert.equal(publication.instances.length, 1);
    const instance = publication.instances[0]!;
    const route = instance.routes.find(route =>
      (route as { direction?: string }).direction === direction)!;
    assert(route);
    const handle = instance.routeHandles.find(handle => handle.routeKey === route.routeKey)!;
    assert(handle);
    rounds.length = 0;
    const outcome = await executeFamilyExactQuote({
      family: catalog.forFamily(plugin.manifest.familyId), route: handle,
      amountIn: direction === "token0-in" ? 1_000_000_000_000n : 1_000_000n,
      executor: EXECUTOR, runtimeEvidence: [], source: SOURCE,
      generation: SOURCE.generation, runtime,
    });
    assert.equal(outcome.status, "resolved",
      JSON.stringify(outcome, (_key, value) => typeof value === "bigint" ? String(value) : value));
    if (outcome.status !== "resolved") throw new Error("Exact did not resolve");
    assert(outcome.amountOut > 0n);
    assert.deepEqual(rounds, direction === "token0-in" ? [[
      "kyswap-pool-state", "kyswap-liquidity-state", "kyswap-swap-fee-units",
    ]] : [[
      "kyswap-pool-state", "kyswap-liquidity-state", "kyswap-swap-fee-units",
    ], ["kyswap-initialized-ticks"]]);
    assert.equal(new Set(rounds.flat()).size, rounds.flat().length);
    const beforeRepeat = rounds.length;
    const larger = await executeFamilyExactQuote({
      family: catalog.forFamily(plugin.manifest.familyId), route: handle,
      amountIn: direction === "token0-in" ? 2_000_000_000_000n : 2_000_000n,
      executor: EXECUTOR, runtimeEvidence: [], source: SOURCE,
      generation: SOURCE.generation, runtime,
    });
    assert.equal(larger.status, "resolved");
    if (larger.status !== "resolved") throw new Error("second amount did not resolve");
    assert(larger.amountOut > outcome.amountOut, "changed amount is recalculated");
    assert.equal(rounds.length, beforeRepeat,
      "same-state amount change must reuse both state read rounds");
  });
}

test("a completed dependent round declares no further work", () => {
  const d = { pool: "0x0000000000000000000000000000000000000001" };
  const method = plugin.exact.methods({ descriptor: d, route: {}, amountIn: 1n } as never)[1]!;
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing request program");
  assert.equal(method.program.buildDependentProgram?.({
    programInput: { descriptor: d, route: { direction: "token1-in" }, amountIn: 1n },
    completedRound: 1, initialResults: [], priorEvidence: [],
  } as never), null);
});

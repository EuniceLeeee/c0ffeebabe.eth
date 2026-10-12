// Synthetic transport, actual production lifecycle and Exact issuer. This is
// a dependency/termination contract, not historical EVM or latency acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import type { CentralAdapterRuntime } from "../../../../adapter-work-intent.js";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";

// Configure before importing the production graph: transitive imports may
// initialize the catalog, even when this file imports it dynamically below.
process.env.SEARCHER_FAMILY_KYBERSWAP_ELASTIC_ENABLED = "1";
const { createBoundedRequestExecutor } = await import("../../../adapter-request-program.js");
const { answerFor, EXECUTOR, SOURCE, swapLogEvent, crossingFixture, CROSSING_BOUNDARIES, result } = await import("./fixtures.js");
const { plugin } = await import("../../../production-families/kyberswap-elastic.production.js");
const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } =
  await import("../../../production-family-composition.js");
const { runStrictFamilyLifecycle } = await import("../../../../strict-family-lifecycle-runner.js");
const { executeFamilyExactQuote } = await import("../../../adapter-family-runtime.js");
const { createAdapterFamilyExactQuoteCache } =
  await import("../../../../adapter-family-exact-quote-cache.js");

function fixtureRuntime(options: Parameters<typeof answerFor>[0] = {},
  transform: (request: AdapterRequest, row: AdapterRequestResult) => AdapterRequestResult = (_request, row) => row) {
  const rounds: string[][] = [];
  const reply = answerFor(options);
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
            return execution.requests.map(request => transform(request, reply(request)));
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

async function publishedExact(direction: "token0-in" | "token1-in",
  options: Parameters<typeof answerFor>[0], transform?: Parameters<typeof fixtureRuntime>[1]) {
  const { runtime, rounds } = fixtureRuntime(options, transform);
  const publication = await runStrictFamilyLifecycle({
    catalog, familyId: plugin.manifest.familyId, source: SOURCE, runtime,
    observations: [{ kind: "log", source: SOURCE, ...swapLogEvent() }],
  });
  assert.equal(publication.instances.length, 1);
  const instance = publication.instances[0]!;
  const route = instance.routes.find(r => (r as { direction?: string }).direction === direction)!;
  assert(route);
  const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey)!; assert(handle);
  rounds.length = 0;
  return { rounds, run: (amountIn: bigint) => executeFamilyExactQuote({
    family: catalog.forFamily(plugin.manifest.familyId), route: handle, amountIn,
    executor: EXECUTOR, runtimeEvidence: [], source: SOURCE,
    generation: SOURCE.generation, runtime,
    // Deliberately no maxDependentReadRounds override: production remains four.
  }) };
}

for (const direction of ["token0-in", "token1-in"] as const) {
  test(`production Exact ${direction}: successive crossing rounds terminate and preserve arithmetic`, async () => {
    const f = crossingFixture(), expected = CROSSING_BOUNDARIES[direction];
    const { run, rounds } = await publishedExact(direction, f.options);
    const boundary = await run(expected.amountIn);
    assert.equal(boundary.status, "resolved");
    if (boundary.status !== "resolved") throw new Error("two-crossing Exact failed");
    assert.equal(boundary.amountIn, expected.amountIn); assert.equal(boundary.amountOut, expected.amountOut);
    assert.deepEqual(rounds, [
      ["kyswap-pool-state", "kyswap-liquidity-state", "kyswap-swap-fee-units"],
      ...(direction === "token1-in" ? [["kyswap-initialized-ticks"]] : []),
      ...expected.crossedTicks.map(tick => [`kyswap-tick:${tick}`, `kyswap-tick-neighbours:${tick}`]),
    ]);
    assert.equal(new Set(rounds.flat()).size, rounds.flat().length, "no repeated IDs across dependent rounds");
    const reads = rounds.length;
    const repeated = await run(expected.amountIn);
    assert.equal(repeated.status, "resolved"); assert.equal(rounds.length, reads);
    // These amounts all cross the same two ticks; their state declarations are
    // identical, so the shared cache can replay them without another transport.
    const larger = await run(expected.amountIn + 200_000_000n);
    const smaller = await run(expected.amountIn + 100_000_000n);
    assert.equal(larger.status, "resolved"); assert.equal(smaller.status, "resolved");
    if (larger.status !== "resolved" || smaller.status !== "resolved") throw new Error("changed amount did not resolve");
    assert(larger.amountOut > smaller.amountOut && smaller.amountOut > boundary.amountOut);
    assert.equal(larger.amountIn, expected.amountIn + 200_000_000n);
    assert.equal(smaller.amountIn, expected.amountIn + 100_000_000n);
    assert.equal(rounds.length, reads, "same crossing evidence must be reused for changed amounts");
  });

  test(`production Exact ${direction}: growing beyond cached crossings reads the newly needed tick`, async () => {
    const f = crossingFixture(), { run, rounds } = await publishedExact(direction, f.options);
    const first = await run(CROSSING_BOUNDARIES.first.amountIn);
    assert.equal(first.status, "resolved");
    const before = rounds.length, expected = CROSSING_BOUNDARIES[direction];
    const second = await run(expected.amountIn);
    assert.equal(second.status, "resolved");
    if (second.status !== "resolved") throw new Error("larger crossing set did not resolve");
    assert.equal(second.amountOut, expected.amountOut);
    const missing = expected.crossedTicks[1];
    assert(rounds.slice(before).flat().includes(`kyswap-tick:${missing}`));
    assert(rounds.slice(before).flat().includes(`kyswap-tick-neighbours:${missing}`));
    // The shared cache may reissue the prior rounds on a changed dependency
    // shape; this test does not demand an unimplemented incremental cache.
    assert(rounds.length - before <= 5);
  });

  test(`production Exact ${direction}: temporary 480-tick boundaries issue no bogus crossing reads`, async () => {
    const f = crossingFixture();
    const { run, rounds } = await publishedExact(direction, { ...f.options,
      nearestCurrentTick: -10000, previousTick: -20000, nextTick: 10000, ticks: new Map() });
    for (const amountIn of [30_000_000_000n, 60_000_000_000n]) {
      const outcome = await run(amountIn); assert.equal(outcome.status, "resolved");
      if (outcome.status !== "resolved") throw new Error("virtual-step Exact failed");
      assert.equal(outcome.amountIn, amountIn); assert(outcome.amountOut > 0n);
    }
    assert.deepEqual(rounds, [
      ["kyswap-pool-state", "kyswap-liquidity-state", "kyswap-swap-fee-units"],
      ...(direction === "token1-in" ? [["kyswap-initialized-ticks"]] : []),
    ]);
  });

  test(`production Exact ${direction}: four dependent rounds fail closed before any fifth round`, async () => {
    const f = crossingFixture(), { run, rounds } = await publishedExact(direction, f.options);
    const outcome = await run(10_000_000_000n);
    assert.equal(outcome.status, "failed");
    if (outcome.status === "resolved") throw new Error("budget exhaustion became a successful partial quote");
    assert.equal(outcome.outcome.reasonCode, "exact-dependent-round-budget-exhausted");
    assert.equal(rounds.length, 5, "one initial plus exactly four dependent rounds");
    assert.equal(new Set(rounds.flat()).size, rounds.flat().length);
    const safe = await run(100_000_000n);
    assert.equal(safe.status, "resolved");
    if (safe.status !== "resolved") throw new Error("bounded failure poisoned a later smaller quote");
    assert.equal(safe.amountIn, 100_000_000n); assert(safe.amountOut > 0n);
  });
}

for (const defect of ["malformed-tick", "malformed-link", "stale-tick", "stale-link", "wrong-tick-id", "reverted-tick"] as const) {
  test(`production Exact rejects ${defect} after a valid first crossing`, async () => {
    const f = crossingFixture(), target = defect.includes("link") ? "kyswap-tick-neighbours:-20" : "kyswap-tick:-20";
    const { run, rounds } = await publishedExact("token0-in", f.options, (request, row) => {
      if (request.id !== target) return row;
      if (defect.startsWith("stale")) return { ...row, source: { ...SOURCE, number: SOURCE.number - 1 } };
      if (defect === "wrong-tick-id") return { ...row, id: "kyswap-tick:-30" };
      return result(request.id, "0x", defect === "reverted-tick" ? "reverted-as-declared" : "returned");
    });
    const outcome = await run(CROSSING_BOUNDARIES["token0-in"].amountIn);
    assert.notEqual(outcome.status, "resolved", "neither first-step output nor old evidence may become a complete quote");
    assert(rounds.flat().includes(target)); assert(rounds.length <= 5);
  });
}

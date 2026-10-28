import assert from "node:assert/strict";
import { historicalCandidateSelection, cleanupHistoricalResources, historicalContinuationIdentity } from "../blockscan-at-block-cli.js";
import { blockScanRouteId } from "../blockscan-route-identity.js";
import { test } from "node:test";
import { ethers } from "ethers";
import { parseAtBlockArgs, atBlockJson, parseAtBlockJson, parseHistoricalExecutorRuntimeCode, historicalFundingStarts } from "../blockscan-at-block-cli.js";
import { maybeSubmitBlockScanAtomic, resolveBlockScanAtomicPolicy, resolveBlockScanCoreConfig, resolveBlockScanRefineCandidates } from "../main.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { DEFAULT_PROFIT_TOKEN_VALUATION } from "../profit-token-valuation.js";
import { BLOCKSCAN_ENUMERATION_DEFAULTS } from "../blockscan-enumeration-config.js";
import { createHash } from "node:crypto";
import { historicalLiveConfig, historicalRejectedRoutes, historicalRankedRouteEligibility, historicalExperimentReverts } from "../blockscan-at-block-history.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scanBlockStateFromResolvedMids as scan, type ResolvedBlockScanQuote } from "../detector/blockscan-scanner-core.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { historicalBaselineData, writeHistoricalBenchmarkBaseline, readHistoricalBenchmarkBaseline,
  historicalBenchmarkSummary, assertHistoricalSamplingPolicy } from "../blockscan-historical-benchmark.js";

const base = ["--ready", "ready.json", "--block", "123", "--out", "logs/new-run"];
test("historical continuation binds a bigint sampling policy without serializing raw bigint", () => {
  const policy = { spreadBps: 0, fixedWethInput: 20_000_000_000_000_000n, cascade: false };
  const first = historicalContinuationIdentity("baseline", policy);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, historicalContinuationIdentity("baseline", policy));
  assert.notEqual(first, historicalContinuationIdentity("baseline", { ...policy, fixedWethInput: null }));
  assert.notEqual(first, historicalContinuationIdentity("baseline", { ...policy, fixedWethInput: 1n }));
});
test("historical cleanup drains every resource even when evidence writes fail", async () => {
  const calls: number[] = [], diskError = new Error("ENOSPC");
  const actions = [() => { calls.push(1); throw diskError; }, async () => { calls.push(2); throw new Error("close"); },
    () => { calls.push(3); }];
  await assert.rejects(cleanupHistoricalResources(actions, false), error => error === diskError);
  assert.deepEqual(calls, [1, 2, 3]);
  calls.length = 0;
  await cleanupHistoricalResources(actions, true);
  assert.deepEqual(calls, [1, 2, 3], "original run failure is preserved without skipping final cleanup");
});
test("expired run deadline cannot let unref-only cleanup silently exit zero", () => {
  const url = new URL("../blockscan-at-block-cli.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { cleanupHistoricalResources } from ${JSON.stringify(url)};
    await new Promise(resolve => setTimeout(resolve, 1)); // run deadline already fired
    void (async () => {
      try { throw new Error("original run failure"); }
      finally { await cleanupHistoricalResources([() => new Promise(resolve => {
        setTimeout(() => { console.log("drained"); resolve(); }, 20).unref();
      })], true); }
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stdout, /drained/);
  assert.match(child.stderr, /original run failure/);
});
test("fixed-input baseline permits enumeration-only threshold changes but not sampling changes", () => {
  const fixed = { spreadBps: 0, fixedWethInput: 20_000_000_000_000_000n, cascade: false };
  assert.doesNotThrow(() => assertHistoricalSamplingPolicy(fixed, { ...fixed, spreadBps: 100 }));
  assert.equal(fixed.spreadBps, 0, "the stored baseline policy is not relabelled");
  for (const changed of [{ ...fixed, fixedWethInput: 1n }, { ...fixed, fixedWethInput: null },
    { ...fixed, cascade: true }]) assert.throws(() => assertHistoricalSamplingPolicy(fixed, changed));
  const dynamic = { ...fixed, fixedWethInput: null };
  assert.throws(() => assertHistoricalSamplingPolicy(dynamic, { ...dynamic, spreadBps: 100 }));
  assert.doesNotThrow(() => assertHistoricalSamplingPolicy(dynamic, dynamic));
  assert.throws(() => assertHistoricalSamplingPolicy({ ...fixed, fixedWethInput: 0n },
    { ...fixed, fixedWethInput: 0n, spreadBps: 100 }));
});
test("benchmark supports one or several full production blocks from a fixed baseline without injection", () => {
  const args = [...base, "--benchmark-baseline", "baseline.json"];
  assert.equal(parseAtBlockArgs(args)?.amountSelector, "sim");
  assert.equal(parseAtBlockArgs(args)?.through, "ev");
  assert.equal(parseAtBlockArgs([...args, "--through-block", "125"])?.throughBlock, 125);
  assert.throws(() => parseAtBlockArgs([...base, "--save-baseline", "--through", "prices"]));
  for (const extra of [["--offline"], ["--live-mids", "mids.json"], ["--amount-selector", "solver"],
    ["--only-enumerated-rank", "1"], ["--max-candidates", "2"], ["--execution-mode", "source-block"]])
    assert.throws(() => parseAtBlockArgs([...args, ...extra]));
});

test("extended execution-screen budget is bounded and only available for existing-baseline benchmarks", () => {
  const benchmark = [...base, "--benchmark-baseline", "baseline.json", "--through-block", "222"];
  assert.equal(parseAtBlockArgs(base)?.budgetMs, 120_000);
  assert.equal(parseAtBlockArgs(benchmark)?.budgetMs, 120_000);
  assert.equal(parseAtBlockArgs([...base, "--budget-ms", "3600000"])?.budgetMs, 3_600_000);
  assert.throws(() => parseAtBlockArgs([...base, "--budget-ms", "3600001"]), /invalid --budget-ms/);
  assert.throws(() => parseAtBlockArgs([...base, "--budget-ms", "43200000"]), /invalid --budget-ms/);
  assert.equal(parseAtBlockArgs([...benchmark, "--budget-ms", "43200000"])?.budgetMs, 43_200_000);
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "43200001", "9007199254740992"])
    assert.throws(() => parseAtBlockArgs([...benchmark, `--budget-ms=${value}`]), /invalid --budget-ms/);
});

test("baseline serialization preserves shared integer data, rejects authority and checks bytes", () => {
  const shared = { amount: 17n }, source = { a: new Map([["one", shared]]), b: shared, nonfinite: Infinity };
  const copy = historicalBaselineData(source);
  assert.equal(copy.a.get("one"), copy.b); assert.equal(copy.b.amount, 17n); assert.equal(copy.nonfinite, Infinity);
  assert.throws(() => historicalBaselineData({ issueExact() {} }));
  const dir = mkdtempSync(join(tmpdir(), "production-baseline-")), path = join(dir, "baseline.json");
  try {
    const baseline: any = { version: 1, readySha256: "hash", pricing: { pricing: { sourceBlock: 123, sourceBlockHash: "source" } }, data: source };
    writeHistoricalBenchmarkBaseline(path, baseline);
    assert.deepEqual(readHistoricalBenchmarkBaseline(path).baseline, baseline);
    assert.throws(() => writeHistoricalBenchmarkBaseline(path, baseline));
    writeFileSync(path + ".bin", "changed"); assert.throws(() => readHistoricalBenchmarkBaseline(path), /bytes changed/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("benchmark statistics exclude censored and not-run stages but retain their counts", () => {
  const stage = (ms: number, status = "ran") => ({ status, stage_ms: ms, started_at_ms: 1, finished_at_ms: 2, cumulative_ms: ms });
  const sample = (block: number, time: number): any => ({ block, outcome: "ran", totalMs: time, callWallMs: time + 1,
    completePrices: true, timing: {}, stages: { state: stage(time / 2), ev: stage(0, "not-run") } });
  const result = historicalBenchmarkSummary([sample(2, 10), sample(3, 30), { ...sample(4, 100), outcome: "budget_exceeded" }], 4);
  assert.equal(result.totalMs.mean, 20); assert.equal(result.totalMs.p50, 10); assert.equal(result.totalMs.p90, 30);
  assert.equal(result.afterFirstTransitionTotalMs.mean, 30); assert.equal(result.stages.ev.count, 0);
  assert.equal(result.censoredBlocks.length, 1); assert.equal(result.missingBlocks, 1); assert.equal(result.reachedEvBlocks, 0);
});
test("historical benchmark windows require an existing baseline and never start full-table warmup", () => {
  const valid = [...base, "--benchmark-baseline", "baseline.json", "--through", "prices", "--through-block", "125"];
  assert.equal(parseAtBlockArgs(valid)?.throughBlock, 125);
  for (const end of ["122", "123", "373", "NaN", "124.5"])
    assert.throws(() => parseAtBlockArgs([...base, "--through", "prices", "--through-block", end]));
  for (const extra of [["--offline"], ["--live-mids", "manifest.json"]])
    assert.throws(() => parseAtBlockArgs([...valid, ...extra]));
  for (const stage of ["enumerate", "solver", "ev"])
    assert.throws(() => parseAtBlockArgs([...base, "--through", stage, "--through-block", "125"]));
  assert.throws(() => parseAtBlockArgs([...base, "--through", "prices", "--through-block", "125"]), /cold-start windows/);
  assert.equal(parseAtBlockArgs(base)?.throughBlock, undefined);
});
test("experiment P reverts are hash-bound, single-source and distinct from historical cache knowledge", () => {
  const dir = mkdtempSync(join(tmpdir(), "p-revert-proof-"));
  try {
    const edge: TokenEdge = { adapterId: "fixture", target: `0x${"1".repeat(40)}`, tokenIn: `0x${"2".repeat(40)}`,
      tokenOut: `0x${"3".repeat(40)}`, slotKind: "swap", ...deriveEdgeTaxonomy("swap") };
    const source = { number: 123, hash: `0x${"a".repeat(64)}`, generation: 1 }, routeId = blockScanRouteId([edge]);
    const evidencePath = join(dir, "event.json"), path = join(dir, "table.json");
    const event = atBlockJson({ source, event: { type: "p_revert_recorded", p: 2n, pTrials: 2, routeId, edges: [edge] } });
    writeFileSync(evidencePath, event);
    const value = { schemaVersion: 1, scope: "this-historical-experiment-only", notHistoricalPriorKnowledge: true,
      source: { number: source.number, hash: source.hash },
      routes: [{ p: "2", pTrials: 2, routeId, evidence: { path: evidencePath, sha256: createHash("sha256").update(event).digest("hex") } }] };
    writeFileSync(path, JSON.stringify(value));
    assert(historicalExperimentReverts(path, { source }).ids.has(routeId));
    assert.throws(() => historicalExperimentReverts(path, { source: { ...source, number: 124 } }));
    assert.throws(() => historicalExperimentReverts(path, { source: { ...source, generation: 2 } }));
    writeFileSync(path, JSON.stringify({ ...value, notHistoricalPriorKnowledge: false }));
    assert.throws(() => historicalExperimentReverts(path, { source }));
    writeFileSync(path, JSON.stringify(value)); writeFileSync(evidencePath, event + " ");
    assert.throws(() => historicalExperimentReverts(path, { source }), /evidence changed/);
  } finally { rmSync(dir, { recursive: true }); }
});
test("restored live mids support shared runtime continuation, not a funding or repricing shortcut", () => {
  const live = [...base, "--live-mids", "manifest.json", "--offline"];
  assert.equal(parseAtBlockArgs(live)?.through, "enumerate");
  assert.equal(parseAtBlockArgs([...live, "--rejected-routes", "rejects.json"])?.["rejected-routes"], "rejects.json");
  for (const through of ["prices", "solver", "ev"])
    assert.throws(() => parseAtBlockArgs([...live, "--through", through]));
  assert.equal(parseAtBlockArgs([...base, "--live-mids", "manifest.json", "--max-candidates", "3332"])?.maxCandidates, 3332);
  assert.equal(parseAtBlockArgs([...base, "--live-mids", "manifest.json", "--amount-selector", "sim"])?.through, "ev");
  assert.throws(() => parseAtBlockArgs([...base, "--live-mids", "manifest.json", "--effective-weth-input", "0.01"]));
  for (const value of ["0", "-1", "1.5", "01", "10001", "NaN"])
    assert.throws(() => parseAtBlockArgs([...base, "--max-candidates", value]));
  assert.throws(() => parseAtBlockArgs([...base, "--rejected-routes", "rejects.json"]));
  assert.throws(() => parseAtBlockArgs([...live, "--prices", "snapshot.json"]));
  assert.throws(() => parseAtBlockArgs([...live, "--funding-token", "0x1111111111111111111111111111111111111111"]));
  assert.throws(() => parseAtBlockArgs([...live, "--effective-weth-input", "0.01"]));
  assert.throws(() => parseAtBlockArgs([...live, "--amount-selector", "sim"]));
});

test("prior rejected complete routes do not consume the 512 coarse slots or blacklist their individual legs", () => {
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const edges: TokenEdge[] = [], mids = new Map<string, ResolvedBlockScanQuote>();
  for (let i = 0; i < 620; i++) {
    const token = address(10_000 + i);
    for (const [j, [tokenIn, tokenOut]] of [[weth, token], [token, weth]].entries()) {
      const edge: TokenEdge = { adapterId: "fixture-swap", target: address(20_000 + i * 2 + j),
        tokenIn, tokenOut, slotKind: "swap", ...deriveEdgeTaxonomy("swap") };
      const quoteAmountIn = 10_000n, quoteAmountOut = j === 0 ? quoteAmountIn : quoteAmountIn + BigInt(620 - i);
      edges.push(edge);
      mids.set(blockScanEdgeKey(edge), { kind: "fixture", pool: edge.target, edges: [edge],
        mid: Number(quoteAmountOut) / Number(quoteAmountIn), quoteAmountIn, quoteAmountOut, feeBps: 0, depthProxy: 0 });
    }
  }
  const input: Parameters<typeof scan>[0] = { edges, mids, sourceBlock: 123, swapTouched: null, captureCoarseEnumeration: true,
    cfg: { maxHops: 2, minSpreadBps: 0, maxCandidates: 512, budgetMs: 30_000, hopTokensPerStep: 0, hopPoolsPerPair: 1,
      ethSignalPairsPerToken: 1000, deduplicateRotations: true, allowRepeatedPools: false,
      pricedTokens: new Map([[weth, { maxBorrow: 1_000_000n }]]) } };
  const ids = (routes: readonly { seedEdges: TokenEdge[] }[]) => routes.map(route => blockScanRouteId(route.seedEdges));
  const baseline = scan(input);
  assert.equal(baseline.outcome, "ran");
  assert.equal(baseline.coarseEnumeration!.length, 620);
  assert.equal(baseline.opportunities.length, 512);
  assert.deepEqual(scan({ ...input, ...historicalRankedRouteEligibility(new Set()) }).opportunities, baseline.opportunities);
  const rejected = new Set(ids(baseline.opportunities));
  const filter = historicalRankedRouteEligibility(rejected);
  const filtered = scan({ ...input, rankedRouteEligible: filter.rankedRouteEligible });
  assert.equal(filtered.outcome, "ran");
  assert.deepEqual(ids(filtered.opportunities), ids(baseline.coarseEnumeration!.slice(512)),
    "original rank 513 and the next 99 routes survive without expanding either cap");
  assert.deepEqual(ids(filtered.coarseEnumeration!), ids(filtered.opportunities));
  assert.equal(filter.matched.size, 512);
  assert.equal(filtered.selection.forcedSelectionCount, 0);
  assert.deepEqual(filtered.opportunities.slice(0, 100), baseline.coarseEnumeration!.slice(512, 612));
  const all = historicalRankedRouteEligibility(new Set(ids(baseline.coarseEnumeration!)));
  assert.equal(scan({ ...input, rankedRouteEligible: all.rankedRouteEligible }).opportunities.length, 0);
  assert.equal(scan({ ...input, rankedRouteEligible: filter.rankedRouteEligible, routeEligible: () => false }).opportunities.length, 0,
    "existing route eligibility still applies");
  const partial = historicalRankedRouteEligibility(new Set([blockScanRouteId([edges[0]!])]));
  assert.equal(partial.rankedRouteEligible([edges[0]!, edges[1]!]), true, "partial legs are not route identities");
  assert.equal(filter.rankedRouteEligible([...baseline.opportunities[0]!.seedEdges].reverse()), true,
    "route identity is ordered, not a pool or token blacklist");
  assert.equal(scan({ ...input, rankedRouteEligible: filter.rankedRouteEligible, edgeEligible: () => false }).opportunities.length, 0);
  const dualFunding = { ...input, cfg: { ...input.cfg,
    pricedTokens: new Map([...input.cfg.pricedTokens, [edges[0]!.tokenOut, { maxBorrow: 1_000_000n }]]) } };
  const dual = scan(dualFunding);
  const chosen = dual.coarseEnumeration!.find(route => route.seedEdges.some(edge => edge.target === edges[0]!.target))!;
  const chosenId = blockScanRouteId(chosen.seedEdges);
  const blocked = historicalRankedRouteEligibility(new Set([chosenId]));
  const dualFiltered = scan({ ...dualFunding, rankedRouteEligible: blocked.rankedRouteEligible });
  assert.deepEqual(ids(dualFiltered.coarseEnumeration!), ids(dual.coarseEnumeration!).filter(id => id !== chosenId),
    "rejecting the selected funding rotation removes its slot instead of choosing a new rotation");
  const oldFilter = scan({ ...dualFunding, routeEligible: blocked.rankedRouteEligible });
  assert.equal(oldFilter.coarseEnumeration!.length, dual.coarseEnumeration!.length,
    "regression: filtering before funding-start dedup silently resurrected that same cycle");
  const rotations = scan({ ...dualFunding, cfg: { ...dualFunding.cfg, deduplicateRotations: false } });
  const alternate = rotations.coarseEnumeration!.find(route => blockScanRouteId(route.seedEdges) !== chosenId &&
    route.seedEdges.some(edge => edge.target === edges[0]!.target))!;
  assert(alternate);
  const blockAlternate = historicalRankedRouteEligibility(new Set([blockScanRouteId(alternate.seedEdges)]));
  assert.deepEqual(scan({ ...dualFunding, ...blockAlternate }).coarseEnumeration, dual.coarseEnumeration,
    "an unselected rotation cannot blacklist the chosen representative");
  const rotationsFiltered = scan({ ...dualFunding, cfg: { ...dualFunding.cfg, deduplicateRotations: false }, ...blocked });
  assert.deepEqual(ids(rotationsFiltered.coarseEnumeration!), ids(rotations.coarseEnumeration!).filter(id => id !== chosenId),
    "without rotation dedup, only the exact rejected ordered ID is excluded");
});

test("historical production configuration rejects primitive values instead of silently using defaults", () => {
  for (const value of [true, 1, "abc", null, [], { SEARCHER_DRY_RUN: 1 }])
    assert.throws(() => historicalLiveConfig(JSON.stringify(value)));
  assert.deepEqual(historicalLiveConfig('{"SEARCHER_DRY_RUN":"1"}'), { SEARCHER_DRY_RUN: "1" });
});

test("historical rejection evidence is source-bound and cannot leak later reverts into an earlier enumeration", async () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const expected = { runId: "same-process-epoch", source: { number: 123, hash: `0x${"a".repeat(64)}`, generation: 3 } };
  const routeId = `0x${"b".repeat(64)}`;
  const event = { type: "pipeline_dropped", reason: "sim_revert_seen_this_live", stage: "planner_solver",
    run_id: expected.runId, source_block: 122, emitted_at_ms: 999, route_id: routeId };
  const rawLine = JSON.stringify(event) + "\n";
  const cutoff = { type: "block_scan_result", run_id: expected.runId, source_block: 123, state_block: 123,
    pass_mode: "periodic", pricing_mode: "source_n", coarse_source_block: null, coarse_source_block_hash: null,
    exact_source_block_hash: expected.source.hash, stages: { enumeration: { started_at_ms: 1000 } } };
  const cutoffLine = JSON.stringify(cutoff);
  const input = { schema: "at-block-rejected-routes/v1", coverage: "observed-only", runId: expected.runId,
    sourceBlock: 123, sourceBlockHash: expected.source.hash, generation: 3,
    cutoff: { emittedAtMs: 1000, timeField: "stages.enumeration.started_at_ms",
      proof: { rawLine: cutoffLine, lineSha256: sha(cutoffLine), byteOffset: Buffer.byteLength(rawLine) } },
    evidence: { prefixBytes: 4096, prefixSha256: "c".repeat(64) },
    routes: [{ routeId, observedAtMs: 999, sourceBlock: 122, line: 1, byteOffset: 0, lineSha256: sha(rawLine), rawLine }] };
  assert.deepEqual([...historicalRejectedRoutes(JSON.stringify(input), expected).ids], [routeId]);
  for (const patch of [{ coverage: "complete" }, { runId: "other-run" }, { sourceBlock: 124 }, { generation: 4 },
    { sourceBlockHash: `0x${"d".repeat(64)}` }, { routes: [...input.routes, ...input.routes] }])
    assert.throws(() => historicalRejectedRoutes(JSON.stringify({ ...input, ...patch }), expected));
  for (const patch of [{ type: "sim_amount_execution" }, { reason: "rpc-throttle" }, { source_block: 123 },
    { emitted_at_ms: 1000 }, { run_id: "restart" }]) {
    const changed = JSON.stringify({ ...event, ...patch });
    assert.throws(() => historicalRejectedRoutes(JSON.stringify({ ...input,
      routes: [{ ...input.routes[0], rawLine: changed, lineSha256: sha(changed) }] }), expected));
  }
  assert.throws(() => historicalRejectedRoutes(JSON.stringify({ ...input, cutoff: { ...input.cutoff, emittedAtMs: 1001 } }), expected));
  const stale = JSON.stringify({ ...cutoff, pricing_mode: "n_minus_one_coarse_current_n_exact", coarse_source_block: 122 });
  assert.throws(() => historicalRejectedRoutes(JSON.stringify({ ...input,
    cutoff: { ...input.cutoff, proof: { ...input.cutoff.proof, rawLine: stale, lineSha256: sha(stale) } } }), expected));
  const dir = mkdtempSync(join(tmpdir(), "at-block-reject-test-"));
  try {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, rawLine + cutoffLine);
    const verified = { ...input, evidence: { path, prefixBytes: Buffer.byteLength(rawLine), prefixSha256: sha(rawLine) } };
    await historicalRejectedRoutes(JSON.stringify(verified), expected).verifyEvidence();
    await assert.rejects(historicalRejectedRoutes(JSON.stringify({ ...verified,
      evidence: { ...verified.evidence, prefixSha256: "c".repeat(64) } }), expected).verifyEvidence(), /prefix hash mismatch/);
    await assert.rejects(historicalRejectedRoutes(JSON.stringify({ ...verified,
      routes: [{ ...verified.routes[0], byteOffset: 1 }] }), expected).verifyEvidence());
    writeFileSync(path, "x" + rawLine.slice(1) + cutoffLine);
    await assert.rejects(historicalRejectedRoutes(JSON.stringify(verified), expected).verifyEvidence(), /original source bytes/);
  } finally { rmSync(dir, { recursive: true }); }
});
test("historical sim sizing is an explicit opt-in and never an offline or target-route shortcut", () => {
  assert.equal(parseAtBlockArgs(base)?.amountSelector, "solver");
  assert.equal(parseAtBlockArgs([...base, "--amount-selector", "sim"])?.amountSelector, "sim");
  assert.throws(() => parseAtBlockArgs([...base, "--amount-selector", "unknown"]), /invalid --amount-selector/);
  assert.throws(() => parseAtBlockArgs([...base, "--amount-selector", "sim", "--through", "prices"]), /online sizing/);
  assert.throws(() => parseAtBlockArgs(["--prices", "p", "--block", "123", "--out", "o", "--offline", "--amount-selector", "sim"]), /online sizing/);
});

test("historical target selection only filters actual natural outputs and preserves production planning", async () => {
  assert.equal(parseAtBlockArgs(base)?.onlyEnumeratedRank, undefined);
  assert.equal(parseAtBlockArgs([...base, "--only-enumerated-rank", "25"])?.onlyEnumeratedRank, 25);
  for (const rank of ["0", "-1", "1.5", "NaN"])
    assert.throws(() => parseAtBlockArgs([...base, "--only-enumerated-rank", rank]));
  assert.throws(() => parseAtBlockArgs([...base, "--only-enumerated-rank", "1", "--through", "enumerate"]));
  const make = (digit: string) => ({ seedEdges: [{ adapterId: "fixture", target: `0x${digit.repeat(40)}`,
    tokenIn: `0x${"a".repeat(40)}`, tokenOut: `0x${"b".repeat(40)}`, slotKind: "swap" as const, ...deriveEdgeTaxonomy("swap") }] });
  const opportunities = [make("1"), make("2")], called: any[] = [];
  const planner: any = { async planBlockScanFromSeedEdges(...input: any[]) { called.push(input); return ["original plan"]; } };
  assert.throws(() => historicalCandidateSelection(planner, 101, 100));
  const select = historicalCandidateSelection(planner, 2, 100);
  await assert.rejects(planner.planBlockScanFromSeedEdges(opportunities[1], []), /enumeration must finish/);
  const natural: any = { opportunities, selectionProvenance: { kind: "natural_coarse_ranked" },
    forcedSelectionCount: 0, selectionMode: "production" };
  assert.throws(() => select({ ...natural, forcedSelectionCount: 1 }));
  assert.throws(() => select({ ...natural, opportunities: [] }));
  const before = atBlockJson(natural);
  assert.equal(select(natural).routeId, blockScanRouteId(opportunities[1].seedEdges));
  assert.equal(atBlockJson(natural), before, "full natural output is never rewritten");
  assert.deepEqual(await planner.planBlockScanFromSeedEdges(opportunities[0], []), []);
  const templates: any[] = [], opts = { deadlineAtMs: 123 };
  assert.deepEqual(await planner.planBlockScanFromSeedEdges(opportunities[1], templates, opts), ["original plan"]);
  assert.deepEqual(called, [[opportunities[1], templates, opts]]);
});

test("fixed effective P requires online repricing and preserves live default", () => {
  assert.equal(parseAtBlockArgs(base)?.fixedEffectiveWethInput, undefined);
  assert.equal(parseAtBlockArgs([...base, "--effective-weth-input", "0.05"])?.fixedEffectiveWethInput, 50_000_000_000_000_000n);
  for (const value of ["0", "-1", "1e-2", "NaN", "0.0000000000000000001"])
    assert.throws(() => parseAtBlockArgs([...base, "--effective-weth-input", value]));
  assert.throws(() => parseAtBlockArgs(["--prices", "p", "--block", "123", "--out", "o", "--offline", "--effective-weth-input", "0.05"]), /online repricing/);
});
test("CLI funding starts are opt-in, normalized, verified and do not mutate live defaults", () => {
  const token = "0x1111111111111111111111111111111111111111";
  assert.deepEqual(parseAtBlockArgs(base)?.fundingTokens, []);
  const args = parseAtBlockArgs([...base, "--funding-token", token, "--funding-token", token])!;
  assert.deepEqual(args.fundingTokens, [token]);
  for (const value of ["wstUSR", "", "0x12", ethers.ZeroAddress])
    assert.throws(() => parseAtBlockArgs([...base, "--funding-token", value]), /invalid --funding-token/);
  const defaults = resolveBlockScanCoreConfig({}).pricedTokens;
  const sources = new Map([[token, { amount: 123n, adapterId: "fixture-flash", fundingId: "fixture" }]]);
  const resolved = historicalFundingStarts(defaults, args.fundingTokens, sources);
  assert.equal(resolved.get(token)?.maxBorrow, 123n);
  assert.equal(resolved.size, defaults.size + 1);
  assert.equal(defaults.has(token), false);
  assert.deepEqual(historicalFundingStarts(defaults, [], sources), defaults);
  assert.throws(() => historicalFundingStarts(defaults, [token], new Map()), /no positive verified funding/);
  assert.throws(() => historicalFundingStarts(defaults, [token], new Map([[token, { ...sources.get(token)!, amount: 0n }]])), /no positive verified funding/);
  assert.equal(historicalFundingStarts(new Map([[token, { maxBorrow: 10n }]]), [token], sources).get(token)?.maxBorrow, 10n);
  assert.equal(historicalFundingStarts(new Map([[token, { maxBorrow: 1000n }]]), [token], sources).get(token)?.maxBorrow, 123n);
});
test("live and historical policy allow WBTC starts with an eight-decimal search cap", () => {
  const tokens = resolveBlockScanCoreConfig({}).pricedTokens;
  assert.equal(tokens.size, 5);
  assert.equal(tokens.get("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599")?.maxBorrow, 50n * 10n ** 8n);
  assert.equal(tokens.get("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2")?.maxBorrow, 2_000n * 10n ** 18n);
  assert.equal(tokens.get("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")?.maxBorrow, 5_000_000n * 10n ** 6n);
  assert.equal(tokens.get("0xdac17f958d2ee523a2206206994597c13d831ec7")?.maxBorrow, 5_000_000n * 10n ** 6n);
  assert.equal(tokens.get("0x6b175474e89094c44da98b954eedeac495271d0f")?.maxBorrow, 5_000_000n * 10n ** 18n);
});
test("historical executor code is opt-in, hash-bound and cannot override account state", () => {
  assert.equal(parseAtBlockArgs([...base, "--executor-runtime-code", "code.json"])?.executionMode, "next-block");
  assert.throws(() => parseAtBlockArgs(["--prices", "p", "--block", "123", "--out", "o", "--offline",
    "--execution-mode", "source-block", "--executor-runtime-code", "code.json"]));
  assert.equal(parseAtBlockArgs([...base, "--execution-mode", "source-block", "--executor-runtime-code", "code.json"])?.executionMode, "source-block");
  const valid = { code: "0x6000", keccak256: ethers.keccak256("0x6000") };
  assert.deepEqual(parseHistoricalExecutorRuntimeCode(JSON.stringify(valid)), valid);
  for (const value of [{...valid, balance: "0x1"}, {...valid, stateDiff: {}}, {...valid, code: "0x6001"},
    {...valid, code: "0x"}, {...valid, keccak256: "bad"}, null, []])
    assert.throws(() => parseHistoricalExecutorRuntimeCode(JSON.stringify(value)));
});
test("CLI requires explicit immutable inputs and has no broadcast/target-route option", () => {
  assert.equal(parseAtBlockArgs(base)?.through, "ev");
  assert.equal(parseAtBlockArgs([...base, "--spread-bps", "0"])?.["spread-bps"], "0");
  for (const extra of [["--broadcast"], ["--target-tx", "0x12"], ["--prices", "other.json"], ["--through", "live"]])
    assert.throws(() => parseAtBlockArgs([...base, ...extra]));
  for (const block of ["latest", "-1", "1.2", "9007199254740992", "0"])
    assert.throws(() => parseAtBlockArgs(["--ready", "r", "--out", "o", "--block", block]));
  assert.throws(() => parseAtBlockArgs([...base, "--offline"]));
  assert.equal(parseAtBlockArgs(["--prices", "p", "--out", "o", "--block", "123", "--offline"])?.through, "enumerate");
});

test("price serialization preserves bigint, readonly maps, sets and unavailable infinity", () => {
  const values = { amount: 123456789012345678901n, rates: new Map([["a", { num: 3n, den: 7n }]]),
    coverage: new Set(["a", "b"]), unbounded: Infinity };
  assert.deepEqual(parseAtBlockJson(atBlockJson(values)), values);
});

test("CLI and live share joint-DFS defaults and retain explicit rollback methods", () => {
  const cfg = resolveBlockScanCoreConfig({});
  assert.equal(cfg.allowRepeatedPools, true);
  assert.equal(cfg.enumerationMethod, "joint-dfs");
  assert.equal(cfg.enumerationBackend, "typescript");
  assert.equal(cfg.rustEnumerationThreads, 1);
  assert.equal(cfg.rustEnumerationScratchMb, 512);
  assert.equal(BLOCKSCAN_ENUMERATION_DEFAULTS.rustEnabled, false);
  assert.equal(resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_ENUMERATION_BACKEND: "typescript",
    SEARCHER_BLOCKSCAN_ENUMERATION_METHOD: "dfs" }).enumerationBackend, "typescript");
  for (const method of ["joint-dfs", "dfs", "layered"])
    assert.throws(() => resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_ENUMERATION_BACKEND: "rust",
      SEARCHER_BLOCKSCAN_ENUMERATION_METHOD: method }), /Rust enumeration is disabled/);
  const nativeKnobsOff = resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_RUST_THREADS: "8",
    SEARCHER_BLOCKSCAN_RUST_SCRATCH_MB: "bad" });
  assert.equal(nativeKnobsOff.rustEnumerationThreads, 1);
  assert.equal(nativeKnobsOff.rustEnumerationScratchMb, 512);
  for (const raw of ["", "auto", "js"])
    assert.throws(() => resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_ENUMERATION_BACKEND: raw }), /must be rust or typescript/);
  for (const method of ["joint-dfs", "dfs", "layered"]) for (const reuse of ["0", "1"]) for (const dedup of ["0", "1"]) {
    const current = resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_ALLOW_REPEATED_POOLS_ENABLED: reuse,
      SEARCHER_BLOCKSCAN_DEDUP_ROTATIONS_ENABLED: dedup, SEARCHER_BLOCKSCAN_ENUMERATION_METHOD: method });
    assert.equal(current.allowRepeatedPools, reuse === "1");
    assert.equal(current.deduplicateRotations, dedup === "1");
    assert.equal(current.enumerationMethod, method);
  }
  for (const raw of ["", "false", "2"])
    assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_ALLOW_REPEATED_POOLS_ENABLED:raw}), /must be 0 or 1/);
  assert.equal(cfg.deduplicateRotations, true, "default keeps one funded execution start per cycle");
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_DEDUP_ROTATIONS_ENABLED:"0"}).deduplicateRotations, false);
  assert.equal(resolveBlockScanCoreConfig({}).allowRepeatedTokens, false);
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_ALLOW_REPEATED_TOKENS_ENABLED:"0"}).allowRepeatedTokens, false);
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_ALLOW_REPEATED_TOKENS_ENABLED:"1"}).allowRepeatedTokens, true);
  assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_ALLOW_REPEATED_TOKENS_ENABLED:"false"}), /must be 0 or 1/);
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_DEDUP_ROTATIONS_ENABLED:"1"}).deduplicateRotations, true);
  assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_DEDUP_ROTATIONS_ENABLED:"false"}), /must be 0 or 1/);
  assert.equal(cfg.maxHops, 6); assert.equal(cfg.minSpreadBps, 0);
  assert.equal(cfg.ethSignalPairsPerToken, 50);
  assert.equal(cfg.hopTokensPerStep, 3);
  assert.equal(cfg.hopPoolsPerPair, 3);
  for (const n of ["0", "1", "2", "3", "20"]) {
    const tokens = resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_HOP_TOKENS_PER_STEP:n});
    assert.equal(tokens.hopTokensPerStep, Number(n));
    assert.equal(tokens.hopPoolsPerPair, 3);
    const pools = resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_HOP_POOLS_PER_PAIR:n});
    assert.equal(pools.hopPoolsPerPair, Number(n));
    assert.equal(pools.hopTokensPerStep, 3);
  }
  for (const n of ["", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
    assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_HOP_TOKENS_PER_STEP:n}), /nonnegative safe integer/);
    assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_HOP_POOLS_PER_PAIR:n}), /nonnegative safe integer/);
  }
  const unlimited = resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_HOP_TOKENS_PER_STEP:"0",
    SEARCHER_BLOCKSCAN_HOP_POOLS_PER_PAIR:"0"});
  assert.equal(unlimited.hopTokensPerStep, 0); assert.equal(unlimited.hopPoolsPerPair, 0);
  const rollback = resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_HOP_TOKENS_PER_STEP:"2",
    SEARCHER_BLOCKSCAN_HOP_POOLS_PER_PAIR:"2"});
  assert.equal(rollback.hopTokensPerStep, 2); assert.equal(rollback.hopPoolsPerPair, 2);
  assert.deepEqual(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_HOP_QUOTES_PER_PAIR:"99"}), cfg,
    "retired setting cannot override the explicit HOP_POOLS_PER_PAIR policy");
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_USD_SIGNAL_PAIRS_PER_TOKEN:"1"}).ethSignalPairsPerToken, 1);
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_ETH_SIGNAL_PAIRS_PER_TOKEN:"3"}).ethSignalPairsPerToken, 3);
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_ETH_SIGNAL_PAIRS_PER_TOKEN:"3",
    SEARCHER_BLOCKSCAN_USD_SIGNAL_PAIRS_PER_TOKEN:"1"}).ethSignalPairsPerToken, 3);
  assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_USD_SIGNAL_PAIRS_PER_TOKEN:"0"}), /positive safe integer/);
  assert.equal(cfg.exactAdmissionSpreadBps, 0); assert.equal(cfg.maxCandidates, 100);
  assert.equal(cfg.budgetMs, 2000);
  assert.equal(resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_SCAN_BUDGET_MS: "15000" }).budgetMs, 15000,
    "explicit historical budgets remain configurable");
  const policy = resolveBlockScanAtomicPolicy({});
  assert.equal(policy.maxProfitBpsOfFlash, 10000n);
  assert.equal(policy.dryRun, false); assert.equal(policy.blockScanSubmit, false);
  assert.equal(policy.evGate, false);
});

test("live and historical enumeration share the 512 coarse and 100 downstream defaults", () => {
  const cfg = resolveBlockScanCoreConfig({});
  assert.equal(resolveBlockScanRefineCandidates({}, cfg.maxCandidates), 512);
  assert.equal(cfg.maxCandidates, 100);
  const small = resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_MAX_CANDIDATES:"100"});
  assert.equal(small.maxCandidates, 100, "downstream cap remains explicitly configurable");
  assert.equal(resolveBlockScanRefineCandidates({}, small.maxCandidates), 512);
  assert.equal(resolveBlockScanRefineCandidates({SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:"512"}, small.maxCandidates), 512);
  assert.equal(resolveBlockScanRefineCandidates({SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:"4096"}, cfg.maxCandidates), 4096);
  assert.equal(resolveBlockScanRefineCandidates({SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:"12.9"}, 0), 12);
  assert.equal(resolveBlockScanRefineCandidates({SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:"0"}, cfg.maxCandidates), 100);
  for (const raw of ["NaN", "Infinity", "invalid"])
    assert.equal(resolveBlockScanRefineCandidates({SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:raw}, cfg.maxCandidates), 512);
  assert.equal(resolveBlockScanRefineCandidates({}, 3000), 3000, "coarse cap cannot be smaller than final cap");
});

test("enumeration defaults have one source and prefix pruning is explicitly configurable", () => {
  const defaults = BLOCKSCAN_ENUMERATION_DEFAULTS;
  const cfg = resolveBlockScanCoreConfig({});
  assert.equal(cfg.maxHops, defaults.maxHops);
  assert.equal(cfg.maxCandidates, defaults.maxCandidates);
  assert.equal(resolveBlockScanRefineCandidates({}), defaults.refineCandidates);
  assert.equal(cfg.budgetMs, defaults.budgetMs);
  assert.equal(cfg.enumerationMethod, defaults.method);
  assert.equal(cfg.enumerationBackend, defaults.backend);
  assert.equal(cfg.rustEnumerationThreads, defaults.rustThreads);
  assert.equal(cfg.rustEnumerationScratchMb, defaults.rustScratchMb);
  assert.equal(cfg.allowRepeatedPools, defaults.allowRepeatedPools);
  assert.equal(cfg.allowRepeatedTokens, defaults.allowRepeatedTokens);
  assert.equal(cfg.deduplicateRotations, defaults.deduplicateRotations);
  assert.equal(cfg.ethSignalPairsPerToken, defaults.signalPairsPerToken);
  assert.equal(cfg.minSpreadBps, defaults.minSpreadBps);
  assert.equal(cfg.exactAdmissionSpreadBps, defaults.exactAdmissionSpreadBps);
  assert.equal(cfg.minCapitalFraction, defaults.minCapitalFraction);
  assert.equal(cfg.prefixPruningEnabled, true);
  assert.equal(cfg.maxPrefixDrawdownBps, 0);
  for (const enabled of ["0", "1"]) for (const drawdown of [0, 1000, 2000, 10000]) {
    const current = resolveBlockScanCoreConfig({
      SEARCHER_BLOCKSCAN_PREFIX_PRUNING_ENABLED: enabled,
      SEARCHER_BLOCKSCAN_MAX_PREFIX_DRAWDOWN_BPS: String(drawdown),
    });
    assert.equal(current.prefixPruningEnabled, enabled === "1");
    assert.equal(current.maxPrefixDrawdownBps, drawdown);
  }
  for (const raw of ["", "false", "true", "2", "-1"]) {
    assert.throws(() => resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_PREFIX_PRUNING_ENABLED: raw }), /must be 0 or 1/);
  }
  for (const raw of ["", " ", "-1", "10001", "1.5", "NaN", "Infinity", "1e3", "0x10", "9007199254740992"]) {
    assert.throws(() => resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_MAX_PREFIX_DRAWDOWN_BPS: raw }), /integer from 0 to 10000/);
  }
});

test("historical mode is mechanically forbidden with live signing/submission posture", async () => {
  for (const config of [{ dryRun: false, blockScanSubmit: false }, { dryRun: true, blockScanSubmit: true }])
    await assert.rejects(maybeSubmitBlockScanAtomic({ historicalReadOnly: true, config } as any), /requires dry-run/);
});

for (const historicalReadOnly of [false, true]) {
  test(`${historicalReadOnly ? "historical" : "live"} final gate reads ${historicalReadOnly ? "explicit source" : "latest"}, never accepts a wrong hash`, async () => {
    const hash = `0x${"ab".repeat(32)}`;
    const calls: unknown[][] = [];
    const provider = { async send(method: string, params: unknown[]) {
      calls.push([method, params]); return { number: "0x7b", hash: `0x${"cd".repeat(32)}` };
    } };
    const result = await maybeSubmitBlockScanAtomic({ historicalReadOnly,
      config: { ...resolveBlockScanAtomicPolicy({}), dryRun: true, blockScanSubmit: false, finalVerifyFloorBps: 0n },
      provider: provider as any, sourceBlock: 123, sourceBlockHash: hash, sourceGeneration: 1,
      opp: { seedEdges: [], flashToken: ethers.ZeroAddress, affectedTokens: [], cycleId: "fixture", cycleFingerprint: "fixture" } as any,
      resolved: { root: { adapterId: "erc20-transfer", target: ethers.ZeroAddress, children: [] }, netProfit: 1n, flashAmount: 100n } as any,
      finalSimulationRuntime: { execute() { throw new Error("wrong source must not reach sim"); } } as any,
      bundleRouter: { async submit() { throw new Error("must not submit"); } },
      submissionCoordinator: { offer() { throw new Error("must not submit"); } },
      ring: "fixture", protoRing: false, plans: 1, passDeadlineAtMs: Date.now() + 1000,
      simRejects: new BlockScanSimRejectCache(), profitTokenValuation: DEFAULT_PROFIT_TOKEN_VALUATION,
      signal: new AbortController().signal, collectBlindAudit: true,
      strategyVersions: { strategy_view_version: "fixture", blockscan_view_hash: hash },
    });
    assert.equal(result.decision, "blockscan_stale_state");
    assert.equal(result.finalSimStatus, "not-run"); assert.equal(result.submitted, false);
    assert.deepEqual(calls, [["eth_getBlockByNumber", [historicalReadOnly ? "0x7b" : "latest", false]]]);
  });
}

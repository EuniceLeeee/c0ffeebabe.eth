import assert from "node:assert/strict";
import test from "node:test";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { createAdapterFamilyExactQuoteCache } from "../../../../adapter-family-exact-quote-cache.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { executeAdapterFamilyLifecycleBatch } from "../../../adapter-family-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../../../production-family-composition.js";
import { FamilyCapabilityCatalog, isPricedFamily } from "../../../family-capability-catalog.js";
import { generatedCapabilityManifestFromShadowArtifact } from "../../../family-capability-shadow.js";
import artifact from "../../../../generated/family-capability-shadow.generated.json";
import { CTOKEN_FAMILY_ID } from "../manifest.js";
import { CTOKEN_INTERFACE, CTOKEN_REDEEM_CALL_PATTERN_ID } from "../abi.js";
import { EXECUTOR, MARKET } from "./fixtures.js";
import { fixture, source, state } from "./runtime-fixture.js";

// Test installed definitions without enabling a default-disabled production Family.
const modules = [...load.plugins, ...load.disabledPlugins];
const catalog = new FamilyCapabilityCatalog({ modules, requireCapture: true,
  generatedManifest: generatedCapabilityManifestFromShadowArtifact({ artifact, strictFamilyIds: modules.map(m => m.familyId) }) });

for (const path of ["coarse", "runtime"] as const) test(`${path}: Compound accrual refresh withdraws failed quotes and recovers without stored-rate fallback`, async () => {
  const s = state(), at = source(), family = catalog.forFamily(CTOKEN_FAMILY_ID);
  assert(isPricedFamily(family));
  const life = await executeAdapterFamilyLifecycleBatch({ family, source: at, generation: at.generation,
    runtime: fixture(at, s).runtime, publisher: { publish() {} }, matches: [{ matchedPatternId: CTOKEN_REDEEM_CALL_PATTERN_ID,
      observation: { kind: "call", source: at, target: MARKET, data: CTOKEN_INTERFACE.encodeFunctionData("redeem", [100000000n]) } }] });
  assert(life.publication, JSON.stringify(life.outcomes));
  const ready = life.publication.instances; assert.equal(ready.length, 1);
  const edges = buildFamilyRouteGraphView({ routes: ready.flatMap(i => i.routes.map((route, n) => ({ family, descriptor: i.descriptor, route, handle: i.routeHandles[n] }))) }).edges;
  assert.equal(edges.length, 1);
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: at, readyGraph: edges, readyInstances: ready, readyFundingAssets: [] });
  const cache = createAdapterFamilyExactQuoteCache();
  const sessions: ReturnType<typeof fixture>[] = [], exactSessions: ReturnType<typeof fixture>[] = [];
  const graph = (now: ReturnType<typeof source>) => createVerifiedGraphView({ id: `compound-refresh-${now.number}`, edges,
    generation: now.generation, sourceBlock: now.number, sourceBlockHash: now.hash, completenessWatermark: now.number,
    familyIdForEdge: () => CTOKEN_FAMILY_ID, perSourceCoverage: [{ familyId: CTOKEN_FAMILY_ID, sourceId: "synthetic-compound",
      sourceFingerprint: "compound-refresh", completeThroughBlock: now.number, completeThroughHash: now.hash }] });
  const coordinator = new StrictCurrentRuntimeCoordinator(i => {
    const f = fixture(i.source, s, undefined, cache); sessions.push(f);
    return root.createSession({ source: i.source, runtime: f.runtime, fundingAssets: [],
      kind: i.purpose === "exact-execution" ? "exact" : "pricing", touchedPools: i.touchedPools, requiredEdgeIds: i.requiredEdgeIds, control: i.control });
  }, () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const target = reuse?.quoteGraph ?? pricing;
    const now = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous, touchedStateKeys: reuse?.touchedStateKeys,
      disabledEdgeIds: reuse?.disabledEdgeIds, control,
      // Synthetic valuation anchor only: this single redemption graph has no
      // WETH acquisition leg. It tests scheduling, not production valuation.
      weth: MARKET, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 2,
      prepareQuote: async requiredEdgeIds => {
        const f = fixture(now, s, undefined, cache); exactSessions.push(f);
        exact = await root.createSession({ source: now, runtime: f.runtime, fundingAssets: [], kind: "exact", requiredEdgeIds, control });
      },
      quote: async request => { assert(exact); const q = await exact.issueExact({ ...request, executor: EXECUTOR, runtimeEvidence: [] }); assert("amountIn" in q); return q; },
    });
  }, cache);
  let previous = source(99);
  async function step(n: number) {
    const now = source(n);
    const input = { graph: graph(now), deadlineAtMs: Date.now() + 10000,
      ...(n === at.number ? {} : { touchedPools: new Set<string>(), canonicalActivity: { source: now,
        parentHash: previous.hash, touchedStateKeys: new Set<string>(), complete: true as const } }) };
    if (path === "coarse") await coordinator.prepareCoarsePricing(input);
    else await coordinator.prepare({ ...input, fundingTokens: [] });
    previous = now;
    const p = coordinator.latestPricingSnapshot(); assert(p?.effectiveMids);
    assert.deepEqual(p.effectiveMids.source, now);
    assert.equal(p.sourceBlock, now.number); assert.equal(p.sourceBlockHash, now.hash); assert.equal(p.generation, now.generation);
    return p;
  }
  const first = await step(100), firstRow = [...first.effectiveMids!.rows.values()][0];
  assert.equal(firstRow.status, "quoted"); assert.equal(firstRow.quotedAt?.number, 100);
  assert(first.perBlockRefreshStateKeys?.includes(ready[0].instanceKey));
  const storedReads = () => sessions.flatMap(f => f.reads).filter(r => r.method === "exchangeRateStored").length;
  assert.equal(storedReads(), 1, "one bootstrap raw-rate read");
  const currentReads = () => exactSessions.flatMap(f => f.reads).filter(r => r.method === "exchangeRateCurrent").length;
  const before = currentReads(); assert(before > 0);
  s.current *= 2n; // Accrual changes with no logs, traces or touched keys.
  const second = await step(101), secondRow = [...second.effectiveMids!.rows.values()][0];
  assert.equal(secondRow.status, "quoted"); assert.equal(secondRow.quotedAt?.number, 101);
  assert.equal(secondRow.amountIn, firstRow.amountIn); assert.notEqual(secondRow.amountOut, firstRow.amountOut);
  assert(currentReads() > before, "real coordinator must request current accrual on a quiet new block");
  assert.equal(storedReads(), 1); assert.equal(second.rawMidSource?.number, 100);
  assert.deepEqual([...second.mids], [...first.mids], "bootstrap raw is not relabelled as freshly accrued");
  const f = fixture(source(101), s, undefined, cache);
  const exact = await root.createSession({ source: source(101), runtime: f.runtime, fundingAssets: [], kind: "exact" });
  const issue = (amountIn: bigint) => exact.issueExact({ edge: edges[0], amountIn, executor: EXECUTOR, runtimeEvidence: [] });
  const firstExact = await issue(100000000n); assert("amountOut" in firstExact);
  const count = f.reads.length; assert.equal(count, 2, "ordinary quote uses current+cash in one request round");
  const repeated = await issue(100000000n); assert("amountOut" in repeated);
  assert.equal(firstExact.amountOut, repeated.amountOut); assert.equal(f.reads.length, count, "same source+amount central cache still works");
  await issue(200000000n);
  assert.equal(f.reads.length, count + 2, "without stateOnlyReads a different amount retains no amount-free rate evidence");
  s.failCurrent = true;
  for (const n of [102, 103]) {
    const readsBefore = currentReads();
    const failed = await step(n), row = [...failed.effectiveMids!.rows.values()][0]!;
    assert(currentReads() > readsBefore, "a new block retries the failed current rate");
    assert.equal(row.status, "quote-failed");
    assert.equal(row.amountOut, null); assert.equal(row.effectiveMid, null);
    assert.equal(row.quotedAt, undefined, "no stored/previous successful rate fallback");
    assert(!failed.coverage.resolvedEdgeKeys.includes(row.edgeId));
    assert.equal(storedReads(), 1, "failure never causes stored-rate fallback reads");
  }
  s.failCurrent = false; s.current *= 2n;
  const readsBeforeRecovery = currentReads();
  const recovered = await step(104), recoveredRow = [...recovered.effectiveMids!.rows.values()][0]!;
  assert(currentReads() > readsBeforeRecovery, "recovery requires a fresh current-rate read");
  assert.equal(recoveredRow.status, "quoted"); assert.deepEqual(recoveredRow.quotedAt, source(104));
  assert.equal(recoveredRow.amountIn, firstRow.amountIn);
  assert.equal(recoveredRow.amountOut, secondRow.amountOut! * 2n);
  assert(recovered.coverage.resolvedEdgeKeys.includes(recoveredRow.edgeId));
  assert.equal(storedReads(), 1); assert.equal(recovered.rawMidSource?.number, 100);
});

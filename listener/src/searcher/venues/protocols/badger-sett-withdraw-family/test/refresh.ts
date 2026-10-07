import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { executeAdapterFamilyLifecycleBatch, recheckFamilyInstanceMemoBinding } from "../../../adapter-family-runtime.js";
import { isPricedFamily } from "../../../family-capability-catalog.js";
import { FAMILY } from "../manifest.js";
import { VAULT, WAD } from "../codec.js";
import { actor, original, source, fixture, runtime, testCatalog } from "./fixture.js";
// Real lifecycle/Graph/current/Exact/execution issuers, synthetic transport.
// No saved Ready/catalog or natural USD valuation is manufactured by this test.
test("production issuance + each-block refresh: quiet failures, retry, proxy/strategy change and normal re-admission", async () => {
  const f = fixture(), catalog = testCatalog(), family = catalog.forFamily(FAMILY), start = source();
  assert(isPricedFamily(family));
  const candidate = { candidateKind: "badger-sett-withdraw", vault: original.vault };
  async function admit(at = start) {
    const result = await executeAdapterFamilyLifecycleBatch({ family, source: at, generation: at.generation, runtime: runtime(f, at),
      publisher: { publish() {} }, matches: [{ matchedPatternId: "badger-sett-withdraw-call",
        observation: { kind: "call", source: at, target: f.binding.vault, data: VAULT.encodeFunctionData("withdraw", [WAD]) } }] });
    assert(result.publication, JSON.stringify(result.outcomes)); assert.equal(result.publication.instances.length, 1);
    return result.publication.instances;
  }
  function makeRoot(ready: Awaited<ReturnType<typeof admit>>, at = start) {
    const edges = buildFamilyRouteGraphView({ routes: ready.flatMap(i => i.routes.map((route, n) => ({ family, descriptor: i.descriptor, route, handle: i.routeHandles[n] }))) }).edges;
    assert.equal(edges.length, 1);
    return { edges, root: new StrictProductionRuntimeRoot({ catalog, readySource: at, readyGraph: edges, readyInstances: ready, readyFundingAssets: [] }) };
  }
  const ready = await admit(), { edges, root } = makeRoot(ready);
  const graph = (at: ReturnType<typeof source>) => createVerifiedGraphView({ id: "badger-offline-refresh-" + at.number, edges,
    generation: at.generation, sourceBlock: at.number, sourceBlockHash: at.hash, completenessWatermark: at.number,
    familyIdForEdge: () => FAMILY, perSourceCoverage: [{ familyId: FAMILY, sourceId: "synthetic-test", sourceFingerprint: "offline-only",
      completeThroughBlock: at.number, completeThroughHash: at.hash }] });
  const currentReads: string[] = [], exactReads: string[] = [];
  const coordinator = new StrictCurrentRuntimeCoordinator(i => root.createSession({ source: i.source, runtime: runtime(f, i.source, currentReads),
    fundingAssets: [], kind: i.purpose === "exact-execution" ? "exact" : "pricing", requiredEdgeIds: i.requiredEdgeIds,
    touchedPools: i.touchedPools, control: i.control }), () => {}, undefined,
    async (pricing, control, _backend, reuse) => {
      const target = reuse?.quoteGraph ?? pricing, at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
      let exact: StrictProductionRuntimeSession | undefined;
      return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous, touchedStateKeys: reuse?.touchedStateKeys, control,
        // This single-route offline contract has no acquisition edge. A share
        // amount anchor tests refresh only, NEVER natural production effective P.
        weth: original.vault, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 1,
        prepareQuote: async requiredEdgeIds => { exact = await root.createSession({ source: at, runtime: runtime(f, at, exactReads), kind: "exact", fundingAssets: [], requiredEdgeIds, control }); },
        quote: async request => { assert(exact); const q = await exact.issueExact({ ...request, executor: actor, runtimeEvidence: [] }); assert("amountIn" in q); return q; } });
    });
  let previous = source(99);
  async function step(n: number) {
    const at = source(n), touched = new Set<string>();
    await coordinator.prepareCoarsePricing({ graph: graph(at), deadlineAtMs: Date.now() + 10000,
      touchedPools: n === 100 ? undefined : touched,
      ...(n === 100 ? {} : { canonicalActivity: { source: at, parentHash: previous.hash, touchedStateKeys: touched, complete: true } }) });
    previous = at; const p = coordinator.latestPricingSnapshot(); assert(p); return p;
  }
  const first = await step(100); assert.equal(first.mids.size, 1);
  const row = (p: Awaited<ReturnType<typeof step>>) => [...p.effectiveMids!.rows.values()][0];
  assert.equal(row(first).status, "quoted");
  exactReads.length = 0; currentReads.length = 0;
  const quiet = await step(101); assert.equal(row(quiet).status, "quoted");
  assert.equal(row(quiet).quotedAt?.number, 101); assert(exactReads.length > 0, "each-block effective must not carry old quote");
  assert.equal(currentReads.length, 0, "current production raw mids remain bootstrap references");
  f.state = { ...f.state, feeBps: 200n };
  const fee = await step(102); assert.equal(row(fee).status, "quoted"); assert.notEqual(row(fee).amountOut, row(first).amountOut);
  f.state = { ...f.state, vaultPaused: true };
  assert.notEqual(row(await step(103)).status, "quoted");
  assert.notEqual(row(await step(104)).status, "quoted", "quiet block must not revive stale effective");
  f.state = { ...f.state, vaultPaused: false };
  assert.equal(row(await step(105)).status, "quoted");
  f.failure = true; assert.notEqual(row(await step(106)).status, "quoted");
  f.failure = false; assert.equal(row(await step(107)).status, "quoted");
  f.codes.strategy = "0x6000"; assert.notEqual(row(await step(108)).status, "quoted");
  delete f.codes.strategy; assert.equal(row(await step(109)).status, "quoted");
  f.binding = { ...f.binding, strategy: ethers.toBeHex(1234, 20), strategyImplementation: ethers.toBeHex(1235, 20) };
  assert.notEqual(row(await step(110)).status, "quoted"); assert.notEqual(row(await step(111)).status, "quoted");
  const at = source(112), oldFingerprint = ready[0].staticBindingFingerprint;
  const rechecked = await recheckFamilyInstanceMemoBinding({ family, candidate, source: at, generation: at.generation, runtime: runtime(f, at) });
  assert(rechecked); assert.notEqual(rechecked.fingerprint, oldFingerprint);
  const replacement = await admit(at), next = makeRoot(replacement, at);
  assert.notEqual(replacement[0].staticBindingFingerprint, oldFingerprint);
  assert.deepEqual(root.resolveBlockTouchedStateKeys({ kind: "call", target: f.binding.strategy, data: "0x12345678" }, at), []);
  assert(next.root.resolveBlockTouchedStateKeys({ kind: "call", target: f.binding.strategy, data: "0x12345678" }, at).includes(replacement[0].instanceKey));
  assert.deepEqual(next.root.resolveBlockTouchedStateKeys({ kind: "call", target: original.strategy, data: "0x12345678" }, at), []);
  const reads: string[] = [], exact = await next.root.createSession({ source: at, runtime: runtime(f, at, reads), kind: "exact", fundingAssets: [] });
  const edge = next.edges[0], before = reads.length;
  assert(exact.buildRuntimeAmountLeg({ edge, executor: actor, runtimeEvidence: [] }));
  assert.equal(reads.length, before, "runtime constructs before Exact with zero added reads");
  const quote = await exact.issueExact({ edge, amountIn: WAD, executor: actor, runtimeEvidence: [] }); assert("amountIn" in quote);
  assert.equal(exact.buildExecution({ edge, exact: quote, minAmountOut: quote.amountOut, executor: actor }).status, "resolved");
});

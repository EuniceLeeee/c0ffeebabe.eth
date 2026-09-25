import assert from "node:assert/strict";
import type { CentralAdapterRuntime } from "../../../../adapter-work-intent.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { createAdapterFamilyExactQuoteCache } from "../../../../adapter-family-exact-quote-cache.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { readBlockTouchedStateKeys } from "../../../../blockscan-touched-state.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { FAMILY } from "../manifest.js";

// Only the transport/state is synthetic. Admission, graph projection, amount
// reference selection, raw/effective publication and refresh are production code.
export function refreshFixture(input: {
  publication: Awaited<ReturnType<typeof runStrictFamilyLifecycle>>;
  start: CanonicalSource;
  executor: string;
  asset: string;
  runtime(source: CanonicalSource, lane: "raw" | "exact"): CentralAdapterRuntime;
}) {
  const family = catalog.forFamily(FAMILY);
  const edges = buildFamilyRouteGraphView({ routes: input.publication.instances.flatMap(instance =>
    instance.routes.map((route, i) => ({ family, descriptor: instance.descriptor,
      route, handle: instance.routeHandles[i] }))) }).edges;
  assert.equal(edges.length, 2);
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: input.start,
    readyGraph: edges, readyInstances: input.publication.instances, readyFundingAssets: [] });
  const cache = createAdapterFamilyExactQuoteCache();
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({
    source: request.source, runtime: input.runtime(request.source, "raw"),
    fundingAssets: [], kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    touchedPools: request.touchedPools, requiredEdgeIds: request.requiredEdgeIds, control: request.control,
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const target = reuse?.quoteGraph ?? pricing;
    const at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, control,
      // The synthetic asset is the fixture's valuation anchor, not a claim
      // that the real underlying is WETH or has this production valuation.
      weth: input.asset, gasCostWei: null, enumerationSpreadBps: 50, concurrency: 2,
      prepareQuote: async requiredEdgeIds => {
        exact = await root.createSession({ source: at, runtime: input.runtime(at, "exact"),
          fundingAssets: [], kind: "exact", requiredEdgeIds, control });
      },
      quote: async request => {
        assert(exact);
        const result = await exact.issueExact({ ...request, executor: input.executor,
          runtimeEvidence: [], requireChainAmountQuote: true });
        assert("amountIn" in result); return result;
      },
    });
  }, cache);
  let previous = input.start;
  async function step(at: CanonicalSource) {
    const touched = await readBlockTouchedStateKeys({
      async getLogs() { return []; },
      async send(method) { assert.equal(method, "debug_traceBlockByHash"); return []; },
    }, at.number, input.executor, { hash: at.hash, parentHash: previous.hash,
      transactionHashes: [] }, undefined, root.resolveBlockTouchedStateKeys);
    assert.equal(touched.size, 0);
    await coordinator.prepareCoarsePricing({ graph: createVerifiedGraphView({
      id: `conversion-fixture-${at.number}`, edges, generation: at.generation,
      sourceBlock: at.number, sourceBlockHash: at.hash, completenessWatermark: at.number,
      familyIdForEdge: () => FAMILY,
      perSourceCoverage: [{ familyId: FAMILY, sourceId: "offline-fixture",
        sourceFingerprint: "conversion-empty-block", completeThroughBlock: at.number,
        completeThroughHash: at.hash }],
    }), deadlineAtMs: Date.now() + 20_000, touchedPools: touched,
      canonicalActivity: { source: at, parentHash: previous.hash, touchedStateKeys: touched, complete: true } });
    assert.equal(touched.size, 0, "policy must not mutate observed activity");
    previous = at;
    const result = coordinator.latestPricingSnapshot(); assert(result);
    return result;
  }
  return { root, cache, step };
}

import assert from "node:assert/strict";
import { ethers } from "ethers";
import sample from "./public-sample.json";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { buildEffectiveMids, effectiveEnumerationMids } from "../../../../blockscan-effective-mid.js";
import { createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { executeAdapterFamilyLifecycleBatch } from "../../../adapter-family-runtime.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { ELLA_ID } from "../manifest.js";
import { BALANCE, FEES, MULTICALL, ORACLE, POOL, TOKEN, assertSource } from "../codec.js";

// Synthetic transitions through real production lifecycle/session/coordinator/
// effective/Exact. This is a wiring regression, not additional historical proof.
const fixture = sample.states[0];
const slots: Readonly<Record<string, string>> = fixture.slots;
const word = (value: bigint | string) => ethers.toBeHex(BigInt(value), 32);
const pool = "0x33c577296b0cdece6186ea48cd8fe98bd1a6e3a4";
const otherPool = "0x1000000000000000000000000000000000000004";
const otherOracle = "0x1000000000000000000000000000000000000005";
const otherAggregator = "0x1000000000000000000000000000000000000006";
const executor = "0x1000000000000000000000000000000000000002";
const token = ethers.getAddress(ethers.toBeHex(BigInt(fixture.slots[1]), 20)).toLowerCase();
const factory = ethers.getAddress(ethers.toBeHex(BigInt(fixture.slots[10]), 20)).toLowerCase();
const oracle = ethers.getAddress(ethers.toBeHex(BigInt(fixture.slots[15]), 20)).toLowerCase();
const aggregator = "0x3547473da7deb396acf07d57340a8ef931d7414e";
const source = (number: number): CanonicalSource => ({ number, hash: word(BigInt(number)), generation: number });
const start = source(900), next = source(901);
let failureMode: "read" | "oracle" | "aggregator" | undefined;
const rawReads: string[] = [], amountReads: string[] = [];
function runtime(at: CanonicalSource, lane: "raw" | "exact") {
  const mode = failureMode;
  return createStrictCentralAdapterRuntime({ executor,
    generationFence: { assertCurrent(generation, current) {
      assert.equal(generation, at.generation); assertSource(current, at);
    } },
    provider: {
      async getCode(address, block) {
        assert.equal(block, at.number);
        if ([pool, otherPool].includes(address.toLowerCase())) return sample.poolCode;
        return address.toLowerCase() === factory ? sample.factoryCode : "0x6000";
      },
      async getStorage(address, slot, block) {
        assert.equal(block, at.number);
        const index = Number(BigInt(slot));
        if (index === 15 && address.toLowerCase() === otherPool) return word(otherOracle);
        if (index === 15 && address.toLowerCase() === pool && mode === "oracle") return word(otherOracle);
        return slots[String(index)] ?? word(0n);
      },
      async call(request, block) {
        assert.equal(block, at.number);
        const target = request.to.toLowerCase(), selector = request.data.slice(0, 10);
        if (selector === POOL.getFunction("tokenPrice")!.selector) {
          (lane === "raw" ? rawReads : amountReads).push(target);
          if (mode === "read" && target === pool) throw new Error("fixture oracle unavailable");
          return word(BigInt(fixture.calls.tokenPrice) * (at.number > start.number && target === pool ? 2n : 1n));
        }
        if (target === MULTICALL.toLowerCase()) return BALANCE.encodeFunctionResult("getEthBalance", [10n ** 24n]);
        if (target === token) return selector === TOKEN.getFunction("decimals")!.selector
          ? word(18n) : word(10n ** 30n);
        if ([oracle, otherOracle].includes(target)) return ORACLE.encodeFunctionResult("aggregator",
          [target === oracle && mode !== "aggregator" ? aggregator : otherAggregator]);
        if (target === factory) {
          for (const [name, value] of [["getFees", fixture.calls.getFees], ["getSystemCut", fixture.calls.getSystemCut],
            ["getFeesAddress", fixture.calls.getFeesAddress]] as const) {
            if (selector === FEES.getFunction(name)!.selector) return word(value);
          }
        }
        throw new Error(`unexpected fixture call ${target} ${selector}`);
      },
    },
  });
}
const family = catalog.forFamily(ELLA_ID);
const lifecycle = await executeAdapterFamilyLifecycleBatch({ family, source: start, generation: start.generation,
  runtime: runtime(start, "raw"), publisher: { publish() {} },
  matches: [pool, otherPool].map(target => ({ matchedPatternId: "ella-swapBase1",
    observation: { kind: "call" as const, source: start, target, data: POOL.encodeFunctionData("swapBase1") } })),
});
assert(lifecycle.publication, JSON.stringify(lifecycle.outcomes));
assert.equal(lifecycle.publication.instances.length, 2);
const ready = lifecycle.publication.instances;
const edges = buildFamilyRouteGraphView({ routes: ready.flatMap(instance => instance.routes.map((route, i) =>
  ({ family, descriptor: instance.descriptor, route, handle: instance.routeHandles[i] }))) }).edges;
const root = new StrictProductionRuntimeRoot({ catalog, readySource: start, readyGraph: edges,
  readyInstances: ready, readyFundingAssets: [] });
const graph = (at: CanonicalSource) => createVerifiedGraphView({ id: `ella-refresh-${at.number}`, edges,
  generation: at.generation, sourceBlock: at.number, sourceBlockHash: at.hash, completenessWatermark: at.number,
  familyIdForEdge: () => ELLA_ID,
  perSourceCoverage: [{ familyId: ELLA_ID, sourceId: "fixture", sourceFingerprint: "ella-refresh",
    completeThroughBlock: at.number, completeThroughHash: at.hash }],
});
function createCoordinator() {
const sessionRoot = new StrictProductionRuntimeRoot({ catalog, readySource: start, readyGraph: edges,
  readyInstances: ready, readyFundingAssets: [] });
return new StrictCurrentRuntimeCoordinator(request => sessionRoot.createSession({
  source: request.source, runtime: runtime(request.source, "raw"), fundingAssets: [],
  kind: request.requiredEdgeIds === undefined ? "pricing" : "exact", requiredEdgeIds: request.requiredEdgeIds,
  touchedPools: request.touchedPools, control: request.control,
}), () => {}, undefined, async (pricing, control, _backend, reuse) => {
  const target = reuse?.quoteGraph ?? pricing;
  const at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
  let exact: StrictProductionRuntimeSession | undefined;
  return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
    touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds, control, weth: ADDR.WETH,
    gasCostWei: null, enumerationSpreadBps: 50, concurrency: 2,
    prepareQuote: async requiredEdgeIds => { exact = await sessionRoot.createSession({ source: at,
      runtime: runtime(at, "exact"), fundingAssets: [], kind: "exact", requiredEdgeIds, control }); },
    quote: async request => {
      assert(exact);
      const quoted = await exact.issueExact({ ...request, executor, runtimeEvidence: [] });
      assert("amountIn" in quoted); return quoted;
    },
  });
});
}
const coordinator = createCoordinator();
await coordinator.prepareCoarsePricing({ graph: graph(start), deadlineAtMs: Date.now() + 10_000 });
const before = coordinator.latestPricingSnapshot()!;
assert.equal(before.effectiveMids!.rows.size, 4);
assert([...before.effectiveMids!.rows.values()].every(row => row.status === "quoted"));

// Resolved with the root's production dependency index below; pool itself has
// no transaction in this transition. The reader integration has separate tests.
const touched = new Set([aggregator, ...root.resolveBlockTouchedStateKeys({ kind: "call",
  target: aggregator, data: "0x12345678" }, next)]);
assert(touched.has(pool)); assert(!touched.has(otherPool));
rawReads.length = 0; amountReads.length = 0;
await coordinator.prepareCoarsePricing({ graph: graph(next), deadlineAtMs: Date.now() + 10_000,
  touchedPools: touched, canonicalActivity: { source: next, parentHash: start.hash, touchedStateKeys: touched, complete: true } });
const after = coordinator.latestPricingSnapshot()!;
assert.deepEqual(rawReads, [], "steady updates retain startup raw basis; current amounts use Exact");
assert.deepEqual(amountReads, [pool, pool]);
for (const [key, row] of before.effectiveMids!.rows) {
  const updated = after.effectiveMids!.rows.get(key)!;
  if (row.instanceKey === pool) {
    assert.equal(after.pricingProvenanceByEdgeKey!.get(key), "refreshed");
    assert.notEqual(updated.amountOut, row.amountOut);
    assert.deepEqual(updated.quotedAt, next);
  } else {
    assert.equal(after.pricingProvenanceByEdgeKey!.get(key), "carried");
    assert.equal(updated, row);
  }
}
for (const mode of ["read", "oracle", "aggregator"] as const) {
  // A full instance failure is disabled for this run. Use independent runs so
  // one failure cannot prevent the later binding-negative from being exercised.
  failureMode = undefined;
  const scenario = createCoordinator();
  await scenario.prepareCoarsePricing({ graph: graph(start), deadlineAtMs: Date.now() + 10_000 });
  const scenarioBefore = scenario.latestPricingSnapshot()!;
  for (const [number, dirty, fail] of [[901, true, true], [902, false, true], [903, true, false]] as const) {
    failureMode = fail ? mode : undefined;
    const at = source(number), changed = dirty ? new Set([pool]) : new Set<string>();
    await scenario.prepareCoarsePricing({ graph: graph(at), deadlineAtMs: Date.now() + 10_000,
      touchedPools: changed, canonicalActivity: { source: at, parentHash: source(number - 1).hash,
        touchedStateKeys: changed, complete: true } });
    const current = scenario.latestPricingSnapshot()!;
    const rows = [...current.effectiveMids!.rows.values()];
    assert.equal(rows.length, 4, "failed rows remain auditable rather than disappearing");
    assert(rows.filter(row => row.instanceKey === pool).every(row => row.status !== "quoted"),
      `${mode}: failed or disabled instance must not publish stale quotes, even when the binding later recovers`);
    for (const [key, row] of scenarioBefore.effectiveMids!.rows) if (row.instanceKey === pool) {
      assert.equal(current.mids.get(key), scenarioBefore.mids.get(key), "raw startup basis is retained, not republished as a current quote");
      assert.equal(current.effectiveMids!.rows.get(key)!.effectiveMid, null);
      assert(!effectiveEnumerationMids(current).has(key), "the real enumeration view must exclude the failed price");
      assert(!current.coverage.resolvedEdgeKeys.includes(key));
      assert.notEqual(current.coverageByEdgeKey!.get(key)!.status, "resolved");
    }
    assert.equal(rows.filter(row => row.instanceKey === otherPool && row.status === "quoted").length, 2,
      "unrelated pool remains usable");
  }
}
console.log("Ella oracle-only effective refresh, startup raw carry and independent failed/binding-change run-disable controls: PASS");

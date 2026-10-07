import assert from "node:assert/strict";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { executeAdapterFamilyLifecycleBatch, recheckFamilyInstanceMemoBinding } from "../../../adapter-family-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { isPricedFamily } from "../../../family-capability-catalog.js";
import { FAMILY } from "../manifest.js";
import { MODULE } from "../codec.js";
import { actor, components, controller, module, runtime, set, source, state } from "./fixture.js";

// Production lifecycle/coordinator/amount reference/session/Graph with synthetic
// transport transitions. Not chain acceptance and not a full rebuild CAS test.
const s = state(), start = source(), family = catalog.forFamily(FAMILY);
assert(isPricedFamily(family));
const candidate = { candidateKind: "set-redemption", set, module };
const admit = async (at = start) => {
  const life = await executeAdapterFamilyLifecycleBatch({ family, source: at, generation: at.generation, runtime: runtime(s, at), publisher: { publish() {} },
    matches: [{ matchedPatternId: "set-redeem-call", observation: { kind: "call", source: at, target: module, data: MODULE.encodeFunctionData("redeem", [set, 100n, actor]) } }] });
  assert(life.publication, JSON.stringify(life.outcomes)); assert.equal(life.publication.instances.length, 1); return life.publication.instances;
};
function makeRoot(ready: Awaited<ReturnType<typeof admit>>, at = start) {
  const edges = buildFamilyRouteGraphView({ routes: ready.flatMap(i => i.routes.map((r, n) => ({ family, descriptor: i.descriptor, route: r, handle: i.routeHandles[n] }))) }).edges;
  assert.equal(edges.length, 4);
  return { edges, root: new StrictProductionRuntimeRoot({ catalog, readySource: at, readyGraph: edges, readyInstances: ready, readyFundingAssets: [] }) };
}
const ready = await admit(), { edges, root } = makeRoot(ready);
const graph = (at: ReturnType<typeof source>) => createVerifiedGraphView({ id: `set-refresh-${at.number}`, edges,
  generation: at.generation, sourceBlock: at.number, sourceBlockHash: at.hash, completenessWatermark: at.number,
  familyIdForEdge: () => FAMILY, perSourceCoverage: [{ familyId: FAMILY, sourceId: "synthetic-test", sourceFingerprint: "set-refresh",
    completeThroughBlock: at.number, completeThroughHash: at.hash }] });
const rawReads: string[] = [], exactReads: string[] = [];
const coordinator = new StrictCurrentRuntimeCoordinator(i => root.createSession({ source: i.source, runtime: runtime(s, i.source, rawReads),
  fundingAssets: [], kind: i.purpose === "exact-execution" ? "exact" : "pricing", requiredEdgeIds: i.requiredEdgeIds,
  touchedPools: i.touchedPools, control: i.control }), () => {}, undefined,
  async (pricing, control, _backend, reuse) => {
    const target = reuse?.quoteGraph ?? pricing, at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous, touchedStateKeys: reuse?.touchedStateKeys, control,
      // Synthetic input anchor: this single-Family graph only redeems Set.
      // It has no WETH-to-Set acquisition edge. This tests refresh semantics,
      // not natural production WETH valuation or historical chain prices.
      weth: set, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 2,
      prepareQuote: async requiredEdgeIds => { exact = await root.createSession({ source: at, runtime: runtime(s, at, exactReads), fundingAssets: [], kind: "exact", requiredEdgeIds, control }); },
      quote: async request => { assert(exact); const q = await exact.issueExact({ ...request, executor: actor, runtimeEvidence: [] }); assert("amountIn" in q); return q; } });
  });
let previous = source(99);
async function step(n: number, target?: string) {
  const at = source(n), touched = new Set(target ? root.resolveBlockTouchedStateKeys({ kind: "call", target, data: "0x12345678" }, at) : []);
  await coordinator.prepareCoarsePricing({ graph: graph(at), deadlineAtMs: Date.now() + 10000, touchedPools: n === start.number ? undefined : touched,
    ...(n === start.number ? {} : { canonicalActivity: { source: at, parentHash: previous.hash, touchedStateKeys: touched, complete: true } }) });
  previous = at; const p = coordinator.latestPricingSnapshot(); assert(p); return p;
}
const first = await step(100); assert.equal(first.mids.size, 4); assert.equal(first.effectiveMids!.rows.size, 4);
assert([...first.effectiveMids!.rows.values()].every(r => r.status === "quoted"));
rawReads.length = 0; exactReads.length = 0;
const quiet = await step(101, actor); assert.equal(rawReads.length, 0); assert.equal(exactReads.length, 0);
assert([...quiet.effectiveMids!.rows.values()].every(r => r.quotedAt?.number === 100));
s.units[1] *= 2n;
const units = await step(102, set); assert.equal(units.mids.size, 4); assert([...units.effectiveMids!.rows.values()].every(r => r.quotedAt?.number === 102));
s.multiplier /= 2n; const multiplier = await step(103, set); assert.equal(multiplier.mids.size, 4);
assert.notDeepEqual([...units.effectiveMids!.rows.values()].map(r => r.amountOut), [...multiplier.effectiveMids!.rows.values()].map(r => r.amountOut));
s.supply = 1n; const lowSupply = await step(104, set); assert([...lowSupply.effectiveMids!.rows.values()].every(r => r.status !== "quoted"));
s.supply = state().supply; await step(105, set);
const unavailable = (p: Awaited<ReturnType<typeof step>>) => assert([...p.effectiveMids!.rows.values()].every(r => r.status !== "quoted"), "no executable amount quote may survive");
s.balances[0] = 0n; const collateral = await step(106, components[0]); unavailable(collateral);
s.balances[0] = state().balances[0]; await step(107, components[0]);
let cursor = 108;
for (const [key, value, target] of [["enabled", false, controller], ["locked", true, set], ["external", true, set], ["failure", true, set]] as const) {
  const n = cursor; cursor += 3;
  (s as any)[key] = value; unavailable(await step(n, target));
  unavailable(await step(n + 1));
  (s as any)[key] = key === "enabled"; const recovered = await step(n + 2, target);
  assert([...recovered.effectiveMids!.rows.values()].every(r => r.status === "quoted"), "same binding can recover after an eligible touched state");
}
const oldBinding = ready[0].staticBindingFingerprint, newComponent = "0x1000000000000000000000000000000000000077";
s.components[3] = newComponent;
unavailable(await step(120, set)); unavailable(await step(121));
const at = source(122), rechecked = await recheckFamilyInstanceMemoBinding({ family, candidate, source: at, generation: at.generation, runtime: runtime(s, at) });
assert(rechecked); assert.notEqual(rechecked.fingerprint, oldBinding, "normal new-cutoff identity recheck invalidates the old static binding");
const replacement = await admit(at), next = makeRoot(replacement, at);
assert.notEqual(replacement[0].staticBindingFingerprint, oldBinding);
assert.deepEqual(root.resolveBlockTouchedStateKeys({ kind: "call", target: newComponent, data: "0x12345678" }, at), []);
assert(next.root.resolveBlockTouchedStateKeys({ kind: "call", target: newComponent, data: "0x12345678" }, at).includes(replacement[0].instanceKey));
assert(!next.root.resolveBlockTouchedStateKeys({ kind: "call", target: components[3], data: "0x12345678" }, at).includes(replacement[0].instanceKey));
const constructionReads: string[] = [];
const exact = await next.root.createSession({ source: at, runtime: runtime(s, at, constructionReads), kind: "exact", fundingAssets: [] });
const edge = next.edges.find(e => e.tokenOut.toLowerCase() === newComponent)!;
const beforeConstruction = constructionReads.length;
const runtimeLeg = exact.buildRuntimeAmountLeg({ edge, executor: actor, runtimeEvidence: [] });
assert(runtimeLeg && runtimeLeg.program.startsWith("0x01"));
assert.equal(constructionReads.length, beforeConstruction, "runtime construction adds no provider reads");
const q = await exact.issueExact({ edge, amountIn: 1000000n, executor: actor, runtimeEvidence: [] }); assert("amountIn" in q);
const built = exact.buildExecution({ edge, exact: q, minAmountOut: q.amountOut, executor: actor });
assert.equal(built.status, "resolved");
console.log("Set production lifecycle/raw/effective/touched/quiet failure/next-cutoff recheck/new root/quoted fragment contracts: PASS (synthetic; no chain or full rebuild CAS claim)");

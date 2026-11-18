import assert from "node:assert/strict";
import test from "node:test";
import { buildEffectiveMids, effectiveAmountReferences, effectiveEnumerationMids, effectiveRowExecutionVerified,
  exportEffectiveMidReplayState, exportEffectiveMidReplayDelta, restoreEffectiveMidReplayState,
  type EffectiveMidSnapshot, type EffectivePricingInput } from "../blockscan-effective-mid.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { createBlockScanStartupExecutionPreflight } from "../blockscan-startup-execution-preflight.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import type { StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import type { StartupNodeInvocation, StartupNodeSimulation } from "../blockscan-startup-node-simulation.js";

const source = { number: 100, hash: `0x${"a".repeat(64)}`, generation: 1 };
const edge: TokenEdge = { tokenIn: ADDR.WETH.toLowerCase(), tokenOut: "asset", adapterId: "fixture", target: "pool",
  instanceKey: "pool", executionVariantKey: "variant", canonicalEdgeId: "edge" as TokenEdge["canonicalEdgeId"],
  slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
  executionVerification: "startup-simulation" };
const pricing: EffectivePricingInput = { sourceBlock: source.number, sourceBlockHash: source.hash,
  generation: source.generation, graph: { edges: [edge] }, mids: new Map(), coverage: { resolvedEdgeKeys: ["edge"] },
  pricingStateKeyByEdgeKey: new Map([["edge", "pool"]]) };

for (const pricingMethod of ["exact", "startup-simulation"] as const)
  test(`required execution cannot be supplied by ${pricingMethod} without a bound simulation receipt`, async () => {
    const effective = await buildEffectiveMids({ pricing, weth: ADDR.WETH, fixedWethInput: 100n,
      maxInputPathHops: 4, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1,
      quote: async request => ({ source, amountIn: request.amountIn, amountOut: 200n, amountSpent: 99n, pricingMethod }) });
    assert.equal(effective.rows.get("edge")!.status, "quote-failed");
    assert.equal(effective.rows.get("edge")!.amountOut, null);
  });

const second: TokenEdge = { ...edge, tokenIn: "asset", tokenOut: "asset-two", target: "pool-two", instanceKey: "pool-two",
  executionVariantKey: "variant-two", canonicalEdgeId: "second" as TokenEdge["canonicalEdgeId"] };
const edges = [edge, second];
const at = (n: number) => ({ number: n, hash: `0x${n.toString(16).padStart(64, "0")}`, generation: n - 99 });
const prices = (selected: readonly TokenEdge[], source = at(100)): EffectivePricingInput => ({
  ...pricing, sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
  graph: { edges: selected }, pricingStateKeyByEdgeKey: new Map(selected.map(e => [String(e.canonicalEdgeId), e.instanceKey!])),
});

// The real preflight and price producer, with a deterministic receipt transport.
// This checks authority/orchestration, not EVM execution or live profitability.
function harness(selected: readonly TokenEdge[] = edges) {
  let calls = 0, script = "b";
  const simulateStandalone = Object.assign(async (input: StartupNodeInvocation) => {
    calls++;
    let amount = input.amount;
    const receipts = [{ hop: -1, amountIn: amount, amountSpent: amount, amountOut: amount }];
    for (const [hop] of input.legs.entries()) {
      receipts.push({ hop, amountIn: amount, amountSpent: amount - 1n, amountOut: amount * 2n });
      amount *= 2n;
    }
    return { kind: "success" as const, receipts, returnData: "0x", gasUsed: 1n,
      targetBlock: input.source.number + 1, scriptHash: `0x${script.repeat(64)}`,
      inputFundingMode: "native-prefix" as const, simulationMs: 1, nodeQueueMs: 0 };
  }, { stats: () => ({ requests: calls, retries: 0, simulations: calls, headers: 1, maxCuIn1000Ms: 1 }) }) as StartupNodeSimulation;
  const preflight = createBlockScanStartupExecutionPreflight({ executor: `0x${"1".repeat(40)}`,
    transactionOrigin: `0x${"2".repeat(40)}`, simRejects: new BlockScanSimRejectCache(), concurrency: 1, simulateStandalone });
  const prepareQuote = async () => {}, sessionFor = () => ({ buildRuntimeAmountLeg: () => ({ program: "0x00" }) }) as unknown as StrictProductionRuntimeSession;
  return { preflight, calls: () => calls, prepareQuote, sessionFor,
    changeScript: () => { script = "c"; preflight.reset(); },
    build: (source = at(100), previous?: EffectiveMidSnapshot, touchedStateKeys: ReadonlySet<string> | null = new Set<string>()) => buildEffectiveMids({
      pricing: prices(selected, source), weth: ADDR.WETH, fixedWethInput: 100n, maxInputPathHops: 4,
      gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1, previous,
      ...(previous && touchedStateKeys !== null ? { touchedStateKeys } : {}), prepareQuote,
      quote: async request => {
        const result = await preflight.quoteEffective({ ...request, control: {}, edges: selected, prepareQuote, sessionFor });
        assert(result); return result;
      },
    }),
  };
}

test("one funded quote exposes source/path-bound proof and its screening reuses the same execution", async () => {
  const h = harness(), snapshot = await h.build();
  assert.equal(h.calls(), 2);
  for (const e of edges) {
    const row = snapshot.rows.get(String(e.canonicalEdgeId))!;
    assert.equal(row.status, "quoted");
    assert(effectiveRowExecutionVerified(snapshot, row, e));
    assert.equal(row.executionVerification!.targetBlock, 101);
    assert.equal(row.executionVerification!.kind, "startup-simulation");
  }
  await h.preflight.run({ effective: snapshot, edges, control: {}, prepareQuote: h.prepareQuote, sessionFor: h.sessionFor });
  assert.equal(h.calls(), 2, "screening must reuse both issued price receipts");
  assert.equal(effectiveEnumerationMids({ ...prices(edges), effectiveMids: snapshot }).size, 2);
});

test("complete untouched activity carries original SIM observations without claiming a new simulation", async () => {
  const h = harness(), first = await h.build(), same = await h.build(at(100), first);
  assert.equal(h.calls(), 2);
  assert.strictEqual(same.rows.get("edge"), first.rows.get("edge"));
  const next = await h.build(at(101), same);
  assert.equal(h.calls(), 2, "canonical untouched carry performs zero new simulations");
  assert.strictEqual(next.rows.get("edge"), first.rows.get("edge"));
  assert.equal(next.rows.get("edge")!.quotedAt!.number, 100, "original SIM provenance is not rewritten");
  for (const e of edges) assert(effectiveRowExecutionVerified(next, next.rows.get(String(e.canonicalEdgeId))!, e));
  assert.equal(effectiveEnumerationMids({ ...prices(edges, at(101)), effectiveMids: { ...first, source: at(101) } }).size, 0,
    "moving a historical table to the new envelope cannot refresh its receipts");
});

for (const changed of ["target", "prefix", "continuity"] as const)
  test(`marked samples reexecute when ${changed} invalidates their existing carry authority`, async () => {
    const h = harness(), first = await h.build();
    const next = await h.build(at(101), first, changed === "continuity" ? null : new Set([changed === "target" ? "pool-two" : "pool"]));
    assert.equal(h.calls(), changed === "target" ? 3 : 4);
    assert.equal(next.rows.get("second")!.quotedAt!.number, 101);
    assert(effectiveRowExecutionVerified(next, next.rows.get("second")!, second));
  });

test("legacy method-only rows cannot restore, enumerate, carry, or seed a newly required execution edge", async () => {
  const oldEdges = edges.map(({ executionVerification: _old, ...plain }) => plain);
  const old = await buildEffectiveMids({ pricing: prices(oldEdges), weth: ADDR.WETH, fixedWethInput: 100n,
    maxInputPathHops: 4, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1,
    quote: async request => ({ source: request.source, amountIn: request.amountIn, amountOut: request.amountIn * 2n,
      pricingMethod: "startup-simulation" }) });
  assert.equal(old.rows.get("second")!.status, "quoted");
  assert.equal(effectiveEnumerationMids({ ...prices(edges), effectiveMids: old }).size, 0);
  const serialized = structuredClone({ snapshot: old, lineage: exportEffectiveMidReplayState(old) });
  assert.throws(() => restoreEffectiveMidReplayState(serialized.snapshot, serialized.lineage, edges, ADDR.WETH), /execution verification/);
  let attempts = 0;
  const rejected = await buildEffectiveMids({ pricing: prices(edges), weth: ADDR.WETH, fixedWethInput: 100n,
    maxInputPathHops: 4, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1,
    previous: old, touchedStateKeys: new Set(), quote: async () => { attempts++; throw new Error("execution unavailable"); } });
  assert.equal(attempts, 1);
  assert.equal(rejected.rows.get("edge")!.status, "quote-failed");
  assert.equal(rejected.rows.get("second")!.status, "missing-valuation");
  assert.deepEqual([...effectiveAmountReferences(rejected)!.keys()], [ADDR.WETH.toLowerCase()]);
});

test("an unmarked carried target cannot retain a stale marked input path", async () => {
  const { executionVerification: _unused, ...plainSecond } = second;
  const h = harness([edge, plainSecond]), first = await h.build(), next = await h.build(at(101), first, new Set(["pool"]));
  assert.equal(h.calls(), 4, "both the required prefix and its dependent target refresh together");
  assert.equal(next.rows.get("second")!.quotedAt!.number, 101);
});

test("carried marked replay requires its actual publication source anchor and original receipt", async () => {
  const h = harness(), first = await h.build(), carried = await h.build(at(101), first);
  const saved = { snapshot: carried, lineage: exportEffectiveMidReplayState(carried) };
  const valid = structuredClone(saved);
  restoreEffectiveMidReplayState(valid.snapshot, valid.lineage, edges, ADDR.WETH);
  assert(effectiveRowExecutionVerified(valid.snapshot, valid.snapshot.rows.get("second")!, second));
  assert.equal(valid.snapshot.rows.get("second")!.quotedAt!.number, 100);
  const wrong = structuredClone(saved);
  assert.throws(() => restoreEffectiveMidReplayState({ ...wrong.snapshot, source: at(102) }, wrong.lineage, edges, ADDR.WETH), /source anchor/);
  const missing = structuredClone(saved);
  assert.throws(() => restoreEffectiveMidReplayState(missing.snapshot, { ...missing.lineage, source: undefined }, edges, ADDR.WETH), /execution verification/);
});

for (const mutation of ["replace", "number", "hash", "generation"] as const)
  test(`restored private carry authority cannot follow an in-place source ${mutation} mutation`, async () => {
    const h = harness(), first = await h.build(), carried = await h.build(at(101), first);
    const saved = structuredClone({ snapshot: carried, lineage: exportEffectiveMidReplayState(carried) });
    restoreEffectiveMidReplayState(saved.snapshot, saved.lineage, edges, ADDR.WETH);
    assert(effectiveRowExecutionVerified(saved.snapshot, saved.snapshot.rows.get("second")!, second));
    const mutable = saved.snapshot as any;
    if (mutation === "replace") mutable.source = at(102);
    if (mutation === "number") mutable.source.number = 102;
    if (mutation === "hash") mutable.source.hash = `0x${"f".repeat(64)}`;
    if (mutation === "generation") mutable.source.generation = 3;
    assert.equal(effectiveRowExecutionVerified(saved.snapshot, saved.snapshot.rows.get("second")!, second), false);
    assert.equal(effectiveEnumerationMids({ ...prices(edges, saved.snapshot.source), effectiveMids: saved.snapshot }).size, 0);
    const reexported = structuredClone({ snapshot: saved.snapshot, lineage: exportEffectiveMidReplayState(saved.snapshot) });
    assert.deepEqual(reexported.lineage.source, at(101), "export retains its private authorization anchor");
    assert.throws(() => restoreEffectiveMidReplayState(reexported.snapshot, reexported.lineage, edges, ADDR.WETH), /source anchor/);
  });

test("same-source equal-amount receipt changes are retained in native continuation token deltas", async () => {
  const h = harness(), first = await h.build();
  h.changeScript();
  const next = await h.build(at(100), first, new Set(edges.map(e => e.instanceKey!)));
  assert.equal(next.rows.get("edge")!.amountOut, first.rows.get("edge")!.amountOut);
  assert.notEqual(next.rows.get("edge")!.executionVerification!.receiptHash,
    first.rows.get("edge")!.executionVerification!.receiptHash);
  const delta = exportEffectiveMidReplayDelta(next, first);
  assert(delta.tokenUpdates.some(([token]) => token === "asset"), "equal prices cannot drop changed execution bindings");
  const replay = structuredClone({ snapshot: next, lineage: exportEffectiveMidReplayState(next) });
  restoreEffectiveMidReplayState(replay.snapshot, replay.lineage, edges, ADDR.WETH);
  assert(effectiveRowExecutionVerified(replay.snapshot, replay.snapshot.rows.get("second")!, second));
});

for (const fault of ["missing", "source", "script", "receipt", "amount", "path"] as const)
  test(`restored simulation evidence rejects changed ${fault} while a complete bound replay survives`, async () => {
    const h = harness(), snapshot = await h.build();
    const valid = structuredClone({ snapshot, lineage: exportEffectiveMidReplayState(snapshot) });
    restoreEffectiveMidReplayState(valid.snapshot, valid.lineage, edges, ADDR.WETH);
    assert.equal(effectiveEnumerationMids({ ...prices(edges), effectiveMids: valid.snapshot }).size, 2);
    const bad = structuredClone({ snapshot, lineage: exportEffectiveMidReplayState(snapshot) });
    const row = bad.snapshot.rows.get("edge")! as any;
    if (fault === "missing") delete row.executionVerification;
    if (fault === "source") row.quotedAt = at(99);
    if (fault === "script") row.executionVerification.scriptHash = `0x${"c".repeat(64)}`;
    if (fault === "receipt") row.executionVerification.receiptHash = `0x${"c".repeat(64)}`;
    if (fault === "amount") row.amountSpent--;
    if (fault === "path") {
      const reference = bad.lineage.references.find(value => value.path.length > 0)!;
      (reference.path[0] as any).amountSpent--;
    }
    assert.throws(() => restoreEffectiveMidReplayState(bad.snapshot, bad.lineage, edges, ADDR.WETH), /execution verification/);
  });

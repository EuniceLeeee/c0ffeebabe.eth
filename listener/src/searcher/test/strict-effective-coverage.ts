import assert from "node:assert/strict";
import { test } from "node:test";
import { StrictCurrentRuntimeCoordinator } from "../strict-current-runtime-coordinator.js";
import { strictReadyGraphContractFingerprint, type StrictReadyPricingIndex,
  type StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { EffectiveMidSnapshot, EffectiveMidRow } from "../blockscan-effective-mid.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { blockScanEdgeKey, createVerifiedGraphView, exactSetHash,
  type VerifiedGraphView } from "../venues/blockscan-state-capability.js";

// Isolate the production preparation boundary; no new exported testing API and
// no network/session issuance. Real sessions/publication are tested separately.
function fixture() {
  const source = { number: 100, hash: `0x${"1".repeat(64)}`, generation: 1 };
  const edges: TokenEdge[] = Array.from({ length: 8 }, (_, i) => ({
    instanceKey: `instance-${i}`, executionVariantKey: "forward", adapterId: "univ3-swap",
    slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
    target: `0x${"3".repeat(40)}`, tokenIn: `0x${"1".repeat(40)}`, tokenOut: `0x${"2".repeat(40)}`,
  }));
  const graph = createVerifiedGraphView({ id: "coverage-fixture", sourceBlock: source.number,
    sourceBlockHash: source.hash, generation: source.generation, completenessWatermark: source.number,
    familyIdForEdge: () => "fixture", perSourceCoverage: [], edges });
  const keys = graph.edges.map(blockScanEdgeKey).sort();
  const byId = new Map(graph.edges.map(e => [blockScanEdgeKey(e), e]));
  const owners = new Map(keys.map(k => [k, "fixture"])), stateKeys = new Map(keys.map(k => [k, k]));
  const index = { expectedEdgeKeys: [...keys], expectedEdgeKeyHash: exactSetHash(keys),
    readyGraphContractFingerprint: strictReadyGraphContractFingerprint(graph.edges),
    familyIdByEdgeKey: owners, stateKeyByEdgeKey: stateKeys, perBlockRefreshStateKeys: [] } as unknown as StrictReadyPricingIndex;
  const rows = new Map(keys.map(key => [key, { edgeId: key, instanceKey: byId.get(key)!.instanceKey!,
    tokenIn: byId.get(key)!.tokenIn, tokenOut: byId.get(key)!.tokenOut,
    status: "quoted", amountIn: 1n, amountOut: 2n, effectiveMid: 2, quotedAt: { ...source },
  } as EffectiveMidRow]));
  const effective = { source: { ...source }, complete: true, rows } as unknown as EffectiveMidSnapshot;
  const raw = { graph, sourceBlock: 99, sourceBlockHash: `0x${"0".repeat(64)}`, generation: 0,
    mids: new Map(), coverage: {}, pricingFamilyIdByEdgeKey: owners,
    pricingStateKeyByEdgeKey: stateKeys } as unknown as BlockScanStateSnapshot;
  const coordinator = new StrictCurrentRuntimeCoordinator(async () => { throw new Error("unexpected session"); },
    () => {}, undefined, async () => effective);
  const session = { source, pricingIndex: () => index } as unknown as StrictProductionRuntimeSession;
  const internal = coordinator as unknown as { preparePricing(
    session: Promise<StrictProductionRuntimeSession>, graph: VerifiedGraphView, previous: BlockScanStateSnapshot | null,
    raw: BlockScanStateSnapshot, epoch: number, control: { signal?: AbortSignal; deadlineAtMs: number },
  ): Promise<{ built: { snapshot: BlockScanStateSnapshot } }> };
  let currentGraph = graph;
  const run = async (previous: BlockScanStateSnapshot | null = null, signal?: AbortSignal) =>
    (await internal.preparePricing(Promise.resolve(session), currentGraph, previous, raw, 0,
      { deadlineAtMs: Date.now() + 60_000, signal })).built.snapshot;
  return { source, edges, graph, keys, index, owners, stateKeys, rows, effective, raw, session, coordinator, run,
    setGraph: (value: VerifiedGraphView) => { currentGraph = value; } };
}

function assertHashes(snapshot: BlockScanStateSnapshot) {
  const c = snapshot.coverage;
  for (const kind of ["expected", "resolved", "unavailable", "unresolved", "refreshed", "carried"] as const) {
    assert.equal(c[`${kind}EdgeKeyHash`], exactSetHash(c[`${kind}EdgeKeys`]!));
    assert(Object.isFrozen(c[`${kind}EdgeKeys`]));
  }
}

test("identical sets reuse immutable arrays/hashes without reusing source-bound snapshots", async () => {
  const f = fixture(), first = await f.run(), second = await f.run(first);
  assertHashes(first); assertHashes(second);
  assert.notStrictEqual(first, second);
  for (const kind of ["expected", "resolved", "unavailable", "unresolved", "refreshed", "carried"] as const)
    assert.strictEqual(first.coverage[`${kind}EdgeKeys`], second.coverage[`${kind}EdgeKeys`]);
  const records = [...second.coverageByEdgeKey.values()];
  assert(records.every(r => r === records[0] && Object.isFrozen(r)), "share immutable status, not mutable decisions");
  assert.throws(() => { (first.coverage.resolvedEdgeKeys as string[]).push("forged"); });
  assert.throws(() => { Object.assign(records[0]!, { status: "unresolved" }); });
});

test("same-sized set changes, removals, failure reasons and carry provenance remain current", async () => {
  const f = fixture();
  let previous = await f.run();
  const statuses: EffectiveMidRow["status"][] = ["quoted", "quote-failed", "unsupported", "no-output",
    "disabled-for-run", "cancelled", "missing-valuation"];
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < f.keys.length; i++) {
      const key = f.keys[i]!, row = f.rows.get(key)!;
      Object.assign(row, { status: statuses[(i + round) % statuses.length],
        quotedAt: { ...f.source, generation: i % 2 ? 0 : 1 } });
    }
    const missing = f.keys.at(-1)!, saved = f.rows.get(missing)!;
    f.rows.delete(missing);
    const current = await f.run(previous); assertHashes(current);
    const expected = { resolved: [] as string[], unavailable: [] as string[], unresolved: [] as string[],
      carried: [] as string[], refreshed: [] as string[] };
    for (const key of f.keys) {
      const row = f.rows.get(key), coverage = current.coverageByEdgeKey.get(key)!;
      if (row?.status === "quoted") {
        expected.resolved.push(key);
        expected[row.quotedAt!.generation === 1 ? "refreshed" : "carried"].push(key);
        assert.deepEqual(coverage, { status: "resolved" });
      } else {
        const unavailable = row && ["no-output", "unsupported", "disabled-for-run"].includes(row.status);
        expected[unavailable ? "unavailable" : "unresolved"].push(key);
        assert.deepEqual(coverage, { status: unavailable ? "rejected" : "unresolved",
          reason: `effective-${row?.status ?? "missing-row"}` });
      }
    }
    for (const kind of Object.keys(expected) as (keyof typeof expected)[])
      assert.deepEqual(current.coverage[`${kind}EdgeKeys`], expected[kind]);
    assertHashes(previous); // future runs cannot mutate older publications
    f.rows.set(missing, saved); previous = current;
  }
});

test("warm coverage cache cannot bypass row, index, graph, source or retirement checks", async () => {
  const f = fixture(), first = await f.run();
  const row = f.rows.get(f.keys[0]!)!;
  for (const [field, value] of [["amountIn", 0n], ["amountOut", 0n], ["effectiveMid", NaN],
    ["instanceKey", "changed"], ["tokenIn", `0x${"9".repeat(40)}`], ["edgeId", "changed"]] as const) {
    const before = { ...row }; Object.assign(row, { [field]: value });
    await assert.rejects(f.run(first), /invalid effective pricing row|differs from ready Graph/);
    Object.assign(row, before);
  }
  f.rows.set("unknown", row);
  await assert.rejects(f.run(first), /differs from ready Graph/); f.rows.delete("unknown");
  for (const map of [f.owners, f.stateKeys]) {
    const key = f.keys[0]!, value = map.get(key)!; map.delete(key);
    await assert.rejects(f.run(first), /index omits/); map.set(key, value);
  }
  const expected = f.index.expectedEdgeKeys as string[], original = expected[0]!;
  expected[0] = expected[1]!;
  await assert.rejects(f.run(first), /differs from ready Graph/); expected[0] = original;
  const hash = f.index.expectedEdgeKeyHash;
  Object.assign(f.index, { expectedEdgeKeyHash: "forged" });
  await assert.rejects(f.run(first), /differs from ready Graph/); Object.assign(f.index, { expectedEdgeKeyHash: hash });
  const fingerprint = f.index.readyGraphContractFingerprint;
  Object.assign(f.index, { readyGraphContractFingerprint: "forged" });
  await assert.rejects(f.run(first), /differs from ready Graph/);
  Object.assign(f.index, { readyGraphContractFingerprint: fingerprint });
  f.setGraph({ ...f.graph, scannerEdgeKeyHash: "forged" });
  await assert.rejects(f.run(first), /differs from ready Graph/);
  f.setGraph({ ...f.graph, edges: f.graph.edges.map((edge, i) => i ? edge : { ...edge, target: `0x${"9".repeat(40)}` }) });
  await assert.rejects(f.run(first), /differs from ready Graph/); f.setGraph(f.graph);
  for (const [field, value] of [["number", 101], ["generation", 2], ["hash", `0x${"2".repeat(64)}`]] as const) {
    Object.assign(f.effective.source, { [field]: value });
    await assert.rejects(f.run(first), /mismatched source/); Object.assign(f.effective.source, f.source);
  }
  Object.assign(f.effective, { complete: false });
  await assert.rejects(f.run(first), /incomplete/); Object.assign(f.effective, { complete: true });
  const abort = new AbortController(); abort.abort(new Error("fixture-cancelled"));
  await assert.rejects(f.run(first, abort.signal), /fixture-cancelled|aborted/);
  assertHashes(await f.run(first));
  await f.coordinator.resetDynamicStateForReplay();
  await assert.rejects(f.run(first), /retired/);
});

test("a valid replacement topology rebuilds cached membership at the current source", async () => {
  const f = fixture(), first = await f.run();
  const edges = f.edges.map(edge => ({ ...edge, target: `0x${"9".repeat(40)}` }));
  Object.assign(f.source, { number: 101, generation: 2, hash: `0x${"2".repeat(64)}` });
  Object.assign(f.effective.source, f.source);
  const graph = createVerifiedGraphView({ id: "replacement", sourceBlock: f.source.number,
    sourceBlockHash: f.source.hash, generation: f.source.generation, completenessWatermark: f.source.number,
    familyIdForEdge: () => "replacement-family", perSourceCoverage: [], edges });
  f.setGraph(graph); f.rows.clear(); f.owners.clear(); f.stateKeys.clear();
  for (const edge of graph.edges) {
    const key = blockScanEdgeKey(edge);
    f.owners.set(key, "replacement-family"); f.stateKeys.set(key, key);
    f.rows.set(key, { edgeId: key, instanceKey: edge.instanceKey!, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut,
      status: "quoted", amountIn: 1n, amountOut: 3n, effectiveMid: 3, quotedAt: { ...f.source } });
  }
  const keys = [...f.rows.keys()].sort();
  Object.assign(f.index, { expectedEdgeKeys: keys, expectedEdgeKeyHash: exactSetHash(keys),
    readyGraphContractFingerprint: strictReadyGraphContractFingerprint(graph.edges) });
  const next = await f.run(first); assertHashes(next); assertHashes(first);
  assert.equal(next.sourceBlock, 101); assert.equal(first.sourceBlock, 100);
  assert.deepEqual(next.coverage.resolvedEdgeKeys, keys);
  assert.deepEqual(next.resolvedFamilyIds, ["replacement-family"]);
  assert.notDeepEqual(next.coverage.expectedEdgeKeys, first.coverage.expectedEdgeKeys);
});

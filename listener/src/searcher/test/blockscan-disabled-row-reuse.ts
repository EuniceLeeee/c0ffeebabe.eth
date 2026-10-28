import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildEffectiveMids, effectiveNativeChangesSince, effectiveEnumerationMids,
  effectiveRowAmountReference, withEffectiveRowColumns, type EffectiveMidProgress } from "../blockscan-effective-mid.js";
import { organizeEffectivePricing, effectiveEthPricing, ethViewStatistics,
  buildBlockScanEthView, type EffectiveEthColumns } from "../blockscan-eth-view.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "../venues/route-instance-identity.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { TokenEdge } from "../planner/token-graph.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const weth = ADDR.WETH.toLowerCase();
const edges = Object.freeze([[weth, address(1)], [address(1), weth], [weth, address(2)], [address(2), weth]]
  .map(([tokenIn, tokenOut], n) => {
    const edge = { tokenIn: tokenIn!, tokenOut: tokenOut!, adapterId: `disabled-test-${n}`, target: address(100 + n),
      instanceKey: `instance-${n}`, executionVariantKey: `variant-${n}`, slotKind: "swap" as const,
      ...deriveEdgeTaxonomy("swap") };
    return Object.freeze({ ...edge, canonicalEdgeId: blockScanEdgeKey(edge) });
  }));
const key = blockScanEdgeKey(edges[0]!);
function pricing(n: number, graphEdges: readonly TokenEdge[] = edges) {
  return { sourceBlock: n, sourceBlockHash: `0x${n.toString(16).padStart(64, "0")}`, generation: n,
    graph: { edges: graphEdges }, mids: new Map(), coverage: { resolvedEdgeKeys: graphEdges.map(blockScanEdgeKey) },
    pricingStateKeyByEdgeKey: new Map(graphEdges.map(e => [blockScanEdgeKey(e), edgeInstanceKey(e)])) };
}
const common = { weth, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 2 };
const quoteAt = (input: ReturnType<typeof pricing>) => async ({ amountIn }: { amountIn: bigint }) => ({
  source: { number: input.sourceBlock, hash: input.sourceBlockHash, generation: input.generation }, amountIn, amountOut: amountIn * 2n });
async function disabled(n: number) {
  const input = pricing(n);
  return organizeEffectivePricing({ ...input, effectiveMids: await buildEffectiveMids({ ...common, pricing: input,
    disabledEdgeIds: new Set([key]), quote: quoteAt(input) }) }, 7, false);
}

test("unchanged disabled row is not a native edit, even when touched; it remains unpriced and excluded", async () => {
  const previous = await disabled(7100), old = structuredClone(previous.effectiveMids);
  const input = pricing(7101), progress: EffectiveMidProgress[] = [];
  let calls = 0;
  const raw = await buildEffectiveMids({ ...common, pricing: input, previous: previous.effectiveMids,
    disabledEdgeIds: new Set([key]), touchedStateKeys: new Set([edgeInstanceKey(edges[0]!)]),
    onProgress: p => progress.push(p), quote: async () => { calls++; throw new Error("no quote expected"); } });
  assert.equal(raw.rows.get(key), previous.effectiveMids.rows.get(key));
  assert.equal(effectiveRowAmountReference(raw.rows.get(key)!), undefined);
  const delta = effectiveNativeChangesSince({ ...input, effectiveMids: raw }, previous.effectiveMids)!;
  assert(delta); assert(!delta.updates.some(([id]) => id === key));
  const current = organizeEffectivePricing({ ...input, effectiveMids: raw }, 7, false);
  const result = effectiveEthPricing(current, 7, false), stats = ethViewStatistics(result.view, 0).incremental!;
  assert.equal(stats.nativeDelta, true); assert.equal(stats.projectionRowsVisited, 0);
  assert.equal(stats.derivedRowsVisited, 0); assert.equal(calls, 0);
  assert(!result.mids.has(key)); assert(!result.view.quotes.some(q => q.id === key));
  assert.equal(progress.at(-1)!.reusedDirections, edges.length - 1, "unchanged telemetry: disabled rows are not quote carries");
  assert.deepEqual(result.view, buildBlockScanEthView(edges, effectiveEnumerationMids(current), 7, false));
  assert.deepEqual(previous.effectiveMids, old);
});

test("new exclusion clears a priced row; removing exclusion with a state update can quote again", async () => {
  const firstInput = pricing(7200), first = organizeEffectivePricing({ ...firstInput,
    effectiveMids: await buildEffectiveMids({ ...common, pricing: firstInput, quote: quoteAt(firstInput) }) }, 7, false);
  const nextInput = pricing(7201);
  const next = await buildEffectiveMids({ ...common, pricing: nextInput, previous: first.effectiveMids,
    disabledEdgeIds: new Set([key]), touchedStateKeys: new Set(), quote: quoteAt(nextInput) });
  const row = next.rows.get(key)!;
  assert.equal(row.status, "disabled-for-run"); assert.equal(row.amountIn, null); assert.equal(row.amountOut, null);
  assert.equal(row.eth, undefined); assert.equal(row.enumeration, undefined); assert.equal(row.quotedAt, undefined);
  assert.notEqual(row, first.effectiveMids.rows.get(key));
  const resumedInput = pricing(7202);
  const resumed = await buildEffectiveMids({ ...common, pricing: resumedInput, previous: next,
    disabledEdgeIds: new Set(), touchedStateKeys: new Set([edgeInstanceKey(edges[0]!)]), quote: quoteAt(resumedInput) });
  assert.equal(resumed.rows.get(key)!.status, "quoted");
  assert.equal(resumed.rows.get(key)!.quotedAt!.number, 7202);
});

test("changed identity, foreign/reorg sources and stale derived data cannot reuse a disabled row", async () => {
  const previous = await disabled(7300), oldRow = previous.effectiveMids.rows.get(key)!;
  const changedEdges = Object.freeze(edges.map((e, i) => i === 0 ? Object.freeze({ ...e, instanceKey: "new-instance" }) : e));
  const changed = pricing(7301, changedEdges);
  const identity = await buildEffectiveMids({ ...common, pricing: changed, previous: previous.effectiveMids,
    disabledEdgeIds: new Set([key]), touchedStateKeys: new Set(), quote: quoteAt(changed) });
  assert.notEqual(identity.rows.get(key), oldRow);
  assert.equal(identity.rows.get(key)!.instanceKey, edgeInstanceKey(changedEdges[0]!));
  for (const prior of [previous.effectiveMids, { ...previous.effectiveMids }]) {
    const reorg = { ...pricing(7300), generation: 7302, sourceBlockHash: `0x${"f".repeat(64)}` };
    const result = await buildEffectiveMids({ ...common, pricing: reorg, previous: prior,
      disabledEdgeIds: new Set([key]), touchedStateKeys: new Set(), quote: quoteAt(reorg) });
    assert.notEqual(result.rows.get(key), oldRow);
  }
  const forward = pricing(7302);
  const foreign = await buildEffectiveMids({ ...common, pricing: forward,
    previous: { ...previous.effectiveMids }, disabledEdgeIds: new Set([key]),
    touchedStateKeys: new Set(), quote: quoteAt(forward) });
  assert.notEqual(foreign.rows.get(key), oldRow, "a forward source cannot lend producer identity to a copied snapshot");
  const decorated = withEffectiveRowColumns(previous.effectiveMids,
    new Map([[key, {} as EffectiveEthColumns]]));
  const cleanInput = pricing(7303);
  const clean = await buildEffectiveMids({ ...common, pricing: cleanInput, previous: decorated,
    disabledEdgeIds: new Set([key]), touchedStateKeys: new Set(), quote: quoteAt(cleanInput) });
  assert.notEqual(clean.rows.get(key), decorated.rows.get(key)); assert.equal(clean.rows.get(key)!.eth, undefined);
  const abort = new AbortController(); abort.abort();
  const stopped = await buildEffectiveMids({ ...common, control: { signal: abort.signal }, pricing: pricing(7304),
    previous: previous.effectiveMids, disabledEdgeIds: new Set([key]), touchedStateKeys: new Set(),
    quote: async () => { throw new Error("aborted"); } });
  assert.equal(stopped.complete, false);
});

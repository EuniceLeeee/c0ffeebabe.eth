import assert from "node:assert/strict";
import test from "node:test";
import { buildEffectiveMids, type EffectivePricingInput } from "../blockscan-effective-mid.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";

const source = { number: 42, hash: "0x" + "ab".repeat(32), generation: 7 };
const edge: TokenEdge = { tokenIn: "weth", tokenOut: "usdc", adapterId: "test-swap",
  target: "pool", instanceKey: "pool", executionVariantKey: "pool",
  canonicalEdgeId: "pool" as TokenEdge["canonicalEdgeId"], slotKind: "swap", edgeKind: "swap",
  leavesStandingPosition: false };
const key = blockScanEdgeKey(edge);
const pricing: EffectivePricingInput = {
  sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
  graph: { edges: [edge] }, pricingStateKeyByEdgeKey: new Map([[key, "pool"]]),
  coverage: { resolvedEdgeKeys: [key] },
  mids: new Map<string, RouteVenueMid>([[key, { edges: [edge], kind: "external-swap",
    pool: "pool", mid: 7, feeBps: 0, depthProxy: 1 }]]),
};
type Input = Parameters<typeof buildEffectiveMids>[0];
function build(extra: Partial<Input> = {}) {
  return buildEffectiveMids({ pricing, weth: "weth", gasCostWei: null, enumerationSpreadBps: 200,
    control: {}, concurrency: 2,
    quote: async ({ amountIn }) => ({ source, amountIn, amountOut: amountIn * 7n }), ...extra });
}
function semantic(snapshot: Awaited<ReturnType<typeof build>>) {
  const { wallMs: _wall, rows, ...rest } = snapshot;
  return { ...rest, rows: [...rows] };
}
async function diagnostic<T>(enabled: boolean, run: () => Promise<T>, throws = false) {
  const old = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS, log = console.log;
  const lines: string[] = [];
  if (enabled) process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = "1";
  else delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
  console.log = (...args: unknown[]) => { if (throws) throw new Error("logging unavailable"); lines.push(args.join(" ")); };
  try { return { value: await run(), lines }; }
  finally { console.log = log; if (old === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = old; }
}

test("effective phase diagnostics preserve semantic result and bounded accounting", async () => {
  const baseline = await diagnostic(false, () => build());
  const observed = await diagnostic(true, () => build({ onProgress: () => {} }));
  assert.deepEqual(semantic(observed.value), semantic(baseline.value));
  assert.equal(baseline.lines.length, 0);
  assert.equal(observed.lines.length, 1);
  assert(observed.lines[0]!.startsWith("[searcher/effective-phase-timing] "));
  const row = JSON.parse(observed.lines[0]!.slice(observed.lines[0]!.indexOf("{")));
  assert.equal(row.sourceBlock, source.number); assert.equal(row.sourceBlockHash, source.hash);
  assert.equal(row.status, "completed"); assert(row.waves.length <= 5);
  const fixed = [row.setupMs, row.progressCallbackMs, row.assemblyMs, row.unattributedMs];
  const parts = row.waves.flatMap((wave: Record<string, number>) =>
    [wave.planningMs, wave.sessionPrepareMs, wave.quoteWorkMs, wave.propagationMs]);
  for (const value of [...fixed, ...parts, row.wallMs]) assert(Number.isFinite(value) && value >= 0);
  assert(Math.abs([...fixed, ...parts].reduce((a: number, b: number) => a + b, 0) - row.wallMs) < 0.01);
});

test("logging failure cannot alter quotes or publication result", async () => {
  const baseline = await diagnostic(false, () => build());
  const observed = await diagnostic(true, () => build({ onProgress: () => { throw Error("progress"); } }), true);
  assert.deepEqual(semantic(observed.value), semantic(baseline.value));
});

test("cancelled build preserves cancellation result with one bounded interrupted record", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  const baseline = await diagnostic(false, () => build({ control: { signal: controller.signal } }));
  const observed = await diagnostic(true, () => build({ control: { signal: controller.signal } }));
  assert.deepEqual(semantic(observed.value), semantic(baseline.value));
  assert.equal(observed.lines.length, 1);
  assert.equal(JSON.parse(observed.lines[0]!.slice(observed.lines[0]!.indexOf("{"))).status, "interrupted");
});

test("session preparation exception retains the exact error", async () => {
  const failure = new Error("prepare failure");
  for (const enabled of [false, true]) {
    await assert.rejects(diagnostic(enabled, () => build({ prepareQuote: async () => { throw failure; } })), error => error === failure);
  }
});

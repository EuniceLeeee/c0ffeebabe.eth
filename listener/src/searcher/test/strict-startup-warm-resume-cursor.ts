import assert from "node:assert/strict";
import { ethers } from "ethers";
import { runUniv2Lifecycle, UNIV2_FIXTURE_FACTORY, UNIV2_FIXTURE_POOL,
  UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1 } from "../architecture-migration-fixture-replay.js";
import { readyReceiptContext } from "./ready-receipt-fixture.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { StrictCurrentRuntimeCoordinator, type PrepareStrictRuntimeInput } from
  "../strict-current-runtime-coordinator.js";
import type { EffectiveMidSnapshot } from "../blockscan-effective-mid.js";
import { createVerifiedGraphView, type VerifiedGraphView } from "../venues/blockscan-state-capability.js";
import { UNIV2_PAIR_INTERFACE } from "../venues/swaps/univ2-family/codec.js";

// Pure local production-coordinator/Family fixture, not historical or live evidence.
const initial = Object.freeze({ number: 25_800_000, hash: `0x${"61".repeat(32)}`, generation: 1 });
const balance = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
const publication = await runUniv2Lifecycle(initial, {
  pool: UNIV2_FIXTURE_POOL, factory: UNIV2_FIXTURE_FACTORY,
  token0: UNIV2_FIXTURE_TOKEN0, token1: UNIV2_FIXTURE_TOKEN1,
  reserves: { reserve0: 1_000_000_000n, reserve1: 2_000_000_000n, blockTimestampLast: 1 },
});
const ready = readyReceiptContext(publication, initial);
function graph(generation: number, change: "none" | "number" | "hash" | "order" = "none"): VerifiedGraphView {
  const number = initial.number + (change === "number" ? 1 : 0);
  const hash = change === "hash" ? `0x${"62".repeat(32)}` : initial.hash;
  return createVerifiedGraphView({ id: "startup-private-cursor-fixture", generation,
    sourceBlock: number, sourceBlockHash: hash, completenessWatermark: number,
    perSourceCoverage: [{ familyId: publication.familyId, sourceId: "local-fixture",
      sourceFingerprint: "local-fixture-v1", completeThroughBlock: number, completeThroughHash: hash }],
    familyIdForEdge: () => publication.familyId,
    edges: change === "order" ? [...ready.graph].reverse() : ready.graph });
}
function fixture(options: { failFirstRaw?: boolean } = {}) {
  let mode: "partial" | "complete" | "wrong-source" | "abort" = "partial";
  let beforeEffective: (() => Promise<void>) | undefined;
  let publications = 0;
  const publicationKinds: string[] = [];
  const observed: (EffectiveMidSnapshot | undefined)[] = [];
  const returned: EffectiveMidSnapshot[] = [];
  const sessions: { purpose: string; refreshed: number; selected: number }[] = [];
  const rawCoverage: { unresolved: number; resolved: number }[] = [];
  let controller = new AbortController();
  const coordinator = new StrictCurrentRuntimeCoordinator(async request => {
    const runtime = createStrictCentralAdapterRuntime({ provider: {
      call: async call => {
        if (call.data.slice(0, 10).toLowerCase() ===
            UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector.toLowerCase()) {
          if (options.failFirstRaw && request.source.generation === 1) {
            throw new Error("fixture transient raw transport failure");
          }
          return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [1_000_000_000n, 2_000_000_000n, 1]);
        }
        return balance.encodeFunctionResult("balanceOf", [10n ** 24n]);
      },
      getCode: async () => "0x01", getStorage: async () => `0x${"00".repeat(32)}`,
    }, executor: `0x${"64".repeat(20)}`, transactionOrigin: `0x${"65".repeat(20)}`,
    generationFence: { assertCurrent: (generation, source) => {
      assert.equal(generation, request.source.generation);
      assert.deepEqual(source, request.source);
    } } });
    const session = await ready.root.createSession({ source: request.source, runtime, fundingAssets: [],
      kind: request.purpose === "exact-execution" ? "exact" : "pricing",
      touchedPools: request.touchedPools,
      requiredEdgeIds: request.requiredEdgeIds, control: request.control });
    sessions.push({ purpose: request.purpose,
      refreshed: session.creationTiming.refreshedInstanceCount,
      selected: session.creationTiming.selectedInstanceCount });
    return session;
  }, () => {}, publication => { publications++; publicationKinds.push(publication.kind); }, async (pricing, _control, _backend, reuse) => {
    observed.push(reuse?.previous);
    rawCoverage.push({ unresolved: pricing.coverage.unresolvedEdgeKeys.length,
      resolved: pricing.coverage.resolvedEdgeKeys.length });
    await beforeEffective?.();
    const result: EffectiveMidSnapshot = Object.freeze({ source: {
      number: pricing.sourceBlock, hash: mode === "wrong-source" ? `0x${"63".repeat(32)}` : pricing.sourceBlockHash,
      generation: pricing.generation }, rows: new Map(), reference: "default",
      referenceWethInput: 2_000_000_000_000_000n, complete: mode === "complete", wallMs: 0 });
    returned.push(result);
    if (mode === "abort") controller.abort(new Error("fixture non-deadline cancellation"));
    return result;
  });
  const input = (view: VerifiedGraphView, extra: Partial<PrepareStrictRuntimeInput> = {}): PrepareStrictRuntimeInput => ({
    graph: view, fundingTokens: [], deadlineAtMs: Date.now() + 10_000,
    signal: controller.signal, validateBeforePublish: async () => {}, ...extra,
  });
  return { coordinator, observed, returned, sessions, rawCoverage, publicationKinds, input, publications: () => publications,
    mode: (next: typeof mode) => { mode = next; }, gate: (next?: typeof beforeEffective) => { beforeEffective = next; },
    renewSignal: () => { controller = new AbortController(); } };
}
const partialError = /effective pricing incomplete or mismatched source/;
const retiredError = /startup warm data cursor retired or mismatched/;
let passed = 0;
async function scenario(name: string, run: () => Promise<void>) {
  await run(); passed++; console.log(`strict startup private cursor: PASS ${name}`);
}

await scenario("explicit retry carries only original partial object; successful publication retires cursor", async () => {
  const f = fixture(), first = graph(1), cursor = f.coordinator.startStartupWarmResume(first);
  await assert.rejects(f.coordinator.prepare(f.input(first, { startupWarmResume: cursor })), partialError);
  assert.equal(f.coordinator.latestPricingSnapshot(), null); assert.equal(f.publications(), 0);
  f.mode("complete"); await f.coordinator.prepare(f.input(graph(2), { startupWarmResume: cursor }));
  assert.deepEqual(f.sessions.filter(s => s.purpose === "source-n-runtime").map(s => s.refreshed),
    [1, 0], "same-pin resolved raw must avoid re-reading the Ready instance");
  assert.equal(f.observed[1], f.returned[0]); assert.equal(f.publications(), 1);
  assert.deepEqual(f.publicationKinds, ["baseline"], "private raw draft must not turn first publication into a delta");
  await assert.rejects(f.coordinator.prepare(f.input(graph(3), { startupWarmResume: cursor })), retiredError);
});

await scenario("transient raw unresolved directions refresh their whole Ready state on retry", async () => {
  const f = fixture({ failFirstRaw: true }), first = graph(1);
  const cursor = f.coordinator.startStartupWarmResume(first);
  await assert.rejects(f.coordinator.prepare(f.input(first, { startupWarmResume: cursor })), partialError);
  assert.equal(f.publications(), 0);
  assert.ok(f.rawCoverage[0]!.unresolved > 0);
  f.mode("complete");
  const result = await f.coordinator.prepare(f.input(graph(2), { startupWarmResume: cursor }));
  assert.deepEqual(f.sessions.filter(s => s.purpose === "source-n-runtime").map(s => s.refreshed), [1, 1]);
  assert.equal(f.rawCoverage[1]!.unresolved, 0);
  assert.equal(result.snapshot.pricing.rawMidSource?.generation, 2);
  assert.equal(f.publications(), 1);
});

for (const change of ["number", "hash", "order"] as const) await scenario(`reject changed ${change}`, async () => {
  const f = fixture(), first = graph(1), cursor = f.coordinator.startStartupWarmResume(first);
  await assert.rejects(f.coordinator.prepare(f.input(first, { startupWarmResume: cursor })), partialError);
  const changed = graph(2, change);
  if (change === "order") assert.notEqual(changed.orderedEdgeHash, first.orderedEdgeHash);
  await assert.rejects(f.coordinator.prepare(f.input(changed, { startupWarmResume: cursor })), retiredError);
  assert.equal(f.observed.length, 1); assert.equal(f.publications(), 0);
});

for (const retire of ["close", "reset", "newer-prepare", "same-generation", "missing-canonical-check"] as const)
await scenario(`reject ${retire}`, async () => {
  const f = fixture(), first = graph(1), cursor = f.coordinator.startStartupWarmResume(first);
  await assert.rejects(f.coordinator.prepare(f.input(first, { startupWarmResume: cursor })), partialError);
  if (retire === "close") cursor.close();
  if (retire === "reset") await f.coordinator.resetDynamicStateForReplay();
  if (retire === "newer-prepare") {
    await assert.rejects(f.coordinator.prepare(f.input(graph(2))), partialError);
    assert.equal(f.observed[1], undefined, "ordinary prepare cannot see private draft");
  }
  await assert.rejects(f.coordinator.prepare(f.input(graph(retire === "same-generation" ? 1 : 3), {
    startupWarmResume: cursor,
    ...(retire === "missing-canonical-check" ? { validateBeforePublish: undefined } : {}),
  })), retiredError);
  assert.equal(f.publications(), 0);
});

await scenario("concurrent newer preparation prevents late partial from reseeding old cursor", async () => {
  const f = fixture(), first = graph(1), cursor = f.coordinator.startStartupWarmResume(first);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let once = true;
  f.gate(async () => { if (once) { once = false; entered(); await held; } });
  const pending = f.coordinator.prepare(f.input(first, { startupWarmResume: cursor }));
  const rejection = assert.rejects(pending, /pricing publication retired during prepare/);
  await started;
  await assert.rejects(f.coordinator.prepare(f.input(graph(2))), partialError);
  release(); await rejection;
  await assert.rejects(f.coordinator.prepare(f.input(graph(3), { startupWarmResume: cursor })), retiredError);
  assert.equal(f.publications(), 0);
});

for (const failure of ["wrong-source", "abort"] as const) await scenario(`do not retain ${failure} draft`, async () => {
  const f = fixture(), first = graph(1), cursor = f.coordinator.startStartupWarmResume(first);
  f.mode(failure);
  await assert.rejects(f.coordinator.prepare(f.input(first, { startupWarmResume: cursor })));
  f.renewSignal(); f.mode("complete");
  await f.coordinator.prepare(f.input(graph(2), { startupWarmResume: cursor }));
  assert.equal(f.observed[1], undefined); assert.equal(f.publications(), 1);
});

await scenario("complete pricing followed by execution failure does not become retry draft", async () => {
  const f = fixture(), first = graph(1), cursor = f.coordinator.startStartupWarmResume(first);
  f.mode("complete");
  await assert.rejects(f.coordinator.prepare(f.input(first, { startupWarmResume: cursor,
    prepareExecution: async () => { throw new Error("fixture execution preparation failed"); },
  })), /fixture execution preparation failed/);
  assert.equal(f.coordinator.latestPricingSnapshot(), null); assert.equal(f.publications(), 0);
  await f.coordinator.prepare(f.input(graph(2), { startupWarmResume: cursor }));
  assert.equal(f.observed[1], undefined); assert.equal(f.publications(), 1);
});

for (const sameGeneration of [false, true]) await scenario(`raw-only progress before effective result: same generation=${sameGeneration}`, async () => {
  const f = fixture(), first = graph(1), cursor = f.coordinator.startStartupWarmResume(first);
  f.gate(async () => { throw new Error("strict current runtime deadline expired"); });
  await assert.rejects(f.coordinator.prepare(f.input(first, { startupWarmResume: cursor })), /deadline expired/);
  assert.equal(f.returned.length, 0);
  assert.equal(f.publications(), 0);
  f.gate(); f.mode("complete");
  if (sameGeneration) {
    await assert.rejects(f.coordinator.prepare(f.input(graph(1), { startupWarmResume: cursor })), retiredError);
    assert.equal(f.sessions.length, 1, "raw-only cursor also fences generation before new session work");
  } else {
    await f.coordinator.prepare(f.input(graph(2), { startupWarmResume: cursor }));
    assert.deepEqual(f.sessions.map(s => s.refreshed), [1, 0]);
    assert.equal(f.observed[1], undefined, "no fabricated effective partial object");
    assert.deepEqual(f.publicationKinds, ["baseline"]);
  }
});

console.log(`strict startup private cursor: ${passed} scenarios passed`);

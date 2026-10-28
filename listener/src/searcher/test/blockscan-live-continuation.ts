import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { LivePricingContinuationStore, liveContinuationEnabled, validateLiveContinuationAnchors, liveContinuationIdentity,
  liveContinuationFiles, compatibleLiveContinuationIdentity } from "../blockscan-live-continuation.js";
import { BlockScanAmountReference } from "../blockscan-amount-reference.js";
import { buildEffectiveMids, effectiveRowAmountReference, exportEffectiveMidReplayState,
  restoreEffectiveMidReplayState } from "../blockscan-effective-mid.js";
import { createBlockScanStartupExecutionPreflight } from "../blockscan-startup-execution-preflight.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type { TokenEdge } from "../planner/token-graph.js";

const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const source = (n: number) => ({ number: n, hash: hash(n), generation: n });
const token = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const edge = (id: string, tokenIn: string, tokenOut: string) => ({
  canonicalEdgeId: id, instanceKey: id, adapterId: "fixture", target: token(30),
  tokenIn, tokenOut, slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
}) as TokenEdge;
const edges = [edge("a", ADDR.WETH, token(1)), edge("b", token(1), token(2)),
  edge("c", ADDR.WETH, token(3))];
const prices = (n: number) => ({ sourceBlock: n, sourceBlockHash: hash(n), generation: n,
  graph: { edges }, mids: new Map(), coverage: { resolvedEdgeKeys: ["a", "b", "c"] },
  pricingStateKeyByEdgeKey: new Map(edges.map(e => [e.canonicalEdgeId!, e.instanceKey!])) });
const build = (n: number, extra: Partial<Parameters<typeof buildEffectiveMids>[0]> = {}) =>
  buildEffectiveMids({ pricing: prices(n), weth: ADDR.WETH, fixedWethInput: 100n,
    gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 2,
    quote: async ({ amountIn }) => ({ source: source(n), amountIn, amountOut: amountIn * 2n }), ...extra });

test("private atomic checkpoint roundtrip, corruption and incompatible versions fail closed", async () => {
  assert.equal(liveContinuationEnabled(), false);
  assert.equal(liveContinuationEnabled("1"), true);
  assert.throws(() => liveContinuationEnabled("yes"));
  const dir = await mkdtemp(join(tmpdir(), "live-continuation-"));
  try {
    const store = new LivePricingContinuationStore(dir, "a".repeat(64));
    assert.equal(await store.read(), null);
    const effective = await build(10);
    const data: any = { version: 1, identity: store.identity,
      pricing: { version: 1, pricing: { ...prices(10), effectiveMids: effective },
        raw: prices(10), disabledInstances: [], lineage: exportEffectiveMidReplayState(effective) },
      startup: { version: 1, rows: [] }, simRejects: { version: 1, routes: [], pools: [] },
      amounts: { version: 1, headers: [], samples: [] } };
    await store.write(data);
    const restored = (await store.read())!;
    const snapshot = restored.pricing.pricing.effectiveMids!;
    restoreEffectiveMidReplayState(snapshot, restored.pricing.lineage, edges, ADDR.WETH);
    assert.equal(effectiveRowAmountReference(snapshot.rows.get("b")!)?.amountIn, 200n);
    let calls = 0;
    const next = await build(11, { previous: snapshot, touchedStateKeys: new Set(["c"]),
      quote: async ({ amountIn }) => { calls++; return { source: source(11), amountIn, amountOut: amountIn * 3n }; } });
    assert.equal(calls, 1, "restored clean rows do not warm again");
    assert.equal(next.rows.get("c")?.amountOut, 300n);
    await assert.rejects(new LivePricingContinuationStore(dir, "b".repeat(64)).read(), /incompatible/);
    await writeFile(join(dir, "checkpoint-interrupted.tmp"), "partial");
    assert(await store.read(), "incomplete side file cannot replace the last committed source");
    const archived = await store.beginFreshRound();
    assert(archived && (await readFile(archived)).length > 65, "old round retained recoverably");
    assert.equal(await store.read(), null, "a failed fresh startup cannot silently restore the old round");
    await store.write(data);
    const bytes = await readFile(join(dir, "current.bin")); bytes[70] ^= 1;
    await writeFile(join(dir, "current.bin"), bytes);
    await assert.rejects(store.read(), /checksum/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("startup results defer during catch-up, reuse clean paths, and recheck changed prefixes after restart", async () => {
  let calls = 0;
  const observations: any[] = [];
  const make = () => createBlockScanStartupExecutionPreflight({ executor: token(90), transactionOrigin: token(91),
    simRejects: new BlockScanSimRejectCache(), concurrency: 2,
    onObservation: value => observations.push(value),
    simulateStandalone: Object.assign(async (input: any) => {
      calls++;
      let amount = input.amount;
      const receipts = [{ hop: -1, amountIn: amount, amountOut: amount }];
      for (let hop = 0; hop < input.legs.length; hop++) {
        receipts.push({ hop, amountIn: amount, amountOut: amount * 2n }); amount *= 2n;
      }
      return { kind: "success" as const, returnData: "0x", gasUsed: 1n, targetBlock: input.source.number + 1,
        scriptHash: hash(1), inputFundingMode: "native-prefix" as const, receipts, simulationMs: 1, nodeQueueMs: 0 };
    }, { stats: () => ({ requests: calls, retries: 0, simulations: calls, headers: 0, maxCuIn1000Ms: 0 }) }),
  });
  const run = (flight: ReturnType<typeof make>, effective: Awaited<ReturnType<typeof build>>) => flight.run({
    effective, edges, control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 10_000 },
    prepareQuote: async () => {}, sessionFor: () => ({ buildRuntimeAmountLeg: () => ({ program: "0x0100" }) }) as any,
  });
  const first = make(), before = await build(10);
  await run(first, before); assert.equal(calls, 3);
  const resumed = make(); resumed.restoreContinuation(first.exportContinuation()); resumed.defer(true);
  const after = await build(11, { previous: before, touchedStateKeys: new Set(["a"]) });
  await run(resumed, after); assert.equal(calls, 3, "no startup simulation while catching up");
  resumed.defer(false); await run(resumed, after);
  assert.equal(calls, 5, "only touched a and its dependent b recheck; c reuses");
  assert.equal(observations.filter(o => o.reused).length, 1);
  assert.equal(observations.find(o => o.reused).sourceBlock, 10, "old evidence is not relabelled current");
  await run(resumed, after); assert.equal(calls, 5, "normal live startup-once behavior retained");
});

test("continuation retains disabled rows; an explicit new round builds fresh prices", async () => {
  const old = await build(10, { disabledEdgeIds: new Set(["c"]) });
  assert.equal(old.rows.get("c")?.status, "disabled-for-run");
  const resumed = await build(11, { previous: old, touchedStateKeys: new Set(), disabledEdgeIds: new Set(["c"]) });
  assert.equal(resumed.rows.get("c")?.status, "disabled-for-run");
  const fresh = await build(11);
  assert.equal(fresh.rows.get("c")?.status, "quoted");
});

test("live anchor wiring restores amounts before observing headers and rejects a reorg", async () => {
  const header = (n: number) => ({ ...source(n), parentHash: hash(n - 1),
    baseFeePerGas: 1n, gasUsed: 1n, gasLimit: 30_000_000n });
  const old = new BlockScanAmountReference(); old.observeHeader(header(10));
  const data: any = { amounts: old.exportHistoricalBaseline(),
    pricing: { pricing: prices(10), raw: prices(9) } };
  const resumed = new BlockScanAmountReference();
  await validateLiveContinuationAnchors(data, resumed, async n => {
    // Same side effect as main's frozenProducerTopology.observeHeader.
    resumed.observeHeader(header(n)); return header(n);
  });
  assert.equal(resumed.exportHistoricalBaseline().headers.length, 2);
  await assert.rejects(validateLiveContinuationAnchors(data, new BlockScanAmountReference(),
    async () => ({ hash: hash(99) })), /anchor reorged/);
});

test("compiler and execution boundary changes invalidate continuation identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuation-identity-"));
  try {
    await cp(new URL("../../", import.meta.url), root, { recursive: true });
    const context = { chainId: "1", topology: "fixture" };
    let previous = liveContinuationIdentity(context, root);
    for (const file of ["compiler.ts", "encoder.ts", "searcher/execution-asset-boundary.ts", "searcher/exact-prefix-plan.ts", "searcher/main.ts"]) {
      await writeFile(join(root, file), (await readFile(join(root, file), "utf8")) + "\n// changed fixture\n");
      const current = liveContinuationIdentity(context, root);
      assert.notEqual(current, previous, file); previous = current;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit continuation restores the existing route/pool filter; a new round stays empty", () => {
  const prior = new BlockScanSimRejectCache();
  const reverted: any = { success: false, failure: { kind: "revert", code: "TRANSACTION_REVERTED" } };
  prior.record("route-1", reverted, { amount: 1n, p: 1n });
  prior.recordPool(edges[0]!, reverted, { amount: 1n, p: 1n });
  const resumed = new BlockScanSimRejectCache();
  resumed.restoreContinuation(prior.exportContinuation(), edges);
  assert(resumed.has("route-1")); assert(resumed.hasPool(edges[0]!)); assert(!resumed.hasPool(edges[1]!));
  const fresh = new BlockScanSimRejectCache();
  assert(!fresh.has("route-1")); assert(!fresh.hasPool(edges[0]!));
  assert.throws(() => fresh.restoreContinuation(prior.exportContinuation(), edges.slice(1)), /differs from Ready/);
});

test("reviewed migration binds both complete file inventories, exact changes and review evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuation-migration-"));
  try {
    const producer = join(directory, "producer"), consumer = join(directory, "consumer");
    await cp(new URL("../../", import.meta.url), producer, { recursive: true });
    await cp(producer, consumer, { recursive: true });
    const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    const context = { chainId: "1", topology: "fixture" };
    const change = async (name: string) => writeFile(join(consumer, name),
      (await readFile(join(consumer, name), "utf8")) + "\n// migration fixture\n");
    await change("searcher/blockscan-live-continuation.ts");
    await writeFile(join(directory, "review.txt"), "fixture review evidence");
    const before = liveContinuationFiles(producer);
    const manifest = join(directory, "compatibility.json");
    const proof = () => {
      const after = liveContinuationFiles(consumer), prior = new Map(before);
      return { schema: "reviewed-live-continuation-v1", producerSourceRoot: producer,
        producerFilesSha256: sha(JSON.stringify(before)), consumerFilesSha256: sha(JSON.stringify(after)),
        changes: after.filter(([file, digest]) => prior.get(file) !== digest)
          .map(([file, afterSha256]) => ({ file, beforeSha256: prior.get(file) ?? null, afterSha256 })),
        review: { verdict: "compatible", evidencePath: "review.txt", evidenceSha256: sha("fixture review evidence") } };
    };
    await writeFile(manifest, JSON.stringify(proof()));
    assert.equal(compatibleLiveContinuationIdentity(context, manifest, consumer), liveContinuationIdentity(context, producer));
    const thresholdContext = { ...context, fixedWethInput: "100", spreadBps: 10 };
    const thresholdReview = JSON.stringify({ producerSpreadBps: 0, consumerSpreadBps: 10, fixedWethInput: "100" });
    await writeFile(join(directory, "review.txt"), thresholdReview);
    await writeFile(manifest, JSON.stringify({ ...proof(), producerSpreadBps: 0,
      review: { ...proof().review, evidenceSha256: sha(thresholdReview) } }));
    assert.equal(compatibleLiveContinuationIdentity(thresholdContext, manifest, consumer),
      liveContinuationIdentity({ ...thresholdContext, spreadBps: 0 }, producer));
    for (const fixedWethInput of [null, undefined, "0", "101"]) {
      assert.throws(() => compatibleLiveContinuationIdentity({ ...thresholdContext, fixedWethInput }, manifest, consumer), /threshold change/);
    }
    assert.throws(() => compatibleLiveContinuationIdentity({ ...thresholdContext, spreadBps: 11 }, manifest, consumer), /threshold change/);
    await writeFile(join(directory, "review.txt"), "fixture review evidence");
    await writeFile(manifest, JSON.stringify(proof()));
    await writeFile(join(directory, "review.txt"), "tampered");
    assert.throws(() => compatibleLiveContinuationIdentity(context, manifest, consumer), /evidence changed/);
    await writeFile(join(directory, "review.txt"), "fixture review evidence");
    await change("searcher/blockscan-live-continuation.ts");
    assert.throws(() => compatibleLiveContinuationIdentity(context, manifest, consumer), /code changed/);
    await change("compiler.ts");
    await writeFile(manifest, JSON.stringify(proof()));
    assert.throws(() => compatibleLiveContinuationIdentity(context, manifest, consumer), /execution semantics/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an old observe-only target revert cannot filter a currently unpriced direction", async () => {
  const rejects = new BlockScanSimRejectCache();
  let simulations = 0;
  const flight = createBlockScanStartupExecutionPreflight({ executor: token(90), transactionOrigin: token(91),
    simRejects: rejects, concurrency: 2, filterTargetReverts: true,
    simulateStandalone: Object.assign(async () => { simulations++; throw Error("must not simulate unpriced rows"); },
      { stats: () => ({ requests: simulations, retries: 0, simulations, headers: 0, maxCuIn1000Ms: 0 }) }) });
  flight.restoreContinuation({ version: 1, rows: [["a", { key: hash(1), observation: {
    edgeId: "a", instanceKey: "a", status: "revert", failureStage: "target", targetAttempted: true,
    failedEdgeId: "a", failedHop: 0, prefixEdges: [], expectedAmountIn: "100", gasUsed: "1",
    revertDataHash: hash(2), sourceBlock: 10, sourceBlockHash: hash(10),
  } }]] });
  const effective = await build(11, { quote: async () => { throw Error("quote failed"); } });
  const changed = await flight.run({ effective, edges, control: {}, prepareQuote: async () => {},
    sessionFor: () => { throw Error("must not prepare unpriced rows"); } });
  assert.equal(changed, false); assert.equal(simulations, 0); assert.equal(rejects.hasPool(edges[0]!), false);
  assert.equal(flight.exportContinuation().rows.length, 1, "old observation remains evidence, not a new rejection");
});

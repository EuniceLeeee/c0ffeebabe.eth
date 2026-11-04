import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { beginPricingPhaseDiagnostics, type PricingPhaseHost } from "../state-latency-diagnostics.js";
import { StrictCurrentRuntimeCoordinator } from "../strict-current-runtime-coordinator.js";
import { strictReadyGraphContractFingerprint, StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { blockScanEdgeKey, exactSetHash, createVerifiedGraphView, type CanonicalEdgeId } from "../venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "../venues/route-instance-identity.js";
import { effectiveMidRowCarried, buildEffectiveMids } from "../blockscan-effective-mid.js";
import { scannerConsumesEdge } from "../blockscan-pricing-delta.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { runUniv2Lifecycle, UNIV2_FIXTURE_FACTORY, UNIV2_FIXTURE_POOL,
  UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1 } from "../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../venues/swaps/univ2-family/codec.js";

const phases = ["index-validation/preparation", "row-classification", "coverage-key-hashes", "snapshot-publication"];
const source = { sourceBlock: 26_339_573, sourceBlockHash: "0x" + "ab".repeat(32), generation: 17 };
function fixture() {
  let mono = 100;
  const thread = { user: 1_000, system: 2_000 }, cpu = { user: 10_000, system: 20_000 };
  const summaries: { channel: string; value: any }[] = [];
  const calls = { now: 0, origin: 0, uptime: 0, thread: 0, cpu: 0, emit: 0 };
  const host: PricingPhaseHost = {
    now: () => { calls.now++; return mono; },
    timeOrigin: () => { calls.origin++; return 1_000_000; },
    uptime: () => { calls.uptime++; return 9 + mono / 1_000; },
    threadCpu: () => { calls.thread++; return thread; },
    cpu: () => { calls.cpu++; mono += 2; return cpu; },
    emit: (channel, value) => { calls.emit++; summaries.push({ channel, value }); mono += 50_000; },
  };
  return { host, calls, summaries, advance(ms: number) {
    mono += ms; thread.user += ms * 200; thread.system += ms * 50;
    cpu.user += ms * 2_000; cpu.system += ms * 500;
  } };
}
function withDiagnostics<T>(enabled: boolean, work: () => T): T {
  const prior = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
  process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = enabled ? "1" : "0";
  try { return work(); } finally {
    if (prior === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = prior;
  }
}

// Execute the actual private production bodies with deterministic clocks, not a
// handwritten copy of their control flow. The integration test below separately
// imports the real coordinator and exercises its public entry point/native host.
const coordinatorSource = readFileSync(new URL("../strict-current-runtime-coordinator.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("coordinator.ts", coordinatorSource, ts.ScriptTarget.Latest, true);
function productionBodies(host: PricingPhaseHost) {
  const names = ["effectiveCoverageKeys", "strictGraphPublicationFingerprint", "buildEffectivePricingSnapshot", "diagnosePricingSync"];
  const bodies = names.map(name => {
    const node = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert(node, `missing production function: ${name}`); return node.getText(parsed);
  });
  const deps = { beginPricingPhaseDiagnostics: (enabled: boolean, phase: string) => beginPricingPhaseDiagnostics(enabled, phase, host),
    blockScanEdgeKey, exactSetHash, strictReadyGraphContractFingerprint, effectiveMidRowCarried, edgeInstanceKey, scannerConsumesEdge };
  const js = ts.transpileModule(bodies.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), `${js}; return { buildEffectivePricingSnapshot, diagnosePricingSync };`)(...Object.values(deps)) as {
    buildEffectivePricingSnapshot: (...args: any[]) => any;
    diagnosePricingSync: <T>(graph: typeof source, phase: string, work: () => T) => T;
  };
}
function pricingInput(count = 1) {
  const edges = Array.from({ length: count }, (_, i) => ({ canonicalEdgeId: `edge:${i}` as CanonicalEdgeId, instanceKey: `instance:${i}`,
    target: UNIV2_FIXTURE_POOL, tokenIn: UNIV2_FIXTURE_TOKEN0, tokenOut: UNIV2_FIXTURE_TOKEN1,
    adapterId: "univ2-swap" as const, slotKind: "swap" as const, ...deriveEdgeTaxonomy("swap"), score: 0 }));
  const keys = edges.map(blockScanEdgeKey);
  const graph = { ...source, edges, scannerEdgeCount: count, scannerEdgeKeyHash: exactSetHash(keys) };
  const index = { expectedEdgeKeys: keys, expectedEdgeKeyHash: exactSetHash(keys),
    readyGraphContractFingerprint: strictReadyGraphContractFingerprint(edges),
    familyIdByEdgeKey: new Map(keys.map(key => [key, "fixture-family"])),
    stateKeyByEdgeKey: new Map(keys.map(key => [key, key])), perBlockRefreshStateKeys: [] };
  const effective = { source: { number: source.sourceBlock, hash: source.sourceBlockHash, generation: source.generation },
    rows: new Map(edges.map((edge, i) => [keys[i]!, { edgeId: keys[i], instanceKey: edge.instanceKey,
      tokenIn: edge.tokenIn, tokenOut: edge.tokenOut, status: "quoted", amountIn: 1n, amountOut: 2n, effectiveMid: 2 }])),
    reference: "default", referenceWethInput: 1n, complete: true, wallMs: 0 };
  const raw = { ...source, graph, mids: new Map(), coverage: {} };
  const cache: Record<string, any> = {};
  return { raw, graph, index, effective, cache, args: [raw, graph, index, effective, null, cache] };
}

test("four nonoverlapping production-helper intervals reconcile the same-call envelope and sampling residual", () => {
  const f = fixture(), sample = beginPricingPhaseDiagnostics(true, phases[0]!, f.host)!;
  for (let i = 0; i < phases.length; i++) {
    if (i) sample.enter(phases[i]!);
    f.advance((i + 1) * 10);
    assert.equal(f.summaries.length, 0, "no per-phase logging");
  }
  sample.finish(source, "returned", "coverage-phase-diagnostics");
  sample.finish(source, "failed", "coverage-phase-diagnostics"); sample.enter("ignored");
  const { channel, value: summary } = f.summaries[0]!;
  assert.equal(channel, "coverage-phase-diagnostics");
  assert.deepEqual(f.calls, { now: 10, origin: 5, uptime: 5, thread: 5, cpu: 5, emit: 1 });
  assert.equal(summary.wallMs, 110); assert.equal(summary.accounting.intervalSumWallMs, 100);
  assert.equal(summary.accounting.residualWallMs, 10); assert.equal(summary.accounting.boundarySamplingWallMs, 10);
  assert.equal(summary.wallMs, summary.accounting.intervalSumWallMs + summary.accounting.residualWallMs);
  assert.deepEqual(summary.intervals.map((i: any) => i.wallMs), [10, 20, 30, 40]);
  for (let i = 1; i < summary.intervals.length; i++) {
    assert(summary.intervals[i].startedMonotonicMs >= summary.intervals[i - 1].finishedMonotonicMs);
    assert.equal(summary.intervals[i].startBoundary, summary.intervals[i - 1].endBoundary);
  }
  assert.equal(summary.startedMonotonicMs, 100); assert.equal(summary.finishedMonotonicMs, 210);
  assert.equal(summary.startedAtMs, 1_000_100); assert.equal(summary.finishedAtMs, 1_000_210);
  assert.equal(summary.boundaries[0].wallOriginMs, 1_000_000); assert.equal(summary.boundaries[0].processUptimeMs, 9_100);
  assert.deepEqual(summary.mainThreadCpu, { scope: "main-thread", availability: "available", userMs: 20, systemMs: 5 });
  assert.deepEqual(summary.processCpu, { scope: "process-wide-all-threads", availability: "available", userMs: 200, systemMs: 50 });
  assert.equal(summary.intervals[0].mainThreadCpu.userMs, 2); assert.equal(summary.intervals[0].processCpu.userMs, 20);
  assert.equal(summary.boundaries[0].mainThreadCpuMicros.user, 1_000, "copy mutable CPU samples");
  assert.match(summary.gcAttribution, /not-proof-of-gc-or-scheduling/);
});

test("disabled factory and production wrappers touch no diagnostic hooks or clocks", () => {
  let hooks = 0;
  const forbidden = new Proxy({} as PricingPhaseHost, { get() { hooks++; throw new Error("disabled hook"); } });
  assert.equal(beginPricingPhaseDiagnostics(false, "unused", forbidden), undefined);
  const { diagnosePricingSync, buildEffectivePricingSnapshot } = productionBodies(forbidden), input = pricingInput();
  const output = {}, originalError = {};
  withDiagnostics(false, () => {
    assert.strictEqual(diagnosePricingSync(source, "local", () => output), output);
    assert.throws(() => diagnosePricingSync(source, "local", () => { throw originalError; }), e => e === originalError);
    assert.strictEqual(buildEffectivePricingSnapshot(...input.args).rawBasis, input.raw);
  });
  assert.equal(hooks, 0);
});

test("actual coverage body preserves maps, cache reuse and output for baseline/delta with bounded samples", () => {
  for (const count of [1, 400]) {
    const f = fixture(), { buildEffectivePricingSnapshot: build } = productionBodies(f.host), input = pricingInput(count);
    const plain = withDiagnostics(false, () => build(...input.args));
    const measured = withDiagnostics(true, () => build(...input.args));
    assert.deepEqual(measured, plain);
    assert.strictEqual(measured.rawBasis, input.raw); assert.strictEqual(measured.snapshot.mids, input.raw.mids);
    assert.strictEqual(measured.snapshot.effectiveMids, input.effective);
    assert.strictEqual(measured.snapshot.pricingStateKeyByEdgeKey, input.index.stateKeyByEdgeKey);
    assert.strictEqual(measured.snapshot.pricingFamilyIdByEdgeKey, input.index.familyIdByEdgeKey);
    assert.strictEqual(measured.snapshot.coverage.resolvedEdgeKeys, plain.snapshot.coverage.resolvedEdgeKeys);
    assert.strictEqual(measured.publication.snapshot, measured.snapshot); assert(Object.isFrozen(measured));
    const summary = f.summaries[0]!.value;
    assert.deepEqual(summary.intervals.map((i: any) => i.phase), phases);
    assert.equal(summary.accounting.sampleCount, 5); assert.equal(f.calls.thread, 5); assert.equal(f.calls.now, 10);
    input.args[4] = plain.snapshot;
    const delta = withDiagnostics(true, () => build(...input.args));
    assert.equal(delta.publication.kind, "delta"); assert.strictEqual(delta.publication.snapshot, delta.snapshot);
    assert.deepEqual(delta.publication.updates, []); assert.deepEqual(delta.publication.removals, []);
  }
});

test("each actual coverage failure reports only entered intervals and preserves the exact thrown value", () => {
  for (let failedPhase = 0; failedPhase < 4; failedPhase++) {
    const f = fixture(), { buildEffectivePricingSnapshot: build } = productionBodies(f.host), input = pricingInput();
    const original = { failedPhase };
    const fail = () => { throw original; };
    if (failedPhase === 0) Object.defineProperty(input.index, "expectedEdgeKeys", { get: fail });
    if (failedPhase === 1) input.index.familyIdByEdgeKey.get = fail;
    if (failedPhase === 2) Object.defineProperty(input.cache, "resolved", { get: fail });
    if (failedPhase === 3) Object.defineProperty(input.raw, "coverage", { get: fail });
    withDiagnostics(true, () => assert.throws(() => build(...input.args), error => error === original));
    const summary = f.summaries[0]!.value;
    assert.equal(summary.status, "failed");
    assert.deepEqual(summary.intervals.map((i: any) => i.phase), phases.slice(0, failedPhase + 1));
    assert.deepEqual(summary.intervals.map((i: any) => i.status), [...Array(failedPhase).fill("returned"), "failed"]);
    assert.equal(summary.accounting.sampleCount, failedPhase + 2);
  }
});

test("existing index and row validations retain errors with diagnostics enabled", () => {
  const f = fixture(), { buildEffectivePricingSnapshot: build } = productionBodies(f.host);
  const changes = [
    (input: ReturnType<typeof pricingInput>) => { input.index.expectedEdgeKeyHash = "wrong"; },
    (input: ReturnType<typeof pricingInput>) => { input.index.stateKeyByEdgeKey.clear(); },
    (input: ReturnType<typeof pricingInput>) => { input.effective.rows.get("edge:0")!.tokenIn = "wrong"; },
    (input: ReturnType<typeof pricingInput>) => { input.effective.rows.get("edge:0")!.amountIn = 0n; },
  ];
  for (const change of changes) {
    const input = pricingInput(); change(input);
    let expected: Error | undefined;
    withDiagnostics(false, () => { try { build(...input.args); } catch (error) { expected = error as Error; } });
    assert(expected);
    withDiagnostics(true, () => assert.throws(() => build(...input.args), error => error instanceof Error && error.message === expected!.message));
  }
});

test("clock, CPU, metadata-clock and sink failures cannot change actual sync wrapper return/error identity", () => {
  for (const hook of ["now", "timeOrigin", "uptime", "threadCpu", "cpu", "emit"] as const) {
    const f = fixture(), original = {}, result = {};
    f.host[hook] = () => { throw new Error(`broken ${hook}`); };
    const { diagnosePricingSync } = productionBodies(f.host);
    withDiagnostics(true, () => {
      assert.strictEqual(diagnosePricingSync(source, "organize-view", () => result), result);
      assert.throws(() => diagnosePricingSync(source, "organize-view", () => { throw original; }), error => error === original);
    });
    if (hook !== "emit") {
      assert.equal(f.summaries.length, 2);
      assert.equal(f.summaries[1]!.value.status, "failed");
      if (hook === "now") assert.equal(f.summaries[0]!.value.wallMs, null);
    }
  }
  for (let brokenRead = 1; brokenRead <= 10; brokenRead++) {
    const f = fixture(), now = f.host.now; let reads = 0;
    f.host.now = () => { if (++reads === brokenRead) throw new Error("one bad boundary"); return now(); };
    const { buildEffectivePricingSnapshot: build } = productionBodies(f.host), input = pricingInput();
    withDiagnostics(true, () => assert.strictEqual(build(...input.args).rawBasis, input.raw));
    assert.equal(f.summaries[0]!.value.intervals.length, 4);
    assert.equal(f.summaries[0]!.value.accounting.sampleCount, 5);
  }
});

test("unavailable main-thread counters never inherit process CPU, and invalid counters stay null", () => {
  for (const threadCpu of [undefined, () => null, () => { throw new Error("unsupported"); }, () => ({ user: NaN, system: 1 })]) {
    const f = fixture(); f.host.threadCpu = threadCpu;
    const sample = beginPricingPhaseDiagnostics(true, "one", f.host)!; f.advance(10);
    sample.finish(source, "returned", "pricing-local-phase");
    const summary = f.summaries[0]!.value;
    assert.deepEqual(summary.mainThreadCpu, { scope: "main-thread", availability: "unavailable", userMs: null, systemMs: null });
    assert.equal(summary.processCpu.userMs, 20); assert.equal(summary.processCpu.systemMs, 5);
  }
});

test("native host feature-detects missing/throwing threadCpuUsage without process fallback", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "threadCpuUsage"), log = console.log;
  try {
    for (const value of [undefined, () => { throw new Error("unsupported runtime"); }]) {
      Object.defineProperty(process, "threadCpuUsage", { configurable: true, value });
      const lines: string[] = []; console.log = line => { lines.push(String(line)); };
      const sample = beginPricingPhaseDiagnostics(true, "native")!;
      sample.finish(source, "returned", "pricing-local-phase");
      assert.equal(lines.length, 1);
      const summary = JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{")));
      assert.equal(summary.mainThreadCpu.availability, "unavailable"); assert.equal(summary.mainThreadCpu.userMs, null);
      assert.equal(summary.processCpu.availability, "available");
    }
  } finally {
    console.log = log;
    if (descriptor) Object.defineProperty(process, "threadCpuUsage", descriptor);
    else Reflect.deleteProperty(process, "threadCpuUsage");
  }
});

test("real public coordinator emits one coverage summary and extended local records without changing publication", async () => {
  const canonical = { number: source.sourceBlock, hash: source.sourceBlockHash, generation: source.generation };
  const publication = await runUniv2Lifecycle(canonical, { pool: UNIV2_FIXTURE_POOL, factory: UNIV2_FIXTURE_FACTORY,
    token0: UNIV2_FIXTURE_TOKEN0, token1: UNIV2_FIXTURE_TOKEN1,
    reserves: { reserve0: 1_000_000_000n, reserve1: 2_000_000_000n, blockTimestampLast: 1 } });
  const family = catalog.forFamily(publication.familyId);
  const view = buildFamilyRouteGraphView({ routes: publication.instances.flatMap(instance => instance.routes.map((route, i) => ({
    family, descriptor: instance.descriptor, route, handle: instance.routeHandles[i] }))) });
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: canonical, readyGraph: view.edges,
    readyInstances: publication.instances, readyFundingAssets: [] });
  const graph = createVerifiedGraphView({ ...source, id: "coverage-diagnostics-fixture", edges: view.edges,
    completenessWatermark: source.sourceBlock, familyIdForEdge: () => publication.familyId,
    perSourceCoverage: [{ familyId: publication.familyId, sourceId: "fixture", sourceFingerprint: "fixture",
      completeThroughBlock: source.sourceBlock, completeThroughHash: source.sourceBlockHash }] });
  let observed: unknown;
  const make = () => new StrictCurrentRuntimeCoordinator(request => root.createSession({ source: request.source,
    runtime: createStrictCentralAdapterRuntime({ provider: {
      call: async call => call.data.startsWith(UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector)
        ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [1_000_000_000n, 2_000_000_000n, 1])
        : UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [10n ** 24n]),
      getCode: async () => "0x01", getStorage: async () => "0x" + "00".repeat(32),
    }, executor: UNIV2_FIXTURE_TOKEN0, transactionOrigin: UNIV2_FIXTURE_TOKEN1,
    generationFence: { assertCurrent(generation, current) { assert.equal(generation, canonical.generation); assert.deepEqual(current, canonical); } } }),
    fundingAssets: request.fundingAssets, control: request.control, kind: "pricing",
  }), () => {}, p => { observed = p.snapshot; }, (pricing, control) => buildEffectiveMids({ pricing, control,
    weth: UNIV2_FIXTURE_TOKEN0, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 1,
    quote: async ({ amountIn }) => ({ source: canonical, amountIn, amountOut: amountIn * 2n }) }));
  const prior = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS, log = console.log, lines: string[] = [];
  console.log = line => { lines.push(String(line)); };
  try {
    process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = "0";
    const plain = await make().prepareCoarsePricing({ graph, deadlineAtMs: Date.now() + 10_000 });
    assert(plain.snapshot);
    assert.equal(lines.filter(line => /coverage-phase-diagnostics|pricing-local-phase/.test(line)).length, 0);
    process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = "1";
    const coordinator = make();
    const measured = await coordinator.prepareCoarsePricing({ graph, deadlineAtMs: Date.now() + 10_000 });
    assert(measured.snapshot);
    assert.strictEqual(measured.snapshot, observed); assert.strictEqual(measured.snapshot, coordinator.latestPricingSnapshot());
    assert.deepEqual(measured.snapshot.coverage, plain.snapshot.coverage);
    assert.deepEqual(measured.snapshot.effectiveMids!.rows, plain.snapshot.effectiveMids!.rows);
    const coverage = lines.filter(line => line.startsWith("[searcher/coverage-phase-diagnostics] "));
    assert.equal(coverage.length, 1);
    const summary = JSON.parse(coverage[0]!.slice(coverage[0]!.indexOf("{")));
    assert.equal(summary.sourceBlock, source.sourceBlock); assert.equal(summary.sourceBlockHash, source.sourceBlockHash);
    assert.equal(summary.generation, source.generation); assert.equal(summary.accounting.sampleCount, 5);
    assert.deepEqual(summary.intervals.map((i: any) => i.phase), phases);
    const local = lines.filter(line => line.startsWith("[searcher/pricing-local-phase] "))
      .map(line => JSON.parse(line.slice(line.indexOf("{"))));
    assert.deepEqual(local.map(i => i.phase), ["coverage-assembly", "failure-index", "organize-view", "publication-observer"]);
    for (const record of local) {
      assert.equal(record.timingModel, "sync-wall-includes-gc"); assert.equal(record.status, "returned");
      for (const key of ["startedAtMs", "finishedAtMs", "wallMs", "startedMonotonicMs", "finishedMonotonicMs"])
        assert.equal(typeof record[key], "number");
      assert.equal(record.mainThreadCpu.scope, "main-thread"); assert.equal(record.processCpu.scope, "process-wide-all-threads");
      assert.equal(record.boundaries.length, 2);
    }
  } finally {
    console.log = log;
    if (prior === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = prior;
  }
});

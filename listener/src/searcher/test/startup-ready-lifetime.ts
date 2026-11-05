/** Offline lexical source-slice proof, NOT full checkpoint/performance validation.
 * Exact baseline/candidate startup statements and producer callback; real runtime
 * and GraphView classes; synthetic store/wiring (no global store cache changes).
 * Run: node --expose-gc --import tsx src/searcher/test/startup-ready-lifetime.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { ethers } from "ethers";
import { initializeReadyProducer } from "../main.js";
import { resolveStrictReadyRuntime } from "../strict-ready-runtime.js";
import { resolveProducerBaseline } from "../startup-universe-rebuild.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { StrictReadyGraphViewCoordinator } from "../strict-ready-graph-view.js";
import { parseBlockScanObservedHeader } from "../blockscan-observed-header.js";
import { StateCallAbortedError } from "../../shared/state/state-backend.js";
import { assertReadyFamilyActivation, UniverseRunIncomplete, hashReadyGraphSnapshot,
  hashReadyCatalogSnapshot, hashReadyPublicationSet } from "../universe-rebuild-runner.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from
  "../venues/production-family-composition.js";
import { runUniv2Lifecycle, UNIV2_FIXTURE_FACTORY, UNIV2_FIXTURE_POOL,
  UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1 } from "../architecture-migration-fixture-replay.js";
import type { ReadyUniverseGeneration } from "../universe-rebuild-checkpoint.js";
import type { TokenEdge } from "../planner/token-graph.js";

assert.equal(typeof initializeReadyProducer, "function", "main import remains guarded");
assert.equal(typeof globalThis.gc, "function", "ownership check requires --expose-gc");
const baselineSource = readFileSync(process.env.STARTUP_READY_BASELINE_SOURCE ?? new URL(
  "../../../../../../fast-slow-probe-20261104/main-before-lifetime.ts", import.meta.url), "utf8");
const candidateSource = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
assert.equal(sha256(baselineSource), "a109c83049b48805b97987c1855c4c2ac6c61f99718b812b30501ee7eccbf707");
const parse = (source: string) => ts.createSourceFile("startup.ts", source, ts.ScriptTarget.ES2022, true);
function fn(source: string, name: string): ts.FunctionDeclaration {
  const result = parse(source).statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(result?.body, `missing ${name}`);
  return result;
}
function declaration(source: string, name: string): ts.VariableStatement {
  const result = fn(source, "main").body!.statements.find((node): node is ts.VariableStatement =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some(decl =>
      ts.isIdentifier(decl.name) ? decl.name.text === name :
        ts.isObjectBindingPattern(decl.name) && decl.name.elements.some(element => element.name.getText() === name)));
  assert(result, `missing main declaration ${name}`);
  return result;
}
function slice(source: string, first: string, last = first): string {
  return source.slice(declaration(source, first).getStart(), declaration(source, last).end);
}
const selection = (source: string) => source.slice(
  source.indexOf("  let rebuildEnvelope = await rebuildStore.load();"),
  source.indexOf("  const strictReadyRuntime = resolveStrictReadyRuntime(readyUniverse);"));
assert.equal(selection(candidateSource), selection(baselineSource), "selection/root guards stay byte-identical");
assert.equal(slice(candidateSource, "frozenProducerTopology"), slice(baselineSource, "frozenProducerTopology"));
const mainBody = fn(candidateSource, "main").body!.getText();
for (const name of ["rebuildStore", "rebuildWiring", "rebuildEnvelope", "strictReadyRuntime",
  "activeReadyMemos", "routeReadyMemos", "fundingReadyMemos", "readyInstances", "fundingReadyEntries"]) {
  assert(!new RegExp(`\\b${name}\\b`).test(mainBody), `startup owner escaped into main: ${name}`);
}
const startupNames = new Set(["rebuildStore", "rebuildWiring", "rebuildEnvelope", "readyUniverse",
  "strictReadyRuntime", "activeInstanceKeys", "seenReadyInstances", "activeReadyMemos",
  "routeReadyMemos", "fundingReadyMemos", "readyInstances", "fundingReadyEntries", "baseline"]);
const probeNames = new Set([...startupNames, "strictRuntimeRoot", "graph", "graphViewCoordinator", "strictReadyGraphViews"]);
// Plain calls introduce no closure capturing startup variables. All lexical
// captures of those variables remain the exact production source's captures.
function instrument(source: string): string {
  const inserts: { at: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer && probeNames.has(decl.name.text)) {
        inserts.push({ at: node.end, text: `\nprobe(${JSON.stringify(decl.name.text)}, ${decl.name.text});` });
        if (decl.name.text === "strictReadyRuntime") inserts.push({ at: node.end,
          text: '\nprobe("readyUniverse", readyUniverse); probe("catalogSnapshot", readyUniverse.catalogSnapshot); probe("sourceCoverage", readyUniverse.sourceCoverage);' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  for (const insert of inserts.sort((a, b) => b.at - a.at)) source = source.slice(0, insert.at) + insert.text + source.slice(insert.at);
  return source;
}
const logStatements = (source: string) => fn(source, "main").body!.statements
  .map(node => node.getText()).filter(text => text.startsWith("console.log(") && [
    "strict ready graph loaded:", "strict startup coverage restored:",
    "strict ready catalog loaded:", "universe rebuild ready generation=",
  ].some(marker => text.includes(marker))).join("\n");
const inputs = ["probe", "UniverseRebuildCheckpointStore", "createRebuildWiring", "refreshReadyInstances",
  "rebuildUniverse", "UniverseRunIncomplete", "resolveStrictReadyRuntime", "assertReadyFamilyActivation",
  "PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG", "StrictProductionRuntimeRoot",
  "StrictReadyGraphViewCoordinator", "resolveProducerBaseline", "ethers", "console", "process",
  "parseBlockScanObservedHeader", "StateCallAbortedError"];
function compile(source: string, candidate: boolean) {
  const helper = candidate ? fn(source, "initializeReadyProducer").getText().replace(/^export /, "") : "";
  const startup = slice(source, "universeRebuildCheckpointPath", "strictRuntimeRoot");
  const projection = candidate ? slice(source, "graph") : [slice(source, "graph"),
    slice(source, "strictReadyGraphViews"), slice(source, "baseline")].join("\n");
  const summaries = candidate ? "" : `
    const readyInstanceCount = readyInstances.length;
    const baselineSummary = { generation: baseline.ready.generation, cutoffNumber: baseline.ready.cutoff.number,
      activeInstanceCount: baseline.activeInstanceKeys.size, observationScanFrom: baseline.observationScanFrom };
  `;
  const body = `${helper}
    return async function startup(blindUseIncumbentReady, useReadyGeneration) {
      const config = { rpcUrl: "http://offline.invalid" };
      const executionIdentity = { executor: "0x${"44".repeat(20)}", transactionOrigin: "0x${"55".repeat(20)}" };
      const onSimulationFatal = () => { throw new Error("unexpected simulation"); };
      const rawPinnedWarmPools = [], rawUniversePools = [], rawBlockscanUniverse = [], rawBlockScanOverrides = [];
      const discoveryToBlock = 101, enableBlockScan = true, blockScanChainId = 1n;
      const blockScanActivityProvider = { observeHeader: async (_number, read) => read() };
      const blockScanAmountReference = { observeHeader: () => {} };
      const activityReadFailed = error => { throw error; };
      const provider = { send: async (_method, [number]) => ({ number, hash: "0x${"ab".repeat(32)}",
        parentHash: "0x${"cd".repeat(32)}", timestamp: "0x1", gasUsed: "0x0", gasLimit: "0x1", transactions: [] }) };
      const readBlockScanObservedHeader = () => { throw new Error("test forbids network"); };
      ${startup}
      ${projection}
      ${summaries}
      ${logStatements(source)}
      ${slice(source, "frozenProducerTopology")}
      const view = strictReadyGraphViews.build({ id: "fixture-current", topologyKey: frozenProducerTopology.topologyKey,
        generation: 2, sourceBlock: 101, sourceBlockHash: "0x${"ab".repeat(32)}", edges: graph });
      const summary = JSON.stringify({ graph, view, flashTokens, instanceCount: readyInstanceCount,
        catalogHash: readyUniverse.catalogHash, baselineSummary, pricing: strictRuntimeRoot.pricingIndex() },
        (_key, value) => value instanceof Map || value instanceof Set ? [...value] : typeof value === "bigint" ? String(value) : value);
      return { runtimeRoot: strictRuntimeRoot, graph, graphViewCoordinator: strictReadyGraphViews,
        callback: frozenProducerTopology.observeHeader, summary };
    };
  `;
  return new Function(...inputs, ts.transpileModule(instrument(body), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
  } }).outputText);
}
const oldRun = compile(baselineSource, false), newRun = compile(candidateSource, true);
const SOURCE = { number: 100, hash: `0x${"ab".repeat(32)}`, generation: 1 };
const publication = await runUniv2Lifecycle(SOURCE, {
  pool: UNIV2_FIXTURE_POOL, factory: UNIV2_FIXTURE_FACTORY,
  token0: UNIV2_FIXTURE_TOKEN0, token1: UNIV2_FIXTURE_TOKEN1,
  reserves: { reserve0: 1_000_000_000n, reserve1: 2_000_000_000n, blockTimestampLast: 1 },
});
const family = catalog.forFamily(publication.familyId);
const templateGraph = buildFamilyRouteGraphView({ routes: publication.instances.flatMap(instance =>
  instance.routes.map((route, index) => ({ family, descriptor: instance.descriptor, route, handle: instance.routeHandles[index] }))) }).edges;
const fundingFamily = catalog.listAll().find(entry => entry.plugin.manifest.domain === "funding")!.plugin.manifest.familyId;
type Scenario = "ok" | "missing" | "in-progress" | "no-ready" | "root" | "coverage" | "disabled" |
  "lost-memo" | "no-funding" | "incomplete" | "fatal" | "refresh-fatal" | "reload-missing" | "generation-mismatch";
type Memo = { familyId: string; familyInstanceKey: string; instanceKey: string; asset?: string };
function makeEnvelope(scenario: Scenario, generation = 1) {
  const graphSnapshot = { format: "strict-rebuild-graph-v1", edges: [...templateGraph] };
  const keys = scenario === "no-funding" ? ["route"] : ["route", "funding:a", "funding:b", "funding:c"];
  const catalogSnapshot = { format: "strict-rebuild-catalog-v1", instances: keys.map(familyInstanceKey => ({ familyInstanceKey })) };
  const ready: ReadyUniverseGeneration = {
    generation, cutoff: { ...SOURCE }, universeRange: { fromBlock: 90, toBlock: 100 }, universeHash: "fixture",
    catalogHash: hashReadyCatalogSnapshot(catalogSnapshot), activeInstanceKeys: keys,
    publicationSetHash: hashReadyPublicationSet(catalogSnapshot),
    candidateAccounting: { total: keys.length, verified: keys.length, terminalRejected: 0, retryable: 0, remainingUnaccounted: 0 },
    observedThrough: { number: 100, hash: SOURCE.hash }, appliedThrough: { number: 100, hash: SOURCE.hash },
    sourceCoverage: [{ familyId: String(publication.familyId), sourceId: "fixture-startup", completeThroughBlock: scenario === "coverage" ? 99 : 100, completeThroughHash: SOURCE.hash }],
    graphSnapshot, graphHash: scenario === "root" ? "tampered" : hashReadyGraphSnapshot(graphSnapshot), catalogSnapshot,
  };
  const route: Memo = { familyId: String(publication.familyId), familyInstanceKey: "route", instanceKey: "route" };
  const verifiedMemos: Record<string, Memo> = { route, duplicate: { ...route },
    inactive: { familyId: "ignored-inactive-family", familyInstanceKey: "inactive", instanceKey: "inactive" } };
  if (scenario === "lost-memo") { delete verifiedMemos.route; delete verifiedMemos.duplicate; }
  if (scenario !== "no-funding") for (const [index, asset] of [UNIV2_FIXTURE_TOKEN1, UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1].entries()) {
    const key = keys[index + 1]!;
    verifiedMemos[key] = { familyId: String(fundingFamily), familyInstanceKey: key, instanceKey: key, asset };
  }
  return { readyGeneration: scenario === "no-ready" ? null : ready,
    inProgressRun: scenario === "in-progress" ? {} : null, verifiedMemos, retryableAttemptsByCandidateKey: {} };
}
interface Retained {
  runtimeRoot: StrictProductionRuntimeRoot;
  graph: TokenEdge[];
  graphViewCoordinator: StrictReadyGraphViewCoordinator;
  callback(number: number): Promise<{ number: number }>;
  summary: string;
}
function harness(candidate: boolean, scenario: Scenario, env: Record<string, string> = {}) {
  const probes = new Map<string, WeakRef<object>>(), calls: string[] = [], logs: string[] = [];
  const probe = (name: string, value: object) => { if (value) probes.set(name, new WeakRef(value)); };
  class Store {
    envelope = scenario === "missing" ? null : makeEnvelope(scenario);
    loads = 0;
    async load() {
      calls.push("load");
      return ++this.loads > 1 && scenario === "reload-missing" ? null : this.envelope;
    }
  }
  const createWiring = () => ({
    isFamilyEnabled: () => scenario !== "disabled",
    rehydrateVerifiedInstance({ memo }: { memo: Memo }) {
      calls.push(`rehydrate:${memo.instanceKey}`);
      return memo.asset ? { domain: "funding", familyId: memo.familyId, instanceKey: memo.instanceKey, asset: memo.asset }
        : publication.instances[0];
    },
  });
  const select = (name: string) => async (input: { store: Store; runId?: string; observationWindowBlocks?: number }) => {
    calls.push(`${name}:${input.runId ?? ""}:${input.observationWindowBlocks ?? "default"}`);
    if (scenario === "incomplete") throw new UniverseRunIncomplete({ runId: input.runId!, remainingUnaccounted: 3 });
    if (scenario === "fatal" || scenario === "refresh-fatal") throw new Error("fixture canonical failure");
    input.store.envelope = makeEnvelope(scenario, 2);
    const ready = input.store.envelope.readyGeneration!;
    return scenario === "generation-mismatch" ? { ...ready, generation: 3 } : ready;
  };
  const run = (candidate ? newRun : oldRun)(probe, Store, createWiring, select("refresh"), select("rebuild"),
    UniverseRunIncomplete, resolveStrictReadyRuntime, assertReadyFamilyActivation, catalog, StrictProductionRuntimeRoot,
    StrictReadyGraphViewCoordinator, resolveProducerBaseline, ethers, { log: (message: string) => logs.push(message) },
    { env: { SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH: "offline-checkpoint", ...env } }, parseBlockScanObservedHeader,
    StateCallAbortedError) as (blind: boolean, reuse: boolean) => Promise<Retained>;
  return { run, probes, calls, logs };
}
async function outcome(candidate: boolean, scenario: Scenario, blind: boolean, reuse: boolean, env = {}) {
  const h = harness(candidate, scenario, env);
  try { return { ...h, retained: await h.run(blind, reuse), error: null }; }
  catch (error) { return { ...h, retained: null, error: String(error) }; }
}
const cases: [Scenario, boolean, boolean, string | null][] = [
  ["ok", true, false, null], ["ok", true, true, null], ["ok", false, true, null], ["ok", false, false, null],
  ["missing", true, false, "requires one complete Ready checkpoint"],
  ["missing", false, true, "requires one complete Ready checkpoint"],
  ["in-progress", true, true, "requires one complete Ready checkpoint"],
  ["no-ready", false, true, "requires one complete Ready checkpoint"],
  ["root", true, false, "root mismatch"], ["coverage", true, false, "source coverage is incomplete"],
  ["disabled", true, false, "disabled Families"], ["lost-memo", true, false, "lost an active memo"],
  ["no-funding", true, false, "no observed/retained funding token"],
  ["incomplete", false, false, "rebuild incomplete: run=strict-startup-rebuild remainingUnaccounted=3"],
  ["fatal", false, false, "fixture canonical failure"], ["refresh-fatal", false, true, "fixture canonical failure"],
  ["reload-missing", false, true, "failed root verification"], ["reload-missing", false, false, "failed root verification"],
  ["generation-mismatch", false, true, "failed root verification"], ["generation-mismatch", false, false, "failed root verification"],
];
for (const [scenario, blind, reuse, expected] of cases) {
  const old = await outcome(false, scenario, blind, reuse), next = await outcome(true, scenario, blind, reuse);
  assert.equal(next.error, old.error, `${scenario}: failure parity`);
  if (expected) assert(old.error?.includes(expected), `${scenario}: must fail closed: ${old.error}`);
  else {
    assert.equal(old.error, null);
    assert.equal(next.retained!.summary, old.retained!.summary, `${scenario}: graph/catalog/coverage/funding/runtime parity`);
    const data = JSON.parse(next.retained!.summary);
    assert.equal(data.instanceCount, 1, "duplicate/inactive memos do not become runtime instances");
    assert.deepEqual(data.flashTokens, [...new Set([UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1].map(x => x.toLowerCase()))].sort());
    assert.equal(next.calls.some(call => call.startsWith("refresh:")), !blind && reuse, "normal reuse must refresh");
    assert.equal(next.calls.some(call => call.startsWith("rebuild:")), !blind && !reuse, "only rebuild starts discovery");
  }
  assert.deepEqual(next.calls, old.calls, `${scenario}: call-order parity`);
  assert.deepEqual(next.logs, old.logs, `${scenario}: startup log parity`);
}
const explicit = { SEARCHER_UNIVERSE_REBUILD_RUN_ID: "fixture-run", SEARCHER_UNIVERSE_REBUILD_WINDOW_BLOCKS: "42" };
const configuredOld = await outcome(false, "ok", false, false, explicit), configuredNew = await outcome(true, "ok", false, false, explicit);
assert.deepEqual(configuredNew.calls, configuredOld.calls);
assert(configuredNew.calls.includes("rebuild:fixture-run:42"));

// Keep the genuine producer callback and actual runtime projections alive.
// No returned result strongly references Ready/envelope/store/memo arrays.
async function ownership(candidate: boolean) {
  const h = harness(candidate, "ok");
  const retained = await h.run(true, false);
  assert.equal((await retained.callback(101)).number, 101);
  return { retained, probes: h.probes };
}
const oldOwnership = await ownership(false), newOwnership = await ownership(true);
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
for (let attempt = 0; attempt < 12; attempt++) {
  await turn();
  globalThis.gc!();
  await turn();
}
const survivors = (probes: Map<string, WeakRef<object>>) => [...probes].filter(([, ref]) => ref.deref() !== undefined).map(([name]) => name);
const oldSurvivors = survivors(oldOwnership.probes), newSurvivors = survivors(newOwnership.probes);
for (const name of [...startupNames, "catalogSnapshot", "sourceCoverage"]) {
  assert(newOwnership.probes.has(name), `missing candidate weak probe: ${name}`);
  assert(!newSurvivors.includes(name), `candidate startup owner retained: ${name}`);
}
assert(newSurvivors.includes("strictRuntimeRoot") && newSurvivors.includes("graph") && newSurvivors.includes("graphViewCoordinator"), "runtime projections must remain alive");
assert.equal(newOwnership.retained.runtimeRoot.pricingIndex().stateKeyByEdgeKey.size, templateGraph.length);
assert.equal((await newOwnership.retained.callback(101)).number, 101);
const oldRetentionWitnessed = oldSurvivors.includes("readyUniverse") && oldSurvivors.includes("rebuildWiring");
console.log(JSON.stringify({ test: "startup-ready-lifetime", proof: "lexical-source-slice-only",
  parityCases: cases.length + 1, candidateStartupOwnersCollected: true,
  oldRetention: oldRetentionWitnessed ? "witnessed" : "inconclusive", oldSurvivors, newSurvivors,
  baselineSha256: sha256(baselineSource), candidateSha256: sha256(candidateSource),
  fullCheckpointValidation: "pending", performanceClaim: "unproven" }));
if (!oldRetentionWitnessed) process.exitCode = 2;

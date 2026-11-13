/** Execute the actual startup selection functions with isolated dependencies.
 * Runner/store integration is covered separately; this checks the production
 * caller's inputs, resume guards and read-only consumer boundary without RPC. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import ts from "typescript";
import { canonicalJson } from "../universe-rebuild-checkpoint.js";

const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.ES2022, true);
function functionSource(name: string): string {
  const fn = parsed.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(fn?.body, name + " is present in the production entrypoint");
  return fn.getText(parsed).replace(/^export /, "");
}
const dependencies = ["liveReadySubsetPriceMode", "UniverseRebuildCheckpointStore", "createRebuildWiring",
  "rebuildUniverse", "UniverseRunIncomplete", "resolveStrictReadyRuntime", "canonicalJson", "console", "process", "createReadStream", "createHash", "existsSync",
  "sealedReadyMemos", "assertReadyFamilyActivation", "PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG",
  "ethers", "StrictProductionRuntimeRoot", "StrictReadyGraphViewCoordinator", "resolveProducerBaseline"];
const factory = new Function(...dependencies, ts.transpileModule(
  functionSource("readPreparedReadySeal") + "\n" + functionSource("readyStartupReviewPlan") + "\n" + functionSource("initializeReadyProducer") +
    "\nreturn { initializeReadyProducer, readyStartupReviewPlan, readPreparedReadySeal };",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText);

const cutoff = Object.freeze({ number: 100, hash: "0x" + "ab".repeat(32), generation: 7 });
const range = Object.freeze({ fromBlock: 81, toBlock: 100 });
const completeCandidates = Object.freeze([
  Object.freeze({ familyId: "fixture:a", address: "0x" + "11".repeat(20) }),
  Object.freeze({ familyId: "fixture:b", address: "0x" + "22".repeat(20) }),
]);
const identity = Object.freeze({ executor: "0x" + "33".repeat(20), transactionOrigin: "0x" + "44".repeat(20) });
function checkpoint(partitioned = true): any {
  return { revision: 1, readyGeneration: { generation: 4, cutoff, universeRange: range,
    activeInstanceKeys: ["verified:a", "verified:funding"],
    sourceCoverage: [{familyId:"fixture:a",sourceId:"startup"},{familyId:"fixture:b",sourceId:"startup"}],
    graphSnapshot: {edges:[{canonicalEdgeId:"edge:a"}]}, appliedThrough: cutoff, ...(partitioned ? { familyPartitions: {} } : {}) },
    inProgressRun: null, retryableAttemptsByCandidateKey: {} };
}
class Incomplete extends Error {
  constructor(readonly runId: string, readonly remainingUnaccounted: number) { super("incomplete"); }
}

function harness(initial = checkpoint(), env: Record<string, string> = {}, fail?: Error, assemble = false) {
  const reachedRuntime = new Error("selection completed; stop before runtime assembly");
  const calls: any[] = [], wiringInputs: any[] = [], canonicalChecks: unknown[] = [];
  const projections: unknown[] = [];
  let envelope = initial, rollingFreezes = 0;
  class Store {
    constructor(readonly options: unknown) {}
    async load() { return envelope; }
  }
  const checks: string[] = [];
  const wiring = {
    completeInputMarker: completeCandidates,
    isReadyMemoDefinitionCurrent: (_memo: unknown) => { checks.push("definition"); return true; },
    isFamilyEnabled: (_id: string) => true,
    rehydrateVerifiedInstance: ({memo}: any) => { checks.push("rehydrate"); return memo; },
    aggregateOnceByFamily: (instances: unknown[]) => instances,
    assertReadyGraphSnapshot: (_input: unknown) => { checks.push("graph"); },
    readyReviewInputFingerprint: () => "f".repeat(64),
    familyDefinitionHash: (id: string) => id + ":current",
    requiredSourceCoverageKeys: () => ["fixture:a|startup", "fixture:b|startup"],
    freezeCanonicalHead: async (_number?: number) => { rollingFreezes++; return { ...cutoff, number: 999 }; },
    assertCanonicalHead: async (value: unknown) => { canonicalChecks.push(value); },
  };
  const functions = factory(
    (values: Record<string, string>) => values.TEST_SUBSET_MODE,
    Store,
    (input: unknown) => { wiringInputs.push(input); return wiring; },
    async (input: any) => {
      calls.push(input);
      if (fail) throw fail;
      if (input.observationRange && !input.resumeCompletedOutcomes)
        assert.deepEqual(await input.freezeCanonicalHead(input.observationRange.toBlock), cutoff);
      const ready = { ...(envelope?.readyGeneration ?? checkpoint().readyGeneration), generation: 5 };
      envelope = { ...(envelope ?? checkpoint()), readyGeneration: ready, inProgressRun: null };
      return ready;
    },
    Incomplete,
    (ready: any) => { projections.push(ready); if (!assemble) throw reachedRuntime; return {graph:ready.graphSnapshot.edges}; },
    canonicalJson,
    { log: () => {} },
    { env },
    async function* () { yield Buffer.from("sealed checkpoint"); }, createHash, () => env.TEST_JOURNAL === "1",
    () => [{familyId:"fixture:a",instanceKey:"verified:a"},
      {familyId:"fixture:funding",instanceKey:"verified:funding",asset:identity.executor}],
    (memos: any[], enabled: (id: string)=>boolean) => { checks.push("activation"); assert(memos.every(m=>enabled(m.familyId)), "disabled Family"); },
    {forStrictFamily: (id: string) => ({plugin:{manifest:{domain:id==="fixture:funding"?"funding":"protocol"}}})},
    {getAddress:(address:string)=>address}, class {}, class {},
    ({ready}: any) => ({ready, activeInstanceKeys:new Set(ready.activeInstanceKeys), observationScanFrom:101}),
  );
  const invoke = (overrides: Record<string, unknown> = {}) => functions.initializeReadyProducer({
    universeRebuildCheckpointPath: "/offline/checkpoint.json", rpcUrl: "http://offline.invalid",
    startupCandidates: completeCandidates, executionIdentity: identity, onSimulationFatal: () => {},
    blindUseIncumbentReady: false, useReadyGeneration: true, currentHead: 999, ...overrides,
  });
  const selected = (overrides?: Record<string, unknown>) =>
    assert.rejects(invoke(overrides), (error: unknown) => error === reachedRuntime);
  return { ...functions, calls, wiringInputs, canonicalChecks, projections, wiring, invoke, selected, checks,
    rollingFreezes: () => rollingFreezes };
}

test("ordinary Ready reuse enters the common runner with complete inputs and the sealed source", async () => {
  const h = harness(checkpoint(), { SEARCHER_UNIVERSE_REBUILD_RUN_ID: "requested-review",
    SEARCHER_UNIVERSE_REBUILD_WINDOW_BLOCKS: "500" });
  await h.selected();
  assert.equal(h.calls.length, 1);
  const input = h.calls[0];
  assert.equal(input.runId, "requested-review");
  assert.deepEqual(input.observationRange, range);
  assert.equal(input.observationWindowBlocks, undefined, "rolling-window overrides cannot change Ready reuse time");
  assert.equal(input.resumeCompletedOutcomes, false);
  assert.equal(input.completeInputMarker, completeCandidates);
  assert.equal(input.familyDefinitionHash, h.wiring.familyDefinitionHash);
  assert.equal(input.readyReviewInputFingerprint, h.wiring.readyReviewInputFingerprint);
  assert.equal(input.familyUpdateScope, undefined);
  assert.equal(input.previousReadyReview, undefined, "the common runner derives its ordinary full-input review");
  assert.equal(h.wiringInputs[0].startupCandidates, completeCandidates);
  assert.equal(h.wiringInputs[0].executionIdentity, identity);
  assert.deepEqual(h.canonicalChecks, [cutoff]);
  assert.equal(h.rollingFreezes(), 0);
  await assert.rejects(input.freezeCanonicalHead(101), /cannot move its sealed cutoff/);
  await assert.rejects(input.freezeCanonicalHead(undefined), /cannot move its sealed cutoff/);
  assert.equal(h.projections.length, 1);
});

test("an unfinished review resumes its sealed run and completed outcomes without changing the input range", async () => {
  const state = checkpoint();
  state.inProgressRun = { runId: "already-sealed-review", cutoff, fromBlock: range.fromBlock,
    candidatesByKey: { a: completeCandidates[0], b: completeCandidates[1] }, outcomesByCandidateKey: { a: { status: "verified" } } };
  const h = harness(state, { SEARCHER_UNIVERSE_REBUILD_RUN_ID: "new-default-name" });
  await h.selected();
  assert.equal(h.calls[0].runId, "already-sealed-review");
  assert.equal(h.calls[0].resumeCompletedOutcomes, true);
  assert.deepEqual(h.calls[0].observationRange, range);
  assert.equal(h.wiringInputs[0].startupCandidates, completeCandidates, "progress does not replace complete inputs with a pending list");
  assert.equal(h.rollingFreezes(), 0);
});

test("Ready reuse rejects unfinished work bound to another historical source or range before the runner", async () => {
  for (const change of [
    { fromBlock: range.fromBlock - 1 },
    { cutoff: { ...cutoff, number: cutoff.number + 1 } },
    { cutoff: { ...cutoff, hash: "0x" + "cd".repeat(32) } },
    { cutoff: { ...cutoff, generation: cutoff.generation + 1 } },
  ]) {
    const state = checkpoint();
    state.inProgressRun = { runId: "foreign", cutoff, fromBlock: range.fromBlock, ...change };
    const h = harness(state);
    await assert.rejects(h.invoke(), /sealed parent source and range/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.canonicalChecks.length, 0);
  }
});

test("blind replay and live subsets remain complete-checkpoint consumers", async () => {
  const modes: Array<{ env: Record<string, string>; input: Record<string, unknown> }> = [
    { env: {}, input: { blindUseIncumbentReady: true, useReadyGeneration: false } },
    { env: { TEST_SUBSET_MODE: "resume", SEARCHER_DRY_RUN: "1", SEARCHER_BLOCKSCAN_SUBMIT: "0",
      SEARCHER_ENABLE_BACKRUN: "0", SEARCHER_ENABLE_MEMPOOL: "0" }, input: {} },
  ];
  for (const mode of modes) {
    const h = harness(checkpoint(), mode.env);
    await h.selected(mode.input);
    assert.equal(h.calls.length, 0);
    assert.equal(h.canonicalChecks.length, 0);
    const state = checkpoint(); state.inProgressRun = { runId: "pending", cutoff, fromBlock: range.fromBlock };
    const pending = harness(state, mode.env);
    await assert.rejects(pending.invoke(mode.input), /requires one complete Ready checkpoint/);
    assert.equal(pending.calls.length, 0);
  }
});

test("legacy unpartitioned Ready uses the same rebuild entry without exact-set refresh fallback", async () => {
  const h = harness(checkpoint(false));
  await h.selected();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].observationRange, range);
  assert.deepEqual(h.canonicalChecks, [cutoff]);
  assert(!functionSource("initializeReadyProducer").includes("refreshReadyInstances"));
});

test("ordinary non-reuse startup preserves its rolling rebuild policy", async () => {
  const h = harness(null, { SEARCHER_UNIVERSE_REBUILD_RUN_ID: "rolling-build", SEARCHER_UNIVERSE_REBUILD_WINDOW_BLOCKS: "50" });
  await h.selected({ useReadyGeneration: false });
  assert.equal(h.calls[0].runId, "rolling-build");
  assert.equal(h.calls[0].observationWindowBlocks, 50);
  assert.equal(h.calls[0].observationRange, undefined);
  assert.equal(h.calls[0].freezeCanonicalHead, h.wiring.freezeCanonicalHead);
});

test("reuse still requires a sealed parent and reports unfinished runner work as resumable", async () => {
  for (const state of [null, { ...checkpoint(), readyGeneration: null }]) {
    const h = harness(state);
    await assert.rejects(h.invoke(), /requires one complete Ready checkpoint/);
    assert.equal(h.calls.length, 0);
  }
  const h = harness(checkpoint(), {}, new Incomplete("sealed-review", 2));
  await assert.rejects(h.invoke(), /run=sealed-review remainingUnaccounted=2.*resume the durable run/);
  assert.equal(h.projections.length, 0);
});

const preparedSeal = Object.freeze({generation:4,sha256:createHash("sha256").update("sealed checkpoint").digest("hex")});
test("prepared Ready consumes the sealed graph through production assembly without discovery or attestation", async () => {
  const h = harness(checkpoint(), {}, undefined, true);
  const result = await h.invoke({preparedReady:preparedSeal});
  assert.equal(result.lineage.generation,4);
  assert.equal(result.instanceCount,1);
  assert.equal(result.graph.length,1);
  assert.equal(h.calls.length,0);
  assert.deepEqual(h.canonicalChecks,[cutoff]);
  assert.deepEqual(h.checks,["definition","definition","activation","rehydrate","rehydrate","graph"]);
});

test("prepared Ready fails closed on changed bytes/generation, incomplete inputs and missing coverage", async () => {
  for (const [state, seal, error] of [
    [checkpoint(), {...preparedSeal,sha256:"0".repeat(64)}, /checkpoint hash changed/],
    [checkpoint(), {...preparedSeal,generation:5}, /generation changed/],
    [{...checkpoint(),inProgressRun:{runId:"pending"}},preparedSeal,/complete Ready checkpoint/],
    [null,preparedSeal,/complete Ready checkpoint/],
    [{...checkpoint(),readyGeneration:{...checkpoint().readyGeneration,sourceCoverage:[]}},preparedSeal,/source coverage/],
  ] as const) {
    const h=harness(state,{},undefined,true);
    await assert.rejects(h.invoke({preparedReady:seal}),error);
    assert.equal(h.calls.length,0);
  }
  const h=harness();
  await assert.rejects(h.invoke({preparedReady:preparedSeal,useReadyGeneration:false}),/explicit Ready consumption/);
});

test("prepared Ready rejects an unsealed side journal before loading", async () => {
  const h=harness(checkpoint(),{TEST_JOURNAL:"1"},undefined,true);
  await assert.rejects(h.invoke({preparedReady:preparedSeal}),/unsealed attestation journal/);
  assert.equal(h.calls.length,0);
  assert.equal(h.projections.length,0);
});

test("prepared Ready preserves canonical, definition, activation and Graph rejection", async () => {
  for (const stage of ["canonical","definition","activation","graph"]) {
    const h=harness(checkpoint(),{},undefined,true);
    if(stage==="canonical")h.wiring.assertCanonicalHead=async()=>{throw new Error("canonical mismatch");};
    if(stage==="definition")h.wiring.isReadyMemoDefinitionCurrent=()=>false;
    if(stage==="activation")h.wiring.isFamilyEnabled=()=>false;
    if(stage==="graph")h.wiring.assertReadyGraphSnapshot=()=>{throw new Error("graph mismatch");};
    await assert.rejects(h.invoke({preparedReady:preparedSeal}),/canonical mismatch|proof changed|disabled Family|graph mismatch/);
    assert.equal(h.calls.length,0);
  }
});

test("prepared seal is optional but never accepts an incomplete or malformed launcher binding",()=>{
  const h=harness();
  assert.equal(h.readPreparedReadySeal({}),undefined);
  assert.deepEqual(h.readPreparedReadySeal({SEARCHER_PREPARED_READY_GENERATION:"4",SEARCHER_PREPARED_READY_SHA256:preparedSeal.sha256}),preparedSeal);
  for(const env of [{SEARCHER_PREPARED_READY_GENERATION:"4"},{SEARCHER_PREPARED_READY_SHA256:preparedSeal.sha256},
    {SEARCHER_PREPARED_READY_GENERATION:"4junk",SEARCHER_PREPARED_READY_SHA256:preparedSeal.sha256},
    {SEARCHER_PREPARED_READY_GENERATION:"4",SEARCHER_PREPARED_READY_SHA256:"invalid"}])assert.throws(()=>h.readPreparedReadySeal(env),/generation and checkpoint SHA256/);
});

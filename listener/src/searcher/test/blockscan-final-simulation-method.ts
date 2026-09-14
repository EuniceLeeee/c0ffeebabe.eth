import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { ethers } from "ethers";
import { parseBlockScanObservedHeader } from "../blockscan-observed-header.js";
import { resolveBlockScanFinalSimulationMethod, requireFinalSimulationHeader } from "../blockscan-final-simulation-method.js";
import { createFinalSimulationWorkRuntime } from "../final-simulation-work-runtime.js";
import { executeFinalSimulationWork } from "../adapter-work-intent.js";

const hash = `0x${"ab".repeat(32)}`;
const source = { number: 100, hash, generation: 2 };
const header = { number: 100, hash, parentHash: `0x${"cd".repeat(32)}`, timestamp: 1_000,
  baseFeePerGas: 10n, gasUsed: 100n, gasLimit: 1_000n, transactionHashes: [] };

test("explicit method defaults to eth_simulateV1, preserves Anvil, rejects typos", () => {
  const before = process.env.SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD;
  try {
    delete process.env.SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD;
    assert.equal(resolveBlockScanFinalSimulationMethod(), "eth_simulateV1");
    for (const method of ["anvil", "eth_simulateV1"] as const) assert.equal(resolveBlockScanFinalSimulationMethod(method), method);
    for (const bad of ["", "alchemy", "reth", "auto", "ETH_SIMULATEV1"]) assert.throws(() => resolveBlockScanFinalSimulationMethod(bad));
  } finally {
    if (before === undefined) delete process.env.SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD;
    else process.env.SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD = before;
  }
});

test("direct method requires the actual full header, never zero fee or invented time", () => {
  assert.equal(requireFinalSimulationHeader(header), header);
  for (const key of ["timestamp", "baseFeePerGas", "gasUsed", "gasLimit", "transactionHashes"]) {
    const partial: any = { ...header }; delete partial[key];
    assert.throws(() => requireFinalSimulationHeader(partial));
  }
});

test("production observed-header projection preserves direct-simulation context in both read paths", async () => {
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const mainAst = ts.createSourceFile("main.ts", main, ts.ScriptTarget.Latest, true);
  let statement = "";
  function find(node: ts.Node): void {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "frozenProducerTopology")) statement = node.getText(mainAst);
    ts.forEachChild(node, find);
  }
  find(mainAst); assert(statement);
  const code = ts.transpileModule(`${statement}\nfrozenProducerTopology;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const raw = { number: "0x64", hash, parentHash: header.parentHash, timestamp: "0x3e8",
    baseFeePerGas: "0xa", gasUsed: "0x64", gasLimit: "0x3e8", transactions: [] };
  let reads = 0, observed = 0;
  const topology = runInNewContext(code, {
    readyUniverse: { generation: 1, graphHash: hash }, ethers, blockScanChainId: 1n,
    config: { rpcUrl: "unused" }, parseBlockScanObservedHeader,
    provider: { async send() { reads++; return raw; } },
    async readBlockScanObservedHeader(_url: string, chain: bigint, n: number) { reads++; return parseBlockScanObservedHeader(raw, n, chain); },
    blockScanAmountReference: { observeHeader() { observed++; } }, console: { log() {} },
  }, { timeout: 1000 });
  for (const control of [undefined, { signal: new AbortController().signal, deadlineAtMs: Date.now() + 1000 }]) {
    const actual = requireFinalSimulationHeader(await topology.observeHeader(100, control));
    for (const key of ["number", "hash", "timestamp", "baseFeePerGas", "gasUsed", "gasLimit"] as const) assert.equal(actual[key], header[key], key);
  }
  assert.equal(reads, 2); assert.equal(observed, 2);
});

// Execute the actual runtime method dispatch and slot configuration, not a second
// simulation pipeline in the test. Dependencies below poison all Anvil work in
// direct mode, and exercise the retained Anvil path under the same S5 runtime.
const text = readFileSync(new URL("../blockscan-runtime-loop.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("runtime.ts", text, ts.ScriptTarget.Latest, true);
const declarations: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) &&
    ["finalSimulationResources", "finalSimulationRuntime"].includes(d.name.text))) declarations.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.length, 2);
const js = ts.transpileModule(`${declarations.join("\n")}\nfinalSimulationRuntime;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const direct of [false, true]) for (const nMinusOne of [false, true]) {
  test(`${direct ? "direct" : "anvil"} S5 method preserves scheduler/result contract in ${nMinusOne ? "N-1" : "N"} path`, async () => {
    const controller = new AbortController();
    const plan: any = { id: "same-plan" }, result: any = { success: true, gasUsed: 99n, scriptHex: "0x1234" };
    let directCalls = 0, forkCalls = 0, waits = 0, executions = 0;
    const worker: any = {};
    const directBackend = { concurrency: 1, async simulate(p: unknown, context: any) {
      directCalls++; assert.equal(p, plan); assert.equal(context.header, header);
      assert.equal(context.source.hash, hash); assert.equal(context.source.number, 100);
      assert(!context.signal.aborted); assert(context.deadlineAtMs > Date.now()); return result;
    } };
    const scope = {
      directFinalSimulation: direct ? directBackend : undefined,
      blockScanFinalSimulationWorkers: direct ? [] : [worker],
      createFinalSimulationWorkRuntime, requireFinalSimulationHeader, sourceHeader: header,
      blockScanWorkerRunner: { async simulate(input: any) {
        assert(!direct, "direct method must not execute through an Anvil worker");
        assert.equal(input.resource, worker); executions++; return result;
      }, terminate() { assert(!direct); } },
      ensureExecutionWorkerForked: async () => { assert(!direct); forkCalls++; },
      backgroundFinalSimForks: new Map([[worker, { wait: async () => { assert(!direct); waits++; }, cancel() {} }]]),
      useNMinusOneFallback: nMinusOne,
      assertFinalSimulationSource(g: number, s: any) { assert.equal(g, 2); assert.equal(s.hash, hash); },
      finalSimForkWaitMs: 0,
      finalSimulationPlanIdentity: { bytesHex: () => "0x1234", resultBytesHex: (r: any) => r.scriptHex },
      passDeadlineAtMs: Date.now() + 5_000,
      solvePipelineSignal: controller.signal,
    };
    const runtime = runInNewContext(js, scope, { timeout: 1000 });
    try {
      const actual = await executeFinalSimulationWork({ intent: { stage: "fork-final-sim", source, generation: 2, resolvedPlan: plan }, runtime });
      assert.equal(actual, result);
      assert.equal(directCalls, direct ? 1 : 0);
      assert.equal(executions, direct ? 0 : 1);
      assert.equal(forkCalls, !direct && nMinusOne ? 1 : 0);
      assert.equal(waits, !direct && !nMinusOne ? 1 : 0);
    } finally { await runtime.close(); }
  });
}

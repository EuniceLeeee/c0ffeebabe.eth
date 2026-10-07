// Opt-in, network-isolated reuse of ONE already published native execution.
// Recomputes current production Exact and calldata; it does not run a new EVM.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { SAMPLES, sourcePin, receiptChecks, botvm } from "./historical-dual.js";
import { POOL, FACTORY } from "../../../venues/swaps/balancer-v1-family/codec.js";
import { concatBytes } from "../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../types.js";
import { buildExecuteCalldata } from "../../../../shared/executor/botvm-executor.js";
import { createStrictCentralAdapterRuntime } from "../../../strict-central-adapter-runtime.js";
import { resolveStrictReadyRuntime } from "../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../universe-rebuild-production.js";
import { assertIssuedPreparedFamilyInstance, executeFamilyExactQuote, buildFamilyExecutionFragment,
  buildFamilyRuntimeAmountLeg, type PreparedFamilyInstance } from "../../../venues/adapter-family-runtime.js";
import { asPricedFamily } from "../../../venues/family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../venues/production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../venues/production-infra-actions.js";
import { planFragmentNodes } from "../../../solver/plan-fragment-requirements.js";
import { same, json, sha } from "../../../venues/protocols/set-redemption-family/test/historical-runtime-observations.js";

const ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const SAMPLE = SAMPLES[26138731], CASE = SAMPLE.cases[0];
// Published in 1fef6a3b, independently reviewed BEFORE this cached test existed.
const REPORT_SHA = "da0d71f9839f93189e886dc5b54183a2c3e8fb8005244d429b9e4eab8260164f";
type Read = { kind: number; to: string; from?: string; data?: string; slot?: string };
function digest(bytes: Buffer | string, expected: string): void {
  assert.match(expected, /^[0-9a-f]{64}$/); assert.equal(sha(bytes), expected, "saved evidence digest");
}
function nativePass(text: string, receipt: any, kind: "reads" | "execute"): void {
  assert.equal(receipt.kind, kind); assert.equal(receipt.code, 0); assert.equal(receipt.signal, null);
  assert.equal(receipt.timedOut, false); assert(!receipt.error);
  const method = kind === "reads" ? "testOriginalStateReads" : "testOriginalRuntimeOutputs";
  const contract = kind === "reads" ? "OriginalStateReadProof" : "OriginalRuntimeOutputProof";
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const tests = clean.split("\n").filter(l => /^\[(?:PASS|FAIL[^\]]*|SKIP)\]/.test(l));
  assert.equal(tests.length, 1); assert(tests[0].startsWith("[PASS] " + method + "() "));
  assert(clean.includes("Suite result: ok. 1 passed; 0 failed; 0 skipped;"));
  assert(new RegExp("^Ran 1 test for .+:" + contract + "$", "m").test(clean));
}
function readBinding(request: any, reply: any, fixture: any, requestBytes: Buffer): void {
  assert.equal(request.fixtureSha256, "0x" + sha(JSON.stringify(fixture)));
  assert.equal(request.tx, SAMPLE.tx); assert.equal(request.block, 26138731);
  assert.equal(fixture.tx, request.tx); assert.equal(fixture.block, request.block);
  assert.equal(request.leg, 0); assert.equal(request.prefixCount, 0); assert.deepEqual(request.prefixCalls, []);
  assert.equal(request.count, request.requests.length); assert(request.count > 0 && request.count <= 64);
  assert.equal(reply.requestSha256, "0x" + sha(requestBytes));
  assert.equal(reply.count, request.count); assert.equal(reply.results.length, request.count);
  for (const r of reply.results) { assert.equal(typeof r.ok, "boolean"); assert(ethers.isHexString(r.data)); }
}
function readerBinding(reader: string, originalHash: string): void {
  // Authenticate the final verifier too: a matching message alone cannot bind its predicate.
  digest(reader, "cdce9764f536842bbafe38674a43558515d22f224cf641ad28cb7873dca65f36");
  const oldReader = reader.split("\n").filter(l => !l.includes('"canonical fixture tx"') && !l.includes('"canonical fixture block"')).join("\n");
  assert.equal(reader.split("\n").length - oldReader.split("\n").length, 2);
  digest(oldReader, originalHash);
}


test("current V1 Exact and both encoders match authenticated original native evidence, with no RPC", async () => {
  const arg = process.env.FAMILY_V1_SAVED_NATIVE_REPORT; assert(arg, "explicit saved report required");
  const seen = new Map<string, string>();
  const bound = (p: string, hash: string): Buffer => {
    const actual = realpathSync(p); assert(actual.startsWith(realpathSync(resolve(ROOT, "logs")) + sep));
    const bytes = readFileSync(actual); digest(bytes, hash); seen.set(actual, hash); return bytes;
  };
  const parsed = (p: string, hash: string): any => JSON.parse(bound(p, hash).toString());
  const report = parsed(arg, REPORT_SHA), pin = sourcePin();
  assert.equal(report.status, "pass"); assert.equal(report.inputsUnchanged, true);
  assert.equal(report.block, 26138731); assert.equal(report.tx, SAMPLE.tx);
  assert.equal(report.originalV1BindingChecked, true); assert.equal(report.runCount, 4); assert.equal(report.readCount, 12);
  assert.equal(report.reads.length, 3); assert.equal(report.quotes.length, 1); assert.deepEqual(report.sourcePin, pin);
  const fixture = parsed(report.fixture, report.fixtureSha256);
  assert.deepEqual(fixture.sourcePin, pin); assert.equal(fixture.block, report.block); assert.equal(fixture.tx, SAMPLE.tx);
  assert.equal(fixture.eventCount, 1); assert.equal(fixture.programs.length, 1);
  assert.equal(sha(JSON.stringify(fixture)), report.transportPayloadSha256);
  const captured = parsed(fixture.capture.path, fixture.capture.sha256);
  assert.equal(captured.tx, SAMPLE.tx); assert(same(captured.block.hash, SAMPLE.hash));
  assert.equal(Number(BigInt(captured.block.number)), report.block);
  receiptChecks(captured.receipt, SAMPLE, report.block);
  const canonical = JSON.stringify({ tx: captured.tx, block: { number: captured.block.number, timestamp: captured.block.timestamp,
    baseFeePerGas: captured.block.baseFeePerGas, gasLimit: captured.block.gasLimit, miner: captured.block.miner,
    mixHash: captured.block.mixHash }, prestate: captured.prestate });
  assert.equal(fixture.canonicalPayloadSha256, "0x" + sha(canonical));
  // The old reader differs ONLY by these two additional cross-binding assertions.
  // Their predicates are checked above against the complete authenticated payload.
  const reader = readFileSync(new URL("original-reads.t.sol", import.meta.url), "utf8");
  readerBinding(reader, report.testPin["original-reads.t.sol"]);
  for (const file of ["original-runtime.t.sol", "original-prestate.t.sol"])
    digest(readFileSync(new URL(file, import.meta.url)), report.testPin[file]);
  const batches = report.reads.map((entry: any) => {
    assert.equal(entry.leg, 0);
    const bytes = bound(entry.requestPath, entry.requestSha256), request = JSON.parse(bytes.toString());
    const reply = parsed(entry.replyPath, entry.replySha256);
    readBinding(request, reply, fixture, bytes);
    const log = bound(entry.receipt.log, entry.receipt.logSha256).toString(); nativePass(log, entry.receipt, "reads");
    assert(log.includes("fixture payload sha256: 0x" + report.transportPayloadSha256));
    assert(log.includes("native reads returned: " + request.count));
    assert(log.includes("preceding legs executed: 0"));
    return { request, reply };
  });
  assert.deepEqual(batches.map((b: any) => b.request.count), [9, 2, 1]);
  const quoted = parsed(report.quotedFixture.path, report.quotedFixture.sha256);
  const { claim: _claim, calldata: _data, scriptHash: _script, quoteProof, ...rest } = quoted;
  const { claim: _oldClaim, calldata: _oldData, scriptHash: _oldScript, ...base } = fixture;
  assert.deepEqual(rest, base); assert.deepEqual(quoteProof.quotes, report.quotes); assert.deepEqual(quoteProof.reads, report.reads);
  const execution = bound(report.execution.log, report.execution.logSha256).toString(); nativePass(execution, report.execution, "execute");
  assert(execution.includes("original output leg 0: " + CASE.amountOut));
  assert(execution.includes("original legs matched: 1")); assert(execution.includes("terminal output: " + CASE.amountOut));
  bound(fixture.ready.path, fixture.ready.sha256);
  const envelope = await new UniverseRebuildCheckpointStore({ path: fixture.ready.path }).load();
  assert(envelope && !envelope.inProgressRun);
  const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
  assert.equal(source.number, report.block); assert(same(source.hash, SAMPLE.hash));
  assert.equal(ready.universeRange.fromBlock, report.block); assert.equal(ready.universeRange.toBlock, report.block);
  const family = asPricedFamily(catalog.forStrictFamily(CASE.family as any));
  const memos = activeReadyMemos(envelope).filter(m => m.familyId === CASE.family && m.instanceKey === CASE.instance);
  assert.equal(memos.length, 1); const memo = memos[0];
  assert([familyDefinitionHash(CASE.family), familyMemoDefinitionHash(CASE.family)].includes(memo.familyDefinitionHash));
  const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [CASE.family],
    executionIdentity: { executor: fixture.executor, transactionOrigin: fixture.owner } });
  const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
  assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
  assert.equal(graph.filter(e => e.instanceKey === CASE.instance).length, CASE.directions);
  const routes = instance.routes.filter(r => same(r.tokenIn, CASE.tokenIn) && same(r.tokenOut, CASE.tokenOut)); assert.equal(routes.length, 1);
  const handles = instance.routeHandles.filter(h => h.routeKey === routes[0].routeKey); assert.equal(handles.length, 1);
  const d = instance.descriptor as any;
  const functions = [["isFinalized", []], ["isPublicSwap", []], ["getFinalTokens", []], ["getSwapFee", []],
    ...d.tokens.map((t: string) => ["getDenormalizedWeight", [t]])] as [string, unknown[]][];
  const bindingRequests: Read[] = [...functions.map(([fn, args]) => ({ kind: 0, to: d.pool, from: ethers.ZeroAddress,
    data: POOL.encodeFunctionData(fn, args) })), { kind: 1, to: d.pool }, { kind: 1, to: d.factory },
    { kind: 0, to: d.factory, from: ethers.ZeroAddress, data: FACTORY.encodeFunctionData("isBPool", [d.pool]) }];
  assert.deepEqual(bindingRequests, batches[0].request.requests);
  assert(batches[0].reply.results.every((r: any) => r.ok));
  const data = batches[0].reply.results.map((r: any) => r.data);
  const values = functions.map(([fn], i) => POOL.decodeFunctionResult(fn, data[i])[0]);
  assert.equal(values[0], true); assert.equal(values[1], true);
  assert.deepEqual([...values[2]].map(t => String(t).toLowerCase()), d.tokens.map((t: string) => t.toLowerCase()));
  assert.equal(values[3], d.swapFee); assert.deepEqual(values.slice(4), d.weights);
  assert.equal(ethers.keccak256(data[functions.length]), d.poolCodeHash);
  assert.equal(ethers.keccak256(data[functions.length + 1]), d.factoryCodeHash);
  assert.equal(FACTORY.decodeFunctionResult("isBPool", data.at(-1)!)[0], true);
  const reads = batches.slice(1).flatMap((b: any) => b.request.requests.map((request: Read, i: number) => ({ request, reply: b.reply.results[i] })));
  let cursor = 0, forbidden = 0;
  const read = async (request: Read, block?: number): Promise<string> => {
    assert.equal(block, source.number); assert(cursor < reads.length, "unexpected uncached read");
    const saved = reads[cursor++]; assert.deepEqual(request, saved.request, "production read differs from native proof");
    assert.equal(saved.reply.ok, true); return saved.reply.data;
  };
  const runtime = createStrictCentralAdapterRuntime({ executor: fixture.executor, transactionOrigin: fixture.owner,
    generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } },
    provider: { call: (t, b) => read({ kind: 0, to: t.to, from: t.from ?? ethers.ZeroAddress, data: t.data }, b),
      getCode: (to, b) => read({ kind: 1, to }, b), getStorage: (to, slot, b) => read({ kind: 2, to, slot }, b) } });
  const quote = await executeFamilyExactQuote({ family, route: handles[0], amountIn: CASE.amountIn, source,
    generation: source.generation, executor: fixture.executor, runtimeEvidence: [], runtime,
    control: { signal: AbortSignal.timeout(10000), deadlineAtMs: Date.now() + 10000 } });
  assert.equal(quote.status, "resolved", json(quote)); assert(quote.status === "resolved");
  assert.equal(cursor, reads.length); assert.equal(quote.amountIn, CASE.amountIn); assert.equal(quote.amountOut, CASE.amountOut);
  assert.deepEqual(quote.source, source);
  const fragment = buildFamilyExecutionFragment({ family, route: handles[0], exact: quote, minAmountOut: quote.amountOut,
    executor: fixture.executor, runtimeEvidence: [], actionOwnership: catalog });
  assert.equal(fragment.status, "resolved"); assert(fragment.status === "resolved");
  const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
  const encode = (n: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === n.adapterId); assert(a);
    return a.encode(n, fixture.executor, concatBytes(...n.children.map(encode))); };
  const script = concatBytes(...planFragmentNodes(fragment.fragment, CASE.tokenIn, CASE.amountIn).map(encode));
  assert.equal(buildExecuteCalldata(script), quoted.calldata); assert.equal(ethers.keccak256(script), quoted.scriptHash);
  assert.equal(ethers.keccak256(script), report.quotes[0].quotedScriptHash);
  const guarded = new Proxy(runtime, { get(target, p, receiver) {
    if (!["callerAuthority", "generationFence"].includes(String(p))) { forbidden++; throw Error("runtime construction read"); }
    return Reflect.get(target, p, receiver);
  } });
  const leg = buildFamilyRuntimeAmountLeg({ family, route: handles[0], source, runtime: guarded,
    executor: fixture.executor, runtimeEvidence: [], actionOwnership: catalog });
  assert(leg); assert.equal(leg.program, fixture.programs[0].program); assert.equal(forbidden, 0);
  assert.equal(botvm(fixture.owner).code, fixture.runtimeCode);
  assert.deepEqual(sourcePin(), pin); for (const [p, h] of seen) digest(readFileSync(p), h);
});

test("saved evidence rejects changed bytes and malformed digests", () => {
  const bytes = Buffer.from("bound evidence"), hash = sha(bytes); digest(bytes, hash);
  assert.throws(() => digest(Buffer.concat([bytes, Buffer.from(" ")]), hash));
  assert.throws(() => digest(bytes, "0"));
});
test("native verdict rejects absent, skipped, duplicate, wrong-target and failed executions", () => {
  const receipt = { kind: "reads", code: 0, signal: null, timedOut: false };
  const good = "Ran 1 test for source:OriginalStateReadProof\n[PASS] testOriginalStateReads() (gas: 1)\nSuite result: ok. 1 passed; 0 failed; 0 skipped;";
  nativePass(good, receipt, "reads");
  for (const bad of ["", good.replace("[PASS]", "[SKIP]"), good + "\n[PASS] testOriginalStateReads() (gas: 1)",
    good.replace("OriginalStateReadProof", "Foreign"), good.replace("testOriginalStateReads", "other"),
    good.replace("0 failed", "1 failed")]) assert.throws(() => nativePass(bad, receipt, "reads"));
  assert.throws(() => nativePass(good, { ...receipt, code: 1 }, "reads"));
  assert.throws(() => nativePass(good, { ...receipt, timedOut: true }, "reads"));
});
test("saved read binding rejects foreign transaction, block, prefix, fixture and reply", () => {
  const fixture = { tx: SAMPLE.tx, block: 26138731 };
  const request = { fixtureSha256: "0x" + sha(JSON.stringify(fixture)), tx: SAMPLE.tx, block: 26138731,
    leg: 0, prefixCount: 0, prefixCalls: [], count: 1, requests: [{ kind: 1, to: CASE.pool }] };
  const bytes = Buffer.from(JSON.stringify(request));
  const reply = { requestSha256: "0x" + sha(bytes), count: 1, results: [{ ok: true, data: "0x" }] };
  readBinding(request, reply, fixture, bytes);
  for (const change of [{ tx: ethers.ZeroHash }, { block: 1 }, { leg: 1 }, { prefixCount: 1 },
    { prefixCalls: ["0x"] }, { fixtureSha256: ethers.ZeroHash }, { count: 2 }])
    assert.throws(() => readBinding({ ...request, ...change }, reply, fixture, bytes));
  assert.throws(() => readBinding(request, { ...reply, requestSha256: ethers.ZeroHash }, fixture, bytes));
  assert.throws(() => readBinding(request, { ...reply, results: [] }, fixture, bytes));
});
test("native reader rejects different predicates hidden behind the same assertion messages", () => {
  const reader = readFileSync(new URL("original-reads.t.sol", import.meta.url), "utf8");
  const oldHash = "13c264a1bcd04f30007597622e22da93b4c3a26e24a478a9daa073bf368c8caf";
  readerBinding(reader, oldHash);
  for (const label of ["canonical fixture tx", "canonical fixture block"]) {
    const bad = reader.split("\n").map(l => l.includes('"' + label + '"') ? '        require(false,"' + label + '");' : l).join("\n");
    assert.notEqual(bad, reader);
    assert.throws(() => readerBinding(bad, oldHash), /saved evidence digest/);
  }
});

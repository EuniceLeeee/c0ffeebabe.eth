import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface, JsonRpcProvider, Network, toBeHex } from "ethers";
import { transactionSelectorCensus, canonicalExecutionCall } from "./family-transaction-selector.js";
import { prepareFamilyReady } from "./family-json-ready.js";
import { RebuildReadProvider } from "../rebuild-read-provider.js";
import { activeReadyMemos } from "../universe-rebuild-checkpoint.js";
import { selectorReadyFamilyIds } from "../universe-rebuild-production.js";
import type { ReadyTransactionEvidence } from "../ready-transaction-input.js";

const a = (n: number) => toBeHex(n, 20), h = (n: number) => toBeHex(n, 32);
const source = { number: 100, hash: h(100) }, target = a(10), inputToken = a(11), outputToken = a(12), actor = a(20), owner = a(21);
const ABI = new Interface(["function sellGem(address,uint256)", "function gem() view returns(address)",
  "function dai() view returns(address)", "function to18ConversionFactor() view returns(uint256)"]);
const data = ABI.encodeFunctionData("sellGem", [owner, 17n]);
function evidence(): ReadyTransactionEvidence {
  return { method: "debug_traceTransaction", receipt: { transactionHash: h(101), blockNumber: source.number,
    blockHash: source.hash, transactionIndex: 0, status: 1, logs: [] }, rawTrace: {
    type: "CALL", from: owner, to: a(90), input: "0xdeadbabe", value: "0x0", gas: "0xffff", output: "0x", gasUsed: "0x1",
    calls: [{ type: "CALL", from: owner, to: target, input: data, value: "0x0", gas: "0xffff", output: "0x", gasUsed: "0x1" },
      { type: "CALL", from: owner, to: a(91), input: "0xabcdef01", value: "0x0", gas: "0xffff", output: "0x", gasUsed: "0x1" }],
  } };
}

test("historical diagnostic census keeps every unknown call and reverted subtree without inventing coverage", () => {
  const raw = evidence(), call = (raw.rawTrace as any).calls[0];
  call.error = "execution reverted";
  call.calls = [{ type: "CALL", from: target, to: a(92), input: "0x12345678", value: "0x0", output: "0x", gas: "0xffff", gasUsed: "0x1" }];
  const census = transactionSelectorCensus(raw);
  assert.equal(census.calls.length, 4);
  assert.equal(census.calls.find(c => c.selector === "0x12345678")!.executionStatus, "reverted");
  assert.equal(census.calls.find(c => c.selector === "0xabcdef01")!.executionStatus, "success");
  assert.equal(census.coverage.allInternalCallsEnumerated, false);
  assert.equal(census.calls.find(c => c.target === target)!.params, "0x" + data.slice(10));
});

test("execution ABI rejects malformed/trailing arguments and a foreign target", () => {
  const signature = "function sellGem(address,uint256)";
  assert.equal(canonicalExecutionCall(signature, target, { target, data }), true);
  for (const bad of [data.slice(0, -2), data + "00", data.slice(0, 10), "0xdeadbabe" + data.slice(10)])
    assert.equal(canonicalExecutionCall(signature, target, { target, data: bad }), false);
  assert.equal(canonicalExecutionCall(signature, target, { target: a(99), data }), false);
});

test("actual Ready preparation uses full active selector scope, retains unknowns and reuses across old labels", async t => {
  const directory = mkdtempSync(join(tmpdir(), "facts-selector-ready-")), raw = evidence();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const priorCache = process.env.SEARCHER_FAMILY_FACT_CACHE_DIR;
  process.env.SEARCHER_FAMILY_FACT_CACHE_DIR = join(directory, "cache");
  t.after(() => { if (priorCache === undefined) delete process.env.SEARCHER_FAMILY_FACT_CACHE_DIR;
    else process.env.SEARCHER_FAMILY_FACT_CACHE_DIR = priorCache; });
  const rpcFile = join(directory, "rpc.json"); writeFileSync(rpcFile, JSON.stringify({ MAINNET_RPC_URL: "http://127.0.0.1:1" }));
  const reads: string[] = [];
  t.mock.method(JsonRpcProvider.prototype, "send", async (method: string) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: source.hash };
    if (method === "eth_getTransactionReceipt") return { ...raw.receipt, blockNumber: "0x64", status: "0x1", transactionIndex: "0x0" };
    if (method === "debug_traceTransaction") return raw.rawTrace;
    assert.fail("unexpected diagnostic RPC " + method);
  });
  t.mock.method(RebuildReadProvider.prototype, "getNetwork", async () => Network.from(1));
  t.mock.method(RebuildReadProvider.prototype, "getBlock", async (number: number) => { assert.equal(Number(number), source.number); return source; });
  t.mock.method(RebuildReadProvider.prototype, "getCode", async () => { reads.push("code"); return "0x60016000"; });
  const readCall = (tx: any) => {
    const parsed = ABI.parseTransaction(tx); assert(parsed);
    const value = parsed.name === "gem" ? inputToken : parsed.name === "dai" ? outputToken
      : parsed.name === "to18ConversionFactor" ? 10n ** 12n : assert.fail("Ready tried execution/current-price read " + parsed.name);
    return ABI.encodeFunctionResult(parsed.fragment, [value]);
  };
  t.mock.method(RebuildReadProvider.prototype, "send", async (method: string, params: any[]) => {
    reads.push(method); assert.equal(method, "eth_call"); return readCall(params[0]);
  });
  const header = { number: "0x64", hash: source.hash, parentHash: h(99), stateRoot: h(102), timestamp: "0x3e8", gasLimit: "0x2625a00" };
  t.mock.method(RebuildReadProvider.prototype, "sendControlled", async (method: string, params: readonly any[]) => {
    if (method === "eth_getBlockByHash" || method === "eth_getBlockByNumber") return header;
    assert.equal(method, "eth_simulateV1", "Ready must not acquire any trace or execution proof");
    const blocks = params[0].blockStateCalls; assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].stateOverrides, {}, "metadata reads cannot prepare execution funding");
    reads.push("virtual-block-metadata-read");
    return [{ parentHash: source.hash, number: "0x65", timestamp: "0x3f4", gasLimit: header.gasLimit, baseFeePerGas: "0x0",
      calls: blocks[0].calls.map((call: any) => ({ status: "0x1", returnData: readCall(call), gasUsed: "0x5208", logs: [] })) }];
  });
  t.mock.method(RebuildReadProvider.prototype, "getStorage", async () => { reads.push("upgrade-code-binding"); return h(0); });
  for (const method of ["getLogs", "getTransaction", "getTransactionReceipt", "_send"] as const)
    t.mock.method(RebuildReadProvider.prototype, method, async () => assert.fail("unexpected Ready identity/trace RPC " + method));
  const run = (familyId: string, instanceKey: string, out: string) => prepareFamilyReady({ familyId, domain: "protocol", source,
    executor: actor, owner, rpcFile, out, target: { transactionHash: h(101), instanceKey }, executorCodeMode: "deployed", simulationMethod: "eth_simulateV1" });
  const out = join(directory, "first.json"), first = await run("old:wrong-label", target, out);
  const manifest = JSON.parse(readFileSync(out + ".request.json", "utf8"));
  assert.deepEqual(manifest.familyIds, selectorReadyFamilyIds());
  assert(manifest.familyIds.length > 2, "must not reduce discovery to the target family");
  const memos = activeReadyMemos(first);
  assert.equal(memos.length, 1, JSON.stringify({ retry: Object.values(first.retryableAttemptsByCandidateKey).map(row => ({ stage: row.stage, reason: row.reasonCode })), reads }));
  assert.match(memos[0]!.familyId, /^execution:0x95991276:abi-/);
  assert(first.readyGeneration!.selectorCoverage!.entries.some(row => row.selector === "0xabcdef01" && row.status === "unverified"));
  assert(first.readyGeneration!.selectorCoverage!.entries.some(row => row.selector === "0x95991276" && row.status === "unverified" &&
    row.reasons.includes("awaiting-startup-simulation")), "Ready binding is not execution verification");
  const count = reads.length;
  const secondOut = join(directory, "second.json"), second = await run("another:old-label", a(99), secondOut);
  assert.equal(reads.length, count, "legacy family/instance labels must not duplicate full-catalog Ready work");
  assert.equal(JSON.parse(readFileSync(secondOut + ".cache.json", "utf8")).status, "reused");
  assert.deepEqual(second.readyGeneration, first.readyGeneration);
  const creditOut = join(directory, "credit-reference.json");
  const creditReference = await prepareFamilyReady({ familyId: "uninstalled:credit-label", domain: "credit", source,
    executor: actor, owner, rpcFile, out: creditOut, target: { transactionHash: h(101), instanceKey: target }, executorCodeMode: "deployed", simulationMethod: "eth_simulateV1" });
  assert.equal(JSON.parse(readFileSync(creditOut + ".request.json", "utf8")).bindingMode, "selector");
  assert.equal(reads.length, count, "Credit reference labels also cannot restrict or duplicate full-selector nominations");
  assert.deepEqual(creditReference.readyGeneration, first.readyGeneration);
});

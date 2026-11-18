import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { createRebuildWiring, observationsFromSelectedTransaction, selectorReadyFamilyIds } from "../universe-rebuild-production.js";
import { discoverTransactionReadyInput } from "./family-json-ready.js";
import { ADDR } from "../../shared/constants/addresses.js";
const PSM_INTERFACE = new ethers.Interface(["function sellGem(address,uint256)"]);
import type { ReadyTransactionEvidence } from "../ready-transaction-input.js";

const A = (n: number) => ethers.toBeHex(n, 20), H = (n: number) => ethers.toBeHex(n, 32);
const source = { number: 25_750_000, hash: H(90), generation: 25_750_000 };
const tx = H(91), familyId = "protocol:psm", target = ADDR.SKY_PSM_LITE.toLowerCase();
function frame(to: string, input: string, traceAddress: number[]) {
  return { type: "call", action: { from: A(1), to, input, callType: "call", gas: "0xffff", value: "0x0" },
    result: { output: "0x", gasUsed: "0x20" }, subtraces: traceAddress.length ? 0 : 3,
    traceAddress, transactionHash: tx, blockNumber: source.number, blockHash: source.hash };
}
function evidence(): ReadyTransactionEvidence {
  const v2 = new ethers.Interface(["function swap(uint256,uint256,address,bytes)"]);
  return { receipt: { transactionHash: tx, blockNumber: source.number, blockHash: source.hash,
    transactionIndex: 0, status: 1, logs: [] }, method: "trace_transaction", rawTrace: [
      frame(A(10), "0x12345678", []),
      frame(target, PSM_INTERFACE.encodeFunctionData("sellGem", [A(1), 17n]), [0]),
      frame(A(11), v2.encodeFunctionData("swap", [0n, 1n, A(1), "0x"]), [1]),
      frame(A(12), "0xdeadbeef", [2]),
    ] };
}

test("selected TX decoder reuses production call semantics and rejects escaped/incomplete evidence", () => {
  const value = evidence(), selector = PSM_INTERFACE.getFunction("sellGem")!.selector;
  const result = observationsFromSelectedTransaction(value, [], new Set([selector]));
  assert.equal(result.calls.length, 1); assert.equal(result.calls[0]!.target, target);
  assert.deepEqual(result.calls[0]!.traceAddress, [0]);
  assert.throws(() => observationsFromSelectedTransaction({ ...value, rawTrace: [] }, [], new Set([selector])), /incomplete/);
  assert.throws(() => observationsFromSelectedTransaction({ ...value,
    rawTrace: (value.rawTrace as any[]).map(row => ({ ...row, transactionHash: H(92) })) }, [], new Set([selector])), /escaped/);
  assert.throws(() => observationsFromSelectedTransaction({ ...value,
    receipt: { ...value.receipt, status: 0 } }, [], new Set([selector])), /status/);
  const debug = { ...value, method: "debug_traceTransaction" as const,
    rawTrace: { type: "CALL", from: A(1), to: target, input: PSM_INTERFACE.encodeFunctionData("sellGem", [A(1), 17n]), output: "0x" } };
  assert.equal(observationsFromSelectedTransaction(debug, [], new Set([selector])).calls.length, 1);
  assert.throws(() => observationsFromSelectedTransaction({ ...debug, rawTrace: { result: {} } }, [], new Set([selector])), /schema/);
});

test("facts discovery shares all selector nominations and TX evidence across labels and execution states", async () => {
  const directory = await mkdtemp(join(tmpdir(), "family-tx-ready-"));
  const original = ethers.JsonRpcProvider.prototype.send, calls: string[] = [];
  const value = evidence(), frames = value.rawTrace as any[];
  const debug = { type: "CALL", ...frames[0].action, output: "0x", logs: [], calls: frames.slice(1).map(row => ({
    type: "CALL", ...row.action, output: "0x", logs: [],
  })) };
  ethers.JsonRpcProvider.prototype.send = async (method: string) => {
    calls.push(method);
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return { number: ethers.toQuantity(source.number), hash: source.hash };
    if (method === "eth_getTransactionReceipt") return { ...value.receipt, status: "0x1", transactionIndex: "0x0",
      blockNumber: ethers.toQuantity(source.number) };
    if (method === "debug_traceTransaction") return debug;
    throw new Error("unexpected extra RPC: " + method);
  };
  try {
    const familyIds = selectorReadyFamilyIds();
    const production = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds, selectorCensus: [],
      executionIdentity: { executor: A(2), transactionOrigin: A(1) } });
    const withObservation = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds, selectorCensus: [],
      executionIdentity: { executor: A(2), transactionOrigin: A(1) },
      testTransactionObservation: { transactionHash: tx, source } });
    assert.notEqual(withObservation.readyReviewInputFingerprint!(), production.readyReviewInputFingerprint!());
    assert.equal(withObservation.readyDiscoveryInputFingerprint!(), production.readyDiscoveryInputFingerprint!());
    const wiring = { ...production, scanSwapWindow: async () => assert.fail("supplied TX must not scan a whole block"),
      reverseBindOpaqueCandidates: async () => assert.fail("selector discovery must not infer old identity") };
    const input = { wiring, directory, rpcUrl: "http://127.0.0.1:1", familyIds,
      target: { transactionHash: tx, instanceKey: target }, source };
    const first = await discoverTransactionReadyInput(input);
    assert.equal(new Set(first.candidates.map(candidate => candidate.familyId)).size, 2, "the selected TX nominates both execution selectors and every binding recipe");
    assert(first.candidates.length >= 2);
    assert.equal(new Set(first.candidates.map(candidate => production.familyCandidateKey(candidate))).size, first.candidates.length);
    assert(first.candidates.some(candidate => candidate.address === target && String(candidate.familyId).startsWith("execution:0x95991276:")));
    assert(first.candidates.some(candidate => candidate.address === A(11) && String(candidate.familyId).startsWith("execution:0x022c0d9f:")));
    assert(first.census.calls.some(call => call.selector === "0xdeadbeef" && call.status === "unverified"));
    assert.deepEqual([...first.currentCandidateKeys].sort(), first.candidates.map(c => production.familyCandidateKey(c)).sort());
    assert.equal(first.evidence.identityBypass, false);
    const second = await discoverTransactionReadyInput({ ...input, target: { ...input.target, instanceKey: A(99) } });
    assert.equal(second.currentInputFingerprint, first.currentInputFingerprint, "reference instance cannot change a full-selector nomination set");
    assert.equal(calls.filter(method => method === "eth_getTransactionReceipt").length, 1);
    assert.equal(calls.filter(method => method === "debug_traceTransaction").length, 1);
    const parentSource = { number: source.number - 1, hash: H(89), generation: source.generation };
    const selected = await discoverTransactionReadyInput({ ...input, source: parentSource,
      target: { ...input.target, stateSelection: { mode: "parent", evidenceSource: { number: source.number, hash: source.hash },
        executionSource: { number: parentSource.number, hash: parentSource.hash },
        evidenceHeader: { number: ethers.toQuantity(source.number), hash: source.hash, parentHash: parentSource.hash } } } });
    assert.equal(selected.census.blockNumber, source.number, "historical observation never becomes parent activity");
    assert.notEqual(selected.currentInputFingerprint, first.currentInputFingerprint, "different execution state cannot reuse Ready");
    assert.equal(calls.filter(method => method === "eth_getTransactionReceipt").length, 1);
    assert.equal(selected.candidates.length, first.candidates.length);
  } finally {
    ethers.JsonRpcProvider.prototype.send = original;
    await rm(directory, { recursive: true, force: true });
  }
});

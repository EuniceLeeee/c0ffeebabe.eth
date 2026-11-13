import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { ReadyActivityArchive } from "../ready-activity-archive.js";
import { createRebuildWiring, observationsFromSelectedTransaction } from "../universe-rebuild-production.js";
import { discoverTransactionReadyInput } from "./family-json-ready.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { PSM_INTERFACE } from "../venues/protocols/psm-family/codec.js";
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

test("facts discovery reads the whole TX through the Ready reader, selects target Family, and shares raw block trace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "family-tx-ready-"));
  const archive = new ReadyActivityArchive({ directory: join(directory, "raw"), chainId: 1,
    fromBlock: source.number, toBlock: source.number, cutoffHash: source.hash });
  const original = ethers.JsonRpcProvider.prototype.send, calls: string[] = [];
  const value = evidence();
  ethers.JsonRpcProvider.prototype.send = async (method: string) => {
    calls.push(method);
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return { number: ethers.toQuantity(source.number), hash: source.hash };
    if (method === "eth_getTransactionReceipt") return { ...value.receipt, status: "0x1", transactionIndex: "0x0",
      blockNumber: ethers.toQuantity(source.number) };
    throw new Error("unexpected extra RPC: " + method);
  };
  try {
    await archive.writeTrace({ blockNumber: source.number, method: "trace_block", trace: value.rawTrace as unknown[] });
    const production = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [familyId],
      executionIdentity: { executor: A(2), transactionOrigin: A(1) } });
    let scans = 0;
    const wiring = { ...production, scanSwapWindow: async () => { scans++; return { observations: [], sourceReceipts: [] }; } };
    const input = { wiring, activityArchive: archive, directory, rpcUrl: "http://127.0.0.1:1", familyId,
      target: { transactionHash: tx, instanceKey: target }, source };
    const first = await discoverTransactionReadyInput(input);
    assert(first.evidence.recognizedFamilies.includes("univ2-standard"), "other TX pools are discovered");
    assert(first.evidence.recognizedFamilies.includes(familyId));
    assert.equal(first.candidates.length, 1, "other Family/unknown pools do not become target acceptance requirements");
    assert.equal(first.candidates[0]!.address, target);
    assert.equal(first.candidates[0]!.familyId, familyId);
    assert.deepEqual([...first.currentCandidateKeys], first.candidates.map(c => production.familyCandidateKey(c)));
    assert.equal(first.evidence.identityBypass, false);
    const second = await discoverTransactionReadyInput(input);
    assert.equal(second.currentInputFingerprint, first.currentInputFingerprint);
    assert.equal(calls.filter(method => method === "eth_getTransactionReceipt").length, 1, "receipt is shared");
    assert(calls.every(method => !/trace/i.test(method)), "trace comes from the shared block archive, never another RPC");
    assert.equal(scans, 2);
    await assert.rejects(discoverTransactionReadyInput({ ...input, familyId: "protocol:rocksolid",
      wiring: { ...wiring, dedupeFamilyCandidates: production.dedupeFamilyCandidates } }), /no candidate/);
  } finally {
    ethers.JsonRpcProvider.prototype.send = original;
    await rm(directory, { recursive: true, force: true });
  }
});

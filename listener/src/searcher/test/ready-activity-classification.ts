import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { ReadyActivityArchive, type ReadyActivityTraceMethod } from "../ready-activity-archive.js";
import { RebuildReadProvider } from "../rebuild-read-provider.js";
import { canonicalJson } from "../universe-rebuild-checkpoint.js";
import {
  ARCHIVE_ACTIVITY_CONCURRENCY, candidatesFromCall, candidatesFromLog, createRebuildWiring,
  type RebuildCallObservation, type RebuildScanObservation,
} from "../universe-rebuild-production.js";
import { WSTETH_INTERFACE } from "../venues/protocols/wsteth-family/codec.js";
import { PSM_INTERFACE } from "../venues/protocols/psm-family/codec.js";

const fromBlock = 25_750_000;
const blockCount = ARCHIVE_ACTIVITY_CONCURRENCY * 2 + 1;
const toBlock = fromBlock + blockCount - 1;
const cutoff = { number: toBlock, hash: "0x" + "a1".repeat(32), generation: toBlock };
const sender = "0x" + "ab".repeat(20);
const options = { rpcUrl: "https://offline.invalid", executionIdentity: { executor: sender, transactionOrigin: sender } };
const log: RebuildScanObservation = { address: "0x" + "11".repeat(20),
  topics: [ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)")], data: "0x",
  blockNumber: fromBlock, blockHash: cutoff.hash, transactionHash: "0x" + "cc".repeat(32), logIndex: 0 };
const baseCall: RebuildCallObservation = { kind: "call", target: ADDR.WSTETH.toLowerCase(),
  data: WSTETH_INTERFACE.encodeFunctionData("wrap", [1n]), sender,
  transactionHash: "0x" + "cd".repeat(32), blockNumber: fromBlock, blockHash: cutoff.hash, traceAddress: [0] };
const psmCall: RebuildCallObservation = { ...baseCall, target: ADDR.SKY_PSM_LITE.toLowerCase(),
  data: PSM_INTERFACE.encodeFunctionData("sellGem", [sender, 1n]), traceAddress: [2] };
const logId = String(candidatesFromLog(log)[0]!.familyId);
const callId = String(candidatesFromCall(baseCall)[0]!.familyId);
const otherId = String(candidatesFromCall(psmCall)[0]!.familyId);
const families = [logId, callId];
const input = { fromBlock, cutoff };

function calls(blockNumber: number): RebuildCallObservation[] {
  // Same-instance evidence repeated both within and across blocks. The selected
  // representative must stay exactly the same after per-block compaction.
  return [baseCall, { ...baseCall, traceAddress: [1], data: WSTETH_INTERFACE.encodeFunctionData("wrap", [2n]) }, psmCall]
    .map(call => ({ ...call, blockNumber }));
}

async function fixture(method: ReadyActivityTraceMethod, run: (archive: ReadyActivityArchive, fresh: () => ReadyActivityArchive) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ready-classification-test-"));
  const archiveOptions = { directory: join(root, "raw"), chainId: 1, fromBlock, toBlock, cutoffHash: cutoff.hash };
  const fresh = () => new ReadyActivityArchive(archiveOptions);
  const archive = fresh();
  try {
    for (let start = fromBlock; start <= toBlock; start += 32) {
      await archive.writeLogs({ fromBlock: start, toBlock: Math.min(start + 31, toBlock),
        logs: start === fromBlock ? [{ ...log, logIndex: "0x0", blockNumber: ethers.toQuantity(fromBlock) }] : [] });
    }
    for (let block = fromBlock; block <= toBlock; block++) {
      const blockCalls = calls(block);
      const trace = method === "trace_block" ? blockCalls.map(call => ({ type: "call",
        action: { callType: "call", to: call.target, from: sender, input: call.data },
        result: { gasUsed: "0x10", output: "0x" }, subtraces: 0, blockNumber: block,
        blockHash: cutoff.hash, transactionHash: call.transactionHash, traceAddress: call.traceAddress,
      })) : [{ txHash: baseCall.transactionHash, result: { type: "CALL", from: sender, to: sender,
        input: "0x12345678", output: "0x", calls: blockCalls.map(call => ({ type: "CALL", from: sender,
          to: call.target, input: call.data, output: "0x" })) } }];
      await archive.writeTrace({ blockNumber: block, method, trace });
    }
    await run(archive, fresh);
  } finally { mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
}

function offlineTransport(): void {
  mock.method(RebuildReadProvider.prototype, "send", async () => { assert.fail("complete legacy raw archive needs no RPC"); });
  mock.method(RebuildReadProvider.prototype, "getLogs", async () => { assert.fail("no filtered RPC"); });
  mock.method(RebuildReadProvider.prototype, "getBlock", async (block: number) => ({ number: block, hash: cutoff.hash }));
}

function expectedActivityHash(prefix: string): string {
  const hash = createHash("sha256").update(prefix);
  hash.update(canonicalJson({ kind: "log", ...log })).update("\0");
  for (let block = fromBlock; block <= toBlock; block++) {
    for (const call of calls(block).slice(0, 2)) hash.update(canonicalJson(call)).update("\0");
  }
  return hash.digest("hex");
}

for (const method of ["trace_block", "debug_traceBlockByNumber"] as const) {
  test(`legacy archive → cold classification → fresh-reader cache parity (${method})`, async () => fixture(method, async (archive, fresh) => {
    offlineTransport();
    const wiring = createRebuildWiring({ ...options, familyIds: families, activityArchive: archive });
    const cold = await wiring.scanSwapWindow(input);
    assert.equal(cold.sourceReceipts[1].observationSetHash, expectedActivityHash("catalog-activity-observations-v1:"));
    assert.equal(cold.sourceReceipts[1].completedChunks[0].resultHash, expectedActivityHash("catalog-activity-chunk-v1:"));
    assert.equal(cold.sourceReceipts[1].completedChunks[0].resultCount, 1 + 2 * blockCount);
    assert.deepEqual(cold.observations, [log, { ...baseCall, blockNumber: toBlock }]);
    const logRead = mock.method(ReadyActivityArchive.prototype, "readLogs", async () => { assert.fail("warm cache must skip raw log decode"); });
    const originalRead = ReadyActivityArchive.prototype.readTrace;
    const traceRead = mock.method(ReadyActivityArchive.prototype, "readTrace", async function (this: ReadyActivityArchive, key) {
      // Method selection may stat a missing alternate transport, but must never
      // decode any populated raw entry on a persistent classification hit.
      if (key.method !== method) return originalRead.call(this, key);
      assert.fail("warm cache must skip raw trace decode");
    });
    const headers = mock.method(RebuildReadProvider.prototype, "getBlock", async () => { assert.fail("warm debug trace already bound to block hash"); });
    const warm = await createRebuildWiring({ ...options, familyIds: families, activityArchive: fresh() }).scanSwapWindow(input);
    assert.deepEqual(warm, cold, "candidate representatives and every source receipt remain byte-equivalent");
    assert.deepEqual(wiring.dedupeFamilyCandidates(warm.observations), wiring.dedupeFamilyCandidates(cold.observations));
    logRead.mock.restore(); traceRead.mock.restore(); headers.mock.restore();

    // Scope change must classify previously unrelated raw frames, never reuse the
    // subset as complete coverage. No network needed for the new Family either.
    const newFamily = await createRebuildWiring({ ...options, familyIds: [otherId], activityArchive: fresh() }).scanSwapWindow(input);
    assert.deepEqual(newFamily.observations, [{ ...psmCall, blockNumber: toBlock }]);
    assert.notEqual(newFamily.sourceReceipts[1].queryFingerprint, warm.sourceReceipts[1].queryFingerprint);
  }));
}

test("classification survives interruption before source receipt / strict checkpoint", async () => fixture("trace_block", async (archive, fresh) => {
  offlineTransport();
  const originalWrite = ReadyActivityArchive.prototype.writeClassifiedTrace;
  const completed = new Set<number>();
  const failAt = fromBlock + ARCHIVE_ACTIVITY_CONCURRENCY;
  const writing = mock.method(ReadyActivityArchive.prototype, "writeClassifiedTrace", async function (this: ReadyActivityArchive, key, classifier, data) {
    if (key.blockNumber === failAt) throw new Error("injected interruption before publication");
    await originalWrite.call(this, key, classifier, data);
    completed.add(key.blockNumber);
  });
  await assert.rejects(createRebuildWiring({ ...options, familyIds: families, activityArchive: archive }).scanSwapWindow(input), /injected interruption/);
  assert.equal(completed.size, ARCHIVE_ACTIVITY_CONCURRENCY * 2 - 1, "owned workers drained; each completed block durable");
  writing.mock.restore();
  const originalRead = ReadyActivityArchive.prototype.readTrace;
  const reread: number[] = [];
  mock.method(ReadyActivityArchive.prototype, "readTrace", async function (this: ReadyActivityArchive, key) {
    assert(!completed.has(key.blockNumber), "resume must not decode completed blocks again");
    if (key.method === "trace_block") reread.push(key.blockNumber);
    return originalRead.call(this, key);
  });
  const resumed = await createRebuildWiring({ ...options, familyIds: families, activityArchive: fresh() }).scanSwapWindow(input);
  assert.deepEqual(new Set(reread), new Set([failAt, toBlock]));
  assert.equal(resumed.sourceReceipts[1].observationSetHash, expectedActivityHash("catalog-activity-observations-v1:"));
}));

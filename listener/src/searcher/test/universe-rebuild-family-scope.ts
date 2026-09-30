import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { RebuildReadProvider } from "../rebuild-read-provider.js";
import type { ReadyActivityArchive } from "../ready-activity-archive.js";
import { canonicalJson, type DurableVerifiedMemo, type LegacyDurableVerifiedMemo } from "../universe-rebuild-checkpoint.js";
import {
  candidatesFromCall, candidatesFromLog, createRebuildWiring,
  expectedSourcePlanFingerprints, familyDefinitionHash, familyDiscoveryDefinitionHash,
  strictCatalogActivityPlan, strictCatalogCallPatterns, strictCatalogLogTopics,
  strictCatalogSourceCoverageKeys, strictFamilyDefinitionHashes, strictFamilyDiscoveryDefinitionHashes,
  startupSourcePlanFingerprint, catalogActivitySourcePlanFingerprint,
  SOURCE_SCAN_BATCH_BLOCKS, SOURCE_MIN_CHUNK_BLOCKS, SOURCE_SCAN_CONCURRENCY,
  SOURCE_TRACE_SCAN_CONCURRENCY, SOURCE_TRACE_SCAN_MAX_ATTEMPTS,
  ARCHIVE_ACTIVITY_CONCURRENCY, ARCHIVE_ACTIVITY_ENTRY_BYTES, ARCHIVE_ACTIVITY_RESPONSE_BYTES,
  type RebuildCallObservation, type RebuildScanObservation,
} from "../universe-rebuild-production.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog,
  PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load,
} from "../venues/production-family-composition.js";
import { WSTETH_INTERFACE } from "../venues/protocols/wsteth-family/codec.js";
import { PSM_INTERFACE } from "../venues/protocols/psm-family/codec.js";
import { UNIV4_SWAP_TOPIC } from "../venues/swaps/univ4-abi.js";

// Real production catalog/ABI fixtures. All transport entrances are replaced
// in memory; this suite opens no sockets and starts no simulation process.
const source = { number: 25_750_000, hash: "0x" + "a1".repeat(32), generation: 1 };
const sender = "0x" + "ab".repeat(20);
const options = {
  rpcUrl: "https://offline.invalid",
  executionIdentity: { executor: sender, transactionOrigin: sender },
};
// These transport/resource fixtures intentionally exercise uncached raw reads.
// Persistent classification reuse is covered separately with the real archive.
const classificationMiss = {
  async readClassifiedLogs() { return null; },
  async readClassifiedTrace() { return null; },
  async writeClassifiedLogs() {},
  async writeClassifiedTrace() {},
};
const log: RebuildScanObservation = {
  address: "0x" + "11".repeat(20),
  topics: [ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)")],
  data: "0x", transactionHash: "0x" + "cc".repeat(32),
  blockNumber: source.number, blockHash: source.hash, logIndex: 0,
};
const opaqueLog: RebuildScanObservation = {
  ...log, address: "0x000000000004444c5dc75cb358380d2e3de08a90",
  topics: [UNIV4_SWAP_TOPIC, "0x" + "55".repeat(32)], logIndex: 1,
};
const call: RebuildCallObservation = {
  kind: "call", target: ADDR.WSTETH.toLowerCase(),
  data: WSTETH_INTERFACE.encodeFunctionData("wrap", [1n]), sender,
  transactionHash: "0x" + "cd".repeat(32),
  blockNumber: source.number, blockHash: source.hash, traceAddress: [0, 1],
};
const otherCall: RebuildCallObservation = {
  ...call, target: ADDR.SKY_PSM_LITE.toLowerCase(),
  data: PSM_INTERFACE.encodeFunctionData("sellGem", [sender, 1n]), traceAddress: [0, 2],
};
const logCandidate = candidatesFromLog(log)[0]!;
const callCandidate = candidatesFromCall(call)[0]!;
const otherCandidate = candidatesFromCall(otherCall)[0]!;
assert(logCandidate && callCandidate && otherCandidate, "real catalog fixtures must decode");
const logId = String(logCandidate.familyId), callId = String(callCandidate.familyId);
const otherId = String(otherCandidate.familyId);

function hashPlan(payload: unknown): string {
  return createHash("sha256").update("source-plan-v1:" + canonicalJson(payload)).digest("hex");
}

function checkPlans(): void {
  const allIds = catalog.listAll().map(family => String(family.plugin.manifest.familyId)).sort();
  // Preserve the exact pre-scope source-plan payload, including transport policy.
  const coverage = strictCatalogSourceCoverageKeys();
  const plan = strictCatalogActivityPlan();
  const definitions = allIds.map(familyDiscoveryDefinitionHash);
  const legacy = {
    startup: hashPlan({ sourceKind: "startup-candidate-union", coverageKeys: coverage.startup, familyDefinitionHashes: definitions }),
    activity: hashPlan({
      sourceKind: "catalog-activity-union", topics: plan.logTopics,
      callPatterns: plan.callPatterns, coverageKeys: plan.coverageKeys, familyDefinitionHashes: definitions,
      logReadMethod: "eth_getLogs", initialLogChunkBlocks: SOURCE_SCAN_BATCH_BLOCKS,
      minimumLogChunkBlocks: SOURCE_MIN_CHUNK_BLOCKS, maxConcurrentLogChunks: SOURCE_SCAN_CONCURRENCY,
      traceMethods: ["trace_block", "debug_traceBlockByNumber"], traceRpcBatchMaxCount: 1,
      maxConcurrentTraceBlocks: SOURCE_TRACE_SCAN_CONCURRENCY, maxTraceAttemptsPerBlock: SOURCE_TRACE_SCAN_MAX_ATTEMPTS,
    }),
  };
  assert.deepEqual(expectedSourcePlanFingerprints(), legacy);
  assert.deepEqual(createRebuildWiring(options).expectedSourcePlanFingerprints(), legacy);
  const explicitAll = expectedSourcePlanFingerprints(allIds);
  assert.notEqual(explicitAll.startup, legacy.startup, "explicit scope never grants legacy global coverage");
  assert.notEqual(explicitAll.activity, legacy.activity);
  assert.deepEqual(expectedSourcePlanFingerprints([logId, callId]), expectedSourcePlanFingerprints([callId, logId]));
  assert.notEqual(expectedSourcePlanFingerprints([logId]).activity, expectedSourcePlanFingerprints([callId]).activity);

  // Every enabled Family, including funding/credit, follows registry declarations.
  for (const family of catalog.listAll()) {
    const id = String(family.plugin.manifest.familyId);
    const discovery = "discovery" in family.plugin ? family.plugin.discovery : undefined;
    const selected = strictCatalogActivityPlan([id]);
    assert.deepEqual(selected.logTopics, [...new Set((discovery?.logPatterns ?? []).map(pattern => pattern.topic.toLowerCase()))].sort());
    assert(selected.callPatterns.every(pattern => pattern.familyId === id));
    assert.equal(selected.callPatterns.length, discovery?.callPatterns?.length ?? 0);
    assert.deepEqual(strictCatalogSourceCoverageKeys([id]), {
      startup: [id + "|startup-universe"],
      activity: [...new Set([
        ...(discovery?.logPatterns ?? []).map(pattern => id + "|event:" + pattern.id),
        ...(discovery?.callPatterns ?? []).map(pattern => id + "|call:" + pattern.id),
      ])].sort(),
    });
    assert.deepEqual(strictFamilyDefinitionHashes([id]), [familyDefinitionHash(id)]);
    assert.deepEqual(strictFamilyDiscoveryDefinitionHashes([id]), [familyDiscoveryDefinitionHash(id)]);
  }

  assert(load.disabledPlugins.length > 0, "disabled registry fixture required");
  const invalidScopes = [[], [logId, logId], ["unknown:family"], [""], [" " + logId],
    ...load.disabledPlugins.map(module => [String(module.familyId)])];
  const helpers = [strictCatalogActivityPlan, strictCatalogLogTopics, strictCatalogCallPatterns,
    strictCatalogSourceCoverageKeys, strictFamilyDefinitionHashes, strictFamilyDiscoveryDefinitionHashes,
    expectedSourcePlanFingerprints];
  for (const familyIds of invalidScopes) {
    for (const helper of helpers) assert.throws(() => helper(familyIds), /familyIds scope/);
    assert.throws(() => createRebuildWiring({ ...options, familyIds }), /familyIds scope/);
    assert.throws(() => candidatesFromLog(log, familyIds), /familyIds scope/);
    assert.throws(() => candidatesFromCall(call, familyIds), /familyIds scope/);
    assert.throws(() => startupSourcePlanFingerprint({ familyIds, coverageKeys: [], familyDefinitionHashes: [] }), /familyIds scope/);
    assert.throws(() => catalogActivitySourcePlanFingerprint({ familyIds, coverageKeys: [], familyDefinitionHashes: [], topics: [], callPatterns: [] }), /familyIds scope/);
  }
  assert.throws(() => createRebuildWiring({ ...options, familyIds: null as never }), /familyIds scope/);
}

async function checkArchive(): Promise<void> {
  const context = { chainId: 1, fromBlock: source.number, toBlock: source.number, cutoffHash: source.hash };
  const rawLogs = [log, opaqueLog].map(entry => ({
    address: entry.address, topics: [...entry.topics], data: entry.data,
    blockNumber: ethers.toQuantity(entry.blockNumber!), blockHash: entry.blockHash,
    transactionHash: entry.transactionHash, logIndex: ethers.toQuantity(entry.logIndex!), removed: false,
  }));
  const rawTrace = [call, otherCall].map(entry => ({
    type: "call", action: { callType: "call", to: entry.target, from: sender, input: entry.data },
    result: { gasUsed: "0x10", output: "0x" }, subtraces: 0,
    blockNumber: source.number, blockHash: source.hash,
    transactionHash: entry.transactionHash, traceAddress: entry.traceAddress,
  }));
  let savedLogs: readonly unknown[] | null = null, savedTrace: readonly unknown[] | null = null;
  let logWrites = 0, traceWrites = 0, reads = 0, integrityChecks = 0;
  const archive = {
    ...classificationMiss,
    maxEntryBytes: ARCHIVE_ACTIVITY_ENTRY_BYTES,
    withEntryLimit(limit: number) { assert.equal(limit, ARCHIVE_ACTIVITY_ENTRY_BYTES); return this; },
    assertScope(expected: typeof context) { assert.deepEqual(expected, context, "archive scope mismatch"); },
    async readLogs() { return savedLogs; },
    async readTrace() { return savedTrace; },
    async writeLogs(input: { logs: readonly unknown[]; fromBlock: number; toBlock: number }) {
      assert.equal(input.fromBlock, source.number); assert.equal(input.toBlock, source.number);
      savedLogs = structuredClone(input.logs); logWrites++;
    },
    async writeTrace(input: { trace: readonly unknown[]; method: string; blockNumber: number }) {
      assert.equal(input.method, "trace_block"); assert.equal(input.blockNumber, source.number);
      savedTrace = structuredClone(input.trace); traceWrites++;
    },
    async assertComplete(input: { method: string }) {
      integrityChecks++;
      assert.deepEqual(input, { method: "trace_block" });
      assert.notEqual(savedLogs, null, "integrity check follows complete log publication");
      assert.notEqual(savedTrace, null, "integrity check follows complete trace publication");
      return { stats: { logChunks: 1, traceBlocks: 1 } };
    },
  };
  const activityArchive = archive as unknown as ReadyActivityArchive;
  const sendMock = mock.method(RebuildReadProvider.prototype, "send", async (method: string, params: unknown) => {
    reads++;
    if (method === "eth_getLogs") {
      assert.deepEqual(params, [{ fromBlock: ethers.toQuantity(source.number), toBlock: ethers.toQuantity(source.number) }], "archive log transport must omit every topic/address filter");
      return rawLogs;
    }
    assert.equal(method, "trace_block");
    return rawTrace;
  });
  const getLogsMock = mock.method(RebuildReadProvider.prototype, "getLogs", async () => {
    assert.fail("archive must fetch raw JSON logs");
  });
  try {
    const initial = await createRebuildWiring({ ...options, familyIds: [logId], activityArchive })
      .scanSwapWindow({ fromBlock: source.number, cutoff: source });
    assert.deepEqual(initial.observations, [log]);
    assert.deepEqual(savedLogs, rawLogs, "all raw log fields and unrelated logs retained");
    assert.deepEqual(savedTrace, rawTrace, "full trace responses retained, not matched calls");
    assert.equal(logWrites, 1); assert.equal(traceWrites, 1);
    assert.equal(reads, 2, "trace method probe response is also cached");
    assert.equal(integrityChecks, 1, "archive integrity is checked before scan returns receipts");

    sendMock.mock.mockImplementation(async () => { assert.fail("cached activity must not read RPC"); });
    const newlySelected = createRebuildWiring({ ...options, familyIds: [callId], activityArchive });
    const replay = await newlySelected.scanSwapWindow({ fromBlock: source.number, cutoff: source });
    assert.deepEqual(replay.observations, [call], "new Family is classified from previously unrelated raw frames");
    assert.equal(replay.sourceReceipts[1].completedChunks[0].resultCount, 1);
    assert.deepEqual(newlySelected.dedupeFamilyCandidates(replay.observations), [callCandidate]);
    const opaqueFamilyId = String(catalog.listAll().find(family => "discovery" in family.plugin &&
      family.plugin.discovery.logPatterns?.some(pattern => pattern.topic.toLowerCase() === UNIV4_SWAP_TOPIC.toLowerCase()))!.plugin.manifest.familyId);
    const lateLog = await createRebuildWiring({ ...options, familyIds: [opaqueFamilyId], activityArchive })
      .scanSwapWindow({ fromBlock: source.number, cutoff: source });
    assert(lateLog.observations.some(entry => (entry as RebuildScanObservation).topics?.[0] === UNIV4_SWAP_TOPIC), "new log surface must reuse all-log slice");
    assert.equal(logWrites, 1); assert.equal(traceWrites, 1);
    assert.equal(integrityChecks, 3, "each cached reclassification must still verify archive integrity");
    const assertComplete = archive.assertComplete;
    archive.assertComplete = async input => {
      assert.deepEqual(input, { method: "trace_block" });
      integrityChecks++;
      throw new Error("archive integrity verification failed");
    };
    await assert.rejects(newlySelected.scanSwapWindow({ fromBlock: source.number, cutoff: source }), /archive integrity verification failed/);
    assert.equal(integrityChecks, 4, "integrity failure rejects the source scan instead of returning receipts");
    assert.equal(reads, 2, "integrity failure cannot refetch transport data");
    assert.equal(logWrites, 1); assert.equal(traceWrites, 1);
    archive.assertComplete = assertComplete;
    await assert.rejects(newlySelected.scanSwapWindow({ fromBlock: source.number - 1, cutoff: source }), /archive scope mismatch/);
    await assert.rejects(newlySelected.scanSwapWindow({ fromBlock: source.number, cutoff: { ...source, hash: "0x" + "bb".repeat(32) } }), /archive scope mismatch/);
    const readLogs = archive.readLogs, readTrace = archive.readTrace;
    archive.readLogs = async () => { throw new Error("corrupt logs"); };
    await assert.rejects(newlySelected.scanSwapWindow({ fromBlock: source.number, cutoff: source }), /corrupt logs/);
    archive.readLogs = readLogs;
    archive.readTrace = async () => { throw new Error("corrupt trace"); };
    await assert.rejects(newlySelected.scanSwapWindow({ fromBlock: source.number, cutoff: source }), /corrupt trace/);
    archive.readTrace = readTrace;
    savedLogs = [{ ...rawLogs[0], blockNumber: ethers.toQuantity(source.number - 1) }];
    await assert.rejects(newlySelected.scanSwapWindow({ fromBlock: source.number, cutoff: source }), /invalid archived activity log/);
    savedLogs = rawLogs;
    savedTrace = null;
    archive.writeTrace = async () => { throw new Error("trace archive write failed"); };
    let failedWriteReads = 0;
    sendMock.mock.mockImplementation(async (method: string) => {
      failedWriteReads++; assert.equal(method, "trace_block"); return rawTrace;
    });
    await assert.rejects(newlySelected.scanSwapWindow({ fromBlock: source.number, cutoff: source }), /trace archive write failed/);
    assert.equal(failedWriteReads, 1, "archive write failure must not switch trace transport");
  } finally {
    sendMock.mock.restore(); getLogsMock.mock.restore();
  }
}

async function checkAdaptiveArchive(): Promise<void> {
  const range = { fromBlock: source.number - 127, toBlock: source.number };
  let rpcReads = 0, writes = 0, integrityChecks = 0;
  const expectedRanges = Array.from({ length: 4 }, (_, index) => ({
    fromBlock: range.fromBlock + index * 32, toBlock: range.fromBlock + index * 32 + 31,
  }));
  const requests: { fromBlock: number; toBlock: number }[] = [];
  const writtenRanges = new Map<number, { fromBlock: number; toBlock: number }>();
  const cachedTraces = new Map<number, readonly unknown[]>();
  const archive = {
    ...classificationMiss,
    maxEntryBytes: ARCHIVE_ACTIVITY_ENTRY_BYTES,
    withEntryLimit(limit: number) { assert.equal(limit, ARCHIVE_ACTIVITY_ENTRY_BYTES); return this; },
    assertScope(expected: unknown) { assert.deepEqual(expected, { chainId: 1, ...range, cutoffHash: source.hash }); },
    async readLogs() { return null; },
    async readTrace({ blockNumber }: { blockNumber: number }) { return cachedTraces.get(blockNumber) ?? null; },
    async writeLogs(input: { fromBlock: number; toBlock: number; logs: readonly unknown[] }) {
      writes++;
      const expected = expectedRanges.find(entry => entry.fromBlock === input.fromBlock);
      assert(expected, "write belongs to a configured 32-block archive chunk");
      assert.deepEqual(input, { ...expected, logs: [] }, "complete 32-block chunk is archived after both adaptive subrequests");
      for (const offset of [0, 16]) {
        assert(requests.some(request => request.fromBlock === input.fromBlock + offset &&
          request.toBlock === input.fromBlock + offset + 15), "both 16-block subrequests finish before publication");
      }
      assert(!writtenRanges.has(input.fromBlock), "each complete chunk is published once");
      writtenRanges.set(input.fromBlock, expected);
    },
    async writeTrace({ blockNumber, trace }: { blockNumber: number; trace: readonly unknown[] }) { cachedTraces.set(blockNumber, trace); },
    async assertComplete(input: { method: string }) {
      integrityChecks++;
      assert.deepEqual(input, { method: "trace_block" });
      assert.deepEqual([...writtenRanges.values()].sort((a, b) => a.fromBlock - b.fromBlock), expectedRanges);
      assert.deepEqual([...cachedTraces.keys()].sort((a, b) => a - b), Array.from({ length: 128 }, (_, index) => range.fromBlock + index));
      return { stats: { logChunks: writtenRanges.size, traceBlocks: cachedTraces.size } };
    },
  };
  const sendMock = mock.method(RebuildReadProvider.prototype, "send", async (method: string, params: readonly unknown[]) => {
    if (method === "eth_getLogs") {
      rpcReads++;
      const query = params[0] as { fromBlock: string; toBlock: string };
      assert.deepEqual(Object.keys(query).sort(), ["fromBlock", "toBlock"]);
      const request = { fromBlock: Number(BigInt(query.fromBlock)), toBlock: Number(BigInt(query.toBlock)) };
      requests.push(request);
      if (request.toBlock - request.fromBlock + 1 > 16) throw new Error("fixture provider result limit");
      return [];
    }
    assert.equal(method, "trace_block");
    return [];
  });
  try {
    // This real catalog Family declares no calls. Archive acquisition still
    // saves every trace block, independently of its selected activity surface.
    const noCallId = String(catalog.listAll().find(family =>
      !("discovery" in family.plugin) || !family.plugin.discovery.callPatterns?.length)!.plugin.manifest.familyId);
    const wiring = createRebuildWiring({ ...options, familyIds: [noCallId], activityArchive: archive as unknown as ReadyActivityArchive });
    const result = await wiring.scanSwapWindow({ fromBlock: range.fromBlock, cutoff: source });
    assert.equal(rpcReads, 12, "four 32-block requests each split into two successful 16-block requests");
    assert.equal(writes, 4); assert.equal(cachedTraces.size, 128); assert.equal(integrityChecks, 1);
    assert.deepEqual(requests.filter(request => request.toBlock - request.fromBlock + 1 === 32)
      .sort((a, b) => a.fromBlock - b.fromBlock), expectedRanges);
    assert(result.sourceReceipts.every(receipt => receipt.completedChunks.every(chunk => chunk.resultCount === 0)));
    assert.deepEqual(wiring.buildCoverage({ sourceReceipts: result.sourceReceipts, cutoff: source })
      .map(row => row.familyId + "|" + row.sourceId).sort(), [...wiring.requiredSourceCoverageKeys()].sort(), "zero-candidate Families still have exact coverage");

    archive.writeLogs = async () => { throw new Error("archive durable write failed"); };
    const before = rpcReads;
    await assert.rejects(wiring.scanSwapWindow({ fromBlock: range.fromBlock, cutoff: source }), /archive durable write failed/);
    assert.equal(rpcReads - before, 12, "archive write failures never retry the adaptive scan");
    assert.equal(integrityChecks, 1, "failed publication cannot reach the archive completion gate");
  } finally { sendMock.mock.restore(); }
}

async function checkTraceArchiveSchema(): Promise<void> {
  const base = { blockNumber: source.number, blockHash: source.hash, transactionHash: call.transactionHash,
    traceAddress: [], subtraces: 0 };
  const parityCall = { ...base, type: "call", action: { from: sender, to: sender, input: "0x", callType: "call" },
    result: { gasUsed: "0x10", output: "0x" } };
  const debugFrame = { type: "CALL", from: sender, to: sender, input: "0x", gas: "0x100", gasUsed: "0x10", output: "0x" };
  type Method = "trace_block" | "debug_traceBlockByNumber";
  const check = async (method: Method, raw: readonly unknown[], valid: boolean, cached = false, afterProbe = false) => {
    const fromBlock = source.number - (afterProbe ? 1 : 0);
    const saved = new Map<number, readonly unknown[]>();
    if (cached) saved.set(source.number, raw);
    if (afterProbe) saved.set(source.number, []);
    let writes = 0, integrityChecks = 0, transportReads = 0;
    const archive = {
      ...classificationMiss,
      maxEntryBytes: ARCHIVE_ACTIVITY_ENTRY_BYTES,
      withEntryLimit(limit: number) { assert.equal(limit, ARCHIVE_ACTIVITY_ENTRY_BYTES); return this; },
      assertScope(expected: unknown) { assert.deepEqual(expected, { chainId: 1, fromBlock, toBlock: source.number, cutoffHash: source.hash }); },
      async readLogs() { return []; },
      async readTrace(input: { blockNumber: number; method: Method }) {
        return input.method === method ? saved.get(input.blockNumber) ?? null : null;
      },
      async writeTrace(input: { blockNumber: number; method: Method; trace: readonly unknown[] }) {
        assert.equal(input.method, method); writes++; saved.set(input.blockNumber, input.trace);
      },
      async assertComplete(input: { method: Method }) {
        assert.equal(input.method, method); integrityChecks++;
        for (let number = fromBlock; number <= source.number; number++) assert(saved.has(number));
        return { stats: { traceBlocks: saved.size } };
      },
    };
    const sendMock = mock.method(RebuildReadProvider.prototype, "send", async (requested: string) => {
      transportReads++;
      if (cached) assert.fail("malformed cached trace must never refetch");
      if (method === "debug_traceBlockByNumber" && requested === "trace_block") throw new Error("fixture method unavailable");
      assert.equal(requested, method);
      return raw;
    });
    const blockMock = mock.method(RebuildReadProvider.prototype, "getBlock", async () => {
      assert.fail("unmatched trace validation must not fetch block headers");
    });
    try {
      const noCallId = String(catalog.listAll().find(family =>
        !("discovery" in family.plugin) || !family.plugin.discovery.callPatterns?.length)!.plugin.manifest.familyId);
      const wiring = createRebuildWiring({ ...options, familyIds: [noCallId], activityArchive: archive as unknown as ReadyActivityArchive });
      const scan = wiring.scanSwapWindow({ fromBlock, cutoff: source });
      if (valid) {
        const result = await scan;
        assert(result.sourceReceipts.every(receipt => receipt.status === "complete"));
        assert.deepEqual(saved.get(source.number), raw);
        assert.equal(writes, cached ? 0 : 1); assert.equal(integrityChecks, 1);
      } else {
        await assert.rejects(scan, /invalid archived .* trace schema/);
        assert.equal(writes, 0, "malformed response must never become an immutable receipt");
        assert.equal(integrityChecks, 0, "malformed trace cannot complete the source scan");
        if (cached) { assert.deepEqual(saved.get(source.number), raw); assert.equal(transportReads, 0); }
        else assert.equal(transportReads, method === "trace_block" || afterProbe ? 1 : 2,
          "schema failure must not retry or switch transports");
      }
    } finally { sendMock.mock.restore(); blockMock.mock.restore(); }
  };
  const validParity = [parityCall,
    { ...parityCall, error: "Reverted", result: null },
    { ...parityCall, action: { ...parityCall.action, callType: "delegatecall" } },
    { ...base, type: "create", action: { from: sender, init: "0x1234" }, result: { address: sender, code: "0x", gasUsed: "0x10" } },
    { ...base, type: "create", action: { from: sender, init: "0x1234" }, error: "Out of gas", result: null },
    { ...base, type: "suicide", action: { address: sender, refundAddress: sender, balance: "0x0" } },
    { ...base, type: "reward", transactionHash: null, action: { author: sender, rewardType: "block", value: "0x0" } },
  ];
  const validDebug = [{ txHash: call.transactionHash, result: { ...debugFrame,
    calls: [{ ...debugFrame, type: "DELEGATECALL", error: "execution reverted" },
      { type: "CREATE", from: sender, input: "0x1234", error: "out of gas" },
      { type: "SELFDESTRUCT", from: sender, to: sender, value: "0x1" }] } }];
  for (const [method, raw] of [["trace_block", validParity], ["debug_traceBlockByNumber", validDebug]] as const) {
    await check(method, [], true);
    await check(method, raw, true);
    await check(method, raw, true, true);
    await check(method, [null], false);
    await check(method, [null], false, true);
    await check(method, [null], false, false, true);
  }
  for (const malformed of [
    { ...parityCall, blockNumber: source.number - 1 },
    { ...parityCall, blockHash: "bad" }, { ...parityCall, transactionHash: null },
    { ...parityCall, traceAddress: [-1] }, { ...parityCall, subtraces: "0" },
    { ...parityCall, result: undefined }, { ...parityCall, result: { gasUsed: "0x1", output: "0x1" } },
    { ...parityCall, action: { ...parityCall.action, to: "bad" } },
    { ...parityCall, type: "unexpected" },
  ]) await check("trace_block", [malformed], false);
  await check("trace_block", [parityCall, { ...parityCall, blockHash: "0x" + "bb".repeat(32) }], false);
  for (const malformed of [
    { txHash: call.transactionHash, error: "execution timeout", result: debugFrame },
    { txHash: call.transactionHash, result: { ...debugFrame, calls: [null] } },
    { txHash: call.transactionHash, result: { ...debugFrame, calls: {} } },
    { txHash: call.transactionHash, result: { ...debugFrame, input: "0x1" } },
    { txHash: call.transactionHash, result: { ...debugFrame, type: "unexpected" } },
    { result: debugFrame },
  ]) await check("debug_traceBlockByNumber", [malformed], false);
}

async function checkArchiveSingleBlockFloor(): Promise<void> {
  const fromBlock = source.number - 1;
  const successfulBlocks: number[] = [];
  let writes = 0, rejectSingleBlock = false;
  const archive = {
    ...classificationMiss,
    maxEntryBytes: ARCHIVE_ACTIVITY_ENTRY_BYTES,
    withEntryLimit(limit: number) { assert.equal(limit, ARCHIVE_ACTIVITY_ENTRY_BYTES); return this; },
    assertScope() {}, async readLogs() { return null; }, async readTrace() { return []; },
    async writeLogs(input: { fromBlock: number; toBlock: number; logs: readonly unknown[] }) {
      writes++; assert.deepEqual(input, { fromBlock, toBlock: source.number, logs: [] });
    },
    async assertComplete() { return { stats: {} }; },
  };
  const sendMock = mock.method(RebuildReadProvider.prototype, "send", async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "eth_getLogs");
    const query = params[0] as { fromBlock: string; toBlock: string };
    const from = Number(BigInt(query.fromBlock)), to = Number(BigInt(query.toBlock));
    if (from !== to || rejectSingleBlock) throw new Error("fixture result limit");
    successfulBlocks.push(from); return [];
  });
  try {
    const wiring = createRebuildWiring({ ...options, familyIds: [logId], activityArchive: archive as unknown as ReadyActivityArchive });
    await wiring.scanSwapWindow({ fromBlock, cutoff: source });
    assert.deepEqual(successfulBlocks, [fromBlock, source.number]); assert.equal(writes, 1);
    rejectSingleBlock = true;
    await assert.rejects(wiring.scanSwapWindow({ fromBlock, cutoff: source }), /swap window scan failed/);
    assert.equal(writes, 1, "failed single-block request cannot publish a fabricated empty slice");
  } finally { sendMock.mock.restore(); }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("archive worker test deadline")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function checkArchiveWorkerBounds(): Promise<void> {
  assert.equal(ARCHIVE_ACTIVITY_CONCURRENCY, 16);
  const workers = ARCHIVE_ACTIVITY_CONCURRENCY;
  assert.equal(ARCHIVE_ACTIVITY_ENTRY_BYTES, 64 * 1024 * 1024);
  assert.equal(ARCHIVE_ACTIVITY_RESPONSE_BYTES, 65 * 1024 * 1024);
  for (const failWrite of [false, true]) {
    const reached = deferred(), release = deferred();
    let reads = 0, entered = 0, active = 0, maximum = 0, settled = false;
    const archive = {
      ...classificationMiss,
      maxEntryBytes: ARCHIVE_ACTIVITY_ENTRY_BYTES,
      withEntryLimit(limit: number) { assert.equal(limit, this.maxEntryBytes); return this; },
      assertScope() {}, async readLogs() { return null; }, async readTrace() { return []; },
      async writeLogs() {
        const index = entered++;
        active++; maximum = Math.max(maximum, active);
        if (entered === workers) reached.resolve();
        try {
          if (failWrite && index === 0) throw new Error("fixture publication failed");
          await release.promise;
        } finally { active--; }
      },
      async assertComplete() { return { stats: {} }; },
    };
    const sendMock = mock.method(RebuildReadProvider.prototype, "send", async function (this: RebuildReadProvider, method: string) {
      assert.equal(method, "eth_getLogs"); reads++;
      assert.equal(Reflect.get(this, "maxReceivedBytes"), ARCHIVE_ACTIVITY_RESPONSE_BYTES);
      assert.equal(Reflect.get(this, "maxDecompressedBytes"), ARCHIVE_ACTIVITY_RESPONSE_BYTES);
      return [];
    });
    try {
      const wiring = createRebuildWiring({ ...options, familyIds: [logId], activityArchive: archive as unknown as ReadyActivityArchive });
      const scan = wiring.scanSwapWindow({ fromBlock: source.number - 32 * (workers + 1) + 1, cutoff: source });
      const outcome = scan.then(() => { settled = true; assert.equal(failWrite, false); }, error => {
        settled = true; assert.equal(failWrite, true); assert.match(String(error), /fixture publication failed/);
      });
      await within(reached.promise);
      assert.equal(reads, workers, "next log chunk must wait for durable writes/classification");
      assert.equal(settled, false, "a failed group must drain its still-owned writers before rejecting");
      release.resolve(); await within(outcome);
      assert(maximum <= workers); assert.equal(active, 0); assert.equal(reads, failWrite ? workers : workers + 1);
    } finally { release.resolve(); sendMock.mock.restore(); }
  }
  for (const cached of [false, true]) {
    const reached = deferred(), release = deferred();
    let acquisitions = 0, rpcReads = 0, writes = 0, active = 0, maximum = 0;
    const raw = [{ txHash: call.transactionHash, result: { type: "CALL", from: sender, to: call.target, input: call.data } }];
    const archive = {
      ...classificationMiss,
      maxEntryBytes: ARCHIVE_ACTIVITY_ENTRY_BYTES,
      withEntryLimit(limit: number) { assert.equal(limit, this.maxEntryBytes); return this; },
      assertScope() {}, async readLogs() { return []; },
      async readTrace({ blockNumber, method }: { blockNumber: number; method: string }) {
        if (method !== "debug_traceBlockByNumber") return null;
        if (blockNumber === source.number) return []; // method probe is already archived
        acquisitions++; return cached ? raw : null;
      },
      async writeTrace() { writes++; }, async assertComplete() { return { stats: {} }; },
    };
    const sendMock = mock.method(RebuildReadProvider.prototype, "send", async function (this: RebuildReadProvider, method: string) {
      assert.equal(cached, false); assert.equal(method, "debug_traceBlockByNumber"); rpcReads++;
      assert.equal(Reflect.get(this, "maxReceivedBytes"), ARCHIVE_ACTIVITY_RESPONSE_BYTES);
      assert.equal(Reflect.get(this, "maxDecompressedBytes"), ARCHIVE_ACTIVITY_RESPONSE_BYTES);
      return raw;
    });
    const blockMock = mock.method(RebuildReadProvider.prototype, "getBlock", async (number: number) => {
      active++; maximum = Math.max(maximum, active);
      if (active === workers) reached.resolve();
      try { await release.promise; return { number, hash: source.hash } as ethers.Block; }
      finally { active--; }
    });
    try {
      const wiring = createRebuildWiring({ ...options, familyIds: [callId], activityArchive: archive as unknown as ReadyActivityArchive });
      const scan = wiring.scanSwapWindow({ fromBlock: source.number - 2 * workers, cutoff: source });
      await within(reached.promise);
      assert.equal(acquisitions, workers, "trace slot remains held through asynchronous classification");
      assert.equal(rpcReads, cached ? 0 : workers);
      release.resolve(); await within(scan);
      assert.equal(maximum, workers); assert.equal(acquisitions, 2 * workers); assert.equal(writes, cached ? 0 : 2 * workers);
    } finally { release.resolve(); sendMock.mock.restore(); blockMock.mock.restore(); }
  }
}

async function checkAccumulatedLogPayloadLimit(): Promise<void> {
  let reads = 0, writes = 0;
  const archive = {
    ...classificationMiss,
    maxEntryBytes: 512, withEntryLimit() { return this; }, assertScope() {},
    async readLogs() { return null; }, async readTrace() { assert.fail("oversize log slice cannot reach tracing"); },
    async writeLogs() { writes++; }, async assertComplete() { assert.fail("oversize slice cannot seal source receipts"); },
  };
  const sendMock = mock.method(RebuildReadProvider.prototype, "send", async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "eth_getLogs"); reads++;
    const query = params[0] as { fromBlock: string; toBlock: string };
    if (query.fromBlock !== query.toBlock) throw new Error("fixture split required");
    return [{ address: log.address, topics: log.topics, data: "0x", blockNumber: query.fromBlock,
      blockHash: source.hash, transactionHash: call.transactionHash, logIndex: "0x0" }];
  });
  try {
    const wiring = createRebuildWiring({ ...options, familyIds: [logId], activityArchive: archive as unknown as ReadyActivityArchive });
    await assert.rejects(wiring.scanSwapWindow({ fromBlock: source.number - 1, cutoff: source }),
      error => (error as { code?: string }).code === "READY_ACTIVITY_ENTRY_LIMIT");
    assert.equal(reads, 3, "accumulated oversize failure must not refetch successful subrequests");
    assert.equal(writes, 0);
  } finally { sendMock.mock.restore(); }
}

async function main(): Promise<void> {
  let physicalRequests = 0;
  mock.method(RebuildReadProvider.prototype, "_send", async () => {
    physicalRequests++;
    throw new Error("test forbids physical RPC");
  });
  try {
    checkPlans();
    const mutableScope = [callId, logId];
    const scoped = createRebuildWiring({ ...options, familyIds: mutableScope });
    mutableScope.splice(0, mutableScope.length, otherId);
    assert.deepEqual(scoped.expectedSourcePlanFingerprints(), expectedSourcePlanFingerprints([logId, callId]), "caller mutation cannot widen scope");
    assert(scoped.isFamilyEnabled!(logId));
    assert(scoped.isFamilyEnabled!(callId));
    assert.equal(scoped.isFamilyEnabled!(otherId), false);
    assert.equal(scoped.isFamilyEnabled!("unknown:family"), false);
    assert.deepEqual(scoped.requiredSourceCoverageKeys(), [
      ...strictCatalogSourceCoverageKeys([logId, callId]).startup,
      ...strictCatalogActivityPlan([logId, callId]).coverageKeys,
    ]);
    assert.equal(scoped.candidateFamilyId(logCandidate), logId);
    assert.equal(scoped.candidateFamilyId({ adapter: logCandidate.adapter }), logId);
    assert.equal(scoped.candidateFamilyId({ adapter: callCandidate.adapter }), callId);
    assert.equal(scoped.candidateFamilyId(otherCandidate), otherId, "accounting resolution is pure, not admission");
    assert.equal(scoped.candidateFamilyId({ adapter: "unknown" }), "unknown-family");
    assert.equal(scoped.candidateFamilyId(null), "unknown-family");
    assert.equal(scoped.familyDiscoveryDefinitionHash(logId), familyDiscoveryDefinitionHash(logId));

    assert.deepEqual(candidatesFromLog(log, [callId]), []);
    assert.deepEqual(candidatesFromLog(log, [logId]), [logCandidate]);
    assert.deepEqual(candidatesFromCall(otherCall, [callId]), []);
    assert.deepEqual(candidatesFromCall(call, [callId]), [callCandidate]);
    const retained = { ...logCandidate, familyId: undefined };
    const deduped = scoped.dedupeFamilyCandidates([
      log, log, call, call, otherCall, opaqueLog,
      ...[retained, otherCandidate, { familyId: "unknown:family" }].map(candidate => ({ kind: "startup-candidate", candidate })),
    ]) as readonly { familyId: string }[];
    assert.deepEqual(deduped.map(candidate => candidate.familyId).sort(), [logId, callId].sort());
    assert.deepEqual(await scoped.reverseBindOpaqueCandidates!({ observations: [opaqueLog], cutoff: source, knownCandidates: [otherCandidate] }), []);

    // A retained Family outside scope cannot enter lifecycle, memo reuse or Graph.
    const foreignMemo = { familyId: otherId } as DurableVerifiedMemo;
    assert.equal(scoped.isReadyMemoDefinitionCurrent!(foreignMemo), false);
    assert.equal(await scoped.findReusableMemo({ candidate: otherCandidate, checkpoint: null as never, cutoff: source }), null);
    await assert.rejects(scoped.attestFamilyInstanceOnce({ candidate: otherCandidate, cutoff: source }), /outside rebuild familyIds scope/);
    assert.throws(() => scoped.upgradeLegacyVerifiedMemo!(foreignMemo as unknown as LegacyDurableVerifiedMemo), /outside rebuild familyIds scope/);
    assert.throws(() => scoped.rehydrateVerifiedInstance({ memo: foreignMemo, cutoff: source }), /outside rebuild familyIds scope/);
    assert.throws(() => scoped.aggregateOnceByFamily([otherCandidate]), /outside rebuild familyIds scope/);
    assert.throws(() => scoped.buildGraphSnapshot([{ familyId: otherId, instances: [] }], source), /outside rebuild familyIds scope/);

    let logReads = 0, traceReads = 0;
    const filters: unknown[] = [];
    const logMock = mock.method(RebuildReadProvider.prototype, "getLogs", async (filter: unknown) => {
      logReads++;
      filters.push(filter);
      // Deliberately include an unsolicited log: it must not contaminate a
      // scoped receipt even if a provider returns more than the topic query.
      return [log, opaqueLog].map(entry => ({ ...entry, index: entry.logIndex })) as unknown as ethers.Log[];
    });
    const traceMock = mock.method(RebuildReadProvider.prototype, "send", async (method: string, params: unknown) => {
      assert.equal(method, "trace_block");
      assert.deepEqual(params, [ethers.toQuantity(source.number)]);
      traceReads++;
      return [call, otherCall].map(entry => ({
        type: "call", action: { callType: "call", to: entry.target, from: sender, input: entry.data },
        blockNumber: entry.blockNumber, blockHash: entry.blockHash,
        transactionHash: entry.transactionHash, traceAddress: entry.traceAddress,
      }));
    });
    const scanWiring = createRebuildWiring({ ...options, familyIds: [logId, callId], startupCandidates: [logCandidate, otherCandidate] });
    const result = await scanWiring.scanSwapWindow({ fromBlock: source.number, cutoff: source });
    assert.equal(logReads, 1);
    assert(traceReads > 0);
    const topics = strictCatalogLogTopics([logId, callId]);
    assert.deepEqual(filters, [{ topics: topics.length === 1 ? [topics[0]] : [topics], fromBlock: source.number, toBlock: source.number }]);
    assert.deepEqual(result.observations, [{ kind: "startup-candidate", candidate: logCandidate }, log, call]);
    assert.equal(result.sourceReceipts.length, 2);
    assert.equal(result.sourceReceipts[0].completedChunks[0].resultCount, 1, "startup receipt counts only selected candidates");
    assert.equal(result.sourceReceipts[1].completedChunks[0].resultCount, 2, "activity receipt counts only selected logs/calls");
    for (const receipt of result.sourceReceipts) {
      assert.equal(receipt.queryFingerprint, scanWiring.expectedSourcePlanFingerprints()[receipt.sourceKind === "startup-candidate-union" ? "startup" : "activity"]);
      assert(receipt.coverageKeys.every(key => [logId, callId].includes(key.split("|")[0])));
    }
    const rows = scanWiring.buildCoverage({ sourceReceipts: result.sourceReceipts, cutoff: source });
    assert.deepEqual(rows.map(row => row.familyId + "|" + row.sourceId).sort(), [...scanWiring.requiredSourceCoverageKeys()].sort());
    assert.throws(() => scanWiring.buildCoverage({ sourceReceipts: [{ ...result.sourceReceipts[0], queryFingerprint: expectedSourcePlanFingerprints().startup }], cutoff: source }), /differs from rebuild familyIds scope/);
    assert.throws(() => scanWiring.buildCoverage({ sourceReceipts: [{ ...result.sourceReceipts[0], coverageKeys: [...result.sourceReceipts[0].coverageKeys, otherId + "|startup-universe"] }], cutoff: source }), /differs from rebuild familyIds scope/);

    // Changing only unrelated inputs leaves scoped observation hashes identical.
    const repeated = await createRebuildWiring({ ...options, familyIds: [callId, logId], startupCandidates: [logCandidate] })
      .scanSwapWindow({ fromBlock: source.number, cutoff: source });
    assert.deepEqual(repeated.sourceReceipts, result.sourceReceipts);
    const logOnlyId = String(catalog.listAll().find(family =>
      !("discovery" in family.plugin) || !family.plugin.discovery.callPatterns?.length)!.plugin.manifest.familyId);
    const logOnly = createRebuildWiring({ ...options, familyIds: [logOnlyId] });
    assert.equal(strictCatalogCallPatterns([logOnlyId]).length, 0);
    const tracesBefore = traceReads;
    await logOnly.scanSwapWindow({ fromBlock: source.number, cutoff: source });
    assert.equal(traceReads, tracesBefore, "no trace transport without selected call declarations");
    logMock.mock.restore();
    traceMock.mock.restore();
    await checkArchive();
    await checkAdaptiveArchive();
    await checkTraceArchiveSchema();
    await checkArchiveSingleBlockFloor();
    await checkArchiveWorkerBounds();
    await checkAccumulatedLogPayloadLimit();
    assert.equal(physicalRequests, 0);
    console.log("universe rebuild family scope PASS (real catalog, offline transports, legacy fingerprints preserved)");
  } finally {
    mock.restoreAll();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

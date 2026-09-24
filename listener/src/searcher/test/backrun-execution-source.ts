import assert from "node:assert/strict";
import { resolveBackrunExecutionSource, assertBackrunSourceSimulation } from "../backrun-execution-source.js";
import { resolveLiveBackrunSettings, DEFAULT_BACKRUN_MAX_HOPS } from "../backrun-live-policy.js";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";

const B = 100, N = B + 1, hashB = `0x${"ab".repeat(32)}`, hashN = `0x${"cd".repeat(32)}`;
const calls: string[] = [];
const provider = (label: string, number: number, hash: string) => ({
  async getBlock(request: number) {
    calls.push(`${label}:${request}`);
    return { number, hash, parentHash: hashB } as never;
  },
});
const event: OrderflowEvent = {
  txHash: `0x${"ef".repeat(32)}`, blockNumber: N, rawTx: "0x1234", from: `0x${"12".repeat(20)}`,
  nonce: 0, to: null, input: "0x", logs: [], minProfit: 1n, victimState: "materialized", logsCompleteness: "complete-receipt",
  sourceBlockHash: hashB, receiptBlockHash: hashN, receiptBlockNumber: N, receiptParentBlockHash: hashB,
};
const input = { dryRun: true, path: "rawTx", event, latestBlock: B, generation: 8,
  provider: provider("canonical", B, hashB), materializedProvider: provider("derived", N, hashN) };
const normal = await resolveBackrunExecutionSource(input);
assert.deepEqual(normal, { source: { number: B, hash: hashB, generation: 8 } });
assert.deepEqual(calls.splice(0), [`canonical:${B}`]);
const historical = await resolveBackrunExecutionSource({ ...input, historicalMode: "materialized-source" });
assert.deepEqual(historical, { source: { number: N, hash: hashN, generation: 8 },
  feeEnvironment: { mode: "source-block", sourceBlockHash: hashN } });
assert.deepEqual(calls.splice(0), [`derived:${N}`]);
for (const patch of [
  { dryRun: false }, { path: "hash-only" }, { event: { ...event, logsCompleteness: "fragment" as const } },
  { event: { ...event, receiptBlockHash: hashB } }, { event: { ...event, receiptParentBlockHash: hashN } },
  { materializedProvider: provider("wrong", N + 1, hashN) },
]) {
  await assert.rejects(resolveBackrunExecutionSource({ ...input, historicalMode: "materialized-source", ...patch }));
}
const valid = { success: true, sourceBlockEvidence: { executionMode: "source-block",
  source: historical.source, baseFeePerGas: "1000", repaymentVerified: true, conservationVerified: true } };
assertBackrunSourceSimulation(valid as unknown as SimulationResult, historical.source);
for (const sim of [
  { success: true },
  { ...valid, sourceBlockEvidence: { ...valid.sourceBlockEvidence, source: normal.source } },
  { ...valid, sourceBlockEvidence: { ...valid.sourceBlockEvidence, conservationVerified: false } },
]) assert.throws(() => assertBackrunSourceSimulation(sim as unknown as SimulationResult, historical.source));
const settings = resolveLiveBackrunSettings({ SEARCHER_DRY_RUN: "1" });
assert.equal(DEFAULT_BACKRUN_MAX_HOPS, 6);
assert.equal(settings.planner.maxHops, 6);
assert.deepEqual(settings.planner, { maxHops: 6, maxCandidates: 20, maxPoolsPerToken: 8, maxRotationsPerPath: 3 });
assert.equal(settings.execution.oppTtlMs, 5000);
assert.equal(settings.execution.solverDeadlineMs, 8000);
assert.equal(settings.execution.quoteSafetyBps, 10000n);
assert.equal(settings.execution.quoteToleranceRawUnits, 1n);
for (const disabled of ["0", "false"]) {
  const exact = resolveLiveBackrunSettings({ SEARCHER_BACKRUN_QUOTE_TOLERANCE_ENABLED: disabled, SEARCHER_QUOTE_SAFETY_BPS: "9999" });
  assert.equal(exact.execution.quoteToleranceRawUnits, 0n);
  assert.equal(exact.execution.quoteSafetyBps, 10000n);
}
assert.throws(() => resolveLiveBackrunSettings({ SEARCHER_BACKRUN_QUOTE_TOLERANCE_ENABLED: "2" }));
assert.equal(settings.execution.quoteProfitFloorBps, 20n);
assert.equal(resolveLiveBackrunSettings({}).execution.quoteProfitFloorBps, 0n);
assert.equal(resolveLiveBackrunSettings({ SEARCHER_MAX_HOPS: "4" }).planner.maxHops, 4);
console.log("backrun execution source and shared live policy PASS");

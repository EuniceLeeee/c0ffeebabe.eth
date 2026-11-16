import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder } from "ethers";
import { evaluateEv, snapshotEvBlockObservation, type EvBlockObservation } from "../ev-evaluator.js";
import { maybeSubmitBlockScanAtomic, resolveBlockScanAtomicPolicy } from "../main.js";
import { createFinalSimulationWorkRuntime } from "../final-simulation-work-runtime.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";

const hash = "0x" + "12".repeat(32), otherHash = "0x" + "34".repeat(32);
const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const parent = { number: 100, hash, timestamp: 1_800_000_000,
  baseFeePerGas: 10n, gasUsed: 30_000_000n, gasLimit: 60_000_000n };
const policy = { profitHaircutBps: 0, evGate: true, bribeAllAboveGas: false, bribeBps: 5000 };
const scanned = { source: { number: parent.number, hash }, canValue: () => true,
  valueInEth: (_token: string, amount: bigint) => amount };

test("complete invocation-local header saves one read with identical scanned EV output", async () => {
  let reads = 0;
  const provider = { async getBlock(tag: number | "latest") { reads++; assert.equal(tag, 100); return parent; } };
  const baseline = await evaluateEv(provider, weth, 100_000n, 100n, policy, scanned, 100);
  assert.equal(reads, 2);
  const observation = snapshotEvBlockObservation(parent, 100, hash)!;
  assert(Object.isFrozen(observation)); assert.notEqual(observation, parent);
  const candidate = await evaluateEv(provider, weth, 100_000n, 100n, policy, scanned, 100, undefined, observation);
  assert.deepEqual(candidate, baseline); assert.equal(reads, 3, "final canonical read remains mandatory");
});

for (const change of [{ hash: otherHash }, { number: 101 }, null]) {
  test(`reused first header still rejects final canonical ${JSON.stringify(change)}`, async () => {
    let reads = 0;
    const result = await evaluateEv({ async getBlock() { reads++; return change === null ? null : { ...parent, ...change }; } },
      weth, 100_000n, 100n, policy, scanned, 100, undefined, parent);
    assert.equal(reads, 1); assert.equal(result.feeStateAvailable, false);
    assert.equal(result.sourceBlockHash, null); assert.equal(result.valuationAvailable, false);
  });
}

for (const change of [{ number: 99 }, { hash: otherHash }, { baseFeePerGas: undefined },
  { baseFeePerGas: "10" }, { gasUsed: -1n }, { gasLimit: 0n }, { gasUsed: 60_000_001n },
  { timestamp: Number.NaN }]) {
  test(`invalid or mismatched observation falls back: ${Object.keys(change)[0]}=${String(Object.values(change)[0])}`, async () => {
    let reads = 0;
    const result = await evaluateEv({ async getBlock() { reads++; return parent; } },
      weth, 100_000n, 100n, policy, scanned, 100, undefined, { ...parent, ...change } as EvBlockObservation);
    assert.equal(reads, 2); assert(result.feeStateAvailable && result.valuationAvailable);
    assert.equal(result.maxBaseFeePerGas, 10n); assert.equal(result.sourceBlockHash, hash);
  });
}

test("oracle path snapshots supplied fields before awaiting and keeps source bracketing", async () => {
  const supplied = { ...parent };
  const calls: string[] = [];
  const result = await evaluateEv({
    async getBlock(tag) { calls.push("after"); assert.equal(tag, 100); return parent; },
    async call(tx) {
      calls.push("oracle"); assert.equal(tx.blockTag, 100);
      Object.assign(supplied, { hash: otherHash, baseFeePerGas: 999n, timestamp: 1, gasUsed: 1n });
      await Promise.resolve();
      return AbiCoder.defaultAbiCoder().encode(["uint80", "int256", "uint256", "uint256", "uint80"],
        [1n, 2000_00000000n, 0n, BigInt(parent.timestamp - 1), 1n]);
    },
  }, usdc, 1_000_000n, 100n, policy, undefined, 100, undefined, supplied);
  assert.deepEqual(calls, ["oracle", "after"]);
  assert.equal(result.sourceBlockHash, hash); assert.equal(result.maxBaseFeePerGas, 10n);
  assert.equal(result.ethUsd, 2000); assert(result.valuationAvailable && result.feeStateAvailable);
});

test("historical source-block zero base fee and source binding remain valid", async () => {
  let reads = 0;
  const zero = { ...parent, baseFeePerGas: 0n };
  const provider = { async getBlock() { reads++; return zero; } };
  const result = await evaluateEv(provider, weth, 100_000n, 100n, policy, scanned, 100,
    { mode: "source-block", sourceBlockHash: hash }, zero);
  assert.equal(reads, 1); assert.equal(result.maxBaseFeePerGas, 0n);
  assert(result.feeStateAvailable); assert.equal(result.gasCostEth, 0n);
  await evaluateEv(provider, weth, 100_000n, 100n, policy, undefined, 100,
    { mode: "source-block", sourceBlockHash: hash }, { ...zero, hash: otherHash });
  assert.equal(reads, 3, "a different-hash observation cannot satisfy the historical pin");
});

test("unbound latest and fee-disabled calls retain their old provider behavior", async () => {
  const tags: (number | "latest")[] = [];
  const provider = { async getBlock(tag: number | "latest") { tags.push(tag); return parent; } };
  await evaluateEv(provider, weth, 100_000n, 100n, policy, undefined, undefined, undefined, parent);
  assert.deepEqual(tags, ["latest"]);
  await evaluateEv(provider, weth, 100_000n, 100n, { ...policy, evGate: false }, undefined, 100, undefined, parent);
  assert.deepEqual(tags, ["latest"]);
});

function atomicFixture(input: { rawPatch?: Record<string, unknown>; afterHash?: string; simProfit?: bigint;
  mutateAfterObservation?: boolean; historical?: boolean } = {}) {
  const controller = new AbortController();
  const calls: string[] = [];
  let simulations = 0, rawReads = 0;
  const raw: Record<string, unknown> = { number: "0x64", hash,
    timestamp: "0x" + parent.timestamp.toString(16), baseFeePerGas: "0xa",
    gasUsed: "0x1c9c380", gasLimit: "0x3938700", transactions: [],
    parentHash: otherHash, stateRoot: otherHash, ...input.rawPatch };
  const profit = input.simProfit ?? 100_000n;
  const runtime = createFinalSimulationWorkRuntime<null, ResolvedPlan, SimulationResult>({
    reservedResources: [{ id: "ev-fixture", value: null }],
    runner: { async simulate() {
      simulations++; return { success: profit > 0n, netProfit: profit, grossProfit: profit,
        profitToken: weth, gasUsed: 100n, calldata: "0x12", scriptHex: "0x12",
        ...(input.historical ? { sourceBlockEvidence: { executionMode: "source-block", source: { number: 100, hash, generation: 1 },
          repaymentVerified: true, conservationVerified: true, baseFeePerGas: "10" } } : {}) };
    } },
    generationFence: { assertCurrent(g, s) { assert.equal(g, 1); assert.equal(s.hash, hash); } },
    planIdentity: { bytesHex: () => "0x12", resultBytesHex: result => result.scriptHex }, timeoutMs: 5000, maxQueued: 1,
  });
  const run = () => maybeSubmitBlockScanAtomic({
    historicalReadOnly: input.historical,
    ...(input.historical ? { historicalExecutionMode: "source-block" as const } : {}),
    config: { ...resolveBlockScanAtomicPolicy({ SEARCHER_EV_GATE: "1", SEARCHER_BRIBE_BPS: "5000" }),
      dryRun: true, blockScanSubmit: false, finalVerifyFloorBps: 0n },
    provider: {
      async send(method: string, params: unknown[]) { assert.equal(method, "eth_getBlockByNumber");
        calls.push("raw:" + params[0]); rawReads++;
        return rawReads > 1 && input.afterHash ? { ...raw, hash: input.afterHash } : raw; },
      async getBlock(tag: number | "latest") { calls.push("fee:" + tag); return { ...parent, hash: input.afterHash ?? hash }; },
    } as any,
    finalSimulationRuntime: runtime, sourceGeneration: 1, sourceBlock: 100, sourceBlockHash: hash,
    opp: { seedEdges: [], flashToken: weth, affectedTokens: [], cycleId: "ev-fixture",
      cycleFingerprint: "ev-fixture", leavesStandingPosition: false, searchSeed: { searchCenter: 1_000_000n } } as any,
    resolved: { root: { adapterId: "ev-fixture", target: weth, tokenIn: weth, tokenOut: weth,
      amount: 1_000_000n, params: {}, children: [] }, flashAmount: 1_000_000n,
      profitToken: weth, netProfit: 100_000n, templateName: "ev-fixture" },
    bundleRouter: { async submit() { throw new Error("test must not submit"); } },
    submissionCoordinator: { offer() { throw new Error("test must not offer a submission"); } },
    ring: "ev-fixture", protoRing: false, plans: 1, passDeadlineAtMs: Date.now() + 5000,
    simRejects: new BlockScanSimRejectCache(), profitTokenValuation: scanned,
    signal: controller.signal, collectBlindAudit: true,
    strategyVersions: { strategy_view_version: "ev-fixture", blockscan_view_hash: hash },
    onSuccessfulSimulation: input.mutateAfterObservation ? () => {
      raw.baseFeePerGas = "0xffff"; raw.gasUsed = "0x1"; raw.timestamp = "0x1";
    } : undefined,
  });
  return { run, calls, simulations: () => simulations, close: () => runtime.close() };
}

test("production atomic path reuses its own pre-sim header and keeps a fresh combined canonical check", async () => {
  const f = atomicFixture();
  try {
    const result = await f.run();
    assert.equal(result.decision, "blockscan_submit_disabled"); assert.equal(result.finalSimStatus, "succeeded");
    assert.equal(result.audit?.ev.reason, "ev_gate_pass"); assert.equal(f.simulations(), 1);
    assert.deepEqual(f.calls, ["raw:latest", "raw:latest"]);
    await f.run();
    assert.deepEqual(f.calls, ["raw:latest", "raw:latest", "raw:latest", "raw:latest"],
      "a later invocation must obtain and check its own source observations");
  } finally { f.close(); }
});

for (const rawPatch of [{ baseFeePerGas: undefined }, { baseFeePerGas: "0x0a" }, { gasLimit: "not-a-quantity" }]) {
  test(`production incomplete header retains provider fallback before the combined check (${String(Object.values(rawPatch)[0])})`, async () => {
    const f = atomicFixture({ rawPatch });
    try {
      const result = await f.run(); assert.equal(result.decision, "blockscan_submit_disabled");
      assert.deepEqual(f.calls, ["raw:latest", "fee:100", "raw:latest"]);
    } finally { f.close(); }
  });
}

test("production post-sim reorg still rejects the combined EV decision", async () => {
  const f = atomicFixture({ afterHash: otherHash });
  try { assert.equal((await f.run()).decision, "blockscan_stale_after_sim"); assert.equal(f.simulations(), 1);
    assert.deepEqual(f.calls, ["raw:latest", "raw:latest"]);
  } finally { f.close(); }
});

test("production header observation is detached before callbacks can mutate RPC response", async () => {
  const f = atomicFixture({ mutateAfterObservation: true });
  try { assert.equal((await f.run()).audit?.ev.reason, "ev_gate_pass");
    assert.deepEqual(f.calls, ["raw:latest", "raw:latest"]);
  } finally { f.close(); }
});

test("production failed pinned final simulation performs no unused EV reads", async () => {
  const f = atomicFixture({ simProfit: 0n });
  try { assert.equal((await f.run()).decision, "sim_revert"); assert.equal(f.simulations(), 1);
    assert.deepEqual(f.calls, ["raw:latest"]);
  } finally { f.close(); }
});

test("historical production path uses its pinned header and a fresh combined source check", async () => {
  const f = atomicFixture({ historical: true });
  try { assert.equal((await f.run()).decision, "blockscan_submit_disabled"); assert.equal(f.simulations(), 1);
    assert.deepEqual(f.calls, ["raw:0x64", "raw:0x64"]);
  } finally { f.close(); }
});

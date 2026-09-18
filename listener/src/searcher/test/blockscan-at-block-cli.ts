import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { parseAtBlockArgs, atBlockJson, parseAtBlockJson } from "../blockscan-at-block-cli.js";
import { maybeSubmitBlockScanAtomic, resolveBlockScanAtomicPolicy, resolveBlockScanCoreConfig } from "../main.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { DEFAULT_PROFIT_TOKEN_VALUATION } from "../profit-token-valuation.js";

const base = ["--ready", "ready.json", "--block", "123", "--out", "logs/new-run"];
test("CLI requires explicit immutable inputs and has no broadcast/target-route option", () => {
  assert.equal(parseAtBlockArgs(base)?.through, "ev");
  assert.equal(parseAtBlockArgs([...base, "--spread-bps", "0"])?.["spread-bps"], "0");
  for (const extra of [["--broadcast"], ["--target-tx", "0x12"], ["--prices", "other.json"], ["--through", "live"]])
    assert.throws(() => parseAtBlockArgs([...base, ...extra]));
  for (const block of ["latest", "-1", "1.2", "9007199254740992", "0"])
    assert.throws(() => parseAtBlockArgs(["--ready", "r", "--out", "o", "--block", block]));
  assert.throws(() => parseAtBlockArgs([...base, "--offline"]));
  assert.equal(parseAtBlockArgs(["--prices", "p", "--out", "o", "--block", "123", "--offline"])?.through, "enumerate");
});

test("price serialization preserves bigint, readonly maps, sets and unavailable infinity", () => {
  const values = { amount: 123456789012345678901n, rates: new Map([["a", { num: 3n, den: 7n }]]),
    coverage: new Set(["a", "b"]), unbounded: Infinity };
  assert.deepEqual(parseAtBlockJson(atBlockJson(values)), values);
});

test("CLI and live share the same policy resolvers, without changing defaults", () => {
  const cfg = resolveBlockScanCoreConfig({});
  assert.equal(cfg.maxHops, 6); assert.equal(cfg.minSpreadBps, 100);
  assert.equal(cfg.usdSignalPairsPerToken, 20);
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_USD_SIGNAL_PAIRS_PER_TOKEN:"1"}).usdSignalPairsPerToken, 1);
  assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_USD_SIGNAL_PAIRS_PER_TOKEN:"0"}), /positive safe integer/);
  assert.equal(cfg.exactAdmissionSpreadBps, 50); assert.equal(cfg.maxCandidates, 100);
  assert.equal(cfg.budgetMs, 1500);
  const policy = resolveBlockScanAtomicPolicy({});
  assert.equal(policy.maxProfitBpsOfFlash, 10000n);
  assert.equal(policy.dryRun, false); assert.equal(policy.blockScanSubmit, false);
  assert.equal(policy.evGate, false);
});

test("historical mode is mechanically forbidden with live signing/submission posture", async () => {
  for (const config of [{ dryRun: false, blockScanSubmit: false }, { dryRun: true, blockScanSubmit: true }])
    await assert.rejects(maybeSubmitBlockScanAtomic({ historicalReadOnly: true, config } as any), /requires dry-run/);
});

for (const historicalReadOnly of [false, true]) {
  test(`${historicalReadOnly ? "historical" : "live"} final gate reads ${historicalReadOnly ? "explicit source" : "latest"}, never accepts a wrong hash`, async () => {
    const hash = `0x${"ab".repeat(32)}`;
    const calls: unknown[][] = [];
    const provider = { async send(method: string, params: unknown[]) {
      calls.push([method, params]); return { number: "0x7b", hash: `0x${"cd".repeat(32)}` };
    } };
    const result = await maybeSubmitBlockScanAtomic({ historicalReadOnly,
      config: { ...resolveBlockScanAtomicPolicy({}), dryRun: true, blockScanSubmit: false, finalVerifyFloorBps: 0n },
      provider: provider as any, sourceBlock: 123, sourceBlockHash: hash, sourceGeneration: 1,
      opp: { seedEdges: [], flashToken: ethers.ZeroAddress, affectedTokens: [], cycleId: "fixture", cycleFingerprint: "fixture" } as any,
      resolved: { root: { adapterId: "erc20-transfer", target: ethers.ZeroAddress, children: [] }, netProfit: 1n, flashAmount: 100n } as any,
      finalSimulationRuntime: { execute() { throw new Error("wrong source must not reach sim"); } } as any,
      bundleRouter: { async submit() { throw new Error("must not submit"); } },
      submissionCoordinator: { offer() { throw new Error("must not submit"); } },
      ring: "fixture", protoRing: false, plans: 1, passDeadlineAtMs: Date.now() + 1000,
      simRejects: new BlockScanSimRejectCache(), profitTokenValuation: DEFAULT_PROFIT_TOKEN_VALUATION,
      signal: new AbortController().signal, collectBlindAudit: true,
      strategyVersions: { strategy_view_version: "fixture", blockscan_view_hash: hash },
    });
    assert.equal(result.decision, "blockscan_stale_state");
    assert.equal(result.finalSimStatus, "not-run"); assert.equal(result.submitted, false);
    assert.deepEqual(calls, [["eth_getBlockByNumber", [historicalReadOnly ? "0x7b" : "latest", false]]]);
  });
}

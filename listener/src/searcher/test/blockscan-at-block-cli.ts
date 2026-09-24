import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { parseAtBlockArgs, atBlockJson, parseAtBlockJson, parseHistoricalExecutorRuntimeCode } from "../blockscan-at-block-cli.js";
import { maybeSubmitBlockScanAtomic, resolveBlockScanAtomicPolicy, resolveBlockScanCoreConfig, resolveBlockScanRefineCandidates } from "../main.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { DEFAULT_PROFIT_TOKEN_VALUATION } from "../profit-token-valuation.js";
import { BLOCKSCAN_ENUMERATION_DEFAULTS } from "../blockscan-enumeration-config.js";

const base = ["--ready", "ready.json", "--block", "123", "--out", "logs/new-run"];
test("live and historical policy allow WBTC starts with an eight-decimal search cap", () => {
  const tokens = resolveBlockScanCoreConfig({}).pricedTokens;
  assert.equal(tokens.size, 5);
  assert.equal(tokens.get("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599")?.maxBorrow, 50n * 10n ** 8n);
  assert.equal(tokens.get("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2")?.maxBorrow, 2_000n * 10n ** 18n);
  assert.equal(tokens.get("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")?.maxBorrow, 5_000_000n * 10n ** 6n);
  assert.equal(tokens.get("0xdac17f958d2ee523a2206206994597c13d831ec7")?.maxBorrow, 5_000_000n * 10n ** 6n);
  assert.equal(tokens.get("0x6b175474e89094c44da98b954eedeac495271d0f")?.maxBorrow, 5_000_000n * 10n ** 18n);
});
test("historical executor code is opt-in, hash-bound and cannot override account state", () => {
  assert.throws(() => parseAtBlockArgs([...base, "--executor-runtime-code", "code.json"]));
  assert.throws(() => parseAtBlockArgs(["--prices", "p", "--block", "123", "--out", "o", "--offline",
    "--execution-mode", "source-block", "--executor-runtime-code", "code.json"]));
  assert.equal(parseAtBlockArgs([...base, "--execution-mode", "source-block", "--executor-runtime-code", "code.json"])?.executionMode, "source-block");
  const valid = { code: "0x6000", keccak256: ethers.keccak256("0x6000") };
  assert.deepEqual(parseHistoricalExecutorRuntimeCode(JSON.stringify(valid)), valid);
  for (const value of [{...valid, balance: "0x1"}, {...valid, stateDiff: {}}, {...valid, code: "0x6001"},
    {...valid, code: "0x"}, {...valid, keccak256: "bad"}, null, []])
    assert.throws(() => parseHistoricalExecutorRuntimeCode(JSON.stringify(value)));
});
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

test("CLI and live share joint-DFS defaults and retain explicit rollback methods", () => {
  const cfg = resolveBlockScanCoreConfig({});
  assert.equal(cfg.allowRepeatedPools, true);
  assert.equal(cfg.enumerationMethod, "joint-dfs");
  assert.equal(cfg.enumerationBackend, "typescript");
  assert.equal(cfg.rustEnumerationThreads, 1);
  assert.equal(cfg.rustEnumerationScratchMb, 512);
  assert.equal(BLOCKSCAN_ENUMERATION_DEFAULTS.rustEnabled, false);
  assert.equal(resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_ENUMERATION_BACKEND: "typescript",
    SEARCHER_BLOCKSCAN_ENUMERATION_METHOD: "dfs" }).enumerationBackend, "typescript");
  for (const method of ["joint-dfs", "dfs", "layered"])
    assert.throws(() => resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_ENUMERATION_BACKEND: "rust",
      SEARCHER_BLOCKSCAN_ENUMERATION_METHOD: method }), /Rust enumeration is disabled/);
  const nativeKnobsOff = resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_RUST_THREADS: "8",
    SEARCHER_BLOCKSCAN_RUST_SCRATCH_MB: "bad" });
  assert.equal(nativeKnobsOff.rustEnumerationThreads, 1);
  assert.equal(nativeKnobsOff.rustEnumerationScratchMb, 512);
  for (const raw of ["", "auto", "js"])
    assert.throws(() => resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_ENUMERATION_BACKEND: raw }), /must be rust or typescript/);
  for (const method of ["joint-dfs", "dfs", "layered"]) for (const reuse of ["0", "1"]) for (const dedup of ["0", "1"]) {
    const current = resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_ALLOW_REPEATED_POOLS_ENABLED: reuse,
      SEARCHER_BLOCKSCAN_DEDUP_ROTATIONS_ENABLED: dedup, SEARCHER_BLOCKSCAN_ENUMERATION_METHOD: method });
    assert.equal(current.allowRepeatedPools, reuse === "1");
    assert.equal(current.deduplicateRotations, dedup === "1");
    assert.equal(current.enumerationMethod, method);
  }
  for (const raw of ["", "false", "2"])
    assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_ALLOW_REPEATED_POOLS_ENABLED:raw}), /must be 0 or 1/);
  assert.equal(cfg.deduplicateRotations, true, "default keeps one funded execution start per cycle");
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_DEDUP_ROTATIONS_ENABLED:"0"}).deduplicateRotations, false);
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_DEDUP_ROTATIONS_ENABLED:"1"}).deduplicateRotations, true);
  assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_DEDUP_ROTATIONS_ENABLED:"false"}), /must be 0 or 1/);
  assert.equal(cfg.maxHops, 6); assert.equal(cfg.minSpreadBps, 100);
  assert.equal(cfg.usdSignalPairsPerToken, 20);
  assert.equal(cfg.hopQuotesPerPair, 1);
  for (const n of ["0", "1", "2", "20"])
    assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_HOP_QUOTES_PER_PAIR:n}).hopQuotesPerPair, Number(n));
  for (const n of ["", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])
    assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_HOP_QUOTES_PER_PAIR:n}), /nonnegative safe integer/);
  assert.equal(resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_USD_SIGNAL_PAIRS_PER_TOKEN:"1"}).usdSignalPairsPerToken, 1);
  assert.throws(() => resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_USD_SIGNAL_PAIRS_PER_TOKEN:"0"}), /positive safe integer/);
  assert.equal(cfg.exactAdmissionSpreadBps, 50); assert.equal(cfg.maxCandidates, 100);
  assert.equal(cfg.budgetMs, 15000);
  assert.equal(resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_SCAN_BUDGET_MS: "1500" }).budgetMs, 1500,
    "explicit historical budgets remain configurable");
  const policy = resolveBlockScanAtomicPolicy({});
  assert.equal(policy.maxProfitBpsOfFlash, 10000n);
  assert.equal(policy.dryRun, false); assert.equal(policy.blockScanSubmit, false);
  assert.equal(policy.evGate, false);
});

test("live and historical enumeration share the 512 coarse and 100 downstream defaults", () => {
  const cfg = resolveBlockScanCoreConfig({});
  assert.equal(resolveBlockScanRefineCandidates({}, cfg.maxCandidates), 512);
  assert.equal(cfg.maxCandidates, 100);
  const small = resolveBlockScanCoreConfig({SEARCHER_BLOCKSCAN_MAX_CANDIDATES:"100"});
  assert.equal(small.maxCandidates, 100, "downstream cap remains explicitly configurable");
  assert.equal(resolveBlockScanRefineCandidates({}, small.maxCandidates), 512);
  assert.equal(resolveBlockScanRefineCandidates({SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:"512"}, small.maxCandidates), 512);
  assert.equal(resolveBlockScanRefineCandidates({SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:"4096"}, cfg.maxCandidates), 4096);
  assert.equal(resolveBlockScanRefineCandidates({SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:"12.9"}, 0), 12);
  assert.equal(resolveBlockScanRefineCandidates({SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:"0"}, cfg.maxCandidates), 100);
  for (const raw of ["NaN", "Infinity", "invalid"])
    assert.equal(resolveBlockScanRefineCandidates({SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:raw}, cfg.maxCandidates), 512);
  assert.equal(resolveBlockScanRefineCandidates({}, 3000), 3000, "coarse cap cannot be smaller than final cap");
});

test("enumeration defaults have one source and prefix pruning is explicitly configurable", () => {
  const defaults = BLOCKSCAN_ENUMERATION_DEFAULTS;
  const cfg = resolveBlockScanCoreConfig({});
  assert.equal(cfg.maxHops, defaults.maxHops);
  assert.equal(cfg.maxCandidates, defaults.maxCandidates);
  assert.equal(resolveBlockScanRefineCandidates({}), defaults.refineCandidates);
  assert.equal(cfg.budgetMs, defaults.budgetMs);
  assert.equal(cfg.enumerationMethod, defaults.method);
  assert.equal(cfg.enumerationBackend, defaults.backend);
  assert.equal(cfg.rustEnumerationThreads, defaults.rustThreads);
  assert.equal(cfg.rustEnumerationScratchMb, defaults.rustScratchMb);
  assert.equal(cfg.allowRepeatedPools, defaults.allowRepeatedPools);
  assert.equal(cfg.deduplicateRotations, defaults.deduplicateRotations);
  assert.equal(cfg.usdSignalPairsPerToken, defaults.signalPairsPerToken);
  assert.equal(cfg.minSpreadBps, defaults.minSpreadBps);
  assert.equal(cfg.exactAdmissionSpreadBps, defaults.exactAdmissionSpreadBps);
  assert.equal(cfg.minCapitalFraction, defaults.minCapitalFraction);
  assert.equal(cfg.prefixPruningEnabled, true);
  assert.equal(cfg.maxPrefixDrawdownBps, 0);
  for (const enabled of ["0", "1"]) for (const drawdown of [0, 1000, 2000, 10000]) {
    const current = resolveBlockScanCoreConfig({
      SEARCHER_BLOCKSCAN_PREFIX_PRUNING_ENABLED: enabled,
      SEARCHER_BLOCKSCAN_MAX_PREFIX_DRAWDOWN_BPS: String(drawdown),
    });
    assert.equal(current.prefixPruningEnabled, enabled === "1");
    assert.equal(current.maxPrefixDrawdownBps, drawdown);
  }
  for (const raw of ["", "false", "true", "2", "-1"]) {
    assert.throws(() => resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_PREFIX_PRUNING_ENABLED: raw }), /must be 0 or 1/);
  }
  for (const raw of ["", " ", "-1", "10001", "1.5", "NaN", "Infinity", "1e3", "0x10", "9007199254740992"]) {
    assert.throws(() => resolveBlockScanCoreConfig({ SEARCHER_BLOCKSCAN_MAX_PREFIX_DRAWDOWN_BPS: raw }), /integer from 0 to 10000/);
  }
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

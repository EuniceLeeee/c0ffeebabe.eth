import assert from "node:assert/strict";
import { blockScanRouteId, blockScanRouteLocator } from "./blockscan-route-identity.js";
import { initEvents, makeBlockScanOpportunityId } from "./events.js";
import { initBlockScanEnumerationSolverTelemetry } from "./blockscan-enumeration-solver-telemetry.js";
import { createSolverExecutionInputRecorder } from "./solver-execution-input-recorder.js";
import { LiveRpcThrottleObservation } from "./rpc-throttle-guard.js";
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { AnvilStateBackend, type StateCallControl } from "../shared/state/state-backend.js";
import { activeReadyMemos, UniverseRebuildCheckpointStore } from "./universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "./universe-rebuild-production.js";
import { resolveStrictReadyRuntime } from "./strict-ready-runtime.js";
import { assertReadyFamilyActivation } from "./universe-rebuild-runner.js";
import { assertFamilyActivationEnvironment } from "./venues/production-families/activation.js";
import { StrictReadyGraphViewCoordinator } from "./strict-ready-graph-view.js";
import { StrictProductionRuntimeRoot, type StrictReadyFundingAsset } from "./strict-production-runtime-session.js";
import { assertIssuedPreparedFamilyInstance, type PreparedFamilyInstance } from "./venues/adapter-family-runtime.js";
import { familyId } from "./venues/adapter-family-identifiers.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog,
  PRODUCTION_FAMILY_ACTIVATIONS } from "./venues/production-family-composition.js";
import { PRODUCTION_STRICT_FAMILY_DECLARATIONS as declarations } from "./strict-production-family-declarations.js";
import { BlockScanRuntimeLoop } from "./blockscan-runtime-loop.js";
import { createBlockScanPriceRuntime, createLiveSourceSimulationFactory, createBlockScanLiveAmountSelectorFactory, logBlockScanAmountEvent, maybeSubmitBlockScanAtomic,
  resolveBlockScanCoreConfig, resolveBlockScanRefineCandidates, resolveBlockScanAtomicPolicy, resolveBlockScanLiveStageSettings } from "./main.js";
import { readBlockTouchedStateKeys } from "./blockscan-touched-state.js";
import { BlockScanActivityPrefetch } from "./blockscan-activity-prefetch.js";
import { createBlockScanActivityTransport } from "./blockscan-activity-transport.js";
import { LivePricingContinuationStore, LivePricingContinuationWriter, liveContinuationIdentity } from "./blockscan-live-continuation.js";
import { ADDR } from "../shared/constants/addresses.js";
import { RethTransportScheduler, type RethTransportLane, type RethTransportLease } from "./reth-transport-scheduler.js";
import { parseBlockScanObservedHeader, readBlockScanObservedHeader } from "./blockscan-observed-header.js";
import { TemplatePlanner } from "./planner/planner.js";
import { AnvilSolver } from "./solver/solver.js";
import { BotVMSimulator } from "./simulator/botvm-simulator.js";
import { EthSimulateV1Simulator, buildEthSimulateV1ExecutionInput } from "./simulator/eth-simulate-v1.js";
import { SourceBlockSimulator } from "./simulator/source-block.js";
import { resolveBlockScanSolverSearchConfig } from "./blockscan-solver-search-config.js";
import { BlockScanSimRejectCache } from "./blockscan-sim-reject-cache.js";
import { createBlockScanStartupExecutionPreflight } from "./blockscan-startup-execution-preflight.js";
import { createStartupNodeSimulation } from "./blockscan-startup-node-simulation.js";
import { cliStartupReplay, defaultStartupTable, readStartupTable, readCompatibleStartupTable, writeStartupTable, applyStartupTargetFilters,
  startupTableImplementation, type StartupTableIdentity } from "./blockscan-startup-table-cli.js";
import { BlockScanPoolRevertAttributor, poolRevertFilterEnabled } from "./blockscan-pool-revert.js";
import { rawExecutionEntryEnabled, canUseRawExecuteCalldata, dryRunBotVmCodeOverrideEnabled,
  loadBotVmRuntimeCode } from "../shared/executor/botvm-executor.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";
import { DEFAULT_PROFIT_TOKEN_VALUATION } from "./profit-token-valuation.js";
import { createBlockScanExecutionAvailability } from "./blockscan-pending-evidence.js";
import { detectProductionBlockScanOpportunities, assertAtomicBlockScanRuntime } from "./detector/blockscan-scanner-production.js";
import type { AdapterRuntimeSnapshot } from "./adapter-runtime-coordinator.js";
import { readHistoricalLiveMids, historicalRejectedRoutes, historicalRankedRouteEligibility, historicalExperimentReverts } from "./blockscan-at-block-history.js";
import { scanBlockStateFromResolvedMids } from "./detector/blockscan-scanner-core.js";
import { buildBlockScanEthView, publishedEffectiveIncrementalStatistics } from "./blockscan-eth-view.js";
import { createEffectiveQuoteSessions, resolveEffectiveAmountCascade } from "./blockscan-effective-mid.js";
import { readHistoricalBenchmarkBaseline, historicalBenchmarkSummary, assertHistoricalSamplingPolicy,
  type HistoricalBenchmarkSample } from "./blockscan-historical-benchmark.js";

const HELP = `Usage: npm run searcher:at-block -- --ready CHECKPOINT --block NUMBER --out NEW_DIRECTORY
  --prices FILE          Reuse a saved price-table's Ready; refresh at --block.
  --offline              Enumerate saved prices without RPC (requires matching --block).
  --live-mids MANIFEST    With --ready: restore effective data; offline enumerate, or live runHead continuation.
                        Online continuation acquires fresh strict/Funding authority; does not reprice.
  --max-candidates COUNT  Diagnostic coarse and downstream caps; original live defaults are unchanged.
  --experiment-reverts FILE  Verified P failures from this historical experiment; not prior live knowledge.
  --rejected-routes FILE  With --live-mids: exclude observed prior complete-route rejections before caps.
                        Same run/source required; preserves proof records, no live cache mutation.
  --through STAGE        prices | enumerate | solver | ev (default: ev).
  --through-block NUMBER With --benchmark-baseline: consecutive production state passes (max 250).
                        Requires an existing complete baseline. No cold start or full-table warmup.
  --benchmark-baseline FILE  Restore a saved B baseline, then measure --block B+1 (optionally --through-block).
                        Production runHead handles state through EV. No full-table bootstrap.
                        Repeat this command with the SAME baseline and a NEW --out for independent trials.
                        Load/restore/output costs are outside measured passes; no opaque Exact authority is saved.
  --startup-table FILE   CLI startup observations (default: BASELINE.startup.json).
  --startup-compatibility FILE  Explicit reviewed producer/consumer code manifest; historical baseline only.
  --startup-revert-filter 0|1  Target reverts use the run-local sim pool filter (env SEARCHER_BLOCKSCAN_STARTUP_REVERT_FILTER; default: 0).
                        Matching baseline/execution required; never feeds live rejection filters.
  --startup-table-only   Validate/read the startup table, then exit without RPC or block execution.
  --import-startup-results DIR  With --startup-table-only: import a completed full prefix-test result.
  --refresh-startup-table Explicitly simulate startup again and save a NEW table; never overwrite.
  --amount-selector MODE solver (default) | sim (shared live autonomous amount search).
  --only-enumerated-rank NUMBER  Size one naturally emitted candidate within the normal downstream cap.
                        Full enumeration is saved unchanged; no route/amount injection.
  --spread-bps NUMBER    Enumeration spread; 50 = 0.5%, 0 = strictly >0%.
  --admission-bps NUMBER Exact/Solver admission; default is the live policy.
  --funding-token ADDRESS Add an enumeration start from verified snapshot funding (repeatable).
                        Uses its available amount as search cap; no funding discovery/injection.
                        Existing default caps and rotation-dedup policy remain in effect.
  --budget-ms NUMBER     Historical preparation budget (default: 120000); benchmark block budgets use live settings.
  --run-budget-ms NUMBER Whole-window deadline after Ready load (default: --budget-ms; max: 43200000).
  --pricing-batch-size 32|64|1000  Existing-baseline transport experiment; cap producer-bulk batches only.
                        Production scheduler, retry policy and 8-batch source pricing concurrency remain unchanged.
  --effective-weth-input ETH  Fixed positive P in ETH units; online repricing only.
  --env-file FILE        Read RPC URL, public executor/owner and simulator path only.
  --executor ADDRESS --owner ADDRESS  Public execution identity, required through EV.
  --revm-bin FILE        Existing strict quote-simulation engine.
  --execution-mode MODE next-block (default) | source-block (historical only).
  --executor-runtime-code FILE  Hash-bound {code, keccak256}; online only, no deployment.
No discovery/rebuild, latest-head subscription, signing or broadcasting.
--block is the end-state source. source-block executes that block's environment
using pinned REVM plus debug_traceCall charged gas, and that block's fee in EV.
Default next-block simulation remains eth_simulateV1; no implicit fallback.
Prices from a newer Ready are explicitly hindsight-topology diagnostics, not discovery proof.
`;

export function parseAtBlockArgs(argv: string[]) {
  const { values: v } = parseArgs({ args: argv, allowPositionals: false, options: {
    ready: { type: "string" }, prices: { type: "string" }, block: { type: "string" }, out: { type: "string" },
    through: { type: "string" }, offline: { type: "boolean" }, help: { type: "boolean" },
    "spread-bps": { type: "string" }, "admission-bps": { type: "string" }, "budget-ms": { type: "string" },
    "run-budget-ms": { type: "string" }, "pricing-batch-size": { type: "string" },
    "env-file": { type: "string" }, executor: { type: "string" }, owner: { type: "string" }, "revm-bin": { type: "string" },
    "execution-mode": { type: "string" },
    "amount-selector": { type: "string" },
    "only-enumerated-rank": { type: "string" },
    "executor-runtime-code": { type: "string" },
    "funding-token": { type: "string", multiple: true },
    "effective-weth-input": { type: "string" },
    "live-mids": { type: "string" }, "rejected-routes": { type: "string" },
    "max-candidates": { type: "string" },
    "experiment-reverts": { type: "string" },
    "through-block": { type: "string" },
    "benchmark-baseline": { type: "string" },
    "startup-table": { type: "string" }, "startup-table-only": { type: "boolean" },
    "startup-compatibility": { type: "string" },
    "startup-revert-filter": { type: "string" },
    "import-startup-results": { type: "string" }, "refresh-startup-table": { type: "boolean" },
  } });
  if (v.help) return null;
  assert(v["startup-revert-filter"] === undefined || ["0", "1"].includes(v["startup-revert-filter"]!),
    "--startup-revert-filter must be 0 or 1");
  assert(v["startup-revert-filter"] !== "1" || (v["benchmark-baseline"] && !v["startup-table-only"]),
    "startup filtering requires an executing existing-baseline benchmark");
  assert(!(v["startup-table"] || v["startup-table-only"] || v["import-startup-results"] || v["refresh-startup-table"]) ||
    v["benchmark-baseline"], "startup table options require --benchmark-baseline");
  assert(!v["import-startup-results"] || v["startup-table-only"], "startup import requires --startup-table-only");
  assert(!v["refresh-startup-table"] || !v["startup-table-only"], "refresh runs simulations; incompatible with table-only");
  assert(!v["startup-compatibility"] || (v["benchmark-baseline"] &&
    !v["refresh-startup-table"] && !v["import-startup-results"]),
    "startup compatibility is read-only existing-baseline reuse; refresh/import forbidden");
  const block = Number(v.block), budgetMs = Number(v["budget-ms"] ?? "120000");
  const runBudgetMs = Number(v["run-budget-ms"] ?? budgetMs);
  const pricingBatchSize = v["pricing-batch-size"] === undefined ? undefined : Number(v["pricing-batch-size"]);
  assert(pricingBatchSize === undefined || (v["benchmark-baseline"] && [32, 64, 1000].includes(pricingBatchSize)),
    "--pricing-batch-size requires an existing baseline and 32, 64 or 1000");
  assert(v.block && /^\d+$/.test(v.block) && Number.isSafeInteger(block) && block > 0, "--block must be an explicit positive block number");
  assert(v.ready || v.prices, "--ready or --prices is required");
  assert(!(v.ready && v.prices), "Use one input: --ready or --prices");
  assert(v.out, "--out is required");
  const through = v.through ?? (v.offline ? "enumerate" : "ev");
  const throughBlock = v["through-block"] === undefined ? undefined : Number(v["through-block"]);
  if (throughBlock !== undefined) {
    assert(/^\d+$/.test(v["through-block"]!) && Number.isSafeInteger(throughBlock) &&
      throughBlock > block && throughBlock - block < 250, "--through-block requires 2..250 consecutive blocks");
    assert(v.ready && !v.prices && !v.offline && !v["live-mids"] && v["benchmark-baseline"],
      "--through-block requires an existing complete benchmark baseline; cold-start windows are disabled");
  }
  const executionMode = v["execution-mode"] ?? "next-block";
  const amountSelector = v["amount-selector"] ?? (v["benchmark-baseline"] ? "sim" : "solver");
  assert(amountSelector === "solver" || amountSelector === "sim", "invalid --amount-selector");
  assert(executionMode === "next-block" || executionMode === "source-block", "invalid --execution-mode");
  if (v["benchmark-baseline"]) {
    assert(v.ready && !v.prices && !v.offline && !v["live-mids"] && !v["funding-token"]?.length &&
      !v["executor-runtime-code"] && !v["only-enumerated-rank"] && !v["max-candidates"] && executionMode === "next-block",
    "benchmark requires the original Ready and production next-block pipeline, without stage/route injection");
    assert(!v["amount-selector"] || v["amount-selector"] === "sim",
      "benchmark uses the live simulation amount selector");
  }
  assert(!v["executor-runtime-code"] || !v.offline, "--executor-runtime-code requires online mode");
  assert(through === "prices" || through === "enumerate" || through === "solver" || through === "ev", "invalid --through");
  assert(!v.offline || ((v.prices || v["live-mids"]) && through === "enumerate"),
    "--offline requires --prices or --live-mids and --through enumerate");
  assert(!v["live-mids"] || (v.ready && !v.prices && through !== "prices"),
    "--live-mids requires --ready and cannot reprice");
  assert(!v["rejected-routes"] || v["live-mids"], "--rejected-routes requires --live-mids");
  assert(!v["experiment-reverts"] || (v["live-mids"] && v.offline), "--experiment-reverts requires offline live-mids enumeration");
  assert(!v["live-mids"] || !v["funding-token"]?.length, "--live-mids has no verified funding snapshot for extra funding tokens");
  assert(!v["amount-selector"] || (!v.offline && (through === "solver" || through === "ev")), "--amount-selector requires online sizing stage");
  const onlyEnumeratedRank = v["only-enumerated-rank"] === undefined ? undefined : Number(v["only-enumerated-rank"]);
  if (onlyEnumeratedRank !== undefined) {
    assert(/^\d+$/.test(v["only-enumerated-rank"]!) && Number.isSafeInteger(onlyEnumeratedRank) && onlyEnumeratedRank > 0,
      "invalid --only-enumerated-rank");
    assert(!v.offline && (through === "solver" || through === "ev"), "--only-enumerated-rank requires online sizing stage");
  }
  const maxBudgetMs = v["benchmark-baseline"] ? 43_200_000 : 3_600_000;
  assert(Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= maxBudgetMs, "invalid --budget-ms");
  assert(Number.isSafeInteger(runBudgetMs) && runBudgetMs > 0 && runBudgetMs <= maxBudgetMs, "invalid --run-budget-ms");
  const maxCandidates = v["max-candidates"] === undefined ? undefined : Number(v["max-candidates"]);
  assert(maxCandidates === undefined || (/^[1-9]\d*$/.test(v["max-candidates"]!) && Number.isSafeInteger(maxCandidates) && maxCandidates <= 10_000),
    "invalid --max-candidates");
  for (const k of ["spread-bps", "admission-bps"] as const) {
    assert(v[k] === undefined || (/^\d+(?:\.\d+)?$/.test(v[k]!) && Number(v[k]) <= 10_000), `invalid --${k}`);
  }
  const fundingTokens = [...new Set((v["funding-token"] ?? []).map(value => {
    assert(ethers.isAddress(value) && value.toLowerCase() !== ethers.ZeroAddress, "invalid --funding-token address");
    return ethers.getAddress(value).toLowerCase();
  }))];
  let fixedEffectiveWethInput: bigint | undefined;
  if (v["effective-weth-input"] !== undefined) {
    assert(!v.offline && !v["live-mids"], "--effective-weth-input requires online repricing, not frozen effective rows");
    assert(/^\d+(?:\.\d{1,18})?$/.test(v["effective-weth-input"]), "invalid --effective-weth-input");
    fixedEffectiveWethInput = ethers.parseEther(v["effective-weth-input"]);
    assert(fixedEffectiveWethInput > 0n && fixedEffectiveWethInput <= ethers.MaxUint256, "invalid --effective-weth-input");
  }
  return { ...v, throughBlock, maxCandidates, fixedEffectiveWethInput, fundingTokens, executionMode, amountSelector, onlyEnumeratedRank, through: through as "prices" | "enumerate" | "solver" | "ev", block, budgetMs, runBudgetMs, pricingBatchSize, out: resolve(v.out) };
}

/** CLI-only parameter adapter. The production backend itself splits oversized
 * envelopes before HTTP dispatch and uses its original pump/permits/retries. */
export class HistoricalPricingBatchScheduler extends RethTransportScheduler {
  constructor(options: ConstructorParameters<typeof RethTransportScheduler>[0], private readonly batchSize?: number) {
    super(options);
    assert(batchSize === undefined || [32, 64, 1000].includes(batchSize));
  }
  override run<T>(lane: RethTransportLane, signal: AbortSignal, work: (lease: RethTransportLease) => Promise<T>): Promise<T> {
    return super.run(lane, signal, lease => {
      if (this.batchSize === undefined || lane !== "producer-bulk") return work(lease);
      const load = lease.load!;
      return work({ ...lease, load: { ...load,
        limits: (size, concurrency, items) => load.limits(Math.min(size, this.batchSize!), concurrency, items),
      } });
    });
  }
}

/** CLI-only post-enumeration selection. The selected object still passes the
 * ordinary admission, Funding, Planner, amount search, final sim and EV gates. */
export function historicalCandidateSelection(planner: TemplatePlanner, rank: number, maxCandidates: number) {
  assert(Number.isSafeInteger(rank) && rank > 0 && rank <= maxCandidates,
    "--only-enumerated-rank must stay within the ordinary downstream candidate cap");
  let selectedRouteId: string | undefined;
  const plan = planner.planBlockScanFromSeedEdges.bind(planner);
  planner.planBlockScanFromSeedEdges = async (...input) => {
    assert(selectedRouteId !== undefined, "natural enumeration must finish before historical planning");
    return blockScanRouteId(input[0].seedEdges) === selectedRouteId ? plan(...input) : [];
  };
  return (result: ReturnType<typeof scanBlockStateFromResolvedMids>) => {
    if ("selectionProvenance" in result) {
      const production = result as ReturnType<typeof detectProductionBlockScanOpportunities>;
      assert.equal(production.selectionProvenance.kind, "natural_coarse_ranked");
      assert.equal(production.forcedSelectionCount, 0);
      assert.equal(production.selectionMode, "production");
    } else {
      assert.equal(result.selection.mode, "natural_ranked");
      assert.equal(result.selection.forcedSelectionCount, 0);
    }
    const opportunity = result.opportunities[rank - 1];
    assert(opportunity, "requested rank is absent from natural enumeration");
    selectedRouteId = blockScanRouteId(opportunity.seedEdges);
    return { rank, routeId: selectedRouteId, enumeratedCandidates: result.opportunities.length,
      note: "only this natural candidate is sized; other candidates are intentionally not tested" };
  };
}

/** CLI-only search eligibility, never a synthetic funding offer. The caller
 * validates the atomic snapshot; Planner/Solver retain actual funding checks. */
export function historicalFundingStarts(
  defaults: ReadonlyMap<string, { maxBorrow: bigint }>,
  tokens: readonly string[],
  sources: AdapterRuntimeSnapshot["funding"]["sources"],
): Map<string, { maxBorrow: bigint }> {
  const result = new Map(defaults);
  for (const token of tokens) {
    const source = sources.get(token);
    assert(source && source.amount > 0n, `--funding-token ${token} has no positive verified funding in this snapshot; discover/revalidate Ready and reprice first`);
    const previous = result.get(token)?.maxBorrow;
    result.set(token, { maxBorrow: previous !== undefined && previous < source.amount ? previous : source.amount });
  }
  return result;
}

// Lossless data serialization only. Authority-bearing sessions are always reissued,
// never revived from disk. Supports the existing historical snapshot encoding.
export const atBlockJson = (value: unknown): string => JSON.stringify(value, (_key, v) => {
  if (typeof v === "bigint") return { $type: "bigint", value: v.toString() };
  if (typeof v === "number" && !Number.isFinite(v)) return { $type: "number", value: String(v) };
  if (v && typeof v.entries === "function" && typeof v.get === "function" && typeof v.size === "number")
    return { $type: "map", entries: [...v.entries()] };
  if (v instanceof Set) return { $type: "set", values: [...v] };
  return v;
}, 2) + "\n";
export const parseAtBlockJson = (value: string): any => JSON.parse(value, (_key, v) => {
  if (v?.$type === "bigint") return BigInt(v.value);
  if (v?.$type === "number") return Number(v.value);
  if (v?.$type === "map") return new Map(v.entries);
  if (v?.$type === "set") return new Set(v.values);
  return v;
});
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function parseHistoricalExecutorRuntimeCode(bytes: string) {
  const value = JSON.parse(bytes);
  assert(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2 && Object.keys(value).every(k => ["code", "keccak256"].includes(k)),
    "executor override accepts only code and keccak256");
  assert(typeof value.code === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value.code), "invalid executor runtime code");
  assert(typeof value.keccak256 === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.keccak256)
    && ethers.keccak256(value.code) === value.keccak256.toLowerCase(), "executor runtime code hash mismatch");
  return Object.freeze({ code: value.code.toLowerCase() as string, keccak256: value.keccak256.toLowerCase() as string });
}

/** Historical evidence only: bind the loaded source tree and actual engine,
 * including dirty/untracked runtime files, without trusting a Git HEAD label. */
function historicalImplementation(executablePath: string) {
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const files: [string, string][] = [];
  const visit = (relative: string) => {
    for (const entry of readdirSync(resolve(sourceRoot, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "test" || entry.name === "templates") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push([path, sha256(readFileSync(resolve(sourceRoot, path)))]);
      else throw new Error("historical source tree contains an unsupported file type");
    }
  };
  visit("");
  return { sourceTreeSha256: sha256(JSON.stringify(files)), revmBinarySha256: sha256(readFileSync(executablePath)) };
}

function publicEnvironment(file: string | undefined): Record<string, string> {
  if (!file) return {};
  const allowed = new Set(["MAINNET_RPC_URL", "BOTVM_ADDRESS", "BOTVM_OWNER", "SEARCHER_REVM_SIM_BIN",
    ...PRODUCTION_FAMILY_ACTIVATIONS.flatMap(entry => entry.envKey === null ? [] : [entry.envKey])]);
  const result: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (match && allowed.has(match[1])) result[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return result;
}

/** Diagnostic-only gate; never force the producer's fast path. */
export function assertHistoricalNativeDelta(firstBlock: boolean,
  stats: { nativeDelta: boolean; fullBuild: boolean } | undefined): void {
  assert(stats && (stats.nativeDelta === true || firstBlock && stats.fullBuild === true),
    "historical native-delta guard: expected nativeDelta=true after initialization");
}

export async function runAtBlock(argv: string[]): Promise<void> {
  const args = parseAtBlockArgs(argv);
  if (!args) { console.log(HELP); return; }
  const env = { ...publicEnvironment(args["env-file"]), ...process.env };
  assertFamilyActivationEnvironment(PRODUCTION_FAMILY_ACTIVATIONS, env);
  assert(!existsSync(args.out), "--out must be a new directory; input files are never overwritten");
  mkdirSync(args.out, { recursive: true, mode: 0o700 });
  const setupStarted = performance.now();
  const benchmark = args["benchmark-baseline"] ? readHistoricalBenchmarkBaseline(args["benchmark-baseline"]) : undefined;
  const requireNativeDelta = env.SEARCHER_HISTORICAL_REQUIRE_NATIVE_DELTA === "1";
  if (requireNativeDelta) assert(benchmark, "native-delta guard requires an existing historical baseline");
  if (benchmark) assert.equal(args.block, benchmark.baseline.pricing.pricing.sourceBlock + 1,
    "benchmark must start immediately after its baseline; no same-block prices as completed state");
  let artifactPrefix = "", measuring = false;
  const deferredArtifacts: [string, unknown][] = [];
  const save = (name: string, value: unknown) => {
    if (measuring) { deferredArtifacts.push([artifactPrefix + name, value]); return; }
    writeFileSync(resolve(args.out, artifactPrefix + name), atBlockJson(value), { flag: "wx", mode: 0o600 });
  };
  const executorRuntimeCode = args["executor-runtime-code"]
    ? parseHistoricalExecutorRuntimeCode(readFileSync(args["executor-runtime-code"], "utf8")) : undefined;
  if (executorRuntimeCode) save("executor-runtime-code.json", executorRuntimeCode);
  const startupTablePath = benchmark ? resolve(args["startup-table"] ?? defaultStartupTable(args["benchmark-baseline"]!)) : undefined;
  const startupIdentity: StartupTableIdentity | undefined = benchmark ? {
    baselineSha256: benchmark.sha256, readySha256: benchmark.baseline.readySha256,
    source: benchmark.baseline.pricing.pricing.effectiveMids!.source, chainId: benchmark.baseline.chainId,
    executor: (args.executor ?? env.BOTVM_ADDRESS ?? benchmark.baseline.executor).toLowerCase(),
    owner: (args.owner ?? env.BOTVM_OWNER ?? benchmark.baseline.owner).toLowerCase(),
    executorCode: executorRuntimeCode?.keccak256 ?? "chain", rawEntry: rawExecutionEntryEnabled(process.env.SEARCHER_BOTVM_RAW_ENTRY),
    implementationSha256: startupTableImplementation(),
  } : undefined;
  const startupExpected = benchmark ? new Map([...benchmark.baseline.pricing.pricing.effectiveMids!.rows]
    .filter(([, row]) => row.status === "quoted" && (row.amountOut ?? 0n) > 0n)) : undefined;
  if (args["import-startup-results"]) {
    const resultPath = resolve(args["import-startup-results"], "summary.json");
    const bytes = readFileSync(resultPath), prior = JSON.parse(bytes.toString("utf8"));
    const executionIdentityPath = resolve(args["import-startup-results"], "execution-identity.json");
    const executionIdentityBytes = readFileSync(executionIdentityPath);
    assert.deepEqual(JSON.parse(executionIdentityBytes.toString("utf8")), startupIdentity,
      "original startup execution identity changed; cannot rebind old results to new code/config");
    assert(prior.complete === true && prior.scope === "full" && prior.signing === false &&
      prior.broadcasting === false && prior.repriced === false && prior.filtersAdded === 0,
      "only a completed observe-only full result can be imported");
    assert.equal(prior.baselineSha256, benchmark!.sha256);
    assert.equal(prior.readySha256, benchmark!.baseline.readySha256);
    assert.deepEqual(prior.source, startupIdentity!.source);
    assert.equal(prior.results.length, 1);
    assert.equal(prior.results[0].progress.infrastructureFailures, 0);
    assert.equal(prior.results[0].progress.pending, 0);
    await writeStartupTable(startupTablePath!, { identity: startupIdentity!, expected: startupExpected!,
      observations: resolve(args["import-startup-results"], "observations-0.jsonl"),
      expectedOutcomesSha256: prior.results[0].outcomesSha256,
      provenance: { resultPath, summarySha256: sha256(bytes), executionIdentityPath,
        executionIdentitySha256: sha256(executionIdentityBytes), originalSimulationMs: prior.results[0].elapsedMs } });
  }
  if (args["refresh-startup-table"]) assert(!existsSync(startupTablePath!), "startup table exists; choose a new --startup-table");
  const cachedStartup = benchmark && !args["refresh-startup-table"]
    ? args["startup-compatibility"]
      ? await readCompatibleStartupTable(startupTablePath!, startupIdentity!, startupExpected!, args["startup-compatibility"])
      : await readStartupTable(startupTablePath!, startupIdentity!, startupExpected!) : undefined;
  if (cachedStartup) {
    const { rows: _rows, ...receipt } = cachedStartup;
    save("startup-table-reuse.json", { ...receipt, readMs: performance.now() - setupStarted,
      historicalObservationOnly: true });
    console.log(atBlockJson({ stage: "startup-table", source: cachedStartup.identity.source,
      ...cachedStartup.counts, reused: true, startupSimRequests: 0, filtersAdded: 0 }));
  }
  if (args["startup-table-only"]) {
    assert(cachedStartup);
    save("summary.json", { mode: "startup-table-only", counts: cachedStartup.counts,
      reused: true, networkRequests: 0, startupSimRequests: 0, filtersAdded: 0, signing: false, broadcast: false });
    return;
  }
  // Large Ready files are streamed by their existing store; do not also retain a multi-GiB Buffer.
  const inputBytes = args.prices || args["live-mids"] ? readFileSync(args.ready ?? args.prices!) : undefined;
  const saved = args.prices ? parseAtBlockJson(inputBytes!.toString()) : null;
  const restored = args["live-mids"] ? readHistoricalLiveMids(args["live-mids"], inputBytes!, args.block, catalog) : undefined;
  const rejectBytes = args["rejected-routes"] ? readFileSync(args["rejected-routes"], "utf8") : undefined;
  const rejects = rejectBytes === undefined ? undefined : historicalRejectedRoutes(rejectBytes, restored!);
  const experimentRejects = args["experiment-reverts"] ? historicalExperimentReverts(args["experiment-reverts"], restored!) : undefined;
  await rejects?.verifyEvidence();
  if (rejectBytes !== undefined) save("rejected-routes-input.json", JSON.parse(rejectBytes));
  const configEnv: NodeJS.ProcessEnv = { ...(restored?.config ?? process.env),
    ...(args.maxCandidates === undefined ? {} : { SEARCHER_BLOCKSCAN_MAX_CANDIDATES: String(args.maxCandidates),
      SEARCHER_BLOCKSCAN_REFINE_CANDIDATES: String(args.maxCandidates) }),
    ...(args["spread-bps"] === undefined ? {} : { SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS: args["spread-bps"] }),
    ...(args["admission-bps"] === undefined ? {} : { SEARCHER_BLOCKSCAN_EXACT_ADMISSION_SPREAD_BPS: args["admission-bps"] }),
  };
  const cfg = resolveBlockScanCoreConfig(configEnv);
  if (args.maxCandidates !== undefined) cfg.maxCandidates = args.maxCandidates;
  const coarseCfg = { ...cfg, maxCandidates: args.maxCandidates ?? resolveBlockScanRefineCandidates(configEnv, cfg.maxCandidates) };
  const eligibility = createBlockScanExecutionAvailability({ mode: "periodic", evidence: [],
    familyForEdge: id => declarations.currentHeadEvidenceFamilyForEdge(id),
    edgeScopeKey: edge => declarations.currentHeadEvidenceScopeKeyForEdge(edge),
    evidenceScopeKeys: evidence => declarations.currentHeadEvidenceScopeKeys(evidence),
  });
  if (restored && args.offline) {
    assertFamilyActivationEnvironment(PRODUCTION_FAMILY_ACTIVATIONS, restored.config);
    const historicalConfig = configEnv;
    const historicalCfg = resolveBlockScanCoreConfig(historicalConfig);
    const historicalCoarseCfg = { ...historicalCfg,
      maxCandidates: args.maxCandidates ?? resolveBlockScanRefineCandidates(historicalConfig, historicalCfg.maxCandidates) };
    const prior = rejects || experimentRejects ? historicalRankedRouteEligibility(new Set([
      ...(rejects?.ids ?? []), ...(experimentRejects?.ids ?? []),
    ])) : undefined;
    const start = performance.now();
    const ethView = buildBlockScanEthView(restored.graph, restored.mids, historicalCoarseCfg.ethSignalPairsPerToken, historicalCoarseCfg.allowRepeatedPools);
    const result = scanBlockStateFromResolvedMids({ edges: [...restored.edges], sourceBlock: args.block, swapTouched: null,
      cfg: historicalCoarseCfg, mids: restored.mids, ethView, ...eligibility,
      ...(prior ? { rankedRouteEligible: prior.rankedRouteEligible } : {}), captureCoarseEnumeration: true });
    const wallMs = performance.now() - start;
    save("enumeration.json", result);
    save("summary.json", { mode: "live-mids-coarse-only", block: args.block, runId: restored.runId, source: restored.source,
      input: restored.provenance, cfg: historicalCoarseCfg, downstreamMaxCandidates: historicalCfg.maxCandidates,
      priorRejections: rejects ? { ...rejects.provenance,
        matchedRouteIds: [...prior!.matched].filter(id => rejects.ids.has(id)).sort() } : null,
      experimentRejections: experimentRejects ? { ...experimentRejects.provenance,
        matchedRouteIds: [...prior!.matched].filter(id => experimentRejects.ids.has(id)).sort() } : null,
      wallMs, selection: result.selection, stages: { enumeration: result.outcome, solver: "not-run", sim: "not-run", ev: "not-run" },
      atomicRuntimeValidated: false, networkRequests: 0, broadcast: false });
    console.log(atBlockJson({ block: args.block, stage: "enumerate", mode: "live-mids-coarse-only", wallMs, selection: result.selection }));
    return;
  }
  if (args.offline) {
    const snapshot = (saved.runtime ?? saved) as AdapterRuntimeSnapshot;
    assert.equal(snapshot.sourceBlock, args.block, "saved price source differs from --block; reprice online first");
    assertAtomicBlockScanRuntime(snapshot);
    cfg.pricedTokens = historicalFundingStarts(cfg.pricedTokens, args.fundingTokens, snapshot.funding.sources);
    coarseCfg.pricedTokens = cfg.pricedTokens;
    const adapterIds = new Set([
      ...snapshot.graph.edges.map(edge => edge.adapterId),
      ...[...snapshot.funding.sources.values()].map(source => source.adapterId),
    ]);
    for (const adapterId of adapterIds) {
      try { catalog.ownerOfAction(adapterId); }
      catch { throw new Error(`saved prices contain a disabled or unknown adapter ${adapterId}; regenerate prices with the active plugin settings`); }
    }
    const start = performance.now();
    const result = detectProductionBlockScanOpportunities({ runtime: snapshot, cfg: coarseCfg, swapTouched: null,
      ...eligibility, captureCoarseEnumeration: true });
    const wallMs = performance.now() - start;
    save("enumeration.json", result);
    save("summary.json", { mode: "offline", inputSha256: sha256(inputBytes!), block: args.block,
      sourceHash: snapshot.sourceBlockHash, fundingTokens: args.fundingTokens, cfg: coarseCfg, wallMs, selection: result.selection, broadcast: false });
    console.log(atBlockJson({ block: args.block, stage: "enumerate", wallMs, selection: result.selection }));
    return;
  }

  const rpcUrl = env.MAINNET_RPC_URL;
  assert(rpcUrl && /^https?:\/\//.test(rpcUrl), "MAINNET_RPC_URL is required");
  const executor = args.executor ?? env.BOTVM_ADDRESS;
  const owner = args.owner ?? env.BOTVM_OWNER;
  assert(executor && ethers.isAddress(executor) && owner && ethers.isAddress(owner), "public --executor and --owner required (or BOTVM_ADDRESS/BOTVM_OWNER)");
  const policy = { ...resolveBlockScanAtomicPolicy(configEnv, cfg.maxHops), dryRun: true, blockScanSubmit: false, evGate: true };
  let readyPath = args.ready ?? saved?.readyPath;
  if (!readyPath && args.prices) {
    // Existing frozen historical tables carry Ready provenance in input.json.
    readyPath = JSON.parse(readFileSync(resolve(dirname(args.prices), "input.json"), "utf8")).checkpointPath;
  }
  assert(typeof readyPath === "string", "price table has no Ready provenance");
  readyPath = realpathSync(readyPath);
  const readyHash = await fileSha256(readyPath);
  if (benchmark) assert.equal(benchmark.baseline.readySha256, readyHash, "benchmark Ready changed");
  if (saved?.readySha256) assert.equal(readyHash, saved.readySha256, "saved Ready changed");
  const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load();
  assert(envelope && !envelope.inProgressRun, "completed Ready required; CLI does not rebuild");
  const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
  const identity = { executor: executor.toLowerCase(), transactionOrigin: owner.toLowerCase() };
  const wiring = createRebuildWiring({ rpcUrl, executionIdentity: identity });
  const instances: PreparedFamilyInstance[] = [], funding: StrictReadyFundingAsset[] = [];
  const readyMemos = activeReadyMemos(envelope);
  assertReadyFamilyActivation(readyMemos, wiring.isFamilyEnabled);
  for (const memo of readyMemos) {
    assert([familyDefinitionHash(memo.familyId), familyMemoDefinitionHash(memo.familyId)].includes(memo.familyDefinitionHash),
      `Ready requires existing selective revalidation: ${memo.familyId}; CLI will not rebuild or drop it`);
    const family = catalog.forStrictFamily(familyId(memo.familyId));
    const value = wiring.rehydrateVerifiedInstance({ memo, cutoff: ready.cutoff });
    if (family.plugin.manifest.domain === "funding") {
      assert(value && typeof value === "object" && "asset" in value && typeof value.asset === "string" && ethers.isAddress(value.asset));
      funding.push({ familyId: familyId(memo.familyId), asset: value.asset });
    } else {
      const instance = value as PreparedFamilyInstance;
      assertIssuedPreparedFamilyInstance({ family, instance, source: ready.cutoff, generation: ready.cutoff.generation });
      instances.push(instance);
    }
  }
  assert.equal(instances.length + funding.length, ready.activeInstanceKeys.length);
  for (const token of args.fundingTokens) assert(funding.some(f => f.asset.toLowerCase() === token),
    `--funding-token ${token} is absent from Ready funding; CLI does not discover or inject assets`);
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: ready.cutoff, readyGraph: graph,
    readyInstances: instances, readyFundingAssets: funding });
  const views = new StrictReadyGraphViewCoordinator({ catalog, ready, edges: graph });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("historical window deadline")), args.runBudgetMs);
  const interrupt = () => abort.abort(new Error("historical pass interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const fetch = new ethers.FetchRequest(rpcUrl); fetch.timeout = 30_000;
  const provider = new ethers.JsonRpcProvider(fetch);
  const liveSettings = resolveBlockScanLiveStageSettings(configEnv, cfg.maxCandidates);
  const priceWindow = benchmark !== undefined;
  const scheduler = new HistoricalPricingBatchScheduler(priceWindow ? liveSettings.transport
    : { capacity: 2, producerReserved: 1, transportTimeoutMs: 30_000 }, args.pricingBatchSize);
  const activityTransport = createBlockScanActivityTransport(rpcUrl);
  const activity = new BlockScanActivityPrefetch(activityTransport, abort.signal);
  // Quote-only Solver and direct final sim do not start or fork this legacy resource.
  const state = new AnvilStateBackend(rpcUrl, "http://127.0.0.1:1", 1);
  const executionStates = [state, ...Array.from({ length: benchmark ? liveSettings.solveConcurrency - 1 : 0 },
    () => new AnvilStateBackend(rpcUrl, "http://127.0.0.1:1", 1))];
  let loop: BlockScanRuntimeLoop | undefined;
  let startupExecutionMs = 0;
  let continuationWriter: LivePricingContinuationWriter | undefined;
  let routeTelemetry: Awaited<ReturnType<typeof initBlockScanEnumerationSolverTelemetry>> | undefined;
  let solverInputRecorder: ReturnType<typeof createSolverExecutionInputRecorder> | undefined;
  const priorEventsPath = process.env.SEARCHER_EVENTS_PATH;
  const priorRevertsPath = process.env.SEARCHER_SIM_REVERT_DIAGNOSTICS_PATH;
  let runFailed = false;
  try {
    const chainId = (await provider.getNetwork()).chainId;
    if (benchmark) {
      // Same production writers, isolated historical outputs. Their synchronous
      // work and background worker now participate in the measured passes.
      process.env.SEARCHER_EVENTS_PATH = resolve(args.out, "events.jsonl");
      process.env.SEARCHER_SIM_REVERT_DIAGNOSTICS_PATH = resolve(args.out, "reverts.jsonl");
      const events = initEvents();
      assert.equal(BigInt(events.chainId), chainId);
      const routePath = resolve(args.out, "routes.jsonl");
      solverInputRecorder = createSolverExecutionInputRecorder({ path: resolve(args.out, "solver-inputs.jsonl"),
        runId: events.runId, chainId: events.chainId, runtimeCommit: configEnv.SEARCHER_RUNTIME_COMMIT ?? "",
        maxFileBytes: Number(configEnv.SEARCHER_BLOCKSCAN_SOLVER_INPUTS_MAX_BYTES ?? 10 * 1024 ** 3),
        protectedPaths: [events.path, routePath, readyPath] });
      routeTelemetry = await initBlockScanEnumerationSolverTelemetry({ path: routePath,
        eventsPath: events.path, runId: events.runId });
      assert(routeTelemetry.enabled, "production telemetry must initialize for a live-shaped benchmark");
    }
    // Match live's configured executor, including chain code without overrides.
    // The chain executor supplies the same direct hop evidence as live.
    const finalSimulationExecutorRuntimeCode = dryRunBotVmCodeOverrideEnabled(
      configEnv.SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE, true, false)
      ? loadBotVmRuntimeCode(owner) : executorRuntimeCode;
    if (finalSimulationExecutorRuntimeCode) save("final-simulation-executor-code.json", {
      ...finalSimulationExecutorRuntimeCode, scope: "search/final simulation only; startup table identity unchanged" });
    const sourceSimulationFactory = createLiveSourceSimulationFactory({ rpcUrl, chainId: Number(chainId),
      executablePath: args["revm-bin"] ?? env.SEARCHER_REVM_SIM_BIN,
      timeoutMs: benchmark ? liveSettings.sourceSimulationTimeoutMs : 120_000, runtimeAbort: abort,
      onFatal: reason => abort.abort(new Error(`strict simulator fatal: ${reason.kind}`)) });
    let anchor: ReturnType<typeof parseBlockScanObservedHeader> | undefined;
    let rawAnchor: Record<string, unknown> | undefined;
    const headers = new Map<number, ReturnType<typeof parseBlockScanObservedHeader>>();
    const observeHeader = async (number: number, control: StateCallControl = {
      signal: abort.signal, deadlineAtMs: Date.now() + 30_000,
    }) => {
      assert(number >= (benchmark?.baseline.pricing.raw.sourceBlock ?? args.block) &&
        number <= (args.throughBlock ?? args.block), "header outside requested window");
      abort.signal.throwIfAborted();
      // The raw first header is provenance only, read before any measured pass.
      // Measured window reads use the live cancellable reader, not ethers retries.
      const raw = !priceWindow || !anchor
        ? await provider.send("eth_getBlockByNumber", [ethers.toQuantity(number), priceWindow]) : undefined;
      const header = priceWindow ? await readBlockScanObservedHeader(rpcUrl, chainId, number, control)
        : parseBlockScanObservedHeader(raw, number, chainId);
      if (priceWindow && raw) assert.equal(parseBlockScanObservedHeader(raw, number, chainId).hash, header.hash,
        "historical provenance header reorganized");
      if (headers.has(number)) assert.equal(header.hash, headers.get(number)!.hash, "historical source reorganized");
      const parent = headers.get(number - 1);
      if (parent) assert.equal(header.parentHash, parent.hash, "historical parent chain changed");
      headers.set(number, header);
      if (!anchor) { anchor = header; rawAnchor = raw; }
      return header;
    };
    await observeHeader(args.block);
    const simRejects = new BlockScanSimRejectCache();
    const startupFilterFlag = args["startup-revert-filter"] ?? configEnv.SEARCHER_BLOCKSCAN_STARTUP_REVERT_FILTER ?? "0";
    assert(["0", "1"].includes(startupFilterFlag), "SEARCHER_BLOCKSCAN_STARTUP_REVERT_FILTER must be 0 or 1");
    const startupFilterEnabled = startupFilterFlag === "1";
    assert(!startupFilterEnabled || benchmark, "startup filtering requires an existing-baseline benchmark");
    const startupFilterRows: Readonly<Record<string, unknown>>[] = [];
    const search = resolveBlockScanSolverSearchConfig(configEnv);
    const productionStartup = createBlockScanStartupExecutionPreflight({ ...identity, simRejects,
      concurrency: 32,
      simulateStandalone: createStartupNodeSimulation({ rpcUrl, chainId, ...identity, executorRuntimeCode,
        rawExecutionEntry: benchmark ? rawExecutionEntryEnabled(configEnv.SEARCHER_BOTVM_RAW_ENTRY) : false,
        scheduler, requestsPerSecond: 200 }),
      onObservation: observation => {
        if (startupFilterEnabled) startupFilterRows.push(observation);
        if (args["refresh-startup-table"]) appendFileSync(resolve(args.out, "startup-observations.jsonl"),
          JSON.stringify(observation) + "\n", { mode: 0o600 });
      },
      onProgress: progress => {
        const path = resolve(args.out, "startup-execution-progress.json");
        writeFileSync(path + ".tmp", atBlockJson(progress), { mode: 0o600 });
        renameSync(path + ".tmp", path);
      } });
    const startupExecutionPreflight = cliStartupReplay(productionStartup);
    if (cachedStartup) startupExecutionPreflight.restore(cachedStartup);
    const prices = createBlockScanPriceRuntime({ provider, rpcUrl, ...identity, strictRuntimeRoot: root,
      fixedEffectiveWethInput: args.fixedEffectiveWethInput ?? (priceWindow ? liveSettings.fixedEffectiveWethInput : undefined),
      blockScanRuntimeAbort: abort, blockScanRethTransportScheduler: scheduler, blockScanCfg: cfg,
      isPoolSimRejected: edge => simRejects.hasPool(edge),
      startupExecutionPreflight,
      recordPricing: () => continuationWriter?.capture() });
    const pricingPolicy = { spreadBps: cfg.minSpreadBps,
      fixedWethInput: args.fixedEffectiveWethInput ?? (priceWindow ? liveSettings.fixedEffectiveWethInput : undefined) ?? null,
      cascade: resolveEffectiveAmountCascade(configEnv.SEARCHER_BLOCKSCAN_EFFECTIVE_AMOUNT_CASCADE_ENABLED) };
    if (benchmark) {
      const base = benchmark.baseline, stored = base.pricing;
      assert.equal(base.chainId, String(chainId), "benchmark chain changed");
      assert.equal(base.executor, executor.toLowerCase(), "benchmark executor changed");
      assert.equal(base.owner, owner.toLowerCase(), "benchmark owner changed");
      assertHistoricalSamplingPolicy(base.pricingPolicy, pricingPolicy);
      const header = await observeHeader(stored.pricing.sourceBlock);
      assert.equal(header.hash, stored.pricing.sourceBlockHash, "benchmark source is no longer canonical");
      const rawHeader = await observeHeader(stored.raw.sourceBlock);
      assert.equal(rawHeader.hash, stored.raw.sourceBlockHash, "benchmark raw source is no longer canonical");
      const view = (pricing: typeof stored.pricing) => views.build({ id: "historical-baseline", edges: graph,
        topologyKey: `strict-ready:${ready.generation}:${ready.graphHash}`, generation: pricing.generation,
        sourceBlock: pricing.sourceBlock, sourceBlockHash: pricing.sourceBlockHash });
      await prices.currentRuntimeCoordinator.restoreHistoricalBaseline(stored, { graph: view(stored.pricing),
        rawGraph: view(stored.raw), weth: ADDR.WETH, control: { signal: abort.signal, deadlineAtMs: Date.now() + args.budgetMs } });
      prices.blockScanAmountReference.restoreHistoricalBaseline(base.amounts);
      // The existing B table already finished pricing. Run the production
      // startup execution observations BEFORE B+1's ordinary live pass budget.
      // No quote/price builder or replacement search pipeline is involved.
      const effective = stored.pricing.effectiveMids;
      assert(effective?.complete, "startup execution requires the existing complete effective baseline");
      const source = effective.source;
      const control = { signal: abort.signal, deadlineAtMs: Date.now() + args.budgetMs };
      const sessions = createEffectiveQuoteSessions(requiredEdgeIds => prices.strictSessionFor({
        purpose: "exact-execution", source, control, fundingAssets: [], requiredEdgeIds,
      }));
      const started = performance.now();
      // Startup executes every priced direction, unlike an incremental pass.
      // Keep its counters/revert evidence without per-RPC debug volume. Restore
      // the frozen diagnostic setting before the measured production passes.
      const diagnostics = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
      process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = "0";
      try {
        await startupExecutionPreflight.run({ effective, edges: graph, control,
          prepareQuote: sessions.prepareQuote, sessionFor: sessions.sessionFor });
        await observeHeader(source.number, control);
      } finally {
        if (diagnostics === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
        else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = diagnostics;
        startupExecutionMs = performance.now() - started;
      }
      const filtersAdded = applyStartupTargetFilters({ enabled: startupFilterEnabled,
        rows: cachedStartup?.rows.values() ?? startupFilterRows, edges: graph, cache: simRejects,
        record: event => appendFileSync(resolve(args.out, "startup-pool-filters.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 }) });
      console.log(atBlockJson({ stage: "startup-filter", enabled: startupFilterEnabled, filtersAdded,
        excludedEdges: graph.filter(edge => simRejects.hasPool(edge)).length }));
      save("startup-execution.json", { source, startupExecutionMs, baselineSha256: benchmark.sha256,
        reused: !!cachedStartup, startupTable: startupTablePath, filtersAdded, startupFilterEnabled,
        pricingPerformed: false, scope: "CLI-only; shared run-local sim pool filter", signing: false, broadcast: false });
      if (args["refresh-startup-table"]) await writeStartupTable(startupTablePath!, {
        identity: startupIdentity!, expected: startupExpected!, observations: resolve(args.out, "startup-observations.jsonl"),
        provenance: { runDirectory: args.out, startupExecutionMs } });
    }
    if (benchmark) {
      const store = new LivePricingContinuationStore(resolve(args.out, "continuation"),
        historicalContinuationIdentity(benchmark.sha256, pricingPolicy));
      await store.beginFreshRound();
      const existing = JSON.parse(readFileSync(args["benchmark-baseline"]!, "utf8"));
      await store.seedHistorical(resolve(dirname(args["benchmark-baseline"]!), existing.file), benchmark.sha256,
        { version: 1, identity: store.identity, amounts: prices.blockScanAmountReference.exportHistoricalBaseline(),
          startup: productionStartup.exportContinuation(), simRejects: simRejects.exportContinuation() },
        prices.currentRuntimeCoordinator.latestPricingSnapshot()!.effectiveMids!.source);
      prices.blockScanAmountReference.takeContinuationDelta(); simRejects.takeContinuationDelta();
      productionStartup.takeContinuationDelta(); prices.currentRuntimeCoordinator.takeContinuationDisabled();
      continuationWriter = new LivePricingContinuationWriter({ store, coordinator: prices.currentRuntimeCoordinator,
        amounts: prices.blockScanAmountReference, startup: productionStartup, simRejects, restored: true,
        onEvent: event => console.log(`[searcher/live-continuation] ${JSON.stringify(event)}`) });
      // Reuse existing baseline bytes, not another full export/serialization.
      // Every measured pass uses the exact live delta writer.
    }
    const planner = new TemplatePlanner(); planner.setGraph([...graph]);
    const selectCandidate = args.onlyEnumeratedRank === undefined ? undefined
      : historicalCandidateSelection(planner, args.onlyEnumeratedRank, cfg.maxCandidates);
    planner.setProfitTokenValuation(DEFAULT_PROFIT_TOKEN_VALUATION);
    planner.setMaxCandidates(Number(configEnv.SEARCHER_MAX_CANDIDATES ?? "20"));
    planner.setMaxRotationsPerPath(Number(configEnv.SEARCHER_MAX_ROTATIONS_PER_PATH ?? "3"));
    const poolReverts = benchmark && poolRevertFilterEnabled(configEnv.SEARCHER_BLOCKSCAN_POOL_REVERT_FILTER)
      ? new BlockScanPoolRevertAttributor(simRejects, resolve(args.out, "pool-revert-evidence")) : undefined;
    let sequence = 0;
    let simulationSequence = 0;
    let evSequence = 0;
    let amountEventSequence = 0;
    const executablePath = args["revm-bin"] ?? env.SEARCHER_REVM_SIM_BIN;
    const implementation = executablePath ? historicalImplementation(executablePath) : undefined;
    const sourceSimulator = args.executionMode === "source-block" ? new SourceBlockSimulator({
      rpcUrl, executor, owner, chainId: Number(chainId), stateRoot: String(rawAnchor!.stateRoot), executablePath: executablePath!,
      ...(executorRuntimeCode ? { executorRuntimeCode } : {}),
      fundingForPlan: plan => {
        const matches = catalog.listAll().filter(f => f.plugin.manifest.domain === "funding" &&
          f.plugin.manifest.ownedActionAdapterIds.includes(plan.root.adapterId));
        assert.equal(matches.length, 1, "source-block requires one registered Funding root");
        const plugin = matches[0]!.plugin;
        assert(plugin.manifest.domain === "funding" && "funding" in plugin);
        const repayment = plugin.funding.repayment;
        assert.equal(plan.root.target.toLowerCase(), repayment.target.toLowerCase());
        assert.equal(plan.root.amount, plan.flashAmount);
        return { asset: plan.profitToken, amount: plan.flashAmount.toString(), target: repayment.target,
          liquidityHolder: repayment.liquidityHolder };
      },
      onResult: (executionInput, result) => save(`simulation-${++simulationSequence}.json`, { implementation, executionInput, result }),
    }) : undefined;
    if (benchmark) assert((configEnv.SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD ?? "eth_simulateV1") === "eth_simulateV1",
      "this benchmark requires the same production eth_simulateV1 backend");
    const rawEntry = benchmark ? rawExecutionEntryEnabled(configEnv.SEARCHER_BOTVM_RAW_ENTRY) : false;
    const chainDiagnosticCode = !finalSimulationExecutorRuntimeCode && poolReverts
      ? loadBotVmRuntimeCode(owner) : undefined;
    if (chainDiagnosticCode || (rawEntry && !finalSimulationExecutorRuntimeCode)) {
      const expected = chainDiagnosticCode ?? loadBotVmRuntimeCode(owner);
      const code = await provider.send("eth_getCode", [executor, { blockHash: anchor!.hash, requireCanonical: true }]);
      assert.equal(ethers.keccak256(code), expected.keccak256, "direct hop/raw entry requires the exact tested deployed runtime");
    }
    const executionEntry = (scriptHex: string) => rawEntry && canUseRawExecuteCalldata(ethers.getBytes(scriptHex))
      ? { executionEntry: "raw" as const } : {};
    const directSimulator = sourceSimulator ?? Object.assign(new EthSimulateV1Simulator(rpcUrl, executor, owner, finalSimulationExecutorRuntimeCode, rawEntry, chainDiagnosticCode),
    { concurrency: benchmark ? liveSettings.finalSimulationConcurrency : 1 });
    // Observe the production simulator; do not add a candidate/trial scheduler.
    const simulate = directSimulator.simulate.bind(directSimulator);
    let trialSequence = 0;
    directSimulator.simulate = async (plan, context) => {
      const trialId = ++trialSequence;
      save(`trial-${trialId}-input.json`, { source: context.source, header: context.header, plan });
      try {
        const result = await simulate(plan, context);
        save(`trial-${trialId}-result.json`, { result, revertEvidence: result.revertEvidence,
          ...(sourceSimulator || !result.scriptHex ? {} : {
          executionInput: result.revertEvidence?.executionInput ?? buildEthSimulateV1ExecutionInput({ ...context, executor, owner,
            profitToken: plan.profitToken, scriptHex: result.scriptHex, executorRuntimeCode: finalSimulationExecutorRuntimeCode,
            ...executionEntry(result.scriptHex) }) }) });
        return result;
      } catch (error) {
        save(`trial-${trialId}-error.json`, { error: String(error).replace(/https?:\/\/[^\s"'`]+/g, "[REDACTED_RPC]") });
        throw error;
      }
    };
    // Historical backends declare their execution capacity independently of hop quotes.
    const simTrialConcurrency = benchmark ? search.quoteConcurrency : Math.min(search.quoteConcurrency, directSimulator.concurrency);
    const provenance = { readyPath, readySha256: readyHash, topologySource: ready.cutoff, stateSource: anchor,
      executionMode: args.executionMode, amountSelector: args.amountSelector, onlyEnumeratedRank: args.onlyEnumeratedRank, simTrialConcurrency, sourceHeader: rawAnchor, chainId: chainId.toString(),
      ...(executorRuntimeCode ? { counterfactualExecutorCode: { address: executor.toLowerCase(), keccak256: executorRuntimeCode.keccak256 } } : {}),
      finalSimulationExecutorCode: finalSimulationExecutorRuntimeCode?.keccak256 ?? "chain",
      startupExecutorCode: startupIdentity?.executorCode ?? "chain",
      startupRevertFilterEnabled: startupFilterEnabled,
      ...(implementation ? { implementation } : {}),
      topologyContainsFutureDiscovery: ready.cutoff.number > args.block, historicalNaturalDiscoveryProven: false,
      ...(restored ? { historicalEffective: restored.provenance, atomicRuntimeRestored: false,
        authority: "fresh production strict execution and Funding session; saved effective is data only" } : {}),
      ...(priceWindow ? { priceWindow: { from: args.block, to: args.throughBlock ?? args.block,
        firstBlock: "restored-pricing-baseline; opaque-exact-cache-cold",
        subsequentBlocks: "same-process-production-incremental", scheduling: "sequential; not WS arrival latency",
        productionWriters: ["events", "route-worker", "solver-inputs", "continuation-deltas"],
        midHistoryWorker: false, continuationDrain: "at shutdown, not between blocks",
        headerHints: "historical hash supplies the WS-shaped hint; full header is independently checked during the pass",
        productionSettings: liveSettings } } : {}),
      ...(benchmark ? { baseline: { path: resolve(args["benchmark-baseline"]!), sha256: benchmark.sha256,
        block: benchmark.baseline.pricing.pricing.sourceBlock,
        storedPricingPolicy: benchmark.baseline.pricingPolicy, activePricingPolicy: pricingPolicy }, independentTrial: true } : {}),
      broadcast: false, fixedEffectiveWethInput: args.fixedEffectiveWethInput, fundingTokens: args.fundingTokens, cfg, coarseCfg, policy, search, executor, owner, through: args.through, budgetMs: args.budgetMs,
      runBudgetMs: args.runBudgetMs, pricingBatchSize: args.pricingBatchSize ?? null };
    save("input.json", provenance);
    loop = new BlockScanRuntimeLoop({
      onPassSettled: () => continuationWriter?.capture(),
      enabled: true, blockScanConfig: cfg, executionWorkers: executionStates.map(state => ({ state, solver: new AnvilSolver(),
        simulator: new BotVMSimulator(state, executor, owner) })), finalSimulationWorkers: [],
      directFinalSimulation: directSimulator,
      historicalReadOnly: true,
      ...(args.executionMode === "source-block" ? { historicalExecutionMode: "source-block" as const } : {}),
      isRouteSimRejected: opportunity => rejects?.ids.has(blockScanRouteId(opportunity.seedEdges)) === true ||
        simRejects.has(blockScanRouteId(opportunity.seedEdges)) ||
        opportunity.seedEdges.some(edge => simRejects.hasPool(edge)),
      isPoolSimRejected: edge => simRejects.hasPool(edge),
      ...(args.amountSelector === "sim" ? { amountSelectorFactory: createBlockScanLiveAmountSelectorFactory({
        executor, quoteConcurrency: simTrialConcurrency, simRejects,
        ...(benchmark ? { singleFunding: liveSettings.singleFunding, poolRevertAttributor: poolReverts } : {}),
        record: event => {
          if (benchmark) logBlockScanAmountEvent(event);
          save(`amount-event-${++amountEventSequence}.json`, event);
        },
      }) } : {}),
      rpcUrl, strictSession: prices.strictSessionFor, runtimeAbort: abort, rethTransportScheduler: scheduler,
      sourceSimulationFactory,
      ...(benchmark ? { routeTelemetry, rpcThrottleObservation: new LiveRpcThrottleObservation(
        reason => abort.abort(new Error(`historical runtime stopped: ${reason.kind}`))) } : {}),
      sharedPlanner: planner, backrunStatePublisher: { publish() {} },
      frozenTopology: { topologyKey: `strict-ready:${ready.generation}:${ready.graphHash}`, observeHeader: async (number, control) => {
        return activity.observeHeader(number, async () => {
          const header = await observeHeader(number, control); prices.blockScanAmountReference.observeHeader(header); return header;
        }, control);
      } },
      blind: { enabled: false, activeSource: () => null, preparedBase: () => null, preparedArtifacts: () => null, dynamicResetNonce: () => null },
      exactRefineEnabled: configEnv.SEARCHER_BLOCKSCAN_EXACT_REFINE_ENABLED === "1",
      exactRefineHardBudgetMs: Number(configEnv.SEARCHER_BLOCKSCAN_EXACT_REFINE_HARD_BUDGET_MS ?? "4000"),
      largeGraphEdgeThreshold: 25_000, largeGraphPassBudgetMs: args.budgetMs, passBudgetMs: args.budgetMs,
      startupWarmEnabled: false,
      hotPricingFamilyBudgetMs: args.budgetMs,
      refineCandidates: coarseCfg.maxCandidates, solveReserveMs: 2500,
      solverGridHalfWidth: search.gridHalfWidth, solverAmountGrid: search.amountGrid, solverGssMaxTries: search.gssMaxTries,
      solverQuoteConcurrency: search.quoteConcurrency, amountReference: prices.blockScanAmountReference,
      // Historical opt-in forwards the resolved setting; default/live policy is unchanged.
      ...(sourceSimulator || benchmark ? { solverQuoteToleranceRawUnits: search.quoteToleranceRawUnits } : {}),
      exactConcurrency: 16, exactProbeTimeoutMs: 4000, executorAddress: executor,
      ...(priceWindow ? { largeGraphEdgeThreshold: liveSettings.largeGraphEdgeThreshold,
        exactRefineHardBudgetMs: liveSettings.exactRefineHardBudgetMs,
        largeGraphPassBudgetMs: liveSettings.largeGraphPassBudgetMs, passBudgetMs: liveSettings.passBudgetMs,
        hotPricingFamilyBudgetMs: liveSettings.hotPricingFamilyBudgetMs,
        runtimePublicationReserveMs: liveSettings.runtimePublicationReserveMs, solveReserveMs: liveSettings.solveReserveMs,
        exactConcurrency: liveSettings.exactConcurrency, exactProbeTimeoutMs: liveSettings.exactProbeTimeoutMs,
        exactRpcBatchSize: liveSettings.exactRpcBatchSize, exactRpcBatchConcurrency: liveSettings.exactRpcBatchConcurrency,
      } : {}),
      readBlockSwapTouched: priceWindow ? (number, header, range) => activity.withBlockActivity(header?.hash,
        () => readBlockTouchedStateKeys(activity, number, ADDR.UNISWAP_V4_POOL_MANAGER, header,
          range === undefined ? undefined : { ...range, readHeader: number => observeHeader(number,
            { signal: range.signal, deadlineAtMs: range.deadlineAtMs }) }, root.resolveBlockTouchedStateKeys), range)
        : async () => new Set(graph.map(edge => (edge.poolId ?? edge.target).toLowerCase())),
      currentHeadEvidenceFamilyForEdge: id => declarations.currentHeadEvidenceFamilyForEdge(id),
      currentHeadEvidenceScopeKeyForEdge: edge => declarations.currentHeadEvidenceScopeKeyForEdge(edge),
      currentHeadEvidenceScopeKeys: evidence => declarations.currentHeadEvidenceScopeKeys(evidence),
      isCurrentHeadEvidenceFamily: id => declarations.isCurrentHeadEvidenceFamily(id),
      isShuttingDown: () => abort.signal.aborted, blockScanGraph: () => graph, blockScanPlanner: () => planner,
      currentRuntimeCoordinator: () => prices.currentRuntimeCoordinator, flashTokens: () => funding.map(f => f.asset),
      buildGraphView: input => views.build(input), readBlockHash: async (_provider, number) => (await observeHeader(number)).hash,
      formatRouteKey: opportunity => blockScanRouteId(opportunity.seedEdges),
      formatRing: opportunity => opportunity.seedEdges.map(e => e.tokenIn).join(" → "),
      recordSolvedInput: input => {
        try {
        const executionInput = sourceSimulator ? sourceSimulator.captureInput(input.resolved, input, input.scriptHex)
          : buildEthSimulateV1ExecutionInput({ ...input, executor, owner,
            profitToken: input.resolved.profitToken, scriptHex: input.scriptHex,
            ...(finalSimulationExecutorRuntimeCode ? { executorRuntimeCode: finalSimulationExecutorRuntimeCode } : {}),
            ...executionEntry(input.scriptHex) });
        solverInputRecorder?.record({ source: input.source,
          opportunityId: makeBlockScanOpportunityId({ sourceBlock: input.source.number, cycleId: input.opportunity.cycleId,
            startToken: input.opportunity.flashToken, seedPools: input.opportunity.seedEdges.map(edge => edge.target) }),
          route: blockScanRouteLocator(input.opportunity), solverIndex: input.solverIndex, candidateIndex: input.candidateIndex,
          flashAmount: input.resolved.flashAmount, quoteProfit: input.resolved.netProfit,
          profitToken: input.resolved.profitToken, templateName: input.resolved.templateName, executionInput });
        save(`solver-${++sequence}.json`, { route: input.opportunity.seedEdges, ...(implementation ? { implementation } : {}),
          flashAmount: input.resolved.flashAmount, quoteProfit: input.resolved.netProfit, executionInput });
        } catch (error) {
          abort.abort(error);
          throw error;
        }
      },
      submitAtomic: input => maybeSubmitBlockScanAtomic({ ...input, provider, config: policy, historicalReadOnly: true,
        ...(sourceSimulator ? { historicalExecutionMode: "source-block" as const,
          onHistoricalEv: ({ evaluation, calldata }: { evaluation: Awaited<ReturnType<typeof import("./ev-evaluator.js").evaluateEv>>; calldata: string }) =>
            save(`ev-${++evSequence}.json`, { executionMode: "source-block", sourceBlock: input.sourceBlock,
              sourceBlockHash: input.sourceBlockHash, implementation, calldataSha256: sha256(Buffer.from(ethers.getBytes(calldata))),
              flashAmount: input.resolved.flashAmount, profitToken: input.resolved.profitToken, policy, evaluation }),
        } : {}),
        collectBlindAudit: !benchmark, simRejects, poolRevertAttributor: poolReverts,
        strategyVersions: { strategy_view_version: "historical-diagnostic", blockscan_view_hash: ready.graphHash },
        bundleRouter: { async submit() { throw new Error("historical CLI cannot submit"); } },
        submissionCoordinator: { offer() { throw new Error("historical CLI cannot submit"); } },
        onSuccessfulSimulation: sample => prices.blockScanAmountReference.recordSimulation(sample) }),
    });
    if (benchmark) loop.restoreHistoricalBaseline();
    const loadAndRestoreMs = performance.now() - setupStarted - startupExecutionMs;
    const samples: HistoricalBenchmarkSample[] = [];
    try {
    for (let block = args.block; block <= (args.throughBlock ?? args.block); block++) {
    if (benchmark) {
      // Historical input delivery replaces WS only. Do not precompute touched
      // state or prices: the production observer validates this hint afresh.
      const hint = headers.get(block)?.hash ?? (await provider.send("eth_getBlockByNumber", [ethers.toQuantity(block), false]))?.hash;
      assert(typeof hint === "string", "historical source hint unavailable");
      activity.noteHead(block, hint);
    }
    artifactPrefix = benchmark ? `block-${block}-` : "";
    measuring = priceWindow;
    let finished = false;
    let completePrices = false;
    let observedPricing: AdapterRuntimeSnapshot["pricing"] | undefined;
    let terminal: Parameters<NonNullable<Parameters<typeof loop.runHead>[2]>["onComplete"]>[0] | undefined;
    let failure: unknown;
    const started = performance.now();
    try { await loop.runHead(block, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: started }, {
      through: args.through,
      ...(restored ? { effectivePricing: restored.pricing } : {}),
      onSnapshot: runtime => {
        observedPricing = runtime.pricing;
        completePrices = runtime.pricing.effectiveMids?.complete === true;
        if (requireNativeDelta) {
          const stats = publishedEffectiveIncrementalStatistics(runtime.pricing);
          save("native-delta-check.json", { block, firstBlock: block === args.block, ...stats });
          console.log(`[searcher/historical-native-delta] block=${block} nativeDelta=${stats?.nativeDelta}`);
          try { assertHistoricalNativeDelta(block === args.block, stats); }
          catch (error) { abort.abort(error); throw error; }
        }
        if (benchmark) {
          const excluded = graph.filter(edge => simRejects.hasPool(edge));
          const stillQuoted = excluded.filter(edge => runtime.pricing.effectiveMids?.rows.get(blockScanEdgeKey(edge))?.status === "quoted");
          save("pool-filter-price-check.json", { excludedEdges: excluded.length, stillQuoted: stillQuoted.length });
          assert.equal(stillQuoted.length, 0, "production pricing retained a rejected pool as an effective price");
        }
        if (args.fundingTokens.length > 0) {
          assertAtomicBlockScanRuntime(runtime);
          cfg.pricedTokens = historicalFundingStarts(cfg.pricedTokens, args.fundingTokens, runtime.funding.sources);
          coarseCfg.pricedTokens = cfg.pricedTokens;
          save("funding-starts.json", { requested: args.fundingTokens, resolved: cfg.pricedTokens,
            sourceBlock: runtime.sourceBlock, sourceBlockHash: runtime.sourceBlockHash });
        }
        if (!benchmark) save("prices.json", { schemaVersion: 1, readyPath, readySha256: readyHash, runtime });
      },
      onEnumeration: result => {
        if (benchmark) {
          const rejectedCandidates = result.opportunities.filter(opportunity => opportunity.seedEdges.some(edge => simRejects.hasPool(edge)));
          save("pool-filter-enumeration-check.json", { candidates: result.opportunities.length, rejectedCandidates: rejectedCandidates.length });
          assert.equal(rejectedCandidates.length, 0, "production enumeration admitted a rejected pool");
        }
        save("enumeration.json", result);
        if (selectCandidate) save("candidate-selection.json", selectCandidate(result));
      },
      onSolver: result => save(`route-result-${result.solverIndex + 1}.json`, result),
      onComplete: result => { finished = true; terminal = result; },
    }); } catch (error) { failure = error; }
    const pipelineWallMs = performance.now() - started;
    const callWallMs = performance.now() - started;
    measuring = false;
    if (observedPricing) console.log(atBlockJson({ stage: "prices", block, raw: observedPricing.mids.size,
      effective: [...(observedPricing.effectiveMids?.rows.values() ?? [])].filter(r => r.status === "quoted").length }));
    if (terminal) {
      const stages = structuredClone(terminal.detail!.stages);
      // The existing diagnostic prices-only return leaves state open until the
      // runtime's finally/drain. Report that intentional terminal separately;
      // never change the live timeline implementation for a CLI measurement.
      if (args.through === "prices" && completePrices && !failure && stages.state.status === "failed") stages.state.status = "ran";
      samples.push({ block, outcome: terminal.outcome, reason: terminal.reason, totalMs: terminal.totalMs,
        callWallMs, pipelineWallMs, completePrices, timing: terminal.timing, stages,
        ...(failure ? { error: String(failure).replace(/https?:\/\/[^\s"'`]+/g, "[REDACTED_RPC]") } : {}) });
      save(priceWindow ? `summary-${block}.json` : "summary.json", { ...provenance, ...terminal,
        phase: benchmark ? "incremental" : "historical", solverInputs: sequence, pipelineWallMs,
        callWallMs, productionTelemetry: routeTelemetry?.telemetry(),
        productionSolverInputs: solverInputRecorder?.snapshot() });
    }
    const pending = deferredArtifacts.splice(0);
    for (const [name, value] of pending) writeFileSync(resolve(args.out, name), atBlockJson(value), { flag: "wx", mode: 0o600 });
    if (failure) throw failure;
    assert(finished, "single pass did not produce a terminal result");
    if (priceWindow) assert(completePrices, `incomplete state at ${block}; do not measure following blocks as warm`);
    await observeHeader(block);
    }
    } finally {
      measuring = false; artifactPrefix = "";
      if (benchmark) save("benchmark-summary.json", { ...historicalBenchmarkSummary(samples, (args.throughBlock ?? args.block) - args.block + 1),
        loadAndRestoreMs, startupExecutionMs, baselineSha256: benchmark.sha256, source: provenance, samples, signing: false, broadcast: false });
    }
    assert.equal(await fileSha256(readyPath), readyHash, "Ready changed during diagnostic");
    if (implementation) assert.deepEqual(historicalImplementation(executablePath!), implementation, "historical implementation changed during pass");
    console.log(`Historical pass complete; results: ${args.out}`);
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    let continuationDrainMs = 0;
    try { await cleanupHistoricalResources([
      () => loop?.shutdown(), () => activity.closeAndDrain(),
      async () => { const start = performance.now(); continuationWriter?.capture();
        await continuationWriter?.flush(); continuationDrainMs = performance.now() - start; },
      () => routeTelemetry?.shutdown(), () => solverInputRecorder?.close(),
      () => { if (benchmark) save("production-writers.json", { route: routeTelemetry?.telemetry(),
        solverInputs: solverInputRecorder?.snapshot(), continuationDrainMs }); },
      () => { if (benchmark) {
        initEvents("");
        if (priorEventsPath === undefined) delete process.env.SEARCHER_EVENTS_PATH; else process.env.SEARCHER_EVENTS_PATH = priorEventsPath;
        if (priorRevertsPath === undefined) delete process.env.SEARCHER_SIM_REVERT_DIAGNOSTICS_PATH;
        else process.env.SEARCHER_SIM_REVERT_DIAGNOSTICS_PATH = priorRevertsPath;
      } },
      ...executionStates.map(backend => () => backend.stop()),
      () => activityTransport.destroy(), () => provider.destroy(),
    ], runFailed); } finally {
      // Keep the CLI's referenced deadline alive while unref'ed production
      // workers drain; otherwise Node may exit 0 with an unresolved cleanup.
      clearTimeout(timeout); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    }
  }
}

export function historicalContinuationIdentity(baseline: string,
  policy: { readonly spreadBps: number; readonly fixedWethInput: bigint | null; readonly cascade: boolean }): string {
  return liveContinuationIdentity({ scope: "historical-journal", baseline,
    pricingPolicy: { ...policy, fixedWethInput: policy.fixedWethInput?.toString() ?? null } });
}

export async function cleanupHistoricalResources(actions: readonly (() => unknown | Promise<unknown>)[], runFailed: boolean): Promise<void> {
  // A run deadline may already have fired. An unresolved Promise and the
  // production worker's unref'ed timers do not keep a CLI process alive.
  const keepAlive = setInterval(() => {}, 60_000);
  const errors: unknown[] = [];
  try {
    for (const action of actions) { try { await action(); } catch (error) { errors.push(error); } }
  } finally { clearInterval(keepAlive); }
  // Preserve the original pass failure, but a failed evidence drain must never
  // turn an otherwise successful run into a successful receipt.
  if (errors.length && !runFailed) throw errors[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runAtBlock(process.argv.slice(2)).catch(error => {
    const message = String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"'`]+/g, "[REDACTED_RPC]");
    console.error(`Historical pass failed: ${message}`); process.exitCode = 1;
  });
}

// Thin manual launcher for the actual live loop. Never imported by live.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ethers } from "ethers";
import { atBlockJson, parseHistoricalExecutorRuntimeCode } from "../src/searcher/blockscan-at-block-cli.js";
import { activeReadyMemos, UniverseRebuildCheckpointStore } from "../src/searcher/universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../src/searcher/universe-rebuild-production.js";
import { resolveStrictReadyRuntime } from "../src/searcher/strict-ready-runtime.js";
import { assertReadyFamilyActivation } from "../src/searcher/universe-rebuild-runner.js";
import { assertFamilyActivationEnvironment } from "../src/searcher/venues/production-families/activation.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog, PRODUCTION_FAMILY_ACTIVATIONS } from "../src/searcher/venues/production-family-composition.js";
import { StrictProductionRuntimeRoot, type StrictReadyFundingAsset } from "../src/searcher/strict-production-runtime-session.js";
import { assertIssuedPreparedFamilyInstance, type PreparedFamilyInstance } from "../src/searcher/venues/adapter-family-runtime.js";
import { familyId } from "../src/searcher/venues/adapter-family-identifiers.js";
import { StrictReadyGraphViewCoordinator } from "../src/searcher/strict-ready-graph-view.js";
import { createBlockScanPriceRuntime, createLiveSourceSimulationFactory, resolveBlockScanCoreConfig,
  resolveBlockScanLiveStageSettings, createBlockScanLiveAmountSelectorFactory } from "../src/searcher/main.js";
import { BlockScanActivityPrefetch } from "../src/searcher/blockscan-activity-prefetch.js";
import { readBlockTouchedStateKeys } from "../src/searcher/blockscan-touched-state.js";
import { readBlockScanObservedHeader, type BlockScanObservedHeader } from "../src/searcher/blockscan-observed-header.js";
import { BlockScanRuntimeLoop } from "../src/searcher/blockscan-runtime-loop.js";
import { RethTransportScheduler } from "../src/searcher/reth-transport-scheduler.js";
import type { AdapterRuntimeSnapshot } from "../src/searcher/adapter-runtime-coordinator.js";
import { TemplatePlanner } from "../src/searcher/planner/planner.js";
import { AnvilSolver } from "../src/searcher/solver/solver.js";
import { AnvilStateBackend } from "../src/shared/state/state-backend.js";
import { BotVMSimulator } from "../src/searcher/simulator/botvm-simulator.js";
import { EthSimulateV1Simulator } from "../src/searcher/simulator/eth-simulate-v1.js";
import { resolveBlockScanFinalSimulationMethod } from "../src/searcher/blockscan-final-simulation-method.js";
import { BlockScanSimRejectCache } from "../src/searcher/blockscan-sim-reject-cache.js";
import { blockScanRouteId } from "../src/searcher/blockscan-route-identity.js";
import { DEFAULT_PROFIT_TOKEN_VALUATION } from "../src/searcher/profit-token-valuation.js";
import { resolveLiveBackrunSettings } from "../src/searcher/backrun-live-policy.js";
import { isRpcThrottleError } from "../src/searcher/rpc-throttle-guard.js";
import { PRODUCTION_STRICT_FAMILY_DECLARATIONS as declarations } from "../src/searcher/strict-production-family-declarations.js";
import { effectiveMidRowCarried } from "../src/searcher/blockscan-effective-mid.js";
import { ADDR } from "../src/shared/constants/addresses.js";
import { distribution } from "./enumeration.js";
import { redactToolOutput } from "../../analysis/src/tool-run-security.js";
import { PrerequisiteCache, type PrerequisiteManifest } from "./prerequisite-cache.js";

const sha256 = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
export interface Head { number: number; hash: string }
export type LiveBenchmarkStage = "effective-update" | "sim-amount" | "live-enumeration";
type LiveDiagnostic = NonNullable<Parameters<BlockScanRuntimeLoop["runHead"]>[2]>;
type LiveResult = Parameters<LiveDiagnostic["onComplete"]>[0];
type Enumeration = Parameters<LiveDiagnostic["onEnumeration"]>[0];
type SolverRecord = Parameters<NonNullable<LiveDiagnostic["onSolver"]>>[0];

/** Drive the actual live runHead, stopping at its existing diagnostic boundary.
 * No benchmark-owned prepare/funding/cache/batching loop. The production loop owns
 * all source reads, work controls, publication, startup transition and drains. */
export async function measureLiveHead(input: {
  head: Head; loop: Pick<BlockScanRuntimeLoop, "schedule" | "waitForIdle">; budgetMs: number; setup?: boolean; now?: () => number;
  sizingBudgetMs?: number; signal?: AbortSignal;
  stage: LiveBenchmarkStage;
  setDiagnostic(diagnostic: LiveDiagnostic | undefined): void;
  noteHead(head: Head): void;
  latestPricing(): unknown;
  recordFailure?(error: unknown): void;
  /** Changes only the diagnostic input transport, never live scheduling. */
  onMeasuredStageStart?(): void;
}) {
  assert(input.sizingBudgetMs === undefined || (!input.setup && input.stage === "sim-amount" &&
    Number.isFinite(input.sizingBudgetMs) && input.sizingBudgetMs > 0 && input.sizingBudgetMs <= 3_600_000),
  "sizingBudgetMs requires a measured sim-amount head and must be in (0, 3600000]");
  const now = input.now ?? (() => performance.now()), start = now();
  const receivedAtMs = Date.now();
  let publicationReadyMs: number | null = null, snapshot: AdapterRuntimeSnapshot | undefined;
  let sizingStartedAt: number | null = null, enumerationStartedAt: number | null = null;
  let live: LiveResult | undefined, failure: unknown;
  let enumeration: Enumeration | undefined;
  const solvers: SolverRecord[] = [];
  try {
    input.setDiagnostic({
      // Startup's own branch returns before enumeration and completes its normal
      // startup transition. through=prices would return too early to reset it.
      through: input.setup || input.stage === "live-enumeration" ? "enumerate" : input.stage === "effective-update" ? "prices" : "solver",
      ...(input.sizingBudgetMs === undefined ? {} : { sizingBudgetMs: input.sizingBudgetMs }),
      onSnapshot(value) {
        snapshot = value; publicationReadyMs = now() - start;
        if (!input.setup && input.stage === "live-enumeration") { enumerationStartedAt = now(); input.onMeasuredStageStart?.(); }
      },
      onEnumeration(value) {
        assert(!input.setup && input.stage !== "effective-update", "effective benchmark must not enumerate");
        enumeration = value;
      },
      onSolver(value) { solvers.push(value); },
      onSizingStart() { sizingStartedAt = now(); input.onMeasuredStageStart?.(); },
      onComplete(value) { live = value; },
    });
    if (!input.setup && input.stage === "effective-update") input.onMeasuredStageStart?.();
    input.noteHead(input.head);
    input.loop.schedule(input.head.number, { sourceHeadSeenAtMs: receivedAtMs, sourceHeadSeenAtMonotonicMs: start });
    await input.loop.waitForIdle();
    assert(live && snapshot, "live pass did not publish a terminal snapshot");
    assert(input.setup ? live.outcome === "startup_warm" : ["ran", "degraded"].includes(live.outcome), "live pass did not finish preparation");
    assertEffectivePublication(snapshot, input.latestPricing(), input.head);
    if (input.setup || input.stage !== "sim-amount") assert.equal(live.planned, 0, "upstream benchmark reached Planner");
    if (!input.setup && input.stage === "live-enumeration") assert(enumeration, "live enumeration not reached");
    assert(enumeration?.outcome !== "budget_exceeded", "natural enumeration was budget truncated");
    assert.equal(live.atomicResults.length, 0, "effective benchmark reached sim/EV");
    assert.equal(live.timing.finalSimMs, 0, "stage benchmark reached independent final sim");
    assert.equal(live.timing.evMs, 0, "stage benchmark reached EV");
    input.signal?.throwIfAborted();
    if (input.sizingBudgetMs === undefined) {
      assert(now() - start < input.budgetMs, "live preparation/drain exceeded benchmark budget");
    } else {
      assert(sizingStartedAt !== null, "live pass did not reach sizing");
      assert(sizingStartedAt - start < input.budgetMs, "live prerequisites exceeded benchmark budget");
      assert(now() - sizingStartedAt < input.sizingBudgetMs, "live sizing/drain exceeded benchmark budget");
    }
  } catch (error) { failure = error; input.recordFailure?.(error); }
  finally { input.setDiagnostic(undefined); }
  if (failure !== undefined && live?.reason) input.recordFailure?.(new Error(live.reason));
  const totalMs = now() - start;
  const boundary = input.stage === "live-enumeration" ? enumerationStartedAt : sizingStartedAt;
  const prerequisitesMs = boundary === null ? null : boundary - start;
  const stageMs = input.stage === "effective-update" ? totalMs : boundary === null ? null : now() - boundary;
  const timedOut = live?.outcome === "budget_exceeded" || enumeration?.outcome === "budget_exceeded" || (input.sizingBudgetMs === undefined
    ? totalMs >= input.budgetMs
    : (prerequisitesMs ?? totalMs) >= input.budgetMs || (stageMs !== null && stageMs >= input.sizingBudgetMs));
  const aborted = input.signal?.aborted || live?.reason === "source_head_superseded" || live?.reason === "pending_evidence_priority";
  return {
    snapshot, enumeration, solvers,
    metrics: { status: failure === undefined ? "completed" as const :
      timedOut ? "timeout" as const : aborted ? "aborted" as const : "failed" as const,
      publicationReadyMs, totalMs,
      budgets: { sharedPassBudgetMs: input.sizingBudgetMs === undefined ? input.budgetMs : null,
        prerequisiteBudgetMs: input.sizingBudgetMs === undefined ? null : input.budgetMs,
        sizingBudgetMs: input.sizingBudgetMs ?? null },
      // Native stage boundary, not a sum of concurrent workers. Keep null when
      // upstream never reached selection; zero would imply a fast sim sample.
      stageMs, prerequisitesMs,
      live: live ? { outcome: live.outcome, timing: live.timing, totalMs: live.totalMs,
        planned: live.planned, quotePositive: live.quotePositive, atomicResultCount: live.atomicResults.length,
        detail: live.detail,
        // runtime_error text can contain remote errors, so retain no free-form reason.
        reasonPresent: live.reason !== undefined } : undefined,
      // Remote errors may carry credentials; never serialize their message, stack or cause.
      ...(failure === undefined ? {} : { failureType: failure instanceof Error ? failure.name : "UnknownError" }) },
  };
}

/** Production may log RPC error strings. This CLI silences them locally; only
 * benchmark-owned structured summaries cross stdout. No live logging change. */
export async function withoutProductionConsole<T>(run: () => Promise<T>): Promise<T> {
  const keys = ["log", "warn", "error", "debug", "info"] as const;
  const original = keys.map(key => console[key]);
  for (const key of keys) console[key] = () => {};
  try { return await run(); }
  finally { keys.forEach((key, index) => { console[key] = original[index]!; }); }
}

/** loop.shutdown retires its own runtime controller. It must not poison a
 * fresh repetition; only an external experiment interrupt propagates inward. */
export function createBenchmarkRuntimeAbort(parent: AbortSignal) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(parent.reason);
  parent.addEventListener("abort", interrupt, { once: true });
  if (parent.aborted) interrupt();
  return { controller, detach: () => parent.removeEventListener("abort", interrupt) };
}

export function parseHeads(value: unknown): Head[] {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 250, "heads must contain 1..250 consecutive notifications");
  return value.map((item, index) => {
    assert(item && Object.keys(item).length === 2 && Number.isSafeInteger(item.number) && item.number > 0 &&
      typeof item.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(item.hash), "invalid head; expected {number,hash}");
    if (index > 0) assert.equal(item.number, value[index - 1].number + 1, "heads must be consecutive, without repeats");
    return { number: item.number, hash: item.hash.toLowerCase() };
  });
}

export const LIVE_STAGE_HELP = `Manual live-stage benchmark (no live restart, signing or broadcasting).
  npm run benchmark:effective-update -- --ready CHECKPOINT --heads HEADS.json --out NEW_DIR
  npm run benchmark:sim-amount -- --ready CHECKPOINT --heads HEADS.json --out NEW_DIR
  npm run benchmark:live-enumeration -- --ready CHECKPOINT --heads HEADS.json --out NEW_DIR
  --env-file FILE             Only RPC/public execution identity/REVM settings are read.
  --executor ADDRESS --owner ADDRESS --revm-bin FILE
  --executor-runtime-code FILE Optional hash-bound {code,keccak256}; no deployment.
  --repetitions N             Default 1; fresh producer/cache and N-1 setup per repetition.
  --setup-budget-ms N         Default 300000, outside all measured distributions.
  --block-budget-ms N         Default live 11000 (large graph 30000); experiment-only.
  --sizing-budget-ms N        Sim only, 1..3600000; fresh budget at planner_solver.
                             With this flag, block-budget-ms bounds prerequisites.
  --save-prices               Save source-bound full snapshots after timing for later stage tests.
  --prepare-cache NEW_DIR     Sim entry only, one repetition; capture reusable prerequisite reads.
  --input-cache DIR           Restore prerequisites from a completed capture; no network fallback on a miss.
HEADS.json is [{"number":N,"hash":"0x..."}, ...], 1..250 consecutive newHeads inputs.
N-1 baseline must actually finish; it is not a measured sample. Measured N is never prewarmed.
Both enter the actual live head scheduler. effective stops at through=prices;
sim uses through=solver with live's actual-profit selector, not an independent dispatch loop.
The live loop owns activity, strict producer, effective build, natural enumeration, planning,
trial dispatch, concurrency, deadlines, cancellation and drain. Sim prerequisites still run
through live, but stageMs starts at the native sizing boundary and includes its final drain;
native plannerSolverMs is also retained. By default both share the whole-pass deadline.
Only explicit --sizing-budget-ms renews it at the runtime's sizing boundary, including drain;
prerequisite and sizing budgets are reported separately. Setup never receives this override.
No independent final sim/EV is run. Negative/revert/deadline outcomes remain in the report.
Heads are supplied sequentially. The real scheduler runs, but this does not stress overlapping
head arrival/WS propagation or concurrent downstream contention. Reads archive RPC; do not
claim realtime live acceptance or all routes complete on timeout.
Completed effective tables can contain failed/disabled edges; their counts are reported.
The cache stores pinned prerequisite RPC inputs, not live handles or measured results.
Production rebuilds its own in-memory state/price tables and natural candidates from these
local inputs. This local restoration is reported separately, never included in stageMs.
Effective's measured N reads/quotes and sim's trial quotes/simulations always reach the real
RPC through a loopback passthrough (whose overhead remains measured). Live-enumeration uses
the same production scheduler/dispatcher, stopping before Planner. Source header validation,
Ready loading and hash checks remain untimed. No signing/broadcast and no live default changes.
`;

export function parseLiveStageOptions(argv: string[], stage: LiveBenchmarkStage) {
  const { values: v } = parseArgs({ args: argv, options: {
    ready: { type: "string" }, heads: { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
    "env-file": { type: "string" }, executor: { type: "string" }, owner: { type: "string" }, "revm-bin": { type: "string" },
    "executor-runtime-code": { type: "string" }, repetitions: { type: "string" }, "save-prices": { type: "boolean" },
    "setup-budget-ms": { type: "string" }, "block-budget-ms": { type: "string" },
    "sizing-budget-ms": { type: "string" },
    "prepare-cache": { type: "string" }, "input-cache": { type: "string" },
  }, allowPositionals: false });
  if (v.help) return null;
  assert(v.ready && v.heads && v.out, "--ready, --heads and --out are required");
  assert(v["sizing-budget-ms"] === undefined || stage === "sim-amount", "--sizing-budget-ms is only applicable to sim-amount");
  assert(!(v["prepare-cache"] && v["input-cache"]), "choose prepare-cache or input-cache, not both");
  assert(!v["prepare-cache"] || (stage === "sim-amount" && (v.repetitions === undefined || v.repetitions === "1")),
    "prepare-cache requires the sim entry and exactly one repetition");
  const positive = (raw: string, max: number) => {
    assert(/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 && Number(raw) <= max, "invalid benchmark integer");
    return Number(raw);
  };
  return { ...v, ready: realpathSync(v.ready), heads: realpathSync(v.heads), out: resolve(v.out),
    prepareCache: v["prepare-cache"] ? resolve(v["prepare-cache"]) : undefined,
    inputCache: v["input-cache"] ? realpathSync(v["input-cache"]) : undefined,
    repetitions: positive(v.repetitions ?? "1", 20),
    setupBudgetMs: v["setup-budget-ms"] === undefined ? undefined : positive(v["setup-budget-ms"], 3_600_000),
    blockBudgetMs: v["block-budget-ms"] === undefined ? undefined : positive(v["block-budget-ms"], 3_600_000),
    sizingBudgetMs: v["sizing-budget-ms"] === undefined ? undefined : positive(v["sizing-budget-ms"], 3_600_000) };
}

function readEnvironment(path?: string): NodeJS.ProcessEnv {
  const publicKeys = new Set(["MAINNET_RPC_URL", "BOTVM_ADDRESS", "BOTVM_OWNER", "SEARCHER_REVM_SIM_BIN", "SEARCHER_REVM_TIMEOUT_MS"]);
  const env: NodeJS.ProcessEnv = {};
  if (path) for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (m && publicKeys.has(m[1]!)) env[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return { ...env, ...process.env };
}

export function assertEffectivePublication(snapshot: AdapterRuntimeSnapshot, latest: unknown, head: Head) {
  assert.equal(snapshot.sourceBlock, head.number);
  assert.equal(snapshot.sourceBlockHash.toLowerCase(), head.hash);
  assert.equal(latest, snapshot.pricing, "atomic publication missing");
  assert.equal(snapshot.pricing.effectiveMids?.complete, true, "effective build incomplete");
  assert.equal(snapshot.pricing.effectiveMids.source.number, head.number);
  assert.equal(snapshot.pricing.effectiveMids.source.hash.toLowerCase(), head.hash);
  assert.equal(snapshot.pricing.effectiveMids.source.generation, snapshot.generation);
}

export function assertLiveStageMode(env: NodeJS.ProcessEnv) {
  // Match live's 0/1 syntax; this benchmark supports only its normal mode.
  assert([undefined, "0"].includes(env.SEARCHER_BLOCKSCAN_N_MINUS_ONE_FALLBACK), "benchmark requires normal source-N mode");
  assert([undefined, "0"].includes(env.SEARCHER_BLOCKSCAN_EXACT_REFINE_ENABLED), "benchmark requires the default Exact-disabled live mode");
}

export async function runLiveStageBenchmark(stage: LiveBenchmarkStage, argv = process.argv.slice(2)) {
  const args = parseLiveStageOptions(argv, stage);
  if (!args) { console.log(LIVE_STAGE_HELP); return; }
  const env = readEnvironment(args["env-file"]);
  assertFamilyActivationEnvironment(PRODUCTION_FAMILY_ACTIVATIONS, env);
  const upstreamRpcUrl = env.MAINNET_RPC_URL, executor = args.executor ?? env.BOTVM_ADDRESS, owner = args.owner ?? env.BOTVM_OWNER;
  const executableInput = args["revm-bin"] ?? env.SEARCHER_REVM_SIM_BIN;
  assert(upstreamRpcUrl && /^https?:\/\//.test(upstreamRpcUrl), "MAINNET_RPC_URL required");
  let rpcUrl = upstreamRpcUrl;
  assert(executor && ethers.isAddress(executor) && owner && ethers.isAddress(owner), "public executor and owner required");
  assert(executableInput && existsSync(executableInput), "existing REVM binary required");
  const executablePath = realpathSync(executableInput);
  const codePath = args["executor-runtime-code"];
  const executorRuntimeCode = codePath ? parseHistoricalExecutorRuntimeCode(readFileSync(codePath, "utf8")) : undefined;
  const heads = parseHeads(JSON.parse(readFileSync(args.heads, "utf8")));
  assert(!existsSync(args.out), "--out must be a new directory");
  mkdirSync(args.out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(resolve(args.out, name), atBlockJson(value), { flag: "wx", mode: 0o600 });
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  const sourcePaths = git("ls-files", "--cached", "--others", "--exclude-standard", "listener/src", "listener/benchmarks", "listener/package.json", "listener/package-lock.json", "analysis/src/tool-run-security.ts")
    .split("\n").filter(Boolean).sort();
  const bindings = [...new Set([...sourcePaths.map(p => resolve(repo, p)), args.ready, args.heads, executablePath, ...(codePath ? [realpathSync(codePath)] : [])])]
    .map(path => ({ path, sha256: sha256(readFileSync(path)) }));
  const readySha256 = bindings.find(b => b.path === args.ready)!.sha256;
  const cfg = resolveBlockScanCoreConfig(env);
  const settings = resolveBlockScanLiveStageSettings(env, cfg.maxCandidates);
  const search = settings.solverSearch;
  assert.equal(search.amountGrid, "multiples", "live sim amount selection requires multiples");
  assert.equal(resolveBlockScanFinalSimulationMethod(env.SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD), "eth_simulateV1",
    "this isolated benchmark supports live's stateless simulator only; never silently switches backend");
  assertLiveStageMode(env);
  const envelope = await new UniverseRebuildCheckpointStore({ path: args.ready }).load();
  assert(envelope && !envelope.inProgressRun, "completed Ready required; benchmark never rebuilds");
  const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
  const topologyKey = `strict-ready:${ready.generation}:${ready.graphHash}`;
  const identity = { executor: executor.toLowerCase(), transactionOrigin: owner.toLowerCase() };
  const wiring = createRebuildWiring({ rpcUrl, executionIdentity: identity });
  const memos = activeReadyMemos(envelope);
  assertReadyFamilyActivation(memos, wiring.isFamilyEnabled);
  for (const memo of memos) assert([familyDefinitionHash(memo.familyId), familyMemoDefinitionHash(memo.familyId)].includes(memo.familyDefinitionHash),
    `Ready requires selective revalidation: ${memo.familyId}; benchmark will not drop or bypass it`);
  const producerReserved = settings.stateRpcBatchConcurrency;
  const transportCapacity = producerReserved + settings.exactRpcBatchConcurrency;
  const blockBudgetMs = args.blockBudgetMs ?? (graph.length >= settings.largeGraphEdgeThreshold
    ? settings.largeGraphPassBudgetMs : settings.passBudgetMs);
  const setupBudgetMs = args.setupBudgetMs ?? settings.startupWarmBudgetMs;
  const familyBudgetMs = settings.hotPricingFamilyBudgetMs, reserveMs = settings.runtimePublicationReserveMs;
  assert(blockBudgetMs > reserveMs && setupBudgetMs > reserveMs, "budget must exceed publication reserve");
  save("declaration.json", { schema: 2, benchmark: stage, head: git("rev-parse", "HEAD"), bindings,
    notifications: heads, repetitions: args.repetitions, cfg, identity, executorRuntimeCodeHash: executorRuntimeCode?.keccak256,
    readySource: ready.cutoff, graphEdges: graph.length, topologyContainsFutureDiscovery: ready.cutoff.number > heads[0]!.number - 1,
    settings, budgets: { blockBudgetMs, familyBudgetMs, reserveMs, setupBudgetMs,
      sharedPassBudgetMs: args.sizingBudgetMs === undefined ? blockBudgetMs : null,
      prerequisiteBudgetMs: args.sizingBudgetMs === undefined ? null : blockBudgetMs,
      sizingBudgetMs: args.sizingBudgetMs ?? null },
    experimentOverrides: { blockBudgetMs: args.blockBudgetMs, setupBudgetMs: args.setupBudgetMs, sizingBudgetMs: args.sizingBudgetMs },
    transport: { producerReserved, transportCapacity, policyOwner: "BlockScanRuntimeLoop/createBlockScanPriceRuntime" },
    cacheRegime: "fresh producer each repetition; real predecessor build excluded; consecutive hot updates; provider-side cache uncontrolled",
    prerequisiteCache: { mode: args.prepareCache ? "capture" : args.inputCache ? "restore" : "none",
      directory: args.prepareCache ?? args.inputCache, measuredRpc: args.prepareCache || args.inputCache ? "loopback-passthrough" : "direct",
      localRestorationExcluded: true, measuredResultsCached: false },
    finalRevertCache: "fresh process cache; no independent final-sim decisions injected",
    scope: "actual head scheduler and runHead with diagnostic stop; sequential notifications; no independent final sim/EV",
    liveStarted: false, broadcast: false, signing: false, enumeration: stage !== "effective-update", simSizing: stage === "sim-amount" });
  const records: Array<Record<string, unknown> & { status: string; totalMs: number; stageMs: number | null }> = [];
  const sanitizedError = (error: unknown) => redactToolOutput(error instanceof Error ? error.message : String(error), env).slice(0, 4000);
  const experimentAbort = new AbortController();
  const interrupt = () => experimentAbort.abort(new Error("benchmark interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  let inputCache: PrerequisiteCache | undefined, inputManifest: PrerequisiteManifest | undefined;
  const compatibility = { readySha256, heads, cfg, identity, refineCandidates: settings.refineCandidates,
    executorRuntimeCodeHash: executorRuntimeCode?.keccak256 ?? null };
  const capturedHeads: PrerequisiteManifest["heads"] = {};
  const effectiveHash = (snapshot: AdapterRuntimeSnapshot) => sha256(atBlockJson([...snapshot.pricing.effectiveMids!.rows].map(([key, r]) =>
    [key, r.status, r.amountIn, r.amountOut]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
  const restorePhase = args.prepareCache ? "record" as const : "replay" as const;
  try {
    if (args.prepareCache || args.inputCache) {
      // Independent fresh canonical checks, never answered by the cassette.
      const canonical = await Promise.all([heads[0]!.number - 1, ...heads.map(h => h.number)].map(number =>
        readBlockScanObservedHeader(upstreamRpcUrl, 1n, number,
          { signal: experimentAbort.signal, deadlineAtMs: Date.now() + 30_000 })));
      for (let index = 1; index < canonical.length; index++) {
        assert.equal(canonical[index]!.hash.toLowerCase(), heads[index - 1]!.hash, "cached cohort is not canonical");
        assert.equal(canonical[index]!.parentHash.toLowerCase(), canonical[index - 1]!.hash.toLowerCase(), "cached cohort is not contiguous");
      }
      const opened = await PrerequisiteCache.open({ upstreamUrl: upstreamRpcUrl, mode: args.prepareCache ? "record" : "replay",
        directory: (args.prepareCache ?? args.inputCache)!, compatibility, onFault: error => experimentAbort.abort(error) });
      inputCache = opened.cache; inputManifest = opened.manifest; rpcUrl = opened.rpcUrl;
      save("cache-source-check.json", { canonical: canonical.map(h => ({ number: h.number, hash: h.hash })),
        reused: !!args.inputCache, measured: false });
    }
    for (let repetition = 0; repetition < args.repetitions; repetition++) {
      experimentAbort.signal.throwIfAborted();
      inputCache?.setPhase(restorePhase);
      const runtimeControl = createBenchmarkRuntimeAbort(experimentAbort.signal), abort = runtimeControl.controller;
      // Rehydrate per repetition; no target block dynamic cache is transplanted.
      const instances: PreparedFamilyInstance[] = [], funding: StrictReadyFundingAsset[] = [];
      for (const memo of memos) {
        const family = catalog.forStrictFamily(familyId(memo.familyId));
        const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: ready.cutoff });
        if (family.plugin.manifest.domain === "funding") {
          assert(instance && typeof instance === "object" && "asset" in instance && typeof instance.asset === "string" && ethers.isAddress(instance.asset));
          funding.push({ familyId: familyId(memo.familyId), asset: instance.asset });
        } else {
          assertIssuedPreparedFamilyInstance({ family, instance: instance as PreparedFamilyInstance, source: ready.cutoff, generation: ready.cutoff.generation });
          instances.push(instance as PreparedFamilyInstance);
        }
      }
      assert.equal(instances.length + funding.length, ready.activeInstanceKeys.length);
      const root = new StrictProductionRuntimeRoot({ catalog, readySource: ready.cutoff, readyGraph: graph, readyInstances: instances, readyFundingAssets: funding });
      const views = new StrictReadyGraphViewCoordinator({ catalog, ready, edges: graph });
      const provider: ethers.JsonRpcProvider = new ethers.JsonRpcProvider(rpcUrl);
      const scheduler = new RethTransportScheduler({ capacity: transportCapacity, producerReserved });
      let rpcReads: Array<{ method: string; wallMs: number; returned: boolean }> = [];
      const timed = async <T>(method: string, run: () => Promise<T>): Promise<T> => {
        const started = performance.now(); let returned = false;
        try { const value = await run(); returned = true; return value; }
        catch (error) {
          // Same fatal source policy as main; diagnostics stop/drain rather
          // than exiting the hosting process before writing the result.
          if (isRpcThrottleError(error)) abort.abort(new Error("activity RPC throttle"));
          throw error;
        }
        finally { rpcReads.push({ method, wallMs: performance.now() - started, returned }); }
      };
      const activity: BlockScanActivityPrefetch = new BlockScanActivityPrefetch({
        getLogs: filter => timed("eth_getLogs", () => provider.getLogs(filter)),
        send: (method, params) => timed(method, () => provider.send(method, params)),
      }, abort.signal);
      // These are the ordinary production dependencies. through=prices never
      // leases a worker, starts Anvil, enumerates, plans, solves or simulates.
      const state = new AnvilStateBackend(rpcUrl, "http://127.0.0.1:1", 1);
      let loop: BlockScanRuntimeLoop | undefined;
      try {
        const chainId: bigint = (await provider.getNetwork()).chainId;
        assert.equal(chainId, 1n, "mainnet Ready requires Ethereum chain ID 1");
        let lastPublicationKind: string | undefined;
        const prices = createBlockScanPriceRuntime({ provider, rpcUrl, ...identity, strictRuntimeRoot: root, blockScanRuntimeAbort: abort,
          blockScanRethTransportScheduler: scheduler, blockScanCfg: cfg, recordPricing: p => { lastPublicationKind = p.kind; } });
        const sourceFactory = createLiveSourceSimulationFactory({ rpcUrl, chainId: Number(chainId), executablePath,
          timeoutMs: settings.sourceSimulationTimeoutMs, runtimeAbort: abort, onFatal: () => abort.abort(new Error("strict simulation source failure")), executorRuntimeCode });
        let observedHeader: BlockScanObservedHeader | undefined;
        const planner = new TemplatePlanner(), rejects = new BlockScanSimRejectCache();
        const plannerSettings = resolveLiveBackrunSettings(env).planner;
        planner.setGraph([...graph]);
        planner.setProfitTokenValuation(DEFAULT_PROFIT_TOKEN_VALUATION);
        planner.setMaxCandidates(plannerSettings.maxCandidates);
        planner.setMaxRotationsPerPath(plannerSettings.maxRotationsPerPath);
        let amountEvents: Array<Record<string, unknown>> = [], solvedInputs: Array<Record<string, unknown>> = [];
        let diagnostic: LiveDiagnostic | undefined;
        loop = new BlockScanRuntimeLoop({ enabled: true, blockScanConfig: cfg,
          diagnosticForHead: () => diagnostic,
          executionWorkers: [{ state, solver: new AnvilSolver(), simulator: new BotVMSimulator(state, executor, owner) }],
          finalSimulationWorkers: [], directFinalSimulation: Object.assign(new EthSimulateV1Simulator(rpcUrl, executor, owner, executorRuntimeCode), { concurrency: settings.finalSimulationConcurrency }),
          amountSelectorFactory: createBlockScanLiveAmountSelectorFactory({ executor, quoteConcurrency: search.quoteConcurrency,
            record: ({ source, workerIndex, event }) => { amountEvents.push({ ...event, sourceBlock: source.number, generation: source.generation, workerIndex }); } }),
          rpcUrl, strictSession: prices.strictSessionFor, sourceSimulationFactory: sourceFactory, rethTransportScheduler: scheduler, runtimeAbort: abort,
          sharedPlanner: planner, backrunStatePublisher: { publish() {} },
          frozenTopology: { topologyKey, observeHeader: (number, control) => activity.observeHeader(number, async () => {
            const header = await timed("eth_getBlockByNumber", () => readBlockScanObservedHeader(rpcUrl, chainId, number, control));
            prices.blockScanAmountReference.observeHeader(header); observedHeader = header; return header;
          }, control) },
          blind: { enabled: false, activeSource: () => null, preparedBase: () => null, preparedArtifacts: () => null, dynamicResetNonce: () => null },
          exactRefineEnabled: false, exactRefineHardBudgetMs: settings.exactRefineHardBudgetMs, largeGraphEdgeThreshold: settings.largeGraphEdgeThreshold,
          passBudgetMs: blockBudgetMs, largeGraphPassBudgetMs: blockBudgetMs,
          startupWarmEnabled: true, startupWarmBudgetMs: setupBudgetMs, hotPricingFamilyBudgetMs: familyBudgetMs, runtimePublicationReserveMs: reserveMs,
          refineCandidates: settings.refineCandidates, solveReserveMs: settings.solveReserveMs, solverGridHalfWidth: search.gridHalfWidth, solverAmountGrid: search.amountGrid,
          solverGssMaxTries: search.gssMaxTries, solverQuoteConcurrency: search.quoteConcurrency, amountReference: prices.blockScanAmountReference,
          solverQuoteToleranceRawUnits: search.quoteToleranceRawUnits,
          exactConcurrency: settings.exactConcurrency, exactProbeTimeoutMs: settings.exactProbeTimeoutMs,
          exactRpcBatchSize: settings.exactRpcBatchSize, exactRpcBatchConcurrency: settings.exactRpcBatchConcurrency, executorAddress: executor,
          readBlockSwapTouched: (number, header, range) => activity.withBlockActivity(header?.hash,
            () => readBlockTouchedStateKeys(activity, number, ADDR.UNISWAP_V4_POOL_MANAGER,
              header?.transactionHashes === undefined ? undefined : { ...header, transactionHashes: header.transactionHashes },
              range === undefined ? undefined : { ...range, readHeader: n => readBlockScanObservedHeader(rpcUrl, chainId, n, range) },
              root.resolveBlockTouchedStateKeys), range),
          currentHeadEvidenceFamilyForEdge: id => declarations.currentHeadEvidenceFamilyForEdge(id),
          currentHeadEvidenceScopeKeyForEdge: edge => declarations.currentHeadEvidenceScopeKeyForEdge(edge),
          currentHeadEvidenceScopeKeys: evidence => declarations.currentHeadEvidenceScopeKeys(evidence),
          isCurrentHeadEvidenceFamily: id => declarations.isCurrentHeadEvidenceFamily(id), isShuttingDown: () => abort.signal.aborted,
          blockScanGraph: () => graph, blockScanPlanner: () => planner, currentRuntimeCoordinator: () => prices.currentRuntimeCoordinator,
          flashTokens: () => funding.map(f => f.asset), buildGraphView: input => views.build(input),
          readBlockHash: async (_provider, n) => (await readBlockScanObservedHeader(rpcUrl, chainId, n, { signal: abort.signal, deadlineAtMs: Date.now() + 30000 })).hash,
          formatRouteKey: opportunity => blockScanRouteId(opportunity.seedEdges),
          formatRing: opportunity => opportunity.seedEdges.map(e => e.tokenIn).join(" → "),
          isRouteSimRejected: opportunity => rejects.has(blockScanRouteId(opportunity.seedEdges)),
          recordSolvedInput: input => { solvedInputs.push({ solverIndex: input.solverIndex, candidateIndex: input.candidateIndex,
            source: input.source, routeId: blockScanRouteId(input.opportunity.seedEdges),
            flashAmount: input.resolved.flashAmount, profitToken: input.resolved.profitToken,
            actualProfit: input.resolved.netProfit, scriptSha256: sha256(input.scriptHex) }); },
          submitAtomic: async () => { throw new Error("stage benchmark cannot enter final sim/EV or submit"); },
        });
        const predecessor = await readBlockScanObservedHeader(rpcUrl, chainId, heads[0]!.number - 1,
          { signal: abort.signal, deadlineAtMs: Date.now() + 30000 });
        const run = (head: Head, setup: boolean): ReturnType<typeof measureLiveHead> => withoutProductionConsole(async () => {
          inputCache?.setPhase(restorePhase);
          // Outer experiment safety stop covers both diagnostic phases and
          // joined cleanup. Startup may normally resume indefinitely.
          const budgetMs = setup ? setupBudgetMs * 2 : blockBudgetMs;
          const sizingBudgetMs = setup ? undefined : args.sizingBudgetMs;
          const guard = setTimeout(() => abort.abort(new Error("benchmark outer wall limit")), budgetMs + (sizingBudgetMs ?? 0) + 60000);
          const failures: string[] = [];
          try { return await measureLiveHead({ stage, head, setup, loop: loop!, budgetMs, sizingBudgetMs, signal: abort.signal,
            setDiagnostic: value => { diagnostic = value; },
            noteHead: h => activity.noteHead(h.number, h.hash),
            onMeasuredStageStart: () => inputCache?.setPhase("measured"),
            recordFailure: error => { failures.push(sanitizedError(error)); },
            latestPricing: () => prices.currentRuntimeCoordinator.latestPricingSnapshot() }); }
          finally {
            clearTimeout(guard);
            if (failures.length) save(`diagnostics-${repetition + 1}-${head.number}.json`, { failures });
          }
        });
        const setup = await run(predecessor, true);
        inputCache?.assertHealthy();
        save(`setup-${repetition + 1}.json`, { measured: false, source: predecessor, ...setup.metrics, prerequisiteCache: inputCache?.stats() });
        assert.equal(setup.metrics.status, "completed", "predecessor setup failed; no hot samples measured");
        if (inputCache) {
          const output = { effectiveSha256: effectiveHash(setup.snapshot!), candidatesSha256: null };
          if (inputManifest) assert.equal(output.effectiveSha256, inputManifest.heads[String(predecessor.number)]?.effectiveSha256,
            "restored predecessor differs from cached input; rebuild the prerequisite cache");
          capturedHeads[String(predecessor.number)] = output;
        }
        for (const head of heads) {
          assert.equal(prices.currentRuntimeCoordinator.latestPricingSnapshot()?.sourceBlock, head.number - 1, "missing genuine predecessor table");
          rpcReads = []; lastPublicationKind = undefined; amountEvents = []; solvedInputs = [];
          const beforeCache = inputCache?.stats();
          const measured = await run(head, false), snapshot = measured.snapshot, effective = snapshot?.pricing.effectiveMids;
          inputCache?.assertHealthy();
          const outputSha256 = snapshot && effective ? effectiveHash(snapshot) : null;
          const enumerationInput = measured.enumeration?.opportunities.map(opp => ({ routeId: blockScanRouteId(opp.seedEdges),
            flashToken: opp.flashToken, searchSeed: opp.searchSeed, seedEdges: opp.seedEdges }));
          const candidateInputSha256 = enumerationInput ? sha256(atBlockJson(enumerationInput)) : null;
          const expected = inputManifest?.heads[String(head.number)];
          if (inputManifest && stage !== "effective-update") {
            assert.equal(outputSha256, expected?.effectiveSha256, "restored effective input changed; rebuild the prerequisite cache");
            if (stage === "sim-amount") assert.equal(candidateInputSha256, expected?.candidatesSha256,
              "restored natural candidates changed; rebuild the prerequisite cache");
          }
          if (inputCache && outputSha256) capturedHeads[String(head.number)] = { effectiveSha256: outputSha256, candidatesSha256: candidateInputSha256 };
          const sizing = stage === "sim-amount" ? { candidateInputSha256,
            naturalSelection: measured.enumeration?.selection, enumerationOutcome: measured.enumeration?.outcome,
            planned: measured.metrics.live?.planned, dispatched: measured.solvers.length,
            routeOutcomes: measured.solvers.reduce<Record<string, number>>((counts, s) => { counts[s.outcome] = (counts[s.outcome] ?? 0) + 1; return counts; }, {}),
            trialCount: amountEvents.filter(e => e.type === "amount_trial").length,
            searchCount: amountEvents.filter(e => e.type === "amount_search").length,
            positiveTrialCount: amountEvents.filter(e => e.type === "amount_trial" && e.success).length,
            // Service-time sums overlap. They are NOT the elapsed stage time.
            serviceTotals: measured.solvers.reduce((a, s) => ({ quoteMs: a.quoteMs + s.timing.quoteMs,
              planBuildMs: a.planBuildMs + s.timing.planBuildMs, simMs: a.simMs + s.timing.simMs }), { quoteMs: 0, planBuildMs: 0, simMs: 0 }),
          } : null;
          const row = { repetition: repetition + 1, block: head.number, sourceHash: head.hash, ...measured.metrics,
            prerequisiteCache: inputCache ? { before: beforeCache, after: inputCache.stats(),
              restoredEffectiveMatches: expected ? outputSha256 === expected.effectiveSha256 : null,
              restoredCandidatesMatch: expected ? candidateInputSha256 === expected.candidatesSha256 : null } : undefined,
            publicationKind: lastPublicationKind, rpcReads, outputSha256,
            sizing,
            effective: effective ? { complete: effective.complete, total: effective.rows.size,
              reference: effective.reference, referenceWethInput: effective.referenceWethInput,
              carried: [...effective.rows.values()].filter(r => effectiveMidRowCarried(effective, r)).length,
              statuses: [...effective.rows.values()].reduce<Record<string, number>>((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {}) } : null };
          records.push(row); save(`run-${repetition + 1}-${head.number}.json`, row);
          if (stage !== "effective-update") save(`${stage === "sim-amount" ? "sizing" : "enumeration"}-${repetition + 1}-${head.number}.json`, {
            input: enumerationInput, candidateInputSha256, routeResults: measured.solvers, amountEvents, solvedInputs,
            environment: { state: head, execution: "production next-block (N+1)", sourceHeader: observedHeader },
          });
          // A timed-out search can still publish a valid price table. Keep its
          // result and continue the cohort, just as the next live head does.
          assert(snapshot, "missing price snapshot; next head has no genuine predecessor");
          assertEffectivePublication(snapshot, prices.currentRuntimeCoordinator.latestPricingSnapshot(), head);
          const prior = records.filter(r => r.block === head.number);
          const stableEffective = new Set(prior.map(r => r.outputSha256)).size === 1;
          save(`parity-${repetition + 1}-${head.number}.json`, { stableEffective,
            // Resource/time-dependent edge failures may change the next run's
            // input. Report incomparable instead of quietly claiming same-input.
            stableCandidates: stage === "sim-amount" ? new Set(prior.map(r => (r.sizing as typeof sizing)?.candidateInputSha256)).size === 1 : null });
          if (args["save-prices"]) save(`prices-${repetition + 1}-${head.number}.json`, { readyPath: args.ready, readySha256, cfg, runtime: snapshot, header: observedHeader });
        }
      } finally {
        try { await withoutProductionConsole(async () => { await loop?.shutdown(); await activity.closeAndDrain(); }); }
        finally { runtimeControl.detach(); state.stop(); provider.destroy(); }
      }
    }
    for (const b of bindings) assert.equal(sha256(readFileSync(b.path)), b.sha256, "benchmark input/source changed during run");
    if (args.prepareCache) {
      assert(records.length === heads.length && records.every(r => r.status === "completed"), "incomplete capture cannot become a reusable cache");
      const manifest = inputCache!.save(args.prepareCache, { compatibility, heads: capturedHeads,
        producer: { head: git("rev-parse", "HEAD"), bindings, createdAt: new Date().toISOString() } });
      save("cache-built.json", { directory: args.prepareCache, entryCount: manifest.entryCount, rpcSha256: manifest.rpcSha256 });
    }
    const measuredStages = records.flatMap(r => r.stageMs === null ? [] : [r.stageMs]);
    const summary = { status: "completed", benchmark: stage, runs: records.length, completed: records.filter(r => r.status === "completed").length,
      outcomes: records.reduce<Record<string, number>>((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {}),
      notReached: records.filter(r => r.stageMs === null).length,
      stageMs: measuredStages.length ? distribution(measuredStages) : null,
      byBlock: heads.map(head => {
        const rows = records.filter(r => r.block === head.number), values = rows.flatMap(r => r.stageMs === null ? [] : [r.stageMs]);
        const complete = rows.length === args.repetitions && rows.every(r => r.status === "completed" && r.stageMs !== null);
        return { block: head.number, expectedRuns: args.repetitions, samples: rows.map(r => ({ repetition: r.repetition, status: r.status,
          stageMs: r.stageMs, prerequisitesMs: r.prerequisitesMs })),
          completeMedianMs: complete ? distribution(values).p50 : null,
          allObserved: values.length ? distribution(values) : null };
      }),
      totalMs: distribution(records.map(r => r.totalMs)), coldStartIncluded: false, liveStarted: false, broadcast: false,
      interpretation: "isolated historical RPC stage timing, not real-time live acceptance", inputsUnchanged: true };
    save("summary.json", summary); console.log(atBlockJson(summary));
  } catch (error) {
    save("failure.json", { status: "failed", attemptedMeasuredHeads: records.length, plannedMeasuredHeads: heads.length * args.repetitions,
      failureType: error instanceof Error ? error.name : "UnknownError", reason: sanitizedError(error),
      prerequisiteCache: inputCache?.stats(),
      completed: records.filter(r => r.status === "completed").length });
    throw error;
  } finally {
    experimentAbort.abort(); await inputCache?.close();
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
}

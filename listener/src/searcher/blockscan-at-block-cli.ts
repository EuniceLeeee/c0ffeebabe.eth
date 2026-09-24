import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { AnvilStateBackend } from "../shared/state/state-backend.js";
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
import { createBlockScanPriceRuntime, createLiveSourceSimulationFactory, maybeSubmitBlockScanAtomic,
  resolveBlockScanCoreConfig, resolveBlockScanRefineCandidates, resolveBlockScanAtomicPolicy } from "./main.js";
import { RethTransportScheduler } from "./reth-transport-scheduler.js";
import { parseBlockScanObservedHeader } from "./blockscan-observed-header.js";
import { TemplatePlanner } from "./planner/planner.js";
import { AnvilSolver } from "./solver/solver.js";
import { BotVMSimulator } from "./simulator/botvm-simulator.js";
import { EthSimulateV1Simulator, buildEthSimulateV1ExecutionInput } from "./simulator/eth-simulate-v1.js";
import { SourceBlockSimulator } from "./simulator/source-block.js";
import { resolveBlockScanSolverSearchConfig } from "./blockscan-solver-search-config.js";
import { BlockScanSimRejectCache } from "./blockscan-sim-reject-cache.js";
import { DEFAULT_PROFIT_TOKEN_VALUATION } from "./profit-token-valuation.js";
import { createBlockScanExecutionAvailability } from "./blockscan-pending-evidence.js";
import { detectProductionBlockScanOpportunities, assertAtomicBlockScanRuntime } from "./detector/blockscan-scanner-production.js";
import type { AdapterRuntimeSnapshot } from "./adapter-runtime-coordinator.js";

const HELP = `Usage: npm run searcher:at-block -- --ready CHECKPOINT --block NUMBER --out NEW_DIRECTORY
  --prices FILE          Reuse a saved price-table's Ready; refresh at --block.
  --offline              Enumerate saved prices without RPC (requires matching --block).
  --through STAGE        prices | enumerate | solver | ev (default: ev).
  --spread-bps NUMBER    Enumeration spread; 50 = 0.5%, 0 = strictly >0%.
  --admission-bps NUMBER Exact/Solver admission; default is the live policy.
  --budget-ms NUMBER     Historical single-pass window (default: 120000).
  --env-file FILE        Read RPC URL, public executor/owner and simulator path only.
  --executor ADDRESS --owner ADDRESS  Public execution identity, required through EV.
  --revm-bin FILE        Existing strict quote-simulation engine.
  --execution-mode MODE next-block (default) | source-block (historical only).
  --executor-runtime-code FILE  Hash-bound {code, keccak256}; source-block only, no deployment.
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
    "env-file": { type: "string" }, executor: { type: "string" }, owner: { type: "string" }, "revm-bin": { type: "string" },
    "execution-mode": { type: "string" },
    "executor-runtime-code": { type: "string" },
  } });
  if (v.help) return null;
  const block = Number(v.block), budgetMs = Number(v["budget-ms"] ?? "120000");
  assert(v.block && /^\d+$/.test(v.block) && Number.isSafeInteger(block) && block > 0, "--block must be an explicit positive block number");
  assert(v.ready || v.prices, "--ready or --prices is required");
  assert(!(v.ready && v.prices), "Use one input: --ready or --prices");
  assert(v.out, "--out is required");
  const through = v.through ?? (v.offline ? "enumerate" : "ev");
  const executionMode = v["execution-mode"] ?? "next-block";
  assert(executionMode === "next-block" || executionMode === "source-block", "invalid --execution-mode");
  assert(!v["executor-runtime-code"] || (executionMode === "source-block" && !v.offline),
    "--executor-runtime-code requires online source-block mode");
  assert(through === "prices" || through === "enumerate" || through === "solver" || through === "ev", "invalid --through");
  assert(!v.offline || (v.prices && through === "enumerate"), "--offline requires --prices and --through enumerate");
  assert(Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= 3_600_000, "invalid --budget-ms");
  for (const k of ["spread-bps", "admission-bps"] as const) {
    assert(v[k] === undefined || (/^\d+(?:\.\d+)?$/.test(v[k]!) && Number(v[k]) <= 10_000), `invalid --${k}`);
  }
  return { ...v, executionMode, through: through as "prices" | "enumerate" | "solver" | "ev", block, budgetMs, out: resolve(v.out) };
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

export async function runAtBlock(argv: string[]): Promise<void> {
  const args = parseAtBlockArgs(argv);
  if (!args) { console.log(HELP); return; }
  const env = { ...publicEnvironment(args["env-file"]), ...process.env };
  assertFamilyActivationEnvironment(PRODUCTION_FAMILY_ACTIVATIONS, env);
  assert(!existsSync(args.out), "--out must be a new directory; input files are never overwritten");
  mkdirSync(args.out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(resolve(args.out, name), atBlockJson(value), { flag: "wx", mode: 0o600 });
  const executorRuntimeCode = args["executor-runtime-code"]
    ? parseHistoricalExecutorRuntimeCode(readFileSync(args["executor-runtime-code"], "utf8")) : undefined;
  if (executorRuntimeCode) save("executor-runtime-code.json", executorRuntimeCode);
  const inputBytes = readFileSync(args.ready ?? args.prices!);
  const saved = args.prices ? parseAtBlockJson(inputBytes.toString()) : null;
  const configEnv: NodeJS.ProcessEnv = { ...process.env,
    ...(args["spread-bps"] === undefined ? {} : { SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS: args["spread-bps"] }),
    ...(args["admission-bps"] === undefined ? {} : { SEARCHER_BLOCKSCAN_EXACT_ADMISSION_SPREAD_BPS: args["admission-bps"] }),
  };
  const cfg = resolveBlockScanCoreConfig(configEnv);
  const coarseCfg = { ...cfg, maxCandidates: resolveBlockScanRefineCandidates(configEnv, cfg.maxCandidates) };
  const eligibility = createBlockScanExecutionAvailability({ mode: "periodic", evidence: [],
    familyForEdge: id => declarations.currentHeadEvidenceFamilyForEdge(id),
    edgeScopeKey: edge => declarations.currentHeadEvidenceScopeKeyForEdge(edge),
    evidenceScopeKeys: evidence => declarations.currentHeadEvidenceScopeKeys(evidence),
  });
  if (args.offline) {
    const snapshot = (saved.runtime ?? saved) as AdapterRuntimeSnapshot;
    assert.equal(snapshot.sourceBlock, args.block, "saved price source differs from --block; reprice online first");
    assertAtomicBlockScanRuntime(snapshot);
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
    save("summary.json", { mode: "offline", inputSha256: sha256(inputBytes), block: args.block,
      sourceHash: snapshot.sourceBlockHash, cfg: coarseCfg, wallMs, selection: result.selection, broadcast: false });
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
  const readyHash = sha256(readFileSync(readyPath));
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
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: ready.cutoff, readyGraph: graph,
    readyInstances: instances, readyFundingAssets: funding });
  const views = new StrictReadyGraphViewCoordinator({ catalog, ready, edges: graph });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("historical pass deadline")), args.budgetMs);
  const interrupt = () => abort.abort(new Error("historical pass interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const fetch = new ethers.FetchRequest(rpcUrl); fetch.timeout = 30_000;
  const provider = new ethers.JsonRpcProvider(fetch, undefined, { batchMaxCount: 1 });
  const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1, transportTimeoutMs: 30_000 });
  // Quote-only Solver and direct final sim do not start or fork this legacy resource.
  const state = new AnvilStateBackend(rpcUrl, "http://127.0.0.1:1", 1);
  let loop: BlockScanRuntimeLoop | undefined;
  try {
    const chainId = (await provider.getNetwork()).chainId;
    let anchor: ReturnType<typeof parseBlockScanObservedHeader> | undefined;
    let rawAnchor: Record<string, unknown> | undefined;
    const observeHeader = async (number: number) => {
      assert.equal(number, args.block);
      abort.signal.throwIfAborted();
      const raw = await provider.send("eth_getBlockByNumber", [ethers.toQuantity(number), false]);
      const header = parseBlockScanObservedHeader(raw, number, chainId);
      if (anchor) assert.equal(header.hash, anchor.hash, "historical source reorganized");
      else { anchor = header; rawAnchor = raw; }
      return header;
    };
    await observeHeader(args.block);
    const prices = createBlockScanPriceRuntime({ provider, rpcUrl, ...identity, strictRuntimeRoot: root,
      blockScanRuntimeAbort: abort, blockScanRethTransportScheduler: scheduler, blockScanCfg: cfg,
      recordPricing: () => {} });
    const planner = new TemplatePlanner(); planner.setGraph([...graph]);
    planner.setProfitTokenValuation(DEFAULT_PROFIT_TOKEN_VALUATION);
    planner.setMaxCandidates(Number(configEnv.SEARCHER_MAX_CANDIDATES ?? "20"));
    planner.setMaxRotationsPerPath(Number(configEnv.SEARCHER_MAX_ROTATIONS_PER_PATH ?? "3"));
    const search = resolveBlockScanSolverSearchConfig(configEnv);
    const simRejects = new BlockScanSimRejectCache();
    let sequence = 0;
    let simulationSequence = 0;
    let evSequence = 0;
    const executablePath = args["revm-bin"] ?? env.SEARCHER_REVM_SIM_BIN;
    const implementation = args.executionMode === "source-block" ? historicalImplementation(executablePath!) : undefined;
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
    const provenance = { readyPath, readySha256: readyHash, topologySource: ready.cutoff, stateSource: anchor,
      executionMode: args.executionMode, sourceHeader: rawAnchor, chainId: chainId.toString(),
      ...(executorRuntimeCode ? { counterfactualExecutorCode: { address: executor.toLowerCase(), keccak256: executorRuntimeCode.keccak256 } } : {}),
      ...(implementation ? { implementation } : {}),
      topologyContainsFutureDiscovery: ready.cutoff.number > args.block, historicalNaturalDiscoveryProven: false,
      broadcast: false, cfg, coarseCfg, policy, search, executor, owner, through: args.through, budgetMs: args.budgetMs };
    save("input.json", provenance);
    loop = new BlockScanRuntimeLoop({
      enabled: true, blockScanConfig: cfg, executionWorkers: [{ state, solver: new AnvilSolver(),
        simulator: new BotVMSimulator(state, executor, owner) }], finalSimulationWorkers: [],
      directFinalSimulation: sourceSimulator ?? Object.assign(new EthSimulateV1Simulator(rpcUrl, executor, owner), { concurrency: 1 }),
      rpcUrl, strictSession: prices.strictSessionFor, runtimeAbort: abort, rethTransportScheduler: scheduler,
      sourceSimulationFactory: createLiveSourceSimulationFactory({ rpcUrl, chainId: Number(chainId),
        executablePath: args["revm-bin"] ?? env.SEARCHER_REVM_SIM_BIN, timeoutMs: 120_000, runtimeAbort: abort,
        onFatal: reason => abort.abort(new Error(`strict simulator fatal: ${reason.kind}`)) }),
      sharedPlanner: planner, backrunStatePublisher: { publish() {} },
      frozenTopology: { topologyKey: `strict-ready:${ready.generation}:${ready.graphHash}`, observeHeader: async number => {
        const header = await observeHeader(number); prices.blockScanAmountReference.observeHeader(header); return header;
      } },
      blind: { enabled: false, activeSource: () => null, preparedBase: () => null, preparedArtifacts: () => null, dynamicResetNonce: () => null },
      exactRefineEnabled: configEnv.SEARCHER_BLOCKSCAN_EXACT_REFINE_ENABLED === "1",
      exactRefineHardBudgetMs: Number(configEnv.SEARCHER_BLOCKSCAN_EXACT_REFINE_HARD_BUDGET_MS ?? "4000"),
      largeGraphEdgeThreshold: 25_000, largeGraphPassBudgetMs: args.budgetMs, passBudgetMs: args.budgetMs,
      startupWarmEnabled: false, startupWarmBudgetMs: args.budgetMs, hotPricingFamilyBudgetMs: args.budgetMs,
      refineCandidates: coarseCfg.maxCandidates, solveReserveMs: 2500,
      solverGridHalfWidth: search.gridHalfWidth, solverAmountGrid: search.amountGrid, solverGssMaxTries: search.gssMaxTries,
      solverQuoteConcurrency: search.quoteConcurrency, amountReference: prices.blockScanAmountReference,
      // Historical opt-in forwards the resolved setting; default/live policy is unchanged.
      ...(sourceSimulator ? { solverQuoteToleranceRawUnits: search.quoteToleranceRawUnits } : {}),
      exactConcurrency: 16, exactProbeTimeoutMs: 4000, executorAddress: executor,
      readBlockSwapTouched: async () => new Set(graph.map(edge => (edge.poolId ?? edge.target).toLowerCase())),
      currentHeadEvidenceFamilyForEdge: id => declarations.currentHeadEvidenceFamilyForEdge(id),
      currentHeadEvidenceScopeKeyForEdge: edge => declarations.currentHeadEvidenceScopeKeyForEdge(edge),
      currentHeadEvidenceScopeKeys: evidence => declarations.currentHeadEvidenceScopeKeys(evidence),
      isCurrentHeadEvidenceFamily: id => declarations.isCurrentHeadEvidenceFamily(id),
      isShuttingDown: () => abort.signal.aborted, blockScanGraph: () => graph, blockScanPlanner: () => planner,
      currentRuntimeCoordinator: () => prices.currentRuntimeCoordinator, flashTokens: () => funding.map(f => f.asset),
      buildGraphView: input => views.build(input), readBlockHash: async (_provider, number) => (await observeHeader(number)).hash,
      formatRouteKey: opportunity => opportunity.seedEdges.map(e => `${e.adapterId}:${e.poolId ?? e.target}:${e.tokenIn}:${e.tokenOut}`).join("|"),
      formatRing: opportunity => opportunity.seedEdges.map(e => e.tokenIn).join(" → "),
      recordSolvedInput: input => save(`solver-${++sequence}.json`, { route: input.opportunity.seedEdges,
        ...(implementation ? { implementation } : {}),
        flashAmount: input.resolved.flashAmount, quoteProfit: input.resolved.netProfit,
        executionInput: sourceSimulator ? sourceSimulator.captureInput(input.resolved, input, input.scriptHex) : buildEthSimulateV1ExecutionInput({ ...input, executor, owner,
          profitToken: input.resolved.profitToken }) }),
      submitAtomic: input => maybeSubmitBlockScanAtomic({ ...input, provider, config: policy, historicalReadOnly: true,
        ...(sourceSimulator ? { historicalExecutionMode: "source-block" as const,
          onHistoricalEv: ({ evaluation, calldata }: { evaluation: Awaited<ReturnType<typeof import("./ev-evaluator.js").evaluateEv>>; calldata: string }) =>
            save(`ev-${++evSequence}.json`, { executionMode: "source-block", sourceBlock: input.sourceBlock,
              sourceBlockHash: input.sourceBlockHash, implementation, calldataSha256: sha256(Buffer.from(ethers.getBytes(calldata))),
              flashAmount: input.resolved.flashAmount, profitToken: input.resolved.profitToken, policy, evaluation }),
        } : {}),
        collectBlindAudit: true, simRejects,
        strategyVersions: { strategy_view_version: "historical-diagnostic", blockscan_view_hash: ready.graphHash },
        bundleRouter: { async submit() { throw new Error("historical CLI cannot submit"); } },
        submissionCoordinator: { offer() { throw new Error("historical CLI cannot submit"); } },
        onSuccessfulSimulation: sample => prices.blockScanAmountReference.recordSimulation(sample) }),
    });
    let finished = false;
    await loop.runHead(args.block, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() }, {
      through: args.through,
      onSnapshot: runtime => {
        save("prices.json", { schemaVersion: 1, readyPath, readySha256: readyHash, runtime });
        console.log(atBlockJson({ stage: "prices", block: args.block, raw: runtime.pricing.mids.size,
          effective: [...(runtime.pricing.effectiveMids?.rows.values() ?? [])].filter(r => r.status === "quoted").length }));
      },
      onEnumeration: result => save("enumeration.json", result),
      onComplete: result => { finished = true; save("summary.json", { ...provenance, ...result, solverInputs: sequence }); },
    });
    assert(finished, "single pass did not produce a terminal result");
    await observeHeader(args.block);
    assert.equal(sha256(readFileSync(readyPath)), readyHash, "Ready changed during diagnostic");
    if (implementation) assert.deepEqual(historicalImplementation(executablePath!), implementation, "historical implementation changed during pass");
    console.log(`Historical pass complete; results: ${args.out}`);
  } finally {
    clearTimeout(timeout); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    try { await loop?.shutdown(); } finally { state.stop(); provider.destroy(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runAtBlock(process.argv.slice(2)).catch(error => {
    const message = String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"'`]+/g, "[REDACTED_RPC]");
    console.error(`Historical pass failed: ${message}`); process.exitCode = 1;
  });
}

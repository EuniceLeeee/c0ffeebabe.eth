/**
 * Block-scan exemplar hunt harness.
 *
 * Mainnet-fork + dry-run only. Builds the real protocol-enriched graph at a
 * pinned block, scans it for standing dislocations, then fork-solves the top
 * ranked candidates on local Anvil state.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  AnvilStateBackend,
  type StateBackend,
  type StateCallControl,
} from "../../shared/state/state-backend.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import {
  diagnoseResolvedRingScore,
  estimateResolvedRingSpreadBps,
  isAdmissibleBlockScanRingShape,
  scanBlockStateFromResolvedMids,
  type ResolvedBlockScanMid,
} from "../detector/blockscan-scanner-core.js";
import {
  refineBlockScanCandidates,
  type BlockScanProbeDiagnostic,
} from "../detector/blockscan-candidate-refinement.js";
import {
  BlockScanStateCoordinator,
  type BlockScanStateSnapshot,
} from "../blockscan-state-coordinator.js";
import {
  JsonRpcBlockScanStateReadBackend,
} from "../blockscan-state-read-backend.js";
import {
  assessAdapterFamilyQuoteCoverage,
  blockScanPassBudgetExceeded,
  remapExpectedRouteToVerifiedGraph,
  resolveBlockScanHuntVerdict,
  resolveBlockScanHuntBudgets,
  routeMatchesExpected,
  routeStepMatchesExpected,
  selectedReplayOpportunityIndexes,
  solveForOpportunityIndex,
  type AdapterFamilyQuoteCoverageSummary,
} from "./blockscan-hunt-selection.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import {
  mergePoolProjectionRows,
  mergePoolRegistries,
} from "../active-pool-discovery.js";
import { TemplatePlanner } from "../planner/planner.js";
import {
  buildTokenPaths,
  buildTokenGraph,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenEdge,
  type TokenPath,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import { pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import {
  DEFAULT_POOL_UNIVERSE_PATH,
  loadPoolUniverse,
  poolProjectionRowKey,
} from "../pool-universe.js";
import {
  protocolCandidateAddressesFromDexGraph,
  protocolCandidateAddressesFromDexUniverse,
  protocolDiscoveryCandidateAddressHints,
  prepareActiveProtocolDiscoveryPass,
} from "../protocol-discovery-runtime.js";
import {
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  projectVerifiedProtocolPool,
} from "../protocol-instance-discovery.js";
import {
  advanceProtocolObservedContiguousAuthority,
  createProtocolDiscoveryEvidenceCache,
  reconcileProtocolDiscoveryEvidenceCache,
  recordProtocolRouteOwnership,
  saveProtocolDiscoveryEvidenceCache,
  updateProtocolObservedSourceFingerprint,
} from "../protocol-discovery-cache.js";
import {
  protocolDiscoverySourceFingerprints,
  protocolObservedSourceFingerprint,
} from "../observed-protocol-discovery.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { AnvilSolver, resolveSearchCenter, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { evaluateEv } from "../ev-evaluator.js";
import { DEFAULT_BRIBE_BPS } from "../live-envelope.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";
import { buildStrategyViews } from "../strategy-views.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
} from "../venues/production-registry.js";
import type { ProtocolCandidate } from "../venues/route-leg-adapter.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "../venues/admission.js";
import {
  attestPoolIdentities,
  isRetryablePoolIdentityFailure,
} from "../venues/identity.js";
import { createPinnedDexReadBackend } from "../runtime-pool-refresh.js";
import {
  blockScanEdgeKey,
  createVerifiedGraphView,
} from "../venues/blockscan-state-capability.js";
import {
  loadProductionReplayDiscoveredPools,
  PRODUCTION_REPLAY_ARTIFACT_PRODUCER,
  PRODUCTION_REPLAY_ARTIFACT_SCHEMA,
  selectProductionReplayDiscoveredPools,
  writeProductionReplayDiscoveryArtifact,
  type ProductionReplayUniverseEvidence,
} from "./production-replay-artifact.js";
import {
  loadTrustedHuntProtocolDiscoveryCache,
  type VerifiedRetainedTopologyProof,
} from "./blockscan-hunt-protocol-cache.js";

type DiagnosticStopAfter = "graph" | "enumeration" | "refine" | "solve" | "sim" | "ev";

interface DiagnosticOptions {
  enabled: boolean;
  maxCandidates?: number;
  scanBudgetMs?: number;
  passBudgetMs?: number;
  topK?: number;
  stopAfter?: DiagnosticStopAfter;
}

const DIAGNOSTIC = parseDiagnosticArgs(process.argv.slice(2));
const HUNT_PROTOCOL_CURSOR_SEMANTICS_VERSION =
  "family-source-contiguous-v3-hash-anchored";

interface HuntConfig {
  rpcUrl: string;
  blockNumber: number;
  universePath: string;
  maxPools: number;
  maxHops: number;
  minSpreadBps: number;
  scanBudgetMs: number;
  passBudgetMs: number;
  maxCandidates: number;
  topK: number;
  outPath: string;
  anvilPort: number;
}

interface OpportunityReport {
  rank: number;
  ring: string[];
  pools: string[];
  poolIds: string[];
  adapterIds: string[];
  spreadBps: number | null;
  searchCenter: string;
  maxInput: string;
  hasProtocolEdge: boolean;
  seedEdges: Array<{
    adapterId: string;
    target: string;
    tokenIn: string;
    tokenOut: string;
    slotKind: string;
    edgeKind: string;
    leavesStandingPosition: boolean;
    poolId?: string;
  }>;
  swapPath: Array<{ pool_id: string; direction: "0for1" | "1for0" }> | null;
  route: Array<{
    adapterId: string;
    slotKind: "swap" | "protocol";
    target: string;
    tokenIn: string;
    tokenOut: string;
    edgeKind?: string;
    leavesStandingPosition?: boolean;
    poolId?: string;
  }>;
}

interface SolveReport {
  opportunityIndex: number;
  ring: string[];
  pools: string[];
  spreadBps: number | null;
  planCount: number;
  solved: string | null;
  solveError: string | null;
  searchCenter: string | null;
  diagnosticHopAmounts?: Array<{
    adapterId: string;
    target: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
    rawAmountOut: string;
  }>;
  diagnosticAmountError?: string;
  diagnosticSimulation?: {
    success: boolean;
    profitToken: string;
    grossProfit: string;
    gasUsed: string;
    netProfit: string;
    calldataHash: string;
    revertReason: string | null;
  };
  diagnosticEv?: {
    decision:
      | "allow"
      | "below_ev_gate"
      | "unpriceable_profit_token"
      | "missing_gas_estimate"
      | "missing_fee_state"
      | "disabled";
    evGate: boolean;
    netEvWei: string;
    expectedProfitEth: string;
    gasCostEth: string;
    bidEth: string;
    minNetEth: string;
    decisionParentBlock: number;
    targetBlock: number;
    decisionParentHash: string | null;
    ethUsd: number | null;
    ethUsdRoundId: string | null;
    ethUsdUpdatedAt: string | null;
    maxBaseFeePerGas: string;
  };
}

let checks = 0;
let passed = 0;
let lastDiagnosticStep = 0;

function parseDiagnosticArgs(args: string[]): DiagnosticOptions {
  if (args.length === 0) return { enabled: false };
  const parsed: DiagnosticOptions = { enabled: false };
  for (let index = 0; index < args.length;) {
    const name = args[index++];
    if (name === "--diagnostic") {
      if (parsed.enabled) throw new Error("--diagnostic may appear only once");
      parsed.enabled = true;
      continue;
    }
    const value = args[index++];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires one value`);
    }
    if (name === "--max-candidates") {
      if (parsed.maxCandidates !== undefined) throw new Error(`${name} may appear only once`);
      parsed.maxCandidates = diagnosticPositiveInt(name, value);
    } else if (name === "--scan-budget-ms") {
      if (parsed.scanBudgetMs !== undefined) throw new Error(`${name} may appear only once`);
      parsed.scanBudgetMs = diagnosticPositiveInt(name, value);
    } else if (name === "--pass-budget-ms") {
      if (parsed.passBudgetMs !== undefined) throw new Error(`${name} may appear only once`);
      parsed.passBudgetMs = diagnosticPositiveInt(name, value);
    } else if (name === "--top-k") {
      if (parsed.topK !== undefined) throw new Error(`${name} may appear only once`);
      parsed.topK = diagnosticPositiveInt(name, value);
    } else if (name === "--stop-after") {
      if (parsed.stopAfter !== undefined) throw new Error(`${name} may appear only once`);
      if (!(["graph", "enumeration", "refine", "solve", "sim", "ev"] as string[]).includes(value)) {
        throw new Error("--stop-after must be graph|enumeration|refine|solve|sim|ev");
      }
      parsed.stopAfter = value as DiagnosticStopAfter;
    } else {
      throw new Error(`unsupported blockscan diagnostic option ${name}`);
    }
  }
  if (!parsed.enabled) {
    throw new Error("diagnostic options require --diagnostic");
  }
  return parsed;
}

function diagnosticPositiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function emitDiagnostic(
  step: 1 | 2 | 3 | 4 | 5 | 6,
  stage: string,
  status: "pass" | "fail" | "reject" | "not_reached",
  details: Record<string, unknown>,
): void {
  if (!DIAGNOSTIC.enabled) return;
  lastDiagnosticStep = Math.max(lastDiagnosticStep, step);
  console.log(`SIX_STEP_DIAGNOSTIC=${JSON.stringify({ step, stage, status, ...details })}`);
}

function diagnosticStopsAfter(stage: DiagnosticStopAfter): boolean {
  return DIAGNOSTIC.enabled && DIAGNOSTIC.stopAfter === stage;
}

function loadEnv(): void {
  if (process.env.SEARCHER_TEST_DISABLE_DOTENV === "1") return;
  let text = "";
  try {
    text = readFileSync(resolve("..", ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

function universeDiscoveryFromBlock(
  universePath: string,
  sourceBlock: number,
): number {
  let fromBlock: unknown;
  try {
    const parsed = JSON.parse(readFileSync(universePath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      fromBlock = (parsed as Record<string, unknown>).fromBlock;
    }
  } catch (error) {
    throw new Error(
      `cannot read protocol discovery range from ${universePath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const fallback = Math.max(
    0,
    sourceBlock - envInt("HUNT_PROTOCOL_DISCOVERY_BLOCKS", 14_400),
  );
  const resolved = fromBlock === undefined ? fallback : Number(fromBlock);
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 0 ||
    resolved > sourceBlock
  ) {
    throw new Error(
      `invalid protocol discovery range ${String(fromBlock)}..${sourceBlock}`,
    );
  }
  return resolved;
}

function huntUniverseEvidence(
  universePath: string,
  maxPools: number,
  selectedPoolCount: number,
): ProductionReplayUniverseEvidence {
  const bytes = readFileSync(universePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`pool universe file ${universePath} is not valid JSON`);
  }
  const record =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  const rawPools = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record?.pools)
      ? record.pools
      : null;
  if (!rawPools) {
    throw new Error(`pool universe file ${universePath} omits pools`);
  }
  const optionalInteger = (value: unknown, field: string): number | null => {
    if (value === undefined || value === null) return null;
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
      throw new Error(`${field} must be a non-negative safe integer`);
    }
    return parsedValue;
  };
  const optionalText = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new Error(`${field} must be a string`);
    return value;
  };
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    schemaVersion: optionalInteger(
      record?.schemaVersion,
      "universe.schemaVersion",
    ),
    generatedAt: optionalText(record?.generatedAt, "universe.generatedAt"),
    fromBlock: optionalInteger(record?.fromBlock, "universe.fromBlock"),
    toBlock: optionalInteger(record?.toBlock, "universe.toBlock"),
    rawPoolCount: rawPools.length,
    selectedPoolCount,
    maxPools,
    minScore: 1,
  };
}

function assertProtocolCacheNominationBootstrapMatches(input: {
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly universePath: string;
  readonly sourceFromBlock: number;
  readonly sourceToBlock: number;
  readonly discoveredProtocolPools: readonly PoolEntry[];
}): void {
  const universeBytes = readFileSync(input.universePath);
  const universeSha256 = createHash("sha256")
    .update(universeBytes)
    .digest("hex");
  const expectedUniverseSha256 =
    process.env.PRODUCTION_REPLAY_UNIVERSE_SHA256?.trim().toLowerCase() ?? "";
  if (
    !/^[0-9a-f]{64}$/.test(expectedUniverseSha256) ||
    expectedUniverseSha256 !== universeSha256
  ) {
    throw new Error(
      "protocol cache nomination source universe is absent or mismatched",
    );
  }

  const expectedPools = loadProductionReplayDiscoveredPools(
    input.artifactPath,
    input.artifactSha256.toLowerCase(),
  );
  let envelope: unknown;
  try {
    envelope = JSON.parse(readFileSync(input.artifactPath, "utf8"));
  } catch {
    throw new Error("protocol cache nomination artifact is not valid JSON");
  }
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope)
  ) {
    throw new Error("protocol cache nomination artifact must be an object");
  }
  const record = envelope as Record<string, unknown>;
  const sourceFromBlock = Number(record.sourceFromBlock);
  const sourceToBlock = Number(record.sourceToBlock);
  const identityBlock = Number(record.identityBlock);
  if (
    !Number.isSafeInteger(sourceFromBlock) ||
    !Number.isSafeInteger(sourceToBlock) ||
    !Number.isSafeInteger(identityBlock) ||
    sourceFromBlock !== input.sourceFromBlock ||
    sourceToBlock !== input.sourceToBlock ||
    identityBlock !== input.sourceToBlock
  ) {
    throw new Error(
      "protocol cache nomination artifact does not bind the reconstructed range",
    );
  }

  const expectedKeys = expectedPools.map(poolProjectionRowKey).sort();
  const actualKeys = input.discoveredProtocolPools
    .map(poolProjectionRowKey)
    .sort();
  const firstMismatch = expectedKeys.findIndex(
    (key, index) => actualKeys[index] !== key,
  );
  if (
    expectedKeys.length !== actualKeys.length ||
    firstMismatch >= 0
  ) {
    const index = firstMismatch >= 0
      ? firstMismatch
      : Math.min(expectedKeys.length, actualKeys.length);
    throw new Error(
      "protocol cache nomination projection differs from the sealed artifact: " +
        `expected=${expectedKeys.length} actual=${actualKeys.length} ` +
        `first=${expectedKeys[index] ?? "<end>"}|${actualKeys[index] ?? "<end>"}`,
    );
  }
  console.log(
    `HUNT_PROTOCOL_DISCOVERY_NOMINATION_PROOF=${JSON.stringify({
      artifactPath: input.artifactPath,
      artifactSha256: input.artifactSha256.toLowerCase(),
      universeSha256,
      sourceFromBlock,
      sourceToBlock,
      instances: actualKeys.length,
      projectionSha256: canonicalSetSha256(actualKeys),
    })}`,
  );
}

function huntGraphView(input: {
  readonly edges: readonly TokenEdge[];
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
}) {
  return createVerifiedGraphView({
    id:
      `blockscan-hunt:${canonicalSetSha256(
        input.edges.map(canonicalEdgeIdentity),
      )}`,
    generation: input.generation,
    sourceBlock: input.sourceBlock,
    sourceBlockHash: input.sourceBlockHash,
    completenessWatermark: input.sourceBlock,
    perSourceCoverage: PRODUCTION_ADAPTER_FAMILIES
      .blockScanStateFamilies()
      .map((family) => ({
        familyId: family.familyId,
        sourceId: "frozen-hunt-inputs",
        sourceFingerprint: canonicalSetSha256(
          input.edges.filter(family.ownsEdge).map(canonicalEdgeIdentity),
        ),
        completeThroughBlock: input.sourceBlock,
        completeThroughHash: input.sourceBlockHash,
      })),
    edges: input.edges,
    familyIdForEdge: (edge) =>
      PRODUCTION_ADAPTER_FAMILIES.routes().forEdge(edge.adapterId).id,
  });
}

async function check(name: string, run: () => boolean | Promise<boolean>): Promise<void> {
  checks += 1;
  let ok = false;
  try {
    ok = await run();
  } catch (err) {
    console.error(`[blockscan-hunt] ${name}: FAIL`);
    console.error(err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!ok) {
    console.error(`[blockscan-hunt] ${name}: FAIL`);
    throw new Error(name);
  }
  passed += 1;
  console.log(`[blockscan-hunt] ${name}: PASS`);
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required for block-scan hunt.");
  }
  const observedHistoryRpcUrl =
    process.env.HUNT_PROTOCOL_HISTORY_RPC_URL ??
    process.env.SEARCHER_PROTOCOL_DISCOVERY_ARCHIVE_RPC_URL ??
    (process.env.SEARCHER_LIVE_RPC_URL
      ? process.env.MAINNET_RPC_URL
      : undefined);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const observedHistoryProvider =
    observedHistoryRpcUrl && observedHistoryRpcUrl !== rpcUrl
      ? new ethers.JsonRpcProvider(
          observedHistoryRpcUrl,
          undefined,
          { batchMaxCount: 1 },
        )
      : undefined;
  const state = new AnvilStateBackend(
    rpcUrl,
    `http://127.0.0.1:${envInt("SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT", 8566)}`,
    envInt("SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT", 8566),
  );

  try {
    const latest = await withTimeout(
      provider.getBlockNumber(),
      30_000,
      `upstream RPC preflight ${redactRpcUrl(rpcUrl)}`,
      rpcUrl,
    );
    const blockNumber = resolveBlockNumber(latest);
    if (latest < blockNumber) {
      throw new Error(`upstream latest block ${latest} is before HUNT_BLOCK ${blockNumber}`);
    }
    const cfg = readConfig(rpcUrl, blockNumber);
    console.log(
      `[blockscan-hunt] upstream=${redactRpcUrl(rpcUrl)} block=${cfg.blockNumber} ` +
        `universe=${cfg.universePath} maxPools=${cfg.maxPools} maxHops=${cfg.maxHops} ` +
        `observedHistory=${observedHistoryProvider ? "separate-aligned" : "primary"}`,
    );

    const callBackend = new PinnedCallBackend(provider, cfg.blockNumber);
    const graphBackend = tokenBackend(provider, cfg.blockNumber);

    // The production-replay wrapper passes a hash-frozen copy of the live
    // runtime graph. Those rows are already admitted and intentionally omit
    // historical activity scores; filtering them again at minScore=1 would
    // erase the real live graph. Ordinary hunt inputs retain the scored
    // universe contract.
    const universeMinScore =
      process.env.PRODUCTION_REPLAY_DISCOVERY_ARTIFACT ? 0 : 1;
    const rawUniversePools = loadPoolUniverse(cfg.universePath, {
      maxPools: cfg.maxPools,
      minScore: universeMinScore,
    }).map(lowerPoolEntry);
    const staticProtocolPools = POOL_REGISTRY
      .filter((pool) => pool.adapter !== "fluid-vault")
      .map(lowerPoolEntry);
    const universeIdentity = await attestPoolIdentities(
      createPinnedDexReadBackend(provider, cfg.blockNumber),
      rawUniversePools,
      {
        identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
        admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
        seedEntries: staticProtocolPools,
      },
    );
    const retryableIdentityRejections = universeIdentity.rejected.filter(
      (rejection) => isRetryablePoolIdentityFailure(rejection.reason),
    );
    console.log(
      `DEX_IDENTITY_ATTESTATION=${JSON.stringify({
        sourceBlock: cfg.blockNumber,
        candidates: rawUniversePools.length,
        accepted: universeIdentity.accepted.length,
        rejected: universeIdentity.rejected.length,
        retryable: retryableIdentityRejections.length,
        reasons: Object.fromEntries(
          [...new Set(universeIdentity.rejected.map((item) => item.reason))]
            .sort()
            .map((reason) => [
              reason,
              universeIdentity.rejected.filter((item) => item.reason === reason)
                .length,
            ]),
        ),
      })}`,
    );
    if (retryableIdentityRejections.length > 0) {
      throw new Error(
        "source-pinned DEX identity attestation incomplete: " +
          `${retryableIdentityRejections.length} retryable candidates`,
      );
    }
    const universePools = universeIdentity.accepted.map(lowerPoolEntry);
    // Production starts from code-owned protocol seeds, then admits the
    // file-backed universe. Keep the same precedence so stale file metadata
    // cannot replace a newer exact adapter classification in the replay.
    const basePools = mergePoolRegistries(staticProtocolPools, universePools);
    const baseGraph = await buildTokenGraph(graphBackend, basePools);
    let protocolPools = staticProtocolPools;
    let pools = basePools;
    let rawEdges = baseGraph;
    let retainedProtocolTopologyProof:
      VerifiedRetainedTopologyProof | null = null;
    if (
      process.env.PRODUCTION_REPLAY_DISCOVERY_ARTIFACT &&
      (
        process.env.HUNT_PROTOCOL_DISCOVERY_CACHE_PATH?.trim() ||
        process.env.HUNT_PROTOCOL_DISCOVERY_CACHE_SHA256?.trim() ||
        process.env.HUNT_PROTOCOL_DISCOVERY_CACHE_OUT?.trim()
      )
    ) {
      throw new Error(
        "verified replay preload and hunt protocol discovery cache modes cannot be combined",
      );
    }
    if (!process.env.PRODUCTION_REPLAY_DISCOVERY_ARTIFACT) {
      const discoverableFamilies =
        PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes();
      const discoveryFamilySources = discoverableFamilies.map((family) => ({
        familyId: family.id,
        sourceIds: [...new Set(family.discovery!.candidateSources)],
      }));
      const dexPoolAdapters = new Set(
        PRODUCTION_ADAPTER_FAMILIES.swaps()
          .flatMap((family) => [...family.poolAdapters]),
      );
      const graphTokens = [...new Set([
        ...protocolCandidateAddressesFromDexUniverse(
          universePools,
          dexPoolAdapters,
        ),
        ...protocolCandidateAddressesFromDexGraph(baseGraph),
      ])].sort();
      const candidateAddresses = [...new Set([
        ...graphTokens,
        ...protocolDiscoveryCandidateAddressHints(discoverableFamilies),
      ])].sort();
      const protocolChainId = (await provider.getNetwork()).chainId;
      const observedSourceFingerprint = `0x${createHash("sha256")
        .update(HUNT_PROTOCOL_CURSOR_SEMANTICS_VERSION)
        .update(":")
        .update(protocolObservedSourceFingerprint(discoverableFamilies))
        .digest("hex")}`;
      const discoverySourceFingerprints =
        protocolDiscoverySourceFingerprints(discoverableFamilies);
      const cacheInputPath =
        process.env.HUNT_PROTOCOL_DISCOVERY_CACHE_PATH?.trim() || null;
      const cacheInputSha256 =
        process.env.HUNT_PROTOCOL_DISCOVERY_CACHE_SHA256?.trim() || null;
      const cacheOutputPath =
        process.env.HUNT_PROTOCOL_DISCOVERY_CACHE_OUT?.trim() || null;
      const bootstrapArtifactPath =
        process.env.HUNT_PROTOCOL_DISCOVERY_BOOTSTRAP_ARTIFACT?.trim() || null;
      const bootstrapArtifactSha256 =
        process.env.HUNT_PROTOCOL_DISCOVERY_BOOTSTRAP_ARTIFACT_SHA256?.trim() ||
        null;
      if ((cacheInputPath === null) !== (cacheInputSha256 === null)) {
        throw new Error(
          "HUNT_PROTOCOL_DISCOVERY_CACHE_PATH and " +
            "HUNT_PROTOCOL_DISCOVERY_CACHE_SHA256 must be supplied together",
        );
      }
      if (
        (bootstrapArtifactPath === null) !==
          (bootstrapArtifactSha256 === null)
      ) {
        throw new Error(
          "HUNT_PROTOCOL_DISCOVERY_BOOTSTRAP_ARTIFACT and " +
            "HUNT_PROTOCOL_DISCOVERY_BOOTSTRAP_ARTIFACT_SHA256 " +
            "must be supplied together",
        );
      }
      if (
        cacheInputPath !== null &&
        bootstrapArtifactPath !== null
      ) {
        throw new Error(
          "a sealed cache delta cannot also consume a nomination bootstrap",
        );
      }
      if (
        cacheOutputPath !== null &&
        cacheInputPath === null &&
        bootstrapArtifactPath === null
      ) {
        throw new Error(
          "a first protocol cache requires a sealed nomination artifact",
        );
      }
      if (
        cacheInputPath &&
        process.env.HUNT_DISCOVERY_ARTIFACT_OUT?.trim()
      ) {
        throw new Error(
          "a delta-seeded hunt cannot emit a discovery artifact with a false full-range claim",
        );
      }

      let protocolDiscoveryCache =
        createProtocolDiscoveryEvidenceCache(protocolChainId);
      let currentOwnership = EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP;
      let bootstrapCandidates:
        | ReadonlyMap<
            string,
            readonly ProtocolCandidate[]
          >
        | undefined;
      let discoveryFromBlock = universeDiscoveryFromBlock(
        cfg.universePath,
        cfg.blockNumber,
      );
      let cacheProvenance: {
        readonly mode: "history-reconstruction" | "sealed-cache-delta";
        readonly inputSha256: string | null;
        readonly cursor: number | null;
        readonly cursorHash: string | null;
        readonly retainedOwnership: number;
        readonly cachedCandidates: number;
      };
      if (cacheInputPath && cacheInputSha256) {
        const trusted = await loadTrustedHuntProtocolDiscoveryCache({
          path: cacheInputPath,
          expectedSha256: cacheInputSha256,
          expectedChainId: protocolChainId,
          maxCursor: cfg.blockNumber - 1,
          expectedObservedSourceFingerprint: observedSourceFingerprint,
          expectedDiscoverySourceFingerprints: discoverySourceFingerprints,
          readCanonicalBlockHash: async (blockNumber) =>
            (await provider.getBlock(blockNumber))?.hash?.toLowerCase() ?? null,
        });
        protocolDiscoveryCache = trusted.cache;
        currentOwnership = trusted.ownership;
        bootstrapCandidates = trusted.bootstrapCandidates;
        discoveryFromBlock = trusted.cursor + 1;
        retainedProtocolTopologyProof = trusted.topologyProof;
        cacheProvenance = {
          mode: "sealed-cache-delta",
          inputSha256: trusted.contentSha256,
          cursor: trusted.cursor,
          cursorHash: trusted.cursorHash,
          retainedOwnership: trusted.ownership.admissions.size,
          cachedCandidates: trusted.cache.verifiedCandidates.size,
        };
        console.log(
          `HUNT_PROTOCOL_RETAINED_TOPOLOGY=${JSON.stringify({
            status:
              trusted.topologyProof === null
                ? "nominations_only"
                : "contiguous",
            cursor: trusted.cursor,
            cursorHash: trusted.cursorHash,
          })}`,
        );
      } else {
        updateProtocolObservedSourceFingerprint(
          protocolDiscoveryCache,
          observedSourceFingerprint,
          discoverySourceFingerprints,
        );
        cacheProvenance = {
          mode: "history-reconstruction",
          inputSha256: null,
          cursor: null,
          cursorHash: null,
          retainedOwnership: 0,
          cachedCandidates: 0,
        };
      }
      console.log(
        `HUNT_PROTOCOL_DISCOVERY_CACHE_PROVENANCE=${JSON.stringify({
          ...cacheProvenance,
          scanFromBlock: discoveryFromBlock,
          scanToBlock: cfg.blockNumber,
          observedSourceFingerprint,
          discoverySourceFingerprints: [...discoverySourceFingerprints]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([familyId, fingerprint]) => ({ familyId, fingerprint })),
        })}`,
      );
      const protocolSourceHeaderBefore = await provider.getBlock(
        cfg.blockNumber,
      );
      if (!protocolSourceHeaderBefore?.hash) {
        throw new Error(
          `cannot resolve protocol discovery source ${cfg.blockNumber}`,
        );
      }
      const protocolDiscovery = await prepareActiveProtocolDiscoveryPass({
        provider,
        ...(observedHistoryProvider === undefined
          ? {}
          : { observedHistoryProvider }),
        adapters: discoverableFamilies,
        identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
        protocolEdgesEnabled: true,
        chainId: protocolChainId,
        probeExecutor: DEFAULT_SEARCHER_EXECUTOR,
        currentOwnership,
        currentBackrunPools: basePools,
        currentBackrunGraph: baseGraph,
        currentBlockscanGraph: baseGraph,
        buildStrategyViews: (viewPools) =>
          buildStrategyViews(viewPools, [], [], {
            blockscanMaxPools: 0,
            poolUniverseGeneratedAt: `blockscan-hunt:${cfg.blockNumber}`,
          }),
        blockNumber: cfg.blockNumber,
        fromBlock: discoveryFromBlock,
        toBlock: cfg.blockNumber,
        graphTokens,
        candidateAddresses,
        evidenceCache: protocolDiscoveryCache,
        ...(bootstrapCandidates === undefined
          ? {}
          : { bootstrapCandidates }),
        shadow: false,
      });
      const incompleteFamilySources =
        protocolDiscovery.result.familySourceCoverage
          .filter((item) => !item.complete)
          .map((item) => ({
            familyId: item.familyId,
            sourceId: item.sourceId,
            issues: item.issues,
          }));
      console.log(
        `PROTOCOL_DISCOVERY_DIAGNOSTIC=${JSON.stringify({
          scannerSourceComplete: protocolDiscovery.scanner.sourceComplete,
          eventSourceComplete:
            protocolDiscovery.scanner.eventSourceComplete,
          addressSourceComplete:
            protocolDiscovery.scanner.addressSourceComplete,
          resultSourceComplete: protocolDiscovery.result.sourceComplete,
          evaluationComplete:
            protocolDiscovery.result.evaluationComplete,
          projection: protocolDiscovery.projection !== null,
          addressStats: protocolDiscovery.scanner.addressStats,
          sourceErrors: protocolDiscovery.scanner.sourceErrors,
          incompleteFamilySources,
          candidates: [
            ...protocolDiscovery.scanner.candidatesByAdapter.values(),
          ].reduce((sum, items) => sum + items.length, 0),
          wouldAdmit: protocolDiscovery.result.wouldAdmit.length,
        })}`,
      );
      await check("active protocol discovery completed", () =>
        protocolDiscovery.scanner.sourceComplete &&
        protocolDiscovery.result.sourceComplete &&
        protocolDiscovery.result.evaluationComplete &&
        protocolDiscovery.projection !== null,
      );
      if (!protocolDiscovery.projection) {
        throw new Error("active protocol discovery produced no graph projection");
      }
      reconcileProtocolDiscoveryEvidenceCache(
        protocolDiscoveryCache,
        protocolDiscovery.result,
      );
      recordProtocolRouteOwnership(
        protocolDiscoveryCache,
        protocolDiscovery.projection.ownership,
      );
      const discoveredProtocolPools = [
        ...protocolDiscovery.projection.ownership.admissions.values(),
      ].map((item) => lowerPoolEntry(projectVerifiedProtocolPool(item)));
      if (bootstrapArtifactPath && bootstrapArtifactSha256) {
        assertProtocolCacheNominationBootstrapMatches({
          artifactPath: bootstrapArtifactPath,
          artifactSha256: bootstrapArtifactSha256,
          universePath: cfg.universePath,
          sourceFromBlock: discoveryFromBlock,
          sourceToBlock: cfg.blockNumber,
          discoveredProtocolPools,
        });
      }
      const protocolSourceHeader = await provider.getBlock(cfg.blockNumber);
      if (
        !protocolSourceHeader?.hash ||
        protocolSourceHeader.hash.toLowerCase() !==
          protocolSourceHeaderBefore.hash.toLowerCase()
      ) {
        throw new Error(
          `protocol discovery source ${cfg.blockNumber} changed during the pass`,
        );
      }
      const contiguousAuthority =
        advanceProtocolObservedContiguousAuthority({
          cache: protocolDiscoveryCache,
          families: discoveryFamilySources,
          familySourceCoverage:
            protocolDiscovery.result.familySourceCoverage,
          fromBlock: discoveryFromBlock,
          toBlock: cfg.blockNumber,
          toBlockHash: protocolSourceHeader.hash,
          contiguousSourceIds: new Set(["observed-interaction"]),
        });
      if (cacheOutputPath) {
        saveProtocolDiscoveryEvidenceCache(
          cacheOutputPath,
          protocolDiscoveryCache,
        );
        const outputSha256 = createHash("sha256")
          .update(readFileSync(cacheOutputPath))
          .digest("hex");
        console.log(
          `HUNT_PROTOCOL_DISCOVERY_CACHE_OUTPUT=${JSON.stringify({
            path: cacheOutputPath,
            sha256: outputSha256,
            cursor: cfg.blockNumber,
            cursorHash: protocolSourceHeader.hash.toLowerCase(),
            ownership:
              protocolDiscoveryCache.routeOwnership.admissions.length,
            verifiedCandidates:
              protocolDiscoveryCache.verifiedCandidates.size,
            topologyAuthority:
              contiguousAuthority === null
                ? "positive-only"
                : contiguousAuthority.profile,
          })}`,
        );
      }
      const discoveryArtifactOut =
        process.env.HUNT_DISCOVERY_ARTIFACT_OUT?.trim();
      if (discoveryArtifactOut) {
        const discoveredPoolKeys = discoveredProtocolPools
          .map(poolProjectionRowKey)
          .sort();
        const artifactPools = selectProductionReplayDiscoveredPools(
          protocolDiscovery.projection.strategyViews.blockscan,
          discoveredPoolKeys,
        );
        const artifactSha256 = writeProductionReplayDiscoveryArtifact(
          discoveryArtifactOut,
          {
            schemaVersion: PRODUCTION_REPLAY_ARTIFACT_SCHEMA,
            producer: PRODUCTION_REPLAY_ARTIFACT_PRODUCER,
            sourceFromBlock: discoveryFromBlock,
            sourceToBlock: cfg.blockNumber,
            identityBlock: cfg.blockNumber,
            sourceUniverse: huntUniverseEvidence(
              cfg.universePath,
              cfg.maxPools,
              universePools.length,
            ),
            sourceComplete: true,
            evaluationComplete: true,
            discoveredPoolKeys,
            pools: artifactPools,
          },
        );
        console.log(
          `PRODUCTION_REPLAY_DISCOVERY_ARTIFACT=${JSON.stringify({
            path: discoveryArtifactOut,
            sha256: artifactSha256,
            pools: artifactPools.length,
          })}`,
        );
      }
      protocolPools = mergePoolProjectionRows(
        staticProtocolPools,
        discoveredProtocolPools,
      );
      pools = protocolDiscovery.projection.strategyViews.blockscan;
      rawEdges =
        protocolDiscovery.projection.blockscanGraph ??
        protocolDiscovery.projection.backrunGraph;
      console.log(
        `[blockscan-hunt] protocol discovery candidates=` +
          `${[...protocolDiscovery.scanner.candidatesByAdapter.values()]
            .reduce((sum, items) => sum + items.length, 0)} ` +
          `admitted=${protocolDiscovery.projection.ownership.admissions.size}`,
      );
    } else {
      console.log(
        "[blockscan-hunt] active protocol discovery supplied by verified replay preload",
      );
    }
    const edges = rawEdges.map(lowerEdge);
    const protocolEdges = edges.filter((edge) => edge.slotKind === "protocol");
    console.log(
      `[blockscan-hunt] protocol graph pools=${protocolPools.length} ` +
        `edges=${protocolEdges.length}`,
    );

    await check("graph has swap edges and protocol edges", () =>
      edges.length > 0 && protocolEdges.length > 0,
    );
    let diagnosticExpectedEdges: TokenEdge[] | null = null;
    if (DIAGNOSTIC.enabled) {
      const expectedRouteRaw =
        process.env.AB_EXPECTED_ROUTE_JSON?.trim() ?? "";
      const topologyOnly =
        expectedRouteRaw.length === 0 &&
        DIAGNOSTIC.stopAfter === "graph" &&
        Boolean(process.env.HUNT_PROTOCOL_DISCOVERY_CACHE_OUT?.trim());
      if (expectedRouteRaw.length === 0 && !topologyOnly) {
        throw new Error(
          "diagnostic route is required unless stop-after=graph is building a protocol cache",
        );
      }
      const expectedRoute = topologyOnly
        ? []
        : parseExpectedRoute(expectedRouteRaw);
      const edgeIdentities = edges.map(canonicalEdgeIdentity);
      const routeMatches = expectedRoute.map((expected) => ({
        expected,
        matches: edges.filter((edge) =>
          sameRouteStep(opportunityRoute([edge])[0], expected)
        ),
      }));
      const missingEdges = routeMatches
        .filter(({ matches }) => matches.length === 0)
        .map(({ expected }) => expected);
      const ambiguousEdges = routeMatches
        .filter(({ matches }) => matches.length > 1)
        .map(({ expected, matches }) => ({
          expected,
          matchCount: matches.length,
          matchKeys: matches.map(blockScanEdgeKey),
        }));
      if (missingEdges.length === 0 && ambiguousEdges.length === 0) {
        diagnosticExpectedEdges = routeMatches.map(({ matches }) => matches[0]);
      }
      const poolAdmission = describeExpectedPoolAdmission(
        expectedPoolIds(),
        universePools,
        protocolPools,
        edges,
      );
      emitDiagnostic(
        1,
        "graph",
        missingEdges.length === 0 && ambiguousEdges.length === 0
          ? "pass"
          : "fail",
        {
        mode: topologyOnly ? "protocol_topology_cache" : "route",
        graphEdges: edges.length,
        edgeSetSize: new Set(edgeIdentities).size,
        edgeSetSha256: canonicalSetSha256(edgeIdentities),
        expectedEdges: expectedRoute.length,
        missingEdges,
        ambiguousEdges,
        poolAdmission,
        },
      );
      if (diagnosticStopsAfter("graph")) return;
      if (missingEdges.length > 0 || ambiguousEdges.length > 0) return;
    }

    const [baseBlock, sourceBlock] = await Promise.all([
      provider.getBlock(cfg.blockNumber - 1),
      provider.getBlock(cfg.blockNumber),
    ]);
    if (!baseBlock?.hash) {
      throw new Error(
        `cannot resolve canonical prewarm hash for ${cfg.blockNumber - 1}`,
      );
    }
    if (!sourceBlock?.hash) {
      throw new Error(`cannot resolve canonical source hash for ${cfg.blockNumber}`);
    }
    const stateBackend = new JsonRpcBlockScanStateReadBackend(cfg.rpcUrl, {
      maxBatchSize: envInt(
        "SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_SIZE",
        500,
      ),
      maxConcurrentBatches: envInt(
        "SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_CONCURRENCY",
        4,
      ),
      multicallMode:
        process.env.SEARCHER_BLOCKSCAN_STATE_MULTICALL === "1"
          ? "aggregate3"
          : "rpc-batch",
    });
    const stateCoordinator = new BlockScanStateCoordinator(stateBackend, {
      familyTimeoutMs: envInt("HUNT_STATE_FAMILY_TIMEOUT_MS", 120_000),
    });
    const prewarmBudgetMs = envInt("HUNT_PREWARM_BUDGET_MS", 120_000);
    const prewarmStartedAtMs = Date.now();
    const prewarm = await stateCoordinator.prepare({
      graph: huntGraphView({
        edges,
        generation: 1,
        sourceBlock: cfg.blockNumber - 1,
        sourceBlockHash: baseBlock.hash,
      }),
      families: PRODUCTION_ADAPTER_FAMILIES.blockScanStateFamilies(),
      requiresPricing: (edge) =>
        PRODUCTION_ADAPTER_FAMILIES.isBlockScanPricedEdge(edge),
      deadlineAtMs: prewarmStartedAtMs + prewarmBudgetMs,
    });
    console.log(
      `ADAPTER_FAMILY_PREWARM_TELEMETRY=${JSON.stringify({
        block: cfg.blockNumber - 1,
        generation: prewarm.generation,
        status: prewarm.status,
        wallMs: Date.now() - prewarmStartedAtMs,
        issueCount: prewarm.issues.length,
        families: prewarm.familyTelemetry ?? [],
        lanes: prewarm.laneTelemetry,
      })}`,
    );
    if (prewarm.status === "incomplete") {
      throw new Error(
        `adapter-family N-1 prewarm incomplete: ` +
          `${prewarm.issues[0]?.message ?? "unknown"}`,
      );
    }
    const passDeadlineAtMs = Date.now() + cfg.passBudgetMs;
    console.log(
      `[blockscan-hunt] budgets prewarm=${prewarmBudgetMs}ms ` +
        `scan=${cfg.scanBudgetMs}ms pass=${cfg.passBudgetMs}ms`,
    );
    const graphView = huntGraphView({
      edges,
      generation: 2,
      sourceBlock: cfg.blockNumber,
      sourceBlockHash: sourceBlock.hash,
    });
    const verifiedDiagnosticExpectedEdges = diagnosticExpectedEdges
      ? remapExpectedRouteToVerifiedGraph(
          edges,
          graphView.edges,
          diagnosticExpectedEdges,
        )
      : null;
    if (diagnosticExpectedEdges && !verifiedDiagnosticExpectedEdges) {
      throw new Error(
        "diagnostic expected route could not be remapped to verified graph",
      );
    }
    const stateStartedAtMs = Date.now();
    const preparedState = await stateCoordinator.prepare({
      graph: graphView,
      families: PRODUCTION_ADAPTER_FAMILIES.blockScanStateFamilies(),
      requiresPricing: (edge) =>
        PRODUCTION_ADAPTER_FAMILIES.isBlockScanPricedEdge(edge),
      deadlineAtMs: passDeadlineAtMs,
    });
    const stateWallMs = Date.now() - stateStartedAtMs;
    console.log(
      `ADAPTER_FAMILY_STATE_TELEMETRY=${JSON.stringify({
        block: cfg.blockNumber,
        generation: preparedState.generation,
        status: preparedState.status,
        wallMs: stateWallMs,
        issueCount: preparedState.issues.length,
        families: preparedState.familyTelemetry ?? [],
        lanes: preparedState.laneTelemetry,
      })}`,
    );
    requirePassBudget("adapter_family_state", passDeadlineAtMs);
    if (preparedState.status === "incomplete") {
      throw new Error(
        `adapter-family state incomplete: ` +
          `${preparedState.issues[0]?.message ?? "unknown"}`,
      );
    }
    const pricing = preparedState.snapshot;
    const familyQuoteCoverage = summarizeAdapterFamilyQuotes(pricing);
    const pricedFamilyIds = PRODUCTION_ADAPTER_FAMILIES
      .blockScanStateFamilies()
      .map((family) => family.familyId);
    const familyCoverageAssessment = assessAdapterFamilyQuoteCoverage(
      familyQuoteCoverage,
      pricedFamilyIds,
      retainedProtocolTopologyProof,
    );
    console.log(
      `ADAPTER_FAMILY_QUOTE_COVERAGE=${JSON.stringify({
        registeredFamilies: PRODUCTION_ADAPTER_FAMILIES.list().length,
        pricedFamilies:
          PRODUCTION_ADAPTER_FAMILIES.blockScanStateFamilies().length,
        creditFamilies: PRODUCTION_ADAPTER_FAMILIES.credits().length,
        fundingFamilies:
          PRODUCTION_ADAPTER_FAMILIES.fundingStateFamilies().length,
        status: preparedState.status,
        wallMs: stateWallMs,
        families: familyQuoteCoverage,
        incompleteFamilyIds: pricing.incompleteFamilyIds,
        unresolvedEdgeKeys: pricing.coverage.unresolvedEdgeKeys.length,
        issues: preparedState.issues.slice(0, 64).map((issue) => ({
          kind: issue.kind,
          lane: issue.lane,
          familyId: issue.familyId,
          sourceId: issue.sourceId,
          stateKey: issue.stateKey,
          edgeKey: issue.edgeKey,
          message: issue.message,
        })),
        issueCount: preparedState.issues.length,
        laneTelemetry: preparedState.laneTelemetry,
        familyTelemetry: preparedState.familyTelemetry ?? [],
        assessment: familyCoverageAssessment,
        retainedTopologyProof:
          retainedProtocolTopologyProof === null
            ? null
            : {
                cursor: retainedProtocolTopologyProof.cursor,
                cursorHash: retainedProtocolTopologyProof.cursorHash,
                contentSha256:
                  retainedProtocolTopologyProof.contentSha256,
              },
      })}`,
    );
    await check(
      "adapter-family coverage telemetry is registry-complete and well formed",
      () => familyCoverageAssessment.structurallyValid,
    );
    const resolvedEdgeKeys = new Set(pricing.coverage.resolvedEdgeKeys);
    const scanEdges = graphView.edges.filter((edge) =>
      !PRODUCTION_ADAPTER_FAMILIES.isBlockScanPricedEdge(edge) ||
      resolvedEdgeKeys.has(blockScanEdgeKey(edge))
    );

    // Production treats code-owned protocol edges as admission guarantees outside
    // the scored DEX-edge budget. Older scanner versions ignore this forward-
    // compatible field; challengers that implement it must replay the same view.
    const pricedTokenLimits = pricedTokens();
    const scanCfg = {
      maxHops: cfg.maxHops,
      minSpreadBps: cfg.minSpreadBps,
      maxCandidates: cfg.maxCandidates,
      budgetMs: cfg.scanBudgetMs,
      pricedTokens: pricedTokenLimits,
      pinnedOutsideBudget: true,
    };
    const coarseMaxCandidates = Math.max(
      cfg.maxCandidates,
      envInt("HUNT_REFINE_CANDIDATES", 512),
    );
    const expectedRouteDiagnosis =
      DIAGNOSTIC.enabled && verifiedDiagnosticExpectedEdges
        ? diagnoseExpectedRouteEnumeration({
            edges: scanEdges,
            route: verifiedDiagnosticExpectedEdges,
            maxHops: scanCfg.maxHops,
            minSpreadBps: scanCfg.minSpreadBps,
            pinnedOutsideBudget: scanCfg.pinnedOutsideBudget === true,
            pricedTokenLimits,
            mids: pricing.mids,
          })
        : null;
    const coarseScan = scanBlockStateFromResolvedMids({
      edges: [...scanEdges],
      sourceBlock: cfg.blockNumber,
      swapTouched: null,
      cfg: { ...scanCfg, maxCandidates: coarseMaxCandidates },
      mids: pricing.mids,
    });
    let diagnosticCoarseTarget: ExpectedReplayTarget | null = null;
    if (DIAGNOSTIC.enabled) {
      const coarseReports = coarseScan.opportunities.map((opp, index) =>
        describeOpportunity(index + 1, opp, pricing.mids),
      );
      const ringIdentities = coarseScan.opportunities.map((opp) =>
        canonicalRingIdentity(opp.seedEdges),
      );
      diagnosticCoarseTarget = readExpectedReplayTarget(coarseReports);
      const found = (diagnosticCoarseTarget?.opportunityIndex ?? -1) >= 0;
      const rankComplete = coarseScan.outcome === "ran";
      const passBudgetExceeded = blockScanPassBudgetExceeded(passDeadlineAtMs, false);
      emitDiagnostic(
        2,
        "enumeration",
        passBudgetExceeded
          ? "not_reached"
          : found
            ? "pass"
            : rankComplete
              ? "fail"
              : "not_reached",
        {
          observedRank: found
            ? diagnosticCoarseTarget!.opportunityIndex + 1
            : null,
          rankComplete,
          candidatesSearched: coarseReports.length,
          ringSetSize: new Set(ringIdentities).size,
          ringSetSha256: canonicalSetSha256(ringIdentities),
          candidateCap: coarseMaxCandidates,
          scannerOutcome: coarseScan.outcome,
          scannedPairs: coarseScan.scannedPairs,
          passBudgetExceeded,
          expectedRouteDiagnosis,
          reason: passBudgetExceeded
            ? "pass_budget_exceeded"
            : !found && !rankComplete
              ? "scan_budget_exceeded_before_target"
              : !found
                ? expectedRouteDiagnosis?.status === "rejected"
                  ? expectedRouteDiagnosis.reason
                  : coarseScan.selection.enumeratedCount >
                      coarseScan.selection.selectedCount
                    ? "rank_or_family_cap"
                    : "absent_after_post_score_checks"
                : null,
        },
      );
      if (diagnosticStopsAfter("enumeration")) return;
      if (passBudgetExceeded || !found) return;
    }
    requirePassBudget("scan", passDeadlineAtMs);
    const probeDiagnostics = new Map<number, BlockScanProbeDiagnostic>();
    const probeFailureCounts = new Map<string, {
      reason: NonNullable<BlockScanProbeDiagnostic["failure"]>["reason"];
      familyIds: readonly string[];
      attributedFamilyId: string | null;
      attributedInstanceCircuitKey: string | null;
      blockingCircuitScope: "family" | "instance" | "composite" | null;
      stage: string | null;
      causeName: string | null;
      causeCode: string | null;
      causeKind: string | null;
      count: number;
    }>();
    const diagnosticTargetIndex = diagnosticCoarseTarget?.opportunityIndex ?? -1;
    const refineConcurrency = envInt("HUNT_REFINE_CONCURRENCY", 24);
    const refineFamilyTimeoutMs = envInt(
      "HUNT_REFINE_FAMILY_TIMEOUT_MS",
      1_000,
    );
    const refineMaxConcurrentPerFamily = envInt(
      "HUNT_REFINE_MAX_CONCURRENT_PER_FAMILY",
      3,
    );
    const refinement = await refineBlockScanCandidates(
      callBackend,
      coarseScan.opportunities,
      cfg.maxCandidates,
      passDeadlineAtMs,
      pricedTokenLimits,
      DIAGNOSTIC.enabled && diagnosticTargetIndex >= 0
        ? (probe) => {
            if (probe.failure) {
              const failureKey = JSON.stringify([
                probe.failure.reason,
                probe.failure.familyIds,
                probe.failure.attributedFamilyId,
                probe.failure.attributedInstanceCircuitKey,
                probe.failure.blockingCircuitScope,
                probe.failure.stage,
                probe.failure.causeName,
                probe.failure.causeCode,
                probe.failure.causeKind,
              ]);
              const previous = probeFailureCounts.get(failureKey);
              probeFailureCounts.set(failureKey, previous
                ? { ...previous, count: previous.count + 1 }
                : { ...probe.failure, count: 1 });
            }
            if (probe.index === diagnosticTargetIndex) probeDiagnostics.set(probe.index, probe);
          }
        : undefined,
      refineConcurrency,
      {
        familyTimeoutMs: refineFamilyTimeoutMs,
        maxConcurrentPerFamily: refineMaxConcurrentPerFamily,
      },
    );
    const scan = { ...coarseScan, opportunities: refinement.opportunities };
    if (DIAGNOSTIC.enabled) {
      const refinedReports = scan.opportunities.map((opp, index) =>
        describeOpportunity(index + 1, opp, pricing.mids),
      );
      const refinedTarget = readExpectedReplayTarget(refinedReports);
      const refinedRank = (refinedTarget?.opportunityIndex ?? -1) >= 0
        ? refinedTarget!.opportunityIndex + 1
        : null;
      const targetProbe = probeDiagnostics.get(diagnosticTargetIndex);
      const probeStatus = targetProbe?.status
        ?? (diagnosticTargetIndex < 0 ? "not_enumerated" : "unprobed");
      const passBudgetExceeded = blockScanPassBudgetExceeded(
        passDeadlineAtMs,
        refinement.deadlineHit,
      );
      emitDiagnostic(
        3,
        "exact_quote_refine",
        passBudgetExceeded || probeStatus === "unprobed"
          ? "not_reached"
          : probeStatus === "positive" && refinedRank !== null
            ? "pass"
            : "fail",
        {
          refinedRank,
          probeStatus,
          probeMarginBps: targetProbe?.marginBps ?? null,
          probeAttempted: targetProbe?.attempted ?? false,
          probeFailure: targetProbe?.failure ?? null,
          probeFailureSummary: [...probeFailureCounts.values()].sort(
            (left, right) =>
              right.count - left.count ||
              JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
          refinementConfig: {
            concurrency: refineConcurrency,
            familyTimeoutMs: refineFamilyTimeoutMs,
            maxConcurrentPerFamily: refineMaxConcurrentPerFamily,
          },
          retainedAsFallback: refinedRank !== null && probeStatus === "failed",
          reason: probeStatus === "positive" && refinedRank === null
            ? "positive_but_below_candidate_cap"
            : probeStatus === "failed"
              ? targetProbe?.failure?.reason ?? "exact_quote_failed"
              : probeStatus === "negative"
                ? "exact_quote_non_positive"
                : probeStatus === "not_enumerated"
                  ? "target_not_enumerated"
                  : null,
          selectedCandidates: refinedReports.length,
          attempted: refinement.attempted,
          positive: refinement.positive,
          negative: refinement.negative,
          failed: refinement.failed,
          deadlineHit: refinement.deadlineHit,
          openFamilyIds: refinement.openFamilyIds,
          openInstanceCircuitKeys: refinement.openInstanceCircuitKeys,
          openCompositeKeys: refinement.openCompositeKeys,
          passBudgetExceeded,
        },
      );
      if (diagnosticStopsAfter("refine")) return;
      if (passBudgetExceeded || probeStatus !== "positive" || refinedRank === null) return;
    }
    requirePassBudget("refine", passDeadlineAtMs, refinement.deadlineHit);
    console.log(
      `[blockscan-hunt] exact route probes attempted=${refinement.attempted} ` +
        `positive=${refinement.positive} negative=${refinement.negative} ` +
        `failed=${refinement.failed} deadline=${refinement.deadlineHit ? 1 : 0}`,
    );
    await check("block scan executed", () =>
      scan.stateBlock === cfg.blockNumber && scan.scannedPairs >= 0,
    );

    const opportunityReports = scan.opportunities.map((opp, i) =>
      describeOpportunity(i + 1, opp, pricing.mids),
    );
    for (const opp of opportunityReports) {
      console.log(
        `[blockscan-hunt] opp rank=${opp.rank} spreadBps=${formatSpread(opp.spreadBps)} ` +
          `center=${opp.searchCenter} protocol=${opp.hasProtocolEdge} ` +
          `ring=${opp.ring.join("->")} pools=${opp.pools.join(",")} ` +
          `adapters=${opp.adapterIds.join(",")}`,
      );
    }

    const expectedTarget = readExpectedReplayTarget(opportunityReports);
    const expectedOpportunityIndex = expectedTarget?.opportunityIndex ?? -1;
    const selectedByTopK = expectedOpportunityIndex >= 0
      && expectedOpportunityIndex < Math.min(cfg.topK, scan.opportunities.length);
    const forcedProbe = expectedOpportunityIndex >= 0 && !selectedByTopK;
    const solveIndexes = selectedReplayOpportunityIndexes(
      scan.opportunities.length,
      cfg.topK,
      expectedTarget?.opportunityIndex ?? null,
    );
    const solvedReports = await solveSelected(
      state,
      provider,
      cfg,
      scan.opportunities,
      pricing.mids,
      solveIndexes,
    );
    await check("fork-solve top candidates recorded", () =>
      solvedReports.length === solveIndexes.length,
    );

    if (DIAGNOSTIC.enabled) {
      const expectedSolve = expectedTarget && expectedTarget.opportunityIndex >= 0
        ? solveForOpportunityIndex(solvedReports, expectedTarget.opportunityIndex)
        : null;
      const solveSucceeded = expectedSolve?.solved !== null
        && expectedSolve?.solved !== undefined
        && expectedSolve.solveError === null
        && expectedSolve.diagnosticAmountError === undefined
        && expectedSolve.diagnosticHopAmounts?.length === expectedTarget?.expectedRoute.length;
      emitDiagnostic(
        4,
        "planner_and_solver",
        solveSucceeded ? "pass" : "fail",
        {
          opportunityRank: expectedTarget && expectedTarget.opportunityIndex >= 0
            ? expectedTarget.opportunityIndex + 1
            : null,
          selectedByTopK,
          forcedProbe,
          selectionMode: selectedByTopK ? "top_k" : forcedProbe ? "forced_probe" : "not_found",
          planCount: expectedSolve?.planCount ?? 0,
          solveSucceeded,
          includesInternalFinalSim: true,
          searchCenter: expectedSolve?.searchCenter ?? null,
          hopAmounts: expectedSolve?.diagnosticHopAmounts ?? [],
          error: expectedSolve?.solveError
            ?? expectedSolve?.diagnosticAmountError
            ?? (expectedTarget?.opportunityIndex === -1 ? "route_not_enumerated" : null),
        },
      );
      if (diagnosticStopsAfter("solve")) return;
      const simulation = expectedSolve?.diagnosticSimulation;
      emitDiagnostic(5, "resolved_plan_resim", simulation?.success ? "pass" : "fail", {
        ...(simulation ?? {
          success: false,
          netProfit: expectedSolve?.solved ?? null,
          error: expectedSolve?.solveError ?? "simulation_not_reached",
        }),
      });
      if (diagnosticStopsAfter("sim")) return;
      const ev = expectedSolve?.diagnosticEv;
      emitDiagnostic(6, "ev", ev?.decision === "allow"
        ? "pass"
        : ev?.decision === "disabled" || !ev
          ? "not_reached"
          : "reject", {
        ...(ev ?? { decision: null, error: "simulation_not_reached" }),
      });
      if (diagnosticStopsAfter("ev")) return;
    }

    const bestNet = bestSolvedNet(solvedReports);
    const verdict = resolveBlockScanHuntVerdict(
      scan.opportunities.length,
      bestNet,
      familyCoverageAssessment.globallyComplete,
    );
    const report = {
      stateBlock: cfg.blockNumber,
      universePools: universePools.length,
      graphPools: pools.length,
      edges: edges.length,
      maxHops: cfg.maxHops,
      protocolEdges: protocolEdges.length,
      protocolMids: pricing.mids.size,
      adapterFamilyQuoteCoverage: familyQuoteCoverage,
      adapterFamilyCoverageAssessment: familyCoverageAssessment,
      verdictScope:
        familyCoverageAssessment.globallyComplete ? "global" : "targeted",
      verdictCompleteness:
        familyCoverageAssessment.globallyComplete ? "complete" : "indeterminate",
      adapterFamilyState: {
        status: preparedState.status,
        wallMs: stateWallMs,
        resolvedEdges: pricing.coverage.resolvedEdgeKeys.length,
        unavailableEdges: pricing.coverage.unavailableEdgeKeys.length,
        unresolvedEdges: pricing.coverage.unresolvedEdgeKeys.length,
        laneTelemetry: pricing.laneTelemetry,
        familyTelemetry: pricing.familyTelemetry ?? [],
      },
      scannedPairs: scan.scannedPairs,
      swapVenuesSkipped: scan.debug?.skippedVenues ?? 0,
      opportunities: opportunityReports,
      solved: solvedReports,
      verdict,
    };
    mkdirSync(dirname(cfg.outPath), { recursive: true });
    writeFileSync(cfg.outPath, `${JSON.stringify(report, jsonReplacer, 2)}\n`);
    await check("report written", () => readFileSync(cfg.outPath, "utf8").length > 0);
    emitProductionReplayResult(cfg, opportunityReports, solvedReports, expectedTarget);

    console.log(
      `blockscan-hunt verdict=${verdict} block=${cfg.blockNumber} ` +
        `scope=${familyCoverageAssessment.globallyComplete ? "global" : "targeted"} ` +
        `completeness=${familyCoverageAssessment.globallyComplete ? "complete" : "indeterminate"} ` +
        `opps=${scan.opportunities.length} bestNet=${bestNet === null ? "null" : bestNet.toString()}`,
    );
  } finally {
    state.stop();
    observedHistoryProvider?.destroy();
    provider.destroy();
  }
}

function emitProductionReplayResult(
  cfg: HuntConfig,
  opportunities: OpportunityReport[],
  solved: SolveReport[],
  expectedTarget: ExpectedReplayTarget | null,
): void {
  if (!expectedTarget) return;
  const { expectedPools, expectedSwapPath, expectedRoute, opportunityIndex } = expectedTarget;
  const opportunity = opportunityIndex >= 0 ? opportunities[opportunityIndex] : null;
  const solve = opportunityIndex >= 0
    ? solveForOpportunityIndex(solved, opportunityIndex)
    : null;
  let stage = "not_admitted";
  if (opportunity) stage = "path_found";
  if (solve?.solved !== null && solve?.solved !== undefined) {
    stage = BigInt(solve.solved) > 0n ? "final_sim_success" : "path_found";
  }
  const closedRoute = Boolean(opportunity
    && opportunity.ring.length >= 2
    && opportunity.ring[0].toLowerCase() === opportunity.ring.at(-1)?.toLowerCase());
  console.log(`BLOCKSCAN_HUNT_RESULT=${JSON.stringify({
    schema_version: 1,
    fork_block: cfg.blockNumber,
    stage,
    expected_pool_ids: expectedPools,
    matched_pool_ids: opportunity?.pools.map((pool) => pool.toLowerCase()) ?? [],
    expected_swap_path: expectedSwapPath,
    matched_swap_path: opportunity?.swapPath ?? [],
    expected_route: expectedRoute,
    matched_route: opportunity?.route ?? [],
    has_protocol_edge: opportunity?.hasProtocolEdge ?? false,
    closed_route: closedRoute,
    final_sim_success: stage === "final_sim_success",
    net_profit_raw: solve?.solved ?? null,
  })}`);
}

interface ExpectedReplayTarget {
  expectedPools: string[];
  expectedSwapPath: OpportunityReport["swapPath"];
  expectedRoute: OpportunityReport["route"];
  opportunityIndex: number;
}

function expectedPoolIds(): string[] {
  return (process.env.AB_EXPECTED_POOL_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function describeExpectedPoolAdmission(
  expectedPools: readonly string[],
  universePools: readonly PoolEntry[],
  protocolPools: readonly PoolEntry[],
  edges: readonly TokenEdge[],
): Array<Record<string, unknown>> {
  return expectedPools.map((expectedPool) => {
    const protocolPool = protocolPools.find((pool) => poolEntryMatches(pool, expectedPool));
    const universePool = universePools.find((pool) => poolEntryMatches(pool, expectedPool));
    const sourcePool = protocolPool ?? universePool;
    const activity = sourcePool as (PoolEntry & { swapCount30d?: number }) | undefined;
    const graphEdgeCount = edges.filter((edge) => edgePoolIdentity(edge) === expectedPool).length;
    return {
      pool: expectedPool,
      source: protocolPool ? "protocol_registry" : universePool ? "generated_universe" : "missing",
      adapter: sourcePool?.adapter ?? null,
      score: sourcePool?.score ?? null,
      swapCount30d: activity?.swapCount30d ?? null,
      graphEdgeCount,
      admittedToGraph: graphEdgeCount > 0,
    };
  });
}

function poolEntryMatches(pool: PoolEntry, expectedPool: string): boolean {
  return pool.address.toLowerCase() === expectedPool
    || pool.poolId?.toLowerCase() === expectedPool;
}

function readExpectedReplayTarget(
  opportunities: OpportunityReport[],
): ExpectedReplayTarget | null {
  const expectedPools = expectedPoolIds();
  if (expectedPools.length === 0) return null;
  const expectedSwapPath = parseExpectedSwapPath(process.env.AB_EXPECTED_SWAP_PATH_JSON ?? "");
  const expectedRoute = parseExpectedRoute(process.env.AB_EXPECTED_ROUTE_JSON ?? "");
  const expectedProtocol = process.env.AB_EXPECTED_ROUTE_SCOPE === "dex-permissionless-protocol";
  const opportunityIndex = opportunities.findIndex((entry) =>
    entry.swapPath !== null
    && JSON.stringify(entry.swapPath) === JSON.stringify(expectedSwapPath)
    && routeMatchesExpected(entry.route, expectedRoute)
    && entry.hasProtocolEdge === expectedProtocol);
  return { expectedPools, expectedSwapPath, expectedRoute, opportunityIndex };
}

function readConfig(rpcUrl: string, blockNumber: number): HuntConfig {
  void rpcUrl;
  const anvilPort = envInt("SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT", 8566);
  const budgets = resolveBlockScanHuntBudgets(process.env);
  return {
    rpcUrl,
    blockNumber,
    universePath: process.env.HUNT_UNIVERSE_PATH ?? DEFAULT_POOL_UNIVERSE_PATH,
    maxPools: envInt("HUNT_MAX_POOLS", 1500),
    maxHops: envInt("HUNT_MAX_HOPS", 4),
    minSpreadBps: envInt("HUNT_MIN_SPREAD_BPS", 10),
    scanBudgetMs: DIAGNOSTIC.scanBudgetMs ?? budgets.scanBudgetMs,
    passBudgetMs: DIAGNOSTIC.passBudgetMs ?? budgets.passBudgetMs,
    maxCandidates: DIAGNOSTIC.maxCandidates ?? envInt("HUNT_MAX_CANDIDATES", 16),
    topK: DIAGNOSTIC.topK ?? envInt("HUNT_TOP_K", 3),
    outPath: process.env.HUNT_OUT ?? `/tmp/blockscan-hunt-${blockNumber}.json`,
    anvilPort,
  };
}

function resolveBlockNumber(latest: number): number {
  const raw = process.env.HUNT_BLOCK?.trim();
  if (!raw) return latest - 1;
  if (raw === "latest") return latest;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`HUNT_BLOCK must be a positive integer or latest, got ${raw}`);
  }
  return parsed;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

function requirePassBudget(stage: string, deadlineAtMs: number, deadlineHit = false): void {
  if (!blockScanPassBudgetExceeded(deadlineAtMs, deadlineHit)) return;
  throw new Error(`blockscan pass budget exceeded at ${stage}`);
}

function tokenBackend(provider: ethers.JsonRpcProvider, blockNumber: number): TokenQueryBackend {
  return {
    call: (req) => provider.call({ to: req.to, data: req.data, blockTag: blockNumber }),
    getLogs: async (req) => provider.send("eth_getLogs", [req]) as Promise<Array<{ data: string; topics: string[] }>>,
  };
}

function pricedTokens(): Map<string, { maxBorrow: bigint }> {
  return new Map([
    [ADDR.WETH.toLowerCase(), { maxBorrow: 2_000n * 10n ** 18n }],
    [ADDR.USDC.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
    [ADDR.USDT.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
    [ADDR.DAI.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 18n }],
  ]);
}

function summarizeAdapterFamilyQuotes(
  snapshot: BlockScanStateSnapshot,
): AdapterFamilyQuoteCoverageSummary[] {
  return PRODUCTION_ADAPTER_FAMILIES.blockScanStateFamilies().map((family) => {
    const ownedEdges = snapshot.graph.edges.filter((edge) =>
      PRODUCTION_ADAPTER_FAMILIES.isBlockScanPricedEdge(edge) &&
      family.ownsEdge(edge)
    );
    let positiveQuotes = 0;
    let unavailableEdges = 0;
    let unresolvedEdges = 0;
    for (const edge of ownedEdges) {
      const edgeKey = blockScanEdgeKey(edge);
      const coverage = snapshot.coverageByEdgeKey.get(edgeKey);
      if (coverage?.status === "resolved") {
        const mid = snapshot.mids.get(edgeKey);
        if (
          mid &&
          Number.isFinite(mid.mid) &&
          mid.mid > 0 &&
          Number.isFinite(mid.depthProxy) &&
          mid.depthProxy > 0
        ) {
          positiveQuotes++;
        } else {
          unresolvedEdges++;
        }
      } else if (coverage?.status === "rejected") {
        unavailableEdges++;
      } else {
        unresolvedEdges++;
      }
    }
    return {
      familyId: family.familyId,
      graphEdges: ownedEdges.length,
      positiveQuotes,
      unavailableEdges,
      unresolvedEdges,
    };
  });
}

async function solveSelected(
  state: AnvilStateBackend,
  canonicalProvider: ethers.JsonRpcProvider,
  cfg: HuntConfig,
  opportunities: BlockScanOpportunity[],
  mids: ReadonlyMap<string, ResolvedBlockScanMid>,
  opportunityIndexes: readonly number[],
): Promise<SolveReport[]> {
  if (opportunityIndexes.length === 0) return [];

  console.log(
    `[blockscan-hunt] fork upstream=${redactRpcUrl(cfg.rpcUrl)} ` +
      `block=${cfg.blockNumber} anvil=http://127.0.0.1:${cfg.anvilPort}`,
  );
  await state.forkAt(cfg.blockNumber);
  await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);

  const planner = new TemplatePlanner();
  const solver = new AnvilSolver();
  const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
  const reports: SolveReport[] = [];

  for (const opportunityIndex of opportunityIndexes) {
    const opp = opportunities[opportunityIndex];
    const spreadBps = estimateResolvedRingSpreadBps(opp.seedEdges, mids);
    let planCount = 0;
    let solved: ResolvedPlan | null = null;
    let solvedTokenPath: TokenPath | null = null;
    let solveError: string | null = null;
    let searchCenter: string | null = null;
    let diagnosticHopAmounts: SolveReport["diagnosticHopAmounts"];
    let diagnosticAmountError: string | undefined;
    let diagnosticSimulation: SolveReport["diagnosticSimulation"];
    let diagnosticEv: SolveReport["diagnosticEv"];
    try {
      planner.setGraph(opp.seedEdges);
      const plans = await planner.planBlockScanFromSeedEdges(opp, [FLASH_SWAP_REPAY]);
      planCount = plans.length;
      if (plans.length === 0) {
        throw new Error("no candidate plans");
      }
      solvedTokenPath = plans[0].tokenPath;
      // Exact solve reads the FORK directly (matches searcher:blockscan-fork-solve); do NOT pass
      // the detection cache — it holds metadata-only v3 ticks for cheap mids, which would corrupt
      // a cache-local exact quote. The fork + eth_call quoter is the source of truth for EV.
      const center = await resolveSearchCenter(plans[0], opp.flashToken, state, {});
      searchCenter = center.toString();
      solved = await solver.solve(plans[0], state, simulator, {
        finalSimTopN: 3,
        gssMaxTries: 8,
        quoteProfitFloorBps: 0n,
        quoteSafetyBps: 10000n,
      });
    } catch (err) {
      solveError = err instanceof Error ? err.message : String(err);
    }
    if (DIAGNOSTIC.enabled && solved && solvedTokenPath) {
      try {
        const propagated = await propagateAmountsWithRawOutputs(
          solvedTokenPath,
          solved.flashAmount,
          state,
          { safetyBps: 10000n },
        );
        diagnosticHopAmounts = opp.seedEdges.map((edge, index) => ({
          adapterId: edge.adapterId,
          target: edge.target.toLowerCase(),
          tokenIn: edge.tokenIn.toLowerCase(),
          tokenOut: edge.tokenOut.toLowerCase(),
          amountIn: propagated.amounts[index].toString(),
          amountOut: propagated.amounts[index + 1].toString(),
          rawAmountOut: propagated.rawOutputs[index].toString(),
        }));
      } catch (error) {
        diagnosticAmountError = error instanceof Error ? error.message : String(error);
      }
      const simulation = await simulator.simulate(solved);
      diagnosticSimulation = {
        success: simulation.success,
        profitToken: simulation.profitToken.toLowerCase(),
        grossProfit: simulation.grossProfit.toString(),
        gasUsed: simulation.gasUsed.toString(),
        netProfit: simulation.netProfit.toString(),
        calldataHash: createHash("sha256").update(simulation.calldata).digest("hex"),
        revertReason: simulation.revertReason ?? null,
      };
      if (simulation.success) {
        const minNetEth = BigInt(process.env.SEARCHER_MIN_NET_ETH ?? "0");
        const evGate = process.env.SEARCHER_EV_GATE === "1";
        const evaluation = await evaluateEv(
          canonicalProvider,
          simulation.profitToken,
          simulation.netProfit,
          simulation.gasUsed,
          {
            profitHaircutBps: Number(process.env.SEARCHER_PROFIT_HAIRCUT_BPS ?? "2000"),
            evGate,
            bribeAllAboveGas: process.env.SEARCHER_BRIBE_ALL_ABOVE_GAS === "1",
            bribeBps: Number(process.env.SEARCHER_BRIBE_BPS ?? DEFAULT_BRIBE_BPS.toString()),
          },
          undefined,
          cfg.blockNumber,
        );
        const targetBlock = cfg.blockNumber + 1;
        const targetHeader = await canonicalProvider.getBlock(targetBlock);
        if (
          evaluation.feeStateAvailable &&
          targetHeader?.baseFeePerGas !== evaluation.maxBaseFeePerGas
        ) {
          throw new Error(
            `EV fee anchor mismatch parent=${cfg.blockNumber} target=${targetBlock} ` +
            `predicted=${evaluation.maxBaseFeePerGas} actual=${targetHeader?.baseFeePerGas ?? "missing"}`,
          );
        }
        diagnosticEv = {
          decision: !evGate
            ? "disabled"
            : !evaluation.valuationAvailable
              ? "unpriceable_profit_token"
              : !evaluation.gasMeasurementAvailable
                ? "missing_gas_estimate"
                : !evaluation.feeStateAvailable
                  ? "missing_fee_state"
                  : evaluation.netEvWei <= minNetEth
                    ? "below_ev_gate"
                    : "allow",
          evGate,
          netEvWei: evaluation.netEvWei.toString(),
          expectedProfitEth: evaluation.expectedProfitEth.toString(),
          gasCostEth: evaluation.gasCostEth.toString(),
          bidEth: evaluation.bidEth.toString(),
          minNetEth: minNetEth.toString(),
          decisionParentBlock: cfg.blockNumber,
          targetBlock,
          decisionParentHash: evaluation.sourceBlockHash,
          ethUsd: evaluation.ethUsd,
          ethUsdRoundId: evaluation.ethUsdRoundId?.toString() ?? null,
          ethUsdUpdatedAt: evaluation.ethUsdUpdatedAt?.toString() ?? null,
          maxBaseFeePerGas: evaluation.maxBaseFeePerGas.toString(),
        };
      }
    }
    const report = {
      opportunityIndex,
      ring: ringTokens(opp.seedEdges),
      pools: uniqueStrings(opp.seedEdges.map(edgePoolIdentity)),
      spreadBps,
      planCount,
      solved: solved ? solved.netProfit.toString() : null,
      solveError,
      searchCenter,
      ...(diagnosticHopAmounts ? { diagnosticHopAmounts } : {}),
      ...(diagnosticAmountError ? { diagnosticAmountError } : {}),
      ...(diagnosticSimulation ? { diagnosticSimulation } : {}),
      ...(diagnosticEv ? { diagnosticEv } : {}),
    };
    reports.push(report);
    console.log(
      `[blockscan-hunt] solve rank=${opportunityIndex + 1} planCount=${planCount} ` +
        `net=${report.solved ?? "null"} error=${solveError ? solveError.slice(0, 160) : "none"}`,
    );
  }
  return reports;
}

function describeOpportunity(
  rank: number,
  opp: BlockScanOpportunity,
  mids: ReadonlyMap<string, ResolvedBlockScanMid>,
): OpportunityReport {
  return {
    rank,
    ring: ringTokens(opp.seedEdges),
    pools: uniqueStrings(opp.seedEdges.map(edgePoolIdentity)),
    poolIds: uniqueStrings(opp.seedEdges.map((edge) => edge.poolId?.toLowerCase()).filter(isString)),
    adapterIds: opp.seedEdges.map((edge) => edge.adapterId),
    spreadBps: estimateResolvedRingSpreadBps(opp.seedEdges, mids),
    searchCenter: opp.searchSeed.searchCenter.toString(),
    maxInput: opp.searchSeed.maxInput.toString(),
    hasProtocolEdge: opp.seedEdges.some((edge) => edge.slotKind === "protocol"),
    seedEdges: opp.seedEdges.map((edge) => ({
      adapterId: edge.adapterId,
      target: edge.target.toLowerCase(),
      tokenIn: edge.tokenIn.toLowerCase(),
      tokenOut: edge.tokenOut.toLowerCase(),
      slotKind: edge.slotKind,
      edgeKind: edge.edgeKind,
      leavesStandingPosition: edge.leavesStandingPosition,
      ...(edge.poolId ? { poolId: edge.poolId.toLowerCase() } : {}),
    })),
    swapPath: opportunitySwapPath(opp.seedEdges),
    route: opportunityRoute(opp.seedEdges),
  };
}

function parseExpectedRoute(value: string): OpportunityReport["route"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("AB_EXPECTED_ROUTE_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 8 || parsed.some((step) => {
    const edge = step as Record<string, unknown>;
    return typeof edge.adapterId !== "string"
      || (edge.slotKind !== "swap" && edge.slotKind !== "protocol")
      || typeof edge.target !== "string"
      || typeof edge.tokenIn !== "string"
      || typeof edge.tokenOut !== "string"
      || (edge.edgeKind !== undefined && typeof edge.edgeKind !== "string")
      || (edge.leavesStandingPosition !== undefined
        && typeof edge.leavesStandingPosition !== "boolean")
      || (edge.poolId !== undefined && typeof edge.poolId !== "string");
  })) {
    throw new Error("AB_EXPECTED_ROUTE_JSON must contain 2..8 complete ordered route edges");
  }
  return parsed.map((step) => {
    const edge = step as OpportunityReport["route"][number];
    return {
      adapterId: edge.adapterId,
      slotKind: edge.slotKind,
      target: edge.target.toLowerCase(),
      tokenIn: edge.tokenIn.toLowerCase(),
      tokenOut: edge.tokenOut.toLowerCase(),
      ...(edge.edgeKind !== undefined ? { edgeKind: edge.edgeKind } : {}),
      ...(edge.leavesStandingPosition !== undefined
        ? { leavesStandingPosition: edge.leavesStandingPosition }
        : {}),
      ...(edge.poolId ? { poolId: edge.poolId.toLowerCase() } : {}),
    };
  });
}

function opportunityRoute(edges: TokenEdge[]): OpportunityReport["route"] {
  return edges.map((edge) => ({
    adapterId: edge.adapterId,
    slotKind: edge.slotKind === "protocol" ? "protocol" : "swap",
    target: edge.target.toLowerCase(),
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
    edgeKind: edge.edgeKind,
    leavesStandingPosition: edge.leavesStandingPosition,
    ...(edge.poolId ? { poolId: edge.poolId.toLowerCase() } : {}),
  }));
}

function canonicalEdgeIdentity(edge: TokenEdge): string {
  return JSON.stringify([
    edge.adapterId,
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
    edge.edgeKind,
    edge.leavesStandingPosition,
    edge.poolId?.toLowerCase() ?? null,
  ]);
}

function canonicalRingIdentity(edges: TokenEdge[]): string {
  return JSON.stringify(edges.map(canonicalEdgeIdentity));
}

interface ExpectedEnumerationAttempt {
  protocolEdgeIndex: number | null;
  missingExpansionEdgeKeys: string[];
  enumeratedPathCount: number;
  pathCapReached: boolean;
  targetPathIndex: number | null;
  routeOrderScore: ReturnType<typeof diagnoseResolvedRingScore>;
  fundedOrderScore: ReturnType<typeof diagnoseResolvedRingScore> | null;
  flashToken: string | null;
  reason: string;
}

function diagnoseExpectedRouteEnumeration(input: {
  edges: readonly TokenEdge[];
  route: readonly TokenEdge[];
  maxHops: number;
  minSpreadBps: number;
  pinnedOutsideBudget: boolean;
  pricedTokenLimits: ReadonlyMap<string, { maxBorrow: bigint }>;
  mids: ReadonlyMap<string, ResolvedBlockScanMid>;
}): {
  status: "rejected" | "post_score";
  reason: string;
  mode: "protocol-first" | "general";
  attempts: ExpectedEnumerationAttempt[];
} {
  const route = [...input.route];
  const protocolIndexes = route.flatMap((edge, index) =>
    edge.slotKind === "protocol" ? [index] : []
  );
  const attempts = (protocolIndexes.length > 0 ? protocolIndexes : [null])
    .map((protocolEdgeIndex): ExpectedEnumerationAttempt => {
      const routeOrder = protocolEdgeIndex === null
        ? route
        : [
            ...route.slice(protocolEdgeIndex),
            ...route.slice(0, protocolEdgeIndex),
          ];
      const protocolEdge = protocolEdgeIndex === null
        ? null
        : routeOrder[0];
      const expectedPath = protocolEdge ? routeOrder.slice(1) : routeOrder;
      const paths = buildTokenPaths(
        [...input.edges],
        protocolEdge?.tokenOut ?? routeOrder[0]?.tokenIn ?? "",
        protocolEdge?.tokenIn ?? routeOrder[0]?.tokenIn ?? "",
        {
          maxHops: protocolEdge
            ? Math.max(0, input.maxHops - 1)
            : input.maxHops,
          maxPoolsPerToken: 20,
          pinnedOutsideBudget: input.pinnedOutsideBudget,
          preferDirectClosure: protocolEdge !== null,
          maxPaths: 2000,
        },
      );
      const retainedEdgeKeys = new Set(
        paths.flatMap((path) => path.edges.map(blockScanEdgeKey)),
      );
      const missingExpansionEdgeKeys = expectedPath
        .map(blockScanEdgeKey)
        .filter((edgeKey) => !retainedEdgeKeys.has(edgeKey));
      const targetPathIndex = paths.findIndex((path) =>
        sameEdgeSequence(path.edges, expectedPath)
      );
      const routeOrderScore = diagnoseResolvedRingScore(
        routeOrder,
        input.mids,
      );
      const flashToken = expectedFlashToken(
        routeOrder,
        input.pricedTokenLimits,
      );
      const fundedOrder = flashToken
        ? rotateExpectedRoute(routeOrder, flashToken)
        : null;
      const fundedOrderScore = fundedOrder
        ? diagnoseResolvedRingScore(fundedOrder, input.mids)
        : null;
      const reason = missingExpansionEdgeKeys.length > 0
        ? protocolEdge
          ? "protocol_expansion_edge_pruned"
          : "general_expansion_edge_pruned"
        : targetPathIndex < 0
          ? protocolEdge
            ? "protocol_tail_not_retained"
            : "general_path_not_retained"
          : pathLeavesStandingPosition(routeOrder)
            ? "standing_position"
            : !isAdmissibleBlockScanRingShape(
                routeOrder,
                input.pricedTokenLimits,
              )
              ? "inadmissible_ring_shape"
              : routeOrderScore.status === "rejected"
                ? `coarse_score_${routeOrderScore.reason}`
                : routeOrderScore.estSpreadBps <= input.minSpreadBps
                  ? "below_min_spread"
                  : !flashToken
                    ? "no_priced_flash_token"
                    : fundedOrderScore?.status === "rejected"
                      ? `funded_score_${fundedOrderScore.reason}`
                      : fundedOrderScore &&
                          fundedOrderScore.estSpreadBps <= input.minSpreadBps
                        ? "funded_below_min_spread"
                        : "post_score_checks_passed";
      return {
        protocolEdgeIndex,
        missingExpansionEdgeKeys,
        enumeratedPathCount: paths.length,
        pathCapReached: paths.length >= 2000,
        targetPathIndex: targetPathIndex >= 0 ? targetPathIndex : null,
        routeOrderScore,
        fundedOrderScore,
        flashToken,
        reason,
      };
    });
  const postScore = attempts.find(
    (attempt) => attempt.reason === "post_score_checks_passed",
  );
  return {
    status: postScore ? "post_score" : "rejected",
    reason: postScore?.reason ?? bestExpectedAttemptReason(attempts),
    mode: protocolIndexes.length > 0 ? "protocol-first" : "general",
    attempts,
  };
}

function bestExpectedAttemptReason(
  attempts: readonly ExpectedEnumerationAttempt[],
): string {
  return attempts.find((attempt) =>
    attempt.missingExpansionEdgeKeys.length === 0 &&
    attempt.targetPathIndex !== null
  )?.reason ??
    attempts.find((attempt) =>
      attempt.missingExpansionEdgeKeys.length === 0
    )?.reason ??
    attempts[0]?.reason ??
    "empty_route";
}

function sameEdgeSequence(
  left: readonly TokenEdge[],
  right: readonly TokenEdge[],
): boolean {
  return left.length === right.length &&
    left.every((edge, index) =>
      blockScanEdgeKey(edge) === blockScanEdgeKey(right[index])
    );
}

function expectedFlashToken(
  route: readonly TokenEdge[],
  pricedTokenLimits: ReadonlyMap<string, { maxBorrow: bigint }>,
): string | null {
  const tokens = route.map((edge) => edge.tokenIn.toLowerCase());
  const weth = ADDR.WETH.toLowerCase();
  if (tokens.includes(weth) && pricedTokenLimits.has(weth)) return weth;
  return tokens.find((token) => pricedTokenLimits.has(token)) ?? null;
}

function rotateExpectedRoute(
  route: readonly TokenEdge[],
  startToken: string,
): TokenEdge[] | null {
  const wanted = startToken.toLowerCase();
  const index = route.findIndex(
    (edge) => edge.tokenIn.toLowerCase() === wanted,
  );
  if (index < 0) return null;
  return [...route.slice(index), ...route.slice(0, index)];
}

function canonicalSetSha256(values: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...new Set(values)].sort()))
    .digest("hex");
}

function sameRouteStep(
  actual: OpportunityReport["route"][number],
  expected: OpportunityReport["route"][number],
): boolean {
  return routeStepMatchesExpected(actual, expected);
}

function parseExpectedSwapPath(value: string): Array<{ pool_id: string; direction: "0for1" | "1for0" }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("AB_EXPECTED_SWAP_PATH_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((step) => {
    const entry = step as { pool_id?: unknown; direction?: unknown };
    return typeof entry?.pool_id !== "string"
      || (entry.direction !== "0for1" && entry.direction !== "1for0");
  })) {
    throw new Error("AB_EXPECTED_SWAP_PATH_JSON must contain ordered pool_id/direction steps");
  }
  return parsed.map((step) => {
    const entry = step as { pool_id: string; direction: "0for1" | "1for0" };
    return { pool_id: entry.pool_id.toLowerCase(), direction: entry.direction };
  });
}

function opportunitySwapPath(
  edges: TokenEdge[],
): Array<{ pool_id: string; direction: "0for1" | "1for0" }> | null {
  const result: Array<{ pool_id: string; direction: "0for1" | "1for0" }> = [];
  for (const edge of edges) {
    if (edge.slotKind !== "swap") continue;
    const direction = edgeSwapDirection(edge);
    if (!direction) return null;
    result.push({ pool_id: edgePoolIdentity(edge), direction });
  }
  return result;
}

function edgeSwapDirection(edge: TokenEdge): "0for1" | "1for0" | null {
  if (edge.curveI !== undefined && edge.curveJ !== undefined) {
    return edge.curveI < edge.curveJ ? "0for1" : "1for0";
  }
  const token0 = (edge.nativeCurrency0 ? ADDR.WETH : edge.poolToken0)?.toLowerCase();
  const token1 = (edge.nativeCurrency1 ? ADDR.WETH : edge.poolToken1)?.toLowerCase();
  const tokenIn = edge.tokenIn.toLowerCase();
  const tokenOut = edge.tokenOut.toLowerCase();
  if (token0 && token1) {
    if (tokenIn === token0 && tokenOut === token1) return "0for1";
    if (tokenIn === token1 && tokenOut === token0) return "1for0";
  }
  if (edge.adapterId.toLowerCase().includes("balancer")) {
    return tokenIn < tokenOut ? "0for1" : "1for0";
  }
  return null;
}

function ringTokens(edges: TokenEdge[]): string[] {
  if (edges.length === 0) return [];
  return [edges[0].tokenIn.toLowerCase(), ...edges.map((edge) => edge.tokenOut.toLowerCase())];
}

function edgePoolIdentity(edge: TokenEdge): string {
  return (edge.poolId ?? edge.target).toLowerCase();
}

function protocolKey(target: string, tokenIn: string, tokenOut: string): string {
  return `${target.toLowerCase()}|${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}`;
}

function bestSolvedNet(reports: SolveReport[]): bigint | null {
  let best: bigint | null = null;
  for (const report of reports) {
    if (report.solved === null) continue;
    const net = BigInt(report.solved);
    if (best === null || net > best) best = net;
  }
  return best;
}

function lowerPoolEntry(pool: PoolEntry): PoolEntry {
  return {
    ...pool,
    address: lowerAddress(pool.address),
    token0: lowerOptionalAddress(pool.token0),
    token1: lowerOptionalAddress(pool.token1),
    currency0: lowerOptionalAddress(pool.currency0),
    currency1: lowerOptionalAddress(pool.currency1),
    hooks: lowerOptionalAddress(pool.hooks),
    fixedTokenIn: lowerOptionalAddress(pool.fixedTokenIn),
    fixedTokenOut: lowerOptionalAddress(pool.fixedTokenOut),
    poolId: pool.poolId?.toLowerCase(),
  };
}

function lowerEdge(edge: TokenEdge): TokenEdge {
  return {
    ...edge,
    target: lowerAddress(edge.target),
    tokenIn: lowerAddress(edge.tokenIn),
    tokenOut: lowerAddress(edge.tokenOut),
    poolToken0: lowerOptionalAddress(edge.poolToken0),
    poolToken1: lowerOptionalAddress(edge.poolToken1),
    poolId: edge.poolId?.toLowerCase(),
    v4PoolKey: edge.v4PoolKey
      ? {
          currency0: lowerAddress(edge.v4PoolKey.currency0),
          currency1: lowerAddress(edge.v4PoolKey.currency1),
          fee: edge.v4PoolKey.fee,
          tickSpacing: edge.v4PoolKey.tickSpacing,
          hooks: lowerAddress(edge.v4PoolKey.hooks),
        }
      : undefined,
  };
}

function lowerOptionalAddress(value: string | undefined): string | undefined {
  return value === undefined ? undefined : lowerAddress(value);
}

function lowerAddress(value: string): string {
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress.toLowerCase();
  return ethers.getAddress(value.toLowerCase()).toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

function formatSpread(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = parsed.username ? "<redacted>" : "";
    parsed.password = parsed.password ? "<redacted>" : "";
    const localHost = parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1";
    if (!localHost && parsed.pathname && parsed.pathname !== "/") {
      parsed.pathname = "/redacted";
    }
    if (parsed.search) parsed.search = "?<redacted>";
    return parsed.toString();
  } catch {
    return url.startsWith("http") ? "<rpc-url>" : url;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  secret?: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = secret ? msg.split(secret).join("<rpc-url>") : msg;
    throw new Error(`${label} failed: ${redacted}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class PinnedCallBackend implements StateBackend {
  private readonly backend: ReturnType<typeof createPinnedDexReadBackend>;

  constructor(
    provider: ethers.JsonRpcProvider,
    blockNumber: number,
  ) {
    this.backend = createPinnedDexReadBackend(provider, blockNumber);
  }

  async call(
    req: { to: string; data: string; from?: string },
    control?: StateCallControl,
  ): Promise<string> {
    return this.backend.call(req, control);
  }

  async forkAt(): Promise<void> {
    this.unsupported("forkAt");
  }

  async forkAfterTx(): Promise<void> {
    this.unsupported("forkAfterTx");
  }

  async prepareVictimPostState(): Promise<never> {
    this.unsupported("prepareVictimPostState");
  }

  async applyRawTx(): Promise<never> {
    this.unsupported("applyRawTx");
  }

  async queueHistoricalRawTransactions(): Promise<never> {
    this.unsupported("queueHistoricalRawTransactions");
  }

  async snapshot(): Promise<never> {
    this.unsupported("snapshot");
  }

  async revert(): Promise<void> {
    this.unsupported("revert");
  }

  async send(): Promise<never> {
    this.unsupported("send");
  }

  async getGasUsed(): Promise<never> {
    this.unsupported("getGasUsed");
  }

  async getTokenBalance(): Promise<never> {
    this.unsupported("getTokenBalance");
  }

  private unsupported(method: string): never {
    throw new Error(`PinnedCallBackend.${method} unsupported`);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (DIAGNOSTIC.enabled && lastDiagnosticStep < 6) {
    const nextStep = Math.max(1, Math.min(6, lastDiagnosticStep + 1)) as 1 | 2 | 3 | 4 | 5 | 6;
    emitDiagnostic(nextStep, "execution_error", "fail", {
      afterStep: lastDiagnosticStep,
      error: message.replace(/https?:\/\/[^\s]+/g, "<rpc-url>").slice(0, 500),
    });
  }
  console.error(`blockscan-hunt FAIL: ${message}`);
  process.exit(1);
});

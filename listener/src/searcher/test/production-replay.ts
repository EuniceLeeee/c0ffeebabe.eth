/**
 * Source-unseeded production-path diagnostic orchestration.
 *
 * Inputs are only a landed winner, its lane-correct state anchor, a historical
 * source window and the ordinary DEX universe. No route, pool, family target,
 * amount or calldata enters discovery/ranking. The shared protocol discovery
 * pipeline first produces probe-verified pools. A hash-bound preload makes
 * only those pools visible to the unchanged blockscan-hunt process; its output
 * route is then independently re-simulated and evaluated with production code.
 * This candidate-authored runner is not the trusted gate: a trigger anchor is
 * sender-prefix/post-trigger scanner evidence, not boundary/trigger/full-prefix
 * backrun causality.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { compilePlan } from "../../shared/compiler/compiler.js";
import {
  canonicalMaterializedGraphEvidence,
  type CanonicalMaterializedGraphEvidence,
  type CanonicalShardCompleteness,
  type FamilySourceCoverage,
  productionShardCompleteness,
} from "../../shared/evidence/canonical-edge-set.js";
import {
  semanticJsonSha256,
  type SemanticJson,
} from "../../shared/evidence/semantic-six-step.js";
import {
  buildExecuteCalldata,
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { sendDexDiscoveryRpc } from "../dex-discovery-transport.js";
import { mergePoolRegistries } from "../pool-registry-merge.js";
import { canonicalTokenRing, cycleFingerprint } from "../detector/cycle-fingerprint.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import { detectImpactFromLogs, type PoolImpact } from "../detector/pool-impact.js";
import { evaluateEv, type EvPolicy } from "../ev-evaluator.js";
import { DEFAULT_BRIBE_BPS } from "../live-envelope.js";
import { TemplatePlanner } from "../planner/planner.js";
import {
  buildTokenGraph,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenEdge,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import {
  DEFAULT_POOL_UNIVERSE_PATH,
  loadPoolUniverse,
  poolProjectionRowKey,
} from "../pool-universe.js";
import {
  enabledDiscoveryAdapters,
  protocolCandidateAddressesFromDexGraph,
  protocolCandidateAddressesFromDexUniverse,
  protocolDiscoveryCandidateAddressHints,
  prepareActiveProtocolDiscoveryPass,
  prepareObservedProtocolDiscoveryPass,
} from "../protocol-discovery-runtime.js";
import {
  createPinnedProtocolDiscoveryContext,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  projectVerifiedProtocolPool,
} from "../protocol-instance-discovery.js";
import { createProfitTokenValuation } from "../profit-token-valuation.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import {
  defaultFinalVerifyFloorBps,
  shouldRunFinalVerify,
} from "../solver/final-verify-gate.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { AnvilSolver } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { buildStrategyViews } from "../strategy-views.js";
import {
  DEFAULT_CREDIT_LIVE_MARKER_PATH,
  evaluateStandingGuard,
} from "../standing-guard.js";
import { pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";
import {
  STRICT_EMPTY_PROTOCOL_IDENTITY_TEST_REGISTRY,
  STRICT_PROJECTED_FAMILY_TEST_REGISTRY,
} from "./strict-family-test-compat.js";
import {
  DEFAULT_PENDING_EVIDENCE_MAX_READS,
  DEFAULT_PENDING_EVIDENCE_TIMEOUT_MS,
} from "../venues/adapter-family-registry.js";
import {
  PRODUCTION_REPLAY_ARTIFACT_PRODUCER,
  PRODUCTION_REPLAY_ARTIFACT_SCHEMA,
  selectProductionReplayDiscoveredPools,
  type ProductionReplayUniverseEvidence,
  writeProductionReplayDiscoveryArtifact,
} from "./production-replay-artifact.js";
import {
  anchorHistoricalSenderNoncePrefix,
  type HistoricalSenderNonceAnchorResult,
} from "./historical-replay-anchor.js";
import {
  observeFrozenTransactionExecutionEvidence,
  pendingExecutionEvidenceFamilyIds,
  pendingExecutionEvidenceReport,
  selectFrozenRouteExecutionEvidence,
  writeFrozenPendingExecutionEvidenceArtifact,
  type PendingExecutionEvidenceReport,
} from "./production-replay-pending-evidence.js";
import {
  flattenSuccessfulCalls,
  matchReferenceWitness,
  parseReferenceWitness,
  type FlattenedTraceCall,
  type ReferenceWitnessLeg,
  type TraceCall,
} from "./adapter-replay.js";
import type {
  ResolvedActionExecutionSurface,
  ResolvedRouteExecutionSurface,
} from "./route-execution-witness.js";

interface CliConfig {
  winnerTx: string;
  triggerTx: string | null;
  sourceFromBlock: number;
  universePath: string;
  maxPools: number;
  maxHops: number;
  maxCandidates: number;
  topK: number;
  minSpreadBps: number;
  prewarmBudgetMs: number;
  scanBudgetMs: number;
  passBudgetMs: number;
  largeGraphPassBudgetMs: number;
  largeGraphEdgeThreshold: number;
  refineCandidates: number;
  refineFamilyTimeoutMs: number;
  outPath: string | null;
}

interface TargetBlindProduceConfig {
  phase: "produce";
  baseBlock: number;
  baseBlockHash: string;
  baseStateRoot: string;
  sourceFromBlock: number;
  universePath: string;
  anvilPort: number;
  workspacePath: string;
  maxPools: number;
  maxHops: number;
  maxCandidates: number;
  topK: number;
  minSpreadBps: number;
  prewarmBudgetMs: number;
  scanBudgetMs: number;
  passBudgetMs: number;
  largeGraphPassBudgetMs: number;
  largeGraphEdgeThreshold: number;
  refineCandidates: number;
  refineFamilyTimeoutMs: number;
  outPath: string;
}

interface TargetBlindVerifyConfig {
  phase: "verify";
  winnerTx: string;
  producerArtifactPath: string;
  producerArtifactSha256: string;
  trustedReferencePath: string;
  trustedReferenceSha256: string;
  anvilPort: number;
  outPath: string;
}

type TargetBlindConfig =
  | TargetBlindProduceConfig
  | TargetBlindVerifyConfig;

export interface HuntEdge {
  adapterId: string;
  target: string;
  tokenIn: string;
  tokenOut: string;
  slotKind: TokenEdge["slotKind"];
  edgeKind: TokenEdge["edgeKind"];
  leavesStandingPosition: boolean;
  poolId?: string;
}

interface HuntOpportunity {
  rank: number;
  searchCenter: string;
  maxInput: string;
  seedEdges: HuntEdge[];
}

export interface HuntSolve {
  opportunityIndex: number;
  solved: string | null;
  solveError: string | null;
  diagnosticHopAmounts?: Array<{
    adapterId: string;
    target: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
    rawAmountOut: string;
  }>;
  frozenResult?: {
    schemaVersion: 2;
    executor: string;
    routeSha256: string;
    flashAmount: string;
    quotedNetProfit: string;
    profitToken: string;
    rawCalldata: string;
    calldataSha256: string;
    resolvedPlanSha256: string;
    fundingActionId: string;
    executionSurfaces: ResolvedRouteExecutionSurface[];
    supportActionAdapterIds: string[];
    supportExecutionCalls: ResolvedActionExecutionSurface[];
    leavesStandingPosition: boolean;
    requiredFamilyIds: string[];
    shardCompleteness: CanonicalShardCompleteness;
    bindingSha256: string;
  };
}

interface HuntReport {
  stateBlock: number;
  edges: number;
  edgeSetSha256: string;
  pendingExecutionEvidenceArtifactSha256: string;
  opportunities: HuntOpportunity[];
  solved: HuntSolve[];
  scanCompleteness?: TargetBlindScanCompleteness;
  effectivePassBudgetMs?: number;
  materializedGraph?: CanonicalMaterializedGraphEvidence;
  familySourceCoverage?: FamilySourceCoverage[];
}

export interface TargetBlindScanCompleteness {
  outcome: "ran" | "budget_exceeded";
  /**
   * Legacy field name: true means the frozen production-policy scan reached
   * its normal terminal state. Production caps remain policy, not a claim that
   * every graph path was exhaustively enumerated.
   */
  rankComplete: boolean;
  refinementDeadlineHit: boolean;
  evaluationComplete: boolean;
  enumeratedCount: number;
  selectedCount: number;
  forcedSelectionCount: number;
  scannedPairs: number;
}

export interface TargetBlindExplicitInputBindings {
  universeSha256: string;
  universeManifestSha256: string;
  runtimeJsonInputs: Array<{
    key: string;
    sha256: string;
  }>;
  sha256: string;
}

interface TargetBlindProducerArtifact {
  schemaVersion: 1;
  artifact: "explicit-input-target-late-production-replay";
  stateAnchor: {
    kind: "parent-block";
    blockNumber: number;
    blockHash: string;
    stateRoot: string;
  };
  sourceFromBlock: number;
  universe: ProductionReplayUniverseEvidence;
  actualRunnerConfig: ReturnType<typeof targetBlindRunnerConfigEvidence>;
  validationPolicy: ReplayReport["validationPolicy"];
  explicitInputBindings: TargetBlindExplicitInputBindings;
  producerOutput: ProducerOutputEvidence;
  familySourceCoverage: FamilySourceCoverage[];
  naturalTopK: Array<{
    opportunityIndex: number;
    rank: number;
    route: HuntEdge[];
    routeSha256: string;
    hopAmounts: NonNullable<HuntSolve["diagnosticHopAmounts"]> | null;
    frozenResult: NonNullable<HuntSolve["frozenResult"]> | null;
  }>;
}

export interface TrustedReferenceRoute {
  schemaVersion: 2;
  artifact: "trusted-production-reference-route";
  sampleTxHash: string;
  targetInputSha256: string;
  stateAnchor: {
    opportunityBlock: number;
    baseBlock: number;
    baseBlockHash: string;
    baseStateRoot: string;
  };
  route: HuntEdge[];
  routeSha256: string;
  routeWitnesses: Array<ReferenceWitnessLeg>;
}

interface ReplayValidationPolicy {
  quoteSafetyBps: bigint;
  quoteProfitFloorBps: bigint;
  finalVerifyFloorBps: bigint;
  maxProfitBpsOfFlash: bigint;
  standingMarkerPath: string;
  ev: EvPolicy;
  minNetEth: bigint;
}

interface ReplayInputAudit {
  explicitRouteInputs: string[];
  explicitAmountInputs: string[];
  strippedRouteEnvironmentKeys: string[];
  strippedAmountEnvironmentKeys: string[];
}

interface FrozenUniverseInput {
  snapshotPath: string;
  snapshotName: string;
  evidence: ProductionReplayUniverseEvidence;
  pools: PoolEntry[];
}

interface NaturalRouteSetEvidence {
  opportunityCount: number;
  routeCount: number;
  routeSha256s: string[];
  sha256: string;
}

interface ProducerOutputEvidence {
  materializedGraph: CanonicalMaterializedGraphEvidence;
  fullGraph: { edgeCount: number; sha256: string };
  naturalRouteSet: NaturalRouteSetEvidence | null;
  frozenHuntArtifact: { byteLength: number; sha256: string } | null;
  scanCompleteness?: TargetBlindScanCompleteness;
}

interface ReplayReport {
  schemaVersion: 5;
  evidenceClass: "candidate-authored-diagnostic";
  trustedAcceptance: false;
  laneCoverage: "parent-block-blockscan" | "sender-prefix-post-trigger-blockscan";
  winnerTx: string;
  triggerTx: string | null;
  sourceWindow: { fromBlock: number; toBlock: number };
  stateAnchor: {
    kind: "parent-block" | "sender-nonce-prefix";
    blockNumber: number;
    txHash: string | null;
    replayedTransactions: number;
    reconstruction: HistoricalSenderNonceAnchorResult | null;
  };
  inputs: {
    universePath: string;
    contentAddressedSnapshot: string;
    universe: ProductionReplayUniverseEvidence;
    universeProvenance: "unverified-cli";
    explicitRouteInjected: boolean;
    explicitRouteInputs: string[];
    strippedRouteEnvironmentKeys: string[];
    explicitAmountInjected: boolean;
    explicitAmountInputs: string[];
    strippedAmountEnvironmentKeys: string[];
    amountSource: "solver";
    dynamicPoolsFromDiscoveryArtifact: true;
    explicitInputBindings?: TargetBlindExplicitInputBindings;
  };
  actualRunnerConfig: ReturnType<typeof runnerConfigEvidence>;
  discovery: {
    sourceComplete: boolean;
    evaluationComplete: boolean;
    candidates: number;
    admittedInstances: number;
    discoveredPools: number;
    artifactSha256: string;
    familySourceCoverage: FamilySourceCoverage[];
    completeFamilyIds: string[];
    shardCompleteness: CanonicalShardCompleteness;
  };
  producerOutput: ProducerOutputEvidence;
  executionEvidence: PendingExecutionEvidenceReport;
  reference: {
    observedAdmissions: number;
    subjectEdges: HuntEdge[];
    referenceEdgeMatched: boolean;
    cycleCandidates: number;
    subjectCycle: HuntEdge[];
    exactCycleMatched: boolean;
    targetInputVerified?: boolean;
    targetInputSha256?: string;
    trustedReferenceArtifactSha256?: string;
    trustedRouteSha256?: string;
    frozenHuntArtifactSha256?: string;
  };
  stages: {
    sourceAndIdentity: "pass" | "fail";
    graphProjection: "pass" | "fail";
    enumeration: "pass" | "fail";
    solver: "pass" | "fail";
    finalSim: "pass" | "fail" | "not_reached";
    ev: "allow" | "reject" | "not_reached";
  };
  validationPolicy: {
    quoteSafetyBps: string;
    quoteProfitFloorBps: string;
    finalVerifyFloorBps: string;
    maxProfitBpsOfFlash: string;
    standingMarkerPath: string;
    ev: EvPolicy & { minNetEth: string };
  };
  terminalGates: {
    finalVerifyAdmission: null | {
      allowed: boolean;
      quoteProfit: string;
      flashAmount: string;
      floorBps: string;
    };
    phantomProfit: null | {
      allowed: boolean;
      netProfit: string;
      flashAmount: string;
      maxProfitBpsOfFlash: string;
    };
    standingGuard: null | {
      allowed: boolean;
      containsStandingPosition: boolean;
      reason: string | null;
      markerPath: string;
    };
    repaymentAndConservation: null | { allowed: true };
    offlineHistorical: {
      headStaleCheck: "not_applicable";
      submissionCoordinator: "not_run";
      bundleRouter: "not_run";
      submissionAttempted: false;
      reason: "historical replay never submits";
    };
  };
  selected: null | {
    rank: number;
    route: HuntEdge[];
    routeSha256: string;
    solverAmount: string;
    hopAmounts: Array<{ amountIn: string; amountOut: string; rawAmountOut: string }>;
    profitToken: string;
    grossProfit: string;
    netProfit: string;
    gasUsed: string;
    calldataHash: string;
    resolvedPlanSha256: string;
    fundingActionId?: string;
    executionSurfaces?: ResolvedRouteExecutionSurface[];
    supportActionAdapterIds?: string[];
    supportExecutionCalls?: ResolvedActionExecutionSurface[];
    repaymentAndConservation: true;
    leavesStandingPosition: boolean;
    ev: {
      valuationAvailable: boolean;
      gasMeasurementAvailable: boolean;
      feeStateAvailable: boolean;
      sourceBlockHash: string | null;
      decisionParentBlock: number;
      targetBlock: number;
      ethUsd: number | null;
      ethUsdRoundId: string | null;
      ethUsdUpdatedAt: string | null;
      rawProfitEth: string;
      netEvWei: string;
      expectedProfitEth: string;
      gasUnits: string;
      maxBaseFeePerGas: string;
      gasCostEth: string;
      bidEth: string;
    };
  };
  failure: string | null;
}

const LISTENER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REPO_ROOT = resolve(LISTENER_ROOT, "..");
const HUNT_PATH = resolve(LISTENER_ROOT, "src/searcher/test/blockscan-hunt.ts");
const PRELOAD_PATH = resolve(LISTENER_ROOT, "src/searcher/test/production-replay-preload.ts");
const TSX_IMPORT_URL = import.meta.resolve("tsx");

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--phase")) {
    const targetBlind = parseTargetBlindArgs(process.argv.slice(2));
    if (targetBlind.phase === "produce") {
      await produceTargetBlind(targetBlind);
    } else {
      await verifyTargetBlind(targetBlind);
    }
    return;
  }
  loadRpcEnv();
  const cfg = parseArgs();
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL ?? process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const tempRoot = mkdtempSync(resolve(tmpdir(), "mev-production-replay-"));
  const validationPolicy = readValidationPolicy(cfg);
  const inputAudit = auditReplayInputs(process.argv.slice(2), process.env);
  let anchorState: AnvilStateBackend | null = null;
  let validationState: AnvilStateBackend | null = null;
  let report: ReplayReport | null = null;
  try {
    const frozenUniverse = freezeUniverseInput(
      cfg.universePath,
      tempRoot,
      cfg.maxPools,
      // The supplied artifact may already be the exact live runtime graph.
      // Re-applying active-pool scoring here turns its intentionally unscored
      // admitted rows into a zero-pool universe and manufactures a false
      // discovery failure. Top-N remains enforced by maxPools.
      0,
    );
    const [winner, winnerTransaction] = await Promise.all([
      provider.getTransactionReceipt(cfg.winnerTx),
      provider.getTransaction(cfg.winnerTx),
    ]);
    if (!winner || winner.status !== 1) throw new Error("winner receipt missing or reverted");
    if (!winnerTransaction) throw new Error("winner transaction missing");
    const parentBlock = winner.blockNumber - 1;
    const parentHeader = await provider.getBlock(parentBlock);
    if (!parentHeader?.hash) throw new Error("winner parent header missing");
    const frozenPendingExecutionEvidence =
      await observeFrozenTransactionExecutionEvidence({
        projection: STRICT_PROJECTED_FAMILY_TEST_REGISTRY.pendingTransactionEvidence(),
        transaction: Object.freeze({
          hash: winnerTransaction.hash,
          to: winnerTransaction.to,
          data: winnerTransaction.data,
        }),
        familyRequiresCurrentHeadEvidence(familyId) {
          return STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes()
            .forFamily(familyId)
            .pendingTransactionEvidence?.routeActivation ===
              "current-head-block-scan";
        },
        transport: {
          head: Object.freeze({
            number: parentBlock,
            hash: parentHeader.hash,
          }),
          call(read, control) {
            return sendDexDiscoveryRpc<string>(
              provider,
              "eth_call",
              [
                provider.getRpcTransaction({
                  to: read.to,
                  data: read.data,
                }),
                {
                  blockHash: parentHeader.hash,
                  requireCanonical: true,
                },
              ],
              control,
            );
          },
        },
        timeoutMs: Number(
          process.env.SEARCHER_PENDING_EVIDENCE_TIMEOUT_MS ??
            DEFAULT_PENDING_EVIDENCE_TIMEOUT_MS,
        ),
        maxReadsPerFamily: Number(
          process.env.SEARCHER_PENDING_EVIDENCE_MAX_READS ??
            DEFAULT_PENDING_EVIDENCE_MAX_READS,
        ),
      });
    const pendingEvidenceArtifactPath =
      resolve(tempRoot, "pending-execution-evidence.json");
    const pendingEvidenceArtifactSha256 =
      writeFrozenPendingExecutionEvidenceArtifact(
        pendingEvidenceArtifactPath,
        frozenPendingExecutionEvidence,
      );
    if (cfg.sourceFromBlock > parentBlock) {
      throw new Error("source-from-block must not exceed the winner parent block");
    }
    if (
      frozenUniverse.evidence.fromBlock !== null &&
      frozenUniverse.evidence.fromBlock !== cfg.sourceFromBlock
    ) {
      throw new Error(
        `universe fromBlock ${frozenUniverse.evidence.fromBlock} != source-from-block ` +
          `${cfg.sourceFromBlock}`,
      );
    }
    if (
      frozenUniverse.evidence.toBlock !== null &&
      frozenUniverse.evidence.toBlock !== parentBlock
    ) {
      throw new Error(
        `universe toBlock ${frozenUniverse.evidence.toBlock} != winner parent ${parentBlock}`,
      );
    }
    let triggerReceipt: ethers.TransactionReceipt | null = null;
    let trigger: ethers.TransactionResponse | null = null;
    if (cfg.triggerTx) {
      [triggerReceipt, trigger] = await Promise.all([
        provider.getTransactionReceipt(cfg.triggerTx),
        provider.getTransaction(cfg.triggerTx),
      ]);
      if (
        !triggerReceipt || !trigger || triggerReceipt.status !== 1 ||
        triggerReceipt.blockNumber !== winner.blockNumber ||
        Number(triggerReceipt.index) >= Number(winner.index)
      ) {
        throw new Error("trigger must be a successful earlier transaction in the winner block");
      }
    }

    const universe = frozenUniverse.pools;
    const staticProtocols = POOL_REGISTRY
      .filter((pool) => pool.adapter !== "fluid-vault")
      .map(lowerPoolEntry);
    const basePools = mergePoolRegistries(staticProtocols, universe.map(lowerPoolEntry));
    const parentBackend = tokenBackend(provider, parentBlock);
    const baseGraph = (await buildTokenGraph(parentBackend, basePools)).map(lowerEdge);
    const dexAdapters = new Set(
      STRICT_PROJECTED_FAMILY_TEST_REGISTRY.swaps().flatMap((adapter) => [...adapter.poolAdapters]),
    );
    const protocolEdgesEnabled = true;
    const discoveryAdapters = enabledDiscoveryAdapters(
      STRICT_PROJECTED_FAMILY_TEST_REGISTRY.discoverableRoutes(),
      protocolEdgesEnabled,
    );
    const graphTokens = [...new Set([
      ...protocolCandidateAddressesFromDexUniverse(universe, dexAdapters),
      ...protocolCandidateAddressesFromDexGraph(baseGraph),
    ])].sort();
    const candidateAddresses = [...new Set([
      ...graphTokens,
      ...protocolDiscoveryCandidateAddressHints(
        discoveryAdapters,
      ),
    ])].sort();
    const chainId = (await provider.getNetwork()).chainId;
    const pass = await prepareActiveProtocolDiscoveryPass({
      provider,
      adapters: discoveryAdapters,
      identityRegistry: STRICT_EMPTY_PROTOCOL_IDENTITY_TEST_REGISTRY,
      protocolEdgesEnabled,
      chainId,
      probeExecutor: DEFAULT_SEARCHER_EXECUTOR,
      currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
      currentBackrunPools: basePools,
      currentBackrunGraph: baseGraph,
      currentBlockscanGraph: baseGraph,
      buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
        blockscanMaxPools: 0,
        poolUniverseGeneratedAt: "production-replay",
      }),
      blockNumber: parentBlock,
      fromBlock: cfg.sourceFromBlock,
      graphTokens,
      candidateAddresses,
      shadow: false,
    });
    if (!pass.projection) throw new Error("active protocol discovery produced no projection");
    // Bind the eventual autonomous hunt result back to the landed winner only
    // after discovery. This receipt+calltrace matcher is an acceptance oracle;
    // none of its target/edge data is passed into graph construction, ranking,
    // sizing or simulation.
    const referenceContext = createPinnedProtocolDiscoveryContext({
      provider,
      blockNumber: parentBlock,
      fromBlock: parentBlock,
      chainId,
      probeExecutor: DEFAULT_SEARCHER_EXECUTOR,
      graphTokens,
    });
    const [referenceReceipt, referenceTrace] = await Promise.all([
      referenceContext.backend.getTransactionReceipt(cfg.winnerTx),
      referenceContext.backend.traceTransaction(cfg.winnerTx),
    ]);
    if (!referenceReceipt || referenceReceipt.status !== 1) {
      throw new Error("winner receipt was unavailable to the observed protocol matcher");
    }
    const referencePass = await prepareObservedProtocolDiscoveryPass({
      provider,
      adapters: discoveryAdapters,
      identityRegistry: STRICT_EMPTY_PROTOCOL_IDENTITY_TEST_REGISTRY,
      protocolEdgesEnabled,
      chainId,
      probeExecutor: DEFAULT_SEARCHER_EXECUTOR,
      currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
      currentBackrunPools: basePools,
      currentBackrunGraph: baseGraph,
      currentBlockscanGraph: baseGraph,
      buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
        blockscanMaxPools: 0,
        poolUniverseGeneratedAt: "production-replay-reference",
      }),
      blockNumber: parentBlock,
      txHash: cfg.winnerTx,
      receipt: referenceReceipt,
      trace: referenceTrace,
      graphTokens,
    });
    const referenceAdmissions = [...referencePass.projection.ownership.admissions.values()];
    const referenceEdges = referenceAdmissions.flatMap((item) => item.edges).map(lowerEdge);
    const fullGraph = pass.projection.blockscanGraph ?? pass.projection.backrunGraph;
    const effectivePassBudgetMs = productionPassBudgetMs(
      cfg,
      fullGraph.length,
    );
    const winnerLogs = winner.logs.map((log) => ({
      address: log.address,
      topics: [...log.topics],
      data: log.data,
    }));
    const swapImpacts = await detectImpactFromLogs(
      winnerLogs,
      fullGraph,
      null,
      parentBackend,
    );
    const referenceSwapEdges = uniqueEdges(
      swapImpacts.map((impact) => findSwapImpactEdge(fullGraph, impact)),
    );
    const referenceCycles = deriveClosedReferenceCycles(
      [...referenceSwapEdges, ...referenceEdges],
      new Set(referenceEdges.map(edgeIdentity)),
      cfg.maxHops,
    );
    const referenceCycle = referenceCycles.length === 1 ? referenceCycles[0] : [];
    const sourceComplete = pass.scanner.sourceComplete && pass.result.sourceComplete;
    const evaluationComplete = pass.result.evaluationComplete;
    const familySourceCoverage = pass.result.familySourceCoverage.map((item) => ({
      familyId: item.familyId,
      sourceId: item.sourceId,
      complete: item.complete,
      issues: [...item.issues],
    }));
    const discoveredProtocolPools = [
      ...pass.projection.ownership.admissions.values(),
    ].map((item) => lowerPoolEntry(projectVerifiedProtocolPool(item)));
    const discoveredPoolKeys = discoveredProtocolPools
      .map(poolProjectionRowKey)
      .sort();
    const discoveredPools = selectProductionReplayDiscoveredPools(
      pass.projection.strategyViews.blockscan,
      discoveredPoolKeys,
    );
    const artifactPath = resolve(tempRoot, "verified-universe.json");
    let artifactSha256 = "";
    const initialShardProof = productionShardCompleteness({
      edges: fullGraph,
      familySourceCoverage,
      requiredFamilyIds: null,
    });
    report = emptyReport(
      cfg,
      parentBlock,
      winner.blockNumber,
      sourceComplete,
      evaluationComplete,
      frozenUniverse,
      inputAudit,
      validationPolicy,
      fullGraph,
      pendingExecutionEvidenceReport(
        frozenPendingExecutionEvidence,
        [],
        pendingEvidenceArtifactSha256,
      ),
      {
        candidates: [...pass.scanner.candidatesByAdapter.values()].reduce((sum, items) => sum + items.length, 0),
        admittedInstances: pass.result.wouldAdmit.length,
        discoveredPools: discoveredPoolKeys.length,
        artifactSha256,
        familySourceCoverage,
        completeFamilyIds: initialShardProof.familyShards
          .filter((shard) => shard.status === "complete")
          .map((shard) => shard.familyId),
        shardCompleteness: initialShardProof,
      },
    );
    report.reference = {
      observedAdmissions: referenceAdmissions.length,
      subjectEdges: referenceEdges.map(toHuntEdge),
      referenceEdgeMatched: false,
      cycleCandidates: referenceCycles.length,
      subjectCycle: referenceCycle.map(toHuntEdge),
      exactCycleMatched: false,
    };
    artifactSha256 = writeProductionReplayDiscoveryArtifact(artifactPath, {
      schemaVersion: PRODUCTION_REPLAY_ARTIFACT_SCHEMA,
      producer: PRODUCTION_REPLAY_ARTIFACT_PRODUCER,
      sourceFromBlock: cfg.sourceFromBlock,
      sourceToBlock: parentBlock,
      identityBlock: parentBlock,
      sourceUniverse: frozenUniverse.evidence,
      sourceComplete,
      evaluationComplete,
      familySourceCoverage,
      discoveredPoolKeys,
      pools: discoveredPools,
    });
    report.discovery.artifactSha256 = artifactSha256;
    const discoveredEdgeKeys = new Set(
      [...pass.projection.ownership.admissions.values()]
        .flatMap((item) => item.edges)
        .map(edgeIdentity),
    );
    const referenceEdgeKeys = new Set(
      referenceEdges.map(edgeIdentity).filter((key) => discoveredEdgeKeys.has(key)),
    );
    if (referenceEdgeKeys.size === 0) {
      report.failure = referenceEdges.length === 0
        ? "winner receipt+calltrace produced no verified protocol subject edge"
        : "winner-bound protocol edge was not independently discovered from the source window";
      finish(report, cfg.outPath);
      return;
    }
    if (referenceCycles.length !== 1) {
      report.failure =
        `winner receipt did not yield a unique closed production route: ` +
          `${referenceCycles.length} candidate cycles`;
      finish(report, cfg.outPath);
      return;
    }
    report.stages.graphProjection = pass.projection.blockscanGraph &&
      pass.projection.blockscanGraph.length > baseGraph.length ? "pass" : "fail";
    if (report.stages.graphProjection !== "pass") {
      report.failure = "verified discovery did not add a block-scan graph edge";
      finish(report, cfg.outPath);
      return;
    }

    const anchorPort = await allocatePort();
    anchorState = new AnvilStateBackend(
      rpcUrl,
      `http://127.0.0.1:${anchorPort}`,
      anchorPort,
    );
    let replayedTransactions = 0;
    let anchorReconstruction: HistoricalSenderNonceAnchorResult | null = null;
    if (cfg.triggerTx) {
      if (!triggerReceipt || !trigger) {
        throw new Error("validated trigger transaction state was not retained");
      }
      const senderPrefix = await anchorHistoricalSenderNoncePrefix({
        state: anchorState,
        archiveProvider: provider,
        triggerTxHash: cfg.triggerTx,
        expectedBlockNumber: winner.blockNumber,
        mustPrecedeIndex: Number(winner.index),
        mineLabel: "trigger-sender-nonce-prefix",
      });
      anchorReconstruction = senderPrefix;
      replayedTransactions = senderPrefix.transactionHashes.length;
      console.log(
        `[production-replay] state anchor: sender nonce ${senderPrefix.firstNonce}..` +
          `${trigger.nonce}, tx indexes ${senderPrefix.transactionIndexes.join(",")} ` +
          `(through ${cfg.triggerTx})`,
      );
    } else {
      await anchorState.forkAt(parentBlock);
    }
    const anchorBlock = await anchorState.provider.getBlockNumber();
    const expectedAnchorBlock = cfg.triggerTx ? winner.blockNumber : parentBlock;
    if (anchorBlock !== expectedAnchorBlock) {
      throw new Error(`fork anchor block ${anchorBlock} != expected ${expectedAnchorBlock}`);
    }
    report.stateAnchor = {
      kind: cfg.triggerTx ? "sender-nonce-prefix" : "parent-block",
      blockNumber: anchorBlock,
      txHash: cfg.triggerTx,
      replayedTransactions,
      reconstruction: anchorReconstruction,
    };

    const huntOut = resolve(tempRoot, "hunt.json");
    const huntPort = await allocatePort();
    assertFileSha256(frozenUniverse.snapshotPath, frozenUniverse.evidence.sha256);
    await runHunt({
      upstreamRpc: anchorState.anvilUrl,
      anchorBlock,
      artifactPath,
      artifactSha256,
      huntOut,
      huntPort,
      universeSnapshotPath: frozenUniverse.snapshotPath,
      universeSha256: frozenUniverse.evidence.sha256,
      pendingEvidenceArtifactPath,
      pendingEvidenceArtifactSha256,
      cfg,
      passBudgetMs: effectivePassBudgetMs,
    });
    assertFileSha256(frozenUniverse.snapshotPath, frozenUniverse.evidence.sha256);
    const frozenHunt = readFrozenHuntReport(huntOut);
    const hunt = frozenHunt.report;
    report.producerOutput.frozenHuntArtifact = frozenHunt.artifact;
    report.producerOutput.naturalRouteSet = naturalRouteSetEvidence(
      hunt.opportunities,
    );
    if (hunt.opportunities.length > cfg.maxCandidates) {
      report.failure =
        `frozen hunt emitted ${hunt.opportunities.length} opportunities above ` +
          `production maxCandidates ${cfg.maxCandidates}`;
      finish(report, cfg.outPath);
      return;
    }
    if (hunt.stateBlock !== anchorBlock) {
      report.failure =
        `frozen hunt state block ${hunt.stateBlock} != anchor ${anchorBlock}`;
      finish(report, cfg.outPath);
      return;
    }
    if (hunt.edges !== report.producerOutput.materializedGraph.edgeCount) {
      report.failure =
        `frozen hunt graph edge count ${hunt.edges} != independently built ` +
          `${report.producerOutput.materializedGraph.edgeCount}`;
      finish(report, cfg.outPath);
      return;
    }
    if (hunt.edgeSetSha256 !== report.producerOutput.materializedGraph.sha256) {
      report.failure =
        `frozen hunt graph ${hunt.edgeSetSha256} != independently built ` +
          `${report.producerOutput.materializedGraph.sha256}`;
      finish(report, cfg.outPath);
      return;
    }
    if (
      hunt.pendingExecutionEvidenceArtifactSha256 !==
        pendingEvidenceArtifactSha256
    ) {
      report.failure =
        "frozen hunt did not bind the wrapper-owned pending evidence artifact";
      finish(report, cfg.outPath);
      return;
    }
    const relevant = hunt.opportunities
      .map((opportunity, index) => ({ opportunity, index }))
      .filter(({ opportunity }) => opportunity.rank <= cfg.topK)
      .filter(({ opportunity }) => sameOrderedCycle(
        opportunity.seedEdges,
        referenceCycle.map(toHuntEdge),
      ));
    report.reference.referenceEdgeMatched = relevant.length > 0;
    report.reference.exactCycleMatched = relevant.length > 0;
    if (relevant.length === 0) {
      report.stages.enumeration = "fail";
      report.failure =
        `scanner did not enumerate the winner-bound protocol edge within top ${cfg.topK}`;
      finish(report, cfg.outPath);
      return;
    }
    const requiredFamilyIds = routeFamilyIds(
      relevant[0].opportunity.seedEdges,
    );
    report.discovery.shardCompleteness = productionShardCompleteness({
      edges: fullGraph,
      familySourceCoverage,
      requiredFamilyIds,
    });
    if (report.discovery.shardCompleteness.requiredComplete !== true) {
      report.failure =
        "selected route lacks complete required discovery shards: " +
        summarizeRequiredShardFailure(
          report.discovery.shardCompleteness,
        );
      finish(report, cfg.outPath);
      return;
    }
    report.stages.sourceAndIdentity = "pass";
    report.stages.enumeration = "pass";

    const validationPort = await allocatePort();
    validationState = new AnvilStateBackend(
      anchorState.anvilUrl,
      `http://127.0.0.1:${validationPort}`,
      validationPort,
    );
    await validationState.forkAt(anchorBlock);
    await installForkBotVm(
      validationState.provider,
      DEFAULT_SEARCHER_OWNER,
      DEFAULT_SEARCHER_EXECUTOR,
    );
    const simulator = new BotVMSimulator(
      validationState,
      DEFAULT_SEARCHER_EXECUTOR,
      DEFAULT_SEARCHER_OWNER,
    );
    let solverReached = false;
    const validationFailures: string[] = [];
    for (const selected of relevant) {
      try {
        const evidenceFamilyIds = pendingExecutionEvidenceFamilyIds(
          selected.opportunity.seedEdges,
          STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes(),
        );
        const executionEvidence = selectFrozenRouteExecutionEvidence(
          frozenPendingExecutionEvidence,
          evidenceFamilyIds,
        );
        const selectedRouteSha256 = huntRouteSha256(
          selected.opportunity.seedEdges,
        );
        if (
          !report.producerOutput.naturalRouteSet?.routeSha256s.includes(
            selectedRouteSha256,
          )
        ) {
          throw new Error(
            "selected route is absent from the frozen natural route set",
          );
        }
        const routeEdges = selected.opportunity.seedEdges.map((edge, index) =>
          findExactEdge(fullGraph, edge, index));
        const opportunity = reconstructedOpportunity(
          selected.opportunity,
          routeEdges,
          anchorBlock,
        );
        const planner = new TemplatePlanner();
        planner.setGraph(routeEdges);
        const plans = await planner.planBlockScanFromSeedEdges(opportunity, [FLASH_SWAP_REPAY]);
        if (plans.length === 0) {
          throw new Error("production planner could not reconstruct enumerated route");
        }
        // Pancake V3 and other UniV3-compatible factories share pool execution
        // semantics but not necessarily Uniswap's QuoterV2. Warm the pool and
        // use the production local-math path, keyed by the actual fork state.
        const cache = new PoolStateCache(provider);
        cache.setTickBlock(anchorBlock);
        const solved = await new AnvilSolver().solve(plans[0], validationState, simulator, {
          deadlineMs: effectivePassBudgetMs,
          finalSimTopN: 3,
          gssMaxTries: 8,
          quoteProfitFloorBps: validationPolicy.quoteProfitFloorBps,
          quoteSafetyBps: validationPolicy.quoteSafetyBps,
          cache,
          runtimeEvidence: Object.freeze([]),
        });
        solverReached = true;
        report.stages.solver = "pass";
        const finalVerifyAllowed = shouldRunFinalVerify(
          solved.netProfit,
          solved.flashAmount,
          validationPolicy.finalVerifyFloorBps,
        );
        report.terminalGates.finalVerifyAdmission = {
          allowed: finalVerifyAllowed,
          quoteProfit: solved.netProfit.toString(),
          flashAmount: solved.flashAmount.toString(),
          floorBps: validationPolicy.finalVerifyFloorBps.toString(),
        };
        if (!finalVerifyAllowed) {
          throw new Error(
            `below_final_verify_floor: quoteProfit=${solved.netProfit} ` +
              `floorBps=${validationPolicy.finalVerifyFloorBps}`,
          );
        }
        const propagated = await propagateAmountsWithRawOutputs(
          plans[0].tokenPath,
          solved.flashAmount,
          validationState,
          {
            executor: DEFAULT_SEARCHER_EXECUTOR,
            safetyBps: validationPolicy.quoteSafetyBps,
            cache,
          },
        );
        const sim = await simulator.simulate(solved);
        if (!sim.success) {
          report.stages.finalSim = "fail";
          throw new Error(sim.revertReason ?? "resolved plan final verify reverted");
        }
        if (sim.netProfit <= 0n) {
          report.stages.finalSim = "fail";
          throw new Error(`non-positive final profit ${sim.netProfit}`);
        }
        report.stages.finalSim = "pass";
        const phantomAllowed = solved.flashAmount <= 0n ||
          sim.netProfit * 10_000n <=
            solved.flashAmount * validationPolicy.maxProfitBpsOfFlash;
        report.terminalGates.phantomProfit = {
          allowed: phantomAllowed,
          netProfit: sim.netProfit.toString(),
          flashAmount: solved.flashAmount.toString(),
          maxProfitBpsOfFlash: validationPolicy.maxProfitBpsOfFlash.toString(),
        };
        if (!phantomAllowed) {
          throw new Error(
            `phantom_profit: ${sim.netProfit} > ` +
              `${validationPolicy.maxProfitBpsOfFlash}bps of flash ${solved.flashAmount}`,
          );
        }
        let conservation: NonNullable<
          ReplayReport["terminalGates"]["repaymentAndConservation"]
        >;
        try {
          conservation = await proveReplayConservation(
            validationState,
            solved,
            routeEdges,
            sim.calldata,
            sim.grossProfit,
          );
        } catch (error) {
          report.stages.finalSim = "fail";
          throw error;
        }
        report.terminalGates.repaymentAndConservation = conservation;
        const ev = await evaluateEv(
          // A sender-prefix reconstruction has a synthetic block-N header.
          // Economics for target N+1 must use the canonical block-N header and
          // oracle state, never the synthetic Anvil gasUsed/hash.
          cfg.triggerTx ? provider : validationState.provider,
          sim.profitToken,
          sim.netProfit,
          sim.gasUsed,
          validationPolicy.ev,
          createProfitTokenValuation(),
          anchorBlock,
        );
        const evTargetBlock = anchorBlock + 1;
        const targetHeader = await provider.getBlock(evTargetBlock);
        if (
          ev.feeStateAvailable &&
          targetHeader?.baseFeePerGas !== ev.maxBaseFeePerGas
        ) {
          throw new Error(
            `EV fee anchor mismatch parent=${anchorBlock} target=${evTargetBlock} ` +
            `predicted=${ev.maxBaseFeePerGas} actual=${targetHeader?.baseFeePerGas ?? "missing"}`,
          );
        }
        report.executionEvidence = pendingExecutionEvidenceReport(
          frozenPendingExecutionEvidence,
          evidenceFamilyIds,
          pendingEvidenceArtifactSha256,
        );
        report.selected = {
          rank: selected.opportunity.rank,
          route: selected.opportunity.seedEdges,
          routeSha256: selectedRouteSha256,
          solverAmount: solved.flashAmount.toString(),
          hopAmounts: routeEdges.map((_edge, index) => ({
            amountIn: propagated.amounts[index].toString(),
            amountOut: propagated.amounts[index + 1].toString(),
            rawAmountOut: propagated.rawOutputs[index].toString(),
          })),
          profitToken: sim.profitToken.toLowerCase(),
          grossProfit: sim.grossProfit.toString(),
          netProfit: sim.netProfit.toString(),
          gasUsed: sim.gasUsed.toString(),
          calldataHash: createHash("sha256").update(sim.calldata).digest("hex"),
          resolvedPlanSha256: createHash("sha256")
            .update(compilePlan(solved.root, DEFAULT_SEARCHER_EXECUTOR))
            .digest("hex"),
          repaymentAndConservation: true,
          leavesStandingPosition: pathLeavesStandingPosition(routeEdges),
          ev: {
            valuationAvailable: ev.valuationAvailable,
            gasMeasurementAvailable: ev.gasMeasurementAvailable,
            feeStateAvailable: ev.feeStateAvailable,
            sourceBlockHash: ev.sourceBlockHash,
            decisionParentBlock: anchorBlock,
            targetBlock: evTargetBlock,
            ethUsd: ev.ethUsd,
            ethUsdRoundId: ev.ethUsdRoundId?.toString() ?? null,
            ethUsdUpdatedAt: ev.ethUsdUpdatedAt?.toString() ?? null,
            rawProfitEth: ev.rawProfitEth.toString(),
            netEvWei: ev.netEvWei.toString(),
            expectedProfitEth: ev.expectedProfitEth.toString(),
            gasUnits: ev.gasUnits.toString(),
            maxBaseFeePerGas: ev.maxBaseFeePerGas.toString(),
            gasCostEth: ev.gasCostEth.toString(),
            bidEth: ev.bidEth.toString(),
          },
        };
        if (!ev.valuationAvailable) {
          report.stages.ev = "reject";
          throw new Error(`unpriceable_profit_token: ${sim.profitToken}`);
        }
        if (!ev.gasMeasurementAvailable) {
          report.stages.ev = "reject";
          throw new Error("missing_gas_estimate");
        }
        if (!ev.feeStateAvailable) {
          report.stages.ev = "reject";
          throw new Error(`missing_fee_state: block=${anchorBlock}`);
        }
        const standingGuard = evaluateStandingGuard(
          plans[0].tokenPath.edges,
          validationPolicy.standingMarkerPath,
        );
        report.terminalGates.standingGuard = {
          allowed: standingGuard.allowed,
          containsStandingPosition: standingGuard.containsStandingPosition,
          reason: standingGuard.reason ?? null,
          markerPath: validationPolicy.standingMarkerPath,
        };
        if (!standingGuard.allowed) {
          report.stages.ev = "reject";
          throw new Error(`standing_guard: ${standingGuard.reason}`);
        }
        if (ev.netEvWei <= validationPolicy.minNetEth) {
          report.stages.ev = "reject";
          throw new Error(
            `below_ev_gate: net=${ev.netEvWei} min=${validationPolicy.minNetEth}`,
          );
        }
        report.stages.ev = "allow";
        finish(report, cfg.outPath);
        return;
      } catch (error) {
        validationFailures.push(`rank ${selected.opportunity.rank}: ${safeError(error)}`);
      }
    }
    report.stages.solver = solverReached ? "pass" : "fail";
    if (!solverReached) report.stages.finalSim = "not_reached";
    report.failure =
      `winner-bound routes failed production validation: ${validationFailures.slice(0, 5).join("; ")}`;
    finish(report, cfg.outPath);
  } catch (error) {
    if (report) {
      report.failure = safeError(error);
      finish(report, cfg.outPath);
      return;
    }
    throw error;
  } finally {
    validationState?.stop();
    anchorState?.stop();
    provider.destroy();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function produceTargetBlind(
  cfg: TargetBlindProduceConfig,
): Promise<void> {
  const rpcUrl =
    process.env.SEARCHER_LIVE_RPC_URL ?? process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("target-blind producer requires RPC");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  try {
    const header = await provider.getBlock(cfg.baseBlock);
    if (
      !header?.hash ||
      !header.stateRoot ||
      header.hash.toLowerCase() !== cfg.baseBlockHash ||
      header.stateRoot.toLowerCase() !== cfg.baseStateRoot
    ) {
      throw new Error("target-blind base header differs from frozen input");
    }
    mkdirSync(cfg.workspacePath, { recursive: true, mode: 0o700 });
    const frozenUniverse = freezeUniverseInput(
      cfg.universePath,
      cfg.workspacePath,
      cfg.maxPools,
      0,
    );
    if (
      frozenUniverse.evidence.fromBlock !== cfg.sourceFromBlock ||
      frozenUniverse.evidence.toBlock !== cfg.baseBlock
    ) {
      throw new Error("target-blind universe range differs from frozen input");
    }
    const huntOut = resolve(cfg.workspacePath, "hunt.json");
    const explicitInputBindings =
      targetBlindExplicitInputBindings(frozenUniverse.evidence.sha256);
    await runTargetBlindHunt({
      rpcUrl,
      cfg,
      huntOut,
      universeSnapshotPath: frozenUniverse.snapshotPath,
    });
    if (
      stableJsonValue(explicitInputBindings) !==
        stableJsonValue(
          targetBlindExplicitInputBindings(frozenUniverse.evidence.sha256),
        )
    ) {
      throw new Error(
        "target-blind explicit input changed during producer execution",
      );
    }
    const frozenHunt = readFrozenHuntReport(huntOut);
    const hunt = frozenHunt.report;
    if (
      hunt.stateBlock !== cfg.baseBlock ||
      hunt.opportunities.length > cfg.maxCandidates ||
      !hunt.scanCompleteness ||
      !hunt.materializedGraph ||
      !hunt.familySourceCoverage
    ) {
      throw new Error("target-blind hunt output is incomplete");
    }
    assertTargetBlindScanCompleteness(hunt.scanCompleteness);
    const expectedPassBudget = productionPassBudgetMs(
      cfg,
      hunt.edges,
    );
    if (hunt.effectivePassBudgetMs !== expectedPassBudget) {
      throw new Error("target-blind hunt used a non-production pass budget");
    }
    const solveByIndex = new Map(
      hunt.solved.map((solve) => [solve.opportunityIndex, solve]),
    );
    const naturalTopK = hunt.opportunities
      .map((opportunity, opportunityIndex) => ({
        opportunity,
        opportunityIndex,
      }))
      .filter(({ opportunity }) => opportunity.rank <= cfg.topK)
      .map(({ opportunity, opportunityIndex }) => {
        const route = opportunity.seedEdges.map(normalizeReplayEdge);
        const routeSha256 = semanticJsonSha256(
          route as unknown as SemanticJson,
        );
        const solve = solveByIndex.get(opportunityIndex);
        const frozenResult = solve?.frozenResult ?? null;
        if (frozenResult) {
          assertFrozenResult(frozenResult, routeSha256, route);
        }
        return {
          opportunityIndex,
          rank: opportunity.rank,
          route,
          routeSha256,
          hopAmounts: solve?.diagnosticHopAmounts ?? null,
          frozenResult,
        };
      });
    const validationPolicy = readValidationPolicy(cfg);
    const artifact: TargetBlindProducerArtifact = {
      schemaVersion: 1,
      artifact: "explicit-input-target-late-production-replay",
      stateAnchor: {
        kind: "parent-block",
        blockNumber: cfg.baseBlock,
        blockHash: cfg.baseBlockHash,
        stateRoot: cfg.baseStateRoot,
      },
      sourceFromBlock: cfg.sourceFromBlock,
      universe: frozenUniverse.evidence,
      actualRunnerConfig:
        targetBlindRunnerConfigEvidence(cfg, hunt.edges),
      validationPolicy: serializeValidationPolicy(validationPolicy),
      explicitInputBindings,
      producerOutput: {
        materializedGraph: hunt.materializedGraph,
        fullGraph: {
          edgeCount: hunt.edges,
          sha256: hunt.edgeSetSha256,
        },
        naturalRouteSet: naturalRouteSetEvidence(hunt.opportunities),
        frozenHuntArtifact: frozenHunt.artifact,
        scanCompleteness: hunt.scanCompleteness,
      },
      familySourceCoverage: hunt.familySourceCoverage,
      naturalTopK,
    };
    writeFileSync(
      cfg.outPath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      { mode: 0o600 },
    );
  } finally {
    provider.destroy();
  }
}

async function verifyTargetBlind(
  cfg: TargetBlindVerifyConfig,
): Promise<void> {
  const rpcUrl =
    process.env.SEARCHER_LIVE_RPC_URL ?? process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("target-aware verifier requires RPC");
  const producer = readHashedJson<TargetBlindProducerArtifact>(
    cfg.producerArtifactPath,
    cfg.producerArtifactSha256,
  );
  assertProducerArtifact(producer);
  const trustedPolicy = readValidationPolicy({
    maxHops: producer.actualRunnerConfig.maxHops,
  });
  if (
    stableJsonValue(serializeValidationPolicy(trustedPolicy)) !==
      stableJsonValue(producer.validationPolicy)
  ) {
    throw new Error(
      "candidate producer validation policy differs from trusted verifier",
    );
  }
  const reference = readHashedJson<TrustedReferenceRoute>(
    cfg.trustedReferencePath,
    cfg.trustedReferenceSha256,
  );
  assertTrustedReference(reference, cfg.winnerTx);
  if (
    reference.stateAnchor.baseBlock !== producer.stateAnchor.blockNumber ||
    reference.stateAnchor.baseBlockHash !== producer.stateAnchor.blockHash ||
    reference.stateAnchor.baseStateRoot !== producer.stateAnchor.stateRoot
  ) {
    throw new Error("trusted reference and frozen producer anchor differ");
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  let state: AnvilStateBackend | null = null;
  let report = targetBlindReport(
    producer,
    cfg,
    reference,
  );
  try {
    const [receipt, callTrace, opportunityHeader] = await Promise.all([
      provider.send("eth_getTransactionReceipt", [cfg.winnerTx]),
      provider.send("debug_traceTransaction", [
        cfg.winnerTx,
        { tracer: "callTracer", timeout: "60s" },
      ]),
      provider.send("eth_getBlockByNumber", [
        ethers.toQuantity(reference.stateAnchor.opportunityBlock),
        false,
      ]),
    ]);
    assertCanonicalTargetReceipt(
      receipt,
      opportunityHeader,
      reference.stateAnchor.opportunityBlock,
      reference.stateAnchor.baseBlockHash,
    );
    if (
      trustedTargetInputSha256({
        txHash: cfg.winnerTx,
        receipt,
        callTrace,
      }) !== reference.targetInputSha256
    ) {
      throw new Error("trusted reference does not bind canonical target input");
    }
    report.reference.targetInputVerified = true;
    const relevant = producer.naturalTopK.filter((entry) =>
      sameOrderedCycle(entry.route, reference.route)
    );
    report.reference.referenceEdgeMatched = relevant.length > 0;
    report.reference.cycleCandidates = relevant.length;
    report.reference.exactCycleMatched = relevant.length === 1;
    if (relevant.length !== 1) {
      report.failure =
        `trusted route matched ${relevant.length} frozen natural top-K routes`;
      finish(report, cfg.outPath);
      return;
    }
    const selected = relevant[0];
    if (
      !selected.frozenResult ||
      !selected.hopAmounts ||
      selected.hopAmounts.length !== selected.route.length
    ) {
      report.stages.enumeration = "pass";
      report.failure =
        "trusted route was enumerated but not naturally solved/refined";
      finish(report, cfg.outPath);
      return;
    }
    const frozen = selected.frozenResult;
    assertFrozenResult(frozen, selected.routeSha256, selected.route);
    assertRouteReferenceWitnesses({
      trace: callTrace,
      receipt,
      reference,
      executionSurfaces: frozen.executionSurfaces,
      supportExecutionCalls: frozen.supportExecutionCalls,
      label: "canonical target",
      requireResolvedCallBytes: false,
    });
    assertClosedProfitToken(selected.route, frozen.profitToken);
    const routeStanding = pathLeavesStandingPosition(selected.route);
    if (frozen.leavesStandingPosition !== routeStanding) {
      throw new Error("frozen standing-position bit differs from trusted route");
    }
    if (
      !frozen.shardCompleteness.requiredComplete ||
      frozen.requiredFamilyIds.length === 0
    ) {
      throw new Error("selected route lacks complete required family shards");
    }
    report.discovery.shardCompleteness = frozen.shardCompleteness;
    report.discovery.completeFamilyIds =
      frozen.shardCompleteness.familyShards
        .filter((shard) => shard.status === "complete")
        .map((shard) => shard.familyId);
    report.stages.sourceAndIdentity = "pass";
    report.stages.graphProjection = "pass";
    report.stages.enumeration = "pass";
    report.stages.solver = "pass";
    state = new AnvilStateBackend(
      rpcUrl,
      `http://127.0.0.1:${cfg.anvilPort}`,
      cfg.anvilPort,
    );
    await state.forkAt(producer.stateAnchor.blockNumber);
    await installForkBotVm(
      state.provider,
      DEFAULT_SEARCHER_OWNER,
      DEFAULT_SEARCHER_EXECUTOR,
    );
    const sim = await simulateFrozenCalldata(
      state,
      frozen.rawCalldata,
      frozen.profitToken,
      resolveFrozenFundingHolder(frozen.fundingActionId),
      BigInt(frozen.flashAmount),
    );
    if (!sim.success || sim.netProfit <= 0n) {
      throw new Error(sim.revertReason ?? "frozen raw calldata reverted");
    }
    report.stages.finalSim = "pass";
    const conservation = await conserveFrozenCalldata({
      state,
      frozen,
      routeTokens: [
        ...selected.route.flatMap(
          (edge) => [edge.tokenIn, edge.tokenOut],
        ),
        ...sim.executorTransferTokens,
      ],
      expectedGrossProfit: sim.grossProfit,
      expectedGasUsed: sim.gasUsed,
    });
    assertRouteReferenceWitnesses({
      trace: conservation.callTrace,
      receipt: conservation.receipt,
      reference,
      executionSurfaces: frozen.executionSurfaces,
      supportExecutionCalls: frozen.supportExecutionCalls,
      label: "frozen final sim",
      requireResolvedCallBytes: true,
    });
    const policy = trustedPolicy;
    const finalVerifyAllowed = shouldRunFinalVerify(
      BigInt(frozen.quotedNetProfit),
      BigInt(frozen.flashAmount),
      policy.finalVerifyFloorBps,
    );
    report.terminalGates.finalVerifyAdmission = {
      allowed: finalVerifyAllowed,
      quoteProfit: frozen.quotedNetProfit,
      flashAmount: frozen.flashAmount,
      floorBps: policy.finalVerifyFloorBps.toString(),
    };
    if (!finalVerifyAllowed) {
      throw new Error("frozen result failed final-verify admission policy");
    }
    const phantomAllowed =
      sim.netProfit * 10_000n <=
        BigInt(frozen.flashAmount) * policy.maxProfitBpsOfFlash;
    report.terminalGates.phantomProfit = {
      allowed: phantomAllowed,
      netProfit: sim.netProfit.toString(),
      flashAmount: frozen.flashAmount,
      maxProfitBpsOfFlash: policy.maxProfitBpsOfFlash.toString(),
    };
    if (!phantomAllowed) {
      throw new Error("frozen result failed phantom-profit policy");
    }
    const standing = evaluateStandingGuard(
      selected.route,
      policy.standingMarkerPath,
    );
    report.terminalGates.standingGuard = {
      allowed: standing.allowed,
      containsStandingPosition: standing.containsStandingPosition,
      reason: standing.reason ?? null,
      markerPath: policy.standingMarkerPath,
    };
    if (!standing.allowed || standing.containsStandingPosition) {
      throw new Error(
        standing.reason ?? "frozen result leaves a standing position",
      );
    }
    const ev = await evaluateEv(
      provider,
      sim.profitToken,
      sim.netProfit,
      sim.gasUsed,
      policy.ev,
      createProfitTokenValuation(),
      producer.stateAnchor.blockNumber,
    );
    if (
      !ev.valuationAvailable ||
      !ev.gasMeasurementAvailable ||
      !ev.feeStateAvailable ||
      ev.netEvWei <= policy.minNetEth
    ) {
      throw new Error("frozen raw calldata failed production EV");
    }
    report.stages.ev = "allow";
    report.terminalGates = {
      ...report.terminalGates,
      repaymentAndConservation: { allowed: true },
    };
    report.selected = {
      rank: selected.rank,
      route: selected.route,
      routeSha256: selected.routeSha256,
      solverAmount: frozen.flashAmount,
      hopAmounts: selected.hopAmounts,
      profitToken: sim.profitToken,
      grossProfit: sim.grossProfit.toString(),
      netProfit: sim.netProfit.toString(),
      gasUsed: sim.gasUsed.toString(),
      calldataHash: frozen.calldataSha256,
      resolvedPlanSha256: frozen.resolvedPlanSha256,
      fundingActionId: frozen.fundingActionId,
      executionSurfaces: frozen.executionSurfaces,
      supportActionAdapterIds: frozen.supportActionAdapterIds,
      supportExecutionCalls: frozen.supportExecutionCalls,
      repaymentAndConservation: true,
      leavesStandingPosition: false,
      ev: {
        valuationAvailable: ev.valuationAvailable,
        gasMeasurementAvailable: ev.gasMeasurementAvailable,
        feeStateAvailable: ev.feeStateAvailable,
        sourceBlockHash: ev.sourceBlockHash,
        decisionParentBlock: producer.stateAnchor.blockNumber,
        targetBlock: producer.stateAnchor.blockNumber + 1,
        ethUsd: ev.ethUsd,
        ethUsdRoundId: ev.ethUsdRoundId?.toString() ?? null,
        ethUsdUpdatedAt: ev.ethUsdUpdatedAt?.toString() ?? null,
        rawProfitEth: ev.rawProfitEth.toString(),
        netEvWei: ev.netEvWei.toString(),
        expectedProfitEth: ev.expectedProfitEth.toString(),
        gasUnits: ev.gasUnits.toString(),
        maxBaseFeePerGas: ev.maxBaseFeePerGas.toString(),
        gasCostEth: ev.gasCostEth.toString(),
        bidEth: ev.bidEth.toString(),
      },
    };
    report.failure = null;
    finish(report, cfg.outPath);
  } catch (error) {
    report.failure = safeError(error);
    finish(report, cfg.outPath);
  } finally {
    state?.stop();
    provider.destroy();
  }
}

function parseTargetBlindArgs(args: readonly string[]): TargetBlindConfig {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        `invalid target-blind replay option near ${name ?? "<end>"}`,
      );
    }
    if (values.has(name)) throw new Error(`${name} may appear only once`);
    values.set(name, value);
  }
  const phase = required(values, "--phase");
  if (phase !== "produce" && phase !== "verify") {
    throw new Error("--phase must be produce or verify");
  }
  const common = new Set(["--phase", "--anvil-port", "--out"]);
  const produce = new Set([
    ...common,
    "--base-block",
    "--base-block-hash",
    "--base-state-root",
    "--source-from-block",
    "--universe",
    "--workspace",
    "--max-pools",
    "--max-hops",
    "--max-candidates",
    "--top-k",
    "--min-spread-bps",
    "--prewarm-budget-ms",
    "--scan-budget-ms",
    "--pass-budget-ms",
    "--large-graph-pass-budget-ms",
    "--large-graph-edge-threshold",
    "--refine-candidates",
    "--refine-family-timeout-ms",
  ]);
  const verify = new Set([
    ...common,
    "--winner-tx",
    "--producer-artifact",
    "--producer-artifact-sha256",
    "--trusted-reference",
    "--trusted-reference-sha256",
  ]);
  const allowed = phase === "produce" ? produce : verify;
  const unknown = [...values.keys()].filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `unknown target-blind replay option(s): ${unknown.join(",")}`,
    );
  }
  const outPath = resolve(required(values, "--out"));
  const anvilPort = positiveInt(
    required(values, "--anvil-port"),
    "--anvil-port",
  );
  if (phase === "verify") {
    const producerArtifactSha256 = required(
      values,
      "--producer-artifact-sha256",
    ).toLowerCase();
    const trustedReferenceSha256 = required(
      values,
      "--trusted-reference-sha256",
    ).toLowerCase();
    if (
      !/^[0-9a-f]{64}$/.test(producerArtifactSha256) ||
      !/^[0-9a-f]{64}$/.test(trustedReferenceSha256)
    ) {
      throw new Error("target-blind artifact hashes must be SHA-256");
    }
    return {
      phase,
      winnerTx: txHash(
        required(values, "--winner-tx"),
        "--winner-tx",
      ),
      producerArtifactPath: resolve(
        required(values, "--producer-artifact"),
      ),
      producerArtifactSha256,
      trustedReferencePath: resolve(
        required(values, "--trusted-reference"),
      ),
      trustedReferenceSha256,
      anvilPort,
      outPath,
    };
  }
  const configured = (
    name: string,
    fallback: number,
    allowZero = false,
  ): number => (allowZero ? nonNegativeInt : positiveInt)(
    values.get(name) ?? String(fallback),
    name,
  );
  const maxCandidates = configured("--max-candidates", 100);
  const topK = configured("--top-k", maxCandidates);
  if (topK > maxCandidates) {
    throw new Error("--top-k cannot exceed --max-candidates");
  }
  const passBudgetMs = configured("--pass-budget-ms", 11_000);
  return {
    phase,
    baseBlock: positiveInt(
      required(values, "--base-block"),
      "--base-block",
    ),
    baseBlockHash: hash32(
      required(values, "--base-block-hash"),
      "--base-block-hash",
    ),
    baseStateRoot: hash32(
      required(values, "--base-state-root"),
      "--base-state-root",
    ),
    sourceFromBlock: nonNegativeInt(
      required(values, "--source-from-block"),
      "--source-from-block",
    ),
    universePath: resolve(required(values, "--universe")),
    anvilPort,
    workspacePath: resolve(required(values, "--workspace")),
    maxPools: configured("--max-pools", 20_000),
    maxHops: configured("--max-hops", 4),
    maxCandidates,
    topK,
    minSpreadBps: configured("--min-spread-bps", 10, true),
    prewarmBudgetMs: configured("--prewarm-budget-ms", 120_000),
    scanBudgetMs: configured("--scan-budget-ms", 1_500),
    passBudgetMs,
    largeGraphPassBudgetMs: Math.max(
      passBudgetMs,
      configured("--large-graph-pass-budget-ms", 30_000),
    ),
    largeGraphEdgeThreshold: configured(
      "--large-graph-edge-threshold",
      20_000,
    ),
    refineCandidates: Math.max(
      maxCandidates,
      configured("--refine-candidates", 512),
    ),
    refineFamilyTimeoutMs: configured(
      "--refine-family-timeout-ms",
      1_000,
    ),
    outPath,
  };
}

async function runTargetBlindHunt(input: {
  rpcUrl: string;
  cfg: TargetBlindProduceConfig;
  huntOut: string;
  universeSnapshotPath: string;
}): Promise<void> {
  const cfg = input.cfg;
  const env = targetBlindHuntEnvironment(process.env, {
    SEARCHER_LIVE_RPC_URL: input.rpcUrl,
    MAINNET_RPC_URL: input.rpcUrl,
    SEARCHER_TEST_DISABLE_DOTENV: "1",
    SEARCHER_TARGET_BLIND_EVIDENCE: "1",
    SEARCHER_DRY_RUN: "1",
    SEARCHER_EV_GATE: "1",
    SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT: String(cfg.anvilPort),
    HUNT_BLOCK: String(cfg.baseBlock),
    HUNT_UNIVERSE_PATH: input.universeSnapshotPath,
    HUNT_MAX_POOLS: String(cfg.maxPools),
    HUNT_MAX_HOPS: String(cfg.maxHops),
    HUNT_MIN_SPREAD_BPS: String(cfg.minSpreadBps),
    HUNT_PREWARM_BUDGET_MS: String(cfg.prewarmBudgetMs),
    HUNT_SCAN_BUDGET_MS: String(cfg.scanBudgetMs),
    HUNT_PASS_BUDGET_MS: String(cfg.passBudgetMs),
    HUNT_LARGE_GRAPH_PASS_BUDGET_MS:
      String(cfg.largeGraphPassBudgetMs),
    HUNT_LARGE_GRAPH_EDGE_THRESHOLD:
      String(cfg.largeGraphEdgeThreshold),
    HUNT_MAX_CANDIDATES: String(cfg.maxCandidates),
    HUNT_REFINE_CANDIDATES: String(cfg.refineCandidates),
    HUNT_REFINE_FAMILY_TIMEOUT_MS:
      String(cfg.refineFamilyTimeoutMs),
    HUNT_TOP_K: String(cfg.topK),
    HUNT_OUT: input.huntOut,
  });
  const args = ["--import", TSX_IMPORT_URL, HUNT_PATH];
  const audit = auditReplayInputs(args, env);
  if (
    audit.explicitRouteInputs.length > 0 ||
    audit.explicitAmountInputs.length > 0
  ) {
    throw new Error("target-blind hunt received a route/amount oracle");
  }
  const childCwd = resolve(cfg.workspacePath, "isolated-hunt-cwd");
  mkdirSync(childCwd, { recursive: true, mode: 0o700 });
  await spawnChecked(
    process.execPath,
    args,
    childCwd,
    env,
    "target-blind blockscan-hunt",
  );
}

const TARGET_BLIND_SEARCHER_ENV_ALLOWLIST = new Set([
  "SEARCHER_BLOCKSCAN_STATE_MULTICALL",
  "SEARCHER_BRIBE_ALL_ABOVE_GAS",
  "SEARCHER_BRIBE_BPS",
  "SEARCHER_CREDIT_LIVE_MARKER_PATH",
  "SEARCHER_MAX_PROFIT_BPS_OF_FLASH",
  "SEARCHER_MIN_NET_ETH",
  "SEARCHER_PROFIT_HAIRCUT_BPS",
  "SEARCHER_PROTOCOL_DISCOVERY_ARCHIVE_RPC_URL",
  "SEARCHER_PROTOCOL_DISCOVERY_RPC_TIMEOUT_MS",
  "SEARCHER_QUOTE_PROFIT_FLOOR_BPS",
  "SEARCHER_QUOTE_SAFETY_BPS",
  "SEARCHER_FINAL_VERIFY_FLOOR_BPS",
]);

export function targetBlindHuntEnvironment(
  inherited: Readonly<NodeJS.ProcessEnv>,
  explicit: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
  ]) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  const controllerAllowed = new Set(
    (inherited.PRODUCTION_REPLAY_ALLOWED_SEARCHER_CONFIG_KEYS ?? "")
      .split(",")
      .filter((key) => /^SEARCHER_[A-Z0-9_]+$/.test(key)),
  );
  for (const key of new Set([
    ...TARGET_BLIND_SEARCHER_ENV_ALLOWLIST,
    ...controllerAllowed,
  ])) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  Object.assign(env, explicit);
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper.includes("EXPECTED") ||
      upper.includes("TARGET") && key !== "SEARCHER_TARGET_BLIND_EVIDENCE" ||
      upper.startsWith("AB_")
    ) {
      delete env[key];
    }
  }
  return env;
}

async function spawnChecked(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const consume = (chunk: Buffer, stream: NodeJS.WriteStream): void => {
      const text = chunk.toString("utf8");
      stream.write(text);
      tail = `${tail}${text}`.slice(-8_000);
    };
    child.stdout.on(
      "data",
      (chunk: Buffer) => consume(chunk, process.stdout),
    );
    child.stderr.on(
      "data",
      (chunk: Buffer) => consume(chunk, process.stderr),
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) done();
      else {
        reject(new Error(
          `${label} exited code=${code} signal=${signal ?? "none"}: ${tail}`,
        ));
      }
    });
  });
}

export function normalizeReplayEdge(edge: HuntEdge): HuntEdge {
  if (
    typeof edge.adapterId !== "string" ||
    edge.adapterId.length === 0 ||
    (edge.slotKind !== "swap" && edge.slotKind !== "protocol") ||
    typeof edge.edgeKind !== "string" ||
    typeof edge.leavesStandingPosition !== "boolean"
  ) {
    throw new Error("target-blind route edge is malformed");
  }
  return {
    adapterId: edge.adapterId,
    target: ethers.getAddress(edge.target).toLowerCase(),
    tokenIn: ethers.getAddress(edge.tokenIn).toLowerCase(),
    tokenOut: ethers.getAddress(edge.tokenOut).toLowerCase(),
    slotKind: edge.slotKind,
    edgeKind: edge.edgeKind,
    leavesStandingPosition: edge.leavesStandingPosition,
    ...(edge.poolId === undefined
      ? {}
      : { poolId: edge.poolId.toLowerCase() }),
  };
}

export function assertFrozenResult(
  frozen: NonNullable<HuntSolve["frozenResult"]>,
  routeSha256: string,
  route?: readonly HuntEdge[],
): void {
  const value = frozen as unknown as Record<string, unknown>;
  const fields = [
    "schemaVersion",
    "executor",
    "routeSha256",
    "flashAmount",
    "quotedNetProfit",
    "profitToken",
    "rawCalldata",
    "calldataSha256",
    "resolvedPlanSha256",
    "fundingActionId",
    "executionSurfaces",
    "supportActionAdapterIds",
    "supportExecutionCalls",
    "leavesStandingPosition",
    "requiredFamilyIds",
    "shardCompleteness",
    "bindingSha256",
  ];
  if (
    stableObjectKeys(value) !== stableObjectKeys(
      Object.fromEntries(fields.map((field) => [field, true])),
    ) ||
    frozen.schemaVersion !== 2 ||
    frozen.routeSha256 !== routeSha256 ||
    frozen.executor !== DEFAULT_SEARCHER_EXECUTOR.toLowerCase() ||
    !ethers.isAddress(frozen.profitToken) ||
    frozen.profitToken !== frozen.profitToken.toLowerCase() ||
    !ethers.isHexString(frozen.rawCalldata) ||
    ethers.dataLength(frozen.rawCalldata) < 4 ||
    frozen.rawCalldata !== frozen.rawCalldata.toLowerCase() ||
    !/^[0-9a-f]{64}$/.test(frozen.calldataSha256) ||
    createHash("sha256")
      .update(frozen.rawCalldata)
      .digest("hex") !== frozen.calldataSha256 ||
    !/^[0-9a-f]{64}$/.test(frozen.resolvedPlanSha256) ||
    resolvedPlanScriptSha256(frozen.rawCalldata) !==
      frozen.resolvedPlanSha256 ||
    typeof frozen.fundingActionId !== "string" ||
    frozen.fundingActionId.length === 0 ||
    typeof frozen.leavesStandingPosition !== "boolean" ||
    !positiveDecimal(frozen.flashAmount) ||
    !positiveDecimal(frozen.quotedNetProfit) ||
    !exactSortedStrings(frozen.requiredFamilyIds) ||
    frozen.requiredFamilyIds.length === 0 ||
    !Array.isArray(frozen.executionSurfaces) ||
    !Array.isArray(frozen.supportActionAdapterIds) ||
    !Array.isArray(frozen.supportExecutionCalls) ||
    frozen.supportActionAdapterIds.some(
      (id) => typeof id !== "string" || id.length === 0,
    ) ||
    (route !== undefined && frozen.executionSurfaces.length !== route.length)
  ) {
    throw new Error("target-blind frozen result is malformed");
  }
  for (let index = 0; index < frozen.executionSurfaces.length; index++) {
    const surface = frozen.executionSurfaces[index];
    const edge = route?.[index];
    if (
      stableObjectKeys(surface as unknown as Record<string, unknown>) !==
        stableObjectKeys({
          adapterId: true,
          familyId: true,
          rootActionAdapterId: true,
          target: true,
          selector: true,
          calldataSha256: true,
          subtreeActionAdapterIds: true,
          actionCalls: true,
        }) ||
      typeof surface.adapterId !== "string" ||
      typeof surface.familyId !== "string" ||
      surface.familyId.length === 0 ||
      typeof surface.rootActionAdapterId !== "string" ||
      surface.rootActionAdapterId.length === 0 ||
      !ethers.isAddress(surface.target) ||
      surface.target !== surface.target.toLowerCase() ||
      !/^0x[0-9a-f]{8}$/.test(surface.selector) ||
      !/^[0-9a-f]{64}$/.test(surface.calldataSha256) ||
      !Array.isArray(surface.subtreeActionAdapterIds) ||
      surface.subtreeActionAdapterIds.length === 0 ||
      surface.subtreeActionAdapterIds[0] !== surface.rootActionAdapterId ||
      surface.subtreeActionAdapterIds.some(
        (id) => typeof id !== "string" || id.length === 0,
      ) ||
      !Array.isArray(surface.actionCalls) ||
      surface.actionCalls.length === 0 ||
      (edge !== undefined &&
        surface.adapterId !== edge.adapterId)
    ) {
      throw new Error(
        `target-blind execution surface ${index} is malformed`,
      );
    }
    for (let callIndex = 0;
      callIndex < surface.actionCalls.length;
      callIndex++) {
      const call = surface.actionCalls[callIndex];
      if (
        stableObjectKeys(call as unknown as Record<string, unknown>) !==
          stableObjectKeys({
            actionAdapterId: true,
            target: true,
            selector: true,
            calldataSha256: true,
          }) ||
        typeof call.actionAdapterId !== "string" ||
        !surface.subtreeActionAdapterIds.includes(call.actionAdapterId) ||
        !ethers.isAddress(call.target) ||
        call.target !== call.target.toLowerCase() ||
        !/^0x[0-9a-f]{8}$/.test(call.selector) ||
        !/^[0-9a-f]{64}$/.test(call.calldataSha256) ||
        (
          callIndex === 0 &&
          (
            call.actionAdapterId !== surface.rootActionAdapterId ||
            call.target !== surface.target ||
            call.selector !== surface.selector ||
            call.calldataSha256 !== surface.calldataSha256
          )
        )
      ) {
        throw new Error(
          `target-blind execution action ${index}:${callIndex} is malformed`,
        );
      }
    }
  }
  for (let index = 0; index < frozen.supportExecutionCalls.length; index++) {
    const call = frozen.supportExecutionCalls[index];
    if (
      stableObjectKeys(call as unknown as Record<string, unknown>) !==
        stableObjectKeys({
          actionAdapterId: true,
          target: true,
          selector: true,
          calldataSha256: true,
        }) ||
      typeof call.actionAdapterId !== "string" ||
      !frozen.supportActionAdapterIds.includes(call.actionAdapterId) ||
      !ethers.isAddress(call.target) ||
      call.target !== call.target.toLowerCase() ||
      !/^0x[0-9a-f]{8}$/.test(call.selector) ||
      !/^[0-9a-f]{64}$/.test(call.calldataSha256)
    ) {
      throw new Error(
        `target-blind support execution call ${index} is malformed`,
      );
    }
  }
  const { bindingSha256, ...core } = frozen;
  if (
    !/^[0-9a-f]{64}$/.test(bindingSha256) ||
    semanticJsonSha256(core as unknown as SemanticJson) !== bindingSha256
  ) {
    throw new Error("target-blind frozen result binding is invalid");
  }
}

export function resolvedPlanScriptSha256(rawCalldata: string): string {
  if (
    !ethers.isHexString(rawCalldata) ||
    rawCalldata.length < 10 ||
    rawCalldata.slice(0, 10).toLowerCase() !==
      buildExecuteCalldata(new Uint8Array()).slice(0, 10).toLowerCase()
  ) {
    throw new Error("target-blind calldata is not BotVM execute(bytes)");
  }
  let script: string;
  try {
    [script] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bytes"],
      `0x${rawCalldata.slice(10)}`,
    ) as unknown as [string];
  } catch {
    throw new Error("target-blind BotVM script calldata is malformed");
  }
  const scriptBytes = ethers.getBytes(script);
  if (
    buildExecuteCalldata(scriptBytes).toLowerCase() !==
      rawCalldata.toLowerCase()
  ) {
    throw new Error("target-blind BotVM script calldata is non-canonical");
  }
  return createHash("sha256").update(scriptBytes).digest("hex");
}

function targetBlindRunnerConfigEvidence(
  cfg: TargetBlindProduceConfig,
  graphEdgeCount: number,
) {
  return {
    maxPools: cfg.maxPools,
    maxHops: cfg.maxHops,
    maxCandidates: cfg.maxCandidates,
    refineCandidates: cfg.refineCandidates,
    topK: cfg.topK,
    minSpreadBps: cfg.minSpreadBps,
    prewarmBudgetMs: cfg.prewarmBudgetMs,
    scanBudgetMs: cfg.scanBudgetMs,
    passBudgetMs: productionPassBudgetMs(cfg, graphEdgeCount),
    basePassBudgetMs: cfg.passBudgetMs,
    largeGraphPassBudgetMs: cfg.largeGraphPassBudgetMs,
    largeGraphEdgeThreshold: cfg.largeGraphEdgeThreshold,
    refineFamilyTimeoutMs: cfg.refineFamilyTimeoutMs,
  };
}

function serializeValidationPolicy(
  policy: ReplayValidationPolicy,
): ReplayReport["validationPolicy"] {
  return {
    quoteSafetyBps: policy.quoteSafetyBps.toString(),
    quoteProfitFloorBps: policy.quoteProfitFloorBps.toString(),
    finalVerifyFloorBps: policy.finalVerifyFloorBps.toString(),
    maxProfitBpsOfFlash: policy.maxProfitBpsOfFlash.toString(),
    standingMarkerPath: policy.standingMarkerPath,
    ev: { ...policy.ev, minNetEth: policy.minNetEth.toString() },
  };
}

function replayValidationPolicy(
  value: ReplayReport["validationPolicy"],
): ReplayValidationPolicy {
  const parse = (raw: string, field: string): bigint => {
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      throw new Error(`validation policy ${field} is invalid`);
    }
    return BigInt(raw);
  };
  if (
    !Number.isInteger(value.ev.profitHaircutBps) ||
    value.ev.profitHaircutBps < 0 ||
    value.ev.profitHaircutBps > 10_000 ||
    !Number.isInteger(value.ev.bribeBps) ||
    value.ev.bribeBps < 0 ||
    value.ev.bribeBps > 10_000 ||
    value.ev.evGate !== true ||
    typeof value.ev.bribeAllAboveGas !== "boolean" ||
    typeof value.standingMarkerPath !== "string"
  ) {
    throw new Error("target-blind validation policy is malformed");
  }
  return {
    quoteSafetyBps: parse(value.quoteSafetyBps, "quoteSafetyBps"),
    quoteProfitFloorBps: parse(
      value.quoteProfitFloorBps,
      "quoteProfitFloorBps",
    ),
    finalVerifyFloorBps: parse(
      value.finalVerifyFloorBps,
      "finalVerifyFloorBps",
    ),
    maxProfitBpsOfFlash: parse(
      value.maxProfitBpsOfFlash,
      "maxProfitBpsOfFlash",
    ),
    standingMarkerPath: value.standingMarkerPath,
    ev: {
      profitHaircutBps: value.ev.profitHaircutBps,
      evGate: true,
      bribeAllAboveGas: value.ev.bribeAllAboveGas,
      bribeBps: value.ev.bribeBps,
    },
    minNetEth: parse(value.ev.minNetEth, "minNetEth"),
  };
}

function readHashedJson<T>(path: string, expectedSha256: string): T {
  const bytes = readFileSync(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(`artifact hash mismatch: ${actual} != ${expectedSha256}`);
  }
  return JSON.parse(bytes.toString("utf8")) as T;
}

export function assertTargetBlindScanCompleteness(
  value: unknown,
): asserts value is TargetBlindScanCompleteness {
  if (
    !isPlainRecord(value) ||
    stableObjectKeys(value) !== stableObjectKeys({
      outcome: true,
      rankComplete: true,
      refinementDeadlineHit: true,
      evaluationComplete: true,
      enumeratedCount: true,
      selectedCount: true,
      forcedSelectionCount: true,
      scannedPairs: true,
    }) ||
    value.outcome !== "ran" ||
    value.rankComplete !== true ||
    value.refinementDeadlineHit !== false ||
    value.evaluationComplete !== true ||
    !Number.isSafeInteger(value.enumeratedCount) ||
    Number(value.enumeratedCount) < 0 ||
    !Number.isSafeInteger(value.selectedCount) ||
    Number(value.selectedCount) < 0 ||
    Number(value.selectedCount) > Number(value.enumeratedCount) ||
    value.forcedSelectionCount !== 0 ||
    !Number.isSafeInteger(value.scannedPairs) ||
    Number(value.scannedPairs) < 0
  ) {
    throw new Error(
      "target-blind scanner output is budget-censored or incomplete",
    );
  }
}

function targetBlindExplicitInputBindings(
  universeSha256: string,
): TargetBlindExplicitInputBindings {
  const manifestPath =
    process.env.SEARCHER_POOL_UNIVERSE_MANIFEST_PATH;
  const runtimeKeysRaw =
    process.env.PRODUCTION_REPLAY_FROZEN_RUNTIME_JSON_KEYS;
  if (
    !/^[0-9a-f]{64}$/.test(universeSha256) ||
    !manifestPath ||
    runtimeKeysRaw === undefined
  ) {
    throw new Error(
      "target-blind explicit input binding is not configured",
    );
  }
  const runtimeKeys = runtimeKeysRaw.length === 0
    ? []
    : runtimeKeysRaw.split(",");
  if (
    runtimeKeys.some((key) => !/^SEARCHER_[A-Z0-9_]+$/.test(key)) ||
    new Set(runtimeKeys).size !== runtimeKeys.length ||
    stableJsonValue(runtimeKeys) !==
      stableJsonValue([...runtimeKeys].sort())
  ) {
    throw new Error(
      "target-blind runtime JSON input keys are invalid",
    );
  }
  const hashFile = (path: string, label: string): string => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new Error(`target-blind ${label} is unreadable`);
    }
    return createHash("sha256").update(bytes).digest("hex");
  };
  const payload = {
    universeSha256,
    universeManifestSha256:
      hashFile(manifestPath, "universe manifest"),
    runtimeJsonInputs: runtimeKeys.map((key) => {
      const path = process.env[key];
      if (!path) {
        throw new Error(
          `target-blind runtime JSON input is missing: ${key}`,
        );
      }
      return {
        key,
        sha256: hashFile(path, `runtime JSON input ${key}`),
      };
    }),
  };
  return {
    ...payload,
    sha256: semanticJsonSha256(payload as unknown as SemanticJson),
  };
}

export function assertTargetBlindExplicitInputBindings(
  value: unknown,
): asserts value is TargetBlindExplicitInputBindings {
  if (!isPlainRecord(value)) {
    throw new Error("target-blind explicit input binding is malformed");
  }
  const runtimeJsonInputs = value.runtimeJsonInputs;
  if (
    stableObjectKeys(value) !== stableObjectKeys({
      universeSha256: true,
      universeManifestSha256: true,
      runtimeJsonInputs: true,
      sha256: true,
    }) ||
    !/^[0-9a-f]{64}$/.test(String(value.universeSha256 ?? "")) ||
    !/^[0-9a-f]{64}$/.test(
      String(value.universeManifestSha256 ?? ""),
    ) ||
    !/^[0-9a-f]{64}$/.test(String(value.sha256 ?? "")) ||
    !Array.isArray(runtimeJsonInputs)
  ) {
    throw new Error("target-blind explicit input binding is malformed");
  }
  const keys: string[] = [];
  for (const item of runtimeJsonInputs) {
    if (
      !isPlainRecord(item) ||
      stableObjectKeys(item) !== stableObjectKeys({
        key: true,
        sha256: true,
      }) ||
      !/^SEARCHER_[A-Z0-9_]+$/.test(String(item.key ?? "")) ||
      !/^[0-9a-f]{64}$/.test(String(item.sha256 ?? ""))
    ) {
      throw new Error(
        "target-blind runtime JSON input binding is malformed",
      );
    }
    keys.push(String(item.key));
  }
  if (
    new Set(keys).size !== keys.length ||
    stableJsonValue(keys) !== stableJsonValue([...keys].sort())
  ) {
    throw new Error(
      "target-blind runtime JSON input bindings are not canonical",
    );
  }
  const payload = {
    universeSha256: value.universeSha256,
    universeManifestSha256: value.universeManifestSha256,
    runtimeJsonInputs,
  };
  if (
    semanticJsonSha256(payload as unknown as SemanticJson) !==
      value.sha256
  ) {
    throw new Error(
      "target-blind explicit input binding hash is invalid",
    );
  }
}

function assertProducerArtifact(
  producer: TargetBlindProducerArtifact,
): void {
  if (
    producer.schemaVersion !== 1 ||
    producer.artifact !== "explicit-input-target-late-production-replay" ||
    producer.stateAnchor.kind !== "parent-block" ||
    !Number.isSafeInteger(producer.stateAnchor.blockNumber) ||
    producer.stateAnchor.blockNumber <= 0 ||
    !/^0x[0-9a-f]{64}$/.test(producer.stateAnchor.blockHash) ||
    !/^0x[0-9a-f]{64}$/.test(producer.stateAnchor.stateRoot) ||
    !Number.isSafeInteger(producer.sourceFromBlock) ||
    producer.sourceFromBlock < 0 ||
    !Array.isArray(producer.naturalTopK) ||
    !Array.isArray(producer.familySourceCoverage) ||
    !producer.producerOutput.scanCompleteness ||
    producer.producerOutput.materializedGraph.targetInjected !== false ||
    producer.producerOutput.materializedGraph.graphReduced !== false ||
    producer.producerOutput.fullGraph.edgeCount !==
      producer.producerOutput.materializedGraph.edgeCount ||
    producer.producerOutput.fullGraph.sha256 !==
      producer.producerOutput.materializedGraph.sha256
  ) {
    throw new Error("target-blind producer artifact is malformed");
  }
  assertTargetBlindExplicitInputBindings(
    producer.explicitInputBindings,
  );
  if (
    producer.explicitInputBindings.universeSha256 !==
      producer.universe.sha256
  ) {
    throw new Error(
      "target-blind universe input binding differs from artifact",
    );
  }
  assertTargetBlindScanCompleteness(
    producer.producerOutput.scanCompleteness,
  );
  replayValidationPolicy(producer.validationPolicy);
  const indexes = new Set<number>();
  for (const entry of producer.naturalTopK) {
    if (
      !Number.isSafeInteger(entry.opportunityIndex) ||
      entry.opportunityIndex < 0 ||
      indexes.has(entry.opportunityIndex) ||
      !Number.isSafeInteger(entry.rank) ||
      entry.rank < 1 ||
      entry.rank > producer.actualRunnerConfig.topK ||
      !Array.isArray(entry.route) ||
      entry.route.length < 2
    ) {
      throw new Error("target-blind natural top-K entry is malformed");
    }
    indexes.add(entry.opportunityIndex);
    const route = entry.route.map(normalizeReplayEdge);
    const routeSha256 = semanticJsonSha256(
      route as unknown as SemanticJson,
    );
    if (
      stableJsonValue(route) !== stableJsonValue(entry.route) ||
      routeSha256 !== entry.routeSha256
    ) {
      throw new Error("target-blind natural route binding is invalid");
    }
    if (entry.frozenResult) {
      assertFrozenResult(entry.frozenResult, routeSha256, route);
    }
  }
}

export function assertTrustedReference(
  reference: TrustedReferenceRoute,
  winnerTx: string,
): void {
  if (
    reference.schemaVersion !== 2 ||
    reference.artifact !== "trusted-production-reference-route" ||
    reference.sampleTxHash !== winnerTx ||
    !/^[0-9a-f]{64}$/.test(reference.targetInputSha256) ||
    !Number.isSafeInteger(reference.stateAnchor.opportunityBlock) ||
    !Number.isSafeInteger(reference.stateAnchor.baseBlock) ||
    reference.stateAnchor.opportunityBlock !==
      reference.stateAnchor.baseBlock + 1 ||
    !/^0x[0-9a-f]{64}$/.test(reference.stateAnchor.baseBlockHash) ||
    !/^0x[0-9a-f]{64}$/.test(reference.stateAnchor.baseStateRoot) ||
    !Array.isArray(reference.route) ||
    reference.route.length < 2 ||
    !Array.isArray(reference.routeWitnesses) ||
    reference.routeWitnesses.length !== reference.route.length
  ) {
    throw new Error("trusted target reference is malformed");
  }
  const route = reference.route.map(normalizeReplayEdge);
  if (
    stableJsonValue(route) !== stableJsonValue(reference.route) ||
    semanticJsonSha256(route as unknown as SemanticJson) !==
      reference.routeSha256
  ) {
    throw new Error("trusted target route hash is invalid");
  }
  assertClosedProfitToken(route, route[0].tokenIn);
  for (let index = 0; index < reference.routeWitnesses.length; index++) {
    const witness = reference.routeWitnesses[index];
    const edge = route[index];
    const expectedKeys = [
      "seq",
      "edgeAdapterId",
      "tokenIn",
      "tokenOut",
      ...(edge.poolId ? ["poolId"] : []),
      "referenceWitness",
    ].sort().join("\n");
    if (
      !isPlainRecord(witness) ||
      stableObjectKeys(witness as unknown as Record<string, unknown>) !==
        expectedKeys ||
      witness.seq !== index + 1 ||
      witness.edgeAdapterId !== edge.adapterId ||
      ethers.getAddress(witness.tokenIn).toLowerCase() !== edge.tokenIn ||
      ethers.getAddress(witness.tokenOut).toLowerCase() !== edge.tokenOut ||
      (witness.poolId?.toLowerCase() ?? undefined) !== edge.poolId
    ) {
      throw new Error("trusted route witness identity is invalid");
    }
    const parsed = parseReferenceWitness(
      witness.referenceWitness,
      `trusted route witness ${index + 1}`,
    );
    if (
      stableJsonValue(JSON.parse(JSON.stringify(parsed))) !==
        stableJsonValue(witness.referenceWitness)
    ) {
      throw new Error("trusted route witness is not canonical");
    }
    if (
      edge.poolId !== undefined &&
      edge.poolId !== edge.target &&
      !referenceWitnessUsesRef(parsed, "pool-id")
    ) {
      throw new Error(
        `trusted route witness ${index + 1} does not bind singleton poolId`,
      );
    }
  }
}

export function trustedTargetInputSha256(input: {
  txHash: string;
  receipt: unknown;
  callTrace: unknown;
}): string {
  return semanticJsonSha256({
    tx_hash: input.txHash.toLowerCase(),
    receipt: input.receipt,
    call_trace: input.callTrace,
  } as unknown as SemanticJson);
}

export function assertCanonicalTargetReceipt(
  receipt: unknown,
  opportunityHeader: unknown,
  expectedOpportunityBlock: number,
  expectedParentHash: string,
): void {
  if (
    !isPlainRecord(receipt) ||
    !isPlainRecord(opportunityHeader) ||
    typeof receipt.status !== "string" ||
    typeof receipt.blockNumber !== "string" ||
    typeof receipt.blockHash !== "string" ||
    typeof opportunityHeader.number !== "string" ||
    typeof opportunityHeader.hash !== "string" ||
    typeof opportunityHeader.parentHash !== "string"
  ) {
    throw new Error("canonical target receipt/header is malformed");
  }
  let receiptStatus: bigint;
  let receiptBlock: bigint;
  let headerBlock: bigint;
  try {
    receiptStatus = BigInt(receipt.status);
    receiptBlock = BigInt(receipt.blockNumber);
    headerBlock = BigInt(opportunityHeader.number);
  } catch {
    throw new Error("canonical target receipt/header quantity is invalid");
  }
  if (
    receiptStatus !== 1n ||
    receiptBlock !== BigInt(expectedOpportunityBlock) ||
    headerBlock !== BigInt(expectedOpportunityBlock) ||
    !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(opportunityHeader.hash) ||
    receipt.blockHash.toLowerCase() !== opportunityHeader.hash.toLowerCase() ||
    opportunityHeader.parentHash.toLowerCase() !==
      expectedParentHash.toLowerCase()
  ) {
    throw new Error(
      "target receipt is reverted or not bound to the canonical opportunity header",
    );
  }
}

function targetBlindReport(
  producer: TargetBlindProducerArtifact,
  cfg: TargetBlindVerifyConfig,
  reference: TrustedReferenceRoute,
): ReplayReport {
  const emptyExecutionEvidence: PendingExecutionEvidenceReport = {
    schemaVersion: 1,
    freezePoint: "before-natural-route-scan",
    artifactSha256: createHash("sha256").update("").digest("hex"),
    candidateFamilyIds: [],
    attemptedFamilyIds: [],
    requiredFamilyIds: [],
    commitments: [],
  };
  const initialShard = producer.naturalTopK
    .map((entry) => entry.frozenResult?.shardCompleteness)
    .find((value): value is CanonicalShardCompleteness =>
      value !== undefined);
  if (!initialShard) {
    throw new Error("target-blind artifact contains no naturally solved route");
  }
  return {
    schemaVersion: 5,
    evidenceClass: "candidate-authored-diagnostic",
    trustedAcceptance: false,
    laneCoverage: "parent-block-blockscan",
    winnerTx: cfg.winnerTx,
    triggerTx: null,
    sourceWindow: {
      fromBlock: producer.sourceFromBlock,
      toBlock: producer.stateAnchor.blockNumber,
    },
    stateAnchor: {
      kind: "parent-block",
      blockNumber: producer.stateAnchor.blockNumber,
      txHash: null,
      replayedTransactions: 0,
      reconstruction: null,
    },
    inputs: {
      universePath: `sha256:${producer.universe.sha256}`,
      contentAddressedSnapshot: `universe-${producer.universe.sha256}.json`,
      universe: producer.universe,
      universeProvenance: "unverified-cli",
      explicitRouteInjected: false,
      explicitRouteInputs: [],
      strippedRouteEnvironmentKeys: [],
      explicitAmountInjected: false,
      explicitAmountInputs: [],
      strippedAmountEnvironmentKeys: [],
      amountSource: "solver",
      dynamicPoolsFromDiscoveryArtifact: true,
      explicitInputBindings: producer.explicitInputBindings,
    },
    actualRunnerConfig: producer.actualRunnerConfig,
    discovery: {
      // Completeness is intentionally evaluated per required family shard by
      // the trusted controller. An unrelated degraded family must not veto a
      // healthy selected route.
      sourceComplete: true,
      evaluationComplete:
        producer.producerOutput.scanCompleteness?.evaluationComplete === true,
      candidates: producer.naturalTopK.length,
      admittedInstances: 0,
      discoveredPools: 0,
      artifactSha256: producer.producerOutput.frozenHuntArtifact?.sha256 ??
        createHash("sha256").update("").digest("hex"),
      familySourceCoverage: producer.familySourceCoverage,
      completeFamilyIds: [],
      shardCompleteness: initialShard,
    },
    producerOutput: producer.producerOutput,
    executionEvidence: emptyExecutionEvidence,
    reference: {
      observedAdmissions: 0,
      subjectEdges: reference.route,
      referenceEdgeMatched: false,
      cycleCandidates: 0,
      subjectCycle: reference.route,
      exactCycleMatched: false,
      targetInputVerified: false,
      targetInputSha256: reference.targetInputSha256,
      trustedReferenceArtifactSha256: cfg.trustedReferenceSha256,
      trustedRouteSha256: reference.routeSha256,
      frozenHuntArtifactSha256:
        producer.producerOutput.frozenHuntArtifact?.sha256,
    },
    stages: {
      sourceAndIdentity: "fail",
      graphProjection: "fail",
      enumeration: "fail",
      solver: "fail",
      finalSim: "not_reached",
      ev: "not_reached",
    },
    validationPolicy: producer.validationPolicy,
    terminalGates: {
      finalVerifyAdmission: null,
      phantomProfit: null,
      standingGuard: null,
      repaymentAndConservation: null,
      offlineHistorical: {
        headStaleCheck: "not_applicable",
        submissionCoordinator: "not_run",
        bundleRouter: "not_run",
        submissionAttempted: false,
        reason: "historical replay never submits",
      },
    },
    selected: null,
    failure: null,
  };
}

async function simulateFrozenCalldata(
  state: AnvilStateBackend,
  rawCalldata: string,
  profitToken: string,
  fundingHolder: string,
  flashAmount: bigint,
): Promise<{
  success: boolean;
  profitToken: string;
  grossProfit: bigint;
  netProfit: bigint;
  gasUsed: bigint;
  executorTransferTokens: readonly string[];
  revertReason?: string;
}> {
  const snapshot = await state.snapshot();
  const token = ethers.getAddress(profitToken);
  try {
    const before = await state.getTokenBalance(
      token,
      DEFAULT_SEARCHER_EXECUTOR,
    );
    if (before !== 0n) {
      throw new Error("final sim executor has pre-existing profit inventory");
    }
    const txHash = await state.send({
      from: DEFAULT_SEARCHER_OWNER,
      to: DEFAULT_SEARCHER_EXECUTOR,
      data: rawCalldata,
      gas: "0x1000000",
    });
    const [gasUsed, after, receipt] = await Promise.all([
      state.getGasUsed(txHash),
      state.getTokenBalance(token, DEFAULT_SEARCHER_EXECUTOR),
      state.provider.getTransactionReceipt(txHash),
    ]);
    if (!receipt || receipt.status !== 1) {
      throw new Error("final sim receipt missing or reverted");
    }
    assertFundingTransfersFromReceipt(receipt, {
      token,
      holder: fundingHolder,
      executor: DEFAULT_SEARCHER_EXECUTOR,
      flashAmount,
    });
    const grossProfit = after - before;
    return {
      success: grossProfit > 0n,
      profitToken: token.toLowerCase(),
      grossProfit,
      netProfit: grossProfit,
      gasUsed,
      executorTransferTokens: executorTransferTokensFromReceipt(
        receipt,
        DEFAULT_SEARCHER_EXECUTOR,
      ),
    };
  } catch (error) {
    return {
      success: false,
      profitToken: token.toLowerCase(),
      grossProfit: 0n,
      netProfit: 0n,
      gasUsed: 0n,
      executorTransferTokens: [],
      revertReason: safeError(error),
    };
  } finally {
    await state.revert(snapshot);
  }
}

const ERC20_TRANSFER_TOPIC =
  ethers.id("Transfer(address,address,uint256)").toLowerCase();

interface Erc20TransferEvidence {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

function erc20TransfersFromReceipt(
  receipt: unknown,
): readonly Erc20TransferEvidence[] {
  if (!isPlainRecord(receipt) || !Array.isArray(receipt.logs)) {
    throw new Error("final sim receipt logs are malformed");
  }
  const transfers: Erc20TransferEvidence[] = [];
  for (const rawLog of receipt.logs) {
    if (!isPlainRecord(rawLog) || !Array.isArray(rawLog.topics)) {
      throw new Error("final sim receipt log is malformed");
    }
    if (
      rawLog.topics.length === 0 ||
      typeof rawLog.topics[0] !== "string" ||
      rawLog.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC
    ) {
      continue;
    }
    if (
      typeof rawLog.address !== "string" ||
      !ethers.isAddress(rawLog.address) ||
      rawLog.topics.length < 3 ||
      typeof rawLog.topics[1] !== "string" ||
      typeof rawLog.topics[2] !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(rawLog.topics[1]) ||
      !/^0x[0-9a-fA-F]{64}$/.test(rawLog.topics[2]) ||
      typeof rawLog.data !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(rawLog.data)
    ) {
      throw new Error("ERC20 Transfer log is malformed");
    }
    transfers.push({
      token: ethers.getAddress(rawLog.address).toLowerCase(),
      from: ethers.getAddress(
        `0x${rawLog.topics[1].slice(-40)}`,
      ).toLowerCase(),
      to: ethers.getAddress(
        `0x${rawLog.topics[2].slice(-40)}`,
      ).toLowerCase(),
      amount: BigInt(rawLog.data),
    });
  }
  return transfers;
}

export function executorTransferTokensFromReceipt(
  receipt: unknown,
  executor: string,
): readonly string[] {
  const normalizedExecutor = ethers.getAddress(executor).toLowerCase();
  const tokens = new Set<string>();
  for (const transfer of erc20TransfersFromReceipt(receipt)) {
    if (
      transfer.from === normalizedExecutor ||
      transfer.to === normalizedExecutor
    ) {
      tokens.add(transfer.token);
    }
  }
  return [...tokens].sort();
}

export function assertFundingTransfersFromReceipt(
  receipt: unknown,
  input: {
    token: string;
    holder: string;
    executor: string;
    flashAmount: bigint;
  },
): void {
  const token = ethers.getAddress(input.token).toLowerCase();
  const holder = ethers.getAddress(input.holder).toLowerCase();
  const executor = ethers.getAddress(input.executor).toLowerCase();
  const transfers = erc20TransfersFromReceipt(receipt)
    .filter((transfer) => transfer.token === token);
  const borrowed = transfers.some((transfer) =>
    transfer.from === holder &&
    transfer.to === executor &&
    transfer.amount === input.flashAmount);
  const repaid = transfers.some((transfer) =>
    transfer.from === executor &&
    transfer.to === holder &&
    transfer.amount >= input.flashAmount);
  if (!borrowed || !repaid) {
    throw new Error(
      "final sim receipt does not prove declared funding borrow and repayment",
    );
  }
}

async function conserveFrozenCalldata(input: {
  state: AnvilStateBackend;
  frozen: NonNullable<HuntSolve["frozenResult"]>;
  routeTokens: readonly string[];
  expectedGrossProfit: bigint;
  expectedGasUsed: bigint;
}): Promise<{ callTrace: unknown; receipt: ethers.TransactionReceipt }> {
  const holder = resolveFrozenFundingHolder(
    input.frozen.fundingActionId,
  );
  const profitToken = ethers.getAddress(input.frozen.profitToken);
  const tokens = [...new Set(
    input.routeTokens.map((token) =>
      ethers.getAddress(token).toLowerCase()),
  )].sort().map(ethers.getAddress);
  const snapshot = await input.state.snapshot();
  try {
    for (const token of tokens) {
      const balance = await input.state.getTokenBalance(
        token,
        DEFAULT_SEARCHER_EXECUTOR,
      );
      if (balance !== 0n) {
        throw new Error(
          `executor has pre-existing route-token inventory ${token}:${balance}`,
        );
      }
    }
    const nativeBefore = await input.state.provider.getBalance(
      DEFAULT_SEARCHER_EXECUTOR,
    );
    if (nativeBefore !== 0n) {
      throw new Error(
        `executor has pre-existing native inventory ${nativeBefore}`,
      );
    }
    const lenderBefore = await input.state.getTokenBalance(
      profitToken,
      holder,
    );
    const txHash = await input.state.send({
      from: DEFAULT_SEARCHER_OWNER,
      to: DEFAULT_SEARCHER_EXECUTOR,
      data: input.frozen.rawCalldata,
      gas: "0x1000000",
    });
    const [gasUsed, callTrace, receipt] = await Promise.all([
      input.state.getGasUsed(txHash),
      input.state.provider.send("debug_traceTransaction", [
        txHash,
        { tracer: "callTracer", timeout: "60s" },
      ]),
      input.state.provider.getTransactionReceipt(txHash),
    ]);
    if (!receipt || receipt.status !== 1) {
      throw new Error("conservation replay receipt missing or reverted");
    }
    if (gasUsed !== input.expectedGasUsed) {
      throw new Error(
        `conservation replay gas ${gasUsed} != final sim ` +
          `${input.expectedGasUsed}`,
      );
    }
    for (const token of tokens) {
      const balance = await input.state.getTokenBalance(
        token,
        DEFAULT_SEARCHER_EXECUTOR,
      );
      const expected = token.toLowerCase() === profitToken.toLowerCase()
        ? input.expectedGrossProfit
        : 0n;
      if (balance !== expected) {
        throw new Error(
          `executor route-token conservation failed ${token}:` +
            `${balance} != ${expected}`,
        );
      }
    }
    const nativeAfter = await input.state.provider.getBalance(
      DEFAULT_SEARCHER_EXECUTOR,
    );
    if (nativeAfter !== 0n) {
      throw new Error(`executor retained native inventory ${nativeAfter}`);
    }
    const lenderAfter = await input.state.getTokenBalance(
      profitToken,
      holder,
    );
    if (lenderAfter < lenderBefore) {
      throw new Error("rollback registry funding holder was not repaid");
    }
    return { callTrace, receipt };
  } finally {
    await input.state.revert(snapshot);
  }
}

export function resolveFrozenFundingHolder(
  fundingActionId: string,
): string {
  const funding = STRICT_PROJECTED_FAMILY_TEST_REGISTRY.findFundingByAction(
    fundingActionId,
  );
  if (!funding) {
    throw new Error(
      `rollback registry does not own funding action ${fundingActionId}`,
    );
  }
  return ethers.getAddress(funding.funding.liquidityHolder);
}

export function assertClosedProfitToken(
  route: readonly HuntEdge[],
  profitToken: string,
): void {
  if (
    route.length < 2 ||
    route.some((edge, index) =>
      edge.tokenOut.toLowerCase() !==
        route[(index + 1) % route.length].tokenIn.toLowerCase()) ||
    route[0].tokenIn.toLowerCase() !== profitToken.toLowerCase()
  ) {
    throw new Error("trusted route is not a closed profit-token ring");
  }
}

export function assertRouteReferenceWitnesses(input: {
  readonly trace: unknown;
  readonly receipt: unknown;
  readonly reference: TrustedReferenceRoute;
  readonly executionSurfaces:
    readonly ResolvedRouteExecutionSurface[];
  readonly supportExecutionCalls:
    readonly ResolvedActionExecutionSurface[];
  readonly label: string;
  readonly requireResolvedCallBytes: boolean;
}): void {
  if (
    input.reference.routeWitnesses.length !== input.reference.route.length ||
    input.executionSurfaces.length !== input.reference.route.length
  ) {
    throw new Error(`${input.label} route witness cardinality differs`);
  }
  const calls: FlattenedTraceCall[] = [];
  flattenSuccessfulCalls(
    input.trace as TraceCall,
    calls,
  );
  const receiptLogs = referenceReceiptLogs(input.receipt);
  const witnessCalls: Array<
    ReturnType<typeof matchReferenceWitness>["matchedCalls"][number]
  > = [];
  const usedReceiptLogIndexes = new Set<number>();
  let cursor = 0;
  for (let index = 0; index < input.reference.route.length; index++) {
    const edge = input.reference.route[index];
    const leg = input.reference.routeWitnesses[index];
    const surface = input.executionSurfaces[index];
    if (
      surface.adapterId !== edge.adapterId ||
      leg.edgeAdapterId !== edge.adapterId
    ) {
      throw new Error(
        `${input.label} route execution surface ${index + 1} differs`,
      );
    }
    const matched = matchReferenceWitness({
      calls,
      receiptLogs,
      cursor,
      leg,
      executionTarget: surface.target,
      expectedEncodedSelector: surface.selector,
      // The rollback verifier cannot rely on a newly added family's
      // observation code. The independently reviewed witness must therefore
      // bind both route tokens for every leg, including swaps.
      requireTokenCoverage: true,
      // A newly added family is intentionally absent from rollback/main's
      // ActionAdapter registry. Ownership is instead bound by the sealed
      // resolved execution surface and the family manifest.
      requireActionOwnership: false,
      usedReceiptLogIndexes,
    });
    for (const logIndex of matched.matchedReceiptLogIndexes) {
      usedReceiptLogIndexes.add(logIndex);
    }
    if (
      input.requireResolvedCallBytes &&
      matched.rootInputSha256 !== surface.calldataSha256
    ) {
      throw new Error(
        `${input.label} route call ${index + 1} differs from the ` +
        "solver-selected resolved subtree",
      );
    }
    const unmatched = [...matched.matchedCalls];
    for (const action of surface.actionCalls) {
      const matchedIndex = unmatched.findIndex((call) =>
        call.target === action.target &&
        call.selector === action.selector &&
        (
          !input.requireResolvedCallBytes ||
          call.inputSha256 === action.calldataSha256
        )
      );
      if (matchedIndex < 0) {
        throw new Error(
          `${input.label} route action ${action.actionAdapterId} is not ` +
            (
              input.requireResolvedCallBytes
                ? "byte-bound to the solver-selected subtree"
                : "covered by the declarative reference witness"
            ),
        );
      }
      unmatched.splice(matchedIndex, 1);
    }
    witnessCalls.push(...unmatched);
    cursor = matched.nextCursor;
  }
  for (const action of input.supportExecutionCalls) {
    const matchedIndex = witnessCalls.findIndex((call) =>
      call.target === action.target &&
      call.selector === action.selector &&
      (
        !input.requireResolvedCallBytes ||
        call.inputSha256 === action.calldataSha256
      )
    );
    if (matchedIndex < 0) {
      throw new Error(
        `${input.label} support action ${action.actionAdapterId} is not ` +
          (
            input.requireResolvedCallBytes
              ? "byte-bound to the solver-selected plan"
              : "covered by a declarative route witness"
          ),
      );
    }
    witnessCalls.splice(matchedIndex, 1);
  }
}

function referenceReceiptLogs(receipt: unknown): Array<{
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}> {
  if (!isPlainRecord(receipt) || !Array.isArray(receipt.logs)) {
    throw new Error("reference witness receipt logs are malformed");
  }
  return receipt.logs.map((log, index) => {
    if (
      !isPlainRecord(log) ||
      typeof log.address !== "string" ||
      !ethers.isAddress(log.address) ||
      !Array.isArray(log.topics) ||
      log.topics.some((topic) => typeof topic !== "string") ||
      typeof log.data !== "string" ||
      !ethers.isHexString(log.data)
    ) {
      throw new Error(`reference witness receipt log ${index} is malformed`);
    }
    return {
      address: ethers.getAddress(log.address).toLowerCase(),
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(),
    };
  });
}

function referenceWitnessUsesRef(
  value: unknown,
  ref: string,
): boolean {
  if (value === ref) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => referenceWitnessUsesRef(entry, ref));
  }
  if (isPlainRecord(value)) {
    return Object.values(value).some((entry) =>
      referenceWitnessUsesRef(entry, ref)
    );
  }
  return false;
}

function positiveDecimal(value: unknown): value is string {
  return typeof value === "string" &&
    /^[1-9][0-9]*$/.test(value) &&
    BigInt(value) > 0n;
}

function exactSortedStrings(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0) &&
    new Set(value).size === value.length &&
    stableJsonValue(value) === stableJsonValue([...value].sort());
}

function stableObjectKeys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join("\n");
}

function stableJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonValue).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) =>
        `${JSON.stringify(key)}:${stableJsonValue(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function emptyReport(
  cfg: CliConfig,
  parentBlock: number,
  winnerBlock: number,
  sourceComplete: boolean,
  evaluationComplete: boolean,
  frozenUniverse: FrozenUniverseInput,
  inputAudit: ReplayInputAudit,
  validationPolicy: ReplayValidationPolicy,
  fullGraph: readonly TokenEdge[],
  executionEvidence: PendingExecutionEvidenceReport,
  discovery: Omit<ReplayReport["discovery"], "sourceComplete" | "evaluationComplete">,
): ReplayReport {
  return {
    schemaVersion: 5,
    evidenceClass: "candidate-authored-diagnostic",
    trustedAcceptance: false,
    laneCoverage: cfg.triggerTx
      ? "sender-prefix-post-trigger-blockscan"
      : "parent-block-blockscan",
    winnerTx: cfg.winnerTx,
    triggerTx: cfg.triggerTx,
    sourceWindow: { fromBlock: cfg.sourceFromBlock, toBlock: parentBlock },
    stateAnchor: {
      kind: cfg.triggerTx ? "sender-nonce-prefix" : "parent-block",
      blockNumber: cfg.triggerTx ? winnerBlock : parentBlock,
      txHash: cfg.triggerTx,
      replayedTransactions: 0,
      reconstruction: null,
    },
    inputs: {
      universePath: cfg.universePath,
      contentAddressedSnapshot: frozenUniverse.snapshotName,
      universe: frozenUniverse.evidence,
      universeProvenance: "unverified-cli",
      explicitRouteInjected: inputAudit.explicitRouteInputs.length > 0,
      explicitRouteInputs: inputAudit.explicitRouteInputs,
      strippedRouteEnvironmentKeys: inputAudit.strippedRouteEnvironmentKeys,
      explicitAmountInjected: inputAudit.explicitAmountInputs.length > 0,
      explicitAmountInputs: inputAudit.explicitAmountInputs,
      strippedAmountEnvironmentKeys: inputAudit.strippedAmountEnvironmentKeys,
      amountSource: "solver",
      dynamicPoolsFromDiscoveryArtifact: true,
    },
    actualRunnerConfig: runnerConfigEvidence(cfg, fullGraph.length),
    discovery: { sourceComplete, evaluationComplete, ...discovery },
    producerOutput: initialProducerOutput(fullGraph),
    executionEvidence,
    reference: {
      observedAdmissions: 0,
      subjectEdges: [],
      referenceEdgeMatched: false,
      cycleCandidates: 0,
      subjectCycle: [],
      exactCycleMatched: false,
    },
    stages: {
      sourceAndIdentity: "fail",
      graphProjection: "fail",
      enumeration: "fail",
      solver: "fail",
      finalSim: "not_reached",
      ev: "not_reached",
    },
    validationPolicy: {
      quoteSafetyBps: validationPolicy.quoteSafetyBps.toString(),
      quoteProfitFloorBps: validationPolicy.quoteProfitFloorBps.toString(),
      finalVerifyFloorBps: validationPolicy.finalVerifyFloorBps.toString(),
      maxProfitBpsOfFlash: validationPolicy.maxProfitBpsOfFlash.toString(),
      standingMarkerPath: validationPolicy.standingMarkerPath,
      ev: { ...validationPolicy.ev, minNetEth: validationPolicy.minNetEth.toString() },
    },
    terminalGates: {
      finalVerifyAdmission: null,
      phantomProfit: null,
      standingGuard: null,
      repaymentAndConservation: null,
      offlineHistorical: {
        headStaleCheck: "not_applicable",
        submissionCoordinator: "not_run",
        bundleRouter: "not_run",
        submissionAttempted: false,
        reason: "historical replay never submits",
      },
    },
    selected: null,
    failure: null,
  };
}

async function proveReplayConservation(
  state: AnvilStateBackend,
  solved: Awaited<ReturnType<AnvilSolver["solve"]>>,
  edges: readonly TokenEdge[],
  expectedCalldata: string,
  expectedGrossProfit: bigint,
): Promise<NonNullable<ReplayReport["terminalGates"]["repaymentAndConservation"]>> {
  const flashAdapterId = solved.root.adapterId;
  const funding = STRICT_PROJECTED_FAMILY_TEST_REGISTRY.findFundingByAction(flashAdapterId);
  if (!funding) {
    throw new Error(
      `repayment/conservation cannot resolve flash family ${flashAdapterId}`,
    );
  }
  const tokens = [...new Set(
    edges
      .flatMap((edge) => [edge.tokenIn, edge.tokenOut])
      .map((token) => token.toLowerCase()),
  )]
    .sort()
    .map(ethers.getAddress);
  const snapshot = await state.snapshot();
  try {
    for (const token of tokens) {
      const balance = await state.getTokenBalance(
        token,
        DEFAULT_SEARCHER_EXECUTOR,
      );
      if (balance !== 0n) {
        throw new Error(
          `repayment/conservation executor has pre-existing route-token ` +
          `inventory ${token}:${balance}`,
        );
      }
    }
    const liquidityHolder = ethers.getAddress(funding.funding.liquidityHolder);
    const profitToken = ethers.getAddress(solved.profitToken);
    const lenderBalanceBefore = await state.getTokenBalance(
      profitToken,
      liquidityHolder,
    );
    const calldata = buildExecuteCalldata(
      compilePlan(solved.root, DEFAULT_SEARCHER_EXECUTOR),
    );
    if (calldata.toLowerCase() !== expectedCalldata.toLowerCase()) {
      throw new Error(
        "repayment/conservation calldata differs from independent final sim",
      );
    }
    await state.send({
      from: DEFAULT_SEARCHER_OWNER,
      to: DEFAULT_SEARCHER_EXECUTOR,
      data: calldata,
      gas: "0x1000000",
    });
    let grossProfit = 0n;
    for (const token of tokens) {
      const balance = await state.getTokenBalance(
        token,
        DEFAULT_SEARCHER_EXECUTOR,
      );
      if (token.toLowerCase() === profitToken.toLowerCase()) {
        grossProfit = balance;
      } else if (balance < 0n) {
        throw new Error(
          `repayment/conservation consumed intermediate inventory ` +
            `${token}:${balance}`,
        );
      }
    }
    if (grossProfit <= 0n) {
      throw new Error("repayment/conservation produced no positive profit");
    }
    if (grossProfit !== expectedGrossProfit) {
      throw new Error(
        `repayment/conservation gross profit ${grossProfit} differs from ` +
          `independent final sim ${expectedGrossProfit}`,
      );
    }
    const lenderBalanceAfter = await state.getTokenBalance(
      profitToken,
      liquidityHolder,
    );
    if (lenderBalanceAfter < lenderBalanceBefore) {
      throw new Error(
        "repayment/conservation decreased flash liquidity-holder balance",
      );
    }
    return { allowed: true };
  } finally {
    await state.revert(snapshot);
  }
}

async function runHunt(input: {
  upstreamRpc: string;
  anchorBlock: number;
  artifactPath: string;
  artifactSha256: string;
  huntOut: string;
  huntPort: number;
  universeSnapshotPath: string;
  universeSha256: string;
  pendingEvidenceArtifactPath: string;
  pendingEvidenceArtifactSha256: string;
  cfg: CliConfig;
  passBudgetMs: number;
}): Promise<void> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AB_EXPECTED_") || key.startsWith("HUNT_")) delete env[key];
  }
  Object.assign(env, {
    SEARCHER_LIVE_RPC_URL: input.upstreamRpc,
    MAINNET_RPC_URL: input.upstreamRpc,
    SEARCHER_DRY_RUN: "1",
    SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT: String(input.huntPort),
    HUNT_BLOCK: String(input.anchorBlock),
    HUNT_UNIVERSE_PATH: input.universeSnapshotPath,
    HUNT_MAX_POOLS: String(input.cfg.maxPools),
    HUNT_MAX_HOPS: String(input.cfg.maxHops),
    HUNT_MIN_SPREAD_BPS: String(input.cfg.minSpreadBps),
    // A content-addressed full live graph may need a cold, one-time state
    // bootstrap. Keep this separate from the measured current-block pass.
    HUNT_PREWARM_BUDGET_MS: String(input.cfg.prewarmBudgetMs),
    HUNT_SCAN_BUDGET_MS: String(input.cfg.scanBudgetMs),
    HUNT_PASS_BUDGET_MS: String(input.passBudgetMs),
    HUNT_MAX_CANDIDATES: String(input.cfg.maxCandidates),
    HUNT_REFINE_CANDIDATES: String(input.cfg.refineCandidates),
    HUNT_REFINE_FAMILY_TIMEOUT_MS: String(input.cfg.refineFamilyTimeoutMs),
    HUNT_TOP_K: String(input.cfg.topK),
    HUNT_OUT: input.huntOut,
    PRODUCTION_REPLAY_DISCOVERY_ARTIFACT: input.artifactPath,
    PRODUCTION_REPLAY_DISCOVERY_SHA256: input.artifactSha256,
    PRODUCTION_REPLAY_UNIVERSE_SHA256: input.universeSha256,
    PRODUCTION_REPLAY_PENDING_EVIDENCE_ARTIFACT:
      input.pendingEvidenceArtifactPath,
    PRODUCTION_REPLAY_PENDING_EVIDENCE_SHA256:
      input.pendingEvidenceArtifactSha256,
  });
  const args = [
    "--import", TSX_IMPORT_URL,
    "--import", pathToFileURL(PRELOAD_PATH).href,
    HUNT_PATH,
  ];
  const forwardedAudit = auditReplayInputs(args, env);
  if (
    forwardedAudit.explicitRouteInputs.length > 0 ||
    forwardedAudit.explicitAmountInputs.length > 0
  ) {
    throw new Error("production replay child received an explicit route or amount input");
  }
  const childCwd = resolve(dirname(input.huntOut), "isolated-hunt-cwd");
  mkdirSync(childCwd, { recursive: true });
  await new Promise<void>((done, reject) => {
    // blockscan-hunt loads ../.env relative to cwd. A wrapper-owned empty cwd
    // prevents repo .env from reintroducing stripped expected-route controls.
    const child = spawn(process.execPath, args, { cwd: childCwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const consume = (chunk: Buffer, stream: NodeJS.WriteStream): void => {
      const text = chunk.toString("utf8");
      stream.write(text);
      tail = `${tail}${text}`.slice(-8_000);
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, process.stdout));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, process.stderr));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) done();
      else reject(new Error(`blockscan-hunt exited code=${code} signal=${signal ?? "none"}: ${tail}`));
    });
  });
}

function reconstructedOpportunity(
  report: HuntOpportunity,
  edges: TokenEdge[],
  blockNumber: number,
): BlockScanOpportunity {
  const ring = edges.map((edge) => edge.tokenIn);
  const canonical = canonicalTokenRing(ring);
  return {
    kind: "block-scan-arb",
    sourceBlock: blockNumber,
    stateBlock: blockNumber,
    cycleId: canonical.join("|"),
    cycleFingerprint: cycleFingerprint(blockNumber, ring),
    seedEdges: edges,
    flashToken: edges[0].tokenIn,
    searchSeed: {
      startToken: edges[0].tokenIn,
      searchCenter: BigInt(report.searchCenter),
      maxInput: BigInt(report.maxInput),
    },
    leavesStandingPosition: pathLeavesStandingPosition(edges),
    affectedPools: [...new Set(edges.map((edge) => (edge.poolId ?? edge.target).toLowerCase()))],
    affectedTokens: canonical,
  };
}

function findExactEdge(graph: TokenEdge[], wanted: HuntEdge, index: number): TokenEdge {
  const matches = graph.filter((edge) => edgeIdentity(edge) === huntEdgeIdentity(wanted));
  if (matches.length !== 1) {
    throw new Error(`enumerated route edge ${index + 1} maps to ${matches.length} projected edges`);
  }
  return matches[0];
}

function edgeIdentity(
  edge: Pick<
    TokenEdge,
    | "adapterId"
    | "target"
    | "tokenIn"
    | "tokenOut"
    | "slotKind"
    | "edgeKind"
    | "leavesStandingPosition"
    | "poolId"
  >,
): string {
  return [
    edge.adapterId,
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
    edge.edgeKind,
    edge.leavesStandingPosition ? "standing" : "conserving",
    edge.poolId?.toLowerCase() ?? "",
  ].join("|");
}

function huntEdgeIdentity(edge: HuntEdge): string {
  return [
    edge.adapterId,
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
    edge.edgeKind,
    edge.leavesStandingPosition ? "standing" : "conserving",
    edge.poolId?.toLowerCase() ?? "",
  ].join("|");
}

function findSwapImpactEdge(graph: readonly TokenEdge[], impact: PoolImpact): TokenEdge {
  const matches = uniqueEdges(graph.filter((edge) =>
    edge.slotKind === "swap" &&
    edge.adapterId === impact.matchedAdapterId &&
    edge.target.toLowerCase() === impact.pool.toLowerCase() &&
    edge.tokenIn.toLowerCase() === impact.tokenIn.toLowerCase() &&
    edge.tokenOut.toLowerCase() === impact.tokenOut.toLowerCase() &&
    (impact.poolId === undefined || edge.poolId?.toLowerCase() === impact.poolId.toLowerCase())
  ));
  if (matches.length !== 1) {
    throw new Error(
      `winner swap impact maps to ${matches.length} graph edges: ` +
        `${impact.matchedAdapterId}:${impact.pool}:${impact.tokenIn}->${impact.tokenOut}`,
    );
  }
  return matches[0];
}

function uniqueEdges(edges: readonly TokenEdge[]): TokenEdge[] {
  const unique = new Map<string, TokenEdge>();
  for (const edge of edges) unique.set(edgeIdentity(edge), edge);
  return [...unique.values()];
}

function deriveClosedReferenceCycles(
  rawEdges: readonly TokenEdge[],
  requiredProtocolEdgeKeys: ReadonlySet<string>,
  maxHops: number,
): TokenEdge[][] {
  const edges = uniqueEdges(rawEdges);
  const cycles = new Map<string, TokenEdge[]>();
  const walk = (path: TokenEdge[], used: ReadonlySet<number>): void => {
    const first = path[0];
    const last = path[path.length - 1];
    if (path.length >= 2 && last.tokenOut.toLowerCase() === first.tokenIn.toLowerCase()) {
      if (path.some((edge) => requiredProtocolEdgeKeys.has(edgeIdentity(edge)))) {
        const canonical = canonicalizeCycle(path);
        cycles.set(canonical.map(edgeIdentity).join("\n"), canonical);
      }
      return;
    }
    if (path.length >= maxHops) return;
    for (let index = 0; index < edges.length; index++) {
      if (used.has(index)) continue;
      const edge = edges[index];
      if (edge.tokenIn.toLowerCase() !== last.tokenOut.toLowerCase()) continue;
      const nextUsed = new Set(used);
      nextUsed.add(index);
      walk([...path, edge], nextUsed);
    }
  };
  for (let index = 0; index < edges.length; index++) walk([edges[index]], new Set([index]));
  return [...cycles.values()].sort((left, right) =>
    left.map(edgeIdentity).join("\n").localeCompare(right.map(edgeIdentity).join("\n"))
  );
}

function canonicalizeCycle<T extends TokenEdge | HuntEdge>(cycle: readonly T[]): T[] {
  if (cycle.length === 0) return [];
  const rotations = cycle.map((_edge, index) => [
    ...cycle.slice(index),
    ...cycle.slice(0, index),
  ]);
  rotations.sort((left, right) =>
    left.map((edge) => edgeIdentity(edge)).join("\n")
      .localeCompare(right.map((edge) => edgeIdentity(edge)).join("\n"))
  );
  return [...rotations[0]];
}

function sameOrderedCycle(actual: readonly HuntEdge[], expected: readonly HuntEdge[]): boolean {
  if (actual.length !== expected.length || actual.length === 0) return false;
  const actualKey = canonicalizeCycle(actual).map(huntEdgeIdentity).join("\n");
  const expectedKey = canonicalizeCycle(expected).map(huntEdgeIdentity).join("\n");
  return actualKey === expectedKey;
}

function toHuntEdge(edge: TokenEdge): HuntEdge {
  return {
    adapterId: edge.adapterId,
    target: edge.target.toLowerCase(),
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
    slotKind: edge.slotKind,
    edgeKind: edge.edgeKind,
    leavesStandingPosition: edge.leavesStandingPosition,
    ...(edge.poolId === undefined ? {} : { poolId: edge.poolId.toLowerCase() }),
  };
}

function readFrozenHuntReport(path: string): {
  report: HuntReport;
  artifact: NonNullable<ProducerOutputEvidence["frozenHuntArtifact"]>;
} {
  const bytes = readFileSync(path);
  const raw = JSON.parse(bytes.toString("utf8")) as Partial<HuntReport>;
  if (
    !Number.isSafeInteger(raw.stateBlock) ||
    !Number.isSafeInteger(raw.edges) ||
    (raw.edges ?? -1) < 0 ||
    !/^[0-9a-f]{64}$/.test(raw.edgeSetSha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(
      raw.pendingExecutionEvidenceArtifactSha256 ?? "",
    ) ||
    !raw.scanCompleteness ||
    !Array.isArray(raw.opportunities) ||
    !Array.isArray(raw.solved)
  ) {
    throw new Error("blockscan-hunt report has an invalid shape");
  }
  assertTargetBlindScanCompleteness(raw.scanCompleteness);
  return {
    report: raw as HuntReport,
    artifact: {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function materializedGraphEvidence(
  graph: readonly TokenEdge[],
): CanonicalMaterializedGraphEvidence {
  return canonicalMaterializedGraphEvidence(
    graph.map((edge) => lowerEdge(edge)),
    (edge) => STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().forEdge(edge.adapterId).id,
  );
}

function initialProducerOutput(
  graph: readonly TokenEdge[],
): ProducerOutputEvidence {
  const materializedGraph = materializedGraphEvidence(graph);
  return {
    materializedGraph,
    fullGraph: {
      edgeCount: materializedGraph.edgeCount,
      sha256: materializedGraph.sha256,
    },
    naturalRouteSet: null,
    frozenHuntArtifact: null,
  };
}

function runnerConfigEvidence(cfg: CliConfig, graphEdgeCount: number) {
  return {
    maxPools: cfg.maxPools,
    maxHops: cfg.maxHops,
    maxCandidates: cfg.maxCandidates,
    refineCandidates: cfg.refineCandidates,
    topK: cfg.topK,
    minSpreadBps: cfg.minSpreadBps,
    prewarmBudgetMs: cfg.prewarmBudgetMs,
    scanBudgetMs: cfg.scanBudgetMs,
    passBudgetMs: productionPassBudgetMs(cfg, graphEdgeCount),
    basePassBudgetMs: cfg.passBudgetMs,
    largeGraphPassBudgetMs: cfg.largeGraphPassBudgetMs,
    largeGraphEdgeThreshold: cfg.largeGraphEdgeThreshold,
    refineFamilyTimeoutMs: cfg.refineFamilyTimeoutMs,
  };
}

function naturalRouteSetEvidence(
  opportunities: readonly HuntOpportunity[],
): NaturalRouteSetEvidence {
  const routeSha256s = [...new Set(
    opportunities.map((opportunity) => huntRouteSha256(opportunity.seedEdges)),
  )].sort();
  return {
    opportunityCount: opportunities.length,
    routeCount: routeSha256s.length,
    routeSha256s,
    sha256: semanticJsonSha256(routeSha256s),
  };
}

function huntRouteSha256(route: readonly HuntEdge[]): string {
  return semanticJsonSha256(
    route.map(canonicalHuntEdge) as unknown as SemanticJson,
  );
}

function canonicalHuntEdge(edge: HuntEdge): HuntEdge {
  return {
    adapterId: edge.adapterId,
    target: edge.target.toLowerCase(),
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
    slotKind: edge.slotKind,
    edgeKind: edge.edgeKind,
    leavesStandingPosition: edge.leavesStandingPosition,
    ...(edge.poolId === undefined ? {} : { poolId: edge.poolId.toLowerCase() }),
  };
}

function routeFamilyIds(route: readonly HuntEdge[]): string[] {
  return [...new Set(route.map((edge) =>
    STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().forEdge(edge.adapterId).id
  ))].sort();
}

function summarizeRequiredShardFailure(
  completeness: CanonicalShardCompleteness,
): string {
  const failures = [
    ...(completeness.dexShard.status === "incomplete"
      ? [`${completeness.dexShard.shardId}:` +
        `${completeness.dexShard.issues.join(",") || "incomplete"}`]
      : []),
    ...completeness.familyShards
      .filter((shard) => shard.required && shard.status === "incomplete")
      .map((shard) =>
        `${shard.shardId}:${shard.issues.join(",") || "incomplete"}`
      ),
  ];
  return failures.join(" | ") || "requiredComplete=false without a failed shard";
}

function tokenBackend(provider: ethers.JsonRpcProvider, blockNumber: number): TokenQueryBackend {
  return {
    call: (req) => provider.call({ to: req.to, data: req.data, blockTag: blockNumber }),
    getLogs: async (req) => provider.send("eth_getLogs", [req]),
  };
}

function lowerPoolEntry(pool: PoolEntry): PoolEntry {
  return {
    ...pool,
    address: ethers.getAddress(pool.address).toLowerCase(),
    token0: lowerOptional(pool.token0),
    token1: lowerOptional(pool.token1),
    currency0: lowerOptional(pool.currency0),
    currency1: lowerOptional(pool.currency1),
    hooks: lowerOptional(pool.hooks),
    fixedTokenIn: lowerOptional(pool.fixedTokenIn),
    fixedTokenOut: lowerOptional(pool.fixedTokenOut),
    poolId: pool.poolId?.toLowerCase(),
  };
}

function lowerEdge(edge: TokenEdge): TokenEdge {
  return {
    ...edge,
    target: ethers.getAddress(edge.target).toLowerCase(),
    tokenIn: ethers.getAddress(edge.tokenIn).toLowerCase(),
    tokenOut: ethers.getAddress(edge.tokenOut).toLowerCase(),
    poolToken0: lowerOptional(edge.poolToken0),
    poolToken1: lowerOptional(edge.poolToken1),
    poolId: edge.poolId?.toLowerCase(),
  };
}

function lowerOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress.toLowerCase();
  return ethers.getAddress(value).toLowerCase();
}

function loadRpcEnv(): void {
  for (const path of [resolve(LISTENER_ROOT, ".env"), resolve(REPO_ROOT, ".env")]) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.trim().match(/^(?:export\s+)?(SEARCHER_LIVE_RPC_URL|MAINNET_RPC_URL)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

function readValidationPolicy(
  cfg: Pick<CliConfig, "maxHops"> | Pick<TargetBlindProduceConfig, "maxHops">,
): ReplayValidationPolicy {
  const quoteSafetyBps = bigintEnv("SEARCHER_QUOTE_SAFETY_BPS", 9_999n);
  if (quoteSafetyBps > 10_000n) {
    throw new Error("SEARCHER_QUOTE_SAFETY_BPS must not exceed 10000");
  }
  const quoteProfitFloorBps = bigintEnv("SEARCHER_QUOTE_PROFIT_FLOOR_BPS", 20n);
  const finalVerifyFloorBps = bigintEnv(
    "SEARCHER_FINAL_VERIFY_FLOOR_BPS",
    defaultFinalVerifyFloorBps(quoteSafetyBps, cfg.maxHops),
  );
  const profitHaircutBps = numberEnv("SEARCHER_PROFIT_HAIRCUT_BPS", 0);
  const bribeBps = numberEnv("SEARCHER_BRIBE_BPS", Number(DEFAULT_BRIBE_BPS));
  if (
    !Number.isInteger(profitHaircutBps) ||
    profitHaircutBps < 0 ||
    profitHaircutBps > 10_000 ||
    !Number.isInteger(bribeBps) ||
    bribeBps < 0 ||
    bribeBps > 10_000
  ) {
    throw new Error("profit haircut and bribe bps must be integers between 0 and 10000");
  }
  return {
    quoteSafetyBps,
    quoteProfitFloorBps,
    finalVerifyFloorBps,
    maxProfitBpsOfFlash: bigintEnv("SEARCHER_MAX_PROFIT_BPS_OF_FLASH", 2_000n),
    standingMarkerPath:
      process.env.SEARCHER_CREDIT_LIVE_MARKER_PATH ?? DEFAULT_CREDIT_LIVE_MARKER_PATH,
    ev: {
      profitHaircutBps,
      // Six-step acceptance always executes the EV decision even when a live
      // deployment has temporarily disabled submission-side EV gating.
      evGate: true,
      bribeAllAboveGas: process.env.SEARCHER_BRIBE_ALL_ABOVE_GAS === "1",
      bribeBps,
    },
    minNetEth: bigintEnv("SEARCHER_MIN_NET_ETH", 0n),
  };
}

function freezeUniverseInput(
  path: string,
  tempRoot: string,
  maxPools: number,
  minScore: number,
): FrozenUniverseInput {
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`pool universe file ${path} is not valid JSON`);
  }
  const rawPools = Array.isArray(parsed)
    ? parsed
    : isPlainRecord(parsed) && Array.isArray(parsed.pools)
      ? parsed.pools
      : null;
  if (!rawPools) throw new Error(`pool universe file ${path} omits pools`);
  const snapshotName = `universe-${sha256}.json`;
  const snapshotPath = resolve(tempRoot, snapshotName);
  writeFileSync(snapshotPath, bytes, { mode: 0o600 });
  assertFileSha256(snapshotPath, sha256);
  const pools = loadPoolUniverse(snapshotPath, {
    missingOk: false,
    maxPools,
    minScore,
  });
  const metadata = isPlainRecord(parsed) ? parsed : null;
  const evidence: ProductionReplayUniverseEvidence = {
    sha256,
    schemaVersion: optionalSafeInteger(metadata?.schemaVersion, "universe.schemaVersion"),
    generatedAt: optionalString(metadata?.generatedAt, "universe.generatedAt"),
    fromBlock: optionalSafeInteger(metadata?.fromBlock, "universe.fromBlock"),
    toBlock: optionalSafeInteger(metadata?.toBlock, "universe.toBlock"),
    rawPoolCount: rawPools.length,
    selectedPoolCount: pools.length,
    maxPools,
    minScore,
  };
  return { snapshotPath, snapshotName, evidence, pools };
}

function assertFileSha256(path: string, expected: string): void {
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) {
    throw new Error(`content-addressed universe changed: ${actual} != ${expected}`);
  }
}

function auditReplayInputs(
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
): ReplayInputAudit {
  const routeOptions = new Set([
    "--route", "--route-json", "--expected-route", "--pool", "--pool-id",
    "--edge", "--adapter", "--family", "--calldata",
  ]);
  const amountOptions = new Set([
    "--amount", "--amount-in", "--flash-amount", "--sizing", "--profit",
  ]);
  const explicitRouteInputs = args.filter((arg) => routeOptions.has(arg));
  const explicitAmountInputs = args.filter((arg) => amountOptions.has(arg));
  const strippedRouteEnvironmentKeys: string[] = [];
  const strippedAmountEnvironmentKeys: string[] = [];
  for (const key of Object.keys(env).sort()) {
    const upper = key.toUpperCase();
    const isCandidate = upper.startsWith("AB_EXPECTED_") ||
      /^HUNT_(?:EXPECTED_)?(?:ROUTE|POOL|EDGE|ADAPTER|FAMILY|CALLDATA)/.test(upper);
    const isAmount = /^HUNT_(?:EXPECTED_)?(?:AMOUNT|FLASH|SIZING|PROFIT)/.test(upper) ||
      (upper.startsWith("AB_EXPECTED_") && /AMOUNT|FLASH|SIZING|PROFIT/.test(upper));
    if (isAmount) strippedAmountEnvironmentKeys.push(key);
    else if (isCandidate || upper.startsWith("AB_EXPECTED_")) {
      strippedRouteEnvironmentKeys.push(key);
    }
  }
  return {
    explicitRouteInputs,
    explicitAmountInputs,
    strippedRouteEnvironmentKeys,
    strippedAmountEnvironmentKeys,
  };
}

function optionalSafeInteger(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(): CliConfig {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid production replay option near ${name ?? "<end>"}`);
    }
    if (values.has(name)) throw new Error(`${name} may appear only once`);
    values.set(name, value);
  }
  const allowed = new Set([
    "--winner-tx", "--trigger-tx", "--source-from-block", "--universe",
    "--max-pools", "--max-hops", "--max-candidates", "--top-k",
    "--min-spread-bps", "--prewarm-budget-ms", "--scan-budget-ms",
    "--pass-budget-ms", "--large-graph-pass-budget-ms",
    "--large-graph-edge-threshold", "--refine-candidates",
    "--refine-family-timeout-ms", "--out",
  ]);
  const unknown = [...values.keys()].filter((name) => !allowed.has(name));
  if (unknown.length > 0) throw new Error(`unknown production replay option(s): ${unknown.join(",")}`);
  const winnerTx = txHash(required(values, "--winner-tx"), "--winner-tx");
  const triggerRaw = values.get("--trigger-tx");
  const sourceFromBlock = positiveInt(required(values, "--source-from-block"), "--source-from-block");
  const configured = (
    flag: string,
    env: string | null,
    fallback: number,
    allowZero = false,
  ) => (allowZero ? nonNegativeInt : positiveInt)(
    values.get(flag) ?? (env ? process.env[env] : undefined) ?? String(fallback),
    flag,
  );
  const maxCandidates = configured(
    "--max-candidates", "SEARCHER_BLOCKSCAN_MAX_CANDIDATES", 100,
  );
  const topK = configured("--top-k", null, maxCandidates);
  if (topK > maxCandidates) throw new Error("--top-k cannot exceed --max-candidates");
  const passBudgetMs = configured(
    "--pass-budget-ms", "SEARCHER_BLOCKSCAN_PASS_BUDGET_MS", 11_000,
  );
  const largeGraphPassBudgetMs = Math.max(
    passBudgetMs,
    configured(
      "--large-graph-pass-budget-ms",
      "SEARCHER_BLOCKSCAN_LARGE_GRAPH_PASS_BUDGET_MS",
      30_000,
    ),
  );
  const refineCandidates = Math.max(
    maxCandidates,
    configured(
      "--refine-candidates", "SEARCHER_BLOCKSCAN_REFINE_CANDIDATES", 512,
    ),
  );
  return {
    winnerTx,
    triggerTx: triggerRaw ? txHash(triggerRaw, "--trigger-tx") : null,
    sourceFromBlock,
    universePath: resolve(values.get("--universe") ?? DEFAULT_POOL_UNIVERSE_PATH),
    maxPools: configured("--max-pools", "SEARCHER_POOL_UNIVERSE_TOP_N", 20_000),
    maxHops: configured("--max-hops", "SEARCHER_BLOCKSCAN_MAX_HOPS", 4),
    maxCandidates,
    topK,
    minSpreadBps: configured(
      "--min-spread-bps", "SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS", 10, true,
    ),
    prewarmBudgetMs: configured(
      "--prewarm-budget-ms",
      "SEARCHER_BLOCKSCAN_STARTUP_PREWARM_BUDGET_MS",
      120_000,
    ),
    scanBudgetMs: configured(
      "--scan-budget-ms", "SEARCHER_BLOCKSCAN_SCAN_BUDGET_MS", 1_500,
    ),
    passBudgetMs,
    largeGraphPassBudgetMs,
    largeGraphEdgeThreshold: configured(
      "--large-graph-edge-threshold",
      "SEARCHER_BLOCKSCAN_LARGE_GRAPH_EDGE_THRESHOLD",
      20_000,
    ),
    refineCandidates,
    refineFamilyTimeoutMs: configured("--refine-family-timeout-ms", null, 1_000),
    outPath: values.has("--out") ? resolve(values.get("--out")!) : null,
  };
}

export function productionPassBudgetMs(
  config: Pick<
    CliConfig,
    "passBudgetMs" | "largeGraphPassBudgetMs" | "largeGraphEdgeThreshold"
  >,
  graphEdgeCount: number,
): number {
  return graphEdgeCount >= config.largeGraphEdgeThreshold
    ? Math.max(config.passBudgetMs, config.largeGraphPassBudgetMs)
    : config.passBudgetMs;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function txHash(value: string, name: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${name} must be a transaction hash`);
  return normalized;
}

function hash32(value: string, name: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${name} must be a 32-byte hash`);
  }
  return normalized;
}

function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be non-negative`);
  return parsed;
}

function bigintEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  let parsed: bigint;
  try {
    parsed = BigInt(raw);
  } catch {
    throw new Error(`${name} must be an integer`);
  }
  if (parsed < 0n) throw new Error(`${name} must be non-negative`);
  return parsed;
}

async function allocatePort(): Promise<number> {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate loopback port")));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : done(port));
    });
  });
}

function finish(report: ReplayReport, outPath: string | null): void {
  if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`PRODUCTION_REPLAY_RESULT=${JSON.stringify(report)}`);
  if (report.stages.ev !== "allow") process.exitCode = 1;
}

function summarizeDiscoveryRejections(
  events: readonly {
    readonly adapterId: string;
    readonly target: string | null;
    readonly verdict: "rejected" | "would_admit";
    readonly stage: string;
    readonly reason: string | null;
  }[],
  familySourceCoverage: readonly {
    readonly familyId: string;
    readonly sourceId: string;
    readonly complete: boolean;
    readonly issues: readonly string[];
  }[],
): string {
  const incomplete = familySourceCoverage
    .filter((item) => !item.complete)
    .map((item) =>
      `${item.familyId}/${item.sourceId}:` +
      `${item.issues.join(",") || "incomplete_without_reason"}`
    );
  const rejected = events
    .filter((event) => event.verdict === "rejected")
    .slice(-32)
    .map((event) =>
      `${event.adapterId}@${event.target ?? "none"}:${event.stage}:` +
      `${event.reason ?? "unspecified"}`
    );
  const details = [
    ...incomplete.map((item) => `source=${item}`),
    ...rejected,
  ];
  return details.length === 0
    ? "no structured rejection was emitted"
    : details.join(" | ");
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/g, "<redacted-url>")
    .slice(0, 1_000);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`production-replay FAIL: ${safeError(error)}`);
    process.exit(1);
  });
}

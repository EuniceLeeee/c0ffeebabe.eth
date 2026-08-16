import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  mkdir as mkdirAsync,
  rename as renameAsync,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import "../shared/adapters/index.js";
import { ADDR } from "../shared/constants/addresses.js";
import { AnvilStateBackend, type StateBackend } from "../shared/state/state-backend.js";
import { BackrunDetector, type BlockScanOpportunity, type Opportunity } from "./detector/detector.js";
import { oracleVictimWatchTargets } from "./detector/victim-effect.js";
import type { BlockScanCoreConfig } from "./detector/blockscan-scanner-core.js";
import {
  awaitBlockScanDeadline,
  BlockScanPassDeadlineError,
} from "./blockscan-pass-deadline.js";
import {
  resolveBlockScanPricingSourceMode,
} from "./blockscan-pricing-source-mode.js";
import {
  initBlockScanEnumerationSolverTelemetry,
} from "./blockscan-enumeration-solver-telemetry.js";
import { blockScanRouteId } from "./blockscan-route-identity.js";
import { VictimSourceTracker } from "./detector/victim-source-quality.js";
import { initEvents, emitEvent, makeBlockScanOpportunityId, makeOpportunityId } from "./events.js";
import {
  prepareActiveProtocolDiscoveryPass,
} from "./protocol-discovery-runtime.js";
import {
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  projectVerifiedProtocolPool,
  protocolEdgeKey,
  protocolInstanceKey,
  type ProtocolDiscoveryOwnership,
  type ProtocolDiscoveryResult,
} from "./protocol-instance-discovery.js";
import {
  advanceProtocolObservedContiguousAuthority,
  cachedProtocolCandidates,
  createProtocolDiscoveryEvidenceCache,
  invalidateProtocolObservedHistory,
  loadProtocolDiscoveryEvidenceCache,
  pruneProtocolDiscoveryAddressCache,
  protocolObservedCursorAnchorMatches,
  reconcileProtocolDiscoveryEvidenceCache,
  recordProtocolRouteOwnership,
  saveProtocolDiscoveryEvidenceCache,
  setProtocolObservedCursor,
  updateProtocolObservedSourceFingerprint,
} from "./protocol-discovery-cache.js";
import {
  loadDexDiscoveryCursor,
  resolveInitialDexSourceCompleteThrough,
} from "./discovery-dex-cursor.js";
import {
  createProtocolTraceMemo,
  protocolDiscoverySourceFingerprints,
  protocolObservedSourceFingerprint,
  shouldTraceForProtocolDiscovery,
} from "./observed-protocol-discovery.js";
import {
  planDiscoveryStartup,
} from "./discovery-source-watermark.js";
import {
  type LiveDiscoveryPublicationState,
} from "./live-discovery-publication.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  createLiveDiscoveryCoordinator,
  readBlockHash,
  resolveCanonicalSourceTransition,
} from "./live-discovery-coordinator.js";
import {
  createDurableDiscoveryContinuityComposition,
  type DurableDiscoveryContinuityComposition,
} from "./adapter-family-discovery-continuity-composition.js";
import {
  CheckpointDiscoveryInventoryEnumerator,
  type DiscoveryInventoryEnumerator,
} from "./adapter-family-discovery-inventory-enumerator.js";
import {
  CheckpointDiscoveryInventoryWriter,
  type DiscoveryCheckpointInventoryWriter,
} from "./adapter-family-discovery-inventory-writer.js";
import {
  deriveLiveDiscoveryCheckpointInventory,
  deriveLiveDiscoveryAddressSurfaceObservations,
  resolveStrictFamilyIdForAdapter,
} from "./live-discovery-checkpoint-inventory.js";
import {
  resolveStrictCatalogConsumerDiagnostic,
} from "./strict-catalog-consumer-diagnostic.js";
import {
  createCoalescingPublicationChain,
} from "./strict-live-publication-chain.js";
import {
  createStrictQuoteSource,
} from "./strict-live-quote-source.js";
import {
  resolveStrictSolverConsumer,
} from "./strict-solver-consumer.js";
import {
  createStrictCentralAdapterRuntime,
} from "./strict-central-adapter-runtime.js";
import {
  createRevmStrictSimulationTransport,
} from "./revm-strict-simulation-transport.js";
import {
  runStrictFamilyLifecycle,
} from "./strict-family-lifecycle-runner.js";
import {
  publishStrictCatalogFromLifecycle,
  restoreStrictCatalogFromCheckpoint,
} from "./strict-catalog-live-publisher.js";
import {
  reverifyCarriedInstanceContinuity,
} from "./strict-carry-continuity.js";
import {
  deriveLiveDiscoveryEventObservations,
  mergeFamilyObservations,
} from "./live-discovery-event-observations.js";
import type { CentralAdapterRuntime } from
  "./adapter-work-intent.js";
import {
  productionFamilyStartupManifest,
} from "./production-family-startup-manifest.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./venues/production-family-composition.js";
import {
  PRODUCTION_STRICT_VERIFIED_ACTORS,
} from "./venues/production-verified-actors.js";
import {
  emitProtocolDiscoveryEvents,
  emitStaticSuppressedProtocolEvents,
  ProtocolDiscoveryCandidateDomain,
  ProtocolDiscoveryCoverageCoordinator,
} from "./protocol-discovery-coordinator.js";
import { createBundleRouter } from "./execution/bundle-router.js";
import { trackInclusion } from "./execution/inclusion-tracker.js";
import { SubmissionCoordinator } from "./execution/submission-coordinator.js";
import { TemplatePlanner } from "./planner/planner.js";
import {
  buildTokenGraphWithResults,
  buildTokenIndex,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenEdge,
  type TokenQueryBackend,
} from "./planner/token-graph.js";
import {
  filterStartupActivePoolIncumbents,
  scanActivePoolsDetailed,
  indexFactoryPools,
  mergeStartupActivePoolDiscovery,
  mergePoolRegistries,
  sendDexDiscoveryRpc,
} from "./active-pool-discovery.js";
import {
  isRetryablePoolIdentityFailure,
  type PoolIdentityFailureReason,
  type RejectedPoolIdentity,
} from "./venues/identity.js";
import {
  attestStartupPoolSetsStrict,
  type StrictIdentityProvider,
} from "./strict-identity-attestation.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "./venues/admission.js";
import {
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
  PRODUCTION_ADAPTER_FAMILIES,
  productionPoolUniverseSourceFingerprintsStrict,
} from "./venues/production-registry.js";
import {
  setProductionStrictViewsProvider,
} from "./venues/strict-catalog-registry-projection.js";
import {
  DEFAULT_PENDING_EVIDENCE_MAX_READS,
  DEFAULT_PENDING_EVIDENCE_TIMEOUT_MS,
  type PendingTransactionEvidenceProjection,
} from "./venues/adapter-family-registry.js";
import type {
  ExecutionFamilyId,
  PendingExecutionEvidence,
  PendingTransactionEvidenceHead,
  ProtocolDiscoveryReceipt,
} from "./venues/route-leg-adapter.js";
import {
  validateRouteImmutableBinding,
} from "./venues/route-immutable-binding.js";
import { buildMempoolIntakePlan, type MempoolIntakePlan } from "./mempool-intake.js";
import {
  PendingEvidenceAdmissionQueue,
  PendingEvidenceHeadSnapshot,
  PendingEvidenceTaskScheduler,
  type PendingEvidenceTaskPriority,
} from "./pending-evidence-admission-queue.js";
import {
  createPendingEvidenceSession,
  type PendingEvidenceSession,
} from "./pending-evidence-session.js";
import {
  buildStrategyViews,
  hashTokenGraph,
} from "./strategy-views.js";
import {
  assertDexSourceHashStable,
  createDexGraphCoverageState,
  createPinnedDexReadBackend,
  MempoolIntakeRefreshSignal,
} from "./runtime-pool-refresh.js";
import { computeBidEth, evaluateEv, valueInEth } from "./ev-evaluator.js";
import {
  createProfitTokenValuation,
  type ProfitTokenValuation,
} from "./profit-token-valuation.js";
import { loadBlockScanViewOverrides } from "./blockscan-view-overrides.js";
import {
  DEFAULT_PINNED_WARM_POOLS_PATH,
  loadPinnedWarmPools,
  pinnedWarmHopsFromGraph,
  type PinnedWarmPoolEntry,
} from "./pinned-warm-pools.js";
import {
  DEFAULT_FORCE_INCLUDE_POOLIDS_PATH,
  loadForceIncludePoolIds,
  loadForceIncludeRouters,
  mergeForceIncludePoolIds,
} from "./force-include.js";
import {
  DEFAULT_POOL_UNIVERSE_PATH,
  loadPoolUniverse,
  loadPoolUniverseCoverageMetadata,
  loadPoolUniverseGeneratedAt,
  poolUniverseCanonicalAnchorMatches,
  poolProjectionRowKey,
  poolRegistryKey,
  selectPairCompletionPools,
} from "./pool-universe.js";
import {
  BlockScanStateCoordinator,
} from "./blockscan-state-coordinator.js";
import {
  BlockScanBackrunStateBridge,
  BufferedBlockScanBackrunStatePublisher,
} from "./blockscan-backrun-state-bridge.js";
import { JsonRpcBlockScanStateReadBackend } from "./blockscan-state-read-backend.js";
import { AdapterRuntimeCoordinator } from "./adapter-runtime-coordinator.js";
import { LiveRethReadPriority } from "./live-reth-read-priority.js";
import {
  AdapterFamilyGraphViewCoordinator,
} from "./adapter-family-graph-view-coordinator.js";
import {
  BlockScanRuntimeLoop,
  type BlockScanAtomicResult,
  type BlockScanPendingEvidenceTrigger,
  type BlockScanRejectBlacklistEntry,
  type BlockScanRejectBlacklistState,
} from "./blockscan-runtime-loop.js";
import {
  pendingEvidenceEdgeScopeKey,
  pendingEvidenceScopeKeys,
} from "./blockscan-pending-evidence.js";
import { AnvilSolver, type ResolvedPlan } from "./solver/solver.js";
import type { AmountQuoteSource } from
  "./solver/amount-propagation.js";
import { defaultFinalVerifyFloorBps, shouldRunFinalVerify } from "./solver/final-verify-gate.js";
import {
  PoolStateCache,
  type PostImpactSeed,
} from "./solver/pool-state-cache.js";
import { PoolStateUpdater } from "./solver/pool-state-updater.js";
import { postImpactStateOverrides } from "./solver/post-impact-overrides.js";
import { resolveErc20BalanceSlot } from "./solver/balance-slots.js";
import {
  applyVictimSwapLocallySettled,
  type LocalVictimApplyResult,
} from "./solver/victim-apply.js";
import { BotVMSimulator } from "./simulator/botvm-simulator.js";
import { executeFinalSimulationWork } from "./adapter-work-intent.js";
import {
  FinalSimulationWorkRuntimeError,
  type FinalSimulationWorkRuntime,
} from "./final-simulation-work-runtime.js";
import type { SimulationResult } from "./simulator/botvm-simulator.js";
import { FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY } from "./templates/path-template.js";
import {
  LiveFixtureRecorder,
  type LiveFinalState,
  type LiveFixturePath,
} from "./live-fixture-recorder.js";
import {
  parseLiveBackendKind,
  quoteHopIdentityKey,
  type LiveBackendKind,
} from "./live-state-backend.js";
import type { LiveStateBackend, QuoteHop, QuoteRequest } from "./live-state-backend.js";
import { DEFAULT_BRIBE_BPS, validateLiveEnvelope } from "./live-envelope.js";
import { RevmSimClient } from "./revm-sim-client.js";
import { RpcAnvilLiveBackend } from "./live-backends/rpc-anvil-live-backend.js";
import { RevmLiveBackend } from "./live-backends/revm-live-backend.js";
import { HybridLiveBackend } from "./live-backends/hybrid-live-backend.js";
import { RethTransportScheduler } from "./reth-transport-scheduler.js";
import { replayVictimSwapOnAnvil } from "./live-backends/rpc-victim-replay.js";
import {
  eventPostImpactSeedForSettled,
  hashOnlyImpactReplayAdmittedByPolicy,
  postImpactSeedSummary,
  victimNeedsMutablePoolRefresh,
  victimUsesLocalCacheApply,
} from "./venues/victim-runtime-policy.js";
import type { OrderflowEvent } from "./orderflow/manual-source.js";
import type { SwapEventLog } from "./venues/swap-observation.js";
import type { BundleRouter, BundleSubmission } from "./execution/bundle-router.js";
import {
  createVictimSourceGeneration,
  detectImpactTransitionFromLogs,
  mutationOnlyTransitionDiagnostic,
  type PoolImpact,
  type PoolImpactTransition,
} from "./detector/pool-impact.js";
import type { ResolvedPlanNode } from "../shared/types/plan.js";
import {
  DEFAULT_CREDIT_LIVE_MARKER_PATH,
  evaluateStandingGuard,
} from "./standing-guard.js";
import {
  BLIND_PRODUCTION_RAW_PROFILE,
  BLIND_PRODUCTION_RAW_PREFIX,
  BLIND_PRODUCTION_READY_PREFIX,
  blindProductionAuditHash,
  blindProductionCalldataSha256,
  blindProductionCanonicalJson,
  type BlindProductionOpportunityEvidence,
  type BlindProductionPrepareControl,
  type BlindProductionSourceHeadControl,
} from "./blind-production-audit.js";
import {
  blindProductionArtifactReceipt,
  createBlindProductionArtifact,
  type BlindProductionArtifact,
} from "./blind-production-artifacts.js";
import {
  blindCompatibilityCanonicalEdgeId,
} from "./blind-production-compatibility.js";
import {
  blindGraphArtifactPayload,
  blindResolvedRuntimeEnvironment,
  createBlindProductionPassRecord,
  createBlindProductionStaticArtifacts,
  installBlindProductionControlInput,
  normalizeBlindArtifactValue,
  type PreparedBlindProductionArtifacts,
} from "./blind-production-runtime.js";

const DEFAULT_MEV_SHARE_SSE_URL = "https://mev-share.flashbots.net";
const DEFAULT_RUNTIME_GRAPH_POOLS_PATH = resolve("searcher", "pools", "runtime-graph-pools.json");
const DEFAULT_RUNTIME_BLOCKSCAN_POOLS_PATH = resolve("searcher", "pools", "runtime-blockscan-pools.json");
const DEFAULT_PROTOCOL_DISCOVERY_CACHE_PATH = resolve(
  "searcher",
  "pools",
  "runtime-protocol-discovery-cache.json",
);
const DEFAULT_DEX_DISCOVERY_CURSOR_PATH = resolve(
  "searcher",
  "pools",
  "runtime-dex-graph-coverage.json",
);
const DEFAULT_DISCOVERY_CONTINUITY_CHECKPOINT_PATH = resolve(
  "searcher",
  "state",
  "discovery-continuity-checkpoint.json",
);
const PROTOCOL_CURSOR_SEMANTICS_VERSION =
  "family-source-contiguous-v3-hash-anchored";
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const FORK_ETH_BALANCE = "0x56bc75e2d63100000"; // 100 ETH

interface HintLog {
  address: string;
  topics: string[];
  data: string;
}

interface LiveConfig {
  rpcUrl: string;
  /** Enable victim-driven backrun processing from one or more configured sources. */
  enableBackrun: boolean;
  /** WebSocket URL for public mempool pending-tx subscription (route B). */
  wsUrl: string;
  /** Subscribe to the public mempool as a victim source (route B). */
  enableMempool: boolean;
  /** Subscribe to MEV-Share as a victim source. */
  enableMevShare: boolean;
  /**
   * Global admission switch for route families that declare
   * requiresProtocolEdgesFlag. The kernel never names individual families;
   * each registration owns whether this switch applies.
   */
  enableProtocolEdges: boolean;
  mevShareSseUrl: string;
  liveBackend: LiveBackendKind;
  botvmAddress: string;
  wallet: ethers.Wallet;
  minProfit: bigint;
  defaultGasUsed: number;
  inclusionWatchBlocks: number;
  dryRun: boolean;
  /** Submit +EV block-scan atomic bundles through the standalone bundle path. Default OFF. */
  blockScanSubmit: boolean;
  maxHints: number;
  enableHashOnly: boolean;
  forkRefreshBlocks: number;
  solverDeadlineMs: number;
  oppTtlMs: number;
  planBudgetMs: number;
  oppMinSliceMs: number;
  gssMaxTries: number;
  finalSimTopN: number;
  /** Max candidate plans fully solved per opportunity before bailing to free the
   *  shared per-hint TTL budget. 0 = unlimited (legacy). Measured waste: a single
   *  opp can spawn ~20 candidate plans, each running a 7-pt quote search + top-N
   *  sim that virtually all revert (unprofitable), burning the whole TTL and
   *  starving later candidates/opps into `expired-before-solver`. */
  maxCandidatesPerOpp: number;
  quoteSafetyBps: bigint;
  /** Near-miss admission floor in bps of the flash amount (magnitude; 20 = -20bps).
   *  Lets the solver sim near-break-even quotes; in DRY-RUN only it also lets the
   *  pipeline emit a recorded (never broadcast) bundle. 0 = strictly positive. */
  quoteProfitFloorBps: bigint;
  /** Independent final-verify admission floor. Keeps diagnostic/dry-run quote
   *  floors from spending final revm overlay on candidates too negative for the
   *  quote haircut to plausibly flip positive. */
  finalVerifyFloorBps: bigint;
  revmPrewarmRouteHops: number;
  stateUpdaterEnabled: boolean;
  statePinnedK: number;
  stateRecentK: number;
  stateWatchMaxPools: number;
  pinnedWarmPoolPath: string;
  poolUniversePath: string;
  poolUniverseManifestPath: string;
  poolUniverseTopN: number;
  poolUniverseMinScore: number;
  poolUniverseForceInclude: string[];
  forceIncludePoolIdsPath: string;
  poolUniverseHighSpreadPairQuota: number;
  poolUniverseHighSpreadMinFee: number;
  pairCompletion: boolean;
  recordLiveFixtures: boolean;
  liveFixtureDir: string;
  /** Phantom-profit guard: reject final profit > this many bps of the flash
   *  notional. Real backruns are basis points; 100%+ means a bad overlay. */
  maxProfitBpsOfFlash: bigint;
  /** Fraction of expected profit remaining after gas to pay as priority fee. */
  bribeBps: number;
  /** Pay all expected profit above gas as the priority-fee bribe. */
  bribeAllAboveGas: boolean;
  /** Only submit when profitETH − gas − bribe > minNetEth (net +EV gate). */
  evGate: boolean;
  /** Minimum kept profit (ETH wei) after gas + bribe, for the EV gate. */
  minNetEth: bigint;
  /** Optional discount applied to simulated profit before the EV gate and
   *  bribe sizing, in bps. The production default is zero because mandatory
   *  final sim already supplies the measured execution result; operators may
   *  set an explicit nonzero value for a separately validated risk policy. */
  profitHaircutBps: number;
  /** Allow broadcasting approximate hash-only (synthetic-overlay) bundles. */
  allowHashOnlySubmit: boolean;
  /** Allow broadcasting exact-overlay hash-only MEV-Share bundles. */
  allowHashOnlyMevShareSubmit: boolean;
  victimSourceFilter: {
    enabled: boolean;
    minStreak: number;
    windowBlocks: number;
    ringSize: number;
  };
}

interface HintEnvelope {
  payload: unknown;
  hashes: string[];
  /** Source tag for logging. MEV-Share hints are "mev-share" (default). */
  source?: "mev-share" | "mempool";
  /** For mempool victims: the already-fetched full tx + raw signed bytes, so
   *  handleHint skips MEV-Share log matching and applies the rawTx directly. */
  prefetched?: { tx: ethers.TransactionResponse; rawTx: string };
  /** Immutable, tx/head-bound execution evidence for this hint only. */
  executionEvidence?: readonly PendingExecutionEvidence[];
  /**
   * Evidence observation is family-addressable: planning awaits only the
   * families present in the resolved candidate routes, never unrelated
   * observers.
   */
  resolvePendingExecutionEvidence?: (
    familyIds: readonly ExecutionFamilyId[],
  ) => Promise<readonly PendingExecutionEvidence[]>;
}

async function validateHintExecutionEvidence(
  evidence: readonly PendingExecutionEvidence[],
  txHash: string,
  provider: ethers.JsonRpcProvider,
  timeoutMs = DEFAULT_PENDING_EVIDENCE_TIMEOUT_MS,
): Promise<readonly PendingExecutionEvidence[]> {
  if (evidence.length === 0) return Object.freeze([]);
  const normalizedTxHash = txHash.toLowerCase();
  const canonicalHeads = new Map<string, string>();
  const seenFamilies = new Set<ExecutionFamilyId>();
  const controller = new AbortController();
  const deadlineAtMs = Date.now() + timeoutMs;
  const timer = setTimeout(
    () => controller.abort(new Error("pending evidence canonical validation deadline")),
    timeoutMs,
  );
  try {
    for (const item of evidence) {
      if (item.txHash.toLowerCase() !== normalizedTxHash) {
        throw new Error("pending execution evidence tx binding mismatch");
      }
      if (seenFamilies.has(item.familyId)) {
        throw new Error(
          `duplicate pending execution evidence for family ${item.familyId}`,
        );
      }
      seenFamilies.add(item.familyId);
      const payloadHash = ethers.keccak256(item.canonicalPayload);
      if (payloadHash.toLowerCase() !== item.payloadHash.toLowerCase()) {
        throw new Error(
          `pending execution evidence payload hash mismatch for ${item.familyId}`,
        );
      }
      const evidenceHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "bytes32", "uint256", "bytes32", "bytes32"],
          [
            item.familyId,
            item.txHash,
            item.headBlockNumber,
            item.headHash,
            item.payloadHash,
          ],
        ),
      );
      if (evidenceHash.toLowerCase() !== item.evidenceHash.toLowerCase()) {
        throw new Error(
          `pending execution evidence binding hash mismatch for ${item.familyId}`,
        );
      }
      const key = `${item.headBlockNumber}:${item.headHash.toLowerCase()}`;
      let canonical = canonicalHeads.get(key);
      if (canonical === undefined) {
        const tag = `0x${item.headBlockNumber.toString(16)}`;
        const block = await sendDexDiscoveryRpc<{
          readonly hash?: string;
        } | null>(
          provider,
          "eth_getBlockByNumber",
          [tag, false],
          { deadlineAtMs, signal: controller.signal },
        );
        if (!block?.hash) {
          throw new Error("pending execution evidence canonical head unavailable");
        }
        canonical = block.hash;
        canonicalHeads.set(key, canonical);
      }
      if (canonical.toLowerCase() !== item.headHash.toLowerCase()) {
        throw new Error(
          `pending execution evidence canonical head changed for ${item.familyId}`,
        );
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return Object.freeze([...evidence]);
}

type ActiveBlockScanRejectBlacklistEntry = BlockScanRejectBlacklistEntry & { expiryBlock: number };

export { computeBidEth, valueInEth };

function buildBlockScanPricedTokens(): BlockScanCoreConfig["pricedTokens"] {
  return new Map([
    [ADDR.WETH.toLowerCase(), { maxBorrow: 2_000n * 10n ** 18n }],
    [ADDR.USDC.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
    [ADDR.USDT.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
    [ADDR.DAI.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 18n }],
  ]);
}

export function hashOnlySubmitDecision(
  rawTx: boolean,
  overlayExact: boolean,
  allowApprox: boolean,
  allowHashOnlyMevShareSubmit = false,
): boolean {
  return rawTx || (overlayExact && allowHashOnlyMevShareSubmit) || allowApprox;
}

interface StageCounters {
  hints: number;
  impacts: number;
  opportunities: number;
  plans: number;
  solverEntered: number;
  solverSuccess: number;
  revmSimSuccess: number;
  rpcVerifySuccess: number;
  simSuccess: number;
  submitAttempts: number;
  accepted: number;
  expiredBeforeSolver: number;
  quoteTimeouts: number;
  simReverts: number;
  finalVerifyFailed: number;
  finalVerifySkipped: number;
  missingState: number;
  revmErrors: number;
  pendingReceived: number;
  pendingFilteredReceived: number;
  mempoolOpportunitySeen: number;
  mempoolToSim: number;
  cuProxyRpcCalls: number;
}

const MAX_PENDING_VICTIM_OUTCOMES = 200;

interface PendingVictimOutcome {
  sender: string;
  hash: string;
  targetBlock: number;
}

function logIdentityRejections(source: string, rejected: RejectedPoolIdentity[]): void {
  if (rejected.length === 0) return;
  const counts = new Map<string, number>();
  for (const item of rejected) {
    const key = `${item.reason}:${item.venueId ?? "unknown"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}=${count}`)
    .join(",");
  console.log(
    `[searcher/live] venue identity rejected source=${source} count=${rejected.length} ${summary}`,
  );
}

function retryableIdentityCandidates(
  pools: readonly PoolEntry[],
  rejected: readonly RejectedPoolIdentity[],
): PoolEntry[] {
  const retryable = new Set(
    rejected
      .filter((item) => isRetryablePoolIdentityFailure(item.reason))
      .map((item) => `${item.address.toLowerCase()}:${item.adapter}`),
  );
  return pools.filter((pool) =>
    retryable.has(`${pool.address.toLowerCase()}:${pool.adapter}`)
  );
}

function logRuntimeRefreshFailures(
  failed: Array<{ pool: PoolEntry; reason: string }>,
  context = "refresh retryable",
): void {
  for (const item of failed.slice(0, 5)) {
    console.log(
      `[searcher/live] ${context} pool=${poolRegistryKey(item.pool)} ` +
        `reason=${item.reason}`,
    );
  }
  if (failed.length > 5) {
    console.log(`[searcher/live] ${context} additional=${failed.length - 5}`);
  }
}

function logProvisionalV2GraphInstances(
  plane: "backrun" | "blockscan",
  successful: readonly {
    readonly pool: PoolEntry;
    readonly edges: readonly TokenEdge[];
  }[],
): void {
  for (const { pool, edges } of successful) {
    if (
      pool.adapter !== "univ2" ||
      pool.identitySource !== "factory-call-provisional" ||
      edges.length === 0
    ) {
      continue;
    }
    console.log(
      `[searcher/live] provisional_v2_graph_instance ${JSON.stringify({
        plane,
        pool: pool.address.toLowerCase(),
        factory: pool.factory?.toLowerCase() ?? null,
        adapter: pool.adapter,
        identity_source: pool.identitySource,
        edge_count: edges.length,
        edges: edges.map((edge) => ({
          adapter_id: edge.adapterId,
          target: edge.target.toLowerCase(),
          token_in: edge.tokenIn.toLowerCase(),
          token_out: edge.tokenOut.toLowerCase(),
          v2_fee_bps: edge.v2FeeBps?.toString() ?? null,
        })),
      })}`,
    );
  }
}

function replaceArray<T>(target: T[], next: readonly T[]): void {
  target.splice(0, target.length, ...next);
}

function replaceMap<K, V>(target: Map<K, V>, next: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of next) target.set(key, value);
}

function replaceSet<T>(target: Set<T>, next: ReadonlySet<T>): void {
  target.clear();
  for (const value of next) target.add(value);
}

function loadEnv(): void {
  if (process.env.SEARCHER_TEST_DISABLE_DOTENV === "1") return;
  const envPath = resolve("..", ".env");
  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
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

function dumpRuntimeGraphPools(
  pools: PoolEntry[],
  path = DEFAULT_RUNTIME_GRAPH_POOLS_PATH,
): void {
  try {
    const serialized = serializeRuntimeGraphPools(pools);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized);
    console.log(
      `[searcher/live] runtime graph pools dumped: ${path} count=${pools.length}`,
    );
  } catch (err) {
    console.warn(
      `[searcher/live] warning: failed to dump runtime graph pools: ${(err as Error).message}`,
    );
  }
}

async function dumpRuntimeGraphPoolsAsync(
  pools: readonly PoolEntry[],
  path = DEFAULT_RUNTIME_GRAPH_POOLS_PATH,
): Promise<void> {
  const serialized = serializeRuntimeGraphPools(pools);
  await mkdirAsync(dirname(path), { recursive: true });
  const temporary =
    `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFileAsync(temporary, serialized);
  await renameAsync(temporary, path);
  console.log(
    `[searcher/live] runtime graph pools dumped: ${path} ` +
      `count=${pools.length}`,
  );
}

function serializeRuntimeGraphPools(pools: readonly PoolEntry[]): string {
  const normalized = pools.map((pool) => ({
    address: pool.address.toLowerCase(),
    adapter: pool.adapter,
    venueId: pool.venueId,
    factory: pool.factory?.toLowerCase(),
    identitySource: pool.identitySource,
    poolId: pool.poolId?.toLowerCase(),
    routeBinding: pool.routeBinding === undefined
      ? undefined
      : validateRouteImmutableBinding(pool.routeBinding),
    currency0: pool.currency0?.toLowerCase(),
    currency1: pool.currency1?.toLowerCase(),
    logicalInstanceId: pool.logicalInstanceId,
    fixedTokenIn: pool.fixedTokenIn?.toLowerCase(),
    fixedTokenOut: pool.fixedTokenOut?.toLowerCase(),
    fixedSlotKind: pool.fixedSlotKind,
    fixedProtocolAction: pool.fixedProtocolAction,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks?.toLowerCase(),
  }));
  return `${JSON.stringify({
    builtAt: new Date().toISOString(),
    count: normalized.length,
    pools: normalized,
  }, null, 2)}\n`;
}

// Live hot path prefers a dedicated endpoint (e.g. a local reth on 127.0.0.1)
// and falls back to MAINNET_RPC_URL. AC-3 / forge / historical replay keep
// reading MAINNET_RPC_URL directly so they stay on an archive node.
function liveRpcUrl(): string {
  const url = process.env.SEARCHER_LIVE_RPC_URL ?? process.env.MAINNET_RPC_URL;
  if (!url) throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required");
  return url;
}

function protocolDiscoveryArchiveRpcUrl(liveUrl: string): string | undefined {
  const explicit = process.env.SEARCHER_PROTOCOL_DISCOVERY_ARCHIVE_RPC_URL;
  if (explicit) return explicit === liveUrl ? undefined : explicit;
  const archive = process.env.SEARCHER_LIVE_RPC_URL
    ? process.env.MAINNET_RPC_URL
    : undefined;
  return archive && archive !== liveUrl ? archive : undefined;
}

function liveWsUrl(rpcUrl: string): string {
  return (
    process.env.SEARCHER_LIVE_WS_URL ??
    process.env.MAINNET_WS_URL ??
    rpcUrl.replace(/^http(s?):\/\//, (_m, s) => (s ? "wss://" : "ws://"))
  );
}

function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((addr) => addr.trim())
    .filter((addr) => addr.length > 0)
    .map((addr) => BYTES32_RE.test(addr) ? addr.toLowerCase() : ethers.getAddress(addr));
}

function buildConfig(provider: ethers.JsonRpcProvider): LiveConfig {
  const rpcUrl = liveRpcUrl();

  const privateKey = process.env.PRIVATE_KEY ?? process.env.OWNER_PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY or OWNER_PRIVATE_KEY required");

  const botvmAddress = process.env.BOTVM_ADDRESS;
  if (!botvmAddress) throw new Error("BOTVM_ADDRESS required");

  const wallet = new ethers.Wallet(privateKey, provider);
  const botvmOwner = process.env.BOTVM_OWNER;
  if (botvmOwner && wallet.address.toLowerCase() !== botvmOwner.toLowerCase()) {
    throw new Error(
      `PRIVATE_KEY wallet ${wallet.address} does not match BOTVM_OWNER ${botvmOwner}`,
    );
  }
  const dryRun = process.env.SEARCHER_DRY_RUN === "1";
  const maxHops = Number(process.env.SEARCHER_MAX_HOPS ?? "3");
  const quoteSafetyBps = BigInt(process.env.SEARCHER_QUOTE_SAFETY_BPS ?? "9999");
  const forceIncludePoolIdsPath =
    process.env.SEARCHER_FORCE_INCLUDE_POOLIDS_PATH ?? DEFAULT_FORCE_INCLUDE_POOLIDS_PATH;
  const envForceInclude = parseAddressList(process.env.SEARCHER_POOL_UNIVERSE_FORCE_INCLUDE);
  const fileForceInclude = loadForceIncludePoolIds(forceIncludePoolIdsPath);
  const poolUniverseForceInclude = mergeForceIncludePoolIds(envForceInclude, fileForceInclude);
  const poolUniversePath =
    process.env.SEARCHER_POOL_UNIVERSE_PATH ?? DEFAULT_POOL_UNIVERSE_PATH;

  const wsUrl = liveWsUrl(rpcUrl);

  const enableBackrun = process.env.SEARCHER_ENABLE_BACKRUN !== "0";
  const enableMempool = enableBackrun && process.env.SEARCHER_ENABLE_MEMPOOL === "1";
  const enableMevShare = enableBackrun && process.env.SEARCHER_ENABLE_MEV_SHARE !== "0";
  if (enableBackrun && !enableMempool && !enableMevShare) {
    throw new Error("SEARCHER_ENABLE_BACKRUN=1 requires at least one victim source");
  }

  return {
    rpcUrl,
    wsUrl,
    enableBackrun,
    enableMempool,
    enableMevShare,
    enableProtocolEdges: process.env.SEARCHER_ENABLE_PROTOCOL_EDGES === "1",
    mevShareSseUrl: process.env.MEV_SHARE_SSE_URL ?? DEFAULT_MEV_SHARE_SSE_URL,
    liveBackend: parseLiveBackendKind(process.env.SEARCHER_LIVE_BACKEND ?? "rpc"),
    botvmAddress: ethers.getAddress(botvmAddress),
    wallet,
    minProfit: BigInt(process.env.SEARCHER_MIN_PROFIT_RAW ?? "1"),
    defaultGasUsed: Number(process.env.SEARCHER_BACKRUN_GAS_USED ?? "12000000"),
    inclusionWatchBlocks: Number(process.env.SEARCHER_INCLUSION_WATCH_BLOCKS ?? "3"),
    dryRun,
    blockScanSubmit: process.env.SEARCHER_BLOCKSCAN_SUBMIT === "1",
    enableHashOnly: process.env.SEARCHER_ENABLE_HASH_ONLY === "1",
    maxHints: Number(process.env.SEARCHER_MAX_HINTS ?? "0"),
    forkRefreshBlocks: Number(process.env.SEARCHER_FORK_REFRESH_BLOCKS ?? "5"),
    solverDeadlineMs: Number(process.env.SEARCHER_SOLVER_DEADLINE_MS ?? "8000"),
    oppTtlMs: Number(process.env.SEARCHER_OPP_TTL_MS ?? "5000"),
    planBudgetMs: Number(process.env.SEARCHER_PLAN_BUDGET_MS ?? "300"),
    oppMinSliceMs: Number(process.env.SEARCHER_OPP_MIN_SLICE_MS ?? "500"),
    gssMaxTries: Number(process.env.SEARCHER_GSS_MAX_TRIES ?? "12"),
    finalSimTopN: Number(process.env.SEARCHER_FINAL_SIM_TOP_N ?? "3"),
    maxCandidatesPerOpp: Number(process.env.SEARCHER_MAX_CANDIDATES_PER_OPP ?? "6"),
    quoteSafetyBps,
    quoteProfitFloorBps: BigInt(
      process.env.SEARCHER_QUOTE_PROFIT_FLOOR_BPS ?? (dryRun ? "20" : "0"),
    ),
    finalVerifyFloorBps: BigInt(
      process.env.SEARCHER_FINAL_VERIFY_FLOOR_BPS ??
        defaultFinalVerifyFloorBps(quoteSafetyBps, maxHops).toString(),
    ),
    revmPrewarmRouteHops: Number(process.env.SEARCHER_REVM_PREWARM_ROUTE_HOPS ?? "0"),
    stateUpdaterEnabled: process.env.SEARCHER_STATE_UPDATER_ENABLED !== "0",
    statePinnedK: Number(process.env.SEARCHER_STATE_PINNED_K ?? "8"),
    stateRecentK: Number(process.env.SEARCHER_STATE_RECENT_K ?? "24"),
    stateWatchMaxPools: Number(process.env.SEARCHER_STATE_WATCH_MAX_POOLS ?? "64"),
    pinnedWarmPoolPath: process.env.SEARCHER_PINNED_WARM_POOLS ?? DEFAULT_PINNED_WARM_POOLS_PATH,
    poolUniversePath,
    poolUniverseManifestPath:
      process.env.SEARCHER_POOL_UNIVERSE_MANIFEST_PATH ??
      `${poolUniversePath}.manifest.json`,
    poolUniverseTopN: Number(process.env.SEARCHER_POOL_UNIVERSE_TOP_N ?? "20000"),
    poolUniverseMinScore: Number(process.env.SEARCHER_POOL_UNIVERSE_MIN_SCORE ?? "1"),
    poolUniverseForceInclude,
    forceIncludePoolIdsPath,
    poolUniverseHighSpreadPairQuota: Number(process.env.SEARCHER_POOL_UNIVERSE_HIGH_SPREAD_PAIR_QUOTA ?? "150"),
    poolUniverseHighSpreadMinFee: Number(process.env.SEARCHER_POOL_UNIVERSE_HIGH_SPREAD_MIN_FEE ?? "10000"),
    pairCompletion: process.env.SEARCHER_PAIR_COMPLETION !== "0",
    recordLiveFixtures: process.env.SEARCHER_RECORD_LIVE_FIXTURES === "1",
    liveFixtureDir: process.env.SEARCHER_LIVE_FIXTURE_DIR ?? resolve("searcher", "live-fixtures"),
    maxProfitBpsOfFlash: BigInt(process.env.SEARCHER_MAX_PROFIT_BPS_OF_FLASH ?? "2000"),
    bribeBps: Number(process.env.SEARCHER_BRIBE_BPS ?? DEFAULT_BRIBE_BPS.toString()),
    bribeAllAboveGas: process.env.SEARCHER_BRIBE_ALL_ABOVE_GAS === "1",
    evGate: process.env.SEARCHER_EV_GATE === "1",
    minNetEth: BigInt(process.env.SEARCHER_MIN_NET_ETH ?? "0"),
    profitHaircutBps: Number(process.env.SEARCHER_PROFIT_HAIRCUT_BPS ?? "0"),
    allowHashOnlySubmit: process.env.SEARCHER_ALLOW_HASHONLY_SUBMIT === "1",
    allowHashOnlyMevShareSubmit: process.env.SEARCHER_SUBMIT_HASHONLY_MEVSHARE === "1",
    victimSourceFilter: {
      enabled: process.env.SEARCHER_VICTIM_SOURCE_FILTER !== "0",
      minStreak: Number(process.env.SEARCHER_VICTIM_SOURCE_MIN_STREAK ?? "3"),
      windowBlocks: Number(process.env.SEARCHER_VICTIM_SOURCE_WINDOW_BLOCKS ?? "200"),
      ringSize: 8,
    },
  };
}

async function main(): Promise<void> {
  // Blind acceptance must be enabled by the process supervisor. Letting .env
  // turn it on would make the nominal production process execute audit-only
  // control paths, while loading .env eagerly would also make the default path
  // pay audit setup costs. This preserves the trusted baseline's inert-default
  // boundary without reviving its legacy block-scan loop.
  const blindAuditProcessValue = process.env.SEARCHER_BLIND_RAW_AUDIT;
  if (blindAuditProcessValue !== "1") {
    loadEnv();
    if (process.env.SEARCHER_BLIND_RAW_AUDIT === "1") {
      throw new Error(
        "SEARCHER_BLIND_RAW_AUDIT must be supplied by the process environment, not .env",
      );
    }
  }
  const blindProductionAudit = blindAuditProcessValue === "1";

  const rpcUrl = liveRpcUrl();

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const protocolDiscoveryArchiveUrl =
    protocolDiscoveryArchiveRpcUrl(rpcUrl);
  const protocolDiscoveryHistoryProvider = protocolDiscoveryArchiveUrl
    ? new ethers.JsonRpcProvider(
        protocolDiscoveryArchiveUrl,
        undefined,
        { batchMaxCount: 1 },
      )
    : undefined;
  let protocolDiscoveryHistoryProviderDestroyed = false;
  const destroyProtocolDiscoveryHistoryProvider = (): void => {
    if (
      !protocolDiscoveryHistoryProvider ||
      protocolDiscoveryHistoryProviderDestroyed
    ) return;
    protocolDiscoveryHistoryProviderDestroyed = true;
    protocolDiscoveryHistoryProvider.destroy();
  };
  console.log(
    `[searcher/live] protocol discovery observed-history=` +
      `${protocolDiscoveryHistoryProvider ? "separate-aligned" : "local"}`,
  );
  const config = buildConfig(provider);
  const blindPrepareBudgetRaw = Number(
    process.env.SEARCHER_BLIND_PREPARE_BUDGET_MS ?? "120000",
  );
  const blindPrepareBudgetMs =
    Number.isSafeInteger(blindPrepareBudgetRaw) && blindPrepareBudgetRaw > 0
      ? blindPrepareBudgetRaw
      : 120_000;
  if (blindProductionAudit && !config.dryRun) {
    throw new Error("blind production audit requires SEARCHER_DRY_RUN=1");
  }
  await validateLiveEnvelope(
    {
      dryRun: config.dryRun,
      evGate: config.evGate,
      bribeBps: config.bribeBps,
      bribeAllAboveGas: config.bribeAllAboveGas,
      minNetEth: config.minNetEth,
      profitHaircutBps: config.profitHaircutBps,
      walletAddress: config.wallet.address,
      botvmAddress: config.botvmAddress,
      configuredBotvmOwner: process.env.BOTVM_OWNER,
      maxWalletEth: process.env.MEV_LIVE_MAX_WALLET_ETH,
    },
    {
      walletBalance: (address) => provider.getBalance(address),
      botvmOwner: async (address) => {
        const contract = new ethers.Contract(
          address,
          ["function owner() view returns (address)"],
          provider,
        );
        return String(await contract.owner());
      },
    },
  );
  const anvilPort = Number(process.env.SEARCHER_ANVIL_PORT ?? "8555");
  const state = new AnvilStateBackend(
    config.rpcUrl,
    `http://127.0.0.1:${anvilPort}`,
    anvilPort,
  );
  if (process.env.SEARCHER_EAGER_STATE_BACKEND === "1") {
    await state.start();
    console.log(`[searcher/live] eager state backend ready port=${anvilPort}`);
  }
  const detector = new BackrunDetector();
  const profitTokenValuation = createProfitTokenValuation();
  const planner = new TemplatePlanner();
  planner.setProfitTokenValuation(profitTokenValuation);
  const maxCandidates = Number(process.env.SEARCHER_MAX_CANDIDATES ?? "20");
  planner.setMaxCandidates(maxCandidates);
  const maxHops = Number(process.env.SEARCHER_MAX_HOPS ?? "3");
  const maxPoolsPerToken = Number(process.env.SEARCHER_MAX_POOLS_PER_TOKEN ?? "8");
  const maxRotationsPerPath = Number(process.env.SEARCHER_MAX_ROTATIONS_PER_PATH ?? "3");
  const enableBlockScan = process.env.SEARCHER_ENABLE_BLOCK_SCAN === "1";
  const blockScanPricingSource = resolveBlockScanPricingSourceMode(
    process.argv.slice(2),
    process.env.SEARCHER_BLOCKSCAN_N_MINUS_ONE_FALLBACK,
  );
  const blockScanNMinusOneFallback =
    blockScanPricingSource.mode === "n-1";
  if (blindProductionAudit && !enableBlockScan) {
    throw new Error("blind production audit requires SEARCHER_ENABLE_BLOCK_SCAN=1");
  }
  if (blindProductionAudit && !config.blockScanSubmit) {
    throw new Error(
      "blind production audit requires SEARCHER_BLOCKSCAN_SUBMIT=1",
    );
  }
  const blockScanMinSpreadBps = Number(
    process.env.SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS ?? "10",
  );
  const blockScanCfg: BlockScanCoreConfig | undefined = enableBlockScan
    ? {
        maxHops: Number(process.env.SEARCHER_BLOCKSCAN_MAX_HOPS ?? "4"),
        minSpreadBps: blockScanMinSpreadBps,
        /*
         * No hard performance gate at 50/100bps: enumeration floor and exact
         * admission are the same. Shadow telemetry still buckets by spread.
         */
        exactAdmissionSpreadBps: Number(
          process.env.SEARCHER_BLOCKSCAN_EXACT_ADMISSION_SPREAD_BPS ??
            String(blockScanMinSpreadBps),
        ),
        minCapitalFraction: Number(
          process.env.SEARCHER_BLOCKSCAN_MIN_CAPITAL_FRACTION ?? "0.001",
        ),
        maxCandidates: Number(process.env.SEARCHER_BLOCKSCAN_MAX_CANDIDATES ?? "100"),
        budgetMs: Number(process.env.SEARCHER_BLOCKSCAN_SCAN_BUDGET_MS ?? "1500"),
        pricedTokens: buildBlockScanPricedTokens(),
      }
    : undefined;
  planner.setMaxHops(maxHops);
  planner.setMaxPoolsPerToken(maxPoolsPerToken);
  planner.setMaxRotationsPerPath(maxRotationsPerPath);
  let blockScanPlanner: TemplatePlanner | undefined;
  let adapterRuntimeCoordinator: AdapterRuntimeCoordinator | undefined;
  const liveRethReadPriority = new LiveRethReadPriority();
  let blockScanStateReadBackend:
    JsonRpcBlockScanStateReadBackend | undefined;
  const blockScanExecutionWorkers: Array<{
    readonly state: AnvilStateBackend;
    readonly solver: AnvilSolver;
    readonly simulator: BotVMSimulator;
  }> = [];
  const blockScanFinalSimulationWorkers: Array<{
    readonly state: AnvilStateBackend;
    readonly solver: AnvilSolver;
    readonly simulator: BotVMSimulator;
  }> = [];
  const blockScanRuntimeAbort = new AbortController();
  let shuttingDown = false;
  const blockScanPassBudgetRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_PASS_BUDGET_MS ?? "11000",
  );
  const blockScanPassBudgetMs = Number.isFinite(blockScanPassBudgetRaw)
    ? Math.max(1, Math.floor(blockScanPassBudgetRaw))
    : 11_000;
  const blockScanNMinusOneStateBudgetRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_N_MINUS_ONE_STATE_BUDGET_MS ?? "40000",
  );
  const blockScanNMinusOneStateBudgetMs =
    Number.isFinite(blockScanNMinusOneStateBudgetRaw)
      ? Math.max(1, Math.floor(blockScanNMinusOneStateBudgetRaw))
      : 40_000;
  const blockScanNMinusOneFamilySettleRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_N_MINUS_ONE_FAMILY_SETTLE_MS ?? "24000",
  );
  const blockScanNMinusOneFamilySettleMs =
    Number.isFinite(blockScanNMinusOneFamilySettleRaw) &&
      blockScanNMinusOneFamilySettleRaw > 0
      ? Math.floor(blockScanNMinusOneFamilySettleRaw)
      : 24_000;
  const blockScanNMinusOneMaxGraphLagRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_N_MINUS_ONE_MAX_GRAPH_LAG_BLOCKS ?? "10",
  );
  const blockScanNMinusOneMaxGraphLagBlocks =
    Number.isFinite(blockScanNMinusOneMaxGraphLagRaw) &&
      blockScanNMinusOneMaxGraphLagRaw > 0
      ? Math.floor(blockScanNMinusOneMaxGraphLagRaw)
      : 10;
  const blockScanLargeGraphPassBudgetRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_LARGE_GRAPH_PASS_BUDGET_MS ?? "30000",
  );
  const blockScanLargeGraphPassBudgetMs = Number.isFinite(blockScanLargeGraphPassBudgetRaw)
    ? Math.max(blockScanPassBudgetMs, Math.floor(blockScanLargeGraphPassBudgetRaw))
    : Math.max(blockScanPassBudgetMs, 30_000);
  const blockScanLargeGraphEdgeThresholdRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_LARGE_GRAPH_EDGE_THRESHOLD ?? "20000",
  );
  const blockScanLargeGraphEdgeThreshold = Number.isFinite(blockScanLargeGraphEdgeThresholdRaw)
    ? Math.max(1, Math.floor(blockScanLargeGraphEdgeThresholdRaw))
    : 20_000;
  const blockScanStartupWarmBudgetRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_STARTUP_PREWARM_BUDGET_MS ?? "300000",
  );
  const blockScanStartupWarmBudgetMs =
    Number.isSafeInteger(blockScanStartupWarmBudgetRaw) &&
      blockScanStartupWarmBudgetRaw > 0
      ? blockScanStartupWarmBudgetRaw
      : 300_000;
  const blockScanHotPricingFamilyBudgetRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_STATE_HOT_FAMILY_BUDGET_MS ?? "5000",
  );
  const blockScanHotPricingFamilyBudgetMs =
    Number.isFinite(blockScanHotPricingFamilyBudgetRaw) &&
      blockScanHotPricingFamilyBudgetRaw > 0
      ? Math.floor(blockScanHotPricingFamilyBudgetRaw)
      : 5_000;
  const blockScanRuntimePublicationReserveRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_RUNTIME_PUBLICATION_RESERVE_MS ?? "1500",
  );
  const blockScanRuntimePublicationReserveMs =
    Number.isFinite(blockScanRuntimePublicationReserveRaw) &&
      blockScanRuntimePublicationReserveRaw > 0
      ? Math.floor(blockScanRuntimePublicationReserveRaw)
      : 1_500;
  const blockScanSolveReserveRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_SOLVE_RESERVE_MS ?? "8000",
  );
  const blockScanSolveReserveMs = Number.isFinite(blockScanSolveReserveRaw)
    ? Math.max(0, Math.floor(blockScanSolveReserveRaw))
    : 8_000;
  const blockScanSolveConcurrencyRaw = Number(process.env.SEARCHER_BLOCKSCAN_SOLVE_CONCURRENCY ?? "4");
  const blockScanSolveConcurrency = Number.isFinite(blockScanSolveConcurrencyRaw)
    ? Math.max(1, Math.floor(blockScanSolveConcurrencyRaw))
    : 4;
  const blockScanFinalSimulationConcurrencyRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_FINAL_SIM_CONCURRENCY ?? "1",
  );
  const blockScanFinalSimulationConcurrency = Number.isFinite(
    blockScanFinalSimulationConcurrencyRaw,
  )
    ? Math.max(1, Math.floor(blockScanFinalSimulationConcurrencyRaw))
    : 1;
  const blockScanRefineCandidatesRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_REFINE_CANDIDATES ?? "512",
  );
  const blockScanRefineCandidates = Number.isFinite(blockScanRefineCandidatesRaw)
    ? Math.max(blockScanCfg?.maxCandidates ?? 0, Math.floor(blockScanRefineCandidatesRaw))
    : 512;
  const blockScanMidConcurrencyRaw = Number(
    process.env.SEARCHER_BLOCKSCAN_MID_CONCURRENCY ?? "24",
  );
  const blockScanMidConcurrency = Number.isFinite(blockScanMidConcurrencyRaw)
    ? Math.max(1, Math.floor(blockScanMidConcurrencyRaw))
    : 24;
  let blockScanRethTransportScheduler: RethTransportScheduler | undefined;
  if (enableBlockScan) {
    const blockScanAnvilPort = Number(process.env.SEARCHER_BLOCKSCAN_ANVIL_PORT ?? "8556");
    const isolatedState = new AnvilStateBackend(
      config.rpcUrl,
      `http://127.0.0.1:${blockScanAnvilPort}`,
      blockScanAnvilPort,
    );
    process.once("exit", () => isolatedState.stop());
    await isolatedState.start();
    console.log(
      `[searcher/live] eager block-scan state backend ready ` +
        `port=${blockScanAnvilPort}`,
    );
    const isolatedPlanner = new TemplatePlanner();
    isolatedPlanner.setProfitTokenValuation(profitTokenValuation);
    isolatedPlanner.setMaxCandidates(maxCandidates);
    isolatedPlanner.setMaxHops(maxHops);
    isolatedPlanner.setMaxPoolsPerToken(maxPoolsPerToken);
    isolatedPlanner.setMaxRotationsPerPath(maxRotationsPerPath);
    blockScanPlanner = isolatedPlanner;
    const isolatedSolver = new AnvilSolver();
    const isolatedSimulator = new BotVMSimulator(
      isolatedState,
      config.botvmAddress,
      config.wallet.address,
    );
    blockScanExecutionWorkers.push({
      state: isolatedState,
      solver: isolatedSolver,
      simulator: isolatedSimulator,
    });
    for (let worker = 1; worker < blockScanSolveConcurrency; worker++) {
      const port = blockScanAnvilPort + worker;
      const workerState = new AnvilStateBackend(
        config.rpcUrl,
        `http://127.0.0.1:${port}`,
        port,
      );
      blockScanExecutionWorkers.push({
        state: workerState,
        solver: new AnvilSolver(),
        simulator: new BotVMSimulator(
          workerState,
          config.botvmAddress,
          config.wallet.address,
        ),
      });
    }
    for (
      let worker = 0;
      worker < blockScanFinalSimulationConcurrency;
      worker++
    ) {
      const port = blockScanAnvilPort + blockScanSolveConcurrency + worker;
      const workerState = new AnvilStateBackend(
        config.rpcUrl,
        `http://127.0.0.1:${port}`,
        port,
      );
      blockScanFinalSimulationWorkers.push({
        state: workerState,
        solver: new AnvilSolver(),
        simulator: new BotVMSimulator(
          workerState,
          config.botvmAddress,
          config.wallet.address,
        ),
      });
    }
    const blockScanStateRpcConcurrency = Math.max(
      1,
      Number(
        process.env.SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_CONCURRENCY ?? "4",
      ),
    );
    blockScanRethTransportScheduler = new RethTransportScheduler({
      capacity: blockScanStateRpcConcurrency * 2,
      producerReserved: blockScanStateRpcConcurrency,
    });
    const familyStateReads = new JsonRpcBlockScanStateReadBackend(config.rpcUrl, {
      maxBatchSize: Math.max(
        1,
        Number(process.env.SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_SIZE ?? "500"),
      ),
      maxConcurrentBatches: blockScanStateRpcConcurrency,
      maxConcurrentMutationProofs: Math.max(
        1,
        Number(
          process.env.SEARCHER_BLOCKSCAN_MUTATION_PROOF_CONCURRENCY ?? "3",
        ),
      ),
      multicallMode:
        process.env.SEARCHER_BLOCKSCAN_STATE_MULTICALL === "1"
          ? "aggregate3"
          : "rpc-batch",
      hardRequestTimeoutMs: Math.max(
        1_000,
        Number(
          process.env.SEARCHER_BLOCKSCAN_STATE_HARD_RPC_TIMEOUT_MS ??
            "45000",
        ),
      ),
      mutationHeaderMode: "debug-raw-header-with-fallback",
      onMutationProofTelemetry: (telemetry) => {
        console.log(
          `[searcher/blockscan-mutation-proof] ${JSON.stringify(telemetry)}`,
        );
      },
      mutationReadPriority: liveRethReadPriority,
      transportScheduler: blockScanRethTransportScheduler,
      transportLane: "producer-bulk",
    });
    /*
     * Funding is intentionally isolated from pricing/proof transport. The two
     * flash providers read every graph asset at current N; sharing the pricing
     * backend's four FIFO slots allowed those balance reads to starve Uni
     * mutation proofs and turned a family-local slowdown into a global miss.
     * aggregate3 preserves exact source-hash pinning while collapsing the
     * funding fan-out into bounded calls on the local node.
     */
    const fundingStateReads = new JsonRpcBlockScanStateReadBackend(
      config.rpcUrl,
      {
        maxBatchSize: Math.max(
          1,
          Number(
            process.env.SEARCHER_BLOCKSCAN_FUNDING_MULTICALL_BATCH_SIZE ??
              "500",
          ),
        ),
        maxConcurrentBatches: Math.max(
          1,
          Number(
            process.env.SEARCHER_BLOCKSCAN_FUNDING_MULTICALL_CONCURRENCY ??
              "4",
          ),
        ),
        multicallMode: "aggregate3",
        transportScheduler: blockScanRethTransportScheduler,
        transportLane: "exact",
      },
    );
    blockScanStateReadBackend = familyStateReads;
    const protocolTouchMode =
      process.env.SEARCHER_BLOCKSCAN_PROTOCOL_TOUCH_MODE ?? "off";
    if (
      protocolTouchMode !== "off" &&
      protocolTouchMode !== "shadow" &&
      protocolTouchMode !== "enabled"
    ) {
      throw new Error(
        "SEARCHER_BLOCKSCAN_PROTOCOL_TOUCH_MODE must be off, shadow or enabled",
      );
    }
    adapterRuntimeCoordinator = new AdapterRuntimeCoordinator(
      PRODUCTION_ADAPTER_FAMILIES,
      new BlockScanStateCoordinator(familyStateReads, {
        // Cold N-1 preparation may legitimately take longer than one live
        // pass. Source-N work is still hard-bounded by the enclosing absolute
        // pass deadline, which is always the tighter limit in the hot loop.
        familyTimeoutMs: Math.max(
          1,
          Number(
            process.env.SEARCHER_BLOCKSCAN_STATE_FAMILY_TIMEOUT_MS ?? "120000",
          ),
        ),
        incrementalRangeBlocks: Math.max(
          1,
          Number(
            process.env.SEARCHER_BLOCKSCAN_INCREMENTAL_RANGE_BLOCKS ??
              "128",
          ),
        ),
        cachePath:
          process.env.SEARCHER_BLOCKSCAN_STATE_CACHE_PATH ??
          "/opt/MEV-runtime/blockscan-state-cache.jsonl",
        protocolAddressTouchMode: protocolTouchMode,
        onProtocolAddressTouchShadowTelemetry: (telemetry) => {
          console.log(
            `[searcher/blockscan-protocol-touch-shadow] ${
              JSON.stringify({ mode: protocolTouchMode, ...telemetry })
            }`,
          );
        },
      }),
      fundingStateReads,
    );
  }
  const solver = new AnvilSolver();
  // Direct provider for v3 tick data — anvil-over-RPC is slow + wrong for TickLens.
  const poolStateCache = new PoolStateCache(provider);
  const blockScanBackrunState = new BlockScanBackrunStateBridge(poolStateCache);
  const poolStateUpdater = new PoolStateUpdater(provider, poolStateCache, {
    maxPools: config.stateWatchMaxPools,
  });
  const fixtureRecorder = new LiveFixtureRecorder(
    config.liveFixtureDir,
    config.recordLiveFixtures,
  );
  const simulator = new BotVMSimulator(state, config.botvmAddress, config.wallet.address);
  const rpcLiveBackend = new RpcAnvilLiveBackend(state, simulator);
  // revm/hybrid backends are constructed after the routing graph is built (they
  // need it to encode the victim overlay); default to rpc until then.
  let liveBackend: LiveStateBackend = rpcLiveBackend;
  const bundleRouter: BundleRouter = createBundleRouter({
    dryRun: config.dryRun,
    wallet: config.wallet,
    provider,
    botvmAddress: config.botvmAddress,
    defaultGasUsed: config.defaultGasUsed,
  });
  const submissionCoordinator = new SubmissionCoordinator({
    blockscanPreemptMarginBps: Number(process.env.SEARCHER_BLOCKSCAN_PREEMPT_MARGIN_BPS ?? 0),
  });

  console.log("[searcher/live] starting V5 searcher");
  try {
    const startupManifest = productionFamilyStartupManifest();
    console.log(
      `[searcher/live] production family startup manifest ` +
        `${startupManifest.manifestHash} ` +
        `families=${startupManifest.familyCount} ` +
        `capabilities=${startupManifest.capabilityCount}`,
    );
  } catch (error) {
    console.warn(
      `[searcher/live] production family startup manifest failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const eventContext = initEvents();
  const blockScanRouteTelemetry =
    await initBlockScanEnumerationSolverTelemetry({
      path: enableBlockScan && !blindProductionAudit
        ? process.env.SEARCHER_BLOCKSCAN_ROUTE_EVENTS_PATH
        : "",
      eventsPath: eventContext.path,
      runId: eventContext.runId,
    });
  if (blockScanRouteTelemetry.enabled) {
    console.log(
      `[searcher/live] block-scan route events emit → ` +
        `${process.env.SEARCHER_BLOCKSCAN_ROUTE_EVENTS_PATH}`,
    );
  }
  console.log(`[searcher/live] runtime_commit=${process.env.SEARCHER_RUNTIME_COMMIT ?? "unavailable"}`);
  const sourceMode = victimSourceMode(
    config.enableBackrun,
    config.enableMempool,
    config.enableMevShare,
  );
  if (blindProductionAudit && sourceMode !== "disabled") {
    throw new Error("blind production audit requires the victim feed to be disabled");
  }
  const victimFeedHash = createHash("sha256").update(JSON.stringify({
    sourceMode,
    mempool: config.enableMempool ? config.wsUrl : null,
    mevShare: config.enableMevShare ? config.mevShareSseUrl : null,
  })).digest("hex");
  console.log(`[searcher/live] victim_feed_hash=0x${victimFeedHash}`);
  console.log(`[searcher/live] backrun=${config.enableBackrun ? "enabled" : "disabled"}`);
  console.log(`[searcher/live] mempool=${config.enableMempool ? "enabled" : "disabled"}`);
  console.log(`[searcher/live] mevshare=${config.enableMevShare ? "enabled" : "disabled"}`);
  console.log(
    `[searcher/live] bribeBps=${config.bribeBps} ` +
      `bribeAllAboveGas=${config.bribeAllAboveGas ? "on" : "off"} ` +
      `maxProfitBpsOfFlash=${config.maxProfitBpsOfFlash} ` +
      `ethUsd=chainlink-canonical-parent`,
  );
  console.log(
    `[searcher/live] evGate=${config.evGate ? "on" : "off"} minNetEth=${config.minNetEth} ` +
      `gasPrice=exact-next-block-eip1559 ` +
      `profitHaircut=${(config.profitHaircutBps / 100).toFixed(0)}% ` +
      `hashOnlyApproxSubmit=${config.allowHashOnlySubmit ? "on" : "off"} ` +
      `hashOnlyMevShareSubmit=${config.allowHashOnlyMevShareSubmit ? "on" : "off"}`,
  );
  console.log(`[searcher/live] wallet=${config.wallet.address}`);
  console.log(`[searcher/live] botvm=${config.botvmAddress}`);
  console.log(`[searcher/live] liveBackend=${config.liveBackend}`);
  console.log(`[searcher/live] minProfitRaw=${config.minProfit}`);
  console.log(`[searcher/live] mode=${config.dryRun ? "dry-run" : "live-submit"}`);
  console.log(
    `[searcher/blockscan] enabled=${enableBlockScan ? "on" : "off"} ` +
      `submit=${config.blockScanSubmit ? "on" : "off"} ` +
      `solveConcurrency=${blockScanSolveConcurrency} ` +
      `refineCandidates=${blockScanRefineCandidates} ` +
      `passBudgetMs=${blockScanPassBudgetMs} ` +
      `largeGraphBudgetMs=${blockScanLargeGraphPassBudgetMs} ` +
      `largeGraphEdges=${blockScanLargeGraphEdgeThreshold} ` +
      `solveReserveMs=${blockScanSolveReserveMs} ` +
      `pricingSource=${blockScanPricingSource.mode} ` +
      `pricingSourceSelection=${blockScanPricingSource.source} ` +
      `nMinusOneFallback=${blockScanNMinusOneFallback ? "on" : "off"} ` +
      `nMinusOneStateBudgetMs=${blockScanNMinusOneStateBudgetMs} ` +
      `nMinusOneFamilySettleMs=${blockScanNMinusOneFamilySettleMs} ` +
      `nMinusOneMaxGraphLagBlocks=${blockScanNMinusOneMaxGraphLagBlocks} ` +
      `(SEARCHER_BLOCKSCAN_SUBMIT=${process.env.SEARCHER_BLOCKSCAN_SUBMIT ?? "0"})`,
  );
  console.log(`[searcher/live] hashOnly=${config.enableHashOnly ? "enabled" : "disabled"}`);
  console.log(
    `[searcher/live] victimSourceFilter enabled=${config.victimSourceFilter.enabled ? "on" : "off"} ` +
      `minStreak=${config.victimSourceFilter.minStreak} ` +
      `windowBlocks=${config.victimSourceFilter.windowBlocks}`,
  );
  console.log(`[searcher/live] maxCandidates=${maxCandidates}`);
  console.log(
    `[searcher/live] maxHops=${maxHops} maxPoolsPerToken=${maxPoolsPerToken} ` +
      `maxRotationsPerPath=${maxRotationsPerPath}`,
  );
  console.log(`[searcher/live] revmPrewarmRouteHops=${config.revmPrewarmRouteHops}`);
  console.log(
    `[searcher/live] stateUpdater=${config.stateUpdaterEnabled ? "enabled" : "disabled"} ` +
      `pinnedK=${config.statePinnedK} recentK=${config.stateRecentK} ` +
      `maxPools=${config.stateWatchMaxPools}`,
  );
  console.log(
    `[searcher/live] quoteSafetyBps=${config.quoteSafetyBps} ` +
      `quoteProfitFloorBps=${config.quoteProfitFloorBps} ` +
      `finalVerifyFloorBps=${config.finalVerifyFloorBps}`,
  );
  console.log(`[searcher/live] pinnedWarmPools=${config.pinnedWarmPoolPath}`);
  console.log(
    `[searcher/live] forceIncludePoolIds=${config.forceIncludePoolIdsPath} ` +
      `merged=${config.poolUniverseForceInclude.length}`,
  );
  console.log(
    `[searcher/live] poolUniverse=${config.poolUniversePath} ` +
      `topN=${config.poolUniverseTopN} minScore=${config.poolUniverseMinScore} ` +
      `highSpreadPairQuota=${config.poolUniverseHighSpreadPairQuota} ` +
      `highSpreadMinFee=${config.poolUniverseHighSpreadMinFee} ` +
      `pairCompletion=${config.pairCompletion ? "on" : "off"}`,
  );
  console.log(
    `[searcher/live] solverDeadlineMs=${config.solverDeadlineMs} ` +
      `oppTtlMs=${config.oppTtlMs} planBudgetMs=${config.planBudgetMs} ` +
      `oppMinSliceMs=${config.oppMinSliceMs} gssMaxTries=${config.gssMaxTries} ` +
      `finalSimTopN=${config.finalSimTopN} ` +
      `maxCandidatesPerOpp=${config.maxCandidatesPerOpp || "unlimited"}`,
  );
  if (config.recordLiveFixtures) {
    console.log(`[searcher/live] recording live fixtures to ${config.liveFixtureDir}`);
  }

  const discoveryBlocks = Number(process.env.SEARCHER_DISCOVERY_BLOCKS ?? "300");
  const discoveryTopN = Number(process.env.SEARCHER_DISCOVERY_TOP_N ?? "100");
  const factoryBlocks = Number(process.env.SEARCHER_FACTORY_BLOCKS ?? "50000");
  const protocolDiscoveryBlocks = Math.max(
    1,
    Number(process.env.SEARCHER_PROTOCOL_DISCOVERY_BLOCKS ?? "300"),
  );
  const protocolDiscoveryShadow = process.env.SEARCHER_PROTOCOL_DISCOVERY_SHADOW === "1";
  const discoveryToBlock = process.env.SEARCHER_DISCOVERY_TO_BLOCK === undefined
    ? await provider.getBlockNumber()
    : Number(process.env.SEARCHER_DISCOVERY_TO_BLOCK);
  if (!Number.isSafeInteger(discoveryToBlock) || discoveryToBlock < 0) {
    throw new Error("SEARCHER_DISCOVERY_TO_BLOCK must be a non-negative safe integer");
  }
  const startupDexSourceBlockHash = await readBlockHash(provider, discoveryToBlock);
  if (blockScanStateReadBackend) {
    const controller = new AbortController();
    const probeTimeoutMs = Math.max(
      1_000,
      Number(
        process.env.SEARCHER_BLOCKSCAN_EIP1898_PROBE_TIMEOUT_MS ??
          "15000",
      ),
    );
    const timer = setTimeout(
      () => controller.abort(
        new Error(
          `EIP-1898 startup probe exceeded ${probeTimeoutMs}ms`,
        ),
      ),
      probeTimeoutMs,
    );
    try {
      await blockScanStateReadBackend.probeEip1898(
        {
          number: discoveryToBlock,
          hash: startupDexSourceBlockHash,
          generation: 0,
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  const startupDexBackend = createPinnedDexReadBackend(provider, discoveryToBlock);
  const refreshIntervalMs = Number(process.env.SEARCHER_REFRESH_INTERVAL_MS ?? "300000"); // 5 min
  // Protocol discovery runs on its own cadence, decoupled from the DEX refresh
  // timer. Both lanes still serialize through one mutation queue below.
  const protocolDiscoveryIntervalMs = Math.max(
    1_000,
    Number(process.env.SEARCHER_PROTOCOL_DISCOVERY_INTERVAL_MS ?? "300000"),
  );
  const protocolDiscoveryMaxCatchupBlocks = Math.max(
    protocolDiscoveryBlocks,
    Number(process.env.SEARCHER_PROTOCOL_DISCOVERY_MAX_CATCHUP_BLOCKS ?? "50000"),
  );
  const protocolDiscoveryStartupFallbackBlocks = Number(
    process.env.SEARCHER_PROTOCOL_DISCOVERY_STARTUP_FALLBACK_BLOCKS ??
      "10000",
  );
  if (
    !Number.isSafeInteger(protocolDiscoveryStartupFallbackBlocks) ||
    protocolDiscoveryStartupFallbackBlocks < 0
  ) {
    throw new Error(
      "SEARCHER_PROTOCOL_DISCOVERY_STARTUP_FALLBACK_BLOCKS must be a non-negative integer",
    );
  }
  const mainnetBackend: TokenQueryBackend = {
    call: async (req) => provider.call(req),
    getLogs: async (req) => provider.send("eth_getLogs", [req]),
  };
  // Declared singleton/compat protocol venues start here. Permissionless
  // families join later only through canonical discovery identity + route probe.
  const liveRegistry = filterLiveProtocolRegistry(POOL_REGISTRY, config.enableProtocolEdges);
  const rawPinnedWarmPools = loadPinnedWarmPools(config.pinnedWarmPoolPath);
  const rawUniversePools = loadPoolUniverse(config.poolUniversePath, {
    maxPools: config.poolUniverseTopN,
    minScore: config.poolUniverseMinScore,
    forceInclude: config.poolUniverseForceInclude,
    highSpreadPairQuota: config.poolUniverseHighSpreadPairQuota,
    highSpreadMinFee: config.poolUniverseHighSpreadMinFee,
  });
  const rawBlockscanUniverse = loadPoolUniverse(config.poolUniversePath, {
    maxPools: 0,
    // Protocol address discovery consumes the complete file-backed DEX token
    // domain. Arb score ranks swap planning; it is not an identity gate for a
    // share token that may expose a protocol conversion route.
    minScore: 0,
  });
  const poolUniverseCoverage = loadPoolUniverseCoverageMetadata(
    config.poolUniversePath,
    config.poolUniverseManifestPath,
  );
  const currentDexUniverseSourceFingerprints =
    productionPoolUniverseSourceFingerprintsStrict();
  let universeCanonicalAnchorMatches = false;
  if (poolUniverseCoverage.source !== null) {
    try {
      const anchor = await provider.getBlock(poolUniverseCoverage.source.number);
      universeCanonicalAnchorMatches = poolUniverseCanonicalAnchorMatches(
        poolUniverseCoverage,
        anchor,
      );
    } catch {
      universeCanonicalAnchorMatches = false;
    }
  }
  const universeRegistryMatches =
    poolUniverseCoverage.manifestVerified &&
    universeCanonicalAnchorMatches &&
    poolUniverseCoverage.toBlock !== null &&
    poolUniverseCoverage.toBlock <= discoveryToBlock &&
    poolUniverseCoverage.registrySourceFingerprints !== null &&
    poolUniverseCoverage.registrySourceFingerprints.length ===
      currentDexUniverseSourceFingerprints.length &&
    poolUniverseCoverage.registrySourceFingerprints.every(
      (fingerprint, index) =>
        fingerprint === currentDexUniverseSourceFingerprints[index],
    );
  // The recent factory window cannot prove landed-event coverage for
  // Curve/DODO/V4/Balancer. Only the actual landed scan may bridge the
  // persisted universe cursor to this startup source.
  const startupLandedDiscoveryFloor = Math.max(
    0,
    discoveryToBlock - discoveryBlocks,
  );
  const dexDiscoveryCursorPath =
    process.env.SEARCHER_DISCOVERY_DEX_CURSOR_PATH ??
    DEFAULT_DEX_DISCOVERY_CURSOR_PATH;
  const loadedDexCursor = blindProductionAudit
    ? null
    : await loadDexDiscoveryCursor(dexDiscoveryCursorPath);
  let dexCursorSourceCompleteThrough: number | null = null;
  if (
    loadedDexCursor !== null &&
    loadedDexCursor.sourceCompleteThrough >= 0 &&
    loadedDexCursor.sourceHash !== null
  ) {
    try {
      const cursorHash = await readBlockHash(
        provider,
        loadedDexCursor.sourceCompleteThrough,
      );
      if (cursorHash.toLowerCase() === loadedDexCursor.sourceHash.toLowerCase()) {
        dexCursorSourceCompleteThrough =
          loadedDexCursor.sourceCompleteThrough;
        console.log(
          `[searcher/live] DEX coverage cursor resumed at block ` +
            `${loadedDexCursor.sourceCompleteThrough}`,
        );
      } else {
        console.warn(
          `[searcher/live] persisted DEX coverage cursor is not canonical ` +
            `at ${loadedDexCursor.sourceCompleteThrough}; ignoring`,
        );
      }
    } catch {
      console.warn(
        `[searcher/live] could not validate persisted DEX coverage cursor ` +
          `at ${loadedDexCursor.sourceCompleteThrough}; ignoring`,
      );
    }
  }
  const trustedThrough = Math.max(
    poolUniverseCoverage.toBlock ?? -1,
    dexCursorSourceCompleteThrough ?? -1,
  );
  const initialDexSourceCompleteThrough =
    resolveInitialDexSourceCompleteThrough({
      universeRegistryMatches,
      universeToBlock: poolUniverseCoverage.toBlock,
      startupLandedDiscoveryFloor,
      discoveryToBlock,
      trustedThrough,
    });
  if (!universeRegistryMatches) {
    console.warn(
      "[searcher/live] pool universe provenance/registry/canonical anchor " +
        "changed or is unverifiable; source completeness will resume from " +
        `max(universe.toBlock, persisted cursor) ` +
        `(universe=${poolUniverseCoverage.toBlock ?? -1}, ` +
        `cursor=${dexCursorSourceCompleteThrough ?? -1})`,
    );
  }
  // F6 Pair C: durable discovery continuity composition is the default
  // strict discovery authority. The file-backed checkpoint store loads and
  // re-verifies the persisted restart state, then logs its status; the
  // point-in-time enumerator restores the checkpoint's durable incumbent
  // inventory and fails closed when it cannot; the checkpoint inventory
  // writer is the CAS entry for discovery producers (the live coordinator
  // call-site is wired below). Complete-snapshot/omission/tombstone remain
  // closed unless a separate independent closure passes.
  const continuityCompositionPath =
    process.env.SEARCHER_DISCOVERY_CONTINUITY_COMPOSITION_PATH ??
    DEFAULT_DISCOVERY_CONTINUITY_CHECKPOINT_PATH;
  let discoveryContinuityStatus = "disabled";
  let discoveryContinuityComposition: DurableDiscoveryContinuityComposition |
    null = null;
  let discoveryInventoryEnumerator: DiscoveryInventoryEnumerator | null = null;
  let discoveryInventoryWriter: DiscoveryCheckpointInventoryWriter | null = null;
  let strictCentralRuntime: CentralAdapterRuntime | null = null;
  let restartTrustedSource: CanonicalSource | null = null;
  let runStrictLivePublicationChain:
    (() => Promise<void>) | null = null;
  const strictLivePublicationChain = createCoalescingPublicationChain(
    (error) => {
      console.warn(
        "[searcher/live] strict live publication chain failed: " +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  if (
    continuityCompositionPath !== undefined &&
    continuityCompositionPath.trim() !== ""
  ) {
    try {
      discoveryContinuityComposition =
        createDurableDiscoveryContinuityComposition({
        catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
        chainId: String((await provider.getNetwork()).chainId),
        sourceRegistryFingerprint: "strict-source-registry-v1",
        checkpointPath: continuityCompositionPath,
        enumerateSnapshotInventory: async (source) => {
          if (discoveryInventoryEnumerator === null) {
            throw new Error(
              "production point-in-time enumerator source is not wired",
            );
          }
          return await discoveryInventoryEnumerator.enumerate(source);
        },
        verifyCanonicalSource: async (source) => {
          const hash = await readBlockHash(provider, source.number);
          if (hash.toLowerCase() !== source.hash.toLowerCase()) {
            throw new Error(
              `discovery continuity checkpoint source hash mismatch at ` +
                `${source.number}`,
            );
          }
        },
        assertGenerationCurrent: (source) => {
          const committed =
            discoveryContinuityComposition?.catalogRoot.capture() ?? null;
          if (
            committed !== null &&
            source.generation <=
              committed.envelope.snapshot.source.generation
          ) {
            throw new Error(
              `strict catalog source generation is stale: ` +
                `${source.generation}`,
            );
          }
        },
      });
      discoveryInventoryEnumerator =
        new CheckpointDiscoveryInventoryEnumerator({
          checkpointStore: discoveryContinuityComposition.store,
        });
      discoveryInventoryWriter =
        new CheckpointDiscoveryInventoryWriter({
          checkpointStore: discoveryContinuityComposition.store,
          checkpointIssuer: discoveryContinuityComposition.checkpointIssuer,
        });
      runStrictLivePublicationChain = async (): Promise<void> => {
          if (
            discoveryInventoryWriter === null ||
            discoveryContinuityComposition === null ||
            strictCentralRuntime === null
          ) {
            return;
          }
          const composition = discoveryContinuityComposition;
          const strictRuntime = strictCentralRuntime;
          // One capture per chain run: checkpoint inventory and the
          // catalogRoot CAS must describe the same publication state.
          const envelope = liveDiscovery.capture();
          if (envelope === null) return;
          const cursor = envelope.protocolObservedCursor;
          if (cursor.completeThroughHash === null) return;
          const previousCatalogRoot =
            discoveryContinuityComposition.catalogRoot.capture();
          // F8: the legacy observed cursor cannot advance (the observed
          // protocol-discovery pass is inert), so pinning the publication
          // source to it would strand every observation behind the anchor.
          // Anchor at the current canonical head instead: recent observations
          // qualify and the strict pipeline stays self-sufficient.
          let sourceBlock = cursor.completeThroughBlock;
          let sourceHash = cursor.completeThroughHash;
          try {
            const headNumber = await provider.getBlockNumber();
            if (
              Number.isSafeInteger(headNumber) &&
              headNumber >= sourceBlock
            ) {
              const headHash = await readBlockHash(provider, headNumber);
              if (/^0x[0-9a-fA-F]{64}$/.test(headHash)) {
                sourceBlock = headNumber;
                sourceHash = headHash.toLowerCase();
              }
            }
          } catch {
            // Keep the cursor anchor on head read failure (fail closed).
          }
          const source = Object.freeze({
            number: sourceBlock,
            hash: sourceHash,
            generation:
              (previousCatalogRoot?.envelope.snapshot.source.generation ?? -1) +
              1,
          });
          const addressObservations =
            deriveLiveDiscoveryAddressSurfaceObservations({
              publication: envelope,
              source,
              catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
              familyIdForAdapter: (adapterId) =>
                resolveStrictFamilyIdForAdapter(
                  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
                  adapterId,
                ),
            });
          const eventObservations =
            deriveLiveDiscoveryEventObservations({
              events: envelope.protocolEvidenceCache.runtime.observedEvents,
              source,
              catalog:
                PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
            });
          const observations = mergeFamilyObservations(
            addressObservations,
            eventObservations,
          );
          if (observations.size === 0) return;
          if (previousCatalogRoot !== null) {
            const previousSource =
              previousCatalogRoot.envelope.snapshot.source;
            const transition = await resolveCanonicalSourceTransition(
              provider,
              previousSource,
              source,
            );
            if (transition !== "canonical-descendant") {
              console.warn(
                `[searcher/live] strict catalog publish skipped: ` +
                  `source transition is not canonical-descendant ` +
                  `${previousSource.number}->${source.number}`,
              );
              return;
            }
          }
          const publications = [];
          // Small families first: a handful of verified nominations (for
          // example fluid-dex) publish before the large erc4626 cohort
          // saturates the node RPC with base identity reads.
          const familyEntries = [...observations.entries()].sort(
            (left, right) => left[1].length - right[1].length,
          );
          for (const [familyId, familyObservations] of familyEntries) {
            try {
              publications.push(Object.freeze({
                familyId,
                publication: await runStrictFamilyLifecycle({
                  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
                  familyId,
                  source,
                  observations: familyObservations,
                  runtime: strictCentralRuntime,
                }),
              }));
            } catch (error) {
              console.warn(
                "[searcher/live] strict lifecycle failed for " +
                  `${familyId}: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (publications.length === 0) return;
          const result = await publishStrictCatalogFromLifecycle({
            composition: discoveryContinuityComposition,
            catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
            source,
            publications: Object.freeze(publications),
            verifyCarriedInstance: async ({
              familyId,
              lineageId,
              instanceKey,
              current,
            }) => {
              const committedRoot =
                composition.catalogRoot.capture();
              if (committedRoot === null) return null;
              const carried = [...committedRoot.envelope.privateState
                .instances.values()].find((entry) =>
                  entry.familyId === familyId &&
                  entry.lineageId === lineageId &&
                  entry.instanceKey === instanceKey
                );
              if (carried === undefined || !("descriptor" in carried.value)) {
                return null;
              }
              return reverifyCarriedInstanceContinuity({
                catalog:
                  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
                familyId,
                instance: carried.value,
                current,
                runtime: strictRuntime,
                readAddressSurface: async (address, at) => {
                  try {
                    const [code, word] = await Promise.all([
                      provider.getCode(address, at.number),
                      provider.getStorage(
                        "0x360894a13ba1a3210667c828492db98dca3e2076" +
                          "cc3735a920a3ca505d382bbc",
                        address,
                        at.number,
                      ),
                    ]);
                    return Object.freeze({
                      codeHash: ethers.keccak256(code),
                      implementationWord: word.toLowerCase(),
                    });
                  } catch {
                    return null;
                  }
                },
              });
            },
          });
          console.log(
            `[searcher/live] strict catalog live publisher ` +
              `${result.status}` +
              (result.status === "unresolved" ? `: ${result.reason}` : ""),
          );
          if (result.status !== "published") return;
          const committedRoot =
            discoveryContinuityComposition.catalogRoot.capture();
          if (committedRoot !== null) {
            console.log(
              `[searcher/live] strict catalog root committed: ` +
                `revision=${committedRoot.envelope.snapshot.revision} ` +
                `instances=${committedRoot.envelope.privateState.instances.size} ` +
                `pricing=${committedRoot.views.pricingByPublicationKey.size}`,
            );
          }
          // The durable checkpoint follows the committed catalogRoot CAS at
          // the same source, so appliedThrough never leads the recoverable
          // strict authority.
          const derived = deriveLiveDiscoveryCheckpointInventory({
            publication: envelope,
            source,
            catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
            familyIdForAdapter: (adapterId) =>
              resolveStrictFamilyIdForAdapter(
                PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
                adapterId,
              ),
          });
          const writeResult = await discoveryInventoryWriter.write({
            source,
            watermarks: derived.watermarks,
            inventoryFamilies: derived.inventoryFamilies,
          });
          console.log(
            `[searcher/live] discovery checkpoint inventory ` +
              `${writeResult.status}`,
          );
        };
      const loaded = await discoveryContinuityComposition.loadForRestart();
      discoveryContinuityStatus = loaded.status;
      if (loaded.status === "trusted") {
        restartTrustedSource = loaded.snapshot.source;
      }
      console.log(
        `[searcher/live] discovery continuity composition ` +
          `${discoveryContinuityStatus}`,
      );
      console.log(
        `[searcher/live] discovery continuity inventory writer ready`,
      );
    } catch (error) {
      discoveryContinuityStatus =
        `failed:${error instanceof Error ? error.message : String(error)}`;
      console.warn(
        `[searcher/live] discovery continuity composition ` +
          `${discoveryContinuityStatus}`,
      );
    }
  }
  // F8: install the committed strict views provider for the legacy-shaped
  // runtime bridges (blockscan pricing + funding reads). The projection's
  // pricing/funding capabilities read the strict publication through this
  // central holder; absent composition or committed publication fails closed
  // (no mids / no offers), never a legacy read.
  setProductionStrictViewsProvider(
    () => discoveryContinuityComposition?.catalogRoot.capture()?.views ?? null,
  );
  // Strict catalog consumer diagnostic (shadow/diagnostic; OFF by default).
  // SEARCHER_STRICT_CATALOG_CONSUMER=1 resolves the currently committed
  // strict views through the source-bound consumer and logs a redacted
  // summary. It never feeds the solver and never falls back to the legacy
  // registry; this grants no default-authority cutover.
  if (process.env.SEARCHER_STRICT_CATALOG_CONSUMER === "1") {
    let strictConsumerStatus: string;
    try {
      const committed =
        discoveryContinuityComposition?.catalogRoot.capture() ?? null;
      strictConsumerStatus = committed === null
        ? "no-committed-publication"
        : resolveStrictCatalogConsumerDiagnostic({
            composition: discoveryContinuityComposition,
            source: committed.views.source,
            generation: committed.views.source.generation,
          });
    } catch (error) {
      strictConsumerStatus =
        `failed:${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(
      `[searcher/live] strict catalog consumer diagnostic ` +
        strictConsumerStatus,
    );
  }
  // Strict solver consumer (solver-shaped wiring; OFF by default).
  // SEARCHER_STRICT_SOLVER_CONSUMER=1 resolves the complete strict read
  // surface (every pricing mid, funding offer and credit route) through the
  // source-bound consumer and logs counts. It never feeds the legacy
  // registry; the planner call-site remains part of the default-authority
  // cutover and is not enabled here.
  if (process.env.SEARCHER_STRICT_SOLVER_CONSUMER === "1") {
    let strictSolverStatus: string;
    try {
      const committed =
        discoveryContinuityComposition?.catalogRoot.capture() ?? null;
      strictSolverStatus = committed === null
        ? "no-committed-publication"
        : resolveStrictSolverConsumer({
            composition: discoveryContinuityComposition,
            source: committed.views.source,
            generation: committed.views.source.generation,
          });
    } catch (error) {
      strictSolverStatus =
        `failed:${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(
      `[searcher/live] strict solver consumer ` + strictSolverStatus,
    );
  }
  let protocolGraphCompleteThrough = -1;
  const rawBlockScanOverrides = loadBlockScanViewOverrides();
  // F6 Pair B: strict identity attestation (catalog + plugin identity stage)
  // is the only startup identity authority; the legacy IdentityResolverRegistry
  // path has been removed.
  const [pinnedIdentity, universeIdentity, blockscanIdentity, overrideIdentity] =
    await attestStartupPoolSetsStrict({
      provider: strictIdentityProvider(provider),
      source: {
        number: discoveryToBlock,
        hash: startupDexSourceBlockHash.toLowerCase(),
        generation: discoveryToBlock,
      },
      poolSets: [
        rawPinnedWarmPools,
        rawUniversePools,
        rawBlockscanUniverse,
        rawBlockScanOverrides,
      ],
    });
  // F6 Pair B: strict attestation returns a narrower rejected shape; bridge
  // it back to the legacy RejectedPoolIdentity for the transition consumers.
  const asLegacyRejections = (
    rejected: readonly {
      readonly address: string;
      readonly adapter: string;
      readonly reason: string;
    }[],
  ): RejectedPoolIdentity[] => rejected.map((entry) => Object.freeze({
    address: entry.address,
    adapter: entry.adapter,
    reason: entry.reason as PoolIdentityFailureReason,
  }));
  const pinnedWarmPools = [
    ...pinnedIdentity.accepted,
  ] as unknown as PinnedWarmPoolEntry[];
  const universePools = [...universeIdentity.accepted] as PoolEntry[];
  const blockscanUniverse = [...blockscanIdentity.accepted] as PoolEntry[];
  const blockScanOverrides = [...overrideIdentity.accepted] as PoolEntry[];
  logIdentityRejections("pinned", asLegacyRejections(pinnedIdentity.rejected));
  logIdentityRejections("universe", asLegacyRejections(universeIdentity.rejected));
  logIdentityRejections(
    "blockscan-universe",
    asLegacyRejections(blockscanIdentity.rejected),
  );
  logIdentityRejections(
    "blockscan-overrides",
    asLegacyRejections(overrideIdentity.rejected),
  );
  const startupRetryableIdentityPools = [
    ...retryableIdentityCandidates(
      rawPinnedWarmPools,
      asLegacyRejections(pinnedIdentity.rejected),
    ),
    ...retryableIdentityCandidates(
      rawUniversePools,
      asLegacyRejections(universeIdentity.rejected),
    ),
    ...retryableIdentityCandidates(
      rawBlockscanUniverse,
      asLegacyRejections(blockscanIdentity.rejected),
    ),
    ...retryableIdentityCandidates(
      rawBlockScanOverrides,
      asLegacyRejections(overrideIdentity.rejected),
    ),
  ];
  const retryableDexIdentityPools = new Map(
    mergePoolRegistries([], startupRetryableIdentityPools).map((pool) => [
      poolRegistryKey(pool),
      pool,
    ] as const),
  );
  const landedPoolDiscoveryRegistry =
    PRODUCTION_ADAPTER_FAMILIES.landedPoolDiscovery();
  const startupFamilyMaterializationRetries = [
    ...retryableDexIdentityPools.values(),
  ].filter((pool) =>
    landedPoolDiscoveryRegistry.consumesMaterializationRetries(pool.adapter)
  );

  // Phase 1: Factory event indexing — discover ALL pools created in recent N blocks
  const factoryPools = await indexFactoryPools(
    provider,
    factoryBlocks,
    discoveryToBlock,
    { strict: true },
  );
  // Phase 2: Swap event discovery — find most active pools (may include Curve etc.)
  const startupActivePoolDiscovery = await scanActivePoolsDetailed(
    provider,
    discoveryBlocks,
    Number.POSITIVE_INFINITY,
    discoveryToBlock,
    {
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
      identityBackend: startupDexBackend,
      identityBlockTag: discoveryToBlock,
      // Reuse the current-N admitted, full file-backed family inventory when
      // singleton events expose only opaque identities (for example a V4
      // poolId). The family materializer validates the retained shape before
      // accepting it; genuinely new identities still take the normal on-chain
      // backfill path.
      retainedPools: blockscanUniverse,
      retryablePools: startupFamilyMaterializationRetries,
      ...(protocolDiscoveryHistoryProvider === undefined
        ? {}
        : {
            historicalLogProvider: protocolDiscoveryHistoryProvider,
            historicalLogAnchor: {
              blockNumber: discoveryToBlock,
              blockHash: startupDexSourceBlockHash,
            },
          }),
      topicScanMode: "union",
      strict: true,
    },
  );
  for (const pool of startupFamilyMaterializationRetries) {
    retryableDexIdentityPools.delete(poolRegistryKey(pool));
  }
  for (const pool of startupActivePoolDiscovery.retryablePools) {
    retryableDexIdentityPools.set(poolRegistryKey(pool), pool);
  }
  const swapPools = [...startupActivePoolDiscovery.pools];
  const routeFamilies = PRODUCTION_ADAPTER_FAMILIES.routes();
  const familyIdForStartupPool = (pool: PoolEntry): string | null =>
    routeFamilies.findForPool(pool.adapter)?.id ?? null;
  // Merge: protocol contracts + pinned backbone + file-backed active universe + discovered pools.
  // Apply the registry-declared family admission switch. No venue identity is
  // interpreted here; families that do not require the switch remain active.
  const incumbentPools =
    mergePoolRegistries(
      mergePoolRegistries(
        mergePoolRegistries(liveRegistry, pinnedWarmPools),
        universePools,
      ),
      factoryPools,
    );
  const basePools = mergeStartupActivePoolDiscovery(
    incumbentPools,
    startupActivePoolDiscovery,
    familyIdForStartupPool,
  );
  const startupBlockscanUniverse = filterStartupActivePoolIncumbents(
    blockscanUniverse,
    startupActivePoolDiscovery,
    familyIdForStartupPool,
  );
  const startupBlockScanOverrides = filterStartupActivePoolIncumbents(
    blockScanOverrides,
    startupActivePoolDiscovery,
    familyIdForStartupPool,
  );
  const suppressedDexPoolKeys = new Set(
    startupActivePoolDiscovery.cacheRevalidation.stalePoolKeys,
  );
  const pairCompletionCandidates = config.pairCompletion
    ? selectPairCompletionPools(
      basePools,
      startupBlockscanUniverse,
    )
    : [];
  const allPools = mergePoolRegistries(basePools, pairCompletionCandidates);
  const pairCompletionAdded = allPools.length - basePools.length;
  console.log(
    `[searcher/live] pair-completion: +${pairCompletionAdded} alternate-venue pools` +
      (config.pairCompletion ? "" : " (disabled)"),
  );
  console.log(
    `[searcher/live] protocolEdges=${config.enableProtocolEdges
      ? "enabled"
      : "disabled (registry-gated protocol venues off)"}`,
  );
  console.log(
    `[searcher/live] pool registry: ${liveRegistry.length} protocol + ` +
      `${pinnedWarmPools.length} pinned + ${universePools.length} universe ` +
      `(forceInclude=${config.poolUniverseForceInclude.length}) + ` +
      `${factoryPools.length} factory + ${swapPools.length} swap-active + ` +
      `${pairCompletionAdded} pair-completion = ` +
      `${allPools.length} total`,
  );
  const strategyViewOptions = {
    blockscanMaxPools: Number(process.env.SEARCHER_BLOCKSCAN_VIEW_MAX_POOLS ?? 6000),
    poolUniverseGeneratedAt: loadPoolUniverseGeneratedAt(config.poolUniversePath),
  };
  const rebuildStrategyViews = (
    backrunPools: PoolEntry[],
    suppressedSupplementalPoolKeys: ReadonlySet<string> = new Set<string>(),
  ) => buildStrategyViews(
    backrunPools,
    blockscanUniverse.filter((pool) =>
      !suppressedSupplementalPoolKeys.has(poolProjectionRowKey(pool))
    ),
    blockScanOverrides.filter((pool) =>
      !suppressedSupplementalPoolKeys.has(poolProjectionRowKey(pool))
    ),
    strategyViewOptions,
  );
  let strategyViews = buildStrategyViews(
    allPools,
    startupBlockscanUniverse,
    startupBlockScanOverrides,
    strategyViewOptions,
  );
  let protocolDiscoveryOwnership: ProtocolDiscoveryOwnership =
    EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP;
  // Family membership and candidate-source lanes are owned by the strict
  // catalog projection. Legacy adapter objects supply only matcher details
  // (topics/selectors) for evidence fingerprints, never membership.
  const enabledProtocolDiscoveryFamilySources =
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
      .discoverableFamilySources()
      .filter((entry) =>
        !PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
          .requiresProtocolEdgesFlagFor(entry.familyId) ||
        config.enableProtocolEdges
      );
  const enabledProtocolDiscoveryFamilyIds = new Set<string>(
    enabledProtocolDiscoveryFamilySources.map((entry) => entry.familyId),
  );
  const enabledProtocolDiscoveryMatcherAdapters =
    PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes().filter((adapter) =>
      enabledProtocolDiscoveryFamilyIds.has(adapter.id)
    );
  // Family × candidate-source completeness is owned by the discovery
  // coordinator. One current address-domain scan cannot make an observed-only
  // sibling family complete.
  const protocolDiscoveryCoverage =
    new ProtocolDiscoveryCoverageCoordinator(
      enabledProtocolDiscoveryFamilySources,
    );
  const adapterFamilyGraphViews = new AdapterFamilyGraphViewCoordinator(
    PRODUCTION_ADAPTER_FAMILIES,
    protocolDiscoveryCoverage,
  );
  let lastProtocolDiscoveryBlock = -1;
  console.log(
    `[searcher/live] strategy views: backrun=${strategyViews.backrun.length} ` +
      `blockscan=${strategyViews.blockscan.length} ` +
      `view_version=${strategyViews.versions.strategy_view_version} ` +
      `blockscan_view_hash=${strategyViews.versions.blockscan_view_hash} ` +
      `discovery_to_block=${discoveryToBlock}`,
  );
  if (!blindProductionAudit) {
    dumpRuntimeGraphPools(strategyViews.backrun);
    dumpRuntimeGraphPools(
      strategyViews.blockscan,
      DEFAULT_RUNTIME_BLOCKSCAN_POOLS_PATH,
    );
  }

  // Build routing graph from all pools. File-backed universe entries can carry
  // token0/token1 metadata, so V2/V3 graph construction avoids per-pool token
  // eth_call unless the generated file is missing that metadata.
  // Factory pools are queried for token0/token1 in parallel batches.
  // This is ~1500 eth_call pairs at startup but gives full routing coverage.
  const backrunGraphBuild = await buildTokenGraphWithResults(
    startupDexBackend,
    strategyViews.backrun,
  );
  logProvisionalV2GraphInstances("backrun", backrunGraphBuild.successful);
  const graph = backrunGraphBuild.edges;
  logRuntimeRefreshFailures(backrunGraphBuild.failed, "graph build skipped");
  const retryableDexGraphPools = new Map(
    backrunGraphBuild.failed.map((failure) => [
      poolRegistryKey(failure.pool),
      failure.pool,
    ] as const),
  );
  let blockScanGraph: TokenEdge[] | undefined;
  if (enableBlockScan) {
    const blockscanGraphBuild = await buildTokenGraphWithResults(
      startupDexBackend,
      strategyViews.blockscan,
    );
    logProvisionalV2GraphInstances("blockscan", blockscanGraphBuild.successful);
    blockScanGraph = blockscanGraphBuild.edges;
    logRuntimeRefreshFailures(blockscanGraphBuild.failed, "blockscan graph build skipped");
    for (const failure of blockscanGraphBuild.failed) {
      retryableDexGraphPools.set(poolRegistryKey(failure.pool), failure.pool);
    }
    blockScanPlanner?.setGraph(blockScanGraph);
    const blockscanGraphHash = hashTokenGraph(blockScanGraph);
    console.log(
      `[searcher/blockscan] graph built: edges=${blockScanGraph.length} ` +
        `from blockscan view=${strategyViews.blockscan.length} ` +
      `blockscan_graph_hash=${blockscanGraphHash}`,
    );
  }
  const startupDexCanonicalHash = await readBlockHash(provider, discoveryToBlock);
  assertDexSourceHashStable(
    discoveryToBlock,
    startupDexSourceBlockHash,
    startupDexCanonicalHash,
  );
  let dexGraphCoverage = createDexGraphCoverageState({
    sourceCompleteThrough: initialDexSourceCompleteThrough,
    // A source-complete scan and executable projection are separate proofs.
    // Failed pool projections stay retryable without erasing the source cursor.
    graphCompleteThrough:
      retryableDexGraphPools.size === 0 &&
        retryableDexIdentityPools.size === 0
      ? initialDexSourceCompleteThrough
      : -1,
  });
  const protocolCandidateDomain = new ProtocolDiscoveryCandidateDomain({
    registry: PRODUCTION_ADAPTER_FAMILIES,
    dexUniverse: rawBlockscanUniverse,
  });
  const protocolDexDomainFor = (
    backrunEdges: readonly TokenEdge[],
    blockscanEdges: readonly TokenEdge[] | undefined,
  ): string[] => protocolCandidateDomain.graphTokens(
    backrunEdges,
    blockscanEdges,
  );
  const currentProtocolDexDomain = (): string[] =>
    protocolDexDomainFor(graph, blockScanGraph);
  const protocolAddressCandidatesFor = (
    backrunEdges: readonly TokenEdge[],
    blockscanEdges: readonly TokenEdge[] | undefined,
  ): string[] => protocolCandidateDomain.addresses(
    backrunEdges,
    blockscanEdges,
  );
  const currentProtocolAddressCandidates = (): string[] =>
    protocolAddressCandidatesFor(graph, blockScanGraph);
  const protocolGraphBefore = graph.filter((edge) => edge.slotKind === "protocol");
  const protocolEdgeKeysBefore = new Set(protocolGraphBefore.map(protocolEdgeKey));
  const protocolDiscoveryCachePath = process.env.SEARCHER_PROTOCOL_DISCOVERY_CACHE_PATH ??
    DEFAULT_PROTOCOL_DISCOVERY_CACHE_PATH;
  const protocolDiscoveryChainId = (await provider.getNetwork()).chainId;
  const protocolDiscoveryCache = blindProductionAudit
    ? createProtocolDiscoveryEvidenceCache(protocolDiscoveryChainId)
    : loadProtocolDiscoveryEvidenceCache(
        protocolDiscoveryCachePath,
        protocolDiscoveryChainId,
      );
  // Salt the registry fingerprint with cursor semantics so a cursor persisted
  // by the former recent-window-as-complete implementation is invalidated once
  // instead of being trusted as contiguous history after upgrade.
  const observedSourceFingerprint = `0x${createHash("sha256")
    .update(PROTOCOL_CURSOR_SEMANTICS_VERSION)
    .update(":")
    .update(protocolObservedSourceFingerprint(
      enabledProtocolDiscoveryMatcherAdapters,
    ))
    .digest("hex")}`;
  const discoverySourceFingerprints = protocolDiscoverySourceFingerprints(
    enabledProtocolDiscoveryMatcherAdapters,
  );
  let observedSourceChanged = updateProtocolObservedSourceFingerprint(
    protocolDiscoveryCache,
    observedSourceFingerprint,
    discoverySourceFingerprints,
  );
  const observedDiscoveryFamilyIds = new Set(
    enabledProtocolDiscoveryFamilySources
      .filter((entry) =>
        entry.sourceIds.includes("observed-interaction")
      )
      .map((entry) => entry.familyId),
  );
  const persistedObservedCursor = protocolDiscoveryCache.runtime.observedCursor;
  const persistedObservedCursorHash =
    protocolDiscoveryCache.runtime.observedCursorHash;
  if (persistedObservedCursor !== null) {
    const canonicalCursorHash = persistedObservedCursor <= discoveryToBlock
      ? await readBlockHash(provider, persistedObservedCursor)
      : null;
    if (
      canonicalCursorHash === null ||
      !protocolObservedCursorAnchorMatches(
        protocolDiscoveryCache,
        persistedObservedCursor,
        canonicalCursorHash,
      )
    ) {
      console.warn(
        `[searcher/live] protocol observed cursor anchor invalid; ` +
          `cursor=${persistedObservedCursor} cached_hash=` +
          `${persistedObservedCursorHash ?? "missing"} canonical_hash=` +
          `${canonicalCursorHash ?? "unavailable"}; rebuilding canonical history`,
      );
      invalidateProtocolObservedHistory(
        protocolDiscoveryCache,
        observedDiscoveryFamilyIds,
      );
      observedSourceChanged = true;
    }
  }
  const persistedObservedAuthority =
    protocolDiscoveryCache.runtime.observedContiguousAuthority;
  if (persistedObservedAuthority !== null) {
    const canonicalAuthorityHash = await readBlockHash(
      provider,
      persistedObservedAuthority.completeThroughBlock,
    );
    if (
      canonicalAuthorityHash !==
        persistedObservedAuthority.completeThroughHash
    ) {
      console.warn(
        `[searcher/live] protocol contiguous authority invalid; ` +
          `cursor=${persistedObservedAuthority.completeThroughBlock} ` +
          `cached_hash=${persistedObservedAuthority.completeThroughHash} ` +
          `canonical_hash=${canonicalAuthorityHash ?? "unavailable"}`,
      );
      protocolDiscoveryCache.runtime.observedContiguousAuthority = null;
    }
  }
  const protocolDiscoveryStartup = planDiscoveryStartup({
    targetBlock: discoveryToBlock,
    persistedCursor: protocolDiscoveryCache.runtime.observedCursor,
    sourceRegistryChanged: observedSourceChanged,
    recentBlocks: protocolDiscoveryBlocks,
    maxCatchupBlocks: protocolDiscoveryMaxCatchupBlocks,
    bootstrapMode: "recent-positive",
  });
  const observedAuthority =
    protocolDiscoveryCache.runtime.observedContiguousAuthority;
  const initialProtocolObservedCoverageAuthoritative =
    protocolDiscoveryStartup.mode === "contiguous" &&
    observedAuthority?.completeThroughBlock ===
      protocolDiscoveryStartup.cursorBefore;
  const cachedObservedCursor =
    protocolDiscoveryCache.runtime.observedCursor ?? -1;
  lastProtocolDiscoveryBlock = cachedObservedCursor;
  let lastProtocolDiscoveryBlockHash =
    cachedObservedCursor >= 0
      ? protocolDiscoveryCache.runtime.observedCursorHash
      : null;
  // F8: the legacy observed protocol-discovery pass is inert (the strict
  // pipeline owns discovery), so a persisted legacy observed cursor can no
  // longer advance. Without one, the strict publisher would block forever on
  // a null cursor; anchor it at the startup discovery source instead (the
  // canonical hash is read and stability-asserted at startup).
  if (
    lastProtocolDiscoveryBlockHash === null &&
    startupDexSourceBlockHash !== null &&
    startupDexSourceBlockHash !== ""
  ) {
    lastProtocolDiscoveryBlock = discoveryToBlock;
    lastProtocolDiscoveryBlockHash = startupDexSourceBlockHash;
  }
  if (observedAuthority !== null) {
    protocolDiscoveryCoverage.seedObserved(
      observedAuthority.completeThroughBlock,
    );
  }
  if (observedSourceChanged) {
    console.warn(
      `[searcher/live] protocol observed-source registry changed; ` +
        `startup_positive_only=${protocolDiscoveryStartup.range.fromBlock}-` +
        `${protocolDiscoveryStartup.range.toBlock} ` +
        `fingerprint=${observedSourceFingerprint}`,
    );
  } else if (!initialProtocolObservedCoverageAuthoritative) {
    console.warn(
      `[searcher/live] protocol discovery has no authoritative cursor; ` +
        `startup_positive_only=${protocolDiscoveryStartup.range.fromBlock}-` +
        `${protocolDiscoveryStartup.range.toBlock}`,
    );
  } else if (protocolDiscoveryStartup.range.toBlock < discoveryToBlock) {
    console.warn(
      `[searcher/live] protocol discovery cursor catch-up chunk: ` +
        `range=${protocolDiscoveryStartup.range.fromBlock}-` +
        `${protocolDiscoveryStartup.range.toBlock} ` +
        `remaining_through=${discoveryToBlock} ` +
        `cap=${protocolDiscoveryMaxCatchupBlocks}`,
    );
  }
  // Reload persisted route ownership as retained CANDIDATES only: edges were
  // stripped at save time, so nothing routes until this pass re-attests and
  // re-probes each instance. Incumbent static edges participate later in
  // semantic-route arbitration; address equality is never an admission gate.
  if (protocolDiscoveryCache.routeOwnership.admissions.length > 0) {
    const reloadedAdmissions = new Map(
      protocolDiscoveryCache.routeOwnership.admissions
        .map((item) => [
          protocolInstanceKey(item.adapterId, item.instance.pool),
          { adapterId: item.adapterId, instance: item.instance, edges: [], claims: [] },
        ] as const),
    );
    protocolDiscoveryOwnership = {
      version: protocolDiscoveryCache.routeOwnership.version,
      admissions: reloadedAdmissions,
    };
  }
  const persistProtocolDiscoveryEvidence = (result: ProtocolDiscoveryResult): void => {
    if (blindProductionAudit || protocolDiscoveryShadow) return;
    // evaluatedInstanceKeys excludes retryable identity/probe failures, so
    // per-key reconciliation is safe even when an unrelated source read failed.
    reconcileProtocolDiscoveryEvidenceCache(protocolDiscoveryCache, result);
    recordProtocolRouteOwnership(protocolDiscoveryCache, protocolDiscoveryOwnership);
    // Ownership must be materialized before pruning: the capacity cap is an
    // optimization and may never evict a newly admitted active instance.
    pruneProtocolDiscoveryAddressCache(protocolDiscoveryCache, {
      currentBlock: discoveryToBlock,
    });
    try {
      saveProtocolDiscoveryEvidenceCache(protocolDiscoveryCachePath, protocolDiscoveryCache);
    } catch (error) {
      console.warn(
        `[searcher/live] protocol discovery cache write failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const initialProtocolGraphTokens = currentProtocolDexDomain();
  const initialProtocolAddressCandidates = currentProtocolAddressCandidates();
  // One memo across the live observed lane and the range scanner: a landed tx
  // is debug_traced at most once no matter which entrance sees it first.
  let protocolTraceMemo = createProtocolTraceMemo();
  console.log(
    `[searcher/live] protocol discovery cache: address=${protocolDiscoveryCache.addressEntries.size} ` +
      `verified=${protocolDiscoveryCache.verifiedCandidates.size} ` +
      `cursor=${protocolDiscoveryCache.runtime.observedCursor ?? "none"} ` +
      `ownership=${protocolDiscoveryCache.routeOwnership.admissions.length} ` +
      `path=${protocolDiscoveryCachePath}`,
  );
  const initialProtocolDiscoveryRange = protocolDiscoveryStartup.range;
  const initialProtocolRangeHashBefore = await readBlockHash(
    provider,
    initialProtocolDiscoveryRange.toBlock,
  );
  const initialProtocolDiscovery = await prepareActiveProtocolDiscoveryPass({
    provider,
    ...(protocolDiscoveryHistoryProvider === undefined
      ? {}
      : { observedHistoryProvider: protocolDiscoveryHistoryProvider }),
    adapters: PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes(),
    identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
    protocolEdgesEnabled: config.enableProtocolEdges,
    chainId: protocolDiscoveryChainId,
    probeExecutor: config.botvmAddress,
    currentOwnership: protocolDiscoveryOwnership,
    currentBackrunPools: strategyViews.backrun,
    currentBackrunGraph: graph,
    currentBlockscanGraph: blockScanGraph,
    buildStrategyViews: rebuildStrategyViews,
    blockNumber: discoveryToBlock,
    fromBlock: initialProtocolDiscoveryRange.fromBlock,
    toBlock: initialProtocolDiscoveryRange.toBlock,
    graphTokens: initialProtocolGraphTokens,
    candidateAddresses: initialProtocolAddressCandidates,
    evidenceCache: protocolDiscoveryCache,
    bootstrapCandidates: cachedProtocolCandidates(protocolDiscoveryCache),
    ...(!blindProductionAudit &&
        initialProtocolDiscoveryRange.fromBlock > 0 &&
        protocolDiscoveryStartupFallbackBlocks > 0
      ? {
          startupFallback: {
            searchBeforeBlock: initialProtocolDiscoveryRange.fromBlock - 1,
            maxLookbackBlocks: protocolDiscoveryStartupFallbackBlocks,
          },
        }
      : {}),
    traceMemo: protocolTraceMemo,
    shadow: protocolDiscoveryShadow,
  });
  const initialProtocolRangeHashAfter = await readBlockHash(
    provider,
    initialProtocolDiscoveryRange.toBlock,
  );
  assertDexSourceHashStable(
    initialProtocolDiscoveryRange.toBlock,
    initialProtocolRangeHashBefore,
    initialProtocolRangeHashAfter,
  );
  emitProtocolDiscoveryEvents(
    initialProtocolDiscovery.result.events,
    protocolDiscoveryShadow ? "shadow" : "active",
    initialProtocolDiscoveryRange.toBlock,
  );
  emitStaticSuppressedProtocolEvents(
    initialProtocolDiscovery.projection,
    protocolDiscoveryShadow ? "shadow" : "active",
    initialProtocolDiscoveryRange.toBlock,
  );
  if (
    initialProtocolDiscovery.startupFallback.searchedFamilyIds.length > 0
  ) {
    console.log(
      `[searcher/live] protocol startup fallback: searched=` +
        `${initialProtocolDiscovery.startupFallback.searchedFamilyIds.length} ` +
        `recovered=` +
        `${initialProtocolDiscovery.startupFallback.recoveredFamilyIds.length} ` +
        `txs=${initialProtocolDiscovery.startupFallback.inspectedTransactions} ` +
        `errors=${initialProtocolDiscovery.startupFallback.errors.length}`,
    );
  }
  if (initialProtocolDiscovery.projection) {
    const projection = initialProtocolDiscovery.projection;
    replaceArray(graph, projection.backrunGraph);
    strategyViews = projection.strategyViews;
    protocolDiscoveryOwnership = projection.ownership;
    if (blockScanGraph && projection.blockscanGraph) {
      replaceArray(blockScanGraph, projection.blockscanGraph);
      blockScanPlanner?.setGraph(blockScanGraph);
    }
    if (!blindProductionAudit) {
      dumpRuntimeGraphPools(strategyViews.backrun);
      dumpRuntimeGraphPools(
        strategyViews.blockscan,
        DEFAULT_RUNTIME_BLOCKSCAN_POOLS_PATH,
      );
    }
  }
  if (!protocolDiscoveryShadow) {
    const advanced = protocolDiscoveryCoverage.advance({
      range: initialProtocolDiscoveryRange,
      scanner: initialProtocolDiscovery.scanner,
      result: initialProtocolDiscovery.result,
      positiveOnlyObserved: !initialProtocolObservedCoverageAuthoritative,
      evaluationBlock: discoveryToBlock,
    });
    protocolDiscoveryCoverage.replace(advanced.watermarks);
    const priorProtocolDiscoveryBlock = lastProtocolDiscoveryBlock;
    lastProtocolDiscoveryBlock =
      protocolDiscoveryCoverage.nextObservedCursor({
        currentCursor: lastProtocolDiscoveryBlock,
        range: initialProtocolDiscoveryRange,
        watermarks: advanced.watermarks,
        positiveOnlyObserved: !initialProtocolObservedCoverageAuthoritative,
        eventSourceComplete:
          initialProtocolDiscovery.scanner.eventSourceComplete,
      });
    if (lastProtocolDiscoveryBlock !== priorProtocolDiscoveryBlock) {
      if (lastProtocolDiscoveryBlock !== initialProtocolDiscoveryRange.toBlock) {
        throw new Error(
          "protocol discovery advanced to an unanchored partial range",
        );
      }
      lastProtocolDiscoveryBlockHash = initialProtocolRangeHashAfter;
    }
    setProtocolObservedCursor(
      protocolDiscoveryCache,
      lastProtocolDiscoveryBlock >= 0 ? lastProtocolDiscoveryBlock : null,
      lastProtocolDiscoveryBlock >= 0
        ? lastProtocolDiscoveryBlockHash
        : null,
    );
    const observedFamilies = protocolDiscoveryCoverage.families
      .filter((family) =>
        family.sourceIds.includes("observed-interaction")
      )
      .map((family) => ({
        familyId: family.familyId,
        sourceIds: ["observed-interaction"],
      }));
    const observedCoverage = new Map<string, boolean>(
      initialProtocolDiscovery.result.familySourceCoverage
        .filter((coverage) =>
          coverage.sourceId === "observed-interaction"
        )
        .map((coverage) => [coverage.familyId, coverage.complete]),
    );
    /*
     * A clean positive-only startup scan is the intended "operational cursor"
     * seed (planDiscoveryStartup): it fully scans a recent window with no
     * retryable errors, so observed-only families must not stay at
     * complete-through 0 forever. Seed the contiguous authority and persist
     * the cursor so the next startup resumes in contiguous mode.
     */
    const observedScanClean =
      observedFamilies.length > 0 &&
      observedFamilies.every(
        (family) => observedCoverage.get(family.familyId) === true,
      ) &&
      initialProtocolDiscovery.scanner.eventSourceComplete === true;
    const observedAuthoritySeeded =
      initialProtocolObservedCoverageAuthoritative ||
      observedScanClean;
    console.log(
      `[searcher/live] protocol observed seed: mode=${protocolDiscoveryStartup.mode} ` +
        `families=${observedFamilies.length} scanClean=${observedScanClean} ` +
        `authoritative=${initialProtocolObservedCoverageAuthoritative} ` +
        `eventSourceComplete=${initialProtocolDiscovery.scanner.eventSourceComplete} ` +
        `observedComplete=${JSON.stringify([...observedCoverage])}`,
    );
    if (observedAuthoritySeeded && observedFamilies.length > 0) {
      const authority = advanceProtocolObservedContiguousAuthority({
        cache: protocolDiscoveryCache,
        families: observedFamilies,
        familySourceCoverage: observedFamilies.map((family) => ({
          familyId: family.familyId,
          sourceId: "observed-interaction",
          complete: observedCoverage.get(family.familyId) === true,
        })),
        fromBlock: initialProtocolDiscoveryRange.fromBlock,
        toBlock: initialProtocolDiscoveryRange.toBlock,
        toBlockHash: initialProtocolRangeHashAfter!,
        contiguousSourceIds: new Set(["observed-interaction"]),
      });
      if (
        authority !== null &&
        !initialProtocolObservedCoverageAuthoritative
      ) {
        // Persist the seeded cursor so a restart resumes contiguous mode
        // instead of re-scanning the recent window as positive-only forever.
        setProtocolObservedCursor(
          protocolDiscoveryCache,
          initialProtocolDiscoveryRange.toBlock,
          initialProtocolRangeHashAfter!,
        );
      }
      console.log(
        `[searcher/live] protocol observed seed done: ` +
          `authority=${authority?.completeThroughBlock ?? null} ` +
          `cursor=${protocolDiscoveryCache.runtime.observedCursor} ` +
          `memAuthority=${
            protocolDiscoveryCache.runtime.observedContiguousAuthority
              ?.completeThroughBlock ?? null
          }`,
      );
    }
    protocolGraphCompleteThrough =
      protocolDiscoveryCoverage.graphCompleteThrough(advanced.watermarks);
  }
  // Persist after ownership/cursor advanced so the snapshot survives a restart.
  persistProtocolDiscoveryEvidence(initialProtocolDiscovery.result);
  const protocolGraphAfter = graph.filter((edge) => edge.slotKind === "protocol");
  const addedProtocolEdges = protocolGraphAfter.filter(
    (edge) => !protocolEdgeKeysBefore.has(protocolEdgeKey(edge)),
  );
  console.log(
    `[searcher/live] protocol discovery ${protocolDiscoveryShadow ? "shadow" : "active"}: ` +
      `instances=${protocolDiscoveryOwnership.admissions.size} ` +
      `would_admit=${initialProtocolDiscovery.result.wouldAdmit.length} ` +
      `protocol_edges=${protocolGraphBefore.length}->${protocolGraphAfter.length} ` +
      `added=${addedProtocolEdges.length} ` +
      `address_probe=${initialProtocolDiscovery.scanner.addressStats.probes} ` +
      `address_cache_hit=${initialProtocolDiscovery.scanner.addressStats.cacheHits} ` +
      `address_overlap=${initialProtocolDiscovery.scanner.addressStats.overlapAddresses} ` +
      `range=${initialProtocolDiscoveryRange.fromBlock}-` +
      `${initialProtocolDiscoveryRange.toBlock} ` +
      `coverage_mode=${protocolDiscoveryStartup.mode}`,
  );
  for (const edge of addedProtocolEdges) {
    console.log(
      `[searcher/live] protocol graph + adapter=${edge.adapterId} target=${edge.target} ` +
        `${edge.tokenIn}->${edge.tokenOut}`,
    );
  }
  const tokenIndex = buildTokenIndex(graph);

  // Detection uses ALL known pool addresses (factory + swap + hardcoded)
  // for matching hint logs. Map: address → adapter type.
  // Routing graph is a subset for path finding.
  const allPoolMap = new Map<string, string>();
  for (const p of strategyViews.backrun) allPoolMap.set(p.address.toLowerCase(), p.adapter);
  detector.setGraph(graph);
  detector.setPoolAddressMap(allPoolMap);
  detector.setTokenQuery(mainnetBackend);
  planner.setGraph(graph);

  // Funding tokens are resolved together with graph pricing by the universal
  // current-N runtime. Until that atomic snapshot publishes, planners fail
  // closed instead of consuming a timer-refreshed, differently-aged cache.
  const flashTokens = [...tokenIndex.keys()];
  console.log(
    `[searcher/live] routing graph: ${graph.length} edges, ${tokenIndex.size} tokens | ` +
      `detection pool set: ${allPoolMap.size} addresses`,
  );

  // Now that the graph exists, wire the configured revm/hybrid backend.
  if (config.liveBackend !== "rpc") {
    const revmSimClient = new RevmSimClient({
      executablePath: process.env.SEARCHER_REVM_SIM_BIN,
      timeoutMs: Number(process.env.SEARCHER_REVM_TIMEOUT_MS ?? "60000"),
    });
    if (discoveryContinuityComposition !== null) {
      strictCentralRuntime = createStrictCentralAdapterRuntime({
        provider,
        generationFence: Object.freeze({ assertCurrent() {} }),
        verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
        simulator: createRevmStrictSimulationTransport({
          client: revmSimClient,
          executor: config.botvmAddress,
          verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
        }),
      });
    }
    if (
      discoveryContinuityComposition !== null &&
      strictCentralRuntime !== null &&
      discoveryInventoryEnumerator !== null &&
      restartTrustedSource !== null
    ) {
      try {
        const restoreResult = await restoreStrictCatalogFromCheckpoint({
          composition: discoveryContinuityComposition,
          catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
          source: restartTrustedSource,
          enumerate: (source) =>
            discoveryInventoryEnumerator!.enumerate(source),
          runtime: strictCentralRuntime,
        });
        console.log(
          `[searcher/live] strict catalog restore ` +
            `${restoreResult.status}` +
            (restoreResult.status === "unresolved"
              ? `: ${restoreResult.reason}`
              : ` revision=${restoreResult.revision}`),
        );
      } catch (error) {
        console.warn(
          `[searcher/live] strict catalog restore failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const revmLiveBackend = new RevmLiveBackend(
      revmSimClient,
      config.botvmAddress,
      config.wallet.address,
      provider,
      graph,
      config.rpcUrl,
      discoveryContinuityComposition === null
        ? undefined
        : {
            views: () =>
              discoveryContinuityComposition.catalogRoot.capture()
                ?.views ?? null,
            catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
          },
    );
    liveBackend = config.liveBackend === "revm"
      ? revmLiveBackend
      : new HybridLiveBackend(revmLiveBackend, rpcLiveBackend);
  }

  // Incremental refresh: scan recent blocks for new pools every N minutes
  const knownPoolKeys = new Set(
    [
      ...backrunGraphBuild.successful.map((item) => poolRegistryKey(item.pool)),
      ...[...protocolDiscoveryOwnership.admissions.values()]
        .map((item) =>
          poolProjectionRowKey(projectVerifiedProtocolPool(item))
        ),
    ],
  );
  for (const retryKey of retryableDexGraphPools.keys()) {
    knownPoolKeys.delete(retryKey);
  }
  for (const retryKey of retryableDexIdentityPools.keys()) {
    knownPoolKeys.delete(retryKey);
  }
  const knownPoolAddrs = new Set(
    strategyViews.backrun.map((pool) => pool.address.toLowerCase()),
  );
  const mempoolIntakeRefresh = new MempoolIntakeRefreshSignal();
  const liveDiscovery = await createLiveDiscoveryCoordinator({
    provider,
    ...(protocolDiscoveryHistoryProvider === undefined
      ? {}
      : { observedHistoryProvider: protocolDiscoveryHistoryProvider }),
    mainnetBackend,
    liveRegistry,
    retainedDexUniverse: blockscanUniverse,
    config: {
      poolUniverseTopN: config.poolUniverseTopN,
      enableProtocolEdges: config.enableProtocolEdges,
      botvmAddress: config.botvmAddress,
    },
    discoveryToBlock,
    discoveryTopN,
    refreshIntervalMs,
    protocolDiscoveryIntervalMs,
    protocolDiscoveryMaxCatchupBlocks,
    protocolDiscoveryShadow,
    protocolDiscoveryChainId,
    protocolDiscoveryCachePath,
    protocolDiscoveryCache,
    dexDiscoveryCursorPath,
    protocolDiscoveryCoverage,
    startupActivePoolDiscovery,
    startupDexSourceBlockHash,
    ...(strictCentralRuntime === null
      ? {}
      : { identityRuntime: strictCentralRuntime }),
    initial: {
      strategyViews,
      protocolOwnership: protocolDiscoveryOwnership,
      lastProtocolDiscoveryBlock,
      lastProtocolDiscoveryBlockHash,
      protocolGraphCompleteThrough,
      dexGraphCoverage,
      graph,
      blockScanGraph,
      tokenIndex,
      poolAddressMap: allPoolMap,
      flashTokens,
      knownPoolKeys,
      knownPoolAddresses: knownPoolAddrs,
      suppressedDexPoolKeys,
      retryableDexGraphPools,
      retryableDexIdentityPools,
    },
    rebuildStrategyViews,
    protocolDexDomainFor,
    protocolAddressCandidatesFor,
    blockScanPlanner,
    detector,
    planner,
    blockScanRuntimeAbort,
    blindProductionAudit,
    mempoolIntakeRefresh,
    getProtocolTraceMemo: () => protocolTraceMemo,
    onPublicationApplied(next) {
      strategyViews = next.strategyViews;
      dexGraphCoverage = { ...next.dexGraphCoverage };
      if (runStrictLivePublicationChain !== null) {
        strictLivePublicationChain.enqueue(runStrictLivePublicationChain);
      }
    },
    async persistRuntimeGraphs(next) {
      await Promise.all([
        dumpRuntimeGraphPoolsAsync(next.backrun),
        dumpRuntimeGraphPoolsAsync(
          next.blockscan,
          DEFAULT_RUNTIME_BLOCKSCAN_POOLS_PATH,
        ),
      ]);
    },
    logRuntimeRefreshFailures: (failures, label) =>
      logRuntimeRefreshFailures([...failures], label),
    onFatalReorg() {
      shuttingDown = true;
    },
    readPriority: liveRethReadPriority,
  });
  liveDiscovery.start();

  let processedHints = 0;
  let busy = false;
  const backrunStatePublisher = new BufferedBlockScanBackrunStatePublisher(
    blockScanBackrunState,
    () => busy,
  );
  const seen = new Set<string>();
  const counters = createStageCounters();
  const victimSource = new VictimSourceTracker(config.victimSourceFilter);
  const pendingVictimOutcomes: PendingVictimOutcome[] = [];
  const recentWarmPools = new RecentWarmTracker(
    Number(process.env.SEARCHER_WARM_RECENT_TTL_BLOCKS ?? "12"),
  );
  const pinnedWarmHops = pinnedWarmHopsFromGraph(graph, pinnedWarmPools);
  const pinnedWarmTargets = new Set(pinnedWarmHops.map((hop) => hop.target.toLowerCase()));
  console.log(
    `[searcher/live] seeded pinned warm hops: ${pinnedWarmHops.length} directions ` +
      `from ${pinnedWarmPools.length} pools`,
  );

  // Between-block warmer: pinned and recent pools have independent quotas so
  // bluechip backbone pools cannot crowd out newly observed longtail pools.
  // If a new block arrives while a hint is in flight, remember the latest block
  // and warm it as soon as the hint finishes instead of dropping the warm event.
  const warmPinnedK = Number(
    process.env.SEARCHER_WARM_PINNED_K ??
      process.env.SEARCHER_WARM_TOP_K ??
      "0",
  );
  const warmRecentK = Number(
    process.env.SEARCHER_WARM_RECENT_K ??
      process.env.SEARCHER_WARM_TOP_K ??
      String(Math.min(config.stateRecentK, 1)),
  );
  const warmIdleDelayMs = Number(process.env.SEARCHER_WARM_IDLE_DELAY_MS ?? "1000");
  console.log(
    `[searcher/live] warm lanes pinnedK=${warmPinnedK} recentK=${warmRecentK} ` +
      `recentTtlBlocks=${recentWarmPools.ttl} idleDelayMs=${warmIdleDelayMs}`,
  );
  let warming = false;
  let pendingWarmBlock: number | null = null;
  let pendingWarmReason: "block" | "after-hint" = "block";
  let warmTimer: NodeJS.Timeout | null = null;
  const cancelScheduledWarm = (): void => {
    if (!warmTimer) return;
    clearTimeout(warmTimer);
    warmTimer = null;
  };
  const runWarm = (blockNumber: number, reason: "block" | "after-hint"): void => {
    if (!liveBackend.warmHotPools || warming) {
      pendingWarmBlock = blockNumber;
      pendingWarmReason = reason;
      return;
    }
    const pinned = topPinnedWarmHops(pinnedWarmHops, warmPinnedK);
    const recent = recentWarmPools.top(warmRecentK, blockNumber, pinnedWarmTargets);
    const hops = [...recent, ...pinned];
    if (hops.length === 0) return;
    warming = true;
    pendingWarmBlock = null;
    console.log(
      `[searcher/live] warm block=${blockNumber} reason=${reason} ` +
        `recent=${recent.length}/${warmRecentK} pinned=${pinned.length}/${warmPinnedK}`,
    );
    void liveBackend
      .warmHotPools(blockNumber, hops)
      .catch((err) =>
        console.log(`[searcher/live] warm error: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        warming = false;
        if (!busy && pendingWarmBlock !== null) {
          const nextBlock = pendingWarmBlock;
          const nextReason = pendingWarmReason;
          pendingWarmBlock = null;
          scheduleWarm(nextBlock, nextReason);
        }
      });
  };
  const scheduleWarm = (blockNumber: number, reason: "block" | "after-hint"): void => {
    pendingWarmBlock = blockNumber;
    pendingWarmReason = reason;
    if (busy || warming || warmTimer) return;
    warmTimer = setTimeout(() => {
      warmTimer = null;
      if (busy || warming || pendingWarmBlock === null) return;
      const nextBlock = pendingWarmBlock;
      const nextReason = pendingWarmReason;
      pendingWarmBlock = null;
      runWarm(nextBlock, nextReason);
    }, warmIdleDelayMs);
  };
  const flushPendingWarm = (): void => {
    if (busy || pendingWarmBlock === null || warming) return;
    const blockNumber = pendingWarmBlock;
    const reason = pendingWarmReason;
    pendingWarmBlock = null;
    scheduleWarm(blockNumber, reason);
  };
  if (
    !blindProductionAudit &&
    (warmPinnedK > 0 || warmRecentK > 0) &&
    liveBackend.warmHotPools
  ) {
    provider.on("block", (blockNumber: number) => {
      if (busy || warming) {
        pendingWarmBlock = blockNumber;
        pendingWarmReason = "block";
        return;
      }
      scheduleWarm(blockNumber, "block");
    });
  }

  const blockScanRejectBlacklist: BlockScanRejectBlacklistState = {
    enabled: process.env.SEARCHER_BLOCKSCAN_REJECT_BLACKLIST !== "0",
    after: Math.max(
      1,
      Number(process.env.SEARCHER_BLOCKSCAN_REJECT_BLACKLIST_AFTER ?? "2"),
    ),
    ttlBlocks: Math.max(
      1,
      Number(process.env.SEARCHER_BLOCKSCAN_REJECT_BLACKLIST_TTL_BLOCKS ?? "300"),
    ),
    entries: new Map(),
  };
  let activeBlindSourceHead: BlindProductionSourceHeadControl | null = null;
  let preparedBlindBase: BlindProductionPrepareControl | null = null;
  let preparedBlindDynamicResetNonce: string | null = null;
  const blockScanRuntimeLoop = new BlockScanRuntimeLoop({
    enabled: enableBlockScan,
    blockScanConfig: blockScanCfg,
    executionWorkers: blockScanExecutionWorkers,
    finalSimulationWorkers: blockScanFinalSimulationWorkers,
    rpcUrl: config.rpcUrl,
    rethTransportScheduler: blockScanRethTransportScheduler,
    runtimeAbort: blockScanRuntimeAbort,
    sharedPlanner: planner,
    backrunStatePublisher,
    routeTelemetry: blockScanRouteTelemetry,
    discovery: liveDiscovery.blockScanHooks,
    blind: {
      enabled: blindProductionAudit,
      activeSource: () => activeBlindSourceHead,
      preparedBase: () => preparedBlindBase,
      preparedArtifacts: () => preparedBlindArtifacts,
      dynamicResetNonce: () => preparedBlindDynamicResetNonce,
    },
    discoveryBackfillMinIntervalMs: Math.max(
      0,
      Number(
        process.env.SEARCHER_DISCOVERY_BACKFILL_MIN_INTERVAL_MS ??
          "30000",
      ),
    ),
    discoveryProducerYieldMaxWaitMs: Math.max(
      0,
      Number(
        process.env.SEARCHER_DISCOVERY_PRODUCER_YIELD_MAX_WAIT_MS ??
          "10000",
      ),
    ),
    discoveryProducerYieldPerReadMaxWaitMs: Math.max(
      0,
      Number(
        process.env.SEARCHER_DISCOVERY_PRODUCER_YIELD_PER_READ_MAX_WAIT_MS ??
          "250",
      ),
    ),
    exactProducerLagYieldMs: Math.max(
      0,
      Number(
        process.env.SEARCHER_BLOCKSCAN_EXACT_PRODUCER_LAG_YIELD_MS ??
          "5000",
      ),
    ),
    exactProducerLagYieldBudgetMs: Math.max(
      0,
      Number(
        process.env.SEARCHER_BLOCKSCAN_EXACT_PRODUCER_LAG_YIELD_BUDGET_MS ??
          "10000",
      ),
    ),
    producerTopologyAdoptIntervalMs: Math.max(
      0,
      Number(
        process.env.SEARCHER_BLOCKSCAN_PRODUCER_TOPOLOGY_ADOPT_MS ??
          "240000",
      ),
    ),
    largeGraphEdgeThreshold: blockScanLargeGraphEdgeThreshold,
    largeGraphPassBudgetMs: blockScanLargeGraphPassBudgetMs,
    passBudgetMs: blockScanPassBudgetMs,
    startupWarmEnabled: enableBlockScan && !blindProductionAudit,
    startupWarmBudgetMs: blockScanStartupWarmBudgetMs,
    nMinusOneFallbackEnabled: blockScanNMinusOneFallback,
    nMinusOneStateBudgetMs: blockScanNMinusOneStateBudgetMs,
    nMinusOneFamilySettleBudgetMs: blockScanNMinusOneFamilySettleMs,
    nMinusOneMaxGraphLagBlocks: blockScanNMinusOneMaxGraphLagBlocks,
    hotPricingFamilyBudgetMs: blockScanHotPricingFamilyBudgetMs,
    runtimePublicationReserveMs: blockScanRuntimePublicationReserveMs,
    refineCandidates: blockScanRefineCandidates,
    solveReserveMs: blockScanSolveReserveMs,
    midConcurrency: blockScanMidConcurrency,
    executorAddress: config.botvmAddress,
    currentHeadEvidenceFamilyForEdge(edgeAdapterId) {
      const owner = PRODUCTION_ADAPTER_FAMILIES.routes().findForEdge(
        edgeAdapterId,
      );
      return owner?.pendingTransactionEvidence?.routeActivation ===
          "current-head-block-scan"
        ? owner.id
        : null;
    },
    currentHeadEvidenceScopeKeyForEdge(edge) {
      const owner = PRODUCTION_ADAPTER_FAMILIES.routes().findForEdge(
        edge.adapterId,
      );
      const capability = owner?.pendingTransactionEvidence;
      return capability
        ? pendingEvidenceEdgeScopeKey(capability, edge)
        : null;
    },
    currentHeadEvidenceScopeKeys(evidence) {
      const owner = PRODUCTION_ADAPTER_FAMILIES.routes().forFamily(
        evidence.familyId,
      );
      const capability = owner.pendingTransactionEvidence;
      return capability
        ? pendingEvidenceScopeKeys(capability, evidence)
        : Object.freeze([]);
    },
    isCurrentHeadEvidenceFamily(familyId) {
      const owner = PRODUCTION_ADAPTER_FAMILIES.routes().forFamily(familyId);
      return owner.pendingTransactionEvidence?.routeActivation ===
        "current-head-block-scan";
    },
    isShuttingDown: () => shuttingDown,
    blockScanGraph: () => blockScanGraph,
    blockScanPlanner: () => blockScanPlanner,
    adapterRuntimeCoordinator: () => adapterRuntimeCoordinator,
    flashTokens: () => flashTokens,
    buildGraphView(input) {
      return adapterFamilyGraphViews.build({
        ...input,
        dexSourceCompleteThrough: dexGraphCoverage.sourceCompleteThrough,
        retryablePools: [
          ...retryableDexGraphPools.values(),
          ...retryableDexIdentityPools.values(),
        ],
        dexUniverseFingerprint: poolUniverseCoverage.contentSha256,
        strategyViewHash: strategyViews.versions.blockscan_view_hash,
        protocolSourceFingerprints: discoverySourceFingerprints,
        protocolEdgesEnabled: config.enableProtocolEdges,
      });
    },
    readBlockHash,
    formatRouteKey: formatBlockScanRouteKey,
    formatRing: formatBlockScanRing,
    isRouteBlacklisted: (routeKey, currentBlock) =>
      activeBlockScanRejectBlacklistEntry(
        blockScanRejectBlacklist,
        routeKey,
        currentBlock,
      ) !== null,
    submitAtomic(input) {
      return maybeSubmitBlockScanAtomic({
        ...input,
        config,
        provider,
        bundleRouter,
        submissionCoordinator,
        rejectBlacklist: blockScanRejectBlacklist,
        strategyVersions: {
          strategy_view_version:
            strategyViews.versions.strategy_view_version,
          blockscan_view_hash:
            strategyViews.versions.blockscan_view_hash,
        },
        profitTokenValuation,
        collectBlindAudit: blindProductionAudit,
      });
    },
  });

  let stateUpdating = false;
  let pendingStateUpdateBlock: number | null = null;
  const runStateUpdate = (blockNumber: number, reason: "block" | "pending"): void => {
    if (stateUpdating) {
      pendingStateUpdateBlock = blockNumber;
      return;
    }
    const pinned = topPinnedWarmHops(pinnedWarmHops, config.statePinnedK);
    const recent = recentWarmPools.top(config.stateRecentK, blockNumber, pinnedWarmTargets);
    const hops = [...recent, ...pinned].slice(0, config.stateWatchMaxPools);
    if (hops.length === 0) return;
    stateUpdating = true;
    pendingStateUpdateBlock = null;
    console.log(
      `[searcher/live] state update block=${blockNumber} reason=${reason} ` +
        `recent=${recent.length}/${config.stateRecentK} ` +
        `pinned=${pinned.length}/${config.statePinnedK} watched=${hops.length}`,
    );
    void poolStateUpdater.update(blockNumber, hops)
      .catch((err) =>
        console.log(`[searcher/live] state update error: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        stateUpdating = false;
        if (pendingStateUpdateBlock !== null) {
          const next = pendingStateUpdateBlock;
          pendingStateUpdateBlock = null;
          runStateUpdate(next, "pending");
        }
      });
  };

  const {
    rpcUrl: _blindRpcUrl,
    wsUrl: _blindWsUrl,
    mevShareSseUrl: _blindMevShareSseUrl,
    wallet: blindWallet,
    pinnedWarmPoolPath: _blindPinnedWarmPoolPath,
    poolUniversePath: _blindPoolUniversePath,
    poolUniverseManifestPath: _blindPoolUniverseManifestPath,
    forceIncludePoolIdsPath: _blindForceIncludePoolIdsPath,
    liveFixtureDir: _blindLiveFixtureDir,
    poolUniverseForceInclude: blindForceIncludePoolIds,
    ...blindPublicConfig
  } = config;
  const blindEffectiveConfig = normalizeBlindArtifactValue({
    config: blindPublicConfig,
    executorAddress: blindWallet.address.toLowerCase(),
    forceInclude: {
      count: blindForceIncludePoolIds.length,
      contentSha256: blindProductionAuditHash(
        [...blindForceIncludePoolIds].sort(),
      ),
    },
    runtimeEnvironment: blindProductionAudit
      ? blindResolvedRuntimeEnvironment(process.env)
      : { values: {}, redactedBindings: [] },
    blockScan: {
      core: blockScanCfg,
      largeGraphEdgeThreshold: blockScanLargeGraphEdgeThreshold,
      largeGraphPassBudgetMs: blockScanLargeGraphPassBudgetMs,
      midConcurrency: blockScanMidConcurrency,
      passBudgetMs: blockScanPassBudgetMs,
      refineCandidates: blockScanRefineCandidates,
      solveConcurrency: blockScanSolveConcurrency,
      solveReserveMs: blockScanSolveReserveMs,
      nMinusOneFallback: blockScanNMinusOneFallback,
      nMinusOneStateBudgetMs: blockScanNMinusOneStateBudgetMs,
      nMinusOneMaxGraphLagBlocks: blockScanNMinusOneMaxGraphLagBlocks,
    },
  }) as Readonly<Record<string, unknown>>;
  const blindStaticArtifacts = blindProductionAudit
    ? createBlindProductionStaticArtifacts({
        effectiveConfig: blindEffectiveConfig,
        productionPools: strategyViews.blockscan,
        configuredUniverseContentSha256: blindProductionAuditHash(
          rawBlockscanUniverse.map(poolRegistryKey).sort(),
        ),
        universeGeneratedAt: strategyViewOptions.poolUniverseGeneratedAt,
        selectedUniverse: blockscanUniverse,
        strategyViewVersion: strategyViews.versions.blockscan_view_hash,
        families: PRODUCTION_ADAPTER_FAMILIES.list(),
      })
    : null;

  let blindSessionBase:
    | {
        readonly anchor: BlindProductionPrepareControl["base"];
        readonly runtimeState: LiveDiscoveryPublicationState;
      }
    | null = null;
  let preparedBlindArtifacts: PreparedBlindProductionArtifacts | null = null;
  const captureBlindBaseRuntimeState =
    (): LiveDiscoveryPublicationState =>
      liveDiscovery.capture();

  const restoreBlindBaseRuntimeState = (
    base: LiveDiscoveryPublicationState,
  ): void => {
    liveDiscovery.publish(base);
    protocolTraceMemo = createProtocolTraceMemo();
    blockScanRejectBlacklist.entries.clear();
  };

  const assertBlindBackendAnchor = async (
    expected: BlindProductionPrepareControl["base"],
  ): Promise<void> => {
    const actual = await readLatestBlockAnchor(provider);
    if (
      actual.number !== expected.number ||
      actual.hash.toLowerCase() !== expected.hash.toLowerCase() ||
      actual.stateRoot.toLowerCase() !== expected.stateRoot.toLowerCase()
    ) {
      throw new Error(
        `blind backend anchor mismatch expected=${expected.number}:${expected.hash} ` +
          `actual=${actual.number}:${actual.hash}`,
      );
    }
  };

  const prepareBlindProductionAttempt = async (
    control: BlindProductionPrepareControl,
  ): Promise<void> => {
    const staticArtifacts = blindStaticArtifacts;
    if (!staticArtifacts) {
      throw new Error("blind production artifacts requested outside audit mode");
    }
    if (activeBlindSourceHead || preparedBlindBase) {
      throw new Error("blind production attempt overlaps an active/prepared attempt");
    }
    await liveDiscovery.settled();
    await assertBlindBackendAnchor(control.base);
    if (!blindSessionBase) {
      blindSessionBase = {
        anchor: { ...control.base },
        runtimeState: captureBlindBaseRuntimeState(),
      };
    } else {
      if (
        blindSessionBase.anchor.number !== control.base.number ||
        blindSessionBase.anchor.hash.toLowerCase() !==
          control.base.hash.toLowerCase() ||
        blindSessionBase.anchor.stateRoot.toLowerCase() !==
          control.base.stateRoot.toLowerCase()
      ) {
        throw new Error(
          "blind production session cannot reuse runtime state across base anchors",
        );
      }
      restoreBlindBaseRuntimeState(blindSessionBase.runtimeState);
    }
    // A blind attempt may target the same source N/hash as the previous
    // attempt. Clear both dynamic publishers before rebuilding N-1: the
    // coordinator will retain only this attempt's fresh N-1 predecessor, while
    // the backrun bridge must not retain prior source-N live/tick cache state.
    blockScanBackrunState.resetDynamicStateForReplay();
    await adapterRuntimeCoordinator!.resetDynamicStateForReplay();
    await Promise.all([
      ...blockScanExecutionWorkers,
      ...blockScanFinalSimulationWorkers,
    ].map(async (worker) => {
      await worker.state.forkAt(control.base.number);
      const forkHash = await readBlockHash(worker.state.provider, control.base.number);
      if (forkHash.toLowerCase() !== control.base.hash.toLowerCase()) {
        throw new Error(
          `blind worker base hash mismatch ${forkHash} != ${control.base.hash}`,
        );
      }
    }));
    if (!blockScanGraph) {
      throw new Error("blind production prepare has no block-scan graph");
    }
    if (dexGraphCoverage.graphCompleteThrough < control.base.number) {
      throw new Error(
        "blind production DEX base graph is not complete at N-1",
      );
    }
    const baseGeneration = blockScanRuntimeLoop.nextGeneration();
    const baseGraph = adapterFamilyGraphViews.build({
      id: `blind-base:${hashTokenGraph([...blockScanGraph])}`,
      generation: baseGeneration,
      sourceBlock: control.base.number,
      sourceBlockHash: control.base.hash,
      edges: Object.freeze([...blockScanGraph]),
      topologyKey: `blind:${hashTokenGraph([...blockScanGraph])}`,
      dexSourceCompleteThrough: dexGraphCoverage.sourceCompleteThrough,
      retryablePools: [
        ...retryableDexGraphPools.values(),
        ...retryableDexIdentityPools.values(),
      ],
      dexUniverseFingerprint: poolUniverseCoverage.contentSha256,
      strategyViewHash: strategyViews.versions.blockscan_view_hash,
      landedCoverage: liveDiscovery.capture().landedCoverage,
      protocolSourceFingerprints: discoverySourceFingerprints,
      protocolEdgesEnabled: config.enableProtocolEdges,
    });
    const baseGraphArtifact = createBlindProductionArtifact(
      "base-graph-view",
      blindGraphArtifactPayload(baseGraph),
    );
    const baseRuntime = await adapterRuntimeCoordinator!.prepare({
      graph: baseGraph,
      fundingTokens: [...new Set([
        ...flashTokens,
        ...blockScanGraph.flatMap((edge) => [edge.tokenIn, edge.tokenOut]),
      ])],
      deadlineAtMs: Date.now() + blindPrepareBudgetMs,
    });
    if (baseRuntime.status === "incomplete") {
      throw new Error(
        `blind production N-1 prewarm is ${baseRuntime.status}: ` +
          `${baseRuntime.issues[0]?.message ?? "unknown"}`,
      );
    }
    // Keep this attempt's freshly rebuilt N-1 publication as the sole
    // incremental predecessor for source N. The reset at the beginning of the
    // next attempt discards its prior source-N publication before rebuilding
    // N-1, so no attempt can reuse another attempt's N while unchanged keys can
    // still carry forward across the intended N-1 -> N boundary.
    preparedBlindDynamicResetNonce = control.attemptNonce;
    preparedBlindBase = control;
    preparedBlindArtifacts = {
      baseAnchor: Object.freeze({ ...control.base }),
      baseGraph: baseGraphArtifact,
      baseOrderedEdgeIds:
        baseGraph.edges.map(blindCompatibilityCanonicalEdgeId),
      receipts: {
        resolvedConfig:
          blindProductionArtifactReceipt(staticArtifacts.resolvedConfig),
        universe: blindProductionArtifactReceipt(staticArtifacts.universe),
        activeFamilyManifest:
          blindProductionArtifactReceipt(staticArtifacts.activeFamilyManifest),
        baseGraphView: blindProductionArtifactReceipt(baseGraphArtifact),
      },
      documents: {
        resolvedConfig: staticArtifacts.resolvedConfig,
        universe: staticArtifacts.universe,
        activeFamilyManifest: staticArtifacts.activeFamilyManifest,
        baseGraphView: baseGraphArtifact,
      },
    };
    process.stdout.write(
      `${BLIND_PRODUCTION_READY_PREFIX}${blindProductionCanonicalJson({
        type: "ready",
        profile: BLIND_PRODUCTION_RAW_PROFILE,
        attemptNonce: control.attemptNonce,
        base: control.base,
        artifacts: preparedBlindArtifacts.receipts,
        artifactDocuments: preparedBlindArtifacts.documents,
      })}\n`,
    );
  };

  const runBlindProductionSourceHead = async (
    control: BlindProductionSourceHeadControl,
  ): Promise<void> => {
    const prepared = preparedBlindBase;
    if (
      !prepared ||
      activeBlindSourceHead ||
      prepared.attemptNonce !== control.attemptNonce ||
      prepared.base.number + 1 !== control.source.number
    ) {
      throw new Error("blind source head does not match its prepared attempt");
    }
    const sourceHeadSeenAtMs = Date.now();
    const sourceHeadSeenAtMonotonicMs = performance.now();
    await assertBlindBackendAnchor(control.source);
    submissionCoordinator.onBlock(control.source.number);
    activeBlindSourceHead = control;
    try {
      await blockScanRuntimeLoop.runHead(control.source.number, {
        sourceHeadSeenAtMs,
        sourceHeadSeenAtMonotonicMs,
      });
    } finally {
      activeBlindSourceHead = null;
      preparedBlindBase = null;
      preparedBlindDynamicResetNonce = null;
      preparedBlindArtifacts = null;
    }
  };

  if (blindProductionAudit) {
    installBlindProductionControlInput({
      stream: process.stdin,
      prepare: prepareBlindProductionAttempt,
      sourceHead: runBlindProductionSourceHead,
    });
  }

  // The family snapshot is the sole block-level V2/V3 state publisher for the
  // block-scan lane. Running the legacy watched-pool updater on the same head
  // would issue a second set of reserve/slot reads for overlapping pools and create
  // two independently published views of the same generation. Backrun-only
  // deployments retain the mature updater unchanged; victim-specific JIT
  // preparation remains scoped to the backrun lane.
  if (config.stateUpdaterEnabled && !enableBlockScan) {
    provider.on("block", (blockNumber: number) => runStateUpdate(blockNumber, "block"));
  }
  if (enableBlockScan && !blindProductionAudit) {
    provider.on(
      "block",
      (blockNumber: number) => blockScanRuntimeLoop.schedule(blockNumber),
    );
    // Close the listener-registration race and warm from the current canonical
    // head rather than the early startup discovery anchor. The runtime loop
    // owns discovery/CAS and retries fail-closed without taking down backrun.
    blockScanRuntimeLoop.schedule(await provider.getBlockNumber());
  }

  // Track the latest mined block from the WS newHeads stream so the per-hint hot
  // path doesn't issue a redundant eth_blockNumber on every hint — the number is
  // already being pushed to us. Seed once at startup; WS keeps it fresh.
  const blockTracker = { latest: await provider.getBlockNumber() };
  if (!blindProductionAudit) {
    provider.on("block", (blockNumber: number) => {
      if (blockNumber > blockTracker.latest) blockTracker.latest = blockNumber;
      submissionCoordinator.onBlock(blockNumber);
    });
  }

  let stopRuntimePromise: Promise<void> | null = null;
  const stopRuntime = (): Promise<void> => {
    if (stopRuntimePromise) return stopRuntimePromise;
    stopRuntimePromise = (async () => {
      console.log("\n[searcher/live] shutting down");
      shuttingDown = true;
      logStageCounters(counters);
      cancelScheduledWarm();
      provider.removeAllListeners("block");
      try {
        await blockScanRuntimeLoop.shutdown();
      } catch (error) {
        console.warn(
          `[searcher/live] block-scan shutdown failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await blockScanRouteTelemetry.shutdown();
      } catch (error) {
        console.warn(
          `[searcher/live] block-scan route telemetry shutdown failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await liveDiscovery.shutdown();
      } catch (error) {
        console.warn(
          `[searcher/live] discovery persistence flush failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      destroyProtocolDiscoveryHistoryProvider();
      state.stop();
    })();
    return stopRuntimePromise;
  };
  const shutdown = (): void => {
    void stopRuntime().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const mempoolStream = () => {
    console.log(`[searcher/live] mempool=enabled ws=${config.wsUrl.slice(0, 40)}...`);
    return mempoolHints(
      config.wsUrl,
      provider,
      () => strategyViews.backrun,
      counters,
      knownPoolAddrs,
      mempoolIntakeRefresh,
      (trigger) => {
        blockScanRuntimeLoop.schedulePendingEvidence(trigger);
      },
    );
  };
  const hintStream = sourceMode === "disabled"
    ? disabledHints()
    : sourceMode === "public-mempool"
      ? mempoolStream()
      : sourceMode === "mev-share"
        ? mevShareHints(config.mevShareSseUrl)
        : mergeHints(mevShareHints(config.mevShareSseUrl), mempoolStream());

  try {
    for await (const hint of hintStream) {
      processedHints++;
      counters.hints++;
      if (busy) {
        console.log("[searcher/live] skip hint: simulation already running");
        continue;
      }
      if (hint.hashes.length === 0) continue;

      for (const txHash of hint.hashes) {
        const key = txHash.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        cancelScheduledWarm();
        busy = true;
        const tHint = Date.now();
        try {
          await handleHint(hint, txHash, {
            config,
            provider,
            state,
            detector,
            planner,
            profitTokenValuation,
            solver,
            simulator,
            bundleRouter,
            submissionCoordinator,
            graph,
            tokenIndex,
            poolAddrs: allPoolMap,
            tokenQuery: mainnetBackend,
            counters,
            startedAt: tHint,
            cache: poolStateCache,
            poolStateUpdater,
            fixtureRecorder,
            liveBackend,
            victimSource,
            pendingVictimOutcomes,
            recentWarmPools,
            pinnedWarmTargets,
            blockTracker,
            observeProtocolReceipt: liveDiscovery.observeProtocolReceipt,
            observeProtocolTxHash: liveDiscovery.observeProtocolTxHash,
            ...(discoveryContinuityComposition === null
              ? {}
              : {
                  strictQuoteSource: createStrictQuoteSource({
                    views: () =>
                      discoveryContinuityComposition.catalogRoot.capture()
                        ?.views ?? null,
                    catalog:
                      PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
                    legacy: liveBackend,
                    // F6 Pair E: the durable composition is the default, so
                    // the solver never prices through a non-strict path; a
                    // route missing from committed views fails closed.
                    fallback: "fail-closed",
                  }),
                }),
          });
        } catch (err) {
          console.log(
            `[searcher/live] ${txHash.slice(0, 10)} skip: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          console.log(`[searcher/live] ${txHash.slice(0, 10)} end-to-end ${Date.now() - tHint}ms`);
          logStageCounters(counters);
          busy = false;
          backrunStatePublisher.flush();
          flushPendingWarm();
        }
      }
      if (config.maxHints > 0 && processedHints >= config.maxHints) break;
    }
  } finally {
    await stopRuntime();
  }
}

interface HandleCtx {
  config: LiveConfig;
  provider: ethers.JsonRpcProvider;
  state: AnvilStateBackend;
  detector: BackrunDetector;
  planner: TemplatePlanner;
  profitTokenValuation: ProfitTokenValuation;
  solver: AnvilSolver;
  simulator: BotVMSimulator;
  bundleRouter: BundleRouter;
  submissionCoordinator: SubmissionCoordinator;
  graph: TokenEdge[];
  tokenIndex: Map<string, Set<string>>;
  poolAddrs: Map<string, string>;
  tokenQuery: TokenQueryBackend;
  counters: StageCounters;
  /** Wall-clock time the hint was received; used for the opportunity TTL budget. */
  startedAt: number;
  /** Warmed pool-state cache for local-math quotes (path B). Cleared per hint. */
  cache: PoolStateCache;
  poolStateUpdater: PoolStateUpdater;
  fixtureRecorder: LiveFixtureRecorder;
  liveBackend: LiveStateBackend;
  victimSource: VictimSourceTracker;
  pendingVictimOutcomes: PendingVictimOutcome[];
  /** Recent candidate route-hop directions for the longtail warmer lane. */
  recentWarmPools: RecentWarmTracker;
  /** Pool targets already covered by the pinned warmer lane. */
  pinnedWarmTargets: Set<string>;
  /** Latest mined block, kept fresh by the WS newHeads stream (no per-hint poll). */
  blockTracker: { latest: number };
  observeProtocolReceipt(input: {
    txHash: string;
    blockNumber: number;
    receipt: ProtocolDiscoveryReceipt;
  }): Promise<void>;
  observeProtocolTxHash(txHash: string): Promise<void>;
  /**
   * Pair E: solver quote source backed by committed strict catalog pricing
   * views with per-family/per-availability legacy fallback. Absent when no
   * composition is configured.
   */
  readonly strictQuoteSource?: AmountQuoteSource;
}

/**
 * F8: the strict catalog's plugin log patterns are the enumerable receipt
 * surface for the protocol-trace gate (the legacy adapter list is empty, so
 * the trace gate cannot infer patterns from it). Module-level because
 * handleHint is a module-level function.
 */
let strictTraceTopics: ReadonlySet<string> | null = null;
const strictCatalogTraceTopics = (): ReadonlySet<string> => {
  if (strictTraceTopics === null) {
    const topics = new Set<string>();
    for (const family of PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
      .listAll()) {
      const discovery = "discovery" in family.plugin
        ? family.plugin.discovery
        : null;
      for (const pattern of discovery?.logPatterns ?? []) {
        topics.add(pattern.topic.toLowerCase());
      }
    }
    strictTraceTopics = topics;
  }
  return strictTraceTopics;
};

/**
 * Process a single MEV-Share hint. Two paths:
 *
 * Hint logs are fragmentary observation evidence. They can nominate pools and
 * trigger a full-transaction fetch, but may not certify a complete victim
 * transition. A future attested complete-receipt source may enter the exact
 * hash-only overlay branch.
 *
 * Path B (fallback: can fetch full tx from RPC):
 *   getTransaction → rawTx → applyRawTx on Anvil (current V5 logic)
 *   → detect/plan/solve/simulate → mev_sendBundle (hash-only)
 */
async function handleHint(
  hint: HintEnvelope,
  txHash: string,
  ctx: HandleCtx,
): Promise<void> {
  const victimSource = hint.source ?? "mev-share";
  console.log(`[searcher/live] hint tx=${txHash} src=${victimSource}`);

  // Per-stage timing from hint receipt — surfaces where the wall time goes
  // (fork setup vs state prep vs detect/plan) so even a no-solver expiry is
  // debuggable: "found opportunity in Xms" and the stage breakdown on expiry.
  const segStart = ctx.startedAt;
  let segPrev = segStart;
  const seg: Record<string, number> = {};
  const segMark = (k: string): void => {
    const now = Date.now();
    seg[k] = now - segPrev;
    segPrev = now;
  };
  const segStr = (): string =>
    `${Object.entries(seg).map(([k, v]) => `${k}=${v}ms`).join(" ")} total=${Date.now() - segStart}ms`;

  // Use the WS-tracked block instead of polling eth_blockNumber every hint; fall
  // back to a one-off poll only if the stream hasn't delivered a block yet.
  const latestBlock = ctx.blockTracker.latest || (await ctx.provider.getBlockNumber());
  const validatedExecutionEvidence = new Map<
    string,
    Promise<readonly PendingExecutionEvidence[]>
  >();
  const resolveExecutionEvidence = (
    familyIds: readonly ExecutionFamilyId[],
  ) => {
    const requested = [...new Set(familyIds)].sort();
    const key = requested.join(",");
    let pending = validatedExecutionEvidence.get(key);
    if (pending) return pending;
    pending = (async () => {
      const immediate = (hint.executionEvidence ?? []).filter((item) =>
        requested.includes(item.familyId)
      );
      const missing = requested.filter((familyId) =>
        !immediate.some((item) => item.familyId === familyId)
      );
      const observed = missing.length > 0
        ? await (
          hint.resolvePendingExecutionEvidence?.(missing) ??
            Promise.resolve(Object.freeze([]))
        )
        : Object.freeze([]);
      return validateHintExecutionEvidence(
        Object.freeze([...immediate, ...observed]),
        txHash,
        ctx.provider,
      );
    })();
    validatedExecutionEvidence.set(key, pending);
    return pending;
  };
  await drainPendingVictimOutcomes(ctx, latestBlock);
  let anvilForkReady = false;
  const ensureHintFork = async (blockNumber: number, forceRefresh = false): Promise<void> => {
    if (anvilForkReady && !forceRefresh) return;
    // Fork-reuse: reset to baseline (~ms) instead of re-forking (~s) each hint;
    // only re-fork every forkRefreshBlocks to refresh state (~7x faster setup).
    if (forceRefresh) {
      await ctx.state.refreshFork(blockNumber);
    } else {
      await ctx.state.ensureFreshFork(blockNumber, ctx.config.forkRefreshBlocks);
    }
    // Pin the cache to this fork block while preserving any block-level state
    // seeded by PoolStateUpdater. The impact pool is marked later, after the
    // opportunity is known.
    ctx.cache.beginHint(blockNumber);
    anvilForkReady = true;
    segMark("fork"); // getBlockNumber + ensureFreshFork/refresh + cache reset
  };

  // Inspect fragmentary hint logs before attempting a full-transaction fetch.
  const hintLogs = extractLogs(hint.payload);
  if (hintLogs.length > 0 && hintLogs.length <= 5) {
    for (const l of hintLogs) {
      const isTransfer = l.topics[0]?.toLowerCase() === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      if (isTransfer && l.topics.length >= 3) {
        const from = "0x" + l.topics[1].slice(26);
        const to = "0x" + l.topics[2].slice(26);
        console.log(`[searcher/live] ${txHash.slice(0, 10)} Transfer: token=${l.address.slice(0, 10)} from=${from.slice(0, 10)} to=${to.slice(0, 10)}`);
      } else {
        console.log(`[searcher/live] ${txHash.slice(0, 10)} log: addr=${l.address.slice(0, 10)} t0=${l.topics[0]?.slice(0, 10)}`);
      }
    }
  } else if (hintLogs.length > 5) {
    console.log(`[searcher/live] ${txHash.slice(0, 10)} hint has ${hintLogs.length} logs (batch)`);
  }
  const hintTransition = await matchPoolImpactFromLogs(
    hintLogs,
    ctx.graph,
    ctx.poolAddrs,
    latestBlock,
    null,
    txHash,
  );
  const admittedHintImpacts = hintTransition.impacts.filter((impact) =>
    hashOnlyImpactReplayAdmitted(impact.matchedAdapterId)
  );
  const hintImpact = hintTransition.hashOnlyReplayable &&
      admittedHintImpacts.length === 1
    ? admittedHintImpacts[0]
    : null;
  const hintMutationOnly =
    mutationOnlyTransitionDiagnostic(hintTransition);
  if (!hintTransition.complete) {
    console.log(
      `[searcher/live] ${txHash.slice(0, 10)} victim transition unresolved: ` +
        hintTransition.unresolved
          .slice(0, 4)
          .map((item) => `${item.reason}:${item.pool ?? "unknown"}`)
          .join(","),
    );
  } else if (hintTransition.impacts.length > 1) {
    console.log(
      `[searcher/live] ${txHash.slice(0, 10)} multi-pool victim transition ` +
        `impacts=${hintTransition.impacts.length}; hash-only replay disabled`,
    );
  }
  if (hintTransition.mutations.length > 0) {
    console.log(
      `[searcher/live] ${txHash.slice(0, 10)} mutation-only receipt steps ` +
        hintTransition.mutations
          .slice(0, 4)
          .map((mutation) =>
            `${mutation.familyId}:${mutation.poolIdentity}:${mutation.reason}`
          )
          .join(","),
    );
  }
  segMark("match"); // pool-impact matching against the graph

  // Token-index check: does any hint Transfer involve a token we track?
  const hintTokenHit =
    hintTransition.impacts.length > 0 ||
    hintTransition.mutations.length > 0 ||
    hintLogsMatchTokenIndex(hintLogs, ctx.tokenIndex);

  let rawTx: string | undefined;
  let eventLogs: SwapEventLog[] = [];
  let eventFrom = ethers.ZeroAddress;
  let eventNonce = 0;
  let eventTo: string | null = null;
  let eventInput = "0x";
  let eventBlockNumber = latestBlock + 1;
  let eventSourceBlockHash: string | undefined;
  let eventReceiptBlockNumber: number | undefined;
  let eventReceiptBlockHash: string | undefined;
  let eventReceiptParentBlockHash: string | undefined;
  let eventReceiptTransactionHash: string | undefined;
  let eventLogsCompleteness: NonNullable<OrderflowEvent["logsCompleteness"]> =
    "fragment";
  let observedProtocolReceipt: ProtocolDiscoveryReceipt | null = null;
  let submissionMode: BundleSubmission["mode"] = "hash-only";
  let fixturePath: LiveFixturePath = "hash-only";
  let countedHintImpact = false;
  let fixtureImpact: PoolImpact | null = hintImpact;
  let fixtureOpportunities = 0;
  let fixturePlans = 0;

  const recordFinalState = (
    finalState: LiveFinalState,
    error?: string,
    sim?: { calldata: string; profitToken: string; netProfit: bigint; gasUsed: bigint },
  ): void => {
    const impact = fixtureImpact;
    if (!impact) return;
    ctx.fixtureRecorder.record({
      hintPayload: hint.payload,
      eventLogs,
      report: {
        txHash,
        receivedAt: ctx.startedAt,
        path: fixturePath,
        blockNumber: eventBlockNumber,
        pool: impact.pool,
        tokenIn: impact.tokenIn,
        tokenOut: impact.tokenOut,
        amountIn: impact.amountIn.toString(),
        opportunities: fixtureOpportunities,
        plans: fixturePlans,
        stageMs: { ...seg, total: Date.now() - segStart },
        finalState,
        error,
        calldata: sim?.calldata,
        profitToken: sim?.profitToken,
        netProfit: sim?.netProfit.toString(),
        gasUsed: sim?.gasUsed.toString(),
        counters: counterSnapshot(ctx.counters),
      },
    });
  };

  if (hint.prefetched) {
    // ── Route B: public mempool victim — apply the prefetched rawTx on fork ──
    // We already have the full tx + raw signed bytes, so skip MEV-Share log
    // matching/RPC fetch and go straight to the Path-B apply. Submits via
    // eth_sendBundle to all builders (rawTx present → submissionMode set below).
    const { tx, rawTx: prefetchedRaw } = hint.prefetched;
    if (tx.blockNumber !== null) {
      throw new Error("mempool victim already mined");
    }
    submissionMode = "victim-bundle";
    fixturePath = "rawTx";
    rawTx = prefetchedRaw;

    await ensureHintFork(latestBlock);
    const appliedHash = await ctx.state.applyRawTx(rawTx);
    if (appliedHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error(`local victim hash mismatch ${appliedHash}`);
    }

    await prepareForkExecutor(ctx.state.provider, ctx.config.wallet.address, ctx.config.botvmAddress);

    const receipt = await ctx.state.provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      throw new Error("local victim receipt missing or reverted");
    }

    eventFrom = tx.from;
    eventNonce = tx.nonce;
    eventTo = tx.to;
    eventInput = tx.data;
    eventLogs = receipt.logs.map((log) => ({
      address: log.address,
      topics: [...log.topics],
      data: log.data,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
    }));
    eventReceiptBlockNumber = receipt.blockNumber;
    eventReceiptBlockHash = receipt.blockHash;
    eventReceiptTransactionHash = receipt.hash;
    eventSourceBlockHash = await readBlockHash(ctx.provider, latestBlock);
    const forkSourceBlockHash = await readBlockHash(ctx.state.provider, latestBlock);
    if (forkSourceBlockHash !== eventSourceBlockHash) {
      throw new Error(
        `victim source fork hash mismatch ${forkSourceBlockHash} != ${eventSourceBlockHash}`,
      );
    }
    const receiptBlock = await ctx.state.provider.getBlock(receipt.blockNumber);
    if (
      !receiptBlock?.hash ||
      receiptBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      receiptBlock.parentHash.toLowerCase() !== forkSourceBlockHash
    ) {
      throw new Error("local victim receipt block is not a child of the source fork");
    }
    eventReceiptParentBlockHash = receiptBlock.parentHash;
    eventLogsCompleteness = "complete-receipt";
  } else if (hintImpact) {
    ctx.counters.impacts++;
    countedHintImpact = true;

    // Attested-complete receipt path: exact event overlay when available,
    // otherwise approximate simulation via impersonate swap. Raw MEV-Share
    // hint fragments never enter this branch.
    if (!ctx.config.enableHashOnly) {
      throw new Error("hash-only hint (no rawTx); set SEARCHER_ENABLE_HASH_ONLY=1 to enable");
    }
    const hintOverlayExact = hintImpact.v3PostState !== undefined;
    console.log(
      `[searcher/live] hint via logs (${hintOverlayExact ? "exact-v3-post-state" : "approximate"}): ` +
        `pool=${hintImpact.pool.slice(0, 10)} ` +
        `amountIn=${hintImpact.amountIn}`,
    );

    // Use hint logs directly for detector
    eventLogs = hintLogs.map((l) => ({
      address: l.address,
      topics: [...l.topics],
      data: l.data,
    }));
  } else if (!hintTokenHit) {
    // No pool match AND no token match — skip early. Emit a drop so this is not event-silent
    // (else onchain-loss-scan undercounts received_but_dropped into not_received — rule-16 fix).
    emitEvent({
      type: "pipeline_dropped",
      opportunity_id: makeOpportunityId({ targetBlock: eventBlockNumber, victimHash: txHash }),
      target_block: eventBlockNumber,
      victim_hash: txHash,
      victim_source: hint.source ?? "mev-share",
      stage: "detect",
      reason: "no_matching_graph_pool",
    });
    if (
      shouldTraceForProtocolDiscovery(
        hintLogs,
        PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes().filter((adapter) =>
          !adapter.requiresProtocolEdgesFlag || ctx.config.enableProtocolEdges
        ),
        // F8: the strict catalog's plugin log patterns are the enumerable
        // receipt surface; the legacy adapter list is empty.
        strictCatalogTraceTopics(),
      )
    ) {
      void ctx.observeProtocolTxHash(txHash);
    }
    throw new Error("no matching graph pool");
  } else {
    // Token hit but no pool impact — try to fetch full tx from RPC
    console.log(`[searcher/live] ${txHash.slice(0, 10)} token-index hit, trying RPC fetch`);
    const tx = await ctx.provider.getTransaction(txHash);
    if (!tx) {
      emitEvent({
        type: "pipeline_dropped",
        opportunity_id: makeOpportunityId({
          targetBlock: eventBlockNumber,
          victimHash: txHash,
        }),
        target_block: eventBlockNumber,
        victim_hash: txHash,
        victim_source: victimSource,
        stage: "detect",
        reason: hintTransition.unresolved.some((item) =>
            item.reason === "receipt-fragment"
          )
          ? "receipt_fragment_full_tx_unavailable"
          : "tx_not_available",
      });
      throw new Error("tx not available from RPC (private receipt fragment)");
    }

    if (tx.blockNumber !== null) {
      // ── Path C: tx already mined — fork at that block, check for next-block arb ──
      console.log(
        `[searcher/live] ${txHash.slice(0, 10)} mined in block ${tx.blockNumber}, checking next-block arb`,
      );
      submissionMode = "standalone";
      fixturePath = "mined";
      eventBlockNumber = tx.blockNumber;
      eventSourceBlockHash = await readBlockHash(
        ctx.provider,
        Math.max(0, eventBlockNumber - 1),
      );

      const receipt = await ctx.provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        throw new Error("on-chain receipt missing or reverted");
      }
      eventFrom = tx.from;
      eventNonce = tx.nonce;
      eventTo = tx.to;
      eventInput = tx.data;
      eventLogs = receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
      }));
      eventReceiptBlockNumber = receipt.blockNumber;
      eventReceiptBlockHash = receipt.blockHash;
      eventReceiptTransactionHash = receipt.hash;
      const receiptBlock = await ctx.provider.getBlock(receipt.blockNumber);
      if (
        !receiptBlock?.hash ||
        receiptBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
        receiptBlock.parentHash.toLowerCase() !== eventSourceBlockHash
      ) {
        throw new Error("on-chain receipt block is not a child of the source block");
      }
      eventReceiptParentBlockHash = receiptBlock.parentHash;
      eventLogsCompleteness = "complete-receipt";
      observedProtocolReceipt = {
        status: receipt.status,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: [...log.topics],
          data: log.data,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
        })),
      };
      // Debug: classify receipt log events
      const swapCount = eventLogs.filter((log) =>
        PRODUCTION_ADAPTER_FAMILIES.landedEvents().isSwapLog(log)
      ).length;
      const xferCount = eventLogs.filter((l) => l.topics[0]?.toLowerCase() === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef").length;
      console.log(
        `[searcher/live] ${txHash.slice(0, 10)} receipt: ${eventLogs.length} logs (${xferCount} Transfer, ${swapCount} Swap)`,
      );
    } else {
      // ── Path B: pending tx — apply raw tx on fork ──
      submissionMode = "victim-bundle";
      fixturePath = "rawTx";
      rawTx = (await rawTxByHash(ctx.provider, txHash, tx)) ?? undefined;
      if (!rawTx) throw new Error("raw tx unavailable");

      await ensureHintFork(latestBlock);
      const appliedHash = await ctx.state.applyRawTx(rawTx);
      if (appliedHash.toLowerCase() !== txHash.toLowerCase()) {
        throw new Error(`local victim hash mismatch ${appliedHash}`);
      }

      await prepareForkExecutor(ctx.state.provider, ctx.config.wallet.address, ctx.config.botvmAddress);

      const receipt = await ctx.state.provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        throw new Error("local victim receipt missing or reverted");
      }

      eventFrom = tx.from;
      eventNonce = tx.nonce;
      eventTo = tx.to;
      eventInput = tx.data;
      eventLogs = receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
      }));
      eventReceiptBlockNumber = receipt.blockNumber;
      eventReceiptBlockHash = receipt.blockHash;
      eventReceiptTransactionHash = receipt.hash;
      eventSourceBlockHash = await readBlockHash(ctx.provider, latestBlock);
      const forkSourceBlockHash = await readBlockHash(ctx.state.provider, latestBlock);
      if (forkSourceBlockHash !== eventSourceBlockHash) {
        throw new Error(
          `victim source fork hash mismatch ${forkSourceBlockHash} != ${eventSourceBlockHash}`,
        );
      }
      const receiptBlock = await ctx.state.provider.getBlock(receipt.blockNumber);
      if (
        !receiptBlock?.hash ||
        receiptBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
        receiptBlock.parentHash.toLowerCase() !== forkSourceBlockHash
      ) {
        throw new Error("local victim receipt block is not a child of the source fork");
      }
      eventReceiptParentBlockHash = receiptBlock.parentHash;
      eventLogsCompleteness = "complete-receipt";
    }
  }

  // ── Common pipeline: detect → plan → solve → simulate → submit ──
  const emitPipelineDropped = (
    stage: string,
    reason: string,
    error?: string,
    extra?: {
      sender?: string;
      pathId?: string;
      templateId?: string;
      plans?: number;
      ev?: {
        expected_profit_eth: string;
        gas_cost_eth: string;
        bid_eth: string;
        net_ev_wei: string;
        eth_usd: number | null;
        eth_usd_round_id: string | null;
        eth_usd_updated_at: string | null;
        max_base_fee_per_gas: string;
        decision_parent_hash: string | null;
      };
    },
  ): void => {
    const ev = {
      type: "pipeline_dropped" as const,
      opportunity_id: makeOpportunityId({ targetBlock: eventBlockNumber, victimHash: txHash }),
      target_block: eventBlockNumber,
      victim_hash: txHash,
      victim_source: victimSource,
      stage,
      reason,
      error: error ? error.slice(0, 240) : undefined,
      sender: extra?.sender,
      path_id: extra?.pathId,
      template_id: extra?.templateId,
      plans: extra?.plans,
      ...extra?.ev,
    };
    emitEvent(ev);
  };
  if (
    eventFrom !== ethers.ZeroAddress &&
    ctx.victimSource.shouldSkip(eventFrom.toLowerCase(), eventBlockNumber)
  ) {
    emitPipelineDropped("admission", "victim_source_low_landrate", undefined, { sender: eventFrom });
    return;
  }
  if (submissionMode === "victim-bundle" && rawTx && eventFrom !== ethers.ZeroAddress) {
    enqueuePendingVictimOutcome(ctx.pendingVictimOutcomes, {
      sender: eventFrom.toLowerCase(),
      hash: txHash,
      targetBlock: eventBlockNumber,
    });
  }

  const event: OrderflowEvent = {
    txHash,
    blockNumber: eventBlockNumber,
    rawTx: rawTx ?? "0x",
    from: eventFrom,
    nonce: eventNonce,
    to: eventTo,
    input: eventInput,
    logs: eventLogs,
    minProfit: ctx.config.minProfit,
    sourceBlockHash: eventSourceBlockHash,
    receiptBlockNumber: eventReceiptBlockNumber,
    receiptBlockHash: eventReceiptBlockHash,
    receiptParentBlockHash: eventReceiptParentBlockHash,
    receiptTransactionHash: eventReceiptTransactionHash,
    logsCompleteness: eventLogsCompleteness,
    victimState: fixturePath === "hash-only" ? "must-overlay" : "materialized",
  };

  if (observedProtocolReceipt) {
    void ctx.observeProtocolReceipt({
      txHash,
      blockNumber: eventBlockNumber,
      receipt: observedProtocolReceipt,
    });
  }

  segMark("prep"); // path A impersonateSwap / path B applyRawTx / path C refetch
  const opportunities = await ctx.detector.detect(event, ctx.state);
  segMark("detect");
  if (countedHintImpact) {
    ctx.counters.impacts += Math.max(0, opportunities.length - 1);
  } else {
    ctx.counters.impacts += opportunities.length;
  }
  if (opportunities.length === 0) {
    if (hintMutationOnly) {
      const detail = hintMutationOnly.mutations
        .slice(0, 4)
        .map((mutation) =>
          `${mutation.familyId}:${mutation.poolIdentity}:${mutation.reason}`
        )
        .join(",");
      emitPipelineDropped(
        "detect",
        hintMutationOnly.reason,
        detail,
      );
      console.log(
        `[searcher/live] ${txHash.slice(0, 10)} ` +
          `${hintMutationOnly.reason}; no directional PoolImpact fabricated ` +
          detail,
      );
    } else {
      console.log(`[searcher/live] ${txHash.slice(0, 10)} no matching graph pool`);
    }
    return;
  }
  fixtureOpportunities = opportunities.length;
  fixtureImpact ??= poolImpactFromOpportunity(opportunities[0]);
  ctx.counters.opportunities += opportunities.length;
  if (hint.source === "mempool") ctx.counters.mempoolOpportunitySeen += opportunities.length;
  console.log(
    `[searcher/live] detector: ${opportunities.length} opportunities — found in ${Date.now() - segStart}ms (${segStr()})`,
  );
  for (const opp of opportunities) {
    const opportunityId = opportunityIdFor(eventBlockNumber, txHash, opp);
    emitEvent({
      type: "opportunity_seen",
      opportunity_id: opportunityId,
      target_block: eventBlockNumber,
      victim_hash: txHash,
      pool: opp.affectedPools?.[0],
      tokens: opp.affectedTokens,
    });
  }

  await processOpportunities(
    ctx,
    opportunities,
    {
      kind: "backrun-arb",
      victimTxHash: txHash,
      victimSource,
      eventBlockNumber,
      victimRawTx: rawTx,
      submissionMode,
      resolveExecutionEvidence,
    },
    {
      recordFinalState,
      segMark,
      segStr,
      addFixturePlans: (n) => {
        fixturePlans += n;
      },
      event,
      latestBlock,
      fixturePath,
      fixtureImpact,
      ensureHintFork,
    },
  );
}

type BackrunSourceMeta = {
  kind: "backrun-arb";
  victimTxHash: string;
  victimSource: NonNullable<HintEnvelope["source"]>;
  eventBlockNumber: number;
  victimRawTx: string | undefined;
  submissionMode: BundleSubmission["mode"];
  resolveExecutionEvidence(
    familyIds: readonly ExecutionFamilyId[],
  ): Promise<readonly PendingExecutionEvidence[]>;
};

interface ProcessOppsDeps {
  recordFinalState: (
    finalState: LiveFinalState,
    error?: string,
    sim?: { calldata: string; profitToken: string; netProfit: bigint; gasUsed: bigint },
  ) => void;
  segMark: (k: string) => void;
  segStr: () => string;
  addFixturePlans: (n: number) => void;
  event: OrderflowEvent;
  latestBlock: number;
  fixturePath: LiveFixturePath;
  fixtureImpact: PoolImpact | null;
  ensureHintFork: (blockNumber: number, forceRefresh?: boolean) => Promise<void>;
}

async function processOpportunities(
  ctx: HandleCtx,
  opportunities: Opportunity[],
  sourceMeta: BackrunSourceMeta,
  deps: ProcessOppsDeps,
): Promise<void> {
  let lastTerminalState: LiveFinalState = "no-profitable-quote";
  let lastTerminalError: string | undefined;
  const event = deps.event;
  const latestBlock = deps.latestBlock;
  const fixturePath = deps.fixturePath;
  const fixtureImpact = deps.fixtureImpact;
  const ensureHintFork = deps.ensureHintFork;
  const hint = { source: sourceMeta.victimSource };

  for (let oppIndex = 0; oppIndex < opportunities.length; oppIndex++) {
    const opp = opportunities[oppIndex];
    if (!opp) continue;
    const opportunityId = opportunityIdFor(sourceMeta.eventBlockNumber, sourceMeta.victimTxHash, opp);
    const remainingTtl = ctx.config.oppTtlMs - (Date.now() - ctx.startedAt);
    if (remainingTtl <= 0) {
      for (const droppedOpp of opportunities.slice(oppIndex)) {
        emitEvent({
          type: "pipeline_dropped",
          opportunity_id: opportunityIdFor(sourceMeta.eventBlockNumber, sourceMeta.victimTxHash, droppedOpp),
          target_block: sourceMeta.eventBlockNumber,
          victim_hash: sourceMeta.victimTxHash,
          victim_source: sourceMeta.victimSource,
          stage: "solver",
          reason: "expired-before-solver",
          pool: droppedOpp.affectedPools?.[0],
          tokens: droppedOpp.affectedTokens,
          plans: 0,
        });
        ctx.counters.expiredBeforeSolver++;
      }
      deps.recordFinalState("expired-before-solver");
      return;
    }
    const oppsLeft = opportunities.length - oppIndex;
    const sliceMs = Math.max(ctx.config.oppMinSliceMs, Math.floor(remainingTtl / oppsLeft));
    const oppDeadlineAtMs = Math.min(Date.now() + sliceMs, ctx.startedAt + ctx.config.oppTtlMs);
    const emitPipelineDropped = (
      stage: string,
      reason: string,
      error?: string,
      extra?: {
        pathId?: string;
        templateId?: string;
        plans?: number;
        noCandidateDiagnostic?: unknown;
        ev?: {
          expected_profit_eth: string;
          gas_cost_eth: string;
          bid_eth: string;
          net_ev_wei: string;
          eth_usd: number | null;
          eth_usd_round_id: string | null;
          eth_usd_updated_at: string | null;
          max_base_fee_per_gas: string;
          decision_parent_hash: string | null;
        };
      },
    ): void => {
      emitEvent({
        type: "pipeline_dropped",
        opportunity_id: opportunityId,
        target_block: sourceMeta.eventBlockNumber,
        victim_hash: sourceMeta.victimTxHash,
        victim_source: sourceMeta.victimSource,
        stage,
        reason,
        error: error ? error.slice(0, 240) : undefined,
        pool: opp.affectedPools?.[0],
        tokens: opp.affectedTokens,
        path_id: extra?.pathId,
        template_id: extra?.templateId,
        plans: extra?.plans,
        no_candidate_diagnostic: extra?.noCandidateDiagnostic,
        ...extra?.ev,
      });
    };
    const plans = await ctx.planner.plan(opp, [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY], {
      deadlineAtMs: Date.now() + Math.min(ctx.config.planBudgetMs, Math.floor(sliceMs / 2)),
    });
    deps.segMark("plan");
    ctx.counters.plans += plans.length;
    deps.addFixturePlans(plans.length);
    console.log(`[searcher/live] planner: ${plans.length} candidate plans`);
    if (plans.length === 0) {
      const noCandidateDiagnostic = ctx.planner.lastNoCandidateDiagnostic?.();
      emitPipelineDropped(
        "plan",
        noCandidateDiagnostic?.classification === "plan_budget_exhausted"
          ? "plan_budget_exhausted"
          : noCandidateDiagnostic?.classification === "unpriceable_profit_token"
            ? "unpriceable_profit_token"
            : "no_candidate_plans",
        undefined,
        {
          plans: 0,
          noCandidateDiagnostic,
        },
      );
      continue;
    }
    const evidenceFamilyIds = [...new Set(plans.flatMap((plan) =>
      plan.tokenPath.edges.flatMap((edge) => {
        const owner = PRODUCTION_ADAPTER_FAMILIES.routes()
          .findForEdge(edge.adapterId);
        return owner?.pendingTransactionEvidence === undefined
          ? []
          : [owner.id];
      })
    ))];
    const executionEvidence = evidenceFamilyIds.length > 0
      ? await sourceMeta.resolveExecutionEvidence(evidenceFamilyIds)
      : Object.freeze([]);

    // Backend selection happens after planning. Preparing an overlay for an
    // opportunity with zero candidate paths is pure latency waste (observed as
    // 20s+ cold revm overlay on obscure WETH pairs), and it can expire the hint
    // before the solver gets a chance on real candidate plans.
    const oppImpact = poolImpactFromOpportunity(opp) ?? fixtureImpact;
    const prepareBaseBlock = fixturePath === "mined" ? sourceMeta.eventBlockNumber : latestBlock;
    const prepareBaseBlockHash = await readBlockHash(
      ctx.provider,
      prepareBaseBlock,
    );
    if (fixturePath === "hash-only" && opp.victimEffect.kind === "swap") {
      const generation = oppImpact?.sourceGeneration;
      const transitionGeneration = opp.victimEffect.transition?.sourceGeneration;
      const expectedHash = event.sourceBlockHash?.toLowerCase() ?? null;
      let generationError =
        !generation || !transitionGeneration
          ? "missing victim source generation"
          : generation.id !== transitionGeneration.id
            ? "impact/transition source generation mismatch"
            : generation.logsCompleteness !== "complete-receipt"
              ? "victim logs are not a complete receipt"
              : generation.sourceBlock !== prepareBaseBlock
                ? `source block ${generation.sourceBlock} != base block ${prepareBaseBlock}`
                : generation.sourceBlockHash === null ||
                    generation.sourceBlockHash !== expectedHash
                  ? "victim source block hash mismatch"
                  : null;
      if (generationError === null) {
        if (prepareBaseBlockHash !== generation!.sourceBlockHash) {
          generationError =
            `canonical source hash ${prepareBaseBlockHash} != ${generation!.sourceBlockHash}`;
        }
      }
      if (generationError !== null) {
        emitPipelineDropped(
          "prepare",
          "victim_source_generation_mismatch",
          generationError,
        );
        continue;
      }
    }
    let exactPostImpact: PostImpactSeed | null = null;
    if (fixturePath === "hash-only" && oppImpact) {
      const settled = await eventPostImpactSeedForSettled(
        oppImpact,
        prepareBaseBlock,
        Math.max(1, oppDeadlineAtMs - Date.now()),
      );
      if (!settled.ok) {
        lastTerminalState = "sim-revert";
        lastTerminalError =
          `victim runtime ${settled.familyId}/${settled.stage} failed: ${settled.reason}`;
        emitPipelineDropped(
          "overlay",
          "victim_runtime_family_failed",
          lastTerminalError,
          { plans: plans.length },
        );
        deps.recordFinalState(lastTerminalState, lastTerminalError);
        continue;
      }
      exactPostImpact = settled.value;
    }
    const overlayExact = exactPostImpact !== null;
    const prepareInput = {
      event,
      impact: oppImpact,
      baseBlock: prepareBaseBlock,
      baseBlockHash: prepareBaseBlockHash,
      path: fixturePath,
      routeHops: dedupeRouteHops(
        plans,
        ctx.config.revmPrewarmRouteHops,
        executionEvidence,
      ),
      postImpact: exactPostImpact ?? undefined,
      deadlineAtMs: oppDeadlineAtMs,
    };
    if (exactPostImpact !== null) {
      console.log(
        `[searcher/live] hash-only exact ${exactPostImpact.kind} overlay seed ` +
          postImpactSeedSummary(exactPostImpact),
      );
    }
    // Feed the between-block warmer: these pools recur across hints, so record
    // their quote directions to pre-warm recent longtail pools on the next block.
    if (oppImpact) {
      ctx.recentWarmPools.record({
        adapterId: oppImpact.matchedAdapterId,
        target: oppImpact.pool,
        tokenIn: oppImpact.tokenIn,
        tokenOut: oppImpact.tokenOut,
      }, oppImpact.amountIn, prepareInput.baseBlock, ctx.pinnedWarmTargets);
      for (
        const hop of dedupeRouteHops(
          plans,
          Number.MAX_SAFE_INTEGER,
        )
      ) {
        ctx.recentWarmPools.record(hop, oppImpact.amountIn, prepareInput.baseBlock, ctx.pinnedWarmTargets);
      }
    }
    let localVictimApply: LocalVictimApplyResult | null = null;
    let jitWarmCurrent: Promise<void> | null = null;
    const supportsConfiguredBackend = ctx.config.liveBackend !== "rpc" &&
      (ctx.liveBackend.supportsPath?.(prepareInput) ?? true);
    if (!overlayExact && supportsConfiguredBackend && oppImpact && victimUsesLocalCacheApply(oppImpact.matchedAdapterId)) {
      const applyStarted = Date.now();
      ctx.cache.beginHint(prepareInput.baseBlock);
      const localReadState = blockReadState(ctx.state, ctx.provider, prepareInput.baseBlock);
      const settled = await applyVictimSwapLocallySettled(
        ctx.cache,
        oppImpact,
        prepareInput.baseBlock,
        localReadState,
        Math.max(1, oppDeadlineAtMs - Date.now()),
      );
      if (!settled.ok) {
        lastTerminalState = "sim-revert";
        lastTerminalError =
          `victim runtime ${settled.familyId}/${settled.stage} failed: ${settled.reason}`;
        emitPipelineDropped(
          "overlay",
          "victim_runtime_family_failed",
          lastTerminalError,
          { plans: plans.length },
        );
        deps.recordFinalState(lastTerminalState, lastTerminalError);
        continue;
      }
      localVictimApply = settled.value;
      if (!localVictimApply) {
        try {
          if (victimNeedsMutablePoolRefresh(oppImpact.matchedAdapterId)) {
            await ctx.poolStateUpdater.update(prepareInput.baseBlock, [{
              adapterId: oppImpact.matchedAdapterId,
              target: oppImpact.pool,
              tokenIn: oppImpact.tokenIn,
              tokenOut: oppImpact.tokenOut,
              amountIn: oppImpact.amountIn,
            }], { awaitTicks: true, maxTickPools: 1 });
            const refreshed = await applyVictimSwapLocallySettled(
              ctx.cache,
              oppImpact,
              prepareInput.baseBlock,
              localReadState,
              Math.max(1, oppDeadlineAtMs - Date.now()),
            );
            if (!refreshed.ok) {
              lastTerminalState = "sim-revert";
              lastTerminalError =
                `victim runtime ${refreshed.familyId}/${refreshed.stage} failed: ` +
                refreshed.reason;
              emitPipelineDropped(
                "overlay",
                "victim_runtime_family_failed",
                lastTerminalError,
                { plans: plans.length },
              );
              deps.recordFinalState(lastTerminalState, lastTerminalError);
              continue;
            }
            localVictimApply = refreshed.value;
          }
        } catch (err) {
          console.log(
            `[searcher/live] victim-apply seed failed, falling back to revm overlay: ` +
              `${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
          );
        }
      }
      if (localVictimApply) {
        deps.segMark("victimApply");
        console.log(
          `[searcher/live] victim-apply local ${oppImpact.matchedAdapterId} ` +
            `${oppImpact.pool.slice(0, 10)} amountOut=${localVictimApply.amountOut} ` +
            `${Date.now() - applyStarted}ms`,
        );
      } else {
        console.log(
          `[searcher/live] victim-apply unavailable for ${oppImpact.matchedAdapterId} ` +
            `${oppImpact.pool.slice(0, 10)}, falling back to revm overlay`,
        );
      }
    }

    if (
      localVictimApply &&
      ctx.config.liveBackend !== "rpc" &&
      ctx.liveBackend.warmPrepareState &&
      process.env.SEARCHER_REVM_JIT_WARM_CURRENT !== "0"
    ) {
      const warmStarted = Date.now();
      jitWarmCurrent = ctx.liveBackend
        .warmPrepareState({
          ...prepareInput,
          postImpact: localVictimApply.postImpact,
        })
        .then(() => {
          console.log(
            `[searcher/live] jit warm current ${localVictimApply!.postImpact.kind} ` +
              `${oppImpact?.pool.slice(0, 10) ?? "n/a"} ${Date.now() - warmStarted}ms`,
          );
        })
        .catch((err) => {
          console.log(
            `[searcher/live] jit warm current failed: ` +
              `${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
          );
        });
    }

    let preparedSourceBlockHash: string | null = null;
    let useConfiguredBackend = ctx.config.liveBackend === "rpc" || localVictimApply !== null;
    if (!localVictimApply && ctx.config.liveBackend !== "rpc" && supportsConfiguredBackend) {
      try {
        const prepared = await ctx.liveBackend.prepareVictimState(prepareInput);
        preparedSourceBlockHash = prepared.blockHash ?? null;
        deps.segMark("overlay");
        useConfiguredBackend = true;
      } catch (err) {
        ctx.counters.revmErrors++;
        const message = err instanceof Error ? err.message : String(err);
	        if (isBalanceSlotMissingMessage(message)) {
	          lastTerminalState = "no-profitable-quote";
	          lastTerminalError = message;
          console.log(
            `[searcher/live] revm prepare skipped (balance slot missing, no anvil fallback): ` +
              `${message.slice(0, 160)}`,
	          );
	          emitPipelineDropped("overlay", "balance_slot_missing", lastTerminalError, { plans: plans.length });
	          deps.recordFinalState(lastTerminalState, lastTerminalError);
	          continue;
	        }
        lastTerminalState = "sim-revert";
        lastTerminalError = `revm prepare failed: ${message}`;
	        console.log(
	          `[searcher/live] revm prepare skipped (no anvil fallback): ` +
	            `${message.slice(0, 160)}`,
	        );
	        emitPipelineDropped("overlay", "revm_prepare_failed", lastTerminalError, { plans: plans.length });
	        deps.recordFinalState(lastTerminalState, lastTerminalError);
	        continue;
	      }
    }
    if (!localVictimApply && (ctx.config.liveBackend === "rpc" || !useConfiguredBackend) && fixturePath === "hash-only") {
      if (!oppImpact) throw new Error("hash-only fallback missing impact");
      try {
        await ensureHintFork(latestBlock);
        if (exactPostImpact) {
          const overrides = await applyPostImpactOverridesToAnvil(ctx.state, exactPostImpact);
          console.log(
            `[searcher/live] anvil exact ${exactPostImpact.kind} post-state overlay ` +
              `${postImpactSeedSummary(exactPostImpact)} overrides=${overrides}`,
          );
        } else {
          await replayVictimSwapOnAnvil(
            ctx.state,
            oppImpact,
            ctx.graph,
            Math.max(1, oppDeadlineAtMs - Date.now()),
          );
        }
        await prepareForkExecutor(ctx.state.provider, ctx.config.wallet.address, ctx.config.botvmAddress);
      } catch (err) {
        const familyId = PRODUCTION_ADAPTER_FAMILIES
          .routes()
          .findForEdge(oppImpact.matchedAdapterId)
          ?.id ?? oppImpact.matchedAdapterId;
        const message = err instanceof Error ? err.message : String(err);
        lastTerminalState = "sim-revert";
        lastTerminalError =
          `victim runtime ${familyId} failed: ${message}`;
        emitPipelineDropped(
          "overlay",
          "victim_runtime_family_failed",
          lastTerminalError,
          { plans: plans.length },
        );
        deps.recordFinalState(lastTerminalState, lastTerminalError);
        continue;
      }
      deps.segMark(exactPostImpact ? "anvilExactOverlay" : "anvilOverlay");
    }
    if (!localVictimApply && (ctx.config.liveBackend === "rpc" || !useConfiguredBackend) && fixturePath === "mined") {
      await ensureHintFork(sourceMeta.eventBlockNumber, true);
      await prepareForkExecutor(ctx.state.provider, ctx.config.wallet.address, ctx.config.botvmAddress);
      deps.segMark("anvilMined");
    }
    const solveProbe = useConfiguredBackend ? ctx.liveBackend : ctx.simulator;
    // In revm/hybrid mode the anvil fork is never started, so route the solver's
    // state reads (PoolStateCache warm-up + quoter fallback) through the live
    // backend's warm post-victim overlay. This is what makes path-B local math
    // run against the shifted state instead of re-faulting slots or bypassing the
    // cache entirely via quoteSource. rpc mode keeps the anvil state backend.
    const useRevmReadState = useConfiguredBackend && ctx.config.liveBackend !== "rpc" && !localVictimApply;
    ctx.cache.beginHint(
      prepareInput.baseBlock,
      localVictimApply || exactPostImpact
        ? { postImpact: [localVictimApply?.postImpact ?? exactPostImpact!] }
        : oppImpact ? [oppImpact.pool] : [],
    );
    const solveState = useRevmReadState
      ? revmReadState(ctx.state, ctx.liveBackend)
      : localVictimApply
        ? blockReadState(ctx.state, ctx.provider, prepareInput.baseBlock)
      : ctx.state;

	    let candidatesTried = 0;
	    let skipPostSolverDrop = false;
	    for (const candidate of plans) {
      // Candidate cap: a single opportunity can spawn ~20 candidate plans, each
      // running a full quote search + top-N sim that virtually all revert
      // (unprofitable). Grinding every one burns the shared per-hint TTL and
      // starves later candidates/opps into `expired-before-solver`. Bail after
      // maxCandidatesPerOpp to leave budget for the rest of the hint. (0 = off)
      if (ctx.config.maxCandidatesPerOpp > 0 && candidatesTried >= ctx.config.maxCandidatesPerOpp) {
        console.log(
          `[searcher/live] candidate cap: tried ${candidatesTried}/${plans.length} for this opp ` +
            `(hintOpps=${opportunities.length}) — bail to free TTL budget. ${deps.segStr()}`,
        );
        emitPipelineDropped("solver", "candidate-cap", lastTerminalError, {
          plans: plans.length,
        });
        skipPostSolverDrop = true;
        break;
      }
	      // Opportunity slice TTL: keep one slow opportunity from consuming the whole
	      // hint budget. Each solve is further capped to the remaining slice.
	      const remainingMs = oppDeadlineAtMs - Date.now();
	      if (remainingMs <= 0) {
	        const hintElapsedMs = Date.now() - ctx.startedAt;
	        if (hintElapsedMs >= ctx.config.oppTtlMs) {
	          ctx.counters.expiredBeforeSolver++;
	          console.log(
	            `[searcher/live] opportunity expired (hint TTL) ` +
	              `(${hintElapsedMs}ms > TTL ${ctx.config.oppTtlMs}ms) — never reached solver ` +
	              `(hintOpps=${opportunities.length} candidatesTried=${candidatesTried}/${plans.length}). ` +
	              `stage breakdown: ${deps.segStr()}`,
	          );
	          emitPipelineDropped("solver", "expired-before-solver", undefined, { plans: plans.length });
	          deps.recordFinalState("expired-before-solver");
	          return;
	        }
	        console.log(
	          `[searcher/live] opportunity expired (slice) ` +
	            `(${Date.now()} >= sliceDeadline ${oppDeadlineAtMs}) — moving to next opportunity ` +
	            `(hintOpps=${opportunities.length} candidatesTried=${candidatesTried}/${plans.length}). ` +
	            `stage breakdown: ${deps.segStr()}`,
	        );
	        if (candidatesTried === 0) {
	          ctx.counters.expiredBeforeSolver++;
	          lastTerminalState = "expired-before-solver";
	          lastTerminalError = undefined;
	          emitPipelineDropped("solver", "expired-before-solver", undefined, { plans: plans.length });
	          skipPostSolverDrop = true;
	        }
	        break;
	      }
      candidatesTried++;
      try {
        ctx.counters.solverEntered++;
        const resolved = await ctx.solver.solve(candidate, solveState, solveProbe, {
          deadlineMs: Math.min(ctx.config.solverDeadlineMs, remainingMs),
          gssMaxTries: ctx.config.gssMaxTries,
          finalSimTopN: ctx.config.finalSimTopN,
          quoteProfitFloorBps: ctx.config.quoteProfitFloorBps,
          quoteSafetyBps: ctx.config.quoteSafetyBps,
          cache: ctx.cache,
          // F8 default authority: the strict quote source is the only
          // solver pricing path once the durable composition is the default.
          // The legacy live backend is no longer a quote fallback; a solver
          // without a strict source fails closed (no quote).
          quoteSource: useConfiguredBackend && ctx.config.liveBackend !== "rpc" && !localVictimApply
            ? ctx.strictQuoteSource
            : undefined,
          deferPhase2Sim: localVictimApply !== null && useConfiguredBackend && ctx.config.liveBackend !== "rpc",
          executionEvidence,
        });
        deps.segMark("solve");
        ctx.counters.solverSuccess++;
        // Terminal verify (v7 AC-3a.4): re-simulate the resolved plan and require
        // strictly positive profit before paying gas — never submit on a plan that
        // only broke even or drifted negative since the solver picked it.
        if (localVictimApply && useConfiguredBackend && ctx.config.liveBackend !== "rpc") {
          if (!shouldRunFinalVerify(
            resolved.netProfit,
            resolved.flashAmount,
            ctx.config.finalVerifyFloorBps,
          )) {
            ctx.counters.finalVerifySkipped++;
            lastTerminalState = "no-profitable-quote";
            lastTerminalError =
              `quoteProfit ${resolved.netProfit} below final verify floor ` +
              `${ctx.config.finalVerifyFloorBps}bps`;
	            console.log(
	              `[searcher/live] final verify skipped: ${lastTerminalError}`,
	            );
	            emitPipelineDropped("final_verify", "below_final_verify_floor", lastTerminalError, {
	              pathId: resolvedRouteSummary(resolved.root),
	              templateId: candidate.templateName,
	              plans: plans.length,
	            });
	            deps.recordFinalState(lastTerminalState, lastTerminalError);
	            continue;
	          }
          try {
            if (jitWarmCurrent) {
              const waitStarted = Date.now();
              await jitWarmCurrent;
              const waited = Date.now() - waitStarted;
              if (waited > 50) console.log(`[searcher/live] jit warm wait ${waited}ms`);
            }
            const prepared = await ctx.liveBackend.prepareVictimState({
              ...prepareInput,
              postImpact: localVictimApply.postImpact,
            });
            preparedSourceBlockHash = prepared.blockHash ?? null;
            deps.segMark("finalOverlay");
          } catch (err) {
            ctx.counters.revmErrors++;
            const message = err instanceof Error ? err.message : String(err);
            lastTerminalState = "sim-revert";
            lastTerminalError = `final overlay failed: ${message}`;
	            console.log(
	              `[searcher/live] final overlay failed after local victim-apply: ` +
	                `${message.slice(0, 160)}`,
	            );
	            emitPipelineDropped("overlay", "final_overlay_failed", lastTerminalError, {
	              pathId: resolvedRouteSummary(resolved.root),
	              templateId: candidate.templateName,
	              plans: plans.length,
	            });
	            deps.recordFinalState(lastTerminalState, lastTerminalError);
	            continue;
	          }
        }
        const sim = useConfiguredBackend
          ? (ctx.liveBackend.finalVerify
              ? await ctx.liveBackend.finalVerify(resolved)
              : await ctx.liveBackend.simulate(resolved))
          : await ctx.simulator.simulate(resolved);
        if (hint.source === "mempool") ctx.counters.mempoolToSim++;
        emitEvent({
          type: "simulation_result",
          opportunity_id: opportunityId,
          target_block: sourceMeta.eventBlockNumber,
          victim_hash: sourceMeta.victimTxHash,
          path_id: resolvedRouteSummary(resolved.root),
          template_id: candidate.templateName,
          ok: sim.success && sim.netProfit > 0n,
          simulated_profit: sim.netProfit.toString(),
          profit_token: resolved.profitToken,
          gas_estimate: sim.gasUsed.toString(),
          failure_reason: sim.success ? undefined : sim.revertReason,
        });
        if (sim.success && sim.netProfit > 0n) {
          ctx.counters.simSuccess++;
          if (ctx.config.liveBackend === "rpc" || ctx.config.liveBackend === "hybrid") {
            ctx.counters.rpcVerifySuccess++;
          }
          if (ctx.config.liveBackend === "revm" || ctx.config.liveBackend === "hybrid") {
            ctx.counters.revmSimSuccess++;
          }
        }
        // The flash loan must repay (enforced by the assert-balance guard), so a
        // successful sim with positive profit guarantees token profit > 0. Gas
        // economics are the builder's concern — we submit with expectedProfit.
        if (!sim.success) {
          ctx.counters.simReverts++;
          lastTerminalState = "sim-revert";
          lastTerminalError = sim.revertReason;
          console.log(
            `[searcher/live] final sim rejected: ` +
              `quoteProfit=${resolved.netProfit} finalProfit=${sim.netProfit} ` +
              `flashAmount=${resolved.flashAmount} profitToken=${resolved.profitToken} ` +
              `route=${resolvedRouteSummary(resolved.root)} ` +
              `reason=${sim.revertReason ?? "no-positive-profit"}`,
          );
          deps.recordFinalState("sim-revert", sim.revertReason, sim);
          continue;
        }
        // Strictly positive profit required to submit — a closed-loop flash arb
        // that returns < flashAmount cannot repay the flash (reverts at repayment,
        // so sim.success is already false here), so a "losing bundle" is physically
        // impossible. The quote-profit floor only widens phase-1 admission to catch
        // quotes the safety haircut made pessimistically-negative but that sim
        // positive; it does NOT relax this gate.
        if (sim.netProfit <= 0n) {
          ctx.counters.finalVerifyFailed++;
          lastTerminalState = "final-verify-failed";
          lastTerminalError = `non-positive final profit ${sim.netProfit}`;
          deps.recordFinalState("final-verify-failed", lastTerminalError, sim);
          continue;
        }

        // Real-victim / hash-only gate (Fix A): approximate hash-only bundles
        // reconstruct the pending swap with a SYNTHETIC overlay (whale swaps
        // impact.amountIn), which can inflate the sim and over-size the builder
        // payment. Real-victim bundles carry rawTx; exact hash-only overlays use
        // event-derived post-state but still have no landed order to backrun, so
        // exact-overlay MEV-Share submit requires its own explicit override.
        const allowApproxHashOnlySubmit = !overlayExact && ctx.config.allowHashOnlySubmit;
        if (
          !hashOnlySubmitDecision(
            Boolean(sourceMeta.victimRawTx),
            overlayExact,
            allowApproxHashOnlySubmit,
            ctx.config.allowHashOnlyMevShareSubmit,
          )
        ) {
          ctx.counters.finalVerifySkipped++;
          lastTerminalState = "no-profitable-quote";
          const hashOnlyDropReason = overlayExact
            ? "hash_only_unmatchable"
            : "hash_only_unverifiable";
          lastTerminalError = overlayExact
            ? `hash-only unmatchable (exact overlay has no landed order) route=${resolvedRouteSummary(resolved.root)}`
            : `hash-only unverifiable (no real victim or exact overlay) route=${resolvedRouteSummary(resolved.root)}`;
          console.log(`[searcher/live] skip hash-only submit: ${lastTerminalError}`);
          emitPipelineDropped("submit_gate", hashOnlyDropReason, lastTerminalError, {
            pathId: resolvedRouteSummary(resolved.root),
            templateId: candidate.templateName,
            plans: plans.length,
          });
          deps.recordFinalState(lastTerminalState, lastTerminalError, sim);
          continue;
        }

        // Phantom-profit guard: a closed-loop backrun capturing a large fraction
        // of the flash notional is not real — it means the revm victim overlay
        // dislocated the pool (curve/univ3 state bug). Reject before submitting
        // so we never spam builders or bribe against a fake profit.
        if (
          resolved.flashAmount > 0n &&
          sim.netProfit * 10000n > resolved.flashAmount * ctx.config.maxProfitBpsOfFlash
        ) {
          ctx.counters.finalVerifyFailed++;
          lastTerminalState = "final-verify-failed";
          lastTerminalError =
            `phantom profit ${sim.netProfit} > ${ctx.config.maxProfitBpsOfFlash}bps of ` +
            `flash ${resolved.flashAmount} route=${resolvedRouteSummary(resolved.root)}`;
	          console.log(`[searcher/live] reject phantom: ${lastTerminalError}`);
	          emitPipelineDropped("submit_gate", "phantom_profit", lastTerminalError, {
	            pathId: resolvedRouteSummary(resolved.root),
	            templateId: candidate.templateName,
	            plans: plans.length,
	          });
	          deps.recordFinalState("final-verify-failed", lastTerminalError, sim);
	          continue;
	        }

        // Value the profit in ETH, then apply a scale-invariant haircut to absorb
        // sim-vs-real error. The discounted figure drives BOTH the EV gate AND the
        // bribe size — so we never gate or bribe off an over-estimate (this also
        // damps the adverse-selection: we'd otherwise overbribe exactly the bundles
        // we most over-estimated, and win the losers). Calibrate the haircut from
        // the reconciliation of landed txs (real profit vs the logged sim profit).
        const ev = await evaluateEv(
          ctx.provider,
          resolved.profitToken,
          sim.netProfit,
          sim.gasUsed,
          ctx.config,
          ctx.profitTokenValuation,
          prepareInput.baseBlock,
        );
        const {
          valuationAvailable,
          gasMeasurementAvailable,
          feeStateAvailable,
          sourceBlockHash,
          ethUsd,
          ethUsdRoundId,
          ethUsdUpdatedAt,
          expectedProfitEth,
          gasUnits,
          maxBaseFeePerGas,
          gasCostEth,
          bidEth,
          netEvWei,
        } = ev;
        const evEvent = {
          expected_profit_eth: expectedProfitEth.toString(),
          gas_cost_eth: gasCostEth.toString(),
          bid_eth: bidEth.toString(),
          net_ev_wei: netEvWei.toString(),
          eth_usd: ethUsd,
          eth_usd_round_id: ethUsdRoundId?.toString() ?? null,
          eth_usd_updated_at: ethUsdUpdatedAt?.toString() ?? null,
          max_base_fee_per_gas: maxBaseFeePerGas.toString(),
          decision_parent_hash: ctx.config.evGate
            ? sourceBlockHash
            : prepareBaseBlockHash,
        };

        if (
          ctx.config.evGate &&
          (
            ev.sourceBlockHash === null ||
            ev.sourceBlockHash !== prepareBaseBlockHash ||
            (
              preparedSourceBlockHash !== null &&
              preparedSourceBlockHash !== ev.sourceBlockHash
            )
          )
        ) {
          ctx.counters.finalVerifySkipped++;
          lastTerminalState = "no-profitable-quote";
          lastTerminalError =
            `EV/simulation source hash mismatch expected=${prepareBaseBlockHash} ` +
            `prepared=${preparedSourceBlockHash ?? "unreported"} ` +
            `ev=${ev.sourceBlockHash ?? "missing"}`;
          emitPipelineDropped("submit_gate", "stale_ev_state", lastTerminalError, {
            pathId: resolvedRouteSummary(resolved.root),
            templateId: candidate.templateName,
            plans: plans.length,
            ev: evEvent,
          });
          deps.recordFinalState(lastTerminalState, lastTerminalError, sim);
          continue;
        }

        if (ctx.config.evGate && !valuationAvailable) {
          ctx.counters.finalVerifySkipped++;
          lastTerminalState = "no-profitable-quote";
          lastTerminalError = `unpriceable profit token ${resolved.profitToken}`;
          console.log(`[searcher/live] skip unpriceable: ${lastTerminalError}`);
          emitPipelineDropped("submit_gate", "unpriceable_profit_token", lastTerminalError, {
            pathId: resolvedRouteSummary(resolved.root),
            templateId: candidate.templateName,
            plans: plans.length,
            ev: evEvent,
          });
          deps.recordFinalState(lastTerminalState, lastTerminalError, sim);
          continue;
        }
        if (ctx.config.evGate && !gasMeasurementAvailable) {
          ctx.counters.finalVerifySkipped++;
          lastTerminalState = "no-profitable-quote";
          lastTerminalError = "EV gate: final simulation did not measure gas";
          emitPipelineDropped("submit_gate", "missing_gas_estimate", lastTerminalError, {
            pathId: resolvedRouteSummary(resolved.root),
            templateId: candidate.templateName,
            plans: plans.length,
            ev: evEvent,
          });
          deps.recordFinalState(lastTerminalState, lastTerminalError, sim);
          continue;
        }
        if (ctx.config.evGate && !feeStateAvailable) {
          ctx.counters.finalVerifySkipped++;
          lastTerminalState = "no-profitable-quote";
          lastTerminalError = `EV gate: source block ${prepareInput.baseBlock} fee state unavailable`;
          emitPipelineDropped("submit_gate", "missing_fee_state", lastTerminalError, {
            pathId: resolvedRouteSummary(resolved.root),
            templateId: candidate.templateName,
            plans: plans.length,
            ev: evEvent,
          });
          deps.recordFinalState(lastTerminalState, lastTerminalError, sim);
          continue;
        }

        const creditLiveMarkerPath =
          process.env.SEARCHER_CREDIT_LIVE_MARKER_PATH ?? DEFAULT_CREDIT_LIVE_MARKER_PATH;
        const standingGuard = evaluateStandingGuard(
          candidate.tokenPath.edges,
          creditLiveMarkerPath,
        );
        const containsStandingPosition = standingGuard.containsStandingPosition;
        if (!standingGuard.allowed) {
          ctx.counters.finalVerifySkipped++;
          lastTerminalState = "no-profitable-quote";
          lastTerminalError = standingGuard.reason === "edge_taxonomy_inconsistent"
            ? "standing guard: edge taxonomy inconsistent"
            : `standing position unauthorized: marker missing ${creditLiveMarkerPath}`;
          console.log(`[searcher/live] reject standing-position: ${lastTerminalError}`);
          emitPipelineDropped("submit_gate", standingGuard.reason, lastTerminalError, {
            pathId: resolvedRouteSummary(resolved.root),
            templateId: candidate.templateName,
            plans: plans.length,
          });
          deps.recordFinalState(lastTerminalState, lastTerminalError, sim);
          continue;
        }

        // Net-EV gate and signer share the exact EIP-1559 fee derived from the
        // source block. Zero retained profit is not +EV.
        if (ctx.config.evGate) {
          if (netEvWei <= ctx.config.minNetEth) {
            ctx.counters.finalVerifySkipped++;
            lastTerminalState = "no-profitable-quote";
            lastTerminalError =
              `EV gate: net ${netEvWei} <= ${ctx.config.minNetEth} ` +
              `(profitEth=${expectedProfitEth} gas=${gasCostEth} bribe=${bidEth} ` +
              `token=${resolved.profitToken.slice(0, 10)})`;
	            console.log(`[searcher/live] skip below-EV: ${lastTerminalError}`);
	            emitPipelineDropped("submit_gate", "below_ev_gate", lastTerminalError, {
	              pathId: resolvedRouteSummary(resolved.root),
	              templateId: candidate.templateName,
	              plans: plans.length,
	              ev: evEvent,
	            });
	            deps.recordFinalState(lastTerminalState, lastTerminalError, sim);
	            continue;
	          }
          console.log(
            `[searcher/live] EV ok: net=${ethers.formatEther(netEvWei)} ETH ` +
              `profitEth=${ethers.formatEther(expectedProfitEth)} gas=${ethers.formatEther(gasCostEth)} ` +
              `bribe=${ethers.formatEther(bidEth)} ethUsd=${ethUsd ?? "n/a"} ` +
              `targetBaseFee=${maxBaseFeePerGas}`,
          );
        }

        const latestAtSubmit = await readUncachedLatestBlock(ctx.provider);
        if (
          latestAtSubmit.number !== prepareInput.baseBlock ||
          latestAtSubmit.hash !== prepareBaseBlockHash ||
          (
            ctx.config.evGate &&
            sourceBlockHash !== prepareBaseBlockHash
          )
        ) {
          const error =
            `EV source block ${prepareInput.baseBlock} is stale at ` +
            `head=${latestAtSubmit.number} expectedHash=${prepareBaseBlockHash} ` +
            `evHash=${sourceBlockHash ?? "not-required"} canonicalHash=${latestAtSubmit.hash}`;
          emitPipelineDropped("submit_gate", "stale_ev_state", error, {
            pathId: resolvedRouteSummary(resolved.root),
            templateId: candidate.templateName,
            plans: plans.length,
            ev: evEvent,
          });
          deps.recordFinalState("no-profitable-quote", error, sim);
          continue;
        }
        const targetBlock = prepareInput.baseBlock + 1;
        const decision = ctx.submissionCoordinator.offer({
          strategy: "backrun",
          opportunityId,
          targetBlock,
          netEvWei,
          deadlineAtMs: oppDeadlineAtMs,
        });
        if (!decision.admit) {
          emitPipelineDropped("submit_gate", decision.reason, undefined, {
            pathId: resolvedRouteSummary(resolved.root),
            templateId: candidate.templateName,
            plans: plans.length,
          });
          deps.recordFinalState(lastTerminalState, lastTerminalError, sim);
          continue;
        }
        ctx.counters.submitAttempts++;
        const results = await ctx.bundleRouter.submit({
          victimTxHash: sourceMeta.victimTxHash,
          victimRawTx: sourceMeta.victimRawTx,
          mode: sourceMeta.submissionMode,
          backrunCalldata: sim.calldata,
          targetBlock,
          expectedProfit: sim.netProfit,
          expectedProfitEth,
          bribeBps: ctx.config.bribeBps,
          bribeWei: bidEth,
          maxBaseFeePerGas,
          gasUsed: gasUnits,
          safety: { leavesStandingPosition: containsStandingPosition, authorized: standingGuard.allowed },
        });
        ctx.counters.accepted += results.filter((r) => r.accepted).length;
        const bundleHash = results.find((r) => r.bundleHash)?.bundleHash;
        const backrunTxHash = results.find((r) => r.backrunTxHash)?.backrunTxHash;
        const mode = sourceMeta.submissionMode === "standalone"
          ? "standalone eth_sendBundle"
          : sourceMeta.victimRawTx ? "eth_sendBundle" : "mev_sendBundle";
        console.log(
          `[searcher/live] submitted via ${mode} targetBlock=${targetBlock} ` +
            `profit=${sim.netProfit} route=${resolvedRouteSummary(resolved.root)}` +
            `${bundleHash ? ` bundleHash=${bundleHash}` : ""}`,
        );
        if (backrunTxHash) {
          emitEvent({
            type: "bundle_submitted",
            opportunity_id: opportunityId,
            target_block: sourceMeta.eventBlockNumber,
            submission_target_block: targetBlock,
            victim_hash: sourceMeta.victimTxHash,
            mode,
            path_id: resolvedRouteSummary(resolved.root),
            template_id: candidate.templateName,
            simulated_profit: sim.netProfit.toString(),
            simulated_profit_eth: expectedProfitEth.toString(),
            bid: bidEth.toString(),
            gas_cost_eth: gasCostEth.toString(),
            net_ev_wei: netEvWei.toString(),
            eth_usd: ethUsd,
            eth_usd_round_id: ethUsdRoundId?.toString() ?? null,
            eth_usd_updated_at: ethUsdUpdatedAt?.toString() ?? null,
            max_base_fee_per_gas: maxBaseFeePerGas.toString(),
            decision_parent_hash: ctx.config.evGate
              ? sourceBlockHash
              : prepareBaseBlockHash,
            tx_hash: backrunTxHash,
            calldata_hash: ethers.keccak256(sim.calldata),
            builders_sent: results.map((r) => r.builder),
            bundle_hash: bundleHash,
            accepted: results.filter((r) => r.accepted).length,
          });
        }
        if (backrunTxHash && results.some((r) => r.accepted)) {
          trackInclusion({
            provider: ctx.provider,
            backrunTxHash,
            opportunityId,
            targetBlock,
            watchBlocks: ctx.config.inclusionWatchBlocks,
            emit: emitEvent,
          });
        }
        deps.recordFinalState("would-submit", undefined, sim);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastTerminalState = isTimeoutMessage(message) ? "quote-timeout" : "no-profitable-quote";
        lastTerminalError = message;
        if (lastTerminalState === "quote-timeout") ctx.counters.quoteTimeouts++;
        if (message.toLowerCase().includes("missing")) ctx.counters.missingState++;
	        console.log(
	          `[searcher/live] candidate failed: ` +
	            `${message}`.slice(0, 180),
	        );
	      }
	    }
		    if (!skipPostSolverDrop) {
		      emitPipelineDropped("solver", lastTerminalState, lastTerminalError, { plans: plans.length });
		    }
		  }
  deps.recordFinalState(lastTerminalState, lastTerminalError);
}

async function readUncachedLatestBlock(
  provider: ethers.JsonRpcProvider,
): Promise<{ number: number; hash: string }> {
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]) as {
    number?: unknown;
    hash?: unknown;
  } | null;
  if (
    typeof block?.number !== "string" ||
    typeof block.hash !== "string" ||
    !ethers.isHexString(block.hash, 32)
  ) {
    throw new Error("latest block response missing a valid number/hash");
  }
  return {
    number: ethers.toNumber(block.number),
    hash: block.hash.toLowerCase(),
  };
}

async function readLatestBlockAnchor(
  provider: ethers.JsonRpcProvider,
): Promise<{ number: number; hash: string; stateRoot: string }> {
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]) as {
    number?: unknown;
    hash?: unknown;
    stateRoot?: unknown;
  } | null;
  if (
    typeof block?.number !== "string" ||
    typeof block.hash !== "string" ||
    typeof block.stateRoot !== "string" ||
    !ethers.isHexString(block.hash, 32) ||
    !ethers.isHexString(block.stateRoot, 32)
  ) {
    throw new Error("latest block response missing blind-run anchor fields");
  }
  return {
    number: ethers.toNumber(block.number),
    hash: block.hash.toLowerCase(),
    stateRoot: block.stateRoot.toLowerCase(),
  };
}

async function maybeSubmitBlockScanAtomic(params: {
  config: LiveConfig;
  provider: ethers.JsonRpcProvider;
  finalSimulationRuntime: FinalSimulationWorkRuntime<
    ResolvedPlan,
    SimulationResult
  >;
  sourceGeneration: number;
  bundleRouter: BundleRouter;
  submissionCoordinator: SubmissionCoordinator;
  opp: BlockScanOpportunity;
  resolved: ResolvedPlan;
  sourceBlock: number;
  ring: string;
  protoRing: boolean;
  plans: number;
  passDeadlineAtMs: number;
  rejectBlacklist: BlockScanRejectBlacklistState;
  profitTokenValuation: ProfitTokenValuation;
  sourceBlockHash: string;
  signal: AbortSignal;
  collectBlindAudit: boolean;
  strategyVersions: {
    strategy_view_version: string;
    blockscan_view_hash: string;
  };
}): Promise<BlockScanAtomicResult> {
  const timing = {
    finalSimMs: 0,
    evMs: 0,
    finalSimStartedAtMs: null as number | null,
    finalSimFinishedAtMs: null as number | null,
    evStartedAtMs: null as number | null,
    evFinishedAtMs: null as number | null,
  };
  let evStartedAt: number | null = null;
  let finalSimStatus: BlockScanAtomicResult["finalSimStatus"] = "not-run";
  let auditSimulation: BlindProductionOpportunityEvidence["simulation"] | null =
    params.collectBlindAudit
      ? {
          executed: false,
          success: false,
          profitRaw: "0",
          gasUsed: "0",
          calldataSha256: blindProductionCalldataSha256("0x"),
          standingPosition: params.opp.leavesStandingPosition,
        }
      : null;
  let auditEv: BlindProductionOpportunityEvidence["ev"] | null =
    params.collectBlindAudit
      ? {
          executionStatus: "not_run",
          decision: "reject",
          reason: "not_reached",
        }
      : null;
  const recordAuditEv = (
    value: BlindProductionOpportunityEvidence["ev"],
  ): void => {
    if (collectBlindAudit) auditEv = value;
  };
  const closeEvTiming = (): void => {
    if (evStartedAt === null) return;
    timing.evMs += Math.max(0, performance.now() - evStartedAt);
    timing.evFinishedAtMs = Date.now();
    evStartedAt = null;
  };
  const finish = (
    decision: string,
    submitted = false,
    terminalForQuoteSet = true,
  ): BlockScanAtomicResult => {
    closeEvTiming();
    const terminalAuditEv = auditEv?.reason === "not_reached"
      ? { ...auditEv, reason: decision }
      : auditEv;
    return {
      decision,
      submitted,
      terminalForQuoteSet,
      finalSimStatus,
      audit: auditSimulation && terminalAuditEv
        ? {
            simulation: auditSimulation,
            ev: terminalAuditEv,
          }
        : null,
      timing: { ...timing },
    };
  };
  const {
    config,
    provider,
    finalSimulationRuntime,
    sourceGeneration,
    bundleRouter,
    submissionCoordinator,
    opp,
    resolved,
    sourceBlock,
    ring,
    protoRing,
    plans,
    passDeadlineAtMs,
    rejectBlacklist,
    profitTokenValuation,
    sourceBlockHash,
    signal,
    collectBlindAudit,
    strategyVersions,
  } = params;
  if (signal.aborted) {
    throw signal.reason ?? new Error("block-scan atomic execution aborted");
  }
  const route = resolvedRouteSummary(resolved.root);
  const routeId = blockScanRouteId(opp.seedEdges);
  const opportunityId = makeBlockScanOpportunityId({
    sourceBlock,
    cycleId: opp.cycleId,
    startToken: opp.flashToken,
    seedPools: opp.seedEdges.map((edge) => edge.target),
  });
  const eventBase = (targetBlock: number) => ({
    opportunity_id: opportunityId,
    route_id: routeId,
    target_block: targetBlock,
    opportunity_kind: "block-scan-arb" as const,
    source_block: sourceBlock,
    cycle_id: opp.cycleId,
    cycle_fingerprint: opp.cycleFingerprint,
    strategy_view_used: "blockscan" as const,
    strategy_view_version: strategyVersions.strategy_view_version,
    blockscan_view_hash: strategyVersions.blockscan_view_hash,
    seed_venues: opp.seedEdges.map((edge) => edge.adapterId),
    path_id: route,
    template_id: resolved.templateName,
  });
  const drop = (
    targetBlock: number,
    stage: string,
    reason: string,
    error?: string,
    ev?: {
      expected_profit_eth: string;
      gas_cost_eth: string;
      bid_eth: string;
      net_ev_wei: string;
      eth_usd: number | null;
      eth_usd_round_id: string | null;
      eth_usd_updated_at: string | null;
      max_base_fee_per_gas: string;
      decision_parent_hash: string | null;
    },
  ): void => {
    emitEvent({
      type: "pipeline_dropped",
      ...eventBase(targetBlock),
      stage,
      reason,
      error,
      plans,
      ...ev,
    });
  };

  if (!shouldRunFinalVerify(
    resolved.netProfit,
    resolved.flashAmount,
    config.finalVerifyFloorBps,
  )) {
    const error =
      `quoteProfit ${resolved.netProfit} below final verify floor ` +
      `${config.finalVerifyFloorBps}bps`;
    console.log(`[searcher/blockscan] block=${sourceBlock} final verify skipped ring=${ring}: ${error}`);
    drop(sourceBlock + 1, "final_verify", "below_final_verify_floor", error);
    return finish("below_final_verify_floor");
  }

  let targetBlock = sourceBlock + 1;
  try {
    const latestAtVerify = await awaitBlockScanDeadline(
      readUncachedLatestBlock(provider),
      passDeadlineAtMs,
      "source-head verification",
      undefined,
      signal,
    );
    const currentHead = latestAtVerify.number;
    targetBlock = Math.max(sourceBlock, currentHead) + 1;
    const canonicalSourceBlockHash = latestAtVerify.hash;
    if (
      currentHead !== sourceBlock ||
      canonicalSourceBlockHash !== sourceBlockHash.toLowerCase()
    ) {
      const error =
        `stale source block ${sourceBlock} head=${currentHead} ` +
        `forkHash=${sourceBlockHash} canonicalHash=${canonicalSourceBlockHash ?? "missing"}`;
      console.log(`[searcher/blockscan] block=${sourceBlock} stale source ring=${ring}: ${error}`);
      drop(targetBlock, "final_verify", "blockscan_stale_state", error);
      return finish("blockscan_stale_state");
    }
    timing.finalSimStartedAtMs = Date.now();
    finalSimStatus = "failed";
    const finalSimStarted = performance.now();
    const sim = await executeFinalSimulationWork({
      intent: Object.freeze({
        stage: "fork-final-sim" as const,
        source: Object.freeze({
          number: sourceBlock,
          hash: sourceBlockHash,
          generation: sourceGeneration,
        }),
        generation: sourceGeneration,
        resolvedPlan: resolved,
      }),
      runtime: finalSimulationRuntime,
    }).finally(() => {
        timing.finalSimMs += Math.max(0, performance.now() - finalSimStarted);
        timing.finalSimFinishedAtMs = Date.now();
      });
    if (collectBlindAudit) {
      auditSimulation = {
        executed: true,
        success: sim.success,
        profitRaw: sim.netProfit.toString(),
        gasUsed: sim.gasUsed.toString(),
        calldataSha256: blindProductionCalldataSha256(sim.calldata),
        standingPosition: opp.leavesStandingPosition,
      };
    }
    if (sim.success && sim.netProfit > 0n) {
      const latestAfterSim = await awaitBlockScanDeadline(
        readUncachedLatestBlock(provider),
        passDeadlineAtMs,
        "post-simulation source-head verification",
        undefined,
        signal,
      );
      if (
        latestAfterSim.number !== sourceBlock ||
        latestAfterSim.hash !== sourceBlockHash.toLowerCase()
      ) {
        targetBlock = Math.max(sourceBlock, latestAfterSim.number) + 1;
        const error =
          `source advanced during final simulation ` +
          `${sourceBlock}/${sourceBlockHash} -> ` +
          `${latestAfterSim.number}/${latestAfterSim.hash}`;
        recordAuditEv({
          executionStatus: "not_run",
          decision: "reject",
          reason: "blockscan_stale_after_sim",
        });
        drop(
          targetBlock,
          "final_verify",
          "blockscan_stale_after_sim",
          error,
        );
        return finish("blockscan_stale_after_sim");
      }
      finalSimStatus = "succeeded";
    }
    emitEvent({
      type: "simulation_result",
      ...eventBase(targetBlock),
      ok: sim.success && sim.netProfit > 0n,
      simulated_profit: sim.netProfit.toString(),
      profit_token: resolved.profitToken,
      gas_estimate: sim.gasUsed.toString(),
      failure_reason: sim.success ? undefined : sim.revertReason,
    });

    if (!sim.success) {
      const error = sim.revertReason ?? "no-positive-profit";
      recordAuditEv({
        executionStatus: "not_run",
        decision: "reject",
        reason: "sim_revert",
      });
      recordBlockScanRejectStrike(rejectBlacklist, opp, sourceBlock);
      console.log(
        `[searcher/blockscan] block=${sourceBlock} final sim rejected ring=${ring} route=${route} ` +
          `quoteProfit=${resolved.netProfit} finalProfit=${sim.netProfit} reason=${error}`,
      );
      drop(targetBlock, "final_verify", "sim_revert", error);
      return finish("sim_revert", false, false);
    }
    clearBlockScanRejectStrikes(rejectBlacklist, opp);
    if (sim.netProfit <= 0n) {
      const error = `non-positive final profit ${sim.netProfit}`;
      recordAuditEv({
        executionStatus: "not_run",
        decision: "reject",
        reason: "final_verify_failed",
      });
      console.log(`[searcher/blockscan] block=${sourceBlock} final verify failed ring=${ring}: ${error}`);
      drop(targetBlock, "final_verify", "final_verify_failed", error);
      return finish("final_verify_failed", false, false);
    }

    if (
      resolved.flashAmount > 0n &&
      sim.netProfit * 10000n > resolved.flashAmount * config.maxProfitBpsOfFlash
    ) {
      const error =
        `phantom profit ${sim.netProfit} > ${config.maxProfitBpsOfFlash}bps of ` +
        `flash ${resolved.flashAmount} route=${route}`;
      recordAuditEv({
        executionStatus: "not_run",
        decision: "reject",
        reason: "phantom_profit",
      });
      console.log(`[searcher/blockscan] block=${sourceBlock} reject phantom ring=${ring}: ${error}`);
      drop(targetBlock, "submit_gate", "phantom_profit", error);
      return finish("phantom_profit");
    }

    timing.evStartedAtMs = Date.now();
    evStartedAt = performance.now();
    const ev = await awaitBlockScanDeadline(
      evaluateEv(
        provider,
        resolved.profitToken,
        sim.netProfit,
        sim.gasUsed,
        config,
        profitTokenValuation,
        sourceBlock,
      ),
      passDeadlineAtMs,
      "EV evaluation",
      undefined,
      signal,
    );
    const {
      valuationAvailable,
      gasMeasurementAvailable,
      feeStateAvailable,
      sourceBlockHash: evSourceBlockHash,
      ethUsd,
      ethUsdRoundId,
      ethUsdUpdatedAt,
      expectedProfitEth,
      gasUnits,
      maxBaseFeePerGas,
      gasCostEth,
      bidEth,
      netEvWei,
    } = ev;
    recordAuditEv({
      executionStatus: "pass",
      decision: "allow",
      reason: config.evGate ? "ev_gate_pass" : "ev_gate_disabled",
    });
    const evEvent = {
      expected_profit_eth: expectedProfitEth.toString(),
      gas_cost_eth: gasCostEth.toString(),
      bid_eth: bidEth.toString(),
      net_ev_wei: netEvWei.toString(),
      eth_usd: ethUsd,
      eth_usd_round_id: ethUsdRoundId?.toString() ?? null,
      eth_usd_updated_at: ethUsdUpdatedAt?.toString() ?? null,
      max_base_fee_per_gas: maxBaseFeePerGas.toString(),
      decision_parent_hash: evSourceBlockHash,
    };

    if (config.evGate && !valuationAvailable) {
      const error = `unpriceable profit token ${resolved.profitToken}`;
      recordAuditEv({
        executionStatus: "pass",
        decision: "reject",
        reason: "unpriceable_profit_token",
      });
      console.log(`[searcher/blockscan] block=${sourceBlock} skip unpriceable ring=${ring}: ${error}`);
      drop(
        targetBlock,
        "submit_gate",
        "unpriceable_profit_token",
        error,
        evEvent,
      );
      return finish("unpriceable_profit_token");
    }
    if (config.evGate && !gasMeasurementAvailable) {
      const error = "EV gate: final simulation did not measure gas";
      recordAuditEv({
        executionStatus: "pass",
        decision: "reject",
        reason: "missing_gas_estimate",
      });
      drop(targetBlock, "submit_gate", "missing_gas_estimate", error, evEvent);
      return finish("missing_gas_estimate");
    }
    if (config.evGate && !feeStateAvailable) {
      const error = `EV gate: source block ${sourceBlock} fee state unavailable`;
      recordAuditEv({
        executionStatus: "pass",
        decision: "reject",
        reason: "stale_ev_state",
      });
      drop(targetBlock, "submit_gate", "stale_ev_state", error, evEvent);
      return finish("stale_ev_state");
    }
    if (
      config.evGate &&
      (
        evSourceBlockHash === null ||
        evSourceBlockHash !== sourceBlockHash.toLowerCase()
      )
    ) {
      const error =
        `EV gate: source block ${sourceBlock} hash changed during evaluation ` +
        `forkHash=${sourceBlockHash} evHash=${evSourceBlockHash ?? "missing"}`;
      recordAuditEv({
        executionStatus: "pass",
        decision: "reject",
        reason: "missing_fee_state",
      });
      drop(targetBlock, "submit_gate", "missing_fee_state", error, evEvent);
      return finish("missing_fee_state");
    }

    const creditLiveMarkerPath =
      process.env.SEARCHER_CREDIT_LIVE_MARKER_PATH ?? DEFAULT_CREDIT_LIVE_MARKER_PATH;
    const standingGuard = evaluateStandingGuard(
      opp.seedEdges,
      creditLiveMarkerPath,
    );
    const containsStandingPosition = standingGuard.containsStandingPosition;
    if (collectBlindAudit && auditSimulation) {
      auditSimulation = {
        ...auditSimulation,
        standingPosition: containsStandingPosition,
      };
    }
    if (!standingGuard.allowed) {
      const error = standingGuard.reason === "edge_taxonomy_inconsistent"
        ? "standing guard: edge taxonomy inconsistent"
        : `standing position unauthorized: marker missing ${creditLiveMarkerPath}`;
      recordAuditEv({
        executionStatus: "pass",
        decision: "reject",
        reason: standingGuard.reason,
      });
      console.log(`[searcher/blockscan] block=${sourceBlock} reject standing-position ring=${ring}: ${error}`);
      drop(targetBlock, "submit_gate", standingGuard.reason, error);
      return finish(standingGuard.reason);
    }

    if (config.evGate) {
      if (netEvWei <= config.minNetEth) {
        const error =
          `EV gate: net ${netEvWei} <= ${config.minNetEth} ` +
          `(profitEth=${expectedProfitEth} gas=${gasCostEth} bribe=${bidEth} ` +
          `token=${resolved.profitToken.slice(0, 10)})`;
        recordAuditEv({
          executionStatus: "pass",
          decision: "reject",
          reason: "below_ev_gate",
        });
        console.log(`[searcher/blockscan] block=${sourceBlock} skip below-EV ring=${ring}: ${error}`);
        drop(targetBlock, "submit_gate", "below_ev_gate", error, evEvent);
        return finish("below_ev_gate");
      }
      console.log(
        `[searcher/blockscan] block=${sourceBlock} EV ok: net=${ethers.formatEther(netEvWei)} ETH ` +
          `profitEth=${ethers.formatEther(expectedProfitEth)} ` +
          `gas=${ethers.formatEther(gasCostEth)} bribe=${ethers.formatEther(bidEth)} ` +
          `ethUsd=${ethUsd ?? "n/a"} targetBaseFee=${maxBaseFeePerGas}`,
      );
    }

    if (!config.blockScanSubmit) {
      const reason = "SEARCHER_BLOCKSCAN_SUBMIT!=1";
      console.log(
        `[searcher/blockscan] block=${sourceBlock} EV decision complete; ` +
          `submission gated-off ring=${ring} route=${route} ` +
          `net=${sim.netProfit} reason=${reason} protoRing=${protoRing}`,
      );
      drop(targetBlock, "submit_gate", "blockscan_submit_disabled", reason);
      return finish("blockscan_submit_disabled");
    }

    closeEvTiming();
    const latestAtSubmit = await awaitBlockScanDeadline(
      readUncachedLatestBlock(provider),
      passDeadlineAtMs,
      "pre-submit source-head verification",
      undefined,
      signal,
    );
    const submitHead = latestAtSubmit.number;
    const submitHeadHash = latestAtSubmit.hash;
    if (
      submitHead !== sourceBlock ||
      submitHeadHash !== sourceBlockHash.toLowerCase()
    ) {
      targetBlock = Math.max(sourceBlock, submitHead) + 1;
      const error =
        `stale source block ${sourceBlock} head=${submitHead} ` +
        `forkHash=${sourceBlockHash} canonicalHash=${submitHeadHash}`;
      console.log(`[searcher/blockscan] block=${sourceBlock} stale before submit ring=${ring}: ${error}`);
      drop(targetBlock, "submit_gate", "blockscan_stale_state", error);
      return finish("blockscan_stale_state");
    }

    const decision = submissionCoordinator.offer({
      strategy: "block-scan",
      opportunityId,
      targetBlock,
      netEvWei,
      deadlineAtMs: passDeadlineAtMs,
    });
    if (!decision.admit) {
      console.log(
        `[searcher/blockscan] block=${sourceBlock} submit gated ring=${ring} targetBlock=${targetBlock} ` +
          `reason=${decision.reason}`,
      );
      drop(targetBlock, "submit_gate", decision.reason);
      return finish(decision.reason);
    }

    if (signal.aborted) {
      throw signal.reason ?? new Error("block-scan atomic execution aborted");
    }
    const results = await bundleRouter.submit({
      victimTxHash: "",
      mode: "standalone",
      backrunCalldata: sim.calldata,
      targetBlock,
      expectedProfit: sim.netProfit,
      expectedProfitEth,
      bribeBps: config.bribeBps,
      bribeWei: bidEth,
      maxBaseFeePerGas,
      gasUsed: gasUnits,
      safety: { leavesStandingPosition: containsStandingPosition, authorized: standingGuard.allowed },
    });
    const bundleHash = results.find((r) => r.bundleHash)?.bundleHash;
    const backrunTxHash = results.find((r) => r.backrunTxHash)?.backrunTxHash;
    const accepted = results.filter((r) => r.accepted).length;
    if (!backrunTxHash) {
      const error = results.find((r) => r.error)?.error ?? "missing backrun tx hash";
      console.log(`[searcher/blockscan] block=${sourceBlock} submit failed ring=${ring}: ${error}`);
      drop(targetBlock, "submit", "bundle_router_rejected", error);
      return finish("bundle_router_rejected");
    }

    console.log(
      `[searcher/blockscan] block=${sourceBlock} ${config.dryRun ? "dry-run queued" : "submitted"} ` +
        `atomic via eth_sendBundle targetBlock=${targetBlock} profit=${sim.netProfit} ` +
        `route=${route}${bundleHash ? ` bundleHash=${bundleHash}` : ""}`,
    );
    emitEvent({
      type: "bundle_submitted",
      ...eventBase(targetBlock),
      submission_target_block: targetBlock,
      mode: "eth_sendBundle",
      simulated_profit: sim.netProfit.toString(),
      simulated_profit_eth: expectedProfitEth.toString(),
      bid: bidEth.toString(),
      gas_cost_eth: gasCostEth.toString(),
      net_ev_wei: netEvWei.toString(),
      eth_usd: ethUsd,
      eth_usd_round_id: ethUsdRoundId?.toString() ?? null,
      eth_usd_updated_at: ethUsdUpdatedAt?.toString() ?? null,
      max_base_fee_per_gas: maxBaseFeePerGas.toString(),
      decision_parent_hash: evSourceBlockHash,
      tx_hash: backrunTxHash,
      calldata_hash: ethers.keccak256(sim.calldata),
      builders_sent: results.map((r) => r.builder),
      bundle_hash: bundleHash,
      accepted,
    });
    if (results.some((r) => r.accepted)) {
      trackInclusion({
        provider,
        backrunTxHash,
        opportunityId,
        targetBlock,
        watchBlocks: config.inclusionWatchBlocks,
        emit: emitEvent,
      });
    }
    return finish(
      results.some((result) => result.accepted)
        ? "bundle_submitted_accepted"
        : "bundle_submitted_unaccepted",
      true,
    );
  } catch (err) {
    if (signal.aborted) {
      throw signal.reason ?? err;
    }
    if (err instanceof BlockScanPassDeadlineError) {
      const reason = err.stage === "final simulation"
        ? "final_sim_deadline"
        : "ev_or_submit_deadline";
      recordAuditEv({
        executionStatus: "not_run",
        decision: "reject",
        reason,
      });
      drop(targetBlock, "deadline", reason, err.message);
      return finish(reason);
    }
    if (err instanceof FinalSimulationWorkRuntimeError) {
      const reason = err.failureCode === "timeout"
        ? "final_sim_deadline"
        : "final_sim_unresolved";
      recordAuditEv({
        executionStatus: "not_run",
        decision: "reject",
        reason,
      });
      drop(targetBlock, "final_verify", reason, err.message);
      return finish(reason);
    }
    const error = err instanceof Error ? err.message : String(err);
    console.log(`[searcher/blockscan] block=${sourceBlock} submit error ring=${ring}: ${error}`);
    drop(targetBlock, "submit", "blockscan_submit_error", error);
    return finish("blockscan_submit_error");
  }
}

async function drainPendingVictimOutcomes(ctx: HandleCtx, currentHeadBlock: number): Promise<void> {
  const pending = ctx.pendingVictimOutcomes;
  if (pending.length === 0) return;

  let write = 0;
  for (let read = 0; read < pending.length; read++) {
    const entry = pending[read];
    if (!entry) continue;
    if (entry.targetBlock >= currentHeadBlock) {
      pending[write++] = entry;
      continue;
    }
    try {
      const receipt = await ctx.provider.getTransactionReceipt(entry.hash);
      ctx.victimSource.record(entry.sender, entry.targetBlock, receipt?.status === 1);
    } catch {
      pending[write++] = entry;
    }
  }
  pending.length = Math.min(write, MAX_PENDING_VICTIM_OUTCOMES);
}

function enqueuePendingVictimOutcome(
  pending: PendingVictimOutcome[],
  entry: PendingVictimOutcome,
): void {
  pending.push(entry);
  while (pending.length > MAX_PENDING_VICTIM_OUTCOMES) pending.shift();
}

function createStageCounters(): StageCounters {
  return {
    hints: 0,
    impacts: 0,
    opportunities: 0,
    plans: 0,
    solverEntered: 0,
    solverSuccess: 0,
    revmSimSuccess: 0,
    rpcVerifySuccess: 0,
    simSuccess: 0,
    submitAttempts: 0,
    accepted: 0,
    expiredBeforeSolver: 0,
    quoteTimeouts: 0,
    simReverts: 0,
    finalVerifyFailed: 0,
    finalVerifySkipped: 0,
    missingState: 0,
    revmErrors: 0,
    pendingReceived: 0,
    pendingFilteredReceived: 0,
    mempoolOpportunitySeen: 0,
    mempoolToSim: 0,
    cuProxyRpcCalls: 0,
  };
}

function logStageCounters(counters: StageCounters): void {
  console.log(
    `[searcher/live] counters ` +
      `hints=${counters.hints} ` +
      `impacts=${counters.impacts} ` +
      `opportunities=${counters.opportunities} ` +
      `plans=${counters.plans} ` +
      `solverEntered=${counters.solverEntered} ` +
      `solverSuccess=${counters.solverSuccess} ` +
      `revmSimSuccess=${counters.revmSimSuccess} ` +
      `rpcVerifySuccess=${counters.rpcVerifySuccess} ` +
      `simSuccess=${counters.simSuccess} ` +
      `submitAttempts=${counters.submitAttempts} ` +
      `accepted=${counters.accepted} ` +
      `expiredBeforeSolver=${counters.expiredBeforeSolver} ` +
      `quoteTimeouts=${counters.quoteTimeouts} ` +
      `simReverts=${counters.simReverts} ` +
      `finalVerifyFailed=${counters.finalVerifyFailed} ` +
      `finalVerifySkipped=${counters.finalVerifySkipped} ` +
      `missingState=${counters.missingState} ` +
      `revmErrors=${counters.revmErrors} ` +
      `pendingReceived=${counters.pendingReceived} ` +
      `pendingFilteredReceived=${counters.pendingFilteredReceived} ` +
      `mempoolOpportunitySeen=${counters.mempoolOpportunitySeen} ` +
      `mempoolToSim=${counters.mempoolToSim} ` +
      `cuProxyRpcCalls=${counters.cuProxyRpcCalls}`,
  );
}

function counterSnapshot(counters: StageCounters): Record<string, number> {
  return { ...counters };
}

/**
 * A StateBackend whose reads (`call`) hit the live backend's warm post-victim
 * overlay instead of the anvil fork. In revm/hybrid mode the anvil fork is never
 * started, so this is what lets the solver's PoolStateCache warm path-B local
 * math (and the quoter's eth_call fallback) from the same shifted state the
 * daemon quotes/simulates against. Only `.call` is exercised by the solve path;
 * every other StateBackend member falls through to `base` via the prototype
 * chain. Falls back to `base` if the backend exposes no `call`.
 */
function revmReadState(base: StateBackend, backend: LiveStateBackend): StateBackend {
  if (!backend.call) return base;
  const call = backend.call.bind(backend);
  return Object.assign(Object.create(base) as StateBackend, {
    call: (req: { to: string; data: string; from?: string }) => call(req),
    // The prepared Revm API has no generic state-override value-delta
    // operation yet. Never fall through to an unrelated/dead Anvil fork.
    simulateTokenToNativeDelta: undefined,
  });
}

/**
 * Read-only StateBackend view pinned to a mainnet block. Local victim-apply
 * runs quote/search on post-impact cache for the touched pool and pre-victim
 * block reads for every untouched pool, avoiding revm overlay in the hot path.
 */
function blockReadState(
  base: StateBackend,
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
): StateBackend {
  return Object.assign(Object.create(base) as StateBackend, {
    call: (req: { to: string; data: string; from?: string }) =>
      provider.call({
        to: req.to,
        data: req.data,
        from: req.from,
        blockTag: blockNumber,
      }),
    // This view is block-pinned for eth_call only; a base Anvil simulation
    // would execute against a different source and must fail closed.
    simulateTokenToNativeDelta: undefined,
  });
}

function opportunityIdFor(
  targetBlock: number,
  victimHash: string,
  opp: { affectedPools?: string[]; affectedTokens?: string[] },
): string {
  return makeOpportunityId({
    targetBlock,
    victimHash,
    pool: opp.affectedPools?.[0],
    tokens: opp.affectedTokens,
  });
}

function resolvedRouteSummary(root: ResolvedPlanNode): string {
  const route: string[] = [];
  const visit = (node: ResolvedPlanNode): void => {
    if (
      !node.adapterId.endsWith("-flash") &&
      node.adapterId !== "erc20-approve" &&
      node.adapterId !== "erc20-transfer" &&
      node.adapterId !== "assert-balance"
    ) {
      route.push(
        `${node.tokenIn.slice(0, 6)}->${node.tokenOut.slice(0, 6)}@${node.adapterId}`,
      );
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return route.join(">");
}

/**
 * Recent longtail warm lane. Pinned pools are handled in a separate lane, so
 * they are excluded here; otherwise high-frequency bluechip paths crowd out the
 * just-seen longtail pools we are trying to catch on their second/third swap.
 */
class RecentWarmTracker {
  private hops = new Map<string, { hop: QuoteRequest; count: number; lastSeenBlock: number }>();

  constructor(private readonly ttlBlocks: number) {}

  get ttl(): number {
    return this.ttlBlocks;
  }

  record(
    hop: QuoteHop,
    amountIn: bigint,
    blockNumber: number,
    excludeTargets: Set<string>,
  ): void {
    if (amountIn <= 0n) return;
    if (excludeTargets.has(hop.target.toLowerCase())) return;
    const key = quoteHopIdentityKey(hop);
    const existing = this.hops.get(key);
    if (existing) {
      existing.count++;
      existing.hop.amountIn = amountIn;
      existing.lastSeenBlock = blockNumber;
    } else {
      this.hops.set(key, { hop: { ...hop, amountIn }, count: 1, lastSeenBlock: blockNumber });
    }
  }

  top(k: number, blockNumber: number, excludeTargets: Set<string>): QuoteRequest[] {
    if (k <= 0) return [];
    this.prune(blockNumber, excludeTargets);
    return [...this.hops.values()]
      .sort((a, b) => b.count - a.count || b.lastSeenBlock - a.lastSeenBlock)
      .slice(0, k)
      .map((e) => e.hop);
  }

  private prune(blockNumber: number, excludeTargets: Set<string>): void {
    for (const [key, entry] of this.hops) {
      const expired = this.ttlBlocks >= 0 && blockNumber - entry.lastSeenBlock > this.ttlBlocks;
      const pinned = excludeTargets.has(entry.hop.target.toLowerCase());
      if (expired || pinned) this.hops.delete(key);
    }
  }
}

function topPinnedWarmHops(
  hops: Array<QuoteRequest & { weight?: number }>,
  k: number,
): QuoteRequest[] {
  if (k <= 0) return [];
  return [...hops]
    .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))
    .slice(0, k)
    .map(({ canonicalEdgeId, instanceKey, executionVariantKey, adapterId, target, tokenIn, tokenOut, amountIn, poolToken0, poolToken1, v4PoolKey }) => ({
      canonicalEdgeId,
      instanceKey,
      executionVariantKey,
      adapterId,
      target,
      tokenIn,
      tokenOut,
      amountIn,
      poolToken0,
      poolToken1,
      v4PoolKey,
    }));
}

function dedupeRouteHops(
  plans: Array<{
    tokenPath: { edges: TokenEdge[] };
  }>,
  maxHops: number,
  executionEvidence: readonly PendingExecutionEvidence[] = [],
): QuoteHop[] {
  if (maxHops <= 0) return [];
  const seen = new Set<string>();
  const hops: QuoteHop[] = [];
  for (const plan of plans) {
    for (const edge of plan.tokenPath.edges) {
      const key = quoteHopIdentityKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      const owner = PRODUCTION_ADAPTER_FAMILIES.routes().findForEdge(
        edge.adapterId,
      );
      hops.push({
        canonicalEdgeId: edge.canonicalEdgeId,
        instanceKey: edge.instanceKey,
        executionVariantKey: edge.executionVariantKey,
        adapterId: edge.adapterId,
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        poolToken0: edge.poolToken0,
        poolToken1: edge.poolToken1,
        v4PoolKey: edge.v4PoolKey,
        executionEvidence: executionEvidence.find(
          (evidence) => evidence.familyId === owner?.id,
        ),
      });
      if (hops.length >= maxHops) return hops;
    }
  }
  return hops;
}

function poolImpactFromOpportunity(
  opportunity: Opportunity | BlockScanOpportunity | undefined,
): PoolImpact | null {
  if (!opportunity || opportunity.kind !== "backrun-arb") return null;
  return opportunity.victimEffect.kind === "swap"
    ? opportunity.victimEffect.impact
    : null;
}

function isTimeoutMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline");
}

function isBalanceSlotMissingMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("balance slot") ||
    lower.includes("could not locate erc20") ||
    lower.includes("could not find balance");
}

// ─── Hint Log Parsing ─────────────────────────────────────────

/** Extract logs array from MEV-Share hint payload. */
function extractLogs(payload: unknown): HintLog[] {
  if (payload && typeof payload === "object" && "logs" in payload) {
    const logs = (payload as Record<string, unknown>).logs;
    if (Array.isArray(logs)) {
      return logs.filter(
        (l): l is HintLog =>
          l != null &&
          typeof l === "object" &&
          typeof (l as any).address === "string" &&
          Array.isArray((l as any).topics) &&
          typeof (l as any).data === "string",
      );
    }
  }
  return [];
}

async function matchPoolImpactFromLogs(
  logs: HintLog[],
  graph: TokenEdge[],
  broadPoolAddrs: Map<string, string> | undefined,
  sourceBlock: number,
  sourceBlockHash: string | null,
  receiptId: string,
): Promise<PoolImpactTransition> {
  const sourceGeneration = createVictimSourceGeneration({
    sourceBlock,
    sourceBlockHash,
    receiptId,
    logs,
    logsCompleteness: "fragment",
  });
  return detectImpactTransitionFromLogs(
    logs,
    graph,
    sourceGeneration,
    broadPoolAddrs,
    null,
  );
}

export function hashOnlyImpactReplayAdmitted(adapterId: string): boolean {
  return hashOnlyImpactReplayAdmittedByPolicy(adapterId);
}

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Check if any Transfer log's token address is in our token index. */
function hintLogsMatchTokenIndex(
  logs: HintLog[],
  tokenIndex: Map<string, Set<string>>,
): boolean {
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (tokenIndex.has(log.address.toLowerCase())) return true;
  }
  return false;
}

function formatBlockScanRing(opp: { affectedTokens?: string[]; seedEdges: TokenEdge[] }): string {
  return (opp.affectedTokens ?? opp.seedEdges.map((edge) => edge.tokenIn)).join("->");
}

function formatBlockScanRouteKey(opp: { seedEdges: TokenEdge[] }): string {
  return blockScanRouteId(opp.seedEdges);
}

function activeBlockScanRejectBlacklistEntry(
  state: BlockScanRejectBlacklistState,
  routeKey: string,
  currentBlock: number,
): ActiveBlockScanRejectBlacklistEntry | null {
  if (!state.enabled) return null;
  const entry = state.entries.get(routeKey);
  if (!entry || entry.expiryBlock === null) return null;
  if (currentBlock >= entry.expiryBlock) {
    state.entries.delete(routeKey);
    return null;
  }
  return { strikes: entry.strikes, expiryBlock: entry.expiryBlock };
}

function recordBlockScanRejectStrike(
  state: BlockScanRejectBlacklistState,
  opp: { seedEdges: TokenEdge[] },
  sourceBlock: number,
): void {
  if (!state.enabled) return;
  const routeKey = formatBlockScanRouteKey(opp);
  const entry = state.entries.get(routeKey) ?? { strikes: 0, expiryBlock: null };
  entry.strikes += 1;
  if (entry.strikes >= state.after) {
    entry.expiryBlock = sourceBlock + state.ttlBlocks + 1;
  }
  state.entries.set(routeKey, entry);
}

function clearBlockScanRejectStrikes(
  state: BlockScanRejectBlacklistState,
  opp: { seedEdges: TokenEdge[] },
): void {
  if (!state.enabled) return;
  state.entries.delete(formatBlockScanRouteKey(opp));
}

async function applyPostImpactOverridesToAnvil(
  state: AnvilStateBackend,
  postImpact: PostImpactSeed,
): Promise<number> {
  const holder = postImpact.kind === "v2" ? postImpact.pool : undefined;
  const overrides = await postImpactStateOverrides(
    postImpact,
    holder ? (token) => resolveAnvilBalanceSlot(state, token, holder) : undefined,
  );
  if (overrides.length === 0) {
    throw new Error(`post-impact state override unavailable for ${postImpact.kind}`);
  }
  for (const override of overrides) {
    await state.provider.send("anvil_setStorageAt", [override.address, override.slot, override.value]);
  }
  return overrides.length;
}

const BALANCE_OF_IFACE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

async function resolveAnvilBalanceSlot(
  state: AnvilStateBackend,
  token: string,
  holder: string,
): Promise<number | null> {
  return resolveErc20BalanceSlot(token, holder, {
    balanceOf: async (t, h) => {
      const ret = await state.provider.call({
        to: t,
        data: BALANCE_OF_IFACE.encodeFunctionData("balanceOf", [h]),
      });
      return ret && ret !== "0x" ? BigInt(ret) : 0n;
    },
    getStorage: async (t, key) => {
      const ret = await state.provider.getStorage(t, key);
      return ret && ret !== "0x" ? BigInt(ret) : 0n;
    },
  });
}

async function prepareForkExecutor(
  provider: ethers.JsonRpcProvider,
  owner: string,
  botvmAddress: string,
): Promise<void> {
  const code = await provider.getCode(botvmAddress);
  if (code === "0x") throw new Error(`BOTVM_ADDRESS has no code on fork: ${botvmAddress}`);
  await provider.send("anvil_setBalance", [ethers.getAddress(owner), FORK_ETH_BALANCE]);
  await provider.send("anvil_impersonateAccount", [ethers.getAddress(owner)]);
}

async function rawTxByHash(
  provider: ethers.JsonRpcProvider,
  txHash: string,
  tx: ethers.TransactionResponse,
  allowRpcFallback = true,
): Promise<string | null> {
  // Prefer local re-serialization (zero RPC): the tx we already fetched carries
  // its signature, so we can rebuild the signed raw bytes ourselves. Only fall
  // back to eth_getRawTransactionByHash when the local rebuild can't reproduce
  // the exact tx (missing signature / exotic type), verified by hash match.
  const rebuilt = rebuildSignedRawTx(txHash, tx);
  if (rebuilt) return rebuilt;
  if (!allowRpcFallback) return null;

  try {
    const raw = await provider.send("eth_getRawTransactionByHash", [txHash]);
    if (typeof raw === "string" && raw.startsWith("0x")) return raw;
  } catch {
    // Some RPC providers do not expose raw pending transactions.
  }
  return null;
}

function rebuildSignedRawTx(txHash: string, tx: ethers.TransactionResponse): string | null {
  try {
    const rebuilt = ethers.Transaction.from({
      type: tx.type,
      to: tx.to,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      data: tx.data,
      value: tx.value,
      chainId: tx.chainId,
      accessList: tx.accessList,
      signature: tx.signature,
    });
    if (rebuilt.hash?.toLowerCase() === txHash.toLowerCase()) return rebuilt.serialized;
  } catch {
    // Missing signature / exotic pending tx shape. Mempool filtered mode will
    // drop it; non-mempool callers may still use the RPC fallback above.
  }
  return null;
}

/**
 * Route B: subscribe to the public mempool and yield pending swaps as victims.
 *
 * Adapter observation capabilities, the runtime graph and the chain-derived
 * router index form one complete target set. A local firehose filters against
 * that full set; an external provider receives a capped server-side subset and
 * reports any coverage gap. Yielded envelopes carry the full tx + locally
 * rebuilt rawTx so handleHint applies the victim on the fork.
 */
async function* mempoolHints(
  wsUrl: string,
  provider: ethers.JsonRpcProvider,
  getPools: () => PoolEntry[],
  counters: StageCounters,
  liveGraphTargets?: ReadonlySet<string>,
  refreshSignal?: MempoolIntakeRefreshSignal,
  onPendingExecutionEvidence?: (
    trigger: BlockScanPendingEvidenceTrigger,
  ) => void,
): AsyncGenerator<HintEnvelope> {
  const routersPath = process.env.SEARCHER_FORCE_INCLUDE_ROUTERS_PATH ?? undefined;
  const forceIncludeRouters = loadForceIncludeRouters(routersPath);
  const maxAddresses = Number(process.env.SEARCHER_MEMPOOL_FILTER_MAX_ADDRESSES ?? "300");
  const initialIntake = buildMempoolIntakeWithRouters(getPools(), forceIncludeRouters);
  const fullAddressSet = new Set(
    initialIntake.fullTargets.map((address) => address.toLowerCase()),
  );
  const interesting = (to: string | null | undefined): boolean =>
    isMempoolIntakeTarget(to, fullAddressSet, liveGraphTargets);
  const pendingEvidence =
    PRODUCTION_ADAPTER_FAMILIES.pendingTransactionEvidence();
  const reportedEvidenceFailures = new Set<string>();
  const pendingEvidenceTimeoutMs = Number(
    process.env.SEARCHER_PENDING_EVIDENCE_TIMEOUT_MS ??
      String(DEFAULT_PENDING_EVIDENCE_TIMEOUT_MS),
  );
  const pendingEvidenceMaxReads = Number(
    process.env.SEARCHER_PENDING_EVIDENCE_MAX_READS ??
      String(DEFAULT_PENDING_EVIDENCE_MAX_READS),
  );
  const mode = parseMempoolMode();
  if (mode === "alchemy_filtered" && pendingEvidence.familyIds.length > 0) {
    throw new FatalMempoolSubscriptionError(
      "pending execution-evidence families require a full mempool firehose; " +
        "alchemy_filtered cannot observe unknown outer executors",
    );
  }
  if (mode === "local_firehose" || pendingEvidence.familyIds.length > 0) {
    reportMempoolIntake("local_firehose", initialIntake, maxAddresses);
    yield* localFirehoseMempoolHints(
      wsUrl,
      provider,
      interesting,
      pendingEvidence,
      pendingEvidenceTimeoutMs,
      pendingEvidenceMaxReads,
      reportedEvidenceFailures,
      counters,
      onPendingExecutionEvidence,
    );
    return;
  }

  let lastIntakeKey = "";
  for (;;) {
    const intake = buildMempoolIntakeWithRouters(getPools(), forceIncludeRouters);
    const toAddress = [...intake.filteredTargets];
    const intakeKey = toAddress.map((address) => address.toLowerCase()).join(",");
    if (intakeKey !== lastIntakeKey) {
      reportMempoolIntake(mode, intake, maxAddresses);
      lastIntakeKey = intakeKey;
    }

    let ws: WebSocket | null = null;
    let refreshRequested = false;
    const unsubscribeRefresh = refreshSignal?.subscribe(() => {
      refreshRequested = true;
      try { ws?.close(); } catch { /* reconnect below */ }
    });
    try {
      try {
        ws = await connectFilteredMempool(wsUrl, toAddress);
      } catch (err) {
        if (err instanceof FatalMempoolSubscriptionError) {
          if (mode === "auto" && shouldUseLocalFirehoseFallback(wsUrl, err)) {
            console.log(
              `[searcher/live] mempool filtered subscription unsupported by local node; ` +
                `falling back to newPendingTransactions firehose`,
            );
            yield* localFirehoseMempoolHints(
              wsUrl,
              provider,
              interesting,
              pendingEvidence,
              pendingEvidenceTimeoutMs,
              pendingEvidenceMaxReads,
              reportedEvidenceFailures,
              counters,
              onPendingExecutionEvidence,
            );
            return;
          }
          throw err;
        }
        console.log(
          `[searcher/live] mempool WS connect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.log("[searcher/live] mempool_state=disconnected");
        await sleep(1_000);
        continue;
      }
      if (refreshRequested) continue;

      // Bounded queue: keep only the freshest victims; a stale pending tx is
      // useless once newer blocks/txs land, so drop oldest past the cap.
      const queue: HintEnvelope[] = [];
      let wake: (() => void) | null = null;
      let failed = false;
      const seen = new Set<string>();

      const fail = () => {
        if (!failed && !refreshRequested) console.log("[searcher/live] mempool_state=disconnected");
        failed = true;
        wake?.();
      };
      ws.addEventListener("error", fail);
      ws.addEventListener("close", fail);

      ws.addEventListener("message", (event) => {
        void (async () => {
          const msg = parseWsJson(event.data);
          const result = msg?.method === "eth_subscription"
            ? msg.params?.result
            : undefined;
          if (!isRecord(result)) return;
          counters.pendingReceived++;
          const tx = pendingTxFromAlchemy(result);
          if (!tx) return;
          if (!interesting(tx.to)) return;
          const hash = tx.hash.toLowerCase();
          if (seen.has(hash)) return;
          seen.add(hash);
          if (seen.size > 100_000) seen.clear();

          const rawTx = rebuildSignedRawTx(hash, tx);
          if (!rawTx) return;

          counters.pendingFilteredReceived++;
          queue.push({
            payload: { mempool: true },
            hashes: [tx.hash],
            source: "mempool",
            prefetched: { tx, rawTx },
          });
          if (queue.length > 64) queue.shift();
          wake?.();
        })().catch(() => {
          // Registry failures are isolated and reported above; malformed
          // provider messages remain ordinary non-matches.
        });
      });

      for (;;) {
        if (failed) break;
        if (queue.length === 0) {
          await new Promise<void>((res) => {
            wake = res;
          });
          wake = null;
          continue;
        }
        yield queue.shift()!;
      }
    } finally {
      try { ws?.close(); } catch { /* already closed */ }
      unsubscribeRefresh?.();
    }
    if (refreshRequested) {
      console.log("[searcher/live] mempool filtered targets refreshed; reconnecting");
      continue;
    }
    console.log("[searcher/live] mempool WS reconnect");
    await sleep(1_000);
  }
}

function reportMempoolIntake(
  mode: MempoolMode,
  intake: MempoolIntakePlan,
  maxAddresses: number,
): void {
  console.log(
    `[searcher/live] mempool mode=${mode} fullTargets=${intake.fullTargets.length} ` +
      `filteredTargets=${intake.filteredTargets.length} canonical=${intake.canonicalTargetCount} ` +
      `dynamicRouters=${intake.dynamicTargetCount}`,
  );
  emitEvent({
    type: "mempool_filter_config",
    source: "filtered_mempool",
    to_addresses: [...intake.filteredTargets],
    address_count: intake.filteredTargets.length,
    router_count: intake.canonicalTargetCount + intake.dynamicTargetCount,
    full_address_count: intake.fullTargets.length,
    canonical_target_count: intake.canonicalTargetCount,
    dynamic_target_count: intake.dynamicTargetCount,
    graph_target_count: intake.graphTargetCount,
    filtered_truncated: intake.filteredTruncated,
    max_addresses: maxAddresses,
  });
}

type MempoolMode = "auto" | "alchemy_filtered" | "local_firehose";

function parseMempoolMode(): MempoolMode {
  const raw = (process.env.SEARCHER_MEMPOOL_MODE ?? "auto").trim().toLowerCase();
  if (raw === "auto") return "auto";
  if (raw === "alchemy" || raw === "alchemy_filtered" || raw === "filtered") {
    return "alchemy_filtered";
  }
  if (raw === "local" || raw === "local_firehose" || raw === "firehose" || raw === "reth") {
    return "local_firehose";
  }
  throw new FatalMempoolSubscriptionError(`unknown SEARCHER_MEMPOOL_MODE=${raw}`);
}

async function* localFirehoseMempoolHints(
  wsUrl: string,
  provider: ethers.JsonRpcProvider,
  interesting: (to: string | null | undefined) => boolean,
  pendingEvidence: PendingTransactionEvidenceProjection,
  pendingEvidenceTimeoutMs: number,
  pendingEvidenceMaxReads: number,
  reportedEvidenceFailures: Set<string>,
  counters: StageCounters,
  onPendingExecutionEvidence?: (
    trigger: BlockScanPendingEvidenceTrigger,
  ) => void,
): AsyncGenerator<HintEnvelope> {
  const maxInFlight = Number(process.env.SEARCHER_MEMPOOL_FIREHOSE_MAX_INFLIGHT ?? "64");
  const maxQueue = Number(process.env.SEARCHER_MEMPOOL_FIREHOSE_QUEUE_MAX ?? "64");
  const txTimeoutMs = Number(process.env.SEARCHER_MEMPOOL_FIREHOSE_TX_TIMEOUT_MS ?? "1500");
  const evidenceAdmissionsPerFamilyPerHead = Number(
    process.env.SEARCHER_PENDING_EVIDENCE_ADMISSIONS_PER_FAMILY_PER_HEAD ?? "16",
  );
  const evidenceMaxInFlight = Number(
    process.env.SEARCHER_PENDING_EVIDENCE_MAX_INFLIGHT ?? "4",
  );
  const evidenceReadMaxInFlight = Number(
    process.env.SEARCHER_PENDING_EVIDENCE_READ_MAX_INFLIGHT ?? "8",
  );
  const evidenceCanonicalQueueMax = Number(
    process.env.SEARCHER_PENDING_EVIDENCE_CANONICAL_QUEUE_MAX ??
      String(maxQueue),
  );
  const evidenceFamilyCount = Math.max(
    1,
    pendingEvidence.familyIds.length,
  );
  const observerScheduler = new PendingEvidenceTaskScheduler(
    evidenceMaxInFlight,
    maxQueue,
    evidenceCanonicalQueueMax,
  );
  const readScheduler = new PendingEvidenceTaskScheduler(
    evidenceReadMaxInFlight,
    maxQueue * pendingEvidenceMaxReads,
    evidenceCanonicalQueueMax * pendingEvidenceMaxReads,
  );
  const reportEvidenceFailure = (
    familyId: ExecutionFamilyId | "kernel",
    code: string,
  ) => {
    const key = `${familyId}:${code}`;
    if (reportedEvidenceFailures.has(key)) return;
    reportedEvidenceFailures.add(key);
    console.log(
      `[searcher/live] pending execution evidence family=${familyId} ` +
        `failed code=${code}`,
    );
  };
  console.log(
    `[searcher/live] mempool local firehose subscription ` +
      `maxInFlight=${maxInFlight} queueMax=${maxQueue} txTimeoutMs=${txTimeoutMs} ` +
      `evidenceMaxInFlight=${evidenceMaxInFlight} ` +
      `evidenceReadMaxInFlight=${evidenceReadMaxInFlight}`,
  );

  for (;;) {
    let ws: WebSocket | null = null;
    let pendingSubscriptionId = "";
    let headSubscriptionId = "";
    try {
      const connection = await connectStandardMempool(wsUrl);
      ws = connection.ws;
      pendingSubscriptionId = connection.pendingSubscriptionId;
      headSubscriptionId = connection.headSubscriptionId;
    } catch (err) {
      console.log(
        `[searcher/live] mempool local firehose connect failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      console.log("[searcher/live] mempool_state=disconnected");
      await sleep(1_000);
      continue;
    }

    // Canonical intake and evidence-promoted unknown targets never share an
    // eviction queue. Each evidence family gets its own bounded FIFO, drained
    // round-robin after canonical traffic.
    const admissionQueue = new PendingEvidenceAdmissionQueue<HintEnvelope>(
      maxQueue,
      evidenceFamilyCount,
      evidenceAdmissionsPerFamilyPerHead,
    );
    const seen = new Set<string>();
    let wake: (() => void) | null = null;
    let failed = false;
    let inFlight = 0;
    const evidenceHeadSnapshot = new PendingEvidenceHeadSnapshot();

    const fail = () => {
      if (!failed) console.log("[searcher/live] mempool_state=disconnected");
      failed = true;
      wake?.();
    };
    const enqueueCanonical = (hint: HintEnvelope) => {
      admissionQueue.enqueueCanonical(hint);
      wake?.();
    };
    const enqueueEvidence = (
      familyId: ExecutionFamilyId,
      hint: HintEnvelope,
    ) => {
      admissionQueue.enqueueEvidence(familyId, hint);
      wake?.();
    };
    const parseEvidenceHead = (
      raw: { readonly number?: unknown; readonly hash?: unknown },
    ): PendingTransactionEvidenceHead | undefined => {
      if (
        typeof raw.number !== "string" ||
        typeof raw.hash !== "string" ||
        !ethers.isHexString(raw.hash, 32)
      ) {
        return undefined;
      }
      const number = Number(BigInt(raw.number));
      if (!Number.isSafeInteger(number) || number < 0) return undefined;
      return Object.freeze({ number, hash: raw.hash });
    };
    const currentEvidenceHead = (
      priority: PendingEvidenceTaskPriority,
    ): Promise<PendingTransactionEvidenceHead> =>
      evidenceHeadSnapshot.current(() =>
        readScheduler.run(priority, async () => {
        const controller = new AbortController();
        const deadlineAtMs = Date.now() + pendingEvidenceTimeoutMs;
        const timer = setTimeout(
          () => controller.abort(new Error("pending evidence head deadline")),
          pendingEvidenceTimeoutMs,
        );
        try {
          const block = await sendDexDiscoveryRpc<{
            readonly number?: string;
            readonly hash?: string;
          } | null>(
            provider,
            "eth_getBlockByNumber",
            ["latest", false],
            { deadlineAtMs, signal: controller.signal },
          );
          const head = block ? parseEvidenceHead(block) : undefined;
          if (!head) {
            throw new Error(
              "pending execution evidence could not freeze canonical head",
            );
          }
          return head;
        } catch (error) {
          reportEvidenceFailure("kernel", "backend");
          throw error;
        } finally {
          clearTimeout(timer);
        }
        }, "head")
      );
    const evidenceSession = (
      tx: Pick<ethers.TransactionResponse, "hash" | "to" | "data">,
    ) =>
      createPendingEvidenceSession(
        tx,
        provider,
        pendingEvidence,
        observerScheduler,
        readScheduler,
        currentEvidenceHead,
        pendingEvidenceTimeoutMs,
        pendingEvidenceMaxReads,
        reportEvidenceFailure,
      );
    const publishCurrentHeadExecutionEvidence = async (
      tx: Pick<ethers.TransactionResponse, "hash">,
      evidence: readonly PendingExecutionEvidence[],
      observation: {
        readonly observedAtMs: number;
        readonly observedAtMonotonicMs: number;
      },
    ): Promise<readonly PendingExecutionEvidence[]> => {
      const validated = await validateHintExecutionEvidence(
        evidence,
        tx.hash,
        provider,
        pendingEvidenceTimeoutMs,
      );
      const activating = validated.filter((item) => {
        const owner = PRODUCTION_ADAPTER_FAMILIES.routes().forFamily(
          item.familyId,
        );
        return owner.pendingTransactionEvidence?.routeActivation ===
          "current-head-block-scan";
      });
      if (activating.length === 0 || !onPendingExecutionEvidence) {
        return validated;
      }
      const head = activating[0]!;
      if (activating.some((item) =>
        item.headBlockNumber !== head.headBlockNumber ||
        item.headHash.toLowerCase() !== head.headHash.toLowerCase()
      )) {
        throw new Error("pending execution evidence spans multiple heads");
      }
      const evidenceReadyAtMs = Date.now();
      const evidenceReadyAtMonotonicMs = performance.now();
      onPendingExecutionEvidence(Object.freeze({
        txHash: tx.hash,
        head: Object.freeze({
          number: head.headBlockNumber,
          hash: head.headHash,
        }),
        observedAtMs: observation.observedAtMs,
        observedAtMonotonicMs: observation.observedAtMonotonicMs,
        evidenceReadyAtMs,
        evidenceReadyAtMonotonicMs,
        evidence: Object.freeze(activating),
      }));
      return validated;
    };
    const startCurrentHeadRouteActivation = (
      session: PendingEvidenceSession,
      tx: Pick<ethers.TransactionResponse, "hash">,
      observation: {
        readonly observedAtMs: number;
        readonly observedAtMonotonicMs: number;
      },
    ): void => {
      const familyIds = session.candidateFamilyIds.filter((familyId) => {
        const owner = PRODUCTION_ADAPTER_FAMILIES.routes().forFamily(familyId);
        return owner.pendingTransactionEvidence?.routeActivation ===
          "current-head-block-scan";
      });
      if (familyIds.length === 0) return;
      void session.resolve(familyIds, "canonical")
        .then((evidence) =>
          publishCurrentHeadExecutionEvidence(tx, evidence, observation)
        )
        .catch((error) => {
          const code = error instanceof Error &&
              error.message.includes("queue full")
            ? "canonical_queue_full"
            : "route_activation_error";
          for (const familyId of familyIds) {
            reportEvidenceFailure(familyId, code);
          }
          // Route activation is independently bounded and cannot disrupt
          // victim intake.
        });
    };
    const startUnknownEvidenceAdmission = (
      session: PendingEvidenceSession,
      baseHint: HintEnvelope,
    ): void => {
      if (session.candidateFamilyIds.length === 0) return;
      void (async () => {
        const head = await session.head("unknown");
        let admitted = false;
        await Promise.allSettled(session.candidateFamilyIds.map(
          async (familyId) => {
            if (!admissionQueue.beginUnknownAttempt(familyId, head.hash)) {
              return;
            }
            let finished = false;
            try {
              const evidence = await session.observeFamily(
                familyId,
                "unknown",
              );
              const validated = evidence
                ? await validateHintExecutionEvidence(
                    [evidence],
                    baseHint.prefetched!.tx.hash,
                    provider,
                    pendingEvidenceTimeoutMs,
                  )
                : Object.freeze([]);
              const commit = evidence !== undefined && !admitted;
              const accepted = admissionQueue.finishUnknownAttempt(
                familyId,
                head.hash,
                commit,
              );
              finished = true;
              if (!evidence || !accepted) return;
              admitted = true;
              counters.pendingFilteredReceived++;
              enqueueEvidence(familyId, {
                ...baseHint,
                executionEvidence: validated,
                resolvePendingExecutionEvidence: (familyIds) =>
                  session.resolve(familyIds, "canonical"),
              });
            } finally {
              if (!finished) {
                admissionQueue.finishUnknownAttempt(
                  familyId,
                  head.hash,
                  false,
                );
              }
            }
          },
        ));
      })().catch(() => {
        // Speculative unknown-target admission has its own bounded scheduler;
        // failure cannot consume or disconnect canonical intake.
      });
    };
    const processHash = (hash: string) => {
      const observation = Object.freeze({
        observedAtMs: Date.now(),
        observedAtMonotonicMs: performance.now(),
      });
      const normalized = hash.toLowerCase();
      if (!TX_HASH_RE.test(normalized)) return;
      counters.pendingReceived++;
      if (seen.has(normalized)) return;
      if (inFlight >= maxInFlight) return;
      seen.add(normalized);
      if (seen.size > 100_000) seen.clear();

      inFlight++;
      void (async () => {
        try {
          const tx = await withTimeout(
            provider.getTransaction(normalized),
            txTimeoutMs,
            `getTransaction ${normalized.slice(0, 10)}`,
          );
          if (!tx) return;
          const session = evidenceSession(tx);
          startCurrentHeadRouteActivation(session, tx, observation);
          const canonicalTarget = interesting(tx.to);
          const rawTx = await withTimeout(
            rawTxByHash(provider, normalized, tx, true),
            txTimeoutMs,
            `rawTx ${normalized.slice(0, 10)}`,
          );
          if (!rawTx) return;
          const baseHint = {
            payload: { mempool: true },
            hashes: [tx.hash],
            source: "mempool",
            prefetched: { tx, rawTx },
          } satisfies HintEnvelope;
          if (canonicalTarget) {
            counters.pendingFilteredReceived++;
            enqueueCanonical({
              ...baseHint,
              resolvePendingExecutionEvidence: (familyIds) =>
                session.resolve(familyIds, "canonical"),
            });
            return;
          }
          startUnknownEvidenceAdmission(session, baseHint);
        } catch {
          // Pending hashes can vanish or arrive before the tx is queryable.
        } finally {
          inFlight--;
        }
      })();
    };
    const processFullTransaction = (result: Record<string, unknown>) => {
      const observation = Object.freeze({
        observedAtMs: Date.now(),
        observedAtMonotonicMs: performance.now(),
      });
      const tx = pendingTxFromAlchemy(result);
      if (!tx) return;
      const hash = tx.hash.toLowerCase();
      counters.pendingReceived++;
      if (seen.has(hash)) return;
      if (inFlight >= maxInFlight) return;
      seen.add(hash);
      if (seen.size > 100_000) seen.clear();

      inFlight++;
      void (async () => {
        try {
          const session = evidenceSession(tx);
          startCurrentHeadRouteActivation(session, tx, observation);
          const canonicalTarget = interesting(tx.to);
          const rawTx = rebuildSignedRawTx(hash, tx);
          if (!rawTx) return;
          const baseHint = {
            payload: { mempool: true },
            hashes: [tx.hash],
            source: "mempool",
            prefetched: { tx, rawTx },
          } satisfies HintEnvelope;
          if (canonicalTarget) {
            counters.pendingFilteredReceived++;
            enqueueCanonical({
              ...baseHint,
              resolvePendingExecutionEvidence: (familyIds) =>
                session.resolve(familyIds, "canonical"),
            });
            return;
          }
          startUnknownEvidenceAdmission(session, baseHint);
        } finally {
          inFlight--;
        }
      })().catch(() => {
        // Malformed full transaction notifications and family-local evidence
        // failures remain isolated from the shared subscription.
      });
    };

    ws.addEventListener("error", fail);
    ws.addEventListener("close", fail);
    ws.addEventListener("message", (event) => {
      const msg = parseWsJson(event.data);
      if (msg?.method !== "eth_subscription") return;
      const subscription = msg.params?.subscription;
      const result = msg.params?.result;
      if (subscription === headSubscriptionId && isRecord(result)) {
        const head = parseEvidenceHead(result);
        if (head) evidenceHeadSnapshot.update(head);
        return;
      }
      if (subscription !== pendingSubscriptionId) return;
      if (typeof result === "string") {
        processHash(result);
        return;
      }
      if (isRecord(result)) processFullTransaction(result);
    });

    try {
      for (;;) {
        if (failed) break;
        const hint = admissionQueue.dequeue();
        if (!hint) {
          await new Promise<void>((res) => {
            wake = res;
          });
          wake = null;
          continue;
        }
        yield hint;
      }
    } finally {
      try { ws.close(); } catch { /* already closed */ }
    }
    console.log("[searcher/live] mempool local firehose reconnect");
    await sleep(1_000);
  }
}

interface StandardMempoolConnection {
  readonly ws: WebSocket;
  readonly pendingSubscriptionId: string;
  readonly headSubscriptionId: string;
}

async function connectStandardMempool(
  wsUrl: string,
): Promise<StandardMempoolConnection> {
  const ws = await openWebSocket(wsUrl);
  try {
    // Subscribe to the auxiliary head stream first. The pending subscription
    // is activated last, immediately before returning to the caller that
    // installs the notification handler, so there is no multi-request window
    // in which orderflow is live but unconsumed.
    const headSubscriptionId = await wsRequest(
      ws,
      "eth_subscribe",
      ["newHeads"],
    );
    const pendingSubscriptionId = await wsRequest(
      ws,
      "eth_subscribe",
      ["newPendingTransactions"],
    );
    if (
      typeof pendingSubscriptionId !== "string" ||
      typeof headSubscriptionId !== "string"
    ) {
      throw new Error("unexpected standard mempool subscription id");
    }
    console.log(
      `[searcher/live] mempool WS connected ` +
        `localFirehoseSub=${pendingSubscriptionId} ` +
        `headSub=${headSubscriptionId}`,
    );
    console.log("[searcher/live] mempool_state=connected");
    return Object.freeze({
      ws,
      pendingSubscriptionId,
      headSubscriptionId,
    });
  } catch (err) {
    try { ws.close(); } catch { /* already closed */ }
    throw err;
  }
}

function shouldUseLocalFirehoseFallback(wsUrl: string, err: Error): boolean {
  return isLocalOrPrivateWsUrl(wsUrl) && isAlchemyFilteredUnsupported(err);
}

function isAlchemyFilteredUnsupported(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("alchemy_pendingtransactions") &&
    (msg.includes("unknown variant") || msg.includes("invalid params") || msg.includes("-32602"))
  );
}

function isLocalOrPrivateWsUrl(wsUrl: string): boolean {
  try {
    const parsed = new URL(wsUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host === "[::1]") return true;
    if (host.startsWith("127.")) return true;
    if (host.startsWith("10.")) return true;
    if (host.startsWith("192.168.")) return true;
    const parts = host.split(".").map((part) => Number(part));
    return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
  } catch {
    return false;
  }
}

class FatalMempoolSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalMempoolSubscriptionError";
  }
}

let wsRpcId = 1;

export function filterLiveProtocolRegistry(pools: PoolEntry[], enabled: boolean): PoolEntry[] {
  if (enabled) return pools;
  return pools.filter((pool) =>
    PRODUCTION_ADAPTER_FAMILIES.routes().findForPool(pool.adapter)?.requiresProtocolEdgesFlag !== true
  );
}

export function buildMempoolToAddressFilter(pools: PoolEntry[], routersPath?: string): string[] {
  const forceRouters = loadForceIncludeRouters(
    routersPath ?? process.env.SEARCHER_FORCE_INCLUDE_ROUTERS_PATH ?? undefined,
  );
  return [...buildMempoolIntakeWithRouters(pools, forceRouters).filteredTargets];
}

export function isMempoolIntakeTarget(
  to: string | null | undefined,
  startupTargets: ReadonlySet<string>,
  liveGraphTargets?: ReadonlySet<string>,
): boolean {
  if (!to) return false;
  const key = to.toLowerCase();
  return startupTargets.has(key) || liveGraphTargets?.has(key) === true;
}

export function buildMempoolIntakeWithRouters(
  pools: PoolEntry[],
  forceRouters: readonly string[],
): MempoolIntakePlan {
  const hotPoolTopN = Number(process.env.SEARCHER_MEMPOOL_FILTER_TOP_N ?? "200");
  const maxAddresses = Number(process.env.SEARCHER_MEMPOOL_FILTER_MAX_ADDRESSES ?? "300");
  const intake = buildMempoolIntakePlan({
    pools,
    swaps: PRODUCTION_ADAPTER_FAMILIES.swaps(),
    dynamicRouterTargets: forceRouters,
    additionalCanonicalTargets: oracleVictimWatchTargets(
      PRODUCTION_ADAPTER_FAMILIES.oracleVictims(),
    ),
    options: { hotPoolTopN, filteredMaxAddresses: maxAddresses },
  });
  if (intake.filteredTargets.length === 0) {
    throw new FatalMempoolSubscriptionError("mempool filtered subscription has empty toAddress list");
  }
  if (intake.filteredTruncated) {
    console.log(
      `[searcher/live] external mempool coverage truncated to ` +
        `${intake.filteredTargets.length}/${intake.fullTargets.length} targets; ` +
        `local firehose retains the complete set`,
    );
  }
  return intake;
}

async function connectFilteredMempool(wsUrl: string, toAddress: string[]): Promise<WebSocket> {
  const ws = await openWebSocket(wsUrl);
  try {
    const subId = await wsRequest(ws, "eth_subscribe", [
      "alchemy_pendingTransactions",
      { toAddress, hashesOnly: false },
    ]);
    if (typeof subId !== "string") {
      throw new Error(`unexpected subscription id ${String(subId)}`);
    }
    console.log(`[searcher/live] mempool WS connected filteredSub=${subId}`);
    console.log("[searcher/live] mempool_state=connected");
    return ws;
  } catch (err) {
    try { ws.close(); } catch { /* already closed */ }
    throw new FatalMempoolSubscriptionError(
      `filtered mempool subscription rejected; refusing hash-firehose fallback: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function openWebSocket(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error("mempool websocket open timeout")), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const finish = <T>(fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onOpen = () => finish(resolve, ws);
    const onError = () => finish(reject, new Error("mempool websocket error"));
    const onClose = () => finish(reject, new Error("mempool websocket closed before open"));
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

function wsRequest(ws: WebSocket, method: string, params: unknown[]): Promise<unknown> {
  const id = wsRpcId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error(`${method} timeout`)), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const finish = <T>(fn: (value: T) => void, value: T) => {
      cleanup();
      fn(value);
    };
    const onMessage = (event: MessageEvent) => {
      const msg = parseWsJson(event.data);
      if (!msg || msg.id !== id) return;
      if (msg.error) {
        finish(reject, new Error(JSON.stringify(msg.error)));
      } else {
        finish(resolve, msg.result);
      }
    };
    const onError = () => finish(reject, new Error(`${method} websocket error`));
    const onClose = () => finish(reject, new Error(`${method} websocket closed`));
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function pendingTxFromAlchemy(raw: Record<string, unknown>): ethers.TransactionResponse | null {
  const hash = stringField(raw.hash);
  const from = normalizeAddress(stringField(raw.from));
  const to = normalizeAddress(stringField(raw.to));
  const input = stringField(raw.input) ?? stringField(raw.data) ?? "0x";
  const signature = pendingSignature(raw);
  if (!hash || !TX_HASH_RE.test(hash) || !from || !to || !signature) return null;
  return {
    hash,
    from,
    to,
    nonce: quantityNumber(raw.nonce),
    gasLimit: quantityBigInt(raw.gas ?? raw.gasLimit),
    gasPrice: optionalQuantityBigInt(raw.gasPrice),
    maxFeePerGas: optionalQuantityBigInt(raw.maxFeePerGas),
    maxPriorityFeePerGas: optionalQuantityBigInt(raw.maxPriorityFeePerGas),
    data: input,
    value: quantityBigInt(raw.value),
    chainId: optionalQuantityBigInt(raw.chainId) ?? 1n,
    type: quantityNumber(raw.type),
    accessList: Array.isArray(raw.accessList) ? raw.accessList as ethers.AccessListish : [],
    signature,
    blockNumber: null,
    blockHash: null,
    index: null,
  } as unknown as ethers.TransactionResponse;
}

function pendingSignature(raw: Record<string, unknown>): ethers.Signature | null {
  const r = stringField(raw.r);
  const s = stringField(raw.s);
  if (!r || !s) return null;
  try {
    if (typeof raw.v === "string" || typeof raw.v === "number") {
      return ethers.Signature.from({ r, s, v: quantityNumber(raw.v) });
    }
    const rawParity = typeof raw.yParity === "string" || typeof raw.yParity === "number"
      ? quantityNumber(raw.yParity)
      : 0;
    const yParity: 0 | 1 = rawParity === 0 || rawParity === 27 ? 0 : 1;
    return ethers.Signature.from({ r, s, yParity });
  } catch {
    return null;
  }
}

function parseWsJson(data: unknown): Record<string, any> | null {
  try {
    const text = typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
          : null;
    if (!text) return null;
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type VictimSourceMode = "disabled" | "public-mempool" | "mev-share" | "both";

export function victimSourceMode(
  enableBackrun: boolean,
  enableMempool: boolean,
  enableMevShare: boolean,
): VictimSourceMode {
  if (!enableBackrun) return "disabled";
  if (enableMempool && enableMevShare) return "both";
  if (enableMempool) return "public-mempool";
  if (enableMevShare) return "mev-share";
  throw new Error("backrun lane requires at least one victim source");
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeAddress(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function quantityBigInt(value: unknown): bigint {
  return optionalQuantityBigInt(value) ?? 0n;
}

function optionalQuantityBigInt(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value !== "string" || value === "") return undefined;
  return BigInt(value);
}

function quantityNumber(value: unknown): number {
  return Number(quantityBigInt(value));
}

/**
 * Merge multiple hint sources into one stream, racing each source's next() so a
 * slow source never blocks a fast one. The downstream busy-guard serializes
 * actual processing.
 */
async function* mergeHints(
  ...sources: AsyncGenerator<HintEnvelope>[]
): AsyncGenerator<HintEnvelope> {
  const its = sources.map((s) => s[Symbol.asyncIterator]());
  const live = new Set(its.map((_, i) => i));
  const pending = its.map((it, i) => it.next().then((r) => ({ i, r })));
  while (live.size > 0) {
    const { i, r } = await Promise.race(
      [...live].map((idx) => pending[idx]),
    );
    if (r.done) {
      live.delete(i);
      continue;
    }
    yield r.value;
    pending[i] = its[i].next().then((r) => ({ i, r }));
  }
}

async function* mevShareHints(url: string): AsyncGenerator<HintEnvelope> {
  for (;;) {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      timer = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      timer = null;
      if (!res.ok || !res.body) {
        throw new Error(`SSE HTTP ${res.status}`);
      }
      console.log("[searcher/live] MEV-Share SSE connected");

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = parseSseData(frame);
            if (!data) continue;
            const payload = JSON.parse(data) as unknown;
            yield { payload, hashes: extractTxHashes(payload) };
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be closed when the server ended it.
        }
        reader.releaseLock();
      }
    } catch (err) {
      console.log(
        `[searcher/live] SSE reconnect: ${err instanceof Error ? err.message : String(err)}`,
      );
      await sleep(1_000);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
}

async function* disabledHints(): AsyncGenerator<HintEnvelope> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

function parseSseData(frame: string): string | null {
  const parts: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) parts.push(line.slice(5).trimStart());
  }
  const data = parts.join("\n").trim();
  if (!data || data === "[DONE]") return null;
  return data;
}

function extractTxHashes(value: unknown): string[] {
  const hashes = new Set<string>();

  function walk(node: unknown, key = ""): void {
    if (typeof node === "string") {
      if ((key === "hash" || key === "txHash" || key === "transactionHash") && TX_HASH_RE.test(node)) {
        hashes.add(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, childKey);
    }
  }

  walk(value);
  return [...hashes];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * F6 Pair B: adapts the ethers provider to the strict identity provider
 * shape, passing through the nomination capabilities (recent-log reverse
 * lookup, tx seed, trace) that plugin-owned nomination consumes. The
 * framework stays free of protocol semantics; the adapter only maps RPC
 * verbs.
 */
function strictIdentityProvider(
  provider: ethers.JsonRpcProvider,
): StrictIdentityProvider {
  return {
    call: (transaction, blockTag) =>
      provider.call({ ...transaction, blockTag } as ethers.TransactionRequest),
    getCode: (address, blockTag) => provider.getCode(address, blockTag),
    getStorage: (address, slot, blockTag) =>
      provider.getStorage(address, slot, blockTag),
    getLogs: (filter) => provider.getLogs({
      ...(filter.address === undefined ? {} : { address: filter.address }),
      fromBlock: filter.fromBlock ?? 0,
      toBlock: filter.toBlock ?? 0,
      topics: filter.topics ?? [],
    } as unknown as ethers.Filter),
    getTransactionReceipt: (hash) => provider.getTransactionReceipt(hash),
    traceTransaction: (hash) => provider.send("debug_traceTransaction", [
      hash,
      { tracer: "callTracer" },
    ]),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[searcher/live] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  indexFactoryPools,
  mergePoolRegistries,
  scanActivePoolsDetailed,
} from "../active-pool-discovery.js";
import {
  BlockScanStateCoordinator,
  type BlockScanStateSnapshot,
} from
  "../blockscan-state-coordinator.js";
import { JsonRpcBlockScanStateReadBackend } from
  "../blockscan-state-read-backend.js";
import {
  DEFAULT_BLOCKSCAN_VIEW_OVERRIDES_PATH,
  loadBlockScanViewOverrides,
} from
  "../blockscan-view-overrides.js";
import {
  DEFAULT_FORCE_INCLUDE_POOLIDS_PATH,
  loadForceIncludePoolIds,
  mergeForceIncludePoolIds,
} from "../force-include.js";
import {
  DEFAULT_PINNED_WARM_POOLS_PATH,
  loadPinnedWarmPools,
} from "../pinned-warm-pools.js";
import {
  planDiscoveryStartup,
} from "../discovery-source-watermark.js";
import {
  buildTokenGraphWithResults,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenEdge,
} from "../planner/token-graph.js";
import {
  loadPoolUniverse,
  loadPoolUniverseCoverageMetadata,
  loadPoolUniverseGeneratedAt,
  poolRegistryKey,
  selectPairCompletionPools,
} from "../pool-universe.js";
import {
  cachedProtocolCandidates,
  invalidateProtocolObservedHistory,
  loadProtocolDiscoveryEvidenceCache,
  protocolObservedCursorAnchorMatches,
  reconcileProtocolDiscoveryEvidenceCache,
  recordProtocolRouteOwnership,
  setProtocolObservedCursor,
  type ProtocolDiscoveryEvidenceCache,
  updateProtocolObservedSourceFingerprint,
} from "../protocol-discovery-cache.js";
import {
  protocolCandidateAddressesFromDexGraph,
  protocolCandidateAddressesFromDexUniverse,
  protocolDiscoveryCandidateAddressHints,
  prepareActiveProtocolDiscoveryPass,
} from "../protocol-discovery-runtime.js";
import {
  protocolDiscoverySourceFingerprints,
  protocolObservedSourceFingerprint,
} from "../observed-protocol-discovery.js";
import {
  protocolInstanceKey,
  type ProtocolDiscoveryOwnership,
} from "../protocol-instance-discovery.js";
import { createPinnedDexReadBackend } from "../runtime-pool-refresh.js";
import {
  buildStrategyViews,
} from "../strategy-views.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "../venues/admission.js";
import {
  blockScanEdgeKey,
  createVerifiedGraphView,
} from "../venues/blockscan-state-capability.js";
import {
  attestPoolIdentities,
  createPoolIdentityCache,
} from "../venues/identity.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
} from "../venues/production-registry.js";
import { wstethAdapter } from "../venues/protocols/wsteth.js";
import type {
  ConversionFreshnessPrivatePredicate,
  ConversionFreshnessReveal,
} from "./conversion-freshness-oracle.js";
import {
  conversionRuntimeFromPricing,
} from "./conversion-freshness-production-live.js";
import {
  captureConversionProductionEvidenceWithProducer,
  compareConversionProductionEvidence,
  conversionProductionDeliveryId,
  conversionProductionGraphArtifactSha256,
  conversionRuntimeWithTargetMidsRestored,
  conversionProductionScannerConfigSha256,
  scanConversionProductionCandidateOracle,
  type ConversionCandidateRankOracleEntry,
  type ConversionProductionComparison,
  type SealedConversionProductionEvidence,
} from "./conversion-freshness-production-evidence.js";
import { sha256Canonical } from "./adapter-family-blind-contract.js";
import {
  validateConversionUniverseBuildManifest,
} from "./conversion-freshness-universe-manifest.js";

export interface ConversionProductionFullResolvedConfig {
  readonly universeTopN: number;
  readonly universeMinScore: number;
  readonly universeForceInclude: readonly string[];
  readonly universeHighSpreadPairQuota: number;
  readonly universeHighSpreadMinFee: number;
  readonly pairCompletion: boolean;
  readonly pinnedWarmPoolPath: string;
  readonly blockscanOverridesPath: string;
  readonly discoveryQueuePath: string;
  readonly blockscanExtraPools: number;
  readonly factoryLookbackBlocks: number;
  readonly activeLookbackBlocks: number;
  readonly activeTopN: number;
  readonly protocolDiscoveryLookbackBlocks: number;
  readonly protocolDiscoveryMaxCatchupBlocks: number;
  readonly protocolDiscoveryCachePath: string;
  readonly protocolEdgesEnabled: boolean;
  readonly protocolDiscoveryShadow: boolean;
  readonly probeExecutor: string;
  readonly scanner: Readonly<{
    maxHops: number;
    minSpreadBps: number;
    maxCandidates: number;
    budgetMs: number;
    pinnedOutsideBudget: false;
  }>;
}

export const CONVERSION_PRODUCTION_INPUTS_PROFILE =
  "conversion-production-inputs-v1" as const;

interface ConversionProductionFrozenFile {
  readonly role:
    | "force-include"
    | "pinned-warm-pools"
    | "blockscan-overrides"
    | "protocol-discovery-cache"
    | "discovery-queue";
  readonly sourcePath: string;
  readonly frozenPath: string;
  readonly exists: boolean;
  readonly contentSha256: string;
}

export interface ConversionProductionInputManifest {
  readonly schemaVersion: 1;
  readonly profile: typeof CONVERSION_PRODUCTION_INPUTS_PROFILE;
  readonly resolvedConfig: ConversionProductionFullResolvedConfig;
  readonly files: readonly ConversionProductionFrozenFile[];
}

/**
 * Resolve the same graph/scanner knobs consumed by main. The closure records
 * the canonical hash of this post-load value; deploy-time overrides therefore
 * cannot silently fall back to source defaults during evidence generation.
 */
export function resolveConversionProductionFullConfig(
  env: NodeJS.ProcessEnv,
): ConversionProductionFullResolvedConfig {
  const forceIncludePath =
    env.SEARCHER_FORCE_INCLUDE_POOLIDS_PATH ??
      DEFAULT_FORCE_INCLUDE_POOLIDS_PATH;
  const forceInclude = mergeForceIncludePoolIds(
    parseForceIncludeList(env.SEARCHER_POOL_UNIVERSE_FORCE_INCLUDE),
    loadForceIncludePoolIds(forceIncludePath),
  );
  const protocolDiscoveryLookbackBlocks = positiveInteger(
    env.SEARCHER_PROTOCOL_DISCOVERY_BLOCKS ?? "300",
    "SEARCHER_PROTOCOL_DISCOVERY_BLOCKS",
  );
  const protocolDiscoveryMaxCatchupBlocks = Math.max(
    protocolDiscoveryLookbackBlocks,
    positiveInteger(
      env.SEARCHER_PROTOCOL_DISCOVERY_MAX_CATCHUP_BLOCKS ?? "50000",
      "SEARCHER_PROTOCOL_DISCOVERY_MAX_CATCHUP_BLOCKS",
    ),
  );
  return Object.freeze({
    universeTopN: nonnegativeInteger(
      env.SEARCHER_POOL_UNIVERSE_TOP_N ?? "20000",
      "SEARCHER_POOL_UNIVERSE_TOP_N",
    ),
    universeMinScore: finiteNumber(
      env.SEARCHER_POOL_UNIVERSE_MIN_SCORE ?? "1",
      "SEARCHER_POOL_UNIVERSE_MIN_SCORE",
    ),
    universeForceInclude: Object.freeze(forceInclude),
    universeHighSpreadPairQuota: nonnegativeInteger(
      env.SEARCHER_POOL_UNIVERSE_HIGH_SPREAD_PAIR_QUOTA ?? "150",
      "SEARCHER_POOL_UNIVERSE_HIGH_SPREAD_PAIR_QUOTA",
    ),
    universeHighSpreadMinFee: nonnegativeInteger(
      env.SEARCHER_POOL_UNIVERSE_HIGH_SPREAD_MIN_FEE ?? "10000",
      "SEARCHER_POOL_UNIVERSE_HIGH_SPREAD_MIN_FEE",
    ),
    pairCompletion: env.SEARCHER_PAIR_COMPLETION !== "0",
    pinnedWarmPoolPath:
      env.SEARCHER_PINNED_WARM_POOLS ??
      DEFAULT_PINNED_WARM_POOLS_PATH,
    blockscanOverridesPath: DEFAULT_BLOCKSCAN_VIEW_OVERRIDES_PATH,
    discoveryQueuePath:
      env.POOL_UNIVERSE_DISCOVERY_QUEUE_PATH ??
      resolve("searcher", "pools", "discovery-queue.json"),
    blockscanExtraPools: nonnegativeInteger(
      env.SEARCHER_BLOCKSCAN_VIEW_MAX_POOLS ?? "6000",
      "SEARCHER_BLOCKSCAN_VIEW_MAX_POOLS",
    ),
    factoryLookbackBlocks: nonnegativeInteger(
      env.SEARCHER_FACTORY_BLOCKS ?? "50000",
      "SEARCHER_FACTORY_BLOCKS",
    ),
    activeLookbackBlocks: nonnegativeInteger(
      env.SEARCHER_DISCOVERY_BLOCKS ?? "300",
      "SEARCHER_DISCOVERY_BLOCKS",
    ),
    activeTopN: nonnegativeInteger(
      env.SEARCHER_DISCOVERY_TOP_N ?? "100",
      "SEARCHER_DISCOVERY_TOP_N",
    ),
    protocolDiscoveryLookbackBlocks,
    protocolDiscoveryMaxCatchupBlocks,
    protocolDiscoveryCachePath:
      env.SEARCHER_PROTOCOL_DISCOVERY_CACHE_PATH ??
      resolve(
        "searcher",
        "pools",
        "runtime-protocol-discovery-cache.json",
      ),
    protocolEdgesEnabled: env.SEARCHER_ENABLE_PROTOCOL_EDGES === "1",
    protocolDiscoveryShadow:
      env.SEARCHER_PROTOCOL_DISCOVERY_SHADOW === "1",
    probeExecutor: ethers.getAddress(
      env.BOTVM_ADDRESS ??
        (() => {
          throw new Error("BOTVM_ADDRESS is required");
        })(),
    ),
    scanner: Object.freeze({
      maxHops: nonnegativeInteger(
        env.SEARCHER_BLOCKSCAN_MAX_HOPS ?? "4",
        "SEARCHER_BLOCKSCAN_MAX_HOPS",
      ),
      minSpreadBps: finiteNumber(
        env.SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS ?? "10",
        "SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS",
      ),
      maxCandidates: nonnegativeInteger(
        env.SEARCHER_BLOCKSCAN_MAX_CANDIDATES ?? "100",
        "SEARCHER_BLOCKSCAN_MAX_CANDIDATES",
      ),
      budgetMs: nonnegativeInteger(
        env.SEARCHER_BLOCKSCAN_SCAN_BUDGET_MS ?? "1500",
        "SEARCHER_BLOCKSCAN_SCAN_BUDGET_MS",
      ),
      pinnedOutsideBudget: false as const,
    }),
  });
}

/**
 * Freeze every mutable, non-chain input before the selection reveal. The plan
 * commits to sha256Canonical(manifest); the production-full runner consumes
 * only these copied files and never re-resolves process.env.
 */
export function freezeConversionProductionInputs(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly artifactDirectory: string;
}): ConversionProductionInputManifest {
  const sourceConfig = resolveConversionProductionFullConfig(input.env);
  const directory = resolve(input.artifactDirectory, "production-inputs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const forceIncludeSource =
    input.env.SEARCHER_FORCE_INCLUDE_POOLIDS_PATH ??
    DEFAULT_FORCE_INCLUDE_POOLIDS_PATH;
  const bindings = Object.freeze([
    freezeProductionInputFile("force-include", forceIncludeSource, directory),
    freezeProductionInputFile(
      "pinned-warm-pools",
      sourceConfig.pinnedWarmPoolPath,
      directory,
    ),
    freezeProductionInputFile(
      "blockscan-overrides",
      sourceConfig.blockscanOverridesPath,
      directory,
    ),
    freezeProductionInputFile(
      "protocol-discovery-cache",
      sourceConfig.protocolDiscoveryCachePath,
      directory,
    ),
    freezeProductionInputFile(
      "discovery-queue",
      sourceConfig.discoveryQueuePath,
      directory,
    ),
  ]);
  const byRole = new Map(bindings.map((binding) => [binding.role, binding]));
  const resolvedConfig = Object.freeze({
    ...sourceConfig,
    pinnedWarmPoolPath: byRole.get("pinned-warm-pools")!.frozenPath,
    blockscanOverridesPath: byRole.get("blockscan-overrides")!.frozenPath,
    protocolDiscoveryCachePath:
      byRole.get("protocol-discovery-cache")!.frozenPath,
    discoveryQueuePath: byRole.get("discovery-queue")!.frozenPath,
  });
  const manifest = Object.freeze({
    schemaVersion: 1 as const,
    profile: CONVERSION_PRODUCTION_INPUTS_PROFILE,
    resolvedConfig,
    files: bindings,
  });
  validateConversionProductionInputs(manifest);
  return manifest;
}

export function validateConversionProductionInputs(
  manifest: ConversionProductionInputManifest,
  expectedSha256?: string,
): ConversionProductionFullResolvedConfig {
  assert.equal(manifest.schemaVersion, 1, "conversion inputs schema");
  assert.equal(
    manifest.profile,
    CONVERSION_PRODUCTION_INPUTS_PROFILE,
    "conversion inputs profile",
  );
  if (expectedSha256 !== undefined) {
    assert.equal(
      sha256Canonical(manifest),
      expectedSha256,
      "conversion production inputs do not match the reveal-preceding commitment",
    );
  }
  const roles = new Set<string>();
  for (const file of manifest.files) {
    assert(!roles.has(file.role), `duplicate conversion input ${file.role}`);
    roles.add(file.role);
    assert.equal(
      existsSync(file.frozenPath),
      file.exists,
      `conversion frozen input existence changed: ${file.role}`,
    );
    const actual = file.exists
      ? createHash("sha256").update(readFileSync(file.frozenPath)).digest("hex")
      : sha256Canonical(null);
    assert.equal(
      actual,
      file.contentSha256,
      `conversion frozen input changed: ${file.role}`,
    );
  }
  assert.deepEqual(
    [...roles].sort(),
    [
      "blockscan-overrides",
      "discovery-queue",
      "force-include",
      "pinned-warm-pools",
      "protocol-discovery-cache",
    ],
    "conversion production inputs are incomplete",
  );
  const fileFor = (
    role: ConversionProductionFrozenFile["role"],
  ): ConversionProductionFrozenFile => manifest.files.find(
    (file) => file.role === role,
  )!;
  assert.equal(
    resolve(manifest.resolvedConfig.pinnedWarmPoolPath),
    resolve(fileFor("pinned-warm-pools").frozenPath),
    "conversion pinned pools do not use the frozen input",
  );
  assert.equal(
    resolve(manifest.resolvedConfig.blockscanOverridesPath),
    resolve(fileFor("blockscan-overrides").frozenPath),
    "conversion overrides do not use the frozen input",
  );
  assert.equal(
    resolve(manifest.resolvedConfig.protocolDiscoveryCachePath),
    resolve(fileFor("protocol-discovery-cache").frozenPath),
    "conversion protocol cache does not use the frozen input",
  );
  assert.equal(
    resolve(manifest.resolvedConfig.discoveryQueuePath),
    resolve(fileFor("discovery-queue").frozenPath),
    "conversion discovery queue does not use the frozen input",
  );
  assert.equal(
    manifest.resolvedConfig.protocolDiscoveryShadow,
    false,
    "production-full conversion requires active protocol discovery",
  );
  assert(
    manifest.resolvedConfig.protocolEdgesEnabled,
    "production-full conversion requires live protocol edges enabled",
  );
  return manifest.resolvedConfig;
}

function freezeProductionInputFile(
  role: ConversionProductionFrozenFile["role"],
  sourcePath: string,
  directory: string,
): ConversionProductionFrozenFile {
  const frozenPath = resolve(directory, `${role}.json`);
  const present = existsSync(sourcePath);
  if (present) {
    copyFileSync(sourcePath, frozenPath);
    chmodSync(frozenPath, 0o600);
  } else {
    rmSync(frozenPath, { force: true });
  }
  return Object.freeze({
    role,
    sourcePath: resolve(sourcePath),
    frozenPath,
    exists: present,
    contentSha256: present
      ? createHash("sha256").update(readFileSync(frozenPath)).digest("hex")
      : sha256Canonical(null),
  });
}

export interface ConversionProductionFullLiveResult {
  readonly comparison: ConversionProductionComparison;
  readonly sealed: SealedConversionProductionEvidence;
  readonly graph: {
    readonly scope: "production-full";
    readonly universePools: number;
    readonly universeSha256: string;
    readonly universeManifestSha256: string;
    readonly productionInputsSha256: string;
    readonly resolvedConfigSha256: string;
    readonly runtimePools: number;
    readonly edges: number;
    readonly artifactSha256: string;
    readonly graphBuildFailures: number;
    readonly identityRejections: number;
    readonly protocolCacheSha256: string;
    readonly protocolAdmissions: number;
  };
  readonly scanner: {
    readonly baseCandidates: readonly ConversionCandidateRankOracleEntry[];
    readonly sourceCandidates: readonly ConversionCandidateRankOracleEntry[];
    readonly sourceWithoutTargetUpdateCandidates:
      readonly ConversionCandidateRankOracleEntry[];
    readonly baseSetSha256: string;
    readonly sourceSetSha256: string;
    readonly sourceWithoutTargetUpdateSetSha256: string;
    readonly targetBaseRanks: readonly number[];
    readonly targetSourceRanks: readonly number[];
    readonly targetSourceWithoutUpdateRanks: readonly number[];
  };
}

/**
 * Trusted post-selection closure over the complete production pool view.
 *
 * The graph is built once from the selected N-1 universe and is reused
 * unchanged at N. Only dynamic family state advances. This is deliberately
 * different from a component fixture: static protocol venues, pinned pools,
 * recent factory pools, recent landed swaps and permissionless protocol
 * discovery all participate before the graph artifact is sealed.
 */
export async function verifySelectedConversionProductionFullLive(input: {
  readonly rpcUrl: string;
  readonly universePath: string;
  readonly universeManifestPath?: string;
  readonly productionInputs: ConversionProductionInputManifest;
  readonly predicate: ConversionFreshnessPrivatePredicate;
  readonly reveal: ConversionFreshnessReveal;
  readonly stateDeadlineMs?: number;
  readonly scanBudgetMs?: number;
}): Promise<ConversionProductionFullLiveResult> {
  assert.equal(input.reveal.freshnessEvidence, "selected");
  const selected = input.reveal.selected;
  const evidence = input.reveal.selectedEvidence;
  assert(selected && evidence, "production-full conversion needs selected evidence");
  assert.equal(selected.sourceBlock, evidence.source.number);
  assert.equal(evidence.base.number + 1, evidence.source.number);
  const resolvedConfig = validateConversionProductionInputs(
    input.productionInputs,
    input.reveal.plan.productionInputsSha256,
  );

  const provider = new ethers.JsonRpcProvider(input.rpcUrl);
  await Promise.all([
    assertCanonicalHeader(provider, evidence.base),
    assertCanonicalHeader(provider, evidence.source),
  ]);
  const pinnedBase = createPinnedDexReadBackend(
    provider,
    evidence.base.number,
  );
  const rawUniverse = loadPoolUniverse(input.universePath, {
    maxPools: 0,
    minScore: 0,
    missingOk: false,
  });
  const deployedUniverse = loadPoolUniverse(input.universePath, {
    maxPools: resolvedConfig.universeTopN,
    minScore: resolvedConfig.universeMinScore,
    forceInclude: [...resolvedConfig.universeForceInclude],
    highSpreadPairQuota: resolvedConfig.universeHighSpreadPairQuota,
    highSpreadMinFee: resolvedConfig.universeHighSpreadMinFee,
    missingOk: false,
  });
  const universeCoverage = loadPoolUniverseCoverageMetadata(
    input.universePath,
  );
  assert.equal(
    universeCoverage.toBlock,
    evidence.base.number,
    "production-full universe is not pinned to selected N-1",
  );
  assert(
    universeCoverage.contentSha256.length === 64,
    "production-full universe lacks a content hash",
  );
  const universeManifestSha256 = validateConversionUniverseBuildManifest({
    manifestPath:
      input.universeManifestPath ?? `${input.universePath}.manifest.json`,
    universePath: input.universePath,
    universeSha256: universeCoverage.contentSha256,
    universePools: rawUniverse.length,
    expectedDiscoveryQueueExists: input.productionInputs.files.find(
      (file) => file.role === "discovery-queue",
    )!.exists,
    expectedDiscoveryQueueSha256: input.productionInputs.files.find(
      (file) => file.role === "discovery-queue",
    )!.contentSha256,
    expectedSource: evidence.base,
  });
  const identityCache = createPoolIdentityCache();
  const liveRegistry = POOL_REGISTRY.filter((pool) =>
    PRODUCTION_ADAPTER_FAMILIES.routes().findForPool(pool.adapter)
      ?.requiresProtocolEdgesFlag !== true ||
    resolvedConfig.protocolEdgesEnabled
  );
  const rawPinnedPools = loadPinnedWarmPools(resolvedConfig.pinnedWarmPoolPath);
  const rawOverrides = loadBlockScanViewOverrides(
    resolvedConfig.blockscanOverridesPath,
  );
  const [
    pinnedIdentity,
    universeIdentity,
    blockscanIdentity,
    overrideIdentity,
  ] = await Promise.all([
    attestPoolIdentities(pinnedBase, rawPinnedPools, {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      cache: identityCache,
      seedEntries: liveRegistry,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    }),
    attestPoolIdentities(pinnedBase, deployedUniverse, {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      cache: identityCache,
      seedEntries: liveRegistry,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    }),
    attestPoolIdentities(pinnedBase, rawUniverse, {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      cache: identityCache,
      seedEntries: liveRegistry,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    }),
    attestPoolIdentities(pinnedBase, rawOverrides, {
      identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
      cache: identityCache,
      seedEntries: liveRegistry,
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    }),
  ]);
  const identityRejections =
    pinnedIdentity.rejected.length +
    universeIdentity.rejected.length +
    blockscanIdentity.rejected.length +
    overrideIdentity.rejected.length;
  const blockscanUniverse = blockscanIdentity.accepted;
  const [factoryPools, active] = await Promise.all([
    indexFactoryPools(
      provider,
      resolvedConfig.factoryLookbackBlocks,
      evidence.base.number,
      { strict: true },
    ),
    scanActivePoolsDetailed(
      provider,
      resolvedConfig.activeLookbackBlocks,
      resolvedConfig.activeTopN,
      evidence.base.number,
      {
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
      identityBackend: pinnedBase,
      identityBlockTag: evidence.base.number,
      strict: true,
      },
    ),
  ]);
  const rankedBasePools = mergePoolRegistries(
    mergePoolRegistries(
      mergePoolRegistries(
        mergePoolRegistries(liveRegistry, pinnedIdentity.accepted),
        universeIdentity.accepted,
      ),
      factoryPools,
    ),
    [...active.pools],
  );
  const basePools = mergePoolRegistries(
    rankedBasePools,
    resolvedConfig.pairCompletion
      ? selectPairCompletionPools(rankedBasePools, blockscanUniverse)
      : [],
  );
  const buildViews = (pools: readonly PoolEntry[]) => buildStrategyViews(
    [...pools],
    blockscanUniverse,
    overrideIdentity.accepted,
    {
      blockscanMaxPools: resolvedConfig.blockscanExtraPools,
      poolUniverseGeneratedAt: loadPoolUniverseGeneratedAt(input.universePath),
    },
  );
  const initialViews = buildViews(basePools);
  const [backrunBuild, blockscanBuild] = await Promise.all([
    buildTokenGraphWithResults(pinnedBase, initialViews.backrun),
    buildTokenGraphWithResults(pinnedBase, initialViews.blockscan),
  ]);
  const graphBuildFailures =
    backrunBuild.failed.length + blockscanBuild.failed.length;
  assert.equal(
    graphBuildFailures,
    0,
    "production-full graph projection has retryable pool failures",
  );

  const dexPoolAdapters = new Set(
    PRODUCTION_ADAPTER_FAMILIES.swaps().flatMap(
      (family) => [...family.poolAdapters],
    ),
  );
  const fullDexUniverseTokens = protocolCandidateAddressesFromDexUniverse(
    blockscanUniverse,
    dexPoolAdapters,
  );
  const graphTokens = [...new Set([
    ...fullDexUniverseTokens,
    ...protocolCandidateAddressesFromDexGraph(
      backrunBuild.edges,
      blockscanBuild.edges,
    ),
  ])].sort();
  const candidateAddresses = [...new Set([
    ...graphTokens,
    ...protocolDiscoveryCandidateAddressHints(
      PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes(),
    ),
  ])].sort();
  const protocolCacheInput = await prepareProtocolDiscoveryCacheAtBase({
    provider,
    config: resolvedConfig,
    base: evidence.base,
  });
  const protocol = await prepareActiveProtocolDiscoveryPass({
    provider,
    adapters: PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes(),
    identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
    protocolEdgesEnabled: resolvedConfig.protocolEdgesEnabled,
    chainId: 1,
    currentOwnership: protocolCacheInput.ownership,
    currentBackrunPools: initialViews.backrun,
    currentBackrunGraph: backrunBuild.edges,
    currentBlockscanGraph: blockscanBuild.edges,
    currentKnownPoolKeys: new Set(initialViews.backrun.map(poolRegistryKey)),
    buildStrategyViews: (pools) => buildViews(pools),
    blockNumber: evidence.base.number,
    fromBlock: protocolCacheInput.range.fromBlock,
    toBlock: protocolCacheInput.range.toBlock,
    graphTokens,
    candidateAddresses,
    evidenceCache: protocolCacheInput.cache,
    bootstrapCandidates: cachedProtocolCandidates(protocolCacheInput.cache),
    probeExecutor: resolvedConfig.probeExecutor,
    shadow: resolvedConfig.protocolDiscoveryShadow,
  });
  assert(protocol.projection, "production-full protocol projection missing");
  assert(
    protocol.scanner.sourceComplete && protocol.result.evaluationComplete,
    "production-full protocol discovery is incomplete",
  );
  reconcileProtocolDiscoveryEvidenceCache(
    protocolCacheInput.cache,
    protocol.result,
  );
  recordProtocolRouteOwnership(
    protocolCacheInput.cache,
    protocol.projection.ownership,
  );
  setProtocolObservedCursor(
    protocolCacheInput.cache,
    evidence.base.number,
    evidence.base.hash,
  );
  const baseEdges = Object.freeze([
    ...(protocol.projection.blockscanGraph ?? blockscanBuild.edges),
  ]);
  assert(baseEdges.length > 0, "production-full graph has no edges");
  const graphSourceFingerprint = sha256Canonical({
    universeSha256: universeCoverage.contentSha256,
    universeManifestSha256,
    protocolCacheSha256: protocolCacheInput.contentSha256,
    resolvedConfig,
  });
  const baseGraph = fullGraph(
    baseEdges,
    1,
    evidence.base.number,
    evidence.base.hash,
    graphSourceFingerprint,
  );

  // Prove that freezing the N-1 topology for the conversion comparison is not
  // hiding a real N discovery delta. Run the same registered DEX/protocol
  // discovery entrances for N and require the resulting production view to be
  // exactly the same graph.
  const pinnedSource = createPinnedDexReadBackend(
    provider,
    evidence.source.number,
  );
  const [sourceFactoryPools, sourceActive] = await Promise.all([
    indexFactoryPools(provider, 0, evidence.source.number, { strict: true }),
    scanActivePoolsDetailed(
      provider,
      0,
      Math.max(
        resolvedConfig.universeTopN,
        resolvedConfig.activeTopN * 2,
      ),
      evidence.source.number,
      {
        admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
        identityBackend: pinnedSource,
        identityBlockTag: evidence.source.number,
        strict: true,
      },
    ),
  ]);
  const sourcePools = mergePoolRegistries(
    mergePoolRegistries(
      protocol.projection.strategyViews.backrun,
      sourceFactoryPools,
    ),
    [...sourceActive.pools],
  );
  const sourceViews = buildViews(sourcePools);
  const [sourceBackrunBuild, sourceBlockscanBuild] = await Promise.all([
    buildTokenGraphWithResults(pinnedSource, sourceViews.backrun),
    buildTokenGraphWithResults(pinnedSource, sourceViews.blockscan),
  ]);
  assert.equal(
    sourceBackrunBuild.failed.length + sourceBlockscanBuild.failed.length,
    0,
    "production-full N graph projection has retryable pool failures",
  );
  const sourceGraphTokens = [...new Set([
    ...fullDexUniverseTokens,
    ...protocolCandidateAddressesFromDexGraph(
      sourceBackrunBuild.edges,
      sourceBlockscanBuild.edges,
    ),
  ])].sort();
  const sourceCandidateAddresses = [...new Set([
    ...sourceGraphTokens,
    ...protocolDiscoveryCandidateAddressHints(
      PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes(),
    ),
  ])].sort();
  const sourceProtocol = await prepareActiveProtocolDiscoveryPass({
    provider,
    adapters: PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes(),
    identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
    protocolEdgesEnabled:
      resolvedConfig.protocolEdgesEnabled,
    chainId: 1,
    currentOwnership: protocol.projection.ownership,
    currentBackrunPools: sourceViews.backrun,
    currentBackrunGraph: sourceBackrunBuild.edges,
    currentBlockscanGraph: sourceBlockscanBuild.edges,
    currentKnownPoolKeys: new Set(sourceViews.backrun.map(poolRegistryKey)),
    buildStrategyViews: (pools) => buildViews(pools),
    blockNumber: evidence.source.number,
    fromBlock: evidence.source.number,
    graphTokens: sourceGraphTokens,
    candidateAddresses: sourceCandidateAddresses,
    evidenceCache: protocolCacheInput.cache,
    bootstrapCandidates: cachedProtocolCandidates(protocolCacheInput.cache),
    probeExecutor: resolvedConfig.probeExecutor,
    shadow: resolvedConfig.protocolDiscoveryShadow,
  });
  assert(sourceProtocol.projection, "production-full N protocol projection missing");
  assert(
    sourceProtocol.scanner.sourceComplete &&
      sourceProtocol.result.evaluationComplete,
    "production-full N protocol discovery is incomplete",
  );
  const sourceEdges = Object.freeze([
    ...(sourceProtocol.projection.blockscanGraph ?? sourceBlockscanBuild.edges),
  ]);
  const sourceGraph = fullGraph(
    sourceEdges,
    2,
    evidence.source.number,
    evidence.source.hash,
    graphSourceFingerprint,
  );
  assert.equal(
    sourceGraph.orderedEdgeHash,
    baseGraph.orderedEdgeHash,
    "selected conversion block changes production ordered edges",
  );
  assert.equal(
    sourceGraph.metadataHash,
    baseGraph.metadataHash,
    "selected conversion block changes production edge metadata",
  );
  assert.equal(
    sourceGraph.ownershipHash,
    baseGraph.ownershipHash,
    "selected conversion block changes production family ownership",
  );
  assert.equal(
    sourceGraph.edges.length,
    baseGraph.edges.length,
    "selected conversion block changes production edge count",
  );
  const backend = new JsonRpcBlockScanStateReadBackend(input.rpcUrl, {
    maxBatchSize: 500,
    maxConcurrentBatches: 4,
  });
  const stateDeadlineMs = input.stateDeadlineMs ?? 600_000;
  const coordinator = new BlockScanStateCoordinator(backend, {
    // The full historical snapshot is built before the blind-run timing
    // boundary. Preserve semantic completeness instead of applying the live
    // per-family latency budget to a remote archive transport.
    familyTimeoutMs: stateDeadlineMs,
  });
  const basePrepared = await coordinator.prepare({
    graph: baseGraph,
    families: PRODUCTION_ADAPTER_FAMILIES.blockScanStateFamilies(),
    requiresPricing: (edge) =>
      PRODUCTION_ADAPTER_FAMILIES.isBlockScanPricedEdge(edge),
    deadlineAtMs: Date.now() + stateDeadlineMs,
  });
  assert.equal(
    basePrepared.status,
    "complete",
    `production-full base state is not complete: ${basePrepared.issues[0]?.message ?? "unknown"}`,
  );
  assert(basePrepared.snapshot);
  const sourcePrepared = await coordinator.prepare({
    graph: sourceGraph,
    families: PRODUCTION_ADAPTER_FAMILIES.blockScanStateFamilies(),
    requiresPricing: (edge) =>
      PRODUCTION_ADAPTER_FAMILIES.isBlockScanPricedEdge(edge),
    deadlineAtMs: Date.now() + stateDeadlineMs,
  });
  assert.equal(
    sourcePrepared.status,
    "complete",
    `production-full source state is not complete: ${sourcePrepared.issues[0]?.message ?? "unknown"}`,
  );
  assert(sourcePrepared.snapshot);
  assertCompletePricingCoverage(basePrepared.snapshot, "base");
  assertCompletePricingCoverage(sourcePrepared.snapshot, "source");
  const base = conversionRuntimeFromPricing(basePrepared.snapshot, "complete");
  const source = conversionRuntimeFromPricing(sourcePrepared.snapshot, "complete");
  const scannerConfig = {
    ...resolvedConfig.scanner,
    budgetMs:
      input.scanBudgetMs ??
      resolvedConfig.scanner.budgetMs,
    pricedTokens: productionPricedTokens(),
  };
  assert.equal(
    scannerConfig.budgetMs,
    resolvedConfig.scanner.budgetMs,
    "production-full freshness may not relax the live scanner deadline",
  );
  await Promise.all([
    assertCanonicalHeader(provider, evidence.base),
    assertCanonicalHeader(provider, evidence.source),
  ]);
  const graphArtifactSha256 = conversionProductionGraphArtifactSha256(base);
  const attemptNonce = randomBytes(32).toString("hex");
  // Blind producer seal boundary: capture sees the full runtimes and resolved
  // production config only. No selected family/state/edge/rate descriptor has
  // been matched yet.
  const producerCapture = captureConversionProductionEvidenceWithProducer({
    delivery: {
      attemptNonce,
      baseDeliveryId: conversionProductionDeliveryId({
        attemptNonce,
        phase: "base",
        blockHash: evidence.base.hash,
      }),
      sourceDeliveryId: conversionProductionDeliveryId({
        attemptNonce,
        phase: "source",
        blockHash: evidence.source.hash,
      }),
      graphScope: "production-full",
      graphArtifactSha256,
    },
    base,
    source,
    scannerConfig,
  });
  const sealed = producerCapture.sealed;

  // Trusted post-seal comparator work starts here.
  const targetEdges = baseGraph.edges.filter((edge) =>
    wstethAdapter.edgeAdapterIds.includes(edge.adapterId)
  );
  assert.equal(targetEdges.length, 2, "production-full graph lacks wstETH directions");
  assert.deepEqual(
    sourceGraph.edges
      .filter((edge) => wstethAdapter.edgeAdapterIds.includes(edge.adapterId))
      .map(blockScanEdgeKey),
    targetEdges.map(blockScanEdgeKey),
    "production-full source changed canonical wstETH edge identity",
  );
  const baseCandidateOracle = producerCapture.scanner.baseCandidates;
  const sourceCandidateOracle = producerCapture.scanner.sourceCandidates;
  const sourceWithoutTargetUpdate = conversionRuntimeWithTargetMidsRestored({
    source,
    base,
    targetEdges,
  });
  const sourceWithoutTargetUpdateScan = scanConversionProductionCandidateOracle(
    sourceWithoutTargetUpdate,
    scannerConfig,
  );
  const sourceWithoutTargetUpdateCandidateOracle =
    sourceWithoutTargetUpdateScan.candidates;
  const targetStateKeys = [...source.pricing.stateByStateKey.entries()]
    .filter(([, state]) => state.familyId === wstethAdapter.id)
    .map(([stateKey]) => stateKey);
  assert.equal(targetStateKeys.length, 1, "production-full wstETH state partition");
  const comparison = compareConversionProductionEvidence({
    reveal: input.reveal,
    sealed,
    expectation: {
      selectedCandidateId: selected.id,
      selectedEvidenceSha256: selected.evidenceSha256,
      graphArtifactSha256,
      scannerConfigSha256:
        conversionProductionScannerConfigSha256(scannerConfig),
      sourceWithoutTargetUpdateOutcome:
        sourceWithoutTargetUpdateScan.outcome,
      targetStateKey: targetStateKeys[0],
      edgeRateBindings: targetEdges.map((edge) => {
        const rateReadId = edge.adapterId === "wsteth-wrap"
          ? "get-wsteth-by-steth"
          : "get-steth-by-wsteth";
        const descriptor = input.predicate.rateReads.find(
          (read) => read.id === rateReadId,
        );
        assert(descriptor, `conversion predicate lacks ${rateReadId}`);
        return {
          edgeKey: blockScanEdgeKey(edge),
          rateReadId,
          amountInRaw: BigInt(`0x${descriptor.data.slice(-64)}`).toString(),
        };
      }),
      candidateOracle: {
        base: baseCandidateOracle,
        source: sourceCandidateOracle,
        sourceWithoutTargetUpdate:
          sourceWithoutTargetUpdateCandidateOracle,
      },
    },
  });
  const targetKeys = new Set(targetEdges.map(blockScanEdgeKey));
  const targetRanks = (
    candidates: readonly ConversionCandidateRankOracleEntry[],
  ): readonly number[] => Object.freeze(
    candidates
      .filter((candidate) =>
        candidate.edgeKeys.some((edgeKey) => targetKeys.has(edgeKey))
      )
      .map((candidate) => candidate.rank),
  );
  // Catch any mutation or replacement of the frozen files while the run was
  // consuming them. Their content is part of the public pre-reveal plan.
  validateConversionProductionInputs(
    input.productionInputs,
    input.reveal.plan.productionInputsSha256,
  );
  return Object.freeze({
    comparison,
    sealed,
    graph: Object.freeze({
      scope: "production-full" as const,
      universePools: rawUniverse.length,
      universeSha256: universeCoverage.contentSha256,
      universeManifestSha256,
      productionInputsSha256: input.reveal.plan.productionInputsSha256,
      resolvedConfigSha256: sha256Canonical(
        resolvedConfig,
      ),
      runtimePools: protocol.projection.strategyViews.blockscan.length,
      edges: baseGraph.edges.length,
      artifactSha256: graphArtifactSha256,
      graphBuildFailures,
      identityRejections,
      protocolCacheSha256: protocolCacheInput.contentSha256,
      protocolAdmissions: protocol.result.wouldAdmit.length,
    }),
    scanner: Object.freeze({
      baseCandidates: baseCandidateOracle,
      sourceCandidates: sourceCandidateOracle,
      sourceWithoutTargetUpdateCandidates:
        sourceWithoutTargetUpdateCandidateOracle,
      baseSetSha256: sha256Canonical(baseCandidateOracle),
      sourceSetSha256: sha256Canonical(sourceCandidateOracle),
      sourceWithoutTargetUpdateSetSha256: sha256Canonical(
        sourceWithoutTargetUpdateCandidateOracle,
      ),
      targetBaseRanks: targetRanks(baseCandidateOracle),
      targetSourceRanks: targetRanks(sourceCandidateOracle),
      targetSourceWithoutUpdateRanks: targetRanks(
        sourceWithoutTargetUpdateCandidateOracle,
      ),
    }),
  });
}

function fullGraph(
  edges: readonly TokenEdge[],
  generation: number,
  block: number,
  hash: string,
  sourceFingerprint: string,
) {
  const families = [...new Set(edges.map((edge) =>
    PRODUCTION_ADAPTER_FAMILIES.routes().forEdge(edge.adapterId).id
  ))].sort();
  return createVerifiedGraphView({
    id: `conversion-freshness-production-full:${sourceFingerprint}`,
    generation,
    sourceBlock: block,
    sourceBlockHash: hash,
    completenessWatermark: block,
    perSourceCoverage: families.map((familyId) => ({
      familyId,
      sourceId: "frozen-production-full-inputs",
      sourceFingerprint,
      completeThroughBlock: block,
      completeThroughHash: hash,
    })),
    edges,
    familyIdForEdge: (edge) =>
      PRODUCTION_ADAPTER_FAMILIES.routes().forEdge(edge.adapterId).id,
  });
}

async function prepareProtocolDiscoveryCacheAtBase(input: {
  readonly provider: ethers.JsonRpcProvider;
  readonly config: ConversionProductionFullResolvedConfig;
  readonly base: {
    readonly number: number;
    readonly hash: string;
  };
}): Promise<{
  readonly cache: ProtocolDiscoveryEvidenceCache;
  readonly ownership: ProtocolDiscoveryOwnership;
  readonly range: { readonly fromBlock: number; readonly toBlock: number };
  readonly contentSha256: string;
}> {
  const contentSha256 = existsSync(input.config.protocolDiscoveryCachePath)
    ? createHash("sha256")
      .update(readFileSync(input.config.protocolDiscoveryCachePath))
      .digest("hex")
    : sha256Canonical(null);
  const cache = loadProtocolDiscoveryEvidenceCache(
    input.config.protocolDiscoveryCachePath,
    1,
  );
  for (const entry of cache.addressEntries.values()) {
    assert(
      entry.checkedAtBlock <= input.base.number,
      "protocol discovery cache contains post-base address evidence",
    );
  }
  for (const block of cache.runtime.recentProcessedTxs.values()) {
    assert(
      block <= input.base.number,
      "protocol discovery cache contains post-base observed evidence",
    );
  }
  const enabledAdapters = PRODUCTION_ADAPTER_FAMILIES
    .discoverableRoutes()
    .filter((adapter) =>
      !adapter.requiresProtocolEdgesFlag ||
      input.config.protocolEdgesEnabled
    );
  const observedSourceFingerprint = `0x${createHash("sha256")
    .update("family-source-contiguous-v3-hash-anchored")
    .update(":")
    .update(protocolObservedSourceFingerprint(enabledAdapters))
    .digest("hex")}`;
  const sourceRegistryChanged = updateProtocolObservedSourceFingerprint(
    cache,
    observedSourceFingerprint,
    protocolDiscoverySourceFingerprints(enabledAdapters),
  );
  const observedFamilyIds = new Set(
    enabledAdapters
      .filter((adapter) =>
        adapter.discovery?.candidateSources.includes("observed-interaction")
      )
      .map((adapter) => adapter.id),
  );
  const cursor = cache.runtime.observedCursor;
  if (cursor !== null) {
    const cursorHeader = cursor <= input.base.number
      ? await input.provider.getBlock(cursor)
      : null;
    if (
      !cursorHeader?.hash ||
      !protocolObservedCursorAnchorMatches(
        cache,
        cursor,
        cursorHeader.hash,
      )
    ) {
      invalidateProtocolObservedHistory(cache, observedFamilyIds);
    }
  }
  const startup = planDiscoveryStartup({
    targetBlock: input.base.number,
    persistedCursor: cache.runtime.observedCursor,
    sourceRegistryChanged:
      sourceRegistryChanged || cache.runtime.observedCursor === null,
    recentBlocks: input.config.protocolDiscoveryLookbackBlocks,
    maxCatchupBlocks: input.config.protocolDiscoveryMaxCatchupBlocks,
    bootstrapMode: "contiguous",
  });
  assert.equal(
    startup.mode,
    "contiguous",
    "production-full protocol cache lacks contiguous history",
  );
  assert.equal(
    startup.range.toBlock,
    input.base.number,
    "production-full protocol cache cannot catch up through selected N-1 in one pass",
  );
  const ownership: ProtocolDiscoveryOwnership = {
    version: cache.routeOwnership.version,
    admissions: new Map(
      cache.routeOwnership.admissions.map((item) => [
        protocolInstanceKey(item.adapterId, item.instance.pool),
        {
          adapterId: item.adapterId,
          instance: item.instance,
          edges: [],
          claims: [],
        },
      ]),
    ),
  };
  return Object.freeze({
    cache,
    ownership,
    range: startup.range,
    contentSha256,
  });
}

function productionPricedTokens() {
  return new Map([
    [ADDR.WETH.toLowerCase(), { maxBorrow: 2_000n * 10n ** 18n }],
    [ADDR.USDC.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
    [ADDR.USDT.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
    [ADDR.DAI.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 18n }],
  ]);
}

function assertCompletePricingCoverage(
  snapshot: BlockScanStateSnapshot,
  label: "base" | "source",
): void {
  const coverage = snapshot.coverage;
  assert.equal(
    coverage.unresolvedStateKeys.length,
    0,
    `production-full ${label} has unresolved state keys`,
  );
  assert.equal(
    coverage.unresolvedReadKeys.length,
    0,
    `production-full ${label} has unresolved read keys`,
  );
  assert.equal(
    coverage.unresolvedEdgeKeys.length,
    0,
    `production-full ${label} has unresolved edge keys`,
  );
  assert.equal(
    snapshot.incompleteFamilyIds.length,
    0,
    `production-full ${label} has incomplete pricing families`,
  );
  assert.deepEqual(
    [...coverage.resolvedStateKeys].sort(),
    [...coverage.expectedStateKeys].sort(),
    `production-full ${label} state coverage is not exact`,
  );
  assert.deepEqual(
    [...coverage.resolvedReadKeys].sort(),
    [...coverage.expectedReadKeys].sort(),
    `production-full ${label} read coverage is not exact`,
  );
  assert.deepEqual(
    [...new Set([
      ...coverage.resolvedEdgeKeys,
      ...coverage.unavailableEdgeKeys,
    ])].sort(),
    [...coverage.expectedEdgeKeys].sort(),
    `production-full ${label} edge terminals are not exact`,
  );
}

function parseForceIncludeList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) =>
      /^0x[0-9a-fA-F]{64}$/.test(entry)
        ? entry.toLowerCase()
        : ethers.getAddress(entry)
    );
}

function nonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function positiveInteger(value: string, name: string): number {
  const parsed = nonnegativeInteger(value, name);
  if (parsed === 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function finiteNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be finite`);
  }
  return parsed;
}

async function assertCanonicalHeader(
  provider: ethers.JsonRpcProvider,
  expected: {
    readonly number: number;
    readonly hash: string;
    readonly stateRoot: string;
  },
): Promise<void> {
  const observed = await provider.getBlock(expected.number);
  assert(observed?.hash, `missing canonical header ${expected.number}`);
  assert.equal(
    observed.hash.toLowerCase(),
    expected.hash.toLowerCase(),
    `canonical hash changed at ${expected.number}`,
  );
  assert(
    observed.stateRoot,
    `missing canonical state root ${expected.number}`,
  );
  assert.equal(
    observed.stateRoot.toLowerCase(),
    expected.stateRoot.toLowerCase(),
    `canonical state root changed at ${expected.number}`,
  );
}

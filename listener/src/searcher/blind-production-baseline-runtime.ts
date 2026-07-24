import { createInterface } from "node:readline";
import type { BlockScanOpportunity } from "./detector/detector.js";
import type {
  NaturalBlockScanSelectionProvenance,
  ProtocolMid,
} from "./detector/blockscan-scanner.js";
import type { PoolEntry, TokenEdge } from "./planner/token-graph.js";
import type { PoolStateCache } from "./solver/pool-state-cache.js";
import type { RouteAdapterRegistry } from "./venues/route-adapter-registry.js";
import {
  blindProductionAuditHash,
  blindProductionCalldataSha256,
  blindProductionDeepSeal,
  BLIND_PRODUCTION_CONTROL_PREFIX,
  BLIND_PRODUCTION_RAW_PROFILE,
  BLIND_PRODUCTION_STAGE_NAMES,
  sealBlindProductionStageArtifact,
  validateBlindProductionControl,
  type BlindProductionGraphEvidence,
  type BlindProductionOpportunityEvidence,
  type BlindProductionPassRecord,
  type BlindProductionPrepareControl,
  type BlindProductionPricingCoverageEvidence,
  type BlindProductionSourceHeadControl,
  type BlindProductionStageEvidence,
  type BlindProductionStageSealInput,
} from "./blind-production-audit.js";
import {
  blindProductionArtifactFileSha256,
  blindProductionArtifactPayloadHash,
  blindProductionArtifactReceipt,
  createBlindProductionArtifact,
  type BlindProductionArtifact,
  type BlindProductionArtifactReceipts,
} from "./blind-production-artifacts.js";
import {
  normalizeBlindArtifactValue,
} from "./blind-production-sanitize.js";

export type BlindBaselineStageName =
  BlindProductionStageEvidence["name"];

export interface BlindBaselinePricingCoverage {
  readonly expectedStateKeys: readonly string[];
  readonly resolvedStateKeys: readonly string[];
  readonly expectedPricedEdgeIds: readonly string[];
  readonly resolvedPricedEdgeIds: readonly string[];
  readonly incompleteFamilyIds: readonly string[];
}

export interface BlindBaselinePreparedArtifacts {
  readonly baseAnchor: BlindProductionPrepareControl["base"];
  readonly baseGraph: BlindProductionArtifact<"base-graph-view">;
  readonly baseOrderedEdgeIds: readonly string[];
  readonly receipts: Omit<BlindProductionArtifactReceipts, "sourceDelta">;
  readonly documents: {
    readonly resolvedConfig: BlindProductionArtifact<"resolved-config">;
    readonly universe: BlindProductionArtifact<"production-universe">;
    readonly activeFamilyManifest:
      BlindProductionArtifact<"active-family-manifest">;
    readonly baseGraphView: BlindProductionArtifact<"base-graph-view">;
  };
}

export interface MutableBlindOpportunityEvidence {
  rank: number;
  route: BlindProductionOpportunityEvidence["route"];
  refined: boolean;
  planCount: number;
  simulation: {
    executed: boolean;
    success: boolean;
    profitRaw: string;
    gasUsed: string;
    calldataSha256: string;
    standingPosition: boolean;
  };
  ev: {
    executionStatus: "pass" | "not_run";
    decision: "allow" | "reject";
    reason: string;
  };
}

export interface BlindBaselineUnrunSelectionProvenance {
  readonly kind: "coarse_selection_not_run";
  readonly selectionMode: "production";
  readonly forcedSelectionCount: 0;
  readonly eligibleCandidateCount: 0;
  readonly selectedCandidateCount: 0;
  readonly maxCandidates: number;
}

export type BlindBaselineSelectionProvenance =
  | NaturalBlockScanSelectionProvenance
  | BlindBaselineUnrunSelectionProvenance;

export interface BlindBaselineLegacyRouteEdge {
  readonly edgeAdapterId: string;
  readonly poolAdapters: readonly string[];
  readonly slotKind: string;
  readonly reason: string;
}

export function createBlindBaselineStaticArtifacts(input: {
  readonly effectiveConfig: Readonly<Record<string, unknown>>;
  readonly productionPools: readonly PoolEntry[];
  readonly configuredUniverseContentSha256: string;
  readonly universeGeneratedAt: string | null;
  readonly selectedUniverse: readonly PoolEntry[];
  readonly strategyViewVersion: string;
  readonly registry: RouteAdapterRegistry;
  readonly legacyRouteEdges?: readonly BlindBaselineLegacyRouteEdge[];
}): {
  readonly resolvedConfig: BlindProductionArtifact<"resolved-config">;
  readonly universe: BlindProductionArtifact<"production-universe">;
  readonly activeFamilyManifest:
    BlindProductionArtifact<"active-family-manifest">;
} {
  const resolvedConfig = createBlindProductionArtifact(
    "resolved-config",
    {
      configLoaderFingerprint: blindProductionAuditHash({
        loader: "main.buildConfig",
        phase: "post-load",
        schema: 1,
      }),
      effectiveConfig: input.effectiveConfig,
      effectiveConfigSha256:
        blindProductionArtifactPayloadHash(input.effectiveConfig),
    },
  );
  const normalizePool = (pool: PoolEntry): unknown =>
    normalizeBlindArtifactValue({
      ...pool,
      address: pool.address.toLowerCase(),
      token0: pool.token0?.toLowerCase() ?? null,
      token1: pool.token1?.toLowerCase() ?? null,
      fixedTokenIn: pool.fixedTokenIn?.toLowerCase() ?? null,
      fixedTokenOut: pool.fixedTokenOut?.toLowerCase() ?? null,
      currency0: pool.currency0?.toLowerCase() ?? null,
      currency1: pool.currency1?.toLowerCase() ?? null,
      receiptEmitters:
        pool.receiptEmitters?.map((address) => address.toLowerCase()) ?? [],
      underlyingCoins:
        pool.underlyingCoins?.map((address) => address.toLowerCase()) ?? [],
    });
  const universe = createBlindProductionArtifact(
    "production-universe",
    {
      builderFingerprint: blindProductionAuditHash({
        loader: "pool-universe.loadPoolUniverse+buildStrategyViews",
        schema: 1,
      }),
      contentSha256:
        blindProductionAuditHash(input.productionPools.map(normalizePool)),
      poolCount: input.productionPools.length,
      provenanceSha256: blindProductionAuditHash({
        configuredContent: input.configuredUniverseContentSha256,
        generatedAt: input.universeGeneratedAt,
        selectedUniverse: input.selectedUniverse.map(normalizePool),
        strategyViewVersion: input.strategyViewVersion,
      }),
    },
  );
  const registeredFamilies = [
    ...input.registry.swaps,
    ...input.registry.protocols,
    ...input.registry.compat,
  ]
    .map((family) => {
      const descriptor = normalizeBlindArtifactValue({
        id: family.id,
        kind: family.kind,
        poolAdapters: [...family.poolAdapters],
        edgeAdapterIds: [...family.edgeAdapterIds],
        actionAdapterIds: [...family.actionAdapterIds],
        requiresProtocolEdgesFlag: family.requiresProtocolEdgesFlag,
        warmKind: family.warm?.kind ?? null,
      });
      return {
        familyId: family.id,
        kind: family.kind,
        descriptorSha256: blindProductionAuditHash(descriptor),
      };
    });
  const legacyFamilies = (input.legacyRouteEdges ?? []).map((legacy) => ({
    familyId: `legacy:${legacy.edgeAdapterId}`,
    kind: "legacy-route",
    descriptorSha256: blindProductionAuditHash(
      normalizeBlindArtifactValue(legacy),
    ),
  }));
  const families = [...registeredFamilies, ...legacyFamilies]
    .sort((a, b) => a.familyId.localeCompare(b.familyId));
  const activeFamilyManifest = createBlindProductionArtifact(
    "active-family-manifest",
    {
      families,
      familyCount: families.length,
      registryFingerprint: blindProductionAuditHash(families),
    },
  );
  return Object.freeze({
    resolvedConfig,
    universe,
    activeFamilyManifest,
  });
}

export function createBlindBaselinePreparedArtifacts(input: {
  readonly base: BlindProductionPrepareControl["base"];
  readonly edges: readonly TokenEdge[];
  readonly resolvedConfig: BlindProductionArtifact<"resolved-config">;
  readonly universe: BlindProductionArtifact<"production-universe">;
  readonly activeFamilyManifest:
    BlindProductionArtifact<"active-family-manifest">;
  readonly registry: RouteAdapterRegistry;
}): BlindBaselinePreparedArtifacts {
  const baseGraph = createBlindBaselineGraphArtifact({
    kind: "base-graph-view",
    anchor: input.base,
    edges: input.edges,
    registry: input.registry,
  });
  return Object.freeze({
    baseAnchor: Object.freeze({ ...input.base }),
    baseGraph,
    baseOrderedEdgeIds: input.edges.map(blindBaselineCanonicalEdgeId),
    receipts: {
      resolvedConfig: blindProductionArtifactReceipt(input.resolvedConfig),
      universe: blindProductionArtifactReceipt(input.universe),
      activeFamilyManifest:
        blindProductionArtifactReceipt(input.activeFamilyManifest),
      baseGraphView: blindProductionArtifactReceipt(baseGraph),
    },
    documents: {
      resolvedConfig: input.resolvedConfig,
      universe: input.universe,
      activeFamilyManifest: input.activeFamilyManifest,
      baseGraphView: baseGraph,
    },
  });
}

export function createBlindBaselineSourceDelta(input: {
  readonly source: BlindProductionSourceHeadControl["source"];
  readonly edges: readonly TokenEdge[];
  readonly base: BlindBaselinePreparedArtifacts;
  readonly registry: RouteAdapterRegistry;
}): BlindProductionArtifact<"source-delta"> {
  const currentIds = input.edges.map(blindBaselineCanonicalEdgeId);
  const prior = new Set(input.base.baseOrderedEdgeIds);
  const current = new Set(currentIds);
  const added = [...current].filter((edgeId) => !prior.has(edgeId)).sort();
  const removed = [...prior].filter((edgeId) => !current.has(edgeId)).sort();
  const payload = blindBaselineGraphPayload({
    anchor: input.source,
    coverageAnchor: input.base.baseAnchor,
    edges: input.edges,
    registry: input.registry,
  });
  return createBlindProductionArtifact(
    "source-delta",
    {
      ...payload,
      baseGraphViewSha256:
        blindProductionArtifactFileSha256(input.base.baseGraph),
      addedEdgeCount: added.length,
      addedEdgeHash: blindProductionAuditHash(added),
      removedEdgeCount: removed.length,
      removedEdgeHash: blindProductionAuditHash(removed),
    },
  );
}

export function blindBaselineCanonicalEdgeId(edge: TokenEdge): string {
  return `edge:${blindProductionAuditHash({
    adapterId: edge.adapterId,
    target: edge.target.toLowerCase(),
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
    slotKind: edge.slotKind,
    protocolAction: edge.protocolAction ?? null,
    edgeKind: edge.edgeKind,
    leavesStandingPosition: edge.leavesStandingPosition,
    curveI: edge.curveI ?? null,
    curveJ: edge.curveJ ?? null,
    poolToken0: edge.poolToken0?.toLowerCase() ?? null,
    poolToken1: edge.poolToken1?.toLowerCase() ?? null,
    poolId: edge.poolId?.toLowerCase() ?? null,
    nativeCurrency0: edge.nativeCurrency0 ?? false,
    nativeCurrency1: edge.nativeCurrency1 ?? false,
    v4PoolKey: edge.v4PoolKey
      ? {
          currency0: edge.v4PoolKey.currency0.toLowerCase(),
          currency1: edge.v4PoolKey.currency1.toLowerCase(),
          fee: edge.v4PoolKey.fee,
          tickSpacing: edge.v4PoolKey.tickSpacing,
          hooks: edge.v4PoolKey.hooks.toLowerCase(),
        }
      : null,
  })}`;
}

export function collectBlindBaselinePricingCoverage(input: {
  readonly edges: readonly TokenEdge[];
  readonly blockNumber: number;
  readonly cache: PoolStateCache;
  readonly protocolMids: ReadonlyMap<string, ProtocolMid>;
  readonly registry: RouteAdapterRegistry;
}): BlindBaselinePricingCoverage {
  const expectedStateKeys = new Set<string>();
  const resolvedStateKeys = new Set<string>();
  const expectedPricedEdgeIds = new Set<string>();
  const resolvedPricedEdgeIds = new Set<string>();
  const incompleteFamilyIds = new Set<string>();

  for (const edge of input.edges) {
    const owner = input.registry.routeLegs.findForEdge(edge.adapterId);
    const warm = owner?.warm;
    // Registered compatibility edges with no coarse-pricing capability are
    // intentionally absent from the block-scan pricing domain. Truly unowned
    // legacy edges (currently Fluid DEX) still require external-mid evidence.
    if (owner && !warm) continue;
    const familyId = blindBaselineFamilyId(edge, input.registry);
    const warmKind = warm?.kind ?? "legacy-mid";
    const stateKey = blindBaselineStateKey(edge, familyId, warmKind);
    const edgeId = blindBaselineCanonicalEdgeId(edge);
    expectedStateKeys.add(stateKey);
    expectedPricedEdgeIds.add(edgeId);
    const resolved = warm?.kind === "mutable-pool"
      ? warm.cache === "v2"
        ? input.cache.snapshotV2(edge.target, input.blockNumber) !== null
        : warm.cache === "v3"
          ? input.cache.snapshotV3(edge.target, input.blockNumber) !== null
          : input.cache.snapshotV4(
              edge.poolId ?? "",
              input.blockNumber,
            ) !== null
      : warm?.kind === "curve-pool"
        ? input.cache.snapshotCurve(edge.target, input.blockNumber) !== null
        : input.protocolMids.has(blindBaselineProtocolMidKey(edge));
    if (resolved) {
      resolvedStateKeys.add(stateKey);
      resolvedPricedEdgeIds.add(edgeId);
    } else {
      incompleteFamilyIds.add(familyId);
    }
  }

  return Object.freeze({
    expectedStateKeys: Object.freeze([...expectedStateKeys].sort()),
    resolvedStateKeys: Object.freeze([...resolvedStateKeys].sort()),
    expectedPricedEdgeIds:
      Object.freeze([...expectedPricedEdgeIds].sort()),
    resolvedPricedEdgeIds:
      Object.freeze([...resolvedPricedEdgeIds].sort()),
    incompleteFamilyIds: Object.freeze([...incompleteFamilyIds].sort()),
  });
}

export function createMutableBlindOpportunityEvidence(
  opportunity: BlockScanOpportunity,
  rank: number,
  registry: RouteAdapterRegistry,
  refined = true,
): MutableBlindOpportunityEvidence {
  return {
    rank,
    route: opportunity.seedEdges.map((edge) => ({
      familyId:
        blindBaselineFamilyId(edge, registry),
      adapterId: edge.adapterId,
      target: edge.target.toLowerCase(),
      tokenIn: edge.tokenIn.toLowerCase(),
      tokenOut: edge.tokenOut.toLowerCase(),
      executionVariantKey: blindBaselineCanonicalEdgeId(edge),
    })),
    refined,
    planCount: 0,
    simulation: {
      executed: false,
      success: false,
      profitRaw: "0",
      gasUsed: "0",
      calldataSha256: blindProductionCalldataSha256("0x"),
      standingPosition: opportunity.leavesStandingPosition,
    },
    ev: {
      executionStatus: "not_run",
      decision: "reject",
      reason: "not_evaluated",
    },
  };
}

export function createBlindBaselineUnrunSelectionProvenance(
  maxCandidates: number,
): BlindBaselineUnrunSelectionProvenance {
  return Object.freeze({
    kind: "coarse_selection_not_run",
    selectionMode: "production",
    forcedSelectionCount: 0,
    eligibleCandidateCount: 0,
    selectedCandidateCount: 0,
    maxCandidates,
  });
}

export function createBlindBaselineSemanticEvidence(input: {
  readonly graph: readonly TokenEdge[];
  readonly pricingCoverage: BlindBaselinePricingCoverage;
  readonly opportunities: readonly MutableBlindOpportunityEvidence[];
}): BlindProductionStageSealInput {
  const orderedEdgeIds = Object.freeze(
    input.graph.map(blindBaselineCanonicalEdgeId),
  );
  const graph: BlindProductionGraphEvidence = Object.freeze({
    orderedEdgeIds,
    orderedEdgeHash: blindProductionAuditHash(orderedEdgeIds),
  });
  const pricingCoverage: BlindProductionPricingCoverageEvidence =
    Object.freeze({
      expectedStateKeys:
        Object.freeze([...input.pricingCoverage.expectedStateKeys]),
      resolvedStateKeys:
        Object.freeze([...input.pricingCoverage.resolvedStateKeys]),
      expectedStateKeyHash: blindProductionAuditHash(
        input.pricingCoverage.expectedStateKeys,
      ),
      resolvedStateKeyHash: blindProductionAuditHash(
        input.pricingCoverage.resolvedStateKeys,
      ),
      expectedPricedEdgeIds:
        Object.freeze([...input.pricingCoverage.expectedPricedEdgeIds]),
      resolvedPricedEdgeIds:
        Object.freeze([...input.pricingCoverage.resolvedPricedEdgeIds]),
      expectedPricedEdgeHash: blindProductionAuditHash(
        input.pricingCoverage.expectedPricedEdgeIds,
      ),
      resolvedPricedEdgeHash: blindProductionAuditHash(
        input.pricingCoverage.resolvedPricedEdgeIds,
      ),
    });
  return Object.freeze({
    graph,
    pricingCoverage,
    opportunities: input.opportunities,
  });
}

export function appendBlindBaselineStageEvidence(input: {
  readonly stages: readonly BlindProductionStageEvidence[];
  readonly name: BlindBaselineStageName;
  readonly status: "pass" | "fail" | "not_run" | "bypassed";
  readonly cumulativeMs: number;
  readonly semanticEvidence: BlindProductionStageSealInput;
}): readonly BlindProductionStageEvidence[] {
  const expectedName =
    BLIND_PRODUCTION_STAGE_NAMES[input.stages.length];
  if (!expectedName || input.name !== expectedName) {
    throw new Error(
      `blind baseline stage order expected=${expectedName ?? "complete"} ` +
        `actual=${input.name}`,
    );
  }
  const previous = input.stages.at(-1);
  const priorCumulativeMs = previous?.cumulativeMs ?? 0;
  const cumulativeMs = Math.max(priorCumulativeMs, input.cumulativeMs);
  const sealed = sealBlindProductionStageArtifact(
    input.name,
    previous?.artifactSha256 ?? null,
    input.semanticEvidence,
  );
  const stage: BlindProductionStageEvidence = Object.freeze({
    name: input.name,
    status: input.status,
    artifact: sealed.artifact,
    artifactSha256: sealed.artifactSha256,
    stageMs: cumulativeMs - priorCumulativeMs,
    cumulativeMs,
  });
  return Object.freeze([...input.stages, stage]);
}

export function completeBlindBaselineStageEvidence(input: {
  readonly stages: readonly BlindProductionStageEvidence[];
  readonly cumulativeMs: number;
  readonly semanticEvidence: BlindProductionStageSealInput;
}): readonly BlindProductionStageEvidence[] {
  let stages = input.stages;
  while (stages.length < BLIND_PRODUCTION_STAGE_NAMES.length) {
    stages = appendBlindBaselineStageEvidence({
      stages,
      name: BLIND_PRODUCTION_STAGE_NAMES[stages.length]!,
      status: "not_run",
      cumulativeMs: input.cumulativeMs,
      semanticEvidence: input.semanticEvidence,
    });
  }
  return stages;
}

export function createBlindBaselinePassRecord(input: {
  readonly source: BlindProductionSourceHeadControl;
  readonly base: BlindProductionPrepareControl;
  readonly preparedArtifacts: BlindBaselinePreparedArtifacts;
  readonly sourceDeltaArtifact: BlindProductionArtifact<"source-delta">;
  readonly semanticEvidence: BlindProductionStageSealInput;
  readonly stages: readonly BlindProductionStageEvidence[];
  readonly selectionProvenance: BlindBaselineSelectionProvenance;
  readonly dynamicCacheGeneration: number;
  readonly dynamicCacheReset: boolean;
  readonly sourceDeltaApplied: boolean;
  readonly freshReadCount: number;
  readonly batchCount: number;
  readonly incompleteFamilyIds: readonly string[];
}): BlindProductionPassRecord {
  if (input.stages.length !== BLIND_PRODUCTION_STAGE_NAMES.length) {
    throw new Error("blind baseline pass requires six sealed stages");
  }
  for (let index = 0; index < input.stages.length; index += 1) {
    if (input.stages[index]!.name !== BLIND_PRODUCTION_STAGE_NAMES[index]) {
      throw new Error("blind baseline pass stage order");
    }
  }
  const semanticEvidence = blindProductionDeepSeal(input.semanticEvidence);
  if (
    !Number.isSafeInteger(
      input.selectionProvenance.forcedSelectionCount,
    ) ||
    input.selectionProvenance.forcedSelectionCount < 0 ||
    input.selectionProvenance.forcedSelectionCount >
      input.selectionProvenance.selectedCandidateCount ||
    input.selectionProvenance.selectedCandidateCount !==
      semanticEvidence.opportunities.length
  ) {
    throw new Error(
      "blind baseline coarse selection provenance count mismatch",
    );
  }
  return Object.freeze({
    type: "pass",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce: input.source.attemptNonce,
    base: input.base.base,
    source: input.source.source,
    artifacts: {
      ...input.preparedArtifacts.receipts,
      sourceDelta:
        blindProductionArtifactReceipt(input.sourceDeltaArtifact),
    },
    artifactDocuments: {
      ...input.preparedArtifacts.documents,
      sourceDelta: input.sourceDeltaArtifact,
    },
    selectionMode: input.selectionProvenance.selectionMode,
    forcedSelectionCount:
      input.selectionProvenance.forcedSelectionCount,
    stages: Object.freeze([...input.stages]),
    graph: semanticEvidence.graph,
    pricingCoverage: semanticEvidence.pricingCoverage,
    telemetry: {
      dynamicCacheGeneration: input.dynamicCacheGeneration,
      dynamicCacheReset: input.dynamicCacheReset,
      sourceDeltaApplied: input.sourceDeltaApplied,
      freshReadCount: input.freshReadCount,
      batchCount: input.batchCount,
      incompleteFamilyIds: Object.freeze([...input.incompleteFamilyIds]),
    },
    opportunities: semanticEvidence.opportunities,
  });
}

export function installBlindBaselineControlInput(input: {
  readonly stream: NodeJS.ReadableStream;
  readonly prepare:
    (control: BlindProductionPrepareControl) => Promise<void>;
  readonly sourceHead:
    (control: BlindProductionSourceHeadControl) => Promise<void>;
}): void {
  let queue: Promise<void> = Promise.resolve();
  createInterface({ input: input.stream }).on("line", (line) => {
    if (!line.startsWith(BLIND_PRODUCTION_CONTROL_PREFIX)) return;
    queue = queue
      .then(async () => {
        const control = validateBlindProductionControl(JSON.parse(
          line.slice(BLIND_PRODUCTION_CONTROL_PREFIX.length),
        ));
        if (control.type === "prepare") {
          await input.prepare(control);
        } else {
          await input.sourceHead(control);
        }
      })
      .catch((error) => {
        console.error(
          `[searcher/blind-audit] control failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
  });
}

function createBlindBaselineGraphArtifact(input: {
  readonly kind: "base-graph-view";
  readonly anchor: BlindProductionPrepareControl["base"];
  readonly edges: readonly TokenEdge[];
  readonly registry: RouteAdapterRegistry;
}): BlindProductionArtifact<"base-graph-view"> {
  return createBlindProductionArtifact(
    input.kind,
    blindBaselineGraphPayload(input),
  );
}

function blindBaselineGraphPayload(input: {
  readonly anchor:
    | BlindProductionPrepareControl["base"]
    | BlindProductionSourceHeadControl["source"];
  /**
   * Old production has no per-head topology publication. A source-N record
   * therefore remains honestly complete only through the prepared N-1 graph.
   */
  readonly coverageAnchor?:
    | BlindProductionPrepareControl["base"]
    | BlindProductionSourceHeadControl["source"];
  readonly edges: readonly TokenEdge[];
  readonly registry: RouteAdapterRegistry;
}): Readonly<Record<string, unknown>> {
  const coverageAnchor = input.coverageAnchor ?? input.anchor;
  const orderedEdgeIds = input.edges.map(blindBaselineCanonicalEdgeId);
  const normalizedEdges = input.edges.map((edge) =>
    normalizeBlindArtifactValue({
      canonicalEdgeId: blindBaselineCanonicalEdgeId(edge),
      ...edge,
    })
  );
  const ownership = input.edges.map((edge) => ({
    canonicalEdgeId: blindBaselineCanonicalEdgeId(edge),
    familyId:
      blindBaselineFamilyId(edge, input.registry),
  }));
  const perSourceCoverage = [{
    familyId: "legacy-production",
    sourceId: "resolved-production-graph",
    sourceFingerprint: blindProductionAuditHash({
      graph: orderedEdgeIds,
      schema: 1,
    }),
    completeThroughBlock: coverageAnchor.number,
    completeThroughHash: coverageAnchor.hash,
  }];
  return {
    anchorNumber: input.anchor.number,
    anchorHash: input.anchor.hash,
    completenessWatermark: coverageAnchor.number,
    edgeCount: input.edges.length,
    orderedEdgeHash: blindProductionAuditHash(orderedEdgeIds),
    orderedCanonicalEdgeIdHash: blindProductionAuditHash(orderedEdgeIds),
    metadataHash: blindProductionAuditHash(normalizedEdges),
    ownershipHash: blindProductionAuditHash(ownership),
    perSourceCoverage,
    perSourceCoverageSha256:
      blindProductionArtifactPayloadHash(perSourceCoverage),
  };
}

function blindBaselineStateKey(
  edge: TokenEdge,
  familyId: string,
  warmKind:
    | "mutable-pool"
    | "curve-pool"
    | "external-mid"
    | "protocol-mid"
    | "legacy-mid",
): string {
  const identity = warmKind === "mutable-pool" && edge.poolId
    ? edge.poolId.toLowerCase()
    : warmKind === "external-mid" ||
        warmKind === "protocol-mid" ||
        warmKind === "legacy-mid"
      ? blindBaselineProtocolMidKey(edge)
      : edge.target.toLowerCase();
  return `${familyId}:${warmKind}:${identity}`;
}

function blindBaselineFamilyId(
  edge: TokenEdge,
  registry: RouteAdapterRegistry,
): string {
  return registry.routeLegs.findForEdge(edge.adapterId)?.id ??
    `legacy:${edge.adapterId}`;
}

function blindBaselineProtocolMidKey(edge: TokenEdge): string {
  return [
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
  ].join(":");
}

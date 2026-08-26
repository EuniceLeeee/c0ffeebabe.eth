import type {
  PoolEntry,
  TokenEdge,
} from "./planner/token-graph.js";
import {
  blindProductionAuditHash,
  type BlindProductionOpportunityEvidence,
} from "./blind-production-audit.js";
import {
  blindProductionArtifactPayloadHash,
} from "./blind-production-artifacts.js";
import {
  normalizeBlindArtifactValue,
} from "./blind-production-sanitize.js";
import {
  PRODUCTION_STRICT_FAMILY_DECLARATIONS,
  type StrictRouteFamilyDeclaration,
} from "./strict-production-family-declarations.js";
import type {
  VerifiedGraphView,
} from "./venues/blockscan-state-capability.js";
import {
  blockScanEdgeKey,
} from "./venues/blockscan-state-capability.js";

interface BlindCompatibilityCoverageSource {
  readonly expectedStateKeys: readonly string[];
  readonly resolvedStateKeys: readonly string[];
  readonly expectedEdgeKeys: readonly string[];
  readonly resolvedEdgeKeys: readonly string[];
}

export interface BlindCompatibilityPricingCoverage {
  readonly expectedStateKeys: readonly string[];
  readonly resolvedStateKeys: readonly string[];
  readonly expectedEdgeKeys: readonly string[];
  readonly resolvedEdgeKeys: readonly string[];
}

export function blindCompatibilityCanonicalEdgeId(edge: TokenEdge): string {
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

/**
 * Project the richer family-line pool row into the exact PoolEntry vocabulary
 * frozen by T1. Production keeps discovery ownership, retained-topology and
 * execution-order metadata; the trusted cross-commit evidence must not treat
 * those post-T1 fields as a semantic universe change.
 */
export function blindCompatibilityPoolIdentity(pool: PoolEntry): unknown {
  const legacyUniverseFields = pool as PoolEntry & {
    readonly swapCount30d?: number;
    readonly lastSwapBlock?: number;
    readonly source?: string;
  };
  return normalizeBlindArtifactValue({
    address: pool.address.toLowerCase(),
    adapter: pool.adapter,
    receiptEmitters:
      pool.receiptEmitters?.map((address) => address.toLowerCase()) ?? [],
    venueId: pool.venueId,
    factory: pool.factory,
    identitySource: pool.identitySource,
    token0: pool.token0?.toLowerCase() ?? null,
    token1: pool.token1?.toLowerCase() ?? null,
    underlyingCoins:
      pool.underlyingCoins?.map((address) => address.toLowerCase()) ?? [],
    poolId: pool.poolId,
    currency0: pool.currency0?.toLowerCase() ?? null,
    currency1: pool.currency1?.toLowerCase() ?? null,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks,
    fixedTokenIn: pool.fixedTokenIn?.toLowerCase() ?? null,
    fixedTokenOut: pool.fixedTokenOut?.toLowerCase() ?? null,
    fixedSlotKind: pool.fixedSlotKind,
    fixedProtocolAction: pool.fixedProtocolAction,
    nonStandardRedeem: pool.nonStandardRedeem,
    redeemTokenOut: pool.redeemTokenOut,
    score: pool.score,
    logicalInstanceId: pool.logicalInstanceId,
    verifiedRoutes: pool.verifiedRoutes?.map((route) => ({
      edgeAdapterId: route.edgeAdapterId,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      slotKind: route.slotKind,
      protocolAction: route.protocolAction,
    })),
    swapCount30d: legacyUniverseFields.swapCount30d,
    lastSwapBlock: legacyUniverseFields.lastSwapBlock,
    source: legacyUniverseFields.source,
  });
}

export function blindCompatibilityFamilyId(edge: TokenEdge): string {
  try {
    return PRODUCTION_STRICT_FAMILY_DECLARATIONS.familyIdForEdge(
      edge.adapterId,
    );
  } catch {
    throw new Error(
      `blind T1 compatibility has no family owner for ${edge.adapterId}`,
    );
  }
}

export function blindCompatibilityRouteStep(
  edge: TokenEdge,
): BlindProductionOpportunityEvidence["route"][number] {
  return Object.freeze({
    familyId: blindCompatibilityFamilyId(edge),
    adapterId: edge.adapterId,
    target: edge.target.toLowerCase(),
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
    executionVariantKey: blindCompatibilityCanonicalEdgeId(edge),
  });
}

export function blindCompatibilityGraphArtifactPayload(
  graph: VerifiedGraphView,
  coverageAnchor: {
    readonly number: number;
    readonly hash: string;
  } = {
    number: graph.sourceBlock,
    hash: graph.sourceBlockHash,
  },
): Readonly<Record<string, unknown>> {
  const orderedEdgeIds = graph.edges.map(blindCompatibilityCanonicalEdgeId);
  const normalizedEdges = graph.edges.map((edge) =>
    normalizeBlindArtifactValue(t1EdgeMetadata(edge))
  );
  const ownership = graph.edges.map((edge) => ({
    canonicalEdgeId: blindCompatibilityCanonicalEdgeId(edge),
    familyId: blindCompatibilityFamilyId(edge),
  }));
  const perSourceCoverage = [{
    familyId: "strict-catalog",
    sourceId: "strict-ready-graph",
    sourceFingerprint: blindProductionAuditHash({
      graph: orderedEdgeIds,
      schema: 1,
    }),
    completeThroughBlock: coverageAnchor.number,
    completeThroughHash: coverageAnchor.hash.toLowerCase(),
  }];
  return {
    anchorNumber: graph.sourceBlock,
    anchorHash: graph.sourceBlockHash,
    completenessWatermark: coverageAnchor.number,
    edgeCount: graph.edges.length,
    orderedEdgeHash: blindProductionAuditHash(orderedEdgeIds),
    orderedCanonicalEdgeIdHash: blindProductionAuditHash(orderedEdgeIds),
    metadataHash: blindProductionAuditHash(normalizedEdges),
    ownershipHash: blindProductionAuditHash(ownership),
    perSourceCoverage,
    perSourceCoverageSha256:
      blindProductionArtifactPayloadHash(perSourceCoverage),
  };
}

export function blindCompatibilityActiveFamilyManifestPayload(
  families: readonly StrictRouteFamilyDeclaration[],
): Readonly<Record<string, unknown>> {
  const projected = families.map((family) => {
    const descriptor = normalizeBlindArtifactValue({
      id: family.id,
      kind: family.kind,
      poolAdapters: [...family.poolAdapters],
      edgeAdapterIds: [...family.edgeAdapterIds],
      actionAdapterIds: [
        ...family.ownedActionAdapterIds,
        ...family.requiredInfraActionAdapterIds,
      ],
      allowedTaxonomy: [...family.allowedTaxonomy],
      candidateSources: [...family.candidateSources],
      requiresProtocolEdgesFlag: family.requiresProtocolEdgesFlag,
    });
    return {
      familyId: family.id,
      kind: family.kind,
      descriptorSha256: blindProductionAuditHash(descriptor),
    };
  }).sort((a, b) => a.familyId.localeCompare(b.familyId));
  return Object.freeze({
    families: Object.freeze(projected),
    familyCount: projected.length,
    registryFingerprint: blindProductionAuditHash(projected),
  });
}

export function blindCompatibilityPricingCoverage(
  graph: VerifiedGraphView,
  source: BlindCompatibilityCoverageSource,
): BlindCompatibilityPricingCoverage {
  const expectedCurrent = new Set(source.expectedEdgeKeys);
  const resolvedCurrent = new Set(source.resolvedEdgeKeys);
  const expectedStateKeys = new Set(source.expectedStateKeys);
  const resolvedStateKeys = new Set(source.resolvedStateKeys);
  const unexpectedResolvedEdges = [...resolvedCurrent]
    .filter((edgeKey) => !expectedCurrent.has(edgeKey));
  const unexpectedResolvedStates = [...resolvedStateKeys]
    .filter((stateKey) => !expectedStateKeys.has(stateKey));
  if (
    unexpectedResolvedEdges.length > 0 ||
    unexpectedResolvedStates.length > 0
  ) {
    throw new Error(
      "blind strict pricing coverage resolved keys outside expected set " +
        [...unexpectedResolvedEdges, ...unexpectedResolvedStates].join(","),
    );
  }
  const edgesByKey = new Map(graph.edges.map((edge) => [
    blockScanEdgeKey(edge),
    edge,
  ] as const));
  const unknown = [...new Set([...expectedCurrent, ...resolvedCurrent])]
    .filter((edgeKey) => !edgesByKey.has(edgeKey));
  if (unknown.length > 0) {
    throw new Error(
      "blind T1 compatibility cannot project priced edges " +
        unknown.join(","),
    );
  }
  const projectEdgeKeys = (keys: ReadonlySet<string>): readonly string[] =>
    Object.freeze([...keys].map((edgeKey) =>
      blindCompatibilityCanonicalEdgeId(edgesByKey.get(edgeKey)!)
    ).sort());
  return Object.freeze({
    expectedStateKeys: Object.freeze([...expectedStateKeys].sort()),
    resolvedStateKeys: Object.freeze([...resolvedStateKeys].sort()),
    expectedEdgeKeys: projectEdgeKeys(expectedCurrent),
    resolvedEdgeKeys: projectEdgeKeys(resolvedCurrent),
  });
}

function t1EdgeMetadata(edge: TokenEdge): Readonly<Record<string, unknown>> {
  return {
    canonicalEdgeId: blindCompatibilityCanonicalEdgeId(edge),
    adapterId: edge.adapterId,
    target: edge.target,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    slotKind: edge.slotKind,
    protocolAction: edge.protocolAction,
    edgeKind: edge.edgeKind,
    leavesStandingPosition: edge.leavesStandingPosition,
    curveI: edge.curveI,
    curveJ: edge.curveJ,
    poolToken0: edge.poolToken0,
    poolToken1: edge.poolToken1,
    score: edge.score,
    v4PoolKey: edge.v4PoolKey,
    poolId: edge.poolId,
    nativeCurrency0: edge.nativeCurrency0,
    nativeCurrency1: edge.nativeCurrency1,
  };
}

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

type BlindBaselineWarmKind =
  | "mutable-pool"
  | "curve-pool"
  | "external-mid"
  | "protocol-mid"
  | "legacy-mid";

interface BlindCompatibilityCoverageSource {
  readonly expectedEdgeKeys: readonly string[];
  readonly resolvedEdgeKeys: readonly string[];
}

export interface BlindCompatibilityPricingCoverage {
  readonly expectedStateKeys: readonly string[];
  readonly resolvedStateKeys: readonly string[];
  readonly expectedEdgeKeys: readonly string[];
  readonly resolvedEdgeKeys: readonly string[];
}

interface BlindCompatibilityFamilyDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly poolAdapters: readonly string[];
  readonly edgeAdapterIds: readonly string[];
  readonly actionAdapterIds: readonly string[];
  readonly requiresProtocolEdgesFlag: boolean;
  readonly warmKind: BlindBaselineWarmKind | null;
}

type BlindRouteFamily = StrictRouteFamilyDeclaration;

/**
 * T0/T1 were deliberately frozen before the family-line implementation.
 * Their blind comparator therefore has one immutable semantic vocabulary.
 *
 * Production keeps the richer family/instance IDs. Only the evidence emitted
 * to that frozen comparator is projected through these functions. Changing
 * this vocabulary would silently invalidate the trusted baseline, so a future
 * acceptance generation must freeze a new T0 instead of editing this bridge.
 *
 * The frozen vocabulary lives as sealed data in
 * generated/blind-t1-baseline.generated.json (emitted by the dev/CI tool
 * build-blind-t1-baseline.ts, which is outside the production import
 * closure). This module only consumes it; it holds no literal per-family
 * driver tables (§0.1).
 */
import blindT1Baseline from "./generated/blind-t1-baseline.generated.json";

const t1RegisteredIds: readonly string[] = Object.freeze([
  ...blindT1Baseline.registeredRouteFamilyIds,
]);
const t1CurrentIds: readonly string[] = Object.freeze([
  ...blindT1Baseline.currentRouteFamilyIds,
]);
const t1WarmKindByFamily: ReadonlyMap<string, BlindBaselineWarmKind | null> =
  new Map(
    Object.entries(blindT1Baseline.warmKindByFamily) as [
      string,
      BlindBaselineWarmKind | null,
    ][],
  );
const t1MergeGroups: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(blindT1Baseline.mergeGroups),
);

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
    familyId: "legacy-production",
    sourceId: "resolved-production-graph",
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
  const byId = new Map(families.map((family) => [family.id, family] as const));
  const actualIds = [...byId.keys()].sort();
  const expectedIds = [...t1CurrentIds].sort();
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error(
      "blind T1 compatibility route inventory changed; freeze a new trusted " +
        `acceptance generation expected=${expectedIds.join(",")} ` +
        `actual=${actualIds.join(",")}`,
    );
  }

  const registered = t1RegisteredIds.map((familyId) => {
    const descriptor = t1RegisteredFamilyDescriptor(familyId, byId);
    return {
      familyId: descriptor.id,
      kind: descriptor.kind,
      descriptorSha256: blindProductionAuditHash(
        normalizeBlindArtifactValue(descriptor),
      ),
    };
  });
  const projected = [...registered]
    .sort((a, b) => a.familyId.localeCompare(b.familyId));
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
  const mappedCurrent = new Set<string>();
  const expectedStateKeys = new Set<string>();
  const resolvedStateKeys = new Set<string>();
  const expectedEdgeKeys = new Set<string>();
  const resolvedEdgeKeys = new Set<string>();

  for (const edge of graph.edges) {
    const currentFamilyId = currentFamilyIdForEdge(edge);
    const warmKind = t1WarmKindByFamily.get(currentFamilyId);
    if (warmKind === undefined) {
      throw new Error(
        `blind T1 compatibility lacks warm semantics for ${currentFamilyId}`,
      );
    }
    if (warmKind === null) continue;
    const currentEdgeKey = blockScanEdgeKey(edge);
    mappedCurrent.add(currentEdgeKey);
    const baselineEdgeId = blindCompatibilityCanonicalEdgeId(edge);
    const baselineFamilyId = blindCompatibilityFamilyId(edge);
    const baselineStateKey = t1StateKey(
      edge,
      baselineFamilyId,
      warmKind,
    );
    expectedEdgeKeys.add(baselineEdgeId);
    expectedStateKeys.add(baselineStateKey);
    if (
      expectedCurrent.has(currentEdgeKey) &&
      resolvedCurrent.has(currentEdgeKey)
    ) {
      resolvedEdgeKeys.add(baselineEdgeId);
      resolvedStateKeys.add(baselineStateKey);
    }
  }

  const unknownExpected = [...expectedCurrent]
    .filter((edgeKey) => !mappedCurrent.has(edgeKey));
  if (unknownExpected.length > 0) {
    throw new Error(
      "blind T1 compatibility cannot project priced edges " +
        unknownExpected.join(","),
    );
  }
  return Object.freeze({
    expectedStateKeys: Object.freeze([...expectedStateKeys].sort()),
    resolvedStateKeys: Object.freeze([...resolvedStateKeys].sort()),
    expectedEdgeKeys: Object.freeze([...expectedEdgeKeys].sort()),
    resolvedEdgeKeys: Object.freeze([...resolvedEdgeKeys].sort()),
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

function currentFamilyIdForEdge(edge: TokenEdge): string {
  try {
    return PRODUCTION_STRICT_FAMILY_DECLARATIONS.familyIdForEdge(
      edge.adapterId,
    );
  } catch {
    throw new Error(
      `blind T1 compatibility has no current family for ${edge.adapterId}`,
    );
  }
}

function t1StateKey(
  edge: TokenEdge,
  familyId: string,
  warmKind: BlindBaselineWarmKind,
): string {
  const identity = warmKind === "mutable-pool" && edge.poolId
    ? edge.poolId.toLowerCase()
    : warmKind === "external-mid" ||
        warmKind === "protocol-mid" ||
        warmKind === "legacy-mid"
      ? [
          edge.target.toLowerCase(),
          edge.tokenIn.toLowerCase(),
          edge.tokenOut.toLowerCase(),
        ].join(":")
      : edge.target.toLowerCase();
  return `${familyId}:${warmKind}:${identity}`;
}

function t1RegisteredFamilyDescriptor(
  familyId: string,
  byId: ReadonlyMap<string, BlindRouteFamily>,
): BlindCompatibilityFamilyDescriptor {
  const family = requiredFamily(byId, familyId);
  const warmKind = t1WarmKindByFamily.get(family.id);
  if (warmKind === undefined || warmKind === null) {
    throw new Error(`blind T1 compatibility missing warm kind for ${family.id}`);
  }
  // T1 merge groups fold extra families into the registered family's
  // descriptor (frozen baseline semantics, declared in the sealed artifact).
  const merged = (t1MergeGroups.get(familyId) ?? []).map((id) =>
    requiredFamily(byId, id),
  );
  return {
    id: family.id,
    kind: family.kind,
    poolAdapters: Object.freeze([...family.poolAdapters]),
    edgeAdapterIds: Object.freeze([
      ...family.edgeAdapterIds,
      ...merged.flatMap((m) => [...m.edgeAdapterIds]),
    ]),
    actionAdapterIds: Object.freeze([
      ...family.ownedActionAdapterIds,
      ...merged.flatMap((m) => [...m.ownedActionAdapterIds]),
      ...family.requiredInfraActionAdapterIds,
    ]),
    requiresProtocolEdgesFlag: family.requiresProtocolEdgesFlag,
    warmKind,
  };
}

function requiredFamily(
  byId: ReadonlyMap<string, BlindRouteFamily>,
  familyId: string,
): BlindRouteFamily {
  const family = byId.get(familyId);
  if (!family) {
    throw new Error(`blind T1 compatibility missing family ${familyId}`);
  }
  return family;
}

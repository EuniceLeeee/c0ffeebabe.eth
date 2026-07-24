import type { TokenEdge } from "./planner/token-graph.js";
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
import type { AdapterFamily } from "./venues/route-leg-adapter.js";
import type {
  VerifiedGraphView,
} from "./venues/blockscan-state-capability.js";
import {
  blockScanEdgeKey,
} from "./venues/blockscan-state-capability.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
} from "./venues/production-registry.js";

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

type BlindRouteFamily = Exclude<
  AdapterFamily,
  { readonly kind: "flash-loan" }
>;

/**
 * T0/T1 were deliberately frozen before the family-line implementation.
 * Their blind comparator therefore has one immutable semantic vocabulary.
 *
 * Production keeps the richer family/instance IDs. Only the evidence emitted
 * to that frozen comparator is projected through these functions. Changing
 * this vocabulary would silently invalidate the trusted baseline, so a future
 * acceptance generation must freeze a new T0 instead of editing this bridge.
 */
const T1_REGISTERED_ROUTE_FAMILY_IDS = Object.freeze([
  "univ2-standard",
  "univ3-standard",
  "curve-plain",
  "curve-underlying",
  "balancer-v3",
  "univ4",
  "custom-swap:dodo-v2",
  "protocol:erc4626",
  "protocol:goldx",
  "protocol:metronome-synth",
  "protocol:metronome-hgusdc",
  "protocol:psm",
  "protocol:eigenpie",
  "protocol:rocksolid",
  "protocol:wsteth",
] as const);

const T1_CURRENT_ROUTE_FAMILY_IDS = Object.freeze([
  ...T1_REGISTERED_ROUTE_FAMILY_IDS,
  "protocol:erc4626-silo-redeem",
  "fluid-dex",
  "credit:fluid",
] as const);

const T1_WARM_KIND_BY_FAMILY = Object.freeze(
  new Map<string, BlindBaselineWarmKind | null>([
    ["univ2-standard", "mutable-pool"],
    ["univ3-standard", "mutable-pool"],
    ["curve-plain", "curve-pool"],
    ["curve-underlying", "external-mid"],
    ["balancer-v3", "external-mid"],
    ["univ4", "mutable-pool"],
    ["custom-swap:dodo-v2", "external-mid"],
    ["fluid-dex", "legacy-mid"],
    ["protocol:erc4626", "protocol-mid"],
    ["protocol:erc4626-silo-redeem", "protocol-mid"],
    ["protocol:goldx", "protocol-mid"],
    ["protocol:metronome-synth", "protocol-mid"],
    ["protocol:metronome-hgusdc", "protocol-mid"],
    ["protocol:psm", "protocol-mid"],
    ["protocol:eigenpie", "protocol-mid"],
    ["protocol:rocksolid", "protocol-mid"],
    ["protocol:wsteth", "protocol-mid"],
    ["credit:fluid", null],
  ]),
);

const T1_FLUID_LEGACY_DESCRIPTOR = Object.freeze({
  edgeAdapterId: "fluid-dex-swap",
  poolAdapters: Object.freeze(["fluid-dex"]),
  slotKind: "swap",
  reason: "legacy Fluid DEX route; RouteAdapter migration is fixture-blocked",
});

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

export function blindCompatibilityFamilyId(edge: TokenEdge): string {
  const current = PRODUCTION_ADAPTER_FAMILIES.routes()
    .findForEdge(edge.adapterId)?.id;
  if (!current) {
    throw new Error(
      `blind T1 compatibility has no family owner for ${edge.adapterId}`,
    );
  }
  if (current === "fluid-dex") return "legacy:fluid-dex-swap";
  if (current === "credit:fluid") return "compat:fluid-credit";
  if (current === "protocol:erc4626-silo-redeem") {
    return "protocol:erc4626";
  }
  return current;
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
  families: readonly AdapterFamily[],
): Readonly<Record<string, unknown>> {
  const routes = families.filter(
    (family): family is BlindRouteFamily => "poolAdapters" in family,
  );
  const byId = new Map(routes.map((family) => [family.id, family] as const));
  const actualIds = [...byId.keys()].sort();
  const expectedIds = [...T1_CURRENT_ROUTE_FAMILY_IDS].sort();
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

  const registered = T1_REGISTERED_ROUTE_FAMILY_IDS.map((familyId) => {
    const descriptor = t1RegisteredFamilyDescriptor(familyId, byId);
    return {
      familyId: descriptor.id,
      kind: descriptor.kind,
      descriptorSha256: blindProductionAuditHash(
        normalizeBlindArtifactValue(descriptor),
      ),
    };
  });
  const legacy = {
    familyId: "legacy:fluid-dex-swap",
    kind: "legacy-route",
    descriptorSha256: blindProductionAuditHash(
      normalizeBlindArtifactValue(T1_FLUID_LEGACY_DESCRIPTOR),
    ),
  };
  const projected = [...registered, t1FluidCreditDescriptor(byId), legacy]
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
    const warmKind = T1_WARM_KIND_BY_FAMILY.get(currentFamilyId);
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
  const familyId = PRODUCTION_ADAPTER_FAMILIES.routes()
    .findForEdge(edge.adapterId)?.id;
  if (!familyId) {
    throw new Error(
      `blind T1 compatibility has no current family for ${edge.adapterId}`,
    );
  }
  return familyId;
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
  familyId: typeof T1_REGISTERED_ROUTE_FAMILY_IDS[number],
  byId: ReadonlyMap<string, BlindRouteFamily>,
): BlindCompatibilityFamilyDescriptor {
  const family = requiredFamily(byId, familyId);
  const warmKind = T1_WARM_KIND_BY_FAMILY.get(family.id);
  if (warmKind === undefined || warmKind === null) {
    throw new Error(`blind T1 compatibility missing warm kind for ${family.id}`);
  }
  if (familyId !== "protocol:erc4626") {
    return {
      id: family.id,
      kind: family.kind,
      poolAdapters: Object.freeze([...family.poolAdapters]),
      edgeAdapterIds: Object.freeze([...family.edgeAdapterIds]),
      actionAdapterIds: Object.freeze([
        ...family.ownedActionAdapterIds,
        ...family.requiredInfraActionAdapterIds,
      ]),
      requiresProtocolEdgesFlag: family.requiresProtocolEdgesFlag,
      warmKind,
    };
  }

  const silo = requiredFamily(byId, "protocol:erc4626-silo-redeem");
  return {
    id: family.id,
    kind: family.kind,
    poolAdapters: Object.freeze([...family.poolAdapters]),
    edgeAdapterIds: Object.freeze([
      ...family.edgeAdapterIds,
      ...silo.edgeAdapterIds,
    ]),
    actionAdapterIds: Object.freeze([
      ...family.ownedActionAdapterIds,
      ...silo.ownedActionAdapterIds,
      ...family.requiredInfraActionAdapterIds,
    ]),
    requiresProtocolEdgesFlag: family.requiresProtocolEdgesFlag,
    warmKind,
  };
}

function t1FluidCreditDescriptor(
  byId: ReadonlyMap<string, BlindRouteFamily>,
): {
  readonly familyId: string;
  readonly kind: string;
  readonly descriptorSha256: string;
} {
  const family = requiredFamily(byId, "credit:fluid");
  const descriptor: BlindCompatibilityFamilyDescriptor = {
    id: "compat:fluid-credit",
    kind: "compat",
    poolAdapters: Object.freeze([...family.poolAdapters]),
    edgeAdapterIds: Object.freeze([...family.edgeAdapterIds]),
    actionAdapterIds: Object.freeze([
      ...family.edgeAdapterIds,
      ...family.requiredInfraActionAdapterIds,
    ]),
    requiresProtocolEdgesFlag: family.requiresProtocolEdgesFlag,
    warmKind: null,
  };
  return {
    familyId: descriptor.id,
    kind: descriptor.kind,
    descriptorSha256: blindProductionAuditHash(
      normalizeBlindArtifactValue(descriptor),
    ),
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

import { createHash } from "node:crypto";
import type { TokenEdge } from "../../searcher/planner/token-graph.js";
import {
  blockScanEdgeMetadataFingerprint,
} from "../../searcher/venues/blockscan-state-capability.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../../searcher/venues/production-registry.js";
import type { SemanticJson } from "./semantic-six-step.js";

export interface CanonicalEdgeSetEvidence {
  readonly edgeCount: number;
  readonly sha256: string;
}

export interface CanonicalMaterializedGraphEvidence
  extends CanonicalEdgeSetEvidence {
  readonly scope: "all_materialized_edges";
  readonly familyEdges: readonly {
    readonly familyId: string;
    readonly edgeCount: number;
    readonly sha256: string;
  }[];
  readonly targetInjected: false;
  readonly graphReduced: false;
  readonly capMode: "production_config" | "diagnostic_override";
}

export interface FamilySourceCoverage {
  readonly familyId: string;
  readonly sourceId: string;
  readonly complete: boolean;
  readonly issues: readonly string[];
}

export interface CanonicalShardCompleteness {
  readonly schemaVersion: 1;
  readonly selection: "pending" | "selected";
  readonly dexShard: CanonicalShard;
  readonly familyShards: readonly CanonicalFamilyShard[];
  readonly requiredFamilyIds: readonly string[];
  readonly requiredComplete: boolean | null;
  readonly isolatedIncompleteFamilyIds: readonly string[];
  readonly cacheReuse: {
    readonly status: "not_measured";
    readonly claimedHit: false;
  };
}

interface CanonicalShard extends CanonicalEdgeSetEvidence {
  readonly shardId: string;
  readonly sourceKind:
    | "dex-universe"
    | "dynamic-discovery"
    | "registry-declared";
  readonly status: "complete" | "incomplete";
  readonly required: boolean;
  readonly issues: readonly string[];
}

interface CanonicalFamilyShard extends CanonicalShard {
  readonly familyId: string;
  readonly disposition:
    | "required"
    | "isolated_non_blocking"
    | "not_required";
  readonly sourceCoverage: readonly FamilySourceCoverage[];
}

export function canonicalEdgeEvidenceIdentity(
  edge: TokenEdge,
): string {
  return blockScanEdgeMetadataFingerprint(edge);
}

export function canonicalEdgeSetEvidence(
  edges: readonly TokenEdge[],
): CanonicalEdgeSetEvidence {
  const identities = edges.map(canonicalEdgeEvidenceIdentity).sort();
  return Object.freeze({
    edgeCount: identities.length,
    sha256: createHash("sha256")
      .update(JSON.stringify(identities))
      .digest("hex"),
  });
}

/**
 * Describe exactly the graph that was built. This is deliberately not a
 * topology-completeness claim: discovery completeness belongs to the
 * separately verified shard evidence.
 */
export function canonicalMaterializedGraphEvidence(
  edges: readonly TokenEdge[],
  familyIdForEdge: (edge: TokenEdge) => string,
  capMode:
    CanonicalMaterializedGraphEvidence["capMode"] = "production_config",
): CanonicalMaterializedGraphEvidence {
  const byFamily = new Map<string, TokenEdge[]>();
  for (const edge of edges) {
    const familyId = familyIdForEdge(edge);
    const familyEdges = byFamily.get(familyId) ?? [];
    familyEdges.push(edge);
    byFamily.set(familyId, familyEdges);
  }
  const graph = canonicalEdgeSetEvidence(edges);
  return Object.freeze({
    scope: "all_materialized_edges",
    ...graph,
    familyEdges: Object.freeze(
      [...byFamily]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([familyId, familyEdges]) => Object.freeze({
          familyId,
          ...canonicalEdgeSetEvidence(familyEdges),
        })),
    ),
    targetInjected: false,
    graphReduced: false,
    capMode,
  });
}

export function productionShardCompleteness(input: {
  readonly edges: readonly TokenEdge[];
  readonly familySourceCoverage: readonly FamilySourceCoverage[];
  readonly requiredFamilyIds: readonly string[] | null;
}): CanonicalShardCompleteness {
  const routes = PRODUCTION_ADAPTER_FAMILIES.routes();
  const required = new Set(input.requiredFamilyIds ?? []);
  const matureDex = new Set(
    PRODUCTION_ADAPTER_FAMILIES.swaps()
      .filter((family) => family.matureDexUniverseDiscovery)
      .map((family) => family.id),
  );
  const graph = canonicalMaterializedGraphEvidence(
    input.edges,
    (edge) => routes.forEdge(edge.adapterId).id,
  );
  const graphByFamily = new Map(
    graph.familyEdges.map((entry) => [entry.familyId, entry]),
  );
  const dex = canonicalEdgeSetEvidence(input.edges.filter((edge) =>
    matureDex.has(routes.forEdge(edge.adapterId).id)
  ));
  const dexIssues = dex.edgeCount === 0
    ? ["materialized DEX universe contains no executable edge"]
    : [];
  const familyShards = routes.list().map((family): CanonicalFamilyShard => {
    const edgeSet = graphByFamily.get(family.id) ??
      canonicalEdgeSetEvidence([]);
    const sourceCoverage = input.familySourceCoverage
      .filter((source) => source.familyId === family.id)
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const sourceKind = matureDex.has(family.id)
      ? "dex-universe"
      : family.discovery
        ? "dynamic-discovery"
        : "registry-declared";
    const issues = sourceKind === "dex-universe"
      ? dexIssues
      : sourceKind === "dynamic-discovery"
        ? discoveryIssues(sourceCoverage)
        : [];
    const status = issues.length === 0 ? "complete" : "incomplete";
    const isRequired = required.has(family.id);
    return {
      shardId: `family:${family.id}`,
      familyId: family.id,
      sourceKind,
      status,
      required: isRequired,
      disposition: isRequired
        ? "required"
        : status === "complete"
          ? "not_required"
          : "isolated_non_blocking",
      ...edgeSet,
      sourceCoverage,
      issues,
    };
  }).sort((a, b) => a.familyId.localeCompare(b.familyId));
  const selected = input.requiredFamilyIds !== null;
  return {
    schemaVersion: 1,
    selection: selected ? "selected" : "pending",
    dexShard: {
      shardId: "dex-universe",
      sourceKind: "dex-universe",
      status: dexIssues.length === 0 ? "complete" : "incomplete",
      required: true,
      ...dex,
      issues: dexIssues,
    },
    familyShards,
    requiredFamilyIds: [...required].sort(),
    requiredComplete: selected
      ? dexIssues.length === 0 &&
        [...required].every((familyId) =>
          familyShards.some((shard) =>
            shard.familyId === familyId && shard.status === "complete"
          )
        )
      : null,
    isolatedIncompleteFamilyIds: familyShards
      .filter((shard) => shard.disposition === "isolated_non_blocking")
      .map((shard) => shard.familyId),
    cacheReuse: { status: "not_measured", claimedHit: false },
  };
}

export function semanticMaterializedGraphEvidence(
  graph: CanonicalMaterializedGraphEvidence,
): Readonly<Record<string, SemanticJson>> {
  return snakeCaseJson(graph) as Readonly<Record<string, SemanticJson>>;
}

export function semanticShardCompletenessEvidence(
  proof: CanonicalShardCompleteness,
): Readonly<Record<string, SemanticJson>> {
  return snakeCaseJson(proof) as Readonly<Record<string, SemanticJson>>;
}

function discoveryIssues(
  coverage: readonly FamilySourceCoverage[],
): string[] {
  if (coverage.length === 0) {
    return ["dynamic family has no source-completeness proof"];
  }
  return coverage.flatMap((source) =>
    source.complete
      ? []
      : source.issues.length > 0
        ? source.issues.map((issue) => `${source.sourceId}: ${issue}`)
        : [`${source.sourceId}: incomplete without reason`]
  );
}

function snakeCaseJson(value: unknown): SemanticJson {
  if (value === null || typeof value === "string" ||
    typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(snakeCaseJson);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      snakeCaseJson(child),
    ]));
}

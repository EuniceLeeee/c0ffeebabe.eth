import type { TokenEdge } from "./planner/token-graph.js";
import type { ReadyUniverseGeneration } from
  "./universe-rebuild-checkpoint.js";
import {
  createVerifiedGraphView,
  type VerifiedGraphView,
} from "./venues/blockscan-state-capability.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";

interface CachedReadyTopology {
  readonly edges: readonly TokenEdge[];
  readonly orderedEdgeHash: string;
  readonly metadataHash: string;
  readonly ownershipHash: string;
  readonly scannerEdgeCount: number;
  readonly scannerEdgeKeyHash: string;
}

/**
 * Current-source shell for one immutable startup-ready topology.
 *
 * The ready envelope already proved Graph/catalog/source coverage atomically.
 * A producer generation may bind that exact edge set to a newer canonical
 * header for pricing, but it cannot use a registry, pool universe or landed
 * observation to add, remove or re-own an edge.
 */
export class StrictReadyGraphViewCoordinator {
  private readonly topologyKey: string;
  private readonly readyEdges: readonly TokenEdge[];
  private readonly coverageOwners: readonly {
    readonly familyId: string;
    readonly sourceId: string;
    readonly sourceFingerprint: string;
  }[];
  private cached: CachedReadyTopology | null = null;

  constructor(input: {
    readonly catalog: FamilyCapabilityCatalog;
    readonly ready: ReadyUniverseGeneration;
    readonly edges: readonly TokenEdge[];
  }) {
    if (input.edges.length === 0) {
      throw new Error("strict ready GraphView requires a non-empty ready Graph");
    }
    const readyEdgeIds = new Set<string>();
    for (const edge of input.edges) {
      if (
        typeof edge.canonicalEdgeId !== "string" ||
        edge.canonicalEdgeId.trim() === ""
      ) {
        throw new Error("strict ready Graph edge lacks canonicalEdgeId");
      }
      if (readyEdgeIds.has(edge.canonicalEdgeId)) {
        throw new Error(
          `strict ready Graph duplicates ${edge.canonicalEdgeId}`,
        );
      }
      readyEdgeIds.add(edge.canonicalEdgeId);
      input.catalog.ownerOfAction(edge.adapterId);
    }
    const coverageOwners = new Map<string, {
      readonly familyId: string;
      readonly sourceId: string;
      readonly sourceFingerprint: string;
    }>();
    for (const coverage of input.ready.sourceCoverage) {
      const key = `${coverage.familyId}\u0000${coverage.sourceId}`;
      coverageOwners.set(key, Object.freeze({
        familyId: coverage.familyId,
        sourceId: `strict-ready:${coverage.sourceId}`,
        sourceFingerprint: [
          "strict-ready-generation-v1",
          input.ready.generation,
          input.ready.graphHash,
          input.ready.catalogHash,
          coverage.familyId,
          coverage.sourceId,
        ].join(":"),
      }));
    }
    if (coverageOwners.size === 0) {
      throw new Error("strict ready GraphView requires source coverage");
    }
    this.topologyKey =
      `strict-ready:${input.ready.generation}:${input.ready.graphHash}`;
    this.readyEdges = Object.freeze([...input.edges]);
    this.coverageOwners = Object.freeze([...coverageOwners.values()]);
    this.catalog = input.catalog;
  }

  private readonly catalog: FamilyCapabilityCatalog;

  build(input: {
    readonly id: string;
    readonly topologyKey: string;
    readonly generation: number;
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
    readonly edges: readonly TokenEdge[];
  }): VerifiedGraphView {
    if (
      input.id.trim() === "" ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 0 ||
      !Number.isSafeInteger(input.sourceBlock) ||
      input.sourceBlock < 0 ||
      !/^0x[0-9a-fA-F]{64}$/.test(input.sourceBlockHash)
    ) {
      throw new Error("strict ready GraphView source shell is invalid");
    }
    if (input.topologyKey !== this.topologyKey) {
      throw new Error(
        `strict ready topology key mismatch ${input.topologyKey}`,
      );
    }
    if (
      input.edges.length !== this.readyEdges.length ||
      input.edges.some((edge, index) => edge !== this.readyEdges[index])
    ) {
      throw new Error("strict producer Graph differs from ready edge objects");
    }
    const perSourceCoverage = Object.freeze(this.coverageOwners.map(
      (coverage) => Object.freeze({
        ...coverage,
        completeThroughBlock: input.sourceBlock,
        completeThroughHash: input.sourceBlockHash,
      }),
    ));
    if (this.cached === null) {
      const view = createVerifiedGraphView({
        id: input.id,
        generation: input.generation,
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
        completenessWatermark: input.sourceBlock,
        perSourceCoverage,
        edges: input.edges,
        familyIdForEdge: (edge) =>
          this.catalog.ownerOfAction(edge.adapterId),
      });
      const projectedIds = view.edges.map((edge) => edge.canonicalEdgeId);
      const readyIds = this.readyEdges.map((edge) => edge.canonicalEdgeId);
      if (
        projectedIds.length !== readyIds.length ||
        projectedIds.some((edgeId, index) => edgeId !== readyIds[index])
      ) {
        throw new Error(
          "strict catalog ownership changed a ready canonicalEdgeId",
        );
      }
      this.cached = Object.freeze({
        edges: view.edges,
        orderedEdgeHash: view.orderedEdgeHash,
        metadataHash: view.metadataHash,
        ownershipHash: view.ownershipHash,
        scannerEdgeCount: view.scannerEdgeCount,
        scannerEdgeKeyHash: view.scannerEdgeKeyHash,
      });
      return view;
    }
    return Object.freeze({
      id: input.id,
      generation: input.generation,
      sourceBlock: input.sourceBlock,
      sourceBlockHash: input.sourceBlockHash.toLowerCase(),
      completenessWatermark: input.sourceBlock,
      perSourceCoverage,
      ...this.cached,
    });
  }
}

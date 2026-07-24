import type { PoolEntry, TokenEdge } from "./planner/token-graph.js";
import type { LandedPoolDiscoveryCoverage } from "./venues/landed-pool-discovery.js";
import type { AdapterFamilyRegistry } from "./venues/adapter-family-registry.js";
import {
  createVerifiedGraphView,
  type VerifiedGraphView,
} from "./venues/blockscan-state-capability.js";
import {
  ProtocolDiscoveryCoverageCoordinator,
} from "./protocol-discovery-coordinator.js";

export interface BuildAdapterFamilyGraphViewInput {
  readonly id: string;
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly edges: readonly TokenEdge[];
  readonly dexSourceCompleteThrough: number;
  readonly retryablePools: readonly PoolEntry[];
  readonly dexUniverseFingerprint: string;
  readonly strategyViewHash: string;
  readonly landedCoverage: readonly LandedPoolDiscoveryCoverage[];
  readonly protocolSourceFingerprints: ReadonlyMap<string, string>;
  readonly protocolEdgesEnabled: boolean;
}

/**
 * Registry-derived discovery completeness → immutable GraphView publication.
 * The coordinator owns the family/source union and exact-set checks; main only
 * supplies the current source, graph and discovery results.
 */
export class AdapterFamilyGraphViewCoordinator {
  constructor(
    private readonly registry: AdapterFamilyRegistry,
    private readonly protocol: ProtocolDiscoveryCoverageCoordinator,
  ) {}

  build(input: BuildAdapterFamilyGraphViewInput): VerifiedGraphView {
    const zeroHash = `0x${"00".repeat(32)}`;
    const retryableFamilyIds = new Set(
      input.retryablePools.flatMap((pool) => {
        const owner = this.registry.routes().findForPool(pool.adapter);
        return owner ? [owner.id] : [];
      }),
    );
    const registryCoverage = this.registry
      .registryBackedDiscoveryFamilies(input.protocolEdgesEnabled)
      .map((family) => {
        const complete =
          input.dexSourceCompleteThrough >= input.sourceBlock &&
          !retryableFamilyIds.has(family.id);
        return Object.freeze({
          familyId: family.id,
          sourceId: "dex-universe-and-family-registry",
          sourceFingerprint:
            `${family.id}:${input.dexUniverseFingerprint}:` +
            input.strategyViewHash,
          completeThroughBlock: complete
            ? input.sourceBlock
            : Math.max(
                0,
                Math.min(
                  input.sourceBlock - 1,
                  input.dexSourceCompleteThrough,
                ),
              ),
          completeThroughHash: complete ? input.sourceBlockHash : zeroHash,
        });
      });

    const expectedLandedSources = new Set(
      this.registry.landedPoolDiscovery().list().flatMap(
        (descriptor) => descriptor.event.executionFamilies.map((familyId) =>
          `${familyId}\u001f${descriptor.sourceId}`
        ),
      ),
    );
    const consumedLandedSources = new Set(
      input.landedCoverage
        .filter((coverage) => coverage.consumed)
        .map((coverage) => `${coverage.familyId}\u001f${coverage.sourceId}`),
    );
    const missingLandedSources = [...expectedLandedSources].filter(
      (key) => !consumedLandedSources.has(key),
    );
    if (missingLandedSources.length > 0) {
      throw new Error(
        "DEX landed discovery omitted registered family/source descriptors: " +
          missingLandedSources.join(","),
      );
    }
    const landedCoverage = input.landedCoverage.map((coverage) => {
      const complete =
        coverage.consumed &&
        coverage.complete &&
        input.dexSourceCompleteThrough >= input.sourceBlock &&
        !retryableFamilyIds.has(coverage.familyId);
      return Object.freeze({
        familyId: coverage.familyId,
        sourceId: coverage.sourceId,
        sourceFingerprint:
          `${coverage.sourceFingerprint}:${input.strategyViewHash}`,
        completeThroughBlock: complete
          ? input.sourceBlock
          : Math.max(
              0,
              Math.min(
                input.sourceBlock - 1,
                input.dexSourceCompleteThrough,
              ),
            ),
        completeThroughHash: complete ? input.sourceBlockHash : zeroHash,
      });
    });
    const protocolCoverage = this.protocol.sourceCoverage({
      targetBlock: input.sourceBlock,
      sourceBlockHash: input.sourceBlockHash,
      sourceFingerprints: input.protocolSourceFingerprints,
      zeroHash,
    });
    const perSourceCoverage = Object.freeze([
      ...registryCoverage,
      ...landedCoverage,
      ...protocolCoverage,
    ]);
    const completenessWatermark = Math.min(
      ...perSourceCoverage.map((coverage) => coverage.completeThroughBlock),
    );
    return createVerifiedGraphView({
      id: input.id,
      generation: input.generation,
      sourceBlock: input.sourceBlock,
      sourceBlockHash: input.sourceBlockHash,
      completenessWatermark,
      perSourceCoverage,
      edges: Object.freeze([...input.edges]),
      familyIdForEdge: (edge) =>
        this.registry.routes().forEdge(edge.adapterId).id,
    });
  }
}

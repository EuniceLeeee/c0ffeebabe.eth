import type { AdapterRuntimeSnapshot } from "../adapter-runtime-coordinator.js";
import {
  blockScanEdgeKey,
  exactSetHash,
} from "../venues/blockscan-state-capability.js";
import {
  scanBlockStateFromResolvedMids,
  type BlockScanCoreConfig,
  type BlockScanOutcome,
} from "./blockscan-scanner-core.js";

export interface ProductionBlockScanInput {
  /**
   * The only production state input. Graph, prices and funding were published
   * together by AdapterRuntimeCoordinator for one canonical generation.
   */
  readonly runtime: AdapterRuntimeSnapshot;
  readonly swapTouched: Set<string> | null;
  readonly cfg: BlockScanCoreConfig;
}

export interface ProductionBlockScanOutcome extends BlockScanOutcome {
  readonly completeness: "complete" | "degraded";
  readonly incompleteFamilyIds: readonly string[];
  readonly selectionMode: "production";
  readonly forcedSelectionCount: number;
}

/**
 * Strict production boundary: callers cannot independently supply a graph,
 * cache, block number or partial mid map.
 */
export function detectProductionBlockScanOpportunities(
  input: ProductionBlockScanInput,
): ProductionBlockScanOutcome {
  assertAtomicRuntime(input.runtime);
  const resolvedEdgeKeys = new Set(
    input.runtime.pricing.coverage.resolvedEdgeKeys,
  );
  const outcome = scanBlockStateFromResolvedMids({
    edges: input.runtime.graph.edges.filter(
      (edge) => !scannerConsumesEdge(edge) ||
        resolvedEdgeKeys.has(blockScanEdgeKey(edge)),
    ),
    sourceBlock: input.runtime.sourceBlock,
    swapTouched: input.swapTouched,
    cfg: input.cfg,
    mids: input.runtime.pricing.mids,
  });
  return Object.freeze({
    ...outcome,
    completeness: input.runtime.completeness,
    incompleteFamilyIds: input.runtime.pricing.incompleteFamilyIds,
    selectionMode: "production" as const,
    forcedSelectionCount: outcome.selection.forcedSelectionCount,
  });
}

export function assertAtomicBlockScanRuntime(
  runtime: AdapterRuntimeSnapshot,
): void {
  assertAtomicRuntime(runtime);
}

function assertAtomicRuntime(runtime: AdapterRuntimeSnapshot): void {
  const { graph, pricing, funding } = runtime;
  assertEqualNumber("generation", [
    runtime.generation,
    graph.generation,
    pricing.generation,
    pricing.graph.generation,
    funding.generation,
  ]);
  assertEqualNumber("source block", [
    runtime.sourceBlock,
    graph.sourceBlock,
    pricing.sourceBlock,
    pricing.graph.sourceBlock,
    funding.sourceBlock,
  ]);
  assertEqualString("source block hash", [
    runtime.sourceBlockHash,
    graph.sourceBlockHash,
    pricing.sourceBlockHash,
    pricing.graph.sourceBlockHash,
    funding.sourceBlockHash,
  ]);
  assertEqualString("graph id", [graph.id, pricing.graph.id]);
  assertEqualString("graph edge hash", [
    graph.orderedEdgeHash,
    pricing.graph.orderedEdgeHash,
  ]);
  assertEqualString("graph metadata hash", [
    graph.metadataHash,
    pricing.graph.metadataHash,
  ]);
  assertEqualString("graph ownership hash", [
    graph.ownershipHash,
    pricing.graph.ownershipHash,
  ]);

  const coverage = pricing.coverage;
  assertCoverageIntegrity(
    "state keys",
    coverage.expectedStateKeys,
    coverage.resolvedStateKeys,
    coverage.unresolvedStateKeys,
    coverage.expectedStateKeyHash,
    coverage.resolvedStateKeyHash,
    coverage.unresolvedStateKeyHash,
  );
  assertCoverageIntegrity(
    "read keys",
    coverage.expectedReadKeys,
    coverage.resolvedReadKeys,
    coverage.unresolvedReadKeys,
    coverage.expectedReadKeyHash,
    coverage.resolvedReadKeyHash,
    coverage.unresolvedReadKeyHash,
  );
  assertCoverageIntegrity(
    "edge keys",
    coverage.expectedEdgeKeys,
    coverage.resolvedEdgeKeys,
    coverage.unresolvedEdgeKeys,
    coverage.expectedEdgeKeyHash,
    coverage.resolvedEdgeKeyHash,
    coverage.unresolvedEdgeKeyHash,
    coverage.unavailableEdgeKeys,
    coverage.unavailableEdgeKeyHash,
  );

  const expectedEdgeSet = new Set(coverage.expectedEdgeKeys);
  const resolvedEdgeSet = new Set(coverage.resolvedEdgeKeys);
  const unavailableEdgeSet = new Set(coverage.unavailableEdgeKeys);
  if (
    pricing.coverageByReadKey.size !== coverage.expectedReadKeys.length ||
    pricing.freshnessByReadKey.size !== coverage.resolvedReadKeys.length ||
    coverage.expectedReadKeys.some((readKey) => {
      const expectedStatus = coverage.resolvedReadKeys.includes(readKey)
        ? "resolved"
        : "unresolved";
      return pricing.coverageByReadKey.get(readKey)?.status !== expectedStatus;
    }) ||
    coverage.resolvedReadKeys.some(
      (readKey) => !pricing.freshnessByReadKey.has(readKey),
    )
  ) {
    throw new Error(
      "production scanner rejected incomplete read-key coverage/freshness",
    );
  }
  if (
    pricing.coverageByEdgeKey.size !== coverage.expectedEdgeKeys.length ||
    coverage.expectedEdgeKeys.some((edgeKey) => {
      const expectedStatus = resolvedEdgeSet.has(edgeKey)
        ? "resolved"
        : unavailableEdgeSet.has(edgeKey)
        ? "rejected"
        : "unresolved";
      const actual = pricing.coverageByEdgeKey.get(edgeKey);
      return actual?.status !== expectedStatus ||
        expectedStatus === "rejected" &&
          (actual?.status !== "rejected" || actual.reason.trim().length === 0);
    })
  ) {
    throw new Error(
      "production scanner rejected incomplete edge availability coverage",
    );
  }
  const midKeys = [...pricing.mids.keys()];
  if (
    exactSetHash(midKeys) !== coverage.resolvedEdgeKeyHash ||
    midKeys.length !== coverage.resolvedEdgeKeys.length
  ) {
    throw new Error(
      "production scanner rejected non-exact atomic mid coverage",
    );
  }
  const scannerEdgeKeys = graph.edges
    .filter(scannerConsumesEdge)
    .map(blockScanEdgeKey);
  if (
    scannerEdgeKeys.length !== expectedEdgeSet.size ||
    exactSetHash(scannerEdgeKeys) !== coverage.expectedEdgeKeyHash
  ) {
    const missing = scannerEdgeKeys.find((key) => !expectedEdgeSet.has(key));
    throw new Error(
      missing
        ? `production scanner missing current-N mid for ${missing}`
        : "production scanner pricing coverage does not exactly match its graph",
    );
  }
  if (runtime.completeness === "complete") {
    assertCompleteCoverage("state keys", coverage.unresolvedStateKeys);
    assertCompleteCoverage("read keys", coverage.unresolvedReadKeys);
    assertCompleteCoverage("edge keys", coverage.unresolvedEdgeKeys);
    if (pricing.incompleteFamilyIds.length > 0) {
      throw new Error("complete runtime contains incomplete pricing families");
    }
  } else if (
    pricing.incompleteFamilyIds.length === 0 &&
    funding.coverage.unresolvedKeys.length === 0
  ) {
    throw new Error("degraded runtime has no incomplete pricing family");
  }

  const fundingCoverage = funding.coverage;
  assertCoverageIntegrity(
    "funding keys",
    fundingCoverage.expectedKeys,
    fundingCoverage.resolvedKeys,
    fundingCoverage.unresolvedKeys,
    fundingCoverage.expectedHash,
    fundingCoverage.resolvedHash,
    fundingCoverage.unresolvedHash,
  );
  if (
    funding.coverageByFundingId.size !== fundingCoverage.expectedKeys.length ||
    funding.freshnessByFundingId.size !== fundingCoverage.resolvedKeys.length ||
    fundingCoverage.expectedKeys.some((fundingId) => {
      const expectedStatus = fundingCoverage.resolvedKeys.includes(fundingId)
        ? "resolved"
        : "unresolved";
      return funding.coverageByFundingId.get(fundingId)?.status !== expectedStatus;
    }) ||
    fundingCoverage.resolvedKeys.some(
      (fundingId) => !funding.freshnessByFundingId.has(fundingId),
    )
  ) {
    throw new Error("production scanner rejected funding coverage/freshness");
  }
  for (const source of funding.sources.values()) {
    if (
      !source.fundingId ||
      !fundingCoverage.resolvedKeys.includes(source.fundingId)
    ) {
      throw new Error("production scanner rejected unresolved funding source");
    }
  }
  if (runtime.completeness === "complete") {
    assertCompleteCoverage("funding keys", fundingCoverage.unresolvedKeys);
  }
}

function scannerConsumesEdge(edge: {
  readonly slotKind: string;
  readonly leavesStandingPosition: boolean;
}): boolean {
  return edge.slotKind === "swap" ||
    (edge.slotKind === "protocol" && !edge.leavesStandingPosition);
}

function assertCoverageIntegrity(
  label: string,
  expected: readonly string[],
  resolved: readonly string[],
  unresolved: readonly string[],
  expectedHash: string,
  resolvedHash: string,
  unresolvedHash: string,
  unavailable: readonly string[] = [],
  unavailableHash: string = exactSetHash([]),
): void {
  if (
    expected.length !== new Set(expected).size ||
    resolved.length !== new Set(resolved).size ||
    unresolved.length !== new Set(unresolved).size ||
    unavailable.length !== new Set(unavailable).size
  ) {
    throw new Error(`production scanner rejected duplicate ${label} coverage`);
  }
  if (
    exactSetHash(expected) !== expectedHash ||
    exactSetHash(resolved) !== resolvedHash ||
    exactSetHash(unresolved) !== unresolvedHash ||
    exactSetHash(unavailable) !== unavailableHash
  ) {
    throw new Error(`production scanner rejected invalid ${label} coverage hash`);
  }
  const resolvedSet = new Set(resolved);
  const unresolvedSet = new Set(unresolved);
  const unavailableSet = new Set(unavailable);
  if (
    resolved.some(
      (key) => unresolvedSet.has(key) || unavailableSet.has(key),
    ) ||
    unresolved.some((key) => unavailableSet.has(key)) ||
    expected.some(
      (key) =>
        !resolvedSet.has(key) &&
        !unresolvedSet.has(key) &&
        !unavailableSet.has(key),
    ) ||
    [...resolvedSet, ...unresolvedSet, ...unavailableSet].some(
      (key) => !expected.includes(key),
    )
  ) {
    throw new Error(`production scanner rejected non-partitioned ${label} coverage`);
  }
}

function assertCompleteCoverage(
  label: string,
  unresolved: readonly string[],
): void {
  if (unresolved.length > 0) {
    throw new Error(`production scanner rejected incomplete ${label} coverage`);
  }
}

function assertEqualNumber(label: string, values: readonly number[]): void {
  if (values.some((value) => value !== values[0])) {
    throw new Error(`production scanner ${label} mismatch: ${values.join(",")}`);
  }
}

function assertEqualString(label: string, values: readonly string[]): void {
  const normalized = values.map((value) => value.toLowerCase());
  if (normalized.some((value) => value !== normalized[0])) {
    throw new Error(`production scanner ${label} mismatch: ${values.join(",")}`);
  }
}

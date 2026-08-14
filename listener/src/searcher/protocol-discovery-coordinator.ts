import { emitEvent } from "./events.js";
import {
  advanceDiscoveryFamilySourceWatermarks,
  createDiscoveryFamilySourceWatermarks,
  discoveryFamilySourceKey,
  discoveryGraphCompleteThrough,
  discoverySourceCompleteThrough,
  seedDiscoverySourceWatermark,
  type DiscoveryFamilySources,
  type DiscoveryRange,
} from "./discovery-source-watermark.js";
import type {
  ProtocolDiscoveryEvent,
  ProtocolDiscoveryProjection,
  ProtocolDiscoveryResult,
} from "./protocol-instance-discovery.js";
import type { PoolEntry, TokenEdge } from "./planner/token-graph.js";
import type { AdapterFamilyRegistry } from "./venues/adapter-family-registry.js";
import {
  protocolCandidateAddressesFromDexGraph,
  protocolCandidateAddressesFromDexUniverse,
  protocolDiscoveryCandidateAddressHints,
} from "./protocol-discovery-runtime.js";

export interface ProtocolDiscoveryScannerCoverage {
  readonly eventSourceComplete: boolean;
  readonly addressSourceComplete: boolean;
  readonly sourceErrors: readonly {
    readonly sourceKind: string;
    readonly impactedFamilyIds: readonly string[];
    readonly retryable: boolean;
  }[];
}

export interface ProtocolDiscoverySourceCoverage {
  readonly familyId: string;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly completeThroughBlock: number;
  readonly completeThroughHash: string;
}

/**
 * Protocol discovery never runs inside the current-head DEX pass. The hot lane
 * publishes only DEX topology; observed/address work is prepared by the
 * independent background lane and becomes visible atomically later.
 */
export function protocolDiscoveryRangeForLane(input: {
  readonly mode: "hot" | "backfill";
  readonly observedRange: DiscoveryRange | null;
  readonly addressOnlyRetryRange: DiscoveryRange | null;
}): DiscoveryRange | null {
  return input.mode === "hot"
    ? null
    : input.observedRange ?? input.addressOnlyRetryRange;
}

/**
 * Owns family × source completeness. Runtime callers may stage a cloned
 * watermark map and publish it atomically, but they never need to know which
 * discovery sources a concrete family declares.
 */
export class ProtocolDiscoveryCoverageCoordinator {
  readonly families: readonly DiscoveryFamilySources[];
  private readonly watermarks: Map<string, number>;

  constructor(familySources: readonly DiscoveryFamilySources[]) {
    this.families = Object.freeze(familySources.map((family) =>
      Object.freeze({
        familyId: family.familyId,
        sourceIds: Object.freeze([
          ...new Set(family.sourceIds),
        ]),
      })
    ));
    this.watermarks = createDiscoveryFamilySourceWatermarks(this.families);
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.watermarks);
  }

  replace(next: ReadonlyMap<string, number>): void {
    this.watermarks.clear();
    for (const [key, value] of next) this.watermarks.set(key, value);
  }

  seedObserved(throughBlock: number): void {
    seedDiscoverySourceWatermark(
      this.watermarks,
      this.families,
      "observed-interaction",
      throughBlock,
    );
  }

  resetObserved(): void {
    for (const family of this.families) {
      if (!family.sourceIds.includes("observed-interaction")) continue;
      this.watermarks.set(
        discoveryFamilySourceKey(
          family.familyId,
          "observed-interaction",
        ),
        -1,
      );
    }
  }

  hasObservedSource(): boolean {
    return this.families.some((family) =>
      family.sourceIds.includes("observed-interaction")
    );
  }

  graphCompleteThrough(
    watermarks: ReadonlyMap<string, number> = this.watermarks,
  ): number {
    return discoveryGraphCompleteThrough(this.families, watermarks);
  }

  advance(input: {
    readonly current?: ReadonlyMap<string, number>;
    readonly range: DiscoveryRange;
    readonly scanner: ProtocolDiscoveryScannerCoverage;
    readonly result: ProtocolDiscoveryResult;
    readonly positiveOnlyObserved: boolean;
    readonly evaluationBlock: number;
  }): {
    readonly watermarks: ReadonlyMap<string, number>;
    readonly completedKeys: ReadonlySet<string>;
  } {
    const current = input.current ?? this.watermarks;
    const familySourceComplete = new Map(
      input.result.familySourceCoverage.map((coverage) => [
        discoveryFamilySourceKey(
          coverage.familyId,
          coverage.sourceId,
        ),
        coverage.complete,
      ]),
    );
    const familyComplete = new Map(
      this.families.map((family) => [
        family.familyId,
        family.sourceIds.every((sourceId) =>
          familySourceComplete.get(
            discoveryFamilySourceKey(family.familyId, sourceId),
          ) === true
        ),
      ]),
    );
    const sourceIssues = input.scanner.sourceErrors.map((issue) => ({
      sourceId: issue.sourceKind,
      impactedFamilyIds: issue.impactedFamilyIds,
      retryable: issue.retryable,
    }));
    const observed = advanceDiscoveryFamilySourceWatermarks({
      current,
      families: this.families,
      range: input.range,
      familyComplete,
      familySourceComplete,
      sourceComplete: new Map([
        ["observed-interaction", input.scanner.eventSourceComplete],
        ["dex-token-domain", false],
        ["canonical-registry", false],
      ]),
      sourceIssues: sourceIssues.filter((issue) =>
        issue.sourceId === "observed-interaction"
      ),
      contiguousSourceIds: new Set(["observed-interaction"]),
      ...(input.positiveOnlyObserved
        ? { positiveOnlySourceIds: new Set(["observed-interaction"]) }
        : {}),
    });
    const address = advanceDiscoveryFamilySourceWatermarks({
      current: observed.watermarks,
      families: this.families,
      // Address matchers enumerate one complete current-N snapshot. They do
      // not inherit the historical observed-log range endpoint.
      range: {
        fromBlock: input.evaluationBlock,
        toBlock: input.evaluationBlock,
      },
      familyComplete,
      familySourceComplete,
      sourceComplete: new Map([
        ["observed-interaction", false],
        ["dex-token-domain", input.scanner.addressSourceComplete],
        ["canonical-registry", false],
      ]),
      sourceIssues: sourceIssues.filter((issue) =>
        issue.sourceId === "dex-token-domain"
      ),
      contiguousSourceIds: new Set(["observed-interaction"]),
    });
    return Object.freeze({
      watermarks: new Map(address.watermarks),
      completedKeys: new Set([
        ...observed.completedKeys,
        ...address.completedKeys,
      ]),
    });
  }

  nextObservedCursor(input: {
    readonly currentCursor: number;
    readonly range: DiscoveryRange;
    readonly watermarks: ReadonlyMap<string, number>;
    readonly positiveOnlyObserved: boolean;
    readonly eventSourceComplete: boolean;
  }): number {
    if (!this.hasObservedSource()) {
      return input.currentCursor;
    }
    // This is operational ingestion progress, not negative/completeness
    // authority. The one bounded positive-only startup scan advances to the
    // live tip even when old traces were pruned; retained candidates are
    // re-attested separately and production must not start a genesis chase.
    // Incremental live scans, however, retain a failed range until every
    // receipt/trace read completed so a one-off observed-only candidate is not
    // silently skipped.
    if (!input.positiveOnlyObserved && !input.eventSourceComplete) {
      return input.currentCursor;
    }
    return Math.max(input.currentCursor, input.range.toBlock);
  }

  sourceCoverage(input: {
    readonly targetBlock: number;
    readonly sourceBlockHash: string;
    readonly sourceFingerprints: ReadonlyMap<string, string>;
    readonly zeroHash?: string;
    readonly watermarks?: ReadonlyMap<string, number>;
  }): readonly ProtocolDiscoverySourceCoverage[] {
    const watermarks = input.watermarks ?? this.watermarks;
    const zeroHash = input.zeroHash ?? `0x${"00".repeat(32)}`;
    return Object.freeze(this.families.flatMap(
      (family) => family.sourceIds.map((sourceId) => {
        const completeThrough =
          watermarks.get(
            discoveryFamilySourceKey(family.familyId, sourceId),
          ) ?? -1;
        const complete = completeThrough >= input.targetBlock;
        return Object.freeze({
          familyId: family.familyId,
          sourceId: `protocol-family-discovery:${sourceId}`,
          sourceFingerprint:
            `${input.sourceFingerprints.get(family.familyId) ??
              `${family.familyId}:missing-source-fingerprint`}:${sourceId}`,
          completeThroughBlock: complete
            ? input.targetBlock
            : Math.max(0, Math.min(input.targetBlock - 1, completeThrough)),
          completeThroughHash: complete ? input.sourceBlockHash : zeroHash,
        });
      }),
    ));
  }
}

/**
 * Immutable candidate-domain descriptor derived from the production registry
 * and the complete file-backed DEX universe. Runtime graph generations supply
 * only their current edges; they do not rebuild family/address policy.
 */
export class ProtocolDiscoveryCandidateDomain {
  private readonly universeTokens: readonly string[];
  private readonly addressHints: readonly string[];

  constructor(input: {
    readonly registry: AdapterFamilyRegistry;
    readonly dexUniverse: readonly PoolEntry[];
  }) {
    const dexPoolAdapters = new Set(
      input.registry.swaps().flatMap((adapter) => [...adapter.poolAdapters]),
    );
    this.universeTokens = Object.freeze(
      protocolCandidateAddressesFromDexUniverse(
        input.dexUniverse,
        dexPoolAdapters,
      ),
    );
    this.addressHints = Object.freeze(
      protocolDiscoveryCandidateAddressHints(
        input.registry.discoverableRoutes(),
      ),
    );
  }

  graphTokens(
    backrunGraph: readonly TokenEdge[],
    blockscanGraph: readonly TokenEdge[] | undefined,
  ): string[] {
    return [...new Set([
      ...this.universeTokens,
      ...protocolCandidateAddressesFromDexGraph(
        backrunGraph,
        blockscanGraph,
      ),
    ])];
  }

  addresses(
    backrunGraph: readonly TokenEdge[],
    blockscanGraph: readonly TokenEdge[] | undefined,
  ): string[] {
    return [...new Set([
      ...this.graphTokens(backrunGraph, blockscanGraph),
      ...this.addressHints,
    ])].sort();
  }
}

export function emitProtocolDiscoveryEvents(
  events: readonly ProtocolDiscoveryEvent[],
  mode: "shadow" | "active" | "observed",
  blockNumber: number,
): void {
  for (const event of events) {
    emitEvent({
      type: "protocol_discovery",
      adapter_id: event.adapterId,
      ...(event.target === null ? {} : { target: event.target }),
      selectors: [...event.selectors],
      sources: [...event.sources],
      verdict: event.verdict,
      stage: event.stage,
      ...(event.reason === null ? {} : { reason: event.reason }),
      edge_count: event.wouldAdmitEdges,
      mode,
      block_number: blockNumber,
    });
  }
}

export function emitStaticSuppressedProtocolEvents(
  projection: ProtocolDiscoveryProjection | null,
  mode: "shadow" | "active" | "observed",
  blockNumber: number,
): void {
  if (!projection) return;
  emitProtocolDiscoveryEvents(
    [
      ...projection.staticSuppressed.map((admission) => ({
        event: "protocol_discovery" as const,
        adapterId: admission.adapterId,
        target: admission.instance.pool.address,
        selectors: [...admission.instance.selectors],
        sources: [...admission.instance.sources],
        verdict: "rejected" as const,
        stage: "arbitration" as const,
        reason: "verified_incumbent_owns_equivalent_semantic_route",
        wouldAdmitEdges: 0,
      })),
      ...projection.staticConflicted.map((admission) => ({
        event: "protocol_discovery" as const,
        adapterId: admission.adapterId,
        target: admission.instance.pool.address,
        selectors: [...admission.instance.selectors],
        sources: [...admission.instance.sources],
        verdict: "rejected" as const,
        stage: "arbitration" as const,
        reason: "non_equivalent_incumbent_semantic_route_quarantined",
        wouldAdmitEdges: 0,
      })),
    ],
    mode,
    blockNumber,
  );
}

/**
 * One mutation lane for DEX refresh, active protocol discovery and observed
 * receipts. A failed task is reported without poisoning later generations.
 */
export class ProtocolDiscoveryMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(
    label: "active" | "observed" | "dex-refresh",
    work: () => Promise<T>,
  ): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.then(() => undefined).catch((error) => {
      console.log(
        `[searcher/live] protocol discovery ${label} error: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return run;
  }

  settled(): Promise<void> {
    return this.tail;
  }
}

import {
  FlashFundingSnapshot,
  type AdapterRuntimePrepareResult,
  type AdapterRuntimePrepareTiming,
  type AdapterRuntimeSnapshot,
  type CurrentNExactExecutionContextResult,
  type FlashFundingCoverage,
  type FlashFundingFreshnessProof,
  type PrepareAdapterRuntimeInput,
  type PrepareCurrentNExactExecutionContextInput,
} from "./adapter-runtime-coordinator.js";
import type { CurrentSourceRuntimeCoordinator } from
  "./blockscan-runtime-loop.js";
import type {
  BlockScanStateCoverage,
  BlockScanStatePrepareResult,
  BlockScanStateSnapshot,
} from "./blockscan-state-coordinator.js";
import type {
  StrictFundingRuntimeProjection,
  StrictProductionRuntimeSession,
} from
  "./strict-production-runtime-session.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import { PRODUCTION_STRICT_FAMILY_DECLARATIONS } from
  "./strict-production-family-declarations.js";
import {
  blockScanEdgeKey,
  exactSetHash,
  type StateKeyCoverage,
  type VerifiedGraphView,
} from "./venues/blockscan-state-capability.js";
import type { RouteVenueMid } from "./venues/mid-readers.js";
import type { StateBackend } from "../shared/state/state-backend.js";

export type StrictSessionPurpose =
  | "coarse-pricing"
  | "source-n-runtime"
  | "exact-execution";

export interface StrictSessionRequest {
  readonly purpose: StrictSessionPurpose;
  readonly source: CanonicalSource;
  readonly control?: {
    readonly deadlineAtMs?: number;
    readonly signal?: AbortSignal;
  };
  /** Explicit on every call; coarse-pricing must pass an empty array. */
  readonly fundingAssets: readonly string[];
  readonly touchedPools?: ReadonlySet<string>;
  readonly exactCallBackend?: Pick<StateBackend, "call">;
  readonly pricingCallBackend?: Pick<StateBackend, "call">;
  /** Required for exact-execution; inherited from coarse candidate closure. */
  readonly requiredEdgeIds?: ReadonlySet<string>;
}

export type StrictSessionProvider = (
  request: StrictSessionRequest,
) => Promise<StrictProductionRuntimeSession>;

const EMPTY_FUNDING_ASSETS: readonly string[] = Object.freeze([]);

export interface StrictCanonicalActivityProof {
  readonly source: CanonicalSource;
  readonly touchedStateKeys: ReadonlySet<string>;
  readonly complete: true;
}

/**
 * Atomic producer snapshot built only from one current-source strict session.
 * It intentionally implements the temporary scanner result shape while
 * owning no legacy registry, StateInstance compiler, cache or fallback.
 */
export class StrictCurrentRuntimeCoordinator
  implements CurrentSourceRuntimeCoordinator {
  private publishedPricing: BlockScanStateSnapshot | null = null;

  constructor(
    private readonly sessionFor: StrictSessionProvider,
    private readonly resetSessions: () => void,
  ) {}

  latestPricingSnapshot(): BlockScanStateSnapshot | null {
    return this.publishedPricing;
  }

  async resetDynamicStateForReplay(): Promise<void> {
    this.publishedPricing = null;
    this.resetSessions();
  }

  async prepareCoarsePricing(input: {
    readonly graph: VerifiedGraphView;
    readonly deadlineAtMs: number;
    readonly familySettleDeadlineAtMs?: number;
    readonly signal?: AbortSignal;
    readonly touchedPools?: ReadonlySet<string>;
    readonly canonicalActivity?: StrictCanonicalActivityProof;
  }): Promise<BlockScanStatePrepareResult> {
    const settleDeadlineAtMs = Math.min(
      input.deadlineAtMs,
      input.familySettleDeadlineAtMs ?? input.deadlineAtMs,
    );
    assertWorkOpen(settleDeadlineAtMs, input.signal);
    const previous = this.publishedPricing;
    const session = await this.sessionFor({
      purpose: "coarse-pricing",
      source: sourceFor(input.graph),
      control: controlFor(settleDeadlineAtMs, input.signal),
      fundingAssets: EMPTY_FUNDING_ASSETS,
      ...(previous === null || input.touchedPools === undefined
        ? {}
        : { touchedPools: input.touchedPools }),
    });
    assertWorkOpen(settleDeadlineAtMs, input.signal);
    const pricing = buildStrictPricingSnapshot(session, input.graph, {
      previous,
      canonicalActivity: input.canonicalActivity,
    });
    this.publishedPricing = pricing;
    return completePricingResult(pricing);
  }

  async prepare(
    input: PrepareAdapterRuntimeInput,
  ): Promise<AdapterRuntimePrepareResult> {
    const startedAtMs = Date.now();
    const settleDeadlineAtMs = Math.min(
      input.deadlineAtMs,
      input.preparationSettleDeadlineAtMs ?? input.deadlineAtMs,
    );
    assertWorkOpen(settleDeadlineAtMs, input.signal);
    const source = sourceFor(input.graph);
    const sessionStartedAtMs = Date.now();
    const previous = this.publishedPricing;
    const sessionPromise = this.sessionFor({
      purpose: "source-n-runtime",
      source,
      control: controlFor(settleDeadlineAtMs, input.signal),
      fundingAssets: input.fundingTokens,
      ...(previous === null || input.touchedPools === undefined
        ? {}
        : { touchedPools: input.touchedPools }),
      ...(input.pricingCallBackend === undefined
        ? {}
        : { pricingCallBackend: input.pricingCallBackend }),
    });
    const executionStartedAtMs = Date.now();
    const executionPromise = input.prepareExecution === undefined
      ? Promise.resolve()
      : input.prepareExecution({
          generation: source.generation,
          sourceBlock: source.number,
          sourceBlockHash: source.hash,
          deadlineAtMs: settleDeadlineAtMs,
          signal: input.signal ?? new AbortController().signal,
        });
    const [session] = await Promise.all([sessionPromise, executionPromise]);
    const executionMs = Math.max(0, Date.now() - executionStartedAtMs);
    assertWorkOpen(input.deadlineAtMs, input.signal);
    const pricingStartedAtMs = Date.now();
    const pricing = buildStrictPricingSnapshot(session, input.graph, {
      previous,
      canonicalActivity: input.canonicalActivity,
    });
    const pricingMs = Math.max(0, Date.now() - pricingStartedAtMs) +
      Math.max(0, pricingStartedAtMs - sessionStartedAtMs);
    const funding = buildStrictFundingSnapshot(
      session.fundingProjection(),
      input.graph,
    );
    const fundingCoverage = funding.coverage;
    const completeness = pricing.coverage.unresolvedEdgeKeys.length > 0 ||
        fundingCoverage.unresolvedKeys.length > 0
      ? "degraded" as const
      : "complete" as const;
    const snapshot: AdapterRuntimeSnapshot = Object.freeze({
      completeness,
      generation: input.graph.generation,
      sourceBlock: input.graph.sourceBlock,
      sourceBlockHash: input.graph.sourceBlockHash,
      graph: input.graph,
      pricing,
      funding,
    });
    this.publishedPricing = pricing;
    const finishedAtMs = Date.now();
    const timing: AdapterRuntimePrepareTiming = Object.freeze({
      startedAtMs,
      finishedAtMs,
      wallMs: Math.max(0, finishedAtMs - startedAtMs),
      pricingMs,
      fundingMs: 0,
      executionMs,
      finalCanonicalCasMs: 0,
    });
    return Object.freeze({
      status: completeness,
      snapshot,
      pricing: completePricingResult(pricing),
      fundingCoverage,
      issues: Object.freeze([]),
      timing,
    });
  }

  async prepareCurrentNExactExecutionContext(
    input: PrepareCurrentNExactExecutionContextInput,
  ): Promise<CurrentNExactExecutionContextResult> {
    const startedAtMs = Date.now();
    const settleDeadlineAtMs = Math.min(
      input.deadlineAtMs,
      input.preparationSettleDeadlineAtMs ?? input.deadlineAtMs,
    );
    assertWorkOpen(settleDeadlineAtMs, input.signal);
    const source = sourceFor(input.graph);
    if (input.requiredEdgeIds === undefined) {
      throw new Error(
        "strict exact execution requires requiredEdgeIds from candidate closure",
      );
    }
    const session = await this.sessionFor({
      purpose: "exact-execution",
      source,
      control: controlFor(settleDeadlineAtMs, input.signal),
      fundingAssets: input.fundingTokens,
      requiredEdgeIds: input.requiredEdgeIds,
    });
    if (input.prepareExecution !== undefined) {
      await input.prepareExecution({
        generation: source.generation,
        sourceBlock: source.number,
        sourceBlockHash: source.hash,
        deadlineAtMs: settleDeadlineAtMs,
        signal: input.signal ?? new AbortController().signal,
      });
    }
    assertWorkOpen(input.deadlineAtMs, input.signal);
    const funding = buildStrictFundingSnapshot(
      session.fundingProjection(),
      input.graph,
    );
    const finishedAtMs = Date.now();
    return Object.freeze({
      status: funding.coverage.unresolvedKeys.length > 0
        ? "degraded" as const
        : "complete" as const,
      context: Object.freeze({
        generation: input.graph.generation,
        sourceBlock: input.graph.sourceBlock,
        sourceBlockHash: input.graph.sourceBlockHash,
        graph: input.graph,
        funding,
      }),
      fundingCoverage: funding.coverage,
      issues: Object.freeze([]),
      timing: Object.freeze({
        startedAtMs,
        finishedAtMs,
        wallMs: Math.max(0, finishedAtMs - startedAtMs),
        fundingMs: Math.max(0, finishedAtMs - startedAtMs),
        executionMs: 0,
        finalCanonicalCasMs: 0,
      }),
    });
  }
}

function buildStrictPricingSnapshot(
  session: StrictProductionRuntimeSession,
  graph: VerifiedGraphView,
  input: {
    readonly previous: BlockScanStateSnapshot | null;
    readonly canonicalActivity?: StrictCanonicalActivityProof;
  },
): BlockScanStateSnapshot {
  assertSessionGraphSource(session, graph);
  const sessionCoveredEdgeIds = new Set(session.edges.map(blockScanEdgeKey));
  const previousEdgeByKey = new Map(
    (input.previous?.graph.edges ?? []).map((edge) => [
      blockScanEdgeKey(edge),
      edge,
    ] as const),
  );
  const mids = new Map<string, RouteVenueMid>();
  const coverageByEdgeKey = new Map<string, StateKeyCoverage>();
  const pricingProvenanceByEdgeKey = new Map<
    string,
    "refreshed" | "carried" | "unavailable" | "unresolved"
  >();
  const pricingStateKeyByEdgeKey = new Map<string, string>();
  const pricingFamilyIdByEdgeKey = new Map<string, string>();
  const familyIds = new Set<string>();
  const incompleteFamilyIds = new Set<string>();
  const refreshedEdgeKeys: string[] = [];
  const carriedEdgeKeys: string[] = [];
  const expectedEdgeKeys: string[] = [];
  const resolvedEdgeKeys: string[] = [];
  const unavailableEdgeKeys: string[] = [];
  const unresolvedEdgeKeys: string[] = [];
  for (const edge of graph.edges) {
    if (!scannerConsumesEdge(edge)) continue;
    const edgeKey = blockScanEdgeKey(edge);
    expectedEdgeKeys.push(edgeKey);
    const familyId = sessionCoveredEdgeIds.has(edgeKey)
      ? session.familyIdForEdge(edge)
      : PRODUCTION_STRICT_FAMILY_DECLARATIONS.familyIdForEdge(edge.adapterId);
    familyIds.add(familyId);
    const stateKey = sessionCoveredEdgeIds.has(edgeKey)
      ? session.stateKeyForEdge(edge)
      : null;
    if (stateKey !== null) pricingStateKeyByEdgeKey.set(edgeKey, stateKey);
    pricingFamilyIdByEdgeKey.set(edgeKey, familyId);
    const current = sessionCoveredEdgeIds.has(edgeKey)
      ? session.currentPricingForEdge(edge)
      : null;
    if (current === null) {
      const carried = compatibleCarryForEdge({
        edge,
        edgeKey,
        stateKey,
        previous: input.previous,
        previousEdge: previousEdgeByKey.get(edgeKey),
        canonicalActivity: input.canonicalActivity,
        source: sourceFor(graph),
        familyId,
      });
      if (carried !== null) {
        mids.set(edgeKey, Object.freeze({
          ...carried.mid,
          edges: [edge],
        }));
        resolvedEdgeKeys.push(edgeKey);
        carriedEdgeKeys.push(edgeKey);
        pricingProvenanceByEdgeKey.set(edgeKey, "carried");
        coverageByEdgeKey.set(edgeKey, Object.freeze({ status: "resolved" as const }));
        continue;
      }
      unresolvedEdgeKeys.push(edgeKey);
      incompleteFamilyIds.add(familyId);
      pricingProvenanceByEdgeKey.set(edgeKey, "unresolved");
      coverageByEdgeKey.set(edgeKey, Object.freeze({
        status: "unresolved" as const,
        reason: input.previous === null
          ? "bootstrap-missing-current-pricing"
          : "no-compatible-carry-base",
      }));
      continue;
    }
    if (current.status === "unresolved") {
      unresolvedEdgeKeys.push(edgeKey);
      incompleteFamilyIds.add(familyId);
      pricingProvenanceByEdgeKey.set(edgeKey, "unresolved");
      coverageByEdgeKey.set(edgeKey, Object.freeze({
        status: "unresolved" as const,
        reason: current.reason,
      }));
      continue;
    }
    if (current.status === "behavior-proven-unavailable") {
      unavailableEdgeKeys.push(edgeKey);
      pricingProvenanceByEdgeKey.set(edgeKey, "unavailable");
      coverageByEdgeKey.set(edgeKey, Object.freeze({
        status: "rejected" as const,
        reason: current.reason,
      }));
      continue;
    }
    resolvedEdgeKeys.push(edgeKey);
    refreshedEdgeKeys.push(edgeKey);
    pricingProvenanceByEdgeKey.set(edgeKey, "refreshed");
    coverageByEdgeKey.set(edgeKey, Object.freeze({ status: "resolved" as const }));
    mids.set(edgeKey, Object.freeze({
      ...current.mid,
      edges: [edge],
    }));
  }
  expectedEdgeKeys.sort();
  resolvedEdgeKeys.sort();
  unavailableEdgeKeys.sort();
  unresolvedEdgeKeys.sort();
  refreshedEdgeKeys.sort();
  carriedEdgeKeys.sort();
  if (
    refreshedEdgeKeys.length + carriedEdgeKeys.length +
        unavailableEdgeKeys.length + unresolvedEdgeKeys.length !==
      expectedEdgeKeys.length
  ) {
    throw new Error("strict pricing edge partition violates expected count invariant");
  }
  if (
    expectedEdgeKeys.length !== graph.scannerEdgeCount ||
    exactSetHash(expectedEdgeKeys) !== graph.scannerEdgeKeyHash
  ) {
    throw new Error("strict pricing edge partition differs from ready Graph");
  }
  const coverage: BlockScanStateCoverage = Object.freeze({
    expectedStateKeys: Object.freeze([]),
    resolvedStateKeys: Object.freeze([]),
    unresolvedStateKeys: Object.freeze([]),
    expectedReadKeys: Object.freeze([]),
    resolvedReadKeys: Object.freeze([]),
    unresolvedReadKeys: Object.freeze([]),
    expectedEdgeKeys: Object.freeze(expectedEdgeKeys),
    resolvedEdgeKeys: Object.freeze(resolvedEdgeKeys),
    unavailableEdgeKeys: Object.freeze(unavailableEdgeKeys),
    unresolvedEdgeKeys: Object.freeze(unresolvedEdgeKeys),
    expectedStateKeyHash: exactSetHash([]),
    resolvedStateKeyHash: exactSetHash([]),
    unresolvedStateKeyHash: exactSetHash([]),
    expectedReadKeyHash: exactSetHash([]),
    resolvedReadKeyHash: exactSetHash([]),
    unresolvedReadKeyHash: exactSetHash([]),
    expectedEdgeKeyHash: exactSetHash(expectedEdgeKeys),
    resolvedEdgeKeyHash: exactSetHash(resolvedEdgeKeys),
    unavailableEdgeKeyHash: exactSetHash(unavailableEdgeKeys),
    unresolvedEdgeKeyHash: exactSetHash(unresolvedEdgeKeys),
    refreshedEdgeKeys: Object.freeze(refreshedEdgeKeys),
    carriedEdgeKeys: Object.freeze(carriedEdgeKeys),
    refreshedEdgeKeyHash: exactSetHash(refreshedEdgeKeys),
    carriedEdgeKeyHash: exactSetHash(carriedEdgeKeys),
  });
  return Object.freeze({
    generation: graph.generation,
    sourceBlock: graph.sourceBlock,
    sourceBlockHash: graph.sourceBlockHash,
    graph,
    mids: new Map(mids),
    coverageByReadKey: new Map(),
    coverageByEdgeKey: new Map(coverageByEdgeKey),
    freshnessByReadKey: new Map(),
    stateByStateKey: new Map(),
    resolvedFamilyIds: Object.freeze(
      [...familyIds].filter((familyId) =>
        !incompleteFamilyIds.has(familyId)
      ).sort(),
    ),
    incompleteFamilyIds: Object.freeze(
      [...incompleteFamilyIds].sort(),
    ),
    coverage,
    pricingProvenanceByEdgeKey: new Map(pricingProvenanceByEdgeKey),
    pricingStateKeyByEdgeKey: new Map(pricingStateKeyByEdgeKey),
    pricingFamilyIdByEdgeKey: new Map(pricingFamilyIdByEdgeKey),
    laneTelemetry: Object.freeze([]),
    familyTelemetry: Object.freeze([]),
  });
}

function completePricingResult(
  snapshot: BlockScanStateSnapshot,
): BlockScanStatePrepareResult {
  const degraded = snapshot.coverage.unresolvedEdgeKeys.length > 0;
  return Object.freeze({
    status: degraded ? "degraded" as const : "complete" as const,
    generation: snapshot.generation,
    sourceBlock: snapshot.sourceBlock,
    sourceBlockHash: snapshot.sourceBlockHash,
    coverage: snapshot.coverage,
    issues: Object.freeze([]),
    laneTelemetry: Object.freeze([]),
    familyTelemetry: Object.freeze([]),
    snapshot,
  });
}

function compatibleCarryForEdge(input: {
  readonly edge: VerifiedGraphView["edges"][number];
  readonly edgeKey: string;
  readonly stateKey: string | null;
  readonly previous: BlockScanStateSnapshot | null;
  readonly previousEdge: VerifiedGraphView["edges"][number] | undefined;
  readonly canonicalActivity: StrictCanonicalActivityProof | undefined;
  readonly source: CanonicalSource;
  readonly familyId: string;
}): { readonly mid: RouteVenueMid } | null {
  const {
    edge,
    edgeKey,
    stateKey,
    previous,
    previousEdge,
    canonicalActivity,
    source,
    familyId,
  } = input;
  if (
    previous === null ||
    previousEdge === undefined ||
    stateKey === null ||
    canonicalActivity === undefined ||
    canonicalActivity.complete !== true ||
    !sameCanonicalSource(canonicalActivity.source, source) ||
    source.number <= previous.sourceBlock ||
    source.generation <= previous.generation ||
    !sameEdgeContract(previousEdge, edge)
  ) return null;
  if (canonicalActivity.touchedStateKeys.has(stateKey)) return null;
  const previousStateKey = previous.pricingStateKeyByEdgeKey?.get(edgeKey);
  if (previousStateKey !== stateKey) return null;
  const previousFamilyId = previous.pricingFamilyIdByEdgeKey?.get(edgeKey);
  if (previousFamilyId !== familyId) return null;
  const previousProvenance = previous.pricingProvenanceByEdgeKey?.get(edgeKey);
  if (previousProvenance !== "refreshed" && previousProvenance !== "carried") {
    return null;
  }
  if (previous.coverageByEdgeKey.get(edgeKey)?.status !== "resolved") return null;
  const mid = previous.mids.get(edgeKey);
  return mid === undefined ? null : { mid };
}

function sameCanonicalSource(left: CanonicalSource, right: CanonicalSource): boolean {
  return left.number === right.number &&
    left.generation === right.generation &&
    left.hash.toLowerCase() === right.hash.toLowerCase();
}

function sameEdgeContract(
  left: VerifiedGraphView["edges"][number],
  right: VerifiedGraphView["edges"][number],
): boolean {
  return blockScanEdgeKey(left) === blockScanEdgeKey(right) &&
    left.adapterId === right.adapterId &&
    left.target.toLowerCase() === right.target.toLowerCase() &&
    left.tokenIn.toLowerCase() === right.tokenIn.toLowerCase() &&
    left.tokenOut.toLowerCase() === right.tokenOut.toLowerCase() &&
    left.slotKind === right.slotKind &&
    (left.protocolAction ?? "") === (right.protocolAction ?? "") &&
    left.edgeKind === right.edgeKind &&
    left.leavesStandingPosition === right.leavesStandingPosition &&
    (left.instanceKey ?? "") === (right.instanceKey ?? "") &&
    (left.executionVariantKey ?? "") === (right.executionVariantKey ?? "");
}

function buildStrictFundingSnapshot(
  projection: StrictFundingRuntimeProjection,
  graph: VerifiedGraphView,
): FlashFundingSnapshot {
  const coverageByFundingId = new Map<string, StateKeyCoverage>();
  const freshnessByFundingId = new Map<
    string,
    ReadonlyMap<string, FlashFundingFreshnessProof>
  >();
  const expectedKeys: string[] = [];
  const resolvedKeys: string[] = [];
  const unresolvedKeys: string[] = [];
  for (const outcome of projection.outcomes) {
    if (
      outcome.source.number !== graph.sourceBlock ||
      outcome.source.hash.toLowerCase() !== graph.sourceBlockHash.toLowerCase() ||
      outcome.source.generation !== graph.generation
    ) {
      throw new Error("strict Funding projection differs from ready Graph source");
    }
    if (coverageByFundingId.has(outcome.fundingId)) {
      throw new Error(`strict Funding projection duplicates ${outcome.fundingId}`);
    }
    expectedKeys.push(outcome.fundingId);
    if (outcome.status !== "verified") {
      unresolvedKeys.push(outcome.fundingId);
      coverageByFundingId.set(outcome.fundingId, Object.freeze({
        status: "unresolved" as const,
        reason: `${outcome.status}:${outcome.reasonCode}`,
      }));
      continue;
    }
    const receipt = outcome.workReceipt;
    if (
      receipt === null ||
      receipt.stage !== "pricing-current" ||
      receipt.familyId !== outcome.familyId ||
      receipt.source.number !== outcome.source.number ||
      receipt.source.hash.toLowerCase() !== outcome.source.hash.toLowerCase() ||
      receipt.source.generation !== outcome.source.generation ||
      receipt.generation !== outcome.source.generation ||
      receipt.failureStage !== null ||
      receipt.subjectKey.length === 0 ||
      receipt.dedupeKey === null ||
      receipt.dedupeKey.length === 0 ||
      outcome.trustedResultsFingerprint === null ||
      outcome.trustedResultsFingerprint.length === 0 ||
      outcome.evidenceRefs.length === 0
    ) {
      throw new Error(
        `verified strict Funding lacks work provenance ${outcome.fundingId}`,
      );
    }
    resolvedKeys.push(outcome.fundingId);
    coverageByFundingId.set(
      outcome.fundingId,
      Object.freeze({ status: "resolved" as const }),
    );
    freshnessByFundingId.set(outcome.fundingId, new Map([[outcome.stateKey,
      Object.freeze({
        kind: "strict-work" as const,
        source: Object.freeze({ ...outcome.source }),
        subjectKey: receipt.subjectKey,
        dedupeKey: receipt.dedupeKey,
        trustedResultsFingerprint: outcome.trustedResultsFingerprint,
        evidenceFingerprint: exactSetHash(outcome.evidenceRefs),
      }),
    ]]));
  }
  expectedKeys.sort();
  resolvedKeys.sort();
  unresolvedKeys.sort();
  const sources = new Map(projection.sources);
  for (const [token, source] of sources) {
    if (
      source.amount <= 0n ||
      source.fundingId === undefined ||
      coverageByFundingId.get(source.fundingId)?.status !== "resolved"
    ) {
      throw new Error(`strict Funding source is not resolved for ${token}`);
    }
  }
  const coverage: FlashFundingCoverage = Object.freeze({
    expectedKeys: Object.freeze(expectedKeys),
    resolvedKeys: Object.freeze(resolvedKeys),
    unresolvedKeys: Object.freeze(unresolvedKeys),
    expectedHash: exactSetHash(expectedKeys),
    resolvedHash: exactSetHash(resolvedKeys),
    unresolvedHash: exactSetHash(unresolvedKeys),
  });
  return new FlashFundingSnapshot(
    graph.generation,
    graph.sourceBlock,
    graph.sourceBlockHash,
    coverage,
    coverageByFundingId,
    freshnessByFundingId,
    sources,
  );
}

function sourceFor(graph: VerifiedGraphView): CanonicalSource {
  return Object.freeze({
    number: graph.sourceBlock,
    hash: graph.sourceBlockHash,
    generation: graph.generation,
  });
}

function controlFor(
  deadlineAtMs: number,
  signal: AbortSignal | undefined,
): { readonly deadlineAtMs: number; readonly signal?: AbortSignal } {
  return Object.freeze({
    deadlineAtMs,
    ...(signal === undefined ? {} : { signal }),
  });
}

function assertWorkOpen(
  deadlineAtMs: number,
  signal: AbortSignal | undefined,
): void {
  if (!Number.isFinite(deadlineAtMs) || Date.now() >= deadlineAtMs) {
    throw new Error("strict current runtime deadline expired");
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error("strict current runtime aborted");
  }
}

function assertSessionGraphSource(
  session: StrictProductionRuntimeSession,
  graph: VerifiedGraphView,
): void {
  if (
    session.source.number !== graph.sourceBlock ||
    session.source.hash.toLowerCase() !== graph.sourceBlockHash.toLowerCase() ||
    session.source.generation !== graph.generation
  ) {
    throw new Error("strict session source differs from current GraphView");
  }
}

function scannerConsumesEdge(edge: {
  readonly slotKind: string;
  readonly leavesStandingPosition: boolean;
}): boolean {
  return edge.slotKind === "swap" ||
    (edge.slotKind === "protocol" && !edge.leavesStandingPosition);
}

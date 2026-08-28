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
import { strictReadyGraphContractFingerprint } from
  "./strict-production-runtime-session.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
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

type StrictPricingProvenance =
  | "refreshed"
  | "carried"
  | "unavailable"
  | "unresolved";

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
    readonly pricingCallBackend?: Pick<StateBackend, "call">;
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
      ...(input.pricingCallBackend === undefined
        ? {}
        : { pricingCallBackend: input.pricingCallBackend }),
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
  const pricingIndex = session.pricingIndex();
  const graphFingerprint = strictGraphPublicationFingerprint(graph);
  if (
    pricingIndex.expectedEdgeKeys.length !== graph.scannerEdgeCount ||
    pricingIndex.expectedEdgeKeyHash !== graph.scannerEdgeKeyHash ||
    pricingIndex.readyGraphContractFingerprint !==
      strictReadyGraphContractFingerprint(graph.edges)
  ) {
    throw new Error("strict pricing index differs from ready Graph");
  }
  const previousEdgeByKey = new Map(
    (input.previous?.graph.edges ?? []).map((edge) => [
      blockScanEdgeKey(edge),
      edge,
    ] as const),
  );
  /*
   * A strict ready Graph is immutable between source generations. Once that
   * publication fingerprint and the expected edge set are unchanged, retain
   * the previous maps and delta only refreshed/status-changing entries. A
   * bootstrap or topology change uses the full assembly below; no carry is
   * authorized merely because a map happens to be available.
   */
  const previous = input.previous;
  const canDeltaPublish = previous !== null &&
    strictGraphPublicationFingerprint(previous.graph) === graphFingerprint &&
    previous.coverage.expectedEdgeKeys.length === graph.scannerEdgeCount &&
    previous.coverage.expectedEdgeKeyHash === graph.scannerEdgeKeyHash &&
    previous.coverageByEdgeKey.size === graph.scannerEdgeCount &&
    previous.pricingProvenanceByEdgeKey !== undefined &&
    previous.pricingProvenanceByEdgeKey.size === graph.scannerEdgeCount &&
    previous.pricingStateKeyByEdgeKey !== undefined &&
    previous.pricingStateKeyByEdgeKey.size === graph.scannerEdgeCount &&
    previous.pricingFamilyIdByEdgeKey !== undefined &&
    previous.pricingFamilyIdByEdgeKey.size === graph.scannerEdgeCount;
  const previousForDelta = canDeltaPublish ? previous : null;
  const fullMids = canDeltaPublish ? null : new Map<string, RouteVenueMid>();
  const midUpdates: [string, RouteVenueMid][] = [];
  const midRemovals: string[] = [];
  const fullCoverageByEdgeKey = canDeltaPublish
    ? null
    : new Map<string, StateKeyCoverage>();
  const coverageUpdates: [string, StateKeyCoverage][] = [];
  const fullPricingProvenanceByEdgeKey = canDeltaPublish
    ? null
    : new Map<string, StrictPricingProvenance>();
  const pricingProvenanceUpdates: [string, StrictPricingProvenance][] = [];
  const fullPricingStateKeyByEdgeKey = canDeltaPublish
    ? null
    : new Map<string, string>();
  const fullPricingFamilyIdByEdgeKey = canDeltaPublish
    ? null
    : new Map<string, string>();
  const recordCoverage = (
    edgeKey: string,
    coverage: StateKeyCoverage,
  ): void => {
    if (canDeltaPublish) {
      const previousCoverage = previousForDelta!.coverageByEdgeKey.get(edgeKey);
      if (!sameStateKeyCoverage(previousCoverage, coverage)) {
        coverageUpdates.push([edgeKey, coverage]);
      }
      return;
    }
    fullCoverageByEdgeKey!.set(edgeKey, coverage);
  };
  const recordProvenance = (
    edgeKey: string,
    provenance: StrictPricingProvenance,
  ): void => {
    if (canDeltaPublish) {
      if (
        previousForDelta!.pricingProvenanceByEdgeKey!.get(edgeKey) !==
          provenance
      ) {
        pricingProvenanceUpdates.push([edgeKey, provenance]);
      }
      return;
    }
    fullPricingProvenanceByEdgeKey!.set(edgeKey, provenance);
  };
  const recordMid = (edgeKey: string, mid: RouteVenueMid): void => {
    if (canDeltaPublish) {
      if (previousForDelta!.mids.get(edgeKey) !== mid) {
        midUpdates.push([edgeKey, mid]);
      }
      return;
    }
    fullMids!.set(edgeKey, mid);
  };
  const removeMid = (edgeKey: string): void => {
    if (canDeltaPublish && previousForDelta!.mids.has(edgeKey)) {
      midRemovals.push(edgeKey);
    }
  };
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
    const covered = sessionCoveredEdgeIds.has(edgeKey);
    const familyId = pricingIndex.familyIdByEdgeKey.get(edgeKey);
    const stateKey = pricingIndex.stateKeyByEdgeKey.get(edgeKey);
    if (familyId === undefined || stateKey === undefined) {
      throw new Error(`strict ready pricing index omits ${edgeKey}`);
    }
    if (covered) {
      if (
        session.familyIdForEdge(edge) !== familyId ||
        session.stateKeyForEdge(edge) !== stateKey
      ) {
        throw new Error(`strict pricing session contract differs at ${edgeKey}`);
      }
    }
    familyIds.add(familyId);
    if (!canDeltaPublish) {
      fullPricingStateKeyByEdgeKey!.set(edgeKey, stateKey);
      fullPricingFamilyIdByEdgeKey!.set(edgeKey, familyId);
    }
    const current = covered
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
      if (carried?.kind === "priced") {
        const mid = canDeltaPublish
          ? previousForDelta!.mids.get(edgeKey) ?? strictMidForEdge(carried.mid, edge)
          : strictMidForEdge(carried.mid, edge);
        recordMid(edgeKey, mid);
        resolvedEdgeKeys.push(edgeKey);
        carriedEdgeKeys.push(edgeKey);
        recordProvenance(edgeKey, "carried");
        recordCoverage(edgeKey, Object.freeze({ status: "resolved" as const }));
        continue;
      }
      if (carried?.kind === "unavailable") {
        unavailableEdgeKeys.push(edgeKey);
        removeMid(edgeKey);
        recordProvenance(edgeKey, "unavailable");
        recordCoverage(edgeKey, Object.freeze({
          status: "rejected" as const,
          reason: carried.reason,
        }));
        continue;
      }
      unresolvedEdgeKeys.push(edgeKey);
      incompleteFamilyIds.add(familyId);
      const reason = input.previous === null
        ? "bootstrap-missing-current-pricing"
        : "no-compatible-carry-base";
      removeMid(edgeKey);
      recordProvenance(edgeKey, "unresolved");
      recordCoverage(edgeKey, Object.freeze({
        status: "unresolved" as const,
        reason,
      }));
      continue;
    }
    if (current.status === "unresolved") {
      unresolvedEdgeKeys.push(edgeKey);
      incompleteFamilyIds.add(familyId);
      removeMid(edgeKey);
      recordProvenance(edgeKey, "unresolved");
      recordCoverage(edgeKey, Object.freeze({
        status: "unresolved" as const,
        reason: current.reason,
      }));
      continue;
    }
    if (current.status === "behavior-proven-unavailable") {
      unavailableEdgeKeys.push(edgeKey);
      removeMid(edgeKey);
      recordProvenance(edgeKey, "unavailable");
      recordCoverage(edgeKey, Object.freeze({
        status: "rejected" as const,
        reason: current.reason,
      }));
      continue;
    }
    resolvedEdgeKeys.push(edgeKey);
    refreshedEdgeKeys.push(edgeKey);
    recordProvenance(edgeKey, "refreshed");
    recordCoverage(edgeKey, Object.freeze({ status: "resolved" as const }));
    recordMid(edgeKey, strictMidForEdge(current.mid, edge));
  }
  expectedEdgeKeys.sort();
  resolvedEdgeKeys.sort();
  unavailableEdgeKeys.sort();
  unresolvedEdgeKeys.sort();
  refreshedEdgeKeys.sort();
  carriedEdgeKeys.sort();
  const expectedEdgeKeyHash = exactSetHash(expectedEdgeKeys);
  const resolvedEdgeKeyHash = exactSetHash(resolvedEdgeKeys);
  const unavailableEdgeKeyHash = exactSetHash(unavailableEdgeKeys);
  const unresolvedEdgeKeyHash = exactSetHash(unresolvedEdgeKeys);
  if (
    refreshedEdgeKeys.length + carriedEdgeKeys.length +
        unavailableEdgeKeys.length + unresolvedEdgeKeys.length !==
      expectedEdgeKeys.length
  ) {
    throw new Error("strict pricing edge partition violates expected count invariant");
  }
  if (
    expectedEdgeKeys.length !== graph.scannerEdgeCount ||
    expectedEdgeKeyHash !== graph.scannerEdgeKeyHash
  ) {
    throw new Error("strict pricing edge partition differs from ready Graph");
  }
  const coverageMapsUnchanged = canDeltaPublish &&
    previousForDelta!.coverage.expectedEdgeKeyHash ===
      expectedEdgeKeyHash &&
    previousForDelta!.coverage.resolvedEdgeKeyHash ===
      resolvedEdgeKeyHash &&
    previousForDelta!.coverage.unavailableEdgeKeyHash ===
      unavailableEdgeKeyHash &&
    previousForDelta!.coverage.unresolvedEdgeKeyHash ===
      unresolvedEdgeKeyHash &&
    coverageUpdates.length === 0;
  const coverageByEdgeKey = coverageMapsUnchanged
    ? previousForDelta!.coverageByEdgeKey
    : canDeltaPublish
      ? deltaMap(previousForDelta!.coverageByEdgeKey, coverageUpdates, [])
      : fullCoverageByEdgeKey!;
  const mids = canDeltaPublish
    ? deltaMap(previousForDelta!.mids, midUpdates, midRemovals)
    : fullMids!;
  const pricingProvenanceByEdgeKey = canDeltaPublish
    ? deltaMap(
        previousForDelta!.pricingProvenanceByEdgeKey!,
        pricingProvenanceUpdates,
        [],
      )
    : fullPricingProvenanceByEdgeKey!;
  const pricingStateKeyByEdgeKey = canDeltaPublish
    ? previousForDelta!.pricingStateKeyByEdgeKey!
    : fullPricingStateKeyByEdgeKey!;
  const pricingFamilyIdByEdgeKey = canDeltaPublish
    ? previousForDelta!.pricingFamilyIdByEdgeKey!
    : fullPricingFamilyIdByEdgeKey!;
  const coverageByReadKey = canDeltaPublish &&
      previousForDelta!.coverageByReadKey.size === 0
    ? previousForDelta!.coverageByReadKey
    : new Map();
  const freshnessByReadKey = canDeltaPublish &&
      previousForDelta!.freshnessByReadKey.size === 0
    ? previousForDelta!.freshnessByReadKey
    : new Map();
  const stateByStateKey = canDeltaPublish &&
      previousForDelta!.stateByStateKey.size === 0
    ? previousForDelta!.stateByStateKey
    : new Map();
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
    expectedEdgeKeyHash,
    resolvedEdgeKeyHash,
    unavailableEdgeKeyHash,
    unresolvedEdgeKeyHash,
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
    mids,
    coverageByReadKey,
    coverageByEdgeKey,
    freshnessByReadKey,
    stateByStateKey,
    resolvedFamilyIds: Object.freeze(
      [...familyIds].filter((familyId) =>
        !incompleteFamilyIds.has(familyId)
      ).sort(),
    ),
    incompleteFamilyIds: Object.freeze(
      [...incompleteFamilyIds].sort(),
    ),
    coverage,
    pricingProvenanceByEdgeKey,
    pricingStateKeyByEdgeKey,
    pricingFamilyIdByEdgeKey,
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

function strictGraphPublicationFingerprint(graph: VerifiedGraphView): string {
  return [
    graph.orderedEdgeHash,
    graph.metadataHash,
    graph.ownershipHash,
    String(graph.scannerEdgeCount),
    graph.scannerEdgeKeyHash,
  ].join("\u001f");
}

function strictMidForEdge(
  mid: RouteVenueMid,
  edge: VerifiedGraphView["edges"][number],
): RouteVenueMid {
  return Object.freeze({
    ...mid,
    edges: [edge],
  });
}

function sameStateKeyCoverage(
  left: StateKeyCoverage | undefined,
  right: StateKeyCoverage,
): boolean {
  if (left === undefined || left.status !== right.status) return false;
  if (right.status === "resolved") return true;
  return "reason" in left && left.reason === right.reason;
}

function deltaMap<K, V>(
  previous: ReadonlyMap<K, V>,
  updates: readonly (readonly [K, V])[],
  removals: readonly K[],
): ReadonlyMap<K, V> {
  if (updates.length === 0 && removals.length === 0) return previous;
  const next = new Map(previous);
  for (const [key, value] of updates) next.set(key, value);
  for (const key of removals) next.delete(key);
  return next;
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
}):
  | { readonly kind: "priced"; readonly mid: RouteVenueMid }
  | { readonly kind: "unavailable"; readonly reason: string }
  | null {
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
  if (
    previousProvenance === "unavailable" &&
    previous.coverageByEdgeKey.get(edgeKey)?.status === "rejected"
  ) {
    const previousCoverage = previous.coverageByEdgeKey.get(edgeKey);
    if (previousCoverage?.status === "rejected") {
      const reason = previousCoverage.reason;
      return reason.trim().length > 0
        ? { kind: "unavailable", reason }
        : null;
    }
  }
  if (previousProvenance !== "refreshed" && previousProvenance !== "carried") {
    return null;
  }
  if (previous.coverageByEdgeKey.get(edgeKey)?.status !== "resolved") return null;
  const mid = previous.mids.get(edgeKey);
  return mid === undefined ? null : { kind: "priced", mid };
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

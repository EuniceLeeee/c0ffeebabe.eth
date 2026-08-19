import type {
  AdapterRuntimePrepareResult,
  AdapterRuntimePrepareTiming,
  AdapterRuntimeSnapshot,
  CurrentNExactExecutionContextResult,
  FlashFundingCoverage,
  PrepareAdapterRuntimeInput,
  PrepareCurrentNExactExecutionContextInput,
} from "./adapter-runtime-coordinator.js";
import type { CurrentSourceRuntimeCoordinator } from
  "./blockscan-runtime-loop.js";
import type {
  BlockScanStateCoverage,
  BlockScanStatePrepareResult,
  BlockScanStateSnapshot,
} from "./blockscan-state-coordinator.js";
import type { FlashLiquidityView, FlashSource } from
  "./solver/flash-liquidity.js";
import type {
  StrictProductionRuntimeSession,
  StrictProductionSessionKind,
} from
  "./strict-production-runtime-session.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  blockScanEdgeKey,
  exactSetHash,
  type StateFreshnessProof,
  type StateKeyCoverage,
  type VerifiedGraphView,
} from "./venues/blockscan-state-capability.js";
import type { RouteVenueMid } from "./venues/mid-readers.js";

type StrictSessionProvider = (
  source: CanonicalSource,
  control?: {
    readonly deadlineAtMs?: number;
    readonly signal?: AbortSignal;
  },
  kind?: StrictProductionSessionKind,
  fundingAssets?: readonly string[],
) => Promise<StrictProductionRuntimeSession>;

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
  }): Promise<BlockScanStatePrepareResult> {
    const settleDeadlineAtMs = Math.min(
      input.deadlineAtMs,
      input.familySettleDeadlineAtMs ?? input.deadlineAtMs,
    );
    assertWorkOpen(settleDeadlineAtMs, input.signal);
    const session = await this.sessionFor(
      sourceFor(input.graph),
      controlFor(settleDeadlineAtMs, input.signal),
      "pricing",
    );
    assertWorkOpen(settleDeadlineAtMs, input.signal);
    const pricing = buildStrictPricingSnapshot(session, input.graph);
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
    const sessionPromise = this.sessionFor(
      source,
      controlFor(settleDeadlineAtMs, input.signal),
      "pricing",
    );
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
    const pricing = buildStrictPricingSnapshot(session, input.graph);
    const pricingMs = Math.max(0, Date.now() - pricingStartedAtMs) +
      Math.max(0, pricingStartedAtMs - sessionStartedAtMs);
    const funding = buildStrictFundingSnapshot(
      session.fundingLiquidityView(),
      input.fundingTokens,
      input.graph,
    );
    const fundingCoverage = funding.coverage;
    const snapshot: AdapterRuntimeSnapshot = Object.freeze({
      completeness: "complete" as const,
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
      status: "complete" as const,
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
    const session = await this.sessionFor(
      source,
      controlFor(settleDeadlineAtMs, input.signal),
      "exact",
      input.fundingTokens,
    );
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
      session.fundingLiquidityView(),
      input.fundingTokens,
      input.graph,
    );
    const finishedAtMs = Date.now();
    return Object.freeze({
      status: "complete" as const,
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
): BlockScanStateSnapshot {
  assertSessionGraphSource(session, graph);
  const mids = new Map<string, RouteVenueMid>();
  const coverageByEdgeKey = new Map<string, StateKeyCoverage>();
  const familyIds = new Set<string>();
  const expectedEdgeKeys: string[] = [];
  const resolvedEdgeKeys: string[] = [];
  const unavailableEdgeKeys: string[] = [];
  for (const edge of graph.edges) {
    if (!scannerConsumesEdge(edge)) continue;
    const edgeKey = blockScanEdgeKey(edge);
    expectedEdgeKeys.push(edgeKey);
    familyIds.add(session.familyIdForEdge(edge));
    const current = session.currentPricingForEdge(edge);
    if (current === null) {
      throw new Error(`scanner edge ${edgeKey} has no strict pricing authority`);
    }
    if (current.status === "behavior-proven-unavailable") {
      unavailableEdgeKeys.push(edgeKey);
      coverageByEdgeKey.set(edgeKey, Object.freeze({
        status: "rejected" as const,
        reason: current.reason,
      }));
      continue;
    }
    resolvedEdgeKeys.push(edgeKey);
    coverageByEdgeKey.set(edgeKey, Object.freeze({ status: "resolved" as const }));
    mids.set(edgeKey, Object.freeze({
      ...current.mid,
      edges: [edge],
    }));
  }
  expectedEdgeKeys.sort();
  resolvedEdgeKeys.sort();
  unavailableEdgeKeys.sort();
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
    unresolvedEdgeKeys: Object.freeze([]),
    expectedStateKeyHash: exactSetHash([]),
    resolvedStateKeyHash: exactSetHash([]),
    unresolvedStateKeyHash: exactSetHash([]),
    expectedReadKeyHash: exactSetHash([]),
    resolvedReadKeyHash: exactSetHash([]),
    unresolvedReadKeyHash: exactSetHash([]),
    expectedEdgeKeyHash: exactSetHash(expectedEdgeKeys),
    resolvedEdgeKeyHash: exactSetHash(resolvedEdgeKeys),
    unavailableEdgeKeyHash: exactSetHash(unavailableEdgeKeys),
    unresolvedEdgeKeyHash: exactSetHash([]),
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
    resolvedFamilyIds: Object.freeze([...familyIds].sort()),
    incompleteFamilyIds: Object.freeze([]),
    coverage,
    laneTelemetry: Object.freeze([]),
    familyTelemetry: Object.freeze([]),
  });
}

function completePricingResult(
  snapshot: BlockScanStateSnapshot,
): BlockScanStatePrepareResult {
  return Object.freeze({
    status: "complete" as const,
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

class StrictFundingSnapshot implements FlashLiquidityView {
  readonly sources: ReadonlyMap<string, FlashSource>;
  readonly coverageByFundingId: ReadonlyMap<string, StateKeyCoverage> =
    new Map();
  readonly freshnessByFundingId: ReadonlyMap<
    string,
    ReadonlyMap<string, StateFreshnessProof>
  > = new Map();

  constructor(
    readonly generation: number,
    readonly sourceBlock: number,
    readonly sourceBlockHash: string,
    readonly coverage: FlashFundingCoverage,
    sources: ReadonlyMap<string, FlashSource>,
  ) {
    this.sources = new Map(sources);
    Object.freeze(this);
  }

  borrowable(token: string): bigint {
    return this.sources.get(token.toLowerCase())?.amount ?? 0n;
  }

  source(token: string): FlashSource | null {
    return this.sources.get(token.toLowerCase()) ?? null;
  }
}

function buildStrictFundingSnapshot(
  view: FlashLiquidityView,
  fundingTokens: readonly string[],
  graph: VerifiedGraphView,
): StrictFundingSnapshot {
  const expectedKeys = [...new Set(fundingTokens.map((token) =>
    token.toLowerCase()
  ))].sort();
  const sources = new Map<string, FlashSource>();
  for (const token of expectedKeys) {
    const source = view.source(token);
    if (source !== null) sources.set(token, Object.freeze({ ...source }));
  }
  const coverage: FlashFundingCoverage = Object.freeze({
    expectedKeys: Object.freeze(expectedKeys),
    resolvedKeys: Object.freeze([...expectedKeys]),
    unresolvedKeys: Object.freeze([]),
    expectedHash: exactSetHash(expectedKeys),
    resolvedHash: exactSetHash(expectedKeys),
    unresolvedHash: exactSetHash([]),
  });
  return new StrictFundingSnapshot(
    graph.generation,
    graph.sourceBlock,
    graph.sourceBlockHash,
    coverage,
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

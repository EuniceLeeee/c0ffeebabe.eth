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
  StrictReadyPricingIndex,
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
import type { PinnedRethQuoteBackend } from "./pinned-reth-quote-backend.js";
import type { AdapterWorkControl } from "./adapter-work-intent.js";
import { effectiveMidRowCarried, type EffectiveMidSnapshot } from "./blockscan-effective-mid.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";
import type { StrictSimulationTransport } from "./strict-central-adapter-runtime.js";
import { deltaMap, scannerConsumesEdge } from "./blockscan-pricing-delta.js";
import type { AdapterFamilyExactQuoteCache } from "./adapter-family-exact-quote-cache.js";

export type StrictSessionPurpose =
  | "coarse-pricing"
  | "source-n-runtime"
  | "exact-execution";

export interface StrictSessionRequest {
  readonly purpose: StrictSessionPurpose;
  readonly source: CanonicalSource;
  /** Source-owned transport, forwarded unchanged; not a per-session daemon. */
  readonly simulationTransport?: StrictSimulationTransport;
  readonly control?: {
    readonly deadlineAtMs?: number;
    readonly signal?: AbortSignal;
  };
  /** Explicit on every call; coarse-pricing must pass an empty array. */
  readonly fundingAssets: readonly string[];
  readonly touchedPools?: ReadonlySet<string>;
  readonly exactCallBackend?: Pick<StateBackend, "call">;
  readonly pricingCallBackend?: Pick<StateBackend, "call">;
  /** Same-pass successful reads only; misses keep the ordinary provider path. */
  readonly pricingCallCache?: Pick<PinnedRethQuoteBackend, "callCached">;
  /** Required for exact-execution; inherited from coarse candidate closure. */
  readonly requiredEdgeIds?: ReadonlySet<string>;
}

export type StrictSessionProvider = (
  request: StrictSessionRequest,
) => Promise<StrictProductionRuntimeSession>;

/** Pass-owned work handle; Funding projection/authority is not caller supplied. */
export interface StrictFundingPreparation {
  settle(): Promise<void>;
}

export type StrictFundingPreparationInput = Pick<PrepareAdapterRuntimeInput,
  "graph" | "fundingTokens" | "deadlineAtMs" |
  "preparationSettleDeadlineAtMs" | "signal" | "pricingCallBackend" | "simulationTransport"
>;

export interface PrepareStrictRuntimeInput extends PrepareAdapterRuntimeInput {
  readonly fundingPreparation?: StrictFundingPreparation;
  readonly canonicalActivity?: StrictCanonicalActivityProof;
  /**
   * Source-owned canonical recheck for a resumed startup. Cached eth_call bytes
   * do not perform a new requireCanonical check. The callback must obey this
   * request's work controls; it supplies no pricing or execution authority.
   */
  readonly validateBeforePublish?: () => Promise<void>;
}

const EMPTY_FUNDING_ASSETS: readonly string[] = Object.freeze([]);

export interface StrictCanonicalActivityProof {
  readonly source: CanonicalSource;
  readonly parentHash?: string;
  /** Present only after the activity reader verified every canonical transition
   * from this published source through source; never a target-only touched set. */
  readonly previousSource?: { readonly number: number; readonly hash: string };
  readonly touchedStateKeys: ReadonlySet<string>;
  readonly complete: true;
}

export type StrictPricingPublication =
  | {
      readonly kind: "baseline";
      readonly graphFingerprint: string;
      readonly snapshot: BlockScanStateSnapshot;
    }
  | {
      readonly kind: "delta";
      readonly graphFingerprint: string;
      readonly previousGeneration: number;
      readonly previousSourceBlock: number;
      readonly previousSourceBlockHash: string;
      readonly updates: readonly (readonly [string, RouteVenueMid])[];
      readonly removals: readonly string[];
      readonly snapshot: BlockScanStateSnapshot;
    };

interface StrictPricingBuildResult {
  readonly snapshot: BlockScanStateSnapshot;
  readonly publication: StrictPricingPublication;
  /** Installed only by the successful atomic publication, never by a draft. */
  readonly rawBasis?: BlockScanStateSnapshot;
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
  private bootstrapRawPricing: BlockScanStateSnapshot | null = null;
  private pricingEpoch = 0;
  private fundingEpoch = 0;
  private readonly fundingPreparations = new WeakMap<StrictFundingPreparation, {
    readonly input: StrictFundingPreparationInput;
    readonly assetsKey: string;
    readonly epoch: number;
    readonly result: Promise<PromiseSettledResult<StrictProductionRuntimeSession>>;
  }>();

  constructor(
    private readonly sessionFor: StrictSessionProvider,
    private readonly resetSessions: () => void,
    private readonly onPricingPublication?: (
      publication: StrictPricingPublication,
    ) => void,
    private readonly effectivePricing?: (
      snapshot: BlockScanStateSnapshot,
      control: AdapterWorkControl,
      backend?: Pick<StateBackend, "call">,
      reuse?: { readonly previous?: EffectiveMidSnapshot;
        readonly touchedStateKeys?: ReadonlySet<string>;
        /** Explicit quote target; snapshot remains the unmodified sizing reference. */
        readonly quoteGraph?: VerifiedGraphView },
      simulationTransport?: StrictSimulationTransport,
    ) => Promise<EffectiveMidSnapshot>,
    private readonly exactQuoteCache?: AdapterFamilyExactQuoteCache,
  ) {}

  latestPricingSnapshot(): BlockScanStateSnapshot | null {
    return this.publishedPricing;
  }

  async resetDynamicStateForReplay(): Promise<void> {
    this.pricingEpoch++;
    this.fundingEpoch++;
    this.publishedPricing = null;
    this.bootstrapRawPricing = null;
    this.exactQuoteCache?.resetState();
    this.resetSessions();
  }

  private rawBasisFor(graph: VerifiedGraphView, previous: BlockScanStateSnapshot | null,
    activity?: StrictCanonicalActivityProof): BlockScanStateSnapshot | null {
    const raw = this.bootstrapRawPricing;
    if (!this.effectivePricing || raw === null || previous === null ||
        strictGraphPublicationFingerprint(raw.graph) !== strictGraphPublicationFingerprint(graph) ||
        graph.sourceBlock < previous.sourceBlock || graph.generation < previous.generation ||
        (graph.sourceBlock === previous.sourceBlock &&
          graph.sourceBlockHash.toLowerCase() !== previous.sourceBlockHash.toLowerCase()) ||
        (graph.sourceBlock === previous.sourceBlock + 1 && activity?.parentHash !== undefined &&
          activity.parentHash.toLowerCase() !== previous.sourceBlockHash.toLowerCase())) return null;
    return raw;
  }

  startFundingPreparation(
    request: StrictFundingPreparationInput,
  ): StrictFundingPreparation {
    const input = Object.freeze({
      ...request,
      fundingTokens: Object.freeze([...request.fundingTokens]),
    });
    const deadlineAtMs = Math.min(input.deadlineAtMs,
      input.preparationSettleDeadlineAtMs ?? input.deadlineAtMs);
    assertWorkOpen(deadlineAtMs, input.signal);
    // Empty exact closure requests only the existing Funding preparation.
    // Install both handlers before yielding to activity scanning.
    const result = Promise.resolve().then(() => {
      assertWorkOpen(deadlineAtMs, input.signal);
      return this.sessionFor({
        purpose: "exact-execution",
        source: sourceFor(input.graph),
        control: controlFor(deadlineAtMs, input.signal),
        fundingAssets: input.fundingTokens,
        requiredEdgeIds: new Set<string>(),
        ...(input.simulationTransport === undefined
          ? {} : { simulationTransport: input.simulationTransport }),
        ...(input.pricingCallBackend === undefined
          ? {} : { pricingCallBackend: input.pricingCallBackend }),
      });
    }).then(
      (value): PromiseSettledResult<StrictProductionRuntimeSession> =>
        ({ status: "fulfilled", value }),
      (reason): PromiseSettledResult<StrictProductionRuntimeSession> =>
        ({ status: "rejected", reason }),
    );
    const handle = Object.freeze({ settle: async () => { await result; } });
    this.fundingPreparations.set(handle, {
      input,
      assetsKey: fundingAssetsKey(input.fundingTokens),
      epoch: this.fundingEpoch,
      result,
    });
    return handle;
  }

  async prepareCoarsePricing(input: {
    readonly graph: VerifiedGraphView;
    readonly simulationTransport?: StrictSimulationTransport;
    readonly deadlineAtMs: number;
    readonly familySettleDeadlineAtMs?: number;
    readonly signal?: AbortSignal;
    readonly touchedPools?: ReadonlySet<string>;
    readonly canonicalActivity?: StrictCanonicalActivityProof;
    readonly pricingCallBackend?: Pick<StateBackend, "call">;
  }): Promise<BlockScanStatePrepareResult> {
    const simulationTransport = input.simulationTransport;
    const settleDeadlineAtMs = Math.min(
      input.deadlineAtMs,
      input.familySettleDeadlineAtMs ?? input.deadlineAtMs,
    );
    assertWorkOpen(settleDeadlineAtMs, input.signal);
    const pricingEpoch = ++this.pricingEpoch;
    const previous = this.publishedPricing;
    const rawBasis = this.rawBasisFor(input.graph, previous, input.canonicalActivity);
    const sessionPromise = Promise.resolve().then(() => this.sessionFor({
      purpose: rawBasis === null ? "coarse-pricing" : "exact-execution",
      source: sourceFor(input.graph),
      control: controlFor(settleDeadlineAtMs, input.signal),
      fundingAssets: EMPTY_FUNDING_ASSETS,
      ...(simulationTransport === undefined ? {} : { simulationTransport }),
      ...(input.pricingCallBackend === undefined
        ? {}
        : { pricingCallBackend: input.pricingCallBackend }),
      ...(rawBasis !== null ? { requiredEdgeIds: new Set<string>() }
        : this.effectivePricing === undefined && previous !== null && input.touchedPools !== undefined
          ? { touchedPools: input.touchedPools } : {}),
    }));
    const { built } = await this.preparePricing(sessionPromise, input.graph, previous, rawBasis,
      pricingEpoch, controlFor(settleDeadlineAtMs, input.signal), input.pricingCallBackend,
      input.canonicalActivity, simulationTransport);
    assertWorkOpen(settleDeadlineAtMs, input.signal);
    this.publishPricing(built, pricingEpoch);
    return completePricingResult(built.snapshot);
  }

  async prepare(
    input: PrepareStrictRuntimeInput,
  ): Promise<AdapterRuntimePrepareResult> {
    const simulationTransport = input.simulationTransport;
    const startedAtMs = Date.now();
    const settleDeadlineAtMs = Math.min(
      input.deadlineAtMs,
      input.preparationSettleDeadlineAtMs ?? input.deadlineAtMs,
    );
    assertWorkOpen(settleDeadlineAtMs, input.signal);
    const source = sourceFor(input.graph);
    const prefunding = input.fundingPreparation === undefined
      ? undefined : this.fundingPreparations.get(input.fundingPreparation);
    if (input.fundingPreparation !== undefined && (
      prefunding === undefined ||
      prefunding.epoch !== this.fundingEpoch ||
      prefunding.input.graph !== input.graph ||
      prefunding.assetsKey !== fundingAssetsKey(input.fundingTokens) ||
      prefunding.input.signal !== input.signal ||
      prefunding.input.deadlineAtMs !== input.deadlineAtMs ||
      prefunding.input.preparationSettleDeadlineAtMs !==
        input.preparationSettleDeadlineAtMs ||
      prefunding.input.pricingCallBackend !== input.pricingCallBackend ||
      prefunding.input.simulationTransport !== simulationTransport
    )) {
      throw new Error("strict Funding preparation differs from current pass");
    }
    const pricingEpoch = ++this.pricingEpoch;
    const sessionStartedAtMs = Date.now();
    const previous = this.publishedPricing;
    const rawBasis = this.rawBasisFor(input.graph, previous, input.canonicalActivity);
    const sessionPromise = Promise.resolve().then(() => this.sessionFor({
      purpose: rawBasis === null ? "source-n-runtime" : "exact-execution",
      source,
      control: controlFor(settleDeadlineAtMs, input.signal),
      ...(simulationTransport === undefined ? {} : { simulationTransport }),
      fundingAssets: prefunding === undefined
        ? input.fundingTokens : EMPTY_FUNDING_ASSETS,
      ...(rawBasis !== null ? { requiredEdgeIds: new Set<string>() }
        : this.effectivePricing === undefined && previous !== null && input.touchedPools !== undefined
          ? { touchedPools: input.touchedPools } : {}),
      ...(input.pricingCallBackend === undefined
        ? {}
        : { pricingCallBackend: input.pricingCallBackend }),
    }));
    const executionStartedAtMs = Date.now();
    const executionPromise = input.prepareExecution === undefined
      ? Promise.resolve()
      : Promise.resolve().then(() => input.prepareExecution!({
          generation: source.generation,
          sourceBlock: source.number,
          sourceBlockHash: source.hash,
          deadlineAtMs: settleDeadlineAtMs,
          signal: input.signal ?? new AbortController().signal,
        }));
    const pricingPromise = this.preparePricing(sessionPromise, input.graph, previous, rawBasis,
      pricingEpoch, controlFor(settleDeadlineAtMs, input.signal), input.pricingCallBackend,
      input.canonicalActivity, simulationTransport);
    const [pricingResult, executionResult, fundingResult] = await Promise.allSettled([
      pricingPromise,
      executionPromise,
      prefunding?.result,
    ] as const);
    if (pricingResult.status === "rejected") throw pricingResult.reason;
    if (executionResult.status === "rejected") throw executionResult.reason;
    if (fundingResult.status === "rejected") throw fundingResult.reason;
    const preparedFunding = fundingResult.value;
    if (preparedFunding?.status === "rejected") throw preparedFunding.reason;
    const { session, built } = pricingResult.value;
    const fundingSession = preparedFunding?.value ?? session;
    if (prefunding !== undefined && prefunding.epoch !== this.fundingEpoch) {
      throw new Error("strict Funding preparation retired during join");
    }
    assertSessionGraphSource(fundingSession, input.graph);
    const executionMs = input.prepareExecution === undefined
      ? 0
      : Math.max(0, Date.now() - executionStartedAtMs);
    assertWorkOpen(input.deadlineAtMs, input.signal);
    const pricing = built.snapshot;
    const pricingMs = Math.max(0, Date.now() - sessionStartedAtMs);
    const funding = buildStrictFundingSnapshot(
      fundingSession.fundingProjection(prefunding === undefined
        ? undefined : controlFor(settleDeadlineAtMs, input.signal)),
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
    const canonicalStartedAtMs = Date.now();
    if (input.validateBeforePublish !== undefined) {
      assertWorkOpen(settleDeadlineAtMs, input.signal);
      await input.validateBeforePublish();
      // Validation yields: shutdown, deadline or a newer preparation may have
      // retired this work. publishPricing performs the final epoch check.
      assertWorkOpen(settleDeadlineAtMs, input.signal);
    }
    const finalCanonicalCasMs = input.validateBeforePublish === undefined
      ? 0 : Math.max(0, Date.now() - canonicalStartedAtMs);
    this.publishPricing(built, pricingEpoch);
    const finishedAtMs = Date.now();
    const timing: AdapterRuntimePrepareTiming = Object.freeze({
      startedAtMs,
      finishedAtMs,
      wallMs: Math.max(0, finishedAtMs - startedAtMs),
      pricingMs,
      fundingMs: 0,
      executionMs,
      finalCanonicalCasMs,
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

  /** One preparation path for bootstrap and steady producers; one atomic join. */
  private async preparePricing(
    sessionPromise: Promise<StrictProductionRuntimeSession>,
    graph: VerifiedGraphView,
    previous: BlockScanStateSnapshot | null,
    rawBasis: BlockScanStateSnapshot | null,
    pricingEpoch: number,
    control: AdapterWorkControl,
    backend?: Pick<StateBackend, "call">,
    activity?: StrictCanonicalActivityProof,
    simulationTransport?: StrictSimulationTransport,
  ): Promise<{ session: StrictProductionRuntimeSession; built: StrictPricingBuildResult }> {
    // Raw is immutable after bootstrap, but effective/local Exact state still
    // obeys the Ready's environment-sensitive refresh policy every block.
    if (activity !== undefined && previous?.perBlockRefreshStateKeys?.length) {
      activity = { ...activity, touchedStateKeys: new Set([
        ...activity.touchedStateKeys, ...previous.perBlockRefreshStateKeys,
      ]) };
    }
    // A new raw epoch cannot reuse state authorized by an old graph/reorg.
    this.exactQuoteCache?.advanceState(sourceFor(graph),
      this.effectivePricing && rawBasis === null ? undefined : activity);
    const raw = sessionPromise.then(session => {
      // Soft Family settlement may return degraded coverage while the outer
      // runtime pass is still open. Cancellation, unlike that deadline, retires it.
      if (control.signal?.aborted) throw control.signal.reason ?? new Error("strict current runtime aborted");
      assertSessionGraphSource(session, graph);
      const built = rawBasis === null
        ? buildStrictPricingSnapshot(session, graph, {
            previous: this.effectivePricing === undefined ? previous : null, canonicalActivity: activity,
          })
        : { snapshot: rawBasis };
      return { session, built };
    });
    const quote = this.effectivePricing;
    if (!quote) {
      const result = await raw;
      if (!("publication" in result.built)) throw new Error("raw pricing publication missing");
      return { session: result.session, built: result.built };
    }
    const effective = (async () => {
      // Startup ordering is unchanged. Steady P sizing always uses the ORIGINAL
      // raw source and coverage; quoteGraph independently binds current Exact.
      const sizing = rawBasis ?? (await raw).built.snapshot;
      assertWorkOpen(control.deadlineAtMs ?? Infinity, control.signal);
      return quote(sizing, control, backend, {
        previous: rawBasis === null ? undefined : previous?.effectiveMids,
        quoteGraph: rawBasis === null ? undefined : graph,
        touchedStateKeys: rawBasis !== null && activityAllowsEffectiveCarry(previous, graph, activity)
          ? activity.touchedStateKeys : undefined,
      }, simulationTransport);
    })();
    // A rejection cannot leave the sibling pricing work detached from the
    // producer's existing cancellation/drain boundary.
    const [rawResult, effectiveResult] = await Promise.allSettled([raw, effective]);
    if (rawResult.status === "rejected") throw rawResult.reason;
    if (effectiveResult.status === "rejected") throw effectiveResult.reason;
    const { session, built } = rawResult.value;
    const effectiveMids = effectiveResult.value;
    // Retired/reset preparations must not overwrite the published table.
    // The amount builder itself rejects late quotes.
    if (pricingEpoch !== this.pricingEpoch) throw new Error("pricing publication retired during prepare");
    const source = sourceFor(graph);
    if (effectiveMids.source.number !== source.number ||
        effectiveMids.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
        effectiveMids.source.generation !== source.generation) {
      throw new Error("effective pricing incomplete or mismatched source");
    }
    assertWorkOpen(control.deadlineAtMs ?? Infinity, control.signal);
    if (!effectiveMids.complete) throw new Error("effective pricing incomplete or mismatched source");
    return { session, built: buildEffectivePricingSnapshot(built.snapshot, graph,
      session.pricingIndex(), effectiveMids, rawBasis === null ? null : previous) };
  }

  private publishPricing(built: StrictPricingBuildResult, pricingEpoch: number): void {
    if (pricingEpoch !== this.pricingEpoch) throw new Error("pricing publication retired during prepare");
    if (built.rawBasis !== undefined) this.bootstrapRawPricing = built.rawBasis;
    this.publishedPricing = built.snapshot;
    try {
      this.onPricingPublication?.(built.publication);
    } catch {
      // Historical evidence is fail-open and cannot suppress pricing.
    }
  }

  async prepareCurrentNExactExecutionContext(
    input: PrepareCurrentNExactExecutionContextInput,
  ): Promise<CurrentNExactExecutionContextResult> {
    const simulationTransport = input.simulationTransport;
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
      ...(simulationTransport === undefined ? {} : { simulationTransport }),
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

function activityAllowsEffectiveCarry(previous: BlockScanStateSnapshot | null,
  graph: VerifiedGraphView, activity: StrictCanonicalActivityProof | undefined,
): activity is StrictCanonicalActivityProof {
  if (previous === null || activity?.complete !== true ||
      !sameCanonicalSource(activity.source, sourceFor(graph))) return false;
  const base = activity.previousSource;
  if (base !== undefined && (base.number !== previous.sourceBlock ||
      base.hash.toLowerCase() !== previous.sourceBlockHash.toLowerCase())) return false;
  if (graph.sourceBlock === previous.sourceBlock) {
    return graph.sourceBlockHash.toLowerCase() === previous.sourceBlockHash.toLowerCase() &&
      graph.generation >= previous.generation;
  }
  // Only a complete range rooted in the still-published table can bridge a
  // cancelled/coalesced block. A naked forward source remains insufficient.
  if (base !== undefined) return graph.sourceBlock > previous.sourceBlock && graph.generation > previous.generation;
  return graph.sourceBlock === previous.sourceBlock + 1 && graph.generation > previous.generation &&
    activity.parentHash?.toLowerCase() === previous.sourceBlockHash.toLowerCase();
}

/** The current publication owns effective coverage; raw retains its startup
 * source/map and supplies sizing only. It is never promoted to current state. */
function buildEffectivePricingSnapshot(raw: BlockScanStateSnapshot,
  graph: VerifiedGraphView, index: StrictReadyPricingIndex, effectiveMids: EffectiveMidSnapshot,
  previous: BlockScanStateSnapshot | null,
): StrictPricingBuildResult {
  const expectedEdgeKeys = [...index.expectedEdgeKeys].sort();
  const expected = new Set(expectedEdgeKeys);
  const graphEdges = new Map(graph.edges.map(edge => [blockScanEdgeKey(edge), edge]));
  const scannerKeys = graph.edges.filter(scannerConsumesEdge).map(blockScanEdgeKey);
  if (expected.size !== expectedEdgeKeys.length ||
      exactSetHash(expectedEdgeKeys) !== index.expectedEdgeKeyHash ||
      index.readyGraphContractFingerprint !== strictReadyGraphContractFingerprint(graph.edges) ||
      scannerKeys.length !== graph.scannerEdgeCount || exactSetHash(scannerKeys) !== graph.scannerEdgeKeyHash ||
      scannerKeys.some(key => !expected.has(key)) || [...effectiveMids.rows.keys()].some(key => !expected.has(key))) {
    throw new Error("effective pricing index differs from ready Graph");
  }
  const resolvedEdgeKeys: string[] = [], unavailableEdgeKeys: string[] = [], unresolvedEdgeKeys: string[] = [];
  const refreshedEdgeKeys: string[] = [], carriedEdgeKeys: string[] = [];
  const coverageByEdgeKey = new Map<string, StateKeyCoverage>();
  const pricingProvenanceByEdgeKey = new Map<string, StrictPricingProvenance>();
  const familyIds = new Set<string>(), incompleteFamilyIds = new Set<string>();
  for (const key of expectedEdgeKeys) {
    const edge = graphEdges.get(key), familyId = index.familyIdByEdgeKey.get(key);
    if (!edge || !familyId || !index.stateKeyByEdgeKey.has(key)) {
      throw new Error(`effective pricing index omits ${key}`);
    }
    familyIds.add(familyId);
    const row = effectiveMids.rows.get(key);
    if (row && (row.edgeId !== key || row.instanceKey !== edgeInstanceKey(edge) ||
        row.tokenIn.toLowerCase() !== edge.tokenIn.toLowerCase() || row.tokenOut.toLowerCase() !== edge.tokenOut.toLowerCase())) {
      throw new Error(`effective pricing row differs from ready Graph: ${key}`);
    }
    if (row?.status === "quoted") {
      if (row.amountIn === null || row.amountIn <= 0n || row.amountOut === null || row.amountOut <= 0n ||
          row.effectiveMid === null || !Number.isFinite(row.effectiveMid) || row.effectiveMid <= 0) {
        throw new Error(`invalid effective pricing row: ${key}`);
      }
      resolvedEdgeKeys.push(key);
      const carried = effectiveMidRowCarried(effectiveMids, row);
      (carried ? carriedEdgeKeys : refreshedEdgeKeys).push(key);
      pricingProvenanceByEdgeKey.set(key, carried ? "carried" : "refreshed");
      coverageByEdgeKey.set(key, Object.freeze({ status: "resolved" }));
    } else if (row?.status === "no-output" || row?.status === "unsupported") {
      unavailableEdgeKeys.push(key);
      pricingProvenanceByEdgeKey.set(key, "unavailable");
      coverageByEdgeKey.set(key, Object.freeze({ status: "rejected", reason: `effective-${row.status}` }));
    } else {
      unresolvedEdgeKeys.push(key);
      incompleteFamilyIds.add(familyId);
      pricingProvenanceByEdgeKey.set(key, "unresolved");
      coverageByEdgeKey.set(key, Object.freeze({ status: "unresolved", reason: `effective-${row?.status ?? "missing-row"}` }));
    }
  }
  const coverage: BlockScanStateCoverage = Object.freeze({
    ...raw.coverage,
    expectedEdgeKeys: Object.freeze(expectedEdgeKeys),
    resolvedEdgeKeys: Object.freeze(resolvedEdgeKeys),
    unavailableEdgeKeys: Object.freeze(unavailableEdgeKeys),
    unresolvedEdgeKeys: Object.freeze(unresolvedEdgeKeys),
    refreshedEdgeKeys: Object.freeze(refreshedEdgeKeys),
    carriedEdgeKeys: Object.freeze(carriedEdgeKeys),
    expectedEdgeKeyHash: index.expectedEdgeKeyHash,
    resolvedEdgeKeyHash: exactSetHash(resolvedEdgeKeys),
    unavailableEdgeKeyHash: exactSetHash(unavailableEdgeKeys),
    unresolvedEdgeKeyHash: exactSetHash(unresolvedEdgeKeys),
    refreshedEdgeKeyHash: exactSetHash(refreshedEdgeKeys),
    carriedEdgeKeyHash: exactSetHash(carriedEdgeKeys),
  });
  const snapshot: BlockScanStateSnapshot = Object.freeze({
    ...raw, generation: graph.generation, sourceBlock: graph.sourceBlock,
    sourceBlockHash: graph.sourceBlockHash, graph,
    rawMidSource: Object.freeze({ number: raw.sourceBlock, hash: raw.sourceBlockHash, generation: raw.generation }),
    mids: raw.mids, effectiveMids, coverage, coverageByEdgeKey,
    perBlockRefreshStateKeys: index.perBlockRefreshStateKeys,
    pricingStateKeyByEdgeKey: index.stateKeyByEdgeKey,
    pricingFamilyIdByEdgeKey: index.familyIdByEdgeKey,
    pricingProvenanceByEdgeKey,
    resolvedFamilyIds: Object.freeze([...familyIds].filter(id => !incompleteFamilyIds.has(id)).sort()),
    incompleteFamilyIds: Object.freeze([...incompleteFamilyIds].sort()),
  });
  const graphFingerprint = strictGraphPublicationFingerprint(graph);
  const publication: StrictPricingPublication = previous === null
    ? Object.freeze({ kind: "baseline", graphFingerprint, snapshot })
    : Object.freeze({ kind: "delta", graphFingerprint,
        previousGeneration: previous.generation, previousSourceBlock: previous.sourceBlock,
        previousSourceBlockHash: previous.sourceBlockHash,
        updates: Object.freeze([]), removals: Object.freeze([]), snapshot });
  return Object.freeze({ snapshot, publication, rawBasis: raw });
}

function buildStrictPricingSnapshot(
  session: StrictProductionRuntimeSession,
  graph: VerifiedGraphView,
  input: {
    readonly previous: BlockScanStateSnapshot | null;
    readonly canonicalActivity?: StrictCanonicalActivityProof;
  },
): StrictPricingBuildResult {
  assertSessionGraphSource(session, graph);
  const sessionCoveredEdgeIds = new Set(session.edges.map(blockScanEdgeKey));
  const pricingIndex = session.pricingIndex();
  const perBlockRefresh = new Set(pricingIndex.perBlockRefreshStateKeys);
  const graphFingerprint = strictGraphPublicationFingerprint(graph);
  // Pricing capability is independent of strategy admission. A declared
  // Credit quote can be displayed without making a standing debt searchable.
  const pricedEdgeKeys = new Set(pricingIndex.expectedEdgeKeys);
  const scannerKeys = graph.edges.filter(scannerConsumesEdge).map(blockScanEdgeKey);
  if (
    scannerKeys.length !== graph.scannerEdgeCount ||
    exactSetHash(scannerKeys) !== graph.scannerEdgeKeyHash ||
    scannerKeys.some(key => !pricedEdgeKeys.has(key)) ||
    pricedEdgeKeys.size !== pricingIndex.expectedEdgeKeys.length ||
    exactSetHash([...pricedEdgeKeys]) !== pricingIndex.expectedEdgeKeyHash ||
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
    previous.coverage.expectedEdgeKeys.length === pricedEdgeKeys.size &&
    previous.coverage.expectedEdgeKeyHash === pricingIndex.expectedEdgeKeyHash &&
    previous.coverageByEdgeKey.size === pricedEdgeKeys.size &&
    previous.pricingProvenanceByEdgeKey !== undefined &&
    previous.pricingProvenanceByEdgeKey.size === pricedEdgeKeys.size &&
    previous.pricingStateKeyByEdgeKey !== undefined &&
    previous.pricingStateKeyByEdgeKey.size === pricedEdgeKeys.size &&
    previous.pricingFamilyIdByEdgeKey !== undefined &&
    previous.pricingFamilyIdByEdgeKey.size === pricedEdgeKeys.size;
  const previousForDelta = canDeltaPublish ? previous : null;
  const fullMids = canDeltaPublish ? null : new Map<string, RouteVenueMid>();
  const midUpdates: (readonly [string, RouteVenueMid])[] = [];
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
        midUpdates.push(Object.freeze([edgeKey, mid] as const));
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
    const edgeKey = blockScanEdgeKey(edge);
    if (!pricedEdgeKeys.has(edgeKey)) continue;
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
      const carried = perBlockRefresh.has(stateKey) ? null : compatibleCarryForEdge({
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
    expectedEdgeKeys.length !== pricedEdgeKeys.size ||
    expectedEdgeKeyHash !== pricingIndex.expectedEdgeKeyHash
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
  const snapshot: BlockScanStateSnapshot = Object.freeze({
    perBlockRefreshStateKeys: pricingIndex.perBlockRefreshStateKeys,
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
  const publication: StrictPricingPublication = canDeltaPublish
    ? Object.freeze({
        kind: "delta" as const,
        graphFingerprint,
        previousGeneration: previousForDelta!.generation,
        previousSourceBlock: previousForDelta!.sourceBlock,
        previousSourceBlockHash: previousForDelta!.sourceBlockHash,
        updates: Object.freeze(midUpdates),
        removals: Object.freeze(midRemovals),
        snapshot,
      })
    : Object.freeze({
        kind: "baseline" as const,
        graphFingerprint,
        snapshot,
      });
  return Object.freeze({ snapshot, publication });
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

function fundingAssetsKey(assets: readonly string[]): string {
  return [...new Set(assets.map((asset) => asset.toLowerCase()))].sort().join(",");
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

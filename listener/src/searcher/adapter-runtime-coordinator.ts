import { ethers } from "ethers";
import type { StateBackend } from "../shared/state/state-backend.js";
import {
  BlockScanStateCoordinator,
  type BlockScanLaggingTopologyRefreshMode,
  type BlockScanStateIssue,
  type BlockScanStatePrepareResult,
  type BlockScanStateSnapshot,
} from "./blockscan-state-coordinator.js";
import type { JsonRpcBlockScanStateReadBackend } from "./blockscan-state-read-backend.js";
import type { FlashLiquidityView, FlashSource } from "./solver/flash-liquidity.js";
import type { AdapterFamilyRegistry } from "./venues/adapter-family-registry.js";
import {
  exactSetHash,
  type BlockSource,
  type StateFreshnessProof,
  type StateKeyCoverage,
  type StateReadResult,
  type VerifiedGraphView,
} from "./venues/blockscan-state-capability.js";
import {
  fundingReadId,
  type FundingOffer,
  type FundingSource,
  type PreparedFundingFamily,
  type RegisteredFundingFamily,
} from "./venues/funding/funding-capability.js";

export interface FlashFundingCoverage {
  readonly expectedKeys: readonly string[];
  readonly resolvedKeys: readonly string[];
  readonly unresolvedKeys: readonly string[];
  readonly expectedHash: string;
  readonly resolvedHash: string;
  readonly unresolvedHash: string;
}

export type FlashFundingFreshnessProof = StateFreshnessProof | {
  /** Source-pinned RequestProgram completion issued by the central runtime. */
  readonly kind: "strict-work";
  readonly source: BlockSource;
  readonly subjectKey: string;
  readonly dedupeKey: string;
  readonly trustedResultsFingerprint: string;
  readonly evidenceFingerprint: string;
};

export class FlashFundingSnapshot implements FlashLiquidityView {
  readonly sources: ReadonlyMap<string, FlashSource>;

  constructor(
    readonly generation: number,
    readonly sourceBlock: number,
    readonly sourceBlockHash: string,
    readonly coverage: FlashFundingCoverage,
    readonly coverageByFundingId: ReadonlyMap<string, StateKeyCoverage>,
    readonly freshnessByFundingId: ReadonlyMap<
      string,
      ReadonlyMap<string, FlashFundingFreshnessProof>
    >,
    sources: ReadonlyMap<string, FlashSource>,
  ) {
    this.sources = new FrozenReadonlyMap(
      [...sources.entries()]
        .map(([token, source]) => [
          token.toLowerCase(),
          Object.freeze({ ...source }),
        ] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    this.coverageByFundingId = new FrozenReadonlyMap([
      ...coverageByFundingId.entries(),
    ]);
    this.freshnessByFundingId = new FrozenReadonlyMap(
      [...freshnessByFundingId.entries()].map(([fundingId, freshness]) => [
        fundingId,
        new FrozenReadonlyMap([...freshness.entries()]),
      ]),
    );
    Object.freeze(this);
  }

  borrowable(token: string): bigint {
    return this.sources.get(token.toLowerCase())?.amount ?? 0n;
  }

  source(token: string): FlashSource | null {
    return this.sources.get(token.toLowerCase()) ?? null;
  }
}

export interface AdapterRuntimeSnapshot {
  readonly completeness: "complete" | "degraded";
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly graph: VerifiedGraphView;
  readonly pricing: BlockScanStateSnapshot;
  readonly funding: FlashFundingSnapshot;
}

export interface CurrentNExactExecutionContext {
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly graph: VerifiedGraphView;
  readonly funding: FlashFundingSnapshot;
}

export type CurrentNExactExecutionContextResult =
  | {
      readonly status: "complete" | "degraded";
      readonly context: CurrentNExactExecutionContext;
      readonly fundingCoverage: FlashFundingCoverage;
      readonly issues: readonly BlockScanStateIssue[];
      readonly timing: Readonly<{
        startedAtMs: number;
        finishedAtMs: number;
        wallMs: number;
        fundingMs: number;
        executionMs: number;
        finalCanonicalCasMs: number;
      }>;
    }
  | {
      readonly status: "incomplete";
      readonly context?: never;
      readonly fundingCoverage: FlashFundingCoverage;
      readonly issues: readonly BlockScanStateIssue[];
      readonly timing: Readonly<{
        startedAtMs: number;
        finishedAtMs: number;
        wallMs: number;
        fundingMs: number;
        executionMs: number;
        finalCanonicalCasMs: number;
      }>;
    };

export interface AdapterRuntimePrepareTiming {
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly wallMs: number;
  readonly pricingMs: number;
  readonly fundingMs: number;
  readonly executionMs: number;
  readonly finalCanonicalCasMs: number;
}

export type AdapterRuntimePrepareResult =
  | {
      readonly status: "complete";
      readonly snapshot: AdapterRuntimeSnapshot;
      readonly pricing: BlockScanStatePrepareResult;
      readonly fundingCoverage: FlashFundingCoverage;
      readonly issues: readonly BlockScanStateIssue[];
      readonly timing?: AdapterRuntimePrepareTiming;
    }
  | {
      readonly status: "degraded";
      readonly snapshot: AdapterRuntimeSnapshot;
      readonly pricing: BlockScanStatePrepareResult;
      readonly fundingCoverage: FlashFundingCoverage;
      readonly issues: readonly BlockScanStateIssue[];
      readonly timing?: AdapterRuntimePrepareTiming;
    }
  | {
      readonly status: "incomplete";
      readonly snapshot?: never;
      readonly pricing: BlockScanStatePrepareResult;
      readonly fundingCoverage: FlashFundingCoverage;
      readonly issues: readonly BlockScanStateIssue[];
      readonly timing?: AdapterRuntimePrepareTiming;
    };

export interface PrepareAdapterRuntimeInput {
  readonly graph: VerifiedGraphView;
  readonly fundingTokens: readonly string[];
  /** Outer generation deadline retained for the final canonical CAS. */
  readonly deadlineAtMs: number;
  /**
   * Earlier boundary for pricing, funding and execution preparation. The
   * outer controller remains live after this boundary so the final canonical
   * publication fence cannot lose its reserved time.
   */
  readonly preparationSettleDeadlineAtMs?: number;
  /**
   * Earlier hot-path pricing cutoff. It leaves the generation controller alive
   * for funding, execution preparation and the final canonical publication
   * fence; timed-out pricing families remain explicit and current-source
   * scoped.
   */
  readonly pricingFamilySettleDeadlineAtMs?: number;
  /**
   * Explicit startup/steady-state contract for families whose topology
   * completeness proof is lagging. The coordinator forwards it unchanged.
   */
  readonly pricingLaggingTopologyRefreshMode?:
    BlockScanLaggingTopologyRefreshMode;
  /**
   * Warm generations persist each resolved state key's raw reads for the
   * resumable-warm cache; hot generations only read from it.
   */
  readonly cacheMode?: "warm" | "hot";
  /**
   * Current-block touched pools (physical venue identities: pool address for
   * pair venues, poolId for singleton-manager venues). When set, the strict
   * session refreshes current pricing only for these instances; the other
   * instances simply have no current mid this block (the scanner's touched
   * filter keeps enumeration over this block's venues).
   */
  readonly touchedPools?: ReadonlySet<string>;
  /** Canonical block activity proof used for strict sparse-read carry. */
  readonly canonicalActivity?: {
    readonly source: BlockSource;
    readonly touchedStateKeys: ReadonlySet<string>;
    readonly complete: true;
  };
  /** Optional source-pinned physical transport for producer eth_call batching. */
  readonly pricingCallBackend?: Pick<StateBackend, "call">;
  readonly signal?: AbortSignal;
  /**
   * Current-N exact/final-sim workers (for example isolated Anvil forks).
   * The returned promise must settle only after every child operation it
   * started has settled and any failed/aborted resources have been disposed.
   */
  readonly prepareExecution?: (input: {
    readonly generation: number;
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
    readonly deadlineAtMs: number;
    readonly signal: AbortSignal;
  }) => Promise<void>;
}

export interface PrepareCurrentNExactExecutionContextInput {
  readonly graph: VerifiedGraphView;
  readonly fundingTokens: readonly string[];
  readonly deadlineAtMs: number;
  readonly preparationSettleDeadlineAtMs?: number;
  readonly signal?: AbortSignal;
  readonly prepareExecution?: PrepareAdapterRuntimeInput["prepareExecution"];
  /** Venue-scope for the exact session's instance reissue; see strict session. */
  readonly touchedPools?: ReadonlySet<string>;
  readonly requiredEdgeIds?: ReadonlySet<string>;
}

/**
 * One current-N activation boundary for graph, route pricing and flash funding.
 * Publication is atomic: incomplete pricing or one unresolved required lender
 * balance cannot leave a half-new runtime visible to the scanner/planner.
 */
export class AdapterRuntimeCoordinator {
  private published: AdapterRuntimeSnapshot | null = null;
  /**
   * A deadline may stop waiting for execution preparation, but it cannot
   * cancel arbitrary work already running inside the callback. Keep the raw
   * callback promise as a settle barrier so a later generation never reuses
   * those execution resources while an older generation can still mutate
   * them.
   */
  private executionPreparationSettled: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: AdapterFamilyRegistry,
    private readonly pricing: BlockScanStateCoordinator,
    private readonly reads: Pick<
      JsonRpcBlockScanStateReadBackend,
      "readPinned" | "verifyCanonicalSource"
    >,
  ) {}

  latestSnapshot(): AdapterRuntimeSnapshot | null {
    return this.published;
  }

  latestPricingSnapshot(): BlockScanStateSnapshot | null {
    return this.pricing.latestSnapshot();
  }

  /**
   * Background coarse producer. It updates only the pricing coordinator's
   * independently proven snapshot; it never publishes a normal atomic runtime
   * and therefore cannot donate stale funding or worker state.
   */
  async prepareCoarsePricing(input: {
    readonly graph: VerifiedGraphView;
    readonly deadlineAtMs: number;
    readonly familySettleDeadlineAtMs?: number;
    readonly laggingTopologyRefreshMode?: BlockScanLaggingTopologyRefreshMode;
    readonly signal?: AbortSignal;
  }): Promise<BlockScanStatePrepareResult> {
    return await this.pricing.prepare({
      graph: input.graph,
      families: this.registry.blockScanStateFamilies(),
      requiresPricing: (edge) => this.registry.isBlockScanPricedEdge(edge),
      deadlineAtMs: input.deadlineAtMs,
      familySettleDeadlineAtMs: input.familySettleDeadlineAtMs,
      laggingTopologyRefreshMode:
        input.laggingTopologyRefreshMode ?? "proof-scoped",
      signal: input.signal,
    });
  }

  /**
   * Trusted historical blind-run hook. It waits for every execution-prep
   * mutation to settle, then drops only dynamic source state. Static family
   * schemas remain owned by the pricing coordinator.
   */
  async resetDynamicStateForReplay(): Promise<void> {
    await this.executionPreparationSettled;
    this.pricing.resetDynamicStateForReplay();
    this.published = null;
  }

  async prepare(input: PrepareAdapterRuntimeInput): Promise<AdapterRuntimePrepareResult> {
    const startedAtMs = Date.now();
    let pricingMs = 0;
    let fundingMs = 0;
    let executionMs = 0;
    let finalCanonicalCasMs = 0;
    const timing = (): AdapterRuntimePrepareTiming => {
      const finishedAtMs = Date.now();
      return Object.freeze({
        startedAtMs,
        finishedAtMs,
        wallMs: Math.max(0, finishedAtMs - startedAtMs),
        pricingMs,
        fundingMs,
        executionMs,
        finalCanonicalCasMs,
      });
    };
    const controller = new AbortController();
    const detach = linkAbort(input.signal, controller);
    const remainingMs = input.deadlineAtMs - Date.now();
    const preparationSettleDeadlineAtMs = Math.min(
      input.deadlineAtMs,
      input.preparationSettleDeadlineAtMs ?? input.deadlineAtMs,
    );
    if (!Number.isFinite(preparationSettleDeadlineAtMs)) {
      throw new Error(
        `invalid adapter runtime preparation deadline ` +
          `${String(input.preparationSettleDeadlineAtMs)}`,
      );
    }
    const deadlineTimer = setTimeout(
      () => controller.abort(new AdapterRuntimeDeadline()),
      Math.max(0, remainingMs),
    );
    const preparationController = new AbortController();
    const detachPreparation = linkAbort(
      controller.signal,
      preparationController,
    );
    const preparationTimer = setTimeout(
      () =>
        preparationController.abort(
          new AdapterRuntimePreparationDeadline(),
        ),
      Math.max(0, preparationSettleDeadlineAtMs - Date.now()),
    );
    try {
      if (remainingMs <= 0) controller.abort(new AdapterRuntimeDeadline());
      if (preparationSettleDeadlineAtMs <= Date.now()) {
        preparationController.abort(
          controller.signal.aborted
            ? controller.signal.reason
            : new AdapterRuntimePreparationDeadline(),
        );
      }
      const [pricing, funding, executionIssue] = await Promise.all([
        measureWallMs(() => this.pricing.prepare({
          graph: input.graph,
          families: this.registry.blockScanStateFamilies(),
          requiresPricing: (edge) => this.registry.isBlockScanPricedEdge(edge),
          deadlineAtMs: input.deadlineAtMs,
          familySettleDeadlineAtMs: Math.min(
            preparationSettleDeadlineAtMs,
            input.pricingFamilySettleDeadlineAtMs ??
              preparationSettleDeadlineAtMs,
          ),
          laggingTopologyRefreshMode:
            input.pricingLaggingTopologyRefreshMode ?? "proof-scoped",
          cacheMode: input.cacheMode ?? "hot",
          // Pricing owns family-local settlement and still needs the outer
          // generation signal for its canonical CAS. Aborting it at the
          // preparation boundary would erase healthy sibling results.
          signal: controller.signal,
        }), (wallMs) => {
          pricingMs = wallMs;
        }),
        measureWallMs(() => this.prepareFunding(
          input.graph,
          input.fundingTokens,
          preparationSettleDeadlineAtMs,
          input.deadlineAtMs,
          preparationController.signal,
          controller.signal,
        ), (wallMs) => {
          fundingMs = wallMs;
        }),
        input.prepareExecution
          ? measureWallMs(() => this.prepareExecution(
              input,
              preparationSettleDeadlineAtMs,
              preparationController.signal,
            ), (wallMs) => {
              executionMs = wallMs;
            })
          : Promise.resolve(null),
      ]);
      clearTimeout(preparationTimer);
      detachPreparation();
      let finalCanonicalIssue: BlockScanStateIssue | null = null;
      if (
        pricing.status !== "incomplete" &&
        funding.snapshot &&
        !executionIssue &&
        !controller.signal.aborted
      ) {
        const finalCanonicalCasStartedAtMs = Date.now();
        try {
          await awaitWithAbort(
            this.reads.verifyCanonicalSource(
              Object.freeze({
                number: input.graph.sourceBlock,
                hash: input.graph.sourceBlockHash,
                generation: input.graph.generation,
              }),
              controller.signal,
            ),
            controller.signal,
          );
          if (
            controller.signal.aborted ||
            Date.now() >= input.deadlineAtMs
          ) {
            throw controller.signal.reason ?? new AdapterRuntimeDeadline();
          }
        } catch (error) {
          finalCanonicalIssue = runtimeIssue(
            "adapter runtime final canonical CAS failed",
            error,
            controller.signal,
          );
        } finally {
          finalCanonicalCasMs = Math.max(
            0,
            Date.now() - finalCanonicalCasStartedAtMs,
          );
        }
      }
      const runtimeAbortIssue = controller.signal.aborted
        ? runtimeIssue(
            "adapter runtime preparation failed",
            controller.signal.reason,
            controller.signal,
          )
        : null;
      const issues = Object.freeze([
        ...pricing.issues,
        ...funding.issues,
        ...(executionIssue ? [executionIssue] : []),
        ...(finalCanonicalIssue ? [finalCanonicalIssue] : []),
        ...(runtimeAbortIssue ? [runtimeAbortIssue] : []),
      ]);
      if (
        pricing.status === "incomplete" ||
        !funding.snapshot ||
        executionIssue ||
        finalCanonicalIssue ||
        runtimeAbortIssue
      ) {
        return Object.freeze({
          status: "incomplete" as const,
          pricing,
          fundingCoverage: funding.coverage,
          issues,
          timing: timing(),
        });
      }
      const snapshot: AdapterRuntimeSnapshot = Object.freeze({
        completeness:
          pricing.status === "degraded" || funding.status === "degraded"
            ? "degraded"
            : "complete",
        generation: input.graph.generation,
        sourceBlock: input.graph.sourceBlock,
        sourceBlockHash: input.graph.sourceBlockHash,
        graph: input.graph,
        pricing: pricing.snapshot,
        funding: funding.snapshot,
      });
      const previous = this.published;
      if (
        previous &&
        (snapshot.generation <= previous.generation ||
          snapshot.sourceBlock < previous.sourceBlock)
      ) {
        return Object.freeze({
          status: "incomplete" as const,
          pricing,
          fundingCoverage: funding.coverage,
          issues: Object.freeze([
            ...issues,
            {
              kind: "stale-generation" as const,
              message:
                `runtime generation ${snapshot.generation} is not newer than ` +
                previous.generation,
              },
            ]),
          timing: timing(),
        });
      }
      this.published = snapshot;
      return Object.freeze({
        status: snapshot.completeness,
        snapshot,
        pricing,
        fundingCoverage: funding.coverage,
        issues,
        timing: timing(),
      });
    } finally {
      clearTimeout(preparationTimer);
      detachPreparation();
      clearTimeout(deadlineTimer);
      detach();
    }
  }

  /**
   * Prepare only the current-N resources needed after a coarse candidate has
   * been found. Pricing is intentionally absent: planner admission remains
   * gated by a separate whole-route current-N exact quote.
   */
  async prepareCurrentNExactExecutionContext(
    input: PrepareCurrentNExactExecutionContextInput,
  ): Promise<CurrentNExactExecutionContextResult> {
    const startedAtMs = Date.now();
    let fundingMs = 0;
    let executionMs = 0;
    let finalCanonicalCasMs = 0;
    const timing = () => {
      const finishedAtMs = Date.now();
      return Object.freeze({
        startedAtMs,
        finishedAtMs,
        wallMs: Math.max(0, finishedAtMs - startedAtMs),
        fundingMs,
        executionMs,
        finalCanonicalCasMs,
      });
    };
    const controller = new AbortController();
    const detach = linkAbort(input.signal, controller);
    const settleDeadlineAtMs = Math.min(
      input.deadlineAtMs,
      input.preparationSettleDeadlineAtMs ?? input.deadlineAtMs,
    );
    if (!Number.isFinite(settleDeadlineAtMs)) {
      throw new Error(
        `invalid exact execution preparation deadline ` +
          `${String(input.preparationSettleDeadlineAtMs)}`,
      );
    }
    const deadlineTimer = setTimeout(
      () => controller.abort(new AdapterRuntimeDeadline()),
      Math.max(0, input.deadlineAtMs - Date.now()),
    );
    const preparationController = new AbortController();
    const detachPreparation = linkAbort(
      controller.signal,
      preparationController,
    );
    const preparationTimer = setTimeout(
      () =>
        preparationController.abort(
          new AdapterRuntimePreparationDeadline(),
        ),
      Math.max(0, settleDeadlineAtMs - Date.now()),
    );
    try {
      if (input.deadlineAtMs <= Date.now()) {
        controller.abort(new AdapterRuntimeDeadline());
      }
      if (settleDeadlineAtMs <= Date.now()) {
        preparationController.abort(
          controller.signal.aborted
            ? controller.signal.reason
            : new AdapterRuntimePreparationDeadline(),
        );
      }
      const [funding, executionIssue] = await Promise.all([
        measureWallMs(() => this.prepareFunding(
          input.graph,
          input.fundingTokens,
          settleDeadlineAtMs,
          input.deadlineAtMs,
          preparationController.signal,
          controller.signal,
        ), (wallMs) => {
          fundingMs = wallMs;
        }),
        input.prepareExecution
          ? measureWallMs(() => this.prepareExecution(
              input,
              settleDeadlineAtMs,
              preparationController.signal,
            ), (wallMs) => {
              executionMs = wallMs;
            })
          : Promise.resolve(null),
      ]);
      clearTimeout(preparationTimer);
      detachPreparation();

      let finalCanonicalIssue: BlockScanStateIssue | null = null;
      if (
        funding.snapshot &&
        !executionIssue &&
        !controller.signal.aborted
      ) {
        const finalCanonicalCasStartedAtMs = Date.now();
        try {
          await awaitWithAbort(
            this.reads.verifyCanonicalSource(
              Object.freeze({
                number: input.graph.sourceBlock,
                hash: input.graph.sourceBlockHash,
                generation: input.graph.generation,
              }),
              controller.signal,
            ),
            controller.signal,
          );
          if (
            controller.signal.aborted ||
            Date.now() >= input.deadlineAtMs
          ) {
            throw controller.signal.reason ?? new AdapterRuntimeDeadline();
          }
        } catch (error) {
          finalCanonicalIssue = runtimeIssue(
            "exact execution context final canonical CAS failed",
            error,
            controller.signal,
          );
        } finally {
          finalCanonicalCasMs = Math.max(
            0,
            Date.now() - finalCanonicalCasStartedAtMs,
          );
        }
      }
      const runtimeAbortIssue = controller.signal.aborted
        ? runtimeIssue(
            "exact execution context preparation failed",
            controller.signal.reason,
            controller.signal,
          )
        : null;
      const issues = Object.freeze([
        ...funding.issues,
        ...(executionIssue ? [executionIssue] : []),
        ...(finalCanonicalIssue ? [finalCanonicalIssue] : []),
        ...(runtimeAbortIssue ? [runtimeAbortIssue] : []),
      ]);
      if (
        !funding.snapshot ||
        executionIssue ||
        finalCanonicalIssue ||
        runtimeAbortIssue
      ) {
        return Object.freeze({
          status: "incomplete" as const,
          fundingCoverage: funding.coverage,
          issues,
          timing: timing(),
        });
      }
      const context: CurrentNExactExecutionContext = Object.freeze({
        generation: input.graph.generation,
        sourceBlock: input.graph.sourceBlock,
        sourceBlockHash: input.graph.sourceBlockHash,
        graph: input.graph,
        funding: funding.snapshot,
      });
      return Object.freeze({
        status:
          funding.status === "degraded" ? "degraded" as const : "complete" as const,
        context,
        fundingCoverage: funding.coverage,
        issues,
        timing: timing(),
      });
    } finally {
      clearTimeout(preparationTimer);
      detachPreparation();
      clearTimeout(deadlineTimer);
      detach();
    }
  }

  private async prepareExecution(
    input: Pick<
      PrepareAdapterRuntimeInput,
      "graph" | "prepareExecution"
    >,
    preparationSettleDeadlineAtMs: number,
    signal: AbortSignal,
  ): Promise<BlockScanStateIssue | null> {
    const previous = this.executionPreparationSettled;
    const preparation = previous.then(async () => {
      if (signal.aborted) throw signal.reason;
      await input.prepareExecution!({
        generation: input.graph.generation,
        sourceBlock: input.graph.sourceBlock,
        sourceBlockHash: input.graph.sourceBlockHash,
        deadlineAtMs: preparationSettleDeadlineAtMs,
        signal,
      });
    });
    // Store the raw operation's settlement, not the abortable waiter below.
    // The current generation can still return its terminal deadline promptly;
    // only later execution preparation waits for the orphan to really finish.
    this.executionPreparationSettled = preparation.then(
      () => undefined,
      () => undefined,
    );
    return await awaitWithAbort(preparation, signal).then(
      () => null,
      (error): BlockScanStateIssue =>
        runtimeIssue("execution preparation failed", error, signal),
    );
  }

  private async prepareFunding(
    graph: VerifiedGraphView,
    tokensInput: readonly string[],
    familySettleDeadlineAtMs: number,
    deadlineAtMs: number,
    preparationSignal: AbortSignal,
    runtimeSignal: AbortSignal,
  ): Promise<{
    readonly status: "complete" | "degraded" | "incomplete";
    readonly coverage: FlashFundingCoverage;
    readonly snapshot: FlashFundingSnapshot | null;
    readonly issues: readonly BlockScanStateIssue[];
  }> {
    const tokens = [...new Set(tokensInput.map(normalizeAddress))].sort();
    const source = Object.freeze({
      number: graph.sourceBlock,
      hash: graph.sourceBlockHash,
      generation: graph.generation,
    });
    const families = this.registry.fundingStateFamilies();
    const fundingIssues: BlockScanStateIssue[] = [];
    const described = families.map((family) => {
      try {
        assertFundingActive(
          preparationSignal,
          familySettleDeadlineAtMs,
        );
        const sources = Object.freeze([...family.describeSources(tokens)]);
        assertFundingActive(
          preparationSignal,
          familySettleDeadlineAtMs,
        );
        return Object.freeze({
          family,
          sources,
          descriptionFailed: false as const,
        });
      } catch (error) {
        fundingIssues.push({
          ...runtimeIssue(
            "funding source description failed",
            error,
            preparationSignal,
          ),
          familyId: family.familyId,
        });
        return Object.freeze({
          family,
          sources: Object.freeze([] as FundingSource[]),
          descriptionFailed: true as const,
          descriptionError: error,
        });
      }
    });
    const expectedKeys = Object.freeze(
      described.flatMap(({ sources }) => sources.map((item) => item.fundingId)).sort(),
    );
    const outcomes = await Promise.all(
      described.map(async ({
        family,
        sources,
        ...description
      }) => {
        if (description.descriptionFailed) {
          return Object.freeze({
            settled: unresolvedFundingFamily(
              family,
              sources,
              description.descriptionError instanceof Error
                ? description.descriptionError.message
                : String(description.descriptionError),
            ),
            issue: null,
          });
        }
        const familyController = new AbortController();
        const detachFamily = linkAbort(
          preparationSignal,
          familyController,
        );
        const familyDeadline = new AdapterRuntimePreparationDeadline(
          family.familyId,
        );
        const familyTimer = setTimeout(
          () => familyController.abort(familyDeadline),
          Math.max(0, familySettleDeadlineAtMs - Date.now()),
        );
        if (familySettleDeadlineAtMs <= Date.now()) {
          familyController.abort(
            preparationSignal.aborted
              ? preparationSignal.reason
              : familyDeadline,
          );
        }
        try {
          const signal = familyController.signal;
          assertFundingActive(signal, familySettleDeadlineAtMs);
          const preparation = Promise.resolve().then(() => {
            assertFundingActive(signal, familySettleDeadlineAtMs);
            return family.prepare({
              assets: tokens,
              source,
              control: {
                deadlineAtMs: familySettleDeadlineAtMs,
                signal,
              },
            });
          });
          const prepared: PreparedFundingFamily = await awaitWithAbort(
            preparation,
            signal,
          );
          // A family may ignore AbortSignal internally. The waiter above
          // returns promptly on abort; these checks fence a result that wins
          // the promise race only after its local deadline.
          assertFundingActive(signal, familySettleDeadlineAtMs);
          assertFundingSourcesExact(family, sources, prepared.sources);
          const raw = prepared.reads.length === 0
            ? []
            : await awaitWithAbort(
                Promise.resolve().then(() => {
                  assertFundingActive(signal, familySettleDeadlineAtMs);
                  return this.reads.readPinned(prepared.reads, {
                    sourceBlock: graph.sourceBlock,
                    sourceBlockHash: graph.sourceBlockHash,
                    sourceGeneration: graph.generation,
                    deadlineAtMs: familySettleDeadlineAtMs,
                    signal,
                  });
                }),
                signal,
              );
          assertFundingActive(signal, familySettleDeadlineAtMs);
          const expected = prepared.reads.map((read) => read.id);
          const exact = exactResults(
            expected,
            raw,
            graph.sourceBlock,
            graph.sourceBlockHash,
            graph.generation,
          );
          if (!exact.exact) {
            throw new Error(
              "funding backend response IDs/provenance were not exact",
            );
          }
          const decoded = prepared.decodeAndDerive([...exact.byId.values()]);
          assertFundingActive(signal, familySettleDeadlineAtMs);
          assertFundingCoverageExact(sources, decoded.decodedCoverage);
          assertFundingOffersExact(
            sources,
            decoded.derived.coverageByFundingId,
          );
          return Object.freeze({
            settled: Object.freeze({
              family,
              sources,
              prepared,
              resultsById: exact.byId,
              offers: decoded.derived.offers,
              coverageByFundingId: decoded.derived.coverageByFundingId,
              decodedCoverage: decoded.decodedCoverage,
              failed: false as const,
            }),
            issue: null,
          });
        } catch (error) {
          return Object.freeze({
            settled: unresolvedFundingFamily(
              family,
              sources,
              error instanceof Error ? error.message : String(error),
            ),
            issue: Object.freeze({
              ...runtimeIssue(
                "funding preparation failed",
                error,
                familyController.signal,
              ),
              familyId: family.familyId,
            }),
          });
        } finally {
          clearTimeout(familyTimer);
          detachFamily();
        }
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.issue) fundingIssues.push(outcome.issue);
    }
    const settled = outcomes.map((outcome) => outcome.settled);
    if (runtimeSignal.aborted || Date.now() >= deadlineAtMs) {
      if (
        !runtimeSignal.aborted &&
        !fundingIssues.some((issue) => issue.kind === "deadline")
      ) {
        fundingIssues.push({
          ...runtimeIssue(
            "funding preparation failed",
            new AdapterRuntimeDeadline(),
            runtimeSignal,
          ),
        });
      }
      const coverage = createFundingCoverage(expectedKeys, []);
      return Object.freeze({
        status: "incomplete" as const,
        coverage,
        snapshot: null,
        issues: Object.freeze(fundingIssues),
      });
    }
    const coverageByFundingId = new Map<string, StateKeyCoverage>();
    const freshnessByFundingId = new Map<
      string,
      ReadonlyMap<string, StateFreshnessProof>
    >();
    const allOffers = new Map<string, FundingOffer>();
    for (const family of settled) {
      for (const fundingSource of family.sources) {
        const fundingCoverage = family.coverageByFundingId.get(
          fundingSource.fundingId,
        ) ?? Object.freeze({
          status: "unresolved" as const,
          reason: "family omitted funding coverage",
        });
        coverageByFundingId.set(fundingSource.fundingId, fundingCoverage);
        const offer = family.offers.get(fundingSource.fundingId);
        if (fundingCoverage.status !== "resolved" || !offer) continue;
        allOffers.set(fundingSource.fundingId, offer);
        const readFreshness = new Map<string, StateFreshnessProof>();
        for (const readKey of fundingSource.requiredReadKeys) {
          const result = family.resultsById.get(
            fundingReadId(fundingSource.stateKey, readKey),
          );
          if (!result?.ok) {
            coverageByFundingId.set(fundingSource.fundingId, Object.freeze({
              status: "unresolved" as const,
              reason: `resolved offer lacks current-N provenance for ${readKey}`,
            }));
            allOffers.delete(fundingSource.fundingId);
            readFreshness.clear();
            break;
          }
          readFreshness.set(readKey, Object.freeze({
            kind: "direct-read" as const,
            source,
            provenance: result.provenance,
          }));
        }
        if (readFreshness.size === fundingSource.requiredReadKeys.length) {
          freshnessByFundingId.set(
            fundingSource.fundingId,
            new FrozenReadonlyMap([...readFreshness.entries()]),
          );
        }
      }
    }
    const resolvedKeys = expectedKeys.filter(
      (fundingId) =>
        coverageByFundingId.get(fundingId)?.status === "resolved" &&
        allOffers.has(fundingId),
    );
    const coverage = createFundingCoverage(expectedKeys, resolvedKeys);
    const sources = new Map<string, FlashSource>();
    for (const token of tokens) {
      let best: FundingOffer | null = null;
      for (const candidate of allOffers.values()) {
        if (candidate.asset.toLowerCase() !== token) continue;
        if (
          !best ||
          candidate.maxBorrow > best.maxBorrow ||
          (candidate.maxBorrow === best.maxBorrow &&
            candidate.liquidityPriority < best.liquidityPriority)
        ) {
          best = candidate;
        }
      }
      if (best && best.maxBorrow > 0n) {
        sources.set(token, Object.freeze({
          amount: best.maxBorrow,
          adapterId: best.actionAdapterId,
          fundingId: best.fundingId,
        }));
      }
    }
    return Object.freeze({
      status: coverage.unresolvedKeys.length > 0 ||
          settled.some((family) => family.failed) ||
          fundingIssues.length > 0
        ? "degraded" as const
        : "complete" as const,
      coverage,
      snapshot: new FlashFundingSnapshot(
        graph.generation,
        graph.sourceBlock,
        graph.sourceBlockHash,
        coverage,
        coverageByFundingId,
        freshnessByFundingId,
        sources,
      ),
      issues: Object.freeze(fundingIssues),
    });
  }
}

class AdapterRuntimeDeadline extends Error {
  constructor(message = "adapter runtime deadline reached") {
    super(message);
    this.name = "AdapterRuntimeDeadline";
  }
}

class AdapterRuntimePreparationDeadline extends AdapterRuntimeDeadline {
  constructor(familyId?: string) {
    super(
      familyId
        ? `funding family ${familyId} preparation deadline reached`
        : "adapter runtime preparation deadline reached",
    );
    this.name = "AdapterRuntimePreparationDeadline";
  }
}

function runtimeIssue(
  prefix: string,
  error: unknown,
  signal: AbortSignal,
): BlockScanStateIssue {
  const reason = signal.aborted ? signal.reason : error;
  return Object.freeze({
    kind: reason instanceof AdapterRuntimeDeadline
      ? "deadline"
      : signal.aborted
        ? "aborted"
        : "backend",
    message: `${prefix}: ${reason instanceof Error ? reason.message : String(reason)}`,
  });
}

function assertFundingActive(
  signal: AbortSignal,
  deadlineAtMs: number,
): void {
  if (signal.aborted) throw signal.reason;
  if (Date.now() >= deadlineAtMs) {
    throw new AdapterRuntimePreparationDeadline();
  }
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function exactResults(
  expected: readonly string[],
  results: readonly StateReadResult[],
  sourceBlock: number,
  sourceBlockHash: string,
  sourceGeneration: number,
): {
  readonly exact: boolean;
  readonly byId: ReadonlyMap<string, StateReadResult>;
} {
  const expectedSet = new Set(expected);
  const byId = new Map<string, StateReadResult>();
  let exact = results.length === expected.length;
  for (const result of results) {
    if (
      !expectedSet.has(result.id) ||
      byId.has(result.id) ||
      result.sourceBlock !== sourceBlock ||
      result.sourceBlockHash.toLowerCase() !== sourceBlockHash.toLowerCase() ||
      result.ok && (
        result.provenance.source.number !== sourceBlock ||
        result.provenance.source.hash.toLowerCase() !== sourceBlockHash.toLowerCase() ||
        result.provenance.source.generation !== sourceGeneration
      )
    ) {
      exact = false;
      continue;
    }
    byId.set(result.id, result);
  }
  if (byId.size !== expectedSet.size) exact = false;
  return Object.freeze({ exact, byId });
}

function createFundingCoverage(
  expectedInput: readonly string[],
  resolvedInput: readonly string[],
): FlashFundingCoverage {
  const expectedKeys = Object.freeze([...new Set(expectedInput)].sort());
  const resolvedKeys = Object.freeze(
    [...new Set(resolvedInput)]
      .filter((key) => expectedKeys.includes(key))
      .sort(),
  );
  const resolved = new Set(resolvedKeys);
  const unresolvedKeys = Object.freeze(
    expectedKeys.filter((key) => !resolved.has(key)),
  );
  return Object.freeze({
    expectedKeys,
    resolvedKeys,
    unresolvedKeys,
    expectedHash: exactSetHash(expectedKeys),
    resolvedHash: exactSetHash(resolvedKeys),
    unresolvedHash: exactSetHash(unresolvedKeys),
  });
}

function assertFundingSourcesExact(
  family: RegisteredFundingFamily,
  expected: readonly FundingSource[],
  actual: readonly FundingSource[],
): void {
  const fingerprint = (sources: readonly FundingSource[]) =>
    exactSetHash(sources.map((source) =>
      `${source.fundingId}\u001f${source.stateKey}\u001f` +
      `${source.instanceKey}\u001f${source.provider.toLowerCase()}\u001f` +
      `${source.asset.toLowerCase()}\u001f${[...source.requiredReadKeys].sort().join(",")}`
    ));
  if (fingerprint(expected) !== fingerprint(actual)) {
    throw new Error(
      `funding family ${family.familyId} changed sources during preparation`,
    );
  }
}

function assertFundingCoverageExact(
  sources: readonly FundingSource[],
  coverage: ReadonlyMap<string, ReadonlyMap<string, StateKeyCoverage>>,
): void {
  const expectedStateKeys = sources.map((source) => source.stateKey).sort();
  if (
    exactSetHash(expectedStateKeys) !== exactSetHash([...coverage.keys()].sort())
  ) {
    throw new Error("funding family returned non-partitioned state coverage");
  }
  for (const source of sources) {
    const reads = coverage.get(source.stateKey);
    if (
      !reads ||
      exactSetHash([...source.requiredReadKeys].sort()) !==
        exactSetHash([...reads.keys()].sort())
    ) {
      throw new Error(
        `funding family returned non-partitioned read coverage for ${source.stateKey}`,
      );
    }
  }
}

function assertFundingOffersExact(
  sources: readonly FundingSource[],
  coverage: ReadonlyMap<string, StateKeyCoverage>,
): void {
  if (
    exactSetHash(sources.map((source) => source.fundingId).sort()) !==
    exactSetHash([...coverage.keys()].sort())
  ) {
    throw new Error("funding family returned non-partitioned funding coverage");
  }
}

function unresolvedFundingFamily(
  family: RegisteredFundingFamily,
  sources: readonly FundingSource[],
  reason: string,
): {
  readonly family: RegisteredFundingFamily;
  readonly sources: readonly FundingSource[];
  readonly resultsById: ReadonlyMap<string, StateReadResult>;
  readonly offers: ReadonlyMap<string, FundingOffer>;
  readonly coverageByFundingId: ReadonlyMap<string, StateKeyCoverage>;
  readonly decodedCoverage: ReadonlyMap<
    string,
    ReadonlyMap<string, StateKeyCoverage>
  >;
  readonly failed: true;
} {
  const unresolved = Object.freeze({
    status: "unresolved" as const,
    reason,
  });
  return Object.freeze({
    family,
    sources,
    resultsById: new Map(),
    offers: new Map(),
    coverageByFundingId: new Map(
      sources.map((source) => [source.fundingId, unresolved]),
    ),
    decodedCoverage: new Map(
      sources.map((source) => [
        source.stateKey,
        new Map(source.requiredReadKeys.map((readKey) => [readKey, unresolved])),
      ]),
    ),
    failed: true as const,
  });
}

function normalizeAddress(address: string): string {
  return ethers.getAddress(address).toLowerCase();
}

function linkAbort(
  parent: AbortSignal | undefined,
  child: AbortController,
): () => void {
  if (!parent) return () => {};
  const abort = (): void => child.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

async function measureWallMs<T>(
  operation: () => Promise<T>,
  record: (wallMs: number) => void,
): Promise<T> {
  const startedAtMs = Date.now();
  try {
    return await operation();
  } finally {
    record(Math.max(0, Date.now() - startedAtMs));
  }
}

class FrozenReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(entries: readonly (readonly [K, V])[]) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#map.size; }
  has(key: K): boolean { return this.#map.has(key); }
  get(key: K): V | undefined { return this.#map.get(key); }
  entries(): MapIterator<[K, V]> { return this.#map.entries(); }
  keys(): MapIterator<K> { return this.#map.keys(); }
  values(): MapIterator<V> { return this.#map.values(); }
  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#map) {
      callbackfn.call(thisArg, value, key, this);
    }
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#map[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return "FrozenReadonlyMap"; }
}

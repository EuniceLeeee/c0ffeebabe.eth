import { ethers } from "ethers";
import {
  BlockScanStateCoordinator,
  type BlockScanStateIssue,
  type BlockScanStatePrepareResult,
  type BlockScanStateSnapshot,
} from "./blockscan-state-coordinator.js";
import type { JsonRpcBlockScanStateReadBackend } from "./blockscan-state-read-backend.js";
import type { FlashLiquidityView, FlashSource } from "./solver/flash-liquidity.js";
import type { AdapterFamilyRegistry } from "./venues/adapter-family-registry.js";
import {
  exactSetHash,
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
      ReadonlyMap<string, StateFreshnessProof>
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

export type AdapterRuntimePrepareResult =
  | {
      readonly status: "complete";
      readonly snapshot: AdapterRuntimeSnapshot;
      readonly pricing: BlockScanStatePrepareResult;
      readonly fundingCoverage: FlashFundingCoverage;
      readonly issues: readonly BlockScanStateIssue[];
    }
  | {
      readonly status: "degraded";
      readonly snapshot: AdapterRuntimeSnapshot;
      readonly pricing: BlockScanStatePrepareResult;
      readonly fundingCoverage: FlashFundingCoverage;
      readonly issues: readonly BlockScanStateIssue[];
    }
  | {
      readonly status: "incomplete";
      readonly snapshot?: never;
      readonly pricing: BlockScanStatePrepareResult;
      readonly fundingCoverage: FlashFundingCoverage;
      readonly issues: readonly BlockScanStateIssue[];
    };

export interface PrepareAdapterRuntimeInput {
  readonly graph: VerifiedGraphView;
  readonly fundingTokens: readonly string[];
  readonly deadlineAtMs: number;
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
    private readonly reads: Pick<JsonRpcBlockScanStateReadBackend, "readPinned">,
  ) {}

  latestSnapshot(): AdapterRuntimeSnapshot | null {
    return this.published;
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
    const controller = new AbortController();
    const detach = linkAbort(input.signal, controller);
    const remainingMs = input.deadlineAtMs - Date.now();
    const deadlineTimer = setTimeout(
      () => controller.abort(new AdapterRuntimeDeadline()),
      Math.max(0, remainingMs),
    );
    try {
      if (remainingMs <= 0) controller.abort(new AdapterRuntimeDeadline());
      const [pricing, funding, executionIssue] = await Promise.all([
        this.pricing.prepare({
          graph: input.graph,
          families: this.registry.blockScanStateFamilies(),
          requiresPricing: (edge) => this.registry.isBlockScanPricedEdge(edge),
          deadlineAtMs: input.deadlineAtMs,
          signal: controller.signal,
        }),
        this.prepareFunding(
          input.graph,
          input.fundingTokens,
          input.deadlineAtMs,
          controller.signal,
        ),
        input.prepareExecution
          ? this.prepareExecution(input, controller.signal)
          : Promise.resolve(null),
      ]);
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
        ...(runtimeAbortIssue ? [runtimeAbortIssue] : []),
      ]);
      if (
        pricing.status === "incomplete" ||
        !funding.snapshot ||
        executionIssue ||
        runtimeAbortIssue
      ) {
        return Object.freeze({
          status: "incomplete" as const,
          pricing,
          fundingCoverage: funding.coverage,
          issues,
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
        });
      }
      this.published = snapshot;
      return Object.freeze({
        status: snapshot.completeness,
        snapshot,
        pricing,
        fundingCoverage: funding.coverage,
        issues,
      });
    } finally {
      clearTimeout(deadlineTimer);
      detach();
    }
  }

  private prepareExecution(
    input: PrepareAdapterRuntimeInput,
    signal: AbortSignal,
  ): Promise<BlockScanStateIssue | null> {
    const previous = this.executionPreparationSettled;
    const preparation = previous.then(async () => {
      if (signal.aborted) throw signal.reason;
      await input.prepareExecution!({
        generation: input.graph.generation,
        sourceBlock: input.graph.sourceBlock,
        sourceBlockHash: input.graph.sourceBlockHash,
        deadlineAtMs: input.deadlineAtMs,
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
    return awaitWithAbort(preparation, signal).then(
      () => null,
      (error): BlockScanStateIssue =>
        runtimeIssue("execution preparation failed", error, signal),
    );
  }

  private async prepareFunding(
    graph: VerifiedGraphView,
    tokensInput: readonly string[],
    deadlineAtMs: number,
    signal: AbortSignal,
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
        assertFundingActive(signal, deadlineAtMs);
        const sources = Object.freeze([...family.describeSources(tokens)]);
        assertFundingActive(signal, deadlineAtMs);
        return Object.freeze({
          family,
          sources,
          descriptionFailed: false as const,
        });
      } catch (error) {
        fundingIssues.push({
          ...runtimeIssue("funding source description failed", error, signal),
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
    const outcomes = await Promise.allSettled(
      described.map(async ({
        family,
        sources,
        ...description
      }) => {
        if (description.descriptionFailed) {
          return unresolvedFundingFamily(
            family,
            sources,
            description.descriptionError instanceof Error
              ? description.descriptionError.message
              : String(description.descriptionError),
          );
        }
        assertFundingActive(signal, deadlineAtMs);
        const preparation = Promise.resolve().then(() => {
          assertFundingActive(signal, deadlineAtMs);
          return family.prepare({
            assets: tokens,
            source,
            control: { deadlineAtMs, signal },
          });
        });
        const prepared: PreparedFundingFamily = await awaitWithAbort(
          preparation,
          signal,
        );
        // A family may ignore AbortSignal internally. The waiter above returns
        // promptly on abort; these checks fence a result that wins the promise
        // race only after its deadline from reaching decode or publication.
        assertFundingActive(signal, deadlineAtMs);
        assertFundingSourcesExact(family, sources, prepared.sources);
        const raw = prepared.reads.length === 0
          ? []
          : await awaitWithAbort(
              Promise.resolve().then(() => {
                assertFundingActive(signal, deadlineAtMs);
                return this.reads.readPinned(prepared.reads, {
                  sourceBlock: graph.sourceBlock,
                  sourceBlockHash: graph.sourceBlockHash,
                  sourceGeneration: graph.generation,
                  deadlineAtMs,
                  signal,
                });
              }),
              signal,
            );
        assertFundingActive(signal, deadlineAtMs);
        const expected = prepared.reads.map((read) => read.id);
        const exact = exactResults(
          expected,
          raw,
          graph.sourceBlock,
          graph.sourceBlockHash,
          graph.generation,
        );
        if (!exact.exact) {
          throw new Error("funding backend response IDs/provenance were not exact");
        }
        const decoded = prepared.decodeAndDerive([...exact.byId.values()]);
        assertFundingActive(signal, deadlineAtMs);
        assertFundingCoverageExact(sources, decoded.decodedCoverage);
        assertFundingOffersExact(sources, decoded.derived.coverageByFundingId);
        return Object.freeze({
          family,
          sources,
          prepared,
          resultsById: exact.byId,
          offers: decoded.derived.offers,
          coverageByFundingId: decoded.derived.coverageByFundingId,
          decodedCoverage: decoded.decodedCoverage,
          failed: false as const,
        });
      }),
    );
    const settled = outcomes.map((outcome, index) => {
      if (outcome.status === "fulfilled") return outcome.value;
      const { family, sources } = described[index];
      const error = outcome.reason;
      fundingIssues.push({
        ...runtimeIssue("funding preparation failed", error, signal),
        familyId: family.familyId,
      });
      return unresolvedFundingFamily(
        family,
        sources,
        error instanceof Error ? error.message : String(error),
      );
    });
    if (signal.aborted || Date.now() >= deadlineAtMs) {
      if (!signal.aborted && !fundingIssues.some((issue) => issue.kind === "deadline")) {
        fundingIssues.push({
          ...runtimeIssue(
            "funding preparation failed",
            new AdapterRuntimeDeadline(),
            signal,
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
  constructor() {
    super("adapter runtime deadline reached");
    this.name = "AdapterRuntimeDeadline";
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
  if (Date.now() >= deadlineAtMs) throw new AdapterRuntimeDeadline();
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

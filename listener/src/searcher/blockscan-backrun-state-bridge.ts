import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import {
  PoolStateCache,
  type BlockScanBackrunStateSeed,
} from "./solver/pool-state-cache.js";
import type {
  BlockSource,
  PublishedStateKey,
} from "./venues/blockscan-state-capability.js";

export interface BlockScanBackrunBridgeReport {
  readonly source: BlockSource;
  readonly projectedStateKeys: readonly string[];
  readonly v2Seeds: number;
  readonly v3LiveSeeds: number;
  readonly v3TickInvalidations: number;
  readonly reorgReset: boolean;
  readonly alreadyPublished: boolean;
}

/**
 * Copy-on-publish bridge from the current-N family snapshot to the mature
 * backrun cache. Families own the typed projection; this boundary owns source
 * validation, reorg invalidation and the final cache mutation.
 */
export class BlockScanBackrunStateBridge {
  private publishedSource: BlockSource | null = null;

  constructor(private readonly cache: PoolStateCache) {}

  latestSource(): BlockSource | null {
    return this.publishedSource;
  }

  publish(snapshot: BlockScanStateSnapshot): BlockScanBackrunBridgeReport {
    const source = snapshotSource(snapshot);
    const previous = this.publishedSource;
    if (previous && source.generation < previous.generation) {
      throw new Error(
        `stale backrun bridge generation ${source.generation} < ${previous.generation}`,
      );
    }
    if (previous && source.generation === previous.generation) {
      if (!sameSource(previous, source)) {
        throw new Error(
          `backrun bridge generation ${source.generation} changed source`,
        );
      }
      return Object.freeze({
        source: previous,
        projectedStateKeys: Object.freeze([]),
        v2Seeds: 0,
        v3LiveSeeds: 0,
        v3TickInvalidations: 0,
        reorgReset: false,
        alreadyPublished: true,
      });
    }

    const staged: Array<{
      readonly stateKey: string;
      readonly state: PublishedStateKey;
      readonly seed: BlockScanBackrunStateSeed;
    }> = [];
    const identities = new Set<string>();
    for (const [stateKey, state] of [
      ...snapshot.stateByStateKey.entries(),
    ].sort(([a], [b]) => a.localeCompare(b))) {
      if (!sameSource(state.source, source)) {
        throw new Error(
          `backrun bridge state ${stateKey} is not pinned to snapshot source`,
        );
      }
      if (
        state.snapshot.familyId !== state.familyId
      ) {
        throw new Error(
          `backrun bridge state ${stateKey} lacks its family owner`,
        );
      }
      const project = state.snapshot.projectBackrunState;
      if (!project) continue;
      const seed = project(source);
      if (isThenable(seed)) {
        throw new Error("backrun state projection must be synchronous");
      }
      validateSeed(seed, source);
      const identity = seedIdentity(seed);
      if (identities.has(identity)) {
        throw new Error(`duplicate backrun bridge seed ${identity}`);
      }
      identities.add(identity);
      staged.push(Object.freeze({ stateKey, state, seed }));
    }

    const reorgReset = Boolean(
      previous &&
      (
        source.number < previous.number ||
        source.number === previous.number &&
          source.hash.toLowerCase() !== previous.hash.toLowerCase()
      ),
    );
    if (reorgReset) this.cache.clearBlockScanWarmProgress();
    const v3TickInvalidations = new Set<string>();
    if (!reorgReset) {
      for (const { state, seed } of staged) {
        if (seed.kind !== "v3-live") {
          if (state.backrunInvalidations.length > 0) {
            throw new Error(
              `non-V3 backrun seed declared an unsupported cache invalidation`,
            );
          }
          continue;
        }
        const pool = seed.state.pool.toLowerCase();
        if (state.refreshMode === "unproven-direct") {
          v3TickInvalidations.add(pool);
        }
        for (const invalidation of state.backrunInvalidations) {
          if (
            invalidation.kind !== "v3-ticks" ||
            invalidation.pool.toLowerCase() !== pool
          ) {
            throw new Error(
              `V3 backrun invalidation does not match projected pool ${pool}`,
            );
          }
          v3TickInvalidations.add(pool);
        }
      }
      this.cache.invalidateBlockScanV3Ticks(v3TickInvalidations);
    }
    this.cache.beginBlockScanPass(source.number);
    let v2Seeds = 0;
    let v3LiveSeeds = 0;
    for (const { seed } of staged) {
      if (seed.kind === "v2") {
        this.cache.seedV2(seed.state);
        v2Seeds++;
      } else {
        this.cache.seedV3Live(seed.state);
        v3LiveSeeds++;
      }
    }
    this.publishedSource = source;
    return Object.freeze({
      source,
      projectedStateKeys: Object.freeze(
        staged.map((entry) => entry.stateKey),
      ),
      v2Seeds,
      v3LiveSeeds,
      v3TickInvalidations: v3TickInvalidations.size,
      reorgReset,
      alreadyPublished: false,
    });
  }

  resetDynamicStateForReplay(): void {
    this.cache.clearBlockScanWarmProgress();
    this.publishedSource = null;
  }
}

/**
 * Backrun hints and block-scan state share one cache. Hold the newest family
 * snapshot while a hint is consuming the cache, then publish it at the first
 * idle boundary. A malformed projection clears same-height dynamic seeds and
 * leaves the existing victim overlay/JIT fallback available.
 */
export class BufferedBlockScanBackrunStatePublisher {
  private pending: BlockScanStateSnapshot | null = null;

  constructor(
    private readonly bridge: BlockScanBackrunStateBridge,
    private readonly isBusy: () => boolean,
  ) {}

  publish(snapshot: BlockScanStateSnapshot): void {
    if (this.isBusy()) {
      if (!this.pending || snapshot.generation > this.pending.generation) {
        this.pending = snapshot;
      }
      return;
    }
    this.apply(snapshot);
  }

  flush(): void {
    if (this.isBusy() || !this.pending) return;
    const snapshot = this.pending;
    this.pending = null;
    this.apply(snapshot);
  }

  private apply(snapshot: BlockScanStateSnapshot): void {
    try {
      const report = this.bridge.publish(snapshot);
      if (report.reorgReset) {
        console.warn(
          `[searcher/live] backrun state bridge reset on canonical replacement ` +
            `block=${report.source.number} generation=${report.source.generation}`,
        );
      }
    } catch (error) {
      this.bridge.resetDynamicStateForReplay();
      console.warn(
        `[searcher/live] backrun state bridge failed closed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function snapshotSource(snapshot: BlockScanStateSnapshot): BlockSource {
  if (
    snapshot.graph.generation !== snapshot.generation ||
    snapshot.graph.sourceBlock !== snapshot.sourceBlock ||
    snapshot.graph.sourceBlockHash.toLowerCase() !==
      snapshot.sourceBlockHash.toLowerCase()
  ) {
    throw new Error("backrun bridge snapshot/graph source mismatch");
  }
  return Object.freeze({
    number: snapshot.sourceBlock,
    hash: snapshot.sourceBlockHash,
    generation: snapshot.generation,
  });
}

function validateSeed(
  seed: BlockScanBackrunStateSeed,
  source: BlockSource,
): void {
  if (!seed || !seed.state.pool || seed.state.blockNumber !== source.number) {
    throw new Error("backrun bridge seed is not pinned to the snapshot block");
  }
  if (seed.kind === "v2") {
    if (
      !seed.state.token0 ||
      !seed.state.token1 ||
      seed.state.reserve0 < 0n ||
      seed.state.reserve1 < 0n ||
      seed.state.feeBps < 0n
    ) {
      throw new Error(`invalid V2 backrun bridge seed ${seed.state.pool}`);
    }
    return;
  }
  if (
    seed.state.sqrtPriceX96 <= 0n ||
    seed.state.liquidity <= 0n ||
    !Number.isSafeInteger(seed.state.tick)
  ) {
    throw new Error(`invalid V3 backrun bridge seed ${seed.state.pool}`);
  }
}

function seedIdentity(seed: BlockScanBackrunStateSeed): string {
  return `${seed.kind}\u001f${seed.state.pool.toLowerCase()}`;
}

function sameSource(a: BlockSource, b: BlockSource): boolean {
  return (
    a.number === b.number &&
    a.generation === b.generation &&
    a.hash.toLowerCase() === b.hash.toLowerCase()
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

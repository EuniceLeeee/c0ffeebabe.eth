import { ethers } from "ethers";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "./planner/token-graph.js";
import {
  buildTokenGraphWithResults,
  buildTokenIndex,
  type PoolGraphBuildFailure,
} from "./planner/token-graph.js";
import {
  mergeDexDiscoveryReadControls,
  mergePoolProjectionRows,
  sendDexDiscoveryRpc,
  type DexDiscoveryReadControl,
} from "./active-pool-discovery.js";
import {
  poolProjectionRowKey,
  poolRegistryKey,
} from "./pool-universe.js";
import type { StrategyViews } from "./strategy-views.js";
import {
  edgeExecutionVariantKey,
  edgeInstanceKey,
} from "./venues/route-instance-identity.js";

export interface DexGraphCoverageState {
  /** Highest contiguous block whose discovery sources have been scanned. */
  readonly sourceCompleteThrough: number;
  /** Highest block whose every discovered pool has executable graph edges. */
  readonly graphCompleteThrough: number;
}

export interface DexGraphCoverageScan {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly blocksBack: number;
}

export interface PinnedDexReadBackend {
  readonly sourceBlock: number;
  call(req: {
    to: string;
    data: string;
    blockTag?: ethers.BlockTag;
  }, control?: DexDiscoveryReadControl): Promise<string>;
  getCode(
    address: string,
    control?: DexDiscoveryReadControl,
  ): Promise<string>;
}

export function createDexGraphCoverageState(input: {
  readonly sourceCompleteThrough: number;
  readonly graphCompleteThrough: number;
}): DexGraphCoverageState {
  const { sourceCompleteThrough, graphCompleteThrough } = input;
  for (const [label, value] of [
    ["sourceCompleteThrough", sourceCompleteThrough],
    ["graphCompleteThrough", graphCompleteThrough],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < -1) {
      throw new Error(`invalid DEX graph coverage ${label}=${value}`);
    }
  }
  if (graphCompleteThrough > sourceCompleteThrough) {
    throw new Error(
      `DEX graph coverage ${graphCompleteThrough} exceeds source coverage ` +
        sourceCompleteThrough,
    );
  }
  return Object.freeze({ sourceCompleteThrough, graphCompleteThrough });
}

/**
 * A failed graph projection must not erase source coverage. Catch-up always
 * starts at the first unscanned source block, never at the current head merely
 * because graphCompleteThrough is -1.
 */
export function planDexGraphCoverageScan(
  state: DexGraphCoverageState,
  targetBlock: number,
): DexGraphCoverageScan {
  if (!Number.isSafeInteger(targetBlock) || targetBlock < 0) {
    throw new Error(`invalid DEX graph target block ${targetBlock}`);
  }
  if (targetBlock < state.sourceCompleteThrough) {
    throw new Error(
      `DEX graph target ${targetBlock} precedes source coverage ` +
        state.sourceCompleteThrough,
    );
  }
  const fromBlock = state.sourceCompleteThrough < targetBlock
    ? Math.max(0, state.sourceCompleteThrough + 1)
    : targetBlock;
  return Object.freeze({
    fromBlock,
    toBlock: targetBlock,
    blocksBack: targetBlock - fromBlock,
  });
}

export function completeDexGraphCoverageScan(
  state: DexGraphCoverageState,
  scan: DexGraphCoverageScan,
  projectionComplete: boolean,
): DexGraphCoverageState {
  const expected = planDexGraphCoverageScan(state, scan.toBlock);
  if (
    scan.fromBlock !== expected.fromBlock ||
    scan.blocksBack !== expected.blocksBack
  ) {
    throw new Error(
      `non-contiguous DEX graph scan ${scan.fromBlock}-${scan.toBlock}; ` +
        `expected ${expected.fromBlock}-${expected.toBlock}`,
    );
  }
  return createDexGraphCoverageState({
    sourceCompleteThrough: scan.toBlock,
    graphCompleteThrough: projectionComplete
      ? scan.toBlock
      : state.graphCompleteThrough,
  });
}

export function assertDexSourceHashStable(
  sourceBlock: number,
  expectedHash: string,
  actualHash: string,
): void {
  const expected = normalizeDexBlockHash(expectedHash);
  const actual = normalizeDexBlockHash(actualHash);
  if (actual !== expected) {
    throw new Error(
      `DEX source block ${sourceBlock} changed ${expected} -> ${actual}`,
    );
  }
}

/**
 * DEX identity and edge projection reads for a strict generation are pinned to
 * one numeric source block. A caller-supplied different tag is rejected rather
 * than silently mixing generations. The enclosing pass must additionally
 * compare the canonical source hash before/after and publish only on equality.
 */
export function createPinnedDexReadBackend(
  provider: ethers.JsonRpcProvider,
  sourceBlock: number,
  control?: DexDiscoveryReadControl,
): PinnedDexReadBackend {
  if (!Number.isSafeInteger(sourceBlock) || sourceBlock < 0) {
    throw new Error(`invalid pinned DEX source block ${sourceBlock}`);
  }
  const blockTag = ethers.toQuantity(sourceBlock);
  return Object.freeze({
    sourceBlock,
    call: async (req: {
      to: string;
      data: string;
      blockTag?: ethers.BlockTag;
    }, nestedControl?: DexDiscoveryReadControl) => {
      if (
        req.blockTag !== undefined &&
        normalizeRequestedBlockTag(req.blockTag) !== blockTag
      ) {
        throw new Error(
          `DEX read requested block ${String(req.blockTag)} outside pinned ${sourceBlock}`,
        );
      }
      return sendDexDiscoveryRpc<string>(
        provider,
        "eth_call",
        [provider.getRpcTransaction({ to: req.to, data: req.data }), blockTag],
        mergeDexDiscoveryReadControls(control, nestedControl),
      );
    },
    getCode: (
      address: string,
      nestedControl?: DexDiscoveryReadControl,
    ) => sendDexDiscoveryRpc<string>(
      provider,
      "eth_getCode",
      [ethers.getAddress(address), blockTag],
      mergeDexDiscoveryReadControls(control, nestedControl),
    ),
  });
}

export type RuntimeStrategyViewBuilder = (
  backrunPools: PoolEntry[],
  /**
   * Supplemental universe/override rows carrying one of these projection keys
   * must not be reintroduced into the block-scan view. Base rows were already
   * filtered before this callback.
   */
  suppressedSupplementalPoolKeys?: ReadonlySet<string>,
) => StrategyViews;

export interface RuntimePoolRefreshInput {
  backend: TokenQueryBackend;
  freshPools: PoolEntry[];
  /** Pools whose edge build has already succeeded, not merely been discovered. */
  knownPoolKeys?: ReadonlySet<string>;
  currentBackrunPools: PoolEntry[];
  /** Current pool inventory feeding the block-scan view, including supplements. */
  currentBlockscanPools?: PoolEntry[];
  currentBackrunGraph: TokenEdge[];
  currentBlockscanGraph?: TokenEdge[];
  buildStrategyViews: RuntimeStrategyViewBuilder;
  /**
   * A family-local discovery/projection failure quarantines its incumbent
   * pools and edges for this generation without blocking healthy siblings.
   * The prepared delta stores exact row/edge keys so publication replay stays
   * pure and cannot depend on a later registry revision.
   */
  isolatedFamilyIds?: ReadonlySet<string>;
  /**
   * Complete uncapped pool inventory which may feed a strategy view. Required
   * for family isolation so a hidden supplemental row cannot replace the
   * visible row removed from a capped block-scan view.
   */
  isolationPoolInventory?: readonly PoolEntry[];
  /** Exact persisted rows invalidated by a successful source revalidation. */
  replacedPoolKeys?: ReadonlySet<string>;
  /** Revalidated output rows which must bypass known-pool deduplication. */
  revalidatedPoolKeys?: ReadonlySet<string>;
  /** Stale cache tombstones retained by the current publication generation. */
  suppressedPoolKeys?: ReadonlySet<string>;
  familyIdForPool?: (pool: PoolEntry) => string | null;
  familyIdForEdge?: (edge: TokenEdge) => string;
  instanceKeyForPool?: (pool: PoolEntry) => string;
}

export interface RuntimePoolRefreshSuccessfulBuild {
  readonly pool: PoolEntry;
  readonly edges: readonly TokenEdge[];
}

/**
 * RPC-free output of one DEX discovery/build pass. Keeping the newly built
 * edges separate from the aggregate projection lets the short publication
 * boundary replay this delta onto a newer protocol-only publication without
 * publishing the stale aggregate that existed when the reads began.
 */
export interface RuntimePoolRefreshDelta {
  readonly attemptedPools: readonly PoolEntry[];
  readonly successfulBuilds: readonly RuntimePoolRefreshSuccessfulBuild[];
  readonly failedPools: readonly PoolGraphBuildFailure[];
  readonly isolatedPoolKeys?: readonly string[];
  readonly isolatedEdgeKeys?: readonly string[];
  readonly replacedPoolKeys?: readonly string[];
  readonly replacedEdgeKeys?: readonly string[];
}

export interface RuntimePoolRefreshProjection {
  readonly delta: RuntimePoolRefreshDelta;
  attemptedPools: PoolEntry[];
  admittedPools: PoolEntry[];
  failedPools: PoolGraphBuildFailure[];
  strategyViews: StrategyViews;
  backrunGraph: TokenEdge[];
  blockscanGraph?: TokenEdge[];
  tokenIndex: Map<string, Set<string>>;
  poolAddressMap: Map<string, string>;
  flashTokens: string[];
  knownPoolKeys: Set<string>;
  knownPoolAddresses: Set<string>;
  suppressedPoolKeys: Set<string>;
}

/**
 * Select refresh candidates from both feeds. Declared protocol venues cannot
 * be rediscovered from swap events, so a boot-time edge-build failure stays
 * retryable through the registry feed until its key is admitted.
 */
export function selectRefreshCandidates(
  registryVenues: readonly PoolEntry[],
  discovered: readonly PoolEntry[],
  knownPoolKeys: ReadonlySet<string>,
  revalidatedPoolKeys: ReadonlySet<string> = new Set<string>(),
): PoolEntry[] {
  const isRequired = (pool: PoolEntry): boolean =>
    revalidatedPoolKeys.has(poolProjectionRowKey(pool)) ||
    !knownPoolKeys.has(poolRegistryKey(pool));
  return [
    ...registryVenues.filter(isRequired),
    ...discovered.filter(isRequired),
  ];
}

/**
 * Prepare every runtime pool projection off to the side. The caller commits
 * this object synchronously, so graph/index/map/flash/mempool consumers never
 * observe a half-refreshed state. Pools whose edge build failed are absent from
 * knownPoolKeys and will therefore be retried on the next discovery pass.
 */
export async function prepareRuntimePoolRefresh(
  input: RuntimePoolRefreshInput,
): Promise<RuntimePoolRefreshProjection> {
  const isolatedFamilyIds = input.isolatedFamilyIds ?? new Set<string>();
  const replacedPoolKeys = input.replacedPoolKeys ?? new Set<string>();
  const revalidatedPoolKeys =
    input.revalidatedPoolKeys ?? new Set<string>();
  if (
    (isolatedFamilyIds.size > 0 || replacedPoolKeys.size > 0) &&
    (
      input.familyIdForPool === undefined ||
      input.familyIdForEdge === undefined
    )
  ) {
    throw new Error(
      "runtime family isolation/replacement requires pool and edge ownership resolvers",
    );
  }
  if (
    isolatedFamilyIds.size > 0 &&
    input.isolationPoolInventory === undefined
  ) {
    throw new Error(
      "runtime family isolation requires the complete pool inventory",
    );
  }
  if (replacedPoolKeys.size > 0 && input.instanceKeyForPool === undefined) {
    throw new Error(
      "runtime pool replacement requires an instance-key resolver",
    );
  }
  const currentPoolRows = [
    ...input.currentBackrunPools,
    ...(input.currentBlockscanPools ?? []),
  ];
  const isolationPoolRows = [
    ...currentPoolRows,
    ...(input.isolationPoolInventory ?? []),
  ];
  const isolatedPoolKeys = new Set(
    isolationPoolRows.flatMap((pool) =>
      input.familyIdForPool !== undefined &&
        isolatedFamilyIds.has(input.familyIdForPool(pool) ?? "")
        ? [poolProjectionRowKey(pool)]
      : []
    ),
  );
  const replacedInstances = new Set<string>();
  for (const pool of currentPoolRows) {
    if (!replacedPoolKeys.has(poolProjectionRowKey(pool))) continue;
    const familyId = input.familyIdForPool?.(pool);
    if (familyId === null || familyId === undefined) {
      throw new Error(
        `runtime replacement cannot resolve owner for ${pool.adapter}`,
      );
    }
    replacedInstances.add(
      familyInstanceKey(familyId, input.instanceKeyForPool!(pool)),
    );
  }
  const isolatedEdgeKeys = new Set(
    [
      ...input.currentBackrunGraph,
      ...(input.currentBlockscanGraph ?? []),
    ].flatMap((edge) =>
      input.familyIdForEdge !== undefined &&
        isolatedFamilyIds.has(input.familyIdForEdge(edge))
        ? [edgeKey(edge)]
      : []
    ),
  );
  const replacedEdgeKeys = new Set(
    [
      ...input.currentBackrunGraph,
      ...(input.currentBlockscanGraph ?? []),
    ].flatMap((edge) =>
      input.familyIdForEdge !== undefined &&
        replacedInstances.has(
          familyInstanceKey(
            input.familyIdForEdge(edge),
            edgeInstanceKey(edge),
          ),
        )
        ? [edgeKey(edge)]
        : []
    ),
  );
  const currentKeys = input.knownPoolKeys ??
    new Set(input.currentBackrunPools.map(poolProjectionRowKey));
  const attemptedPools = uniquePools(input.freshPools)
    .filter((pool) =>
      revalidatedPoolKeys.has(poolProjectionRowKey(pool)) ||
      !currentKeys.has(poolRegistryKey(pool))
    )
    .filter((pool) =>
      input.familyIdForPool === undefined ||
      !isolatedFamilyIds.has(input.familyIdForPool(pool) ?? "")
    );
  const built = await buildTokenGraphWithResults(input.backend, attemptedPools);
  const delta: RuntimePoolRefreshDelta = Object.freeze({
    attemptedPools: Object.freeze([...attemptedPools]),
    successfulBuilds: Object.freeze(built.successful.map((item) =>
      Object.freeze({
        pool: item.pool,
        edges: Object.freeze([...item.edges]),
      })
    )),
    failedPools: Object.freeze([...built.failed]),
    isolatedPoolKeys: Object.freeze([...isolatedPoolKeys]),
    isolatedEdgeKeys: Object.freeze([...isolatedEdgeKeys]),
    replacedPoolKeys: Object.freeze([...replacedPoolKeys]),
    replacedEdgeKeys: Object.freeze([...replacedEdgeKeys]),
  });
  return applyRuntimePoolRefreshDelta({
    delta,
    currentBackrunPools: input.currentBackrunPools,
    currentBackrunGraph: input.currentBackrunGraph,
    ...(input.currentBlockscanGraph === undefined
      ? {}
      : { currentBlockscanGraph: input.currentBlockscanGraph }),
    knownPoolKeys: currentKeys,
    suppressedPoolKeys: input.suppressedPoolKeys,
    buildStrategyViews: input.buildStrategyViews,
  });
}

/**
 * Materialize a prepared DEX delta onto one aggregate publication. This is
 * deliberately pure: no identity, graph-build or provider read may occur in
 * the mutation queue.
 */
export function applyRuntimePoolRefreshDelta(input: {
  readonly delta: RuntimePoolRefreshDelta;
  readonly currentBackrunPools: readonly PoolEntry[];
  readonly currentBackrunGraph: readonly TokenEdge[];
  readonly currentBlockscanGraph?: readonly TokenEdge[];
  readonly knownPoolKeys?: ReadonlySet<string>;
  readonly suppressedPoolKeys?: ReadonlySet<string>;
  readonly buildStrategyViews: RuntimeStrategyViewBuilder;
}): RuntimePoolRefreshProjection {
  const isolatedPoolKeys = new Set(input.delta.isolatedPoolKeys ?? []);
  const isolatedEdgeKeys = new Set(input.delta.isolatedEdgeKeys ?? []);
  const removedPoolKeys = new Set([
    ...isolatedPoolKeys,
    ...(input.delta.replacedPoolKeys ?? []),
  ]);
  const removedEdgeKeys = new Set([
    ...isolatedEdgeKeys,
    ...(input.delta.replacedEdgeKeys ?? []),
  ]);
  const suppressedPoolKeys = new Set(input.suppressedPoolKeys ?? []);
  for (const key of input.delta.replacedPoolKeys ?? []) {
    suppressedPoolKeys.add(key);
  }
  const suppressedForThisView = new Set([
    ...suppressedPoolKeys,
    ...isolatedPoolKeys,
  ]);
  const admittedPools = input.delta.successfulBuilds.map((item) => item.pool);
  const nextBackrunPools = mergePoolProjectionRows(
    input.currentBackrunPools.filter((pool) =>
      !removedPoolKeys.has(poolProjectionRowKey(pool))
    ),
    admittedPools,
  );
  const strategyViews = input.buildStrategyViews(
    nextBackrunPools,
    suppressedForThisView,
  );

  const backrunGraph = mergeEdges(
    input.currentBackrunGraph.filter((edge) =>
      !removedEdgeKeys.has(edgeKey(edge))
    ),
    input.delta.successfulBuilds.flatMap((item) => [...item.edges]),
  );
  const blockscanPoolKeys = new Set(
    strategyViews.blockscan.map(poolProjectionRowKey),
  );
  const blockscanAdditions = input.delta.successfulBuilds.flatMap((item) =>
    blockscanPoolKeys.has(poolProjectionRowKey(item.pool)) ? item.edges : []
  );
  const blockscanGraph = input.currentBlockscanGraph === undefined
    ? undefined
    : mergeEdges(
        input.currentBlockscanGraph.filter((edge) =>
          !removedEdgeKeys.has(edgeKey(edge))
        ),
        blockscanAdditions,
      );
  const tokenIndex = buildTokenIndex(backrunGraph);
  const poolAddressMap = new Map<string, string>();
  for (const pool of strategyViews.backrun) {
    poolAddressMap.set(pool.address.toLowerCase(), pool.adapter);
  }

  const knownPoolKeys = new Set(
    input.knownPoolKeys ??
      input.currentBackrunPools.map(poolProjectionRowKey),
  );
  for (const key of removedPoolKeys) knownPoolKeys.delete(key);
  for (const pool of admittedPools) {
    knownPoolKeys.add(poolProjectionRowKey(pool));
  }

  return {
    delta: input.delta,
    attemptedPools: [...input.delta.attemptedPools],
    admittedPools,
    failedPools: [...input.delta.failedPools],
    strategyViews,
    backrunGraph,
    blockscanGraph,
    tokenIndex,
    poolAddressMap,
    flashTokens: [...tokenIndex.keys()],
    knownPoolKeys,
    knownPoolAddresses: new Set(
      strategyViews.backrun.map((pool) => pool.address.toLowerCase()),
    ),
    suppressedPoolKeys,
  };
}

function familyInstanceKey(familyId: string, instanceKey: string): string {
  return JSON.stringify([familyId, instanceKey]);
}

/** Signals an address-filtered mempool subscription to rebuild and reconnect. */
export class MempoolIntakeRefreshSignal {
  private readonly listeners = new Set<() => void>();

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function uniquePools(pools: readonly PoolEntry[]): PoolEntry[] {
  const seen = new Set<string>();
  const unique: PoolEntry[] = [];
  for (const pool of pools) {
    const key = poolRegistryKey(pool);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pool);
  }
  return unique;
}

function mergeEdges(
  current: readonly TokenEdge[],
  additions: readonly TokenEdge[],
): TokenEdge[] {
  const merged = [...current];
  const seen = new Set(current.map(edgeKey));
  for (const edge of additions) {
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(edge);
  }
  return merged;
}

function edgeKey(edge: TokenEdge): string {
  return [
    edgeInstanceKey(edge),
    edgeExecutionVariantKey(edge),
    edge.adapterId,
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
    edge.protocolAction ?? "",
    edge.curveI ?? "",
    edge.curveJ ?? "",
    edge.poolId?.toLowerCase() ?? "",
  ].join("|");
}

function normalizeRequestedBlockTag(blockTag: ethers.BlockTag): string {
  try {
    return ethers.toQuantity(blockTag);
  } catch {
    throw new Error(`DEX read requires a numeric pinned block, received ${String(blockTag)}`);
  }
}

function normalizeDexBlockHash(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`invalid DEX source block hash ${value}`);
  }
  return value.toLowerCase();
}

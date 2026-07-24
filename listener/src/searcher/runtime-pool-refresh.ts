import { ethers } from "ethers";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "./planner/token-graph.js";
import {
  buildTokenGraphWithResults,
  buildTokenIndex,
  type PoolGraphBuildFailure,
} from "./planner/token-graph.js";
import {
  mergeDexDiscoveryReadControls,
  mergePoolRegistries,
  sendDexDiscoveryRpc,
  type DexDiscoveryReadControl,
} from "./active-pool-discovery.js";
import { poolRegistryKey } from "./pool-universe.js";
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

export type RuntimeStrategyViewBuilder = (backrunPools: PoolEntry[]) => StrategyViews;

export interface RuntimePoolRefreshInput {
  backend: TokenQueryBackend;
  freshPools: PoolEntry[];
  /** Pools whose edge build has already succeeded, not merely been discovered. */
  knownPoolKeys?: ReadonlySet<string>;
  currentBackrunPools: PoolEntry[];
  currentBackrunGraph: TokenEdge[];
  currentBlockscanGraph?: TokenEdge[];
  buildStrategyViews: RuntimeStrategyViewBuilder;
}

export interface RuntimePoolRefreshProjection {
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
): PoolEntry[] {
  return [
    ...registryVenues.filter((pool) => !knownPoolKeys.has(poolRegistryKey(pool))),
    ...discovered.filter((pool) => !knownPoolKeys.has(poolRegistryKey(pool))),
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
  const currentKeys = input.knownPoolKeys ??
    new Set(input.currentBackrunPools.map(poolRegistryKey));
  const attemptedPools = uniquePools(input.freshPools)
    .filter((pool) => !currentKeys.has(poolRegistryKey(pool)));
  const built = await buildTokenGraphWithResults(input.backend, attemptedPools);
  const admittedPools = built.successful.map((item) => item.pool);
  const nextBackrunPools = mergePoolRegistries(input.currentBackrunPools, admittedPools);
  const strategyViews = input.buildStrategyViews(nextBackrunPools);

  const backrunGraph = mergeEdges(input.currentBackrunGraph, built.edges);
  const blockscanPoolKeys = new Set(strategyViews.blockscan.map(poolRegistryKey));
  const blockscanAdditions = built.successful.flatMap((item) =>
    blockscanPoolKeys.has(poolRegistryKey(item.pool)) ? item.edges : []
  );
  const blockscanGraph = input.currentBlockscanGraph === undefined
    ? undefined
    : mergeEdges(input.currentBlockscanGraph, blockscanAdditions);
  const tokenIndex = buildTokenIndex(backrunGraph);
  const poolAddressMap = new Map<string, string>();
  for (const pool of strategyViews.backrun) {
    poolAddressMap.set(pool.address.toLowerCase(), pool.adapter);
  }

  const knownPoolKeys = new Set(currentKeys);
  for (const pool of admittedPools) knownPoolKeys.add(poolRegistryKey(pool));

  return {
    attemptedPools,
    admittedPools,
    failedPools: built.failed,
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
  };
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

function uniquePools(pools: PoolEntry[]): PoolEntry[] {
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

function mergeEdges(current: TokenEdge[], additions: TokenEdge[]): TokenEdge[] {
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

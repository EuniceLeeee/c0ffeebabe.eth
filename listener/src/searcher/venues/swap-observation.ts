import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import { v4PoolId } from "./swaps/univ4-common.js";
import {
  BALANCER_V3_SWAP_TOPIC,
  CURVE_TOKEN_EXCHANGE_TOPICS,
  LANDED_SWAP_EVENTS,
  PANCAKE_V3_SWAP_TOPIC,
  UNIV2_SWAP_TOPIC,
  UNIV2_SYNC_TOPIC,
  UNIV3_SWAP_TOPIC,
  UNIV4_SWAP_TOPIC,
  landedSwapEventsForFamily,
  landedSwapTopicsForFamily,
  observedLandedPoolIdentity,
} from "./landed-event-registry.js";
export {
  BALANCER_V3_SWAP_TOPIC,
  CURVE_TOKEN_EXCHANGE_TOPICS,
  PANCAKE_V3_SWAP_TOPIC,
  UNIV2_SWAP_TOPIC,
  UNIV2_SYNC_TOPIC,
  UNIV3_SWAP_TOPIC,
  UNIV4_SWAP_TOPIC,
} from "./landed-event-registry.js";

export interface PoolImpact {
  pool: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut?: bigint;
  matchedAdapterId: string;
  poolId?: string;
  v3PostState?: {
    sqrtPriceX96: bigint;
    liquidity: bigint;
    tick: number;
  };
  v2PostState?: {
    reserve0: bigint;
    reserve1: bigint;
    blockTimestampLast?: number;
    token0?: string;
    token1?: string;
  };
  v4PostState?: {
    sqrtPriceX96: bigint;
    liquidity: bigint;
    tick: number;
    poolId: string;
    lpFee?: number;
  };
  poolToken0?: string;
  poolToken1?: string;
}

export interface SwapEventLog {
  address: string;
  topics: string[];
  data: string;
}

export interface SwapObservationContext {
  readonly logs: readonly SwapEventLog[];
  readonly graph: readonly TokenEdge[];
  readonly edgesByTarget: ReadonlyMap<string, readonly TokenEdge[]>;
  readonly tokenQuery?: TokenQueryBackend | null;
}

export interface ObservedSwapImpact {
  readonly logIndex: number;
  readonly impact: PoolImpact;
}

export interface SwapObservationCapability {
  /** Receipt topics which make this observer relevant. */
  readonly topics: readonly string[];
  /** Direct public-mempool entrypoints owned by this execution family. */
  readonly canonicalIntakeTargets: readonly string[];
  /** Logical pool identity for discovery; singleton emitters use an indexed id. */
  observedPoolIdentity(log: SwapEventLog): string | null;
  /** Decode once per receipt so related events can be correlated. */
  decodeSwapImpacts(ctx: SwapObservationContext): Promise<readonly ObservedSwapImpact[]>;
}

const univ2PairIface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

export function createUniV2SwapObservation(input: {
  adapterIds: readonly string[];
  canonicalIntakeTargets: readonly string[];
}): SwapObservationCapability {
  const topics = landedSwapTopicsForFamily("univ2-standard");
  return Object.freeze({
    topics,
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity: addressEmitterPoolIdentity,
    async decodeSwapImpacts(ctx: SwapObservationContext) {
      const impacts: ObservedSwapImpact[] = [];
      const finalPostStates = await collectUniV2PostStates(ctx.logs, ctx.tokenQuery);
      for (let index = 0; index < ctx.logs.length; index++) {
        const log = ctx.logs[index];
        if (topic0(log) !== UNIV2_SWAP_TOPIC) continue;
        try {
          const edges = matchingTargetEdges(ctx, log.address, input.adapterIds);
          if (edges.length === 0) continue;

          const swap = decodeUniV2SwapData(log.data);
          const sample = edges.find((edge) => edge.poolToken0 && edge.poolToken1);
          if (!sample?.poolToken0 || !sample.poolToken1) continue;
          const tokenIn = swap.amount0In > 0n ? sample.poolToken0 : sample.poolToken1;
          const tokenOut = swap.amount0In > 0n ? sample.poolToken1 : sample.poolToken0;
          const edge = edges.find((candidate) =>
            sameAddress(candidate.tokenIn, tokenIn) && sameAddress(candidate.tokenOut, tokenOut)
          );
          if (!edge) continue;

          const v2PostState = finalPostStates.get(log.address.toLowerCase()) ?? null;
          impacts.push({
            logIndex: index,
            impact: {
              pool: edge.target,
              tokenIn: edge.tokenIn,
              tokenOut: edge.tokenOut,
              amountIn: swap.amount0In > 0n ? swap.amount0In : swap.amount1In,
              matchedAdapterId: edge.adapterId,
              poolToken0: sample.poolToken0,
              poolToken1: sample.poolToken1,
              ...(v2PostState ? { v2PostState } : {}),
            },
          });
        } catch {
          continue;
        }
      }
      return impacts;
    },
  });
}

export function createUniV3SwapObservation(input: {
  adapterIds: readonly string[];
  canonicalIntakeTargets: readonly string[];
}): SwapObservationCapability {
  const topics = landedSwapTopicsForFamily("univ3-standard");
  return Object.freeze({
    topics,
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity: addressEmitterPoolIdentity,
    async decodeSwapImpacts(ctx: SwapObservationContext) {
      const impacts: ObservedSwapImpact[] = [];
      for (let index = 0; index < ctx.logs.length; index++) {
        const log = ctx.logs[index];
        if (!topics.includes(topic0(log))) continue;
        try {
          const edges = matchingTargetEdges(ctx, log.address, input.adapterIds);
          if (edges.length === 0) continue;
          const { amount0, amount1, v3PostState } = decodeUniV3SwapData(log.data);
          const sample = edges.find((edge) => edge.poolToken0 && edge.poolToken1);
          if (!sample?.poolToken0 || !sample.poolToken1) continue;
          const tokenIn = amount0 > 0n ? sample.poolToken0 : sample.poolToken1;
          const tokenOut = amount0 > 0n ? sample.poolToken1 : sample.poolToken0;
          const edge = edges.find((candidate) =>
            sameAddress(candidate.tokenIn, tokenIn) && sameAddress(candidate.tokenOut, tokenOut)
          );
          if (!edge) continue;
          impacts.push({
            logIndex: index,
            impact: {
              pool: edge.target,
              tokenIn: edge.tokenIn,
              tokenOut: edge.tokenOut,
              amountIn: amount0 > 0n ? amount0 : amount1,
              matchedAdapterId: edge.adapterId,
              v3PostState,
            },
          });
        } catch {
          continue;
        }
      }
      return impacts;
    },
  });
}

export function createCurveSwapObservation(input: {
  adapterIds: readonly string[];
  canonicalIntakeTargets: readonly string[];
}): SwapObservationCapability {
  const topics = landedSwapTopicsForFamily("curve-plain");
  const topicSet = new Set(topics);
  return Object.freeze({
    topics,
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity: addressEmitterPoolIdentity,
    async decodeSwapImpacts(ctx: SwapObservationContext) {
      const impacts: ObservedSwapImpact[] = [];
      for (let index = 0; index < ctx.logs.length; index++) {
        const log = ctx.logs[index];
        if (!topicSet.has(topic0(log))) continue;
        try {
          const edges = matchingTargetEdges(ctx, log.address, input.adapterIds);
          if (edges.length === 0) continue;
          const [soldId, tokensSold, boughtId] = ethers.AbiCoder.defaultAbiCoder().decode(
            ["uint256", "uint256", "uint256", "uint256"],
            log.data,
          );
          impacts.push(...impactsFromCurveIds(
            BigInt(soldId),
            BigInt(boughtId),
            BigInt(tokensSold),
            edges,
          ).map((impact) => ({ logIndex: index, impact })));
        } catch {
          continue;
        }
      }
      return impacts;
    },
  });
}

export const curveSwapObservation = createCurveSwapObservation({
  adapterIds: [
    "curve-exchange",
    "curve-exchange-nr",
    "curve-exchange-plain",
    "curve-exchange-received-uint",
    "curve-exchange-underlying",
  ],
  canonicalIntakeTargets: [
    "0x99a58482bd75cbab83b27ec03ca68ff489b5788f",
    "0x16c6521dff6bab339122a0fe25a9116693265353",
  ],
});

export function createUniV4SwapObservation(input: {
  adapterIds: readonly string[];
  canonicalIntakeTargets: readonly string[];
}): SwapObservationCapability {
  const events = landedSwapEventsForFamily("univ4");
  return Object.freeze({
    topics: landedSwapTopicsForFamily("univ4"),
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity(log: SwapEventLog) {
      return observedFamilyPoolIdentity(events, log);
    },
    async decodeSwapImpacts(ctx: SwapObservationContext) {
      const impacts: ObservedSwapImpact[] = [];
      for (let index = 0; index < ctx.logs.length; index++) {
        const log = ctx.logs[index];
        if (topic0(log) !== UNIV4_SWAP_TOPIC) continue;
        if (!sameAddress(log.address, ADDR.UNISWAP_V4_POOL_MANAGER)) continue;
        try {
          const poolId = log.topics[1]?.toLowerCase();
          if (!poolId) continue;
          const [amount0, amount1, sqrtPriceX96, liquidity, tick, fee] =
            ethers.AbiCoder.defaultAbiCoder().decode(
              ["int128", "int128", "uint160", "uint128", "int24", "uint24"],
              log.data,
            );
          const a0 = BigInt(amount0);
          const a1 = BigInt(amount1);
          const matching = [...(ctx.edgesByTarget.get(ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase()) ?? [])]
            .filter((edge) =>
              input.adapterIds.includes(edge.adapterId) &&
              edge.v4PoolKey !== undefined &&
              (edge.poolId ?? v4PoolId(edge.v4PoolKey)) === poolId
            );
          if (matching.length === 0) continue;
          const key = matching[0].v4PoolKey!;
          const aliasWeth = (currency: string): string =>
            currency === ethers.ZeroAddress ? ADDR.WETH : currency;
          const tokenIn = aliasWeth(a0 > 0n ? key.currency0 : key.currency1);
          const tokenOut = aliasWeth(a0 > 0n ? key.currency1 : key.currency0);
          const amountIn = a0 > 0n ? a0 : a1;
          if (amountIn <= 0n) continue;
          const edge = matching.find((candidate) =>
            sameAddress(candidate.tokenIn, tokenIn) && sameAddress(candidate.tokenOut, tokenOut)
          );
          if (!edge) continue;
          impacts.push({
            logIndex: index,
            impact: {
              pool: edge.target,
              tokenIn: edge.tokenIn,
              tokenOut: edge.tokenOut,
              amountIn,
              amountOut: a0 > 0n ? -a1 : -a0,
              matchedAdapterId: edge.adapterId,
              poolId,
              v4PostState: {
                sqrtPriceX96: BigInt(sqrtPriceX96),
                liquidity: BigInt(liquidity),
                tick: Number(tick),
                poolId,
                lpFee: Number(fee),
              },
            },
          });
        } catch {
          continue;
        }
      }
      return impacts;
    },
  });
}

export function createBalancerV3SwapObservation(input: {
  adapterIds: readonly string[];
  canonicalIntakeTargets: readonly string[];
}): SwapObservationCapability {
  const events = landedSwapEventsForFamily("balancer-v3");
  return Object.freeze({
    topics: landedSwapTopicsForFamily("balancer-v3"),
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity(log: SwapEventLog) {
      return observedFamilyPoolIdentity(events, log);
    },
    async decodeSwapImpacts(ctx: SwapObservationContext) {
      const impacts: ObservedSwapImpact[] = [];
      for (let index = 0; index < ctx.logs.length; index++) {
        const log = ctx.logs[index];
        if (topic0(log) !== BALANCER_V3_SWAP_TOPIC) continue;
        if (!sameAddress(log.address, ADDR.BALANCER_V3_VAULT)) continue;
        try {
          const pool = indexedAddress(log.topics[1]);
          const tokenIn = indexedAddress(log.topics[2]);
          const tokenOut = indexedAddress(log.topics[3]);
          if (!pool || !tokenIn || !tokenOut) continue;
          const [amountIn, amountOut] = ethers.AbiCoder.defaultAbiCoder().decode(
            ["uint256", "uint256", "uint256", "uint256"],
            log.data,
          );
          const edge = matchingTargetEdges(ctx, pool, input.adapterIds).find((candidate) =>
            sameAddress(candidate.tokenIn, tokenIn) && sameAddress(candidate.tokenOut, tokenOut)
          );
          if (!edge) continue;
          impacts.push({
            logIndex: index,
            impact: {
              pool: edge.target,
              tokenIn: edge.tokenIn,
              tokenOut: edge.tokenOut,
              amountIn: BigInt(amountIn),
              amountOut: BigInt(amountOut),
              matchedAdapterId: edge.adapterId,
            },
          });
        } catch {
          continue;
        }
      }
      return impacts;
    },
  });
}

function observedFamilyPoolIdentity(
  events: readonly typeof LANDED_SWAP_EVENTS[number][],
  log: SwapEventLog,
): string | null {
  for (const event of events) {
    const identity = observedLandedPoolIdentity(event, log);
    if (identity !== null) return identity;
  }
  return null;
}

export function decodeUniV2SwapData(data: string): {
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
} {
  const [amount0In, amount1In, amount0Out, amount1Out] =
    ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint256", "uint256", "uint256"],
      data,
    );
  return {
    amount0In: BigInt(amount0In),
    amount1In: BigInt(amount1In),
    amount0Out: BigInt(amount0Out),
    amount1Out: BigInt(amount1Out),
  };
}

export function decodeUniV3SwapData(data: string): {
  amount0: bigint;
  amount1: bigint;
  v3PostState: NonNullable<PoolImpact["v3PostState"]>;
} {
  const [amount0, amount1, sqrtPriceX96, liquidity, tick] =
    ethers.AbiCoder.defaultAbiCoder().decode(
      ["int256", "int256", "uint160", "uint128", "int24"],
      data,
    );
  return {
    amount0: BigInt(amount0),
    amount1: BigInt(amount1),
    v3PostState: {
      sqrtPriceX96: BigInt(sqrtPriceX96),
      liquidity: BigInt(liquidity),
      tick: Number(tick),
    },
  };
}

export async function collectUniV2PostStates(
  logs: readonly SwapEventLog[],
  tokenQuery?: TokenQueryBackend | null,
): Promise<Map<string, NonNullable<PoolImpact["v2PostState"]>>> {
  const out = new Map<string, NonNullable<PoolImpact["v2PostState"]>>();
  const swapLogsByPool = new Map<string, SwapEventLog[]>();
  const lastSyncByPool = new Map<string, NonNullable<PoolImpact["v2PostState"]>>();
  for (const log of logs) {
    const pool = log.address.toLowerCase();
    const currentTopic = topic0(log);
    if (currentTopic === UNIV2_SWAP_TOPIC) {
      const poolLogs = swapLogsByPool.get(pool) ?? [];
      poolLogs.push(log);
      swapLogsByPool.set(pool, poolLogs);
    } else if (currentTopic === UNIV2_SYNC_TOPIC) {
      try {
        lastSyncByPool.set(pool, decodeUniV2SyncData(log.data));
      } catch {
        // Keep scanning; a later valid Sync can still establish final state.
      }
    }
  }
  for (const pool of swapLogsByPool.keys()) {
    const syncState = lastSyncByPool.get(pool);
    if (syncState) out.set(pool, syncState);
  }
  if (!tokenQuery) return out;

  await Promise.all([...swapLogsByPool.entries()].map(async ([pool, poolLogs]) => {
    if (out.has(pool)) return;
    try {
      const swaps = poolLogs.map((log) => decodeUniV2SwapData(log.data));
      const postState = await computeFinalUniV2PostStateFromPreReserves(
        pool,
        swaps,
        tokenQuery,
      );
      if (postState) out.set(pool, postState);
    } catch {
      // A non-standard pair or unavailable pre-state is not an exact observation.
    }
  }));
  return out;
}

export function withUniV2PostStates(
  impacts: PoolImpact[],
  postStates: ReadonlyMap<string, NonNullable<PoolImpact["v2PostState"]>>,
): PoolImpact[] {
  for (const impact of impacts) {
    if (impact.matchedAdapterId !== "univ2-swap" || impact.v2PostState) continue;
    const postState = postStates.get(impact.pool.toLowerCase());
    if (!postState) continue;
    impact.v2PostState = postState;
    impact.poolToken0 ??= postState.token0;
    impact.poolToken1 ??= postState.token1;
  }
  return impacts;
}

export async function computeUniV2PostStateFromPreReserves(
  pool: string,
  swap: ReturnType<typeof decodeUniV2SwapData>,
  tokenQuery: TokenQueryBackend,
): Promise<NonNullable<PoolImpact["v2PostState"]> | null> {
  return computeFinalUniV2PostStateFromPreReserves(pool, [swap], tokenQuery);
}

async function computeFinalUniV2PostStateFromPreReserves(
  pool: string,
  swaps: readonly ReturnType<typeof decodeUniV2SwapData>[],
  tokenQuery: TokenQueryBackend,
): Promise<NonNullable<PoolImpact["v2PostState"]> | null> {
  const [reservesRaw, token0Raw, token1Raw] = await Promise.all([
    tokenQuery.call({ to: pool, data: univ2PairIface.encodeFunctionData("getReserves") }),
    tokenQuery.call({ to: pool, data: univ2PairIface.encodeFunctionData("token0") }),
    tokenQuery.call({ to: pool, data: univ2PairIface.encodeFunctionData("token1") }),
  ]);
  if (
    !reservesRaw || reservesRaw === "0x" ||
    !token0Raw || token0Raw === "0x" ||
    !token1Raw || token1Raw === "0x"
  ) return null;
  const decoded = univ2PairIface.decodeFunctionResult("getReserves", reservesRaw);
  let reserve0 = BigInt(decoded[0]);
  let reserve1 = BigInt(decoded[1]);
  for (const swap of swaps) {
    reserve0 += swap.amount0In - swap.amount0Out;
    reserve1 += swap.amount1In - swap.amount1Out;
    if (reserve0 < 0n || reserve1 < 0n) return null;
  }
  return {
    reserve0,
    reserve1,
    blockTimestampLast: Number(decoded[2]),
    token0: ethers.getAddress(`0x${token0Raw.slice(-40)}`),
    token1: ethers.getAddress(`0x${token1Raw.slice(-40)}`),
  };
}

function decodeUniV2SyncData(data: string): NonNullable<PoolImpact["v2PostState"]> {
  const [reserve0, reserve1] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint112", "uint112"],
    data,
  );
  return { reserve0: BigInt(reserve0), reserve1: BigInt(reserve1) };
}

function impactsFromCurveIds(
  soldId: bigint,
  boughtId: bigint,
  amountIn: bigint,
  edges: readonly TokenEdge[],
): PoolImpact[] {
  const impacts: PoolImpact[] = [];
  for (const edge of edges) {
    if (edge.curveI === undefined || edge.curveJ === undefined) continue;
    if (BigInt(edge.curveI) === soldId && BigInt(edge.curveJ) === boughtId) {
      impacts.push({
        pool: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amountIn,
        matchedAdapterId: edge.adapterId,
      });
    } else if (BigInt(edge.curveI) === boughtId && BigInt(edge.curveJ) === soldId) {
      impacts.push({
        pool: edge.target,
        tokenIn: edge.tokenOut,
        tokenOut: edge.tokenIn,
        amountIn,
        matchedAdapterId: edge.adapterId,
      });
    }
  }
  if (impacts.length > 0) return impacts;
  if (edges.length !== 1) return [];
  const edge = edges[0];
  return [{
    pool: edge.target,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    amountIn,
    matchedAdapterId: edge.adapterId,
  }];
}

function matchingTargetEdges(
  ctx: SwapObservationContext,
  target: string,
  adapterIds: readonly string[],
): TokenEdge[] {
  return [...(ctx.edgesByTarget.get(target.toLowerCase()) ?? [])]
    .filter((edge) => adapterIds.includes(edge.adapterId));
}

function topic0(log: SwapEventLog): string {
  return log.topics[0]?.toLowerCase() ?? "";
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function indexedAddress(topic: string | undefined): string | null {
  if (!topic || topic.length !== 66) return null;
  try {
    return ethers.getAddress(`0x${topic.slice(-40)}`);
  } catch {
    return null;
  }
}

function normalizeAddresses(addresses: readonly string[]): readonly string[] {
  return Object.freeze(addresses.map((address) => ethers.getAddress(address)));
}

function addressEmitterPoolIdentity(log: SwapEventLog): string | null {
  try {
    return ethers.getAddress(log.address).toLowerCase();
  } catch {
    return null;
  }
}

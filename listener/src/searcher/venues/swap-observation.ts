import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import { v2FeeBpsForFactory } from "../solver/v2-fee.js";
import { v4PoolId } from "./swaps/univ4-common.js";
import {
  BALANCER_V3_SWAP_TOPIC,
  CURVE_TOKEN_EXCHANGE_TOPICS,
  DODO_V2_SWAP_TOPIC,
  PANCAKE_V3_SWAP_TOPIC,
  UNIV2_SWAP_TOPIC,
  UNIV2_SYNC_TOPIC,
  UNIV3_SWAP_TOPIC,
  UNIV4_SWAP_TOPIC,
  observedLandedPoolIdentity,
  type AnonymousLandedLogSelector,
  type LandedSwapEventDeclaration,
} from "./landed-event-registry.js";
export {
  BALANCER_V3_SWAP_TOPIC,
  CURVE_TOKEN_EXCHANGE_TOPICS,
  DODO_V2_SWAP_TOPIC,
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
    feeBps?: bigint;
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
  /** Receipt/state generation which admitted this impact. Hand-authored fixtures
   *  may omit it; production detector output always carries it. */
  sourceGeneration?: VictimSourceGeneration;
}

export interface SwapEventLog {
  address: string;
  topics: string[];
  data: string;
  /** Receipt provenance carried by real RPC logs. Synthetic decoder fixtures may omit it. */
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
}

export interface VictimSourceGeneration {
  readonly id: string;
  /** Pre-victim state block used by receipt enrichment reads. */
  readonly sourceBlock: number | null;
  readonly sourceBlockHash: string | null;
  readonly receiptId: string;
  /** Successful receipt identity. Null is permitted only for fragments or analysis-only fixtures. */
  readonly receiptBlockNumber: number | null;
  readonly receiptBlockHash: string | null;
  readonly receiptParentBlockHash: string | null;
  readonly receiptTransactionHash: string | null;
  readonly logsCompleteness: ReceiptLogsCompleteness;
}

export type ReceiptLogsCompleteness = "complete-receipt" | "fragment";

export interface SwapObservationContext {
  readonly logs: readonly SwapEventLog[];
  readonly graph: readonly TokenEdge[];
  readonly edgesByTarget: ReadonlyMap<string, readonly TokenEdge[]>;
  readonly tokenQuery?: TokenQueryBackend | null;
  readonly sourceGeneration: VictimSourceGeneration;
}

export interface SwapDirectCallContext {
  readonly target: string;
  readonly input: string;
  readonly graph: readonly TokenEdge[];
  readonly edgesByTarget: ReadonlyMap<string, readonly TokenEdge[]>;
  readonly sourceGeneration: VictimSourceGeneration;
}

export interface ObservedSwapImpact {
  readonly logIndex: number;
  readonly impact: PoolImpact;
  readonly consumedTriggerIds: readonly string[];
}

export interface ObservedMutationOnly {
  readonly logIndex: number;
  readonly reason: string;
  readonly consumedTriggerIds: readonly string[];
}

interface CandidateSwapImpact {
  readonly logIndex: number;
  readonly impact: PoolImpact;
}

interface CandidateMutationOnly {
  readonly logIndex: number;
  readonly mutationOnlyReason: string;
}

type CandidateReceiptObservation =
  | CandidateSwapImpact
  | CandidateMutationOnly;

export interface OwnedReceiptTrigger {
  readonly triggerId: string;
  readonly logIndex: number;
  readonly emitter: string;
  readonly topic0: string;
}

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type ReceiptImpactResult =
  | { readonly status: "no-match" }
  | {
      readonly status: "resolved";
      readonly impacts: readonly ObservedSwapImpact[];
      readonly mutations: readonly ObservedMutationOnly[];
      readonly consumedTriggerIds: NonEmptyReadonlyArray<string>;
    }
  | { readonly status: "unresolved"; readonly reason: string };

export interface ReceiptSwapObservationContext extends SwapObservationContext {
  readonly matchedOwnedTriggers: readonly OwnedReceiptTrigger[];
  readonly control: {
    readonly deadlineAtMs: number;
    readonly signal: AbortSignal;
  };
}

export interface SwapObservationCapability {
  /** Receipt topics which make this observer relevant. */
  readonly topics: readonly string[];
  /** Structurally bounded anonymous receipt logs owned by this family. */
  readonly anonymousLogs?: readonly AnonymousLandedLogSelector[];
  /** Direct public-mempool entrypoints owned by this execution family. */
  readonly canonicalIntakeTargets: readonly string[];
  /** Logical pool identity for discovery; singleton emitters use an indexed id. */
  observedPoolIdentity(log: SwapEventLog): string | null;
  /**
   * Decode once per receipt so related events can be correlated. A non-empty
   * owned trigger set must be consumed exactly or the whole family result is
   * unresolved; partial family impacts are never published.
   */
  decodeReceiptImpacts(
    ctx: ReceiptSwapObservationContext,
  ): Promise<ReceiptImpactResult>;
  /** Optional family-owned decoder for direct calls whose receipt logs may be absent. */
  readonly directCallSelectors?: readonly string[];
  decodeDirectCallImpacts?(
    ctx: SwapDirectCallContext,
  ): Promise<readonly PoolImpact[]> | readonly PoolImpact[];
}

interface StrictSwapObservationInput {
  readonly topics: readonly string[];
  readonly anonymousLogs?: readonly AnonymousLandedLogSelector[];
  readonly canonicalIntakeTargets: readonly string[];
  observedPoolIdentity(log: SwapEventLog): string | null;
  decodeSwapImpacts(
    ctx: ReceiptSwapObservationContext,
  ): Promise<readonly CandidateReceiptObservation[]>;
  readonly directCallSelectors?: readonly string[];
  decodeDirectCallImpacts?(
    ctx: SwapDirectCallContext,
  ): Promise<readonly PoolImpact[]> | readonly PoolImpact[];
}

/**
 * Shared strict receipt wrapper. Families remain responsible only for event
 * semantics; this boundary owns exact trigger consumption and turns any
 * partial or ambiguous family decode into one fail-closed result.
 */
export function createStrictSwapObservation(
  input: StrictSwapObservationInput,
): SwapObservationCapability {
  return Object.freeze({
    topics: Object.freeze([...input.topics]),
    ...(input.anonymousLogs === undefined
      ? {}
      : {
          anonymousLogs: Object.freeze(
            input.anonymousLogs.map((selector) => Object.freeze({
              ...selector,
              address: ethers.getAddress(selector.address),
            })),
          ),
        }),
    canonicalIntakeTargets: Object.freeze([
      ...input.canonicalIntakeTargets,
    ]),
    observedPoolIdentity: input.observedPoolIdentity,
    async decodeReceiptImpacts(
      ctx: ReceiptSwapObservationContext,
    ): Promise<ReceiptImpactResult> {
      const triggers = [...ctx.matchedOwnedTriggers].sort(
        (left, right) => left.logIndex - right.logIndex,
      );
      if (triggers.length === 0) {
        return Object.freeze({ status: "no-match" as const });
      }
      const byLogIndex = new Map<number, OwnedReceiptTrigger>();
      const triggerIds = new Set<string>();
      for (const trigger of triggers) {
        if (
          triggerIds.has(trigger.triggerId) ||
          byLogIndex.has(trigger.logIndex) ||
          trigger.logIndex < 0 ||
          trigger.logIndex >= ctx.logs.length
        ) {
          return Object.freeze({
            status: "unresolved" as const,
            reason: "owned receipt trigger set is duplicate or out of range",
          });
        }
        const log = ctx.logs[trigger.logIndex];
        if (
          log.address.toLowerCase() !== trigger.emitter.toLowerCase() ||
          topic0(log) !== trigger.topic0.toLowerCase()
        ) {
          return Object.freeze({
            status: "unresolved" as const,
            reason: "owned receipt trigger does not match the supplied receipt",
          });
        }
        triggerIds.add(trigger.triggerId);
        byLogIndex.set(trigger.logIndex, trigger);
      }

      let candidates: readonly CandidateReceiptObservation[];
      try {
        if (
          ctx.control.signal.aborted ||
          Date.now() >= ctx.control.deadlineAtMs
        ) {
          throw ctx.control.signal.reason ??
            new Error("receipt decoder deadline reached");
        }
        candidates = await input.decodeSwapImpacts(ctx);
        if (
          ctx.control.signal.aborted ||
          Date.now() >= ctx.control.deadlineAtMs
        ) {
          throw ctx.control.signal.reason ??
            new Error("receipt decoder deadline reached");
        }
      } catch (error) {
        return Object.freeze({
          status: "unresolved" as const,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const consumedCounts = new Map<string, number>();
      const impacts: ObservedSwapImpact[] = [];
      const mutations: ObservedMutationOnly[] = [];
      for (const candidate of candidates) {
        const trigger = byLogIndex.get(candidate.logIndex);
        if (!trigger) {
          return Object.freeze({
            status: "unresolved" as const,
            reason: "decoder produced an impact for an unknown trigger",
          });
        }
        consumedCounts.set(
          trigger.triggerId,
          (consumedCounts.get(trigger.triggerId) ?? 0) + 1,
        );
        if ("impact" in candidate) {
          impacts.push(Object.freeze({
            ...candidate,
            consumedTriggerIds: Object.freeze([trigger.triggerId]),
          }));
        } else {
          const reason = candidate.mutationOnlyReason.trim();
          if (!reason) {
            return Object.freeze({
              status: "unresolved" as const,
              reason: "mutation-only receipt observation requires a reason",
            });
          }
          mutations.push(Object.freeze({
            logIndex: candidate.logIndex,
            reason,
            consumedTriggerIds: Object.freeze([trigger.triggerId]),
          }));
        }
      }
      if (
        triggers.some(
          (trigger) => consumedCounts.get(trigger.triggerId) !== 1,
        )
      ) {
        return Object.freeze({
          status: "unresolved" as const,
          reason: "decoder did not consume every owned trigger exactly once",
        });
      }
      return Object.freeze({
        status: "resolved" as const,
        impacts: Object.freeze(impacts),
        mutations: Object.freeze(mutations),
        consumedTriggerIds: Object.freeze(
          triggers.map((trigger) => trigger.triggerId),
        ) as NonEmptyReadonlyArray<string>,
      });
    },
    ...(input.directCallSelectors
      ? { directCallSelectors: Object.freeze([...input.directCallSelectors]) }
      : {}),
    ...(input.decodeDirectCallImpacts
      ? { decodeDirectCallImpacts: input.decodeDirectCallImpacts }
      : {}),
  });
}

const univ2PairIface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

const CURVE_DIRECT_IFACE = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
  "function exchange_received(uint256 i, uint256 j, uint256 dx, uint256 min_dy)",
  "function exchange_received(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver)",
  "function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange_underlying(uint256 i, uint256 j, uint256 dx, uint256 min_dy)",
]);

const CURVE_DIRECT_SELECTORS = Object.freeze([
  "0x3df02124",
  "0xddc1f59d",
  "0x7e3db030",
  "0xafb43012",
  "0x29b244bb",
  "0x767691e7",
  "0xa6417ed6",
  "0x65b2489b",
]);
const CURVE_UNDERLYING_DIRECT_SELECTORS = new Set([
  "0xa6417ed6",
  "0x65b2489b",
]);

export function createUniV2SwapObservation(input: {
  adapterIds: readonly string[];
  canonicalIntakeTargets: readonly string[];
  landedEvents?: readonly LandedSwapEventDeclaration[];
  topics?: readonly string[];
}): SwapObservationCapability {
  const topics = observationTopics(input);
  return createStrictSwapObservation({
    topics,
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity: addressEmitterPoolIdentity,
    async decodeSwapImpacts(ctx: ReceiptSwapObservationContext) {
      const impacts: CandidateSwapImpact[] = [];
      const ownedPools = new Set(
        ctx.matchedOwnedTriggers.map((trigger) =>
          trigger.emitter.toLowerCase()
        ),
      );
      const finalPostStates = await collectUniV2PostStates(
        ctx.logs.filter((log) =>
          ownedPools.has(log.address.toLowerCase())
        ),
        ctx.tokenQuery,
        ctx.sourceGeneration.sourceBlock,
        ctx.control,
      );
      for (let index = 0; index < ctx.logs.length; index++) {
        const log = ctx.logs[index];
        if (topic0(log) !== UNIV2_SWAP_TOPIC) continue;
        try {
          const edges = matchingTargetEdges(ctx, log.address, input.adapterIds);
          if (edges.length === 0) continue;

          const swap = decodeUniV2SwapData(log.data);
          const zeroForOne = swap.amount0In > 0n &&
            swap.amount1In === 0n &&
            swap.amount0Out === 0n &&
            swap.amount1Out > 0n;
          const oneForZero = swap.amount1In > 0n &&
            swap.amount0In === 0n &&
            swap.amount1Out === 0n &&
            swap.amount0Out > 0n;
          if (!zeroForOne && !oneForZero) continue;
          const sample = edges.find((edge) => edge.poolToken0 && edge.poolToken1);
          if (!sample?.poolToken0 || !sample.poolToken1) continue;
          const tokenIn = zeroForOne ? sample.poolToken0 : sample.poolToken1;
          const tokenOut = zeroForOne ? sample.poolToken1 : sample.poolToken0;
          const edge = edges.find((candidate) =>
            sameAddress(candidate.tokenIn, tokenIn) && sameAddress(candidate.tokenOut, tokenOut)
          );
          if (!edge) continue;

          const v2PostState = finalPostStates.get(log.address.toLowerCase()) ?? null;
          if (v2PostState && sample.v2FeeBps !== undefined) {
            v2PostState.feeBps = sample.v2FeeBps;
          }
          impacts.push({
            logIndex: index,
            impact: {
              pool: edge.target,
              tokenIn: edge.tokenIn,
              tokenOut: edge.tokenOut,
              amountIn: zeroForOne ? swap.amount0In : swap.amount1In,
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
  landedEvents?: readonly LandedSwapEventDeclaration[];
  topics?: readonly string[];
}): SwapObservationCapability {
  const topics = observationTopics(input);
  return createStrictSwapObservation({
    topics,
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity: addressEmitterPoolIdentity,
    async decodeSwapImpacts(ctx: ReceiptSwapObservationContext) {
      const impacts: CandidateSwapImpact[] = [];
      for (let index = 0; index < ctx.logs.length; index++) {
        const log = ctx.logs[index];
        if (!topics.includes(topic0(log))) continue;
        try {
          const edges = matchingTargetEdges(ctx, log.address, input.adapterIds);
          if (edges.length === 0) continue;
          const { amount0, amount1, v3PostState } = decodeUniV3SwapData(log.data);
          const zeroForOne = amount0 > 0n && amount1 < 0n;
          const oneForZero = amount1 > 0n && amount0 < 0n;
          if (!zeroForOne && !oneForZero) continue;
          const sample = edges.find((edge) => edge.poolToken0 && edge.poolToken1);
          if (!sample?.poolToken0 || !sample.poolToken1) continue;
          const tokenIn = zeroForOne ? sample.poolToken0 : sample.poolToken1;
          const tokenOut = zeroForOne ? sample.poolToken1 : sample.poolToken0;
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
              amountIn: zeroForOne ? amount0 : amount1,
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
  landedEvents?: readonly LandedSwapEventDeclaration[];
  topics?: readonly string[];
}): SwapObservationCapability {
  const topics = observationTopics(input);
  const topicSet = new Set(topics);
  const directCallSelectors = CURVE_DIRECT_SELECTORS;
  const plainAdapterIds = input.adapterIds.filter((adapterId) =>
    adapterId !== "curve-exchange-underlying"
  );
  const underlyingAdapterIds = input.adapterIds.filter((adapterId) =>
    adapterId === "curve-exchange-underlying"
  );
  return createStrictSwapObservation({
    topics,
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity: addressEmitterPoolIdentity,
    async decodeSwapImpacts(ctx: ReceiptSwapObservationContext) {
      const impacts: CandidateSwapImpact[] = [];
      for (let index = 0; index < ctx.logs.length; index++) {
        const log = ctx.logs[index];
        if (!topicSet.has(topic0(log))) continue;
        try {
          const eventTopic = topic0(log);
          const adapterIds = eventTopic === CURVE_TOKEN_EXCHANGE_TOPICS[2] ||
              eventTopic === CURVE_TOKEN_EXCHANGE_TOPICS[3]
            ? underlyingAdapterIds
            : plainAdapterIds;
          const edges = matchingTargetEdges(ctx, log.address, adapterIds);
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
    directCallSelectors,
    decodeDirectCallImpacts(ctx: SwapDirectCallContext) {
      if (!directCallSelectors.includes(ctx.input.slice(0, 10).toLowerCase())) {
        return [];
      }
      const selector = ctx.input.slice(0, 10).toLowerCase();
      const edges = matchingTargetEdges(
        ctx,
        ctx.target,
        CURVE_UNDERLYING_DIRECT_SELECTORS.has(selector)
          ? underlyingAdapterIds
          : plainAdapterIds,
      );
      if (edges.length === 0) return [];
      try {
        const parsed = CURVE_DIRECT_IFACE.parseTransaction({ data: ctx.input });
        if (!parsed) return [];
        return impactsFromCurveIds(
          BigInt(parsed.args[0]),
          BigInt(parsed.args[1]),
          BigInt(parsed.args[2]),
          edges,
        );
      } catch {
        return [];
      }
    },
  });
}

export function createUniV4SwapObservation(input: {
  adapterIds: readonly string[];
  canonicalIntakeTargets: readonly string[];
  landedEvents?: readonly LandedSwapEventDeclaration[];
  topics?: readonly string[];
  /**
   * Swap-affecting hooks may alter the final caller balance after PoolManager
   * emits Swap. Such families still reuse the exact PoolKey/post-state decoder,
   * but must not publish the pre-hook BalanceDelta as an exact amountOut.
   */
  includeAmountOut?: boolean;
}): SwapObservationCapability {
  const events = input.landedEvents;
  return createStrictSwapObservation({
    topics: observationTopics(input),
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity(log: SwapEventLog) {
      return events === undefined
        ? log.topics[1]?.toLowerCase() ?? null
        : observedFamilyPoolIdentity(events, log);
    },
    async decodeSwapImpacts(ctx: ReceiptSwapObservationContext) {
      const impacts: CandidateSwapImpact[] = [];
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
          const zeroForOne = a0 < 0n && a1 > 0n;
          const oneForZero = a1 < 0n && a0 > 0n;
          if (!zeroForOne && !oneForZero) continue;
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
          // PoolManager Swap publishes the swapper's BalanceDelta: the paid
          // currency is negative and the received currency is positive.
          const tokenIn = aliasWeth(zeroForOne ? key.currency0 : key.currency1);
          const tokenOut = aliasWeth(zeroForOne ? key.currency1 : key.currency0);
          const amountIn = zeroForOne ? -a0 : -a1;
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
              ...(input.includeAmountOut === false
                ? {}
                : { amountOut: zeroForOne ? a1 : a0 }),
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
  landedEvents: readonly LandedSwapEventDeclaration[];
}): SwapObservationCapability {
  const events = input.landedEvents;
  return createStrictSwapObservation({
    topics: topicsFromDeclarations(events),
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity(log: SwapEventLog) {
      return observedFamilyPoolIdentity(events, log);
    },
    async decodeSwapImpacts(ctx: ReceiptSwapObservationContext) {
      const impacts: CandidateSwapImpact[] = [];
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

export function createDodoV2SwapObservation(input: {
  adapterIds: readonly string[];
  canonicalIntakeTargets: readonly string[];
  landedEvents?: readonly LandedSwapEventDeclaration[];
  topics?: readonly string[];
}): SwapObservationCapability {
  const topics = observationTopics(input);
  return createStrictSwapObservation({
    topics,
    canonicalIntakeTargets: normalizeAddresses(input.canonicalIntakeTargets),
    observedPoolIdentity: addressEmitterPoolIdentity,
    async decodeSwapImpacts(ctx: ReceiptSwapObservationContext) {
      const impacts: CandidateSwapImpact[] = [];
      for (let index = 0; index < ctx.logs.length; index++) {
        const log = ctx.logs[index];
        if (topic0(log) !== DODO_V2_SWAP_TOPIC) continue;
        try {
          const [fromToken, toToken, fromAmount, toAmount] =
            ethers.AbiCoder.defaultAbiCoder().decode(
              ["address", "address", "uint256", "uint256", "address", "address"],
              log.data,
            );
          const edge = matchingTargetEdges(ctx, log.address, input.adapterIds).find((candidate) =>
            sameAddress(candidate.tokenIn, String(fromToken)) &&
            sameAddress(candidate.tokenOut, String(toToken))
          );
          if (!edge) continue;
          impacts.push({
            logIndex: index,
            impact: {
              pool: edge.target,
              tokenIn: edge.tokenIn,
              tokenOut: edge.tokenOut,
              amountIn: BigInt(fromAmount),
              amountOut: BigInt(toAmount),
              matchedAdapterId: edge.adapterId,
              poolToken0: edge.poolToken0,
              poolToken1: edge.poolToken1,
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
  events: readonly LandedSwapEventDeclaration[],
  log: SwapEventLog,
): string | null {
  for (const event of events) {
    const identity = observedLandedPoolIdentity(event, log);
    if (identity !== null) return identity;
  }
  return null;
}

function topicsFromDeclarations(
  events: readonly LandedSwapEventDeclaration[],
): readonly string[] {
  return Object.freeze([
    ...new Set(events.flatMap((event) =>
      event.topic === null ? [] : [event.topic.toLowerCase()]
    )),
  ]);
}

function observationTopics(input: {
  readonly landedEvents?: readonly LandedSwapEventDeclaration[];
  readonly topics?: readonly string[];
}): readonly string[] {
  if (
    (input.landedEvents === undefined) === (input.topics === undefined)
  ) {
    throw new Error(
      "swap observation requires exactly one landedEvents/topics source",
    );
  }
  const topics = input.landedEvents === undefined
    ? input.topics!
    : topicsFromDeclarations(input.landedEvents);
  const normalized = [...new Set(topics.map((topic) => topic.toLowerCase()))];
  if (
    normalized.length === 0 ||
    normalized.some((topic) => !ethers.isHexString(topic, 32))
  ) {
    throw new Error("swap observation topics must be non-empty bytes32 values");
  }
  return Object.freeze(normalized);
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
  sourceBlock: number | null = null,
  control?: {
    readonly deadlineAtMs?: number;
    readonly signal?: AbortSignal;
  },
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
        sourceBlock,
        control,
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
  sourceBlock: number | null = null,
  control?: {
    readonly deadlineAtMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<NonNullable<PoolImpact["v2PostState"]> | null> {
  return computeFinalUniV2PostStateFromPreReserves(
    pool,
    [swap],
    tokenQuery,
    sourceBlock,
    control,
  );
}

async function computeFinalUniV2PostStateFromPreReserves(
  pool: string,
  swaps: readonly ReturnType<typeof decodeUniV2SwapData>[],
  tokenQuery: TokenQueryBackend,
  sourceBlock: number | null,
  control?: {
    readonly deadlineAtMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<NonNullable<PoolImpact["v2PostState"]> | null> {
  const call = (data: string): Promise<string> =>
    tokenQuery.call({
      to: pool,
      data,
      ...(sourceBlock === null ? {} : { blockTag: sourceBlock }),
    }, control);
  const [reservesRaw, factoryRaw, token0Raw, token1Raw] = await Promise.all([
    call(univ2PairIface.encodeFunctionData("getReserves")),
    call(univ2PairIface.encodeFunctionData("factory")),
    call(univ2PairIface.encodeFunctionData("token0")),
    call(univ2PairIface.encodeFunctionData("token1")),
  ]);
  if (
    !reservesRaw || reservesRaw === "0x" ||
    !factoryRaw || factoryRaw === "0x" ||
    !token0Raw || token0Raw === "0x" ||
    !token1Raw || token1Raw === "0x"
  ) return null;
  const decoded = univ2PairIface.decodeFunctionResult("getReserves", reservesRaw);
  const factory = ethers.getAddress(
    String(univ2PairIface.decodeFunctionResult("factory", factoryRaw)[0]),
  );
  const feeBps = v2FeeBpsForFactory(factory);
  if (feeBps === null) return null;
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
    feeBps,
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
  if (amountIn <= 0n || soldId === boughtId) return [];
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
    }
  }
  if (impacts.length > 0) return impacts;
  // A single edge is not proof of direction. Index mismatch remains
  // unresolved instead of being coerced into the only available route.
  return [];
}

function matchingTargetEdges(
  ctx: Pick<SwapObservationContext, "edgesByTarget">,
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

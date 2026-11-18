import { ethers } from "ethers";
import type { CompiledInstanceDescriptor } from "./adapter-family-plugin.js";
import type { TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import type { AnonymousLandedLogSelector } from "./landed-event-registry.js";
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

/** Opaque Ready authority; only the owning Family interprets the descriptor. */
export interface SwapObservationBinding {
  readonly familyId: string;
  readonly descriptor: CompiledInstanceDescriptor;
}
export type SwapObservationBindingResolver =
  (edge: TokenEdge) => SwapObservationBinding | null;

export interface SwapObservationContext {
  readonly logs: readonly SwapEventLog[];
  readonly graph: readonly TokenEdge[];
  readonly edgesByTarget: ReadonlyMap<string, readonly TokenEdge[]>;
  readonly tokenQuery?: TokenQueryBackend | null;
  readonly resolveBinding?: SwapObservationBindingResolver;
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

function topic0(log: SwapEventLog): string {
  return (log.topics[0] ?? "").toLowerCase();
}

import { ethers } from "ethers";
import type { TokenEdge } from "../../../planner/token-graph.js";
import {
  defineSwapLandedEvents,
  observedLandedPoolIdentity,
  singletonAnonymousDataBytes32Emitter,
} from "../../landed-event-registry.js";
import {
  createStrictSwapObservation,
  type PoolImpact,
  type ReceiptSwapObservationContext,
  type SwapEventLog,
} from "../../swap-observation.js";
import {
  EKUBO_CORE,
  EKUBO_CORE_SWAP_DATA_BYTES,
  EKUBO_CORE_SWAP_POOL_ID_OFFSET_BYTES,
  parseEkuboCoreSwapLog,
} from "./abi.js";
import {
  EKUBO_EDGE_ADAPTER_ID,
  EKUBO_POOL_ADAPTER_ID,
  EKUBO_SWAP_EVENT_ID,
} from "./ids.js";

export const ekuboLandedEvents = defineSwapLandedEvents({
  swaps: [{
    id: EKUBO_SWAP_EVENT_ID,
    topic: null,
    emitter: singletonAnonymousDataBytes32Emitter(
      EKUBO_CORE,
      EKUBO_CORE_SWAP_DATA_BYTES,
      EKUBO_CORE_SWAP_POOL_ID_OFFSET_BYTES,
    ),
    materialization: "family",
    discovery: {
      poolAdapter: EKUBO_POOL_ADAPTER_ID,
      label: "ekubo",
    },
    invalidatesWarmState: true,
  }],
  mutations: [],
});

const anonymousLogs = Object.freeze([{
  address: ethers.getAddress(EKUBO_CORE),
  dataLengthBytes: EKUBO_CORE_SWAP_DATA_BYTES,
  identityOffsetBytes: EKUBO_CORE_SWAP_POOL_ID_OFFSET_BYTES,
}]);

export const ekuboSwapObservation = createStrictSwapObservation({
  topics: Object.freeze([]),
  anonymousLogs,
  // Ekubo's signed int128 amount shares one selector across exact-input and
  // exact-output. This family intentionally has receipt/blockscan intake only.
  canonicalIntakeTargets: Object.freeze([]),
  observedPoolIdentity(log: SwapEventLog) {
    return observedLandedPoolIdentity(ekuboLandedEvents.swaps[0], log);
  },
  async decodeSwapImpacts(ctx: ReceiptSwapObservationContext) {
    return ctx.matchedOwnedTriggers.map((trigger) => {
      const parsed = parseEkuboCoreSwapLog(ctx.logs[trigger.logIndex].data);
      const directedSwap =
        (parsed.delta0 > 0n && parsed.delta1 < 0n) ||
        (parsed.delta1 > 0n && parsed.delta0 < 0n);
      if (!directedSwap) {
        if (parsed.delta0 === 0n || parsed.delta1 === 0n) {
          return Object.freeze({
            logIndex: trigger.logIndex,
            mutationOnlyReason:
              "canonical Ekubo Core log has no directed token flow",
          });
        }
        throw new Error(
          `Ekubo pool ${parsed.poolId} emitted an invalid balance update`,
        );
      }
      const edge = edgeForBalanceUpdate(
        ctx.graph,
        parsed.poolId,
        parsed.delta0,
        parsed.delta1,
      );
      if (!edge) {
        return Object.freeze({
          logIndex: trigger.logIndex,
          mutationOnlyReason:
            `canonical Ekubo swap direction is absent from the admitted graph`,
        });
      }
      return Object.freeze({
        logIndex: trigger.logIndex,
        impact: impactForEdge(
          edge,
          parsed.poolId,
          parsed.delta0,
          parsed.delta1,
        ),
      });
    });
  },
});

function edgeForBalanceUpdate(
  graph: readonly TokenEdge[],
  poolId: string,
  delta0: bigint,
  delta1: bigint,
): TokenEdge | null {
  const zeroForOne = delta0 > 0n && delta1 < 0n;
  const oneForZero = delta1 > 0n && delta0 < 0n;
  if (!zeroForOne && !oneForZero) {
    throw new Error(
      `Ekubo pool ${poolId} emitted a non-swap balance update`,
    );
  }
  const edges = graph.filter((edge) =>
    edge.adapterId === EKUBO_EDGE_ADAPTER_ID &&
    edge.poolId?.toLowerCase() === poolId.toLowerCase()
  );
  const edge = edges.find((candidate) => {
    if (!candidate.poolToken0 || !candidate.poolToken1) return false;
    return zeroForOne
      ? candidate.tokenIn.toLowerCase() === candidate.poolToken0.toLowerCase() &&
          candidate.tokenOut.toLowerCase() === candidate.poolToken1.toLowerCase()
      : candidate.tokenIn.toLowerCase() === candidate.poolToken1.toLowerCase() &&
          candidate.tokenOut.toLowerCase() === candidate.poolToken0.toLowerCase();
  });
  return edge ?? null;
}

function impactForEdge(
  edge: TokenEdge,
  poolId: string,
  delta0: bigint,
  delta1: bigint,
): PoolImpact {
  const zeroForOne =
    edge.tokenIn.toLowerCase() === edge.poolToken0?.toLowerCase();
  const amountIn = zeroForOne ? delta0 : delta1;
  const amountOut = -(zeroForOne ? delta1 : delta0);
  if (amountIn <= 0n || amountOut <= 0n) {
    throw new Error(`Ekubo pool ${poolId} emitted invalid swap deltas`);
  }
  return Object.freeze({
    pool: edge.target,
    poolId,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    amountIn,
    amountOut,
    matchedAdapterId: EKUBO_EDGE_ADAPTER_ID,
    poolToken0: edge.poolToken0,
    poolToken1: edge.poolToken1,
  });
}

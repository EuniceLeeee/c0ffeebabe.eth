import type { TokenEdge } from "../../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import {
  bindRequestResultRound,
  collectRequestProgramResults,
  type PricingSemantics,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import type { RouteVenueMid } from "../../mid-readers.js";
import {
  directedPoolMid,
  q96DirectedReserves,
  q96PrecisionProbeAmount,
} from "../blockscan-state-shared.js";
import {
  UNIV4_INITIALIZE_TOPIC,
  UNIV4_MODIFY_LIQUIDITY_TOPIC,
  UNIV4_QUOTER_INTERFACE,
  UNIV4_STATE_VIEW_INTERFACE,
  UNIV4_SWAP_TOPIC,
} from "../univ4-abi.js";
import {
  uniV4SnapshotCompatibilityProjection,
  uniV4StaticBindingProjection,
} from "../univ4-family/binding.js";
import {
  assertSameSource,
  poolKeyProjection,
  requireSuccessfulResult,
  sameAddress,
} from "../univ4-family/codec.js";
import type {
  FeeHookDescriptor,
  UniV4PrecisionOutcome,
  FeeHookPricingDescriptor,
  FeeHookPricingSnapshot,
  FeeHookRoute,
} from "./types.js";

const SLOT0_REQUEST_ID = "current-slot0";
const LIQUIDITY_REQUEST_ID = "current-liquidity";
const PRECISION_REQUEST_PREFIX = "univ4-precision:";
const MAX_UINT128 = (1n << 128n) - 1n;
const MUTATION_TOPICS = new Set([
  UNIV4_INITIALIZE_TOPIC,
  UNIV4_MODIFY_LIQUIDITY_TOPIC,
  UNIV4_SWAP_TOPIC,
]);

export const univ4FeeHookPricing = {
  stateKey: (route) => route.poolId,
  staticBindingProjection: ({ descriptor }) =>
    uniV4StaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: uniV4SnapshotCompatibilityProjection,
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.poolId) {
      throw new Error(`univ4 fee-hook pricing stateKey does not match ${descriptor.poolId}`);
    }
    assertRoutesMatchDescriptor(descriptor, routes);
    return {
      instanceKey: descriptor.instanceKey,
      poolId: descriptor.poolId,
      poolKey: descriptor.poolKey,
      graphToken0: descriptor.graphToken0,
      graphToken1: descriptor.graphToken1,
      managerBinding: descriptor.managerBinding,
    };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    poolKey: Object.freeze({ ...draft.poolKey }),
    managerBinding: Object.freeze({ ...draft.managerBinding }),
  }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      Object.freeze({
        id: SLOT0_REQUEST_ID,
        kind: "eth-call" as const,
        to: descriptor.managerBinding.stateView,
        data: UNIV4_STATE_VIEW_INTERFACE.encodeFunctionData(
          "getSlot0",
          [descriptor.poolId],
        ),
        completion: "return-data" as const,
      }),
      Object.freeze({
        id: LIQUIDITY_REQUEST_ID,
        kind: "eth-call" as const,
        to: descriptor.managerBinding.stateView,
        data: UNIV4_STATE_VIEW_INTERFACE.encodeFunctionData(
          "getLiquidity",
          [descriptor.poolId],
        ),
        completion: "return-data" as const,
      }),
    ]),
    buildDependentProgram({
      current,
      completedRound,
      initialResults,
      priorEvidence,
    }) {
      if (completedRound > 0) return null;
      const priorResults = collectRequestProgramResults(
        initialResults,
        priorEvidence,
      );
      assertRoutesMatchPricingDescriptor(current.descriptor, current.routes);
      const snapshot = decodeCoreSnapshot(priorResults);
      if (snapshot.inactiveReason !== null) return null;
      const requests = Object.freeze(current.routes.flatMap((route) => {
        const amountIn = precisionAmount(current.descriptor, snapshot, route);
        if (amountIn === null) return [];
        const id = precisionRequestId(route, amountIn);
        if (priorResults.some((result) => result.id === id)) return [];
        return [Object.freeze({
          id,
          kind: "eth-call" as const,
          to: current.descriptor.managerBinding.quoter,
          data: encodeQuote(current.descriptor, route, amountIn),
          completion: "return-or-revert-data" as const,
        })];
      }));
      return requests.length === 0
        ? null
        : bindRequestResultRound({ transports: ["eth-call"] }, requests);
    },
    decodeSnapshot: ({ initialResults, dependentEvidence }) => decodeSnapshot(
      collectRequestProgramResults(initialResults, dependentEvidence),
    ),
    deriveMids({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      if (snapshot.inactiveReason !== null) return new Map();
      const mids = new Map<FeeHookRoute["routeKey"], RouteVenueMid>();
      for (const route of routes) {
        const amountIn = precisionAmount(descriptor, snapshot, route);
        const outcome = amountIn === null
          ? undefined
          : snapshot.precision[precisionRequestId(route, amountIn)];
        if (amountIn !== null && outcome === undefined) {
          throw new Error(`univ4 precision result missing for ${route.routeKey}`);
        }
        if (
          amountIn !== null &&
          (outcome?.failure !== undefined ||
            outcome?.amountOut === undefined ||
            outcome.amountOut === 0n)
        ) {
          continue;
        }
        const edge = routeEdge(descriptor, route);
        const directed = q96DirectedReserves({
          sqrtPriceX96: snapshot.sqrtPriceX96,
          liquidity: snapshot.liquidity,
          token0: descriptor.graphToken0,
          token1: descriptor.graphToken1,
          edge,
          ...(amountIn === null
            ? {}
            : { precisionQuote: { amountIn, amountOut: outcome!.amountOut! } }),
        });
        if (directed === null) continue;
        mids.set(route.routeKey, directedPoolMid({
          kind: "v4",
          edge,
          reserveIn: directed.reserveIn,
          reserveOut: directed.reserveOut,
          mid: directed.mid,
          sqrtPriceX96: directed.sqrtPriceInOutX96,
          liquidity: snapshot.liquidity,
          feeBps: Number(snapshot.lpFee) / 100,
        }));
      }
      return mids;
    },
    classifyUnavailable({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      const unavailable = new Map<FeeHookRoute["routeKey"], string>();
      if (snapshot.inactiveReason !== null) {
        for (const route of routes) {
          unavailable.set(route.routeKey, snapshot.inactiveReason);
        }
        return unavailable;
      }
      for (const route of routes) {
        const amountIn = precisionAmount(descriptor, snapshot, route);
        if (amountIn === null) continue;
        const outcome = snapshot.precision[
          precisionRequestId(route, amountIn)
        ];
        if (outcome === undefined) {
          throw new Error(`univ4 precision result missing for ${route.routeKey}`);
        }
        if (outcome.failure !== undefined) {
          unavailable.set(
            route.routeKey,
            `univ4 direction ${route.tokenIn}->${route.tokenOut} ` +
              `current-source precision witness failed: ${outcome.failure}`,
          );
        } else if (outcome.amountOut === 0n) {
          unavailable.set(
            route.routeKey,
            `univ4 direction ${route.tokenIn}->${route.tokenOut} returned zero ` +
              `at its current-source scanner ceiling ${amountIn}`,
          );
        }
      }
      return unavailable;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.managerBinding.manager,
    descriptor.managerBinding.stateView,
    descriptor.managerBinding.quoter,
    descriptor.poolKey.currency0,
    descriptor.poolKey.currency1,
  ]),
  mutation: {
    affectedStateKeys({ descriptor, observation }) {
      if (
        observation.kind !== "log" ||
        !sameAddress(observation.address, descriptor.managerBinding.manager) ||
        !MUTATION_TOPICS.has(observation.topics[0]?.toLowerCase() ?? "") ||
        observation.topics[1]?.toLowerCase() !== descriptor.poolId
      ) {
        return [];
      }
      return [descriptor.poolId];
    },
  },
  liveStateProjection: {
    project: ({ descriptor, snapshot }) => ({
      kind: "v4-live",
      manager: descriptor.managerBinding.manager,
      poolId: descriptor.poolId,
      poolKey: poolKeyProjection(descriptor.poolKey),
      sqrtPriceX96: snapshot.sqrtPriceX96,
      tick: snapshot.tick,
      liquidity: snapshot.liquidity,
      protocolFee: snapshot.protocolFee,
      lpFee: snapshot.lpFee,
      blockNumber: snapshot.source.number,
    }),
  },
} satisfies PricingSemantics<
  FeeHookDescriptor,
  FeeHookRoute,
  FeeHookPricingDescriptor,
  FeeHookPricingSnapshot
>;

function decodeSnapshot(
  results: readonly AdapterRequestResult[],
): FeeHookPricingSnapshot {
  const core = decodeCoreSnapshot(results);
  const precision: Record<string, UniV4PrecisionOutcome> = {};
  for (const result of results) {
    if (!result.id.startsWith(PRECISION_REQUEST_PREFIX)) continue;
    const amountIn = precisionAmountFromRequestId(result.id);
    if (!result.ok) {
      throw new Error(
        `univ4 request result ${result.id} is unresolved: ${result.failure}`,
      );
    }
    assertSameSource(core.source, result.source);
    if (result.completion === "reverted-as-declared") {
      precision[result.id] = Object.freeze({
        amountIn,
        failure: "quote call reverted",
      });
      continue;
    }
    const decoded = UNIV4_QUOTER_INTERFACE.decodeFunctionResult(
      "quoteExactInputSingle",
      result.data,
    );
    precision[result.id] = Object.freeze({
      amountIn,
      amountOut: BigInt(decoded[0]),
    });
  }
  return Object.freeze({ ...core, precision });
}

function decodeCoreSnapshot(
  results: readonly AdapterRequestResult[],
): Omit<FeeHookPricingSnapshot, "precision"> {
  const slot0Result = requireSuccessfulResult(results, SLOT0_REQUEST_ID);
  const liquidityResult = requireSuccessfulResult(results, LIQUIDITY_REQUEST_ID);
  assertSameSource(slot0Result.source, liquidityResult.source);
  const slot0 = UNIV4_STATE_VIEW_INTERFACE.decodeFunctionResult(
    "getSlot0",
    slot0Result.data,
  );
  const liquidity = BigInt(UNIV4_STATE_VIEW_INTERFACE.decodeFunctionResult(
    "getLiquidity",
    liquidityResult.data,
  )[0]);
  const sqrtPriceX96 = BigInt(slot0[0]);
  const inactive = [];
  if (sqrtPriceX96 === 0n) inactive.push("sqrtPriceX96");
  if (liquidity === 0n) inactive.push("liquidity");
  return Object.freeze({
    source: slot0Result.source,
    sqrtPriceX96,
    tick: Number(slot0[1]),
    liquidity,
    protocolFee: BigInt(slot0[2]),
    lpFee: BigInt(slot0[3]),
    inactiveReason: inactive.length === 0
      ? null
      : `univ4 pool has zero ${inactive.join(" and ")} at the current source`,
  });
}

function precisionAmount(
  descriptor: FeeHookPricingDescriptor,
  snapshot: Pick<FeeHookPricingSnapshot, "sqrtPriceX96" | "liquidity">,
  route: FeeHookRoute,
): bigint | null {
  return q96PrecisionProbeAmount({
    sqrtPriceX96: snapshot.sqrtPriceX96,
    liquidity: snapshot.liquidity,
    token0: descriptor.graphToken0,
    token1: descriptor.graphToken1,
    edge: routeEdge(descriptor, route),
    maxAmountIn: MAX_UINT128,
  });
}

function precisionRequestId(route: FeeHookRoute, amountIn: bigint): string {
  return `${PRECISION_REQUEST_PREFIX}${amountIn}:` + hashCanonical({
    routeKey: route.routeKey,
    amountIn,
  });
}

function precisionAmountFromRequestId(id: string): bigint {
  const amount = id.slice(PRECISION_REQUEST_PREFIX.length).split(":", 1)[0];
  try {
    return BigInt(amount);
  } catch {
    throw new Error(`univ4 precision request id has invalid amount ${id}`);
  }
}

function encodeQuote(
  descriptor: FeeHookPricingDescriptor,
  route: FeeHookRoute,
  amountIn: bigint,
): string {
  return UNIV4_QUOTER_INTERFACE.encodeFunctionData("quoteExactInputSingle", [{
    poolKey: descriptor.poolKey,
    zeroForOne: route.direction === "zero-for-one",
    exactAmount: amountIn,
    hookData: "0x",
  }]);
}

function assertRoutesMatchDescriptor(
  descriptor: FeeHookDescriptor,
  routes: readonly FeeHookRoute[],
): void {
  for (const route of routes) {
    if (
      route.instanceKey !== descriptor.instanceKey ||
      route.poolId !== descriptor.poolId ||
      !sameAddress(route.manager, descriptor.managerBinding.manager)
    ) {
      throw new Error(`univ4 route does not belong to ${descriptor.poolId}`);
    }
  }
}

function assertRoutesMatchPricingDescriptor(
  descriptor: FeeHookPricingDescriptor,
  routes: readonly FeeHookRoute[],
): void {
  for (const route of routes) {
    const zeroForOne = route.direction === "zero-for-one";
    const expectedIn = zeroForOne
      ? descriptor.graphToken0
      : descriptor.graphToken1;
    const expectedOut = zeroForOne
      ? descriptor.graphToken1
      : descriptor.graphToken0;
    if (
      route.instanceKey !== descriptor.instanceKey ||
      route.poolId !== descriptor.poolId ||
      !sameAddress(route.manager, descriptor.managerBinding.manager) ||
      !sameAddress(route.tokenIn, expectedIn) ||
      !sameAddress(route.tokenOut, expectedOut)
    ) {
      throw new Error(`univ4 route binding does not match ${descriptor.poolId}`);
    }
  }
}

function routeEdge(
  descriptor: FeeHookPricingDescriptor,
  route: FeeHookRoute,
): TokenEdge {
  return Object.freeze({
    adapterId: "univ4-unlock",
    instanceKey: route.instanceKey,
    target: descriptor.managerBinding.manager,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: "swap" as const,
    poolId: descriptor.poolId,
    poolToken0: descriptor.graphToken0,
    poolToken1: descriptor.graphToken1,
    v4PoolKey: descriptor.poolKey,
    ...deriveEdgeTaxonomy("swap"),
  });
}

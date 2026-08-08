import type { TokenEdge } from "../../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type {
  AdapterRequestResult,
} from "../../adapter-request-program.js";
import type { RouteVenueMid } from "../../mid-readers.js";
import {
  directedPoolMid,
  q96DirectedReserves,
  q96PrecisionProbeAmount,
} from "../blockscan-state-shared.js";
import {
  UNIV4_STATE_VIEW_INTERFACE,
  UNIV4_SWAP_TOPIC,
} from "../univ4-abi.js";
import {
  angstromV4SnapshotCompatibilityProjection,
  angstromV4StaticBindingProjection,
} from "./binding.js";
import {
  assertSameSource,
  poolKeyProjection,
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import type {
  AngstromV4Descriptor,
  AngstromV4PricingDescriptor,
  AngstromV4PricingSnapshot,
  AngstromV4Route,
} from "./types.js";

const SLOT0_REQUEST_ID = "current-slot0";
const LIQUIDITY_REQUEST_ID = "current-liquidity";
const MAX_UINT128 = (1n << 128n) - 1n;

export const angstromV4Pricing = {
  stateKey: (route) => route.poolId,
  staticBindingProjection: ({ descriptor }) =>
    angstromV4StaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: angstromV4SnapshotCompatibilityProjection,
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.poolId) {
      throw new Error(
        `angstrom-v4 pricing stateKey does not match ${descriptor.poolId}`,
      );
    }
    assertRoutesMatchDescriptor(descriptor, routes);
    return {
      instanceKey: descriptor.instanceKey,
      poolId: descriptor.poolId,
      poolKey: descriptor.poolKey,
      immutableBinding: descriptor.immutableBinding,
    };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    poolKey: Object.freeze({ ...draft.poolKey }),
    immutableBinding: Object.freeze({ ...draft.immutableBinding }),
  }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      Object.freeze({
        id: SLOT0_REQUEST_ID,
        kind: "eth-call" as const,
        to: descriptor.immutableBinding.stateView,
        data: UNIV4_STATE_VIEW_INTERFACE.encodeFunctionData(
          "getSlot0",
          [descriptor.poolId],
        ),
        completion: "return-data" as const,
      }),
      Object.freeze({
        id: LIQUIDITY_REQUEST_ID,
        kind: "eth-call" as const,
        to: descriptor.immutableBinding.stateView,
        data: UNIV4_STATE_VIEW_INTERFACE.encodeFunctionData(
          "getLiquidity",
          [descriptor.poolId],
        ),
        completion: "return-data" as const,
      }),
    ]),
    decodeSnapshot: ({ initialResults }) => decodeSnapshot(initialResults),
    deriveMids({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      const mids = new Map<AngstromV4Route["routeKey"], RouteVenueMid>();
      if (snapshot.inactiveReason !== null) return mids;
      for (const route of routes) {
        if (needsTxBoundPrecision(descriptor, snapshot, route)) continue;
        const edge = routeEdge(descriptor, route);
        const directed = q96DirectedReserves({
          sqrtPriceX96: snapshot.sqrtPriceX96,
          liquidity: snapshot.liquidity,
          token0: descriptor.poolKey.currency0,
          token1: descriptor.poolKey.currency1,
          edge,
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
      const unavailable = new Map<AngstromV4Route["routeKey"], string>();
      for (const route of routes) {
        const reason = snapshot.inactiveReason ??
          (needsTxBoundPrecision(descriptor, snapshot, route)
            ? `angstrom-v4 direction ${route.tokenIn}->${route.tokenOut} ` +
              "requires tx-bound evidence for a current-source precision quote"
            : null);
        if (reason !== null) unavailable.set(route.routeKey, reason);
      }
      return unavailable;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.immutableBinding.manager,
    descriptor.immutableBinding.stateView,
    descriptor.immutableBinding.quoter,
    descriptor.immutableBinding.hook,
    descriptor.immutableBinding.adapter,
    descriptor.immutableBinding.controller,
    descriptor.poolKey.currency0,
    descriptor.poolKey.currency1,
  ]),
  mutation: {
    affectedStateKeys({ descriptor, observation }) {
      if (
        observation.kind !== "log" ||
        !sameAddress(observation.address, descriptor.immutableBinding.manager) ||
        observation.topics[0]?.toLowerCase() !== UNIV4_SWAP_TOPIC ||
        observation.topics[1]?.toLowerCase() !== descriptor.poolId
      ) {
        return [];
      }
      return [descriptor.poolId];
    },
  },
  liveStateProjection: {
    project: ({ descriptor, snapshot }) => ({
      kind: "angstrom-v4-live",
      manager: descriptor.immutableBinding.manager,
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
  AngstromV4Descriptor,
  AngstromV4Route,
  AngstromV4PricingDescriptor,
  AngstromV4PricingSnapshot
>;

function decodeSnapshot(
  results: readonly AdapterRequestResult[],
): AngstromV4PricingSnapshot {
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
      : `angstrom-v4 pool has zero ${inactive.join(" and ")} at the current source`,
  });
}

function needsTxBoundPrecision(
  descriptor: AngstromV4PricingDescriptor,
  snapshot: AngstromV4PricingSnapshot,
  route: AngstromV4Route,
): boolean {
  if (snapshot.inactiveReason !== null) return false;
  return q96PrecisionProbeAmount({
    sqrtPriceX96: snapshot.sqrtPriceX96,
    liquidity: snapshot.liquidity,
    token0: descriptor.poolKey.currency0,
    token1: descriptor.poolKey.currency1,
    edge: routeEdge(descriptor, route),
    maxAmountIn: MAX_UINT128,
  }) !== null;
}

function assertRoutesMatchDescriptor(
  descriptor: AngstromV4Descriptor,
  routes: readonly AngstromV4Route[],
): void {
  for (const route of routes) {
    if (
      route.instanceKey !== descriptor.instanceKey ||
      route.poolId !== descriptor.poolId ||
      !sameAddress(route.manager, descriptor.immutableBinding.manager)
    ) {
      throw new Error(`angstrom-v4 route does not belong to ${descriptor.poolId}`);
    }
  }
}

function assertRoutesMatchPricingDescriptor(
  descriptor: AngstromV4PricingDescriptor,
  routes: readonly AngstromV4Route[],
): void {
  for (const route of routes) {
    const zeroForOne = route.direction === "zero-for-one";
    const expectedIn = zeroForOne
      ? descriptor.poolKey.currency0
      : descriptor.poolKey.currency1;
    const expectedOut = zeroForOne
      ? descriptor.poolKey.currency1
      : descriptor.poolKey.currency0;
    if (
      route.instanceKey !== descriptor.instanceKey ||
      route.poolId !== descriptor.poolId ||
      !sameAddress(route.manager, descriptor.immutableBinding.manager) ||
      !sameAddress(route.tokenIn, expectedIn) ||
      !sameAddress(route.tokenOut, expectedOut)
    ) {
      throw new Error(
        `angstrom-v4 route binding does not match ${descriptor.poolId}`,
      );
    }
  }
}

function routeEdge(
  descriptor: AngstromV4PricingDescriptor,
  route: AngstromV4Route,
): TokenEdge {
  return Object.freeze({
    adapterId: "angstrom-v4-swap",
    instanceKey: route.instanceKey,
    target: descriptor.immutableBinding.manager,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: "swap" as const,
    poolId: descriptor.poolId,
    poolToken0: descriptor.poolKey.currency0,
    poolToken1: descriptor.poolKey.currency1,
    v4PoolKey: descriptor.poolKey,
    ...deriveEdgeTaxonomy("swap"),
  });
}

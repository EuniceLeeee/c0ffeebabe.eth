import type { TokenEdge } from "../../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import type { RouteVenueMid } from "../../mid-readers.js";
import { directedPoolMid } from "../blockscan-state-shared.js";
import {
  decodeReservesResult,
  lowerAddress,
  sameAddress,
  UNIV2_PAIR_INTERFACE,
  UNIV2_SYNC_TOPIC,
} from "./codec.js";
import type {
  UniV2Descriptor,
  UniV2PricingDescriptor,
  UniV2PricingSnapshot,
  UniV2Route,
} from "./types.js";

const CURRENT_RESERVES_REQUEST_ID = "current-reserves";

export const univ2Pricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) => ({
    pool: descriptor.pool,
    token0: descriptor.token0,
    token1: descriptor.token1,
    feeRule: {
      kind: descriptor.feeRule.kind,
      feeBps: descriptor.feeRule.feeBps,
      evidence: descriptor.feeRule.evidence,
    },
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      reversePool: descriptor.factoryBinding.reversePool,
    },
  }),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    pool: descriptor.pool,
    token0: descriptor.token0,
    token1: descriptor.token1,
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey) {
      throw new Error(`univ2 pricing stateKey does not match ${descriptor.pool}`);
    }
    assertRoutesMatchDescriptor(descriptor, routes);
    return {
      instanceKey: descriptor.instanceKey,
      pool: descriptor.pool,
      token0: descriptor.token0,
      token1: descriptor.token1,
      feeRule: descriptor.feeRule,
      factoryBinding: descriptor.factoryBinding,
    };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    feeRule: Object.freeze({ ...draft.feeRule }),
    factoryBinding: Object.freeze({ ...draft.factoryBinding }),
  }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) => [Object.freeze({
      id: CURRENT_RESERVES_REQUEST_ID,
      kind: "eth-call" as const,
      to: descriptor.pool,
      data: UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves"),
      completion: "return-data" as const,
    })],
    decodeSnapshot: ({ initialResults }) => Object.freeze(
      decodeReservesResult(initialResults, CURRENT_RESERVES_REQUEST_ID),
    ),
    deriveMids({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      if (snapshot.reserve0 === 0n || snapshot.reserve1 === 0n) return new Map();
      const mids = new Map<UniV2Route["routeKey"], RouteVenueMid>();
      for (const route of routes) {
        const zeroForOne = route.direction === "zero-for-one";
        mids.set(route.routeKey, directedPoolMid({
          kind: "v2",
          edge: routeEdge(descriptor, route),
          reserveIn: zeroForOne ? snapshot.reserve0 : snapshot.reserve1,
          reserveOut: zeroForOne ? snapshot.reserve1 : snapshot.reserve0,
          feeBps: Number(descriptor.feeRule.feeBps),
        }));
      }
      return mids;
    },
    classifyUnavailable({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      const unavailable = new Map<UniV2Route["routeKey"], string>();
      if (snapshot.reserve0 !== 0n && snapshot.reserve1 !== 0n) return unavailable;
      const reason = `univ2 pool ${descriptor.pool} has zero reserve at the current source`;
      for (const route of routes) unavailable.set(route.routeKey, reason);
      return unavailable;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.pool,
    descriptor.token0,
    descriptor.token1,
  ]),
  mutation: {
    affectedStateKeys({ descriptor, observation }) {
      if (
        observation.kind !== "log" ||
        observation.topics[0]?.toLowerCase() !== UNIV2_SYNC_TOPIC.toLowerCase() ||
        !sameAddress(observation.address, descriptor.pool)
      ) {
        return [];
      }
      return [descriptor.instanceKey];
    },
  },
  liveStateProjection: {
    project: ({ descriptor, snapshot }) => ({
      kind: "v2",
      pool: descriptor.pool,
      token0: descriptor.token0,
      token1: descriptor.token1,
      reserve0: snapshot.reserve0,
      reserve1: snapshot.reserve1,
      feeBps: descriptor.feeRule.feeBps,
      blockTimestampLast: snapshot.blockTimestampLast,
      blockNumber: snapshot.source.number,
    }),
  },
} satisfies PricingSemantics<
  UniV2Descriptor,
  UniV2Route,
  UniV2PricingDescriptor,
  UniV2PricingSnapshot
>;

function assertRoutesMatchDescriptor(
  descriptor: UniV2Descriptor,
  routes: readonly UniV2Route[],
): void {
  for (const route of routes) {
    if (
      route.instanceKey !== descriptor.instanceKey ||
      !sameAddress(route.pool, descriptor.pool)
    ) {
      throw new Error(`univ2 route does not belong to ${descriptor.pool}`);
    }
  }
}

function assertRoutesMatchPricingDescriptor(
  descriptor: UniV2PricingDescriptor,
  routes: readonly UniV2Route[],
): void {
  for (const route of routes) {
    const zeroForOne = route.direction === "zero-for-one";
    const expectedIn = zeroForOne ? descriptor.token0 : descriptor.token1;
    const expectedOut = zeroForOne ? descriptor.token1 : descriptor.token0;
    if (
      route.instanceKey !== descriptor.instanceKey ||
      !sameAddress(route.pool, descriptor.pool) ||
      !sameAddress(route.tokenIn, expectedIn) ||
      !sameAddress(route.tokenOut, expectedOut)
    ) {
      throw new Error(`univ2 route binding does not match ${descriptor.pool}`);
    }
  }
}

function routeEdge(
  descriptor: UniV2PricingDescriptor,
  route: UniV2Route,
): TokenEdge {
  return Object.freeze({
    adapterId: "univ2-swap",
    instanceKey: route.instanceKey,
    target: descriptor.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: "swap" as const,
    poolToken0: descriptor.token0,
    poolToken1: descriptor.token1,
    v2FeeBps: descriptor.feeRule.feeBps,
    factory: descriptor.factoryBinding.factory,
    ...deriveEdgeTaxonomy("swap"),
  });
}

export function decodeUniV2PricingSnapshotForTest(
  results: readonly AdapterRequestResult[],
): UniV2PricingSnapshot {
  return Object.freeze(decodeReservesResult(results, CURRENT_RESERVES_REQUEST_ID));
}

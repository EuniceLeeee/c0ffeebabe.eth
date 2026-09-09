import type { TokenEdge } from "../../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import type { RouteVenueMid } from "../../mid-readers.js";
import { directedPoolMid, quotedPoolMid } from "../blockscan-state-shared.js";
import { decodePoolQuote, poolQuoteRequest } from "./pool-quote.js";
import { uniV2InputCapacity } from "./reserve-capacity.js";
import {
  decodeReservesResult,
  requireSuccessfulResult,
  UNIV2_TOKEN_INTERFACE,
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
    quoteModel: descriptor.quoteModel,
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
    quoteModel: descriptor.quoteModel,
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
      quoteModel: descriptor.quoteModel,
      factoryBinding: descriptor.factoryBinding,
    };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    feeRule: Object.freeze({ ...draft.feeRule }),
    quoteModel: Object.freeze({ ...draft.quoteModel }),
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
    }), ...[descriptor.token0, descriptor.token1].map((token, index) => Object.freeze({
      id: `current-balance-${index}`, kind: "eth-call" as const, to: token,
      data: UNIV2_TOKEN_INTERFACE.encodeFunctionData("balanceOf", [descriptor.pool]),
      completion: "return-data" as const,
    })), ...(descriptor.quoteModel.kind === "pool-get-amount-out" ? [
      poolQuoteRequest("current-quote-0", descriptor.pool, descriptor.token0, descriptor.quoteModel.probe0),
      poolQuoteRequest("current-quote-1", descriptor.pool, descriptor.token1, descriptor.quoteModel.probe1),
    ] : [])],
    decodeSnapshot: ({ descriptor, initialResults }) => Object.freeze({
      ...decodeReservesResult(initialResults, CURRENT_RESERVES_REQUEST_ID),
      balance0: decodeBalance(initialResults, "current-balance-0"),
      balance1: decodeBalance(initialResults, "current-balance-1"),
      ...(descriptor.quoteModel.kind === "pool-get-amount-out" ? {
        quoted0: decodePoolQuote(initialResults, "current-quote-0") ?? 0n,
        quoted1: decodePoolQuote(initialResults, "current-quote-1") ?? 0n,
      } : {}),
    }),
    deriveMids({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      if (snapshot.reserve0 === 0n || snapshot.reserve1 === 0n) return new Map();
      const mids = new Map<UniV2Route["routeKey"], RouteVenueMid>();
      for (const route of routes) {
        const zeroForOne = route.direction === "zero-for-one";
        const balanceHeadroomIn = uniV2InputCapacity(zeroForOne ? snapshot.balance0 : snapshot.balance1);
        if (descriptor.quoteModel.kind === "pool-get-amount-out") {
          const amountOut = zeroForOne ? snapshot.quoted0 : snapshot.quoted1;
          if (amountOut === undefined) throw new Error("univ2 pool-quote snapshot missing quote");
          if (amountOut <= 0n) continue;
          mids.set(route.routeKey, { ...quotedPoolMid({
            kind: "v2", edge: routeEdge(descriptor, route),
            amountIn: zeroForOne ? descriptor.quoteModel.probe0 : descriptor.quoteModel.probe1,
            amountOut,
            depthIn: zeroForOne ? snapshot.reserve0 : snapshot.reserve1,
            depthOut: zeroForOne ? snapshot.reserve1 : snapshot.reserve0,
            // The pool quote already includes its current fee. Applying the
            // factory's xyk fee again would double-charge the mid.
            feeBps: 0,
          }), balanceHeadroomIn });
          continue;
        }
        mids.set(route.routeKey, { ...directedPoolMid({
          kind: "v2",
          edge: routeEdge(descriptor, route),
          reserveIn: zeroForOne ? snapshot.reserve0 : snapshot.reserve1,
          reserveOut: zeroForOne ? snapshot.reserve1 : snapshot.reserve0,
          feeBps: Number(descriptor.feeRule.feeBps),
        }), balanceHeadroomIn });
      }
      return mids;
    },
    classifyUnavailable({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      const unavailable = new Map<UniV2Route["routeKey"], string>();
      if (descriptor.quoteModel.kind === "pool-get-amount-out") {
        for (const route of routes) {
          const quote = route.direction === "zero-for-one" ? snapshot.quoted0 : snapshot.quoted1;
          if (quote === undefined || quote <= 0n) {
            unavailable.set(route.routeKey, "univ2 pool-owned mid quote unavailable at current source");
          }
        }
      }
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
    project: ({ descriptor, snapshot }) => descriptor.quoteModel.kind !== "constant-product" ? null : ({
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

function decodeBalance(results: readonly AdapterRequestResult[], id: string): bigint {
  return BigInt(UNIV2_TOKEN_INTERFACE.decodeFunctionResult(
    "balanceOf", requireSuccessfulResult(results, id).data,
  )[0]);
}

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
  return Object.freeze({
    ...decodeReservesResult(results, CURRENT_RESERVES_REQUEST_ID),
    balance0: decodeBalance(results, "current-balance-0"),
    balance1: decodeBalance(results, "current-balance-1"),
  });
}

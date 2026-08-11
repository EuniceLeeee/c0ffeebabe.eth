import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import type { TokenEdge } from "../../../planner/token-graph.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import {
  decodeDeclaredFluidDexQuote,
  FLUID_DEX_INTERFACE,
  lowerAddress,
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import type {
  FluidDexDescriptor,
  FluidDexPricingDescriptor,
  FluidDexPricingSnapshot,
  FluidDexRoute,
} from "./types.js";

const CURRENT_QUOTE_ID = "current-fluid-dex-quote";

export const fluidDexPricing = {
  stateKey: (route) => route.routeKey,
  staticBindingProjection: ({ descriptor, routes }) => ({
    pool: descriptor.pool,
    token0: descriptor.token0,
    token1: descriptor.token1,
    token0Decimals: descriptor.token0Decimals,
    token1Decimals: descriptor.token1Decimals,
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      dexId: descriptor.factoryBinding.dexId,
      reverseDex: descriptor.factoryBinding.reverseDex,
    },
    quoteBinding: {
      target: descriptor.quoteBinding.target,
      recipient: descriptor.quoteBinding.recipient,
      completion: descriptor.quoteBinding.completion,
      successEncoding: descriptor.quoteBinding.successEncoding,
    },
    directions: routes.map((route) => ({
      routeKey: route.routeKey,
      swap0To1: route.swap0To1,
    })),
  }),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({
    pool: descriptor.pool,
    quoteBinding: {
      target: descriptor.quoteBinding.target,
      recipient: descriptor.quoteBinding.recipient,
      completion: descriptor.quoteBinding.completion,
      successEncoding: descriptor.quoteBinding.successEncoding,
    },
    directions: routes.map((route) => ({
      routeKey: route.routeKey,
      swap0To1: route.swap0To1,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
    })),
  }),
  compileDraft({ descriptor, routes }) {
    if (routes.length !== 1) {
      throw new Error("fluid-dex pricing requires one directed route");
    }
    const route = routes[0];
    assertRoute(descriptor, route);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      pool: descriptor.pool,
      token0: descriptor.token0,
      token1: descriptor.token1,
      token0Decimals: descriptor.token0Decimals,
      token1Decimals: descriptor.token1Decimals,
      quoteBinding: descriptor.quoteBinding,
      route,
    });
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    quoteBinding: Object.freeze({ ...draft.quoteBinding }),
  }),
  current: {
    requirements: () => ({
      transports: ["eth-call"],
      effects: ["revert-data"],
    }),
    buildRequests({ descriptor }) {
      return Object.freeze([Object.freeze({
        id: CURRENT_QUOTE_ID,
        kind: "eth-call" as const,
        to: descriptor.quoteBinding.target,
        data: FLUID_DEX_INTERFACE.encodeFunctionData("swapIn", [
          descriptor.route.swap0To1,
          probeAmount(descriptor),
          0n,
          descriptor.quoteBinding.recipient,
        ]),
        completion: "return-or-revert-data" as const,
      })]);
    },
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      const result = requireSuccessfulResult(results, CURRENT_QUOTE_ID);
      const amountOut = decodeDeclaredFluidDexQuote(result);
      if (amountOut === null) {
        throw new Error(
          "fluid-dex current quote did not return its declared custom-error payload",
        );
      }
      return Object.freeze({
        source: result.source,
        amountIn: probeAmount(descriptor),
        amountOut,
        completion: "reverted-as-declared" as const,
      });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (routes.length !== 1) {
        throw new Error("fluid-dex pricing snapshot requires one route");
      }
      const route = routes[0];
      assertPricingRoute(descriptor, route);
      return new Map([[route.routeKey, quotedPoolMid({
        kind: "external-swap",
        edge: routeEdge(descriptor, route),
        amountIn: snapshot.amountIn,
        amountOut: snapshot.amountOut,
        depthIn: snapshot.amountIn * 10_000n,
        depthOut: snapshot.amountOut * 10_000n,
      })]]);
    },
  },
  dependencies: ({ descriptor }) => Object.freeze(
    [...new Set([
      lowerAddress(descriptor.pool),
      lowerAddress(descriptor.token0),
      lowerAddress(descriptor.token1),
      lowerAddress(descriptor.quoteBinding.target),
    ])].sort(),
  ),
  mutation: {
    affectedStateKeys({ descriptor, routes, observation }) {
      if (
        observation.kind !== "log" ||
        !sameAddress(observation.address, descriptor.pool)
      ) {
        return [];
      }
      return Object.freeze(routes.map((route) => route.routeKey));
    },
  },
  liveStateProjection: {
    project: ({ descriptor, snapshot }) => ({
      kind: "fluid-dex-declared-revert-quote",
      pool: descriptor.pool,
      routeKey: descriptor.route.routeKey,
      amountIn: snapshot.amountIn,
      amountOut: snapshot.amountOut,
      completion: snapshot.completion,
      blockNumber: snapshot.source.number,
    }),
  },
} satisfies PricingSemantics<
  FluidDexDescriptor,
  FluidDexRoute,
  FluidDexPricingDescriptor,
  FluidDexPricingSnapshot
>;

function probeAmount(descriptor: FluidDexPricingDescriptor): bigint {
  return 10n ** BigInt(
    descriptor.route.swap0To1
      ? descriptor.token0Decimals
      : descriptor.token1Decimals,
  );
}

function assertRoute(
  descriptor: FluidDexDescriptor,
  route: FluidDexRoute | undefined,
): asserts route is FluidDexRoute {
  if (route === undefined) throw new Error("fluid-dex route is missing");
  const expectedIn = route.swap0To1 ? descriptor.token0 : descriptor.token1;
  const expectedOut = route.swap0To1 ? descriptor.token1 : descriptor.token0;
  if (
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    !sameAddress(route.tokenIn, expectedIn) ||
    !sameAddress(route.tokenOut, expectedOut)
  ) {
    throw new Error("fluid-dex route does not match descriptor binding");
  }
}

function assertPricingRoute(
  descriptor: FluidDexPricingDescriptor,
  route: FluidDexRoute | undefined,
): asserts route is FluidDexRoute {
  if (
    route === undefined ||
    route.routeKey !== descriptor.route.routeKey ||
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    route.swap0To1 !== descriptor.route.swap0To1
  ) {
    throw new Error("fluid-dex pricing route does not match descriptor");
  }
}

function routeEdge(
  descriptor: FluidDexPricingDescriptor,
  route: FluidDexRoute,
): TokenEdge {
  return Object.freeze({
    adapterId: "fluid-dex-swap",
    instanceKey: route.instanceKey,
    target: descriptor.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: "swap" as const,
    poolToken0: descriptor.token0,
    poolToken1: descriptor.token1,
    ...deriveEdgeTaxonomy("swap"),
  });
}

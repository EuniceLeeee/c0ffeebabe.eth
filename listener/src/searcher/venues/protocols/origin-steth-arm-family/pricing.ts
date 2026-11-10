import { compileAddressMutations } from "../../mutation-index.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import {
  assertSameSource,
  lowerAddress,
  protocolMid,
  returnedResult,
  sameAddress,
  type ProtocolPricingSnapshot,
} from "../standard-family/common.js";
import {
  assertOriginStethArmInvocation,
  originStethArmStaticBindingProjection,
} from "./binding.js";
import {
  ORIGIN_STETH_ARM_DIRECTIONS,
  ORIGIN_STETH_ARM_MAX_RATE,
  ORIGIN_STETH_ARM_PRICE_SAMPLE,
  ORIGIN_STETH_ARM_TRADERATE0_SLOT,
  ORIGIN_STETH_ARM_TRADERATE1_SLOT,
  originStethArmQuote,
  storageRequest,
  storageWordToUint,
  type OriginStethArmDirection,
} from "./codec.js";
import type {
  OriginStethArmDescriptor,
  OriginStethArmPricingDescriptor,
  OriginStethArmRoute,
} from "./types.js";

type Snapshot = ProtocolPricingSnapshot & {
  readonly rates: Readonly<Record<OriginStethArmDirection, bigint>>;
  readonly unavailable: Readonly<Record<string, string>>;
};

/**
 * Pricing for the verified ARM swap. The only chain state is the two price
 * words the swap itself reads, so the quote cannot drift from execution:
 * `traderate0` (slot 50) prices WETH -> stETH and `traderate1` (slot 51)
 * prices stETH -> WETH, both scaled by 1e36. There is no separate fee; the
 * operator spread lives in those words.
 */
export const originStethArmPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    originStethArmStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    target: lowerAddress(descriptor.target),
    weth: lowerAddress(descriptor.weth),
    steth: lowerAddress(descriptor.steth),
    rateModel: "origin-arm-linear-price-v1",
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 2) {
      throw new Error("Origin stETH ARM pricing requires exactly two verified routes");
    }
    const directions = new Set(routes.map((route) => route.direction));
    if (
      directions.size !== 2 ||
      !ORIGIN_STETH_ARM_DIRECTIONS.every((direction) => directions.has(direction))
    ) {
      throw new Error("Origin stETH ARM pricing requires both verified directions");
    }
    for (const route of routes) assertOriginStethArmInvocation(descriptor, route);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      target: descriptor.target,
      weth: descriptor.weth,
      steth: descriptor.steth,
      routes: Object.freeze([...routes]),
    });
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["get-storage" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      storageRequest(
        "current-traderate0",
        descriptor.target,
        ORIGIN_STETH_ARM_TRADERATE0_SLOT,
      ),
      storageRequest(
        "current-traderate1",
        descriptor.target,
        ORIGIN_STETH_ARM_TRADERATE1_SLOT,
      ),
    ]),
    decodeSnapshot({ descriptor, initialResults }) {
      const source = assertSameSource(
        initialResults.map((result) => returnedResult(initialResults, result.id)),
      );
      const rates: Record<OriginStethArmDirection, bigint> = {
        "steth-to-weth": storageWordToUint(
          returnedResult(initialResults, "current-traderate1").data,
        ),
        "weth-to-steth": storageWordToUint(
          returnedResult(initialResults, "current-traderate0").data,
        ),
      };
      const unavailable: Record<string, string> = {};
      const quotes: Record<string, { amountIn: bigint; amountOut: bigint }> = {};
      for (const route of descriptor.routes) {
        const rate = rates[route.direction];
        if (rate <= 0n || rate > ORIGIN_STETH_ARM_MAX_RATE) {
          unavailable[route.routeKey] = "origin-steth-arm price out of range";
          continue;
        }
        const amountIn = ORIGIN_STETH_ARM_PRICE_SAMPLE;
        const amountOut = originStethArmQuote(amountIn, rate);
        if (amountOut === 0n) {
          unavailable[route.routeKey] = "origin-steth-arm zero output";
          continue;
        }
        quotes[route.routeKey] = Object.freeze({ amountIn, amountOut });
      }
      return { source, rates, quotes, unavailable };
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (
        routes.length !== descriptor.routes.length ||
        routes.some((route, index) =>
          route.routeKey !== descriptor.routes[index].routeKey
        )
      ) {
        throw new Error(
          "Origin stETH ARM current route differs from its pricing descriptor",
        );
      }
      return new Map(descriptor.routes.flatMap((route) => {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined) {
          if (snapshot.unavailable[route.routeKey] !== undefined) return [];
          throw new Error("Origin stETH ARM current quote missing");
        }
        return [[route.routeKey, protocolMid({
          route,
          adapterId: "origin-steth-arm-swap",
          target: descriptor.target,
          quote,
        })] as const];
      }));
    },
    classifyUnavailable({ snapshot, routes }) {
      return new Map(routes
        .filter((route) => snapshot.unavailable[route.routeKey] !== undefined)
        .map((route) =>
          [route.routeKey, snapshot.unavailable[route.routeKey]] as const
        ));
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    ...new Set([
      descriptor.target,
      descriptor.weth,
      descriptor.steth,
    ]),
  ]),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(
      entries,
      ({ descriptor }) => ({
        addresses: [descriptor.target],
        keys: [descriptor.instanceKey],
      }),
      { kinds: ["call"] },
    ),
    affectedStateKeys: ({ descriptor, observation }) =>
      observation.kind === "call" &&
        sameAddress(observation.target, descriptor.target)
        ? [descriptor.instanceKey]
        : [],
  },
} satisfies PricingSemantics<
  OriginStethArmDescriptor,
  OriginStethArmRoute,
  OriginStethArmPricingDescriptor,
  Snapshot
>;

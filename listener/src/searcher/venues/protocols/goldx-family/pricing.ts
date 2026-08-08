import type { PricingSemantics } from "../../adapter-family-plugin.js";
import {
  callRequest,
  lowerAddress,
  protocolMid,
  quoteResultMap,
  sameAddress,
  type ProtocolPricingSnapshot,
} from "../standard-family/common.js";
import {
  assertGoldxInvocation,
  goldxStaticBindingProjection,
} from "./binding.js";
import {
  GOLDX_INTERFACE,
  GOLDX_SAMPLE,
  goldxQuote,
} from "./codec.js";
import type {
  GoldxDescriptor,
  GoldxPricingDescriptor,
  GoldxRoute,
} from "./types.js";

export const goldxPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    goldxStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    target: lowerAddress(descriptor.target),
    collateral: lowerAddress(descriptor.collateral),
    receipt: lowerAddress(descriptor.receipt),
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("GOLDx pricing requires exactly one verified route");
    }
    assertGoldxInvocation(descriptor, routes[0]);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      target: descriptor.target,
      route: routes[0],
    });
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      callRequest(
        "current-unit",
        descriptor.target,
        GOLDX_INTERFACE.encodeFunctionData("unit"),
      ),
    ]),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      return quoteResultMap(results, [{
        routeKey: descriptor.route.routeKey,
        requestId: "current-unit",
        amountIn: GOLDX_SAMPLE,
        decodeAmountOut: (data) => goldxQuote(
          GOLDX_SAMPLE,
          BigInt(GOLDX_INTERFACE.decodeFunctionResult("unit", data)[0]),
        ),
      }]);
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (
        routes.length !== 1 ||
        routes[0].routeKey !== descriptor.route.routeKey
      ) {
        throw new Error(
          "GOLDx current route differs from its pricing descriptor",
        );
      }
      const point = snapshot.quotes.get(descriptor.route.routeKey);
      if (point === undefined) throw new Error("GOLDx current quote missing");
      return new Map([[descriptor.route.routeKey, protocolMid({
        route: descriptor.route,
        adapterId: "goldx-mint",
        target: descriptor.target,
        quote: point,
      })]]);
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.target,
    descriptor.route.tokenIn,
    descriptor.route.tokenOut,
  ]),
  mutation: {
    affectedStateKeys: ({ descriptor, observation }) =>
      observation.kind === "call" &&
        sameAddress(observation.target, descriptor.target)
        ? [descriptor.instanceKey]
        : [],
  },
} satisfies PricingSemantics<
  GoldxDescriptor,
  GoldxRoute,
  GoldxPricingDescriptor,
  ProtocolPricingSnapshot
>;

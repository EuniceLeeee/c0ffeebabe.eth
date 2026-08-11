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
  assertRocksolidInvocation,
  rocksolidStaticBindingProjection,
} from "./binding.js";
import { ROCKSOLID_INTERFACE, ROCKSOLID_SAMPLE } from "./codec.js";
import type {
  RocksolidDescriptor,
  RocksolidPricingDescriptor,
  RocksolidRoute,
} from "./types.js";

export const rocksolidPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    rocksolidStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    target: lowerAddress(descriptor.target),
    asset: lowerAddress(descriptor.asset),
    receipt: lowerAddress(descriptor.receipt),
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error(
        "RockSolid pricing requires exactly one verified route",
      );
    }
    assertRocksolidInvocation(descriptor, routes[0]);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      target: descriptor.target,
      route: routes[0],
    });
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([callRequest(
      "current-convert",
      descriptor.target,
      ROCKSOLID_INTERFACE.encodeFunctionData(
        "convertToShares",
        [ROCKSOLID_SAMPLE],
      ),
    )]),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      return quoteResultMap(results, [{
        routeKey: descriptor.route.routeKey,
        requestId: "current-convert",
        amountIn: ROCKSOLID_SAMPLE,
        decodeAmountOut: (data) => BigInt(
          ROCKSOLID_INTERFACE.decodeFunctionResult("convertToShares", data)[0],
        ),
      }]);
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (
        routes.length !== 1 ||
        routes[0].routeKey !== descriptor.route.routeKey
      ) {
        throw new Error(
          "RockSolid current route differs from its pricing descriptor",
        );
      }
      const quote = snapshot.quotes[descriptor.route.routeKey];
      if (quote === undefined) {
        throw new Error("RockSolid current quote missing");
      }
      return new Map([[descriptor.route.routeKey, protocolMid({
        route: descriptor.route,
        adapterId: "rocksolid-sync-deposit",
        target: descriptor.target,
        quote,
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
  RocksolidDescriptor,
  RocksolidRoute,
  RocksolidPricingDescriptor,
  ProtocolPricingSnapshot
>;

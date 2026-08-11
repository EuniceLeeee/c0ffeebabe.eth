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
  assertPsmInvocation,
  psmStaticBindingProjection,
} from "./binding.js";
import {
  PSM_CURRENT_SAMPLE,
  PSM_INTERFACE,
  psmSellQuote,
} from "./codec.js";
import type {
  PsmDescriptor,
  PsmPricingDescriptor,
  PsmRoute,
} from "./types.js";

export const psmPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    psmStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    target: lowerAddress(descriptor.target),
    pair: [lowerAddress(descriptor.gem), lowerAddress(descriptor.dai)],
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("PSM pricing requires exactly one verified route");
    }
    assertPsmInvocation(descriptor, routes[0]);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      target: descriptor.target,
      route: routes[0],
      decimalScale: descriptor.decimalScale,
    });
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      callRequest(
        "current-tin",
        descriptor.target,
        PSM_INTERFACE.encodeFunctionData("tin"),
      ),
    ]),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      return quoteResultMap(results, [{
        routeKey: descriptor.route.routeKey,
        requestId: "current-tin",
        amountIn: PSM_CURRENT_SAMPLE,
        decodeAmountOut: (data) => psmSellQuote(
          PSM_CURRENT_SAMPLE,
          BigInt(PSM_INTERFACE.decodeFunctionResult("tin", data)[0]),
          descriptor.decimalScale,
        ),
      }]);
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (
        routes.length !== 1 ||
        routes[0].routeKey !== descriptor.route.routeKey
      ) {
        throw new Error(
          "PSM current route differs from its pricing descriptor",
        );
      }
      const quote = snapshot.quotes[descriptor.route.routeKey];
      if (quote === undefined) throw new Error("PSM current quote missing");
      return new Map([[descriptor.route.routeKey, protocolMid({
        route: descriptor.route,
        adapterId: "psm",
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
  PsmDescriptor,
  PsmRoute,
  PsmPricingDescriptor,
  ProtocolPricingSnapshot
>;

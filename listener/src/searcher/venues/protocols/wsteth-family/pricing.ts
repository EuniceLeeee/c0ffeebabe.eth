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
  assertWstethInvocation,
  wstethStaticBindingProjection,
} from "./binding.js";
import { WSTETH_INTERFACE, WSTETH_SAMPLE } from "./codec.js";
import type {
  WstethDescriptor,
  WstethPricingDescriptor,
  WstethRoute,
} from "./types.js";

export const wstethPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    wstethStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({
    target: lowerAddress(descriptor.target),
    directions: routes.map((route) => route.direction).sort(),
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 2) {
      throw new Error("wstETH pricing requires its two descriptor routes");
    }
    for (const route of routes) assertWstethInvocation(descriptor, route);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      target: descriptor.target,
      routes: Object.freeze([...routes]),
    });
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze(
      descriptor.routes.map((route) => callRequest(
        `current:${route.direction}`,
        descriptor.target,
        WSTETH_INTERFACE.encodeFunctionData(
          route.direction === "wrap"
            ? "getWstETHByStETH"
            : "getStETHByWstETH",
          [WSTETH_SAMPLE],
        ),
      )),
    ),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      return quoteResultMap(results, descriptor.routes.map((route) => ({
        routeKey: route.routeKey,
        requestId: `current:${route.direction}`,
        amountIn: WSTETH_SAMPLE,
        decodeAmountOut: (data) => BigInt(WSTETH_INTERFACE.decodeFunctionResult(
          route.direction === "wrap"
            ? "getWstETHByStETH"
            : "getStETHByWstETH",
          data,
        )[0]),
      })));
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<
        WstethRoute["routeKey"],
        ReturnType<typeof protocolMid>
      >();
      for (const route of routes) {
        const quote = snapshot.quotes.get(route.routeKey);
        if (quote === undefined) throw new Error("wstETH current quote missing");
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.target,
          quote,
        }));
      }
      return mids;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.target,
    ...descriptor.routes.flatMap((route) => [route.tokenIn, route.tokenOut]),
  ]),
  mutation: {
    affectedStateKeys: ({ descriptor, observation }) =>
      observation.kind === "log" &&
        sameAddress(observation.address, descriptor.target)
        ? [descriptor.instanceKey]
        : [],
  },
} satisfies PricingSemantics<
  WstethDescriptor,
  WstethRoute,
  WstethPricingDescriptor,
  ProtocolPricingSnapshot
>;

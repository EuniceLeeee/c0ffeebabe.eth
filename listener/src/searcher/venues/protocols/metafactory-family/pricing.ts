import { compileAddressMutations } from "../../mutation-index.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import {
  assertSameSource,
  assertSource,
  callRequest,
  protocolMid,
  returnedResult,
  sameAddress,
} from "../standard-family/common.js";
import {
  assertMetafactoryInvocation,
  metafactoryStaticProjection,
} from "./binding.js";
import {
  METAFACTORY_INTERFACE,
  METAFACTORY_MAX_UINT256,
  metafactoryRedeemAmount,
  metafactoryWord,
} from "./codec.js";
import type {
  MetafactoryDescriptor,
  MetafactoryPricingDescriptor,
  MetafactoryPricingSnapshot,
  MetafactoryRoute,
} from "./types.js";

/** One ROBOT (the pinned source block reports 18 decimals). */
function pricingSample(descriptor: MetafactoryDescriptor): bigint {
  if (
    descriptor.oneToken <= 0n ||
    descriptor.oneToken > METAFACTORY_MAX_UINT256
  ) {
    throw new Error("metafactory pricing sample is outside uint256 range");
  }
  return descriptor.oneToken;
}

export const metafactoryPricing = {
  stateKey: (route: MetafactoryRoute) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    metafactoryStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    ...metafactoryStaticProjection(descriptor),
    quote: "source-pro-rata-eth-view-v1",
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("metafactory pricing requires one bound redemption route");
    }
    assertMetafactoryInvocation(descriptor, routes[0]);
    return Object.freeze({
      ...descriptor,
      route: routes[0],
    }) satisfies MetafactoryPricingDescriptor;
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => {
      const amountIn = pricingSample(descriptor);
      return Object.freeze([
        callRequest(
          "current-eth-allocated",
          descriptor.target,
          METAFACTORY_INTERFACE.encodeFunctionData("totalEthAllocated"),
        ),
        callRequest(
          "current-circulating-supply",
          descriptor.target,
          METAFACTORY_INTERFACE.encodeFunctionData("circulatingSupply"),
        ),
        // The composter's own view for the pricing sample amount.
        callRequest(
          "current-amount-quote",
          descriptor.target,
          METAFACTORY_INTERFACE.encodeFunctionData(
            "calculateRedemptionAmount",
            [amountIn],
          ),
        ),
      ]);
    },
    decodeSnapshot({ descriptor, initialResults }) {
      const amountIn = pricingSample(descriptor);
      const allocated = returnedResult(initialResults, "current-eth-allocated");
      const supply = returnedResult(initialResults, "current-circulating-supply");
      const source = assertSameSource([allocated, supply]);
      const totalEthAllocated = metafactoryWord(
        allocated.data, "metafactory totalEthAllocated");
      const circulatingSupply = metafactoryWord(
        supply.data, "metafactory circulatingSupply");
      const quotes: Record<string, {
        readonly amountIn: bigint;
        readonly amountOut: bigint;
      }> = {};
      const unavailable: Record<string, string> = {};
      const key = descriptor.route.routeKey;
      if (totalEthAllocated === 0n || circulatingSupply === 0n) {
        unavailable[key] = "metafactory_redemption_terms_unset";
      } else {
        // A reverted view is a quote gap for this block, not an instance
        // failure: keep the route published, suppress the mid, and let final
        // simulation decide whether the redemption is executable.
        const quote = initialResults.find(
          (entry) => entry.id === "current-amount-quote");
        if (quote === undefined || quote.ok !== true ||
          quote.completion !== "returned") {
          unavailable[key] = "metafactory_redemption_quote_unavailable";
        } else {
          assertSource(quote.source, source);
          const chainQuote = metafactoryWord(
            quote.data, "metafactory redemption amount");
          const localQuote = metafactoryRedeemAmount(
            amountIn, totalEthAllocated, circulatingSupply);
          if (chainQuote !== localQuote) {
            throw new Error(
              "metafactory chain redemption amount disagrees with the bound pro-rata rate",
            );
          }
          if (localQuote === 0n) {
            unavailable[key] = "metafactory_zero_output";
          } else {
            quotes[key] = Object.freeze({ amountIn, amountOut: localQuote });
          }
        }
      }
      return Object.freeze({
        source,
        totalEthAllocated,
        circulatingSupply,
        quotes: Object.freeze(quotes),
        unavailable: Object.freeze(unavailable),
      }) satisfies MetafactoryPricingSnapshot;
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (
        routes.length !== 1 ||
        routes[0].routeKey !== descriptor.route.routeKey
      ) {
        throw new Error(
          "metafactory current route differs from its pricing descriptor",
        );
      }
      const mids = new Map<
        MetafactoryRoute["routeKey"],
        ReturnType<typeof protocolMid>
      >();
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined || quote.amountIn <= 0n ||
          quote.amountOut <= 0n) {
          continue;
        }
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.target,
          quote,
        }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      return new Map(routes
        .filter((route) => snapshot.unavailable[route.routeKey] !== undefined)
        .map((route) => [
          route.routeKey,
          snapshot.unavailable[route.routeKey],
        ] as const));
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.target,
    descriptor.tokenIn,
    descriptor.nativeAnchor,
  ]),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({
      addresses: [descriptor.target, descriptor.tokenIn],
      keys: [descriptor.instanceKey],
    }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor, observation }) {
      const address = observation.kind === "log" ? observation.address
        : observation.kind === "call" ? observation.target : null;
      return address !== null && (sameAddress(address, descriptor.target) ||
        sameAddress(address, descriptor.tokenIn))
        ? [descriptor.instanceKey] : [];
    },
  },
} satisfies PricingSemantics<
  MetafactoryDescriptor,
  MetafactoryRoute,
  MetafactoryPricingDescriptor,
  MetafactoryPricingSnapshot
>;

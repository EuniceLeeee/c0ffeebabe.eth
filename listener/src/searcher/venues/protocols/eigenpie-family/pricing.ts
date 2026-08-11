import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from
  "../../adapter-request-program.js";
import {
  callRequest,
  decodeDecimals,
  lowerAddress,
  protocolMid,
  quoteResultMap,
  sameAddress,
  type ProtocolPricingSnapshot,
} from "../standard-family/common.js";
import {
  assertEigenpieInvocation,
  eigenpieStaticBindingProjection,
} from "./binding.js";
import {
  decodeEigenpieQuote,
  EIGENPIE_ERC20_INTERFACE,
  EIGENPIE_INTERFACE,
} from "./codec.js";
import type {
  EigenpieDescriptor,
  EigenpiePricingDescriptor,
  EigenpiePricingDraft,
  EigenpieRoute,
} from "./types.js";

export const eigenpiePricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    eigenpieStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    target: lowerAddress(descriptor.target),
    asset: lowerAddress(descriptor.asset),
    receipt: lowerAddress(descriptor.receipt),
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("Eigenpie pricing requires exactly one pair route");
    }
    assertEigenpieInvocation(descriptor, routes[0]);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      target: descriptor.target,
      route: routes[0],
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: EigenpiePricingDraft) => Object.freeze([
        draft.route.tokenIn,
        draft.route.tokenOut,
      ]),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: EigenpiePricingDraft) => Object.freeze([
      callRequest(
        "static-asset-decimals",
        draft.route.tokenIn,
        EIGENPIE_ERC20_INTERFACE.encodeFunctionData("decimals"),
      ),
    ]),
    decode: ({ results }: {
      readonly results: readonly AdapterRequestResult[];
    }) => Object.freeze({
      oneAsset: decodeDecimals(
        EIGENPIE_ERC20_INTERFACE,
        results,
        "static-asset-decimals",
      ),
    }),
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error("Eigenpie pricing lacks decimals evidence");
    }
    return Object.freeze({ ...draft, oneAsset: staticEvidence.oneAsset });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      callRequest(
        "current-quote",
        descriptor.target,
        EIGENPIE_INTERFACE.encodeFunctionData("getMLRTAmountToMint", [
          descriptor.route.tokenIn,
          descriptor.oneAsset,
        ]),
      ),
    ]),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      return quoteResultMap(results, [{
        routeKey: descriptor.route.routeKey,
        requestId: "current-quote",
        amountIn: descriptor.oneAsset,
        decodeAmountOut: (data) => {
          const quote = decodeEigenpieQuote(data);
          if (!sameAddress(quote.tokenOut, descriptor.route.tokenOut)) {
            throw new Error("Eigenpie current quote receipt token drifted");
          }
          return quote.amountOut;
        },
      }]);
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (
        routes.length !== 1 ||
        routes[0].routeKey !== descriptor.route.routeKey
      ) {
        throw new Error(
          "Eigenpie current route differs from its pricing descriptor",
        );
      }
      const quote = snapshot.quotes[descriptor.route.routeKey];
      if (quote === undefined) throw new Error("Eigenpie current quote missing");
      return new Map([[descriptor.route.routeKey, protocolMid({
        route: descriptor.route,
        adapterId: "eigenpie-deposit-asset",
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
      (observation.kind === "call" &&
          sameAddress(observation.target, descriptor.target)) ||
        (observation.kind === "log" &&
          sameAddress(observation.address, descriptor.target))
        ? [descriptor.instanceKey]
        : [],
  },
} satisfies PricingSemantics<
  EigenpieDescriptor,
  EigenpieRoute,
  EigenpiePricingDescriptor,
  ProtocolPricingSnapshot,
  EigenpiePricingDraft,
  { readonly oneAsset: bigint }
>;

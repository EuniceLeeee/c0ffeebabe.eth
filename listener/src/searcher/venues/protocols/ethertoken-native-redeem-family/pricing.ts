import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import {
  assertSameSource,
  callRequest,
  decodeDecimals,
  protocolMid,
  sameAddress,
  successfulResult,
} from "../standard-family/common.js";
import {
  ETHERTOKEN_NATIVE_INTERFACE,
  assertEtherTokenNativeInvocation,
  etherTokenNativeStaticProjection,
} from "./shared.js";
import type {
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemPricingDescriptor,
  EtherTokenNativeRedeemPricingDraft,
  EtherTokenNativeRedeemPricingSnapshot,
  EtherTokenNativeRedeemRoute,
} from "./types.js";

export interface EtherTokenNativeRedeemPricingStaticEvidence {
  readonly oneToken: bigint;
}

export const etherTokenNativeRedeemPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    etherTokenNativeStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    token: descriptor.token,
    payoutSemantics: "exact-burn-equal-native-out-v1",
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("EtherToken native pricing requires one bound route");
    }
    const route = routes[0];
    assertEtherTokenNativeInvocation(descriptor, route);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      token: descriptor.token,
      nativeAnchor: descriptor.nativeAnchor,
      route,
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: EtherTokenNativeRedeemPricingDraft) =>
        Object.freeze([draft.token]),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: EtherTokenNativeRedeemPricingDraft) =>
      Object.freeze([callRequest(
        "static-token-decimals",
        draft.token,
        ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionData("decimals"),
      )]),
    decode({ results }: {
      readonly programInput: EtherTokenNativeRedeemPricingDraft;
      readonly results: readonly AdapterRequestResult[];
    }): EtherTokenNativeRedeemPricingStaticEvidence {
      return Object.freeze({
        oneToken: decodeDecimals(
          ETHERTOKEN_NATIVE_INTERFACE,
          results,
          "static-token-decimals",
        ),
      });
    },
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error("EtherToken native pricing lacks decimals evidence");
    }
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([callRequest(
      "current-total-supply",
      descriptor.token,
      ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionData("totalSupply"),
    )]),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      const result = successfulResult(results, "current-total-supply");
      const source = assertSameSource([result]);
      const totalSupply = BigInt(
        ETHERTOKEN_NATIVE_INTERFACE.decodeFunctionResult(
          "totalSupply",
          result.data,
        )[0],
      );
      const amountIn = totalSupply < descriptor.oneToken
        ? totalSupply
        : descriptor.oneToken;
      const quotes = new Map();
      if (amountIn > 0n) {
        quotes.set(descriptor.route.routeKey, Object.freeze({
          amountIn,
          amountOut: amountIn,
        }));
      }
      return Object.freeze({ source, totalSupply, quotes });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<
        EtherTokenNativeRedeemRoute["routeKey"],
        ReturnType<typeof protocolMid>
      >();
      for (const route of routes) {
        const quote = snapshot.quotes.get(route.routeKey);
        if (quote === undefined || quote.amountOut <= 0n) continue;
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.token,
          quote,
        }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      return snapshot.totalSupply === 0n
        ? new Map(routes.map((route) => [
            route.routeKey,
            "ethertoken_total_supply_zero",
          ] as const))
        : new Map();
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.token,
    descriptor.nativeAnchor,
  ]),
  mutation: {
    affectedStateKeys({ descriptor, observation }) {
      return observation.kind === "log" &&
          sameAddress(observation.address, descriptor.token)
        ? [descriptor.instanceKey]
        : [];
    },
  },
} satisfies PricingSemantics<
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemRoute,
  EtherTokenNativeRedeemPricingDescriptor,
  EtherTokenNativeRedeemPricingSnapshot,
  EtherTokenNativeRedeemPricingDraft,
  EtherTokenNativeRedeemPricingStaticEvidence
>;

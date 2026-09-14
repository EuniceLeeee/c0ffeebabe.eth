import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import {
  callRequest,
  decodeDecimals,
  protocolMid,
  sameAddress,
} from "../standard-family/common.js";
import {
  SELF_BURN_NATIVE_TOKEN_INTERFACE,
  assertSelfBurnNativeInvocation,
  selfBurnNativeProbeAmounts,
  selfBurnNativeStaticProjection,
} from "./shared.js";
import type {
  SelfBurnNativeDescriptor,
  SelfBurnNativePricingDescriptor,
  SelfBurnNativePricingDraft,
  SelfBurnNativePricingSnapshot,
  SelfBurnNativeRoute,
} from "./types.js";

import { selfBurnFeeRequests, decodeSelfBurnFees, calculateSelfBurnFee } from "./fee-quote.js";

export interface SelfBurnNativePricingStaticEvidence {
  readonly probeAmounts: readonly bigint[];
}

export const selfBurnNativePricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    selfBurnNativeStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    token: descriptor.token,
    quote: "source-fee-formula-v1",
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("self-burn native pricing requires one bound route");
    }
    const route = routes[0];
    assertSelfBurnNativeInvocation(descriptor, route);
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
      dependencyKeys: (draft: SelfBurnNativePricingDraft) =>
        Object.freeze([draft.token]),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: SelfBurnNativePricingDraft) => Object.freeze([
      callRequest(
        "static-token-decimals",
        draft.token,
        SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionData("decimals"),
      ),
    ]),
    decode({ results }: {
      readonly programInput: SelfBurnNativePricingDraft;
      readonly results: readonly AdapterRequestResult[];
    }): SelfBurnNativePricingStaticEvidence {
      const one = decodeDecimals(
        SELF_BURN_NATIVE_TOKEN_INTERFACE,
        results,
        "static-token-decimals",
      );
      return Object.freeze({
        probeAmounts: selfBurnNativeProbeAmounts(one),
      });
    },
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error("self-burn native pricing lacks decimals evidence");
    }
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => selfBurnFeeRequests(descriptor.token, "current"),
    decodeSnapshot({ descriptor, initialResults }) {
      const { source, fees } = decodeSelfBurnFees(initialResults, "current");
      for (const amountIn of descriptor.probeAmounts) {
        const amountOut = amountIn - calculateSelfBurnFee(amountIn, fees);
        if (amountOut <= 0n) continue;
        return Object.freeze({ source, amountIn, amountOut,
          quotes: Object.freeze({ [descriptor.route.routeKey]: Object.freeze({ amountIn, amountOut }) }) });
      }
      return Object.freeze({ source, amountIn: 0n, amountOut: 0n, quotes: {} });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<
        SelfBurnNativeRoute["routeKey"],
        ReturnType<typeof protocolMid>
      >();
      if (snapshot.amountIn <= 0n || snapshot.amountOut <= 0n) return mids;
      for (const route of routes) {
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.token,
          quote: {
            amountIn: snapshot.amountIn,
            amountOut: snapshot.amountOut,
          },
        }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      return snapshot.amountIn === 0n || snapshot.amountOut === 0n
        ? new Map(routes.map((route) => [
            route.routeKey,
            "self_burn_quote_unavailable",
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
  SelfBurnNativeDescriptor,
  SelfBurnNativeRoute,
  SelfBurnNativePricingDescriptor,
  SelfBurnNativePricingSnapshot,
  SelfBurnNativePricingDraft,
  SelfBurnNativePricingStaticEvidence
>;

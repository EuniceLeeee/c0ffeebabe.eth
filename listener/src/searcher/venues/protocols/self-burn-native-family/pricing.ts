import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import {
  assertSameSource,
  callRequest,
  decodeDecimals,
  protocolMid,
  sameAddress,
} from "../standard-family/common.js";
import {
  SELF_BURN_NATIVE_PRICING_ACTOR,
  SELF_BURN_NATIVE_PRICING_ACTOR_EVIDENCE_ID,
  SELF_BURN_NATIVE_TOKEN_INTERFACE,
  assertSelfBurnNativeInvocation,
  selfBurnNativeProbeAmounts,
  selfBurnNativeSimulation,
  selfBurnNativeStaticProjection,
  validateSelfBurnNativeEffects,
} from "./shared.js";
import type {
  SelfBurnNativeDescriptor,
  SelfBurnNativePricingDescriptor,
  SelfBurnNativePricingDraft,
  SelfBurnNativePricingSnapshot,
  SelfBurnNativeRoute,
} from "./types.js";

export interface SelfBurnNativePricingStaticEvidence {
  readonly probeAmounts: readonly bigint[];
}

export const selfBurnNativePricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    selfBurnNativeStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    token: descriptor.token,
    call: "transfer-self",
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
    requirements: () => ({
      transports: ["effect-delta-simulation" as const],
      caller: "verified-actor" as const,
      effects: [
        "return-data" as const,
        "token-delta" as const,
        "native-delta" as const,
        "total-supply-delta" as const,
        "logs" as const,
      ],
    }),
    buildRequests: ({ descriptor }) => Object.freeze(
      descriptor.probeAmounts.map((amountIn, index) =>
        selfBurnNativeSimulation({
          id: `current-self-burn:${index}`,
          token: descriptor.token,
          actor: SELF_BURN_NATIVE_PRICING_ACTOR,
          callerRef: Object.freeze({
            kind: "verified-actor" as const,
            evidenceId: SELF_BURN_NATIVE_PRICING_ACTOR_EVIDENCE_ID,
          }),
          amountIn,
        })
      ),
    ),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      const successful = results.filter(
        (result): result is Extract<
          AdapterRequestResult,
          { readonly ok: true }
        > => result.ok,
      );
      if (successful.length === 0) {
        throw new Error("self-burn native current reads are unresolved");
      }
      const source = assertSameSource(successful);
      for (const [index, amountIn] of descriptor.probeAmounts.entries()) {
        const result = results.find(
          (candidate) => candidate.id === `current-self-burn:${index}`,
        );
        if (!result?.ok) continue;
        try {
          const amountOut = validateSelfBurnNativeEffects({
            result,
            token: descriptor.token,
            actor: SELF_BURN_NATIVE_PRICING_ACTOR,
            amountIn,
          });
          return Object.freeze({
            source,
            amountIn,
            amountOut,
            quotes: new Map([[descriptor.route.routeKey, Object.freeze({
              amountIn,
              amountOut,
            })]]),
          });
        } catch {
          // Another successful probe may establish the current conversion.
        }
      }
      if (results.some((result) => !result.ok)) {
        throw new Error(
          "self-burn native current reads are partially unresolved",
        );
      }
      return Object.freeze({
        source,
        amountIn: 0n,
        amountOut: 0n,
        quotes: new Map(),
      });
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
            "self_burn_active_effect_unavailable",
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

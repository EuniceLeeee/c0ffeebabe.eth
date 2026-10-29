import { compileAddressMutations } from "../../mutation-index.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import {
  assertSameSource,
  callRequest,
  protocolMid,
  sameAddress,
  successfulResult,
} from "../standard-family/common.js";
import { ARCANA_SOURCE_INTERFACE } from "./abi.js";
import { arcanaStaticProjection } from "./shared.js";
import type {
  ArcanaDescriptor,
  ArcanaPricingDescriptor,
  ArcanaPricingDraft,
  ArcanaPricingSnapshot,
  ArcanaRoute,
} from "./types.js";

export interface ArcanaPricingStaticEvidence {
  readonly oldTokenDecimals: number;
  readonly arcTokenDecimals: number;
}

export const arcanaMigrationPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) => arcanaStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    source: descriptor.source,
    tokenId: descriptor.tokenId,
    conversion: "arcana-lockAndBridge-preview-v1",
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("arcana pricing requires one bound route");
    }
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      source: descriptor.source,
      destination: descriptor.destination,
      oldToken: descriptor.oldToken,
      arcToken: descriptor.arcToken,
      tokenId: descriptor.tokenId,
      tokenDecimals: descriptor.tokenDecimals,
      tokenTwapValue: descriptor.tokenTwapValue,
      tokenMultiplier: descriptor.tokenMultiplier,
      multiplierScale: descriptor.multiplierScale,
      route: routes[0],
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: ArcanaPricingDraft) => Object.freeze([draft.oldToken, draft.arcToken]),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: ArcanaPricingDraft) => Object.freeze([
      callRequest("static-old-decimals", draft.oldToken, "0x313ce567"),
      callRequest("static-arc-decimals", draft.arcToken, "0x313ce567"),
    ]),
    decode({ results }: {
      readonly programInput: ArcanaPricingDraft;
      readonly results: readonly AdapterRequestResult[];
    }): ArcanaPricingStaticEvidence {
      const oldToken = successfulResult(results, "static-old-decimals");
      const arcToken = successfulResult(results, "static-arc-decimals");
      assertSameSource([oldToken, arcToken]);
      return Object.freeze({
        oldTokenDecimals: Number(BigInt(oldToken.data)),
        arcTokenDecimals: Number(BigInt(arcToken.data)),
      });
    },
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) throw new Error("arcana pricing lacks decimals evidence");
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([callRequest(
      "current-preview-arc",
      descriptor.source,
      ARCANA_SOURCE_INTERFACE.encodeFunctionData("previewArcAmount", [
        descriptor.tokenId,
        10n ** BigInt(descriptor.oldTokenDecimals),
      ]),
    )]),
    decodeSnapshot({ descriptor, initialResults }) {
      const result = successfulResult(initialResults, "current-preview-arc");
      const source = assertSameSource([result]);
      const amountOut = BigInt(ARCANA_SOURCE_INTERFACE.decodeFunctionResult(
        "previewArcAmount",
        result.data,
      )[0]);
      const quotes: Record<string, { readonly amountIn: bigint; readonly amountOut: bigint }> = {};
      if (amountOut > 0n) {
        quotes[descriptor.route.routeKey] = Object.freeze({
          amountIn: 10n ** BigInt(descriptor.oldTokenDecimals),
          amountOut,
        });
      }
      return Object.freeze({ source, quotes });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<ArcanaRoute["routeKey"], ReturnType<typeof protocolMid>>();
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined || quote.amountOut <= 0n) continue;
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.source,
          quote,
        }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      const unavailable = new Map<ArcanaRoute["routeKey"], string>();
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined || quote.amountOut <= 0n) {
          unavailable.set(route.routeKey, "arcana_preview_zero");
        }
      }
      return unavailable;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.source,
    descriptor.destination,
    descriptor.oldToken,
    descriptor.arcToken,
  ]),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({
      addresses: [descriptor.source, descriptor.oldToken, descriptor.arcToken],
      keys: [descriptor.instanceKey],
    }), { kinds: ["log"] }),
    affectedStateKeys({ descriptor, observation }) {
      return observation.kind === "log" &&
          (sameAddress(observation.address, descriptor.source) ||
            sameAddress(observation.address, descriptor.arcToken))
        ? [descriptor.instanceKey]
        : [];
    },
  },
} satisfies PricingSemantics<
  ArcanaDescriptor,
  ArcanaRoute,
  ArcanaPricingDescriptor,
  ArcanaPricingSnapshot,
  ArcanaPricingDraft,
  ArcanaPricingStaticEvidence
>;

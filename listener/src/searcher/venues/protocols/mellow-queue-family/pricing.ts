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
import { MELLOW_ORACLE_INTERFACE } from "./abi.js";
import { depositShares, redeemAssets } from "./math.js";
import { mellowQueueStaticProjection } from "./shared.js";
import type {
  MellowQueueDescriptor,
  MellowQueuePricingDescriptor,
  MellowQueuePricingDraft,
  MellowQueuePricingSnapshot,
  MellowQueueRoute,
} from "./types.js";

export interface MellowQueuePricingStaticEvidence {
  readonly assetDecimals: number;
  readonly shareDecimals: number;
}

export const mellowQueuePricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) => mellowQueueStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    queue: descriptor.queue,
    kind: descriptor.kind,
    priceSemantics: "mellow-oracle-getReport-v1",
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("mellow queue pricing requires one bound route");
    }
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      queue: descriptor.queue,
      vault: descriptor.vault,
      asset: descriptor.asset,
      share: descriptor.share,
      oracle: descriptor.oracle,
      feeManager: descriptor.feeManager,
      kind: descriptor.kind,
      penaltyD6: descriptor.penaltyD6,
      maxAge: descriptor.maxAge,
      route: routes[0],
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: MellowQueuePricingDraft) =>
        Object.freeze([draft.asset, draft.share]),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: MellowQueuePricingDraft) => Object.freeze([
      callRequest("static-asset-decimals", draft.asset, "0x313ce567"),
      callRequest("static-share-decimals", draft.share, "0x313ce567"),
    ]),
    decode({ results }: {
      readonly programInput: MellowQueuePricingDraft;
      readonly results: readonly AdapterRequestResult[];
    }): MellowQueuePricingStaticEvidence {
      const asset = successfulResult(results, "static-asset-decimals");
      const share = successfulResult(results, "static-share-decimals");
      assertSameSource([asset, share]);
      return Object.freeze({
        assetDecimals: Number(BigInt(asset.data)),
        shareDecimals: Number(BigInt(share.data)),
      });
    },
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error("mellow queue pricing lacks decimals evidence");
    }
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([callRequest(
      "current-oracle-report",
      descriptor.oracle,
      MELLOW_ORACLE_INTERFACE.encodeFunctionData("getReport", [descriptor.asset]),
    )]),
    decodeSnapshot({ descriptor, initialResults }) {
      const result = successfulResult(initialResults, "current-oracle-report");
      const source = assertSameSource([result]);
      const decoded = MELLOW_ORACLE_INTERFACE.decodeFunctionResult("getReport", result.data);
      const priceD18 = BigInt(decoded[0]);
      const suspicious = Boolean(decoded[2]);
      const quotes: Record<string, { readonly amountIn: bigint; readonly amountOut: bigint }> = {};
      if (priceD18 > 0n && !suspicious) {
        const deposit = descriptor.kind === "deposit";
        const amountIn = 10n ** BigInt(deposit ? descriptor.assetDecimals : descriptor.shareDecimals);
        const amountOut = deposit
          ? depositShares({ assets: amountIn, priceD18, penaltyD6: descriptor.penaltyD6 })
          : redeemAssets({ shares: amountIn, priceD18, penaltyD6: descriptor.penaltyD6 });
        quotes[descriptor.route.routeKey] = Object.freeze({ amountIn, amountOut });
      }
      return Object.freeze({ source, priceD18, quotes });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<MellowQueueRoute["routeKey"], ReturnType<typeof protocolMid>>();
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined || quote.amountOut <= 0n) continue;
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.queue,
          quote,
        }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      return snapshot.priceD18 === 0n
        ? new Map(routes.map((route) => [route.routeKey, "mellow_oracle_price_zero"] as const))
        : new Map();
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.queue,
    descriptor.vault,
    descriptor.asset,
    descriptor.share,
    descriptor.oracle,
    descriptor.feeManager,
  ]),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({
      addresses: [descriptor.queue, descriptor.oracle],
      keys: [descriptor.instanceKey],
    }), { kinds: ["log"] }),
    affectedStateKeys({ descriptor, observation }) {
      return observation.kind === "log" &&
          (sameAddress(observation.address, descriptor.queue) ||
            sameAddress(observation.address, descriptor.oracle))
        ? [descriptor.instanceKey]
        : [];
    },
  },
} satisfies PricingSemantics<
  MellowQueueDescriptor,
  MellowQueueRoute,
  MellowQueuePricingDescriptor,
  MellowQueuePricingSnapshot,
  MellowQueuePricingDraft,
  MellowQueuePricingStaticEvidence
>;

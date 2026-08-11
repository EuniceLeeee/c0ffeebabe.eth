import {
  bindRequestResultRound,
  collectRequestProgramResults,
  type PricingSemantics,
} from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import {
  assertSameSource,
  callRequest,
  decodeDecimals,
  decodeUint,
  protocolMid,
  returnedResult,
  sameAddress,
} from "../standard-family/common.js";
import {
  ERC4626_SILO_ERC20_INTERFACE,
  ERC4626_SILO_INTERFACE,
  ERC4626_SILO_PAYOUT_INTERFACE,
  assertErc4626SiloInvocation,
  erc4626SiloStaticProjection,
} from "./shared.js";
import type {
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemPricingDescriptor,
  Erc4626SiloRedeemPricingDraft,
  Erc4626SiloRedeemPricingSnapshot,
  Erc4626SiloRedeemRoute,
} from "./types.js";

export interface Erc4626SiloRedeemPricingStaticEvidence {
  readonly oneShare: bigint;
}

export const erc4626SiloRedeemPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    erc4626SiloStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    vault: descriptor.vault,
    payoutToken: descriptor.payoutToken,
    quoteChain: "previewRedeem->previewWithdraw",
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error(
        "ERC4626 Silo pricing requires one behavior-proven route",
      );
    }
    const route = routes[0];
    assertErc4626SiloInvocation(descriptor, route);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      vault: descriptor.vault,
      payoutToken: descriptor.payoutToken,
      underlyingAsset: descriptor.underlyingAsset,
      route,
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: Erc4626SiloRedeemPricingDraft) =>
        Object.freeze([draft.vault, draft.payoutToken]),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: Erc4626SiloRedeemPricingDraft) => Object.freeze([
      callRequest(
        "static-share-decimals",
        draft.vault,
        ERC4626_SILO_ERC20_INTERFACE.encodeFunctionData("decimals"),
      ),
    ]),
    decode({ results }: {
      readonly programInput: Erc4626SiloRedeemPricingDraft;
      readonly results: readonly AdapterRequestResult[];
    }): Erc4626SiloRedeemPricingStaticEvidence {
      return Object.freeze({
        oneShare: decodeDecimals(
          ERC4626_SILO_ERC20_INTERFACE,
          results,
          "static-share-decimals",
        ),
      });
    },
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error("ERC4626 Silo pricing lacks share decimals evidence");
    }
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([callRequest(
      "current-preview-redeem",
      descriptor.vault,
      ERC4626_SILO_INTERFACE.encodeFunctionData(
        "previewRedeem",
        [descriptor.oneShare],
      ),
    )]),
    buildDependentProgram({
      current,
      completedRound,
      initialResults,
      priorEvidence,
    }) {
      if (completedRound !== 0) return null;
      const priorResults = collectRequestProgramResults(
        initialResults,
        priorEvidence,
      );
      const assets = decodeUint(
        ERC4626_SILO_INTERFACE,
        "previewRedeem",
        priorResults,
        "current-preview-redeem",
      );
      return bindRequestResultRound(
        { transports: ["eth-call"] },
        Object.freeze([callRequest(
          "current-preview-withdraw",
          current.descriptor.payoutToken,
          ERC4626_SILO_PAYOUT_INTERFACE.encodeFunctionData(
            "previewWithdraw",
            [assets],
          ),
        )]),
      );
    },
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) {
      const results = collectRequestProgramResults(
        initialResults,
        dependentEvidence,
      );
      const preview = returnedResult(results, "current-preview-redeem");
      const payout = returnedResult(results, "current-preview-withdraw");
      const source = assertSameSource([preview, payout]);
      const previewAssets = BigInt(
        ERC4626_SILO_INTERFACE.decodeFunctionResult(
          "previewRedeem",
          preview.data,
        )[0],
      );
      const amountOut = BigInt(
        ERC4626_SILO_PAYOUT_INTERFACE.decodeFunctionResult(
          "previewWithdraw",
          payout.data,
        )[0],
      );
      return Object.freeze({
        source,
        previewAssets,
        quotes: Object.freeze({
          [descriptor.route.routeKey]: Object.freeze({
          amountIn: descriptor.oneShare,
          amountOut,
          }),
        }),
      });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<
        Erc4626SiloRedeemRoute["routeKey"],
        ReturnType<typeof protocolMid>
      >();
      if (snapshot.previewAssets <= 0n) return mids;
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined || quote.amountOut <= 0n) continue;
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.vault,
          quote,
        }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      const unavailable = new Map<Erc4626SiloRedeemRoute["routeKey"], string>();
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (snapshot.previewAssets === 0n || quote?.amountOut === 0n) {
          unavailable.set(route.routeKey, "silo_preview_chain_zero");
        }
      }
      return unavailable;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.vault,
    descriptor.payoutToken,
    descriptor.underlyingAsset,
  ]),
  mutation: {
    affectedStateKeys({ descriptor, observation }) {
      return observation.kind === "log" &&
          (sameAddress(observation.address, descriptor.vault) ||
            sameAddress(observation.address, descriptor.payoutToken))
        ? [descriptor.instanceKey]
        : [];
    },
  },
} satisfies PricingSemantics<
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemRoute,
  Erc4626SiloRedeemPricingDescriptor,
  Erc4626SiloRedeemPricingSnapshot,
  Erc4626SiloRedeemPricingDraft,
  Erc4626SiloRedeemPricingStaticEvidence
>;

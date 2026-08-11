import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import {
  callRequest,
  decodeDecimals,
  lowerAddress,
  protocolMid,
  quoteResultMap,
  type ProtocolPricingSnapshot,
} from "../standard-family/common.js";
import {
  ERC4626_ERC20_INTERFACE,
  ERC4626_INTERFACE,
} from "./abi.js";
import {
  assertErc4626Invocation,
  erc4626StaticProjection,
} from "./binding.js";
import type {
  Erc4626Descriptor,
  Erc4626PricingDescriptor,
  Erc4626PricingDraft,
  Erc4626Route,
} from "./types.js";

export const erc4626Pricing: PricingSemantics<
  Erc4626Descriptor,
  Erc4626Route,
  Erc4626PricingDescriptor,
  ProtocolPricingSnapshot,
  Erc4626PricingDraft,
  { readonly oneAsset: bigint; readonly oneShare: bigint }
> = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    erc4626StaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({
    vault: lowerAddress(descriptor.vault),
    asset: lowerAddress(descriptor.asset),
    share: lowerAddress(descriptor.share),
    directions: routes.map((route) => route.direction).sort(),
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length === 0) {
      throw new Error("ERC4626 pricing requires behavior-proven routes");
    }
    for (const route of routes) assertErc4626Invocation(descriptor, route);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      vault: descriptor.vault,
      routes: Object.freeze([...routes]),
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft) => Object.freeze(
        [...new Set([
          lowerAddress(draft.vault),
          ...draft.routes.flatMap((route) => [
            lowerAddress(route.tokenIn),
            lowerAddress(route.tokenOut),
          ]),
        ])].sort(),
      ),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft) => {
      const deposit = draft.routes.find((route) =>
        route.direction === "deposit"
      );
      const redeem = draft.routes.find((route) =>
        route.direction === "redeem"
      );
      const asset = deposit?.tokenIn ?? redeem?.tokenOut;
      const share = deposit?.tokenOut ?? redeem?.tokenIn;
      if (asset === undefined || share === undefined) {
        throw new Error("ERC4626 pricing cannot derive token bindings");
      }
      return Object.freeze([
        callRequest(
          "static-asset-decimals",
          asset,
          ERC4626_ERC20_INTERFACE.encodeFunctionData("decimals"),
        ),
        callRequest(
          "static-share-decimals",
          share,
          ERC4626_ERC20_INTERFACE.encodeFunctionData("decimals"),
        ),
      ]);
    },
    decode: ({ results }: {
      readonly results: readonly AdapterRequestResult[];
    }) => Object.freeze({
      oneAsset: decodeDecimals(
        ERC4626_ERC20_INTERFACE,
        results,
        "static-asset-decimals",
      ),
      oneShare: decodeDecimals(
        ERC4626_ERC20_INTERFACE,
        results,
        "static-share-decimals",
      ),
    }),
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error("ERC4626 pricing lacks decimals evidence");
    }
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) => Object.freeze(
      descriptor.routes.map((route) => {
        const amountIn = route.direction === "deposit"
          ? descriptor.oneAsset
          : descriptor.oneShare;
        return callRequest(
          `current:${route.direction}`,
          descriptor.vault,
          ERC4626_INTERFACE.encodeFunctionData(
            route.direction === "deposit"
              ? "previewDeposit"
              : "previewRedeem",
            [amountIn],
          ),
        );
      }),
    ),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      return quoteResultMap(results, descriptor.routes.map((route) => ({
        routeKey: route.routeKey,
        requestId: `current:${route.direction}`,
        amountIn: route.direction === "deposit"
          ? descriptor.oneAsset
          : descriptor.oneShare,
        decodeAmountOut: (data) => BigInt(
          ERC4626_INTERFACE.decodeFunctionResult(
            route.direction === "deposit"
              ? "previewDeposit"
              : "previewRedeem",
            data,
          )[0],
        ),
      })));
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<
        Erc4626Route["routeKey"],
        ReturnType<typeof protocolMid>
      >();
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined) throw new Error("ERC4626 current quote missing");
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.vault,
          quote,
        }));
      }
      return mids;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze(
    [...new Set([
      lowerAddress(descriptor.vault),
      ...descriptor.routes.flatMap((route) => [
        lowerAddress(route.tokenIn),
        lowerAddress(route.tokenOut),
      ]),
    ])].sort(),
  ),
  mutation: {
    affectedStateKeys: ({ descriptor, observation }) =>
      observation.kind === "log" &&
        observation.address.toLowerCase() === descriptor.vault.toLowerCase()
        ? [descriptor.instanceKey]
        : [],
  },
};

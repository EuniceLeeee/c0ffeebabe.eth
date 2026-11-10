import { compileAddressMutations } from "../../mutation-index.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import {
  assertSameSource,
  lowerAddress,
  protocolMid,
  returnedResult,
  sameAddress,
} from "../standard-family/common.js";
import {
  assertDefaultCollateralInvocation,
  defaultCollateralStaticBindingProjection,
} from "./binding.js";
import {
  DEFAULT_COLLATERAL_ERC20_INTERFACE,
  DEFAULT_COLLATERAL_FEE_BPS,
  DEFAULT_COLLATERAL_INTERFACE,
  DEFAULT_COLLATERAL_PRICE_SAMPLE,
  declaredCallRequest,
  defaultCollateralAddress,
  defaultCollateralDependencies,
  defaultCollateralQuote,
} from "./codec.js";
import { DEFAULT_COLLATERAL_ACTION_ID } from "./manifest.js";
import type {
  DefaultCollateralDescriptor,
  DefaultCollateralPricingDescriptor,
  DefaultCollateralPricingSnapshot,
  DefaultCollateralRoute,
} from "./types.js";

const REQUEST_IDS = [
  "current-asset",
  "current-total-supply",
  "current-backing",
] as const;

function shape(
  results: readonly { readonly id: string; readonly ok: boolean;
    readonly completion?: string }[],
  id: string,
): "returned" | "reverted" | "missing" {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined || !result.ok) return "missing";
  return result.completion === "returned" ? "returned" : "reverted";
}

/**
 * Raw mid source: the vault's own block-pinned share supply and asset
 * backing. The verified implementation redeems share-for-asset 1:1 while
 * fully backed; when the two reads do not prove that invariant the route is
 * classified unavailable instead of quoting a made-up rate. There is no
 * protocol fee (feeBps 0), so the raw mid is exactly 1.0 while proven.
 */
export const defaultCollateralPricing = {
  refreshPolicy: "each-block" as const,
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    defaultCollateralStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    vault: lowerAddress(descriptor.vault),
    share: lowerAddress(descriptor.share),
    asset: lowerAddress(descriptor.asset),
    rateModel: "default-collateral-one-to-one-v1",
    feeBps: DEFAULT_COLLATERAL_FEE_BPS,
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("default-collateral pricing requires one verified route");
    }
    for (const route of routes) {
      assertDefaultCollateralInvocation(descriptor, route);
    }
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      vault: descriptor.vault,
      share: descriptor.share,
      asset: descriptor.asset,
      implementation: descriptor.implementation,
      routes: Object.freeze([...routes]),
    });
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      declaredCallRequest(
        "current-asset",
        descriptor.vault,
        DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("asset"),
      ),
      declaredCallRequest(
        "current-total-supply",
        descriptor.vault,
        DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("totalSupply"),
      ),
      declaredCallRequest(
        "current-backing",
        descriptor.asset,
        DEFAULT_COLLATERAL_ERC20_INTERFACE.encodeFunctionData("balanceOf", [
          descriptor.vault,
        ]),
      ),
    ]),
    decodeSnapshot({ descriptor, initialResults }) {
      for (const id of REQUEST_IDS) {
        const result = initialResults.find((candidate) => candidate.id === id);
        if (result === undefined) {
          throw new Error(`default-collateral pricing result ${id} is missing`);
        }
        if (!result.ok) throw new RequiredAdapterRequestError(result);
      }
      const source = assertSameSource(
        initialResults.filter((result) => result.ok),
      );
      const unavailable: Record<string, string> = {};
      const quotes: Record<string, { amountIn: bigint; amountOut: bigint }> = {};
      const fail = (reason: string): void => {
        for (const route of descriptor.routes) {
          unavailable[route.routeKey] = reason;
        }
      };
      let totalSupply = 0n;
      let backing = 0n;
      if (
        shape(initialResults, "current-asset") !== "returned" ||
        shape(initialResults, "current-total-supply") !== "returned" ||
        shape(initialResults, "current-backing") !== "returned"
      ) {
        fail("default-collateral vault views are unavailable");
      } else {
        const asset = defaultCollateralAddress(String(
          DEFAULT_COLLATERAL_INTERFACE.decodeFunctionResult(
            "asset",
            returnedResult(initialResults, "current-asset").data,
          )[0],
        ));
        totalSupply = BigInt(DEFAULT_COLLATERAL_INTERFACE.decodeFunctionResult(
          "totalSupply",
          returnedResult(initialResults, "current-total-supply").data,
        )[0]);
        backing = BigInt(
          DEFAULT_COLLATERAL_ERC20_INTERFACE.decodeFunctionResult(
            "balanceOf",
            returnedResult(initialResults, "current-backing").data,
          )[0],
        );
        if (!sameAddress(asset, descriptor.asset)) {
          fail("default-collateral asset() changed at the quote block");
        } else {
          for (const route of descriptor.routes) {
            try {
              const amountOut = defaultCollateralQuote({
                amountIn: DEFAULT_COLLATERAL_PRICE_SAMPLE,
                totalSupply,
                backing,
              });
              if (amountOut <= 0n) {
                unavailable[route.routeKey] =
                  "default-collateral zero output at the price sample";
                continue;
              }
              quotes[route.routeKey] = Object.freeze({
                amountIn: DEFAULT_COLLATERAL_PRICE_SAMPLE,
                amountOut,
              });
            } catch (error) {
              unavailable[route.routeKey] = error instanceof Error
                ? error.message
                : "default-collateral rate not proven";
            }
          }
        }
      }
      return Object.freeze({
        source,
        totalSupply,
        backing,
        feeBps: DEFAULT_COLLATERAL_FEE_BPS,
        quotes: Object.freeze(quotes),
        unavailable: Object.freeze(unavailable),
      });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (
        routes.length !== descriptor.routes.length ||
        routes.some((route, index) =>
          route.routeKey !== descriptor.routes[index].routeKey
        )
      ) {
        throw new Error(
          "default-collateral current route differs from its pricing descriptor",
        );
      }
      return new Map(descriptor.routes.flatMap((route) => {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined) {
          if (snapshot.unavailable[route.routeKey] !== undefined) return [];
          throw new Error("default-collateral current quote is missing");
        }
        return [[route.routeKey, protocolMid({
          route,
          adapterId: DEFAULT_COLLATERAL_ACTION_ID,
          target: descriptor.vault,
          quote,
        })] as const];
      }));
    },
    classifyUnavailable({ snapshot, routes }) {
      return new Map(routes.flatMap((route) => {
        const reason = snapshot.unavailable[route.routeKey];
        return reason === undefined ? [] :
          [[route.routeKey, reason] as const];
      }));
    },
  },
  dependencies: ({ descriptor }) => defaultCollateralDependencies(descriptor),
  liveStateProjection: {
    project: ({ snapshot }) => ({
      ...snapshot,
      source: { ...snapshot.source },
    }),
  },
  mutation: {
    compile: ({ entries }) => compileAddressMutations(
      entries,
      ({ descriptor }) => ({
        addresses: [
          defaultCollateralAddress(descriptor.vault),
          defaultCollateralAddress(descriptor.asset),
        ],
        keys: [descriptor.instanceKey],
      }),
      { kinds: ["log", "call"] },
    ),
    affectedStateKeys: ({ descriptor, observation }) => {
      const address = observation.kind === "log"
        ? observation.address
        : observation.kind === "call"
        ? observation.target
        : undefined;
      if (address === undefined) return [];
      return [descriptor.vault, descriptor.asset].some((candidate) =>
        sameAddress(candidate, address)
      ) ? [descriptor.instanceKey] : [];
    },
  },
} satisfies PricingSemantics<
  DefaultCollateralDescriptor,
  DefaultCollateralRoute,
  DefaultCollateralPricingDescriptor,
  DefaultCollateralPricingSnapshot
>;

import { compileAddressMutations } from "../../mutation-index.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import {
  callRequest,
  decodeAddress,
  lowerAddress,
  protocolMid,
  returnedResult,
  sameAddress,
  type ProtocolPricingSnapshot,
} from "../standard-family/common.js";
import {
  assertOriginOusdInvocation,
  originOusdStaticBindingProjection,
} from "./binding.js";
import {
  ORIGIN_OUSD_PRICE_SAMPLE,
  ORIGIN_OUSD_VAULT_INTERFACE,
  originOusdMintQuote,
} from "./codec.js";
import type {
  OriginOusdDescriptor,
  OriginOusdPricingDescriptor,
  OriginOusdRoute,
} from "./types.js";

type Snapshot = ProtocolPricingSnapshot & {
  readonly unavailable: Readonly<Record<string, string>>;
};

/**
 * Pricing for the deterministic vault mint. There is no preview/oracle: the
 * only chain read is `vault.asset()`, which re-binds the vault's input asset at
 * the pricing source block. The point quote is the 1:1 mint ratio itself
 * (1 USDC -> 1 OUSD, 1e12 raw scaling).
 */
export const originOusdPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    originOusdStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    target: lowerAddress(descriptor.target),
    asset: lowerAddress(descriptor.asset),
    token: lowerAddress(descriptor.token),
    mintSemantics: "origin-ousd-vault-mint-1to1-no-fee-v1",
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("Origin OUSD pricing requires exactly one verified route");
    }
    assertOriginOusdInvocation(descriptor, routes[0]);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      target: descriptor.target,
      asset: descriptor.asset,
      token: descriptor.token,
      decimalScale: descriptor.decimalScale,
      route: routes[0],
    });
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      callRequest(
        "current-asset",
        descriptor.target,
        ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("asset"),
      ),
    ]),
    decodeSnapshot({ descriptor, initialResults }) {
      const result = returnedResult(initialResults, "current-asset");
      const source = result.source;
      const asset = decodeAddress(
        ORIGIN_OUSD_VAULT_INTERFACE,
        "asset",
        initialResults,
        "current-asset",
      );
      const unavailable: Record<string, string> = {};
      const quotes: Record<string, { amountIn: bigint; amountOut: bigint }> = {};
      if (!sameAddress(asset, descriptor.asset)) {
        unavailable[descriptor.route.routeKey] =
          "origin-ousd vault asset binding changed";
      } else {
        const amountIn = ORIGIN_OUSD_PRICE_SAMPLE;
        quotes[descriptor.route.routeKey] = Object.freeze({
          amountIn,
          amountOut: originOusdMintQuote(amountIn),
        });
      }
      return { source, quotes, unavailable };
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (
        routes.length !== 1 ||
        routes[0].routeKey !== descriptor.route.routeKey
      ) {
        throw new Error(
          "Origin OUSD current route differs from its pricing descriptor",
        );
      }
      const quote = snapshot.quotes[descriptor.route.routeKey];
      if (quote === undefined) {
        if (snapshot.unavailable[descriptor.route.routeKey] !== undefined) {
          return new Map();
        }
        throw new Error("Origin OUSD current quote missing");
      }
      return new Map([[descriptor.route.routeKey, protocolMid({
        route: descriptor.route,
        adapterId: "origin-ousd-mint",
        target: descriptor.target,
        quote,
      })]]);
    },
    classifyUnavailable({ snapshot, routes }) {
      return new Map(routes
        .filter(route => snapshot.unavailable[route.routeKey] !== undefined)
        .map(route => [route.routeKey, snapshot.unavailable[route.routeKey]] as const));
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    // The vault target and the two ERC20s are distinct addresses; de-duplicate
    // anyway because the pricing validator requires unique dependencies.
    ...new Set([
      descriptor.target,
      descriptor.asset,
      descriptor.token,
    ]),
  ]),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({
      addresses: [descriptor.target],
      keys: [descriptor.instanceKey],
    }), { kinds: ["call"] }),
    affectedStateKeys: ({ descriptor, observation }) =>
      observation.kind === "call" &&
        sameAddress(observation.target, descriptor.target)
        ? [descriptor.instanceKey]
        : [],
  },
} satisfies PricingSemantics<
  OriginOusdDescriptor,
  OriginOusdRoute,
  OriginOusdPricingDescriptor,
  Snapshot
>;

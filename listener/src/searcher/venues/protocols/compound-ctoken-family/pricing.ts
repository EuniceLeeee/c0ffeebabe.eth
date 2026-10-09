import { compileAddressMutations } from "../../mutation-index.js";
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
import { CTOKEN_EXCHANGE_RATE_SCALE, CTOKEN_INTERFACE } from "./abi.js";
import {
  assertCompoundCTokenInvocation,
  compoundCTokenStaticProjection,
} from "./codec.js";
import type {
  CompoundCTokenDescriptor,
  CompoundCTokenPricingDescriptor,
  CompoundCTokenPricingDraft,
  CompoundCTokenRoute,
} from "./types.js";

/**
 * Raw mid sampling only: the share-side sample amount is one full share unit
 * (`oneShare`), never a substitute for a requested input amount. Effective and
 * explicit quoting keep the caller's amount (see exact.ts).
 */
export const compoundCTokenPricing: PricingSemantics<
  CompoundCTokenDescriptor,
  CompoundCTokenRoute,
  CompoundCTokenPricingDescriptor,
  ProtocolPricingSnapshot,
  CompoundCTokenPricingDraft,
  { readonly oneShare: bigint }
> = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    compoundCTokenStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    market: lowerAddress(descriptor.market),
    comptroller: lowerAddress(descriptor.comptroller),
    underlying: lowerAddress(descriptor.underlying),
    share: lowerAddress(descriptor.share),
    decimals: descriptor.decimals,
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length === 0) {
      throw new Error("Compound cToken pricing requires behavior-proven routes");
    }
    for (const route of routes) {
      assertCompoundCTokenInvocation(descriptor, route);
    }
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      market: descriptor.market,
      comptroller: descriptor.comptroller,
      routes: Object.freeze([...routes]),
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: CompoundCTokenPricingDraft) => Object.freeze(
        [...new Set([
          lowerAddress(draft.market),
          lowerAddress(draft.comptroller),
          ...draft.routes.flatMap((route) => [
            lowerAddress(route.tokenIn),
            lowerAddress(route.tokenOut),
          ]),
        ])].sort(),
      ),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: CompoundCTokenPricingDraft) => Object.freeze([
      callRequest(
        "static-share-decimals",
        draft.market,
        CTOKEN_INTERFACE.encodeFunctionData("decimals"),
      ),
    ]),
    decode: ({ results }: { readonly results: readonly AdapterRequestResult[] }) =>
      Object.freeze({
        // `decodeDecimals` already returns the scaled one-unit value
        // (10 ** decimals) — the same contract the erc4626 share sample uses.
        // Exponentiating it again would make `oneShare` unrepresentable in a
        // double, so the raw mid would decode to NaN and the lifecycle would
        // drop the instance.
        oneShare: decodeDecimals(
          CTOKEN_INTERFACE,
          results,
          "static-share-decimals",
        ),
      }),
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error("Compound cToken pricing lacks decimals evidence");
    }
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) => Object.freeze(
      descriptor.routes.map((route) => callRequest(
        `current:${route.direction}`,
        descriptor.market,
        CTOKEN_INTERFACE.encodeFunctionData("exchangeRateStored"),
      )),
    ),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      return quoteResultMap(results, descriptor.routes.map((route) => ({
        routeKey: route.routeKey,
        requestId: `current:${route.direction}`,
        amountIn: descriptor.oneShare,
        decodeAmountOut: (data) => {
          const rate = BigInt(CTOKEN_INTERFACE.decodeFunctionResult(
            "exchangeRateStored",
            data,
          )[0]);
          return (descriptor.oneShare * rate) / CTOKEN_EXCHANGE_RATE_SCALE;
        },
      })));
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<
        CompoundCTokenRoute["routeKey"],
        ReturnType<typeof protocolMid>
      >();
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined) {
          throw new Error("Compound cToken current quote missing");
        }
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.market,
          quote,
        }));
      }
      return mids;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze(
    [...new Set([
      lowerAddress(descriptor.market),
      lowerAddress(descriptor.comptroller),
      ...descriptor.routes.flatMap((route) => [
        lowerAddress(route.tokenIn),
        lowerAddress(route.tokenOut),
      ]),
    ])].sort(),
  ),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(
      entries,
      ({ descriptor }) => ({
        addresses: [descriptor.market],
        keys: [descriptor.instanceKey],
      }),
      { kinds: ["log"] },
    ),
    affectedStateKeys: ({ descriptor, observation }) =>
      observation.kind === "log" &&
        observation.address.toLowerCase() === descriptor.market.toLowerCase()
        ? [descriptor.instanceKey]
        : [],
  },
};

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
import {
  LT_INTERFACE,
  ERC20_INTERFACE,
  LT_SAMPLE_SHARES,
} from "./abi.js";
import {
  assertYieldBasisLtInvocation,
  yieldBasisLtStaticProjection,
} from "./codec.js";
import type {
  YieldBasisLtDescriptor,
  YieldBasisLtPricingDescriptor,
  YieldBasisLtPricingDraft,
  YieldBasisLtRoute,
} from "./types.js";

/**
 * Raw mid sampling only: the share-side sample amount is one whole share unit
 * (`oneShare`), never a substitute for a requested input amount — the explicit
 * quote keeps the caller's amount and goes through preview_withdraw (exact.ts).
 */
export const yieldBasisLtPricing: PricingSemantics<
  YieldBasisLtDescriptor,
  YieldBasisLtRoute,
  YieldBasisLtPricingDescriptor,
  ProtocolPricingSnapshot,
  YieldBasisLtPricingDraft,
  { readonly oneShare: bigint; readonly oneAsset: bigint }
> = {
  // AMM accrual, oracle EMA and cryptopool ramps can change the withdrawal
  // preview without an LT log. Requote through the existing per-block path.
  refreshPolicy: "each-block",
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    yieldBasisLtStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    lt: lowerAddress(descriptor.lt),
    asset: lowerAddress(descriptor.asset),
    stablecoin: lowerAddress(descriptor.stablecoin),
    cryptopool: lowerAddress(descriptor.cryptopool),
    amm: lowerAddress(descriptor.amm),
    assetCoinIndex: descriptor.assetCoinIndex,
    decimals: descriptor.decimals,
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length === 0) {
      throw new Error(
        "Yield Basis LT pricing requires reverse-binding-proven routes",
      );
    }
    for (const route of routes) {
      assertYieldBasisLtInvocation(descriptor, route);
    }
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      lt: descriptor.lt,
      asset: descriptor.asset,
      stablecoin: descriptor.stablecoin,
      cryptopool: descriptor.cryptopool,
      amm: descriptor.amm,
      routes: Object.freeze([...routes]),
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: YieldBasisLtPricingDraft) => Object.freeze(
        [...new Set([
          lowerAddress(draft.lt),
          lowerAddress(draft.asset),
          ...draft.routes.flatMap((route) => [
            lowerAddress(route.tokenIn),
            lowerAddress(route.tokenOut),
          ]),
        ])].sort(),
      ),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: YieldBasisLtPricingDraft) => Object.freeze([
      callRequest(
        "static-share-decimals",
        draft.lt,
        LT_INTERFACE.encodeFunctionData("decimals"),
      ),
      callRequest("static-asset-decimals", draft.asset, ERC20_INTERFACE.encodeFunctionData("decimals")),
    ]),
    decode: ({ results }: { readonly results: readonly AdapterRequestResult[] }) =>
      Object.freeze({
        // `decodeDecimals` already returns the scaled one-unit value
        // (10 ** decimals): raising it to another power makes oneShare a bigint
        // no double can represent, the raw mid decodes to NaN and the central
        // lifecycle drops the instance. Same defect the compound family had.
        oneShare: decodeDecimals(
          LT_INTERFACE,
          results,
          "static-share-decimals",
        ),
        oneAsset: decodeDecimals(ERC20_INTERFACE, results, "static-asset-decimals"),
      }),
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error("Yield Basis LT pricing lacks share-decimals evidence");
    }
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) => Object.freeze(
      descriptor.routes.map((route) => callRequest(
        `current:${route.direction}`,
        descriptor.lt,
        route.direction === "deposit"
          ? LT_INTERFACE.encodeFunctionData("pricePerShare")
          : LT_INTERFACE.encodeFunctionData("preview_withdraw", [LT_SAMPLE_SHARES[0]]),
      )),
    ),
    decodeSnapshot({ descriptor, initialResults }) {
      return quoteResultMap(initialResults, descriptor.routes.map((route) => ({
        routeKey: route.routeKey,
        requestId: `current:${route.direction}`,
        amountIn: route.direction === "deposit" ? descriptor.oneAsset : LT_SAMPLE_SHARES[0],
        decodeAmountOut: (data) => {
          if (route.direction === "withdraw") return BigInt(LT_INTERFACE.decodeFunctionResult("preview_withdraw", data)[0]);
          // LT's fair NAV is normalized crypto per 18-decimal share. This is
          // raw-mid valuation only, not a slippage/debt-sensitive deposit quote.
          // Requested amounts are always priced by the full program in Exact.
          const fair = BigInt(LT_INTERFACE.decodeFunctionResult("pricePerShare", data)[0]);
          if (fair <= 0n) throw new Error("Yield Basis LT invalid deposit NAV");
          return descriptor.oneShare * 10n ** 18n / fair;
        },
      })));
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<
        YieldBasisLtRoute["routeKey"],
        ReturnType<typeof protocolMid>
      >();
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined) {
          throw new Error("Yield Basis LT current quote missing");
        }
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.lt,
          quote,
        }));
      }
      return mids;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze(
    [...new Set([
      lowerAddress(descriptor.lt),
      lowerAddress(descriptor.asset),
      lowerAddress(descriptor.stablecoin),
      lowerAddress(descriptor.cryptopool),
      lowerAddress(descriptor.amm),
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
        addresses: [descriptor.lt],
        keys: [descriptor.instanceKey],
      }),
      { kinds: ["log"] },
    ),
    affectedStateKeys: ({ descriptor, observation }) =>
      observation.kind === "log" &&
        observation.address.toLowerCase() === descriptor.lt.toLowerCase()
        ? [descriptor.instanceKey]
        : [],
  },
};

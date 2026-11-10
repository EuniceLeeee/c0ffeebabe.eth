import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { assertSameSource, callRequest, protocolMid, sameAddress, successfulResult } from "../standard-family/common.js";
import { ACCOUNTANT_INTERFACE } from "./abi.js";
import { boringStaticProjection } from "./instance.js";
import type {
  BoringDescriptor,
  BoringPricingDescriptor,
  BoringPricingDraft,
  BoringPricingSnapshot,
  BoringRoute,
} from "./types.js";

/** Accountant rates are quoted per ONE_SHARE = 10^shareDecimals raw units. */
export function withdrawOut(input: { readonly shares: bigint; readonly rate: bigint; readonly shareDecimals: number }): bigint {
  if (input.shares <= 0n || input.rate <= 0n || !Number.isInteger(input.shareDecimals) || input.shareDecimals < 0 || input.shareDecimals > 36) {
    throw new Error("boring vault withdraw amounts out of range");
  }
  return input.shares * input.rate / (10n ** BigInt(input.shareDecimals));
}

export const boringPricing = {
  stateKey: (r: BoringRoute) => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => boringStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    teller: descriptor.teller,
    accountant: descriptor.accountant,
    asset: descriptor.asset,
    semantics: "boring-vault-teller-v1",
  }),
  finalizePricingDescriptor({ draft }) {
    return draft;
  },
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) throw new Error("boring vault pricing requires one bound route");
    const route = routes[0]!;
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      teller: descriptor.teller,
      vault: descriptor.vault,
      accountant: descriptor.accountant,
      asset: descriptor.asset,
      shareDecimals: descriptor.shareDecimals,
      shareLockPeriod: descriptor.shareLockPeriod,
      tellerCodeHash: descriptor.tellerCodeHash,
      vaultCodeHash: descriptor.vaultCodeHash,
      accountantCodeHash: descriptor.accountantCodeHash,
      route,
    });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      callRequest("boring-rate", descriptor.accountant, ACCOUNTANT_INTERFACE.encodeFunctionData("getRateInQuoteSafe", [descriptor.asset])),
    ]),
    decodeSnapshot({ descriptor, initialResults }) {
      const rate = BigInt(ACCOUNTANT_INTERFACE.decodeFunctionResult("getRateInQuoteSafe", successfulResult(initialResults, "boring-rate").data)[0]);
      const amountIn = 10n ** BigInt(descriptor.shareDecimals);
      const quotes: Record<string, { readonly amountIn: bigint; readonly amountOut: bigint }> = {};
      if (rate > 0n) quotes[descriptor.route.routeKey] = Object.freeze({ amountIn, amountOut: withdrawOut({ shares: amountIn, rate, shareDecimals: descriptor.shareDecimals }) });
      return Object.freeze({ source: assertSameSource([successfulResult(initialResults, "boring-rate")]), rate, quotes });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<BoringRoute["routeKey"], ReturnType<typeof protocolMid>>();
      for (const route of routes) {
        const q = snapshot.quotes[route.routeKey];
        if (q === undefined || q.amountOut <= 0n) continue;
        mids.set(route.routeKey, protocolMid({ route, adapterId: route.adapterId, target: descriptor.teller, quote: q }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      const m = new Map<BoringRoute["routeKey"], string>();
      for (const route of routes) if (snapshot.quotes[route.routeKey] === undefined) m.set(route.routeKey, "boring_rate_unavailable");
      return m;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.teller, descriptor.vault, descriptor.accountant, descriptor.asset,
  ]),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(
      entries,
      ({ descriptor }) => ({
        addresses: [descriptor.teller, descriptor.vault, descriptor.asset],
        keys: [descriptor.instanceKey],
      }),
      { kinds: ["log"] },
    ),
    affectedStateKeys({ descriptor, observation }) {
      return observation.kind === "log" && (
        sameAddress(observation.address, descriptor.teller) ||
        sameAddress(observation.address, descriptor.accountant) ||
        sameAddress(observation.address, descriptor.vault)
      ) ? [descriptor.instanceKey] : [];
    },
  },
} satisfies PricingSemantics<BoringDescriptor, BoringRoute, BoringPricingDescriptor, BoringPricingSnapshot, BoringPricingDraft>;

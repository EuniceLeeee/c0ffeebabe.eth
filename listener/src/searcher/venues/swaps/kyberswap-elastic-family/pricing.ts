import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import { bigintRatio, directedPoolMid } from "../blockscan-state-shared.js";
import {
  assertKyberSwapInvocation,
  kyberSwapStaticProjection,
  same,
} from "./codec.js";
import { KYSWAP_SWAP_ACTION } from "./manifest.js";
import {
  poolStateRequests,
  decodePoolState,
} from "./state.js";
import { virtualReserves } from "./math.js";
import { KYSWAP_FEE_UNITS, KYSWAP_TWO_POW_96 } from "./abi.js";
import type {
  KyberSwapDescriptor,
  KyberSwapPricingDescriptor,
  KyberSwapPricingSnapshot,
  KyberSwapRoute,
} from "./types.js";

const dependencies = (descriptor: KyberSwapDescriptor) => [descriptor.pool];

function unavailableReason(snapshot: KyberSwapPricingSnapshot): string | null {
  if (snapshot.locked) return "kyberswap_elastic_pool_locked";
  if (snapshot.baseL + snapshot.reinvestL <= 0n) return "kyberswap_elastic_no_active_liquidity";
  const reserves = virtualReserves(snapshot);
  // A fractional virtual reserve needs a separate precision/capacity witness.
  // Do not fabricate a one-unit reserve or call this a chain-proven rejection.
  if (reserves.token0 <= 0n || reserves.token1 <= 0n) {
    return "kyberswap_elastic_raw_depth_below_one_unit";
  }
  return null;
}

/**
 * Raw marginal price only, with the fee included exactly once. Evaluate the
 * sqrt-price ratio directly: integer depth-relative samples can round either
 * input or output to zero even when reinvestment liquidity remains tradable.
 * Unrounded price does not enlarge the unchanged integer depth proxies, and
 * never replaces amount-sensitive Exact or an actual execution (see exact.ts).
 */
export const kyberswapElasticPricing = {
  stateKey: (route: KyberSwapRoute) => route.instanceKey,
  staticBindingProjection: ({
    descriptor,
  }: {
    readonly descriptor: KyberSwapDescriptor;
  }) => kyberSwapStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({
    descriptor,
  }: {
    readonly descriptor: KyberSwapDescriptor;
  }) => ({
    pool: descriptor.pool,
    token0: descriptor.token0,
    token1: descriptor.token1,
    feeUnits: descriptor.feeUnits,
    tickDistance: descriptor.tickDistance,
  }),
  compileDraft({
    descriptor,
    routes,
  }: {
    readonly descriptor: KyberSwapDescriptor;
    readonly routes: readonly KyberSwapRoute[];
  }) {
    for (const route of routes) assertKyberSwapInvocation(descriptor, route);
    return Object.freeze({ instance: descriptor });
  },
  finalizePricingDescriptor({
    draft,
  }: {
    readonly draft: KyberSwapPricingDescriptor;
  }) {
    return Object.freeze({ instance: draft.instance });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests({
      descriptor,
    }: {
      readonly descriptor: KyberSwapPricingDescriptor;
    }) {
      return poolStateRequests(descriptor.instance.pool);
    },
    decodeSnapshot({
      initialResults,
    }: {
      readonly initialResults: Parameters<typeof decodePoolState>[0];
    }) {
      return Object.freeze({
        ...decodePoolState(initialResults, { neighbours: false }),
      });
    },
    deriveMids({
      descriptor,
      routes,
      snapshot,
    }: {
      readonly descriptor: KyberSwapPricingDescriptor;
      readonly routes: readonly KyberSwapRoute[];
      readonly snapshot: KyberSwapPricingSnapshot;
    }) {
      const mids = new Map<
        KyberSwapRoute["routeKey"],
        ReturnType<typeof directedPoolMid>
      >();
      for (const route of routes) assertKyberSwapInvocation(descriptor.instance, route);
      if (unavailableReason(snapshot) !== null) return mids;
      const reserves = virtualReserves(snapshot);
      const square = snapshot.sqrtP * snapshot.sqrtP;
      const q192 = KYSWAP_TWO_POW_96 * KYSWAP_TWO_POW_96;
      const netFee = KYSWAP_FEE_UNITS - snapshot.feeUnits;
      for (const route of routes) {
        const depthIn = route.isToken0 ? reserves.token0 : reserves.token1;
        const depthOut = route.isToken0 ? reserves.token1 : reserves.token0;
        const mid = bigintRatio(
          (route.isToken0 ? square : q192) * netFee,
          (route.isToken0 ? q192 : square) * KYSWAP_FEE_UNITS,
        );
        mids.set(route.routeKey, directedPoolMid({
          kind: "external-swap",
          mid,
          reserveIn: depthIn,
          reserveOut: depthOut,
          feeBps: 0,
          edge: {
            adapterId: KYSWAP_SWAP_ACTION,
            instanceKey: route.instanceKey,
            target: route.pool,
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            slotKind: "swap",
            ...deriveEdgeTaxonomy("swap"),
          },
        }));
      }
      return mids;
    },
    classifyUnavailable({ descriptor, routes, snapshot }: {
      readonly descriptor: KyberSwapPricingDescriptor;
      readonly routes: readonly KyberSwapRoute[];
      readonly snapshot: KyberSwapPricingSnapshot;
    }) {
      const unavailable = new Map<KyberSwapRoute["routeKey"], string>();
      const reason = unavailableReason(snapshot);
      for (const route of routes) {
        assertKyberSwapInvocation(descriptor.instance, route);
        if (reason !== null) unavailable.set(route.routeKey, reason);
      }
      return unavailable;
    },
  },
  dependencies: ({
    descriptor,
  }: {
    readonly descriptor: KyberSwapPricingDescriptor;
  }) => dependencies(descriptor.instance),
  mutation: {
    compile: ({ entries }: { readonly entries: readonly never[] }) =>
      compileAddressMutations(
        entries,
        ({ descriptor }: { readonly descriptor: KyberSwapPricingDescriptor }) => ({
          addresses: dependencies(descriptor.instance),
          keys: [descriptor.instance.instanceKey],
        }),
        { kinds: ["log", "call"] },
      ),
    affectedStateKeys({
      descriptor,
      observation,
    }: {
      readonly descriptor: KyberSwapPricingDescriptor;
      readonly observation: { readonly kind: string; readonly address?: string; readonly target?: string };
    }) {
      const target = observation.kind === "call"
        ? observation.target
        : observation.kind === "log"
        ? observation.address
        : null;
      return target !== undefined && target !== null &&
          same(target, descriptor.instance.pool)
        ? [descriptor.instance.instanceKey]
        : [];
    },
  },
} satisfies PricingSemantics<
  KyberSwapDescriptor,
  KyberSwapRoute,
  KyberSwapPricingDescriptor,
  KyberSwapPricingSnapshot
>;

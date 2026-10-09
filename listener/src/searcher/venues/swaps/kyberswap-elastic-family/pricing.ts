import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
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
import { spotQuoteExactInput, virtualReserves } from "./math.js";
import type {
  KyberSwapDescriptor,
  KyberSwapPricingDescriptor,
  KyberSwapPricingSnapshot,
  KyberSwapRoute,
} from "./types.js";

const dependencies = (descriptor: KyberSwapDescriptor) => [descriptor.pool];

/**
 * Raw mid sampling only. The sample amount is one hundred-thousandth of the
 * pool's virtual reserve at the current price — a depth-relative sample, never
 * a substitute for a caller's requested input amount (see exact.ts). The mid
 * itself is the zero-impact price at the pool's current sqrt price with the
 * pool fee applied, so it can be produced for any live pool state.
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
        ReturnType<typeof quotedPoolMid>
      >();
      const reserves = virtualReserves(snapshot);
      for (const route of routes) {
        assertKyberSwapInvocation(descriptor.instance, route);
        const depthIn = route.isToken0 ? reserves.token0 : reserves.token1;
        const depthOut = route.isToken0 ? reserves.token1 : reserves.token0;
        const amountIn = depthIn / 100_000n;
        if (amountIn <= 1n || depthOut === 0n) continue;
        const amountOut = spotQuoteExactInput(snapshot, route.isToken0, amountIn);
        if (amountOut === 0n) continue;
        mids.set(route.routeKey, quotedPoolMid({
          kind: "external-swap",
          amountIn,
          amountOut,
          depthIn,
          depthOut,
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

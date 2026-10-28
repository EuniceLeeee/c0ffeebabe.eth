import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { lowerAddress } from "../../protocols/standard-family/common.js";
import {
  isToken0For,
  kyberSwapBindingFingerprint,
  tokenInFor,
  tokenOutFor,
} from "./codec.js";
import { KYSWAP_SWAP_ACTION } from "./manifest.js";
import type {
  KyberSwapDescriptor,
  KyberSwapDirection,
  KyberSwapRoute,
} from "./types.js";

/**
 * Exactly two routed directions, both exact input. `isToken0` selects the INPUT
 * token for a positive `swapQty`; a negative `swapQty` would make the same flag
 * denote an output token, so exact output has no route at all.
 */
export const kyberswapElasticRoutes = {
  project({ descriptor }: { readonly descriptor: KyberSwapDescriptor }) {
    const fingerprint = kyberSwapBindingFingerprint(descriptor);
    return Object.freeze([
      route(descriptor, "token0-in", fingerprint),
      route(descriptor, "token1-in", fingerprint),
    ]);
  },
  projectGraph({
    descriptor,
    route,
  }: {
    readonly descriptor: KyberSwapDescriptor;
    readonly route: KyberSwapRoute;
  }) {
    return Object.freeze({
      routeActionAdapterId: KYSWAP_SWAP_ACTION,
      executionTarget: descriptor.pool,
      venueIdentity: Object.freeze({
        kind: "address-pool",
        pool: lowerAddress(descriptor.pool),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<KyberSwapDescriptor, KyberSwapRoute>;

function route(
  descriptor: KyberSwapDescriptor,
  direction: KyberSwapDirection,
  bindingFingerprint: string,
): KyberSwapRoute {
  return Object.freeze({
    routeKey: routeKey([
      descriptor.familyId,
      lowerAddress(descriptor.pool),
      direction,
    ].join("\u001f")),
    familyId: descriptor.familyId,
    lineageId: descriptor.lineageId,
    instanceKey: descriptor.instanceKey,
    tokenIn: tokenInFor(descriptor, direction),
    tokenOut: tokenOutFor(descriptor, direction),
    taxonomy: Object.freeze({ slotKind: "swap" as const }),
    bindingRef: Object.freeze({
      bindingKey: lowerAddress(descriptor.pool),
      fingerprint: bindingFingerprint,
    }),
    runtimeRequirements: Object.freeze([]),
    pool: descriptor.pool,
    direction,
    isToken0: isToken0For(direction),
    feeUnits: descriptor.feeUnits,
    tickDistance: descriptor.tickDistance,
  });
}

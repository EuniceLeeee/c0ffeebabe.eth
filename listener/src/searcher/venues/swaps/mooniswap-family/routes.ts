import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { MOONISWAP_ACTION, assertRoute, binding, lower, routeIdentity } from "./codec.js";
import type { MooniswapDescriptor, MooniswapRoute } from "./types.js";
export const mooniswapRoutes = {
  project({ descriptor: d }) {
    return [[d.token0, d.token1], [d.token1, d.token0]].map(([tokenIn, tokenOut]) => {
      const key = routeIdentity(d, tokenIn, tokenOut);
      return { familyId: d.familyId, lineageId: d.lineageId, instanceKey: d.instanceKey, pool: d.pool,
        routeKey: routeKey(key), tokenIn, tokenOut, taxonomy: { slotKind: "swap" as const }, runtimeRequirements: d.runtimeRequirements,
        bindingRef: { bindingKey: key, fingerprint: hashCanonical(binding(d)) } };
    });
  },
  projectGraph({ descriptor, route }) {
    assertRoute(descriptor, route);
    return { routeActionAdapterId: MOONISWAP_ACTION, executionTarget: descriptor.pool,
      venueIdentity: { kind: "address-pool", pool: lower(descriptor.pool) }, centralScoreKey: route.routeKey };
  },
} satisfies RouteProjectionSemantics<MooniswapDescriptor, MooniswapRoute>;

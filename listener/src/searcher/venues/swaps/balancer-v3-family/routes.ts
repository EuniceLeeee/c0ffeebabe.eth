import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { VAULT, ROUTER, PERMIT2, lower, same, assertRouterQuoteCompatible } from "./codec.js";
import { staticBinding } from "./instance.js";
import { BALANCER_V3_FAMILY_ID, BALANCER_V3_LINEAGE } from "./manifest.js";
import type { BalancerV3Descriptor, BalancerV3Route } from "./types.js";

function key(descriptor: BalancerV3Descriptor, i: number, j: number): string {
  return `${descriptor.familyId}:${lower(descriptor.pool)}:${i}:${j}`;
}
export const balancerV3Routes = {
  project({ descriptor }) {
    assertRouterQuoteCompatible(descriptor.binding.hooks);
    const fingerprint = hashCanonical(staticBinding(descriptor));
    return Object.freeze(descriptor.binding.tokens.flatMap((tokenIn, i) => descriptor.binding.tokens.flatMap((tokenOut, j) =>
      i === j ? [] : [Object.freeze({ familyId: descriptor.familyId, lineageId: descriptor.lineageId,
        instanceKey: descriptor.instanceKey, routeKey: routeKey(key(descriptor, i, j)), tokenIn, tokenOut,
        taxonomy: { slotKind: "swap" as const }, bindingRef: { bindingKey: key(descriptor, i, j), fingerprint },
        runtimeRequirements: descriptor.runtimeRequirements, pool: descriptor.pool, i, j })])));
  },
  projectGraph({ descriptor, route }) {
    assertRoute(descriptor, route);
    // Logical venue is the indexed pool; execution's owned root targets Router.
    return { routeActionAdapterId: "balancer-v3-router-swap", executionTarget: descriptor.pool,
      venueIdentity: { kind: "address-pool", pool: lower(descriptor.pool) }, centralScoreKey: route.routeKey };
  },
} satisfies RouteProjectionSemantics<BalancerV3Descriptor, BalancerV3Route>;
export function assertRoute(descriptor: BalancerV3Descriptor, route: BalancerV3Route): void {
  assertRouterQuoteCompatible(descriptor.binding.hooks);
  const tokens = descriptor.binding.tokens;
  if (descriptor.familyId !== BALANCER_V3_FAMILY_ID || descriptor.lineageId !== BALANCER_V3_LINEAGE ||
      !same(descriptor.binding.vault, VAULT) || !same(descriptor.binding.router, ROUTER) ||
      !same(descriptor.binding.permit2, PERMIT2) ||
      !Number.isInteger(route.i) || !Number.isInteger(route.j) || route.i < 0 || route.j < 0 ||
      route.i >= tokens.length || route.j >= tokens.length || route.i === route.j ||
      route.familyId !== descriptor.familyId || route.lineageId !== descriptor.lineageId || route.instanceKey !== descriptor.instanceKey ||
      !same(route.pool, descriptor.pool) || !same(route.tokenIn, tokens[route.i]) || !same(route.tokenOut, tokens[route.j]) ||
      route.taxonomy.slotKind !== "swap" || route.routeKey !== key(descriptor, route.i, route.j) ||
      route.bindingRef.bindingKey !== key(descriptor, route.i, route.j) ||
      route.bindingRef.fingerprint !== hashCanonical(staticBinding(descriptor))) throw new Error("balancer-v3 route does not match descriptor");
}

import { ADDR } from "../../../../shared/constants/addresses.js";
import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lower, same } from "./codec.js";
import { staticBinding } from "./instance.js";
import type { EllaDescriptor, EllaDirection, EllaRoute } from "./types.js";
export const actionId = (d: EllaDirection) => d === "buy-token" ? "ella-buy-token" : "ella-sell-token";
const directions = ["buy-token", "sell-token"] as const;
export const ellaRoutes = {
  project({ descriptor: d }) {
    return directions.map(direction => ({ familyId: d.familyId, lineageId: d.lineageId, instanceKey: d.instanceKey,
      routeKey: routeKey(`${d.familyId}:${lower(d.pool)}:${direction}`),
      tokenIn: direction === "buy-token" ? ADDR.WETH : d.token, tokenOut: direction === "buy-token" ? d.token : ADDR.WETH,
      taxonomy: { slotKind: "swap" as const }, bindingRef: { bindingKey: lower(d.pool), fingerprint: hashCanonical(staticBinding(d)) },
      runtimeRequirements: d.runtimeRequirements, pool: d.pool, direction }));
  },
  projectGraph({ descriptor, route }) {
    assertRoute(descriptor, route);
    return { routeActionAdapterId: actionId(route.direction), executionTarget: descriptor.pool,
      venueIdentity: { kind: "address-pool", pool: lower(descriptor.pool) }, centralScoreKey: route.routeKey };
  },
} satisfies RouteProjectionSemantics<EllaDescriptor, EllaRoute>;
export function assertRoute(d: EllaDescriptor, r: EllaRoute): void {
  if (!directions.includes(r.direction) || !same(d.pool, r.pool) || r.familyId !== d.familyId || r.lineageId !== d.lineageId ||
      r.instanceKey !== d.instanceKey || r.routeKey !== `${d.familyId}:${lower(d.pool)}:${r.direction}` ||
      r.bindingRef.fingerprint !== hashCanonical(staticBinding(d)) || r.bindingRef.bindingKey !== lower(d.pool) ||
      !same(r.tokenIn, r.direction === "buy-token" ? ADDR.WETH : d.token) || !same(r.tokenOut, r.direction === "buy-token" ? d.token : ADDR.WETH)) {
    throw new Error("ella route does not match admitted instance");
  }
}

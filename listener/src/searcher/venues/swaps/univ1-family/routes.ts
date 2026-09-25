import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { IMPLEMENTATION, MODEL, WETH, same } from "./codec.js";
import { staticBinding } from "./instance.js";
import { ACTION, ID, LINEAGE } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
const key = (pool: string, buy: boolean) => `${ID}:${pool}:${buy ? "eth-token" : "token-eth"}`;
export function assertRoute(d: Descriptor, r: Route): void {
  if (d.familyId !== ID || d.lineageId !== LINEAGE || d.model !== MODEL || d.implementation !== IMPLEMENTATION ||
      d.instanceKey !== d.pool || r.familyId !== ID || r.lineageId !== LINEAGE || r.instanceKey !== d.instanceKey ||
      r.pool !== d.pool || typeof r.buy !== "boolean" || r.routeKey !== key(d.pool, r.buy) ||
      !same(r.tokenIn, r.buy ? WETH : d.token) || !same(r.tokenOut, r.buy ? d.token : WETH) ||
      r.bindingRef.bindingKey !== d.pool || r.bindingRef.fingerprint !== hashCanonical(staticBinding(d)) ||
      r.taxonomy.slotKind !== "swap") throw new Error("univ1 incompatible route");
}
export const routes = {
  project({ descriptor: d }) {
    return [true, false].map(buy => Object.freeze({ familyId: ID, lineageId: LINEAGE, instanceKey: d.instanceKey,
      routeKey: routeKey(key(d.pool, buy)), buy, pool: d.pool, tokenIn: buy ? WETH : d.token, tokenOut: buy ? d.token : WETH,
      taxonomy: { slotKind: "swap" as const }, bindingRef: { bindingKey: d.pool, fingerprint: hashCanonical(staticBinding(d)) },
      runtimeRequirements: d.runtimeRequirements }));
  },
  projectGraph({ descriptor, route }) {
    assertRoute(descriptor, route);
    return { routeActionAdapterId: ACTION, executionTarget: descriptor.pool,
      venueIdentity: { kind: "address-pool", pool: descriptor.pool }, centralScoreKey: route.routeKey };
  },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

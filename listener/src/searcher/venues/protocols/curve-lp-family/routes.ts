import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { binding } from "./instance.js";
import { ACTION, FAMILY, LINEAGE } from "./manifest.js";
import type { Descriptor, Direction, Route } from "./types.js";
const id = (d: Descriptor, dir: Direction, index: number) => `${FAMILY}:${d.pool}:${dir}:${index}`;
export function assertRoute(d: Descriptor, r: Route) {
  if (d.familyId !== FAMILY || d.lineageId !== LINEAGE || d.instanceKey !== d.pool || r.familyId !== FAMILY || r.lineageId !== LINEAGE ||
      r.instanceKey !== d.instanceKey || !["mint", "redeem"].includes(r.direction) || (r.index !== 0 && r.index !== 1) ||
      r.routeKey !== id(d, r.direction, r.index) || r.tokenIn !== (r.direction === "mint" ? d.coins[r.index] : d.lp) ||
      r.tokenOut !== (r.direction === "mint" ? d.lp : d.coins[r.index]) || r.taxonomy.slotKind !== "protocol" || r.taxonomy.protocolAction !== "convert" ||
      r.bindingRef.bindingKey !== d.pool || r.bindingRef.fingerprint !== hashCanonical(binding(d))) throw new Error("curve-lp route binding mismatch");
}
export const routes = { project: ({ descriptor: d }) => (["mint", "redeem"] as const).flatMap(direction => ([0, 1] as const).map(index => ({
  familyId: FAMILY, lineageId: LINEAGE, instanceKey: d.instanceKey, direction, index, routeKey: routeKey(id(d, direction, index)),
  tokenIn: direction === "mint" ? d.coins[index] : d.lp, tokenOut: direction === "mint" ? d.lp : d.coins[index],
  taxonomy: { slotKind: "protocol" as const, protocolAction: "convert" as const }, bindingRef: { bindingKey: d.pool, fingerprint: hashCanonical(binding(d)) },
  runtimeRequirements: d.runtimeRequirements }))),
  projectGraph({ descriptor: d, route: r }) { assertRoute(d, r); return { routeActionAdapterId: ACTION, executionTarget: d.pool,
    venueIdentity: { kind: "address-protocol", target: d.pool }, centralScoreKey: r.routeKey }; },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

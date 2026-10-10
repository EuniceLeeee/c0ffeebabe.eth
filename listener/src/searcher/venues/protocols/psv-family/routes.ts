import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { binding } from "./instance.js";
import { ACTION, FAMILY, LINEAGE } from "./manifest.js";
import type { Descriptor, Direction, Route } from "./types.js";
const key = (d: Descriptor, dir: Direction) => `${FAMILY}:${d.target}:${dir}`;
export function assertRoute(d: Descriptor, r: Route): void {
  const sell = r.direction === "sell-gem";
  if (!["sell-gem", "buy-gem"].includes(r.direction) || d.familyId !== FAMILY || d.lineageId !== LINEAGE || d.instanceKey !== d.target ||
      r.familyId !== FAMILY || r.lineageId !== LINEAGE || r.instanceKey !== d.instanceKey || r.routeKey !== key(d, r.direction) ||
      r.tokenIn !== (sell ? d.gem : d.stable) || r.tokenOut !== (sell ? d.stable : d.gem) ||
      r.taxonomy.slotKind !== "protocol" || r.taxonomy.protocolAction !== "convert" || r.bindingRef.bindingKey !== d.target ||
      r.bindingRef.fingerprint !== hashCanonical(binding(d))) throw new Error("PSV route binding mismatch");
}
export const routes = {
  project: ({ descriptor: d }) => (["sell-gem", "buy-gem"] as const).map(direction => ({ familyId: FAMILY, lineageId: LINEAGE,
    instanceKey: d.instanceKey, direction, routeKey: routeKey(key(d, direction)), tokenIn: direction === "sell-gem" ? d.gem : d.stable,
    tokenOut: direction === "sell-gem" ? d.stable : d.gem, taxonomy: { slotKind: "protocol" as const, protocolAction: "convert" as const },
    bindingRef: { bindingKey: d.target, fingerprint: hashCanonical(binding(d)) }, runtimeRequirements: d.runtimeRequirements })),
  projectGraph({ descriptor: d, route: r }) { assertRoute(d, r); return { routeActionAdapterId: ACTION, executionTarget: d.target,
    venueIdentity: { kind: "address-protocol", target: d.target }, centralScoreKey: r.routeKey }; },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

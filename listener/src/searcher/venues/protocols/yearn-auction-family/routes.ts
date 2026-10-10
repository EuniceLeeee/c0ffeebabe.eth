import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { binding, key } from "./instance.js";
import { ACTION, FAMILY, LINEAGE } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
const routeId = (d: Descriptor) => `${FAMILY}:${key(d)}:take`;
export function assertRoute(d: Descriptor, r: Route): void {
  if (d.familyId !== FAMILY || d.lineageId !== LINEAGE || d.instanceKey !== key(d) || r.direction !== "take" ||
      r.familyId !== FAMILY || r.lineageId !== LINEAGE || r.instanceKey !== d.instanceKey || r.routeKey !== routeId(d) ||
      r.tokenIn !== d.want || r.tokenOut !== d.sold || r.taxonomy.slotKind !== "protocol" || r.taxonomy.protocolAction !== "convert" ||
      r.bindingRef.bindingKey !== key(d) || r.bindingRef.fingerprint !== hashCanonical(binding(d))) throw new Error("Yearn auction route binding mismatch");
}
export const routes = { project: ({ descriptor: d }) => [{ familyId: FAMILY, lineageId: LINEAGE, instanceKey: d.instanceKey,
  direction: "take" as const, routeKey: routeKey(routeId(d)), tokenIn: d.want, tokenOut: d.sold,
  taxonomy: { slotKind: "protocol" as const, protocolAction: "convert" as const },
  bindingRef: { bindingKey: key(d), fingerprint: hashCanonical(binding(d)) }, runtimeRequirements: d.runtimeRequirements }],
  projectGraph({ descriptor: d, route: r }) { assertRoute(d, r); return { routeActionAdapterId: ACTION, executionTarget: d.target,
    venueIdentity: { kind: "address-protocol", target: d.target }, centralScoreKey: r.routeKey }; },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

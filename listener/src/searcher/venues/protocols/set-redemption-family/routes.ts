import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { ACTION, FAMILY, LINEAGE } from "./manifest.js";
import { binding, key } from "./instance.js";
import type { Descriptor, Route } from "./types.js";
const routeId = (d: Descriptor, component: string) => `${FAMILY}:${key(d)}:${component}`;
export function assertRoute(d: Descriptor, r: Route) {
  if (d.familyId !== FAMILY || d.lineageId !== LINEAGE || d.instanceKey !== key(d) || r.familyId !== FAMILY || r.lineageId !== LINEAGE || r.instanceKey !== d.instanceKey ||
    !d.components.includes(r.component) || r.tokenIn !== d.set || r.tokenOut !== r.component || r.routeKey !== routeId(d, r.component) ||
    r.bindingRef.bindingKey !== key(d) || r.bindingRef.fingerprint !== hashCanonical(binding(d)) || r.taxonomy.slotKind !== "protocol" || r.taxonomy.protocolAction !== "redeem")
    throw new Error("set-redemption route binding mismatch");
}
export const routes = {
  project: ({ descriptor: d }) => d.components.map(component => ({ familyId: FAMILY, lineageId: LINEAGE, instanceKey: d.instanceKey,
    routeKey: routeKey(routeId(d, component)), component, tokenIn: d.set, tokenOut: component,
    taxonomy: { slotKind: "protocol" as const, protocolAction: "redeem" as const },
    bindingRef: { bindingKey: key(d), fingerprint: hashCanonical(binding(d)) }, runtimeRequirements: d.runtimeRequirements })),
  projectGraph({ descriptor: d, route: r }) { assertRoute(d, r); return { routeActionAdapterId: ACTION, executionTarget: d.module,
    venueIdentity: { kind: "address-protocol", target: d.set, module: d.module }, centralScoreKey: r.routeKey }; },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

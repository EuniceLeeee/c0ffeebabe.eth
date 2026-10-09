import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { ACTION, FAMILY, LINEAGE, LEGACY_ACTION, LEGACY_ISSUE_ACTION, LEGACY_LINEAGE } from "./manifest.js";
import { binding, key } from "./instance.js";
import type { Descriptor, Route } from "./types.js";
const routeId = (d: Descriptor, component: string, issue?: true) => `${FAMILY}:${key(d)}:${component}${issue ? ":issue" : ""}`;
export const actionId = (d: Descriptor, r?: Route) => r?.issue ? LEGACY_ISSUE_ACTION : d.legacy ? LEGACY_ACTION : ACTION;
export function assertRoute(d: Descriptor, r: Route) {
  if (d.familyId !== FAMILY || d.lineageId !== (d.legacy ? LEGACY_LINEAGE : LINEAGE) || d.instanceKey !== key(d) || r.familyId !== FAMILY || r.lineageId !== d.lineageId || r.instanceKey !== d.instanceKey ||
    !d.components.includes(r.component) || (r.issue && (!d.legacy?.issuance || d.components.length !== 1)) ||
    r.tokenIn !== (r.issue ? r.component : d.set) || r.tokenOut !== (r.issue ? d.set : r.component) || r.routeKey !== routeId(d, r.component, r.issue) ||
    r.bindingRef.bindingKey !== key(d) || r.bindingRef.fingerprint !== hashCanonical(binding(d)) || r.taxonomy.slotKind !== "protocol" || r.taxonomy.protocolAction !== (r.issue ? "wrap" : "redeem"))
    throw new Error("set-redemption route binding mismatch");
}
export const routes = {
  project: ({ descriptor: d }) => [...d.components.map(component => ({ familyId: FAMILY, lineageId: d.lineageId, instanceKey: d.instanceKey,
    routeKey: routeKey(routeId(d, component)), component, tokenIn: d.set, tokenOut: component,
    taxonomy: { slotKind: "protocol" as const, protocolAction: "redeem" as const },
    bindingRef: { bindingKey: key(d), fingerprint: hashCanonical(binding(d)) }, runtimeRequirements: d.runtimeRequirements })),
    ...(d.legacy?.issuance && d.components.length === 1 ? [{ familyId: FAMILY, lineageId: d.lineageId, instanceKey: d.instanceKey,
      routeKey: routeKey(routeId(d, d.components[0], true)), component: d.components[0], issue: true as const, tokenIn: d.components[0], tokenOut: d.set,
      taxonomy: { slotKind: "protocol" as const, protocolAction: "wrap" as const },
      bindingRef: { bindingKey: key(d), fingerprint: hashCanonical(binding(d)) }, runtimeRequirements: d.runtimeRequirements }] : [])],
  projectGraph({ descriptor: d, route: r }) { assertRoute(d, r); return { routeActionAdapterId: actionId(d, r), executionTarget: d.module,
    venueIdentity: { kind: "address-protocol", target: d.set, module: d.module }, centralScoreKey: r.routeKey }; },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

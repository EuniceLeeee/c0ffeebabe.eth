import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { binding } from "./instance.js";
import { ACTION, FAMILY, LINEAGE } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
const key = (d: Descriptor) => `${FAMILY}:${d.pod}:redeem:${d.asset}`;
export function assertRoute(d: Descriptor, r: Route): void {
  if (d.familyId !== FAMILY || d.lineageId !== LINEAGE || d.instanceKey !== d.pod || r.familyId !== FAMILY ||
      r.lineageId !== LINEAGE || r.instanceKey !== d.instanceKey || r.routeKey !== key(d) || r.tokenIn !== d.pod ||
      r.tokenOut !== d.asset || r.taxonomy.slotKind !== "protocol" || r.taxonomy.protocolAction !== "redeem" ||
      r.bindingRef.bindingKey !== d.pod || r.bindingRef.fingerprint !== hashCanonical(binding(d))) throw new Error("peapods route binding mismatch");
}
export const routes = {
  project: ({ descriptor: d }) => [{ familyId: FAMILY, lineageId: LINEAGE, instanceKey: d.instanceKey, routeKey: routeKey(key(d)),
    tokenIn: d.pod, tokenOut: d.asset, taxonomy: { slotKind: "protocol" as const, protocolAction: "redeem" as const },
    bindingRef: { bindingKey: d.pod, fingerprint: hashCanonical(binding(d)) }, runtimeRequirements: d.runtimeRequirements }],
  projectGraph({ descriptor: d, route: r }) { assertRoute(d, r); return { routeActionAdapterId: ACTION, executionTarget: d.pod,
    venueIdentity: { kind: "address-protocol", target: d.pod }, centralScoreKey: r.routeKey }; },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

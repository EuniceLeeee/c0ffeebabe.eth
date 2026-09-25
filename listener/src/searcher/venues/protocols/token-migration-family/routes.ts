import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { assertInvocation, bindingProjection } from "./binding.js";
import type { Descriptor, Route } from "./types.js";
export const routes = {
  project: ({ descriptor: d }) => [{
    routeKey: routeKey(`${FAMILY}\u001f${d.target.toLowerCase()}\u001fmigrate`),
    familyId: FAMILY, lineageId: LINEAGE, instanceKey: d.instanceKey,
    tokenIn: d.tokenIn, tokenOut: d.tokenOut, taxonomy: { slotKind: "protocol" as const, protocolAction: "convert" as const },
    bindingRef: { bindingKey: d.target.toLowerCase(), fingerprint: hashCanonical(bindingProjection(d)) },
    runtimeRequirements: d.runtimeRequirements, target: d.target, direction: "migrate" as const, adapterId: "token-migration" as const,
  }],
  projectGraph({ descriptor, route }) {
    assertInvocation(descriptor, route);
    return { routeActionAdapterId: route.adapterId, executionTarget: descriptor.target,
      venueIdentity: { kind: "address-protocol", target: descriptor.target.toLowerCase() }, centralScoreKey: route.routeKey };
  },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

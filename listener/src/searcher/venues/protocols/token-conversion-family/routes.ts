import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertInvocation, staticProjection } from "./binding.js";
import type { ConversionDescriptor, ConversionRoute } from "./types.js";
export const routes = {
  project({ descriptor: d }) {
    return (["mint", "redeem"] as const).map(direction => Object.freeze({
      familyId: d.familyId, lineageId: d.lineageId, instanceKey: d.instanceKey,
      routeKey: routeKey(`${d.familyId}\u001f${d.target.toLowerCase()}\u001f${direction}`),
      target: d.target, direction, adapterId: `token-conversion-${direction}` as const,
      tokenIn: direction === "mint" ? d.asset : d.target, tokenOut: direction === "mint" ? d.target : d.asset,
      taxonomy: { slotKind: "protocol" as const, protocolAction: direction === "mint" ? "wrap" as const : "redeem" as const },
      bindingRef: { bindingKey: d.target.toLowerCase(), fingerprint: hashCanonical(staticProjection(d)) },
      runtimeRequirements: d.runtimeRequirements,
    }));
  },
  projectGraph({ descriptor, route }) {
    assertInvocation(descriptor, route);
    return { routeActionAdapterId: route.adapterId, executionTarget: descriptor.target,
      venueIdentity: { kind: "address-protocol", target: descriptor.target.toLowerCase() }, centralScoreKey: route.routeKey };
  },
} satisfies RouteProjectionSemantics<ConversionDescriptor, ConversionRoute>;

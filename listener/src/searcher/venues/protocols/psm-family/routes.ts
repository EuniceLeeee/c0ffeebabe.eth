import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { psmStaticBindingProjection } from "./binding.js";
import { PSM_FAMILY_ID, PSM_LINEAGE_ID } from "./manifest.js";
import type { PsmDescriptor, PsmRoute } from "./types.js";

export const psmRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(psmStaticBindingProjection(descriptor));
    return Object.freeze((["sell-gem", "buy-gem"] as const).map(direction => Object.freeze({
      routeKey: routeKey(
        `${PSM_FAMILY_ID}\u001f${lowerAddress(descriptor.target)}\u001f${direction}`,
      ),
      familyId: PSM_FAMILY_ID,
      lineageId: PSM_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: direction === "sell-gem" ? descriptor.gem : descriptor.dai,
      tokenOut: direction === "sell-gem" ? descriptor.dai : descriptor.gem,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "convert" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.target),
        fingerprint,
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.target,
      direction,
      adapterId: "psm" as const,
    })));
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.target,
      venueIdentity: Object.freeze({
        kind: "address-protocol",
        target: lowerAddress(descriptor.target),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<PsmDescriptor, PsmRoute>;

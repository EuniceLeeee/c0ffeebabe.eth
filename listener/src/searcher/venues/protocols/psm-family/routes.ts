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
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${PSM_FAMILY_ID}\u001f${lowerAddress(descriptor.target)}\u001fsell-gem`,
      ),
      familyId: PSM_FAMILY_ID,
      lineageId: PSM_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.gem,
      tokenOut: descriptor.dai,
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
      direction: "sell-gem" as const,
      adapterId: "psm" as const,
    })]);
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

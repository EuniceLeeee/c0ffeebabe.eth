import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { rocksolidStaticBindingProjection } from "./binding.js";
import {
  ROCKSOLID_FAMILY_ID,
  ROCKSOLID_LINEAGE_ID,
} from "./manifest.js";
import type { RocksolidDescriptor, RocksolidRoute } from "./types.js";

export const rocksolidRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(
      rocksolidStaticBindingProjection(descriptor),
    );
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${ROCKSOLID_FAMILY_ID}\u001f${lowerAddress(descriptor.target)}\u001fsync-deposit`,
      ),
      familyId: ROCKSOLID_FAMILY_ID,
      lineageId: ROCKSOLID_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.asset,
      tokenOut: descriptor.receipt,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "wrap" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.target),
        fingerprint,
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.target,
      direction: "sync-deposit" as const,
      adapterId: "rocksolid-sync-deposit" as const,
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
} satisfies RouteProjectionSemantics<RocksolidDescriptor, RocksolidRoute>;

import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { goldxStaticBindingProjection } from "./binding.js";
import { GOLDX_FAMILY_ID, GOLDX_LINEAGE_ID } from "./manifest.js";
import type { GoldxDescriptor, GoldxRoute } from "./types.js";

export const goldxRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(
      goldxStaticBindingProjection(descriptor),
    );
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${GOLDX_FAMILY_ID}\u001f${lowerAddress(descriptor.target)}\u001fmint`,
      ),
      familyId: GOLDX_FAMILY_ID,
      lineageId: GOLDX_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.collateral,
      tokenOut: descriptor.receipt,
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
      direction: "mint" as const,
      adapterId: "goldx-mint" as const,
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
} satisfies RouteProjectionSemantics<GoldxDescriptor, GoldxRoute>;

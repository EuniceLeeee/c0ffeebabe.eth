import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { originOusdStaticBindingProjection } from "./binding.js";
import {
  ORIGIN_OUSD_FAMILY_ID,
  ORIGIN_OUSD_LINEAGE_ID,
} from "./manifest.js";
import type { OriginOusdDescriptor, OriginOusdRoute } from "./types.js";

export const originOusdRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(
      originOusdStaticBindingProjection(descriptor),
    );
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${ORIGIN_OUSD_FAMILY_ID}\u001f${lowerAddress(descriptor.target)}\u001fmint-usdc-to-ousd`,
      ),
      familyId: ORIGIN_OUSD_FAMILY_ID,
      lineageId: ORIGIN_OUSD_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.asset,
      tokenOut: descriptor.token,
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
      direction: "mint-usdc-to-ousd" as const,
      adapterId: "origin-ousd-mint" as const,
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
} satisfies RouteProjectionSemantics<OriginOusdDescriptor, OriginOusdRoute>;

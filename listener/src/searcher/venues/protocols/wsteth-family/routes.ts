import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { wstethStaticBindingProjection } from "./binding.js";
import { WSTETH_FAMILY_ID, WSTETH_LINEAGE_ID } from "./manifest.js";
import type { WstethDescriptor, WstethRoute } from "./types.js";

export const wstethRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(
      wstethStaticBindingProjection(descriptor),
    );
    const make = (
      direction: WstethRoute["direction"],
      tokenIn: string,
      tokenOut: string,
      adapterId: WstethRoute["adapterId"],
    ): WstethRoute => Object.freeze({
      routeKey: routeKey([
        WSTETH_FAMILY_ID,
        lowerAddress(descriptor.target),
        direction,
      ].join("\u001f")),
      familyId: WSTETH_FAMILY_ID,
      lineageId: WSTETH_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn,
      tokenOut,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: direction,
      }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.target),
        fingerprint,
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.target,
      direction,
      adapterId,
    });
    return Object.freeze([
      make("wrap", descriptor.steth, descriptor.wsteth, "wsteth-wrap"),
      make("unwrap", descriptor.wsteth, descriptor.steth, "wsteth-unwrap"),
    ]);
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
} satisfies RouteProjectionSemantics<WstethDescriptor, WstethRoute>;

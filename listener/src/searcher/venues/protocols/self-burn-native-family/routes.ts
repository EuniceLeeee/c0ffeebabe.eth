import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import {
  SELF_BURN_NATIVE_FAMILY_ID,
  SELF_BURN_NATIVE_LINEAGE_ID,
} from "./manifest.js";
import { selfBurnNativeStaticProjection } from "./shared.js";
import type {
  SelfBurnNativeDescriptor,
  SelfBurnNativeRoute,
} from "./types.js";

export const selfBurnNativeRoutes = {
  project({ descriptor }) {
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${SELF_BURN_NATIVE_FAMILY_ID}\u001f${lowerAddress(descriptor.token)}`,
      ),
      familyId: SELF_BURN_NATIVE_FAMILY_ID,
      lineageId: SELF_BURN_NATIVE_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.token,
      tokenOut: descriptor.nativeAnchor,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "redeem" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.token),
        fingerprint: hashCanonical(selfBurnNativeStaticProjection(descriptor)),
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.token,
      direction: "self-burn-to-native" as const,
      adapterId: "self-burn-native-redeem" as const,
    })]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.token,
      venueIdentity: Object.freeze({
        kind: "address-protocol",
        target: lowerAddress(descriptor.token),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<
  SelfBurnNativeDescriptor,
  SelfBurnNativeRoute
>;

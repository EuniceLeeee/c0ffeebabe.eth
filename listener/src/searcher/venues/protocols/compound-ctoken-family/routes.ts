import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { lowerAddress } from "../standard-family/common.js";
import {
  compoundCTokenBindingFingerprint,
  lower,
} from "./codec.js";
import {
  CTOKEN_FAMILY_ID,
  CTOKEN_LINEAGE_ID,
  CTOKEN_REDEEM_ACTION,
} from "./manifest.js";
import type {
  CompoundCTokenDescriptor,
  CompoundCTokenRoute,
} from "./types.js";

/**
 * Exactly one routed direction: cToken shares in, market underlying out.
 * `redeemUnderlying` is intentionally absent — see manifest.ts.
 */
export const compoundCTokenRoutes: RouteProjectionSemantics<
  CompoundCTokenDescriptor,
  CompoundCTokenRoute
> = {
  project({ descriptor }) {
    if (descriptor.redemptionPathVerified !== true) return Object.freeze([]);
    const route = Object.freeze({
      routeKey: routeKey(
        `${CTOKEN_FAMILY_ID}\u001f${lower(descriptor.market)}\u001fredeem`,
      ),
      familyId: CTOKEN_FAMILY_ID,
      lineageId: CTOKEN_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.share,
      tokenOut: descriptor.underlying,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "redeem" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: lower(descriptor.market),
        fingerprint: compoundCTokenBindingFingerprint(descriptor),
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.market,
      direction: "redeem" as const,
      adapterId: CTOKEN_REDEEM_ACTION,
    }) satisfies CompoundCTokenRoute;
    return Object.freeze([route]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.market,
      venueIdentity: Object.freeze({
        kind: "address-protocol",
        target: lowerAddress(descriptor.market),
      }),
      centralScoreKey: route.routeKey,
    });
  },
};

import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { lowerAddress } from "../standard-family/common.js";
import {
  lower,
  yieldBasisLtBindingFingerprint,
} from "./codec.js";
import {
  YIELDBASIS_FAMILY_ID,
  YIELDBASIS_LINEAGE_ID,
  YIELDBASIS_WITHDRAW_ACTION,
} from "./manifest.js";
import type {
  YieldBasisLtDescriptor,
  YieldBasisLtRoute,
} from "./types.js";

/**
 * Exactly one routed direction: LT shares in, `ASSET_TOKEN()` out, executed by
 * `withdraw(uint256 shares, uint256 min_assets)`.
 *
 * `deposit` is not implemented yet. Its crypto input comes from the caller,
 * while its stablecoin input comes from the protocol AMM; the latter is not
 * a reason to classify deposit as requiring two caller-funded assets.
 * `emergency_withdraw` has two outputs with a signed stablecoin leg and is a
 * different, unsupported semantic. Neither unimplemented direction is projected.
 */
export const yieldBasisLtRoutes: RouteProjectionSemantics<
  YieldBasisLtDescriptor,
  YieldBasisLtRoute
> = {
  project({ descriptor }) {
    if (descriptor.redemptionPathVerified !== true) return Object.freeze([]);
    const route = Object.freeze({
      routeKey: routeKey(
        `${YIELDBASIS_FAMILY_ID}\u001f${lower(descriptor.lt)}\u001fwithdraw`,
      ),
      familyId: YIELDBASIS_FAMILY_ID,
      lineageId: YIELDBASIS_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.share,
      tokenOut: descriptor.asset,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "redeem" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: lower(descriptor.lt),
        fingerprint: yieldBasisLtBindingFingerprint(descriptor),
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.lt,
      direction: "withdraw" as const,
      adapterId: YIELDBASIS_WITHDRAW_ACTION,
    }) satisfies YieldBasisLtRoute;
    return Object.freeze([route]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.lt,
      venueIdentity: Object.freeze({
        kind: "address-protocol",
        target: lowerAddress(descriptor.lt),
      }),
      centralScoreKey: route.routeKey,
    });
  },
};

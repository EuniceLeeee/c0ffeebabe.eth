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
  YIELDBASIS_DEPOSIT_ACTION,
} from "./manifest.js";
import type {
  YieldBasisLtDescriptor,
  YieldBasisLtRoute,
} from "./types.js";

/**
 * Withdrawal is retained. Ordinary deposit is projected only with its own
 * actual-mint proof; its stablecoin comes from the protocol AMM, not caller.
 * `emergency_withdraw` has two outputs with a signed stablecoin leg and is a
 * different, unsupported semantic and is never projected.
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
    if (descriptor.depositPathVerified !== true) return Object.freeze([route]);
    const deposit = Object.freeze({ ...route,
      routeKey: routeKey(`${YIELDBASIS_FAMILY_ID}\u001f${lower(descriptor.lt)}\u001fdeposit`),
      tokenIn: descriptor.asset, tokenOut: descriptor.share,
      taxonomy: Object.freeze({ slotKind: "protocol" as const, protocolAction: "wrap" as const }),
      direction: "deposit" as const, adapterId: YIELDBASIS_DEPOSIT_ACTION,
    }) satisfies YieldBasisLtRoute;
    return Object.freeze([route, deposit]);
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

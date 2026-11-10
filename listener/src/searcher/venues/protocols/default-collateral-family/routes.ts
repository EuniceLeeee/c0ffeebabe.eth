import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import {
  assertDefaultCollateralInvocation,
  defaultCollateralStaticBindingProjection,
} from "./binding.js";
import {
  DEFAULT_COLLATERAL_ACTION_ID,
  DEFAULT_COLLATERAL_FAMILY_ID,
  DEFAULT_COLLATERAL_LINEAGE_ID,
} from "./manifest.js";
import type {
  DefaultCollateralDescriptor,
  DefaultCollateralRoute,
} from "./types.js";

const key = (descriptor: DefaultCollateralDescriptor) =>
  `${DEFAULT_COLLATERAL_FAMILY_ID}\u001f${lowerAddress(descriptor.vault)}` +
  `\u001fdefault-collateral:redeem`;

/**
 * One proven direction: shares (the vault itself) -> the vault asset. The
 * verified implementation exposes no deposit()/mint() ABI, so the deposit
 * direction is intentionally not projected here.
 */
export const defaultCollateralRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(
      defaultCollateralStaticBindingProjection(descriptor),
    );
    return Object.freeze([Object.freeze({
      routeKey: routeKey(key(descriptor)),
      familyId: DEFAULT_COLLATERAL_FAMILY_ID,
      lineageId: DEFAULT_COLLATERAL_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.share,
      tokenOut: descriptor.asset,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "convert" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.vault),
        fingerprint,
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.vault,
      adapterId: DEFAULT_COLLATERAL_ACTION_ID as "default-collateral-withdraw",
    })]);
  },
  projectGraph({ descriptor, route }) {
    assertDefaultCollateralInvocation(descriptor, route);
    return Object.freeze({
      routeActionAdapterId: DEFAULT_COLLATERAL_ACTION_ID,
      executionTarget: descriptor.vault,
      venueIdentity: Object.freeze({
        kind: "address-protocol",
        target: lowerAddress(descriptor.vault),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<
  DefaultCollateralDescriptor,
  DefaultCollateralRoute
>;

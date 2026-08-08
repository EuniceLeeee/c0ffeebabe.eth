import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import {
  ERC4626_SILO_REDEEM_FAMILY_ID,
  ERC4626_SILO_REDEEM_LINEAGE_ID,
} from "./manifest.js";
import { erc4626SiloStaticProjection } from "./shared.js";
import type {
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemRoute,
} from "./types.js";

export const erc4626SiloRedeemRoutes = {
  project({ descriptor }) {
    return Object.freeze([Object.freeze({
      routeKey: routeKey([
        ERC4626_SILO_REDEEM_FAMILY_ID,
        lowerAddress(descriptor.vault),
        lowerAddress(descriptor.payoutToken),
      ].join("\u001f")),
      familyId: ERC4626_SILO_REDEEM_FAMILY_ID,
      lineageId: ERC4626_SILO_REDEEM_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.vault,
      tokenOut: descriptor.payoutToken,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "redeem" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey:
          `${lowerAddress(descriptor.vault)}:${lowerAddress(descriptor.payoutToken)}`,
        fingerprint: hashCanonical(erc4626SiloStaticProjection(descriptor)),
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.vault,
      direction: "silo-redeem" as const,
      adapterId: "erc4626-redeem-silo" as const,
    })]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.vault,
      venueIdentity: Object.freeze({
        kind: "address-subinstance",
        target: lowerAddress(descriptor.vault),
        payoutToken: lowerAddress(descriptor.payoutToken),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemRoute
>;

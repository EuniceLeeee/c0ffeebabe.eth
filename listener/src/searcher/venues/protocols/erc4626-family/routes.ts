import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { erc4626StaticProjection } from "./binding.js";
import {
  ERC4626_FAMILY_ID,
  ERC4626_LINEAGE_ID,
} from "./manifest.js";
import type { Erc4626Descriptor, Erc4626Route } from "./types.js";

export const erc4626Routes: RouteProjectionSemantics<
  Erc4626Descriptor,
  Erc4626Route
> = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(erc4626StaticProjection(descriptor));
    const routes: Erc4626Route[] = [];
    if (descriptor.verifiedDirections.deposit) {
      routes.push(makeRoute(descriptor, "deposit", fingerprint));
    }
    if (descriptor.verifiedDirections.redeem) {
      routes.push(makeRoute(descriptor, "redeem", fingerprint));
    }
    return Object.freeze(routes);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.vault,
      venueIdentity: Object.freeze({
        kind: "address-protocol",
        target: lowerAddress(descriptor.vault),
      }),
      centralScoreKey: route.routeKey,
    });
  },
};

function makeRoute(
  descriptor: Erc4626Descriptor,
  direction: Erc4626Route["direction"],
  fingerprint: string,
): Erc4626Route {
  const deposit = direction === "deposit";
  return Object.freeze({
    routeKey: routeKey(
      `${ERC4626_FAMILY_ID}\u001f${lowerAddress(descriptor.vault)}\u001f${direction}`,
    ),
    familyId: ERC4626_FAMILY_ID,
    lineageId: ERC4626_LINEAGE_ID,
    instanceKey: descriptor.instanceKey,
    tokenIn: deposit ? descriptor.asset : descriptor.share,
    tokenOut: deposit ? descriptor.share : descriptor.asset,
    taxonomy: Object.freeze({
      slotKind: "protocol" as const,
      protocolAction: deposit ? "wrap" as const : "redeem" as const,
    }),
    bindingRef: Object.freeze({
      bindingKey: lowerAddress(descriptor.vault),
      fingerprint,
    }),
    runtimeRequirements: descriptor.runtimeRequirements,
    target: descriptor.vault,
    direction,
    adapterId: deposit ? "erc4626-deposit" : "erc4626-redeem",
  });
}

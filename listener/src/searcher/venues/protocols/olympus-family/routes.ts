import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { olympusStaticBindingProjection } from "./binding.js";
import { OLYMPUS_FAMILY_ID, OLYMPUS_LINEAGE_ID } from "./manifest.js";
import type { OlympusDescriptor, OlympusRoute } from "./types.js";

export const olympusRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(
      olympusStaticBindingProjection(descriptor),
    );
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${OLYMPUS_FAMILY_ID}\u001f${lowerAddress(descriptor.staking)}\u001funstake`,
      ),
      familyId: OLYMPUS_FAMILY_ID,
      lineageId: OLYMPUS_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.gOHM,
      tokenOut: descriptor.OHM,
      executionAssets: Object.freeze({
        input: "erc20" as const,
        output: "erc20" as const,
      }),
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "convert" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.staking),
        fingerprint,
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.staking,
      direction: "unstake" as const,
      adapterId: "olympus-unstake" as const,
    })]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.staking,
      venueIdentity: Object.freeze({
        kind: "address-protocol" as const,
        target: lowerAddress(descriptor.staking),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<OlympusDescriptor, OlympusRoute>;

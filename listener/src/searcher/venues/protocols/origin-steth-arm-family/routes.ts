import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { originStethArmStaticBindingProjection } from "./binding.js";
import {
  ORIGIN_STETH_ARM_DIRECTIONS,
  originStethArmTokenIn,
  originStethArmTokenOut,
} from "./codec.js";
import {
  ORIGIN_STETH_ARM_ACTION_ID,
  ORIGIN_STETH_ARM_FAMILY_ID,
  ORIGIN_STETH_ARM_LINEAGE_ID,
} from "./manifest.js";
import type {
  OriginStethArmDescriptor,
  OriginStethArmRoute,
} from "./types.js";

export const originStethArmRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(
      originStethArmStaticBindingProjection(descriptor),
    );
    return Object.freeze(ORIGIN_STETH_ARM_DIRECTIONS.map((direction) =>
      Object.freeze({
        routeKey: routeKey(
          `${ORIGIN_STETH_ARM_FAMILY_ID}\u001f${lowerAddress(descriptor.target)}\u001f${direction}`,
        ),
        familyId: ORIGIN_STETH_ARM_FAMILY_ID,
        lineageId: ORIGIN_STETH_ARM_LINEAGE_ID,
        instanceKey: descriptor.instanceKey,
        tokenIn: originStethArmTokenIn(direction),
        tokenOut: originStethArmTokenOut(direction),
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
        direction,
        adapterId: ORIGIN_STETH_ARM_ACTION_ID as "origin-steth-arm-swap",
      })
    ));
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
} satisfies RouteProjectionSemantics<OriginStethArmDescriptor, OriginStethArmRoute>;

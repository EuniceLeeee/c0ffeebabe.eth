import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import {
  ETHERTOKEN_NATIVE_FAMILY_ID,
  ETHERTOKEN_NATIVE_LINEAGE_ID,
} from "./manifest.js";
import { etherTokenNativeStaticProjection } from "./shared.js";
import type {
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemRoute,
} from "./types.js";

export const etherTokenNativeRedeemRoutes = {
  project({ descriptor }) {
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${ETHERTOKEN_NATIVE_FAMILY_ID}\u001f${lowerAddress(descriptor.token)}`,
      ),
      familyId: ETHERTOKEN_NATIVE_FAMILY_ID,
      lineageId: ETHERTOKEN_NATIVE_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.token,
      tokenOut: descriptor.nativeAnchor,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "redeem" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.token),
        fingerprint: hashCanonical(
          etherTokenNativeStaticProjection(descriptor),
        ),
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.token,
      direction: "withdraw-to-native" as const,
      adapterId: "ethertoken-native-redeem" as const,
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
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemRoute
>;

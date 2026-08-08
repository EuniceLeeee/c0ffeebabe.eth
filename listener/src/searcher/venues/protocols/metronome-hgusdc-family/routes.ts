import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import {
  METRONOME_HGUSDC_FAMILY_ID,
  METRONOME_HGUSDC_LINEAGE_ID,
} from "./manifest.js";
import { metronomeHgUsdcStaticProjection } from "./shared.js";
import type {
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcRoute,
} from "./types.js";

export const metronomeHgUsdcRoutes = {
  project({ descriptor }) {
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${METRONOME_HGUSDC_FAMILY_ID}\u001f${lowerAddress(descriptor.router)}`,
      ),
      familyId: METRONOME_HGUSDC_FAMILY_ID,
      lineageId: METRONOME_HGUSDC_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.tokenIn,
      tokenOut: descriptor.tokenOut,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "redeem" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.router),
        fingerprint: hashCanonical(
          metronomeHgUsdcStaticProjection(descriptor),
        ),
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.router,
      adapterId: "metronome-hgusdc-exit" as const,
      direction: "msusd-to-usdc" as const,
    })]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.router,
      venueIdentity: Object.freeze({
        kind: "address-path-protocol",
        target: lowerAddress(descriptor.router),
        pathHash: descriptor.pathHash.toLowerCase(),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcRoute
>;

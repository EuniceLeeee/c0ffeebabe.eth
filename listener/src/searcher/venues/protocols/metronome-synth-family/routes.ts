import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import {
  METRONOME_SYNTH_FAMILY_ID,
  METRONOME_SYNTH_LINEAGE_ID,
} from "./manifest.js";
import { metronomeSynthStaticProjection } from "./shared.js";
import type {
  MetronomeSynthDescriptor,
  MetronomeSynthRoute,
} from "./types.js";

export const metronomeSynthRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(
      metronomeSynthStaticProjection(descriptor),
    );
    return Object.freeze(descriptor.directions.map((direction) =>
      Object.freeze({
        routeKey: routeKey([
          METRONOME_SYNTH_FAMILY_ID,
          lowerAddress(descriptor.pool),
          lowerAddress(direction.tokenIn),
          lowerAddress(direction.tokenOut),
        ].join("\u001f")),
        familyId: METRONOME_SYNTH_FAMILY_ID,
        lineageId: METRONOME_SYNTH_LINEAGE_ID,
        instanceKey: descriptor.instanceKey,
        tokenIn: direction.tokenIn,
        tokenOut: direction.tokenOut,
        taxonomy: Object.freeze({
          slotKind: "protocol" as const,
          protocolAction: "convert" as const,
        }),
        bindingRef: Object.freeze({
          bindingKey: lowerAddress(descriptor.pool),
          fingerprint,
        }),
        runtimeRequirements: descriptor.runtimeRequirements,
        target: descriptor.pool,
        adapterId: "metronome-synth-swap" as const,
      })
    ));
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.pool,
      venueIdentity: Object.freeze({
        kind: "address-protocol",
        target: lowerAddress(descriptor.pool),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<
  MetronomeSynthDescriptor,
  MetronomeSynthRoute
>;

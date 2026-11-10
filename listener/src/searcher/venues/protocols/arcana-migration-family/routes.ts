import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { arcanaStaticProjection } from "./shared.js";
import type { ArcanaDescriptor, ArcanaRoute } from "./types.js";

export const arcanaMigrationRoutes = {
  project({ descriptor }) {
    return Object.freeze([Object.freeze({
      routeKey: routeKey(`${FAMILY}\u001f${lowerAddress(descriptor.source)}\u001f${descriptor.tokenId}`),
      familyId: FAMILY,
      lineageId: LINEAGE,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.oldToken,
      tokenOut: descriptor.arcToken,
      executionAssets: Object.freeze({ input: "erc20" as const, output: "erc20" as const }),
      taxonomy: Object.freeze({ slotKind: "protocol" as const, protocolAction: "convert" as const }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.source),
        fingerprint: hashCanonical(arcanaStaticProjection(descriptor)),
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.source,
      direction: "migrate-to-arc" as const,
      adapterId: "arcana-migration" as const,
    })]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.source,
      venueIdentity: Object.freeze({
        kind: "address-protocol" as const,
        target: lowerAddress(descriptor.source),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<ArcanaDescriptor, ArcanaRoute>;

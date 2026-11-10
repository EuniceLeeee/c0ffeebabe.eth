import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import {
  assertMetafactoryInvocation,
  metafactoryStaticProjection,
} from "./binding.js";
import {
  METAFACTORY_FAMILY_ID,
  METAFACTORY_LINEAGE_ID,
} from "./manifest.js";
import type {
  MetafactoryDescriptor,
  MetafactoryRoute,
} from "./types.js";

export const metafactoryRoutes = {
  project({ descriptor }: { readonly descriptor: MetafactoryDescriptor }) {
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${METAFACTORY_FAMILY_ID}\u001f${lowerAddress(descriptor.target)}` +
        "\u001fcompost-redeem",
      ),
      familyId: METAFACTORY_FAMILY_ID,
      lineageId: METAFACTORY_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.tokenIn,
      // Native ETH settles to the caller; WETH is only the graph denomination
      // of that raw asset and the shared boundary performs the wrap.
      tokenOut: descriptor.nativeAnchor,
      executionAssets: Object.freeze({
        input: "erc20" as const,
        output: "native" as const,
      }),
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "convert" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.target),
        fingerprint: hashCanonical(metafactoryStaticProjection(descriptor)),
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.target,
      direction: "compost-redeem" as const,
      adapterId: "metafactory-compost-redeem" as const,
    })]);
  },
  projectGraph({ descriptor, route }: {
    readonly descriptor: MetafactoryDescriptor;
    readonly route: MetafactoryRoute;
  }) {
    assertMetafactoryInvocation(descriptor, route);
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
} satisfies RouteProjectionSemantics<MetafactoryDescriptor, MetafactoryRoute>;

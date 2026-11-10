import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { boringStaticProjection } from "./instance.js";
import type { BoringDescriptor, BoringRoute } from "./types.js";

export const boringRoutes = {
  project({ descriptor }: { readonly descriptor: BoringDescriptor }) {
    return Object.freeze([Object.freeze({
      routeKey: routeKey(`${FAMILY}\u001f${lowerAddress(descriptor.teller)}\u001f${lowerAddress(descriptor.asset)}`),
      familyId: FAMILY,
      lineageId: LINEAGE,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.vault,
      tokenOut: descriptor.asset,
      executionAssets: Object.freeze({ input: "erc20" as const, output: "erc20" as const }),
      taxonomy: Object.freeze({ slotKind: "protocol" as const, protocolAction: "redeem" as const }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.teller),
        fingerprint: hashCanonical(boringStaticProjection(descriptor)),
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.teller,
      direction: "withdraw" as const,
      adapterId: "boring-vault-withdraw" as const,
    })]);
  },
  projectGraph({ descriptor, route }: { readonly descriptor: BoringDescriptor; readonly route: BoringRoute }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.teller,
      venueIdentity: Object.freeze({ kind: "address-protocol" as const, target: lowerAddress(descriptor.teller) }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<BoringDescriptor, BoringRoute>;

import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "./codec.js";
import { fluidCreditStaticBindingProjection } from "./instance.js";
import type { FluidCreditDescriptor, FluidCreditRoute } from "./types.js";

export const fluidCreditRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(
      fluidCreditStaticBindingProjection(descriptor),
    );
    return Object.freeze([Object.freeze({
      routeKey: routeKey([
        descriptor.familyId,
        lowerAddress(descriptor.vault),
        lowerAddress(descriptor.supplyToken),
        lowerAddress(descriptor.borrowToken),
        "standing-position",
      ].join("\u001f")),
      familyId: descriptor.familyId,
      lineageId: descriptor.lineageId,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.supplyToken,
      tokenOut: descriptor.borrowToken,
      taxonomy: Object.freeze({ slotKind: "lend" as const }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.vault),
        fingerprint,
      }),
      runtimeRequirements: Object.freeze([...descriptor.runtimeRequirements]),
      vault: descriptor.vault,
      lifecycle: "standing-position" as const,
    })]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: "fluid-vault",
      executionTarget: descriptor.vault,
      venueIdentity: Object.freeze({
        kind: "address-credit-vault",
        target: lowerAddress(descriptor.vault),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<FluidCreditDescriptor, FluidCreditRoute>;

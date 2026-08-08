import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "./codec.js";
import { staticBindingProjection } from "./instance.js";
import type { DodoV2Descriptor, DodoV2Route } from "./types.js";

export const dodoV2Routes = {
  project({ descriptor }) {
    const bindingFingerprint = hashCanonical(staticBindingProjection(descriptor));
    return Object.freeze([
      route(descriptor, "sell-base", bindingFingerprint),
      route(descriptor, "sell-quote", bindingFingerprint),
    ]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: "dodo-v2-swap",
      executionTarget: descriptor.pool,
      venueIdentity: Object.freeze({
        kind: "address-pool",
        pool: lowerAddress(descriptor.pool),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<DodoV2Descriptor, DodoV2Route>;

function route(
  descriptor: DodoV2Descriptor,
  direction: DodoV2Route["direction"],
  bindingFingerprint: string,
): DodoV2Route {
  const sellBase = direction === "sell-base";
  const tokenIn = sellBase ? descriptor.baseToken : descriptor.quoteToken;
  const tokenOut = sellBase ? descriptor.quoteToken : descriptor.baseToken;
  return Object.freeze({
    routeKey: routeKey([
      descriptor.familyId,
      lowerAddress(descriptor.pool),
      lowerAddress(tokenIn),
      lowerAddress(tokenOut),
    ].join("\u001f")),
    familyId: descriptor.familyId,
    lineageId: descriptor.lineageId,
    instanceKey: descriptor.instanceKey,
    tokenIn,
    tokenOut,
    taxonomy: Object.freeze({ slotKind: "swap" as const }),
    bindingRef: Object.freeze({
      bindingKey: lowerAddress(descriptor.pool),
      fingerprint: bindingFingerprint,
    }),
    runtimeRequirements: Object.freeze([...descriptor.runtimeRequirements]),
    pool: descriptor.pool,
    direction,
  });
}

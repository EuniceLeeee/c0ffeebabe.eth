import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { uniV3StaticBindingProjection } from "./binding.js";
import { lowerAddress } from "./codec.js";
import type { UniV3Descriptor, UniV3Route } from "./types.js";

export const univ3Routes = {
  project({ descriptor }) {
    const bindingFingerprint = hashCanonical(
      uniV3StaticBindingProjection(descriptor),
    );
    return Object.freeze([
      route(descriptor, "zero-for-one", bindingFingerprint),
      route(descriptor, "one-for-zero", bindingFingerprint),
    ]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: "univ3-swap",
      executionTarget: descriptor.pool,
      venueIdentity: Object.freeze({
        kind: "address-pool",
        pool: lowerAddress(descriptor.pool),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<UniV3Descriptor, UniV3Route>;

function route(
  descriptor: UniV3Descriptor,
  direction: UniV3Route["direction"],
  bindingFingerprint: string,
): UniV3Route {
  const zeroForOne = direction === "zero-for-one";
  const tokenIn = zeroForOne ? descriptor.token0 : descriptor.token1;
  const tokenOut = zeroForOne ? descriptor.token1 : descriptor.token0;
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
    runtimeRequirements: Object.freeze([]),
    pool: descriptor.pool,
    direction,
    fee: descriptor.fee,
    tickSpacing: descriptor.tickSpacing,
  });
}

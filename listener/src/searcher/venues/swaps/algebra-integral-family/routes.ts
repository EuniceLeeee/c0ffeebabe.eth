import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { ALGEBRA_INTEGRAL_ADAPTER_ID } from "./abi.js";
import { lowerAddress } from "./codec.js";
import { staticBindingProjection } from "./instance.js";
import type {
  AlgebraIntegralDescriptor,
  AlgebraIntegralDirection,
  AlgebraIntegralRoute,
} from "./types.js";

export const algebraIntegralRoutes = {
  project({ descriptor }) {
    const bindingFingerprint = hashCanonical(staticBindingProjection(descriptor));
    return Object.freeze([
      route(descriptor, "zero-for-one", bindingFingerprint),
      route(descriptor, "one-for-zero", bindingFingerprint),
    ]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: ALGEBRA_INTEGRAL_ADAPTER_ID,
      executionTarget: descriptor.pool,
      venueIdentity: Object.freeze({
        kind: "address-pool",
        pool: lowerAddress(descriptor.pool),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<AlgebraIntegralDescriptor, AlgebraIntegralRoute>;

function route(
  descriptor: AlgebraIntegralDescriptor,
  direction: AlgebraIntegralDirection,
  bindingFingerprint: string,
): AlgebraIntegralRoute {
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
    // The executed fee is a per-source pricing fact; this family declares no
    // extra runtime requirement, so a quote is only ever issued with the
    // source-bound reads of its own Exact method.
    runtimeRequirements: Object.freeze([]),
    pool: descriptor.pool,
    direction,
    tickSpacing: descriptor.tickSpacing,
  });
}

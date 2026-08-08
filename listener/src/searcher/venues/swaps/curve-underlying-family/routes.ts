import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "./codec.js";
import { curveUnderlyingStaticBindingProjection } from "./instance.js";
import type {
  CurveUnderlyingDescriptor,
  CurveUnderlyingRoute,
} from "./types.js";

export const curveUnderlyingRoutes = {
  project({ descriptor }) {
    const bindingFingerprint = hashCanonical(
      curveUnderlyingStaticBindingProjection(descriptor),
    );
    return Object.freeze(descriptor.verifiedDirections.map((direction) =>
      Object.freeze({
        routeKey: routeKey([
          descriptor.familyId,
          lowerAddress(descriptor.pool),
          direction.i,
          direction.j,
          lowerAddress(direction.tokenIn),
          lowerAddress(direction.tokenOut),
          "underlying",
        ].join("\u001f")),
        familyId: descriptor.familyId,
        lineageId: descriptor.lineageId,
        instanceKey: descriptor.instanceKey,
        tokenIn: direction.tokenIn,
        tokenOut: direction.tokenOut,
        taxonomy: Object.freeze({ slotKind: "swap" as const }),
        bindingRef: Object.freeze({
          bindingKey: `${lowerAddress(descriptor.pool)}:${direction.i}:${direction.j}`,
          fingerprint: bindingFingerprint,
        }),
        runtimeRequirements: Object.freeze([...descriptor.runtimeRequirements]),
        pool: descriptor.pool,
        i: direction.i,
        j: direction.j,
        semantics: "exchange_underlying(i,j,dx,minDy)" as const,
      })
    ));
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: "curve-exchange-underlying",
      executionTarget: descriptor.pool,
      venueIdentity: Object.freeze({
        kind: "address-pool",
        pool: lowerAddress(descriptor.pool),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<
  CurveUnderlyingDescriptor,
  CurveUnderlyingRoute
>;

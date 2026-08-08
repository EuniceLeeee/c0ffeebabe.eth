import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { uniV4StaticBindingProjection } from "./binding.js";
import type { UniV4Descriptor, UniV4Route } from "./types.js";

export const univ4Routes = {
  project({ descriptor }) {
    const bindingFingerprint = hashCanonical(
      uniV4StaticBindingProjection(descriptor),
    );
    return Object.freeze([
      route(descriptor, "zero-for-one", bindingFingerprint),
      route(descriptor, "one-for-zero", bindingFingerprint),
    ]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: "univ4-unlock",
      executionTarget: descriptor.managerBinding.manager,
      venueIdentity: Object.freeze({
        kind: "manager-pool-id",
        manager: descriptor.managerBinding.manager.toLowerCase(),
        poolId: descriptor.poolId.toLowerCase(),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<UniV4Descriptor, UniV4Route>;

function route(
  descriptor: UniV4Descriptor,
  direction: UniV4Route["direction"],
  bindingFingerprint: string,
): UniV4Route {
  const zeroForOne = direction === "zero-for-one";
  const tokenIn = zeroForOne ? descriptor.graphToken0 : descriptor.graphToken1;
  const tokenOut = zeroForOne ? descriptor.graphToken1 : descriptor.graphToken0;
  const realTokenIn = zeroForOne
    ? descriptor.poolKey.currency0
    : descriptor.poolKey.currency1;
  const realTokenOut = zeroForOne
    ? descriptor.poolKey.currency1
    : descriptor.poolKey.currency0;
  return Object.freeze({
    routeKey: routeKey([
      descriptor.familyId,
      descriptor.managerBinding.manager.toLowerCase(),
      descriptor.poolId,
      tokenIn.toLowerCase(),
      tokenOut.toLowerCase(),
    ].join("\u001f")),
    familyId: descriptor.familyId,
    lineageId: descriptor.lineageId,
    instanceKey: descriptor.instanceKey,
    tokenIn,
    tokenOut,
    taxonomy: Object.freeze({ slotKind: "swap" as const }),
    bindingRef: Object.freeze({
      bindingKey: descriptor.poolId,
      fingerprint: bindingFingerprint,
    }),
    runtimeRequirements: descriptor.runtimeRequirements,
    poolId: descriptor.poolId,
    poolKey: descriptor.poolKey,
    manager: descriptor.managerBinding.manager,
    direction,
    realTokenIn,
    realTokenOut,
  });
}

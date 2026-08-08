import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { angstromV4StaticBindingProjection } from "./binding.js";
import type {
  AngstromV4Descriptor,
  AngstromV4Route,
} from "./types.js";

export const angstromV4Routes = {
  project({ descriptor }) {
    const bindingFingerprint = hashCanonical(
      angstromV4StaticBindingProjection(descriptor),
    );
    return Object.freeze([
      route(descriptor, "zero-for-one", bindingFingerprint),
      route(descriptor, "one-for-zero", bindingFingerprint),
    ]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: "angstrom-v4-swap",
      executionTarget: descriptor.immutableBinding.adapter,
      venueIdentity: Object.freeze({
        kind: "manager-pool-id",
        manager: descriptor.immutableBinding.manager.toLowerCase(),
        poolId: descriptor.poolId.toLowerCase(),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<AngstromV4Descriptor, AngstromV4Route>;

function route(
  descriptor: AngstromV4Descriptor,
  direction: AngstromV4Route["direction"],
  bindingFingerprint: string,
): AngstromV4Route {
  const zeroForOne = direction === "zero-for-one";
  const tokenIn = zeroForOne
    ? descriptor.poolKey.currency0
    : descriptor.poolKey.currency1;
  const tokenOut = zeroForOne
    ? descriptor.poolKey.currency1
    : descriptor.poolKey.currency0;
  return Object.freeze({
    routeKey: routeKey([
      descriptor.familyId,
      descriptor.immutableBinding.manager.toLowerCase(),
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
    manager: descriptor.immutableBinding.manager,
    poolId: descriptor.poolId,
    poolKey: descriptor.poolKey,
    direction,
  });
}

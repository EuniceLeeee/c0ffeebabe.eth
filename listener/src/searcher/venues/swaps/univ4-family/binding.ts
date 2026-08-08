import type { CanonicalValue } from "../../canonical-value.js";
import { poolKeyProjection } from "./codec.js";
import type { UniV4Descriptor, UniV4Route } from "./types.js";

export function uniV4StaticBindingProjection(
  descriptor: UniV4Descriptor,
): CanonicalValue {
  return {
    poolId: descriptor.poolId,
    poolKey: poolKeyProjection(descriptor.poolKey),
    managerBinding: {
      manager: descriptor.managerBinding.manager,
      stateView: descriptor.managerBinding.stateView,
      quoter: descriptor.managerBinding.quoter,
      managerCodeHash: descriptor.managerBinding.managerCodeHash,
    },
    hookPolicy: descriptor.hookPolicy,
  };
}

export function uniV4SnapshotCompatibilityProjection(input: {
  readonly descriptor: UniV4Descriptor;
  readonly routes: readonly UniV4Route[];
}): CanonicalValue {
  return {
    poolId: input.descriptor.poolId,
    poolKey: poolKeyProjection(input.descriptor.poolKey),
    stateView: input.descriptor.managerBinding.stateView,
    quoter: input.descriptor.managerBinding.quoter,
    directions: input.routes
      .map((route) => [route.tokenIn, route.tokenOut] as const)
      .sort(([leftIn, leftOut], [rightIn, rightOut]) =>
        `${leftIn}:${leftOut}`.localeCompare(`${rightIn}:${rightOut}`)
      ),
  };
}

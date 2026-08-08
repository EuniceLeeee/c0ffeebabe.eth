import type { CanonicalValue } from "../../canonical-value.js";
import { poolKeyProjection } from "./codec.js";
import type {
  AngstromV4Descriptor,
  AngstromV4Route,
} from "./types.js";

export function angstromV4StaticBindingProjection(
  descriptor: AngstromV4Descriptor,
): CanonicalValue {
  return {
    poolId: descriptor.poolId,
    poolKey: poolKeyProjection(descriptor.poolKey),
    immutableBinding: { ...descriptor.immutableBinding },
  };
}

export function angstromV4SnapshotCompatibilityProjection(input: {
  readonly descriptor: AngstromV4Descriptor;
  readonly routes: readonly AngstromV4Route[];
}): CanonicalValue {
  return {
    poolId: input.descriptor.poolId,
    poolKey: poolKeyProjection(input.descriptor.poolKey),
    immutableBinding: { ...input.descriptor.immutableBinding },
    directions: input.routes
      .map((route) => [route.tokenIn, route.tokenOut] as const)
      .sort(([leftIn, leftOut], [rightIn, rightOut]) =>
        `${leftIn}:${leftOut}`.localeCompare(`${rightIn}:${rightOut}`)
      ),
  };
}

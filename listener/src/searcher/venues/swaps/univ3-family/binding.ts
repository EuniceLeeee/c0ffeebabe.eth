import type { CanonicalValue } from "../../canonical-value.js";
import type { UniV3Descriptor, UniV3Route } from "./types.js";

export function uniV3StaticBindingProjection(
  descriptor: UniV3Descriptor,
): CanonicalValue {
  return {
    pool: descriptor.pool,
    token0: descriptor.token0,
    token1: descriptor.token1,
    fee: descriptor.fee,
    tickSpacing: descriptor.tickSpacing,
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      reversePool: descriptor.factoryBinding.reversePool,
    },
    quoterBinding: {
      quoter: descriptor.quoterBinding.quoter,
      router: descriptor.quoterBinding.router,
      provenance: descriptor.quoterBinding.provenance,
    },
  };
}

export function uniV3SnapshotCompatibilityProjection(input: {
  readonly descriptor: UniV3Descriptor;
  readonly routes: readonly UniV3Route[];
}): CanonicalValue {
  return {
    pool: input.descriptor.pool,
    fee: input.descriptor.fee,
    quoterBinding: {
      quoter: input.descriptor.quoterBinding.quoter,
      provenance: input.descriptor.quoterBinding.provenance,
    },
    directions: input.routes
      .map((route) => [route.tokenIn, route.tokenOut] as const)
      .sort(([leftIn, leftOut], [rightIn, rightOut]) =>
        `${leftIn}:${leftOut}`.localeCompare(`${rightIn}:${rightOut}`)
      ),
  };
}

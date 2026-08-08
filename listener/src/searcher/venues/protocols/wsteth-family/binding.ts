import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type { WstethDescriptor, WstethRoute } from "./types.js";

export function wstethStaticBindingProjection(
  descriptor: WstethDescriptor,
) {
  return {
    target: lowerAddress(descriptor.target),
    steth: lowerAddress(descriptor.steth),
    wsteth: lowerAddress(descriptor.wsteth),
    conversionSemantics: "lido-wrap-unwrap-v1",
  };
}

export function assertWstethInvocation(
  descriptor: WstethDescriptor,
  route: WstethRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.target,
    route,
    bindingFingerprint: hashCanonical(
      wstethStaticBindingProjection(descriptor),
    ),
  });
  const expected = route.direction === "wrap"
    ? [descriptor.steth, descriptor.wsteth, "wsteth-wrap"] as const
    : [descriptor.wsteth, descriptor.steth, "wsteth-unwrap"] as const;
  if (
    !sameAddress(route.tokenIn, expected[0]) ||
    !sameAddress(route.tokenOut, expected[1]) ||
    route.adapterId !== expected[2]
  ) {
    throw new Error(
      "wstETH route direction is incompatible with its descriptor",
    );
  }
}

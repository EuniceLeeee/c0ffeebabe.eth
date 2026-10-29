import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import {
  ORIGIN_STETH_ARM_DIRECTIONS,
  ORIGIN_STETH_ARM_PRICE_SCALE,
  ORIGIN_STETH_ARM_TRADERATE0_SLOT,
  ORIGIN_STETH_ARM_TRADERATE1_SLOT,
  originStethArmTokenIn,
  originStethArmTokenOut,
} from "./codec.js";
import type {
  OriginStethArmDescriptor,
  OriginStethArmRoute,
} from "./types.js";

export function originStethArmStaticBindingProjection(
  descriptor: OriginStethArmDescriptor,
) {
  return {
    target: lowerAddress(descriptor.target),
    weth: lowerAddress(descriptor.weth),
    steth: lowerAddress(descriptor.steth),
    implementation: lowerAddress(descriptor.implementation),
    proxyCodeHash: descriptor.proxyCodeHash.toLowerCase(),
    implementationCodeHash: descriptor.implementationCodeHash.toLowerCase(),
    stethCodeHash: descriptor.stethCodeHash.toLowerCase(),
    wethCodeHash: descriptor.wethCodeHash.toLowerCase(),
    priceScale: ORIGIN_STETH_ARM_PRICE_SCALE,
    rateModel: "origin-arm-linear-price-v1",
    rateSlots: Object.freeze({
      traderate0: ORIGIN_STETH_ARM_TRADERATE0_SLOT,
      traderate1: ORIGIN_STETH_ARM_TRADERATE1_SLOT,
    }),
  };
}

export function assertOriginStethArmInvocation(
  descriptor: OriginStethArmDescriptor,
  route: OriginStethArmRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.target,
    route,
    bindingFingerprint: hashCanonical(
      originStethArmStaticBindingProjection(descriptor),
    ),
  });
  if (
    route.adapterId !== "origin-steth-arm-swap" ||
    !ORIGIN_STETH_ARM_DIRECTIONS.includes(route.direction) ||
    !sameAddress(route.target, descriptor.target) ||
    !sameAddress(route.tokenIn, originStethArmTokenIn(route.direction)) ||
    !sameAddress(route.tokenOut, originStethArmTokenOut(route.direction)) ||
    sameAddress(descriptor.weth, descriptor.steth)
  ) {
    throw new Error(
      "Origin stETH ARM route is incompatible with its verified descriptor",
    );
  }
}

import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { isFluidDexNative, lowerAddress, sameAddress } from "./codec.js";
import { fluidDexStaticBindingProjection } from "./instance.js";
import type { FluidDexDescriptor, FluidDexRoute } from "./types.js";

export const fluidDexRoutes = {
  project({ descriptor }) {
    if (sameAddress(descriptor.token0, descriptor.token1) ||
        sameAddress(descriptor.rawToken0, descriptor.rawToken1) ||
        (!isFluidDexNative(descriptor.rawToken0) && !sameAddress(descriptor.rawToken0, descriptor.token0)) ||
        (!isFluidDexNative(descriptor.rawToken1) && !sameAddress(descriptor.rawToken1, descriptor.token1))) {
      throw new Error("fluid-dex asset graph mapping conflict");
    }
    const bindingFingerprint = hashCanonical(
      fluidDexStaticBindingProjection(descriptor),
    );
    return Object.freeze([
      route(descriptor, true, bindingFingerprint),
      route(descriptor, false, bindingFingerprint),
    ]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: "fluid-dex-swap",
      executionTarget: descriptor.pool,
      venueIdentity: Object.freeze({
        kind: "address-pool",
        pool: lowerAddress(descriptor.pool),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<FluidDexDescriptor, FluidDexRoute>;

function route(
  descriptor: FluidDexDescriptor,
  swap0To1: boolean,
  bindingFingerprint: string,
): FluidDexRoute {
  const tokenIn = swap0To1 ? descriptor.token0 : descriptor.token1;
  const tokenOut = swap0To1 ? descriptor.token1 : descriptor.token0;
  return Object.freeze({
    routeKey: routeKey([
      descriptor.familyId,
      lowerAddress(descriptor.pool),
      lowerAddress(tokenIn),
      lowerAddress(tokenOut),
      swap0To1 ? "0-1" : "1-0",
    ].join("\u001f")),
    familyId: descriptor.familyId,
    lineageId: descriptor.lineageId,
    instanceKey: descriptor.instanceKey,
    tokenIn,
    tokenOut,
    executionAssets: Object.freeze({
      input: isFluidDexNative(swap0To1 ? descriptor.rawToken0 : descriptor.rawToken1) ? "native" as const : "erc20" as const,
      output: isFluidDexNative(swap0To1 ? descriptor.rawToken1 : descriptor.rawToken0) ? "native" as const : "erc20" as const,
    }),
    taxonomy: Object.freeze({ slotKind: "swap" as const }),
    bindingRef: Object.freeze({
      bindingKey: lowerAddress(descriptor.pool),
      fingerprint: bindingFingerprint,
    }),
    runtimeRequirements: Object.freeze([...descriptor.runtimeRequirements]),
    pool: descriptor.pool,
    swap0To1,
  });
}

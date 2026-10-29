import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { IMPLEMENTATION_CODE_HASH, PROXY_CODE_HASH, address } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION, ID, LINEAGE } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";

const routeId = (descriptor: Descriptor, xForY: boolean) =>
  `${ID}:${descriptor.pair}:${xForY ? "x-y" : "y-x"}`;

export function assertDescriptor(descriptor: Descriptor): void {
  if (descriptor.familyId !== ID || descriptor.lineageId !== LINEAGE ||
      descriptor.proxyCodeHash !== PROXY_CODE_HASH ||
      descriptor.implementationCodeHash !== IMPLEMENTATION_CODE_HASH ||
      descriptor.pair !== address(descriptor.pair) ||
      descriptor.tokenX !== address(descriptor.tokenX) ||
      descriptor.tokenY !== address(descriptor.tokenY) ||
      descriptor.tokenX === descriptor.tokenY ||
      descriptor.instanceKey !== descriptor.pair) {
    throw new Error("ammalgam descriptor mismatch");
  }
}

export function assertRoute(descriptor: Descriptor, route: Route): void {
  assertDescriptor(descriptor);
  const tokenIn = route.xForY ? descriptor.tokenX : descriptor.tokenY;
  const tokenOut = route.xForY ? descriptor.tokenY : descriptor.tokenX;
  if (typeof route.xForY !== "boolean" || route.familyId !== ID || route.lineageId !== LINEAGE ||
      route.pair !== descriptor.pair || route.instanceKey !== descriptor.instanceKey ||
      route.routeKey !== routeId(descriptor, route.xForY) ||
      route.tokenIn !== tokenIn || route.tokenOut !== tokenOut ||
      route.taxonomy.slotKind !== "swap" || route.taxonomy.protocolAction !== undefined ||
      hashCanonical(route.executionAssets ?? null) !==
        hashCanonical({ input: "erc20", output: "erc20" }) ||
      route.bindingRef.bindingKey !== descriptor.pair ||
      route.bindingRef.fingerprint !== hashCanonical(binding(descriptor))) {
    throw new Error("ammalgam route mismatch");
  }
}

export const routes = {
  project({ descriptor }: { readonly descriptor: Descriptor }): readonly Route[] {
    assertDescriptor(descriptor);
    return [true, false].map(xForY => ({
      familyId: ID,
      lineageId: LINEAGE,
      instanceKey: descriptor.instanceKey,
      routeKey: routeKey(routeId(descriptor, xForY)),
      pair: descriptor.pair,
      xForY,
      tokenIn: xForY ? descriptor.tokenX : descriptor.tokenY,
      tokenOut: xForY ? descriptor.tokenY : descriptor.tokenX,
      taxonomy: { slotKind: "swap" as const },
      executionAssets: { input: "erc20" as const, output: "erc20" as const },
      bindingRef: { bindingKey: descriptor.pair, fingerprint: hashCanonical(binding(descriptor)) },
      runtimeRequirements: descriptor.runtimeRequirements,
    }));
  },
  projectGraph({ descriptor, route }: { readonly descriptor: Descriptor; readonly route: Route }) {
    assertRoute(descriptor, route);
    return {
      routeActionAdapterId: ACTION,
      executionTarget: descriptor.pair,
      venueIdentity: { kind: "address-pool" as const, pool: descriptor.pair },
      centralScoreKey: route.routeKey,
    };
  },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

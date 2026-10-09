import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lower, same, validIndex, routeToken, isNativeCoin, isNativeMode } from "./codec.js";
import { staticBinding } from "./instance.js";
import type { CurvePlainDescriptor, CurvePlainMode, CurvePlainRoute } from "./types.js";

export function actionId(mode: CurvePlainMode): string {
  switch (mode) {
    case "received": return "curve-exchange";
    case "received-no-receiver": return "curve-exchange-nr";
    case "exchange": return "curve-exchange-plain";
    case "received-uint": return "curve-exchange-received-uint";
    case "exchange-uint": return "curve-exchange-uint";
    case "native-exchange": return "curve-native-exchange";
    case "native-exchange-uint": return "curve-native-exchange-uint";
    default: throw new Error("curve-plain unsupported execution mode");
  }
}
export const curvePlainRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(staticBinding(descriptor));
    return Object.freeze(descriptor.directions.map(direction => Object.freeze({
      familyId: descriptor.familyId, lineageId: descriptor.lineageId, instanceKey: descriptor.instanceKey,
      routeKey: routeKey([descriptor.familyId, lower(descriptor.pool), direction.i, direction.j, direction.executionMode].join(":")),
      tokenIn: direction.tokenIn, tokenOut: direction.tokenOut, taxonomy: { slotKind: "swap" as const },
      ...(nativeAssets(descriptor, direction) === undefined ? {} : { executionAssets: nativeAssets(descriptor, direction) }),
      bindingRef: { bindingKey: `${lower(descriptor.pool)}:${direction.i}:${direction.j}`, fingerprint },
      runtimeRequirements: descriptor.runtimeRequirements, pool: descriptor.pool,
      i: direction.i, j: direction.j, executionMode: direction.executionMode, quoteAbi: descriptor.binding.quoteAbi,
    })));
  },
  projectGraph({ descriptor, route }) {
    assertRoute(descriptor, route);
    return { routeActionAdapterId: actionId(route.executionMode), executionTarget: descriptor.pool,
      venueIdentity: { kind: "address-pool", pool: lower(descriptor.pool) }, centralScoreKey: route.routeKey };
  },
} satisfies RouteProjectionSemantics<CurvePlainDescriptor, CurvePlainRoute>;
export function assertRoute(descriptor: CurvePlainDescriptor, route: CurvePlainRoute): void {
  const direction = descriptor.directions.find(d => d.i === route.i && d.j === route.j && d.executionMode === route.executionMode);
  if (!validIndex(route.i) || !validIndex(route.j) || route.i === route.j || !direction ||
    route.quoteAbi !== descriptor.binding.quoteAbi || route.familyId !== descriptor.familyId || route.lineageId !== descriptor.lineageId ||
    route.instanceKey !== descriptor.instanceKey || !same(route.pool, descriptor.pool) ||
    !same(route.tokenIn, direction.tokenIn) || !same(route.tokenOut, direction.tokenOut) ||
    hashCanonical(route.executionAssets ?? null) !== hashCanonical(nativeAssets(descriptor, direction) ?? null) ||
    !same(route.tokenIn, routeToken(descriptor.binding.coins[route.i])) || !same(route.tokenOut, routeToken(descriptor.binding.coins[route.j])) ||
    isNativeMode(route.executionMode) !== (isNativeCoin(descriptor.binding.coins[route.i]) || isNativeCoin(descriptor.binding.coins[route.j])) ||
    route.bindingRef.fingerprint !== hashCanonical(staticBinding(descriptor)) ||
    route.routeKey !== [descriptor.familyId, lower(descriptor.pool), route.i, route.j, route.executionMode].join(":")) {
    throw new Error("curve-plain route does not match descriptor");
  }
}

function nativeAssets(descriptor: CurvePlainDescriptor, direction: { i: number; j: number; executionMode: CurvePlainMode }) {
  if (!isNativeMode(direction.executionMode)) return undefined;
  return { input: isNativeCoin(descriptor.binding.coins[direction.i]) ? "native" as const : "erc20" as const,
    output: isNativeCoin(descriptor.binding.coins[direction.j]) ? "native" as const : "erc20" as const };
}

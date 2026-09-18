import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { EKUBO_CORE, EKUBO_ROUTER } from "../ekubo/abi.js";
import { ekuboDirection, ekuboPoolId } from "../ekubo/pool-key.js";
import { vanillaKey } from "./codec.js";
import { staticBinding } from "./instance.js";
import { EKUBO_ACTION_ID, EKUBO_FAMILY_ID, EKUBO_LINEAGE } from "./manifest.js";
import type { EkuboDescriptor, EkuboRoute } from "./types.js";

const key = (poolId: string, isToken1: boolean) => `${EKUBO_FAMILY_ID}:${poolId}:${Number(isToken1)}`;
export function assertRoute(descriptor: EkuboDescriptor, route: EkuboRoute): void {
  const poolKey = vanillaKey(descriptor.poolKey);
  if (descriptor.familyId !== EKUBO_FAMILY_ID || descriptor.lineageId !== EKUBO_LINEAGE ||
      descriptor.poolId !== ekuboPoolId(poolKey) || descriptor.instanceKey !== descriptor.poolId ||
      route.familyId !== descriptor.familyId || route.lineageId !== descriptor.lineageId || route.instanceKey !== descriptor.instanceKey ||
      route.poolId !== descriptor.poolId || typeof route.isToken1 !== "boolean" ||
      ekuboDirection(route.tokenIn, route.tokenOut, poolKey) !== route.isToken1 ||
      route.bindingRef.bindingKey !== descriptor.poolId || route.bindingRef.fingerprint !== hashCanonical(staticBinding(descriptor)) ||
      route.routeKey !== key(descriptor.poolId, route.isToken1) || route.taxonomy.slotKind !== "swap") throw new Error("ekubo route does not match descriptor");
}
export const ekuboRoutes = {
  project({ descriptor }) {
    const poolKey = vanillaKey(descriptor.poolKey);
    const fingerprint = hashCanonical(staticBinding(descriptor));
    return Object.freeze([false, true].map(isToken1 => Object.freeze({
      familyId: descriptor.familyId, lineageId: descriptor.lineageId, instanceKey: descriptor.instanceKey,
      routeKey: routeKey(key(descriptor.poolId, isToken1)), poolId: descriptor.poolId, isToken1,
      tokenIn: isToken1 ? poolKey.token1 : poolKey.token0, tokenOut: isToken1 ? poolKey.token0 : poolKey.token1,
      taxonomy: { slotKind: "swap" as const }, bindingRef: { bindingKey: descriptor.poolId, fingerprint },
      runtimeRequirements: descriptor.runtimeRequirements,
    })));
  },
  projectGraph({ descriptor, route }) {
    assertRoute(descriptor, route);
    return { routeActionAdapterId: EKUBO_ACTION_ID, executionTarget: EKUBO_ROUTER,
      venueIdentity: { kind: "manager-pool-id", manager: EKUBO_CORE, poolId: descriptor.poolId }, centralScoreKey: route.routeKey };
  },
} satisfies RouteProjectionSemantics<EkuboDescriptor, EkuboRoute>;

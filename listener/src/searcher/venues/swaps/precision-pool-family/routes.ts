import { ethers } from "ethers";
import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { normalizedToken } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION, ID, LINEAGE } from "./manifest.js";
import { POOL_INIT_CODE_HASH } from "./runtime.js";
import type { Descriptor, Route } from "./types.js";
const key = (d: Descriptor, forward: boolean) => `${ID}:${d.pool}:${forward ? "0-1" : "1-0"}`;
const assets = (d: Descriptor, forward: boolean) => Object.freeze({
  input: (forward ? d.token0 : d.token1) === ethers.ZeroAddress ? "native" as const : "erc20" as const,
  output: (forward ? d.token1 : d.token0) === ethers.ZeroAddress ? "native" as const : "erc20" as const,
});
export function assertRoute(d: Descriptor, r: Route): void {
  if (d.familyId !== ID || d.lineageId !== LINEAGE || d.poolInitCodeHash !== POOL_INIT_CODE_HASH ||
      d.hook !== ethers.ZeroAddress || d.creatorFeeBps !== 0n ||
      r.familyId !== ID || r.lineageId !== LINEAGE || r.pool !== d.pool || d.instanceKey !== d.pool || r.instanceKey !== d.instanceKey ||
      typeof r.zeroForOne !== "boolean" || r.routeKey !== key(d, r.zeroForOne) ||
      r.tokenIn !== normalizedToken(r.zeroForOne ? d.token0 : d.token1) || r.tokenOut !== normalizedToken(r.zeroForOne ? d.token1 : d.token0) ||
      r.tokenIn === r.tokenOut || r.bindingRef.bindingKey !== d.pool || r.bindingRef.fingerprint !== hashCanonical(binding(d)) ||
      hashCanonical(r.executionAssets ?? null) !== hashCanonical(assets(d, r.zeroForOne)) ||
      r.taxonomy.slotKind !== "swap" || r.taxonomy.protocolAction !== undefined) throw new Error("precision-pool incompatible route");
}
export const routes = {
  project({ descriptor: d }) {
    return [true, false].map(zeroForOne => Object.freeze({ familyId: ID, lineageId: LINEAGE, instanceKey: d.instanceKey,
      routeKey: routeKey(key(d, zeroForOne)), pool: d.pool, zeroForOne, tokenIn: normalizedToken(zeroForOne ? d.token0 : d.token1),
      tokenOut: normalizedToken(zeroForOne ? d.token1 : d.token0), taxonomy: { slotKind: "swap" as const },
      executionAssets: assets(d, zeroForOne),
      bindingRef: { bindingKey: d.pool, fingerprint: hashCanonical(binding(d)) }, runtimeRequirements: d.runtimeRequirements }));
  },
  projectGraph({ descriptor, route }) { assertRoute(descriptor, route); return { routeActionAdapterId: ACTION, executionTarget: descriptor.pool,
    venueIdentity: { kind: "address-pool", pool: descriptor.pool }, centralScoreKey: route.routeKey }; },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

import { ethers } from "ethers";
import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { FACTORY_HASH, IMPLEMENTATION_HASH, normalizedToken } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION, ID, LINEAGE } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
const key = (d: Descriptor, buy: boolean) => `${ID}:${d.pool}:${buy ? "buy" : "sell"}`;
function executionAssets(d: Descriptor, buy: boolean) {
  const nativeInput = (buy ? d.money : d.stock) === ethers.ZeroAddress;
  const nativeOutput = (buy ? d.stock : d.money) === ethers.ZeroAddress;
  return nativeInput || nativeOutput ? { input: nativeInput ? "native" as const : "erc20" as const,
    output: nativeOutput ? "native" as const : "erc20" as const } : undefined;
}
export function assertRoute(d: Descriptor, r: Route): void {
  if (d.familyId !== ID || d.lineageId !== LINEAGE || d.implementationCodeHash !== IMPLEMENTATION_HASH || d.factoryCodeHash !== FACTORY_HASH ||
      r.familyId !== ID || r.lineageId !== LINEAGE || r.pool !== d.pool || d.instanceKey !== d.pool || r.instanceKey !== d.instanceKey ||
      typeof r.buy !== "boolean" || r.routeKey !== key(d, r.buy) || r.tokenIn !== normalizedToken(r.buy ? d.money : d.stock) ||
      r.tokenOut !== normalizedToken(r.buy ? d.stock : d.money) || r.tokenIn === r.tokenOut || r.bindingRef.bindingKey !== d.pool ||
      r.bindingRef.fingerprint !== hashCanonical(binding(d)) || r.taxonomy.slotKind !== "swap" || r.taxonomy.protocolAction !== undefined)
    throw new Error("oneswap incompatible route");
  const assets = executionAssets(d, r.buy);
  if (assets ? r.executionAssets?.input !== assets.input || r.executionAssets?.output !== assets.output : r.executionAssets !== undefined)
    throw new Error("oneswap execution asset binding");
}
export const routes = {
  project({ descriptor: d }) {
    return [true, false].map(buy => Object.freeze({ familyId: ID, lineageId: LINEAGE, instanceKey: d.instanceKey,
      routeKey: routeKey(key(d, buy)), pool: d.pool, buy, tokenIn: normalizedToken(buy ? d.money : d.stock),
      tokenOut: normalizedToken(buy ? d.stock : d.money),
      ...(executionAssets(d, buy) ? { executionAssets: executionAssets(d, buy) } : {}), taxonomy: { slotKind: "swap" as const },
      bindingRef: { bindingKey: d.pool, fingerprint: hashCanonical(binding(d)) }, runtimeRequirements: d.runtimeRequirements }));
  },
  projectGraph({ descriptor, route }) { assertRoute(descriptor, route); return { routeActionAdapterId: ACTION, executionTarget: descriptor.pool,
    venueIdentity: { kind: "address-pool", pool: descriptor.pool }, centralScoreKey: route.routeKey }; },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

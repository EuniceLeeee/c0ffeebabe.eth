import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { VAULT, poolIdentity, same, nonzero, lower } from "./codec.js";
import { staticBinding } from "./instance.js";
import { BALANCER_V2_FAMILY_ID, BALANCER_V2_LINEAGE } from "./manifest.js";
import type { BalancerV2Descriptor, BalancerV2Route } from "./types.js";
const key = (d: BalancerV2Descriptor, i: number, j: number) => d.familyId + ":" + d.poolId + ":" + i + ":" + j;
export const routes = {
  project({ descriptor: d }) {
    const fingerprint = hashCanonical(staticBinding(d));
    return Object.freeze(d.binding.tokens.flatMap((tokenIn, i) => d.binding.tokens.flatMap((tokenOut, j) => i === j ? [] : [
      Object.freeze({ familyId: d.familyId, lineageId: d.lineageId, instanceKey: d.instanceKey,
        routeKey: routeKey(key(d, i, j)), tokenIn, tokenOut, taxonomy: { slotKind: "swap" as const },
        bindingRef: { bindingKey: key(d, i, j), fingerprint }, runtimeRequirements: d.runtimeRequirements,
        pool: d.pool, poolId: d.poolId, i, j }),
    ])));
  },
  projectGraph({ descriptor: d, route: r }) {
    assertRoute(d, r);
    // Graph uses logical pool identity; the Family action settles through Vault.
    return { routeActionAdapterId: "balancer-v2-vault-swap", executionTarget: d.pool,
      venueIdentity: { kind: "vault-pool-id", vault: VAULT.toLowerCase(), poolId: d.poolId }, centralScoreKey: r.routeKey };
  },
} satisfies RouteProjectionSemantics<BalancerV2Descriptor, BalancerV2Route>;
export function assertRoute(d: BalancerV2Descriptor, r: BalancerV2Route) {
  const id = poolIdentity(d.poolId), tokens = d.binding.tokens;
  if (d.familyId !== BALANCER_V2_FAMILY_ID || d.lineageId !== BALANCER_V2_LINEAGE ||
      d.instanceKey !== id.poolId || !same(d.pool, id.pool) || d.binding.specialization !== id.specialization ||
      !same(d.binding.vault, VAULT) || tokens.length < 2 || d.binding.decimals.length !== tokens.length ||
      (id.specialization === 2 && tokens.length !== 2) || new Set(tokens.map(t => lower(nonzero(t)))).size !== tokens.length ||
      d.binding.decimals.some(x => !Number.isInteger(x) || x < 0 || x > 36) ||
      !Number.isInteger(r.i) || !Number.isInteger(r.j) || r.i < 0 || r.j < 0 || r.i >= tokens.length || r.j >= tokens.length || r.i === r.j ||
      r.familyId !== d.familyId || r.lineageId !== d.lineageId || r.instanceKey !== d.instanceKey ||
      !same(r.pool, d.pool) || r.poolId !== d.poolId || !same(r.tokenIn, tokens[r.i]) || !same(r.tokenOut, tokens[r.j]) ||
      r.taxonomy.slotKind !== "swap" || r.routeKey !== key(d, r.i, r.j) || r.bindingRef.bindingKey !== key(d, r.i, r.j) ||
      r.bindingRef.fingerprint !== hashCanonical(staticBinding(d))) throw new Error("balancer-v2 route does not match descriptor");
}

import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { FACTORY_ADDRESS, FACTORY_CODE_HASH, POOL_CODE_HASH, MODEL, BONE, nonzero, same } from "./codec.js";
import { staticBinding } from "./instance.js";
import { ACTION, ID, LINEAGE } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
const key = (pool: string, i: number, j: number) => `${ID}:${pool}:${i}:${j}`;
export function assertDescriptor(d: Descriptor): void {
  if (d.familyId !== ID || d.lineageId !== LINEAGE || d.model !== MODEL || d.factory !== FACTORY_ADDRESS ||
      d.poolCodeHash !== POOL_CODE_HASH || d.factoryCodeHash !== FACTORY_CODE_HASH || d.instanceKey !== d.pool ||
      nonzero(d.pool) !== d.pool || d.pool === d.factory || d.tokens.length < 2 || d.tokens.length > 8 ||
      d.weights.length !== d.tokens.length || new Set(d.tokens).size !== d.tokens.length ||
      d.tokens.some(t => nonzero(t) !== t || t === d.pool || t === d.factory) ||
      d.weights.some(w => w < BONE || w > 50n * BONE) || d.weights.reduce((a, b) => a + b, 0n) > 50n * BONE ||
      d.swapFee < BONE / 1_000_000n || d.swapFee > BONE / 10n) throw new Error("balancer-v1 incompatible descriptor");
}
export function assertRoute(d: Descriptor, r: Route): void {
  assertDescriptor(d);
  if (!Number.isInteger(r.i) || !Number.isInteger(r.j) || r.i < 0 || r.j < 0 || r.i >= d.tokens.length || r.j >= d.tokens.length || r.i === r.j ||
      r.familyId !== ID || r.lineageId !== LINEAGE || r.instanceKey !== d.instanceKey || r.pool !== d.pool ||
      r.routeKey !== key(d.pool, r.i, r.j) || !same(r.tokenIn, d.tokens[r.i]) || !same(r.tokenOut, d.tokens[r.j]) ||
      r.bindingRef.bindingKey !== d.pool || r.bindingRef.fingerprint !== hashCanonical(staticBinding(d)) ||
      r.taxonomy.slotKind !== "swap") throw new Error("balancer-v1 incompatible route");
}
export const routes = {
  project({ descriptor: d }) {
    assertDescriptor(d);
    return d.tokens.flatMap((tokenIn, i) => d.tokens.flatMap((tokenOut, j) => i === j ? [] : [Object.freeze({
      familyId: ID, lineageId: LINEAGE, instanceKey: d.instanceKey, routeKey: routeKey(key(d.pool, i, j)),
      pool: d.pool, i, j, tokenIn, tokenOut, taxonomy: { slotKind: "swap" as const },
      bindingRef: { bindingKey: d.pool, fingerprint: hashCanonical(staticBinding(d)) }, runtimeRequirements: d.runtimeRequirements,
    })]));
  },
  projectGraph({ descriptor, route }) {
    assertRoute(descriptor, route);
    return { routeActionAdapterId: ACTION, executionTarget: descriptor.pool,
      venueIdentity: { kind: "address-pool", pool: descriptor.pool }, centralScoreKey: route.routeKey };
  },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

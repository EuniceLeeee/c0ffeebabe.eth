import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { pair, key, CODE_HASH } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION, ID, LINEAGE } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
const routeId = (d: Descriptor, i: number) => `${ID}:${key(d)}:${i}`;
export function assertDescriptor(d: Descriptor) {
  const p = pair(d.vault, d.tokens);
  if (d.familyId !== ID || d.lineageId !== LINEAGE || d.codeHash !== CODE_HASH || d.vault !== p.vault ||
      d.instanceKey !== key(p) || d.tokens.some((t, i) => t !== p.tokens[i])) throw new Error("vault-spot descriptor mismatch");
}
export function assertRoute(d: Descriptor, r: Route) {
  assertDescriptor(d);
  if ((r.i !== 0 && r.i !== 1) || r.j !== 1-r.i || r.familyId !== ID || r.lineageId !== LINEAGE || r.instanceKey !== d.instanceKey ||
      r.vault !== d.vault || r.routeKey !== routeId(d, r.i) || r.tokenIn !== d.tokens[r.i] || r.tokenOut !== d.tokens[r.j] ||
      r.taxonomy.slotKind !== "swap" || r.bindingRef.bindingKey !== key(d) || r.bindingRef.fingerprint !== hashCanonical(binding(d)))
    throw new Error("vault-spot route mismatch");
}
export const routes = {
  project({ descriptor: d }): readonly Route[] {
    assertDescriptor(d);
    return [0, 1].map(i => ({ familyId: ID, lineageId: LINEAGE, instanceKey: d.instanceKey, routeKey: routeKey(routeId(d, i)),
      vault: d.vault, i, j: 1-i, tokenIn: d.tokens[i], tokenOut: d.tokens[1-i], taxonomy: { slotKind: "swap" as const },
      bindingRef: { bindingKey: key(d), fingerprint: hashCanonical(binding(d)) }, runtimeRequirements: d.runtimeRequirements }));
  },
  projectGraph({ descriptor: d, route: r }) {
    assertRoute(d, r);
    return { routeActionAdapterId: ACTION, executionTarget: d.vault,
      venueIdentity: { kind: "address-pool", pool: d.vault }, centralScoreKey: r.routeKey };
  },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

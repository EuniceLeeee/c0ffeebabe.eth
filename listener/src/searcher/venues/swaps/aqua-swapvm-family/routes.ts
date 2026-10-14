import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { binding as normalize, key, profile, CODE_HASH } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION, ID, LINEAGE } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
const routeId = (d: Descriptor, i: number) => `${ID}:${key(d)}:${i}`;
export function assertDescriptor(d: Descriptor) {
  const b = normalize(d.router, d.order, d.tokens);
  if (d.familyId !== ID || d.lineageId !== LINEAGE || d.codeHash !== CODE_HASH || !profile(d.order) ||
      d.aqua !== b.aqua || d.router !== b.router || d.strategyHash !== b.strategyHash || d.instanceKey !== key(b) ||
      d.tokens.some((t, i) => t !== b.tokens[i]) || d.order.maker !== b.order.maker || d.order.traits !== b.order.traits || d.order.data !== b.order.data)
    throw new Error("aqua descriptor mismatch");
}
export function assertRoute(d: Descriptor, r: Route) {
  assertDescriptor(d);
  if ((r.i !== 0 && r.i !== 1) || r.j !== 1-r.i || r.familyId !== ID || r.lineageId !== LINEAGE || r.instanceKey !== d.instanceKey ||
      r.router !== d.router || r.routeKey !== routeId(d, r.i) || r.tokenIn !== d.tokens[r.i] || r.tokenOut !== d.tokens[r.j] ||
      r.taxonomy.slotKind !== "swap" || r.bindingRef.bindingKey !== key(d) || r.bindingRef.fingerprint !== hashCanonical(binding(d)))
    throw new Error("aqua route mismatch");
}
export const routes = {
  project({ descriptor: d }): readonly Route[] {
    assertDescriptor(d);
    return [0, 1].map(i => ({ familyId: ID, lineageId: LINEAGE, instanceKey: d.instanceKey, routeKey: routeKey(routeId(d, i)),
      router: d.router, i, j: 1-i, tokenIn: d.tokens[i], tokenOut: d.tokens[1-i], taxonomy: { slotKind: "swap" as const },
      bindingRef: { bindingKey: key(d), fingerprint: hashCanonical(binding(d)) }, runtimeRequirements: d.runtimeRequirements }));
  },
  projectGraph({ descriptor: d, route: r }) {
    assertRoute(d, r);
    return { routeActionAdapterId: ACTION, executionTarget: d.router,
      venueIdentity: { kind: "registered-strategy", app: d.router, maker: d.order.maker, strategyHash: d.strategyHash }, centralScoreKey: r.routeKey };
  },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

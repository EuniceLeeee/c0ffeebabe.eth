import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { binding } from "./instance.js";
import { ACTION, FAMILY, LINEAGE, NG_LINEAGE, GENERIC_LINEAGE, ZAP_LINEAGE } from "./manifest.js";
import { genericAssets, genericGraphCoin } from "./generic.js";
import type { Descriptor, Direction, Route } from "./types.js";
const id = (d: Descriptor, dir: Direction, index: number) => `${FAMILY}:${d.pool}:${dir}:${index}`;
const directions = (d: Descriptor) => d.zap?.directions ?? d.generic?.directions ?? d.ng?.directions ?? (["mint", "redeem"] as const).flatMap(direction => ([0, 1] as const).map(index => ({ direction, index })));
const assets = (d: Descriptor, direction: Direction, index: number) => d.generic ? genericAssets(d, direction, index) : undefined;
const coin = (d: Descriptor, token: string) => d.generic ? genericGraphCoin(token) : token;
export function assertRoute(d: Descriptor, r: Route) {
  if (d.familyId !== FAMILY || d.lineageId !== (d.zap ? ZAP_LINEAGE : d.generic ? GENERIC_LINEAGE : d.ng ? NG_LINEAGE : LINEAGE) || d.instanceKey !== d.pool || r.familyId !== FAMILY || r.lineageId !== d.lineageId ||
      r.instanceKey !== d.instanceKey || !["mint", "redeem"].includes(r.direction) || !Number.isInteger(r.index) || r.index < 0 || r.index >= d.coins.length ||
      !directions(d).some(v => v.direction === r.direction && v.index === r.index) ||
      r.routeKey !== id(d, r.direction, r.index) || r.tokenIn !== coin(d, r.direction === "mint" ? d.coins[r.index] : d.lp) ||
      r.tokenOut !== coin(d, r.direction === "mint" ? d.lp : d.coins[r.index]) || r.taxonomy.slotKind !== "protocol" || r.taxonomy.protocolAction !== "convert" ||
      hashCanonical(r.executionAssets ?? null) !== hashCanonical(assets(d, r.direction, r.index) ?? null) ||
      r.bindingRef.bindingKey !== d.pool || r.bindingRef.fingerprint !== hashCanonical(binding(d))) throw new Error("curve-lp route binding mismatch");
}
export const routes = { project: ({ descriptor: d }) => directions(d).map(({ direction, index }) => ({
  familyId: FAMILY, lineageId: d.lineageId, instanceKey: d.instanceKey, direction, index, routeKey: routeKey(id(d, direction, index)),
  tokenIn: coin(d, direction === "mint" ? d.coins[index] : d.lp), tokenOut: coin(d, direction === "mint" ? d.lp : d.coins[index]),
  ...(d.generic ? { executionAssets: genericAssets(d, direction, index) } : {}),
  taxonomy: { slotKind: "protocol" as const, protocolAction: "convert" as const }, bindingRef: { bindingKey: d.pool, fingerprint: hashCanonical(binding(d)) },
  runtimeRequirements: d.runtimeRequirements })),
  projectGraph({ descriptor: d, route: r }) { assertRoute(d, r); return { routeActionAdapterId: ACTION, executionTarget: d.pool,
    venueIdentity: { kind: "address-protocol", target: d.pool }, centralScoreKey: r.routeKey }; },
} satisfies RouteProjectionSemantics<Descriptor, Route>;

import { getAddress } from "ethers";
import type { FamilyRouteDescriptor } from "./adapter-family-plugin.js";
import type { RouteVenueMid } from "./mid-readers.js";
import { validateDeclarativeStatements, validateDeclarativeValue } from "./declarative-values.js";

/** Raw state need not be sampled into a quote. Ratios stay integer until the
 * existing graph-mid boundary; these prices are never an Exact amount quote. */
export function validateDeclarativePricingProjection(block: any): void {
  validateDeclarativeStatements(block.checks);
  validateDeclarativeValue(block.rows);
}
export function projectDeclarativePrices(input: {
  domain: "swap" | "protocol"; routes: readonly (FamilyRouteDescriptor & Record<string, any>)[];
  unavailable: ReadonlyMap<any, string>; rows: unknown;
}): ReadonlyMap<FamilyRouteDescriptor["routeKey"], RouteVenueMid> {
  if (!Array.isArray(input.rows)) throw new Error("price projection must return rows");
  const routes = new Map(input.routes.map(route => [route.routeKey, route]));
  const mids = new Map<FamilyRouteDescriptor["routeKey"], RouteVenueMid>();
  const uint = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n && value < (1n << 256n);
  for (const row of input.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        Object.keys(row).some(key => !["routeKey", "numerator", "denominator", "depth", "reserveA", "reserveB", "feeBps"].includes(key)))
      throw new Error("invalid price projection row");
    const route = routes.get(row.routeKey);
    if (!route || mids.has(row.routeKey) || input.unavailable.has(row.routeKey)) throw new Error("price projection route coverage mismatch");
    if (![row.numerator, row.denominator, row.depth, row.feeBps ?? 0n, row.reserveA ?? 0n, row.reserveB ?? 0n].every(uint) ||
        row.numerator === 0n || row.denominator === 0n || row.depth === 0n || (row.feeBps ?? 0n) > 10000n)
      throw new Error("invalid price projection amount");
    const mid = Number(row.numerator) / Number(row.denominator), depthProxy = Number(row.depth);
    if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(depthProxy)) throw new Error("nonfinite price projection");
    mids.set(route.routeKey, {
      kind: input.domain === "swap" ? "external-swap" : "protocol", pool: getAddress(route.target),
      mid, depthProxy, feeBps: Number(row.feeBps ?? 0n),
      ...(row.reserveA === undefined ? {} : { reserveA: row.reserveA }),
      ...(row.reserveB === undefined ? {} : { reserveB: row.reserveB }),
      edges: [{ adapterId: route.adapterId, instanceKey: route.instanceKey, target: route.target,
        tokenIn: route.tokenIn, tokenOut: route.tokenOut, ...route.taxonomy,
        edgeKind: input.domain === "swap" ? "swap" : "protocol", leavesStandingPosition: false }],
    } as RouteVenueMid);
  }
  if (input.routes.some(route => !mids.has(route.routeKey) && !input.unavailable.has(route.routeKey)))
    throw new Error("price projection omitted an available route");
  return mids;
}

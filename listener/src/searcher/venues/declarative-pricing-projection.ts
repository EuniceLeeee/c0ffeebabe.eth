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
        Object.keys(row).some(key => !["routeKey", "kind", "numerator", "denominator", "depth", "reserveA", "reserveB", "balanceHeadroomIn", "feeBps", "feePpm", "sqrtABX96", "liquidity"].includes(key)))
      throw new Error("invalid price projection row");
    const kind = row.kind ?? (input.domain === "swap" ? "external-swap" : "protocol");
    if (row.kind !== undefined && (input.domain === "protocol" ? kind !== "protocol" :
        !["v2", "v3", "v4", "curve", "curve-underlying", "external-swap"].includes(kind)))
      throw new Error("price kind does not belong to its domain");
    if ((row.sqrtABX96 !== undefined || row.liquidity !== undefined) &&
        (!(kind === "v3" || kind === "v4") || !uint(row.sqrtABX96) || row.sqrtABX96 === 0n ||
         row.sqrtABX96 >= 1n << 160n || !uint(row.liquidity) || row.liquidity === 0n || row.liquidity >= 1n << 128n))
      throw new Error("invalid concentrated price state");
    const route = routes.get(row.routeKey);
    if (!route || mids.has(row.routeKey) || input.unavailable.has(row.routeKey)) throw new Error("price projection route coverage mismatch");
    if (row.feePpm !== undefined && (row.feeBps !== undefined || !uint(row.feePpm) || row.feePpm > 1_000_000n))
      throw new Error("invalid or conflicting price fee units");
    if (![row.numerator, row.denominator, row.depth, row.feeBps ?? 0n, row.reserveA ?? 0n, row.reserveB ?? 0n, row.balanceHeadroomIn === undefined ? 0n : row.balanceHeadroomIn].every(uint) ||
        row.numerator === 0n || row.denominator === 0n || row.depth === 0n || (row.feeBps ?? 0n) > 10000n)
      throw new Error("invalid price projection amount");
    const mid = Number(row.numerator) / Number(row.denominator), depthProxy = Number(row.depth);
    if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(depthProxy)) throw new Error("nonfinite price projection");
    mids.set(route.routeKey, {
      kind, pool: getAddress(route.target),
      mid, depthProxy, feeBps: row.feePpm === undefined ? Number(row.feeBps ?? 0n) : Number(row.feePpm) / 100,
      ...(row.sqrtABX96 === undefined ? {} : { sqrtABX96: row.sqrtABX96, liquidity: row.liquidity }),
      ...(row.reserveA === undefined ? {} : { reserveA: row.reserveA }),
      ...(row.reserveB === undefined ? {} : { reserveB: row.reserveB }),
      ...(row.balanceHeadroomIn === undefined ? {} : { balanceHeadroomIn: row.balanceHeadroomIn }),
      edges: [{ adapterId: route.adapterId, instanceKey: route.instanceKey, target: route.target,
        tokenIn: route.tokenIn, tokenOut: route.tokenOut, ...route.taxonomy,
        edgeKind: input.domain === "swap" ? "swap" : "protocol", leavesStandingPosition: false }],
    } as RouteVenueMid);
  }
  if (input.routes.some(route => !mids.has(route.routeKey) && !input.unavailable.has(route.routeKey)))
    throw new Error("price projection omitted an available route");
  return mids;
}

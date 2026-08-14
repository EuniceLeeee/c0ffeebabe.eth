import type {
  StrictShadowCatalogViews,
} from "./adapter-family-shadow-catalog-publication.js";
import {
  createStrictCatalogConsumer,
} from "./adapter-family-shadow-catalog-publication.js";
import type { AmountQuoteSource } from
  "./solver/amount-propagation.js";
import type { QuoteRequest, QuoteResult } from
  "./live-state-backend.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import type { RouteVenueMid } from
  "./venues/mid-readers.js";
import type { RouteKey } from
  "./venues/adapter-family-identifiers.js";

const INDEX_SCALE = 1_000_000_000n;

interface StrictQuoteIndex {
  readonly edgeByRequest: ReadonlyMap<
    string,
    { readonly familyId: string; readonly instanceKey: string }
  >;
  readonly pricingByRoute: ReadonlyMap<
    string,
    {
      readonly pricingPublicationKey: string;
      readonly routeKey: RouteKey;
    }
  >;
}

function requestKey(
  adapterId: string,
  target: string,
  tokenIn: string,
  tokenOut: string,
): string {
  return [
    adapterId.toLowerCase(),
    target.toLowerCase(),
    tokenIn.toLowerCase(),
    tokenOut.toLowerCase(),
  ].join("\u001f");
}

function buildStrictQuoteIndex(
  views: StrictShadowCatalogViews,
  catalog: FamilyCapabilityCatalog,
): StrictQuoteIndex {
  const edgeByRequest = new Map<
    string,
    { readonly familyId: string; readonly instanceKey: string }
  >();
  for (const edge of views.edges) {
    if (edge.instanceKey === undefined) continue;
    let familyId: string;
    try {
      familyId = catalog.ownerOfAction(edge.adapterId);
    } catch {
      continue;
    }
    edgeByRequest.set(
      requestKey(edge.adapterId, edge.target, edge.tokenIn, edge.tokenOut),
      Object.freeze({ familyId, instanceKey: edge.instanceKey }),
    );
  }
  const pricingByRoute = new Map<
    string,
    { readonly pricingPublicationKey: string; readonly routeKey: RouteKey }
  >();
  for (const [pricingPublicationKey, state] of views.pricingByPublicationKey) {
    for (const route of state.routes) {
      pricingByRoute.set(
        requestKey(
          state.familyId,
          route.instanceKey,
          route.tokenIn,
          route.tokenOut,
        ),
        Object.freeze({
          pricingPublicationKey,
          routeKey: route.routeKey,
        }),
      );
    }
  }
  return Object.freeze({
    edgeByRequest: Object.freeze(edgeByRequest),
    pricingByRoute: Object.freeze(pricingByRoute),
  });
}

function amountOutFromMid(amountIn: bigint, mid: RouteVenueMid): bigint {
  if (!Number.isFinite(mid.mid) || mid.mid <= 0) return 0n;
  const scaled = BigInt(Math.round(mid.mid * Number(INDEX_SCALE)));
  if (scaled <= 0n) return 0n;
  return (amountIn * scaled) / INDEX_SCALE;
}

/**
 * Pair E: solver-shaped quote source backed by committed strict catalog
 * pricing views. Routes covered by the committed publication quote from
 * the strict mid (fail-closed on unavailable/missing by falling back to
 * the legacy source per the per-family/per-availability design); unknown
 * routes keep the legacy quote so the searcher's coverage does not drop
 * while the strict publication set is still growing. The final simulation
 * remains the correctness gate; this only prices candidate propagation.
 */
export interface StrictQuoteSourceFallbackPolicy {
  /**
   * "legacy" (transitional): a route missing from the strict views falls
   * back to the legacy source. "fail-closed" (F6 Pair E terminal): a route
   * missing from committed strict views throws, so the solver never prices
   * through a non-strict path once the durable composition is the default.
   */
  readonly fallback: "legacy" | "fail-closed";
}

export function createStrictQuoteSource(input: {
  readonly views: () => StrictShadowCatalogViews | null;
  readonly catalog: FamilyCapabilityCatalog;
  readonly legacy: AmountQuoteSource;
  readonly fallback?: StrictQuoteSourceFallbackPolicy["fallback"];
}): AmountQuoteSource {
  let cachedRevision = -1;
  let cachedIndex: StrictQuoteIndex | null = null;
  const index = (): StrictQuoteIndex | null => {
    const views = input.views();
    if (views === null) {
      cachedIndex = null;
      cachedRevision = -1;
      return null;
    }
    if (cachedRevision !== views.revision) {
      cachedIndex = buildStrictQuoteIndex(views, input.catalog);
      cachedRevision = views.revision;
    }
    return cachedIndex;
  };
  return Object.freeze({
    async quote(req: QuoteRequest): Promise<QuoteResult> {
      const idx = index();
      if (idx !== null) {
        const edge = idx.edgeByRequest.get(
          requestKey(req.adapterId, req.target, req.tokenIn, req.tokenOut),
        );
        if (edge !== undefined) {
          const pricing = idx.pricingByRoute.get(
            requestKey(
              edge.familyId,
              edge.instanceKey,
              req.tokenIn,
              req.tokenOut,
            ),
          );
          if (pricing !== undefined) {
            const views = input.views()!;
            const consumer = createStrictCatalogConsumer(views);
            const outcome = consumer.resolvePricingMid({
              pricingPublicationKey: pricing.pricingPublicationKey,
              routeKey: pricing.routeKey,
            });
            if (outcome.kind === "mid") {
              return Object.freeze({
                amountOut: amountOutFromMid(req.amountIn, outcome.mid),
                latencyMs: 0,
              });
            }
          }
        }
      }
      if (input.fallback === "fail-closed") {
        throw new Error(
          `strict quote source has no committed pricing for ` +
            `adapter=${req.adapterId} target=${req.target} ` +
            `tokenIn=${req.tokenIn} tokenOut=${req.tokenOut}`,
        );
      }
      return await input.legacy.quote(req);
    },
  });
}

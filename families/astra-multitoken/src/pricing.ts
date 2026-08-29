import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { assertAstraRoute } from "./routes.ts";
import type { AstraExactV1, AstraIdentityV1, AstraQuoteV1, AstraRouteV1, SourceAnchorV1 } from "./types.ts";

export function quoteAstra(input: { readonly identity: AstraIdentityV1; readonly route: AstraRouteV1; readonly source: SourceAnchorV1; readonly amountIn: bigint; readonly amountOut: bigint }): AstraQuoteV1 {
  assertAstraRoute(input.route, { familyId: "astra-multitoken", instanceKey: input.identity.instanceKey, target: input.identity.target, identity: input.identity, runtimeRequirements: [] });
  if (input.amountIn <= 0n || input.amountOut <= 0n) throw new RangeError("astra quote amounts must be positive");
  if (input.source.hash !== input.identity.source.hash || input.source.number !== input.identity.source.number) throw new TypeError("astra quote source mismatch");
  const payload = { routeKey: input.route.routeKey, source: input.source, amountIn: input.amountIn.toString(), amountOut: input.amountOut.toString(), identityFactsHash: input.identity.factsHash };
  return Object.freeze({ source: input.source, routeKey: input.route.routeKey, amountIn: input.amountIn, amountOut: input.amountOut, quoteHash: hashDomain("aloha/astra-multitoken/quote/v1", payload) });
}

export function conservativeAstraUpperBound(quote: AstraQuoteV1): bigint {
  if (quote.amountOut <= 0n) throw new TypeError("astra quote is not rankable");
  return quote.amountOut;
}

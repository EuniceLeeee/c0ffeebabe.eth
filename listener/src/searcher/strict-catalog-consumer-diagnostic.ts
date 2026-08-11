import type {
  DurableDiscoveryContinuityComposition,
} from "./adapter-family-discovery-continuity-composition.js";
import {
  createSourceBoundStrictCatalogConsumer,
  type StrictShadowCatalogViews,
} from "./adapter-family-shadow-catalog-publication.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import { routeKey } from "./venues/adapter-family-identifiers.js";

/**
 * Diagnostic-only production entry for the source-bound strict catalog
 * consumer. When enabled, production startup resolves the currently
 * committed strict views through the source-bound consumer and logs a
 * redacted summary (revision/edge/pricing/funding counts). It never feeds
 * the solver or falls back to the legacy registry, and it is OFF by
 * default; this is not a default-authority cutover.
 */
export function resolveStrictCatalogConsumerDiagnostic(input: {
  readonly composition: DurableDiscoveryContinuityComposition | null;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly assertGenerationCurrent?: (
    generation: number,
    source: CanonicalSource,
  ) => void;
}): string {
  if (input.composition === null) return "no-composition";
  const committed = input.composition.catalogRoot.capture();
  if (committed === null) return "no-committed-publication";
  try {
    const views: StrictShadowCatalogViews = committed.views;
    const consumer = createSourceBoundStrictCatalogConsumer({
      views,
      source: input.source,
      generation: input.generation,
      assertGenerationCurrent: input.assertGenerationCurrent ??
        (() => {}),
    });
    // Resolve one of each read family to prove the source-bound entry is
    // live; the outcomes themselves are intentionally not surfaced.
    const pricingKey = views.pricingByPublicationKey.keys().next().value;
    if (pricingKey !== undefined) {
      const midKey = views.pricingByPublicationKey.get(pricingKey)!.mids
        .keys().next().value;
      if (midKey !== undefined) {
        consumer.resolvePricingMid({
          pricingPublicationKey: String(pricingKey),
          routeKey: routeKey(String(midKey)),
        });
      }
    }
    const fundingKey = views.fundingByPublicationKey.keys().next().value;
    if (fundingKey !== undefined) {
      consumer.resolveFundingOffers({
        fundingPublicationKey: String(fundingKey),
      });
    }
    return "resolved(" +
      `revision=${committed.envelope.snapshot.revision},` +
      `edges=${views.edges.length},` +
      `pricing=${views.pricingByPublicationKey.size},` +
      `funding=${views.fundingByPublicationKey.size})`;
  } catch (error) {
    return `failed:${error instanceof Error ? error.message : String(error)}`;
  }
}

import type {
  DurableDiscoveryContinuityComposition,
} from "./adapter-family-discovery-continuity-composition.js";
import {
  createSourceBoundStrictCatalogConsumer,
} from "./adapter-family-shadow-catalog-publication.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import { routeKey } from "./venues/adapter-family-identifiers.js";

/**
 * Solver-shaped production entry for the source-bound strict catalog
 * consumer. Unlike the one-read diagnostic, it resolves the complete strict
 * read surface (every pricing mid, funding offer and credit route in the
 * committed views) and returns an explicit outcome summary. Every resolve
 * is source/generation-fenced and fail-closed: a missing or unavailable
 * strict value is counted, never replaced by a legacy-registry fallback.
 * This is still env-gated/disabled-path wiring, not a default-authority
 * cutover.
 */
export function resolveStrictSolverConsumer(input: {
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
    const views = committed.views;
    const consumer = createSourceBoundStrictCatalogConsumer({
      views,
      source: input.source,
      generation: input.generation,
      assertGenerationCurrent: input.assertGenerationCurrent ?? (() => {}),
    });
    // Graph completeness at the consumer boundary: every committed edge must
    // have an issued handle, so the solver can never read a graph the
    // catalog did not atomically publish.
    const edgeCount = views.edges.length;
    const handleCount = views.handleByCanonicalEdgeId.size;
    if (handleCount !== edgeCount) {
      throw new Error(
        `strict graph completeness mismatch: edges=${edgeCount} ` +
          `handles=${handleCount}`,
      );
    }
    let pricing = 0;
    let unavailable = 0;
    let missing = 0;
    for (const [pricingKey, state] of views.pricingByPublicationKey) {
      for (const midKey of state.mids.keys()) {
        const outcome = consumer.resolvePricingMid({
          pricingPublicationKey: pricingKey,
          routeKey: routeKey(String(midKey)),
        });
        pricing += 1;
        if (outcome.kind === "unavailable") unavailable += 1;
        if (outcome.kind === "missing") missing += 1;
      }
    }
    let funding = 0;
    for (const fundingKey of views.fundingByPublicationKey.keys()) {
      consumer.resolveFundingOffers({ fundingPublicationKey: fundingKey });
      funding += 1;
    }
    let credit = 0;
    let creditMissing = 0;
    for (const edgeId of views.handleByCanonicalEdgeId.keys()) {
      const handle = consumer.resolveCreditRoute({
        canonicalEdgeId: edgeId as never,
      });
      if (handle === null) creditMissing += 1;
      else credit += 1;
    }
    return "resolved(" +
      `revision=${committed.envelope.snapshot.revision},` +
      `edges=${edgeCount},handles=${handleCount},` +
      `pricing=${pricing},unavailable=${unavailable},missing=${missing},` +
      `funding=${funding},credit=${credit},creditMissing=${creditMissing})`;
  } catch (error) {
    return `failed:${error instanceof Error ? error.message : String(error)}`;
  }
}

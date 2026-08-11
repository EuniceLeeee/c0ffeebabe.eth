import assert from "node:assert/strict";
import {
  resolveStrictCatalogConsumerDiagnostic,
} from "../strict-catalog-consumer-diagnostic.js";
import type {
  DurableDiscoveryContinuityComposition,
} from "../adapter-family-discovery-continuity-composition.js";
import type {
  CommittedStrictShadowCatalogPublication,
  StrictShadowCatalogViews,
} from "../adapter-family-shadow-catalog-publication.js";
import { routeKey } from "../venues/adapter-family-identifiers.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_500,
  hash: `0x${"51".repeat(32)}`,
  generation: 50,
});

function committedViews(source: CanonicalSource): StrictShadowCatalogViews {
  const mid: RouteVenueMid = Object.freeze({
    kind: "v2",
    pool: `0x${"41".repeat(20)}`,
    edges: [] as RouteVenueMid["edges"],
    mid: 1,
    feeBps: 30,
    reserveA: 1_000_000n,
    reserveB: 2_000_000n,
    depthProxy: 1_000_000,
  });
  return Object.freeze({
    revision: 1,
    source,
    publicationFingerprint: "11".repeat(32),
    graphRoutes: Object.freeze([]),
    edges: Object.freeze([]),
    handleByCanonicalEdgeId: new Map(),
    pricingByPublicationKey: new Map([[Object.freeze({
      format: "strict-shadow-pricing-key-v1",
      familyId: "univ2-standard",
      lineageId: "univ2:standard",
      instanceKey: `0x${"41".repeat(20)}`,
      stateInstanceKey: "state-instance:v2",
    }) as never, Object.freeze({
      mids: new Map([[routeKey("r"), mid]]),
      unavailable: new Map(),
    } as never)]]),
    fundingByPublicationKey: new Map(),
  });
}

function compositionWith(
  committed: CommittedStrictShadowCatalogPublication | null,
): DurableDiscoveryContinuityComposition {
  return Object.freeze({
    catalogRoot: Object.freeze({
      capture: () => committed,
    }),
  }) as unknown as DurableDiscoveryContinuityComposition;
}

function main(): void {
  assert.equal(resolveStrictCatalogConsumerDiagnostic({
    composition: null,
    source: SOURCE,
    generation: SOURCE.generation,
  }), "no-composition");
  assert.equal(resolveStrictCatalogConsumerDiagnostic({
    composition: compositionWith(null),
    source: SOURCE,
    generation: SOURCE.generation,
  }), "no-committed-publication");

  const views = committedViews(SOURCE);
  const committed = Object.freeze({
    envelope: Object.freeze({
      snapshot: Object.freeze({
        revision: 1,
        publicationFingerprint: "11".repeat(32),
      }),
    }),
    views,
  }) as unknown as CommittedStrictShadowCatalogPublication;
  const ok = resolveStrictCatalogConsumerDiagnostic({
    composition: compositionWith(committed),
    source: SOURCE,
    generation: SOURCE.generation,
  });
  assert.equal(ok, "resolved(revision=1,edges=0,pricing=1,funding=0)");

  const stale = resolveStrictCatalogConsumerDiagnostic({
    composition: compositionWith(committed),
    source: Object.freeze({
      ...SOURCE,
      number: SOURCE.number + 1,
      hash: `0x${"52".repeat(32)}`,
    }),
    generation: SOURCE.generation + 1,
  });
  assert.match(stale, /^failed:.*source mismatch/);

  const fenced = resolveStrictCatalogConsumerDiagnostic({
    composition: compositionWith(committed),
    source: SOURCE,
    generation: SOURCE.generation,
    assertGenerationCurrent: () => {
      throw new Error("generation fence rejected");
    },
  });
  assert.match(fenced, /^failed:.*generation fence/);

  console.log("strict catalog consumer diagnostic PASS");
}

main();

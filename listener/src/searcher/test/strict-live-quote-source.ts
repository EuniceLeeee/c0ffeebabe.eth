import assert from "node:assert/strict";
import {
  createStrictQuoteSource,
} from "../strict-live-quote-source.js";
import type { StrictShadowCatalogViews } from
  "../adapter-family-shadow-catalog-publication.js";
import type { AmountQuoteSource } from
  "../solver/amount-propagation.js";
import type { QuoteRequest } from
  "../live-state-backend.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { UNIV2_FAMILY_ID } from
  "../venues/swaps/univ2-family/manifest.js";

const CATALOG = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const POOL = `0x${"41".repeat(20)}`;
const TOKEN_IN = `0x${"42".repeat(20)}`;
const TOKEN_OUT = `0x${"43".repeat(20)}`;
const INSTANCE = "univ2:instance-1";
const ROUTE_KEY = "univ2:route-1";
const PRICING_KEY = "pricing:univ2:1";

function viewsFixture(
  midValue: number,
  revision: number,
  unavailable?: boolean,
): StrictShadowCatalogViews {
  const route = Object.freeze({
    routeKey: ROUTE_KEY,
    familyId: UNIV2_FAMILY_ID,
    lineageId: "univ2:lineage",
    instanceKey: INSTANCE,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    taxonomy: Object.freeze({ slotKind: "swap" }),
    bindingRef: Object.freeze({
      bindingKey: "binding",
      fingerprint: "fingerprint",
    }),
    runtimeRequirements: Object.freeze([]),
  });
  const pricing = Object.freeze({
    familyId: UNIV2_FAMILY_ID,
    lineageId: "univ2:lineage",
    instanceKey: INSTANCE,
    stateKey: "state",
    stateInstanceKey: "state-instance",
    routes: Object.freeze([route]),
    pricingDescriptor: Object.freeze({}),
    snapshot: Object.freeze({}),
    mids: new Map([[ROUTE_KEY, Object.freeze({
      kind: "v2",
      pool: POOL,
      edges: Object.freeze([]),
      mid: midValue,
      feeBps: 0,
      depthProxy: 1,
    })]]),
    unavailable: new Map<string, string>(),
    dependencies: Object.freeze([]),
    groupBindingFingerprint: "group",
    staticBindingFingerprint: "static",
    snapshotCompatibilityFingerprint: "snapshot",
    staticEvidenceFingerprint: "evidence",
    currentEvidenceFingerprint: "current",
  }) as never;
  if (unavailable === true) {
    (pricing as { unavailable: Map<string, string> }).unavailable.set(
      ROUTE_KEY,
      "fixture-unavailable",
    );
  }
  const edge = Object.freeze({
    adapterId: "univ2-swap",
    target: POOL,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    instanceKey: INSTANCE,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  });
  return Object.freeze({
    revision,
    source: Object.freeze({
      number: 101,
      hash: `0x${"11".repeat(32)}`,
      generation: 101,
    }),
    publicationFingerprint: "publication",
    graphRoutes: Object.freeze([]),
    edges: Object.freeze([edge]),
    handleByCanonicalEdgeId: new Map(),
    pricingByPublicationKey: new Map([[PRICING_KEY, pricing]]),
    fundingByPublicationKey: new Map(),
  }) as unknown as StrictShadowCatalogViews;
}

function legacyQuoteSource(calls: string[]): AmountQuoteSource {
  return Object.freeze({
    quote: async (req: QuoteRequest) => {
      calls.push(req.adapterId);
      return Object.freeze({ amountOut: 999n, latencyMs: 5 });
    },
  });
}

async function main(): Promise<void> {
  let currentViews: StrictShadowCatalogViews | null = viewsFixture(2, 7);
  const legacyCalls: string[] = [];
  const source = createStrictQuoteSource({
    views: () => currentViews,
    catalog: CATALOG,
    legacy: legacyQuoteSource(legacyCalls),
  });
  const covered = await source.quote({
    adapterId: "univ2-swap",
    target: POOL,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: 1_000n,
  });
  assert.equal(covered.amountOut, 2_000n);
  assert.deepEqual(legacyCalls, [], "covered route must quote from strict views");

  const unknown = await source.quote({
    adapterId: "univ2-swap",
    target: POOL,
    tokenIn: `0x${"44".repeat(20)}`,
    tokenOut: TOKEN_OUT,
    amountIn: 1_000n,
  });
  assert.equal(unknown.amountOut, 999n);
  assert.deepEqual(legacyCalls, ["univ2-swap"]);

  currentViews = viewsFixture(2, 8, true);
  const unavailable = await source.quote({
    adapterId: "univ2-swap",
    target: POOL,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: 1_000n,
  });
  assert.equal(
    unavailable.amountOut,
    999n,
    "unavailable strict mid must fall back to the legacy source",
  );
  assert.deepEqual(legacyCalls, ["univ2-swap", "univ2-swap"]);

  currentViews = viewsFixture(3, 9);
  const updated = await source.quote({
    adapterId: "univ2-swap",
    target: POOL,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: 1_000n,
  });
  assert.equal(updated.amountOut, 3_000n, "revision change must rebuild the index");

  currentViews = null;
  const noViews = await source.quote({
    adapterId: "univ2-swap",
    target: POOL,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: 1_000n,
  });
  assert.equal(noViews.amountOut, 999n);
  assert.deepEqual(legacyCalls, ["univ2-swap", "univ2-swap", "univ2-swap"]);

  // F6 Pair E: fail-closed mode never consults the legacy source.
  const failClosedCalls: string[] = [];
  const failClosed = createStrictQuoteSource({
    views: () => currentViews,
    catalog: CATALOG,
    legacy: legacyQuoteSource(failClosedCalls),
    fallback: "fail-closed",
  });
  await assert.rejects(
    failClosed.quote({
      adapterId: "univ2-swap",
      target: POOL,
      tokenIn: `0x${"44".repeat(20)}`,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000n,
    }),
    /no committed pricing/,
    "unknown route must fail closed instead of falling back",
  );
  await assert.rejects(
    failClosed.quote({
      adapterId: "univ2-swap",
      target: POOL,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000n,
    }),
    /no committed pricing/,
    "no-views route must fail closed instead of falling back",
  );
  assert.deepEqual(failClosedCalls, [], "fail-closed mode must not call legacy");

  console.log("strict-live-quote-source PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

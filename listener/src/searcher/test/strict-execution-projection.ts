import assert from "node:assert/strict";
import {
  resolveFundingPrewarmAddresses,
  strictExecutionProjectionFor,
  strictRoutePrewarmAddresses,
  strictFundingPrewarmAddresses,
} from "../strict-execution-projection.js";
import {
  UNIV2_PAIR_INTERFACE,
} from "../venues/swaps/univ2-family/codec.js";
import {
  UNIV2_ROUTER,
} from "../venues/swaps/univ2-family/victim.js";
import type {
  StrictShadowCatalogViews,
} from "../adapter-family-shadow-catalog-publication.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { UNIV2_FAMILY_ID } from
  "../venues/swaps/univ2-family/manifest.js";

const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});

function fundingState(familyId: string) {
  return Object.freeze({
    kind: "funding" as const,
    familyId,
    source: SOURCE,
    generation: SOURCE.generation,
    tombstone: false,
    offers: Object.freeze([]),
    outcomes: Object.freeze([]),
  });
}

function main(): void {
  const fundingFamily = catalog.listAll().find((family) =>
    family.plugin.manifest.domain === "funding"
  );
  assert(fundingFamily, "production catalog has a funding family");
  const family = fundingFamily!;
  assert("funding" in family.plugin && family.plugin.funding !== undefined);
  const repayment = family.plugin.funding.repayment;
  const views = Object.freeze({
    fundingByPublicationKey: new Map([
      ["funding:fixture", fundingState(fundingFamily!.plugin.manifest.familyId)],
    ]),
  }) as unknown as StrictShadowCatalogViews;
  const addresses = strictFundingPrewarmAddresses({ views, catalog });
  assert.deepEqual(
    addresses,
    Object.freeze([
      repayment.target.toLowerCase(),
      repayment.liquidityHolder.toLowerCase(),
    ].filter((value, index, all) => all.indexOf(value) === index).sort()),
  );
  assert(Object.isFrozen(addresses));

  const swapViews = Object.freeze({
    fundingByPublicationKey: new Map([
      ["funding:wrong", fundingState(UNIV2_FAMILY_ID)],
    ]),
  }) as unknown as StrictShadowCatalogViews;
  assert.throws(
    () => strictFundingPrewarmAddresses({ views: swapViews, catalog }),
    /has no funding plugin/,
  );
  assert.deepEqual(
    resolveFundingPrewarmAddresses({
      strictViews: null,
      catalog,
      legacyAddresses: Object.freeze([
        `0x${"aa".repeat(20)}`,
        `0x${"BB".repeat(20)}`,
        `0x${"aa".repeat(20)}`,
      ]),
    }),
    Object.freeze([
      `0x${"aa".repeat(20)}`,
      `0x${"bb".repeat(20)}`,
    ]),
  );
  assert.deepEqual(
    resolveFundingPrewarmAddresses({
      strictViews: views,
      catalog,
      legacyAddresses: Object.freeze([`0x${"cc".repeat(20)}`]),
    }),
    addresses,
  );
  const hop = Object.freeze({
    adapterId: "univ2-swap",
    target: `0x${"41".repeat(20)}`,
    tokenIn: `0x${"43".repeat(20)}`,
    tokenOut: `0x${"44".repeat(20)}`,
  });
  assert.deepEqual(
    strictRoutePrewarmAddresses({ catalog, hops: Object.freeze([hop]) }),
    Object.freeze([
      `0x${"41".repeat(20)}`,
      `0x${"43".repeat(20)}`,
      `0x${"44".repeat(20)}`,
    ]),
  );
  assert.deepEqual(
    strictRoutePrewarmAddresses({
      catalog,
      hops: Object.freeze([Object.freeze({
        ...hop,
        adapterId: "unknown-adapter",
      })]),
    }),
    Object.freeze([]),
  );
  const univ2Projection = strictExecutionProjectionFor({
    catalog,
    adapterId: "univ2-swap",
  });
  assert(univ2Projection);
  assert.equal(univ2Projection.allowanceSpender, UNIV2_ROUTER);
  assert.equal(univ2Projection.prewarmQuoteCalls.length, 1);
  assert.equal(
    univ2Projection.prewarmQuoteCalls[0]!.calldata,
    UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves", []),
  );
  assert.equal(
    strictExecutionProjectionFor({
      catalog,
      adapterId: "unknown-adapter",
    }),
    null,
  );
  console.log("strict-execution-projection PASS");
}

main();

import assert from "node:assert/strict";
import {
  captureUniv2FixtureCase,
  UNIV2_FIXTURE_FACTORY,
  UNIV2_FIXTURE_POOL,
  UNIV2_FIXTURE_TOKEN0,
  UNIV2_FIXTURE_TOKEN1,
} from "../architecture-migration-fixture-replay.js";
import {
  normalizeBaselineUniv2EnumeratedRouteItem,
  normalizeBaselineUniv2EdgeItem,
} from "../architecture-migration-baseline-normalizer.js";
import type {
  RawMigrationSemanticItem,
} from "../architecture-migration-parity-runner.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_500,
  hash: `0x${"51".repeat(32)}`,
  generation: 50,
});

/**
 * Replicates the frozen-ds baseline exporter edge item for the fixture
 * pool: legacy canonicalEdgeId (tuple execution-variant key) plus the
 * baselineFacts the normalizer consumes.
 */
function legacyFixtureEdgeItem(
  edge: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const value = edge.value as {
    readonly tokenIn: string;
    readonly tokenOut: string;
  };
  const tokenIn = value.tokenIn.toLowerCase();
  const tokenOut = value.tokenOut.toLowerCase();
  const pool = UNIV2_FIXTURE_POOL.toLowerCase();
  const oldId = [
    "univ2-standard",
    pool,
    pool,
    `${tokenIn}>${tokenOut}`,
    JSON.stringify(["univ2-swap", null, null, null, null]),
  ].join("\u001f");
  return Object.freeze({
    id: oldId,
    value: Object.freeze({
      canonicalEdgeId: oldId,
      tokenIn,
      tokenOut,
      adapterId: "univ2-swap",
      baselineFacts: Object.freeze({
        familyId: "univ2-standard",
        pool,
        token0: UNIV2_FIXTURE_TOKEN0.toLowerCase(),
        token1: UNIV2_FIXTURE_TOKEN1.toLowerCase(),
        tokenIn,
        tokenOut,
        feeBps: "30",
        factory: UNIV2_FIXTURE_FACTORY.toLowerCase(),
        reversePool: pool,
      }),
    }),
  });
}

async function main(): Promise<void> {
  const familyCase = await captureUniv2FixtureCase({ source: SOURCE });
  const edges = familyCase.stages.edges!.items;
  assert.equal(edges.length, 2);
  for (const edge of edges) {
    const normalized = normalizeBaselineUniv2EdgeItem(
      legacyFixtureEdgeItem(edge),
    );
    assert.deepEqual(normalized, edge);
  }

  const enumerated = familyCase.stages.enumeratedRoutes!.items;
  assert.equal(enumerated.length, 2);
  for (const route of enumerated) {
    const legacyRoute = {
      ...legacyFixtureEdgeItem(route),
      value: {
        ...(legacyFixtureEdgeItem(route).value as Record<string, unknown>),
        order: (route.value as { readonly order: number }).order,
      },
    };
    const normalized = normalizeBaselineUniv2EnumeratedRouteItem(legacyRoute);
    assert.deepEqual(normalized, route);
  }
  assert.throws(
    () => normalizeBaselineUniv2EnumeratedRouteItem(
      legacyFixtureEdgeItem(enumerated[0]!),
    ),
    /must carry a non-negative order/,
  );

  const passthrough = Object.freeze({
    id: "legacy-unknown-family",
    value: Object.freeze({ canonicalEdgeId: "legacy-unknown-family" }),
  });
  assert.equal(
    normalizeBaselineUniv2EdgeItem(passthrough),
    passthrough,
    "unknown family without baselineFacts must pass through unchanged",
  );

  const mismatchedFee = legacyFixtureEdgeItem(edges[0]!);
  assert.throws(
    () => normalizeBaselineUniv2EdgeItem({
      ...mismatchedFee,
      value: {
        ...(mismatchedFee.value as Record<string, unknown>),
        baselineFacts: {
          ...(mismatchedFee.value as { baselineFacts: Record<string, unknown> })
            .baselineFacts,
          feeBps: "300",
        },
      },
    }),
    /does not match factory rule/,
    "legacy fee that contradicts the factory rule must fail closed",
  );

  console.log("architecture-migration baseline normalizer PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

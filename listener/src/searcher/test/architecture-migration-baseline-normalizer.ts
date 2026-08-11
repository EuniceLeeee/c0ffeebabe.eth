import assert from "node:assert/strict";
import {
  captureUniv2FixtureCase,
  captureUniv2RealCase,
  captureUniv3FixtureCase,
  MIGRATION_CAPTURE_EXECUTOR,
  UNIV2_CAPTURE_EXACT_AMOUNT_IN,
  UNIV2_FIXTURE_FACTORY,
  UNIV2_FIXTURE_POOL,
  UNIV2_FIXTURE_TOKEN0,
  UNIV2_FIXTURE_TOKEN1,
  UNIV3_FIXTURE_FACTORY,
  UNIV3_FIXTURE_POOL,
  UNIV3_FIXTURE_TOKEN0,
  UNIV3_FIXTURE_TOKEN1,
} from "../architecture-migration-fixture-replay.js";
import {
  normalizeBaselineUniv3EdgeItem,
  normalizeBaselineUniv3EnumeratedRouteItem,
  normalizeBaselineUniv3ExactQuoteItem,
  normalizeBaselineUniv3ExecutionFragmentItem,
  normalizeBaselineUniv3FinalSimulationItem,
  normalizeBaselineUniv3InstanceItem,
  normalizeBaselineUniv3PriceItem,
  normalizeBaselineUniv2InstanceItem,
  normalizeBaselineUniv2ExecutionFragmentItem,
  normalizeBaselineUniv2ExactQuoteItem,
  normalizeBaselineUniv2FinalSimulationItem,
  normalizeBaselineUniv2PriceItem,
  normalizeBaselineUniv2EnumeratedRouteItem,
  normalizeBaselineUniv2EdgeItem,
} from "../architecture-migration-baseline-normalizer.js";
import type {
  RawMigrationSemanticItem,
} from "../architecture-migration-parity-runner.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import { quoteV2ExactInput } from
  "../solver/v2-constant-product-math.js";
import { MAX_SQRT_RATIO, MIN_SQRT_RATIO } from
  "../solver/v3-math.js";
import { UNIV3_QUOTER_V2, UNIV3_SWAP_ROUTER } from
  "../venues/swaps/univ3-abi.js";

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

  const real = await captureUniv2RealCase({
    source: SOURCE,
    pool: UNIV2_FIXTURE_POOL,
    tokenA: UNIV2_FIXTURE_TOKEN0,
    tokenB: UNIV2_FIXTURE_TOKEN1,
    reserves: { reserve0: "1000000", reserve1: "2000000" },
  });
  const exactQuotes = real.stages.exactQuotes!.items;
  assert.equal(exactQuotes.length, 2);
  for (const quote of exactQuotes) {
    const value = quote.value as {
      readonly amountIn: string;
      readonly amountOut: string;
      readonly feeBps: string;
    };
    const legacyQuote = {
      ...legacyFixtureEdgeItem(quote),
      value: {
        ...(legacyFixtureEdgeItem(quote).value as Record<string, unknown>),
        amountIn: value.amountIn,
        amountOut: value.amountOut,
        feeBps: value.feeBps,
      },
    };
    const normalized = normalizeBaselineUniv2ExactQuoteItem(legacyQuote);
    assert.deepEqual(normalized, quote);
  }

  const executions = real.stages.executionFragments!.items;
  const finalSims = real.stages.finalSimulations!.items;
  assert.equal(executions.length, 2);
  assert.equal(finalSims.length, 2);
  for (const exec of executions) {
    const value = exec.value as {
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly amountIn: string;
      readonly amountOut: string;
      readonly minAmountOut: string;
    };
    const tokenIn = value.tokenIn.toLowerCase();
    const tokenOut = value.tokenOut.toLowerCase();
    const zeroForOne =
      tokenIn === UNIV2_FIXTURE_TOKEN0.toLowerCase();
    const amountOut = quoteV2ExactInput(
      zeroForOne ? 1_000_000n : 2_000_000n,
      zeroForOne ? 2_000_000n : 1_000_000n,
      UNIV2_CAPTURE_EXACT_AMOUNT_IN,
      30n,
    );
    const legacyBase = legacyFixtureEdgeItem(exec);
    const legacyExec = {
      ...legacyBase,
      id: `${legacyBase.id}\u001fexec:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
      value: {
        ...(legacyBase.value as Record<string, unknown>),
        amountIn: value.amountIn,
        amountOut: value.amountOut,
        minAmountOut: value.minAmountOut,
        node: {
          adapterId: "univ2-swap",
          target: UNIV2_FIXTURE_POOL.toLowerCase(),
          tokenIn,
          tokenOut,
          amount: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          params: {
            amount0Out: (zeroForOne ? 0n : amountOut).toString(),
            amount1Out: (zeroForOne ? amountOut : 0n).toString(),
            to: MIGRATION_CAPTURE_EXECUTOR,
          },
          children: [{
            adapterId: "erc20-transfer",
            target: tokenIn,
            tokenIn,
            tokenOut: tokenIn,
            amount: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
            params: {
              to: UNIV2_FIXTURE_POOL.toLowerCase(),
              amount: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
            },
            children: [],
          }],
        },
      },
    };
    const normalizedExec = normalizeBaselineUniv2ExecutionFragmentItem(
      legacyExec,
    );
    assert.deepEqual(normalizedExec, exec);
  }
  for (const sim of finalSims) {
    const value = sim.value as {
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly amountIn: string;
      readonly amountOut: string;
      readonly minAmountOut: string;
    };
    const tokenIn = value.tokenIn.toLowerCase();
    const tokenOut = value.tokenOut.toLowerCase();
    const legacyBase = legacyFixtureEdgeItem(sim);
    const legacySim = {
      ...legacyBase,
      id: `${legacyBase.id}\u001fsim:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
      value: {
        ...(legacyBase.value as Record<string, unknown>),
        amountIn: value.amountIn,
        amountOut: value.amountOut,
        minAmountOut: value.minAmountOut,
        effects: [
          {
            kind: "token-delta",
            token: tokenIn,
            account: "executor",
            direction: "decrease",
          },
          {
            kind: "token-delta",
            token: tokenIn,
            account: "route-target",
            direction: "increase",
          },
          {
            kind: "token-delta",
            token: tokenOut,
            account: "route-target",
            direction: "decrease",
          },
          {
            kind: "token-delta",
            token: tokenOut,
            account: "executor",
            direction: "increase",
          },
        ],
        conservation: "conserved",
        repayment: "satisfied",
        evInput: {
          amountIn: value.amountIn,
          amountOut: value.amountOut,
        },
      },
    };
    const normalizedSim = normalizeBaselineUniv2FinalSimulationItem(
      legacySim,
    );
    assert.deepEqual(normalizedSim, sim);
  }

  const instances = real.stages.instances!.items;
  assert.equal(instances.length, 1);
  const pool = UNIV2_FIXTURE_POOL.toLowerCase();
  const legacyInstance = Object.freeze({
    id: `univ2-standard\u001f${pool}`,
    value: Object.freeze({
      familyId: "univ2-standard",
      stateKey: pool,
      instanceFingerprint: "11".repeat(32),
      specFingerprint: "22".repeat(32),
      baselineFacts: Object.freeze({
        familyId: "univ2-standard",
        pool,
        token0: UNIV2_FIXTURE_TOKEN0.toLowerCase(),
        token1: UNIV2_FIXTURE_TOKEN1.toLowerCase(),
        tokenIn: UNIV2_FIXTURE_TOKEN0.toLowerCase(),
        tokenOut: UNIV2_FIXTURE_TOKEN1.toLowerCase(),
        feeBps: "30",
        factory: UNIV2_FIXTURE_FACTORY.toLowerCase(),
        reversePool: pool,
      }),
    }),
  });
  assert.deepEqual(
    normalizeBaselineUniv2InstanceItem(legacyInstance),
    instances[0],
  );

  const prices = real.stages.prices!.items;
  assert.equal(prices.length, 2);
  for (const price of prices) {
    const priceValue = price.value as {
      readonly stateKey: string;
      readonly mid: {
        readonly kind: string;
        readonly pool: string;
        readonly mid: number;
        readonly feeBps: number;
        readonly reserveA: bigint | string;
        readonly reserveB: bigint | string;
        readonly depthProxy: number;
        readonly edges: readonly {
          readonly tokenIn: string;
          readonly tokenOut: string;
        }[];
      };
    };
    const tokenIn = priceValue.mid.edges[0]!.tokenIn.toLowerCase();
    const tokenOut = priceValue.mid.edges[0]!.tokenOut.toLowerCase();
    const legacyPrice = Object.freeze({
      id: price.id,
      value: Object.freeze({
        stateKey: priceValue.stateKey,
        mid: Object.freeze({
          ...priceValue.mid,
          edges: Object.freeze([Object.freeze({
            adapterId: "univ2-swap",
            instanceKey: pool,
            target: pool,
            tokenIn,
            tokenOut,
            poolToken0: UNIV2_FIXTURE_TOKEN0.toLowerCase(),
            poolToken1: UNIV2_FIXTURE_TOKEN1.toLowerCase(),
            v2FeeBps: 30n,
            slotKind: "swap",
            edgeKind: "swap",
            leavesStandingPosition: false,
          })]),
        }),
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
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          normalizeBaselineUniv2PriceItem(legacyPrice),
          (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
        ),
      ),
      JSON.parse(
        JSON.stringify(price, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value),
      ),
      "price normalizer must match the JSON-side capture shape",
    );
  }

  const univ3 = await captureUniv3FixtureCase({ source: SOURCE });
  const univ3Facts = (tokenIn: string, tokenOut: string) => Object.freeze({
    familyId: "univ3-standard",
    pool: UNIV3_FIXTURE_POOL.toLowerCase(),
    token0: UNIV3_FIXTURE_TOKEN0.toLowerCase(),
    token1: UNIV3_FIXTURE_TOKEN1.toLowerCase(),
    tokenIn: tokenIn.toLowerCase(),
    tokenOut: tokenOut.toLowerCase(),
    fee: "500",
    tickSpacing: 1,
    factory: UNIV3_FIXTURE_FACTORY.toLowerCase(),
    reversePool: UNIV3_FIXTURE_POOL.toLowerCase(),
    quoter: UNIV3_QUOTER_V2.toLowerCase(),
    router: UNIV3_SWAP_ROUTER.toLowerCase(),
    quoterProvenance: "factory-bound-infrastructure",
  });
  const legacyUniv3EdgeItem = (
    edge: RawMigrationSemanticItem,
  ): RawMigrationSemanticItem => {
    const value = edge.value as {
      readonly tokenIn: string;
      readonly tokenOut: string;
    };
    const tokenIn = value.tokenIn.toLowerCase();
    const tokenOut = value.tokenOut.toLowerCase();
    const pool = UNIV3_FIXTURE_POOL.toLowerCase();
    const oldId = [
      "univ3-standard",
      pool,
      pool,
      `${tokenIn}>${tokenOut}`,
      JSON.stringify(["univ3-swap", null, null, null, null]),
    ].join("\u001f");
    return Object.freeze({
      id: oldId,
      value: Object.freeze({
        canonicalEdgeId: oldId,
        tokenIn,
        tokenOut,
        adapterId: "univ3-swap",
        baselineFacts: univ3Facts(tokenIn, tokenOut),
      }),
    });
  };
  for (const edge of univ3.stages.edges!.items) {
    assert.deepEqual(
      normalizeBaselineUniv3EdgeItem(legacyUniv3EdgeItem(edge)),
      edge,
    );
  }
  const univ3Instances = univ3.stages.instances!.items;
  assert.equal(univ3Instances.length, 1);
  const legacyUniv3Instance = Object.freeze({
    id: `univ3-standard\u001f${UNIV3_FIXTURE_POOL.toLowerCase()}`,
    value: Object.freeze({
      familyId: "univ3-standard",
      stateKey: UNIV3_FIXTURE_POOL.toLowerCase(),
      instanceFingerprint: "11".repeat(32),
      specFingerprint: "22".repeat(32),
      baselineFacts: univ3Facts(
        UNIV3_FIXTURE_TOKEN0,
        UNIV3_FIXTURE_TOKEN1,
      ),
    }),
  });
  assert.deepEqual(
    normalizeBaselineUniv3InstanceItem(legacyUniv3Instance),
    univ3Instances[0],
  );
  for (const route of univ3.stages.enumeratedRoutes!.items) {
    const legacyRoute = {
      ...legacyUniv3EdgeItem(route),
      value: {
        ...(legacyUniv3EdgeItem(route).value as Record<string, unknown>),
        order: (route.value as { readonly order: number }).order,
      },
    };
    assert.deepEqual(
      normalizeBaselineUniv3EnumeratedRouteItem(legacyRoute),
      route,
    );
  }
  for (const quote of univ3.stages.exactQuotes!.items) {
    const value = quote.value as {
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly amountIn: string;
      readonly amountOut: string;
    };
    const legacyQuote = {
      ...legacyUniv3EdgeItem(quote),
      id: `${legacyUniv3EdgeItem(quote).id}\u001fexact:${value.amountIn}`,
      value: {
        ...(legacyUniv3EdgeItem(quote).value as Record<string, unknown>),
        amountIn: value.amountIn,
        amountOut: value.amountOut,
      },
    };
    assert.deepEqual(
      normalizeBaselineUniv3ExactQuoteItem(legacyQuote),
      quote,
    );
  }
  for (const exec of univ3.stages.executionFragments!.items) {
    const value = exec.value as {
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly amountIn: string;
      readonly amountOut: string;
      readonly minAmountOut: string;
    };
    const tokenIn = value.tokenIn.toLowerCase();
    const tokenOut = value.tokenOut.toLowerCase();
    const zeroForOne = tokenIn === UNIV3_FIXTURE_TOKEN0.toLowerCase();
    const legacyBase = legacyUniv3EdgeItem(exec);
    const legacyExec = {
      ...legacyBase,
      id: `${legacyBase.id}\u001fexec:${value.amountIn}`,
      value: {
        ...(legacyBase.value as Record<string, unknown>),
        amountIn: value.amountIn,
        amountOut: value.amountOut,
        minAmountOut: value.minAmountOut,
        node: {
          adapterId: "univ3-swap",
          target: UNIV3_FIXTURE_POOL.toLowerCase(),
          tokenIn,
          tokenOut,
          amount: value.amountIn,
          params: {
            zeroForOne,
            amountSpecified: value.amountIn,
            sqrtPriceLimit: (zeroForOne
              ? MIN_SQRT_RATIO + 1n
              : MAX_SQRT_RATIO - 1n).toString(),
          },
          children: [{
            adapterId: "erc20-transfer",
            target: tokenIn,
            tokenIn,
            tokenOut: tokenIn,
            amount: value.amountIn,
            params: {
              to: UNIV3_FIXTURE_POOL.toLowerCase(),
              amount: value.amountIn,
            },
            children: [],
          }],
        },
      },
    };
    assert.deepEqual(
      normalizeBaselineUniv3ExecutionFragmentItem(legacyExec),
      exec,
    );
  }
  for (const sim of univ3.stages.finalSimulations!.items) {
    const value = sim.value as {
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly amountIn: string;
      readonly amountOut: string;
      readonly minAmountOut: string;
    };
    const tokenIn = value.tokenIn.toLowerCase();
    const tokenOut = value.tokenOut.toLowerCase();
    const legacyBase = legacyUniv3EdgeItem(sim);
    const legacySim = {
      ...legacyBase,
      id: `${legacyBase.id}\u001fsim:${value.amountIn}`,
      value: {
        ...(legacyBase.value as Record<string, unknown>),
        amountIn: value.amountIn,
        amountOut: value.amountOut,
        minAmountOut: value.minAmountOut,
        effects: [
          {
            kind: "token-delta",
            token: tokenIn,
            account: "executor",
            direction: "decrease",
          },
          {
            kind: "token-delta",
            token: tokenIn,
            account: "route-target",
            direction: "increase",
          },
          {
            kind: "token-delta",
            token: tokenOut,
            account: "route-target",
            direction: "decrease",
          },
          {
            kind: "token-delta",
            token: tokenOut,
            account: "executor",
            direction: "increase",
          },
        ],
        conservation: "conserved",
        repayment: "satisfied",
        evInput: {
          amountIn: value.amountIn,
          amountOut: value.amountOut,
        },
      },
    };
    assert.deepEqual(
      normalizeBaselineUniv3FinalSimulationItem(legacySim),
      sim,
    );
  }
  for (const price of univ3.stages.prices!.items) {
    const priceValue = price.value as {
      readonly stateKey: string;
      readonly mid: {
        readonly kind: string;
        readonly pool: string;
        readonly mid: number;
        readonly feeBps: number;
        readonly reserveA: bigint | string;
        readonly reserveB: bigint | string;
        readonly sqrtABX96: bigint | string;
        readonly liquidity: bigint | string;
        readonly depthProxy: number;
        readonly edges: readonly {
          readonly tokenIn: string;
          readonly tokenOut: string;
        }[];
      };
    };
    const tokenIn = priceValue.mid.edges[0]!.tokenIn.toLowerCase();
    const tokenOut = priceValue.mid.edges[0]!.tokenOut.toLowerCase();
    const legacyPrice = Object.freeze({
      id: price.id,
      value: Object.freeze({
        stateKey: priceValue.stateKey,
        mid: Object.freeze({
          ...priceValue.mid,
          edges: Object.freeze([Object.freeze({
            adapterId: "univ3-swap",
            instanceKey: UNIV3_FIXTURE_POOL.toLowerCase(),
            target: UNIV3_FIXTURE_POOL.toLowerCase(),
            tokenIn,
            tokenOut,
            poolToken0: UNIV3_FIXTURE_TOKEN0.toLowerCase(),
            poolToken1: UNIV3_FIXTURE_TOKEN1.toLowerCase(),
            v3Fee: 500,
            v3TickSpacing: 1,
            factory: UNIV3_FIXTURE_FACTORY.toLowerCase(),
            edgeKind: "swap",
            leavesStandingPosition: false,
          })]),
        }),
        baselineFacts: univ3Facts(tokenIn, tokenOut),
      }),
    });
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          normalizeBaselineUniv3PriceItem(legacyPrice),
          (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
        ),
      ),
      JSON.parse(
        JSON.stringify(price, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value),
      ),
    );
  }

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

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCaptureReproducible,
  architectureMigrationSideJson,
  buildFixtureCaptureCorpus,
  buildUniv2CommonGraph,
  fixtureStateAnchor,
  frameworkBlockedStage,
  generateArchitectureMigrationSideCapture,
  validateArchitectureMigrationCaptureCorpus,
  writeArchitectureMigrationSideCapture,
} from "../architecture-migration-capture.js";
import {
  captureUniv2FixtureCase,
  captureUniv2RealCase,
  captureUniv3FixtureCase,
  captureUniv3RealCase,
  captureUniv4FixtureCase,
  captureUniv4RealCase,
  captureFundingFixtureCase,
  capturePsmFixtureCase,
  captureWstethFixtureCase,
  captureGoldxFixtureCase,
  captureRocksolidFixtureCase,
  captureMetronomeHgUsdcFixtureCase,
  captureMetronomeSynthFixtureCase,
  captureErc4626SiloRedeemFixtureCase,
  captureErc4626FixtureCase,
  captureEtherTokenNativeRedeemFixtureCase,
  captureSelfBurnNativeFixtureCase,
  captureAstraMultiTokenFixtureCase,
  captureEigenpieFixtureCase,
  captureCurveUnderlyingFixtureCase,
  captureFluidDexFixtureCase,
  captureAngstromV4FixtureCase,
  captureDodoV2FixtureCase,
  MIGRATION_CAPTURE_EXECUTOR,
  UNIV3_FIXTURE_POOL,
  UNIV3_FIXTURE_TOKEN0,
  UNIV3_FIXTURE_TOKEN1,
} from "../architecture-migration-fixture-replay.js";
import {
  createArchitectureMigrationProductionCaptureIssuer,
  runArchitectureMigrationParityFiles,
  buildArchitectureMigrationSideCapture,
  ARCHITECTURE_MIGRATION_STAGES,
} from "../architecture-migration-parity-runner.js";
import type { RawMigrationStageCapture } from
  "../architecture-migration-parity-runner.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_500,
  hash: `0x${"51".repeat(32)}`,
  generation: 50,
});

function corpusFor(captureId: string, commit: string, productionClosureHash: string) {
  return {
    ...buildFixtureCaptureCorpus({
      captureId,
      commit,
      source: SOURCE,
      familyCases: [],
    }),
    productionClosureHash,
  };
}

async function testCorpusValidation(): Promise<void> {
  const valid = corpusFor("baseline", "a".repeat(40), "11".repeat(32));
  assert.doesNotThrow(() => validateArchitectureMigrationCaptureCorpus(valid));
  assert.throws(
    () => validateArchitectureMigrationCaptureCorpus({ ...valid, captureId: "" }),
    /captureId must be a non-empty string/,
  );
  assert.throws(
    () => validateArchitectureMigrationCaptureCorpus({
      ...valid,
      evidenceRefs: [],
    }),
    /evidenceRefs must be non-empty/,
  );
  assert.throws(
    () => validateArchitectureMigrationCaptureCorpus({
      ...valid,
      stateAnchors: [],
    }),
    /stateAnchors must be non-empty/,
  );
  assert.throws(
    () => validateArchitectureMigrationCaptureCorpus({
      ...valid,
      familyCases: null,
    }),
    /familyCases must be an array/,
  );
}

async function testFixtureReplayProducesCanonicalCase(): Promise<void> {
  const familyCase = await captureUniv2FixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "univ2-standard");
  assert.equal(familyCase.stateAnchorNumber, SOURCE.number);
  assert.equal(familyCase.stages.instances?.status, "exercised");
  assert.equal(familyCase.stages.edges?.status, "exercised");
  assert.equal(familyCase.stages.enumeratedRoutes?.status, "exercised");
  assert.equal(familyCase.stages.enumeratedRoutes?.items.length, 2);
  assert.equal(familyCase.stages.prices?.status, "framework-blocked");
  assert.equal(familyCase.stages.finalSimulations?.status, "framework-blocked");
  assert((familyCase.stages.instances?.items.length ?? 0) >= 1);
  assert((familyCase.stages.edges?.items.length ?? 0) >= 1);
  const commonGraph = buildUniv2CommonGraph({
    source: SOURCE,
    edgeItems: familyCase.stages.edges!.items,
    enumeratedRouteItems: familyCase.stages.enumeratedRoutes!.items,
    evidenceRefs: familyCase.stages.instances!.evidenceRefs,
  });
  assert.equal(commonGraph.stages.edges?.status, "exercised");
  assert.equal(commonGraph.stages.edges?.items.length, 2);
  assert.equal(commonGraph.stages.enumeratedRoutes?.status, "exercised");
  assert.equal(commonGraph.stages.finalSimulations?.status, "framework-blocked");
}

async function testRealCaseUsesDescriptorPoolAndBlocksPrices(): Promise<void> {
  const realPool = `0x${"61".repeat(20)}`;
  const realTokenA = `0x${"71".repeat(20)}`;
  const realTokenB = `0x${"72".repeat(20)}`;
  const familyCase = await captureUniv2RealCase({
    source: SOURCE,
    pool: realPool,
    tokenA: realTokenA,
    tokenB: realTokenB,
  });
  assert.equal(familyCase.stages.prices?.status, "framework-blocked");
  assert(familyCase.stages.edges!.items[0]!.id.includes(realPool.toLowerCase()));
  assert.equal(familyCase.stages.instances?.items.length, 1);
  const pricesOn = await captureUniv2RealCase({
    source: SOURCE,
    pool: realPool,
    tokenA: realTokenA,
    tokenB: realTokenB,
    reserves: {
      reserve0: "1000000000000000000",
      reserve1: "2000000000000000000",
    },
  });
  assert.equal(pricesOn.stages.prices?.status, "exercised");
  assert.equal(pricesOn.stages.prices?.items.length, 2);
  assert.equal(pricesOn.stages.enumeratedRoutes?.status, "exercised");
  assert.equal(pricesOn.stages.exactQuotes?.status, "exercised");
  assert.equal(pricesOn.stages.exactQuotes?.items.length, 2);
  assert.equal(pricesOn.stages.executionFragments?.status, "exercised");
  assert.equal(pricesOn.stages.executionFragments?.items.length, 2);
  assert.equal(pricesOn.stages.finalSimulations?.status, "exercised");
  assert.equal(pricesOn.stages.finalSimulations?.items.length, 2);
  assert(pricesOn.stages.prices!.items[0]!.id.includes(
    `${realPool.toLowerCase()}:${realTokenA.toLowerCase()}>` +
      `${realTokenB.toLowerCase()}`,
  ));
}

async function testRealReservesBilateralExactAndEnumerationParity(): Promise<void> {
  const familyCase = await captureUniv2RealCase({
    source: SOURCE,
    pool: `0x${"41".repeat(20)}`,
    tokenA: `0x${"43".repeat(20)}`,
    tokenB: `0x${"44".repeat(20)}`,
    reserves: { reserve0: "1000000", reserve1: "2000000" },
  });
  const evidenceRefs = familyCase.stages.instances!.evidenceRefs;
  const edges = familyCase.stages.edges!.items;
  const enumerated = familyCase.stages.enumeratedRoutes!.items;
  const exact = familyCase.stages.exactQuotes!.items;
  const pool = `0x${"41".repeat(20)}`;
  const legacyEdgeItem = (edge: (typeof edges)[number]) => {
    const value = edge.value as {
      readonly tokenIn: string;
      readonly tokenOut: string;
    };
    const tokenIn = value.tokenIn.toLowerCase();
    const tokenOut = value.tokenOut.toLowerCase();
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
          token0: `0x${"43".repeat(20)}`,
          token1: `0x${"44".repeat(20)}`,
          tokenIn,
          tokenOut,
          feeBps: "30",
          factory: `0x${"42".repeat(20)}`,
          reversePool: pool,
        }),
      }),
    });
  };
  const legacyEdges = edges.map(legacyEdgeItem);
  const legacyInstances = familyCase.stages.instances!.items.map((item) => {
    const value = item.value as { readonly instanceKey: string };
    return Object.freeze({
      id: `univ2-standard\u001f${pool}`,
      value: Object.freeze({
        familyId: "univ2-standard",
        stateKey: value.instanceKey.toLowerCase(),
        instanceFingerprint: "11".repeat(32),
        specFingerprint: "22".repeat(32),
        baselineFacts: Object.freeze({
          familyId: "univ2-standard",
          pool,
          token0: `0x${"43".repeat(20)}`,
          token1: `0x${"44".repeat(20)}`,
          tokenIn: `0x${"43".repeat(20)}`,
          tokenOut: `0x${"44".repeat(20)}`,
          feeBps: "30",
          factory: `0x${"42".repeat(20)}`,
          reversePool: pool,
        }),
      }),
    });
  });
  const legacyPrices = familyCase.stages.prices!.items.map((price) => {
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
    return Object.freeze({
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
            poolToken0: `0x${"43".repeat(20)}`,
            poolToken1: `0x${"44".repeat(20)}`,
            v2FeeBps: 30n,
            slotKind: "swap",
            edgeKind: "swap",
            leavesStandingPosition: false,
          })]),
        }),
        baselineFacts: Object.freeze({
          familyId: "univ2-standard",
          pool,
          token0: `0x${"43".repeat(20)}`,
          token1: `0x${"44".repeat(20)}`,
          tokenIn,
          tokenOut,
          feeBps: "30",
          factory: `0x${"42".repeat(20)}`,
          reversePool: pool,
        }),
      }),
    });
  });
  const legacyEnumerated = [...legacyEdges]
    .map((edge) => edge.value as {
      readonly tokenIn: string;
      readonly tokenOut: string;
    })
    .map((value) => Object.freeze({
      routeKey: [
        "univ2-standard",
        pool,
        value.tokenIn.toLowerCase(),
        value.tokenOut.toLowerCase(),
      ].join("\u001f"),
      value,
    }))
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map(({ value }, order) => {
      const edge = legacyEdges.find((candidate) =>
        (candidate.value as {
          readonly tokenIn: string;
          readonly tokenOut: string;
        }).tokenIn === (value as { readonly tokenIn: string }).tokenIn &&
        (candidate.value as {
          readonly tokenIn: string;
          readonly tokenOut: string;
        }).tokenOut === (value as { readonly tokenOut: string }).tokenOut
      )!;
      return Object.freeze({
        id: edge.id,
        value: Object.freeze({
          ...(edge.value as Record<string, unknown>),
          order,
        }),
      });
    });
  const legacyExact = exact.map((quote) => {
    const quoteValue = quote.value as {
      readonly amountIn: string;
      readonly amountOut: string;
      readonly feeBps: string;
    };
    const legacyEdge = legacyEdgeItem(quote);
    return Object.freeze({
      id: `${legacyEdge.id}\u001fexact:${quoteValue.amountIn}`,
      value: Object.freeze({
        ...(legacyEdge.value as Record<string, unknown>),
        amountIn: quoteValue.amountIn,
        amountOut: quoteValue.amountOut,
        feeBps: quoteValue.feeBps,
      }),
    });
  });
  const legacyExecution = familyCase.stages.executionFragments!.items.map(
    (exec) => {
      const execValue = exec.value as {
        readonly tokenIn: string;
        readonly tokenOut: string;
        readonly amountIn: string;
        readonly amountOut: string;
        readonly minAmountOut: string;
      };
      const tokenIn = execValue.tokenIn.toLowerCase();
      const tokenOut = execValue.tokenOut.toLowerCase();
      const zeroForOne = tokenIn === `0x${"43".repeat(20)}`;
      const legacyEdge = legacyEdgeItem(exec);
      const amountOut = BigInt(execValue.amountOut);
      return Object.freeze({
        id: `${legacyEdge.id}\u001fexec:${execValue.amountIn}`,
        value: Object.freeze({
          ...(legacyEdge.value as Record<string, unknown>),
          amountIn: execValue.amountIn,
          amountOut: execValue.amountOut,
          minAmountOut: execValue.minAmountOut,
          node: Object.freeze({
            adapterId: "univ2-swap",
            target: pool,
            tokenIn,
            tokenOut,
            amount: execValue.amountIn,
            params: Object.freeze({
              amount0Out: (zeroForOne ? 0n : amountOut).toString(),
              amount1Out: (zeroForOne ? amountOut : 0n).toString(),
              to: MIGRATION_CAPTURE_EXECUTOR,
            }),
            children: Object.freeze([Object.freeze({
              adapterId: "erc20-transfer",
              target: tokenIn,
              tokenIn,
              tokenOut: tokenIn,
              amount: execValue.amountIn,
              params: Object.freeze({
                to: pool,
                amount: execValue.amountIn,
              }),
              children: Object.freeze([]),
            })]),
          }),
        }),
      });
    },
  );
  const legacyFinalSims = familyCase.stages.finalSimulations!.items.map(
    (sim) => {
      const simValue = sim.value as {
        readonly tokenIn: string;
        readonly tokenOut: string;
        readonly amountIn: string;
        readonly amountOut: string;
        readonly minAmountOut: string;
      };
      const tokenIn = simValue.tokenIn.toLowerCase();
      const tokenOut = simValue.tokenOut.toLowerCase();
      const legacyEdge = legacyEdgeItem(sim);
      return Object.freeze({
        id: `${legacyEdge.id}\u001fsim:${simValue.amountIn}`,
        value: Object.freeze({
          ...(legacyEdge.value as Record<string, unknown>),
          amountIn: simValue.amountIn,
          amountOut: simValue.amountOut,
          minAmountOut: simValue.minAmountOut,
          effects: Object.freeze([
            Object.freeze({
              kind: "token-delta",
              token: tokenIn,
              account: "executor",
              direction: "decrease",
            }),
            Object.freeze({
              kind: "token-delta",
              token: tokenIn,
              account: "route-target",
              direction: "increase",
            }),
            Object.freeze({
              kind: "token-delta",
              token: tokenOut,
              account: "route-target",
              direction: "decrease",
            }),
            Object.freeze({
              kind: "token-delta",
              token: tokenOut,
              account: "executor",
              direction: "increase",
            }),
          ]),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: simValue.amountIn,
            amountOut: simValue.amountOut,
          }),
        }),
      });
    },
  );
  const stage = (
    status: "exercised" | "framework-blocked",
    items: readonly RawMigrationStageCapture["items"][number][],
  ) =>
    Object.freeze({
      status,
      items: Object.freeze(items),
      evidenceRefs,
      blocker: status === "exercised" ? null : "fixture-test-stage",
    });
  const baselineSide = buildArchitectureMigrationSideCapture({
    captureId: "baseline",
    commit: "a".repeat(40),
    productionClosureHash: "11".repeat(32),
    activationManifestHash: "22".repeat(32),
    normalizedConfigHash: "33".repeat(32),
    productionPolicyHash: "44".repeat(32),
    corpusHash: "55".repeat(32),
    evidenceRefs,
    familyCases: [{
      ...familyCase,
      stages: Object.freeze({
        ...familyCase.stages,
        instances: stage("exercised", legacyInstances),
        edges: stage("exercised", legacyEdges),
        prices: stage("exercised", legacyPrices),
        enumeratedRoutes: stage("exercised", legacyEnumerated),
        exactQuotes: stage("exercised", legacyExact),
        executionFragments: stage("exercised", legacyExecution),
        finalSimulations: stage("exercised", legacyFinalSims),
      }),
    }],
    commonGraph: Object.freeze({
      inputFingerprint: familyCase.inputFingerprint,
      stages: Object.freeze({
        edges: stage("exercised", legacyEdges),
        enumeratedRoutes: stage("exercised", legacyEnumerated),
        exactQuotes: stage("exercised", legacyExact),
        executionFragments: stage("exercised", legacyExecution),
        finalSimulations: stage("exercised", legacyFinalSims),
      }),
      crossFamilyBindings: Object.freeze([]),
    }),
  });
  const challengerSide = buildArchitectureMigrationSideCapture({
    captureId: "challenger",
    commit: "b".repeat(40),
    productionClosureHash: "aa".repeat(32),
    activationManifestHash: "22".repeat(32),
    normalizedConfigHash: "33".repeat(32),
    productionPolicyHash: "44".repeat(32),
    corpusHash: "55".repeat(32),
    evidenceRefs,
    familyCases: [familyCase],
    commonGraph: buildUniv2CommonGraph({
      source: SOURCE,
      edgeItems: edges,
      enumeratedRouteItems: enumerated,
      exactQuoteItems: exact,
      executionFragmentItems: familyCase.stages.executionFragments!.items,
      finalSimulationItems: familyCase.stages.finalSimulations!.items,
      evidenceRefs,
    }),
  });
  const directory = await mkdtemp(
    join(tmpdir(), "architecture-migration-real-exact-"),
  );
  try {
    const baselinePath = join(directory, "baseline.json");
    const challengerPath = join(directory, "challenger.json");
    await writeFile(
      baselinePath,
      architectureMigrationSideJson(baselineSide),
    );
    await writeFile(
      challengerPath,
      architectureMigrationSideJson(challengerSide),
    );
    const receipt = await runArchitectureMigrationParityFiles({
      baselinePath,
      challengerPath,
      evidenceClass: "unit-contract",
      mode: "pure-refactor",
      stateAnchors: [fixtureStateAnchor(SOURCE)],
      performanceDiagnostics: {
        wallMs: 100,
        requestCount: 10,
        batchCount: 1,
        peakConcurrency: 1,
      },
    });
    const delta = receipt.commonGraphDelta;
    for (const stageName of [
      "edges",
      "enumeratedRoutes",
      "exactQuotes",
      "executionFragments",
      "finalSimulations",
    ] as const) {
      assert.deepEqual(delta[stageName], {
        missingIds: [],
        addedIds: [],
        changedIds: [],
      });
    }
    assert.deepEqual(delta.baselineBlockedStages, []);
    assert.deepEqual(delta.challengerBlockedStages, []);
    assert.equal(receipt.parityReceipt.assembledCommonGraphParity, true);
    const row = receipt.familyCoverage.find(
      (candidate) => candidate.familyId === "univ2-standard",
    )!;
    assert.equal(row.outcome, "pass");
    assert.equal(receipt.parityReceipt.aggregateVerdict, "partial");
    assert.equal(receipt.parityReceipt.nonPassFamilyIds.length, 21);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function testUniv3FixtureReplayProducesAllStages(): Promise<void> {
  const familyCase = await captureUniv3FixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "univ3-standard");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `univ3 fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 2);
  assert.equal(familyCase.stages.prices?.items.length, 2);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 2);
  assert.equal(familyCase.stages.executionFragments?.items.length, 2);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 2);
}

async function testUniv3RealCaseAllStages(): Promise<void> {
  const familyCase = await captureUniv3RealCase({
    source: SOURCE,
    pool: UNIV3_FIXTURE_POOL,
    tokenA: UNIV3_FIXTURE_TOKEN0,
    tokenB: UNIV3_FIXTURE_TOKEN1,
    fee: "500",
    tickSpacing: 1,
    liquidity: "1000000000000000000",
    sqrtPriceX96: (1n << 96n).toString(),
  });
  assert.equal(familyCase.familyId, "univ3-standard");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `univ3 real ${stage} must be exercised`,
    );
  }
}

async function testUniv4FixtureReplayProducesAllStages(): Promise<void> {
  const familyCase = await captureUniv4FixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "univ4");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `univ4 fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 2);
  assert.equal(familyCase.stages.prices?.items.length, 2);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 2);
  assert.equal(familyCase.stages.executionFragments?.items.length, 2);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 2);
}

async function testUniv4RealCaseAllStages(): Promise<void> {
  const familyCase = await captureUniv4RealCase({
    source: SOURCE,
    currency0: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    currency1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    fee: 3000,
    tickSpacing: 60,
    liquidity: "1000000000000000000",
    sqrtPriceX96: (1n << 96n).toString(),
    lpFee: "3000",
  });
  assert.equal(familyCase.familyId, "univ4");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `univ4 real ${stage} must be exercised`,
    );
  }
}

async function testFundingFixtureCases(): Promise<void> {
  for (const familyId of [
    "flash-loan:balancer-v2",
    "flash-loan:morpho",
  ] as const) {
    const familyCase = await captureFundingFixtureCase({
      familyId,
      source: SOURCE,
    });
    assert.equal(familyCase.familyId, familyId);
    assert.equal(familyCase.stages.failures?.status, "exercised");
    assert.equal(familyCase.stages.executionFragments?.status, "exercised");
    assert.equal(familyCase.stages.executionFragments?.items.length, 2);
    assert.equal(familyCase.stages.finalSimulations?.status, "exercised");
    assert.equal(familyCase.stages.finalSimulations?.items.length, 1);
  }
}

async function testPsmFixtureCase(): Promise<void> {
  const familyCase = await capturePsmFixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "protocol:psm");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `psm fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 1);
  assert.equal(familyCase.stages.prices?.items.length, 1);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 1);
  assert.equal(familyCase.stages.executionFragments?.items.length, 1);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 1);
}

async function testWstethFixtureCase(): Promise<void> {
  const familyCase = await captureWstethFixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "protocol:wsteth");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `wsteth fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 2);
  assert.equal(familyCase.stages.prices?.items.length, 2);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 2);
  assert.equal(familyCase.stages.executionFragments?.items.length, 2);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 2);
}

async function testGoldxFixtureCase(): Promise<void> {
  const familyCase = await captureGoldxFixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "protocol:goldx");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `goldx fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 1);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 1);
}

async function testRocksolidFixtureCase(): Promise<void> {
  const familyCase = await captureRocksolidFixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "protocol:rocksolid");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `rocksolid fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 1);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 1);
}

async function testMetronomeHgUsdcFixtureCase(): Promise<void> {
  const familyCase = await captureMetronomeHgUsdcFixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "protocol:metronome-hgusdc");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `metronome-hgusdc fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 1);
  assert.equal(familyCase.stages.prices?.items.length, 1);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 1);
  assert.equal(familyCase.stages.executionFragments?.items.length, 1);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 1);
}

async function testMetronomeSynthFixtureCase(): Promise<void> {
  const familyCase = await captureMetronomeSynthFixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "protocol:metronome-synth");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `metronome-synth fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 6);
  assert.equal(familyCase.stages.prices?.items.length, 6);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 6);
  assert.equal(familyCase.stages.executionFragments?.items.length, 6);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 6);
}

async function testErc4626SiloRedeemFixtureCase(): Promise<void> {
  const familyCase = await captureErc4626SiloRedeemFixtureCase({
    source: SOURCE,
  });
  assert.equal(familyCase.familyId, "protocol:erc4626-silo-redeem");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `erc4626-silo-redeem fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 1);
  assert.equal(familyCase.stages.prices?.items.length, 1);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 1);
  assert.equal(familyCase.stages.executionFragments?.items.length, 1);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 1);
}

async function testErc4626FixtureCase(): Promise<void> {
  const familyCase = await captureErc4626FixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "protocol:erc4626");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `erc4626 fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 2);
  assert.equal(familyCase.stages.prices?.items.length, 2);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 2);
  assert.equal(familyCase.stages.executionFragments?.items.length, 2);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 2);
}

async function testEtherTokenNativeRedeemFixtureCase(): Promise<void> {
  const familyCase = await captureEtherTokenNativeRedeemFixtureCase({
    source: SOURCE,
  });
  assert.equal(familyCase.familyId, "protocol:ethertoken-native-redeem");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `ethertoken-native-redeem fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 1);
  assert.equal(familyCase.stages.prices?.items.length, 1);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 1);
  assert.equal(familyCase.stages.executionFragments?.items.length, 1);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 1);
}

async function testSelfBurnNativeFixtureCase(): Promise<void> {
  const familyCase = await captureSelfBurnNativeFixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "protocol:self-burn-native");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `self-burn-native fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 1);
  assert.equal(familyCase.stages.prices?.items.length, 1);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 1);
  assert.equal(familyCase.stages.executionFragments?.items.length, 1);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 1);
}

async function testAstraMultiTokenFixtureCase(): Promise<void> {
  const familyCase = await captureAstraMultiTokenFixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "protocol:astra-multitoken");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `astra-multitoken fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 2);
  assert.equal(familyCase.stages.prices?.items.length, 2);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 2);
  assert.equal(familyCase.stages.executionFragments?.items.length, 2);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 2);
}

async function testEigenpieFixtureCase(): Promise<void> {
  const familyCase = await captureEigenpieFixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "protocol:eigenpie");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `eigenpie fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 1);
  assert.equal(familyCase.stages.prices?.items.length, 1);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 1);
  assert.equal(familyCase.stages.executionFragments?.items.length, 1);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 1);
}

async function testCurveUnderlyingFixtureCase(): Promise<void> {
  const familyCase = await captureCurveUnderlyingFixtureCase({
    source: SOURCE,
  });
  assert.equal(familyCase.familyId, "curve-underlying");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `curve-underlying fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 2);
  assert.equal(familyCase.stages.prices?.items.length, 2);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 2);
  assert.equal(familyCase.stages.executionFragments?.items.length, 2);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 2);
}

async function testFluidDexFixtureCase(): Promise<void> {
  const familyCase = await captureFluidDexFixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "fluid-dex");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `fluid-dex fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 2);
  assert.equal(familyCase.stages.prices?.items.length, 2);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 2);
  assert.equal(familyCase.stages.executionFragments?.items.length, 2);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 2);
}

async function testAngstromV4FixtureCase(): Promise<void> {
  const familyCase = await captureAngstromV4FixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "custom-swap:angstrom-v4");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `angstrom-v4 fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 2);
  assert.equal(familyCase.stages.prices?.items.length, 2);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 2);
  assert.equal(familyCase.stages.executionFragments?.items.length, 2);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 2);
}

async function testDodoV2FixtureCase(): Promise<void> {
  const familyCase = await captureDodoV2FixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "custom-swap:dodo-v2");
  for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
    assert.equal(
      familyCase.stages[stage]?.status,
      "exercised",
      `dodo-v2 fixture ${stage} must be exercised`,
    );
  }
  assert.equal(familyCase.stages.edges?.items.length, 2);
  assert.equal(familyCase.stages.prices?.items.length, 2);
  assert.equal(familyCase.stages.exactQuotes?.items.length, 2);
  assert.equal(familyCase.stages.executionFragments?.items.length, 2);
  assert.equal(familyCase.stages.finalSimulations?.items.length, 2);
}

async function testWriteAndGenerateRoundTrip(): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "architecture-migration-capture-"),
  );
  try {
    const outPath = join(directory, "side.json");
    const corpus = corpusFor("baseline", "a".repeat(40), "11".repeat(32));
    const captureId = await writeArchitectureMigrationSideCapture(corpus, outPath);
    assert.equal(captureId, "baseline");
    const written = JSON.parse(await readFile(outPath, "utf8"));
    assert.deepEqual(written, generateArchitectureMigrationSideCapture(corpus));
    assert.equal(written.closure.captureId, "baseline");
    assert(Object.isFrozen(
      generateArchitectureMigrationSideCapture(corpus).closure.evidenceRefs,
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function testEndToEndSealedParity(): Promise<void> {
  const familyCase = await captureUniv2FixtureCase({ source: SOURCE });
  const baselineCorpus = {
    ...corpusFor("baseline", "a".repeat(40), "11".repeat(32)),
    familyCases: [familyCase],
  };
  const challengerCorpus = {
    ...corpusFor("challenger", "b".repeat(40), "aa".repeat(32)),
    familyCases: [familyCase],
  };
  const directory = await mkdtemp(
    join(tmpdir(), "architecture-migration-capture-e2e-"),
  );
  try {
    const baselinePath = join(directory, "baseline.json");
    const challengerPath = join(directory, "challenger.json");
    await writeFile(
      baselinePath,
      architectureMigrationSideJson(
        generateArchitectureMigrationSideCapture(baselineCorpus),
      ),
    );
    await writeFile(
      challengerPath,
      architectureMigrationSideJson(
        generateArchitectureMigrationSideCapture(challengerCorpus),
      ),
    );
    const issuer = createArchitectureMigrationProductionCaptureIssuer();
    const receipt = await runArchitectureMigrationParityFiles({
      baselinePath,
      challengerPath,
      evidenceClass: "sealed-production",
      mode: "pure-refactor",
      stateAnchors: baselineCorpus.stateAnchors,
      performanceDiagnostics: {
        wallMs: 100,
        requestCount: 10,
        batchCount: 1,
        peakConcurrency: 1,
      },
      productionCaptureIssuer: issuer,
    });
    assert.equal(receipt.evidenceClass, "sealed-production");
    assert.equal(receipt.acceptance.eligible, true);
    assert.equal(receipt.parityReceipt.aggregateVerdict, "fail");
    assert.equal(receipt.parityReceipt.nonPassFamilyIds.length, 22);
    assert(receipt.parityReceipt.nonPassFamilyIds.includes("univ2-standard"));
    const univ2Row = receipt.familyCoverage.find(
      (row) => row.familyId === "univ2-standard",
    )!;
    assert.equal(univ2Row.outcome, "framework-blocked");
    assert.equal(
      receipt.familyCoverage.filter((row) => row.outcome === "framework-blocked")
        .length,
      1,
    );
    assert.equal(
      receipt.familyCoverage.filter((row) => row.outcome === "not-exercised")
        .length,
      21,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function testCaptureReproducibility(): Promise<void> {
  const corpus = corpusFor("repro", "a".repeat(40), "11".repeat(32));
  await assertCaptureReproducible(corpus);
  const first = await captureUniv2RealCase({
    source: SOURCE,
    pool: `0x${"61".repeat(20)}`,
    tokenA: `0x${"71".repeat(20)}`,
    tokenB: `0x${"72".repeat(20)}`,
    reserves: { reserve0: "1", reserve1: "2" },
  });
  const second = await captureUniv2RealCase({
    source: SOURCE,
    pool: `0x${"61".repeat(20)}`,
    tokenA: `0x${"71".repeat(20)}`,
    tokenB: `0x${"72".repeat(20)}`,
    reserves: { reserve0: "1", reserve1: "2" },
  });
  assert.deepEqual(first, second, "real capture must be reproducible");
}

/**
 * Legacy-vs-challenger fixture parity: the baseline exporter emits old
 * canonicalEdgeIds plus baselineFacts; the trusted comparator's normalizer
 * must map them to the challenger canonical ids so commonGraph edges have a
 * zero delta while the deep stages honestly remain framework-blocked.
 */
async function testLegacyBaselineCommonGraphEdgesParity(): Promise<void> {
  const familyCase = await captureUniv2FixtureCase({ source: SOURCE });
  const evidenceRefs = familyCase.stages.instances!.evidenceRefs;
  const edges = familyCase.stages.edges!.items;
  const pool = `0x${"41".repeat(20)}`;
  const legacyEdges = edges.map((edge) => {
    const value = edge.value as {
      readonly tokenIn: string;
      readonly tokenOut: string;
    };
    const tokenIn = value.tokenIn.toLowerCase();
    const tokenOut = value.tokenOut.toLowerCase();
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
          token0: `0x${"43".repeat(20)}`,
          token1: `0x${"44".repeat(20)}`,
          tokenIn,
          tokenOut,
          feeBps: "30",
          factory: `0x${"42".repeat(20)}`,
          reversePool: pool,
        }),
      }),
    });
  });
  const commonEdgeStage = Object.freeze({
    status: "exercised" as const,
    items: Object.freeze(legacyEdges),
    evidenceRefs,
    blocker: null,
  });
  const legacyEnumeratedRoutes = [...legacyEdges]
    .map((edge) => edge.value as {
      readonly tokenIn: string;
      readonly tokenOut: string;
    })
    .map((value) => Object.freeze({
      routeKey: [
        "univ2-standard",
        pool,
        value.tokenIn.toLowerCase(),
        value.tokenOut.toLowerCase(),
      ].join("\u001f"),
      value,
    }))
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map(({ value }, order) => {
      const edge = legacyEdges.find((candidate) =>
        (candidate.value as {
          readonly tokenIn: string;
          readonly tokenOut: string;
        }).tokenIn === (value as { readonly tokenIn: string }).tokenIn &&
        (candidate.value as {
          readonly tokenIn: string;
          readonly tokenOut: string;
        }).tokenOut === (value as { readonly tokenOut: string }).tokenOut
      )!;
      return Object.freeze({
        id: edge.id,
        value: Object.freeze({
          ...(edge.value as Record<string, unknown>),
          order,
        }),
      });
    });
  const commonEnumeratedStage = Object.freeze({
    status: "exercised" as const,
    items: Object.freeze(legacyEnumeratedRoutes),
    evidenceRefs,
    blocker: null,
  });
  const baselineSide = buildArchitectureMigrationSideCapture({
    captureId: "baseline",
    commit: "a".repeat(40),
    productionClosureHash: "11".repeat(32),
    activationManifestHash: "22".repeat(32),
    normalizedConfigHash: "33".repeat(32),
    productionPolicyHash: "44".repeat(32),
    corpusHash: "55".repeat(32),
    evidenceRefs,
    familyCases: [{
      ...familyCase,
      stages: Object.freeze({
        ...familyCase.stages,
        edges: commonEdgeStage,
        enumeratedRoutes: commonEnumeratedStage,
      }),
    }],
    commonGraph: Object.freeze({
      inputFingerprint: familyCase.inputFingerprint,
      stages: Object.freeze({
        edges: commonEdgeStage,
        enumeratedRoutes: commonEnumeratedStage,
        exactQuotes: frameworkBlockedStage(
          evidenceRefs,
          "capture-harness-exact-not-wired",
        ),
        executionFragments: frameworkBlockedStage(
          evidenceRefs,
          "capture-harness-execution-not-wired",
        ),
        finalSimulations: frameworkBlockedStage(
          evidenceRefs,
          "capture-harness-final-sim-not-wired",
        ),
      }),
      crossFamilyBindings: Object.freeze([]),
    }),
  });
  const challengerSide = buildArchitectureMigrationSideCapture({
    captureId: "challenger",
    commit: "b".repeat(40),
    productionClosureHash: "aa".repeat(32),
    activationManifestHash: "22".repeat(32),
    normalizedConfigHash: "33".repeat(32),
    productionPolicyHash: "44".repeat(32),
    corpusHash: "55".repeat(32),
    evidenceRefs,
    familyCases: [familyCase],
    commonGraph: buildUniv2CommonGraph({
      source: SOURCE,
      edgeItems: edges,
      enumeratedRouteItems: familyCase.stages.enumeratedRoutes!.items,
      evidenceRefs,
    }),
  });
  const directory = await mkdtemp(
    join(tmpdir(), "architecture-migration-legacy-edges-"),
  );
  try {
    const baselinePath = join(directory, "baseline.json");
    const challengerPath = join(directory, "challenger.json");
    await writeFile(
      baselinePath,
      architectureMigrationSideJson(baselineSide),
    );
    await writeFile(
      challengerPath,
      architectureMigrationSideJson(challengerSide),
    );
    const receipt = await runArchitectureMigrationParityFiles({
      baselinePath,
      challengerPath,
      evidenceClass: "unit-contract",
      mode: "pure-refactor",
      stateAnchors: [fixtureStateAnchor(SOURCE)],
      performanceDiagnostics: {
        wallMs: 100,
        requestCount: 10,
        batchCount: 1,
        peakConcurrency: 1,
      },
    });
    const delta = receipt.commonGraphDelta;
    assert.equal(delta.baselineCaptureMissing, false);
    assert.equal(delta.challengerCaptureMissing, false);
    assert.deepEqual(delta.edges, {
      missingIds: [],
      addedIds: [],
      changedIds: [],
    });
    assert.deepEqual(delta.enumeratedRoutes, {
      missingIds: [],
      addedIds: [],
      changedIds: [],
    });
    assert.deepEqual(delta.baselineBlockedStages, [
      "exactQuotes",
      "executionFragments",
      "finalSimulations",
    ]);
    assert.deepEqual(delta.exactQuotes, {
      missingIds: [],
      addedIds: [],
      changedIds: [],
    });
    assert.deepEqual(delta.executionFragments, {
      missingIds: [],
      addedIds: [],
      changedIds: [],
    });
    assert.deepEqual(delta.finalSimulations, {
      missingIds: [],
      addedIds: [],
      changedIds: [],
    });
    assert.equal(receipt.parityReceipt.assembledCommonGraphParity, false);
    const row = receipt.familyCoverage.find(
      (candidate) => candidate.familyId === "univ2-standard",
    )!;
    assert.equal(row.outcome, "framework-blocked");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testCorpusValidation();
  await testFixtureReplayProducesCanonicalCase();
  await testRealCaseUsesDescriptorPoolAndBlocksPrices();
  await testCaptureReproducibility();
  await testWriteAndGenerateRoundTrip();
  await testEndToEndSealedParity();
  await testLegacyBaselineCommonGraphEdgesParity();
  await testRealReservesBilateralExactAndEnumerationParity();
  await testUniv3FixtureReplayProducesAllStages();
  await testUniv3RealCaseAllStages();
  await testUniv4FixtureReplayProducesAllStages();
  await testUniv4RealCaseAllStages();
  await testFundingFixtureCases();
  await testPsmFixtureCase();
  await testWstethFixtureCase();
  await testGoldxFixtureCase();
  await testRocksolidFixtureCase();
  await testMetronomeHgUsdcFixtureCase();
  await testMetronomeSynthFixtureCase();
  await testErc4626SiloRedeemFixtureCase();
  await testErc4626FixtureCase();
  await testEtherTokenNativeRedeemFixtureCase();
  await testSelfBurnNativeFixtureCase();
  await testAstraMultiTokenFixtureCase();
  await testEigenpieFixtureCase();
  await testCurveUnderlyingFixtureCase();
  await testFluidDexFixtureCase();
  await testAngstromV4FixtureCase();
  await testDodoV2FixtureCase();
  console.log("architecture-migration capture harness PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

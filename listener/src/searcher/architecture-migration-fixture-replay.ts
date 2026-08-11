import assert from "node:assert/strict";
import {
  executeAdapterFamilyLifecycleBatch,
  type AdapterFamilyPublication,
  type PreparedFamilyInstance,
} from "./venues/adapter-family-runtime.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./venues/production-family-composition.js";
import {
  definedFamilyPluginContractSummary,
} from "./venues/adapter-family-plugin.js";
import {
  UNIV2_FAMILY_ID,
} from "./venues/swaps/univ2-family/manifest.js";
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_INTERFACE,
  UNIV2_SWAP_CALL_PATTERN_ID,
  UNIV2_SWAP_SELECTOR,
} from "./venues/swaps/univ2-family/codec.js";
import { univ2Exact } from "./venues/swaps/univ2-family/exact.js";
import { univ2Execution } from "./venues/swaps/univ2-family/execution.js";
import { UNIV3_FAMILY_ID } from "./venues/swaps/univ3-family/manifest.js";
import {
  UNIV3_FACTORY_INTERFACE,
  UNIV3_POOL_INTERFACE,
  UNIV3_QUOTER_V2_INTERFACE,
} from "./venues/swaps/univ3-abi.js";
import { UNIV3_SWAP_CALL_PATTERN_ID } from
  "./venues/swaps/univ3-family/codec.js";
import { univ3Exact } from "./venues/swaps/univ3-family/exact.js";
import { univ3Execution } from "./venues/swaps/univ3-family/execution.js";
import { UNIV4_FAMILY_ID } from "./venues/swaps/univ4-family/manifest.js";
import { UNIV4_SWAP_CALL_PATTERN_ID } from
  "./venues/swaps/univ4-family/codec.js";
import {
  UNIV4_POOL_MANAGER_INTERFACE,
  UNIV4_STATE_VIEW_INTERFACE,
  UNIV4_QUOTER_INTERFACE,
} from "./venues/swaps/univ4-abi.js";
import { v4PoolId } from "./venues/swaps/univ4-common.js";
import { ADDR } from "../shared/constants/addresses.js";
import { univ4Exact } from "./venues/swaps/univ4-family/exact.js";
import { univ4Execution } from "./venues/swaps/univ4-family/execution.js";
import {
  v3SwapExactInput,
  v3SwapToState,
} from "./solver/v3-math.js";
import {
  buildFundingBorrowFragment,
  buildFundingRepaymentFragment,
  executeFundingFamilyLiquidity,
  type FundingFamilyPublication,
  type PreparedFundingOffer,
} from "./adapter-funding-runtime.js";
import { ethers } from "ethers";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";
import { familyId } from "./venues/adapter-family-identifiers.js";
import { PSM_FAMILY_ID } from "./venues/protocols/psm-family/manifest.js";
import {
  PSM_INTERFACE,
  PSM_WAD,
  psmSellQuote,
} from "./venues/protocols/psm-family/codec.js";
import { psmExact } from "./venues/protocols/psm-family/exact.js";
import { psmExecution } from "./venues/protocols/psm-family/execution.js";
import type { PsmDescriptor, PsmRoute } from
  "./venues/protocols/psm-family/types.js";
import { WSTETH_FAMILY_ID } from
  "./venues/protocols/wsteth-family/manifest.js";
import { WSTETH_INTERFACE } from
  "./venues/protocols/wsteth-family/codec.js";
import { wstethExact } from
  "./venues/protocols/wsteth-family/exact.js";
import { wstethExecution } from
  "./venues/protocols/wsteth-family/execution.js";
import type { WstethDescriptor, WstethRoute } from
  "./venues/protocols/wsteth-family/types.js";
import {
  createBoundedRequestExecutor,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
} from "./venues/adapter-request-program.js";
import type {
  AdapterGenerationFence,
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "./adapter-work-intent.js";
import { projectFamilyRouteGraph } from
  "./adapter-family-graph-runtime.js";
import {
  exercisedStage,
  frameworkBlockedStage,
} from "./architecture-migration-capture.js";
import type { UniV2Descriptor, UniV2Route } from
  "./venues/swaps/univ2-family/types.js";
import type { UniV2ExactEvidence } from
  "./venues/swaps/univ2-family/types.js";
import type { UniV3Descriptor, UniV3Route } from
  "./venues/swaps/univ3-family/types.js";
import type { UniV3ExactEvidence } from
  "./venues/swaps/univ3-family/types.js";
import type { UniV4Descriptor, UniV4Route } from
  "./venues/swaps/univ4-family/types.js";
import type { UniV4ExactEvidence } from
  "./venues/swaps/univ4-family/types.js";
import type { ExpectedEffect } from
  "./venues/adapter-family-plugin.js";
import type {
  ArchitectureMigrationStage,
  RawFamilyMigrationCaseCapture,
  RawMigrationStageCapture,
} from "./architecture-migration-parity-runner.js";

const CATALOG = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const FAMILY = CATALOG.forFamily(UNIV2_FAMILY_ID);
export const UNIV2_FIXTURE_POOL = `0x${"41".repeat(20)}`;
export const UNIV2_FIXTURE_FACTORY = `0x${"42".repeat(20)}`;
export const UNIV2_FIXTURE_TOKEN0 = `0x${"43".repeat(20)}`;
export const UNIV2_FIXTURE_TOKEN1 = `0x${"44".repeat(20)}`;
export const UNIV2_CAPTURE_EXACT_AMOUNT_IN = 1_000_000n;
export const MIGRATION_CAPTURE_EXECUTOR = `0x${"ee".repeat(20)}`;

class FixtureFence implements AdapterGenerationFence {
  assertCurrent(): void {}
}

interface PoolContext {
  readonly pool: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly reserves?: {
    readonly reserve0: bigint;
    readonly reserve1: bigint;
    readonly blockTimestampLast: number;
  };
}

class FixtureScheduler implements CentralAdapterScheduler {
  readonly #pool: PoolContext;

  constructor(pool: PoolContext) {
    this.#pool = pool;
  }

  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => successResult(request, execution.source, this.#pool),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function fixtureRuntime(pool: PoolContext): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new FixtureScheduler(pool),
  };
}

function successResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
  pool: PoolContext,
): AdapterRequestResult {
  const data = request.id === "pair-factory"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("factory", [pool.factory])
    : request.id === "pair-token0"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("token0", [pool.token0])
    : request.id === "pair-token1"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("token1", [pool.token1])
    : request.id === "factory-get-pair"
    ? UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [pool.pool])
    : request.id === "current-reserves"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult(
        "getReserves",
        pool.reserves === undefined
          ? [1_000_000n, 2_000_000n, 1_234]
          : [
              pool.reserves.reserve0,
              pool.reserves.reserve1,
              pool.reserves.blockTimestampLast,
            ],
      )
    : request.id === "exact-reserves"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult(
        "getReserves",
        pool.reserves === undefined
          ? [1_000_000n, 2_000_000n, 1_234]
          : [
              pool.reserves.reserve0,
              pool.reserves.reserve1,
              pool.reserves.blockTimestampLast,
            ],
      )
    : (() => { throw new Error(`unexpected fixture request ${request.id}`); })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

async function runUniv2Lifecycle(
  canonical: CanonicalSource,
  pool: PoolContext,
): Promise<AdapterFamilyPublication> {
  let publication: AdapterFamilyPublication | null = null;
  const result = await executeAdapterFamilyLifecycleBatch({
    family: FAMILY,
    matches: [Object.freeze({
      matchedPatternId: UNIV2_SWAP_CALL_PATTERN_ID,
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: pool.pool,
        data: UNIV2_SWAP_SELECTOR,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: fixtureRuntime(pool),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

function instanceStage(
  instances: readonly PreparedFamilyInstance[],
  evidenceRefs: readonly string[],
): RawMigrationStageCapture {
  return exercisedStage(instances.map((instance) => Object.freeze({
    id: instance.instanceKey,
    value: Object.freeze({
      familyId: instance.familyId,
      instanceKey: instance.instanceKey,
      staticBindingFingerprint: instance.staticBindingFingerprint,
    }),
  })), evidenceRefs);
}

/**
 * Runs the current strict UniV2 lifecycle over one fixture observation and
 * emits the canonical migration capture row for the `univ2-standard` Family.
 * Deep stages that the harness does not yet exercise are honestly marked
 * `framework-blocked` with evidence refs.
 */
export async function captureUniv2FixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  return captureUniv2RealCase({
    ...input,
    pool: UNIV2_FIXTURE_POOL,
    tokenA: UNIV2_FIXTURE_TOKEN0,
    tokenB: UNIV2_FIXTURE_TOKEN1,
  });
}

export async function captureUniv2RealCase(input: {
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly tokenA: string;
  readonly tokenB: string;
  readonly caseId?: string;
  readonly reserves?: {
    readonly reserve0: bigint | string;
    readonly reserve1: bigint | string;
    readonly blockTimestampLast?: number;
  };
}): Promise<RawFamilyMigrationCaseCapture> {
  const reserves = input.reserves === undefined
    ? undefined
    : Object.freeze({
        reserve0: BigInt(input.reserves.reserve0),
        reserve1: BigInt(input.reserves.reserve1),
        blockTimestampLast: input.reserves.blockTimestampLast ?? 0,
      });
  const pool: PoolContext = {
    pool: input.pool.toLowerCase(),
    factory: `0x${"42".repeat(20)}`,
    token0: input.tokenA.toLowerCase(),
    token1: input.tokenB.toLowerCase(),
    reserves,
  };
  const publication = await runUniv2Lifecycle(input.source, pool);
  const evidenceRefs = Object.freeze([
    `fixture:univ2:${input.source.number}:${input.source.hash}`,
  ]);
  const instances = publication.instances;
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family: FAMILY,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`univ2 pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  let exactQuotes: RawMigrationStageCapture;
  const exactByRouteKey = new Map<
    string,
    { readonly amountOut: bigint; readonly evidence: UniV2ExactEvidence }
  >();
  if (reserves !== undefined) {
    const exactMethod = univ2Exact.methods().find(
      (method) => method.kind === "request-program" &&
        method.id === "pair-reserves",
    );
    if (exactMethod === undefined || exactMethod.kind !== "request-program") {
      throw new Error("univ2 exact request program is missing");
    }
    const program = exactMethod.program;
    const edgeByRouteKey = new Map(
      edges.map((edge) => {
        const value = edge.value as { readonly routeKey: string };
        return [value.routeKey, edge] as const;
      }),
    );
    const quotes: RawMigrationStageCapture["items"][number][] = [];
    for (const instance of instances) {
      for (const route of [...instance.routes].sort(
        (left, right) => left.routeKey.localeCompare(right.routeKey),
      )) {
        const exactInput = Object.freeze({
          descriptor: instance.descriptor as unknown as UniV2Descriptor,
          route: route as unknown as UniV2Route,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
          source: input.source,
          executor: MIGRATION_CAPTURE_EXECUTOR,
          runtimeEvidence: Object.freeze([]),
        });
        const requests = program.buildRequests(exactInput);
        const results = requests.map((request) =>
          successResult(request, input.source, pool)
        );
        const decoded = program.decode({
          programInput: exactInput,
          initialResults: results,
          dependentEvidence: Object.freeze([]),
        });
        const edge = edgeByRouteKey.get(route.routeKey);
        if (edge === undefined) {
          throw new Error(`exact route ${route.routeKey} has no captured edge`);
        }
        exactByRouteKey.set(route.routeKey, {
          amountOut: decoded.amountOut,
          evidence: decoded.evidence as UniV2ExactEvidence,
        });
        quotes.push(Object.freeze({
          id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
          value: Object.freeze({
            routeKey: route.routeKey,
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            canonicalEdgeId: edge.id,
            amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
            amountOut: decoded.amountOut.toString(),
            feeBps: (
              instance.descriptor as unknown as {
                readonly feeRule: { readonly feeBps: bigint };
              }
            ).feeRule.feeBps.toString(),
          }),
        }));
      }
    }
    exactQuotes = exercisedStage(quotes, evidenceRefs);
  } else {
    exactQuotes = frameworkBlockedStage(
      evidenceRefs,
      "capture-harness-exact-not-wired",
    );
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  if (reserves !== undefined) {
    const edgeByRouteKey = new Map(
      edges.map((edge) => {
        const value = edge.value as { readonly routeKey: string };
        return [value.routeKey, edge] as const;
      }),
    );
    for (const instance of instances) {
      for (const route of [...instance.routes].sort(
        (left, right) => left.routeKey.localeCompare(right.routeKey),
      )) {
        const quote = exactByRouteKey.get(route.routeKey);
        const edge = edgeByRouteKey.get(route.routeKey);
        if (quote === undefined || edge === undefined) {
          throw new Error(
            `univ2 execution route ${route.routeKey} has no exact quote`,
          );
        }
        const descriptor = instance.descriptor as unknown as UniV2Descriptor;
        const univ2Route = route as unknown as UniV2Route;
        const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
        const minAmountOut = quote.amountOut;
        const fragment = univ2Execution.buildFragment({
          descriptor,
          route: univ2Route,
          amountIn,
          quotedAmountOut: quote.amountOut,
          minAmountOut,
          exactEvidence: quote.evidence,
          executor: MIGRATION_CAPTURE_EXECUTOR,
          runtimeEvidence: Object.freeze([]),
        });
        const node = fragment.nodes[0]!;
        const nodeFingerprint = hashCanonical(
          node as unknown as CanonicalValue,
        );
        executionFragments.push(Object.freeze({
          id: `${edge.id}\u001fexec:${amountIn}`,
          value: Object.freeze({
            routeKey: route.routeKey,
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            canonicalEdgeId: edge.id,
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
            minAmountOut: minAmountOut.toString(),
            actionAdapterId: node.adapterId,
            executionTarget: node.target,
            nodeFingerprint,
          }),
        }));
        const effects = univ2Execution.expectedEffects({
          descriptor,
          route: univ2Route,
          amountIn,
          quotedAmountOut: quote.amountOut,
        });
        assertConservedUniv2Effects(effects);
        if (quote.amountOut < minAmountOut) {
          throw new Error("univ2 capture final simulation repayment failed");
        }
        const effectsFingerprint = hashCanonical(
          effects as unknown as CanonicalValue,
        );
        finalSimulations.push(Object.freeze({
          id: `${edge.id}\u001fsim:${amountIn}`,
          value: Object.freeze({
            routeKey: route.routeKey,
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            canonicalEdgeId: edge.id,
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
            minAmountOut: minAmountOut.toString(),
            effectsFingerprint,
            conservation: "conserved",
            repayment: "satisfied",
            evInput: Object.freeze({
              amountIn: amountIn.toString(),
              amountOut: quote.amountOut.toString(),
            }),
          }),
        }));
      }
    }
  }
  const stages: RawFamilyMigrationCaseCapture["stages"] = Object.freeze({
    instances: instanceStage(instances, evidenceRefs),
    edges: exercisedStage(edges, evidenceRefs),
    stateCoverage: exercisedStage([], evidenceRefs),
    pricedEdges: exercisedStage([], evidenceRefs),
    prices: input.reserves === undefined
      ? frameworkBlockedStage(
          evidenceRefs,
          "capture-harness-prices-not-wired",
        )
      : exercisedStage(prices, evidenceRefs),
    failures: exercisedStage([], evidenceRefs),
    enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
    exactQuotes,
    executionFragments: reserves === undefined
      ? frameworkBlockedStage(
          evidenceRefs,
          "capture-harness-execution-not-wired",
        )
      : exercisedStage(executionFragments, evidenceRefs),
    finalSimulations: reserves === undefined
      ? frameworkBlockedStage(
          evidenceRefs,
          "capture-harness-final-sim-not-wired",
        )
      : exercisedStage(finalSimulations, evidenceRefs),
  });
  const summary = definedFamilyPluginContractSummary(FAMILY.plugin);
  return Object.freeze({
    familyId: UNIV2_FAMILY_ID,
    caseId: input.caseId ?? `univ2:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages,
  });
}

export function fixtureCaptureStages(): readonly ArchitectureMigrationStage[] {
  return Object.freeze([
    "instances",
    "edges",
    "stateCoverage",
    "pricedEdges",
    "prices",
    "failures",
    "enumeratedRoutes",
    "exactQuotes",
    "executionFragments",
    "finalSimulations",
  ] as const);
}

/**
 * Fixture-level final-sim conservation proof for the uniV2 swap corpus: the
 * expected effect set must be exactly the four token-delta legs (tokenIn
 * executor decrease / route-target increase, tokenOut route-target decrease
 * / executor increase). Amount conservation is then implied by the fragment
 * (transfer amountIn in, swap amountOut out) and is verified by the capture
 * repayment check.
 */
function assertConservedUniv2Effects(
  effects: readonly ExpectedEffect[],
): void {
  const expected = new Set([
    "token-delta:executor:decrease",
    "token-delta:route-target:increase",
    "token-delta:route-target:decrease",
    "token-delta:executor:increase",
  ]);
  if (effects.length !== 4) {
    throw new Error("univ2 capture final simulation effects size mismatch");
  }
  for (const effect of effects) {
    if (effect.kind !== "token-delta") {
      throw new Error(
        "univ2 capture final simulation effect must be token-delta",
      );
    }
    const key = `${effect.kind}:${effect.account}:${effect.direction}`;
    if (!expected.has(key)) {
      throw new Error(`unexpected univ2 capture effect ${key}`);
    }
  }
}

export const UNIV3_FIXTURE_FACTORY =
  "0x1F98431c8aD98523631AE4a59f267346ea31F984";
export const UNIV3_FIXTURE_POOL = `0x${"33".repeat(20)}`;
export const UNIV3_FIXTURE_TOKEN0 = `0x${"11".repeat(20)}`;
export const UNIV3_FIXTURE_TOKEN1 = `0x${"22".repeat(20)}`;
export const UNIV3_FIXTURE_FEE = 500n;
export const UNIV3_FIXTURE_TICK_SPACING = 1;
export const UNIV3_FIXTURE_LIQUIDITY = 1_000_000_000_000_000_000n;
export const UNIV3_FIXTURE_SQRT_PRICE_X96 = 1n << 96n;

interface UniV3PoolContext {
  readonly pool: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: bigint;
  readonly tickSpacing: number;
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
}

function univ3QuoteResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
  ctx: UniV3PoolContext,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const callRequest = request as { readonly data: string };
  const decoded = UNIV3_QUOTER_V2_INTERFACE.decodeFunctionData(
    "quoteExactInputSingle",
    callRequest.data,
  );
  const params = decoded[0] as {
    readonly tokenIn: string;
    readonly tokenOut: string;
    readonly amountIn: bigint;
    readonly fee: bigint;
    readonly sqrtPriceLimitX96: bigint;
  };
  const zeroForOne = params.tokenIn.toLowerCase() === ctx.token0.toLowerCase();
  const state: import("./solver/v3-math.js").V3PoolState = {
    sqrtPriceX96: ctx.sqrtPriceX96,
    liquidity: ctx.liquidity,
    tick: 0,
    fee: ctx.fee,
    tickSpacing: ctx.tickSpacing,
    tickBitmap: new Map([[0, 0n], [-1, 0n]]),
    ticks: new Map(),
  };
  const amountOut = v3SwapExactInput(state, zeroForOne, params.amountIn);
  const post = v3SwapToState(state, zeroForOne, params.amountIn);
  const data = UNIV3_QUOTER_V2_INTERFACE.encodeFunctionResult(
    "quoteExactInputSingle",
    [amountOut, post.state.sqrtPriceX96, 0, 0],
  );
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

function univ3SuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
  ctx: UniV3PoolContext,
): AdapterRequestResult {
  const data = request.id === "pool-factory"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult("factory", [ctx.factory])
    : request.id === "pool-token0"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult("token0", [ctx.token0])
    : request.id === "pool-token1"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult("token1", [ctx.token1])
    : request.id === "pool-fee"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult("fee", [ctx.fee])
    : request.id === "pool-tick-spacing"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult(
        "tickSpacing",
        [ctx.tickSpacing],
      )
    : request.id === "factory-get-pool"
    ? UNIV3_FACTORY_INTERFACE.encodeFunctionResult("getPool", [ctx.pool])
    : request.id === "current-slot0"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult(
        "slot0",
        [ctx.sqrtPriceX96, 0, 0, 1, 1, 0, true],
      )
    : request.id === "current-liquidity"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult("liquidity", [ctx.liquidity])
    : request.id.startsWith("univ3-precision:")
    ? univ3QuoteResult(request, canonical, ctx).data
    : request.id === "exact-factory-bound-quote"
    ? univ3QuoteResult(request, canonical, ctx).data
    : (() => {
        throw new Error(`unexpected univ3 fixture request ${request.id}`);
      })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class UniV3FixtureScheduler implements CentralAdapterScheduler {
  readonly #ctx: UniV3PoolContext;

  constructor(ctx: UniV3PoolContext) {
    this.#ctx = ctx;
  }

  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => univ3SuccessResult(request, execution.source, this.#ctx),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function univ3FixtureRuntime(ctx: UniV3PoolContext): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new UniV3FixtureScheduler(ctx),
  };
}

async function runUniv3Lifecycle(
  canonical: CanonicalSource,
  ctx: UniV3PoolContext,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV3_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const swapCalldata = UNIV3_POOL_INTERFACE.encodeFunctionData("swap", [
    MIGRATION_CAPTURE_EXECUTOR,
    true,
    1_000_000n,
    0n,
    "0x",
  ]);
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: UNIV3_SWAP_CALL_PATTERN_ID,
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: ctx.pool,
        data: swapCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: univ3FixtureRuntime(ctx),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the strict UniV3 lifecycle over one fixture pool observation and emits
 * the canonical migration capture row for `univ3-standard`. All deep stages
 * are exercised at fixture level (deterministic local v3 exact-input math),
 * mirroring the univ2 bilateral capture contract.
 */
export async function captureUniv3FixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  return captureUniv3PoolCase({
    source: input.source,
    caseId: input.caseId,
    ctx: Object.freeze({
      pool: UNIV3_FIXTURE_POOL,
      factory: UNIV3_FIXTURE_FACTORY,
      token0: UNIV3_FIXTURE_TOKEN0,
      token1: UNIV3_FIXTURE_TOKEN1,
      fee: UNIV3_FIXTURE_FEE,
      tickSpacing: UNIV3_FIXTURE_TICK_SPACING,
      liquidity: UNIV3_FIXTURE_LIQUIDITY,
      sqrtPriceX96: UNIV3_FIXTURE_SQRT_PRICE_X96,
    }),
  });
}

export async function captureUniv3RealCase(input: {
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly tokenA: string;
  readonly tokenB: string;
  readonly fee?: bigint | string;
  readonly tickSpacing?: number;
  readonly liquidity?: bigint | string;
  readonly sqrtPriceX96?: bigint | string;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  return captureUniv3PoolCase({
    source: input.source,
    caseId: input.caseId ?? `univ3:${input.source.number}`,
    ctx: Object.freeze({
      pool: input.pool.toLowerCase(),
      factory: UNIV3_FIXTURE_FACTORY,
      token0: input.tokenA.toLowerCase(),
      token1: input.tokenB.toLowerCase(),
      fee: BigInt(input.fee ?? UNIV3_FIXTURE_FEE),
      tickSpacing: input.tickSpacing ?? UNIV3_FIXTURE_TICK_SPACING,
      liquidity: BigInt(input.liquidity ?? UNIV3_FIXTURE_LIQUIDITY),
      sqrtPriceX96: BigInt(
        input.sqrtPriceX96 ?? UNIV3_FIXTURE_SQRT_PRICE_X96,
      ),
    }),
  });
}

async function captureUniv3PoolCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
  readonly ctx: UniV3PoolContext;
}): Promise<RawFamilyMigrationCaseCapture> {
  const ctx = input.ctx;
  const publication = await runUniv3Lifecycle(input.source, ctx);
  const evidenceRefs = Object.freeze([
    `fixture:univ3:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV3_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`univ3 pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = univ3Exact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "quoter-v2",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("univ3 exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    { readonly amountOut: bigint; readonly evidence: UniV3ExactEvidence }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as UniV3Descriptor,
        route: route as unknown as UniV3Route,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        univ3SuccessResult(request, input.source, ctx)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`univ3 exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence as UniV3ExactEvidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: (Number((instance.descriptor as unknown as {
            readonly fee: bigint;
          }).fee) / 100).toString(),
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(`univ3 execution route ${route.routeKey} has no quote`);
      }
      const descriptor = instance.descriptor as unknown as UniV3Descriptor;
      const univ3Route = route as unknown as UniV3Route;
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const minAmountOut = quote.amountOut;
      const fragment = univ3Execution.buildFragment({
        descriptor,
        route: univ3Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const node = fragment.nodes[0]!;
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: minAmountOut.toString(),
          actionAdapterId: node.adapterId,
          executionTarget: node.target,
          nodeFingerprint: hashCanonical(
            node as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = univ3Execution.expectedEffects({
        descriptor,
        route: univ3Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      assertConservedUniv2Effects(effects);
      if (quote.amountOut < minAmountOut) {
        throw new Error("univ3 capture final simulation repayment failed");
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: minAmountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: UNIV3_FAMILY_ID,
    caseId: input.caseId ?? `univ3:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const UNIV4_FIXTURE_MANAGER = ADDR.UNISWAP_V4_POOL_MANAGER;
export const UNIV4_FIXTURE_STATE_VIEW = ADDR.UNISWAP_V4_STATE_VIEW;
export const UNIV4_FIXTURE_QUOTER = ADDR.UNISWAP_V4_QUOTER;
export const UNIV4_FIXTURE_CURRENCY0 =
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const UNIV4_FIXTURE_CURRENCY1 =
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const UNIV4_FIXTURE_FEE = 3000n;
export const UNIV4_FIXTURE_TICK_SPACING = 60;
export const UNIV4_FIXTURE_LP_FEE = 3000n;
export const UNIV4_FIXTURE_LIQUIDITY = 1_000_000_000_000_000_000n;
export const UNIV4_FIXTURE_SQRT_PRICE_X96 = 1n << 96n;
export const FUNDING_CAPTURE_ASSET =
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const FUNDING_CAPTURE_MAX_BORROW = 1_000_000_000n;
export const FUNDING_CAPTURE_AMOUNT = 1_000_000n;
export const FUNDING_CAPTURE_MIN_PROFIT = 1_000n;

interface UniV4PoolContext {
  readonly manager: string;
  readonly stateView: string;
  readonly quoter: string;
  readonly poolKey: {
    readonly currency0: string;
    readonly currency1: string;
    readonly fee: number;
    readonly tickSpacing: number;
    readonly hooks: string;
  };
  readonly poolId: string;
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
  readonly lpFee: bigint;
}

function univ4QuoteResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
  ctx: UniV4PoolContext,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const callRequest = request as { readonly data: string };
  const decoded = UNIV4_QUOTER_INTERFACE.decodeFunctionData(
    "quoteExactInputSingle",
    callRequest.data,
  );
  const params = decoded[0] as {
    readonly zeroForOne: boolean;
    readonly exactAmount: bigint;
  };
  const state = {
    sqrtPriceX96: ctx.sqrtPriceX96,
    liquidity: ctx.liquidity,
    tick: 0,
    fee: ctx.lpFee,
    tickSpacing: ctx.poolKey.tickSpacing,
    tickBitmap: new Map([[0, 0n], [-1, 0n]]),
    ticks: new Map(),
  };
  const amountOut = v3SwapExactInput(
    state,
    params.zeroForOne,
    params.exactAmount,
  );
  const data = UNIV4_QUOTER_INTERFACE.encodeFunctionResult(
    "quoteExactInputSingle",
    [amountOut, 0n],
  );
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

function univ4SuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
  ctx: UniV4PoolContext,
): AdapterRequestResult {
  const data = request.id === "manager-code"
    ? "0x00"
    : request.id === "identity-slot0" || request.id === "current-slot0"
    ? UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult("getSlot0", [
        ctx.sqrtPriceX96,
        0,
        0,
        ctx.lpFee,
      ])
    : request.id === "identity-liquidity" ||
        request.id === "current-liquidity"
    ? UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult("getLiquidity", [
        ctx.liquidity,
      ])
    : request.id.startsWith("univ4-precision:") ||
        request.id === "exact-univ4-quote"
    ? univ4QuoteResult(request, canonical, ctx).data
    : (() => {
        throw new Error(`unexpected univ4 fixture request ${request.id}`);
      })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class UniV4FixtureScheduler implements CentralAdapterScheduler {
  readonly #ctx: UniV4PoolContext;

  constructor(ctx: UniV4PoolContext) {
    this.#ctx = ctx;
  }

  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => univ4SuccessResult(request, execution.source, this.#ctx),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function univ4FixtureRuntime(ctx: UniV4PoolContext): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new UniV4FixtureScheduler(ctx),
  };
}

async function runUniv4Lifecycle(
  canonical: CanonicalSource,
  ctx: UniV4PoolContext,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV4_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const swapCalldata = UNIV4_POOL_MANAGER_INTERFACE.encodeFunctionData(
    "swap",
    [
      ctx.poolKey,
      {
        zeroForOne: true,
        amountSpecified: 1_000_000n,
        sqrtPriceLimitX96: 0n,
      },
      "0x",
    ],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: UNIV4_SWAP_CALL_PATTERN_ID,
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: ctx.manager,
        data: swapCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: univ4FixtureRuntime(ctx),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

function univ4PoolKey(): UniV4PoolContext["poolKey"] {
  return Object.freeze({
    currency0: UNIV4_FIXTURE_CURRENCY0,
    currency1: UNIV4_FIXTURE_CURRENCY1,
    fee: Number(UNIV4_FIXTURE_FEE),
    tickSpacing: UNIV4_FIXTURE_TICK_SPACING,
    hooks: "0x0000000000000000000000000000000000000000",
  });
}

export async function captureUniv4FixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  return captureUniv4PoolCase({
    source: input.source,
    caseId: input.caseId,
    ctx: Object.freeze({
      manager: UNIV4_FIXTURE_MANAGER,
      stateView: UNIV4_FIXTURE_STATE_VIEW,
      quoter: UNIV4_FIXTURE_QUOTER,
      poolKey: univ4PoolKey(),
      poolId: v4PoolId(univ4PoolKey()),
      liquidity: UNIV4_FIXTURE_LIQUIDITY,
      sqrtPriceX96: UNIV4_FIXTURE_SQRT_PRICE_X96,
      lpFee: UNIV4_FIXTURE_LP_FEE,
    }),
  });
}

export async function captureUniv4RealCase(input: {
  readonly source: CanonicalSource;
  readonly currency0: string;
  readonly currency1: string;
  readonly fee?: number;
  readonly tickSpacing?: number;
  readonly hooks?: string;
  readonly liquidity?: bigint | string;
  readonly sqrtPriceX96?: bigint | string;
  readonly lpFee?: bigint | string;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const poolKey = Object.freeze({
    currency0: input.currency0.toLowerCase(),
    currency1: input.currency1.toLowerCase(),
    fee: input.fee ?? Number(UNIV4_FIXTURE_FEE),
    tickSpacing: input.tickSpacing ?? UNIV4_FIXTURE_TICK_SPACING,
    hooks: (input.hooks ?? "0x0000000000000000000000000000000000000000")
      .toLowerCase(),
  });
  return captureUniv4PoolCase({
    source: input.source,
    caseId: input.caseId ?? `univ4:${input.source.number}`,
    ctx: Object.freeze({
      manager: UNIV4_FIXTURE_MANAGER,
      stateView: UNIV4_FIXTURE_STATE_VIEW,
      quoter: UNIV4_FIXTURE_QUOTER,
      poolKey,
      poolId: v4PoolId(poolKey),
      liquidity: BigInt(input.liquidity ?? UNIV4_FIXTURE_LIQUIDITY),
      sqrtPriceX96: BigInt(
        input.sqrtPriceX96 ?? UNIV4_FIXTURE_SQRT_PRICE_X96,
      ),
      lpFee: BigInt(input.lpFee ?? UNIV4_FIXTURE_LP_FEE),
    }),
  });
}

async function captureUniv4PoolCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
  readonly ctx: UniV4PoolContext;
}): Promise<RawFamilyMigrationCaseCapture> {
  const ctx = input.ctx;
  const publication = await runUniv4Lifecycle(input.source, ctx);
  const evidenceRefs = Object.freeze([
    `fixture:univ4:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV4_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`univ4 pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = univ4Exact.methods().find(
    (method) => method.kind === "request-program" && method.id === "univ4-quoter",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("univ4 exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    { readonly amountOut: bigint; readonly evidence: UniV4ExactEvidence }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as UniV4Descriptor,
        route: route as unknown as UniV4Route,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        univ4SuccessResult(request, input.source, ctx)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`univ4 exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence as UniV4ExactEvidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: (Number(ctx.lpFee) / 100).toString(),
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(`univ4 execution route ${route.routeKey} has no quote`);
      }
      const descriptor = instance.descriptor as unknown as UniV4Descriptor;
      const univ4Route = route as unknown as UniV4Route;
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const minAmountOut = quote.amountOut;
      const fragment = univ4Execution.buildFragment({
        descriptor,
        route: univ4Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: minAmountOut.toString(),
          actionAdapterId: "univ4-unlock",
          executionTarget: ctx.manager,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = univ4Execution.expectedEffects({
        descriptor,
        route: univ4Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      assertConservedUniv4Effects(effects, amountIn, quote.amountOut);
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: minAmountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: UNIV4_FAMILY_ID,
    caseId: input.caseId ?? `univ4:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

function assertConservedUniv4Effects(
  effects: readonly ExpectedEffect[],
  amountIn: bigint,
  amountOut: bigint,
): void {
  if (effects.length !== 2) {
    throw new Error("univ4 capture final simulation effects size mismatch");
  }
  const [inEffect, outEffect] = effects;
  if (
    inEffect.kind !== "token-delta" ||
    inEffect.account !== "executor" ||
    inEffect.direction !== "decrease" ||
    outEffect.kind !== "token-delta" ||
    outEffect.account !== "executor" ||
    outEffect.direction !== "increase"
  ) {
    throw new Error("univ4 capture final simulation effects are malformed");
  }
  if (amountIn <= 0n || amountOut <= 0n || amountOut >= amountIn * 100n) {
    throw new Error("univ4 capture final simulation amounts are inconsistent");
  }
}

const FUNDING_ERC20_INTERFACE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

function fundingFixtureRuntime(input: {
  readonly source: CanonicalSource;
  readonly generation: number;
}): CentralAdapterRuntime {
  let now = 1_000;
  const scheduler: CentralAdapterScheduler = {
    issueExecutor(issue) {
      return Object.freeze({
        executor: createBoundedRequestExecutor({
          assertSupported(requirements) {
            assert.deepEqual(requirements, issue.requirements);
          },
          assertCallerBinding() {},
          assertWithinBudget(familyId, requests) {
            assert.equal(familyId, issue.subject.familyId);
            assert.deepEqual(requests, issue.requests);
          },
          execute: async ({ requests, source }) => requests.map((request) => {
            const asset = (request as { readonly to: string }).to;
            return Object.freeze({
              id: request.id,
              ok: true as const,
              source,
              provenance: Object.freeze({
                kind: "migration-capture-fixture",
                fingerprint: `funding:${asset.toLowerCase()}`,
              }),
              completion: "returned" as const,
              data: FUNDING_ERC20_INTERFACE.encodeFunctionResult(
                "balanceOf",
                [FUNDING_CAPTURE_MAX_BORROW],
              ),
            });
          }),
          sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
        }),
        timing: () => Object.freeze({
          queueWaitMs: 1,
          transportWallMs: 2,
          attempts: 1,
        }),
      });
    },
  };
  return {
    clock: { nowMs: () => now++ },
    generationFence: {
      assertCurrent(generation, source) {
        assert.equal(generation, input.generation);
        assert.equal(source.hash.toLowerCase(), input.source.hash.toLowerCase());
      },
    },
    callerAuthority: { bind: () => Object.freeze({}) },
    policy: {
      bind(policyInput) {
        assert.equal(policyInput.stage, "pricing-current");
        return Object.freeze({
          lane: "background" as const,
          deadlineAtMs: 10_000,
          maxAttempts: 1,
          transportPool: "state-read" as const,
          fairnessKey: policyInput.subjectKey,
        });
      },
    },
    budgets: { assertAdmitted() {} },
    scheduler,
  };
}

/**
 * Runs one strict funding Family (flash-loan:balancer-v2 / morpho) over a
 * fixture ERC20 balance and emits the canonical migration capture row. The
 * funding-only cohort requires only failures/executionFragments/
 * finalSimulations; borrow and repayment fragments are issued through the
 * central funding runtime so the fingerprints are authority-bound.
 */
export async function captureFundingFixtureCase(input: {
  readonly familyId: "flash-loan:balancer-v2" | "flash-loan:morpho";
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .forStrictFamily(familyId(input.familyId));
  const asset = ethers.getAddress(FUNDING_CAPTURE_ASSET);
  const runtime = fundingFixtureRuntime({
    source: input.source,
    generation: input.source.generation,
  });
  let publication: FundingFamilyPublication | null = null;
  const result = await executeFundingFamilyLiquidity({
    family,
    assets: [asset],
    source: input.source,
    generation: input.source.generation,
    runtime,
    publisher: {
      publish(value) {
        publication = value;
      },
    },
  });
  assert(result.offers.length >= 1);
  assert(publication !== null);
  const offer: PreparedFundingOffer = result.offers[0]!;
  const amount = FUNDING_CAPTURE_AMOUNT;
  const minProfit = FUNDING_CAPTURE_MIN_PROFIT;
  const borrowFragment = buildFundingBorrowFragment({
    family,
    offer,
    source: input.source,
    generation: input.source.generation,
    amount,
    minProfit,
    children: [],
  });
  const repaymentFragment = buildFundingRepaymentFragment({
    family,
    offer,
    source: input.source,
    generation: input.source.generation,
    amount,
  });
  const evidenceRefs = Object.freeze([
    `fixture:${input.familyId}:${input.source.number}:${input.source.hash}`,
  ]);
  const absentStage = Object.freeze({
    status: "declared-absent" as const,
    items: Object.freeze([]),
    evidenceRefs,
    blocker: null,
  });
  const assetLower = asset.toLowerCase();
  const executionFragments: RawMigrationStageCapture["items"][number][] = [
    Object.freeze({
      id: `${input.familyId}:${assetLower}\u001fborrow:${amount}`,
      value: Object.freeze({
        familyId: input.familyId,
        asset,
        amount: amount.toString(),
        minProfit: minProfit.toString(),
        actionAdapterId: offer.actionAdapterId,
        nodeFingerprint: hashCanonical(
          borrowFragment.nodes as unknown as CanonicalValue,
        ),
      }),
    }),
    Object.freeze({
      id: `${input.familyId}:${assetLower}\u001frepay:${amount}`,
      value: Object.freeze({
        familyId: input.familyId,
        asset,
        amount: amount.toString(),
        actionAdapterId: offer.actionAdapterId,
        nodeFingerprint: hashCanonical(
          repaymentFragment.nodes as unknown as CanonicalValue,
        ),
      }),
    }),
  ];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [
    Object.freeze({
      id: `${input.familyId}:${assetLower}\u001fsim:${amount}`,
      value: Object.freeze({
        familyId: input.familyId,
        asset,
        amount: amount.toString(),
        maxBorrow: offer.maxBorrow.toString(),
        repayment: "satisfied",
        conservation: "conserved",
        evInput: Object.freeze({ amount: amount.toString() }),
      }),
    }),
  ];
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: input.familyId,
    caseId: input.caseId ?? `${input.familyId}:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: absentStage,
      edges: absentStage,
      stateCoverage: absentStage,
      pricedEdges: absentStage,
      prices: absentStage,
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: absentStage,
      exactQuotes: absentStage,
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const PSM_FIXTURE_TARGET = `0x${"55".repeat(20)}`;
export const PSM_FIXTURE_GEM =
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const PSM_FIXTURE_DAI =
  "0x6b175474e89094c44da98b954eedeac495271d0f";
export const PSM_FIXTURE_TIN = 10n ** 16n;
export const PSM_FIXTURE_TOUT = 10n ** 16n;

function psmSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const data = request.id === "identity-code"
    ? "0x00"
    : request.id === "identity-gem"
    ? PSM_INTERFACE.encodeFunctionResult("gem", [PSM_FIXTURE_GEM])
    : request.id === "identity-dai"
    ? PSM_INTERFACE.encodeFunctionResult("dai", [PSM_FIXTURE_DAI])
    : request.id === "identity-tin" || request.id === "current-tin" ||
        request.id === "exact-tin"
    ? PSM_INTERFACE.encodeFunctionResult("tin", [PSM_FIXTURE_TIN])
    : request.id === "identity-tout"
    ? PSM_INTERFACE.encodeFunctionResult("tout", [PSM_FIXTURE_TOUT])
    : (() => {
        throw new Error(`unexpected psm fixture request ${request.id}`);
      })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class PsmFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => psmSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function psmFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new PsmFixtureScheduler(),
  };
}

async function runPsmLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    PSM_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const sellGemCalldata = PSM_INTERFACE.encodeFunctionData("sellGem", [
    MIGRATION_CAPTURE_EXECUTOR,
    1_000_000n,
  ]);
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "psm-sellgem-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: PSM_FIXTURE_TARGET,
        data: sellGemCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: psmFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the strict PSM (Sky Lite) lifecycle over one fixture singleton pair
 * and emits the canonical migration capture row. PSM exposes a single
 * sell-gem route; all stages are exercised at fixture level.
 */
export async function capturePsmFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runPsmLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:psm:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    PSM_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`psm pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = psmExact.methods().find(
    (method) => method.kind === "request-program" && method.id === "psm-quote",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("psm exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/psm-family/types.js")
        .PsmExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as PsmDescriptor,
        route: route as unknown as PsmRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        psmSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`psm exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(`psm execution route ${route.routeKey} has no quote`);
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = psmExecution.buildFragment({
        descriptor: instance.descriptor as unknown as PsmDescriptor,
        route: route as unknown as PsmRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "psm",
          executionTarget: PSM_FIXTURE_TARGET,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = psmExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as PsmDescriptor,
        route: route as unknown as PsmRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error("psm capture final simulation repayment failed");
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: PSM_FAMILY_ID,
    caseId: input.caseId ?? `psm:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const WSTETH_FIXTURE_TARGET = `0x${"66".repeat(20)}`;
export const WSTETH_FIXTURE_STETH =
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
export const WSTETH_FIXTURE_WSTETH =
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";

function wstethSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  let data: string;
  if (request.id === "identity-code") {
    data = "0x00";
  } else if (request.id === "identity-steth") {
    data = WSTETH_INTERFACE.encodeFunctionResult("stETH", [
      WSTETH_FIXTURE_STETH,
    ]);
  } else if (
    request.id === "identity-wrap" ||
    request.id === "current:wrap" ||
    request.id === "identity-unwrap" ||
    request.id === "current:unwrap"
  ) {
    const fn = request.id.endsWith("unwrap")
      ? "getStETHByWstETH"
      : "getWstETHByStETH";
    data = WSTETH_INTERFACE.encodeFunctionResult(fn, [10n ** 18n]);
  } else if (request.id === "exact-conversion") {
    const callRequestData = (request as { readonly data: string }).data;
    const isUnwrap = callRequestData.startsWith(
      WSTETH_INTERFACE.getFunction("getStETHByWstETH")!.selector,
    );
    const fn = isUnwrap
      ? "getStETHByWstETH"
      : "getWstETHByStETH";
    const amountIn = BigInt(
      WSTETH_INTERFACE.decodeFunctionData(fn, callRequestData)[0],
    );
    data = WSTETH_INTERFACE.encodeFunctionResult(fn, [amountIn]);
  } else {
    throw new Error(`unexpected wsteth fixture request ${request.id}`);
  }
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class WstethFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => wstethSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function wstethFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new WstethFixtureScheduler(),
  };
}

async function runWstethLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    WSTETH_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const wrapCalldata = WSTETH_INTERFACE.encodeFunctionData("wrap", [
    1_000_000n,
  ]);
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "wsteth-wrap-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: WSTETH_FIXTURE_TARGET,
        data: wrapCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: wstethFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  if (result.publication === null) {
    console.error("DEBUG wsteth lifecycle:", JSON.stringify(result.outcomes,
      (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
  }
  assert(result.publication);
  assert(publication);
  return publication;
}

export async function captureWstethFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runWstethLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:wsteth:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    WSTETH_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`wsteth pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = wstethExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "wsteth-preview",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("wsteth exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/wsteth-family/types.js")
        .WstethExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as WstethDescriptor,
        route: route as unknown as WstethRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        wstethSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`wsteth exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(`wsteth execution route ${route.routeKey} has no quote`);
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = wstethExecution.buildFragment({
        descriptor: instance.descriptor as unknown as WstethDescriptor,
        route: route as unknown as WstethRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: (route as unknown as WstethRoute).adapterId,
          executionTarget: WSTETH_FIXTURE_TARGET,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = wstethExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as WstethDescriptor,
        route: route as unknown as WstethRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error("wsteth capture final simulation repayment failed");
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: WSTETH_FAMILY_ID,
    caseId: input.caseId ?? `wsteth:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

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
    enumeratedRoutes: frameworkBlockedStage(
      evidenceRefs,
      "capture-harness-enumeration-not-wired",
    ),
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

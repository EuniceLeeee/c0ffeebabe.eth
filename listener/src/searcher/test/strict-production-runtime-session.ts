import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  buildFamilyRouteGraphView,
} from "../adapter-family-graph-runtime.js";
import type { AdapterRuntimeSnapshot } from "../adapter-runtime-coordinator.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import {
  fluidDexFixtureRuntime,
  runUniv2Lifecycle,
  runFluidDexLifecycle,
  UNIV2_FIXTURE_FACTORY,
  UNIV2_FIXTURE_POOL,
  UNIV2_FIXTURE_TOKEN0,
  UNIV2_FIXTURE_TOKEN1,
} from "../architecture-migration-fixture-replay.js";
import { createStrictCentralAdapterRuntime } from
  "../strict-central-adapter-runtime.js";
import { PinnedRethQuoteBackend } from "../pinned-reth-quote-backend.js";
import { StrictProductionRuntimeRoot } from
  "../strict-production-runtime-session.js";
import { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
import {
  StrictCurrentRuntimeCoordinator,
  type StrictPricingPublication,
  type StrictSessionRequest,
} from
  "../strict-current-runtime-coordinator.js";
import { assertAtomicBlockScanRuntime } from
  "../detector/blockscan-scanner-production.js";
import { PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND } from
  "../runtime-evidence.js";
import { executeCreditFamilyInstanceLifecycle, executeFamilyExactQuote,
  reissuePreparedInstanceAuthority, reissuePreparedInstanceRouteHandles,
  assertIssuedPreparedFamilyPricingStateInstance } from
  "../venues/adapter-family-runtime.js";
import { prepareCreditFamilyRoutes, projectCreditRouteGraph } from "../adapter-credit-runtime.js";
import type { CentralAdapterRuntime } from "../adapter-work-intent.js";
import { createBoundedRequestExecutor, type AdapterRequest, type AdapterRequestResult } from
  "../venues/adapter-request-program.js";
import { defineCreditFamily, defineSwapFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { plugin as baseV2Plugin } from "../venues/production-families/univ2-standard.production.js";
import { createAdapterFamilyExactQuoteCache } from "../adapter-family-exact-quote-cache.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog, asPricedFamily } from
  "../venues/family-capability-catalog.js";
import { plugin as fluidCreditStrictFamilyPlugin } from "../venues/production-families/fluid-credit.production.js";
import { FLUID_CREDIT_PROBE_ACTOR, FLUID_VAULT_FACTORY_INTERFACE, FLUID_VAULT_INTERFACE } from
  "../venues/credit/fluid-family/codec.js";
import { FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID } from "../venues/credit/fluid-family/identity.js";
import { BORROW_STATE, capacityFixture, stateFixture } from "../venues/credit/fluid-family/test/quote-fixture.js";
import type { FluidCreditDescriptor } from "../venues/credit/fluid-family/types.js";
import { FLUID_RESOLVER_FACTORY } from "../venues/credit/fluid-family/capacity.js";
import { StrictAdapterFamilyShadowCatalogPublicationRoot, createStrictCatalogConsumer,
  strictPricingPublicationKeysByFamily } from "../adapter-family-shadow-catalog-publication.js";
import { catalogDiscoverySourceFingerprint, createCatalogStateInstanceMutationIssuer,
  createCatalogSourceTransitionIssuer, createCatalogTerminalRemovalIssuer } from
  "../adapter-family-catalog-publication.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import { blockScanEdgeKey, createVerifiedGraphView } from
  "../venues/blockscan-state-capability.js";
import { scannerConsumesEdge } from "../blockscan-pricing-delta.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "../venues/production-family-composition.js";
import type {
  ExecutionFamilyId,
  PendingExecutionEvidence,
} from "../venues/route-leg-adapter.js";
import { UNIV2_PAIR_INTERFACE } from
  "../venues/swaps/univ2-family/codec.js";
import { scanBlockStateFromResolvedMids } from
  "../detector/blockscan-scanner-core.js";
import { readBlockTouchedStateKeys } from "../blockscan-touched-state.js";
import { buildEffectiveMids, DEFAULT_EFFECTIVE_WETH_INPUT, effectiveEnumerationMids, effectiveMidRowCarried, type EffectiveMidRow, type EffectiveMidSnapshot } from "../blockscan-effective-mid.js";
import { effectiveUsdPricing } from "../blockscan-usd-view.js";

const STARTUP: CanonicalSource = Object.freeze({
  number: 25_800_000,
  hash: `0x${"61".repeat(32)}`,
  generation: 1,
});
const CURRENT: CanonicalSource = Object.freeze({
  number: 25_800_007,
  hash: `0x${"62".repeat(32)}`,
  generation: 2,
});
const WRONG_HASH: CanonicalSource = Object.freeze({
  ...CURRENT,
  hash: `0x${"63".repeat(32)}`,
});
const EXECUTOR = `0x${"64".repeat(20)}`;
const ORIGIN = `0x${"65".repeat(20)}`;
const ERC20_BALANCE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);
const ERC20_TRANSFER = new ethers.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
]);
let fixtureAmountSimulations = 0;

const pool = Object.freeze({
  pool: UNIV2_FIXTURE_POOL,
  factory: UNIV2_FIXTURE_FACTORY,
  token0: UNIV2_FIXTURE_TOKEN0,
  token1: UNIV2_FIXTURE_TOKEN1,
  reserves: Object.freeze({
    reserve0: 1_000_000_000n,
    reserve1: 2_000_000_000n,
    blockTimestampLast: 1,
  }),
});

await creditOptionalCapabilities();

const publication = await runUniv2Lifecycle(STARTUP, pool);
const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
  publication.familyId,
);
const startupView = buildFamilyRouteGraphView({
  routes: publication.instances.flatMap((instance) =>
    instance.routes.map((route, index) => ({
      family,
      descriptor: instance.descriptor,
      route,
      handle: instance.routeHandles[index],
    }))
  ),
});
const readyFundingAssets = Object.freeze(
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll()
    .filter((candidate) => candidate.plugin.manifest.domain === "funding")
    .map((candidate) => Object.freeze({
      familyId: candidate.plugin.manifest.familyId,
      asset: UNIV2_FIXTURE_TOKEN0,
    })),
);
const root = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: startupView.edges,
  readyInstances: publication.instances,
  readyFundingAssets,
});

function runtime(
  source: CanonicalSource,
  options: {
    readonly reserves?: Readonly<{
      readonly reserve0: bigint;
      readonly reserve1: bigint;
      readonly blockTimestampLast: number;
    }>;
    readonly reservesByTarget?: ReadonlyMap<string, Readonly<{
      readonly reserve0: bigint;
      readonly reserve1: bigint;
      readonly blockTimestampLast: number;
    }>>;
    readonly poolBalance?: (token: string, account: string) => bigint | undefined;
    readonly onCurrentPricingRead?: () => void;
    readonly onCurrentPricingReadStart?: (target: string) => void | Promise<void>;
    readonly onCurrentPricingReadEnd?: (target: string) => void;
    readonly onFundingRead?: (data: string) => void | Promise<void>;
    readonly onFundingReadEnd?: () => void;
    readonly isCurrent?: () => boolean;
    readonly currentPricingDelayMs?: number | ((target: string) => number);
    readonly failCurrentPricing?: boolean;
    readonly failCurrentPricingTarget?: string;
    readonly failFunding?: boolean;
    readonly fundingBalance?: bigint;
    readonly producerCallBackend?: StrictSessionRequest["pricingCallBackend"];
    readonly producerCallCache?: Pick<PinnedRethQuoteBackend, "callCached">;
    readonly exactCallBackend?: PinnedRethQuoteBackend;
    readonly omitAmountSimulation?: boolean;
  } = {},
) {
  const reserves = options.reserves ?? pool.reserves;
  return createStrictCentralAdapterRuntime({
    provider: {
      call: async (request) => {
        if (
          request.data.slice(0, 10).toLowerCase() ===
            UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector.toLowerCase()
        ) {
          const target = request.to.toLowerCase();
          try {
            await options.onCurrentPricingReadStart?.(target);
            const pricingDelayMs = typeof options.currentPricingDelayMs ===
                "function"
              ? options.currentPricingDelayMs(target)
              : options.currentPricingDelayMs ?? 0;
            if (pricingDelayMs > 0) {
              await new Promise((resolve) => setTimeout(
                resolve,
                pricingDelayMs,
              ));
            }
            options.onCurrentPricingRead?.();
            if (
              options.failCurrentPricing === true ||
              options.failCurrentPricingTarget === target
            ) {
              throw new Error("current pricing transport failed");
            }
            const targetReserves = options.reservesByTarget?.get(target) ?? reserves;
            return UNIV2_PAIR_INTERFACE.encodeFunctionResult(
              "getReserves",
              [
                targetReserves.reserve0,
                targetReserves.reserve1,
                targetReserves.blockTimestampLast,
              ],
            );
          } finally {
            options.onCurrentPricingReadEnd?.(target);
          }
        }
        const balanceAccount = String(ERC20_BALANCE.decodeFunctionData("balanceOf", request.data)[0]).toLowerCase();
        if (balanceAccount === pool.pool.toLowerCase() || options.reservesByTarget?.has(balanceAccount)) {
          return ERC20_BALANCE.encodeFunctionResult("balanceOf", [
            options.poolBalance?.(request.to.toLowerCase(), balanceAccount) ?? 10n ** 24n,
          ]);
        }
        if (options.failFunding === true) {
          throw new Error("current Funding transport failed");
        }
        try {
          await options.onFundingRead?.(request.data);
        } finally {
          options.onFundingReadEnd?.();
        }
        return ERC20_BALANCE.encodeFunctionResult(
          "balanceOf",
          [options.fundingBalance ?? 10n ** 24n],
        );
      },
      getCode: async () => "0x01",
      getStorage: async () => `0x${"00".repeat(32)}`,
    },
    executor: EXECUTOR,
    transactionOrigin: ORIGIN,
    // Session/transport fixture only, not an EVM or live acceptance result.
    // State-read RPC accounting below excludes this controlled simulator.
    ...(options.omitAmountSimulation ? {} : { simulator: {
      async simulate({ request, source: actualSource, callerAuthority }) {
        assert.deepEqual(actualSource, source);
        assert.equal(request.kind, "effect-delta-simulation");
        assert.equal(request.call.executionMode, "impersonated-call-frame");
        assert.ok(callerAuthority.transactionOrigin);
        assert.equal(callerAuthority.executor, EXECUTOR);
        assert.equal(request.preCalls?.length, 1);
        const transfer = request.preCalls![0]!;
        const [recipient, amountIn] = ERC20_TRANSFER.decodeFunctionData("transfer", transfer.data);
        assert.equal(String(recipient).toLowerCase(), request.call.to.toLowerCase());
        const [amount0Out, amount1Out, receiver, callback] =
          UNIV2_PAIR_INTERFACE.decodeFunctionData("swap", request.call.data);
        assert.equal(String(receiver).toLowerCase(), EXECUTOR);
        assert.equal(callback, "0x");
        assert.ok((amount0Out > 0n) !== (amount1Out > 0n));
        const amountOut = BigInt(amount0Out) + BigInt(amount1Out);
        const outputToken = amount0Out > 0n ? pool.token0 : pool.token1;
        const inputToken = amount0Out > 0n ? pool.token1 : pool.token0;
        assert.equal(transfer.to.toLowerCase(), inputToken.toLowerCase());
        assert.equal(request.overrideIntent.tokenBalances?.[0]?.amount, amountIn);
        assert.equal(request.observeTokenBalances?.length, 4);
        fixtureAmountSimulations++;
        return { data: "0x", effects: { tokenDeltas: [
          { token: inputToken, account: EXECUTOR, delta: -BigInt(amountIn) },
          { token: inputToken, account: request.call.to, delta: BigInt(amountIn) },
          { token: outputToken, account: request.call.to, delta: -amountOut },
          { token: outputToken, account: EXECUTOR, delta: amountOut },
        ] } };
      },
    } satisfies NonNullable<Parameters<typeof createStrictCentralAdapterRuntime>[0]["simulator"]> }),
    ...(options.producerCallBackend === undefined ? {} : { producerCallBackend: options.producerCallBackend }),
    ...(options.producerCallCache === undefined ? {} : { producerCallCache: options.producerCallCache }),
    ...(options.exactCallBackend === undefined ? {} : { exactCallBackend: options.exactCallBackend }),
    generationFence: Object.freeze({
      assertCurrent(generation: number, candidate: CanonicalSource) {
        if (
          options.isCurrent?.() === false ||
          generation !== source.generation ||
          candidate.number !== source.number ||
          candidate.hash.toLowerCase() !== source.hash.toLowerCase() ||
          candidate.generation !== source.generation
        ) {
          throw new Error("test generation fence rejected stale source");
        }
      },
    }),
  });
}

let currentPricingReads = 0;
let currentGenerationActive = true;
const strictRuntime = runtime(CURRENT, {
  isCurrent: () => currentGenerationActive,
  reserves: Object.freeze({
    reserve0: pool.reserves.reserve0 * 3n,
    reserve1: pool.reserves.reserve1,
    blockTimestampLast: pool.reserves.blockTimestampLast + 1,
  }),
  onCurrentPricingRead() {
    currentPricingReads++;
  },
});
await assert.rejects(
  root.createSession({
    source: WRONG_HASH,
    runtime: strictRuntime,
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  }),
  /generation fence rejected stale source/,
);

const session = await root.createSession({
  source: CURRENT,
  runtime: strictRuntime,
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});

function preparationGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function awaitPreparationGate(promise: Promise<unknown>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Use the real central issuer and both production Funding plugins. Held reads
// prove dispatch overlap and settlement, not a machine-dependent speedup.
{
  const reference = await root.createSession({
    source: CURRENT, runtime: runtime(CURRENT), fundingAssets: [UNIV2_FIXTURE_TOKEN0],
  });
  const comparableFunding = (value: StrictProductionRuntimeSession) => {
    const projection = value.fundingProjection();
    return { ...projection, outcomes: projection.outcomes.map((outcome) => {
      if (outcome.workReceipt === null) return outcome;
      const { timing, ...receipt } = outcome.workReceipt;
      return { ...outcome, workReceipt: { ...receipt, timing: { attempts: timing.attempts } } };
    }) };
  };
  for (const mode of [
    "funding-first", "pricing-first", "provider-failure",
    "late-abort", "late-retire", "late-deadline",
  ] as const) {
    const pricingStarted = preparationGate();
    const fundingStarted = preparationGate();
    const pricingRelease = preparationGate();
    const fundingRelease = preparationGate();
    const pricingEnded = preparationGate();
    const fundingEnded = preparationGate();
    const controller = new AbortController();
    // Expire the caller deadline deterministically after Funding has finished;
    // every work item retains this same control object.
    const control = { signal: controller.signal, deadlineAtMs: Date.now() + 10_000 };
    let current = true;
    let completed = false;
    let pricingActive = 0;
    let fundingActive = 0;
    let pricingCalls = 0;
    let fundingCompletions = 0;
    const fundingCalls = new Set<string>();
    let failedCall: string | undefined;
    const pending = root.createSession({
      source: CURRENT, kind: "pricing", fundingAssets: [UNIV2_FIXTURE_TOKEN0], control,
      runtime: runtime(CURRENT, {
        isCurrent: () => current,
        async onCurrentPricingReadStart() {
          pricingCalls++;
          pricingActive++;
          pricingStarted.release();
          await pricingRelease.promise;
        },
        onCurrentPricingReadEnd() {
          pricingActive--;
          pricingEnded.release();
        },
        async onFundingRead(data) {
          fundingActive++;
          fundingCalls.add(data);
          failedCall ??= data;
          if (fundingCalls.size === readyFundingAssets.length) fundingStarted.release();
          await fundingRelease.promise;
          if (mode === "provider-failure" && data === failedCall) {
            throw new Error("one overlapped Funding provider failed");
          }
        },
        onFundingReadEnd() {
          fundingActive--;
          if (++fundingCompletions >= readyFundingAssets.length) fundingEnded.release();
        },
      }),
    }).finally(() => { completed = true; });
    // Observe rejection even if the dispatch assertion fails on a serial baseline.
    const observed = Promise.allSettled([pending]);
    try {
      await awaitPreparationGate(
        Promise.all([pricingStarted.promise, fundingStarted.promise]),
        `pricing still blocks Funding dispatch (${mode})`,
      );
      assert.equal(pricingActive, 1);
      assert.equal(fundingActive, readyFundingAssets.length);
      if (mode === "pricing-first") {
        pricingRelease.release();
        await pricingEnded.promise;
      } else {
        fundingRelease.release();
        await fundingEnded.promise;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(completed, false, "one finished branch cannot publish a session");
      if (mode === "late-abort") controller.abort(new Error("test late head cancellation"));
      if (mode === "late-retire") current = false;
      if (mode === "late-deadline") control.deadlineAtMs = Date.now() - 1;
    } finally {
      pricingRelease.release();
      fundingRelease.release();
      await observed;
    }
    const created = await pending;
    assert.equal(pricingActive, 0);
    assert.equal(fundingActive, 0);
    assert.equal(pricingCalls, 1);
    assert.equal(fundingCalls.size, readyFundingAssets.length);
    assert.deepEqual(created.edges, reference.edges);
    const projection = created.fundingProjection();
    assert.deepEqual(projection.outcomes.map((outcome) => outcome.fundingId),
      reference.fundingProjection().outcomes.map((outcome) => outcome.fundingId));
    if (mode.startsWith("late-")) {
      assert.deepEqual(created.fundingActionIds(UNIV2_FIXTURE_TOKEN0), []);
      assert.equal(projection.sources.size, 0);
      assert.ok(projection.outcomes.every((outcome) => outcome.status === "unresolved"));
      assert.ok(projection.outcomes.every((outcome) => outcome.reasonCode.startsWith("funding-publication:")),
        "Funding completed successfully first; the join must invalidate its earlier offers");
      assert.throws(() => created.buildFundingRoot({
        actionAdapterId: "morpho-flash", asset: UNIV2_FIXTURE_TOKEN0,
        amount: 1n, minProfit: 1n, children: [],
      }), /no Funding offer/);
    } else if (mode === "provider-failure") {
      assert.equal(projection.outcomes.filter((outcome) => outcome.status === "verified").length, 1);
      assert.equal(created.fundingActionIds(UNIV2_FIXTURE_TOKEN0).length, 1);
      assert.equal(created.currentPricingForEdge(created.edges[0]!)?.status, "priced");
    } else {
      assert.deepEqual(comparableFunding(created), comparableFunding(reference));
      for (const actionAdapterId of reference.fundingActionIds(UNIV2_FIXTURE_TOKEN0)) {
        const input = { actionAdapterId, asset: UNIV2_FIXTURE_TOKEN0, amount: 1_000_000n, minProfit: 1n, children: [] };
        assert.deepEqual(created.buildFundingRoot(input), reference.buildFundingRoot(input));
      }
      for (const edge of created.edges) {
        assert.deepEqual(created.currentPricingForEdge(edge), reference.currentPricingForEdge(edge));
      }
    }
    console.log(`strict pricing/Funding overlap: PASS ${mode}`);
  }
  // Early Funding validation rejection must be observed, yet projection keeps
  // its original error priority. Exact sessions retain the same serial order.
  for (const kind of ["pricing", "exact"] as const) {
    await assert.rejects(root.createSession({
      source: CURRENT, kind, runtime: runtime(CURRENT), fundingAssets: ["invalid-address"],
      touchedPools: new Set(), requiredEdgeIds: new Set([startupView.edges[0]!.canonicalEdgeId!]),
    }), kind === "pricing" ? /missing required edge ids/ : /invalid address/);
  }
}

// A single physical Fluid DEX instance owns one pricing state per direction.
// The strict session must preserve those route-local state identities instead
// of rejecting the instance as internally contradictory.
const fluidPublication = await runFluidDexLifecycle(STARTUP);
const fluidFamily = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
  fluidPublication.familyId,
);
const fluidView = buildFamilyRouteGraphView({
  routes: fluidPublication.instances.flatMap((instance) =>
    instance.routes.map((route, index) => ({
      family: fluidFamily,
      descriptor: instance.descriptor,
      route,
      handle: instance.routeHandles[index],
    }))
  ),
});
const fluidRoot = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: fluidView.edges,
  readyInstances: fluidPublication.instances,
  readyFundingAssets: Object.freeze([]),
});
const fluidSession = await fluidRoot.createSession({
  source: CURRENT,
  runtime: fluidDexFixtureRuntime(),
  fundingAssets: Object.freeze([]),
});
const fluidStateKeys = new Set(
  fluidSession.edges.map((edge) => fluidSession.stateKeyForEdge(edge)),
);
assert.equal(fluidStateKeys.size, 2, "Fluid directions keep distinct state keys");
assert.ok(
  fluidSession.edges.every((edge) =>
    fluidSession.currentPricingForEdge(edge)?.status === "priced"
  ),
  "Fluid directions remain currently priced",
);

let familyScopedFundingReads = 0;
const oneFundingFamilyRoot = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: startupView.edges,
  readyInstances: publication.instances,
  readyFundingAssets: Object.freeze([readyFundingAssets[0]!]),
});
await oneFundingFamilyRoot.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT, {
    onFundingRead() {
      familyScopedFundingReads++;
    },
  }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});
assert.equal(
  familyScopedFundingReads,
  1,
  "a Funding Family may query only assets admitted for that Family",
);

const zeroLiquiditySession = await root.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT, { fundingBalance: 0n }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});
const zeroLiquidityProjection = zeroLiquiditySession.fundingProjection();
assert.ok(zeroLiquidityProjection.outcomes.length > 0);
assert.ok(zeroLiquidityProjection.outcomes.every((outcome) =>
  outcome.status === "verified" &&
  outcome.reasonCode === "funding-offer-derived"
));
assert.equal(
  zeroLiquidityProjection.sources.size,
  0,
  "verified zero-liquidity sources are resolved coverage, not planner offers",
);

const twoTokenReadyFundingAssets = Object.freeze(
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll()
    .filter((candidate) => candidate.plugin.manifest.domain === "funding")
    .flatMap((candidate) => [UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1]
      .map((asset) => Object.freeze({
        familyId: candidate.plugin.manifest.familyId,
        asset,
      }))),
);
const twoTokenFundingRoot = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: startupView.edges,
  readyInstances: publication.instances,
  readyFundingAssets: twoTokenReadyFundingAssets,
});
const twoTokenFundingProjection = (await twoTokenFundingRoot.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT),
  fundingAssets: Object.freeze([
    UNIV2_FIXTURE_TOKEN0,
    UNIV2_FIXTURE_TOKEN1,
  ]),
})).fundingProjection();
assert.equal(
  twoTokenFundingProjection.outcomes.length,
  twoTokenReadyFundingAssets.length,
  "Funding outcomes partition every dynamically cataloged provider/token source",
);
assert.equal(twoTokenFundingProjection.sources.size, 2);

// Real central issuance/decoding and strict Funding authority; only the HTTP
// endpoint is synthetic. The exact session may reuse bytes, not Funding offers.
{
  type WireCall = {
    id: number;
    method: string;
    params: [{ to: string; data: string; from?: string }, { blockHash: string; requireCanonical: boolean }];
  };
  const wire: Array<{ lane: string; call: WireCall }> = [];
  const stubErrors: unknown[] = [];
  const mixedBatches: WireCall[][] = [];
  const projectionBatchStarted = preparationGate();
  let releaseProjectionBatch: (() => void) | undefined;
  const balanceSelector = ERC20_BALANCE.getFunction("balanceOf")!.selector;
  const reservesSelector = UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireCall | WireCall[];
        if (req.url === "/mixed-failure") mixedBatches.push(Array.isArray(body) ? body : [body]);
        const reply = (call: WireCall) => {
          wire.push({ lane: req.url!, call });
          assert.equal(call.method, "eth_call");
          assert.deepEqual(call.params[1], { blockHash: CURRENT.hash, requireCanonical: true });
          const selector = call.params[0].data.slice(0, 10);
          assert.ok(selector === balanceSelector || selector === reservesSelector, "unexpected local fixture call");
          if (req.url === "/failed") return {
            jsonrpc: "2.0", id: call.id, error: { code: 3, message: "execution reverted", data: "0xdeadbeef" },
          };
          if (req.url === "/mixed-failure") return {
            jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "mixed batch transport failure" },
          };
          const result = selector === balanceSelector
            ? ERC20_BALANCE.encodeFunctionResult("balanceOf", [10n ** 24n])
            : UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [
              pool.reserves.reserve0, pool.reserves.reserve1, pool.reserves.blockTimestampLast,
            ]);
          return { jsonrpc: "2.0", id: call.id, result };
        };
        const response = Array.isArray(body) ? body.map(reply) : reply(body);
        const send = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(response));
        };
        if (req.url === "/projection-failure") {
          releaseProjectionBatch = send;
          projectionBatchStarted.release();
        } else send();
      } catch (error) {
        stubErrors.push(error);
        res.end(JSON.stringify({ error: "unexpected fixture request" }));
      }
    });
  });
  const backends: PinnedRethQuoteBackend[] = [];
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const backend = (lane: string, transportLane: "producer-bulk" | "exact") => {
      const client = new PinnedRethQuoteBackend(`http://127.0.0.1:${address.port}/${lane}`, CURRENT.hash, {
        transportLane, deadlineAtMs: Date.now() + 5000, allowSingleCallFallback: false,
        maxBatchSize: 128, maxConcurrentBatches: 4,
      });
      backends.push(client);
      return client;
    };
    const producer = backend("producer", "producer-bulk");
    const exactBackend = backend("exact", "exact");
    const failedCache = backend("failed", "producer-bulk");
    let directReads = 0;
    const unexpectedDirectRead = () => { directReads++; };
    const pricing = await twoTokenFundingRoot.createSession({
      source: CURRENT, kind: "pricing", fundingAssets: [UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1],
      runtime: runtime(CURRENT, {
        producerCallBackend: producer,
        onFundingRead: unexpectedDirectRead, onCurrentPricingRead: unexpectedDirectRead,
      }),
    });
    await producer.drain();
    const pricingWireCount = wire.length;
    const fundingCalls = wire.filter(({ call }) => call.params[0].data.startsWith(balanceSelector) &&
      String(ERC20_BALANCE.decodeFunctionData("balanceOf", call.params[0].data)[0]).toLowerCase() !== pool.pool.toLowerCase());
    assert.equal(fundingCalls.length, 4, "pricing reads two providers for each of two assets");
    assert.equal(pricingWireCount, 7, "pricing reads reserves and both pool balances with four Funding reads");
    assert.equal(producer.stats().batchesSent, 1, "pricing and both Funding Families share one batch");
    assert.equal(producer.stats().maxBatchItemsSent, 7);
    assert.equal(pricing.fundingProjection().sources.size, 2);
    const refined = await twoTokenFundingRoot.createSession({
      source: CURRENT, kind: "exact", fundingAssets: [UNIV2_FIXTURE_TOKEN0],
      control: { deadlineAtMs: Date.now() + 2000 },
      runtime: runtime(CURRENT, {
        producerCallCache: producer, exactCallBackend: exactBackend,
        onFundingRead: unexpectedDirectRead, onCurrentPricingRead: unexpectedDirectRead,
      }),
    });
    await producer.drain();
    assert.equal(wire.length, pricingWireCount, "second-phase Funding must issue zero physical RPC items");
    assert.equal(directReads, 0, "warm Funding unexpectedly fell back to the raw provider");
    assert.equal(producer.stats().memoHits, 2);
    assert.equal(producer.stats().lane, "producer-bulk");
    assert.equal(exactBackend.stats().totalCalls, 0, "Funding must not enter the exact backend");
    let baselineFundingReads = 0;
    const baseline = await twoTokenFundingRoot.createSession({
      source: CURRENT, kind: "exact", fundingAssets: [UNIV2_FIXTURE_TOKEN0],
      runtime: runtime(CURRENT, { onFundingRead() { baselineFundingReads++; } }),
    });
    assert.equal(baselineFundingReads, 2);
    const comparableFunding = (current: StrictProductionRuntimeSession) => {
      const projection = current.fundingProjection();
      return { ...projection, outcomes: projection.outcomes.map((outcome) => {
        if (!outcome.workReceipt) return outcome;
        // Only clock-dependent receipt timing differs; retain attempts and all
        // schedule/source/evidence/failure/offer fields in the comparison.
        const { timing, ...receipt } = outcome.workReceipt;
        return { ...outcome, workReceipt: { ...receipt, timing: { attempts: timing.attempts } } };
      }) };
    };
    const projection = refined.fundingProjection();
    assert.deepEqual(comparableFunding(refined), comparableFunding(baseline));
    for (const outcome of projection.outcomes) {
      assert.deepEqual(outcome.source, CURRENT);
      assert.equal(outcome.status, "verified");
      assert.notStrictEqual(outcome, pricing.fundingProjection().outcomes.find((old) => old.fundingId === outcome.fundingId));
    }
    const actions = refined.fundingActionIds(UNIV2_FIXTURE_TOKEN0, 1_000_000n);
    assert.deepEqual(actions, ["morpho-flash", "balancer-flash"]);
    assert.deepEqual(actions, baseline.fundingActionIds(UNIV2_FIXTURE_TOKEN0, 1_000_000n));
    for (const actionAdapterId of actions) {
      const input = { actionAdapterId, asset: UNIV2_FIXTURE_TOKEN0, amount: 1_000_000n, minProfit: 1n, children: [] };
      assert.deepEqual(refined.buildFundingRoot(input), baseline.buildFundingRoot(input));
    }
    const edge = refined.edges[0]!;
    const quote = await refined.issueExact({ edge, amountIn: 1_000_000n, executor: EXECUTOR, runtimeEvidence: [] });
    assert.ok(quote.amountOut > 0n);
    assert.deepEqual(quote.source, CURRENT);
    assert.equal(refined.buildExecution({ edge, exact: quote, minAmountOut: quote.amountOut - 1n, executor: EXECUTOR }).status, "resolved");
    await exactBackend.drain();
    assert.equal(wire.length, pricingWireCount, "Exact reuses producer state reads for the local reserve formula");
    assert.equal(producer.stats().memoHits, 4);
    assert.equal(exactBackend.stats().totalCalls, 0);
    assert.equal(directReads, 0);
    const baselineQuote = await baseline.issueExact({ edge: baseline.edges[0]!, amountIn: 1_000_000n, executor: EXECUTOR, runtimeEvidence: [] });
    assert.equal(quote.amountOut, baselineQuote.amountOut);
    assert.deepEqual(refined.buildExecution({ edge, exact: quote, minAmountOut: quote.amountOut - 1n, executor: EXECUTOR }),
      baseline.buildExecution({ edge: baseline.edges[0]!, exact: baselineQuote, minAmountOut: baselineQuote.amountOut - 1n, executor: EXECUTOR }));

    // Reorg/same-height different hash: mint fresh authority and use the
    // ordinary fallback, never relabel the preceding producer's bytes.
    let reorgReads = 0;
    const reorgReserves = { ...pool.reserves, reserve1: pool.reserves.reserve1 * 2n };
    const reorg = await twoTokenFundingRoot.createSession({
      source: WRONG_HASH, kind: "exact", fundingAssets: [],
      runtime: runtime(WRONG_HASH, { producerCallCache: producer, reserves: reorgReserves, onCurrentPricingRead() { reorgReads++; } }),
    });
    const reorgQuote = await reorg.issueExact({ edge: reorg.edges[0]!, amountIn: 1_000_000n, executor: EXECUTOR, runtimeEvidence: [] });
    assert.equal(reorgReads, 1);
    assert.deepEqual(reorgQuote.source, WRONG_HASH);
    assert.ok(reorgQuote.amountOut > quote.amountOut);
    assert.equal(producer.stats().memoHits, 4, "wrong source must not count a successful cache hit");

    // No successful producer entry: Exact keeps its own cold transport.
    const cold = await twoTokenFundingRoot.createSession({
      source: CURRENT, kind: "exact", fundingAssets: [],
      runtime: runtime(CURRENT, { producerCallCache: failedCache, exactCallBackend: exactBackend }),
    });
    const coldQuote = await cold.issueExact({ edge: cold.edges[0]!, amountIn: 1_000_000n, executor: EXECUTOR, runtimeEvidence: [] });
    await exactBackend.drain();
    assert.equal(coldQuote.amountOut, quote.amountOut);
    assert.equal(wire.length, pricingWireCount + 2, "cold Exact reads both reserves and capacity after a producer miss");
    assert.equal(wire.at(-1)!.lane, "/exact");
    assert.deepEqual(new Set(wire.slice(pricingWireCount).map(item => item.call.params[0].data.slice(0, 10))),
      new Set([reservesSelector, balanceSelector]));

    // A missing or failed cache entry must retain the old direct-provider path,
    // never enqueue/join producer transport. Fresh offers still decode normally.
    for (const priorFailure of [false, true]) {
      if (priorFailure) {
        const request = fundingCalls.find(({ call }) => call.params[0].to.toLowerCase() === UNIV2_FIXTURE_TOKEN0.toLowerCase())!.call.params[0];
        await assert.rejects(failedCache.call(request), /revert/i);
        await failedCache.drain();
      }
      const before: number = wire.length;
      let fallbackReads = 0;
      const fallback = await twoTokenFundingRoot.createSession({
        source: CURRENT, kind: "exact", fundingAssets: [UNIV2_FIXTURE_TOKEN0],
        runtime: runtime(CURRENT, { producerCallCache: failedCache, onFundingRead() { fallbackReads++; } }),
      });
      await failedCache.drain();
      assert.equal(fallbackReads, 2, "cache miss/failure must use the original direct provider");
      assert.equal(wire.length, before, "cache lookup changed the miss path to producer batching");
      assert.deepEqual(comparableFunding(fallback), comparableFunding(refined));
      assert.deepEqual(fallback.fundingActionIds(UNIV2_FIXTURE_TOKEN0), actions);
    }

    // Shared batch failure must keep both pricing and Funding unresolved without
    // inventing a fallback lane, suppressing outcomes or leaving HTTP work alive.
    const mixedBackend = backend("mixed-failure", "producer-bulk");
    const mixed = await twoTokenFundingRoot.createSession({
      source: CURRENT, kind: "pricing", fundingAssets: [UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1],
      runtime: runtime(CURRENT, {
        producerCallBackend: mixedBackend,
        onFundingRead: unexpectedDirectRead, onCurrentPricingRead: unexpectedDirectRead,
      }),
    });
    await mixedBackend.drain();
    assert.equal(mixedBatches[0]!.length, 7);
    assert.deepEqual(new Set(mixedBatches[0]!.map((call) => call.params[0].data.slice(0, 10))),
      new Set([balanceSelector, reservesSelector]), "failure must cover an actual mixed pricing/Funding envelope");
    assert.equal(mixed.fundingProjection().outcomes.length, 4);
    assert.ok(mixed.fundingProjection().outcomes.every((outcome) => outcome.status === "unresolved"));
    assert.equal(mixed.fundingProjection().sources.size, 0);
    assert.ok(mixed.edges.every((edge) => mixed.currentPricingForEdge(edge)?.status === "unresolved"));
    assert.equal(directReads, 0);
    assert.equal(mixedBackend.stats().singleCallFallbacks, 0);
    assert.ok(mixedBackend.stats().peakInFlightBatches <= 4);
    assert.equal(mixedBackend.stats().activeTransports, 0);

    // Deliberate changed failure-path scope: an invalid required projection now
    // issues the same two Funding reads before it fails. The failure must wait
    // for that work; the caller still owns physical drain/close.
    const projectionBackend = backend("projection-failure", "producer-bulk");
    let projectionSettled = false;
    const projectionPending = root.createSession({
      source: CURRENT, kind: "pricing", fundingAssets: [UNIV2_FIXTURE_TOKEN0],
      touchedPools: new Set(), requiredEdgeIds: new Set([startupView.edges[0]!.canonicalEdgeId!]),
      runtime: runtime(CURRENT, {
        producerCallBackend: projectionBackend,
        onFundingRead: unexpectedDirectRead, onCurrentPricingRead: unexpectedDirectRead,
      }),
    }).finally(() => { projectionSettled = true; });
    const projectionObserved = Promise.allSettled([projectionPending]);
    try {
      await awaitPreparationGate(projectionBatchStarted.promise, "projection failure did not dispatch Funding");
      assert.equal(projectionSettled, false);
      assert.equal(projectionBackend.stats().activeTransports, 1);
      assert.equal(wire.filter((entry) => entry.lane === "/projection-failure").length, 2);
    } finally {
      releaseProjectionBatch?.();
      await projectionObserved;
      await projectionBackend.drain();
    }
    await assert.rejects(projectionPending, /missing required edge ids/);
    assert.equal(projectionBackend.stats().activeTransports, 0);
    assert.equal(projectionBackend.stats().liveItems, 0);
    assert.equal(directReads, 0);
    assert.deepEqual(stubErrors, []);
  console.log("strict same-source phase reuse: PASS (pricing 4 Funding + reserves + 2 balances in one batch; warm Funding/Exact 0 additional state-read RPC; cold Exact 2 reads; no amount simulation; reorg bypass; miss/revert Funding 2 direct each)");
    console.log("strict pricing/Funding transport: PASS (one mixed batch; mixed failure unresolved; projection failure waits; caller drains)");
  } finally {
    const closed = await Promise.allSettled(backends.map((client) => client.closeAndDrain()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.ok(closed.every((result) => result.status === "fulfilled"));
    for (const client of backends) {
      const stats = client.stats();
      assert.deepEqual([stats.pendingItems, stats.liveItems, stats.inFlightBatches, stats.activeTransports], [0, 0, 0, 0]);
    }
  }
}

// Performance contract: independent ready instances refresh under the
// bounded pool, each exactly once, while the resulting strict topology keeps
// deterministic ready order. This checks concurrency directly rather than
// relying on a machine-dependent wall-clock threshold.
const parallelPublications = await Promise.all(Array.from(
  { length: 20 },
  (_, index) => runUniv2Lifecycle(STARTUP, Object.freeze({
    ...pool,
    pool: `0x${(0x1000 + index).toString(16).padStart(40, "0")}`,
  })),
));
const parallelReadyInstances = Object.freeze(parallelPublications.flatMap(
  (candidate) => candidate.instances,
));
const parallelStartupView = buildFamilyRouteGraphView({
  routes: parallelReadyInstances.flatMap((instance) =>
    instance.routes.map((route, index) => ({
      family,
      descriptor: instance.descriptor,
      route,
      handle: instance.routeHandles[index],
    }))
  ),
});
const parallelRoot = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: parallelStartupView.edges,
  readyInstances: parallelReadyInstances,
  readyFundingAssets,
});

// Instrument reads around real lifecycle-issued instances/Graph edges, not
// fabricated runtime handles. An empty Funding closure must not walk Ready.
let indexedFamilyLookups = 0;
let readyEdgeReads = 0;
const indexedCatalog = new Proxy(PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG, {
  get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      if (property === "forStrictFamily") indexedFamilyLookups++;
      return Reflect.apply(value, target, args);
    };
  },
});
const indexedRoot = new StrictProductionRuntimeRoot({
  catalog: indexedCatalog,
  readySource: STARTUP,
  readyGraph: parallelStartupView.edges.map((edge) => new Proxy(edge, {
    get(target, property) { readyEdgeReads++; return Reflect.get(target, property, target); },
  })),
  readyInstances: parallelReadyInstances,
  readyFundingAssets,
});
indexedFamilyLookups = 0;
readyEdgeReads = 0;
const emptyIndexed = await indexedRoot.createSession({
  source: CURRENT, runtime: runtime(CURRENT), fundingAssets: [],
  kind: "exact", requiredEdgeIds: new Set(),
});
assert.equal(emptyIndexed.edges.length, 0);
assert.equal(emptyIndexed.creationTiming.selectedInstanceCount, 0);
assert.equal(indexedFamilyLookups, 0, "empty exact closure must not inspect Ready Families");
assert.equal(readyEdgeReads, 0, "session validation must reuse startup edge bindings");

const selectedReadyKeys = new Set<string>([
  parallelReadyInstances[2]!.instanceKey, parallelReadyInstances[17]!.instanceKey,
]);
const selectedReadyEdges = parallelStartupView.edges.filter((edge) =>
  selectedReadyKeys.has(edge.instanceKey!)
);
const indexedSubset = await indexedRoot.createSession({
  source: CURRENT, runtime: runtime(CURRENT), fundingAssets: [], kind: "exact",
  // Reverse closure input; two directions share each instance owner.
  requiredEdgeIds: new Set([...selectedReadyEdges].reverse().map((edge) => edge.canonicalEdgeId!)),
});
assert.equal(indexedSubset.creationTiming.selectedInstanceCount, 2);
assert.equal(indexedSubset.creationTiming.refreshedInstanceCount, 0);
assert.deepEqual(indexedSubset.edges.map((edge) => edge.canonicalEdgeId),
  selectedReadyEdges.map((edge) => edge.canonicalEdgeId), "preserve Ready projection order");
assert(indexedFamilyLookups < parallelReadyInstances.length, "narrow exact must avoid all-Ready Family lookup");
assert.equal(readyEdgeReads, 0);
const indexedQuoteOutputs = new Map<string, bigint>();
for (const edge of indexedSubset.edges) {
  const quote = await indexedSubset.issueExact({
    edge, amountIn: 1_000_000n, executor: EXECUTOR, runtimeEvidence: [],
  });
  assert.equal(quote.status, "resolved");
  indexedQuoteOutputs.set(edge.canonicalEdgeId!, quote.amountOut);
}
const indexedAll = await indexedRoot.createSession({
  source: CURRENT, runtime: runtime(CURRENT), fundingAssets: [], kind: "exact",
});
assert.equal(indexedAll.creationTiming.selectedInstanceCount, parallelReadyInstances.length);
assert.deepEqual(indexedAll.edges.map((edge) => edge.canonicalEdgeId),
  parallelStartupView.edges.map((edge) => edge.canonicalEdgeId));
assert.equal(readyEdgeReads, 0);
for (const edge of indexedAll.edges.filter((edge) => indexedQuoteOutputs.has(edge.canonicalEdgeId!))) {
  const quote = await indexedAll.issueExact({
    edge, amountIn: 1_000_000n, executor: EXECUTOR, runtimeEvidence: [],
  });
  assert.equal(quote.amountOut, indexedQuoteOutputs.get(edge.canonicalEdgeId!));
}
assert.throws(() => new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: parallelStartupView.edges.map((edge, index) =>
    index === 0 ? { ...edge, target: ethers.ZeroAddress } : edge
  ),
  readyInstances: parallelReadyInstances, readyFundingAssets,
}), /route contract differs/, "cached bindings must not admit a mismatched startup Graph");

let activePricingReads = 0;
let maxActivePricingReads = 0;
let totalParallelPricingReads = 0;
const parallelSession = await parallelRoot.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT, {
    currentPricingDelayMs: 5,
    onCurrentPricingReadStart() {
      activePricingReads++;
      maxActivePricingReads = Math.max(
        maxActivePricingReads,
        activePricingReads,
      );
    },
    onCurrentPricingReadEnd() {
      activePricingReads--;
    },
    onCurrentPricingRead() {
      totalParallelPricingReads++;
    },
  }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});
assert.equal(
  totalParallelPricingReads,
  parallelReadyInstances.length,
  "each ready instance must perform exactly one current pricing read",
);
assert.ok(
  maxActivePricingReads > 1,
  "ready instance refresh must make real concurrent progress",
);
assert.ok(
  maxActivePricingReads <= 128,
  "ready instance refresh must respect the bounded concurrency cap",
);
assert.equal(
  parallelSession.creationTiming.readyInstanceCount,
  parallelReadyInstances.length,
);
assert.equal(
  parallelSession.creationTiming.selectedInstanceCount,
  parallelReadyInstances.length,
);
assert.equal(
  parallelSession.creationTiming.refreshedInstanceCount,
  parallelReadyInstances.length,
);
assert.equal(parallelSession.creationTiming.failedInstanceCount, 0);
assert.equal(parallelSession.creationTiming.requestedFundingAssetCount, 1);
assert.ok(parallelSession.creationTiming.pricingMs >= 0);
assert.ok(parallelSession.creationTiming.fundingMs >= 0);
assert.ok(parallelSession.creationTiming.routeProjectionMs >= 0);
assert.ok(parallelSession.creationTiming.totalMs >= 0);
assert.ok(parallelSession.creationTiming.heapUsedBytes > 0);
assert.deepEqual(
  parallelSession.edges.map((candidate) => candidate.canonicalEdgeId),
  parallelStartupView.edges.map((candidate) => candidate.canonicalEdgeId),
  "concurrent refresh must preserve deterministic ready edge order",
);

let activeFailedRefreshReads = 0;
const firstParallelTarget = parallelReadyInstances[0]!.instanceKey.toLowerCase();
const secondParallelTarget = parallelReadyInstances[1]!.instanceKey.toLowerCase();
const carryNextSource: CanonicalSource = Object.freeze({
  number: CURRENT.number + 1,
  hash: `0x${"63".repeat(32)}`,
  generation: CURRENT.generation + 1,
});
const carryBaseGraph = createVerifiedGraphView({
  id: "strict-carry-base",
  generation: CURRENT.generation,
  sourceBlock: CURRENT.number,
  sourceBlockHash: CURRENT.hash,
  completenessWatermark: CURRENT.number,
  perSourceCoverage: Object.freeze([Object.freeze({
    familyId: publication.familyId,
    sourceId: "strict-carry-test",
    sourceFingerprint: "strict-carry-test-v1",
    completeThroughBlock: CURRENT.number,
    completeThroughHash: CURRENT.hash,
  })]),
  familyIdForEdge: () => publication.familyId,
  edges: parallelStartupView.edges,
});
const carryNextGraph = createVerifiedGraphView({
  id: "strict-carry-next",
  generation: carryNextSource.generation,
  sourceBlock: carryNextSource.number,
  sourceBlockHash: carryNextSource.hash,
  completenessWatermark: carryNextSource.number,
  perSourceCoverage: Object.freeze([Object.freeze({
    familyId: publication.familyId,
    sourceId: "strict-carry-test",
    sourceFingerprint: "strict-carry-test-v1",
    completeThroughBlock: carryNextSource.number,
    completeThroughHash: carryNextSource.hash,
  })]),
  familyIdForEdge: () => publication.familyId,
  edges: parallelStartupView.edges,
});
const producerPricingBackend = Object.freeze({
  call: async () => {
    throw new Error("producer pricing backend should be transport-only in this test");
  },
});
let sparseCarrySession: StrictProductionRuntimeSession | null = null;
let donatedBalance = 0n;
const pricingHistoryPublications: StrictPricingPublication[] = [];
const carryBaseCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => {
    assert.equal(request.purpose, "coarse-pricing");
    assert.deepEqual(request.fundingAssets, [], "coarse pricing excludes Funding");
    assert.equal(
      request.pricingCallBackend,
      producerPricingBackend,
      "coarse coordinator forwards its generation-scoped pricing backend",
    );
    const created = parallelRoot.createSession({
      source: request.source,
      runtime: runtime(request.source, {
        poolBalance: (token, account) =>
          token === UNIV2_FIXTURE_TOKEN0.toLowerCase() && account === firstParallelTarget
            ? 10n ** 24n + donatedBalance : undefined,
        reservesByTarget: new Map<string, Readonly<{
          reserve0: bigint;
          reserve1: bigint;
          blockTimestampLast: number;
        }>>([
          [firstParallelTarget, Object.freeze({ reserve0: 1_000_000_000n, reserve1: 3_000_000_000n, blockTimestampLast: 1 })],
          [secondParallelTarget, Object.freeze({ reserve0: 3_000_000_000n, reserve1: 1_000_000_000n, blockTimestampLast: 1 })],
        ]),
      }),
      fundingAssets: request.fundingAssets,
      kind: "pricing",
      ...(request.control === undefined ? {} : { control: request.control }),
      ...(request.exactCallBackend === undefined
        ? {}
        : { exactCallBackend: request.exactCallBackend }),
      ...(request.touchedPools === undefined
        ? {}
        : { touchedPools: request.touchedPools }),
      ...(request.pricingCallBackend === undefined
        ? {}
        : { pricingCallBackend: request.pricingCallBackend }),
      ...(request.requiredEdgeIds === undefined
        ? {}
        : { requiredEdgeIds: request.requiredEdgeIds }),
    });
    if (request.source.number === carryNextSource.number) {
      sparseCarrySession = await created;
      return sparseCarrySession;
    }
    return created;
  },
  () => {},
  (pricingPublication) => pricingHistoryPublications.push(pricingPublication),
);
const carryBase = await carryBaseCoordinator.prepareCoarsePricing({
  graph: carryBaseGraph,
  pricingCallBackend: producerPricingBackend,
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(carryBase.status, "complete");
assert.equal(pricingHistoryPublications.length, 1);
assert.equal(pricingHistoryPublications[0]!.kind, "baseline");
assert.strictEqual(
  pricingHistoryPublications[0]!.snapshot,
  carryBase.snapshot,
  "the history baseline reuses the published full snapshot",
);
const bootstrapCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => {
    assert.equal(request.purpose, "coarse-pricing");
    assert.deepEqual(request.fundingAssets, [], "bootstrap excludes Funding");
    assert.equal(request.touchedPools, undefined, "bootstrap refreshes all instances");
    return parallelRoot.createSession({
      source: request.source,
      runtime: runtime(request.source),
      fundingAssets: request.fundingAssets,
      kind: "pricing",
      ...(request.control === undefined ? {} : { control: request.control }),
    });
  },
  () => {},
);
const bootstrap = await bootstrapCoordinator.prepareCoarsePricing({
  graph: carryBaseGraph,
  touchedPools: new Set([firstParallelTarget]),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(bootstrap.status, "complete");
assert.equal(bootstrap.snapshot.coverage.carriedEdgeKeys?.length, 0);
assert.equal(
  bootstrap.snapshot.coverage.refreshedEdgeKeys?.length,
  carryBaseGraph.scannerEdgeCount,
  "without a baseline, bootstrap refreshes the complete graph",
);
const edgeA = carryBaseGraph.edges.find((candidate) =>
  candidate.instanceKey?.toLowerCase() === firstParallelTarget
)!;
const edgeB = carryBaseGraph.edges.find((candidate) =>
  candidate.instanceKey?.toLowerCase() === secondParallelTarget
)!;
const touchedA = new Set([firstParallelTarget]);
const carried = await carryBaseCoordinator.prepareCoarsePricing({
  graph: carryNextGraph,
  pricingCallBackend: producerPricingBackend,
  touchedPools: touchedA,
  canonicalActivity: Object.freeze({
    source: carryNextSource,
    touchedStateKeys: touchedA,
    complete: true,
  }),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(carried.status, "complete");
const carriedPricing = carried.snapshot;
assert.equal(
  carriedPricing.pricingProvenanceByEdgeKey?.get(edgeA.canonicalEdgeId!),
  "refreshed",
);
assert.equal(
  carriedPricing.pricingProvenanceByEdgeKey?.get(edgeB.canonicalEdgeId!),
  "carried",
);
assert.equal(carriedPricing.coverage.carriedEdgeKeys?.length, 38);
assert.equal(carriedPricing.coverage.unresolvedEdgeKeys.length, 0);
assert.ok(carriedPricing.mids.has(edgeA.canonicalEdgeId!));
assert.ok(carriedPricing.mids.has(edgeB.canonicalEdgeId!));
const carryDelta = pricingHistoryPublications[1]!;
assert.equal(carryDelta.kind, "delta");
if (carryDelta.kind === "delta") {
  assert.equal(carryDelta.previousSourceBlock, carryBase.snapshot.sourceBlock);
  assert.deepEqual(carryDelta.removals, []);
  assert.equal(
    carryDelta.updates.length,
    carriedPricing.coverage.refreshedEdgeKeys?.length,
  );
  const touchedEdgeKeys = new Set<string>(carryNextGraph.edges
    .filter((candidate) =>
      candidate.instanceKey?.toLowerCase() === firstParallelTarget
    )
    .map((candidate) => String(candidate.canonicalEdgeId!)));
  assert.ok(carryDelta.updates.every(([edgeKey]) => touchedEdgeKeys.has(edgeKey)));
  assert.ok(
    !carryDelta.updates.some(([edgeKey]) => edgeKey === edgeB.canonicalEdgeId),
    "the carried clean edge is inherited by baseline reconstruction, not re-emitted",
  );
}

const carryThirdSource: CanonicalSource = Object.freeze({
  number: carryNextSource.number + 1,
  hash: `0x${"65".repeat(32)}`,
  generation: carryNextSource.generation + 1,
});
const carryThirdGraph = createVerifiedGraphView({
  id: "strict-carry-third",
  generation: carryThirdSource.generation,
  sourceBlock: carryThirdSource.number,
  sourceBlockHash: carryThirdSource.hash,
  completenessWatermark: carryThirdSource.number,
  perSourceCoverage: Object.freeze([Object.freeze({
    familyId: publication.familyId,
    sourceId: "strict-carry-test",
    sourceFingerprint: "strict-carry-test-v1",
    completeThroughBlock: carryThirdSource.number,
    completeThroughHash: carryThirdSource.hash,
  })]),
  familyIdForEdge: () => publication.familyId,
  edges: parallelStartupView.edges,
});
const carriedAgain = await carryBaseCoordinator.prepareCoarsePricing({
  graph: carryThirdGraph,
  pricingCallBackend: producerPricingBackend,
  touchedPools: touchedA,
  canonicalActivity: Object.freeze({
    source: carryThirdSource,
    touchedStateKeys: touchedA,
    complete: true,
  }),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(carriedAgain.status, "complete");
assert.strictEqual(
  carriedAgain.snapshot.coverageByEdgeKey,
  carriedPricing.coverageByEdgeKey,
  "unchanged coverage categories reuse the prior coverage map",
);
assert.strictEqual(
  carriedAgain.snapshot.pricingStateKeyByEdgeKey,
  carriedPricing.pricingStateKeyByEdgeKey,
  "unchanged topology reuses the prior state-key index",
);
assert.strictEqual(
  carriedAgain.snapshot.pricingFamilyIdByEdgeKey,
  carriedPricing.pricingFamilyIdByEdgeKey,
  "unchanged topology reuses the prior Family index",
);
assert.strictEqual(
  carriedAgain.snapshot.pricingProvenanceByEdgeKey,
  carriedPricing.pricingProvenanceByEdgeKey,
  "unchanged refreshed/carried classification reuses provenance",
);
assert.strictEqual(
  carriedAgain.snapshot.mids.get(edgeB.canonicalEdgeId!),
  carriedPricing.mids.get(edgeB.canonicalEdgeId!),
  "a clean carried mid is reused directly",
);
assert.notStrictEqual(
  carriedAgain.snapshot.mids,
  carriedPricing.mids,
  "the refreshed A entry still publishes a new delta map",
);

await carryBaseCoordinator.resetDynamicStateForReplay();
const fullRebuild = await carryBaseCoordinator.prepareCoarsePricing({
  graph: carryThirdGraph,
  pricingCallBackend: producerPricingBackend,
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(fullRebuild.status, "complete");
assert.equal(pricingHistoryPublications.at(-1)?.kind, "baseline");
assert.deepEqual(
  [...fullRebuild.snapshot.coverageByEdgeKey.entries()],
  [...carriedAgain.snapshot.coverageByEdgeKey.entries()],
  "delta publication preserves the full coverage result",
);
for (const candidate of [edgeA, edgeB]) {
  assert.equal(
    fullRebuild.snapshot.mids.get(candidate.canonicalEdgeId!)?.mid,
    carriedAgain.snapshot.mids.get(candidate.canonicalEdgeId!)?.mid,
    "delta publication preserves full-rebuild mid values",
  );
}

// A donation calls only the token and emits no pool Sync. The existing
// activity reader must still invalidate the pool's directional headroom.
const donationSource: CanonicalSource = Object.freeze({
  number: carryThirdSource.number + 1,
  hash: `0x${"66".repeat(32)}`,
  generation: carryThirdSource.generation + 1,
});
const donationGraph = createVerifiedGraphView({
  ...carryThirdGraph,
  id: "strict-carry-donation",
  sourceBlock: donationSource.number,
  sourceBlockHash: donationSource.hash,
  generation: donationSource.generation,
  completenessWatermark: donationSource.number,
  perSourceCoverage: carryThirdGraph.perSourceCoverage.map((coverage) => ({
    ...coverage,
    completeThroughBlock: donationSource.number,
    completeThroughHash: donationSource.hash,
  })),
  familyIdForEdge: () => publication.familyId,
});
const donationEdge = donationGraph.edges.find((candidate) =>
  candidate.instanceKey?.toLowerCase() === firstParallelTarget &&
  candidate.tokenIn.toLowerCase() === UNIV2_FIXTURE_TOKEN0.toLowerCase()
)!;
const donationBefore = fullRebuild.snapshot.mids.get(donationEdge.canonicalEdgeId!)!;
assert.equal(typeof donationBefore.balanceHeadroomIn, "bigint");
donatedBalance = 10n;
const donationTouched = await readBlockTouchedStateKeys({
  getLogs: async () => [{
    address: UNIV2_FIXTURE_TOKEN0,
    topics: [
      ethers.id("Transfer(address,address,uint256)"),
      ethers.zeroPadValue(EXECUTOR, 32),
      ethers.zeroPadValue(firstParallelTarget, 32),
    ],
  }],
  send: async () => [{ result: { type: "CALL", to: UNIV2_FIXTURE_TOKEN0 } }],
}, donationSource.number, "0x00000000000000000000000000000000000000d4");
const donationPricing = await carryBaseCoordinator.prepareCoarsePricing({
  graph: donationGraph,
  pricingCallBackend: producerPricingBackend,
  touchedPools: donationTouched,
  canonicalActivity: { source: donationSource, touchedStateKeys: donationTouched, complete: true },
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(donationPricing.status, "complete");
const donationAfter = donationPricing.snapshot.mids.get(donationEdge.canonicalEdgeId!)!;
assert.equal(donationAfter.mid, donationBefore.mid, "donation leaves reserves/mid unchanged");
assert.equal(donationAfter.balanceHeadroomIn, donationBefore.balanceHeadroomIn! - donatedBalance);
assert.equal(donationPricing.snapshot.pricingProvenanceByEdgeKey?.get(donationEdge.canonicalEdgeId!), "refreshed");
assert.strictEqual(donationPricing.snapshot.mids.get(edgeB.canonicalEdgeId!), fullRebuild.snapshot.mids.get(edgeB.canonicalEdgeId!),
  "unaffected pools still carry without re-reading");
const donationDelta = pricingHistoryPublications.at(-1)!;
assert.equal(donationDelta.kind, "delta");
if (donationDelta.kind === "delta") {
  assert.equal(donationDelta.previousSourceBlock, carryThirdSource.number);
  assert.equal(donationDelta.updates.find(([key]) => key === donationEdge.canonicalEdgeId)?.[1].balanceHeadroomIn,
    donationAfter.balanceHeadroomIn, "mid history records the changed capacity even when price is unchanged");
}

const unavailableCarryCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => parallelRoot.createSession({
    source: request.source,
    runtime: runtime(request.source, {
      ...(request.source.number === carryNextSource.number
        ? {
            reservesByTarget: new Map([
              [secondParallelTarget, Object.freeze({
                reserve0: 0n,
                reserve1: 1_000_000_000n,
                blockTimestampLast: 1,
              })],
            ]),
          }
        : {}),
    }),
    fundingAssets: request.fundingAssets,
    kind: "pricing",
    ...(request.control === undefined ? {} : { control: request.control }),
    ...(request.touchedPools === undefined
      ? {}
      : { touchedPools: request.touchedPools }),
    ...(request.pricingCallBackend === undefined
      ? {}
      : { pricingCallBackend: request.pricingCallBackend }),
  }),
  () => {},
);
const unavailableBase = await unavailableCarryCoordinator.prepareCoarsePricing({
  graph: carryBaseGraph,
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(unavailableBase.status, "complete");
const unavailableNext = await unavailableCarryCoordinator.prepareCoarsePricing({
  graph: carryNextGraph,
  touchedPools: new Set([firstParallelTarget, secondParallelTarget]),
  canonicalActivity: Object.freeze({
    source: carryNextSource,
    touchedStateKeys: new Set([firstParallelTarget, secondParallelTarget]),
    complete: true,
  }),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(unavailableNext.status, "complete");
assert.equal(
  unavailableNext.snapshot.pricingProvenanceByEdgeKey?.get(
    edgeB.canonicalEdgeId!,
  ),
  "unavailable",
  "a clean behavior-proven unavailable edge remains terminal when carried",
);
assert.equal(
  unavailableNext.snapshot.coverageByEdgeKey.get(edgeB.canonicalEdgeId!)?.status,
  "rejected",
);
assert.ok(
  unavailableNext.snapshot.coverage.unavailableEdgeKeys.includes(
    edgeB.canonicalEdgeId!,
  ),
);
assert.equal(unavailableNext.snapshot.mids.has(edgeB.canonicalEdgeId!), false);
assert.notStrictEqual(
  unavailableNext.snapshot.coverageByEdgeKey,
  unavailableBase.snapshot.coverageByEdgeKey,
  "a newly unavailable edge updates the coverage delta",
);
assert.notStrictEqual(
  unavailableNext.snapshot.mids,
  unavailableBase.snapshot.mids,
  "a newly unavailable edge is deleted from the published mids",
);
const sparseSession = sparseCarrySession!;
assert.equal(
  sparseSession.creationTiming.skippedCleanInstanceCount,
  parallelReadyInstances.length - 1,
  "clean instances are not reissued in a sparse coarse session",
);
assert.equal(
  sparseSession.creationTiming.cleanAuthorityReissueCount,
  0,
);
assert.equal(
  sparseSession.creationTiming.projectedRouteCount,
  2,
  "coarse projection is limited to the touched instance routes",
);
assert.equal(
  sparseSession.creationTiming.selectedInstanceCount,
  1,
);
const carryEnumerationConfig = {
  maxHops: 2,
  minSpreadBps: 1,
  maxCandidates: 20,
  budgetMs: 1_000,
  pricedTokens: new Map([
    [UNIV2_FIXTURE_TOKEN0.toLowerCase(), { maxBorrow: 10n ** 18n }],
    [UNIV2_FIXTURE_TOKEN1.toLowerCase(), { maxBorrow: 10n ** 18n }],
  ]),
};
const unanchoredEnumeration = scanBlockStateFromResolvedMids({
  edges: [...carryNextGraph.edges],
  sourceBlock: carryNextSource.number,
  swapTouched: null,
  cfg: carryEnumerationConfig,
  mids: carriedPricing.mids,
});
assert.equal(unanchoredEnumeration.opportunities.length, 0,
  "disconnected fixture Tokens cannot manufacture a paired valuation signal");
assert.equal(unanchoredEnumeration.enumeration?.missingBuyReference, carryNextGraph.edges.length);
assert.equal(unanchoredEnumeration.enumeration?.tokensAboveThreshold, 0);

// The scanner consumes amount-sensitive effective prices, not raw spot mids.
// Obtain both the WETH valuation and Exact quotes through the real lifecycle;
// do not inject prices, amounts, signals, or an expected route. WETH reserves
// use 18-decimal raw units so the production default P fits this small fixture.
const valuationPool = {
  ...pool,
  pool: `0x${"2000".padStart(40, "0")}`,
  token1: ADDR.WETH,
  reserves: { reserve0: 1_000_000_000n, reserve1: 2n * 10n ** 18n, blockTimestampLast: 1 },
};
const valuationPublication = await runUniv2Lifecycle(STARTUP, valuationPool);
const valuationView = buildFamilyRouteGraphView({
  routes: valuationPublication.instances.flatMap((instance) =>
    instance.routes.map((route, index) => ({
      family, descriptor: instance.descriptor, route,
      handle: instance.routeHandles[index],
    }))),
});
const valuationRoot = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: [...carryNextGraph.edges, ...valuationView.edges],
  readyInstances: [...parallelReadyInstances, ...valuationPublication.instances],
  readyFundingAssets: [],
});
const valuationGraph = createVerifiedGraphView({
  ...carryNextGraph,
  id: "strict-carry-valuation",
  familyIdForEdge: () => valuationPublication.familyId,
  edges: [...carryNextGraph.edges, ...valuationView.edges],
});
const valuationRuntime = (source: CanonicalSource) => runtime(source, {
  omitAmountSimulation: true,
  reservesByTarget: new Map([
    [firstParallelTarget, { reserve0: 1_000_000_000n, reserve1: 3_000_000_000n, blockTimestampLast: 2 }],
    [secondParallelTarget, { reserve0: 3_000_000_000n, reserve1: 1_000_000_000n, blockTimestampLast: 2 }],
    [valuationPool.pool, valuationPool.reserves],
  ]),
});
const valuationCoordinator = new StrictCurrentRuntimeCoordinator(
  request => valuationRoot.createSession({
    source: request.source, runtime: valuationRuntime(request.source),
    fundingAssets: request.fundingAssets, kind: "pricing", control: request.control,
    touchedPools: request.touchedPools,
  }),
  () => {},
);
const valuationBase = await valuationCoordinator.prepareCoarsePricing({
  graph: createVerifiedGraphView({
    ...carryBaseGraph,
    id: "strict-carry-valuation-base",
    familyIdForEdge: () => valuationPublication.familyId,
    edges: valuationGraph.edges,
  }),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(valuationBase.status, "complete");
const valuationPricing = await valuationCoordinator.prepareCoarsePricing({
  graph: valuationGraph,
  touchedPools: touchedA,
  canonicalActivity: { source: carryNextSource, touchedStateKeys: touchedA, complete: true },
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(valuationPricing.status, "complete");
assert.equal(valuationPricing.snapshot.sourceBlockHash, carryNextSource.hash);
assert.equal(valuationPricing.snapshot.mids.size, valuationGraph.edges.length);
assert.equal(valuationPricing.snapshot.pricingProvenanceByEdgeKey?.get(edgeB.canonicalEdgeId!), "carried");
assert.strictEqual(valuationPricing.snapshot.mids.get(edgeB.canonicalEdgeId!),
  valuationBase.snapshot.mids.get(edgeB.canonicalEdgeId!));
let valuationExactSession: StrictProductionRuntimeSession | undefined;
const carryEffectiveMids = await buildEffectiveMids({
  pricing: valuationPricing.snapshot,
  weth: ADDR.WETH, gasCostWei: null, enumerationSpreadBps: carryEnumerationConfig.minSpreadBps,
  concurrency: 2, control: { deadlineAtMs: Date.now() + 10_000 },
  prepareQuote: async requiredEdgeIds => {
    valuationExactSession = await valuationRoot.createSession({
      source: carryNextSource, runtime: valuationRuntime(carryNextSource),
      fundingAssets: [], kind: "exact", requiredEdgeIds,
    });
  },
  quote: async request => {
    assert(valuationExactSession);
    const quote = await valuationExactSession.issueExact({ ...request, executor: EXECUTOR, runtimeEvidence: [] });
    assert.equal(quote.status, "resolved");
    assert("amountIn" in quote);
    return quote;
  },
});
assert.equal(carryEffectiveMids.complete, true);
assert.deepEqual(carryEffectiveMids.source, carryNextSource);
assert.equal(carryEffectiveMids.referenceWethInput, DEFAULT_EFFECTIVE_WETH_INPUT);
assert.ok([...carryEffectiveMids.rows.values()].every(row => row.status === "quoted"));
const carryUsdPricing = effectiveUsdPricing({ ...valuationPricing.snapshot, effectiveMids: carryEffectiveMids });
const enumerated = scanBlockStateFromResolvedMids({
  edges: [...valuationGraph.edges],
  sourceBlock: carryNextSource.number,
  swapTouched: null,
  cfg: carryEnumerationConfig,
  mids: carryUsdPricing.mids,
  usdView: carryUsdPricing.view,
});
assert.ok(enumerated.enumeration!.tokensAboveThreshold > 0);
assert.ok(
  enumerated.opportunities.some((opportunity) =>
    opportunity.seedEdges.some((candidate) => candidate.instanceKey?.toLowerCase() === firstParallelTarget) &&
    opportunity.seedEdges.some((candidate) => candidate.instanceKey?.toLowerCase() === secondParallelTarget)
  ),
  "A→B→A remains enumerable from carried mids with a same-source valuation path",
);
const requiredCarryEdges = new Set([edgeA.canonicalEdgeId!, edgeB.canonicalEdgeId!]);
const exactCarrySession = await parallelRoot.createSession({
  source: carryNextSource,
  runtime: runtime(carryNextSource, {
    reservesByTarget: new Map<string, Readonly<{
      reserve0: bigint;
      reserve1: bigint;
      blockTimestampLast: number;
    }>>([
      [firstParallelTarget, Object.freeze({ reserve0: 1_000_000_000n, reserve1: 3_000_000_000n, blockTimestampLast: 2 })],
      [secondParallelTarget, Object.freeze({ reserve0: 3_000_000_000n, reserve1: 1_000_000_000n, blockTimestampLast: 2 })],
    ]),
  }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  kind: "exact",
  requiredEdgeIds: requiredCarryEdges,
});
assert.ok(exactCarrySession.edges.some((candidate) => candidate.canonicalEdgeId === edgeA.canonicalEdgeId));
assert.ok(exactCarrySession.edges.some((candidate) => candidate.canonicalEdgeId === edgeB.canonicalEdgeId));
for (const candidate of [edgeA, edgeB]) {
  const exactCarry = await exactCarrySession.issueExact({
    edge: exactCarrySession.edges.find((item) => item.canonicalEdgeId === candidate.canonicalEdgeId)!,
    amountIn: 1_000_000n,
    executor: EXECUTOR,
    runtimeEvidence: Object.freeze([]),
  });
  assert.equal(exactCarry.status, "resolved");
}
await assert.rejects(
  parallelRoot.createSession({
    source: carryNextSource,
    runtime: runtime(carryNextSource),
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
    kind: "exact",
    requiredEdgeIds: new Set(["missing-canonical-edge"]),
  }),
  /missing required edge ids/,
  "exact must fail closed when the candidate closure is missing from the session",
);

const reorgCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => parallelRoot.createSession({
    source: request.source,
    runtime: runtime(request.source),
    fundingAssets: request.fundingAssets,
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    ...(request.control === undefined ? {} : { control: request.control }),
    ...(request.exactCallBackend === undefined
      ? {}
      : { exactCallBackend: request.exactCallBackend }),
    ...(request.touchedPools === undefined
      ? {}
      : { touchedPools: request.touchedPools }),
    ...(request.pricingCallBackend === undefined
      ? {}
      : { pricingCallBackend: request.pricingCallBackend }),
    ...(request.requiredEdgeIds === undefined
      ? {}
      : { requiredEdgeIds: request.requiredEdgeIds }),
  }),
  () => {},
);
await reorgCoordinator.prepareCoarsePricing({
  graph: carryBaseGraph,
  deadlineAtMs: Date.now() + 10_000,
});
const reorg = await reorgCoordinator.prepareCoarsePricing({
  graph: carryNextGraph,
  touchedPools: touchedA,
  canonicalActivity: Object.freeze({
    source: Object.freeze({
      ...carryNextSource,
      hash: `0x${"64".repeat(32)}`,
    }),
    touchedStateKeys: touchedA,
    complete: true,
  }),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(reorg.status, "degraded");
assert.equal(
  reorg.snapshot.pricingProvenanceByEdgeKey?.get(edgeB.canonicalEdgeId!),
  "unresolved",
  "a reorg/mismatched canonical activity proof cannot authorize carry",
);
assert.equal(
  reorg.snapshot.mids.has(edgeB.canonicalEdgeId!),
  false,
  "an unresolved edge is deleted from the published mids",
);

const failedParallelSession = await parallelRoot.createSession({
    source: CURRENT,
    runtime: runtime(CURRENT, {
      currentPricingDelayMs: (target) =>
        target === firstParallelTarget ? 0 : 25,
      failCurrentPricingTarget: firstParallelTarget,
      onCurrentPricingReadStart() {
        activeFailedRefreshReads++;
      },
      onCurrentPricingReadEnd() {
        activeFailedRefreshReads--;
      },
    }),
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  });
assert.equal(
  activeFailedRefreshReads,
  0,
  "failed session must drain every sibling refresh before returning",
);
assert.equal(
  failedParallelSession.currentPricingForEdge(failedParallelSession.edges[0]!)?.status,
  "unresolved",
  "a failed dirty refresh remains explicitly unresolved",
);
let exactPricingReads = 0;
const exactSession = await parallelRoot.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT, {
    onCurrentPricingRead() {
      exactPricingReads++;
    },
  }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  kind: "exact",
});
assert.equal(
  exactPricingReads,
  0,
  "exact session must not refresh the full ready pricing set",
);
assert.equal(
  exactSession.currentPricingForEdge(exactSession.edges[0]!),
  null,
  "exact session must not pretend to own coarse current mids",
);
assert.equal(session.edges.length, startupView.edges.length);
assert.deepEqual(
  session.edges.map((edge) => edge.canonicalEdgeId).sort(),
  startupView.edges.map((edge) => edge.canonicalEdgeId).sort(),
);
assert(session.edges.every((edge) =>
  session.familyIdForEdge(edge) === publication.familyId
));
assert.deepEqual(
  session.fundingActionIds(UNIV2_FIXTURE_TOKEN0),
  ["morpho-flash", "balancer-flash"],
);

// Both real Funding plugins must enter transport before either is released.
// This tests the removed dependency, not a machine-speed threshold.
for (const mode of ["success", "failed-provider", "stale", "aborted"] as const) {
  const releases: Array<() => void> = [];
  const heldByCall = new Map<string, Promise<void>>();
  let markAllStarted!: () => void;
  const allStarted = new Promise<void>((resolve) => { markAllStarted = resolve; });
  let active = 0;
  let current = true;
  let completed = false;
  let failedCall: string | undefined;
  const controller = new AbortController();
  const pendingSession = root.createSession({
    source: CURRENT,
    kind: "exact",
    fundingAssets: [UNIV2_FIXTURE_TOKEN0],
    control: { signal: controller.signal },
    runtime: runtime(CURRENT, {
      isCurrent: () => current,
      async onFundingRead(data) {
        let held = heldByCall.get(data);
        if (held === undefined) {
          if (heldByCall.size === 0) failedCall = data;
          held = new Promise<void>((resolve) => { releases.push(resolve); });
          heldByCall.set(data, held);
          if (heldByCall.size === readyFundingAssets.length) markAllStarted();
        }
        active++;
        try {
          await held;
          if (mode === "failed-provider" && data === failedCall) {
            throw new Error("one Funding provider failed");
          }
        } finally {
          active--;
        }
      },
    }),
  }).finally(() => { completed = true; });
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      allStarted,
      new Promise<never>((_, reject) => {
        guard = setTimeout(() => reject(new Error("Funding families still serialize")), 1_000);
      }),
    ]);
    assert.equal(active, readyFundingAssets.length);
    assert.equal(completed, false);
    if (mode === "stale") current = false;
    if (mode === "aborted") controller.abort(new Error("test head changed"));
    // Complete the later catalog entry first; no partial session may escape.
    releases.at(-1)!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (mode !== "aborted") assert.equal(completed, false);
  } finally {
    if (guard !== undefined) clearTimeout(guard);
    releases.forEach((release) => release());
  }
  const funded = await pendingSession;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 0, "all sibling provider work must settle");
  const projection = funded.fundingProjection();
  assert.deepEqual(
    projection.outcomes.map((item) => item.fundingId),
    session.fundingProjection().outcomes.map((item) => item.fundingId),
    "completion order must not change catalog/asset publication order",
  );
  if (mode === "success") {
    assert.deepEqual(funded.fundingActionIds(UNIV2_FIXTURE_TOKEN0), session.fundingActionIds(UNIV2_FIXTURE_TOKEN0));
    for (const actionAdapterId of funded.fundingActionIds(UNIV2_FIXTURE_TOKEN0)) {
      const input = { actionAdapterId, asset: UNIV2_FIXTURE_TOKEN0, amount: 1_000_000n, minProfit: 1n, children: [] };
      assert.deepEqual(funded.buildFundingRoot(input), session.buildFundingRoot(input));
    }
  } else if (mode === "failed-provider") {
    assert.equal(funded.fundingActionIds(UNIV2_FIXTURE_TOKEN0).length, 1);
    assert.equal(projection.outcomes.filter((item) => item.status === "verified").length, 1);
  } else {
    assert.deepEqual(funded.fundingActionIds(UNIV2_FIXTURE_TOKEN0), []);
    assert.ok(projection.outcomes.every((item) => item.status !== "verified"));
  }
}
const fundingRoot = session.buildFundingRoot({
  actionAdapterId: "morpho-flash",
  asset: UNIV2_FIXTURE_TOKEN0,
  amount: 1_000_000n,
  minProfit: 1n,
  children: Object.freeze([]),
});
assert.equal(fundingRoot.adapterId, "morpho-flash");
assert.equal(fundingRoot.tokenIn.toLowerCase(), UNIV2_FIXTURE_TOKEN0.toLowerCase());
assert.throws(
  () => session.buildFundingRoot({
    actionAdapterId: "missing-funding-action",
    asset: UNIV2_FIXTURE_TOKEN0,
    amount: 1_000_000n,
    minProfit: 1n,
    children: Object.freeze([]),
  }),
  /no Funding offer/,
);
assert.throws(
  () => session.buildFundingRoot({
    actionAdapterId: "morpho-flash",
    asset: UNIV2_FIXTURE_TOKEN1,
    amount: 1_000_000n,
    minProfit: 1n,
    children: Object.freeze([]),
  }),
  /no Funding offer/,
);
assert.throws(
  () => session.buildFundingRoot({
    actionAdapterId: "morpho-flash",
    asset: UNIV2_FIXTURE_TOKEN0,
    amount: 10n ** 24n + 1n,
    minProfit: 1n,
    children: Object.freeze([]),
  }),
  /no Funding offer/,
);

const pendingPayload = ethers.toBeHex(0x1234, 32);
const pendingPayloadHash = ethers.keccak256(pendingPayload);
const pendingTxHash = `0x${"65".repeat(32)}`;
const pendingFamilyId = publication.familyId as ExecutionFamilyId;
const pendingEvidenceHash = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "bytes32", "uint256", "bytes32", "bytes32"],
    [
      pendingFamilyId,
      pendingTxHash,
      CURRENT.number,
      CURRENT.hash,
      pendingPayloadHash,
    ],
  ),
);
const pendingEvidence: PendingExecutionEvidence = Object.freeze({
  familyId: pendingFamilyId,
  txHash: pendingTxHash,
  headBlockNumber: CURRENT.number,
  headHash: CURRENT.hash,
  canonicalPayload: pendingPayload,
  payloadHash: pendingPayloadHash,
  evidenceHash: pendingEvidenceHash,
});
const boundPending = session.runtimeEvidenceFromPendingExecution([
  pendingEvidence,
]);
assert.equal(boundPending.length, 1);
assert.deepEqual(boundPending[0], {
  evidenceId: `pending:${pendingTxHash}`,
  familyId: publication.familyId,
  kind: PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND,
  scope: "transaction",
  source: CURRENT,
  txHash: pendingTxHash,
  evidenceHash: pendingEvidenceHash,
  sealedPayloadRef: pendingPayload,
});
assert.throws(
  () => session.runtimeEvidenceFromPendingExecution([Object.freeze({
    ...pendingEvidence,
    headHash: WRONG_HASH.hash,
  })]),
  /differs from strict source/,
);
assert.throws(
  () => session.runtimeEvidenceFromPendingExecution([Object.freeze({
    ...pendingEvidence,
    evidenceHash: `0x${"00".repeat(32)}`,
  })]),
  /hash mismatch/,
);

const edge = session.edges.find((candidate) =>
  candidate.tokenIn.toLowerCase() === UNIV2_FIXTURE_TOKEN0.toLowerCase()
)!;
assert.equal(currentPricingReads, 1, "one current pricing shard read per session");
const currentPricing = session.currentPricingForEdge(edge);
assert.equal(currentPricing?.status, "priced");
const startupRouteKey = startupView.handleByCanonicalEdgeId.get(
  edge.canonicalEdgeId!,
)!.routeKey;
const startupMid = publication.instances[0].pricingInstances
  .find((pricing) => pricing.mids.has(startupRouteKey))!
  .mids.get(startupRouteKey)!;
if (currentPricing?.status === "priced") {
  assert.notEqual(
    currentPricing.mid.mid,
    startupMid.mid,
    "current session must not reuse the startup pricing snapshot",
  );
  assert.equal(
    currentPricing.mid.edges[0],
    edge,
    "current pricing must bind the exact strict-session edge object",
  );
}

const currentGraph = createVerifiedGraphView({
  id: "strict-current-runtime-test",
  generation: CURRENT.generation,
  sourceBlock: CURRENT.number,
  sourceBlockHash: CURRENT.hash,
  completenessWatermark: CURRENT.number,
  perSourceCoverage: Object.freeze([Object.freeze({
    familyId: publication.familyId,
    sourceId: "strict-ready-test",
    sourceFingerprint: "strict-ready-test-v1",
    completeThroughBlock: CURRENT.number,
    completeThroughHash: CURRENT.hash,
  })]),
  familyIdForEdge: () => publication.familyId,
  edges: startupView.edges,
});

// Coordinator-owned early Funding: real root, central runtime and Funding
// plugins; only source-pinned calls and the preceding activity wait are mocked.
{
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const fixture = (options: {
    fundingWait?: Promise<void>;
    pricingWait?: Promise<void>;
    failFunding?: boolean;
    rejectSession?: StrictSessionRequest["purpose"];
    fundingSource?: CanonicalSource;
    isCurrent?: () => boolean;
  } = {}) => {
    const requests: StrictSessionRequest[] = [];
    const sessions: StrictProductionRuntimeSession[] = [];
    const fundingCalls: { to: string; data: string; from?: string }[] = [];
    const fundingStarted = preparationGate();
    const pricingStarted = preparationGate();
    const pricingEnded = preparationGate();
    let activeFunding = 0;
    let activePricing = 0;
    let pricingCalls = 0;
    const backend: NonNullable<StrictSessionRequest["pricingCallBackend"]> = {
      async call(request) {
        if (request.data.slice(0, 10) === UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector) {
          pricingCalls++;
          activePricing++;
          pricingStarted.release();
          try {
            await options.pricingWait;
            return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [
              pool.reserves.reserve0, pool.reserves.reserve1, pool.reserves.blockTimestampLast,
            ]);
          } finally {
            activePricing--;
            pricingEnded.release();
          }
        }
        assert.equal(request.data.slice(0, 10), ERC20_BALANCE.getFunction("balanceOf")!.selector);
        if (String(ERC20_BALANCE.decodeFunctionData("balanceOf", request.data)[0]).toLowerCase() === pool.pool.toLowerCase()) {
          return ERC20_BALANCE.encodeFunctionResult("balanceOf", [10n ** 24n]);
        }
        fundingCalls.push({ ...request });
        activeFunding++;
        if (fundingCalls.length === readyFundingAssets.length) fundingStarted.release();
        try {
          await options.fundingWait;
          if (options.failFunding) throw new Error("prefunding mock transport failed");
          return ERC20_BALANCE.encodeFunctionResult("balanceOf", [10n ** 24n]);
        } finally {
          activeFunding--;
        }
      },
    };
    const coordinator = new StrictCurrentRuntimeCoordinator((request) => {
      requests.push(request);
      if (request.purpose === options.rejectSession) {
        // Deliberately throw synchronously, before returning a session promise.
        throw new Error(`injected ${request.purpose} session rejection`);
      }
      const source = request.purpose === "exact-execution"
        ? options.fundingSource ?? request.source : request.source;
      return root.createSession({
        source,
        kind: request.purpose === "exact-execution" ? "exact" : "pricing",
        fundingAssets: request.fundingAssets,
        control: request.control,
        touchedPools: request.touchedPools,
        requiredEdgeIds: request.requiredEdgeIds,
        runtime: runtime(source, {
          producerCallBackend: request.pricingCallBackend,
          isCurrent: options.isCurrent,
          onCurrentPricingRead() { assert.fail("pricing escaped its pass backend"); },
          onFundingRead() { assert.fail("Funding escaped its pass backend"); },
        }),
      }).then((created) => {
        sessions.push(created);
        return created;
      });
    }, () => {});
    return {
      coordinator, backend, requests, sessions, fundingCalls,
      fundingStarted, pricingStarted, pricingEnded,
      counts: () => ({ activeFunding, activePricing, pricingCalls }),
    };
  };
  const scopeFor = (value: ReturnType<typeof fixture>, signal = new AbortController().signal) => ({
    graph: currentGraph,
    fundingTokens: [UNIV2_FIXTURE_TOKEN0],
    deadlineAtMs: Date.now() + 10_000,
    preparationSettleDeadlineAtMs: Date.now() + 9_000,
    signal,
    pricingCallBackend: value.backend,
  });
  // FrozenReadonlyMap stores entries privately; deepEqual on the wrapper
  // alone cannot establish equality of actual prices, offers or provenance.
  const comparableSnapshot = (snapshot: AdapterRuntimeSnapshot) => ({
    ...snapshot,
    pricing: {
      ...snapshot.pricing,
      mids: [...snapshot.pricing.mids],
      coverageByReadKey: [...snapshot.pricing.coverageByReadKey],
      coverageByEdgeKey: [...snapshot.pricing.coverageByEdgeKey],
      freshnessByReadKey: [...snapshot.pricing.freshnessByReadKey],
      stateByStateKey: [...snapshot.pricing.stateByStateKey],
      pricingProvenanceByEdgeKey: [...snapshot.pricing.pricingProvenanceByEdgeKey ?? []],
      pricingStateKeyByEdgeKey: [...snapshot.pricing.pricingStateKeyByEdgeKey ?? []],
      pricingFamilyIdByEdgeKey: [...snapshot.pricing.pricingFamilyIdByEdgeKey ?? []],
    },
    funding: {
      ...snapshot.funding,
      sources: [...snapshot.funding.sources],
      coverageByFundingId: [...snapshot.funding.coverageByFundingId],
      freshnessByFundingId: [...snapshot.funding.freshnessByFundingId]
        .map(([id, proofs]) => [id, [...proofs]]),
    },
  });
  try {
    for (const mode of ["funding-first", "pricing-first", "failed-funding"] as const) {
      const activity = preparationGate();
      const releaseFunding = preparationGate();
      const releasePricing = preparationGate();
      const tested = fixture({
        fundingWait: releaseFunding.promise, pricingWait: releasePricing.promise,
        failFunding: mode === "failed-funding",
      });
      const input = scopeFor(tested);
      const handle = tested.coordinator.startFundingPreparation(input);
      assert.deepEqual(Object.keys(handle), ["settle"]);
      assert.ok(Object.isFrozen(handle));
      let published = false;
      const pending = (async () => {
        await activity.promise;
        return tested.coordinator.prepare({
          ...input, fundingPreparation: handle,
          touchedPools: new Set([UNIV2_FIXTURE_POOL]),
          canonicalActivity: { source: CURRENT, touchedStateKeys: new Set([UNIV2_FIXTURE_POOL]), complete: true },
        });
      })().finally(() => { published = true; });
      const observed = Promise.allSettled([pending]);
      try {
        await awaitPreparationGate(tested.fundingStarted.promise, `${mode}: Funding waited for activity`);
        assert.equal(tested.requests.length, 1);
        assert.equal(tested.requests[0]!.purpose, "exact-execution");
        assert.deepEqual(tested.requests[0]!.requiredEdgeIds, new Set());
        assert.deepEqual(tested.requests[0]!.fundingAssets, input.fundingTokens);
        assert.deepEqual(tested.requests[0]!.source, CURRENT);
        assert.equal(tested.requests[0]!.control?.signal, input.signal);
        assert.equal(tested.requests[0]!.control?.deadlineAtMs, input.preparationSettleDeadlineAtMs);
        assert.equal(tested.requests[0]!.pricingCallBackend, tested.backend);
        assert.equal(tested.counts().pricingCalls, 0, "Funding-only closure must not refresh routes");
        assert.equal(tested.coordinator.latestPricingSnapshot(), null);
        activity.release();
        await awaitPreparationGate(tested.pricingStarted.promise, `${mode}: pricing waited for Funding`);
        assert.equal(tested.counts().activeFunding, readyFundingAssets.length);
        assert.equal(tested.counts().activePricing, 1);
        assert.equal(tested.requests.length, 2);
        assert.equal(tested.requests[1]!.purpose, "source-n-runtime");
        assert.deepEqual(tested.requests[1]!.fundingAssets, []);
        assert.equal(tested.requests[1]!.pricingCallBackend, tested.backend);
        if (mode === "pricing-first") {
          releasePricing.release();
          await tested.pricingEnded.promise;
        } else {
          releaseFunding.release();
          await handle.settle();
        }
        await nextTurn();
        assert.equal(published, false, "one settled branch cannot publish the joined snapshot");
        assert.equal(tested.coordinator.latestPricingSnapshot(), null);
      } finally {
        activity.release();
        releaseFunding.release();
        releasePricing.release();
        await observed;
        await handle.settle();
      }
      const joined = await pending;
      const baseline = fixture({ failFunding: mode === "failed-funding" });
      const reference = await baseline.coordinator.prepare(scopeFor(baseline));
      assert.ok(joined.status !== "incomplete");
      assert.ok(reference.status !== "incomplete");
      assert.deepEqual(comparableSnapshot(joined.snapshot), comparableSnapshot(reference.snapshot),
        "joined pricing/Funding projections differ from unsplit baseline");
      assert.equal(joined.status, reference.status);
      // Compare the actual calls, including retries, not just offer counts.
      assert.deepEqual(tested.fundingCalls, baseline.fundingCalls);
      assert.equal(new Set(tested.fundingCalls.map((call) => `${call.to}/${call.data}/${call.from ?? ""}`)).size,
        readyFundingAssets.length);
      if (mode !== "failed-funding") assert.equal(tested.fundingCalls.length, readyFundingAssets.length);
      assert.deepEqual(tested.counts(), { activeFunding: 0, activePricing: 0, pricingCalls: 1 });
      const fundingOnly = tested.sessions.find((value) => value.creationTiming.projectedRouteCount === 0)!;
      assert.ok(fundingOnly);
      assert.equal(fundingOnly.creationTiming.selectedInstanceCount, 0);
      assert.equal(fundingOnly.creationTiming.refreshedInstanceCount, 0);
      if (mode === "failed-funding") {
        assert.equal(joined.status, "degraded");
        assert.equal(joined.snapshot.funding.sources.size, 0);
        assert.equal(joined.snapshot.funding.coverage.unresolvedKeys.length, readyFundingAssets.length);
        assert.equal(joined.snapshot.pricing.coverage.unresolvedEdgeKeys.length, 0);
      }
      assert.doesNotThrow(() => assertAtomicBlockScanRuntime(joined.snapshot));
      console.log(`strict early Funding coordinator: PASS ${mode}`);
    }

    // Settlement expiry and retirement invalidate already-successful Funding
    // at the publication join. They preserve the original degraded/no-offer
    // result while the outer pass is open, rather than rejecting the pass.
    for (const mode of ["settle-deadline", "generation-retired"] as const) {
      const releasePricing = preparationGate();
      let current = true;
      const options = { pricingWait: releasePricing.promise, isCurrent: () => current };
      const tested = fixture(options);
      const baseline = fixture(options);
      const input = scopeFor(tested);
      const handle = tested.coordinator.startFundingPreparation(input);
      await handle.settle();
      const fundingOnly = tested.sessions[0]!;
      assert.ok(fundingOnly);
      assert.equal(fundingOnly.creationTiming.fundingOfferCount, readyFundingAssets.length);
      assert.ok(fundingOnly.fundingProjection().outcomes.every((outcome) => outcome.status === "verified"));
      assert.ok(fundingOnly.fundingProjection().sources.size > 0);
      let completions = 0;
      const pending = tested.coordinator.prepare({ ...input, fundingPreparation: handle })
        .finally(() => { completions++; });
      const referencePending = baseline.coordinator.prepare({ ...input, pricingCallBackend: baseline.backend })
        .finally(() => { completions++; });
      const observed = Promise.allSettled([pending, referencePending]);
      const realNow = Date.now;
      try {
        await awaitPreparationGate(Promise.all([
          tested.pricingStarted.promise, baseline.pricingStarted.promise, baseline.fundingStarted.promise,
        ]), `${mode}: both pricing branches and baseline Funding must start`);
        // All mock reads/microtasks for baseline Funding finish before the
        // fence changes, while both real session pricing branches remain held.
        await nextTurn();
        assert.equal(baseline.counts().activeFunding, 0);
        assert.equal(tested.counts().activeFunding, 0);
        assert.equal(baseline.counts().activePricing, 1);
        assert.equal(tested.counts().activePricing, 1);
        assert.equal(completions, 0);
        assert.equal(tested.coordinator.latestPricingSnapshot(), null);
        assert.equal(baseline.coordinator.latestPricingSnapshot(), null);
        if (mode === "settle-deadline") Date.now = () => input.preparationSettleDeadlineAtMs + 1;
        else current = false;
        assert.ok(Date.now() < input.deadlineAtMs, "outer pass deadline must remain open");
        assert.equal(input.signal.aborted, false);
        releasePricing.release();
        await observed;
        const joined = await pending;
        const reference = await referencePending;
        assert.equal(joined.status, "degraded");
        assert.equal(reference.status, "degraded");
        assert.deepEqual(comparableSnapshot(joined.snapshot), comparableSnapshot(reference.snapshot),
          `${mode}: early Funding changed the original late-join result`);
        assert.equal(joined.snapshot.funding.sources.size, 0);
        assert.deepEqual(joined.snapshot.funding.coverage.resolvedKeys, []);
        assert.equal(joined.snapshot.funding.coverage.unresolvedKeys.length, readyFundingAssets.length);
        assert.equal(joined.snapshot.funding.freshnessByFundingId.size, 0);
        const reason = mode === "settle-deadline"
          ? "adapter work deadline reached" : "test generation fence rejected stale source";
        for (const coverage of joined.snapshot.funding.coverageByFundingId.values()) {
          assert.deepEqual(coverage, { status: "unresolved", reason: `unresolved:funding-publication:${reason}` });
        }
        assert.deepEqual(tested.fundingCalls, baseline.fundingCalls);
        assert.equal(tested.fundingCalls.length, readyFundingAssets.length,
          "late invalidation must neither retry nor duplicate successful Funding reads");
        assert.equal(tested.coordinator.latestPricingSnapshot(), joined.snapshot.pricing);
        assert.doesNotThrow(() => assertAtomicBlockScanRuntime(joined.snapshot));
      } finally {
        releasePricing.release();
        await observed;
        Date.now = realNow;
        await handle.settle();
      }
      assert.equal(completions, 2);
      assert.deepEqual(tested.counts(), { activeFunding: 0, activePricing: 0, pricingCalls: 1 });
      assert.deepEqual(baseline.counts(), { activeFunding: 0, activePricing: 0, pricingCalls: 1 });
      console.log(`strict early Funding coordinator: PASS late-${mode} baseline parity`);
    }

    // Handles are coordinator/pass-owned, not structurally forgeable promises.
    const bound = fixture();
    const scope = scopeFor(bound);
    const owned = bound.coordinator.startFundingPreparation(scope);
    await owned.settle();
    const mismatches: readonly [string, Partial<typeof scope>][] = [
      ["graph identity", { graph: Object.freeze({ ...currentGraph }) }],
      ["source number", { graph: Object.freeze({ ...currentGraph, sourceBlock: CURRENT.number + 1 }) }],
      ["source hash", { graph: Object.freeze({ ...currentGraph, sourceBlockHash: WRONG_HASH.hash }) }],
      ["source generation", { graph: Object.freeze({ ...currentGraph, generation: CURRENT.generation + 1 }) }],
      ["assets", { fundingTokens: [UNIV2_FIXTURE_TOKEN1] }],
      ["backend", { pricingCallBackend: { call: bound.backend.call } }],
      ["signal", { signal: new AbortController().signal }],
      ["deadline", { deadlineAtMs: scope.deadlineAtMs + 1 }],
      ["settle deadline", { preparationSettleDeadlineAtMs: scope.preparationSettleDeadlineAtMs + 1 }],
    ];
    for (const [name, change] of mismatches) {
      await assert.rejects(bound.coordinator.prepare({ ...scope, ...change, fundingPreparation: owned }),
        /Funding preparation differs/, name);
      assert.equal(bound.requests.length, 1, `${name}: mismatch admitted pricing work`);
    }
    const other = fixture();
    const foreign = other.coordinator.startFundingPreparation(scope);
    await foreign.settle();
    for (const handle of [foreign, { settle: async () => { assert.fail("foreign settle must not be invoked"); } }]) {
      await assert.rejects(bound.coordinator.prepare({ ...scope, fundingPreparation: handle }), /Funding preparation differs/);
    }
    await bound.coordinator.resetDynamicStateForReplay();
    await assert.rejects(bound.coordinator.prepare({ ...scope, fundingPreparation: owned }), /Funding preparation differs/);
    assert.equal(bound.requests.length, 1);
    assert.equal(bound.coordinator.latestPricingSnapshot(), null);
    for (const source of [
      { ...CURRENT, number: CURRENT.number + 1 }, WRONG_HASH,
      { ...CURRENT, generation: CURRENT.generation + 1 },
    ]) {
      const wrongSource = fixture({ fundingSource: source });
      const input = scopeFor(wrongSource);
      const handle = wrongSource.coordinator.startFundingPreparation(input);
      await handle.settle();
      await assert.rejects(wrongSource.coordinator.prepare({ ...input, fundingPreparation: handle }),
        /strict session source differs/);
      assert.equal(wrongSource.coordinator.latestPricingSnapshot(), null);
    }
    console.log("strict early Funding coordinator: PASS handle/source/control binding");

    const preAborted = fixture();
    const earlyAbort = new AbortController();
    const earlyInput = scopeFor(preAborted, earlyAbort.signal);
    const earlyHandle = preAborted.coordinator.startFundingPreparation(earlyInput);
    earlyAbort.abort(new Error("prefunding cancelled before dispatch"));
    await earlyHandle.settle();
    assert.equal(preAborted.requests.length, 0, "aborted launch dispatched a Funding session");
    assert.throws(() => preAborted.coordinator.startFundingPreparation(earlyInput), /cancelled before dispatch/);
    assert.throws(() => preAborted.coordinator.startFundingPreparation({ ...scopeFor(preAborted), deadlineAtMs: Date.now() - 1 }),
      /deadline expired/);
    for (const mode of ["abort", "deadline", "reset"] as const) {
      const releasePricing = preparationGate();
      const tested = fixture({ pricingWait: releasePricing.promise });
      const controller = new AbortController();
      const input = scopeFor(tested, controller.signal);
      const handle = tested.coordinator.startFundingPreparation(input);
      await handle.settle();
      const pending = tested.coordinator.prepare({ ...input, fundingPreparation: handle });
      const observed = Promise.allSettled([pending]);
      const realNow = Date.now;
      try {
        await awaitPreparationGate(tested.pricingStarted.promise, `${mode}: pricing did not start`);
        if (mode === "abort") controller.abort(new Error("prefunding late abort"));
        // Confined to this held join, then restored even on failure; no sleeps.
        if (mode === "deadline") Date.now = () => input.deadlineAtMs + 1;
        if (mode === "reset") await tested.coordinator.resetDynamicStateForReplay();
      } finally {
        releasePricing.release();
        await observed;
        Date.now = realNow;
        await handle.settle();
      }
      await assert.rejects(pending, mode === "abort" ? /prefunding late abort/
        : mode === "deadline" ? /deadline expired/ : /retired during join/);
      assert.equal(tested.coordinator.latestPricingSnapshot(), null);
      assert.equal(tested.counts().activePricing, 0);
      console.log(`strict early Funding coordinator: PASS late-${mode}`);
    }

    // An early rejected branch is handled at launch, but prepare must still
    // await its delayed pricing/Funding and execution siblings before failing.
    for (const rejected of ["exact-execution", "source-n-runtime"] as const) {
      const release = preparationGate();
      const execution = preparationGate();
      const executionStarted = preparationGate();
      const tested = fixture({
        rejectSession: rejected,
        ...(rejected === "exact-execution" ? { pricingWait: release.promise } : { fundingWait: release.promise }),
      });
      const input = scopeFor(tested);
      const handle = tested.coordinator.startFundingPreparation(input);
      // Deliberately do not call settle yet: the launch owns rejection handling.
      await nextTurn();
      let completed = false;
      const pending = tested.coordinator.prepare({
        ...input, fundingPreparation: handle,
        prepareExecution: async () => { executionStarted.release(); await execution.promise; },
      }).finally(() => { completed = true; });
      const observed = Promise.allSettled([pending]);
      try {
        await awaitPreparationGate(Promise.all([
          executionStarted.promise,
          rejected === "exact-execution" ? tested.pricingStarted.promise : tested.fundingStarted.promise,
        ]), `${rejected}: delayed sibling did not start`);
        await nextTurn();
        assert.equal(completed, false, "early rejection abandoned a live sibling");
        release.release();
        await nextTurn();
        assert.equal(completed, false, "join abandoned delayed execution preparation");
      } finally {
        release.release();
        execution.release();
        await observed;
        await handle.settle();
      }
      await assert.rejects(pending, new RegExp(`injected ${rejected} session rejection`));
      assert.equal(tested.counts().activeFunding, 0);
      assert.equal(tested.counts().activePricing, 0);
      assert.equal(tested.coordinator.latestPricingSnapshot(), null);
      console.log(`strict early Funding coordinator: PASS delayed sibling after ${rejected} rejection`);
    }
    for (const first of ["pricing", "funding"] as const) {
      const releasePricing = preparationGate();
      const releaseFunding = preparationGate();
      const executionStarted = preparationGate();
      const tested = fixture({ pricingWait: releasePricing.promise, fundingWait: releaseFunding.promise });
      const input = scopeFor(tested);
      const handle = tested.coordinator.startFundingPreparation(input);
      let completed = false;
      const pending = tested.coordinator.prepare({
        ...input, fundingPreparation: handle,
        prepareExecution(control) {
          executionStarted.release();
          assert.equal(control.signal, input.signal);
          assert.equal(control.deadlineAtMs, input.preparationSettleDeadlineAtMs);
          assert.equal(control.sourceBlock, CURRENT.number);
          assert.equal(control.sourceBlockHash, CURRENT.hash);
          assert.equal(control.generation, CURRENT.generation);
          // Not an async function: the coordinator must capture the throw and
          // observe/drain both already-launched session branches before exit.
          throw new Error("injected sync execution preparation rejection");
        },
      }).finally(() => { completed = true; });
      const observed = Promise.allSettled([pending]);
      try {
        await awaitPreparationGate(Promise.all([
          tested.pricingStarted.promise, tested.fundingStarted.promise, executionStarted.promise,
        ]), `sync execution rejection (${first} first): session work did not start`);
        await nextTurn();
        assert.equal(completed, false, "synchronous execution throw abandoned both session branches");
        if (first === "pricing") {
          releasePricing.release();
          await tested.pricingEnded.promise;
        } else {
          releaseFunding.release();
          await handle.settle();
        }
        await nextTurn();
        assert.equal(completed, false, "synchronous execution throw abandoned the remaining session branch");
        assert.equal(tested.coordinator.latestPricingSnapshot(), null);
      } finally {
        releasePricing.release();
        releaseFunding.release();
        await observed;
        await handle.settle();
      }
      await assert.rejects(pending, /injected sync execution preparation rejection/);
      assert.deepEqual(tested.counts(), { activeFunding: 0, activePricing: 0, pricingCalls: 1 });
      assert.equal(tested.coordinator.latestPricingSnapshot(), null);
      console.log(`strict early Funding coordinator: PASS sync execution throw drains ${first}-first`);
    }
    await nextTurn();
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

let resetCount = 0;
const currentCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => {
    if (request.purpose === "source-n-runtime") {
      assert.deepEqual(request.fundingAssets, [UNIV2_FIXTURE_TOKEN0]);
    }
    return root.createSession({
      source: request.source,
      runtime: strictRuntime,
      fundingAssets: request.fundingAssets,
      kind: request.purpose === "exact-execution" ? "exact" : "pricing",
      ...(request.control === undefined ? {} : { control: request.control }),
    });
  },
  () => {
    resetCount++;
  },
);
const currentRuntime = await currentCoordinator.prepare({
  graph: currentGraph,
  fundingTokens: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(currentRuntime.status, "complete");
assert.equal(currentRuntime.timing?.executionMs, 0, "no execution barrier means zero execution wait");
assert.equal(currentRuntime.snapshot.graph, currentGraph);
const currentFunding = currentRuntime.snapshot.funding;
assert.equal(
  currentFunding.coverage.expectedKeys.length,
  readyFundingAssets.length,
  "strict Funding coverage is keyed by every dynamic provider/asset source",
);
assert.equal(
  currentFunding.coverageByFundingId.size,
  currentFunding.coverage.expectedKeys.length,
);
assert.equal(
  currentFunding.freshnessByFundingId.size,
  currentFunding.coverage.resolvedKeys.length,
);
assert.ok(
  currentFunding.coverage.expectedKeys.every((fundingId) =>
    fundingId !== UNIV2_FIXTURE_TOKEN0.toLowerCase() &&
    currentFunding.coverageByFundingId.get(fundingId)?.status === "resolved" &&
    [...(currentFunding.freshnessByFundingId.get(fundingId)?.values() ?? [])]
      .every((proof) =>
        proof.kind === "strict-work" &&
        proof.source.number === CURRENT.number &&
        proof.source.hash === CURRENT.hash
      )
  ),
  "token lookup keys must not masquerade as Funding coverage/freshness keys",
);
assert.doesNotThrow(() => assertAtomicBlockScanRuntime(currentRuntime.snapshot));
assert.throws(
  () => assertAtomicBlockScanRuntime(Object.freeze({
    ...currentRuntime.snapshot,
    funding: Object.freeze({
      ...currentFunding,
      borrowable: currentFunding.borrowable.bind(currentFunding),
      source: currentFunding.source.bind(currentFunding),
      freshnessByFundingId: new Map(),
    }),
  })),
  /rejected funding coverage\/freshness/,
  "production boundary must reject a strict Funding snapshot without freshness",
);
assert.equal(
  currentRuntime.snapshot.pricing.coverage.expectedEdgeKeys.length,
  currentGraph.scannerEdgeCount,
);
for (const graphEdge of currentGraph.edges) {
  const mid = currentRuntime.snapshot.pricing.mids.get(
    graphEdge.canonicalEdgeId!,
  );
  assert(mid);
  assert.equal(mid.edges[0], graphEdge);
}
assert.equal(
  currentCoordinator.latestPricingSnapshot()?.sourceBlock,
  CURRENT.number,
);
await currentCoordinator.resetDynamicStateForReplay();
assert.equal(currentCoordinator.latestPricingSnapshot(), null);
assert.equal(resetCount, 1);
await assert.rejects(
  currentCoordinator.prepareCurrentNExactExecutionContext({
    graph: currentGraph,
    fundingTokens: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
    deadlineAtMs: Date.now() + 10_000,
  }),
  /requires requiredEdgeIds/,
  "strict exact context must receive an explicit candidate edge closure",
);

// A source-owned simulator is an opaque pass context, not a coordinator-owned
// client. Every session/enrichment entrance must retain the very same object.
for (const path of ["coarse", "runtime", "prefunded", "exact"] as const) {
  for (const supplied of [false, true]) {
    const firstTransport = Object.freeze({ simulate: async () => {
      assert.fail("coordinator must not invoke or own the simulator");
    } });
    const otherTransport = Object.freeze({ simulate: firstTransport.simulate });
    const simulationTransport = supplied ? firstTransport : undefined;
    const requests: StrictSessionRequest[] = [];
    let enrichments = 0;
    const coordinated = new StrictCurrentRuntimeCoordinator(request => {
      requests.push(request);
      assert.equal(request.simulationTransport, simulationTransport);
      assert.equal("simulationTransport" in request, supplied,
        "explicit RPC-only callers must not acquire a simulator implicitly");
      return root.createSession({ source: request.source, runtime: strictRuntime,
        fundingAssets: request.fundingAssets,
        kind: request.purpose === "exact-execution" ? "exact" : "pricing",
        requiredEdgeIds: request.requiredEdgeIds, control: request.control });
    }, () => {}, undefined, async (pricing, control, backend, reuse, receivedTransport) => {
      enrichments++;
      assert.equal(receivedTransport, simulationTransport,
        "effective enrichment must use the source work's original transport");
      return { source: { number: pricing.sourceBlock, hash: pricing.sourceBlockHash,
        generation: pricing.generation }, rows: new Map(), reference: "default",
        referenceWethInput: 1_000_000_000_000_000n, complete: true, wallMs: 0 };
    });
    const args = { graph: currentGraph, fundingTokens: [UNIV2_FIXTURE_TOKEN0],
      deadlineAtMs: Date.now() + 10_000, simulationTransport };
    if (path === "prefunded") {
      const handle = coordinated.startFundingPreparation(args);
      // Funding captures context synchronously even before its deferred dispatch.
      args.simulationTransport = otherTransport;
      await handle.settle();
      await assert.rejects(coordinated.prepare({ ...args, fundingPreparation: handle }),
        /Funding preparation differs/);
      assert.equal(requests.length, 1, "foreign simulator must reject before pricing dispatch");
      args.simulationTransport = simulationTransport;
      await coordinated.prepare({ ...args, fundingPreparation: handle });
    } else {
      const pending = path === "coarse" ? coordinated.prepareCoarsePricing(args)
        : path === "runtime" ? coordinated.prepare(args)
        : coordinated.prepareCurrentNExactExecutionContext({ ...args,
            requiredEdgeIds: new Set(currentGraph.edges.map(blockScanEdgeKey)) });
      // The caller cannot change the in-flight context while session work yields.
      args.simulationTransport = otherTransport;
      await pending;
    }
    assert.equal(requests.length, path === "prefunded" ? 2 : 1);
    assert.deepEqual(requests.map(request => request.purpose), path === "prefunded"
      ? ["exact-execution", "source-n-runtime"]
      : [path === "coarse" ? "coarse-pricing" : path === "runtime" ? "source-n-runtime" : "exact-execution"]);
    assert.equal(enrichments, path === "exact" ? 0 : 1);
  }
}

// Real raw-mid/session + shared touched-reader integration. Amount quote
// responses are fixtures: this proves orchestration, NOT on-chain Family support.
for (const path of ["coarse", "runtime"] as const) {
  const rawReads: string[] = [], amountReads: string[] = [];
  let gasCostWei: bigint | null = null;
  const enumerationSpreadBps = 200;
  let sharedTouched: ReadonlySet<string> | undefined;
  const paired = new StrictCurrentRuntimeCoordinator(
    request => parallelRoot.createSession({ source: request.source,
      runtime: runtime(request.source, {
        reserves: request.source.number === carryNextSource.number
          ? { reserve0: 2_000_000_000n, reserve1: 4_000_000_000n, blockTimestampLast: 2 }
          : pool.reserves,
        onCurrentPricingReadStart: target => { rawReads.push(target); },
      }),
      fundingAssets: request.fundingAssets, kind: request.purpose === "exact-execution" ? "exact" : "pricing",
      control: request.control, touchedPools: request.touchedPools, requiredEdgeIds: request.requiredEdgeIds,
    }), () => {}, undefined,
    async (pricing, control, _backend, reuse) => {
      assert.equal(reuse?.touchedStateKeys, sharedTouched,
        "effective receives the existing canonical activity set, no separately issued proof");
      const target = reuse?.quoteGraph ?? pricing;
      return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, control, weth: UNIV2_FIXTURE_TOKEN0,
        previous: reuse?.previous, touchedStateKeys: reuse?.touchedStateKeys,
        gasCostWei, enumerationSpreadBps, concurrency: 2,
        quote: async request => {
          assert.equal(Object.hasOwn(request, "requireChainAmountQuote"), false);
          const { edge, amountIn } = request;
          amountReads.push(edge.instanceKey!.toLowerCase());
          return { source: { number: target.sourceBlock, hash: target.sourceBlockHash,
            generation: target.generation }, amountIn,
            amountOut: amountIn * 2n - (target.sourceBlock === carryNextSource.number ? 2n : 1n) };
        },
      });
    },
  );
  const prepare = (graph: typeof carryBaseGraph) => {
    const args = { graph, deadlineAtMs: Date.now() + 10_000,
      touchedPools: sharedTouched,
      canonicalActivity: sharedTouched === undefined ? undefined : {
        source: { number: graph.sourceBlock, hash: graph.sourceBlockHash, generation: graph.generation },
        parentHash: CURRENT.hash, touchedStateKeys: sharedTouched, complete: true as const,
      } };
    return path === "coarse" ? paired.prepareCoarsePricing(args)
      : paired.prepare({ ...args, fundingTokens: [] });
  };
  await prepare(carryBaseGraph);
  const before = paired.latestPricingSnapshot()!;
  assert.equal(before.effectiveMids!.rows.size, carryBaseGraph.scannerEdgeCount);
  assert.equal(amountReads.length, carryBaseGraph.scannerEdgeCount);
  let activityReads = 0;
  const txHash = `0x${"a1".repeat(32)}`;
  sharedTouched = await readBlockTouchedStateKeys({
    getLogs: async () => { activityReads++; return []; },
    send: async () => { activityReads++; return [{ txHash, result: {
      type: "CALL", from: EXECUTOR, to: firstParallelTarget,
      gas: "0x100", gasUsed: "0x80", input: "0x12345678", output: "0x",
    } }]; },
  }, carryNextSource.number, ethers.ZeroAddress, {
    hash: carryNextSource.hash, parentHash: CURRENT.hash,
    transactionHashes: [txHash], passiveTouchedAddresses: [],
  });
  assert(sharedTouched.has(firstParallelTarget), "arbitrary contract call counts, not just swap selectors");
  // Exercise a changed reference independently of the global default P.
  // The old fixed gas value implied G = P + 1 wei; Token conversion can
  // still round that to the same amountIn as the default P.
  gasCostWei = DEFAULT_EFFECTIVE_WETH_INPUT * BigInt(enumerationSpreadBps) * 2n / 10_000n;
  rawReads.length = 0; amountReads.length = 0;
  await prepare(carryNextGraph);
  const after = paired.latestPricingSnapshot()!;
  assert(after.effectiveMids!.referenceWethInput > before.effectiveMids!.referenceWethInput,
    "this fixture must actually change the gas-sized reference");
  assert.equal(activityReads, 2, "one log read plus one trace, never a second effective activity scan");
  assert.deepEqual(rawReads, [], "steady producers never refresh the raw reference table");
  assert.strictEqual(after.mids, before.mids);
  assert.deepEqual(after.rawMidSource, CURRENT);
  assert.deepEqual(before.rawMidSource, CURRENT);
  assert.deepEqual(amountReads, [firstParallelTarget, firstParallelTarget]);
  for (const [key, oldRow] of before.effectiveMids!.rows) {
    const newRow = after.effectiveMids!.rows.get(key)!;
    assert.equal(after.mids.get(key)!.mid, before.mids.get(key)!.mid,
      "reserve ratio stays the same, so numerical-mid comparison cannot drive invalidation");
    if (oldRow.instanceKey === firstParallelTarget) {
      assert.equal(after.pricingProvenanceByEdgeKey!.get(key), "refreshed");
      assert.equal(newRow.carried, undefined);
      assert.notEqual(newRow.amountIn, oldRow.amountIn, "a touched row uses the current amount reference");
      assert.deepEqual(newRow.quotedAt, carryNextSource);
    } else {
      assert.equal(after.pricingProvenanceByEdgeKey!.get(key), "carried");
      assert.equal(effectiveMidRowCarried(after.effectiveMids!, newRow), true);
      assert.equal(newRow, oldRow, "clean rows retain identity");
      assert.equal(newRow.amountIn, oldRow.amountIn);
      assert.equal(newRow.amountOut, oldRow.amountOut);
      assert.equal(newRow.effectiveMid, oldRow.effectiveMid);
      assert.deepEqual(newRow.quotedAt, CURRENT);
    }
  }
  console.log(`strict frozen raw/current effective: PASS ${path}`);
}

// A direction missing from bootstrap raw can recover in current effective,
// without changing the original P/reference table or emitting raw history deltas.
{
  let rawReads = 0, amountReads = 0;
  let originalSizing: BlockScanStateSnapshot | undefined;
  const publications: StrictPricingPublication[] = [];
  const coordinator = new StrictCurrentRuntimeCoordinator(request => parallelRoot.createSession({
    source: request.source, fundingAssets: [], control: request.control,
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    requiredEdgeIds: request.requiredEdgeIds,
    runtime: runtime(request.source, {
      failCurrentPricingTarget: firstParallelTarget,
      onCurrentPricingReadStart: () => { rawReads++; },
    }),
  }), () => {}, item => { publications.push(item); }, async (sizing, control, _backend, reuse) => {
    if (originalSizing) assert.strictEqual(sizing, originalSizing);
    else originalSizing = sizing;
    const target = reuse?.quoteGraph ?? sizing;
    return buildEffectiveMids({ pricing: sizing, quoteGraph: reuse?.quoteGraph, control,
      weth: UNIV2_FIXTURE_TOKEN0, gasCostWei: null, enumerationSpreadBps: 200, concurrency: 2,
      previous: reuse?.previous, touchedStateKeys: reuse?.touchedStateKeys,
      quote: async ({ amountIn }) => {
        amountReads++;
        return { source: { number: target.sourceBlock, hash: target.sourceBlockHash,
          generation: target.generation }, amountIn, amountOut: amountIn * 2n };
      },
    });
  });
  const bootstrap = await coordinator.prepareCoarsePricing({ graph: carryBaseGraph,
    deadlineAtMs: Date.now() + 10_000 });
  assert.equal(bootstrap.status, "degraded");
  const missingKeys = carryBaseGraph.edges.filter(e => e.instanceKey === firstParallelTarget).map(blockScanEdgeKey);
  assert.equal(missingKeys.length, 2);
  for (const key of missingKeys) assert.equal(bootstrap.snapshot.mids.has(key), false);
  const bootstrapReads = rawReads;
  assert(bootstrapReads > 0);
  assert.deepEqual(originalSizing!.sourceBlock, CURRENT.number);
  const originalCoverage = originalSizing!.coverage;
  amountReads = 0;
  const recovered = await coordinator.prepareCoarsePricing({ graph: carryNextGraph,
    deadlineAtMs: Date.now() + 10_000, canonicalActivity: { source: carryNextSource,
      parentHash: CURRENT.hash, touchedStateKeys: new Set([firstParallelTarget]), complete: true } });
  assert.equal(recovered.status, "complete");
  assert.equal(amountReads, 2, "only the formerly absent touched direction pair is newly quoted");
  for (const key of missingKeys) {
    assert.equal(recovered.snapshot.mids.has(key), false);
    assert.equal(recovered.snapshot.effectiveMids!.rows.get(key)!.status, "quoted");
    assert.equal(effectiveEnumerationMids(recovered.snapshot).has(key), true);
  }
  amountReads = 0;
  const carried = await coordinator.prepareCoarsePricing({ graph: carryThirdGraph,
    deadlineAtMs: Date.now() + 10_000, canonicalActivity: { source: carryThirdSource,
      parentHash: carryNextSource.hash, touchedStateKeys: new Set(), complete: true } });
  assert.equal(carried.status, "complete");
  assert.equal(amountReads, 0, "recovered effective rows remain in clean-block membership");
  assert.equal(carried.snapshot.effectiveMids!.rows.size, carryThirdGraph.scannerEdgeCount);
  // No proof and a mismatched-source proof both force a full effective refresh, never raw.
  for (const canonicalActivity of [undefined, { source: carryNextSource,
    touchedStateKeys: new Set<string>(), complete: true as const }]) {
    amountReads = 0;
    await coordinator.prepareCoarsePricing({ graph: carryThirdGraph,
      deadlineAtMs: Date.now() + 10_000, canonicalActivity });
    assert.equal(amountReads, carryThirdGraph.scannerEdgeCount);
  }
  assert.equal(rawReads, bootstrapReads);
  assert.strictEqual(originalSizing!.coverage, originalCoverage);
  assert.strictEqual(coordinator.latestPricingSnapshot()!.mids, bootstrap.snapshot.mids);
  assert.deepEqual(coordinator.latestPricingSnapshot()!.rawMidSource, CURRENT);
  assert.equal(publications[0]!.kind, "baseline");
  for (const item of publications.slice(1)) {
    assert.equal(item.kind, "delta");
    if (item.kind === "delta") { assert.deepEqual(item.updates, []); assert.deepEqual(item.removals, []); }
  }
  console.log("strict frozen raw: PASS missing-direction recovery, carry, full effective refresh, empty raw deltas");
}

// Current effective status owns coverage even when every raw entry is healthy.
{
  const statuses = ["quoted", "no-output", "unsupported", "quote-failed", "missing-valuation", "missing-row"] as const;
  const coordinator = new StrictCurrentRuntimeCoordinator(request => parallelRoot.createSession({
    source: request.source, runtime: runtime(request.source), fundingAssets: [], control: request.control,
    kind: "pricing",
  }), () => {}, undefined, async sizing => {
    const rows = new Map<string, EffectiveMidRow>();
    for (const [index, graphEdge] of sizing.graph.edges.entries()) {
      const status = statuses[index % statuses.length]!;
      if (status === "missing-row") continue;
      const key = blockScanEdgeKey(graphEdge);
      rows.set(key, { edgeId: key, instanceKey: graphEdge.instanceKey!,
        tokenIn: graphEdge.tokenIn.toUpperCase(), tokenOut: graphEdge.tokenOut.toUpperCase(), status,
        amountIn: status === "quoted" ? 1n : null,
        amountOut: status === "quoted" ? 2n : null, effectiveMid: status === "quoted" ? 2 : null });
    }
    return { source: CURRENT, rows, reference: "default", referenceWethInput: DEFAULT_EFFECTIVE_WETH_INPUT,
      complete: true, wallMs: 0 };
  });
  const result = await coordinator.prepare({ graph: carryBaseGraph, fundingTokens: [], deadlineAtMs: Date.now() + 10_000 });
  assert.equal(result.status, "degraded");
  const pricing = result.snapshot.pricing;
  assert.equal(pricing.mids.size, carryBaseGraph.scannerEdgeCount);
  for (const [index, graphEdge] of carryBaseGraph.edges.entries()) {
    const status = statuses[index % statuses.length]!;
    assert.equal(pricing.coverageByEdgeKey.get(blockScanEdgeKey(graphEdge))!.status,
      status === "quoted" ? "resolved" : status === "no-output" || status === "unsupported" ? "rejected" : "unresolved");
  }
  assert.equal(effectiveEnumerationMids(pricing).size, pricing.coverage.resolvedEdgeKeys.length);
  assert.doesNotThrow(() => assertAtomicBlockScanRuntime(result.snapshot));
  console.log("strict frozen raw: PASS current effective coverage partition and case-insensitive row tokens");
}

// Reorg/topology/reset create a fresh raw epoch. A forward source gap retains
// sizing raw, but does not authorize effective carry across the missing blocks.
for (const mode of ["same-height-reorg", "parent-mismatch", "backward", "topology", "reset", "forward-gap"] as const) {
  let selectedRoot = parallelRoot, rawReads = 0;
  const sizingSnapshots: BlockScanStateSnapshot[] = [];
  const publications: StrictPricingPublication[] = [];
  const coordinator = new StrictCurrentRuntimeCoordinator(request => selectedRoot.createSession({
    source: request.source, runtime: runtime(request.source, { onCurrentPricingReadStart: () => { rawReads++; } }),
    fundingAssets: [], control: request.control, kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    requiredEdgeIds: request.requiredEdgeIds,
  }), () => {}, item => { publications.push(item); }, async (sizing, _control, _backend, reuse) => {
    sizingSnapshots.push(sizing);
    assert.equal(reuse?.touchedStateKeys, undefined, "invalid continuity never carries effective state");
    const target = reuse?.quoteGraph ?? sizing;
    return { source: { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation },
      rows: new Map(), reference: "default", referenceWethInput: DEFAULT_EFFECTIVE_WETH_INPUT,
      complete: true, wallMs: 0 };
  });
  await coordinator.prepareCoarsePricing({ graph: carryBaseGraph, deadlineAtMs: Date.now() + 10_000 });
  const baselineReads = rawReads;
  let nextGraph = carryNextGraph;
  if (mode === "reset") await coordinator.resetDynamicStateForReplay();
  if (mode === "topology") selectedRoot = root;
  if (mode === "topology" || mode === "same-height-reorg" || mode === "backward") nextGraph = createVerifiedGraphView({
    ...carryNextGraph, id: `frozen-raw-${mode}`,
    sourceBlock: mode === "backward" ? CURRENT.number - 1 : mode === "same-height-reorg" ? CURRENT.number : carryNextSource.number,
    familyIdForEdge: () => publication.familyId,
    edges: mode === "topology" ? startupView.edges : parallelStartupView.edges,
  });
  if (mode === "forward-gap") nextGraph = carryThirdGraph;
  await coordinator.prepareCoarsePricing({ graph: nextGraph, deadlineAtMs: Date.now() + 10_000,
    canonicalActivity: { source: { number: nextGraph.sourceBlock, hash: nextGraph.sourceBlockHash,
      generation: nextGraph.generation }, parentHash: mode === "parent-mismatch" ? WRONG_HASH.hash : CURRENT.hash,
      touchedStateKeys: new Set(), complete: true } });
  if (mode === "forward-gap") {
    assert.equal(rawReads, baselineReads);
    assert.strictEqual(sizingSnapshots[1], sizingSnapshots[0]);
    assert.equal(publications[1]!.kind, "delta");
  } else {
    assert(rawReads > baselineReads);
    assert.notStrictEqual(sizingSnapshots[1], sizingSnapshots[0]);
    assert.equal(publications[1]!.kind, "baseline");
    assert.equal(coordinator.latestPricingSnapshot()!.rawMidSource!.number, nextGraph.sourceBlock);
  }
  console.log(`strict frozen raw epoch: PASS ${mode}`);
}

// Bootstrap ordering remains raw -> effective. Steady metadata/Funding and
// effective settlement stays atomic without issuing another raw pricing read.
for (const path of ["coarse", "runtime"] as const) {
  const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
  for (const mode of ["session-first", "effective-first", "session-reject", "effective-reject", "abort", "reset"] as const) {
    let rawGate = preparationGate(), quoteGate = preparationGate();
    let rawStarted = preparationGate(), quoteStarted = preparationGate();
    let steady = false, publications = 0, effectiveCalls = 0;
    let previous: BlockScanStateSnapshot | null = null;
    let originalSizing: BlockScanStateSnapshot | undefined;
    let rawReads = 0;
    const controller = new AbortController();
    const touched = new Set<string>([firstParallelTarget]);
    const paired = new StrictCurrentRuntimeCoordinator(async request => {
      rawStarted.release();
      await rawGate.promise;
      if (steady && mode === "session-reject") throw new Error("session fixture rejected");
      if (steady) {
        assert.equal(request.purpose, "exact-execution");
        assert.equal(request.requiredEdgeIds?.size, 0);
        assert.equal(request.touchedPools, undefined);
      }
      return parallelRoot.createSession({ source: request.source,
        runtime: runtime(request.source, { onCurrentPricingReadStart: () => { rawReads++; } }),
        fundingAssets: [], kind: request.purpose === "exact-execution" ? "exact" : "pricing",
        control: request.control, touchedPools: request.touchedPools, requiredEdgeIds: request.requiredEdgeIds });
    }, () => {}, () => { publications++; }, async (sizing, _control, _backend, reuse) => {
      effectiveCalls++;
      if (steady) {
        assert.strictEqual(sizing, originalSizing, "steady sizing is the original startup raw snapshot");
        assert.equal(sizing.rawMidSource, undefined, "the sizing snapshot itself has never been relabelled");
        assert.strictEqual(reuse?.quoteGraph, carryNextGraph, "quote target is independently current");
        assert.strictEqual(reuse?.touchedStateKeys, touched);
      } else { originalSizing = sizing; assert.equal(reuse?.quoteGraph, undefined); }
      quoteStarted.release();
      await quoteGate.promise;
      if (steady && mode === "effective-reject") throw new Error("effective fixture rejected");
      const target = reuse?.quoteGraph ?? sizing;
      return { source: { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation },
        rows: new Map(), reference: "default", referenceWethInput: 1_000_000_000_000_000n,
        complete: true, wallMs: 0 };
    });
    const prepare = (graph: typeof carryBaseGraph) => {
      const args = { graph, deadlineAtMs: Date.now() + 10_000, signal: controller.signal,
        touchedPools: touched, canonicalActivity: { source: { number: graph.sourceBlock,
          hash: graph.sourceBlockHash, generation: graph.generation }, parentHash: CURRENT.hash,
          touchedStateKeys: touched, complete: true as const } };
      return path === "coarse" ? paired.prepareCoarsePricing(args) : paired.prepare({ ...args, fundingTokens: [] });
    };
    const bootstrap = prepare(carryBaseGraph);
    await awaitPreparationGate(rawStarted.promise, "bootstrap raw starts");
    await nextTurn();
    assert.equal(effectiveCalls, 0, "only bootstrap waits for its first raw conversion");
    rawGate.release();
    await awaitPreparationGate(quoteStarted.promise, "bootstrap effective starts after raw");
    assert.equal(publications, 0);
    quoteGate.release();
    await bootstrap;
    const bootstrapReads = rawReads;
    assert(bootstrapReads > 0);
    previous = paired.latestPricingSnapshot();
    assert(previous);
    steady = true;
    rawGate = preparationGate(); quoteGate = preparationGate();
    rawStarted = preparationGate(); quoteStarted = preparationGate();
    let settled = false;
    const pending = prepare(carryNextGraph).finally(() => { settled = true; });
    const observed = Promise.allSettled([pending]);
    try {
      await awaitPreparationGate(Promise.all([rawStarted.promise, quoteStarted.promise]), "both steady branches start before either finishes");
      assert.equal(publications, 1);
      assert.equal(paired.latestPricingSnapshot(), previous);
      if (mode === "abort") controller.abort(new Error("parallel fixture cancelled"));
      if (mode === "reset") await paired.resetDynamicStateForReplay();
      if (mode === "session-first" || mode === "session-reject") rawGate.release();
      else quoteGate.release();
      await nextTurn();
      assert.equal(settled, false, "one completed/rejected branch cannot detach the sibling");
      assert.equal(publications, 1, "no half publication");
    } finally {
      rawGate.release(); quoteGate.release();
      await observed;
    }
    assert.equal(rawReads, bootstrapReads, "steady metadata/session creation issues no raw reads");
    if (mode === "session-first" || mode === "effective-first") {
      await pending;
      assert.equal(publications, 2);
      assert.equal(paired.latestPricingSnapshot()!.sourceBlock, carryNextSource.number);
      assert.deepEqual(paired.latestPricingSnapshot()!.effectiveMids!.source, carryNextSource);
    } else {
      await assert.rejects(pending, mode === "abort" ? /parallel fixture cancelled/
        : mode === "reset" ? /retired/ : /fixture rejected/);
      assert.equal(publications, 1);
      assert.equal(paired.latestPricingSnapshot(), mode === "reset" ? null : previous);
    }
    console.log(`strict frozen raw atomic effective: PASS ${path}/${mode}`);
  }
}

// The existing warm/publication boundary awaits amount quotes atomically in
// both producer paths. Cancellation, mismatch and partial work never replace
// an already published raw/effective pair.
for (const path of ["coarse", "runtime"] as const) {
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let invalid: "none" | "source" | "partial" | "late-abort" = "none";
  let publications = 0;
  const enriched = new StrictCurrentRuntimeCoordinator(
    request => root.createSession({ source: request.source, runtime: strictRuntime,
      fundingAssets: request.fundingAssets, kind: request.purpose === "exact-execution" ? "exact" : "pricing",
      requiredEdgeIds: request.requiredEdgeIds, control: request.control }),
    () => {},
    publication => {
      publications++;
      assert(publication.snapshot.effectiveMids);
      assert.equal(publication.snapshot.effectiveMids.source.number, publication.snapshot.sourceBlock);
    },
    async (pricing) => {
      entered();
      await barrier;
      if (invalid === "late-abort") controller.abort(new Error("canonical source unavailable"));
      return { source: { number: pricing.sourceBlock,
        hash: invalid === "source" ? "0xwrong" : pricing.sourceBlockHash,
        generation: pricing.generation },
        rows: new Map(), reference: "default", referenceWethInput: 1_000_000_000_000_000n,
        complete: invalid !== "partial", wallMs: 0 };
    },
  );
  const controller = new AbortController();
  const prepare = () => path === "coarse"
    ? enriched.prepareCoarsePricing({ graph: currentGraph, deadlineAtMs: Date.now() + 10_000,
        signal: controller.signal })
    : enriched.prepare({ graph: currentGraph, fundingTokens: [UNIV2_FIXTURE_TOKEN0],
        deadlineAtMs: Date.now() + 10_000, signal: controller.signal });
  const pending = prepare();
  await started;
  assert.equal(publications, 0, `${path}: raw mid must not release warm before effective`);
  assert.equal(enriched.latestPricingSnapshot(), null);
  release();
  await pending;
  assert.equal(publications, 1);
  const published = enriched.latestPricingSnapshot();
  assert(published?.effectiveMids);
  assert(published.mids.size > 0, "effective companion must not replace the raw mid table");
  for (const failure of ["source", "partial"] as const) {
    invalid = failure;
    await assert.rejects(prepare, /effective pricing incomplete or mismatched source/);
    assert.equal(enriched.latestPricingSnapshot(), published);
  }
  invalid = "late-abort";
  await assert.rejects(prepare);
  assert.equal(enriched.latestPricingSnapshot(), published);
  await assert.rejects(prepare);
  assert.equal(publications, 1);
  await enriched.resetDynamicStateForReplay();
  assert.equal(enriched.latestPricingSnapshot(), null);
}

// Raw and effective use the SAME published base. Incomplete/cancelled drafts
// never become another reuse cursor, including before the first publication
// and after a source mismatch. Retry may retain the published table only.
for (const path of ["coarse", "runtime"] as const) {
  let publications = 0;
  let observedPrevious: EffectiveMidSnapshot | undefined;
  let returned!: EffectiveMidSnapshot;
  let mode: "partial" | "complete" | "mismatch" | "abort" = "partial";
  let controller = new AbortController();
  const coordinated = new StrictCurrentRuntimeCoordinator(
    request => root.createSession({ source: request.source, runtime: strictRuntime,
      fundingAssets: request.fundingAssets, kind: request.purpose === "exact-execution" ? "exact" : "pricing",
      requiredEdgeIds: request.requiredEdgeIds, control: request.control }),
    () => {}, () => { publications++; },
    async (pricing, _control, _backend, reuse) => {
      observedPrevious = reuse?.previous;
      returned = Object.freeze({ source: { number: pricing.sourceBlock,
        hash: mode === "mismatch" ? WRONG_HASH.hash : pricing.sourceBlockHash,
        generation: pricing.generation }, rows: new Map(), reference: "default",
        referenceWethInput: 1_000_000_000_000_000n, complete: mode === "complete", wallMs: 0 });
      if (mode === "abort") controller.abort(new Error("fixture head superseded"));
      return returned;
    },
  );
  const prepare = () => path === "coarse"
    ? coordinated.prepareCoarsePricing({ graph: currentGraph, deadlineAtMs: Date.now() + 10_000,
        signal: controller.signal })
    : coordinated.prepare({ graph: currentGraph, fundingTokens: [UNIV2_FIXTURE_TOKEN0],
        deadlineAtMs: Date.now() + 10_000, signal: controller.signal });
  await assert.rejects(prepare, /effective pricing incomplete/);
  assert.equal(observedPrevious, undefined);
  assert.equal(publications, 0);
  assert.equal(coordinated.latestPricingSnapshot(), null);
  mode = "mismatch";
  await assert.rejects(prepare, /effective pricing incomplete or mismatched source/);
  assert.equal(observedPrevious, undefined, "unpublished draft is not a raw-mid reuse base");
  mode = "complete";
  await prepare();
  assert.equal(observedPrevious, undefined, "partial or foreign-source drafts must not be reused");
  const published = coordinated.latestPricingSnapshot();
  assert(published);
  assert.equal(publications, 1);
  mode = "abort";
  await assert.rejects(prepare);
  assert.equal(observedPrevious, published.effectiveMids);
  assert.equal(coordinated.latestPricingSnapshot(), published);
  assert.equal(publications, 1, "retained data is never a consumer publication");
  controller = new AbortController();
  mode = "complete";
  await prepare();
  assert.equal(observedPrevious, published.effectiveMids, "cancelled rows never replace the common published base");
  assert.equal(publications, 2);
  await coordinated.resetDynamicStateForReplay();
  assert.equal(coordinated.latestPricingSnapshot(), null);
  await prepare();
  assert.equal(observedPrevious, undefined, "reset clears the one published pricing base");
}

// Completion order/reset must not replace the latest raw/effective publication.
for (const retire of ["newer-prepare", "reset"] as const) {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const coordinated = new StrictCurrentRuntimeCoordinator(
    request => root.createSession({ source: request.source, runtime: strictRuntime,
      fundingAssets: [], kind: request.purpose === "exact-execution" ? "exact" : "pricing",
      requiredEdgeIds: request.requiredEdgeIds, control: request.control }),
    () => {}, undefined,
    async pricing => {
      if (first) { first = false; entered(); await gate; }
      return { source: { number: pricing.sourceBlock, hash: pricing.sourceBlockHash, generation: pricing.generation },
        rows: new Map(), reference: "default", referenceWethInput: 1n, complete: true, wallMs: 0 };
    },
  );
  const firstPrepare = coordinated.prepareCoarsePricing({ graph: currentGraph, deadlineAtMs: Date.now() + 10_000 });
  const rejected = assert.rejects(firstPrepare, /pricing publication retired during prepare/);
  await started;
  if (retire === "reset") await coordinated.resetDynamicStateForReplay();
  else await coordinated.prepareCoarsePricing({ graph: currentGraph, deadlineAtMs: Date.now() + 10_000 });
  const retained = coordinated.latestPricingSnapshot();
  release(); await rejected;
  assert.equal(coordinated.latestPricingSnapshot(), retained, retire);
}

for (const path of ["coarse", "runtime"] as const) for (const rejection of ["aborted", "expired"] as const) {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const guarded = new StrictCurrentRuntimeCoordinator(
    request => root.createSession({ source: request.source, runtime: strictRuntime,
      fundingAssets: [], kind: request.purpose === "exact-execution" ? "exact" : "pricing",
      requiredEdgeIds: request.requiredEdgeIds, control: request.control }), () => {}, undefined,
    async pricing => { entered(); await gate; return {
      source: { number: pricing.sourceBlock, hash: pricing.sourceBlockHash, generation: pricing.generation },
      rows: new Map(), reference: "default", referenceWethInput: 1n, complete: true, wallMs: 0,
    }; },
  );
  const healthy = guarded.prepareCoarsePricing({ graph: currentGraph, deadlineAtMs: Date.now() + 10_000 });
  await started;
  const controller = new AbortController(); if (rejection === "aborted") controller.abort();
  const args = { graph: currentGraph, signal: controller.signal,
    deadlineAtMs: rejection === "expired" ? Date.now() - 1 : Date.now() + 10_000 };
  await assert.rejects(path === "coarse" ? guarded.prepareCoarsePricing(args)
    : guarded.prepare({ ...args, fundingTokens: [] }));
  release(); await healthy;
  assert(guarded.latestPricingSnapshot(), `${path}/${rejection} cannot retire admitted work`);
}

// Resumed startup may use same-hash successful RPC bytes. The last canonical
// recheck is still an atomic publication barrier, including when no new quote
// needed the backend's requireCanonical check.
for (const disposition of [
  "success", "source-mismatch", "source-unavailable", "throttle", "sync-throw",
  "abort", "deadline", "newer-prepare", "reset",
] as const) {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  let effectiveBuilds = 0, publications = 0, validations = 0;
  const guarded = new StrictCurrentRuntimeCoordinator(
    request => root.createSession({ source: request.source, runtime: strictRuntime,
      fundingAssets: request.fundingAssets, kind: request.purpose === "exact-execution" ? "exact" : "pricing",
      requiredEdgeIds: request.requiredEdgeIds, control: request.control }),
    () => {}, () => { publications++; },
    async pricing => {
      effectiveBuilds++;
      return { source: { number: pricing.sourceBlock, hash: pricing.sourceBlockHash,
        generation: pricing.generation }, rows: new Map(), reference: "default",
        referenceWethInput: 1n, complete: true, wallMs: 0 };
    },
  );
  const args = { graph: currentGraph, fundingTokens: [UNIV2_FIXTURE_TOKEN0],
    deadlineAtMs: Date.now() + 60_000, signal: controller.signal };
  await guarded.prepare(args);
  const previous = guarded.latestPricingSnapshot();
  const pending = guarded.prepare({ ...args, validateBeforePublish: () => {
    validations++;
    assert.equal(effectiveBuilds, 2, "canonical barrier must follow complete amount pricing");
    assert.equal(guarded.latestPricingSnapshot(), previous, "no raw-only publication while validating");
    entered();
    if (disposition === "sync-throw") throw new Error("canonical check failed synchronously");
    return barrier.then(() => {
      if (["source-mismatch", "source-unavailable", "throttle"].includes(disposition)) {
        throw new Error(`canonical validation ${disposition}`);
      }
    });
  } });
  const observed = Promise.allSettled([pending]);
  await started;
  assert.equal(publications, 1);
  if (disposition === "abort") controller.abort(new Error("shutdown during canonical check"));
  if (disposition === "newer-prepare") await guarded.prepare(args);
  if (disposition === "reset") await guarded.resetDynamicStateForReplay();
  const retained = guarded.latestPricingSnapshot();
  const publicationCount = publications;
  const realNow = Date.now;
  try {
    // All sessions have settled at the barrier; deterministically expire the
    // request during validation without timing-dependent slow-machine sleeps.
    if (disposition === "deadline") Date.now = () => args.deadlineAtMs + 1;
    release();
    const [result] = await observed;
    assert.equal(validations, 1);
    if (disposition === "success") {
      assert.equal(result.status, "fulfilled");
      assert.notEqual(guarded.latestPricingSnapshot(), previous);
      assert.equal(publications, publicationCount + 1);
    } else {
      assert.equal(result.status, "rejected", disposition);
      assert.equal(guarded.latestPricingSnapshot(), retained, disposition);
      assert.equal(publications, publicationCount, disposition);
    }
  } finally {
    Date.now = realNow;
    release();
    await observed;
  }
  console.log(`strict startup canonical publication barrier: PASS ${disposition}`);
}

const failingCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => await root.createSession({
    source: request.source,
    runtime: runtime(request.source, { failCurrentPricing: true }),
    fundingAssets: request.fundingAssets,
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    ...(request.control === undefined ? {} : { control: request.control }),
  }),
  () => {},
);
const failedCoarse = await failingCoordinator.prepareCoarsePricing({
    graph: currentGraph,
    deadlineAtMs: Date.now() + 10_000,
  });
assert.equal(failedCoarse.status, "degraded");
assert.ok(failingCoordinator.latestPricingSnapshot());
assert.equal(
  failedCoarse.snapshot.coverage.unresolvedEdgeKeys.length,
  currentGraph.scannerEdgeCount,
  "failed strict pricing is published as explicit unresolved coverage",
);
let failAfterPublication = false;
const retainingCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => await root.createSession({
    source: request.source,
    runtime: runtime(request.source, {
      failCurrentPricing: failAfterPublication,
    }),
    fundingAssets: request.fundingAssets,
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    ...(request.control === undefined ? {} : { control: request.control }),
  }),
  () => {},
);
await retainingCoordinator.prepareCoarsePricing({
  graph: currentGraph,
  deadlineAtMs: Date.now() + 10_000,
});
const retainedPricing = retainingCoordinator.latestPricingSnapshot();
assert(retainedPricing);
failAfterPublication = true;
const failedAfterPublication = await retainingCoordinator.prepareCoarsePricing({
    graph: currentGraph,
    deadlineAtMs: Date.now() + 10_000,
  });
assert.equal(failedAfterPublication.status, "degraded");
assert.notStrictEqual(
  retainingCoordinator.latestPricingSnapshot(),
  retainedPricing,
  "failed strict refresh is visible as an explicit degraded generation",
);
const failingFundingCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => await root.createSession({
    source: request.source,
    runtime: runtime(request.source, { failFunding: true }),
    fundingAssets: request.fundingAssets,
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    ...(request.control === undefined ? {} : { control: request.control }),
  }),
  () => {},
);
const unresolvedFunding = await failingFundingCoordinator.prepare({
  graph: currentGraph,
  fundingTokens: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(unresolvedFunding.status, "degraded");
assert.equal(
  unresolvedFunding.snapshot.funding.coverage.unresolvedKeys.length,
  readyFundingAssets.length,
);
assert.equal(unresolvedFunding.snapshot.funding.sources.size, 0);
assert.equal(unresolvedFunding.snapshot.funding.freshnessByFundingId.size, 0);
assert.ok([...unresolvedFunding.snapshot.funding.coverageByFundingId.values()]
  .every((coverage) => coverage.status === "unresolved"));
assert.doesNotThrow(() =>
  assertAtomicBlockScanRuntime(unresolvedFunding.snapshot)
);
assert.equal(
  failingFundingCoordinator.latestPricingSnapshot(),
  unresolvedFunding.snapshot.pricing,
  "healthy pricing may publish while unresolved Funding remains fail-closed",
);
assert(session.supportsVictimReplay(edge));
const victim = session.replayVictim({
  edge,
  impact: Object.freeze({
    pool: UNIV2_FIXTURE_POOL,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    amountIn: 1_000_000n,
    exactPostState: Object.freeze({
      reserve0: pool.reserves.reserve0 + 1_000_000n,
      reserve1: pool.reserves.reserve1 - 1_000n,
      feeBps: 30n,
      blockTimestampLast: pool.reserves.blockTimestampLast,
    }),
  }),
  preState: null,
  validUntil: 1_800_000_000n,
});
assert.equal(victim.status, "resolved");
if (victim.status === "resolved") {
  assert(victim.overlay !== null);
  assert.equal(victim.overlay.preCalls.length, 2);
  assert.equal(
    (victim.exactPostState as { readonly kind?: unknown } | null)?.kind,
    "v2",
  );
}
const simulationsBeforeEffective = fixtureAmountSimulations;
const effectiveExact = await session.issueExact({
  edge, amountIn: 1_000_000n, executor: EXECUTOR, runtimeEvidence: [],
});
assert.ok(effectiveExact.amountOut > 0n);
assert.equal(fixtureAmountSimulations, simulationsBeforeEffective,
  "V2 without a matched Router uses source reserves, never the local execution simulator");
const noSimulationSession = await root.createSession({
  source: CURRENT, kind: "exact", fundingAssets: [],
  runtime: runtime(CURRENT, { omitAmountSimulation: true, reserves: {
    reserve0: pool.reserves.reserve0 * 3n,
    reserve1: pool.reserves.reserve1,
    blockTimestampLast: pool.reserves.blockTimestampLast + 1,
  } }),
});
const noSimulationEdge = noSimulationSession.edges.find(candidate => candidate.canonicalEdgeId === edge.canonicalEdgeId)!;
assert(noSimulationEdge);
await assert.rejects(noSimulationSession.issueExact({
  edge: noSimulationEdge, amountIn: 1_000_000n,
  executor: EXECUTOR, runtimeEvidence: [], requireChainAmountQuote: true,
}), { code: "CHAIN_AMOUNT_QUOTE_UNAVAILABLE" }, "reserve reads alone cannot manufacture a positive chain amount quote");
const noSimulationExact = await noSimulationSession.issueExact({
  edge: noSimulationEdge, amountIn: 1_000_000n,
  executor: EXECUTOR, runtimeEvidence: [],
});
assert.equal(noSimulationExact.amountOut, effectiveExact.amountOut);
assert.equal(fixtureAmountSimulations, simulationsBeforeEffective);
const exact = await session.issueExact({
  edge,
  amountIn: 1_000_000n,
  executor: EXECUTOR,
  runtimeEvidence: Object.freeze([]),
});
assert(exact.amountOut > 0n);
assert.deepEqual(exact.source, CURRENT);
const execution = session.buildExecution({
  edge,
  exact,
  minAmountOut: exact.amountOut - 1n,
  executor: EXECUTOR,
});
assert.equal(execution.status, "resolved");

// Sequential issuance cannot reuse a starting-state method, forged handle,
// foreign session, wrong caller, reordered prefix or disconnected amount.
{
  const reverse = session.edges.find(e => e.instanceKey === edge.instanceKey &&
    e.tokenIn.toLowerCase() === edge.tokenOut.toLowerCase() &&
    e.tokenOut.toLowerCase() === edge.tokenIn.toLowerCase())!;
  assert(reverse);
  const request = { edge: reverse, amountIn: exact.amountOut, executor: EXECUTOR,
    runtimeEvidence: [], priorQuotes: [exact] };
  await assert.rejects(session.issueExact(request), /exact-sequential-prefix-unsupported/);
  await assert.rejects(session.issueExact({ ...request, amountIn: exact.amountOut + 1n }), /prefix does not supply/);
  await assert.rejects(session.issueExact({ ...request, priorQuotes: [Object.freeze({ ...exact }) as typeof exact] }), /same-session/);
  await assert.rejects(noSimulationSession.issueExact({ ...request, edge: noSimulationSession.edges.find(e =>
    e.canonicalEdgeId === reverse.canonicalEdgeId)! }), /same-session/);
  await assert.rejects(session.issueExact({ ...request, executor: ORIGIN }), /same-session/);
  await assert.rejects(session.issueExact({ ...request, priorQuotes: [exact, exact] }), /same-session/);
  assert("amountIn" in exact);
  assert.equal((await session.issueExact({ edge, amountIn: exact.amountIn, executor: EXECUTOR,
    runtimeEvidence: [] })).amountOut, exact.amountOut, "failed sequential trials never mutate effective/start state");
}

// Test-only sequential capability: exercise real issuer/cache/plan authority,
// not V2 sequential pricing support (the production V2 method stays unchanged).
{
  function mutable<T>(value: T): T {
    if (Array.isArray(value)) return value.map(mutable) as T;
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mutable(v)])) as T;
    return value;
  }
  const definition = mutable(baseV2Plugin);
  const plugin = defineSwapFamily({ ...definition, actionAdapters: baseV2Plugin.actionAdapters,
    exact: { ...definition.exact, methods(input) {
      return baseV2Plugin.exact.methods(input).map(method => {
        if (method.kind !== "request-program") return method;
        return { id: "fixture-sequential", kind: "request-program" as const, sequentialPrefix: true as const,
          program: { ...method.program, decode(args) {
            const result = method.program.decode(args);
            const amountOut = result.amountOut + BigInt(args.programInput.prefix?.length ?? 0);
            // This synthetic untaxed quote changes both the pool output and
            // its received amount; retaining the old receipt is invalid evidence.
            return { amountOut, evidence: { ...result.evidence, poolAmountOut: amountOut, amountOut } };
          } } };
      });
    } },
  });
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({
    familyId: plugin.manifest.familyId, capability, contractVersion: "sequential-fixture-v1",
    contentHash: ethers.sha256(ethers.toUtf8Bytes(capability)).slice(2),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: null,
  }));
  const catalog = new FamilyCapabilityCatalog({
    modules: [{ sourceFile: "fixture/sequential.production.ts", plugin,
      definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) },
  });
  const published = await runUniv2Lifecycle(STARTUP, pool, catalog);
  const loaded = catalog.forFamily(plugin.manifest.familyId);
  const graph = buildFamilyRouteGraphView({ routes: published.instances.flatMap(instance =>
    instance.routes.map((route, i) => ({ family: loaded, descriptor: instance.descriptor,
      route, handle: instance.routeHandles[i]! }))) });
  const sequentialRoot = new StrictProductionRuntimeRoot({ catalog, readySource: STARTUP,
    readyGraph: graph.edges, readyInstances: published.instances, readyFundingAssets: [] });
  const exactQuoteCache = createAdapterFamilyExactQuoteCache();
  const session = await sequentialRoot.createSession({ source: CURRENT, kind: "exact", fundingAssets: [],
    runtime: { ...runtime(CURRENT), exactQuoteCache } });
  const firstEdge = session.edges[0]!;
  const secondEdge = session.edges.find(e => e.tokenIn === firstEdge.tokenOut)!;
  const first = await session.issueExact({ edge: firstEdge, amountIn: 1_000_000n, executor: EXECUTOR, runtimeEvidence: [] });
  const request = { edge: secondEdge, amountIn: first.amountOut, executor: EXECUTOR, runtimeEvidence: [] };
  const starting = await session.issueExact(request);
  const sequential = await session.issueExact({ ...request, priorQuotes: [first] });
  assert.equal(sequential.amountOut, starting.amountOut + 1n, "prefix cannot hit an initial-state cache entry");
  const cached = await session.issueExact({ ...request, priorQuotes: [first] });
  assert.equal(cached.amountOut, sequential.amountOut);
  assert("outcome" in cached && cached.outcome.reasonCode === "exact-cache-reused");
  const execution = { edge: secondEdge, exact: cached, minAmountOut: cached.amountOut, executor: EXECUTOR };
  assert.throws(() => session.buildExecution(execution), /original sequential quote prefix/);
  assert.equal(session.buildExecution({ ...execution, priorQuotes: [first] }).status, "resolved");
  const otherFirst = await session.issueExact({ edge: firstEdge, amountIn: 1_000_000n, executor: EXECUTOR, runtimeEvidence: [] });
  assert.throws(() => session.buildExecution({ ...execution, priorQuotes: [otherFirst] }), /original sequential quote prefix/);
  assert.equal((await session.issueExact(request)).amountOut, starting.amountOut, "trial does not mutate effective state");
}

// Direct session consumers never supply origin: only the injected runtime may
// bind it, and issued Exact authority must remain current at buildExecution.
{
  let authority = { executor: EXECUTOR, transactionOrigin: `0x${"ab".repeat(20)}` };
  const originRuntime = { ...runtime(CURRENT), callerAuthority: { bind: () => authority } };
  const originSession = await root.createSession({
    source: CURRENT, runtime: originRuntime, fundingAssets: [], kind: "exact",
  });
  const originEdge = originSession.edges[0]!;
  const quoted = await originSession.issueExact({ edge: originEdge, amountIn: 1_000_000n,
    executor: EXECUTOR, runtimeEvidence: [], transactionOrigin: `0x${"cd".repeat(20)}` } as never);
  const build = () => originSession.buildExecution({ edge: originEdge, exact: quoted,
    minAmountOut: quoted.amountOut - 1n, executor: EXECUTOR });
  assert.equal(build().status, "resolved");
  authority = { ...authority, transactionOrigin: `0x${"cd".repeat(20)}` };
  assert.equal(build().status, "failed", "direct session execution rejects changed trusted origin");
  authority = { executor: `0x${"ef".repeat(20)}`, transactionOrigin: `0x${"ab".repeat(20)}` };
  assert.equal(build().status, "failed", "direct session execution rejects changed trusted executor independently");
}

// A searched handle may be consumed again in its own current session without
// another quote, but retaining it must not retain authority after retirement.
const readsBeforeReuse = currentPricingReads;
assert.deepEqual(session.buildExecution({
  edge,
  exact,
  minAmountOut: exact.amountOut - 1n,
  executor: EXECUTOR,
}), execution);
assert.equal(currentPricingReads, readsBeforeReuse);
currentGenerationActive = false;
try {
  assert.throws(() => session.buildExecution({
    edge,
    exact,
    minAmountOut: exact.amountOut - 1n,
    executor: EXECUTOR,
  }), /generation fence rejected stale source/);
} finally {
  currentGenerationActive = true;
}

assert.throws(
  () => session.buildExecution({
    edge,
    exact: Object.freeze({ ...exact }) as typeof exact,
    minAmountOut: exact.amountOut - 1n,
    executor: EXECUTOR,
  }),
  /same session-issued route\/exact authority/,
);

const foreignSession = await root.createSession({
  source: CURRENT,
  runtime: strictRuntime,
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});
assert.throws(
  () => foreignSession.buildExecution({
    edge: foreignSession.edges.find((candidate) =>
      candidate.canonicalEdgeId === edge.canonicalEdgeId
    )!,
    exact,
    minAmountOut: exact.amountOut - 1n,
    executor: EXECUTOR,
  }),
  /same session-issued route\/exact authority/,
);

const startupHandle = publication.instances[0].routeHandles.find((handle) =>
  handle.routeKey === startupView.handleByCanonicalEdgeId.get(
    edge.canonicalEdgeId!,
  )?.routeKey
)!;
const stale = await executeFamilyExactQuote({
  family,
  route: startupHandle,
  amountIn: 1_000_000n,
  executor: EXECUTOR,
  runtimeEvidence: Object.freeze([]),
  source: CURRENT,
  generation: CURRENT.generation,
  runtime: strictRuntime,
});
assert.notEqual(stale.status, "resolved");

const unavailableSession = await root.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT, {
    reserves: Object.freeze({
      reserve0: 0n,
      reserve1: pool.reserves.reserve1,
      blockTimestampLast: pool.reserves.blockTimestampLast,
    }),
  }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});
assert.equal(
  unavailableSession.currentPricingForEdge(
    unavailableSession.edges.find((candidate) =>
      candidate.canonicalEdgeId === edge.canonicalEdgeId
    )!,
  )?.status,
  "behavior-proven-unavailable",
);

const failedSession = await root.createSession({
    source: CURRENT,
    runtime: runtime(CURRENT, { failCurrentPricing: true }),
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  });
assert.equal(
  failedSession.currentPricingForEdge(failedSession.edges[0]!)?.status,
  "unresolved",
);

assert.throws(
  () => new StrictProductionRuntimeRoot({
      catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
      readySource: STARTUP,
      readyGraph: startupView.edges.slice(1),
      readyInstances: publication.instances,
      readyFundingAssets,
    }),
  /absent from Graph/,
  "the ready pricing index must reject a graph missing a pricing route",
);

async function creditOptionalCapabilities(): Promise<void> {
  const vault = `0x${"71".repeat(20)}`;
  const supply = `0x${"72".repeat(20)}`;
  const borrow = `0x${"73".repeat(20)}`;
  const factory = FLUID_RESOLVER_FACTORY;
  const liquidity = "0x52Aa899454998Be5b000Ad077a46Bbe360F4e497";
  const collateral = 1_000n * 10n ** 18n;
  const capacityBinding = { vault, supplyToken: supply, borrowToken: borrow, supplyDecimals: 18, borrowDecimals: 6,
    factoryBinding: { factory, vaultId: 1n, reverseVault: vault } } as FluidCreditDescriptor;
  const modelFixture = JSON.parse(readFileSync(new URL(
    "../venues/credit/fluid-family/test/fixtures/local-models.json", import.meta.url), "utf8")) as {
    runtimeCode: string; immutableReferences: readonly { name: string; offsets: readonly number[] }[];
  };
  const modelConstants: Record<string, string | bigint> = {
    SUPPLY_TOKEN: supply, BORROW_TOKEN: borrow, SUPPLY_DECIMALS: 18n, BORROW_DECIMALS: 6n,
    ADMIN_IMPLEMENTATION: ethers.ZeroAddress, SECONDARY_IMPLEMENTATION: ethers.ZeroAddress,
    LIQUIDITY: liquidity, VAULT_FACTORY: factory, VAULT_ID: 1n,
    LIQUIDITY_SUPPLY_EXCHANGE_PRICE_SLOT: ethers.ZeroHash, LIQUIDITY_BORROW_EXCHANGE_PRICE_SLOT: ethers.ZeroHash,
    LIQUIDITY_USER_SUPPLY_SLOT: ethers.ZeroHash, LIQUIDITY_USER_BORROW_SLOT: ethers.ZeroHash,
  };
  const modelRuntime = Buffer.from(modelFixture.runtimeCode.slice(2), "hex");
  for (const immutable of modelFixture.immutableReferences) {
    assert(Object.hasOwn(modelConstants, immutable.name));
    const word = Buffer.from(ethers.toBeHex(BigInt(modelConstants[immutable.name]!), 32).slice(2), "hex");
    for (const offset of immutable.offsets) word.copy(modelRuntime, offset);
  }
  const vaultCode = "0x" + modelRuntime.toString("hex");
  function mutableDefinition<T>(value: T): T {
    if (Array.isArray(value)) return value.map(mutableDefinition) as T;
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
        [key, mutableDefinition(entry)])) as T;
    }
    return value;
  }
  // Real Family programs and centrally issued handles; only transport is synthetic.
  function fixtureRuntime(source: CanonicalSource, options: {
    readonly failPricing?: boolean;
    readonly failOperate?: boolean;
    readonly onRequest?: (request: AdapterRequest) => void;
    readonly doubledRate?: boolean;
  } = {}): CentralAdapterRuntime {
    const result = (request: AdapterRequest): AdapterRequestResult => {
      options.onRequest?.(request);
      if (request.id === "credit-current-capacity") {
        if (options.failPricing) throw new Error("fixture pricing read failed");
        assert.equal(request.kind, "eth-call", "local quote reads current capacity, never an operate receipt");
        return capacityFixture(source, capacityBinding, { liquidity,
          ...(options.doubledRate ? { oracleRate: BORROW_STATE.oracleRate * 2n } : {}) })[0]!;
      }
      const state = stateFixture(source).find((entry) => entry.id === request.id);
      if (state !== undefined) {
        if (options.failPricing) throw new Error("fixture pricing read failed");
        if (request.id === "credit-current-oracle" && options.doubledRate && state.ok) {
          return { ...state, data: ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256"], [BORROW_STATE.oracleRate * 2n],
          ) };
        }
        return state;
      }
      const base = { id: request.id, ok: true as const, source,
        provenance: { kind: "session-credit-fixture", fingerprint: request.id },
        completion: "returned" as const };
      if (request.kind === "effect-delta-simulation") {
        if (options.failOperate) throw new Error("fixture operate failed");
        const [, amountIn, amountOut] = FLUID_VAULT_INTERFACE.decodeFunctionData("operate", request.call.data);
        const actor = request.call.caller.kind === "verified-actor" ? FLUID_CREDIT_PROBE_ACTOR : EXECUTOR;
        if (request.id === "credit-exact-operate") {
          assert.equal(request.call.executionMode, "impersonated-call-frame");
        }
        return { ...base,
          data: FLUID_VAULT_INTERFACE.encodeFunctionResult("operate", [1n, amountIn, amountOut]),
          effects: { tokenDeltas: [
            { token: supply, account: actor, delta: -BigInt(amountIn) },
            { token: borrow, account: actor, delta: BigInt(amountOut) },
          ] },
        };
      }
      const data = request.id === "vault-constants"
        ? FLUID_VAULT_INTERFACE.encodeFunctionResult("constantsView", [[
            liquidity, factory, ethers.ZeroAddress, ethers.ZeroAddress,
            supply, borrow, 18, 6, 1n,
            ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash,
          ]])
        : request.kind === "get-code" ? request.id === "vault-code" ? vaultCode : "0x6000"
        : request.id === "factory-reverse-vault"
          ? FLUID_VAULT_FACTORY_INTERFACE.encodeFunctionResult("getVaultAddress", [vault])
          : (() => { throw new Error(`unexpected Credit fixture request ${request.id}`); })();
      return { ...base, data };
    };
    return {
      clock: { nowMs: () => 1_000 },
      generationFence: { assertCurrent(generation, actual) {
        assert.equal(generation, source.generation);
        assert.deepEqual(actual, source);
      } },
      callerAuthority: { bind: () => ({ executor: EXECUTOR, transactionOrigin: ORIGIN,
        verifiedActors: { [FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID]: FLUID_CREDIT_PROBE_ACTOR } }) },
      policy: { bind: input => ({ lane: "background", deadlineAtMs: 100_000, maxAttempts: 1,
        transportPool: "state-read", fairnessKey: input.subjectKey }) },
      budgets: { assertAdmitted() {} },
      scheduler: { issueExecutor(issue) {
        return {
          executor: createBoundedRequestExecutor({
            assertSupported: requirements => assert.deepEqual(requirements, issue.requirements),
            assertCallerBinding() {},
            assertWithinBudget: (_familyId, requests) => assert.deepEqual(requests, issue.requests),
            execute: async ({ requests }) => requests.map(result),
            sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
          }),
          timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
        };
      } },
    };
  }

  for (const slots of ["none", "pricing-only", "exact-only", "both"]) {
    const priced = slots === "both";
    const { pricing: _pricing, exact: _exact, ...legacy } = fluidCreditStrictFamilyPlugin;
    const plugin = priced ? fluidCreditStrictFamilyPlugin : defineCreditFamily({
      ...mutableDefinition({
        ...legacy,
        ...(slots === "pricing-only" ? { pricing: _pricing } : {}),
        ...(slots === "exact-only" ? { exact: _exact } : {}),
      }),
      actionAdapters: fluidCreditStrictFamilyPlugin.actionAdapters,
    });
    const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({
      familyId: plugin.manifest.familyId, capability, contractVersion: "session-credit-fixture-v1",
      contentHash: ethers.sha256(ethers.toUtf8Bytes(capability)).slice(2),
      semanticDependencies: [`contract:${capability}`], provenanceCommit: null,
    }));
    const catalog = new FamilyCapabilityCatalog({
      modules: [{ sourceFile: "fixture/session-credit.production.ts", plugin,
        definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
      generatedManifest: { format: "adapter-family-capabilities-v1", entries,
        manifestHash: capabilityManifestHash(entries) },
    });
    const family = catalog.forStrictFamily(plugin.manifest.familyId);
    assert.throws(() => catalog.forFamily(plugin.manifest.familyId), /unknown|not|route/i,
      "pricing does not change Credit taxonomy");
    const lifecycle = await executeCreditFamilyInstanceLifecycle({
      family, source: STARTUP, generation: STARTUP.generation, runtime: fixtureRuntime(STARTUP),
      match: { matchedPatternId: "fluid-credit-operate-call", observation: {
        kind: "call", source: STARTUP, target: vault, sender: EXECUTOR,
        data: FLUID_VAULT_INTERFACE.encodeFunctionData("operate", [0n, collateral, 1_000_000n, EXECUTOR]),
      } },
    });
    assert(lifecycle.instance, JSON.stringify(lifecycle.outcomes));
    const instance = lifecycle.instance;
    assert.equal((instance.descriptor as FluidCreditDescriptor).localQuoteModel, "t1-view-v1",
      "actual compiler-template runtime selects the local model through identity");
    assert.equal(instance.pricingInstances.length, priced ? 1 : 0);
    if (priced) {
      const authority = reissuePreparedInstanceAuthority({ family, instance, source: CURRENT, generation: CURRENT.generation });
      const reissued = reissuePreparedInstanceRouteHandles({ family: asPricedFamily(family),
        instance: authority, source: CURRENT, generation: CURRENT.generation });
      for (const [owner, source] of [[instance, STARTUP], [authority, CURRENT], [reissued, CURRENT]] as const) {
        assertIssuedPreparedFamilyPricingStateInstance({ family, instance: owner,
          pricing: owner.pricingInstances[0]!, source, generation: source.generation });
      }
      assert.notEqual(instance.pricingInstances[0], reissued.pricingInstances[0]);
      assert.throws(() => assertIssuedPreparedFamilyPricingStateInstance({ family, instance,
        pricing: reissued.pricingInstances[0]!, source: STARTUP, generation: STARTUP.generation }), /issuer-bound/);
    }
    const publication = prepareCreditFamilyRoutes({ family, instance,
      source: STARTUP, generation: STARTUP.generation });
    const graph = buildFamilyRouteGraphView({ routes: [], creditRoutes:
      publication.routes.map(route => projectCreditRouteGraph({ family, route })) });
    const root = new StrictProductionRuntimeRoot({ catalog, readySource: STARTUP,
      readyGraph: graph.edges, readyInstances: [instance], readyFundingAssets: [] });
    const edgeKey = graph.edges[0]!.canonicalEdgeId;
    assert.equal(root.pricingIndex().stateKeyByEdgeKey.has(edgeKey), priced);
    assert.equal(root.pricingIndex().familyIdByEdgeKey.has(edgeKey), priced);
    assert.equal(root.pricingIndex().edgeIdByRouteIdentity.size, priced ? 1 : 0);
    assert.deepEqual(root.pricingIndex().expectedEdgeKeys, priced ? [edgeKey] : []);
    assert.equal(scannerConsumesEdge(graph.edges[0]!), false,
      "Credit pricing coverage must not expand scanner consumption");
    const shadow = new StrictAdapterFamilyShadowCatalogPublicationRoot({ catalog, chainId: "1",
      terminalRemovalAuthority: createCatalogTerminalRemovalIssuer().authority,
      sourceTransitionAuthority: createCatalogSourceTransitionIssuer().authority,
      stateMutationAuthority: createCatalogStateInstanceMutationIssuer().authority });
    const stage = shadow.stageCreditFamily({ family, instance, publication });
    assert.equal(stage.instances[0]!.pricingEntries.size, priced ? 1 : 0);
    const sourceAnchors = plugin.discovery.sources.map(sourceId => ({
      familyId: plugin.manifest.familyId, sourceId,
      sourceFingerprint: catalogDiscoverySourceFingerprint({ familyId: plugin.manifest.familyId,
        sourceId, source: STARTUP }),
      authority: "append-only-nomination" as const, status: "complete" as const,
      completeThroughBlock: STARTUP.number, completeThroughHash: STARTUP.hash,
    }));
    if (priced) {
      const bundle = stage.instances[0]!;
      const [key, entry] = [...bundle.pricingEntries][0]!;
      const forged = { ...stage, instances: [{ ...bundle, pricingEntries:
        new Map([[key, { ...entry, value: Object.freeze({ ...entry.value }) }]]) }] };
      assert.throws(() => shadow.prepare({ source: STARTUP, previous: null,
        stages: [forged], sourceAnchors }), /pricing state was not staged/);
    }
    const prepared = shadow.prepare({ source: STARTUP, previous: null, stages: [stage], sourceAnchors });
    assert.equal(await shadow.compareAndPublish({ expected: null, staged: prepared,
      verifyCanonicalSource() {}, assertGenerationCurrent() {} }), true);
    const committed = shadow.capture()!;
    assert.equal(committed.views.edges[0]!.canonicalEdgeId, edgeKey);
    assert.equal(committed.views.edges[0]!.leavesStandingPosition, true);
    const keys = strictPricingPublicationKeysByFamily({ views: committed.views, familyId: plugin.manifest.familyId });
    assert.equal(keys.length, priced ? 1 : 0);
    if (priced) {
      assert.equal(committed.views.pricingByPublicationKey.get(keys[0]!), instance.pricingInstances[0]);
      assert.equal(createStrictCatalogConsumer(committed.views).resolvePricingMid({
        pricingPublicationKey: keys[0]!, routeKey: publication.routes[0]!.routeKey,
      }).kind, "mid");
    }
    const reads: string[] = [];
    const session = await root.createSession({ source: CURRENT, fundingAssets: [],
      runtime: fixtureRuntime(CURRENT, { doubledRate: true, onRequest: request => reads.push(request.id) }) });
    const edge = session.edges[0]!;
    assert.equal(edge.slotKind, "lend");
    assert.equal(edge.leavesStandingPosition, true);
    assert.equal(session.blocksPrefixInversion(edge), true);
    assert.equal(session.currentPricingForEdge(edge)?.status ?? null, priced ? "priced" : null);
    assert.deepEqual(reads, priced ? ["credit-current-capacity"] : [],
      "priced Credit uses one amount-independent source-state request");
    if (priced) {
      const pricing = session.currentPricingForEdge(edge);
      assert(pricing?.status === "priced");
      const startupMid = instance.pricingInstances[0]!.mids.get(instance.routes[0]!.routeKey)!;
      assert.equal(pricing.mid.mid, startupMid.mid * 2);
      assert.equal(session.stateKeyForEdge(edge), String(instance.pricingInstances[0]!.stateKey).toLowerCase());
      const refreshedExact = await session.issueExact({ edge, amountIn: collateral,
        executor: EXECUTOR, runtimeEvidence: [] });
      assert("methodId" in refreshedExact);
      assert.equal(refreshedExact.methodId, "fluid-credit-local-amount");
      assert.equal(session.buildExecution({ edge, exact: refreshedExact,
        minAmountOut: refreshedExact.amountOut, executor: EXECUTOR }).status, "resolved",
        "refreshed Credit pricing must retain its authenticated generic Exact route");
      const touched = await root.createSession({ source: CURRENT, fundingAssets: [],
        touchedPools: new Set([session.stateKeyForEdge(edge)!]), runtime: fixtureRuntime(CURRENT) });
      assert.equal(touched.currentPricingForEdge(touched.edges[0]!)?.status, "priced");
      const nextSource = { number: CURRENT.number + 1, hash: `0x${"76".repeat(32)}`,
        generation: CURRENT.generation + 1 };
      const nextReads: string[] = [];
      const untouched = await root.createSession({ source: nextSource, kind: "pricing", fundingAssets: [],
        touchedPools: new Set(), runtime: fixtureRuntime(nextSource, { doubledRate: true,
          onRequest: request => nextReads.push(request.id) }) });
      const untouchedPricing = untouched.currentPricingForEdge(untouched.edges[0]!);
      assert(untouchedPricing?.status === "priced");
      assert.equal(untouchedPricing.mid.mid, startupMid.mid * 2);
      assert.deepEqual(nextReads, ["credit-current-capacity"],
        "time-dependent Credit rates/limits refresh each block even with no touched pools");
      const failed = await root.createSession({ source: CURRENT, fundingAssets: [],
        runtime: fixtureRuntime(CURRENT, { failPricing: true }) });
      assert.equal(failed.currentPricingForEdge(failed.edges[0]!)?.status, "unresolved");
      assert.equal(failed.edges[0]!.canonicalEdgeId, edgeKey);
      assert.equal(failed.creationTiming.failedInstanceCount, 1);
    }
    const exactReads: string[] = [];
    const exactSession = await root.createSession({ source: CURRENT, kind: "exact", fundingAssets: [],
      requiredEdgeIds: new Set([edgeKey]),
      runtime: fixtureRuntime(CURRENT, { onRequest: request => exactReads.push(request.id) }) });
    assert.deepEqual(exactReads, [], "reissuing Exact authority performs no pricing reads");
    const exactEdge = exactSession.edges[0]!;
    assert.deepEqual(exactSession.creditDebtBpsCandidates({ edges: [exactEdge] }),
      priced ? [0n] : [...plugin.credit.risk.debtBpsCandidates],
      "priced Credit reuses effective's ordinary Exact, not a separate debt sizing grid");
    const request = { edge: exactEdge, amountIn: collateral, executor: EXECUTOR, runtimeEvidence: [] };
    const risk = await exactSession.issueExact({ ...request, creditDebtBps: 8_500n });
    assert("debtBps" in risk);
    assert.equal(exactReads.filter(id => id === "credit-exact-operate").length, 1,
      "explicit Credit risk remains simulated");
    const riskExecution = exactSession.buildExecution({ edge: exactEdge, exact: risk,
      minAmountOut: risk.amountOut, executor: EXECUTOR });
    assert.equal(riskExecution.status, "resolved");
    if (priced) {
      for (const amountIn of [collateral, collateral * 2n]) {
        const exact = await exactSession.issueExact({ ...request, amountIn });
        assert.equal("debtBps" in exact, false, "omitted debtBps selects ordinary Exact");
        assert("methodId" in exact);
        assert.equal(exact.methodId, "fluid-credit-local-amount");
        assert.equal(exact.amountQuoteReuse, undefined, "local output is not declared chain-amount evidence");
        assert.equal(exact.reusePolicy, undefined, "time-dependent local state is not cross-block reusable");
        assert(exact.amountOut > risk.amountOut);
        assert.deepEqual(exact.source, CURRENT);
        const execution = exactSession.buildExecution({ edge: exactEdge, exact,
          minAmountOut: exact.amountOut, executor: EXECUTOR });
        assert.equal(execution.status, "resolved");
        assert.throws(() => session.buildExecution({ edge, exact,
          minAmountOut: exact.amountOut, executor: EXECUTOR }), /same session-issued/);
        assert.throws(() => exactSession.buildExecution({ edge: exactEdge, exact: { ...exact },
          minAmountOut: exact.amountOut, executor: EXECUTOR }), /same session-issued/);
        assert.throws(() => exactSession.buildExecution({ edge: exactEdge, exact,
          minAmountOut: exact.amountOut, executor: ORIGIN }), /same session-issued/);
      }
      assert.equal(exactReads.filter(id => id === "credit-exact-operate").length, 1,
        "ordinary local Exact must not fabricate or request an execution simulation receipt");
      const beforeChainRequirement = exactReads.length;
      await assert.rejects(() => exactSession.issueExact({ ...request, requireChainAmountQuote: true }),
        /no declared chain amount quote/);
      assert.equal(exactReads.length, beforeChainRequirement, "chain-only rejection happens before transport");
      const failedExactSession = await root.createSession({ source: CURRENT, kind: "exact", fundingAssets: [],
        runtime: fixtureRuntime(CURRENT, { failOperate: true }) });
      const stillLocal = await failedExactSession.issueExact({ ...request, edge: failedExactSession.edges[0]! });
      assert(stillLocal.amountOut > 0n, "local amount calculation does not require a per-amount operate simulation");
      await assert.rejects(() => failedExactSession.issueExact({ ...request,
        edge: failedExactSession.edges[0]!, creditDebtBps: 8_500n }), /strict exact unresolved/);
      const failedStateSession = await root.createSession({ source: CURRENT, kind: "exact", fundingAssets: [],
        runtime: fixtureRuntime(CURRENT, { failPricing: true }) });
      await assert.rejects(() => failedStateSession.issueExact({ ...request,
        edge: failedStateSession.edges[0]! }), /strict exact unresolved/);
    } else {
      await assert.rejects(() => exactSession.issueExact(request), /pricing and exact/);
    }
    await assert.rejects(() => exactSession.issueExact({ ...request, creditDebtBps: 8_500n,
      requireChainAmountQuote: true }), /no declared chain amount quote/);
    assert.equal(session.edges[0]!.canonicalEdgeId, edgeKey);
  }
  console.log("strict Credit optional pricing/Exact and shadow provenance: PASS");
}

console.log("strict production runtime session contract: PASS");

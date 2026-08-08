import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { univ3Adapter } from "../../adapters/univ3.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolEntry } from "../planner/token-graph.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { v3SwapToState } from "../solver/v3-math.js";
import {
  definedFamilyPluginContractSummary,
  type UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../venues/adapter-request-program.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { generateCapabilityClosure } from "../venues/capability-content-hash.js";
import {
  PANCAKE_V3_SWAP_TOPIC,
  UNIV3_BURN_TOPIC,
  UNIV3_FACTORY_INTERFACE,
  UNIV3_MINT_TOPIC,
  UNIV3_POOL_INTERFACE,
  UNIV3_QUOTER_V2,
  UNIV3_QUOTER_V2_INTERFACE,
  UNIV3_SWAP_TOPIC,
} from "../venues/swaps/univ3-abi.js";
import { univ3StrictFamilyPlugin } from "../venues/swaps/univ3-family-plugin.js";
import {
  UNIV3_POOL_CREATED_PATTERN_ID,
  UNIV3_SWAP_LOG_PATTERN_ID,
} from "../venues/swaps/univ3-family/codec.js";
import type {
  UniV3Candidate,
  UniV3Identity,
  UniV3IdentityEvidence,
} from "../venues/swaps/univ3-family/types.js";
import {
  univ3BlockScanState,
  univ3StandardAdapter,
} from "../venues/swaps/univ3-standard.js";

const FACTORY = ethers.getAddress("0x1F98431c8aD98523631AE4a59f267346ea31F984");
const UNKNOWN_FACTORY = ethers.getAddress(
  "0x9999999999999999999999999999999999999999",
);
const POOL = ethers.getAddress("0x3333333333333333333333333333333333333333");
const FORGED_POOL = ethers.getAddress(
  "0x4444444444444444444444444444444444444444",
);
const TOKEN0 = ethers.getAddress("0x1111111111111111111111111111111111111111");
const TOKEN1 = ethers.getAddress("0x2222222222222222222222222222222222222222");
const SENDER = ethers.getAddress("0x5555555555555555555555555555555555555555");
const EXECUTOR = ethers.getAddress("0x6666666666666666666666666666666666666666");
const OTHER_EXECUTOR = ethers.getAddress(
  "0x7777777777777777777777777777777777777777",
);
const FEE = 500n;
const TICK_SPACING = 1;
const Q96 = 1n << 96n;
const LIQUIDITY = 1_000_000_000_000_000_000n;
const SOURCE: CanonicalSource = Object.freeze({
  number: 22_000_000,
  hash: `0x${"ab".repeat(32)}`,
  generation: 7,
});
const PROVENANCE = Object.freeze({ kind: "fixture", fingerprint: "fixture-v1" });

const poolCreated = UNIV3_FACTORY_INTERFACE.encodeEventLog(
  UNIV3_FACTORY_INTERFACE.getEvent("PoolCreated")!,
  [TOKEN0, TOKEN1, FEE, TICK_SPACING, POOL],
);
const poolCreatedObservation: UnifiedObservation = Object.freeze({
  kind: "log",
  source: SOURCE,
  address: FACTORY,
  topics: Object.freeze(poolCreated.topics),
  data: poolCreated.data,
  transactionHash: `0x${"cd".repeat(32)}`,
});

const candidate = univ3StrictFamilyPlugin.discovery.decodeCandidate({
  observation: poolCreatedObservation,
  matchedPatternId: UNIV3_POOL_CREATED_PATTERN_ID,
});
assert(candidate !== null);
assert.equal(candidate.pool, POOL);
assert.equal(candidate.hintedFactory, FACTORY);
assert.equal(candidate.hintedToken0, TOKEN0);
assert.equal(candidate.hintedToken1, TOKEN1);
assert.equal(candidate.hintedFee, FEE);
assert.equal(candidate.hintedTickSpacing, TICK_SPACING);
assert.equal(
  univ3StrictFamilyPlugin.discovery.candidateKey(candidate),
  POOL.toLowerCase(),
);

const identityVariant = univ3StrictFamilyPlugin.identity.variants[0];
assert.equal(identityVariant.kind, "factory-child");
const identity = runIdentity(candidate, FACTORY, POOL);
assert.equal(identity.subject, POOL);
assert.equal(identity.facts.factoryBinding.reversePool, POOL);
assert.equal(identity.facts.quoterBinding.quoter, UNIV3_QUOTER_V2);

const unknownFactoryCandidate: UniV3Candidate = Object.freeze({
  ...candidate,
  hintedFactory: null,
  hintedToken0: null,
  hintedToken1: null,
  hintedFee: null,
  hintedTickSpacing: null,
});
const unknownFactoryIdentity = runIdentity(
  unknownFactoryCandidate,
  UNKNOWN_FACTORY,
  POOL,
);
assert.equal(
  unknownFactoryIdentity.facts.factoryBinding.factory,
  UNKNOWN_FACTORY,
);
assert.equal(
  unknownFactoryIdentity.facts.quoterBinding.quoter,
  null,
  "unknown reverse-verified factory is admitted without borrowing a foreign quoter",
);
assert.deepEqual(runIdentityDecision(candidate, FACTORY, FORGED_POOL), {
  status: "rejected",
  reason: "factory_reverse_binding_failed",
});
assert.throws(
  () => identityVariant.decode({
    step: { candidate, evidence: undefined, step: 0 },
    results: [{
      id: "pool-factory",
      ok: false,
      source: SOURCE,
      failure: "rpc",
    }],
  }),
  /unresolved: rpc/,
  "identity transport failure remains unresolved rather than negative proof",
);

const descriptorDraft = univ3StrictFamilyPlugin.instance.compileDraft(identity);
const descriptor = univ3StrictFamilyPlugin.instance.finalizeDescriptor({
  identity,
  draft: descriptorDraft,
  sharedBindings: [],
});
const routes = univ3StrictFamilyPlugin.routes.project({ descriptor });
assert.equal(routes.length, 2);
assert.deepEqual(
  routes.map((route) => [route.tokenIn, route.tokenOut, route.direction]),
  [
    [TOKEN0, TOKEN1, "zero-for-one"],
    [TOKEN1, TOKEN0, "one-for-zero"],
  ],
);

const staticProjection = hashCanonical(
  univ3StrictFamilyPlugin.pricing.staticBindingProjection({
    descriptor,
    routes,
  }),
);
assert.notEqual(
  staticProjection,
  hashCanonical(univ3StrictFamilyPlugin.pricing.staticBindingProjection({
    descriptor: { ...descriptor, tickSpacing: TICK_SPACING + 1 },
    routes,
  })),
  "tickSpacing changes invalidate the UniV3 static binding",
);
assert.notEqual(
  staticProjection,
  hashCanonical(univ3StrictFamilyPlugin.pricing.staticBindingProjection({
    descriptor: {
      ...descriptor,
      quoterBinding: { ...descriptor.quoterBinding, quoter: OTHER_EXECUTOR },
    },
    routes,
  })),
  "quoter changes invalidate the UniV3 static binding",
);
assert.notEqual(
  staticProjection,
  hashCanonical(univ3StrictFamilyPlugin.pricing.staticBindingProjection({
    descriptor: {
      ...descriptor,
      fee: FEE + 1n,
      factoryBinding: {
        factory: UNKNOWN_FACTORY,
        reversePool: descriptor.factoryBinding.reversePool,
      },
    },
    routes,
  })),
  "fee and factory changes invalidate the UniV3 static binding",
);
const oneDirectionCompatibility = hashCanonical(
  univ3StrictFamilyPlugin.pricing.snapshotCompatibilityProjection({
    descriptor,
    routes: [routes[0]],
  }),
);
const twoDirectionCompatibility = hashCanonical(
  univ3StrictFamilyPlugin.pricing.snapshotCompatibilityProjection({
    descriptor,
    routes,
  }),
);
assert.notEqual(
  oneDirectionCompatibility,
  twoDirectionCompatibility,
  "UniV3 precision witnesses bind snapshot compatibility to directions",
);

const legacyPool: PoolEntry = {
  address: POOL,
  adapter: "univ3",
  token0: TOKEN0,
  token1: TOKEN1,
  fee: Number(FEE),
  tickSpacing: TICK_SPACING,
  factory: FACTORY,
  score: 9,
};
const legacyEdges = await univ3StandardAdapter.buildEdges(legacyPool, {
  call: async () => {
    throw new Error("fully attested legacy UniV3 edge construction must not read");
  },
});
assert.deepEqual(
  routes.map((route) => ({
    adapterId: "univ3-swap",
    target: route.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    fee: Number(route.fee),
    tickSpacing: route.tickSpacing,
    factory: descriptor.factoryBinding.factory,
  })),
  legacyEdges.map((edge) => ({
    adapterId: edge.adapterId,
    target: edge.target,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    fee: edge.v3Fee,
    tickSpacing: edge.v3TickSpacing,
    factory: edge.factory,
  })),
  "strict route projection preserves legacy canonical UniV3 directions",
);

const pricingDraft = univ3StrictFamilyPlugin.pricing.compileDraft({
  descriptor,
  stateKey: univ3StrictFamilyPlugin.pricing.stateKey(routes[0]),
  routes,
});
const pricingDescriptor =
  univ3StrictFamilyPlugin.pricing.finalizePricingDescriptor({
    draft: pricingDraft,
    sharedBindings: [],
  });
const currentInput = { descriptor: pricingDescriptor, routes, source: SOURCE };
const currentRequests =
  univ3StrictFamilyPlugin.pricing.current.buildRequests(currentInput);
assert.deepEqual(currentRequests.map((request) => request.id), [
  "current-slot0",
  "current-liquidity",
]);
const slot0Data = UNIV3_POOL_INTERFACE.encodeFunctionResult("slot0", [
  2n * Q96,
  0,
  0,
  1,
  1,
  0,
  true,
]);
const liquidityData = UNIV3_POOL_INTERFACE.encodeFunctionResult(
  "liquidity",
  [LIQUIDITY],
);
const currentResults = [
  success("current-slot0", slot0Data),
  success("current-liquidity", liquidityData),
];
const snapshot = univ3StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: currentResults,
  dependentEvidence: [],
});
const strictMids = univ3StrictFamilyPlugin.pricing.current.deriveMids({
  descriptor: pricingDescriptor,
  snapshot,
  routes,
});
assert.equal(strictMids.size, 2);

const controller = new AbortController();
const legacySchemaDraft = univ3BlockScanState.compileStaticSchema({
  edges: legacyEdges,
  deadlineAtMs: Date.now() + 10_000,
  signal: controller.signal,
});
const legacyStaticReads = univ3BlockScanState.buildStaticSchemaReads({
  sourceBlock: SOURCE.number,
  sourceBlockHash: SOURCE.hash,
  schema: legacySchemaDraft,
  edges: legacyEdges,
});
const legacySchema = univ3BlockScanState.hydrateStaticSchema(
  legacySchemaDraft,
  legacyStaticReads.map((read) => legacySuccess(
    read.id,
    UNIV3_FACTORY_INTERFACE.encodeFunctionResult("getPool", [POOL]),
  )),
);
const legacyCurrentReads = univ3BlockScanState.buildCurrentBlockReads({
  sourceBlock: SOURCE.number,
  sourceBlockHash: SOURCE.hash,
  schema: legacySchema,
  edges: legacyEdges,
});
const legacySnapshot = univ3BlockScanState.decodeState(
  legacySchema,
  legacyCurrentReads.map((read) => legacySuccess(
    read.id,
    read.id.startsWith("slot0:") ? slot0Data : liquidityData,
  )),
);
const legacyMids = univ3BlockScanState.deriveMids(
  legacySnapshot,
  legacyEdges,
);
assert.deepEqual(
  [...strictMids.values()].map(midSemantics),
  [...legacyMids.values()].map(midSemantics),
  "strict descriptor-only slot0/liquidity mids preserve legacy semantics",
);

const tinySlot0Data = UNIV3_POOL_INTERFACE.encodeFunctionResult("slot0", [
  Q96,
  0,
  0,
  1,
  1,
  0,
  true,
]);
const tinyLiquidityData = UNIV3_POOL_INTERFACE.encodeFunctionResult(
  "liquidity",
  [35n],
);
const tinyCore = [
  success("current-slot0", tinySlot0Data),
  success("current-liquidity", tinyLiquidityData),
];
const dependentProgram =
  univ3StrictFamilyPlugin.pricing.current.buildDependentProgram!({
    current: currentInput,
    completedRound: 0,
    initialResults: tinyCore,
    priorEvidence: [],
  });
assert(dependentProgram);
const dependentRequests = dependentProgram.requests;
assert.equal(dependentRequests.length, 2);
for (const request of dependentRequests) {
  assert.equal(request.kind, "eth-call");
  if (request.kind !== "eth-call") throw new Error("precision request kind");
  assert.equal(request.to, UNIV3_QUOTER_V2);
  assert.equal(request.completion, "return-or-revert-data");
}
const dependentResults = dependentRequests.map((request, index) =>
  index === 0
    ? success(
        request.id,
        UNIV3_QUOTER_V2_INTERFACE.encodeFunctionResult(
          "quoteExactInputSingle",
          [17n, Q96, 0, 100_000n],
        ),
      )
    : declaredRevert(request.id)
);
const tinySnapshot = univ3StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: tinyCore,
  dependentEvidence: [dependentProgram.decode(dependentResults)],
});
assert.equal(
  univ3StrictFamilyPlugin.pricing.current.deriveMids({
    descriptor: pricingDescriptor,
    snapshot: tinySnapshot,
    routes,
  }).size,
  1,
  "one failed precision direction does not remove its healthy sibling",
);
assert.equal(
  univ3StrictFamilyPlugin.pricing.current.classifyUnavailable!({
    descriptor: pricingDescriptor,
    snapshot: tinySnapshot,
    routes,
  }).size,
  1,
  "inner quoter revert is a route-local behavior-unavailable witness",
);
assert.throws(
  () => univ3StrictFamilyPlugin.pricing.current.decodeSnapshot({
    descriptor: pricingDescriptor,
    initialResults: tinyCore,
    dependentEvidence: [dependentProgram.decode([{
        id: dependentRequests[0].id,
        ok: false,
        source: SOURCE,
        failure: "rpc",
      },
      dependentResults[1],
    ])],
  }),
  /unresolved: rpc/,
  "dependent RPC failure remains unresolved and never becomes unavailable",
);
const zeroSnapshot = univ3StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: [
    success("current-slot0", tinySlot0Data),
    success(
      "current-liquidity",
      UNIV3_POOL_INTERFACE.encodeFunctionResult("liquidity", [0n]),
    ),
  ],
  dependentEvidence: [],
});
assert.equal(
  univ3StrictFamilyPlugin.pricing.current.classifyUnavailable!({
    descriptor: pricingDescriptor,
    snapshot: zeroSnapshot,
    routes,
  }).size,
  2,
  "successful zero-liquidity evidence makes both directions unavailable",
);
assert.throws(
  () => univ3StrictFamilyPlugin.pricing.current.decodeSnapshot({
    descriptor: pricingDescriptor,
    initialResults: [{
      id: "current-slot0",
      ok: false,
      source: SOURCE,
      failure: "rpc",
    }, success("current-liquidity", liquidityData)],
    dependentEvidence: [],
  }),
  /unresolved: rpc/,
  "core RPC failure stays unresolved",
);

const AMOUNT_IN = 1_000_000_000_000n;
const exactInput = {
  descriptor,
  route: routes[0],
  amountIn: AMOUNT_IN,
  source: SOURCE,
  executor: EXECUTOR,
  runtimeEvidence: [],
};
const exactRequestMethod = univ3StrictFamilyPlugin.exact.methods(exactInput)[1];
assert.equal(exactRequestMethod.kind, "request-program");
if (exactRequestMethod.kind !== "request-program") {
  throw new Error("univ3 exact request program missing");
}
assert.deepEqual(
  exactRequestMethod.program.requirements(exactInput),
  { transports: ["eth-call"], caller: "executor" },
);
const exactRequests = exactRequestMethod.program.buildRequests(exactInput);
assert.equal(exactRequests.length, 1);
assert.equal(exactRequests[0].kind, "eth-call");
if (exactRequests[0].kind !== "eth-call") throw new Error("exact request kind");
assert.equal(exactRequests[0].to, UNIV3_QUOTER_V2);
assert.deepEqual(exactRequests[0].caller, { kind: "executor" });
const quoterData = UNIV3_QUOTER_V2_INTERFACE.encodeFunctionResult(
  "quoteExactInputSingle",
  [123_456n, Q96, 2, 100_000n],
);
const strictExact = exactRequestMethod.program.decode({
  programInput: exactInput,
  initialResults: [success(exactRequests[0].id, quoterData)],
  dependentEvidence: [],
});
const legacyExact = await univ3StandardAdapter.quoteExact({
  state: { call: async ({ to, data }: { readonly to: string; readonly data: string }) =>
    legacyExactRead(to, data, quoterData) } as unknown as StateBackend,
  target: POOL,
  edgeAdapterId: "univ3-swap",
  tokenIn: TOKEN0,
  tokenOut: TOKEN1,
  amountIn: AMOUNT_IN,
});
assert.equal(strictExact.amountOut, legacyExact);
assert.equal(strictExact.evidence.caller, EXECUTOR);
assert.notEqual(
  hashCanonical(univ3StrictFamilyPlugin.exact.cacheCompatibilityProjection(
    exactInput,
  )),
  hashCanonical(univ3StrictFamilyPlugin.exact.cacheCompatibilityProjection({
    ...exactInput,
    executor: OTHER_EXECUTOR,
  })),
  "exact cache compatibility is caller-bound",
);
const unknownDescriptorDraft =
  univ3StrictFamilyPlugin.instance.compileDraft(unknownFactoryIdentity);
const unknownDescriptor =
  univ3StrictFamilyPlugin.instance.finalizeDescriptor({
    identity: unknownFactoryIdentity,
    draft: unknownDescriptorDraft,
    sharedBindings: [],
  });
const unknownRoute = univ3StrictFamilyPlugin.routes.project({
  descriptor: unknownDescriptor,
})[0];
assert.throws(
  () => exactRequestMethod.program.buildRequests({
    ...exactInput,
    descriptor: unknownDescriptor,
    route: unknownRoute,
  }),
  /no verified quoter binding/,
  "unknown factory remains admitted but exact quote fails closed",
);
assert.equal(
  univ3StrictFamilyPlugin.swap.replay!.buildOverlay({
    descriptor: unknownDescriptor,
    route: unknownRoute,
    impact: {
      pool: POOL,
      tokenIn: unknownRoute.tokenIn,
      tokenOut: unknownRoute.tokenOut,
      amountIn: AMOUNT_IN,
    },
    source: SOURCE,
    validUntil: 1_800_000_000n,
  }),
  null,
  "unknown factory cannot borrow the canonical router for victim replay",
);

const strictFragment = univ3StrictFamilyPlugin.execution.buildFragment({
  descriptor,
  route: routes[0],
  amountIn: AMOUNT_IN,
  quotedAmountOut: strictExact.amountOut,
  minAmountOut: strictExact.amountOut,
  exactEvidence: strictExact.evidence,
  executor: EXECUTOR,
  runtimeEvidence: [],
});
const legacyFragment = await univ3StandardAdapter.buildPlanFragment({
  edge: legacyEdges[0],
  amountIn: AMOUNT_IN,
  amountOut: strictExact.amountOut,
  executor: EXECUTOR,
  state: {} as StateBackend,
});
assert.deepEqual(strictFragment, legacyFragment);
assert.throws(
  () => univ3StrictFamilyPlugin.execution.buildFragment({
    descriptor,
    route: routes[0],
    amountIn: AMOUNT_IN,
    quotedAmountOut: strictExact.amountOut + 1n,
    minAmountOut: strictExact.amountOut,
    exactEvidence: strictExact.evidence,
    executor: EXECUTOR,
    runtimeEvidence: [],
  }),
  /incompatible exact evidence/,
);
const summary = definedFamilyPluginContractSummary(univ3StrictFamilyPlugin);
assert.deepEqual(summary.ownedActionAdapterIds, ["univ3-swap"]);
const innerScript = new Uint8Array([1, 2, 3]);
assert.deepEqual(
  univ3StrictFamilyPlugin.actionAdapters[0].encode(
    strictFragment.nodes[0],
    EXECUTOR,
    innerScript,
  ),
  univ3Adapter.encode(strictFragment.nodes[0], EXECUTOR, innerScript),
  "strict ownership uses the existing UniV3 action encoder exactly",
);

const swapLog = UNIV3_POOL_INTERFACE.encodeEventLog(
  UNIV3_POOL_INTERFACE.getEvent("Swap")!,
  [SENDER, EXECUTOR, AMOUNT_IN, -strictExact.amountOut, Q96, LIQUIDITY, 0],
);
const swapObservation: UnifiedObservation = Object.freeze({
  kind: "log",
  source: SOURCE,
  address: POOL,
  topics: Object.freeze(swapLog.topics),
  data: swapLog.data,
});
assert.equal(
  univ3StrictFamilyPlugin.swap.landedEvents.classify({
    observation: swapObservation,
  }),
  "swap",
);
const observed = univ3StrictFamilyPlugin.swap.observation.decode({
  observation: swapObservation,
});
assert.equal(observed[0]?.kind, "swap");
assert.equal(
  (observed[0]?.canonicalPayload as { readonly amountIn: bigint }).amountIn,
  AMOUNT_IN,
);
assert.deepEqual(
  patternTopics(univ3StrictFamilyPlugin.swap.landedEvents.patternIds),
  [
    ...univ3StandardAdapter.landedEvents.swaps.map((event) => event.topic),
    ...univ3StandardAdapter.landedEvents.mutations.map((event) => event.topic),
  ].map((topic) => topic!.toLowerCase()).sort(),
  "strict landed swap/mutation surface matches the legacy Family",
);
assert.deepEqual(
  [UNIV3_SWAP_TOPIC, UNIV3_MINT_TOPIC, UNIV3_BURN_TOPIC]
    .every((topic) => patternTopics(
      univ3StrictFamilyPlugin.discovery.logPatterns!.map((pattern) => pattern.id),
    ).includes(topic)),
  true,
);

const victimImpact = {
  pool: POOL,
  tokenIn: TOKEN0,
  tokenOut: TOKEN1,
  amountIn: AMOUNT_IN,
};
const preState = {
  pool: POOL,
  sqrtPriceX96: Q96,
  tick: 0,
  liquidity: LIQUIDITY,
  fee: FEE,
  tickSpacing: TICK_SPACING,
  tickBitmap: [[0, 0n], [-1, 0n]],
  ticks: [],
  observationIndex: 0,
  observationCardinality: 1,
  observationCardinalityNext: 1,
  feeProtocol: 0,
  unlocked: true,
};
const strictVictim = univ3StrictFamilyPlugin.swap.replay!.applyLocal({
  descriptor,
  route: routes[0],
  preState,
  impact: victimImpact,
  source: SOURCE,
});
assert(strictVictim !== null);
const cache = new PoolStateCache();
cache.seedV3Ticks({
  pool: POOL,
  token0: TOKEN0,
  token1: TOKEN1,
  fee: FEE,
  tickSpacing: TICK_SPACING,
  tickBitmap: new Map([[0, 0n], [-1, 0n]]),
  ticks: new Map(),
  blockNumber: SOURCE.number,
});
cache.seedV3Live({
  pool: POOL,
  sqrtPriceX96: Q96,
  tick: 0,
  liquidity: LIQUIDITY,
  observationIndex: 0,
  observationCardinality: 1,
  observationCardinalityNext: 1,
  feeProtocol: 0,
  unlocked: true,
  blockNumber: SOURCE.number,
});
const legacyImpact = {
  ...victimImpact,
  matchedAdapterId: "univ3-swap",
};
const legacyVictim = await univ3StandardAdapter.victimModel.runtime.localApply!
  .apply({
    cache,
    impact: legacyImpact,
    blockNumber: SOURCE.number,
    control: {
      deadlineAtMs: Date.now() + 10_000,
      signal: controller.signal,
    },
  });
assert.deepEqual(strictVictim, legacyVictim, "strict local victim apply matches legacy");
assert.deepEqual(
  strictVictim.amountOut,
  v3SwapToState({
    sqrtPriceX96: Q96,
    tick: 0,
    liquidity: LIQUIDITY,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    tickBitmap: new Map([[0, 0n], [-1, 0n]]),
    ticks: new Map(),
  }, true, AMOUNT_IN).amountOut,
);
const normalizedPostState = {
  sqrtPriceX96: Q96 - 1n,
  tick: -1,
  liquidity: LIQUIDITY,
};
assert.deepEqual(
  univ3StrictFamilyPlugin.swap.replay!.exactPostState!({
    descriptor,
    route: routes[0],
    impact: { ...victimImpact, exactPostState: normalizedPostState },
    source: SOURCE,
  }),
  univ3StandardAdapter.victimModel.runtime.exactPostImpact!({
    ...legacyImpact,
    v3PostState: normalizedPostState,
  }, SOURCE.number),
  "strict exact post-state projection matches legacy",
);
const strictOverlay = univ3StrictFamilyPlugin.swap.replay!.buildOverlay({
  descriptor,
  route: routes[0],
  impact: victimImpact,
  source: SOURCE,
  validUntil: 1_800_000_000n,
});
const legacyOverlay = await univ3StandardAdapter.victimModel.runtime
  .buildOverlay!({
    impact: legacyImpact,
    graph: legacyEdges,
    control: {
      deadlineAtMs: Date.now() + 10_000,
      signal: controller.signal,
    },
    read: async () => UNIV3_POOL_INTERFACE.encodeFunctionResult("fee", [FEE]),
  });
assert.deepEqual(strictOverlay, legacyOverlay, "strict victim overlay matches legacy");

const listenerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const capabilityDirectory = resolve(
  listenerRoot,
  "src/searcher/venues/swaps/univ3-family",
);
const manifestRoot = resolve(capabilityDirectory, "manifest.ts");
const capabilityRoots = {
  discovery: resolve(capabilityDirectory, "discovery.ts"),
  identity: resolve(capabilityDirectory, "identity.ts"),
  instance: resolve(capabilityDirectory, "instance.ts"),
  routes: resolve(capabilityDirectory, "routes.ts"),
  pricing: resolve(capabilityDirectory, "pricing.ts"),
  exact: resolve(capabilityDirectory, "exact.ts"),
  execution: resolve(capabilityDirectory, "execution.ts"),
  victim: resolve(capabilityDirectory, "swap.ts"),
} as const;
assert.equal(new Set(Object.values(capabilityRoots)).size, 8);
const generatedCapabilities = await Promise.all(
  Object.entries(capabilityRoots).map(async ([capability, entryFile]) =>
    generateCapabilityClosure({
      familyId: univ3StrictFamilyPlugin.manifest.familyId,
      capability: capability as keyof typeof capabilityRoots,
      rootDirectory: listenerRoot,
      entryFile,
      additionalEntryFiles: [
        manifestRoot,
        ...(capability === "execution"
          ? [resolve(capabilityDirectory, "action.ts")]
          : []),
      ],
      provenanceCommit: null,
    })
  ),
);
assert.equal(
  new Set(generatedCapabilities.map((entry) => entry.entryLogicalId)).size,
  8,
  "each strict UniV3 capability exposes a distinct content-hash root",
);
for (const closure of generatedCapabilities) {
  assert(
    closure.identity.semanticDependencies.every((dependency) =>
      !dependency.endsWith("swaps/univ3-standard.ts")
    ),
    `${closure.identity.capability} must not hash the legacy whole Family`,
  );
}
assert(
  generatedCapabilities.find((entry) =>
    entry.identity.capability === "victim"
  )!.identity.semanticDependencies.some((dependency) =>
    dependency.endsWith("solver/v3-math.ts")
  ),
  "victim capability hash includes the shared bit-exact V3 math",
);
assert(
  generatedCapabilities.find((entry) =>
    entry.identity.capability === "execution"
  )!.identity.semanticDependencies.some((dependency) =>
    dependency.endsWith("adapters/univ3.ts")
  ),
  "execution capability hash includes the owned UniV3 ActionAdapter",
);

console.log(
  "univ3-family-plugin PASS " +
    "(strict eight-capability parity, reverse identity, precision, victim, ownership)",
);

function runIdentity(
  candidateInput: UniV3Candidate,
  factory: string,
  reversePool: string,
): UniV3Identity {
  const decision = runIdentityDecision(candidateInput, factory, reversePool);
  assert.equal(decision.status, "verified");
  return decision.identity;
}

function runIdentityDecision(
  candidateInput: UniV3Candidate,
  factory: string,
  reversePool: string,
): ReturnType<typeof identityVariant.decide> {
  const initial = { candidate: candidateInput, evidence: undefined, step: 0 };
  assert.deepEqual(identityVariant.decide(initial), { status: "continue" });
  const staticEvidence = identityVariant.decode({
    step: initial,
    results: [
      success(
        "pool-factory",
        UNIV3_POOL_INTERFACE.encodeFunctionResult("factory", [factory]),
      ),
      success(
        "pool-token0",
        UNIV3_POOL_INTERFACE.encodeFunctionResult("token0", [TOKEN0]),
      ),
      success(
        "pool-token1",
        UNIV3_POOL_INTERFACE.encodeFunctionResult("token1", [TOKEN1]),
      ),
      success(
        "pool-fee",
        UNIV3_POOL_INTERFACE.encodeFunctionResult("fee", [FEE]),
      ),
      success(
        "pool-tick-spacing",
        UNIV3_POOL_INTERFACE.encodeFunctionResult("tickSpacing", [TICK_SPACING]),
      ),
    ],
  }) as UniV3IdentityEvidence;
  const reverseStep = {
    candidate: candidateInput,
    evidence: staticEvidence,
    step: 1,
  };
  const requests = identityVariant.buildRequests(reverseStep);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, "eth-call");
  if (requests[0].kind !== "eth-call") throw new Error("reverse request kind");
  assert.equal(requests[0].to, factory);
  const reverseEvidence = identityVariant.decode({
    step: reverseStep,
    results: [success(
      "factory-get-pool",
      UNIV3_FACTORY_INTERFACE.encodeFunctionResult("getPool", [reversePool]),
    )],
  }) as UniV3IdentityEvidence;
  return identityVariant.decide({
    candidate: candidateInput,
    evidence: reverseEvidence,
    step: 2,
  });
}

function success(id: string, data: string): AdapterRequestResult {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: PROVENANCE,
    completion: "returned" as const,
    data,
  });
}

function legacySuccess(id: string, data: string) {
  return Object.freeze({
    id,
    ok: true as const,
    sourceBlock: SOURCE.number,
    sourceBlockHash: SOURCE.hash,
    provenance: {
      kind: "eip1898" as const,
      source: SOURCE,
      requireCanonical: true as const,
    },
    data,
  });
}

function declaredRevert(id: string): AdapterRequestResult {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: PROVENANCE,
    completion: "reverted-as-declared" as const,
    data: "0x",
  });
}

function legacyExactRead(to: string, data: string, quote: string): string {
  const target = ethers.getAddress(to);
  const selector = data.slice(0, 10).toLowerCase();
  if (target === POOL) {
    if (selector === UNIV3_POOL_INTERFACE.getFunction("factory")!.selector) {
      return UNIV3_POOL_INTERFACE.encodeFunctionResult("factory", [FACTORY]);
    }
    if (selector === UNIV3_POOL_INTERFACE.getFunction("token0")!.selector) {
      return UNIV3_POOL_INTERFACE.encodeFunctionResult("token0", [TOKEN0]);
    }
    if (selector === UNIV3_POOL_INTERFACE.getFunction("token1")!.selector) {
      return UNIV3_POOL_INTERFACE.encodeFunctionResult("token1", [TOKEN1]);
    }
    if (selector === UNIV3_POOL_INTERFACE.getFunction("fee")!.selector) {
      return UNIV3_POOL_INTERFACE.encodeFunctionResult("fee", [FEE]);
    }
  }
  if (
    target === FACTORY &&
    selector === UNIV3_FACTORY_INTERFACE.getFunction("getPool")!.selector
  ) {
    return UNIV3_FACTORY_INTERFACE.encodeFunctionResult("getPool", [POOL]);
  }
  if (
    target === UNIV3_QUOTER_V2 &&
    selector === UNIV3_QUOTER_V2_INTERFACE.getFunction(
      "quoteExactInputSingle",
    )!.selector
  ) {
    return quote;
  }
  throw new Error(`unexpected legacy UniV3 read ${target}:${selector}`);
}

function midSemantics(mid: {
  readonly kind: string;
  readonly pool: string;
  readonly mid: number;
  readonly feeBps: number;
  readonly reserveA?: bigint;
  readonly reserveB?: bigint;
  readonly sqrtABX96?: bigint;
  readonly liquidity?: bigint;
}) {
  return {
    kind: mid.kind,
    pool: mid.pool,
    mid: mid.mid,
    feeBps: mid.feeBps,
    reserveA: mid.reserveA,
    reserveB: mid.reserveB,
    sqrtABX96: mid.sqrtABX96,
    liquidity: mid.liquidity,
  };
}

function patternTopics(patternIds: readonly string[]): string[] {
  const patterns = univ3StrictFamilyPlugin.discovery.logPatterns ?? [];
  return patternIds.map((id) => {
    const pattern = patterns.find((candidate) => candidate.id === id);
    if (pattern === undefined) throw new Error(`missing UniV3 log pattern ${id}`);
    return pattern.topic.toLowerCase();
  }).sort();
}

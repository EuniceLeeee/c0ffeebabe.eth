import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { univ2Adapter } from "../../adapters/univ2.js";
import type { PoolEntry } from "../planner/token-graph.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type {
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "../adapter-work-intent.js";
import { createBoundedRequestExecutor } from
  "../venues/adapter-request-program.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import {
  quoteV2ExactInput as quoteV2ExactInputPure,
} from "../solver/v2-constant-product-math.js";
import {
  quoteV2ExactInput as quoteV2ExactInputLegacyExport,
} from "../solver/v2-fee.js";
import {
  definedFamilyPluginContractSummary,
  type UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import {
  executeAdapterFamilyLifecycle,
  executeFamilyVictimReplay,
} from "../venues/adapter-family-runtime.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
} from "../venues/adapter-request-program.js";
import type { VictimOverlay } from "../venues/victim-runtime-capability.js";
import { hashCanonical } from "../venues/canonical-value.js";
import {
  FAMILY_CAPABILITY_CONTRACT_VERSIONS,
  generateCapabilityClosure,
} from "../venues/capability-content-hash.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITIES_BY_DOMAIN,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  type GeneratedCapabilityIdentity,
  type LoadedFamilyPlugin,
} from "../venues/family-capability-catalog.js";
import { univ2StrictFamilyPlugin } from "../venues/swaps/univ2-family-plugin.js";
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_PATTERN_ID,
  UNIV2_PAIR_INTERFACE,
  UNIV2_SWAP_LOG_PATTERN_ID,
  UNIV2_SWAP_TOPIC,
  UNIV2_SYNC_LOG_PATTERN_ID,
} from "../venues/swaps/univ2-family/codec.js";
import type {
  UniV2Candidate,
  UniV2Identity,
  UniV2IdentityEvidence,
} from "../venues/swaps/univ2-family/types.js";
import { UNIV2_ROUTER } from "../venues/swaps/univ2-family/victim.js";
import {
  univ2BlockScanState,
  univ2StandardAdapter,
} from "../venues/swaps/univ2-standard.js";

const FACTORY = ethers.getAddress("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f");
const UNKNOWN_FACTORY = ethers.getAddress("0x9999999999999999999999999999999999999999");
const POOL = ethers.getAddress("0x3333333333333333333333333333333333333333");
const FORGED_POOL = ethers.getAddress("0x4444444444444444444444444444444444444444");
const TOKEN0 = ethers.getAddress("0x1111111111111111111111111111111111111111");
const TOKEN1 = ethers.getAddress("0x2222222222222222222222222222222222222222");
const SENDER = ethers.getAddress("0x5555555555555555555555555555555555555555");
const EXECUTOR = ethers.getAddress("0x6666666666666666666666666666666666666666");
const RESERVE0 = 8_000_000_000_000_000_000n;
const RESERVE1 = 16_000_000_000n;
const TIMESTAMP = 1_789_000_000;
const SOURCE: CanonicalSource = Object.freeze({
  number: 22_000_000,
  hash: `0x${"ab".repeat(32)}`,
  generation: 7,
});
const PROVENANCE = Object.freeze({ kind: "fixture", fingerprint: "fixture-v1" });

assert.equal(
  quoteV2ExactInputLegacyExport,
  quoteV2ExactInputPure,
  "legacy and strict V2 paths must share one pure math implementation",
);
for (const vector of [
  [1n, 1n, 1n, 30n],
  [1_000n, 2_000n, 1n, 30n],
  [1_000n, 2_000n, 999n, 25n],
  [RESERVE0, RESERVE1, 1_000_000_000_000_000n, 30n],
  [RESERVE1, RESERVE0, 7_777_777n, 30n],
] as const) {
  const [reserveIn, reserveOut, amountIn, feeBps] = vector;
  assert.equal(
    quoteV2ExactInputLegacyExport(reserveIn, reserveOut, amountIn, feeBps),
    quoteV2ExactInputPure(reserveIn, reserveOut, amountIn, feeBps),
    `V2 integer rounding parity for ${vector.join("/")}`,
  );
}

const pairCreated = UNIV2_FACTORY_INTERFACE.encodeEventLog(
  UNIV2_FACTORY_INTERFACE.getEvent("PairCreated")!,
  [TOKEN0, TOKEN1, POOL, 1n],
);
const pairCreatedObservation: UnifiedObservation = Object.freeze({
  kind: "log",
  source: SOURCE,
  address: FACTORY,
  topics: Object.freeze(pairCreated.topics),
  data: pairCreated.data,
  transactionHash: `0x${"cd".repeat(32)}`,
});

const candidate = univ2StrictFamilyPlugin.discovery.decodeCandidate({
  observation: pairCreatedObservation,
  matchedPatternId: UNIV2_PAIR_CREATED_PATTERN_ID,
});
assert(candidate !== null);
assert.equal(candidate.pool, POOL);
assert.equal(candidate.hintedFactory, FACTORY);
assert.equal(candidate.hintedToken0, TOKEN0);
assert.equal(candidate.hintedToken1, TOKEN1);
assert.equal(
  univ2StrictFamilyPlugin.discovery.candidateKey(candidate),
  POOL.toLowerCase(),
);

const identityVariant = univ2StrictFamilyPlugin.identity.variants[0];
assert.equal(identityVariant.kind, "factory-child");
const identity = runIdentity(candidate, FACTORY, POOL);
assert.equal(identity.subject, POOL);
assert.equal(identity.facts.factoryBinding.reversePool, POOL);
assert.equal(identity.facts.feeRule.feeBps, 30n);

const unknownFactoryCandidate: UniV2Candidate = Object.freeze({
  ...candidate,
  hintedFactory: UNKNOWN_FACTORY,
});
const unknownFactoryIdentity = runIdentity(
  unknownFactoryCandidate,
  UNKNOWN_FACTORY,
  POOL,
);
assert.equal(unknownFactoryIdentity.facts.factoryBinding.factory, UNKNOWN_FACTORY);
assert.equal(
  unknownFactoryIdentity.facts.feeRule.evidence,
  "standard-v2-default",
  "unknown reverse-verified factories are not rejected by an address allowlist",
);

const forgedDecision = runIdentityDecision(candidate, FACTORY, FORGED_POOL);
assert.deepEqual(forgedDecision, {
  status: "rejected",
  reason: "factory_reverse_binding_failed",
});

const descriptorDraft = univ2StrictFamilyPlugin.instance.compileDraft(identity);
const descriptor = univ2StrictFamilyPlugin.instance.finalizeDescriptor({
  identity,
  draft: descriptorDraft,
  sharedBindings: [],
});
assert(Object.isFrozen(descriptor));
assert.equal(descriptor.pool, POOL);

const routes = univ2StrictFamilyPlugin.routes.project({ descriptor });
assert.equal(routes.length, 2);
assert.deepEqual(
  routes.map((route) => [route.tokenIn, route.tokenOut, route.direction]),
  [
    [TOKEN0, TOKEN1, "zero-for-one"],
    [TOKEN1, TOKEN0, "one-for-zero"],
  ],
);
assert.equal(routes[0].bindingRef.fingerprint, routes[1].bindingRef.fingerprint);

const reservesData = UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [
  RESERVE0,
  RESERVE1,
  TIMESTAMP,
]);
const legacyPool: PoolEntry = {
  address: POOL,
  adapter: "univ2",
  token0: TOKEN0,
  token1: TOKEN1,
  factory: FACTORY,
  score: 9,
};
const legacyEdges = await univ2StandardAdapter.buildEdges(
  legacyPool,
  {
    call: async ({ data }) => {
      assert.equal(data, UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves"));
      return reservesData;
    },
  },
);
assert.deepEqual(
  routes.map((route) => ({
    adapterId: "univ2-swap",
    target: route.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: route.taxonomy.slotKind,
    feeBps: route.feeBps,
  })),
  legacyEdges.map((edge) => ({
    adapterId: edge.adapterId,
    target: edge.target,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    slotKind: edge.slotKind,
    feeBps: edge.v2FeeBps,
  })),
  "strict route projection preserves legacy canonical directions and fee semantics",
);

const pricingDraft = univ2StrictFamilyPlugin.pricing.compileDraft({
  descriptor,
  stateKey: univ2StrictFamilyPlugin.pricing.stateKey(routes[0]),
  routes,
});
const pricingDescriptor =
  univ2StrictFamilyPlugin.pricing.finalizePricingDescriptor({
    draft: pricingDraft,
    sharedBindings: [],
  });
const currentInput = { descriptor: pricingDescriptor, routes, source: SOURCE };
assert.deepEqual(
  univ2StrictFamilyPlugin.pricing.current.requirements(currentInput),
  { transports: ["eth-call"] },
);
const currentRequests =
  univ2StrictFamilyPlugin.pricing.current.buildRequests(currentInput);
assert.equal(currentRequests.length, 1);
assert.equal(currentRequests[0].kind, "eth-call");
if (currentRequests[0].kind !== "eth-call") {
  throw new Error("univ2 current request must be eth-call");
}
assert.equal(currentRequests[0].to, POOL);
const currentResults = [success(currentRequests[0].id, reservesData)];
const snapshot = univ2StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: currentResults,
  dependentEvidence: [],
});
const strictMids = univ2StrictFamilyPlugin.pricing.current.deriveMids({
  descriptor: pricingDescriptor,
  snapshot,
  routes,
});

const controller = new AbortController();
const legacySchema = univ2BlockScanState.compileStaticSchema({
  edges: legacyEdges,
  deadlineAtMs: Date.now() + 10_000,
  signal: controller.signal,
});
const legacyReads = univ2BlockScanState.buildCurrentBlockReads({
  schema: legacySchema,
  sourceBlock: SOURCE.number,
  sourceBlockHash: SOURCE.hash,
  edges: legacyEdges,
});
const legacySnapshot = univ2BlockScanState.decodeState(legacySchema, [{
  id: legacyReads[0].id,
  ok: true,
  sourceBlock: SOURCE.number,
  sourceBlockHash: SOURCE.hash,
  provenance: {
    kind: "eip1898",
    source: SOURCE,
    requireCanonical: true,
  },
  data: reservesData,
}]);
const legacyMids = univ2BlockScanState.deriveMids(legacySnapshot, legacyEdges);
assert.deepEqual(
  [...strictMids.values()].map(midSemantics),
  [...legacyMids.values()].map(midSemantics),
  "strict descriptor-only pricing preserves legacy reserve mids",
);

const compatibilityForward = hashCanonical(
  univ2StrictFamilyPlugin.pricing.snapshotCompatibilityProjection({
    descriptor,
    routes: [routes[0]],
  }),
);
const compatibilityBidirectional = hashCanonical(
  univ2StrictFamilyPlugin.pricing.snapshotCompatibilityProjection({
    descriptor,
    routes,
  }),
);
assert.equal(
  compatibilityForward,
  compatibilityBidirectional,
  "adding the reverse direction must preserve raw reserves compatibility",
);
const staticProjection = hashCanonical(
  univ2StrictFamilyPlugin.pricing.staticBindingProjection({
    descriptor,
    routes,
  }),
);
const changedFeeDescriptor = {
  ...descriptor,
  feeRule: { ...descriptor.feeRule, feeBps: 31n },
};
assert.notEqual(
  staticProjection,
  hashCanonical(univ2StrictFamilyPlugin.pricing.staticBindingProjection({
    descriptor: changedFeeDescriptor,
    routes,
  })),
  "fee-rule changes must invalidate the immutable static binding",
);

const zeroData = UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [
  0n,
  RESERVE1,
  TIMESTAMP,
]);
const zeroSnapshot = univ2StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: [success(currentRequests[0].id, zeroData)],
  dependentEvidence: [],
});
assert.equal(
  univ2StrictFamilyPlugin.pricing.current.deriveMids({
    descriptor: pricingDescriptor,
    snapshot: zeroSnapshot,
    routes,
  }).size,
  0,
);
assert.equal(
  univ2StrictFamilyPlugin.pricing.current.classifyUnavailable!({
    descriptor: pricingDescriptor,
    snapshot: zeroSnapshot,
    routes,
  }).size,
  2,
  "successful zero-reserve evidence makes both directions unavailable",
);
assert.throws(
  () => univ2StrictFamilyPlugin.pricing.current.decodeSnapshot({
    descriptor: pricingDescriptor,
    initialResults: [{
      id: currentRequests[0].id,
      ok: false,
      source: SOURCE,
      failure: "rpc",
    }],
    dependentEvidence: [],
  }),
  /unresolved: rpc/,
  "RPC failure stays unresolved and cannot become behavior-unavailable",
);

const AMOUNT_IN = 1_000_000_000_000_000n;
const exactInput = {
  descriptor,
  route: routes[0],
  amountIn: AMOUNT_IN,
  source: SOURCE,
  executor: EXECUTOR,
  runtimeEvidence: [],
};
const exactMethods = univ2StrictFamilyPlugin.exact.methods(exactInput);
const exactRequestMethod = exactMethods[1];
assert.equal(exactRequestMethod.kind, "request-program");
if (exactRequestMethod.kind !== "request-program") {
  throw new Error("univ2 exact remote method is missing");
}
const exactRequests = exactRequestMethod.program.buildRequests(exactInput);
assert.equal(exactRequests.length, 1);
const strictExact = exactRequestMethod.program.decode({
  programInput: exactInput,
  initialResults: [success(exactRequests[0].id, reservesData)],
  dependentEvidence: [],
});
const zeroExactInput = Object.freeze({ ...exactInput, amountIn: 0n });
assert.deepEqual(
  exactRequestMethod.program.buildRequests(zeroExactInput),
  [],
);
const zeroLocalMethod = univ2StrictFamilyPlugin.exact.methods(zeroExactInput)[0];
assert.equal(zeroLocalMethod.kind, "local");
if (zeroLocalMethod.kind !== "local") throw new Error("missing local zero method");
const zeroAttempt = zeroLocalMethod.quote(zeroExactInput);
assert.equal(
  zeroAttempt.status === "quoted" ? zeroAttempt.result.amountOut : null,
  0n,
  "zero-input exact is an explicit local quote, not an ambiguous empty program",
);
const legacyExact = await univ2StandardAdapter.quoteExact({
  state: {
    call: async ({ data }: { readonly data: string }) => {
      if (data === UNIV2_PAIR_INTERFACE.encodeFunctionData("token0")) {
        return UNIV2_PAIR_INTERFACE.encodeFunctionResult("token0", [TOKEN0]);
      }
      if (data === UNIV2_PAIR_INTERFACE.encodeFunctionData("factory")) {
        return UNIV2_PAIR_INTERFACE.encodeFunctionResult("factory", [FACTORY]);
      }
      if (data === UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves")) {
        return reservesData;
      }
      throw new Error(`unexpected legacy exact call ${data}`);
    },
  } as unknown as StateBackend,
  target: POOL,
  edgeAdapterId: "univ2-swap",
  tokenIn: TOKEN0,
  tokenOut: TOKEN1,
  amountIn: AMOUNT_IN,
});
assert.equal(strictExact.amountOut, legacyExact);
assert.equal(strictExact.evidence.pool, POOL);
assert.equal(
  await univ2StandardAdapter.quoteExact({
    state: {
      call: async () => {
        throw new Error("legacy zero-input quote must not read state");
      },
    } as unknown as StateBackend,
    target: POOL,
    edgeAdapterId: "univ2-swap",
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    amountIn: 0n,
  }),
  0n,
);

const strictFragment = univ2StrictFamilyPlugin.execution.buildFragment({
  descriptor,
  route: routes[0],
  amountIn: AMOUNT_IN,
  quotedAmountOut: strictExact.amountOut,
  minAmountOut: strictExact.amountOut,
  exactEvidence: strictExact.evidence,
  executor: EXECUTOR,
  runtimeEvidence: [],
});
const legacyFragment = await univ2StandardAdapter.buildPlanFragment({
  edge: legacyEdges[0],
  amountIn: AMOUNT_IN,
  amountOut: strictExact.amountOut,
  executor: EXECUTOR,
  state: {} as StateBackend,
});
assert.deepEqual(strictFragment, legacyFragment);
assert.equal(strictFragment.nodes[0].adapterId, "univ2-swap");
assert.equal(strictFragment.nodes[0].children[0].adapterId, "erc20-transfer");
assert.throws(
  () => univ2StrictFamilyPlugin.execution.buildFragment({
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

const summary = definedFamilyPluginContractSummary(univ2StrictFamilyPlugin);
assert.deepEqual(summary.ownedActionAdapterIds, ["univ2-swap"]);
assert.deepEqual(summary.requiredInfraActionAdapterIds, ["erc20-transfer"]);
assert.equal(univ2StrictFamilyPlugin.actionAdapters[0].descriptor.edgeKind, "swap");
const innerScript = new Uint8Array([1, 2, 3]);
assert.deepEqual(
  univ2StrictFamilyPlugin.actionAdapters[0].encode(
    strictFragment.nodes[0],
    EXECUTOR,
    innerScript,
  ),
  univ2Adapter.encode(strictFragment.nodes[0], EXECUTOR, innerScript),
  "strict Family ownership reuses the legacy action encoder exactly",
);

const swapLog = UNIV2_PAIR_INTERFACE.encodeEventLog(
  UNIV2_PAIR_INTERFACE.getEvent("Swap")!,
  [SENDER, AMOUNT_IN, 0n, 0n, strictExact.amountOut, EXECUTOR],
);
const swapObservation: UnifiedObservation = Object.freeze({
  kind: "log",
  source: SOURCE,
  address: POOL,
  topics: Object.freeze(swapLog.topics),
  data: swapLog.data,
});
assert.equal(
  univ2StrictFamilyPlugin.swap.landedEvents.classify({
    observation: swapObservation,
  }),
  "swap",
);
assert.equal(
  univ2StrictFamilyPlugin.swap.observation.decode({
    observation: swapObservation,
  })[0]?.kind,
  "swap",
);
assert.equal(univ2StrictFamilyPlugin.swap.victimSupport, "replay");
assert(univ2StrictFamilyPlugin.swap.replay !== undefined);
const syncLog = UNIV2_PAIR_INTERFACE.encodeEventLog(
  UNIV2_PAIR_INTERFACE.getEvent("Sync")!,
  [RESERVE0, RESERVE1],
);
assert.equal(
  univ2StrictFamilyPlugin.swap.landedEvents.classify({
    observation: {
      kind: "log",
      source: SOURCE,
      address: POOL,
      topics: syncLog.topics,
      data: syncLog.data,
    },
  }),
  "mutation",
);
assert.equal(UNIV2_SWAP_TOPIC.toLowerCase(), swapLog.topics[0].toLowerCase());
assert.deepEqual(
  univ2StrictFamilyPlugin.swap.landedEvents.patternIds,
  [UNIV2_SWAP_LOG_PATTERN_ID, UNIV2_SYNC_LOG_PATTERN_ID],
);

const listenerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const capabilityDirectory = resolve(
  listenerRoot,
  "src/searcher/venues/swaps/univ2-family",
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
} as const;
assert.equal(new Set(Object.values(capabilityRoots)).size, 7);
const generatedCapabilities = await Promise.all(
  Object.entries(capabilityRoots).map(async ([capability, entryFile]) =>
    generateCapabilityClosure({
      familyId: univ2StrictFamilyPlugin.manifest.familyId,
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
  7,
  "each strict capability must expose a distinct generated-hash root",
);
const exactClosure = generatedCapabilities.find(
  (entry) => entry.identity.capability === "exact",
)!;
assert(
  exactClosure.identity.semanticDependencies.some((dependency) =>
    dependency.endsWith("solver/v2-constant-product-math.ts")
  ),
  "exact capability hash must include the shared constant-product math",
);
assert(
  exactClosure.identity.semanticDependencies.every((dependency) =>
    !dependency.endsWith("venues/v2-lineage.ts") &&
    dependency !== "runtime:node:fs@node-es2022-v1"
  ),
  "strict exact capability closure must not inherit lineage file I/O",
);
const executionClosure = generatedCapabilities.find(
  (entry) => entry.identity.capability === "execution",
)!;
assert(
  executionClosure.identity.semanticDependencies.some((dependency) =>
    dependency.endsWith("adapters/univ2.ts")
  ),
  "execution capability hash must include the owned action implementation",
);
const victimClosure = await generateCapabilityClosure({
  familyId: univ2StrictFamilyPlugin.manifest.familyId,
  capability: "victim",
  rootDirectory: listenerRoot,
  entryFile: resolve(capabilityDirectory, "victim.ts"),
  additionalEntryFiles: [
    manifestRoot,
    resolve(capabilityDirectory, "swap.ts"),
  ],
  provenanceCommit: null,
});
assert.equal(
  victimClosure.identity.contractVersion,
  "s1-victim-v2",
  "full replay semantics require the v2 victim contract",
);
assert.equal(
  victimClosure.identity.contractVersion,
  FAMILY_CAPABILITY_CONTRACT_VERSIONS.victim,
);
assert.equal(
  victimClosure.entryLogicalId,
  "src/searcher/venues/swaps/univ2-family/victim.ts",
  "victim capability hash must bind the direct UniV2 replay root",
);

const loadedStrictFamily = loadedFamily();
const strictLifecycle = await executeAdapterFamilyLifecycle({
  family: loadedStrictFamily,
  match: {
    observation: pairCreatedObservation,
    matchedPatternId: UNIV2_PAIR_CREATED_PATTERN_ID,
  },
  source: SOURCE,
  generation: SOURCE.generation,
  runtime: lifecycleFixtureRuntime(),
  publisher: { publish() {} },
});
assert(strictLifecycle.publication !== null);
const preparedStrictInstance = strictLifecycle.publication.instances[0];
assert(preparedStrictInstance !== undefined);
const strictVictimRoute = preparedStrictInstance.routeHandles.find(
  (handle) => handle.routeKey === routes[0].routeKey,
);
assert(strictVictimRoute !== undefined);
const noIoRuntime = fixtureRuntime();
const strictVictimImpact = Object.freeze({
  pool: POOL,
  tokenIn: TOKEN0,
  tokenOut: TOKEN1,
  amountIn: AMOUNT_IN,
  amountOut: strictExact.amountOut,
  exactPostState: Object.freeze({
    reserve0: RESERVE0 + AMOUNT_IN,
    reserve1: RESERVE1 - strictExact.amountOut,
    feeBps: 30n,
    blockTimestampLast: TIMESTAMP,
  }),
});
const preVictimState = Object.freeze({
  kind: "v2",
  pool: POOL,
  token0: TOKEN0,
  token1: TOKEN1,
  reserve0: RESERVE0,
  reserve1: RESERVE1,
  feeBps: 30n,
  blockTimestampLast: TIMESTAMP,
  blockNumber: SOURCE.number,
});
const VALID_UNTIL = 1_700_003_600n;
const strictVictim = executeFamilyVictimReplay({
  family: loadedStrictFamily,
  route: strictVictimRoute,
  impact: strictVictimImpact,
  preState: preVictimState,
  validUntil: VALID_UNTIL,
  source: SOURCE,
  generation: SOURCE.generation,
  runtime: noIoRuntime,
});
assert.equal(strictVictim.status, "resolved");
if (strictVictim.status !== "resolved") {
  throw new Error("strict UniV2 victim replay did not resolve");
}
assert(strictVictim.localApply !== null);
assert(strictVictim.exactPostState !== null);
assert(strictVictim.overlay !== null);

const legacyVictimRuntime = univ2StandardAdapter.victimModel.runtime;
const legacyCache = new PoolStateCache();
legacyCache.seedV2({
  pool: POOL,
  token0: TOKEN0,
  token1: TOKEN1,
  reserve0: RESERVE0,
  reserve1: RESERVE1,
  feeBps: 30n,
  blockTimestampLast: TIMESTAMP,
  blockNumber: SOURCE.number,
});
const legacyImpact = Object.freeze({
  pool: POOL,
  tokenIn: TOKEN0,
  tokenOut: TOKEN1,
  amountIn: AMOUNT_IN,
  amountOut: strictExact.amountOut,
  matchedAdapterId: "univ2-swap",
  poolToken0: TOKEN0,
  poolToken1: TOKEN1,
  v2PostState: Object.freeze({
    reserve0: RESERVE0 + AMOUNT_IN,
    reserve1: RESERVE1 - strictExact.amountOut,
    feeBps: 30n,
    blockTimestampLast: TIMESTAMP,
  }),
});
const control = Object.freeze({
  deadlineAtMs: Number.MAX_SAFE_INTEGER,
  signal: new AbortController().signal,
});
const legacyLocal = await legacyVictimRuntime.localApply!.apply({
  cache: legacyCache,
  impact: legacyImpact,
  blockNumber: SOURCE.number,
  control,
});
assert.deepEqual(strictVictim.localApply, legacyLocal);
const legacyExactPost = await legacyVictimRuntime.exactPostImpact!(
  legacyImpact,
  SOURCE.number,
);
assert.deepEqual(strictVictim.exactPostState, legacyExactPost);

const savedNow = Date.now;
let legacyOverlay: VictimOverlay | undefined;
try {
  Date.now = () => 1_700_000_000_000;
  legacyOverlay = await legacyVictimRuntime.buildOverlay!({
    impact: legacyImpact,
    graph: [],
    control,
    read: async () => {
      throw new Error("UniV2 overlay must not read state");
    },
  });
} finally {
  Date.now = savedNow;
}
assert(legacyOverlay !== undefined);
assert.equal(
  strictVictim.overlay.preCalls[1].calldata,
  legacyOverlay.preCalls[1].calldata,
  "strict and legacy replay must encode identical victim calldata",
);
assert.equal(
  strictVictim.overlay.preCalls[1].to,
  UNIV2_ROUTER.toLowerCase(),
);
const reboundWithDifferentClock = executeFamilyVictimReplay({
  family: loadedStrictFamily,
  route: strictVictimRoute,
  impact: strictVictimImpact,
  preState: preVictimState,
  validUntil: VALID_UNTIL,
  source: SOURCE,
  generation: SOURCE.generation,
  runtime: noIoRuntime,
});
assert.equal(reboundWithDifferentClock.status, "resolved");
if (reboundWithDifferentClock.status === "resolved") {
  assert.equal(
    reboundWithDifferentClock.overlay?.preCalls[1].calldata,
    strictVictim.overlay.preCalls[1].calldata,
    "central validUntil, not ambient time, determines strict replay bytes",
  );
}
const foreignVictim = executeFamilyVictimReplay({
  family: loadedStrictFamily,
  route: strictVictimRoute,
  impact: { ...strictVictimImpact, pool: FORGED_POOL },
  preState: preVictimState,
  validUntil: VALID_UNTIL,
  source: SOURCE,
  generation: SOURCE.generation,
  runtime: noIoRuntime,
});
assert.equal(foreignVictim.status, "rejected");
assert.equal(foreignVictim.outcome.reasonCode, "victim-impact-not-bound");

let siblingVictimDerivationTouched = false;
const siblingVictim = executeFamilyVictimReplay({
  family: loadedStrictFamily,
  route: strictVictimRoute,
  impact: Object.freeze({
    pool: POOL,
    tokenIn: TOKEN1,
    tokenOut: TOKEN0,
    amountIn: AMOUNT_IN,
  }),
  preState: Object.defineProperty({}, "poison", {
    enumerable: true,
    get() {
      siblingVictimDerivationTouched = true;
      throw new Error("sibling route mismatch reached victim derivation");
    },
  }) as unknown as typeof preVictimState,
  validUntil: VALID_UNTIL,
  source: SOURCE,
  generation: SOURCE.generation,
  runtime: noIoRuntime,
});
assert.equal(siblingVictim.status, "failed");
assert.match(siblingVictim.outcome.reasonCode, /outside its issuer handle/);
assert.equal(
  siblingVictimDerivationTouched,
  false,
  "a valid sibling route binding must fail before victim derivation callbacks",
);

const forgedVictimRoute = Object.freeze({ ...strictVictimRoute }) as
  typeof strictVictimRoute;
const forgedVictim = executeFamilyVictimReplay({
  family: loadedStrictFamily,
  route: forgedVictimRoute,
  impact: strictVictimImpact,
  preState: preVictimState,
  validUntil: VALID_UNTIL,
  source: SOURCE,
  generation: SOURCE.generation,
  runtime: noIoRuntime,
});
assert.equal(forgedVictim.status, "failed");
assert.match(
  forgedVictim.outcome.reasonCode,
  /route runtime handle must be issued by the central runtime/,
);

const hotReloadVictim = executeFamilyVictimReplay({
  family: loadedFamily(),
  route: strictVictimRoute,
  impact: strictVictimImpact,
  preState: preVictimState,
  validUntil: VALID_UNTIL,
  source: SOURCE,
  generation: SOURCE.generation,
  runtime: noIoRuntime,
});
assert.equal(hotReloadVictim.status, "failed");
assert.match(hotReloadVictim.outcome.reasonCode, /escaped its catalog Family box/);

const staleVictim = executeFamilyVictimReplay({
  family: loadedStrictFamily,
  route: strictVictimRoute,
  impact: strictVictimImpact,
  preState: preVictimState,
  validUntil: VALID_UNTIL,
  source: Object.freeze({ ...SOURCE, generation: SOURCE.generation + 1 }),
  generation: SOURCE.generation + 1,
  runtime: noIoRuntime,
});
assert.equal(staleVictim.status, "failed");
assert.match(
  staleVictim.outcome.reasonCode,
  /source\/generation differs from its route publication handle/,
);

await testUniv2FactoryEnumeration();

console.log(
  "univ2-family-plugin PASS " +
    "(strict seven-capability parity, reverse identity, carry, victim replay, ownership, factory enumeration)",
);

async function testUniv2FactoryEnumeration(): Promise<void> {
  const enumeration = univ2StrictFamilyPlugin.discovery?.factoryEnumeration;
  assert(enumeration, "univ2 discovery must declare factory enumeration");
  const P0 = ethers.getAddress(`0x${"11".repeat(20)}`);
  const P1 = ethers.getAddress(`0x${"22".repeat(20)}`);
  const P2 = ethers.getAddress(`0x${"33".repeat(20)}`);
  const enumIface = new ethers.Interface([
    "function allPairsLength() view returns (uint256)",
    "function allPairs(uint256) view returns (address)",
  ]);
  const lenData = enumIface.encodeFunctionResult("allPairsLength", [3n]);
  let allPairsCalls = 0;
  const provider = {
    call: async (req: { to: string; data: string }): Promise<string> => {
      if (req.data === enumIface.encodeFunctionData("allPairsLength")) {
        return lenData;
      }
      if (req.data.startsWith(enumIface.getFunction("allPairs")!.selector)) {
        allPairsCalls++;
        const decoded = enumIface.decodeFunctionData("allPairs", req.data)[0];
        const address = [P0, P1, P2][Number(decoded)] as string;
        return enumIface.encodeFunctionResult("allPairs", [address]);
      }
      throw new Error(`unexpected call ${req.data.slice(0, 10)}`);
    },
  };
  const pools = await enumeration.enumerate({ provider });
  assert.equal(pools.length, 3);
  assert.deepEqual(
    pools.map((pool) => pool.address),
    [P0.toLowerCase(), P1.toLowerCase(), P2.toLowerCase()],
  );
  assert.equal(pools.every((pool) => pool.adapter === "univ2"), true);
  assert.equal(allPairsCalls, 3);
  const badLen = await enumeration.enumerate({
    provider: {
      call: async (req: { to: string; data: string }): Promise<string> =>
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
  }).then(() => null, (error: unknown) => error);
  assert(badLen instanceof Error);
  assert.match(String((badLen as Error).message), /invalid pool count/);
}

function loadedFamily(): LoadedFamilyPlugin {
  const summary = definedFamilyPluginContractSummary(univ2StrictFamilyPlugin);
  const entries: GeneratedCapabilityIdentity[] = FAMILY_CAPABILITY_NAMES.map(
    (capability) => ({
      familyId: univ2StrictFamilyPlugin.manifest.familyId,
      capability,
      contractVersion: `fixture-${capability}-v1`,
      contentHash: hashCanonical({
        familyId: univ2StrictFamilyPlugin.manifest.familyId,
        capability,
      }),
      semanticDependencies: [`fixture:${capability}`],
      provenanceCommit: null,
    }),
  );
  const catalog = new FamilyCapabilityCatalog({
    modules: [{
      sourceFile: "fixture/univ2.production.ts",
      definitionBoundaryHash: summary.definitionBoundaryHash,
      plugin: univ2StrictFamilyPlugin,
    }],
    generatedManifest: {
      format: "adapter-family-capabilities-v1",
      entries,
      manifestHash: capabilityManifestHash(entries),
    },
  });
  assert.deepEqual(
    catalog.forFamily(univ2StrictFamilyPlugin.manifest.familyId)
      .applicableCapabilities,
    FAMILY_CAPABILITIES_BY_DOMAIN.swap,
  );
  return catalog.forFamily(univ2StrictFamilyPlugin.manifest.familyId);
}

function fixtureRuntime(): CentralAdapterRuntime {
  const unexpectedIo = (): never => {
    throw new Error("zero-input/victim pure runtime unexpectedly requested I/O");
  };
  return {
    generationFence: {
      assertCurrent(generation: number, source: CanonicalSource) {
        assert.equal(generation, SOURCE.generation);
        assert.deepEqual(source, SOURCE);
      },
    },
    policy: { bind: unexpectedIo },
    budgets: { assertAdmitted: unexpectedIo },
    scheduler: { issueExecutor: unexpectedIo },
    callerAuthority: { bind: unexpectedIo },
    clock: { nowMs: () => 0 },
  } as unknown as CentralAdapterRuntime;
}

function lifecycleFixtureRuntime(): CentralAdapterRuntime {
  let now = 0;
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
          execute: async ({ requests, source }) =>
            requests.map((request) => lifecycleRequestResult(request, source)),
          sealStaticEvidenceReuseProof: () => ({
            proofHash: "cd".repeat(32),
          }),
        }),
        timing: () => Object.freeze({
          queueWaitMs: 0,
          transportWallMs: 0,
          attempts: 1,
        }),
      });
    },
  };
  return {
    generationFence: {
      assertCurrent(generation, source) {
        assert.equal(generation, SOURCE.generation);
        assert.deepEqual(source, SOURCE);
      },
    },
    policy: {
      bind(input) {
        return Object.freeze({
          lane: input.stage === "pricing-current"
            ? "foreground" as const
            : "background" as const,
          deadlineAtMs: 10_000,
          maxAttempts: 1,
          transportPool: "state-read" as const,
          fairnessKey: input.subjectKey,
        });
      },
    },
    budgets: { assertAdmitted() {} },
    scheduler,
    callerAuthority: { bind: () => Object.freeze({}) },
    clock: { nowMs: () => now++ },
  };
}

function lifecycleRequestResult(
  request: AdapterRequest,
  source: CanonicalSource,
): AdapterRequestResult {
  assert.deepEqual(source, SOURCE);
  let data: string;
  switch (request.id) {
    case "pair-factory":
      data = UNIV2_PAIR_INTERFACE.encodeFunctionResult("factory", [FACTORY]);
      break;
    case "pair-token0":
      data = UNIV2_PAIR_INTERFACE.encodeFunctionResult("token0", [TOKEN0]);
      break;
    case "pair-token1":
      data = UNIV2_PAIR_INTERFACE.encodeFunctionResult("token1", [TOKEN1]);
      break;
    case "factory-get-pair":
      data = UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [POOL]);
      break;
    default:
      if (request.id !== currentRequests[0].id) {
        throw new Error(`unexpected strict lifecycle request ${request.id}`);
      }
      data = reservesData;
  }
  return success(request.id, data);
}

function runIdentity(
  candidateInput: UniV2Candidate,
  factory: string,
  reversePool: string,
): UniV2Identity {
  const decision = runIdentityDecision(candidateInput, factory, reversePool);
  assert.equal(decision.status, "verified");
  return decision.identity;
}

function runIdentityDecision(
  candidateInput: UniV2Candidate,
  factory: string,
  reversePool: string,
): ReturnType<typeof identityVariant.decide> {
  const initial = { candidate: candidateInput, evidence: undefined, step: 0 };
  assert.deepEqual(identityVariant.decide(initial), { status: "continue" });
  assert.deepEqual(identityVariant.requirements(initial), {
    transports: ["eth-call"],
  });
  const firstRequests = identityVariant.buildRequests(initial);
  assert.deepEqual(firstRequests.map((request) => request.id), [
    "pair-factory",
    "pair-token0",
    "pair-token1",
  ]);
  const firstEvidence = identityVariant.decode({
    step: initial,
    results: [
      success(
        "pair-factory",
        UNIV2_PAIR_INTERFACE.encodeFunctionResult("factory", [factory]),
      ),
      success(
        "pair-token0",
        UNIV2_PAIR_INTERFACE.encodeFunctionResult("token0", [TOKEN0]),
      ),
      success(
        "pair-token1",
        UNIV2_PAIR_INTERFACE.encodeFunctionResult("token1", [TOKEN1]),
      ),
    ],
  }) as UniV2IdentityEvidence;
  const reverseStep = {
    candidate: candidateInput,
    evidence: firstEvidence,
    step: 1,
  };
  assert.deepEqual(identityVariant.decide(reverseStep), { status: "continue" });
  const reverseRequests = identityVariant.buildRequests(reverseStep);
  assert.equal(reverseRequests.length, 1);
  assert.equal(reverseRequests[0].kind, "eth-call");
  if (reverseRequests[0].kind !== "eth-call") {
    throw new Error("univ2 reverse binding request must be eth-call");
  }
  assert.equal(reverseRequests[0].to, factory);
  const reverseEvidence = identityVariant.decode({
    step: reverseStep,
    results: [success(
      "factory-get-pair",
      UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [reversePool]),
    )],
  }) as UniV2IdentityEvidence;
  return identityVariant.decide({
    candidate: candidateInput,
    evidence: reverseEvidence,
    step: 2,
  });
}

function success(
  id: string,
  data: string,
): AdapterRequestResult {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: PROVENANCE,
    completion: "returned" as const,
    data,
  });
}

function midSemantics(mid: {
  readonly kind: string;
  readonly pool: string;
  readonly mid: number;
  readonly feeBps: number;
  readonly reserveA?: bigint;
  readonly reserveB?: bigint;
}) {
  return {
    kind: mid.kind,
    pool: mid.pool,
    mid: mid.mid,
    feeBps: mid.feeBps,
    reserveA: mid.reserveA,
    reserveB: mid.reserveB,
  };
}

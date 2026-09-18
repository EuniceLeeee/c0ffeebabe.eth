import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { univ3Adapter } from "../../adapters/univ3.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolEntry } from "../planner/token-graph.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { getSqrtRatioAtTick, V3MissingBitmapWordError, v3SwapToState } from "../solver/v3-math.js";
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
  PANCAKE_V3_FACTORY,
  PANCAKE_V3_QUOTER_V2,
  PANCAKE_V3_SWAP_TOPIC,
  UNIV3_BURN_TOPIC,
  UNIV3_FACTORY_INTERFACE,
  UNIV3_MINT_TOPIC,
  UNIV3_POOL_INTERFACE,
  UNIV3_QUOTER_V2,
  UNIV3_QUOTER_V2_INTERFACE,
  UNIV3_SWAP_TOPIC,
  UNIV3_TICK_LENS,
  UNIV3_TICK_LENS_INTERFACE,
} from "../venues/swaps/univ3-abi.js";
import { createUniV3Exact } from "../venues/swaps/univ3-family/exact.js";
import { UNIV3_SWAPPER_INTERFACE, uniV3SwapAccessRequest } from "../venues/swaps/univ3-family/swap-access.js";
import {
  readUniV3State,
  resolveUniV3StateReader,
  UNIV3_STATE_READER,
  UNIV3_STATE_READER_INTERFACE,
  UNIV3_STATE_WORD_RADIUS,
} from "../venues/swaps/univ3-family/state-reader.js";
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
  status: "chain-proven-rejected",
  reasonCode: "factory_reverse_binding_failed",
  evidenceRequestIds: ["factory-get-pool"],
});
assert.deepEqual(runIdentityDecision(candidate, FACTORY, null), {
  status: "chain-proven-rejected",
  reasonCode: "factory_reverse_binding_failed",
  evidenceRequestIds: ["factory-get-pool"],
}, "a pinned factory revert is chain-proven failed reverse binding");
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
// Synthetic descriptor metadata for offline behavior tests, not chain proof.
const noSwapAccess = { kind: "no-is-swapper-getter" as const, codeHash: `0x${"ab".repeat(32)}` };
const descriptor = univ3StrictFamilyPlugin.instance.finalizeDescriptor({
  identity,
  draft: descriptorDraft,
  staticEvidence: noSwapAccess,
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
// Keep the original factory-bound Quoter executable and tested explicitly.
const exactRequestMethod = createUniV3Exact("quoter").methods(exactInput)[1];
assert.equal(exactRequestMethod.kind, "request-program");
if (exactRequestMethod.kind !== "request-program") {
  throw new Error("univ3 exact request program missing");
}
assert.equal(exactRequestMethod.id, "quoter-v2");
assert("chainAmountQuote" in exactRequestMethod);
assert.equal(exactRequestMethod.chainAmountQuote, true);
assert.equal("stateOnlyReads" in exactRequestMethod ? exactRequestMethod.stateOnlyReads : undefined,
  undefined, "Quoter outputs remain amount-dependent");
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
assert.equal(exactRequestMethod.program.buildDependentProgram?.({ programInput: exactInput,
  initialResults: [success(exactRequests[0].id, quoterData)], completedRound: 0, priorEvidence: [] }) ?? null,
  null, "Quoter mode does not launch state-reading dependent rounds");
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
    staticEvidence: noSwapAccess,
    sharedBindings: [],
  });
const unknownRoute = univ3StrictFamilyPlugin.routes.project({
  descriptor: unknownDescriptor,
})[0];
const unknownExactInput = {
  ...exactInput,
  descriptor: unknownDescriptor,
  route: unknownRoute,
};
const unknownExactRequests =
  exactRequestMethod.program.buildRequests(unknownExactInput);
assert.deepEqual(unknownExactRequests.map(request => request.id), ["local-slot0", "local-liquidity"]);
for (const request of unknownExactRequests) {
  assert(request.kind === "eth-call");
  assert.equal(request.to, POOL, "unknown reverse-verified factory keeps its pool-state reads");
}
assert.throws(() => exactRequestMethod.program.decode({
  programInput: unknownExactInput,
  initialResults: [],
  dependentEvidence: [],
}), /missing|incomplete/, "missing state is not a successful zero-liquidity quote");

const pancakeIdentity = runIdentity(unknownFactoryCandidate, PANCAKE_V3_FACTORY, POOL);
assert.equal(pancakeIdentity.facts.quoterBinding.quoter, PANCAKE_V3_QUOTER_V2);
const pancakeDescriptor = univ3StrictFamilyPlugin.instance.finalizeDescriptor({
  identity: pancakeIdentity,
  draft: univ3StrictFamilyPlugin.instance.compileDraft(pancakeIdentity),
  staticEvidence: noSwapAccess,
  sharedBindings: [],
});
const uniReader = resolveUniV3StateReader(descriptor);
const pancakeReader = resolveUniV3StateReader(pancakeDescriptor);
assert(uniReader !== null);
assert(pancakeReader !== null);
assert.equal(uniReader.address, UNIV3_STATE_READER);
assert.equal(pancakeReader.address.toLowerCase(), "0x80898f80cfa3fa3abf410d90e69adc432ae5d4c2");
assert.notEqual(uniReader.address, pancakeReader.address, "Pancake does not borrow the incompatible Uni helper");
assert.equal(resolveUniV3StateReader(unknownDescriptor), null,
  "no compatible aggregate helper does not revoke reverse-verified instance admission");
assert.equal(resolveUniV3StateReader({ ...pancakeDescriptor,
  factoryBinding: { ...pancakeDescriptor.factoryBinding, factory: PANCAKE_V3_FACTORY.toLowerCase() } })?.address,
  pancakeReader.address, "helper selection canonicalizes factory addresses");
const readerCompatibilities = [descriptor, pancakeDescriptor, unknownDescriptor].map(descriptorToUse =>
  createUniV3Exact("local").cacheCompatibilityProjection({ ...exactInput, descriptor: descriptorToUse,
    route: univ3StrictFamilyPlugin.routes.project({ descriptor: descriptorToUse })[0] }));
assert.deepEqual(readerCompatibilities.map(compatibility => compatibility.stateReader),
  [uniReader.address, pancakeReader.address, null], "cache compatibility records the selected reader, not just the factory");
const readerCompatibilityHashes = readerCompatibilities.map(compatibility => hashCanonical(compatibility));
assert.equal(new Set(readerCompatibilityHashes).size, 3, "factory/reader changes cannot share cache compatibility");
for (const [reader, expectedType] of [[uniReader, "uint8"], [pancakeReader, "uint32"]] as const) {
  const stateOutput = reader.iface.getFunction("getFullStateWithRelativeBitmaps")!.outputs[0];
  const slot0Output = stateOutput.components!.find(component => component.name === "slot0")!;
  assert.equal(slot0Output.components!.find(component => component.name === "feeProtocol")!.type, expectedType);
}
const wideProtocolFeeState = stateReaderFixture({ feeProtocol: 0x12345678 });
const wideProtocolFeeData = encodeStateReaderFixture(wideProtocolFeeState, pancakeReader.iface);
assert.equal(pancakeReader.iface.decodeFunctionResult("getFullStateWithRelativeBitmaps", wideProtocolFeeData)[0].slot0.feeProtocol,
  0x12345678n, "Pancake uint32 protocol fees must not be truncated to Uni uint8");
assert.deepEqual(readUniV3State(wideProtocolFeeData, pancakeDescriptor),
  readUniV3State(encodeStateReaderFixture(stateReaderFixture(), pancakeReader.iface), pancakeDescriptor),
  "protocol-fee metadata does not change the common local swap state");
assert.throws(() => encodeStateReaderFixture(wideProtocolFeeState), "Uni ABI rejects the wide Pancake field");
assert.throws(() => readUniV3State(wideProtocolFeeData, descriptor), "wide Pancake state cannot be silently decoded as Uni state");

const localMethod = univ3StrictFamilyPlugin.exact.methods(exactInput)[1];
assert.equal(localMethod.id, "local-state-49");
assert.equal(localMethod.kind, "request-program");
if (localMethod.kind !== "request-program") throw new Error("missing local tick program");
assert.equal(localMethod.chainAmountQuote, undefined, "local math is not a Quoter-returned amount");
assert.equal(localMethod.stateOnlyReads, true, "amount changes reuse the existing generic state cache");
const localProgram = localMethod.program;
// The shared Exact program checks executor permissions before publishing a
// quote, without changing the amount-independent tick request/cache identity.
{
  const gatedInput = { ...exactInput, descriptor: { ...descriptor,
    swapAccess: { ...noSwapAccess, kind: "is-swapper" as const } } };
  const initialResults = [success("local-pool-state", encodeStateReaderFixture(stateReaderFixture()))];
  const access = uniV3SwapAccessRequest(gatedInput)!;
  assert.equal(access.caller, undefined, "pure getter is eligible for state-only caching");
  assert.deepEqual([...UNIV3_SWAPPER_INTERFACE.decodeFunctionData("isSwapper", access.data)], [EXECUTOR]);
  assert.deepEqual(localProgram.buildRequests(gatedInput), localProgram.buildRequests(exactInput));
  assert.equal(uniV3SwapAccessRequest({ ...gatedInput, amountIn: AMOUNT_IN * 5n } as typeof gatedInput)?.id,
    access.id, "same-block Solver amounts share permission reads");
  for (const source of [{ ...SOURCE, number: SOURCE.number + 1 },
    { ...SOURCE, generation: SOURCE.generation + 1 }, { ...SOURCE, hash: `0x${"cd".repeat(32)}` }]) {
    const next = { ...gatedInput, source };
    assert.notEqual(uniV3SwapAccessRequest(next)?.id, access.id, "permission reads cannot carry across sources");
    assert.deepEqual(localProgram.buildRequests(next), localProgram.buildRequests(gatedInput),
      "tick request fingerprint remains reusable");
    assert.deepEqual(univ3StrictFamilyPlugin.exact.cacheCompatibilityProjection(next),
      univ3StrictFamilyPlugin.exact.cacheCompatibilityProjection(gatedInput), "do not invalidate the whole tick cache");
  }
  const round = localProgram.buildDependentProgram!({ programInput: gatedInput, initialResults,
    completedRound: 0, priorEvidence: [] });
  assert(round);
  assert.deepEqual(round.requests, [access]);
  const allowed = success(access.id, UNIV3_SWAPPER_INTERFACE.encodeFunctionResult("isSwapper", [true]));
  const denied = success(access.id, UNIV3_SWAPPER_INTERFACE.encodeFunctionResult("isSwapper", [false]));
  const allowEvidence = round.decode([allowed]);
  const decode = (result: AdapterRequestResult) => localProgram.decode({ programInput: gatedInput,
    initialResults, dependentEvidence: [round.decode([result])] });
  assert.equal(decode(allowed).amountOut, localProgram.decode({ programInput: exactInput,
    initialResults, dependentEvidence: [] }).amountOut, "authorization must not change the price formula");
  assert.equal(localProgram.buildDependentProgram!({ programInput: gatedInput, initialResults,
    completedRound: 1, priorEvidence: [allowEvidence] }), null);
  assert.throws(() => decode(denied), /not an allowed swapper/);
  for (const bad of [success(access.id, "0x"), success(access.id, ethers.toBeHex(2, 32)),
    declaredRevert(access.id), { id: access.id, ok: false as const, source: SOURCE, failure: "rpc" as const }]) {
    assert.throws(() => decode(bad), /swap access/);
  }
  assert.throws(() => localProgram.decode({ programInput: gatedInput, initialResults,
    dependentEvidence: [] }), /missing.*swap access/);
  assert.throws(() => localProgram.buildDependentProgram!({ programInput: gatedInput, initialResults,
    completedRound: 1, priorEvidence: [round.decode([denied])] }), /not an allowed swapper/);
  assert.throws(() => exactRequestMethod.program.decode({ programInput: gatedInput,
    initialResults: [success(exactRequests[0].id, quoterData)], dependentEvidence: [round.decode([denied])] }),
    /not an allowed swapper/, "switching to Quoter cannot bypass authorization");
  const { swapAccess: _removed, ...legacyDescriptor } = descriptor;
  assert.throws(() => localProgram.decode({ programInput: { ...exactInput,
    descriptor: legacyDescriptor as typeof descriptor }, initialResults, dependentEvidence: [] }),
    /unsupported swap access/, "old Ready descriptors require selective revalidation");

  const unknownGated = { ...unknownExactInput, descriptor: { ...unknownDescriptor, swapAccess: gatedInput.descriptor.swapAccess } };
  const core = [success("local-slot0", tinySlot0Data), success("local-liquidity", liquidityData)];
  const permissionRound = localProgram.buildDependentProgram!({ programInput: unknownGated,
    initialResults: core, completedRound: 0, priorEvidence: [] });
  assert(permissionRound);
  const permissionEvidence = permissionRound.decode([allowed]);
  const ticksRound = localProgram.buildDependentProgram!({ programInput: unknownGated,
    initialResults: core, completedRound: 1, priorEvidence: [permissionEvidence] });
  assert(ticksRound);
  assert.equal(ticksRound.requests.length, 49, "permission check preserves the unknown-factory tick round");
  const ticksEvidence = ticksRound.decode(ticksRound.requests.map(request => success(request.id,
    UNIV3_TICK_LENS_INTERFACE.encodeFunctionResult("getPopulatedTicksInWord", [[]]))));
  assert.equal(localProgram.buildDependentProgram!({ programInput: unknownGated,
    initialResults: core, completedRound: 2, priorEvidence: [permissionEvidence, ticksEvidence] }), null);
  assert(localProgram.decode({ programInput: unknownGated, initialResults: core,
    dependentEvidence: [permissionEvidence, ticksEvidence] }).amountOut > 0n);
}
assert.deepEqual(localProgram.requirements(exactInput), { transports: ["eth-call"] });
assert.equal(localProgram.buildRequests(exactInput).length, 1);
assert.equal(UNIV3_STATE_WORD_RADIUS, 24);
assert.equal(UNIV3_STATE_READER.toLowerCase(), "0x9c764d2e92da68e4cdfd784b902283a095ff8b63");
assert.notDeepEqual(createUniV3Exact("local").cacheCompatibilityProjection(exactInput),
  createUniV3Exact("quoter").cacheCompatibilityProjection(exactInput));

for (const descriptorToUse of [descriptor, pancakeDescriptor]) {
  const reader = resolveUniV3StateReader(descriptorToUse);
  assert(reader !== null);
  for (const route of univ3StrictFamilyPlugin.routes.project({ descriptor: descriptorToUse })) {
    const programInput = { ...exactInput, descriptor: descriptorToUse, route, amountIn: 100_000_000_000n };
    assert.equal(univ3StrictFamilyPlugin.exact.methods(programInput)[1].id, "local-state-49");
    const requests = localProgram.buildRequests(programInput);
    assert.equal(requests.length, 1, "both directions of a helper-compatible factory use one state read");
    const request = requests[0];
    assert(request.kind === "eth-call");
    assert.equal(request.id, "local-pool-state");
    assert.equal(request.to, reader.address);
    assert.equal(request.completion, "return-data");
    assert.equal(request.caller, undefined, "state reads do not depend on the executor");
    assert.deepEqual([...reader.iface.decodeFunctionData(
      "getFullStateWithRelativeBitmaps", request.data,
    )], [descriptorToUse.factoryBinding.factory, TOKEN0, TOKEN1, FEE, 25n, 24n]);
    for (const multiplier of [5n, 10n, 15n]) {
      assert.deepEqual(localProgram.buildRequests({ ...programInput, amountIn: programInput.amountIn * multiplier }),
        requests, "changing amount only changes local math, not the state request");
    }
    const rawState = stateReaderFixture({ liquidity: 1_000_000_000_000n,
      initializedTicks: [[-1024, 1000n], [1024, -1000n]],
      feeProtocol: descriptorToUse === pancakeDescriptor ? 0x12345678 : 0 });
    const initialResults: readonly AdapterRequestResult[] = [success(request.id, encodeStateReaderFixture(rawState, reader.iface))];
    assert.equal(localProgram.buildDependentProgram?.({ programInput, initialResults,
      completedRound: 0, priorEvidence: [] }) ?? null, null, "aggregate success has no dependent round");
    const decode = (results: readonly AdapterRequestResult[] = initialResults, amountIn = programInput.amountIn) =>
      localProgram.decode({ programInput: { ...programInput, amountIn }, initialResults: results,
        dependentEvidence: [] });
    const quote = decode();
    assert(quote.amountOut > 0n);
    assert.equal(quote.evidence.kind, "univ3-local-ticks");
    assert.equal(quote.evidence.amountIn, programInput.amountIn);
    assert.equal(quote.evidence.initializedTicksCrossed, 1);
    assert.notEqual(quote.evidence.sqrtPriceX96After, Q96, "evidence uses returned post-swap state, not the starting price");
    const words = Array.from({ length: 49 }, (_, i) => i - 24);
    const state = { sqrtPriceX96: Q96, tick: 0, liquidity: 1_000_000_000_000n, fee: FEE,
      tickSpacing: TICK_SPACING, ticks: new Map([[-1024, 1000n], [1024, -1000n]]),
      tickBitmap: new Map(words.map(w => [w, w === -4 || w === 4 ? 1n : 0n])) };
    const expected = v3SwapToState(state, route.direction === "zero-for-one", programInput.amountIn);
    assert.equal(quote.amountOut, expected.amountOut);
    assert.equal(quote.evidence.sqrtPriceX96After, expected.state.sqrtPriceX96);
    assert.throws(() => v3SwapToState({ ...state, tickBitmap: new Map([[-1, 0n], [0, 0n], [1, 0n]]) },
      route.direction === "zero-for-one", programInput.amountIn), V3MissingBitmapWordError,
      "same amount exceeds the previous three-word window");
    assert.notEqual(decode(initialResults, programInput.amountIn / 2n).amountOut * 2n, quote.amountOut,
      "amount-sensitive swap math, not a spot-price multiplier");
    assert.equal(decode(initialResults, 100_000_000_000_000n).amountOut, 0n,
      "out-of-window amount never gets a fabricated output");
    const fragment = univ3StrictFamilyPlugin.execution.buildFragment({ ...programInput,
      quotedAmountOut: quote.amountOut, minAmountOut: quote.amountOut, exactEvidence: quote.evidence });
    assert.equal(fragment.nodes[0].amount, programInput.amountIn);
    for (const change of [{ amountIn: programInput.amountIn + 1n }, { amountOut: quote.amountOut + 1n },
      { tokenIn: route.tokenOut }, { pool: FORGED_POOL }, { fee: FEE + 1n }]) {
      assert.throws(() => univ3StrictFamilyPlugin.execution.buildFragment({ ...programInput,
        quotedAmountOut: quote.amountOut, minAmountOut: quote.amountOut, exactEvidence: { ...quote.evidence, ...change } }), /incompatible/);
    }
    for (const source of [{ ...SOURCE, number: SOURCE.number + 1 }, { ...SOURCE, generation: SOURCE.generation + 1 },
      { ...SOURCE, hash: `0x${"cd".repeat(32)}` }]) {
      assert.throws(() => decode(initialResults.map(r => ({ ...r, source }))), /foreign source/);
    }
    assert.throws(() => decode([]), /missing|incomplete/);
    const failedResults: readonly AdapterRequestResult[] = [{ id: request.id, ok: false, failure: "rpc", source: SOURCE }];
    assert.throws(() => decode(failedResults), /unresolved/);
    assert.equal(localProgram.buildDependentProgram?.({ programInput, initialResults: failedResults,
      completedRound: 0, priorEvidence: [] }) ?? null, null, "aggregate failure cannot trigger an automatic TickLens fallback");
    const revertedResults = [declaredRevert(request.id)];
    assert.throws(() => decode(revertedResults));
    assert.equal(localProgram.buildDependentProgram?.({ programInput, initialResults: revertedResults,
      completedRound: 0, priorEvidence: [] }) ?? null, null, "helper revert cannot silently switch the read method");
    assert.deepEqual(localProgram.buildRequests(programInput), requests, "failure never mutates the selected read method");
    assert.throws(() => decode([success(request.id, "0x")]));
    assert.throws(() => decode([success(request.id, encodeStateReaderFixture({ ...rawState, pool: FORGED_POOL }, reader.iface))]),
      /pool|binding/, "an aggregate helper cannot substitute another pool's state");
  }
}
// Unknown reverse-verified factories remain quoteable through their original
// factory-agnostic state program; this is selected before I/O, not after failure.
for (const route of univ3StrictFamilyPlugin.routes.project({ descriptor: unknownDescriptor })) {
  const programInput = { ...unknownExactInput, route, amountIn: 10_000_000_000n };
  const method = univ3StrictFamilyPlugin.exact.methods(programInput)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing unknown-factory local program");
  assert.equal(method.id, "local-ticks-49");
  assert.equal(method.stateOnlyReads, true);
  assert.equal(method.chainAmountQuote, undefined);
  const program = method.program;
  assert.deepEqual(program.requirements(programInput), { transports: ["eth-call"] });
  const requests = program.buildRequests(programInput);
  assert.deepEqual(requests.map(request => request.id), ["local-slot0", "local-liquidity"]);
  for (const request of requests) {
    assert(request.kind === "eth-call");
    assert.equal(request.to, POOL);
    assert.equal(request.caller, undefined);
  }
  const initialResults = [
    success("local-slot0", UNIV3_POOL_INTERFACE.encodeFunctionResult("slot0", [Q96, 0, 0, 1, 1, 0, true])),
    success("local-liquidity", UNIV3_POOL_INTERFACE.encodeFunctionResult("liquidity", [1_000_000_000_000n])),
  ];
  const round = program.buildDependentProgram!({ programInput, initialResults, completedRound: 0, priorEvidence: [] });
  assert(round !== null);
  assert.equal(requests.length + round.requests.length, 51, "2 core reads plus 49 TickLens words");
  const words = round.requests.map(request => {
    assert(request.kind === "eth-call");
    assert.equal(request.to, UNIV3_TICK_LENS);
    const args = UNIV3_TICK_LENS_INTERFACE.decodeFunctionData("getPopulatedTicksInWord", request.data);
    assert.equal(args[0], POOL);
    return Number(args[1]);
  });
  assert.deepEqual(words, Array.from({ length: 49 }, (_, i) => i - 24));
  const tickResults = round.requests.map((request, i) => success(request.id,
    UNIV3_TICK_LENS_INTERFACE.encodeFunctionResult("getPopulatedTicksInWord", [
      words[i] === -4 ? [[-1024, 1000n, 1000n]] : words[i] === 4 ? [[1024, -1000n, 1000n]] : [],
    ])));
  const decode = (results: readonly AdapterRequestResult[] = tickResults, amountIn = programInput.amountIn) =>
    program.decode({ programInput: { ...programInput, amountIn }, initialResults,
      dependentEvidence: [round.decode(results)] });
  const state = { sqrtPriceX96: Q96, tick: 0, liquidity: 1_000_000_000_000n, fee: FEE,
    tickSpacing: TICK_SPACING, ticks: new Map([[-1024, 1000n], [1024, -1000n]]),
    tickBitmap: new Map(words.map(word => [word, word === -4 || word === 4 ? 1n : 0n])) };
  for (const multiplier of [1n, 5n, 10n, 15n]) {
    const amountIn = programInput.amountIn * multiplier;
    assert.deepEqual(program.buildRequests({ ...programInput, amountIn }), requests);
    const quote = decode(tickResults, amountIn);
    assert(quote.amountOut > 0n, "unknown factory remains usable in both directions at all four sample amounts");
    assert.equal(quote.evidence.kind, "univ3-local-ticks");
    assert.equal(quote.evidence.amountIn, amountIn);
    const expected = v3SwapToState(state, route.direction === "zero-for-one", amountIn);
    assert.equal(quote.amountOut, expected.amountOut);
    assert.equal(quote.evidence.sqrtPriceX96After, expected.state.sqrtPriceX96);
    const fragment = univ3StrictFamilyPlugin.execution.buildFragment({ ...programInput, amountIn,
      quotedAmountOut: quote.amountOut, minAmountOut: quote.amountOut, exactEvidence: quote.evidence });
    assert.equal(fragment.nodes[0].amount, amountIn);
  }
  assert.throws(() => decode(tickResults.slice(1)), /incomplete|missing/);
  assert.throws(() => decode([...tickResults.slice(1), tickResults[1]]), /duplicate/);
  assert.throws(() => decode(tickResults.map((result, i) => i === 0
    ? { id: result.id, ok: false, failure: "rpc" as const, source: SOURCE } : result)), /unresolved/);
  assert.throws(() => decode(tickResults.map((result, i) => i === 0
    ? { ...result, source: { ...SOURCE, generation: SOURCE.generation + 1 } } : result)), /foreign source/);
  assert.equal(decode(tickResults, 100_000_000_000_000n).amountOut, 0n, "unknown-factory window bounds stay fail-closed");
  assert.equal(program.buildDependentProgram!({ programInput, initialResults, completedRound: 1,
    priorEvidence: [round.decode(tickResults)] }), null, "unknown factory uses exactly one dependent round");
}
// Zero active liquidity can still reach funded ticks within the loaded window.
for (const route of routes) {
  const programInput = { ...exactInput, route, amountIn: 100_000_000n };
  const fundedTicks = [[-100, 1_000_000_000_000n], [-10, -1_000_000_000_000n],
    [10, 1_000_000_000_000n], [100, -1_000_000_000_000n]] as const;
  const makeResults = (funded: boolean) => [success("local-pool-state", encodeStateReaderFixture(
    stateReaderFixture({ liquidity: 0n, initializedTicks: funded ? fundedTicks : [] }),
  ))];
  const quote = localProgram.decode({ programInput, initialResults: makeResults(true), dependentEvidence: [] });
  assert.equal(quote.amountOut, 99_840_130n, "swap crosses the empty region before consuming input");
  assert.equal(quote.evidence.kind, "univ3-local-ticks");
  assert.equal(quote.evidence.initializedTicksCrossed, 1);
  assert.equal(localProgram.decode({ programInput, initialResults: makeResults(false),
    dependentEvidence: [] }).amountOut, 0n,
    "no funded ticks in the known window stays unavailable");
}
for (const spacing of [1, 60]) {
  for (const tick of [-15361, -15360, -257, -256, -1, 0, 255, 256, 15360]) {
    const boundDescriptor = { ...descriptor, tickSpacing: spacing };
    const rawState = stateReaderFixture({ tick, tickSpacing: spacing });
    const state = readUniV3State(encodeStateReaderFixture(rawState), boundDescriptor);
    const floorCenter = Math.floor(tick / spacing) >> 8;
    const helperCenter = Math.trunc(tick / spacing) >> 8;
    const expectedWords = Array.from({ length: 49 }, (_, i) => floorCenter - 24 + i);
    assert.deepEqual([...state.tickBitmap.keys()].sort((a, b) => a - b), expectedWords,
      `tick=${tick}/spacing=${spacing} preserves the original floor-centered 49-word window`);
    assert([...state.tickBitmap.values()].every(word => word === 0n), "sparse omitted words are known empty");
    assert(expectedWords.every(word => word >= helperCenter - 25 && word <= helperCenter + 24),
      "never invent a word outside the helper's actual scanned range");
    assert.equal(state.tickBitmap.has(floorCenter - 25), false);
    assert.equal(state.tickBitmap.has(floorCenter + 25), false);
    if (spacing === 60 && (tick === -1 || tick === -15361)) {
      assert.equal(floorCenter, helperCenter - 1, "fixture exercises signed truncation vs floor at a word boundary");
      const boundaryTick = (floorCenter - 24) * 256 * spacing;
      const boundary = readUniV3State(encodeStateReaderFixture(stateReaderFixture({ tick, tickSpacing: spacing,
        initializedTicks: [[boundaryTick, 1000n]] })), boundDescriptor);
      assert.equal(boundary.ticks.get(boundaryTick), 1000n, "the extra left read preserves a real boundary tick");
    }
  }
}
const readerDescriptor = { ...descriptor, tickSpacing: 60 };
const readerFixture = stateReaderFixture({ tickSpacing: 60,
  initializedTicks: [[-15360, 1000n], [60, 2000n], [15360, -3000n]] });
const readFixture = (value: ReturnType<typeof stateReaderFixture>) =>
  readUniV3State(encodeStateReaderFixture(value), readerDescriptor);
const sparseState = readFixture(readerFixture);
assert.equal(sparseState.tickBitmap.size, 49);
assert.deepEqual([...sparseState.ticks], [[-15360, 1000n], [60, 2000n], [15360, -3000n]]);
assert.equal(sparseState.tickBitmap.get(-1), 1n);
assert.equal(sparseState.tickBitmap.get(0), 2n);
assert.equal(sparseState.tickBitmap.get(1), 1n);
const reversedSparseState = readFixture({ ...readerFixture,
  tickBitmap: [...readerFixture.tickBitmap].reverse(), ticks: [...readerFixture.ticks].reverse() });
assert.deepEqual([...reversedSparseState.ticks].sort(([a], [b]) => a - b), [...sparseState.ticks],
  "sparse mappings are validated by identity, not assumed array ordering");

const malformedStates: readonly (readonly [string, ReturnType<typeof stateReaderFixture>])[] = [
  ["foreign pool", { ...readerFixture, pool: FORGED_POOL }],
  ["spacing differs from bound descriptor", { ...readerFixture, tickSpacing: 1 }],
  ["zero spacing", { ...readerFixture, tickSpacing: 0 }],
  ["negative spacing", { ...readerFixture, tickSpacing: -60 }],
  ["bitmap references a missing tick", { ...readerFixture, ticks: readerFixture.ticks.slice(1) }],
  ["tick lacks its bitmap word", { ...readerFixture, tickBitmap: readerFixture.tickBitmap.slice(1) }],
  ["duplicate bitmap word", { ...readerFixture, tickBitmap: [...readerFixture.tickBitmap, readerFixture.tickBitmap[0]] }],
  ["duplicate tick", { ...readerFixture, ticks: [...readerFixture.ticks, readerFixture.ticks[0]] }],
  ["extra tick without a corresponding set bit", { ...readerFixture,
    ticks: [...readerFixture.ticks, { ...readerFixture.ticks[1], index: 120 }] }],
  ["extra bitmap bit without a corresponding tick", { ...readerFixture,
    tickBitmap: readerFixture.tickBitmap.map(word => word.index === 0 ? { ...word, value: word.value | 4n } : word) }],
  ["tick is not aligned to spacing", { ...readerFixture,
    ticks: readerFixture.ticks.map((tick, i) => i === 1 ? { ...tick, index: 61 } : tick) }],
  ["uninitialized tick behind set bit", { ...readerFixture,
    ticks: readerFixture.ticks.map((tick, i) => i === 1 ? { ...tick, value: { ...tick.value, initialized: false } } : tick) }],
  ["zero gross liquidity behind set bit", { ...readerFixture,
    ticks: readerFixture.ticks.map((tick, i) => i === 1 ? { ...tick, value: { ...tick.value, liquidityGross: 0n } } : tick) }],
  ["net liquidity exceeds gross", { ...readerFixture,
    ticks: readerFixture.ticks.map((tick, i) => i === 1 ? { ...tick, value: { ...tick.value, liquidityGross: 1n } } : tick) }],
  ["negative net liquidity magnitude exceeds gross", { ...readerFixture,
    ticks: readerFixture.ticks.map((tick, i) => i === 2 ? { ...tick, value: { ...tick.value, liquidityGross: 1n } } : tick) }],
  ["slot0 tick outside V3 bounds", { ...readerFixture, slot0: { ...readerFixture.slot0, tick: 887273 } }],
  ["word left of helper range", stateReaderFixture({ tickSpacing: 60, initializedTicks: [[-26 * 256 * 60, 1000n]] })],
  ["word right of helper range", stateReaderFixture({ tickSpacing: 60, initializedTicks: [[25 * 256 * 60, 1000n]] })],
];
for (const [label, value] of malformedStates) {
  assert.throws(() => readFixture(value), `reject malformed aggregate: ${label}`);
}
const extraLeft = stateReaderFixture({ tickSpacing: 60, initializedTicks: [[-25 * 256 * 60, 1000n]] });
const clippedExtraLeft = readFixture(extraLeft);
assert.equal(clippedExtraLeft.tickBitmap.size, 49);
assert.equal(clippedExtraLeft.tickBitmap.has(-25), false);
assert.equal(clippedExtraLeft.ticks.size, 0, "valid helper-only extra word is not added to the local quote window");
assert.throws(() => readFixture({ ...extraLeft, ticks: [] }),
  "validate bitmap/tick consistency even in the extra word discarded from the local window");
const extraRight = stateReaderFixture({ tick: -1, tickSpacing: 60, initializedTicks: [[24 * 256 * 60, 1000n]] });
const clippedExtraRight = readFixture(extraRight);
assert.equal(clippedExtraRight.tickBitmap.size, 49);
assert.equal(clippedExtraRight.tickBitmap.has(24), false);
assert.equal(clippedExtraRight.ticks.size, 0, "negative boundary clips the helper-only right word instead");
assert.throws(() => readFixture({ ...extraRight, ticks: [] }),
  "discarding the helper-only right word must not hide malformed data");
assert.throws(() => readUniV3State(encodeStateReaderFixture(readerFixture), { ...readerDescriptor,
  factoryBinding: { ...readerDescriptor.factoryBinding, reversePool: FORGED_POOL } }),
  /pool|binding/, "returned pool must also match the descriptor's reverse-verified binding");
assert.throws(() => readUniV3State(encodeStateReaderFixture(readerFixture) + "00".repeat(32), readerDescriptor),
  /canonical/, "trailing data is not a canonical complete state response");
for (const tickSpacing of [0, -1, 1.5, NaN]) {
  assert.throws(() => readUniV3State(encodeStateReaderFixture(readerFixture), { ...readerDescriptor, tickSpacing }),
    "invalid descriptor spacing fails closed");
}
assert.deepEqual(localProgram.buildRequests({ ...exactInput, amountIn: 0n }), []);
assert.equal(localProgram.decode({ programInput: { ...exactInput, amountIn: 0n },
  initialResults: [], dependentEvidence: [] }).amountOut, 0n);
console.log("univ3 local amount: PASS (Uni/Pancake aggregates, unknown-factory TickLens, 49-word bounds, source, amounts, execution, Quoter switch)");
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

function stateReaderFixture(input: {
  readonly tick?: number;
  readonly tickSpacing?: number;
  readonly liquidity?: bigint;
  readonly feeProtocol?: number;
  readonly initializedTicks?: readonly (readonly [number, bigint])[];
} = {}) {
  const tick = input.tick ?? 0;
  const tickSpacing = input.tickSpacing ?? TICK_SPACING;
  const bitmap = new Map<number, bigint>();
  const ticks = (input.initializedTicks ?? []).map(([index, liquidityNet]) => {
    const compressed = Math.floor(index / tickSpacing);
    const word = compressed >> 8;
    bitmap.set(word, (bitmap.get(word) ?? 0n) | (1n << BigInt(compressed & 255)));
    return { index, value: {
      liquidityGross: liquidityNet < 0n ? -liquidityNet : liquidityNet === 0n ? 1n : liquidityNet,
      liquidityNet,
      tickCumulativeOutside: 0n,
      secondsPerLiquidityOutsideX128: 0n,
      secondsOutside: 0,
      initialized: true,
    } };
  });
  return {
    pool: POOL,
    blockTimestamp: 1_800_000_000n,
    slot0: { sqrtPriceX96: getSqrtRatioAtTick(tick), tick, observationIndex: 0,
      observationCardinality: 1, observationCardinalityNext: 1, feeProtocol: input.feeProtocol ?? 0, unlocked: true },
    liquidity: input.liquidity ?? LIQUIDITY,
    tickSpacing,
    maxLiquidityPerTick: (1n << 128n) - 1n,
    observation: { blockTimestamp: 1_800_000_000, tickCumulative: 0n,
      secondsPerLiquidityCumulativeX128: 0n, initialized: true },
    tickBitmap: [...bitmap].map(([index, value]) => ({ index, value })),
    ticks,
  };
}

function encodeStateReaderFixture(value: ReturnType<typeof stateReaderFixture>, iface = UNIV3_STATE_READER_INTERFACE): string {
  return iface.encodeFunctionResult("getFullStateWithRelativeBitmaps", [value]);
}

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
  reversePool: string | null,
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
  assert.equal(requests[0].completion, "return-or-revert-data");
  const reverseEvidence = identityVariant.decode({
    step: reverseStep,
    results: reversePool === null
      ? [declaredRevert("factory-get-pool")]
      : [success(
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

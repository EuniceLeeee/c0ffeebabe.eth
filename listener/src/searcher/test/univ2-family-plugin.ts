import assert from "node:assert/strict";
import generatedCapabilitiesArtifact from "../generated/family-capability-shadow.generated.json" with { type: "json" };
import { ethers } from "ethers";
import { inspectRuntime } from "./runtime-program-testkit.js";
import { cachedCanonicalAddress as canonicalAddress } from "../../shared/canonical-address.js";
import { univ2Adapter } from "../../adapters/univ2.js";
import { erc20TransferAdapter } from "../../adapters/erc20.js";
import type { TokenEdge } from "../planner/token-graph.js";
import previousV2 from "./fixtures/univ2-legacy-parity.json" with { type: "json" };
import type { StateBackend } from "../../shared/state/state-backend.js";
import type {
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "../adapter-work-intent.js";
import { createBoundedRequestExecutor } from
  "../venues/adapter-request-program.js";
import {
  quoteV2ExactInput as quoteV2ExactInputPure,
} from "../solver/v2-constant-product-math.js";
import {
  quoteV2ExactInput as quoteV2ExactInputLegacyExport,
} from "../solver/v2-fee.js";
import {
  definedFamilyPluginContractSummary,
  type ExactQuoteInput,
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
import { hashCanonical } from "../venues/canonical-value.js";
import {
  FAMILY_CAPABILITY_CONTRACT_VERSIONS,
} from "../venues/capability-content-hash.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITIES_BY_DOMAIN,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  type GeneratedCapabilityIdentity,
  type LoadedFamilyPlugin,
} from "../venues/family-capability-catalog.js";
import { plugin as univ2StrictFamilyPlugin } from "../venues/production-families/univ2-standard.production.js";
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_PATTERN_ID,
  UNIV2_PAIR_INTERFACE,
  UNIV2_SWAP_LOG_PATTERN_ID,
  UNIV2_SWAP_TOPIC,
  UNIV2_SYNC_LOG_PATTERN_ID,
  UNIV2_TOKEN_INTERFACE,
  UNIV2_POOL_QUOTE_INTERFACE,
} from "../venues/swaps/univ2-family/codec.js";
import { UNIV2_MAX_RESERVE } from "../venues/swaps/univ2-family/reserve-capacity.js";
import type {
  UniV2Candidate,
  UniV2Identity,
  UniV2IdentityEvidence,
  UniV2Descriptor,
  UniV2Route,
} from "../venues/swaps/univ2-family/types.js";
import { decodeRouterQuote, routerQuoteRequests, UNIV2_QUOTE_ROUTER_INTERFACE, uniV2QuoteRouter } from "../venues/swaps/univ2-family/test/router-quote-reference.js";
import { univ2BlockScanState } from "../venues/swaps/univ2-standard.js";

// The existing simulation regressions exercise an admitted fork without a
// nominated Router. Matched Router paths have their own contract cases below.
const FACTORY = ethers.getAddress("0x7777777777777777777777777777777777777777");
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

// Successful primitive-string normalization may be reused, not weakened.
const checkedAddress = ethers.getAddress("0x8ba1f109551bd432803012645ac136ddd64dba72");
const validAddressForms = [
  checkedAddress, checkedAddress.toLowerCase(),
  `0x${checkedAddress.slice(2).toUpperCase()}`, checkedAddress.slice(2),
  ethers.getIcapAddress(checkedAddress),
];
for (const value of validAddressForms) {
  assert.equal(canonicalAddress(value), ethers.getAddress(value));
  assert.equal(canonicalAddress(value), ethers.getAddress(value));
  assert.equal(canonicalAddress(value), canonicalAddress(checkedAddress));
}
const badChecksum = "0x8Ba1f109551bD432803012645Ac136ddd64DBA72";
const invalidAddressForms: unknown[] = [
  badChecksum, "", "0x123", "0x" + "gg".repeat(20),
  ` ${checkedAddress}`, `${checkedAddress} `,
  null, undefined, 42, {}, new String(checkedAddress),
];
function addressError(check: () => unknown) {
  try { check(); } catch (error) {
    const { message, code, argument, value, shortMessage } = error as Error & {
      code: string; argument: string; value: unknown; shortMessage: string;
    };
    return { message, code, argument, value, shortMessage };
  }
  assert.fail("invalid address unexpectedly accepted");
}
for (const value of invalidAddressForms) {
  const expected = addressError(() => ethers.getAddress(value as string));
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(addressError(() => canonicalAddress(value as string)), expected);
  }
}
// Churn beyond the bounded memo, then recheck both valid forms and the warmed
// lowercase/invalid mixed-case collision. Eviction cannot change acceptance.
for (let index = 1; index <= 5000; index++) {
  const value = ethers.toBeHex(index, 20);
  assert.equal(canonicalAddress(value), ethers.getAddress(value));
}
for (const value of validAddressForms) assert.equal(canonicalAddress(value), ethers.getAddress(value));
assert.deepEqual(
  addressError(() => canonicalAddress(badChecksum)),
  addressError(() => ethers.getAddress(badChecksum)),
);
console.log("univ2 canonical address memo: PASS (exact keys, native errors, ICAP, churn)");

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
  status: "chain-proven-rejected",
  reasonCode: "factory_reverse_binding_failed",
  evidenceRequestIds: ["factory-get-pair"],
});
assert.deepEqual(runIdentityDecision(candidate, FACTORY, null), {
  status: "chain-proven-rejected",
  reasonCode: "factory_reverse_binding_failed",
  evidenceRequestIds: ["factory-get-pair"],
}, "a pinned factory revert is chain-proven failed reverse binding");

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
// Outputs captured from the previous adapter before its retirement. Replay the
// JSON owner against these fixed values without importing the old implementation.
const legacyEdges: TokenEdge[] = previousV2.edges.map(edge => ({
  ...edge, v2FeeBps: BigInt(edge.v2FeeBps.$bigint),
})) as TokenEdge[];
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
    staticEvidence: {},
  });
const currentInput = { descriptor: pricingDescriptor, routes, source: SOURCE };
assert.deepEqual(
  univ2StrictFamilyPlugin.pricing.current.requirements(currentInput),
  { transports: ["eth-call"] },
);
const currentRequests =
  univ2StrictFamilyPlugin.pricing.current.buildRequests(currentInput);
assert.equal(currentRequests.length, 3, "reserves and both balances belong to one initial request set");
assert.equal(currentRequests[0].kind, "eth-call");
if (currentRequests[0].kind !== "eth-call") {
  throw new Error("univ2 current request must be eth-call");
}
assert.equal(currentRequests[0].to, POOL);
const currentResults = [success(currentRequests[0].id, reservesData),
  success("current-balance-0", UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [RESERVE0])),
  success("current-balance-1", UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [RESERVE1])),
];
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
assert.equal(strictMids.get(routes[0].routeKey)!.balanceHeadroomIn, UNIV2_MAX_RESERVE - RESERVE0);
assert.equal(strictMids.get(routes[1].routeKey)!.balanceHeadroomIn, UNIV2_MAX_RESERVE - RESERVE1);
const donatedMids = univ2StrictFamilyPlugin.pricing.current.deriveMids({
  descriptor: pricingDescriptor, routes,
  snapshot: { ...snapshot, balance0: UNIV2_MAX_RESERVE - 90n, balance1: UNIV2_MAX_RESERVE },
});
assert.equal(donatedMids.get(routes[0].routeKey)!.balanceHeadroomIn, 90n);
assert.equal(donatedMids.get(routes[1].routeKey)!.balanceHeadroomIn, 0n);
assert.equal(donatedMids.get(routes[0].routeKey)!.mid, strictMids.get(routes[0].routeKey)!.mid,
  "capacity uses actual balances; donations do not silently rewrite the reserve price");
assert.throws(() => univ2StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor, dependentEvidence: [],
  initialResults: currentResults.filter(result => result.id !== "current-balance-1"),
}), /result ids do not match requests/, "no reserve fallback for missing balance evidence");

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
  initialResults: [success(currentRequests[0].id, zeroData), ...currentResults.slice(1)],
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
    }, ...currentResults.slice(1)],
    dependentEvidence: [],
  }),
  /failed: rpc/,
  "RPC failure stays unresolved and cannot become behavior-unavailable",
);

const AMOUNT_IN = 1_000_000_000_000_000n;
const exactInput = {
  descriptor,
  route: routes[0],
  amountIn: AMOUNT_IN,
  source: SOURCE,
  executor: EXECUTOR,
  transactionOrigin: SENDER,
  runtimeEvidence: [],
};
const exactMethods = univ2StrictFamilyPlugin.exact.methods(exactInput);
const exactRequestMethod = exactMethods[1];
assert.equal(exactRequestMethod.kind, "request-program");
if (exactRequestMethod.kind !== "request-program") {
  throw new Error("univ2 exact remote method is missing");
}
assert.equal("chainAmountQuote" in exactRequestMethod
  ? exactRequestMethod.chainAmountQuote : undefined, undefined,
"ordinary V2 requires execution effects for every positive quote");
const exactProgram = exactRequestMethod.program;
const exactRequests = exactRequestMethod.program.buildRequests(exactInput);
assert.equal(exactRequests.length, 2);
assert.equal(exactRequests[1].kind, "eth-call");
const exactInitialResults = [
    success(exactRequests[0].id, reservesData),
    success(exactRequests[1].id, UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [RESERVE0])),
];
const strictExact = quoteWithState(exactInput, exactInitialResults);
// Capacity is directional and follows actual token balance, including donations.
// A rejected large amount must not poison a later legal smaller quote.
for (const route of routes) {
  for (const donation of [0n, 10n]) {
    const reserveIn = UNIV2_MAX_RESERVE - 100n;
    const balanceIn = reserveIn + donation;
    const capacity = 100n - donation;
    const pairReserves = route.direction === "zero-for-one"
      ? [reserveIn, UNIV2_MAX_RESERVE, TIMESTAMP]
      : [UNIV2_MAX_RESERVE, reserveIn, TIMESTAMP];
    for (const amountIn of [capacity + 1n, capacity, capacity / 2n]) {
      const quoted = quoteWithState({ ...exactInput, route, amountIn }, [
          success("exact-reserves", UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", pairReserves)),
          success("exact-input-balance", UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [balanceIn])),
        ]);
      assert.equal(quoted.evidence.amountIn, amountIn);
      assert.equal(quoted.evidence.unavailableReason,
        amountIn > capacity ? "input-reserve-capacity" : undefined);
      assert.equal(quoted.amountOut, amountIn > capacity ? 0n :
        quoteV2ExactInputPure(reserveIn, UNIV2_MAX_RESERVE, amountIn, 30n));
      if (amountIn <= capacity) assert(quoted.amountOut > 0n, "smaller legal amounts stay usable");
    }
  }
}
assert.throws(() => exactRequestMethod.program.decode({
  programInput: exactInput,
  initialResults: [
    success("exact-reserves", reservesData),
    { id: "exact-input-balance", ok: false, source: SOURCE, failure: "rpc" },
  ],
  dependentEvidence: [],
}), /required adapter request.*failed: rpc/, "unknown balance must not become a successful quote");
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
assert.equal(strictExact.amountOut, BigInt(previousV2.amountOut.$bigint));
assert.equal(strictExact.evidence.pool, POOL);
const strictFragment = univ2StrictFamilyPlugin.execution.buildFragment({
  descriptor,
  route: routes[0],
  amountIn: AMOUNT_IN,
  quotedAmountOut: strictExact.amountOut,
  minAmountOut: strictExact.amountOut,
  exactEvidence: strictExact.evidence,
  executor: EXECUTOR,
  transactionOrigin: SENDER,
  runtimeEvidence: [],
});
const traced=traceV2Fragment(strictFragment,exactInput,RESERVE0,RESERVE1,strictExact.amountOut);
assert.equal(traced.length,1);
assert.deepEqual([...UNIV2_PAIR_INTERFACE.decodeFunctionData("swap",traced[0]!.data)].slice(0,3),
  [...previousV2.swapOutputs.map(value => BigInt(value.$bigint)), EXECUTOR]);
assert.equal(strictFragment.nodes[0].adapterId, "univ2-swap");
assert.deepEqual(strictFragment.nodes[0].children, []);
assert.equal(univ2StrictFamilyPlugin.execution.runtimeProjection({ hop: {
  adapterId: "univ2-swap", target: POOL, tokenIn: TOKEN0, tokenOut: TOKEN1,
} }).allowanceSpender, null, "direct pair payment needs no router allowance");
assert.throws(
  () => univ2StrictFamilyPlugin.execution.buildFragment({
    descriptor,
    route: routes[0],
    amountIn: AMOUNT_IN,
    quotedAmountOut: strictExact.amountOut + 1n,
    minAmountOut: strictExact.amountOut,
    exactEvidence: strictExact.evidence,
    executor: EXECUTOR,
    transactionOrigin: SENDER,
    runtimeEvidence: [],
  }),
  /incompatible exact evidence/,
);

// Source-reserve local amount model: no actor/origin/overlay is needed to quote.
// Actual transfer eligibility remains a mandatory final-simulation concern.
type V2ExactInput = ExactQuoteInput<UniV2Descriptor, UniV2Route>;
for (const route of routes) {
  for (const feeBps of [25n, 30n]) {
    const changedDescriptor = { ...descriptor, feeRule: { ...descriptor.feeRule, feeBps } };
    const changedRoute = univ2StrictFamilyPlugin.routes.project({ descriptor:changedDescriptor }).find(r=>r.direction===route.direction)!;
    const input = { ...exactInput, route:changedRoute, amountIn:10_000_000n, descriptor:changedDescriptor };
    const initial = initialStateFor(input, 1_000_000_000n, 2_000_000_000n);
    const expected = quoteV2ExactInputPure(1_000_000_000n, 2_000_000_000n, input.amountIn, feeBps);
    assert.equal(exactProgram.buildDependentProgram!({programInput:input,initialResults:initial,completedRound:0,priorEvidence:[]}),null);
    const quote = quoteWithState(input, initial);
    assert.equal(quote.amountOut, expected);
    assert.equal(quote.evidence.kind,"univ2-reserves-exact");
    assert(quote.evidence.kind === "univ2-reserves-exact");
    const evidence = quote.evidence;
    const executionInput={...input,quotedAmountOut:expected,minAmountOut:expected,exactEvidence:quote.evidence};
    const fragment=univ2StrictFamilyPlugin.execution.buildFragment(executionInput);
    assert.deepEqual(fragment.requirements,[]);
    assert.deepEqual(fragment.nodes[0].children,[]);
    const swap=UNIV2_PAIR_INTERFACE.encodeFunctionData("swap",[
      route.direction==="zero-for-one"?0n:expected,route.direction==="zero-for-one"?expected:0n,EXECUTOR,"0x"]);
    assert.deepEqual(traceV2Fragment(fragment,input,1000000000n,2000000000n,expected),[{to:POOL,data:swap}]);
    for (const change of [{executor:FORGED_POOL},{transactionOrigin:FORGED_POOL},{transactionOrigin:undefined}]) {
      assert.equal(quoteWithState({...input,...change},initial).amountOut,expected);
      assert.deepEqual(univ2StrictFamilyPlugin.exact.cacheCompatibilityProjection(input),
        univ2StrictFamilyPlugin.exact.cacheCompatibilityProjection({...input,...change}));
    }
    for (const change of [{amountIn:input.amountIn+1n},{amountOut:expected+1n},{pool:FORGED_POOL},
      {tokenIn:route.tokenOut},{feeBps:feeBps+1n},{quoteModel:"pool-get-amount-out" as const}]) {
      assert.throws(()=>univ2StrictFamilyPlugin.execution.buildFragment({...executionInput,
        exactEvidence:{...evidence,...change}}),/incompatible/);
    }
    const decode=(initialResults:readonly AdapterRequestResult[])=>quoteWithState(input,initialResults);
    for(const invalid of [[],[initial[0],initial[0]],[initial[0]], [...initial,initial[0]]]) assert.throws(()=>decode(invalid),/result ids do not match requests/);
    for(const index of [0,1]) {
      for(const source of [{...SOURCE,number:SOURCE.number+1},{...SOURCE,hash:"0x"+"ef".repeat(32)},{...SOURCE,generation:SOURCE.generation+1}]) {
        assert.throws(()=>decode(initial.map((r,i)=>i===index?{...r,source}:r)),/source mismatch|foreign source/);
      }
      for(const failure of ["rpc","deadline","aborted","resource-limited"] as const) {
        assert.throws(()=>decode(initial.map((r,i)=>i===index?{id:r.id,ok:false,source:SOURCE,failure}:r)),/required adapter request.*failed/);
      }
      assert.throws(()=>decode(initial.map((r,i)=>i===index?{...r,completion:"reverted-as-declared"}:r)),/did not return/);
    }
    assert.throws(()=>exactProgram.decode({programInput:input,initialResults:initial,dependentEvidence:[{}]}),/read-flow is incomplete/);
  }
}
for (const input of [{ ...exactInput, amountIn: 0n }, { ...exactInput, amountIn: 1n },
  { ...exactInput, amountIn: UNIV2_MAX_RESERVE }]) {
  const initial = input.amountIn === 0n ? [] : exactInitialResults;
  assert.equal(quoteWithState({ ...input, transactionOrigin: undefined }, initial).amountOut, 0n);
}
for (const route of routes) {
  for (const balanceIn of [UNIV2_MAX_RESERVE, UNIV2_MAX_RESERVE + 1n]) {
    const input = { ...exactInput, route, amountIn: 1n };
    const quote = quoteWithState(input, initialStateFor(input, UNIV2_MAX_RESERVE-10n,UNIV2_MAX_RESERVE,balanceIn));
    assert.equal(quote.amountOut,0n);
    assert.equal(quote.evidence.unavailableReason,"input-reserve-capacity");
  }
}
assert.throws(()=>exactProgram.buildRequests({...exactInput,amountIn:-1n}),/negative/);
assert.throws(()=>quoteWithState(exactInput,[exactInitialResults[0],success("exact-input-balance","0x")]),/word|256/);
console.log("univ2 local amount: PASS (state/source/fee/capacity, no simulation, transfer-first execution)");

// Router is a source-bound amount quote, not a swap simulation or a new
// admission rule. All transport results here are mocks, not live acceptance.
assert(univ2StrictFamilyPlugin.exact);
for (const [factory, feeBps] of [
  ["0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f", 30n],
  ["0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac", 30n],
  ["0x1097053fd2ea711dad45caccc45eff7548fcb362", 25n],
] as const) {
  const routerIdentity = runIdentity({ ...candidate, hintedFactory: ethers.getAddress(factory) }, ethers.getAddress(factory), POOL);
  assert.equal(routerIdentity.facts.feeRule.feeBps, feeBps);
  const routerDescriptor = univ2StrictFamilyPlugin.instance.finalizeDescriptor({ identity: routerIdentity,
    draft: univ2StrictFamilyPlugin.instance.compileDraft(routerIdentity), sharedBindings: [] });
  const router = uniV2QuoteRouter(routerDescriptor);
  assert(router);
  for (const route of univ2StrictFamilyPlugin.routes.project({ descriptor: routerDescriptor })) {
    const reserveIn = route.direction === "zero-for-one" ? 1_000_000_000n : 2_000_000_000n;
    const reserveOut = route.direction === "zero-for-one" ? 2_000_000_000n : 1_000_000_000n;
    for (const amountIn of [1n, 1_000n, reserveIn / 100n, reserveIn / 2n]) {
      const input = { ...exactInput, descriptor: routerDescriptor, route, amountIn };
      const method = univ2StrictFamilyPlugin.exact.methods(input)[1];
      assert.equal(method.id, "pair-reserves");
      assert(method.kind === "request-program");
      assert.equal(method.chainAmountQuote, undefined);
      const requests = method.program.buildRequests(input);
      assert.deepEqual(requests.map(r => r.id), ["exact-reserves", "exact-input-balance"],
        "local default must not issue Router calls even for nominated infrastructures");
      assert(requests[0].kind === "eth-call" && requests[1].kind === "eth-call");
      assert.equal(requests[0].to, POOL);
      assert.equal(requests[1].to, route.tokenIn);
      const initial = initialStateFor(input, reserveIn, reserveOut);
      const quoted = method.program.decode({ programInput: input, initialResults: initial, dependentEvidence: [] });
      const out = quoteV2ExactInputPure(reserveIn, reserveOut, amountIn, feeBps);
      assert.equal(quoted.amountOut, out);
      assert(quoted.evidence.kind === "univ2-reserves-exact");
      const evidence = quoted.evidence;
      assert.deepEqual(quoted.evidence.source, SOURCE);
      assert.equal(quoted.evidence.tokenIn, route.tokenIn);
      assert.equal(quoted.evidence.tokenOut, route.tokenOut);
      assert.equal(quoted.evidence.feeBps, feeBps);
      assert.equal(quoted.evidence.amountIn, amountIn);
      assert.equal(method.program.buildDependentProgram!({ programInput: input, initialResults: initial,
        completedRound: 0, priorEvidence: [] }), null);
      const executionInput = { ...input, quotedAmountOut: out, minAmountOut: out, exactEvidence: quoted.evidence };
      if (out === 0n) {
        assert.throws(() => univ2StrictFamilyPlugin.execution.buildFragment(executionInput));
      } else {
        const fragment = univ2StrictFamilyPlugin.execution.buildFragment(executionInput);
        assert.deepEqual(fragment.requirements, []);
        assert.deepEqual(fragment.nodes[0].children, []);
        traceV2Fragment(fragment,input,reserveIn,reserveOut,out);
        if (out>1n) {
          const relaxed=univ2StrictFamilyPlugin.execution.buildFragment({...executionInput,minAmountOut:out-1n});
          traceV2Fragment(relaxed,input,reserveIn,reserveOut,out);
        } else {
          assert.throws(()=>univ2StrictFamilyPlugin.execution.buildFragment({...executionInput,minAmountOut:0n}));
        }
        for (const change of [{ amountIn: amountIn + 1n }, { amountOut: out + 1n }, { pool: FORGED_POOL },
          { tokenIn: route.tokenOut }, { tokenOut: route.tokenIn }, { feeBps: feeBps + 1n },
          { quoteModel: "pool-get-amount-out" as const }]) {
          assert.throws(() => univ2StrictFamilyPlugin.execution.buildFragment({ ...executionInput,
            exactEvidence: { ...evidence, ...change } }), /incompatible exact evidence/);
        }
      }
      if (amountIn === reserveIn / 2n) {
        assert(out < amountIn * (10_000n - feeBps) * reserveOut / (reserveIn * 10_000n),
          "large inputs must include price impact instead of scaling the spot price");
      }
    }
    const input = { ...exactInput, descriptor: routerDescriptor, route, amountIn: 1_000_000n,
      transactionOrigin: undefined };
    const method = univ2StrictFamilyPlugin.exact.methods(input)[1];
    assert(method.kind === "request-program"); assert.equal(method.id, "pair-reserves");
    const program = method.program;
    const localRequests = program.buildRequests(input);
    const routerRequests = routerQuoteRequests(routerDescriptor, route, input.amountIn);
    const requests = [...localRequests, ...routerRequests];
    assert.equal(requests.length, 5);
    assert(requests.every(r => r.kind === "eth-call"));
    const request = requests.find(r => r.id === "exact-router-amounts")!;
    assert(request.kind === "eth-call");
    assert.equal(request.to, router);
    const call = UNIV2_QUOTE_ROUTER_INTERFACE.decodeFunctionData("getAmountsOut", request.data);
    assert.equal(call.amountIn, input.amountIn);
    assert.deepEqual([...call.path], [route.tokenIn, route.tokenOut]);
    const out = quoteV2ExactInputPure(1_000_000_000n, 2_000_000_000n, input.amountIn, feeBps);
    const initial = [...initialStateFor(input, 1_000_000_000n, 2_000_000_000n),
      success("exact-router-factory", UNIV2_QUOTE_ROUTER_INTERFACE.encodeFunctionResult("factory", [factory])),
      success("exact-router-pair", UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [POOL])),
      success("exact-router-amounts", UNIV2_QUOTE_ROUTER_INTERFACE.encodeFunctionResult("getAmountsOut", [[input.amountIn, out]])),
    ];
    const decode = (results: readonly AdapterRequestResult[]) => {
      const localResults = results.filter(result => localRequests.some(request => request.id === result.id));
      const referenceResults = results.filter(result => routerRequests.some(request => request.id === result.id));
      const local = program.decode({ programInput: input, initialResults: localResults, dependentEvidence: [] });
      const reference = decodeRouterQuote(routerDescriptor, input.amountIn, out, SOURCE, referenceResults);
      return { local, reference };
    };
    assert.equal(program.buildDependentProgram!({ programInput: input, initialResults: initial.slice(0,2),
      completedRound: 0, priorEvidence: [] }), null, "local amount must not request a swap simulation");
    const { local, reference } = decode(initial);
    assert.equal(local.amountOut, out);
    assert.equal(reference.amountOut, local.amountOut);
    assert.equal(reference.router, router);
    // The independent view is a comparison, never executable evidence.
    assert.throws(() => univ2StrictFamilyPlugin.execution.buildFragment({ ...input,
      quotedAmountOut:out,minAmountOut:out-1n,exactEvidence:reference }));
    assert.deepEqual(routerQuoteRequests(routerDescriptor, route, input.amountIn), routerRequests);
    const replace = (id: string, data: string) => initial.map(r => r.id === id ? success(id, data) : r);
    assert.throws(() => decode(replace("exact-router-factory",
      UNIV2_QUOTE_ROUTER_INTERFACE.encodeFunctionResult("factory", [UNKNOWN_FACTORY]))), /factory\/pair mismatch/);
    assert.throws(() => decode(replace("exact-router-pair",
      UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [FORGED_POOL]))), /factory\/pair mismatch/);
    for (const amounts of [[input.amountIn + 1n, out], [input.amountIn], [input.amountIn, out, 1n]]) {
      assert.throws(() => decode(replace("exact-router-amounts",
        UNIV2_QUOTE_ROUTER_INTERFACE.encodeFunctionResult("getAmountsOut", [amounts]))), /incompatible amounts/);
    }
    assert.throws(() => decode(replace("exact-router-amounts",
      UNIV2_QUOTE_ROUTER_INTERFACE.encodeFunctionResult("getAmountsOut", [[input.amountIn, out + 1n]]))), /curve\/fee mismatch/);
    assert.throws(() => decode(replace("exact-router-amounts", initial[4].ok ? initial[4].data + "00" : "0x")), /incompatible amounts|invalid length/);
    assert.throws(() => decode(replace("exact-router-amounts", "0x")));
    assert.throws(() => decode(initial.slice(0, 4)), /ambiguous request/);
    for (const failure of ["rpc", "deadline", "aborted", "resource-limited"] as const) {
      assert.throws(() => decode(initial.map(r => r.id === "exact-router-amounts"
        ? { id: r.id, ok: false, source: SOURCE, failure } : r)), /unresolved/);
    }
    assert.throws(() => decode(initial.map(r => r.id === "exact-router-amounts"
      ? { ...success(r.id, "0x"), completion: "reverted-as-declared" } : r)), /did not return/);
    for (const source of [{ ...SOURCE, number: SOURCE.number + 1 }, { ...SOURCE, hash: `0x${"ef".repeat(32)}` },
      { ...SOURCE, generation: SOURCE.generation + 1 }]) {
      for (const index of [0, 1, 2, 3, 4]) assert.throws(() => decode(initial.map((r, i) => i === index ? { ...r, source } : r)), /source mismatch|foreign source/);
    }
    assert.throws(() => program.decode({ programInput: input, initialResults: initial.slice(0,2), dependentEvidence: [{}] }));
    const capped = decode(replace("exact-input-balance", UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [UNIV2_MAX_RESERVE])));
    assert.equal(capped.local.amountOut, 0n);
    assert.equal(capped.local.evidence.unavailableReason, "input-reserve-capacity");
    const zero = { ...input, amountIn: 0n };
    assert.deepEqual(program.buildRequests(zero), []);
    assert.equal(program.decode({ programInput: zero, initialResults: [], dependentEvidence: [] }).amountOut, 0n);
    const routerEvidence = reference;
    assert.throws(() => univ2StrictFamilyPlugin.execution.buildFragment({ ...input, quotedAmountOut: out, minAmountOut: out,
      exactEvidence: { ...routerEvidence, router: FORGED_POOL } }));
    assert.equal(uniV2QuoteRouter({ ...routerDescriptor, quoteModel: { kind: "pool-get-amount-out", probe0: 1n, probe1: 1n } }), null,
      "pool-owned curves never inherit a constant-product Router");
  }
}
assert.equal(uniV2QuoteRouter(descriptor), null, "unknown factories retain the existing quote method");
assert.deepEqual(routerQuoteRequests(descriptor, exactInput.route, exactInput.amountIn), []);
assert.equal(univ2StrictFamilyPlugin.exact.methods(exactInput)[1].id, "pair-reserves");
console.log("univ2 local default: PASS (3 infrastructures, both directions, 4 input sizes, price impact, no Router calls)");
console.log("univ2 Router quote: PASS (3 infrastructures, both directions, amount/source/pair/fee/capacity, no swap simulation)");

const summary = definedFamilyPluginContractSummary(univ2StrictFamilyPlugin);
assert.deepEqual(summary.ownedActionAdapterIds, ["univ2-swap"]);
assert.deepEqual(summary.requiredInfraActionAdapterIds, ["erc20-transfer"]);
assert.equal(univ2StrictFamilyPlugin.actionAdapters[0].descriptor.edgeKind, "swap");
const innerScript = new Uint8Array([1, 2, 3]);
assert.throws(()=>univ2StrictFamilyPlugin.actionAdapters[0].encode(strictFragment.nodes[0],EXECUTOR,innerScript));
assert(univ2StrictFamilyPlugin.actionAdapters[0].encode(strictFragment.nodes[0],EXECUTOR,new Uint8Array()).length>24);
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

// Inspect the same generated closure records used by the production catalog.
const sourceRecords = generatedCapabilitiesArtifact.exact.filter(record =>
  record.identity.familyId === univ2StrictFamilyPlugin.manifest.familyId);
for(const capability of ["discovery","identity","instance","routes","pricing","exact","execution","victim"]){
  const record=sourceRecords.find(row=>row.identity.capability===capability);
  assert(record,capability);
  assert(record.identity.semanticDependencies.some(dependency=>dependency.endsWith("/univ2-family/univ2.json")),capability);
}
for(const [capability,dependency] of [["exact","univ2-family/math.ts"],["execution","declarative-execution.ts"],["victim","declarative-swap-domain.ts"]]){
  assert(sourceRecords.find(r=>r.identity.capability===capability)!.identity.semanticDependencies.some(s=>s.endsWith(dependency)));
}
assert.equal(sourceRecords.find(r=>r.identity.capability==="victim")!.identity.contractVersion,FAMILY_CAPABILITY_CONTRACT_VERSIONS.victim);

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
assert(strictLifecycle.publication !== null, JSON.stringify(strictLifecycle, (_, v) => typeof v === "bigint" ? v.toString() : v));
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

const asVector = (value: unknown) => JSON.parse(JSON.stringify(value,
  (_, item) => typeof item === "bigint" ? { $bigint: item.toString() } : item));
assert.deepEqual(asVector(strictVictim.localApply), previousV2.local);
assert.deepEqual(asVector(strictVictim.exactPostState), previousV2.post);
assert.equal(strictVictim.overlay.preCalls[1].calldata, previousV2.overlayCalldata);
assert.equal(strictVictim.overlay.preCalls[1].to, previousV2.overlayTarget);
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

// A reverse-verified pool-owned curve must never reuse the reserve-ratio mid,
// factory's xyk fee, xyk victim overlay, or a former model's quote evidence.
const stableDecision = runIdentityDecision(unknownFactoryCandidate, UNKNOWN_FACTORY, POOL, {
  decimals0: 18, decimals1: 6,
});
assert.equal(stableDecision.status, "verified");
if (stableDecision.status !== "verified") throw new Error("pool-owned model not verified");
const stableDescriptor = univ2StrictFamilyPlugin.instance.finalizeDescriptor({
  identity: stableDecision.identity,
  draft: univ2StrictFamilyPlugin.instance.compileDraft(stableDecision.identity),
  sharedBindings: [],
});
assert.equal(stableDescriptor.quoteModel.kind, "pool-get-amount-out");
assert.equal(stableDescriptor.feeRule.kind, "included-in-pool-quote");
const stableRoutes = univ2StrictFamilyPlugin.routes.project({ descriptor: stableDescriptor });
assert.notEqual(stableRoutes[0].bindingRef.fingerprint, routes[0].bindingRef.fingerprint);
assert.notEqual(stableRoutes[0].bindingRef.fingerprint,
  univ2StrictFamilyPlugin.routes.project({descriptor: {...stableDescriptor, quoteModel: {kind: "constant-product"}}})[0].bindingRef.fingerprint,
  "changing only the model invalidates the route binding");
const stablePricing = univ2StrictFamilyPlugin.pricing.finalizePricingDescriptor({
  draft: univ2StrictFamilyPlugin.pricing.compileDraft({
    descriptor: stableDescriptor, routes: stableRoutes, stateKey: stableDescriptor.instanceKey,
  }), staticEvidence:{},
});
const stableSnapshot = univ2StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: stablePricing,
  initialResults: [
    success("current-reserves", reservesData),
    ...currentResults.slice(1),
    success("current-quote-0", UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionResult("getAmountOut", [99_998n])),
    success("current-quote-1", UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionResult("getAmountOut", [99_980_198_558_287_467n])),
  ], dependentEvidence: [],
});
const stableMids = univ2StrictFamilyPlugin.pricing.current.deriveMids({
  descriptor: stablePricing, snapshot: stableSnapshot, routes: stableRoutes,
});
assert(Math.abs(stableMids.get(stableRoutes[0].routeKey)!.mid * 1e12 - 0.99998) < 1e-12);
assert.equal(stableMids.get(stableRoutes[0].routeKey)!.feeBps, 0, "pool quote fees must not be charged twice");
assert.equal(stableMids.get(stableRoutes[0].routeKey)!.balanceHeadroomIn, UNIV2_MAX_RESERVE - RESERVE0);
assert.equal(univ2StrictFamilyPlugin.pricing.liveStateProjection!.project({
  descriptor: stablePricing, snapshot: stableSnapshot,
}), null, "do not seed a non-xyk model into the legacy xyk state cache");
assert.equal(univ2StrictFamilyPlugin.swap.replay.bind({
  descriptor: stableDescriptor, routes: stableRoutes, impact: strictVictimImpact,
}), null, "a stable curve cannot inherit the constant-product victim calculation");
const stableInput = { ...exactInput, descriptor: stableDescriptor, route: stableRoutes[0] };
for (const route of stableRoutes) {
  for (const amountIn of [17n, AMOUNT_IN, AMOUNT_IN * 3n]) {
    const input = { ...stableInput, route, amountIn };
    const method = univ2StrictFamilyPlugin.exact.methods(input)[1];
    assert.equal(method.kind, "request-program");
    if (method.kind !== "request-program") throw new Error("pool quote method missing");
    assert.equal("chainAmountQuote" in method ? method.chainAmountQuote : undefined, true,
      "only the verified pool-owned amount quote is eligible for effective pricing");
    const request = method.program.buildRequests(input).find(r => r.id === "exact-pool-quote");
    assert(request?.kind === "eth-call");
    const args = UNIV2_POOL_QUOTE_INTERFACE.decodeFunctionData("getAmountOut", request.data);
    assert.equal(String(args[0]).toLowerCase(), route.tokenIn.toLowerCase());
    assert.equal(args[1], amountIn, "preserve the explicit effective input in both directions");
    const result = method.program.decode({ programInput: input, initialResults: [
      success("exact-reserves", reservesData),
      success("exact-input-balance", UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [RESERVE0])),
      success("exact-pool-quote", UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionResult("getAmountOut", [123_457n])),
    ], dependentEvidence: [] });
    assert.equal(result.amountOut, 123_457n, "output comes from the pool, not a local formula");
    assert.equal(uniV2QuoteRouter(input.descriptor), null);
    assert.deepEqual(routerQuoteRequests(input.descriptor, input.route, input.amountIn), [],
      "the independent Router cannot replace a pool-owned curve");
  }
}
const stableRequests = exactRequestMethod.program.buildRequests(stableInput);
assert.equal(stableRequests.length, 3);
const stableQuote = exactRequestMethod.program.decode({
  programInput: stableInput,
  initialResults: [
    success("exact-reserves", reservesData),
    success("exact-input-balance", UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [RESERVE0])),
    success("exact-pool-quote", UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionResult("getAmountOut", [999n])),
  ], dependentEvidence: [],
});
assert.equal(stableQuote.amountOut, 999n, "use pool-owned quote, never an xyk substitute");
const stableFragment = univ2StrictFamilyPlugin.execution.buildFragment({
  ...stableInput, quotedAmountOut: stableQuote.amountOut, minAmountOut: stableQuote.amountOut,
  exactEvidence: stableQuote.evidence,
});
assert.equal(stableFragment.nodes.length, 1, "valid stable quote produces the normal V2-shaped swap action");
traceV2Fragment(stableFragment,stableInput,RESERVE0,RESERVE1,999n);
const stableInitial = [success("exact-reserves", reservesData),
  success("exact-input-balance", UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [RESERVE0])),
  success("exact-pool-quote", UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionResult("getAmountOut", [999n]))];
const stableBefore = structuredClone({ descriptor: stableDescriptor, routes: stableRoutes });
for (const route of stableRoutes) {
  const input = { ...stableInput, route, transactionOrigin: undefined };
  assert.equal(exactProgram.buildDependentProgram!({ programInput: input, completedRound: 0,
    initialResults: stableInitial, priorEvidence: [] }), null, "pool quote never enters simulation");
  const quoted = exactProgram.decode({ programInput: input, initialResults: stableInitial, dependentEvidence: [] });
  assert.equal(quoted.amountOut, 999n, "pool quote does not depend on controlled-simulation origin");
  assert.equal(quoted.evidence.kind, "univ2-pool-quote");
  const fragment = univ2StrictFamilyPlugin.execution.buildFragment({ ...input, quotedAmountOut: 999n,
    minAmountOut: 998n, exactEvidence: quoted.evidence });
  assert.deepEqual(fragment.requirements, []);
  traceV2Fragment(fragment,input,route.direction==="zero-for-one"?RESERVE0:RESERVE1,
    route.direction==="zero-for-one"?RESERVE1:RESERVE0,999n);
  assert.deepEqual(univ2StrictFamilyPlugin.exact.cacheCompatibilityProjection(input),
    univ2StrictFamilyPlugin.exact.cacheCompatibilityProjection({ ...input, transactionOrigin: FORGED_POOL }),
    "pool quote compatibility remains independent of simulation actors");
  for (const data of ["0x", UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionResult("getAmountOut", [0n])]) {
    assert.equal(exactProgram.decode({ programInput: input,
      initialResults: [...stableInitial.slice(0, 2), success("exact-pool-quote", data)], dependentEvidence: [] }).amountOut, 0n);
  }
  assert.equal(exactProgram.decode({ programInput: input,
    initialResults: [...stableInitial.slice(0, 2), { id: "exact-pool-quote", ok: true, source: SOURCE,
      provenance: PROVENANCE, completion: "reverted-as-declared", data: "0x" }], dependentEvidence: [] }).amountOut, 0n);
}
assert.deepEqual({ descriptor: stableDescriptor, routes: stableRoutes }, stableBefore,
  "quoting does not mutate pool identity/model or routes");
assert.throws(() => univ2StrictFamilyPlugin.execution.buildFragment({
  ...stableInput, quotedAmountOut: stableQuote.amountOut, minAmountOut: stableQuote.amountOut,
  exactEvidence: {...stableQuote.evidence, quoteModel: "constant-product"},
}), /incompatible exact evidence/, "changing only evidence model fails binding");
assert.throws(() => univ2StrictFamilyPlugin.execution.buildFragment({
  ...stableInput, quotedAmountOut: strictExact.amountOut, minAmountOut: strictExact.amountOut,
  exactEvidence: strictExact.evidence,
}), /execution read proof|incompatible exact evidence/);
const unavailableStable = runIdentityDecision(unknownFactoryCandidate, UNKNOWN_FACTORY, POOL, {
  decimals0: 18, decimals1: 6, surfaceReverts: true,
});
assert.equal(unavailableStable.status, "verified");
if (unavailableStable.status === "verified") assert.equal(unavailableStable.identity.facts.quoteModel.kind,
  "pool-get-amount-out", "getA evidence forbids xyk fallback even if both tiny quotes revert");
const oneWaySnapshot = {...stableSnapshot, quoted0: 0n};
assert.equal(univ2StrictFamilyPlugin.pricing.current.deriveMids({
  descriptor: stablePricing, snapshot: oneWaySnapshot, routes: stableRoutes,
}).size, 1, "one unavailable direction must not suppress the available reverse direction");
assert.equal(univ2StrictFamilyPlugin.pricing.current.classifyUnavailable!({
  descriptor: stablePricing, snapshot: oneWaySnapshot, routes: stableRoutes,
}).size, 1);

console.log(
  "univ2-family-plugin PASS " +
    "(strict seven-capability parity, reverse identity, carry, victim replay, ownership)",
);

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
    case "transfer-code-0":
    case "transfer-code-1":
      data = "0x6000";
      break;
    case "factory-get-pair":
      data = UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [POOL]);
      break;
    case "current-balance-0":
    case "current-balance-1":
      data = UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [request.id.endsWith("0") ? RESERVE0 : RESERVE1]);
      break;
    case "model-surface-0":
    case "model-surface-1":
    case "model-amplification":
    case "model-decimals-0":
    case "model-decimals-1":
      return declaredRevert(request.id);
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
  reversePool: string | null,
  ownQuote?: { decimals0: number; decimals1: number; surfaceReverts?: boolean },
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
  assert.deepEqual(identityVariant.requirements(reverseStep), { transports: ["eth-call", "get-code"] });
  const reverseRequests = identityVariant.buildRequests(reverseStep);
  assert.equal(reverseRequests.length, 8);
  assert.equal(reverseRequests[0].kind, "eth-call");
  if (reverseRequests[0].kind !== "eth-call") {
    throw new Error("univ2 reverse binding request must be eth-call");
  }
  assert.equal(reverseRequests[0].to, factory);
  assert.equal(reverseRequests[0].completion, "return-or-revert-data");
  const reverseEvidence = identityVariant.decode({
    step: reverseStep,
    results: [reversePool === null
      ? declaredRevert("factory-get-pair")
      : success(
          "factory-get-pair",
          UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [reversePool]),
        ),
      ...[0, 1].map((index) => ownQuote && !ownQuote.surfaceReverts
        ? success(`model-surface-${index}`, UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionResult("getAmountOut", [0n]))
        : declaredRevert(`model-surface-${index}`)),
      ownQuote ? success("model-amplification", UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionResult("getA", [850000n]))
        : declaredRevert("model-amplification"),
      ...[0, 1].map((index) => ownQuote
        ? success(`model-decimals-${index}`, UNIV2_TOKEN_INTERFACE.encodeFunctionResult("decimals", [index ? ownQuote.decimals1 : ownQuote.decimals0]))
        : declaredRevert(`model-decimals-${index}`)),
      success("transfer-code-0", "0x6000"),
      success("transfer-code-1", "0x6000"),
    ],
  }) as UniV2IdentityEvidence;
  const modelStep = {
    candidate: candidateInput,
    evidence: reverseEvidence,
    step: 2,
  };
  const decision = identityVariant.decide(modelStep);
  return decision;
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

function initialStateFor(input: V2ExactInput, reserveIn: bigint, reserveOut: bigint, balanceIn = reserveIn) {
  return [success("exact-reserves", UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves",
    input.route.direction === "zero-for-one" ? [reserveIn, reserveOut, TIMESTAMP] : [reserveOut, reserveIn, TIMESTAMP])),
    success("exact-input-balance", UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [balanceIn]))];
}

/** Exercise the actual VM program sent by the JSON plugin. A pool-quoted
 * subtype replies to its own quote before receiving the transfer. */
function traceV2Fragment(fragment:any, input:any, reserveIn:bigint, reserveOut:bigint, expected:bigint) {
  const pair=input.descriptor.pool.toLowerCase(), actor=input.executor.toLowerCase(), tokenIn=input.route.tokenIn.toLowerCase(), tokenOut=input.route.tokenOut.toLowerCase();
  const forward=input.route.direction==="zero-for-one";
  let spent=0n, moved=0n, received=0n;
  assert.deepEqual(fragment.requirements,[]);
  const backend={nativeBalance:()=>47n,call(c:import("./runtime-program-testkit.js").RuntimeCall):string {
    const target=c.target.toLowerCase(), selector=c.data.slice(0,10);
    if(selector===UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector)
      return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves",forward?[reserveIn,reserveOut,0]:[reserveOut,reserveIn,0]);
    if(selector==="0x70a08231"){
      const address=(UNIV2_TOKEN_INTERFACE.decodeFunctionData("balanceOf",c.data)[0] as string).toLowerCase();
      assert(address===pair||address===actor);
      const balance=address===pair?(target===tokenIn?reserveIn+spent:reserveOut-received):(target===tokenIn?input.amountIn+91n-spent:53n+received);
      return ethers.toBeHex(balance,32);
    }
    if(selector==="0xa9059cbb"){
      const [to,n]=ethers.AbiCoder.defaultAbiCoder().decode(["address","uint256"],"0x"+c.data.slice(10));
      assert.equal(target,tokenIn);assert.equal(to.toLowerCase(),pair);spent+=n;return ethers.toBeHex(1n,32);
    }
    assert.equal(target,pair);
    if(selector===UNIV2_POOL_QUOTE_INTERFACE.getFunction("getAmountOut")!.selector){
      assert.equal(spent,0n);return UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionResult("getAmountOut",[expected]);
    }
    const [a0,a1,to,callback]=UNIV2_PAIR_INTERFACE.decodeFunctionData("swap",c.data);
    if(callback!=="0x") {
      // Pair invokes the public callback with its actual output and tagged payment program.
      const tagged=ethers.getBytes(callback);
      assert.equal(tagged[0],14);
      assert.equal(Number(BigInt(ethers.hexlify(tagged.slice(33,36)))),tagged.length-36);
      const initial=BigInt(ethers.hexlify(tagged.slice(1,33)));
      assert.equal(initial,input.amountIn);
      const cb=new ethers.Interface(["function uniswapV2Call(address,uint256,uint256,bytes)"]);
      inspectRuntime(ethers.hexlify(tagged.slice(36)),initial,{...backend,calldata:cb.encodeFunctionData("uniswapV2Call",[input.executor,a0,a1,callback])});
    }
    assert.equal(to.toLowerCase(),actor);assert.equal(forward?a0:a1,0n);moved=a0+a1;received=moved;return "0x";
  }};
  const result=inspectRuntime(fragment.nodes[0].params.runtimeAmountProgram,input.amountIn,backend);
  assert.equal(spent,input.amountIn);assert.equal(received,expected);assert.equal(moved,expected);
  return result.calls.filter(c=>c.target.toLowerCase()===pair&&!c.static).map(c=>({to:c.target,data:c.data}));
}

function quoteWithState(input: V2ExactInput, initialResults: readonly AdapterRequestResult[]) {
  return exactProgram.decode({ programInput: input, initialResults, dependentEvidence: [] });
}

function decodeFixtureCalls(script: Uint8Array) {
  const calls: { to: string; data: string }[] = [];
  for (let offset = 0; offset < script.length;) {
    const op = script[offset++];
    if (op === 0x02) { offset += 3; continue; }
    if (op === 0x05) continue;
    assert.equal(op, 0x00, "fixture accepts only calls and V2 callback field setup/clear");
    const to = ethers.getAddress(ethers.hexlify(script.slice(offset, offset + 20)));
    offset += 20;
    const size = Number(BigInt(ethers.hexlify(script.slice(offset, offset + 3))));
    offset += 3;
    calls.push({ to, data: ethers.hexlify(script.slice(offset, offset + size)) });
    offset += size;
  }
  return calls;
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

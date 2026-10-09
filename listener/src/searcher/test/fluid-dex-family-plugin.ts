import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { createIdentityAssetMetadataPlan } from "../identity-asset-metadata.js";
import {
  definedFamilyPluginContractSummary,
  type UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../venues/adapter-request-program.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { fluidDexStrictFamilyPlugin } from
  "../venues/swaps/fluid-dex-family-plugin.js";
import {
  FLUID_DEX_CONSTANTS_INTERFACE,
  FLUID_DEX_ERC20_INTERFACE,
  FLUID_DEX_FACTORY_INTERFACE,
  FLUID_DEX_INTERFACE,
  FLUID_DEX_SWAP_SELECTOR,
  FLUID_DEX_NATIVE_TOKEN,
  describeFluidDexQuoteFailure,
} from "../venues/swaps/fluid-dex-family/codec.js";
import { FLUID_DEX_SWAP_CALL_PATTERN_ID } from
  "../venues/swaps/fluid-dex-family/discovery.js";
import type {
  FluidDexCandidate,
  FluidDexIdentity,
  FluidDexIdentityEvidence,
} from "../venues/swaps/fluid-dex-family/types.js";

const POOL = ethers.getAddress("0x1111111111111111111111111111111111111111");
const OTHER_POOL = ethers.getAddress("0x1212121212121212121212121212121212121212");
const FACTORY = ethers.getAddress("0x2222222222222222222222222222222222222222");
const TOKEN0 = ethers.getAddress("0x3333333333333333333333333333333333333333");
const TOKEN1 = ethers.getAddress("0x4444444444444444444444444444444444444444");
const EXECUTOR = ethers.getAddress("0x5555555555555555555555555555555555555555");
const DEX_ID = 17n;
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_001,
  hash: `0x${"bc".repeat(32)}`,
  generation: 10,
});
const PROVENANCE = Object.freeze({ kind: "fixture", fingerprint: "fluid-dex-v1" });

const observation: UnifiedObservation = Object.freeze({
  kind: "call",
  source: SOURCE,
  target: POOL,
  sender: EXECUTOR,
  data: FLUID_DEX_INTERFACE.encodeFunctionData("swapIn", [
    true,
    1_000_000n,
    0n,
    EXECUTOR,
  ]),
});
assert.equal(observation.data.slice(0, 10).toLowerCase(), FLUID_DEX_SWAP_SELECTOR);
const candidate = fluidDexStrictFamilyPlugin.discovery.decodeCandidate({
  observation,
  matchedPatternId: FLUID_DEX_SWAP_CALL_PATTERN_ID,
});
assert(candidate !== null);
assert.equal(candidate.pool, POOL);

const identity = runIdentity(candidate, POOL);
assert.equal(identity.facts.factoryBinding.reverseDex, POOL);
assert.equal(identity.facts.token0Decimals, 6);
assert.equal(identity.facts.token1Decimals, 6);
assert.equal(identity.facts.rawToken0, TOKEN0);
assert.equal(identity.facts.rawToken1, TOKEN1);
assert.equal(
  identity.facts.quoteBinding.successEncoding,
  "FluidDexSwapResult(uint256)-revert",
);

const forgedReverse = runThroughReverse(candidate, OTHER_POOL);
assert.deepEqual(
  fluidDexStrictFamilyPlugin.identity.variants[0].decide({
    candidate,
    evidence: forgedReverse,
    step: 2,
  }),
  { status: "chain-proven-rejected", reasonCode: "factory_reverse_binding_failed", evidenceRequestIds: ["factory-reverse-dex"] },
);
assert.throws(
  () => fluidDexStrictFamilyPlugin.identity.variants[0].decode({
    step: { candidate, step: 0 },
    results: [{
      id: "pool-constants",
      ok: false,
      source: SOURCE,
      failure: "rpc",
    }],
  }),
  /unresolved: rpc/,
  "ordinary transport failure cannot be decoded as unavailable",
);

const draft = fluidDexStrictFamilyPlugin.instance.compileDraft(identity);
const descriptor = fluidDexStrictFamilyPlugin.instance.finalizeDescriptor({
  identity,
  draft,
  sharedBindings: [],
});
const routes = fluidDexStrictFamilyPlugin.routes.project({ descriptor });
assert.deepEqual(
  routes.map((route) => [route.tokenIn, route.tokenOut, route.swap0To1]),
  [[TOKEN0, TOKEN1, true], [TOKEN1, TOKEN0, false]],
  "strict routes preserve the legacy bidirectional token order",
);
const route = routes[0];
const staticFingerprint = hashCanonical(
  fluidDexStrictFamilyPlugin.instance.staticBindingProjection(descriptor),
);
assert.notEqual(
  staticFingerprint,
  hashCanonical(fluidDexStrictFamilyPlugin.instance.staticBindingProjection({
    ...descriptor,
    factoryBinding: { ...descriptor.factoryBinding, dexId: DEX_ID + 1n },
  })),
  "dexId reverse binding participates in static compatibility",
);

const pricingDraft = fluidDexStrictFamilyPlugin.pricing.compileDraft({
  descriptor,
  stateKey: fluidDexStrictFamilyPlugin.pricing.stateKey(route),
  routes: [route],
});
const pricingDescriptor = fluidDexStrictFamilyPlugin.pricing
  .finalizePricingDescriptor({ draft: pricingDraft, sharedBindings: [] });
const currentInput = { descriptor: pricingDescriptor, routes: [route], source: SOURCE };
const currentRequests = fluidDexStrictFamilyPlugin.pricing.current
  .buildRequests(currentInput);
assert.equal(currentRequests.length, 1);
assert.equal(currentRequests[0].kind, "eth-call");
if (currentRequests[0].kind !== "eth-call") throw new Error("quote kind");
assert.equal(currentRequests[0].completion, "return-or-revert-data");
const currentResult = declaredRevert("current-fluid-dex-quote", 999_000n);
const snapshot = fluidDexStrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: [currentResult],
  dependentEvidence: [],
});
assert.equal(snapshot.amountIn, 1_000_000n);
assert.equal(snapshot.amountOut, 999_000n);
assert.equal(snapshot.completion, "reverted-as-declared");
assert.equal(
  fluidDexStrictFamilyPlugin.pricing.current.deriveMids({
    descriptor: pricingDescriptor,
    snapshot,
    routes: [route],
  }).size,
  1,
);
assert.throws(
  () => fluidDexStrictFamilyPlugin.pricing.current.decodeSnapshot({
    descriptor: pricingDescriptor,
    initialResults: [returnedCustomError("current-fluid-dex-quote", 999_000n)],
    dependentEvidence: [],
  }),
  /did not return its declared custom-error payload/,
  "an ordinary return cannot impersonate Fluid's declared revert quote",
);

const amountIn = 5_000_000n;
const exactInput = {
  descriptor,
  route,
  amountIn,
  source: SOURCE,
  executor: EXECUTOR,
  runtimeEvidence: [],
};
const exactRequestMethod = fluidDexStrictFamilyPlugin.exact.methods(exactInput)[1];
assert.equal(exactRequestMethod.kind, "request-program");
if (exactRequestMethod.kind !== "request-program") {
  throw new Error("Fluid exact request program missing");
}
const exactRequests = exactRequestMethod.program.buildRequests(exactInput);
assert.equal(exactRequests.length, 1);
assert.equal(exactRequests[0].kind, "eth-call");
if (exactRequests[0].kind !== "eth-call") throw new Error("exact quote kind");
assert.equal(exactRequests[0].completion, "return-or-revert-data");
const exact = exactRequestMethod.program.decode({
  programInput: exactInput,
  initialResults: [declaredRevert("exact-fluid-dex-declared-revert", 4_990_000n)],
  dependentEvidence: [],
});
assert.equal(exact.amountOut, 4_990_000n);
assert.equal(exact.evidence.completion, "reverted-as-declared");
assert.throws(
  () => exactRequestMethod.program.decode({
    programInput: exactInput,
    initialResults: [{
      id: "exact-fluid-dex-declared-revert",
      ok: false,
      source: SOURCE,
      failure: "deadline",
    }],
    dependentEvidence: [],
  }),
  /unresolved: deadline/,
  "ordinary failure remains unresolved and never becomes quote data",
);
assert.throws(
  () => exactRequestMethod.program.decode({
    programInput: exactInput,
    initialResults: [success(
      "exact-fluid-dex-declared-revert",
      `0xdeadbeef${ethers.zeroPadValue("0x01", 32).slice(2)}`,
      "reverted-as-declared",
    )],
    dependentEvidence: [],
  }),
  /lacked the declared FluidDexSwapResult revert/,
  "unknown custom errors fail closed",
);

const amountBoundaryRevert = success("exact-fluid-dex-declared-revert",
  "0x2fee3e0e000000000000000000000000000000000000000000000000000000000000c769",
  "reverted-as-declared");
assert.throws(() => exactRequestMethod.program.decode({
  programInput: { ...exactInput, amountIn: 38n },
  initialResults: [amountBoundaryRevert], dependentEvidence: [],
}), /selector=0x2fee3e0e error=FluidDexError code=51049 meaning=DexT1__LimitingAmountsSwapAndNonPerfectActions data=0x2fee3e0e/);
for (const rejected of [declaredRevert("exact-fluid-dex-declared-revert", 0n), returnedCustomError("exact-fluid-dex-declared-revert", 100n)]) {
  assert.throws(() => exactRequestMethod.program.decode({ programInput: exactInput,
    initialResults: [rejected], dependentEvidence: [] }), /error=FluidDexSwapResult/);
}
const longPayload = success("diagnostic", "0xdeadbeef" + "ab".repeat(1024), "reverted-as-declared");
assert(longPayload.ok);
const description = describeFluidDexQuoteFailure(longPayload);
assert(description.length < 512);
assert(description.includes("truncated=true"));
const malformedPayload = success("diagnostic", "https://example.invalid/private-key", "reverted-as-declared");
assert(malformedPayload.ok);
assert(!describeFluidDexQuoteFailure(malformedPayload).includes("example.invalid"));

const fragment = fluidDexStrictFamilyPlugin.execution.buildFragment({
  descriptor,
  route,
  amountIn,
  quotedAmountOut: exact.amountOut,
  minAmountOut: exact.amountOut,
  exactEvidence: exact.evidence,
  executor: EXECUTOR,
  runtimeEvidence: [],
});
assert.equal(fragment.nodes[0]?.adapterId, "fluid-dex-swap");
assert.equal(fragment.nodes[0]?.params.swap0to1, true);
assert.deepEqual(fragment.requirements, [], "temporary approvals are inside the raw action");
assert.equal(fragment.nodes[0]?.params.nativeInput, false);
assert.equal(fragment.nodes[0]?.params.nativeOutput, false);
assert.throws(
  () => fluidDexStrictFamilyPlugin.execution.buildFragment({
    descriptor,
    route,
    amountIn,
    quotedAmountOut: exact.amountOut,
    minAmountOut: exact.amountOut,
    exactEvidence: { ...exact.evidence, completion: "local-zero" },
    executor: EXECUTOR,
    runtimeEvidence: [],
  }),
  /incompatible exact evidence/,
);

const summary = definedFamilyPluginContractSummary(fluidDexStrictFamilyPlugin);
assert.equal(summary.domain, "swap");
assert.deepEqual(summary.suppliedActionAdapterIds, ["fluid-dex-swap"]);

// Central metadata fixtures prove the declaration contract, NOT historical
// ADDRESS_DEAD native quote success. Both real active probes remain mandatory.
for (const tokens of [[FLUID_DEX_NATIVE_TOKEN, TOKEN1], [TOKEN0, FLUID_DEX_NATIVE_TOKEN],
  [ADDR.WETH, TOKEN1]] as const) {
  const nativeIdentity = runIdentity(candidate, POOL, tokens);
  const d = fluidDexStrictFamilyPlugin.instance.finalizeDescriptor({ identity: nativeIdentity,
    draft: fluidDexStrictFamilyPlugin.instance.compileDraft(nativeIdentity), sharedBindings: [] });
  assert.equal(d.rawToken0, ethers.getAddress(tokens[0]));
  assert.equal(d.rawToken1, ethers.getAddress(tokens[1]));
  const projected = fluidDexStrictFamilyPlugin.routes.project({ descriptor: d });
  for (const r of projected) {
    const rawIn = r.swap0To1 ? tokens[0] : tokens[1], rawOut = r.swap0To1 ? tokens[1] : tokens[0];
    const nativeIn = rawIn === FLUID_DEX_NATIVE_TOKEN, nativeOut = rawOut === FLUID_DEX_NATIVE_TOKEN;
    assert.deepEqual(r.executionAssets, { input: nativeIn ? "native" : "erc20", output: nativeOut ? "native" : "erc20" });
    assert.equal(r.tokenIn, ethers.getAddress(nativeIn ? ADDR.WETH : rawIn));
    assert.equal(r.tokenOut, ethers.getAddress(nativeOut ? ADDR.WETH : rawOut));
  }
  const reverse = runThroughReverse(candidate, POOL, tokens);
  assert(reverse.phase === "reverse-binding");
  const probes = fluidDexStrictFamilyPlugin.identity.variants[0].buildRequests({ candidate, evidence: reverse, step: 2 });
  assert.equal(probes.length, 2);
  for (const [index, probe] of probes.entries()) {
    assert(probe.kind === "eth-call");
    assert(!Object.hasOwn(probe, "value"), "no invented direct eth-call value capability");
    const args = FLUID_DEX_INTERFACE.decodeFunctionData("swapIn", probe.data);
    assert.equal(args[0], index === 0);
    assert.equal(args[1], 10n ** BigInt(index === 0 ? d.token0Decimals : d.token1Decimals));
  }
  for (const badDirection of [0, 1]) {
    const results = [declaredRevert("active-quote-zero-to-one", 99n), declaredRevert("active-quote-one-to-zero", 98n)];
    results[badDirection] = returnedCustomError(results[badDirection].id, 99n);
    const behavior = fluidDexStrictFamilyPlugin.identity.variants[0].decode({
      step: { candidate, evidence: reverse, step: 2 }, results });
    const failed = fluidDexStrictFamilyPlugin.identity.variants[0].decide({ candidate, evidence: behavior, step: 3 });
    assert.equal(failed.status, "chain-proven-rejected", "neither active quote direction may be bypassed");
  }
  assert.equal(fluidDexStrictFamilyPlugin.identity.variants[0].decide({ candidate,
    evidence: runThroughReverse(candidate, OTHER_POOL, tokens), step: 2 }).status, "chain-proven-rejected");
}
assert.throws(() => runThroughReverse(candidate, POOL, [FLUID_DEX_NATIVE_TOKEN, ADDR.WETH]), /graph mapping conflict/);
const missingCode = runThroughReverse(candidate, POOL, [FLUID_DEX_NATIVE_TOKEN, TOKEN1], "0x");
assert(missingCode.phase === "reverse-binding");
assert.equal(missingCode.assets[0].kind, "native");
assert(!Object.hasOwn(missingCode.assets[0], "code"));
assert(!Object.hasOwn(missingCode, "token0HasCode"));
assert.equal(missingCode.assets[1].kind, "erc20");
assert.equal(missingCode.assets[1].decimals, null);
assert.equal(fluidDexStrictFamilyPlugin.identity.variants[0].decide({ candidate, evidence: missingCode, step: 2 }).status,
  "chain-proven-rejected", "an ERC20 with no code cannot become native");
assert.throws(() => runThroughReverse(candidate, POOL, [TOKEN0, TOKEN1], "0x6000", 37), /invalid decimals/);
console.log("fluid-dex-family-plugin PASS");

function runIdentity(
  input: FluidDexCandidate,
  reversePool: string,
  tokens: readonly [string, string] = [TOKEN0, TOKEN1],
): FluidDexIdentity {
  const variant = fluidDexStrictFamilyPlugin.identity.variants[0];
  const reverse = runThroughReverse(input, reversePool, tokens);
  const quoteRequests = variant.buildRequests({
    candidate: input,
    evidence: reverse,
    step: 2,
  });
  assert.equal(quoteRequests.length, 2);
  const behavior = variant.decode({
    step: { candidate: input, evidence: reverse, step: 2 },
    results: [
      declaredRevert("active-quote-zero-to-one", 999_000n),
      declaredRevert("active-quote-one-to-zero", 998_000n),
    ],
  }) as FluidDexIdentityEvidence;
  const decision = variant.decide({ candidate: input, evidence: behavior, step: 3 });
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("identity not verified");
  return decision.identity;
}

function runThroughReverse(
  input: FluidDexCandidate,
  reversePool: string,
  tokens: readonly [string, string] = [TOKEN0, TOKEN1],
  erc20Code = "0x6000",
  erc20Decimals = 6,
): FluidDexIdentityEvidence {
  const variant = fluidDexStrictFamilyPlugin.identity.variants[0];
  const constants = variant.decode({
    step: { candidate: input, step: 0 },
    results: [
      success("pool-constants", encodedConstants(tokens)),
      success("pool-code", "0x6000"),
    ],
  }) as FluidDexIdentityEvidence;
  assert.deepEqual(variant.decide({ candidate: input, evidence: constants, step: 1 }), {
    status: "continue",
  });
  const step = { candidate: input, evidence: constants, step: 1 };
  assert(variant.assets);
  const declarations = variant.assets(step);
  const plan = createIdentityAssetMetadataPlan(declarations, SOURCE);
  const familyRequests = variant.buildRequests(step);
  assert.deepEqual(familyRequests.map(r => r.id), ["factory-reverse-dex"], "asset reads are centrally appended in the same round");
  const requests = plan.append(familyRequests);
  assert.equal(requests.length, 1 + 2 * declarations.filter(a => a.kind === "erc20").length);
  const results = requests.map(request => {
    assert(request.kind === "eth-call" || request.kind === "get-code");
    const target = request.kind === "get-code" ? request.address : request.to;
    assert.notEqual(target.toLowerCase(), FLUID_DEX_NATIVE_TOKEN.toLowerCase(), "native has no ERC20 code/decimals query");
    if (request.id === "factory-reverse-dex") return success(request.id,
      FLUID_DEX_FACTORY_INTERFACE.encodeFunctionResult("getDexAddress", [reversePool]));
    return success(request.id, request.kind === "get-code" ? erc20Code
      : FLUID_DEX_ERC20_INTERFACE.encodeFunctionResult("decimals", [erc20Decimals]));
  });
  const assets = plan.decode(results);
  assert.throws(() => variant.decode({ step, results }), /metadata missing/);
  assert.throws(() => variant.decode({ step, results, assets: [assets[0], assets[0]] }), /metadata binding/);
  assert.throws(() => plan.decode(results.map(r => r.id.startsWith("central-asset:")
    ? { ...r, source: { ...SOURCE, number: SOURCE.number + 1 } } : r)), /source mismatch/);
  return variant.decode({ step, results, assets }) as FluidDexIdentityEvidence;
}

function encodedConstants(tokens: readonly [string, string] = [TOKEN0, TOKEN1]): string {
  const zero = ethers.ZeroAddress;
  const word = ethers.ZeroHash;
  return FLUID_DEX_CONSTANTS_INTERFACE.encodeFunctionResult("constantsView", [[
    DEX_ID,
    zero,
    FACTORY,
    [zero, zero, zero, zero, zero],
    zero,
    tokens[0],
    tokens[1],
    word,
    word,
    word,
    word,
    word,
    word,
    0n,
  ]]);
}

function declaredRevert(id: string, amountOut: bigint): AdapterRequestResult {
  return success(
    id,
    FLUID_DEX_INTERFACE.encodeErrorResult("FluidDexSwapResult", [amountOut]),
    "reverted-as-declared",
  );
}

function returnedCustomError(id: string, amountOut: bigint): AdapterRequestResult {
  return success(
    id,
    FLUID_DEX_INTERFACE.encodeErrorResult("FluidDexSwapResult", [amountOut]),
    "returned",
  );
}

function success(
  id: string,
  data: string,
  completion: "returned" | "reverted-as-declared" = "returned",
): AdapterRequestResult {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: PROVENANCE,
    completion,
    data,
  });
}

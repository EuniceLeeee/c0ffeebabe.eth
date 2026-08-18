import assert from "node:assert/strict";
import { ethers } from "ethers";
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
assert.equal(fragment.requirements[0]?.kind, "approve");
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
console.log("fluid-dex-family-plugin PASS");

function runIdentity(
  input: FluidDexCandidate,
  reversePool: string,
): FluidDexIdentity {
  const variant = fluidDexStrictFamilyPlugin.identity.variants[0];
  const reverse = runThroughReverse(input, reversePool);
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
): FluidDexIdentityEvidence {
  const variant = fluidDexStrictFamilyPlugin.identity.variants[0];
  const constants = variant.decode({
    step: { candidate: input, step: 0 },
    results: [
      success("pool-constants", encodedConstants()),
      success("pool-code", "0x6000"),
    ],
  }) as FluidDexIdentityEvidence;
  assert.deepEqual(variant.decide({ candidate: input, evidence: constants, step: 1 }), {
    status: "continue",
  });
  return variant.decode({
    step: { candidate: input, evidence: constants, step: 1 },
    results: [
      success(
        "factory-reverse-dex",
        FLUID_DEX_FACTORY_INTERFACE.encodeFunctionResult(
          "getDexAddress",
          [reversePool],
        ),
      ),
      success("token0-code", "0x6001"),
      success("token1-code", "0x6002"),
      success(
        "token0-decimals",
        FLUID_DEX_ERC20_INTERFACE.encodeFunctionResult("decimals", [6]),
      ),
      success(
        "token1-decimals",
        FLUID_DEX_ERC20_INTERFACE.encodeFunctionResult("decimals", [6]),
      ),
    ],
  }) as FluidDexIdentityEvidence;
}

function encodedConstants(): string {
  const zero = ethers.ZeroAddress;
  const word = ethers.ZeroHash;
  return FLUID_DEX_CONSTANTS_INTERFACE.encodeFunctionResult("constantsView", [[
    DEX_ID,
    zero,
    FACTORY,
    [zero, zero, zero, zero, zero],
    zero,
    TOKEN0,
    TOKEN1,
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

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
import { curveUnderlyingStrictFamilyPlugin } from
  "../venues/swaps/curve-underlying-family-plugin.js";
import {
  CURVE_BEHAVIOR_PROBE_AMOUNTS,
  CURVE_UNDERLYING_ERC20_INTERFACE,
  CURVE_UNDERLYING_I128_SELECTOR,
  CURVE_UNDERLYING_META_INTERFACE,
  CURVE_UNDERLYING_POOL_INTERFACE,
} from "../venues/swaps/curve-underlying-family/codec.js";
import { CURVE_UNDERLYING_I128_CALL_PATTERN_ID } from
  "../venues/swaps/curve-underlying-family/discovery.js";
import type {
  CurveUnderlyingCandidate,
  CurveUnderlyingIdentity,
  CurveUnderlyingIdentityEvidence,
} from "../venues/swaps/curve-underlying-family/types.js";

const POOL = ethers.getAddress("0x1111111111111111111111111111111111111111");
const TOKEN0 = ethers.getAddress("0x2222222222222222222222222222222222222222");
const TOKEN1 = ethers.getAddress("0x3333333333333333333333333333333333333333");
const HANDLER = ethers.getAddress("0x4444444444444444444444444444444444444444");
const EXECUTOR = ethers.getAddress("0x5555555555555555555555555555555555555555");
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_000,
  hash: `0x${"ab".repeat(32)}`,
  generation: 9,
});
const PROVENANCE = Object.freeze({ kind: "fixture", fingerprint: "curve-v1" });

const directCallObservation: UnifiedObservation = Object.freeze({
  kind: "call",
  source: SOURCE,
  target: POOL,
  sender: EXECUTOR,
  data: CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionData(
    "exchange_underlying",
    [0n, 1n, 1_000_000n, 0n],
  ),
});
assert.equal(
  directCallObservation.data.slice(0, 10).toLowerCase(),
  CURVE_UNDERLYING_I128_SELECTOR,
);
const candidate = curveUnderlyingStrictFamilyPlugin.discovery.decodeCandidate({
  observation: directCallObservation,
  matchedPatternId: CURVE_UNDERLYING_I128_CALL_PATTERN_ID,
});
assert(candidate !== null);
assert.equal(candidate.pool, POOL);
assert.equal(candidate.hintedI, 0);
assert.equal(candidate.hintedJ, 1);

const identity = runIdentity(candidate, [HANDLER]);
assert.equal(identity.subject, POOL);
assert.deepEqual(identity.facts.coins, [TOKEN0, TOKEN1]);
assert.equal(identity.facts.verifiedDirections.length, 1);
assert.deepEqual(
  identity.facts.verifiedDirections.map((direction) => [
    direction.i,
    direction.j,
    direction.tokenIn,
    direction.tokenOut,
  ]),
  [[0, 1, TOKEN0, TOKEN1]],
  "only the behavior-proven i/j direction is projected",
);

const noRegistryEvidence = runRegistryStep(candidate, []);
assert.deepEqual(
  curveUnderlyingStrictFamilyPlugin.identity.variants[0].decide({
    candidate,
    evidence: noRegistryEvidence,
    step: 1,
  }),
  { status: "chain-proven-rejected", reasonCode: "registry_reverse_binding_failed", evidenceRequestIds: ["registry-handlers"] },
  "a pool address is not admitted without dynamic MetaRegistry reverse proof",
);
assert.throws(
  () => curveUnderlyingStrictFamilyPlugin.identity.variants[0].decode({
    step: { candidate, step: 0 },
    results: [{
      id: "registry-handlers",
      ok: false,
      source: SOURCE,
      failure: "rpc",
    }],
  }),
  /unresolved: rpc/,
  "transport failure stays unresolved rather than becoming a negative identity",
);

const draft = curveUnderlyingStrictFamilyPlugin.instance.compileDraft(identity);
const descriptor = curveUnderlyingStrictFamilyPlugin.instance.finalizeDescriptor({
  identity,
  draft,
  sharedBindings: [],
});
const routes = curveUnderlyingStrictFamilyPlugin.routes.project({ descriptor });
assert.equal(routes.length, 1, "unquotable sibling direction is isolated");
const route = routes[0];
assert.equal(route.i, 0);
assert.equal(route.j, 1);
assert.equal(route.semantics, "exchange_underlying(i,j,dx,minDy)");

const staticFingerprint = hashCanonical(
  curveUnderlyingStrictFamilyPlugin.instance.staticBindingProjection(descriptor),
);
assert.notEqual(
  staticFingerprint,
  hashCanonical(curveUnderlyingStrictFamilyPlugin.instance.staticBindingProjection({
    ...descriptor,
    registryBinding: {
      ...descriptor.registryBinding,
      handlers: [ethers.ZeroAddress],
    },
  })),
  "registry binding changes invalidate the static descriptor",
);

const pricingDraft = curveUnderlyingStrictFamilyPlugin.pricing.compileDraft({
  descriptor,
  stateKey: curveUnderlyingStrictFamilyPlugin.pricing.stateKey(route),
  routes: [route],
});
const pricingDescriptor =
  curveUnderlyingStrictFamilyPlugin.pricing.finalizePricingDescriptor({
    draft: pricingDraft,
    sharedBindings: [],
  });
const currentInput = {
  descriptor: pricingDescriptor,
  routes: [route],
  source: SOURCE,
};
const currentRequests =
  curveUnderlyingStrictFamilyPlugin.pricing.current.buildRequests(currentInput);
assert.deepEqual(currentRequests.map((request) => request.id), [
  "current-registry-decimals",
  "current-registry-balances",
  "current-token-decimals",
]);
const initialResults = [
  success(
    "current-registry-decimals",
    CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult(
      "get_underlying_decimals",
      [[6n, 18n, 0n, 0n, 0n, 0n, 0n, 0n]],
    ),
  ),
  success(
    "current-registry-balances",
    CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult(
      "get_underlying_balances",
      [[1_000_000_000n, 2_000_000_000_000_000_000n, 0n, 0n, 0n, 0n, 0n, 0n]],
    ),
  ),
  success(
    "current-token-decimals",
    CURVE_UNDERLYING_ERC20_INTERFACE.encodeFunctionResult("decimals", [6]),
  ),
];
const dependentProgram =
  curveUnderlyingStrictFamilyPlugin.pricing.current.buildDependentProgram!({
    current: currentInput,
    completedRound: 0,
    initialResults,
    priorEvidence: [],
  });
assert(dependentProgram);
assert.equal(dependentProgram.requests.length, 1);
assert.equal(dependentProgram.requests[0].id, "current-get-dy:0");
const quoteData = CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionResult(
  "get_dy_underlying",
  [999_000_000_000_000_000n],
);
const snapshot =
  curveUnderlyingStrictFamilyPlugin.pricing.current.decodeSnapshot({
    descriptor: pricingDescriptor,
    initialResults,
    dependentEvidence: [dependentProgram.decode([
      success("current-get-dy:0", quoteData),
    ])],
  });
assert.equal(snapshot.amountIn, 1_000_000n);
assert.equal(snapshot.amountOut, 999_000_000_000_000_000n);
assert.equal(
  curveUnderlyingStrictFamilyPlugin.pricing.current.deriveMids({
    descriptor: pricingDescriptor,
    snapshot,
    routes: [route],
  }).size,
  1,
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
const exactRequestMethod = curveUnderlyingStrictFamilyPlugin.exact.methods(exactInput)[1];
assert.equal(exactRequestMethod.kind, "request-program");
if (exactRequestMethod.kind !== "request-program") {
  throw new Error("curve exact request program missing");
}
const exactRequests = exactRequestMethod.program.buildRequests(exactInput);
assert.equal(exactRequests.length, 1);
const exact = exactRequestMethod.program.decode({
  programInput: exactInput,
  initialResults: [success(
    "exact-get-dy-underlying",
    CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionResult(
      "get_dy_underlying",
      [4_995_000_000_000_000_000n],
    ),
  )],
  dependentEvidence: [],
});
assert.equal(exact.amountOut, 4_995_000_000_000_000_000n);
assert.throws(
  () => exactRequestMethod.program.decode({
    programInput: exactInput,
    initialResults: [{
      id: "exact-get-dy-underlying",
      ok: false,
      source: SOURCE,
      failure: "deadline",
    }],
    dependentEvidence: [],
  }),
  /unresolved: deadline/,
);
const fragment = curveUnderlyingStrictFamilyPlugin.execution.buildFragment({
  descriptor,
  route,
  amountIn,
  quotedAmountOut: exact.amountOut,
  minAmountOut: exact.amountOut,
  exactEvidence: exact.evidence,
  executor: EXECUTOR,
  runtimeEvidence: [],
});
assert.equal(fragment.nodes[0]?.adapterId, "curve-exchange-underlying");
assert.equal(fragment.nodes[0]?.params.i, 0n);
assert.equal(fragment.nodes[0]?.params.j, 1n);
assert.equal(
  fragment.requirements[0]?.kind,
  "approve",
  "strict plan preserves the legacy approve + exchange_underlying shape",
);
assert.throws(
  () => curveUnderlyingStrictFamilyPlugin.execution.buildFragment({
    descriptor,
    route,
    amountIn,
    quotedAmountOut: exact.amountOut + 1n,
    minAmountOut: exact.amountOut,
    exactEvidence: exact.evidence,
    executor: EXECUTOR,
    runtimeEvidence: [],
  }),
  /incompatible exact evidence/,
);

const summary = definedFamilyPluginContractSummary(
  curveUnderlyingStrictFamilyPlugin,
);
assert.equal(summary.domain, "swap");
assert.deepEqual(summary.suppliedActionAdapterIds, ["curve-exchange-underlying"]);
console.log("curve-underlying-family-plugin PASS");

function runIdentity(
  input: CurveUnderlyingCandidate,
  handlers: readonly string[],
): CurveUnderlyingIdentity {
  const variant = curveUnderlyingStrictFamilyPlugin.identity.variants[0];
  const registry = runRegistryStep(input, handlers);
  assert.deepEqual(variant.decide({ candidate: input, evidence: registry, step: 1 }), {
    status: "continue",
  });
  const behaviorRequests = variant.buildRequests({
    candidate: input,
    evidence: registry,
    step: 1,
  });
  assert(
    behaviorRequests.every((request) =>
      request.kind === "eth-call" &&
      request.completion === "return-or-revert-data"
    ),
    "behavior probes declare deterministic per-direction reverts",
  );
  const behaviorResults = behaviorRequests.map((request) => {
    const [, i, j, probe] = request.id.split(":");
    const positive = i === "0" && j === "1" && probe === "1";
    if (i === "1" && j === "0" && probe === "0") {
      return declaredRevert(request.id);
    }
    return success(
      request.id,
      CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionResult(
        "get_dy_underlying",
        [positive ? 2_000_000n : 0n],
      ),
    );
  });
  const behavior = variant.decode({
    step: { candidate: input, evidence: registry, step: 1 },
    results: behaviorResults,
  }) as CurveUnderlyingIdentityEvidence;
  const decision = variant.decide({
    candidate: input,
    evidence: behavior,
    step: 2,
  });
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("identity was not verified");
  return decision.identity;
}

function runRegistryStep(
  input: CurveUnderlyingCandidate,
  handlers: readonly string[],
): CurveUnderlyingIdentityEvidence {
  const paddedHandlers = [
    ...handlers,
    ...Array.from({ length: 10 - handlers.length }, () => ethers.ZeroAddress),
  ];
  return curveUnderlyingStrictFamilyPlugin.identity.variants[0].decode({
    step: { candidate: input, step: 0 },
    results: [
      success(
        "registry-handlers",
        CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult(
          "get_registry_handlers_from_pool",
          [paddedHandlers],
        ),
      ),
      success(
        "registry-underlying-coins",
        CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult(
          "get_underlying_coins",
          [[TOKEN0, TOKEN1, ...Array(6).fill(ethers.ZeroAddress)]],
        ),
      ),
      success("pool-code", "0x6000"),
    ],
  }) as CurveUnderlyingIdentityEvidence;
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

void CURVE_BEHAVIOR_PROBE_AMOUNTS;

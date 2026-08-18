import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { familyRouteCanonicalEdgeId } from "../adapter-family-graph-runtime.js";
import type { UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../venues/adapter-request-program.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { instanceKey } from "../venues/adapter-family-identifiers.js";
import { univ4StrictFamilyPlugin } from "../venues/swaps/univ4-family-plugin.js";
import {
  UNIV4_INITIALIZE_PATTERN_ID,
  UNIV4_SWAP_CALL_PATTERN_ID,
} from "../venues/swaps/univ4-family/codec.js";
import {
  UNIV4_POOL_MANAGER_INTERFACE,
  UNIV4_QUOTER_INTERFACE,
  UNIV4_STATE_VIEW_INTERFACE,
} from "../venues/swaps/univ4-abi.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_000,
  hash: `0x${"ab".repeat(32)}`,
  generation: 7,
});
const TOKEN0 = "0x1000000000000000000000000000000000000001";
const TOKEN1 = "0x2000000000000000000000000000000000000002";
const EXECUTOR = "0x3000000000000000000000000000000000000003";
const KEY = Object.freeze({
  currency0: TOKEN0,
  currency1: TOKEN1,
  fee: 3_000,
  tickSpacing: 60,
  hooks: ethers.ZeroAddress,
});
const POOL_ID = v4PoolId(KEY);
const Q96 = 1n << 96n;
// Deliberately below the scanner's 36 raw-unit reserve floor so this fixture
// exercises the declared dependent precision-read round.
const LIQUIDITY = 35n;

const initialize = UNIV4_POOL_MANAGER_INTERFACE.encodeEventLog(
  UNIV4_POOL_MANAGER_INTERFACE.getEvent("Initialize")!,
  [POOL_ID, TOKEN0, TOKEN1, KEY.fee, KEY.tickSpacing, KEY.hooks, Q96, 0],
);
const initializeObservation: UnifiedObservation = Object.freeze({
  kind: "log",
  source: SOURCE,
  address: ADDR.UNISWAP_V4_POOL_MANAGER,
  topics: Object.freeze(initialize.topics),
  data: initialize.data,
});
const initializeCandidate = univ4StrictFamilyPlugin.discovery.decodeCandidate({
  observation: initializeObservation,
  matchedPatternId: UNIV4_INITIALIZE_PATTERN_ID,
});
assert(initializeCandidate !== null);
assert.equal(initializeCandidate.poolId, POOL_ID);

const swapCalldata = UNIV4_POOL_MANAGER_INTERFACE.encodeFunctionData("swap", [
  KEY,
  { zeroForOne: true, amountSpecified: -1_000n, sqrtPriceLimitX96: 1n },
  "0x",
]);
const callCandidate = univ4StrictFamilyPlugin.discovery.decodeCandidate({
  observation: Object.freeze({
    kind: "call",
    source: SOURCE,
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    data: swapCalldata,
  }),
  matchedPatternId: UNIV4_SWAP_CALL_PATTERN_ID,
});
assert(callCandidate !== null);
assert.equal(callCandidate.poolId, POOL_ID);

const identityVariant = univ4StrictFamilyPlugin.identity.variants[0];
assert.deepEqual(
  identityVariant.decide({ candidate: initializeCandidate, step: 0 }),
  { status: "continue" },
);
assert.deepEqual(
  identityVariant.decide({
    candidate: { ...initializeCandidate, manager: EXECUTOR },
    step: 0,
  }),
  { status: "chain-proven-rejected", reasonCode: "foreign_pool_manager", evidenceRequestIds: [] },
);
assert.deepEqual(
  identityVariant.decide({
    candidate: { ...initializeCandidate, poolId: ethers.ZeroHash },
    step: 0,
  }),
  { status: "chain-proven-rejected", reasonCode: "poolkey_reverse_binding_failed", evidenceRequestIds: [] },
);
assert.deepEqual(
  identityVariant.decide({
    candidate: {
      ...initializeCandidate,
      poolId: v4PoolId({ ...KEY, hooks: EXECUTOR }),
      poolKey: { ...KEY, hooks: EXECUTOR },
    },
    step: 0,
  }),
  { status: "chain-proven-rejected", reasonCode: "unknown_hook_fail_closed", evidenceRequestIds: [] },
);
const verified = identityVariant.decide({
  candidate: initializeCandidate,
  step: 1,
  evidence: {
    phase: "manager-active-proof",
    managerCodeHash: `0x${"11".repeat(32)}`,
    sqrtPriceX96: Q96,
    liquidity: LIQUIDITY,
  },
});
assert.equal(verified.status, "verified");
if (verified.status !== "verified") throw new Error("univ4 identity fixture");

const draft = univ4StrictFamilyPlugin.instance.compileDraft(verified.identity);
const descriptor = univ4StrictFamilyPlugin.instance.finalizeDescriptor({
  identity: verified.identity,
  draft,
  sharedBindings: [],
});
const routes = univ4StrictFamilyPlugin.routes.project({ descriptor });
assert.equal(routes.length, 2);
assert.deepEqual(
  routes.map((route) => [route.tokenIn, route.tokenOut]),
  [[TOKEN0, TOKEN1], [TOKEN1, TOKEN0]],
);
const graph = univ4StrictFamilyPlugin.routes.projectGraph({
  descriptor,
  route: routes[0],
});
assert.equal(graph.routeActionAdapterId, "univ4-unlock");
assert.equal(graph.executionTarget, ADDR.UNISWAP_V4_POOL_MANAGER);
assert.deepEqual(graph.venueIdentity, {
  kind: "manager-pool-id",
  manager: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
  poolId: POOL_ID.toLowerCase(),
});

const siblingKey = Object.freeze({ ...KEY, fee: 500 });
const siblingPoolId = v4PoolId(siblingKey);
const siblingDescriptor = Object.freeze({
  ...descriptor,
  instanceKey: instanceKey(
    `${ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase()}\u001f${siblingPoolId}`,
  ),
  poolId: siblingPoolId,
  poolKey: siblingKey,
});
const siblingRoute = univ4StrictFamilyPlugin.routes.project({
  descriptor: siblingDescriptor,
})[0];
const siblingGraph = univ4StrictFamilyPlugin.routes.projectGraph({
  descriptor: siblingDescriptor,
  route: siblingRoute,
});
assert.equal(siblingGraph.executionTarget, graph.executionTarget);
assert.notEqual(
  hashCanonical(siblingGraph.venueIdentity),
  hashCanonical(graph.venueIdentity),
  "manager+poolId must distinguish two V4 venues sharing one singleton target",
);
assert.notEqual(
  familyRouteCanonicalEdgeId({ route: routes[0], graph }),
  familyRouteCanonicalEdgeId({ route: routes[0], graph: siblingGraph }),
  "canonical edge identity must bind V4 venue identity even when route fields match",
);
assert.notEqual(
  familyRouteCanonicalEdgeId({ route: routes[0], graph }),
  familyRouteCanonicalEdgeId({ route: siblingRoute, graph: siblingGraph }),
  "two V4 pools sharing one manager and token pair must not collide",
);
assert.notEqual(
  hashCanonical(univ4StrictFamilyPlugin.pricing.snapshotCompatibilityProjection({
    descriptor,
    routes,
  })),
  hashCanonical(univ4StrictFamilyPlugin.pricing.snapshotCompatibilityProjection({
    descriptor,
    routes: [routes[0]],
  })),
  "V4 snapshot compatibility stays direction-bound",
);

const pricingDraft = univ4StrictFamilyPlugin.pricing.compileDraft({
  descriptor,
  stateKey: POOL_ID,
  routes,
});
const pricingDescriptor =
  univ4StrictFamilyPlugin.pricing.finalizePricingDescriptor({
    draft: pricingDraft,
    sharedBindings: [],
  });
const currentInput = { descriptor: pricingDescriptor, routes, source: SOURCE };
const coreResults = [
  success(
    "current-slot0",
    UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult(
      "getSlot0",
      [Q96, 0, 0, KEY.fee],
    ),
  ),
  success(
    "current-liquidity",
    UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult(
      "getLiquidity",
      [LIQUIDITY],
    ),
  ),
];
assert.equal(
  univ4StrictFamilyPlugin.pricing.current.buildRequests(currentInput).length,
  2,
);
const dependentProgram = univ4StrictFamilyPlugin.pricing.current
  .buildDependentProgram!({
    current: currentInput,
    completedRound: 0,
    initialResults: coreResults,
    priorEvidence: [],
  });
assert(dependentProgram);
const dependentResults = dependentProgram.requests.map((request) => {
    if (request.kind !== "eth-call") throw new Error("precision request kind");
    const decoded = UNIV4_QUOTER_INTERFACE.decodeFunctionData(
      "quoteExactInputSingle",
      request.data,
    );
    return success(
      request.id,
      UNIV4_QUOTER_INTERFACE.encodeFunctionResult(
        "quoteExactInputSingle",
        [BigInt(decoded.params.exactAmount), 50_000n],
      ),
    );
  });
const snapshot = univ4StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: coreResults,
  dependentEvidence: [dependentProgram.decode(dependentResults)],
});
assert.equal(snapshot.source.hash, SOURCE.hash);
assert.equal(
  univ4StrictFamilyPlugin.pricing.current.deriveMids({
    descriptor: pricingDescriptor,
    snapshot,
    routes,
  }).size,
  2,
);
assert.throws(
  () => univ4StrictFamilyPlugin.pricing.current.decodeSnapshot({
    descriptor: pricingDescriptor,
    initialResults: [
      { id: "current-slot0", ok: false, source: SOURCE, failure: "rpc" },
      coreResults[1],
    ],
    dependentEvidence: [],
  }),
  /unresolved: rpc/,
);

const amountIn = 1_000_000n;
const exactInput = {
  descriptor,
  route: routes[0],
  amountIn,
  source: SOURCE,
  executor: EXECUTOR,
  runtimeEvidence: [],
};
const exactRequestMethod = univ4StrictFamilyPlugin.exact.methods(exactInput)[1];
assert.equal(exactRequestMethod.kind, "request-program");
if (exactRequestMethod.kind !== "request-program") {
  throw new Error("univ4 exact request program missing");
}
const exactRequest = exactRequestMethod.program.buildRequests(exactInput)[0];
const exact = exactRequestMethod.program.decode({
  programInput: exactInput,
  initialResults: [success(
    exactRequest.id,
    UNIV4_QUOTER_INTERFACE.encodeFunctionResult(
      "quoteExactInputSingle",
      [900_000n, 70_000n],
    ),
  )],
  dependentEvidence: [],
});
assert.equal(exact.amountOut, 900_000n);
const fragment = univ4StrictFamilyPlugin.execution.buildFragment({
  descriptor,
  route: routes[0],
  amountIn,
  quotedAmountOut: exact.amountOut,
  minAmountOut: exact.amountOut,
  exactEvidence: exact.evidence,
  executor: EXECUTOR,
  runtimeEvidence: [],
});
assert.equal(fragment.nodes[0].adapterId, "univ4-unlock");
assert.throws(
  () => univ4StrictFamilyPlugin.execution.buildFragment({
    descriptor,
    route: routes[0],
    amountIn,
    quotedAmountOut: exact.amountOut + 1n,
    minAmountOut: exact.amountOut,
    exactEvidence: exact.evidence,
    executor: EXECUTOR,
    runtimeEvidence: [],
  }),
  /incompatible exact evidence/,
);

const swapLog = UNIV4_POOL_MANAGER_INTERFACE.encodeEventLog(
  UNIV4_POOL_MANAGER_INTERFACE.getEvent("Swap")!,
  [POOL_ID, EXECUTOR, -amountIn, exact.amountOut, Q96, LIQUIDITY, 0, KEY.fee],
);
const swapObservation: UnifiedObservation = Object.freeze({
  kind: "log",
  source: SOURCE,
  address: ADDR.UNISWAP_V4_POOL_MANAGER,
  topics: Object.freeze(swapLog.topics),
  data: swapLog.data,
});
const observed = univ4StrictFamilyPlugin.swap.observation.decode({
  observation: swapObservation,
});
assert.equal(observed.length, 1);
assert.equal(
  (observed[0].canonicalPayload as { readonly amountOut: bigint }).amountOut,
  exact.amountOut,
);
const impact = {
  pool: ADDR.UNISWAP_V4_POOL_MANAGER,
  tokenIn: TOKEN0,
  tokenOut: TOKEN1,
  amountIn,
  amountOut: exact.amountOut,
  exactPostState: {
    poolId: POOL_ID,
    sqrtPriceX96: Q96,
    tick: 0,
    liquidity: LIQUIDITY,
    lpFee: KEY.fee,
  },
};
assert.equal(
  univ4StrictFamilyPlugin.swap.replay!.bind({ descriptor, routes, impact }),
  routes[0],
);
assert.equal(
  (univ4StrictFamilyPlugin.swap.replay!.exactPostState!({
    descriptor,
    route: routes[0],
    impact,
    source: SOURCE,
  }) as { readonly kind: string } | null)?.kind,
  "v4",
);

const summary = definedFamilyPluginContractSummary(univ4StrictFamilyPlugin);
assert.equal(summary.familyId, "univ4");
assert.equal(new Set(summary.ownedActionAdapterIds).size, 6);
console.log("univ4 strict Family plugin tests passed");

function success(
  id: string,
  data: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: Object.freeze({ kind: "fixture", fingerprint: id }),
    completion: "returned" as const,
    data,
  });
}

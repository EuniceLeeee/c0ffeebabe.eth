import assert from "node:assert/strict";
import { ethers } from "ethers";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
  ObservedEffects,
} from "../../../adapter-request-program.js";
import type { UnifiedObservation } from "../../../adapter-family-plugin.js";
import { hashCanonical } from "../../../canonical-value.js";
import { assertDefaultCollateralInvocation } from "../binding.js";
import { defaultCollateralCapture } from "../capture.js";
import {
  DEFAULT_COLLATERAL_ASSET,
  DEFAULT_COLLATERAL_ASSET_CODE_HASH,
  DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE,
  DEFAULT_COLLATERAL_IMPLEMENTATION,
  DEFAULT_COLLATERAL_IMPLEMENTATION_CODE_HASH,
  DEFAULT_COLLATERAL_INTERFACE,
  DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
  DEFAULT_COLLATERAL_PROBE_RECEIVER,
  DEFAULT_COLLATERAL_SHARE_CODE_HASH,
  DEFAULT_COLLATERAL_SHARE_VAULT,
  DEFAULT_COLLATERAL_TRANSFER_TOPIC,
  DEFAULT_COLLATERAL_WITHDRAW_SELECTOR,
  DEFAULT_COLLATERAL_WITHDRAW_TOPIC,
  declaredCallRequest,
  defaultCollateralCloneCode,
  defaultCollateralQuote,
  eip1167Implementation,
} from "../codec.js";
import { defaultCollateralDiscovery } from "../discovery.js";
import { defaultCollateralExact } from "../exact.js";
import { defaultCollateralExecution } from "../execution.js";
import { defaultCollateralFamilyOwnedAction } from "../action.js";
import { defaultCollateralIdentity } from "../identity.js";
import { defaultCollateralInstance } from "../instance.js";
import {
  DEFAULT_COLLATERAL_ACTION_ID,
  DEFAULT_COLLATERAL_FAMILY_ID,
  DEFAULT_COLLATERAL_LINEAGE_ID,
} from "../manifest.js";
import { defaultCollateralPricing } from "../pricing.js";
import { defaultCollateralRoutes } from "../routes.js";
import type {
  DefaultCollateralActiveEvidence,
  DefaultCollateralBaseEvidence,
  DefaultCollateralCandidate,
  DefaultCollateralDescriptor,
  DefaultCollateralIdentity,
  DefaultCollateralIdentityEvidence,
  DefaultCollateralPricingDescriptor,
  DefaultCollateralRoute,
  DefaultCollateralSurfaceEvidence,
} from "../types.js";
import { IMPLEMENTATION_CODE, ASSET_CODE } from "./bytecode.js";
import { activation, plugin } from
  "../../../production-families/default-collateral.production.js";

// Same-state fixture at the observed transaction block N=26244778 (block hash
// and totalSupply read with a block tag). The code strings are the verified
// deployment runtimes, so the pinned code hashes are exercised without RPC.
const SOURCE: CanonicalSource = Object.freeze({
  number: 26_244_778,
  hash: "0x4d8e7ee76e1d7ce145a752ae4185056d13c83f3b1de57fffe0a1282ef8c39646",
  generation: 26_244_778,
});
const SUPPLY = 59_297_263_277_881_699_980n;
const PROBE_ACTOR = "0x000000000000000000000000000000000000bee2";
const ZERO_TOPIC = `0x${"0".repeat(64)}`;
const IMPL_CODE_HASH = ethers.keccak256(IMPLEMENTATION_CODE);
const ASSET_CODE_HASH = ethers.keccak256(ASSET_CODE);
const CLONE_CODE = defaultCollateralCloneCode(DEFAULT_COLLATERAL_IMPLEMENTATION);
const CANDIDATE: DefaultCollateralCandidate = Object.freeze({
  candidateKind: "default-collateral-share-vault",
  vault: DEFAULT_COLLATERAL_SHARE_VAULT,
});
const PROVENANCE = Object.freeze({
  kind: "test-transport",
  fingerprint: "0x" + "11".repeat(32),
});

assert.equal(IMPL_CODE_HASH, DEFAULT_COLLATERAL_IMPLEMENTATION_CODE_HASH);
assert.equal(ASSET_CODE_HASH, DEFAULT_COLLATERAL_ASSET_CODE_HASH);
assert.equal(
  ethers.keccak256(CLONE_CODE),
  DEFAULT_COLLATERAL_SHARE_CODE_HASH,
);

function padded(address: string): string {
  return `0x${"0".repeat(24)}${ethers.getAddress(address).slice(2)}`.toLowerCase();
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function returned(id: string, data: string, effects?: ObservedEffects):
  Extract<AdapterRequestResult, { readonly ok: true }> {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: PROVENANCE,
    completion: "returned" as const,
    data,
    ...(effects === undefined ? {} : { effects }),
  });
}

function reverted(id: string, data = "0x"):
  Extract<AdapterRequestResult, { readonly ok: true }> {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: PROVENANCE,
    completion: "reverted-as-declared" as const,
    data,
  });
}

function baseResults(options: {
  readonly code?: string;
  readonly asset?: string;
  readonly decimals?: bigint;
  readonly supply?: bigint;
} = {}): readonly AdapterRequestResult[] {
  return Object.freeze([
    returned("base-share-code", options.code ?? CLONE_CODE),
    returned(
      "base-asset",
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("asset", [
        options.asset ?? DEFAULT_COLLATERAL_ASSET,
      ]),
    ),
    returned(
      "base-decimals",
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("decimals", [
        options.decimals ?? 18n,
      ]),
    ),
    returned(
      "base-total-supply",
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("totalSupply", [
        options.supply ?? SUPPLY,
      ]),
    ),
  ]);
}

function surfaceResults(options: {
  readonly implementationCode?: string;
  readonly assetCode?: string;
  readonly backing?: bigint;
} = {}): readonly AdapterRequestResult[] {
  return Object.freeze([
    returned(
      "surface-implementation-code",
      options.implementationCode ?? IMPLEMENTATION_CODE,
    ),
    returned("surface-asset-code", options.assetCode ?? ASSET_CODE),
    returned(
      "surface-backing",
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("balanceOf", [
        options.backing ?? SUPPLY,
      ]),
    ),
  ]);
}

function burnLogs(sample: bigint, receipt: bigint): ObservedEffects {
  return {
    tokenDeltas: [{
      token: DEFAULT_COLLATERAL_ASSET,
      account: DEFAULT_COLLATERAL_PROBE_RECEIVER,
      delta: receipt,
    }],
    totalSupplyDeltas: [{ token: DEFAULT_COLLATERAL_SHARE_VAULT, delta: -sample }],
    logs: [
      {
        address: DEFAULT_COLLATERAL_SHARE_VAULT,
        topics: [
          DEFAULT_COLLATERAL_TRANSFER_TOPIC,
          padded(PROBE_ACTOR),
          ZERO_TOPIC,
        ],
        data: word(sample),
      },
      {
        address: DEFAULT_COLLATERAL_SHARE_VAULT,
        topics: [
          DEFAULT_COLLATERAL_WITHDRAW_TOPIC,
          padded(DEFAULT_COLLATERAL_PROBE_RECEIVER),
          padded(PROBE_ACTOR),
        ],
        data: word(sample),
      },
    ],
  };
}

function activeResults(
  evidence: DefaultCollateralSurfaceEvidence,
  receipt?: bigint,
): readonly AdapterRequestResult[] {
  const sample = DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE < evidence.totalSupply
    ? DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE
    : evidence.totalSupply / 1000n;
  return Object.freeze([
    returned("active-withdraw", "0x", burnLogs(sample, receipt ?? sample)),
  ]);
}

const variant = defaultCollateralIdentity.variants[0]!;

function decode(
  evidence: DefaultCollateralIdentityEvidence | undefined,
  results: readonly AdapterRequestResult[],
  step = 0,
): DefaultCollateralIdentityEvidence {
  return variant.decode({
    step: { candidate: CANDIDATE, evidence, step },
    results,
  }) as DefaultCollateralIdentityEvidence;
}

function decide(evidence: DefaultCollateralIdentityEvidence, step = 1) {
  return variant.decide({ candidate: CANDIDATE, evidence, step });
}

// ---------------------------------------------------------------------------
// 1. EIP-1167 clone identity + pinned runtime code hashes
// ---------------------------------------------------------------------------
assert.equal(eip1167Implementation(CLONE_CODE), ethers.getAddress(
  DEFAULT_COLLATERAL_IMPLEMENTATION,
));
assert.equal(
  ethers.keccak256(CLONE_CODE),
  DEFAULT_COLLATERAL_SHARE_CODE_HASH,
);
assert.throws(() => eip1167Implementation(ASSET_CODE), /45-byte EIP-1167/);
assert.throws(
  () => eip1167Implementation("0x363d3d373d3d3d363d73" + "11".repeat(20) +
    "5af43d82803e903d91602b57fd5bf4"),
  /EIP-1167 minimal proxy/,
);

// ---------------------------------------------------------------------------
// 2. identity accept at N with the observed vault (base -> surface -> active)
// ---------------------------------------------------------------------------
const base = decode(undefined, baseResults()) as DefaultCollateralBaseEvidence;
assert.equal(base.phase, "base");
assert.equal(base.shareIsClone, true);
assert.equal(base.asset.toLowerCase(), DEFAULT_COLLATERAL_ASSET.toLowerCase());
assert.equal(base.decimals, 18n);
assert.equal(base.totalSupply, SUPPLY);
assert.deepEqual(decide(base), { status: "continue" });
assert.deepEqual(
  variant.requirements({ candidate: CANDIDATE, evidence: base, step: 1 }),
  { transports: ["get-code", "eth-call"] },
);
assert.deepEqual(
  variant.buildRequests({ candidate: CANDIDATE, evidence: base, step: 1 })
    .map((request) => request.id),
  ["surface-implementation-code", "surface-asset-code", "surface-backing"],
);

const surface = decode(
  base,
  surfaceResults(),
  1,
) as DefaultCollateralSurfaceEvidence;
assert.equal(surface.phase, "surface");
assert.equal(surface.implementationCodeHash, IMPL_CODE_HASH);
assert.equal(surface.assetCodeHash, ASSET_CODE_HASH);
assert.equal(surface.backing, SUPPLY);
assert.equal(surface.invariantProven, true);
assert.deepEqual(decide(surface), { status: "continue" });
const activeRequests = variant.buildRequests({
  candidate: CANDIDATE,
  evidence: surface,
  step: 2,
});
assert.equal(activeRequests.length, 1);
const activeRequest = activeRequests[0] as Extract<
  AdapterRequest,
  { readonly kind: "effect-delta-simulation" }
>;
assert.equal(activeRequest.id, "active-withdraw");
assert.equal(activeRequest.kind, "effect-delta-simulation");
assert.equal(activeRequest.call.executionMode, "impersonated-call-frame");
assert.equal(activeRequest.call.to.toLowerCase(), DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase());
assert.equal(
  activeRequest.overrideIntent.tokenBalances?.[0]?.token.toLowerCase(),
  DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase(),
);
assert.equal(
  activeRequest.overrideIntent.tokenBalances?.[0]?.amount,
  DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE,
);
assert.deepEqual(activeRequest.observe, [
  "return-data",
  "revert-data",
  "token-delta",
  "total-supply-delta",
  "logs",
]);
const withdrawArgs = DEFAULT_COLLATERAL_INTERFACE.decodeFunctionData(
  "withdraw",
  activeRequest.call.data,
);
assert.equal(
  ethers.getAddress(withdrawArgs[0]) ===
    ethers.getAddress(DEFAULT_COLLATERAL_PROBE_RECEIVER),
  true,
);
assert.equal(BigInt(withdrawArgs[1]), DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE);

const active = decode(
  surface,
  activeResults(surface),
  2,
) as DefaultCollateralActiveEvidence;
assert.equal(active.phase, "active");
assert.equal(active.sampleShares, DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE);
assert.equal(active.shareBurn, DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE);
assert.equal(active.assetReceipt, DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE);
assert.equal(active.supplyBurn, DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE);
assert.equal(active.behaviorValid, true);
const verified = decide(active, 3);
assert.equal(verified.status, "verified");
const identity = (verified as Extract<typeof verified, { status: "verified" }>)
  .identity as DefaultCollateralIdentity;
assert.equal(identity.oneToOne, true);
assert.equal(identity.vault.toLowerCase(), DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase());
assert.equal(identity.share.toLowerCase(), DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase());
assert.equal(identity.asset.toLowerCase(), DEFAULT_COLLATERAL_ASSET.toLowerCase());
assert.equal(identity.decimals, 18n);

// ---------------------------------------------------------------------------
// 3. behavior delta assertion: a fee/rounding delta must not pass
// ---------------------------------------------------------------------------
const shortReceipt = decode(
  surface,
  activeResults(surface, DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE - 1n),
  2,
) as DefaultCollateralActiveEvidence;
assert.equal(shortReceipt.assetReceipt, DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE - 1n);
assert.equal(shortReceipt.behaviorValid, false);
assert.deepEqual(decide(shortReceipt), {
  status: "retryable",
  reasonCode: "default_collateral_withdraw_behavior_not_proven",
});

// ---------------------------------------------------------------------------
// 4. identity rejection: non-clone, unknown implementation, asset mismatch
// ---------------------------------------------------------------------------
const nonClone = decode(undefined, baseResults({ code: ASSET_CODE }));
const nonCloneDecision = decide(nonClone);
assert.equal(nonCloneDecision.status, "chain-proven-rejected");
assert.equal(
  (nonCloneDecision as { reasonCode: string }).reasonCode,
  "default_collateral_not_eip1167_clone",
);

const unknownImplementation = "0x" + "22".repeat(20);
const unknownBase = decode(undefined, baseResults({
  code: defaultCollateralCloneCode(unknownImplementation),
})) as DefaultCollateralBaseEvidence;
assert.equal(unknownBase.implementation, ethers.getAddress(unknownImplementation));
assert.deepEqual(decide(unknownBase), { status: "continue" });
const unknownSurface = decode(
  unknownBase,
  surfaceResults({ implementationCode: "0x60006000" }),
  1,
) as DefaultCollateralSurfaceEvidence;
const unknownDecision = decide(unknownSurface);
assert.equal(unknownDecision.status, "chain-proven-rejected");
assert.equal(
  (unknownDecision as { reasonCode: string }).reasonCode,
  "default_collateral_implementation_code_mismatch",
);

const assetMismatch = decode(
  base,
  surfaceResults({ assetCode: "0x60006000" }),
  1,
) as DefaultCollateralSurfaceEvidence;
const assetDecision = decide(assetMismatch);
assert.equal(assetDecision.status, "chain-proven-rejected");
assert.equal(
  (assetDecision as { reasonCode: string }).reasonCode,
  "default_collateral_asset_code_mismatch",
);

const decimalsMismatch = decode(undefined, baseResults({ decimals: 6n }));
const decimalsDecision = decide(decimalsMismatch);
assert.equal(decimalsDecision.status, "chain-proven-rejected");
assert.equal(
  (decimalsDecision as { reasonCode: string }).reasonCode,
  "default_collateral_decimals_mismatch",
);

const emptyAsset = decode(undefined, baseResults({
  asset: ethers.ZeroAddress,
}));
const emptyAssetDecision = decide(emptyAsset);
assert.equal(emptyAssetDecision.status, "chain-proven-rejected");
assert.equal(
  (emptyAssetDecision as { reasonCode: string }).reasonCode,
  "default_collateral_asset_unavailable",
);

// A vault whose views revert is Family-declared negative evidence (no crash).
const revertedAsset = decode(undefined, Object.freeze([
  returned("base-share-code", CLONE_CODE),
  reverted("base-asset"),
  reverted("base-decimals"),
  reverted("base-total-supply"),
]));
assert.equal(decide(revertedAsset).status, "chain-proven-rejected");

// ---------------------------------------------------------------------------
// 5. exact: 1:1 quote reproduces the observed tx ratio and refuses otherwise
// ---------------------------------------------------------------------------
assert.equal(DEFAULT_COLLATERAL_OBSERVED_WITHDRAW, 9_538_714_839_966_700n);
assert.equal(defaultCollateralQuote({
  amountIn: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
  totalSupply: SUPPLY,
  backing: SUPPLY,
}), DEFAULT_COLLATERAL_OBSERVED_WITHDRAW);
assert.throws(
  () => defaultCollateralQuote({
    amountIn: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
    totalSupply: SUPPLY,
    backing: SUPPLY + 1n,
  }),
  /1:1 rate not proven/,
);
assert.throws(
  () => defaultCollateralQuote({
    amountIn: SUPPLY + 1n,
    totalSupply: SUPPLY,
    backing: SUPPLY,
  }),
  /exceeds the proven share supply/,
);

// ---------------------------------------------------------------------------
// 6. routes / taxonomy / binding + instance descriptor
// ---------------------------------------------------------------------------
const descriptor = defaultCollateralInstance.finalizeDescriptor({
  identity,
  draft: defaultCollateralInstance.compileDraft(identity),
  sharedBindings: [],
}) as DefaultCollateralDescriptor;
assert.equal(defaultCollateralInstance.instanceKey(identity),
  DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase());
const routes = defaultCollateralRoutes.project({ descriptor });
assert.equal(routes.length, 1);
const route = routes[0]! as DefaultCollateralRoute;
assert.equal(route.tokenIn.toLowerCase(), DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase());
assert.equal(route.tokenOut.toLowerCase(), DEFAULT_COLLATERAL_ASSET.toLowerCase());
assert.deepEqual(route.taxonomy, { slotKind: "protocol", protocolAction: "convert" });
assert.equal(route.adapterId, DEFAULT_COLLATERAL_ACTION_ID);
assert.equal(route.familyId, DEFAULT_COLLATERAL_FAMILY_ID);
assert.equal(route.lineageId, DEFAULT_COLLATERAL_LINEAGE_ID);
assert.equal(
  route.bindingRef.fingerprint,
  hashCanonical(defaultCollateralInstance.staticBindingProjection(descriptor)),
);
assert.doesNotThrow(() => assertDefaultCollateralInvocation(descriptor, route));
assert.throws(
  () => assertDefaultCollateralInvocation(descriptor, {
    ...route,
    tokenOut: DEFAULT_COLLATERAL_SHARE_VAULT,
  }),
  /route direction was not behavior-proven/,
);
assert.throws(
  () => assertDefaultCollateralInvocation(descriptor, {
    ...route,
    bindingRef: { ...route.bindingRef, fingerprint: "0x" + "00".repeat(32) },
  }),
  /not bound to its instance descriptor/,
);
const graph = defaultCollateralRoutes.projectGraph({ descriptor, route });
assert.equal(graph.routeActionAdapterId, DEFAULT_COLLATERAL_ACTION_ID);
assert.equal(graph.executionTarget.toLowerCase(), DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase());
assert.deepEqual(graph.venueIdentity, {
  kind: "address-protocol",
  target: DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase(),
});

// ---------------------------------------------------------------------------
// 7. pricing: raw mid 1.0 from same-block supply/backing, refusal otherwise
// ---------------------------------------------------------------------------
const pricingDescriptor = defaultCollateralPricing.compileDraft({
  descriptor,
  stateKey: descriptor.instanceKey,
  routes,
}) as DefaultCollateralPricingDescriptor;
assert.equal(pricingDescriptor.routes.length, 1);
const pricingResults = (options: {
  readonly supply?: bigint;
  readonly backing?: bigint;
  readonly asset?: string;
} = {}): readonly AdapterRequestResult[] => Object.freeze([
  returned(
    "current-asset",
    DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("asset", [
      options.asset ?? DEFAULT_COLLATERAL_ASSET,
    ]),
  ),
  returned(
    "current-total-supply",
    DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("totalSupply", [
      options.supply ?? SUPPLY,
    ]),
  ),
  returned(
    "current-backing",
    DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("balanceOf", [
      options.backing ?? SUPPLY,
    ]),
  ),
]);
const snapshot = defaultCollateralPricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: pricingResults(),
  dependentEvidence: [],
});
assert.equal(snapshot.totalSupply, SUPPLY);
assert.equal(snapshot.backing, SUPPLY);
assert.equal(snapshot.feeBps, 0n);
assert.equal(snapshot.quotes[route.routeKey]!.amountIn, 10n ** 18n);
assert.equal(snapshot.quotes[route.routeKey]!.amountOut, 10n ** 18n);
const mids = defaultCollateralPricing.current.deriveMids({
  descriptor: pricingDescriptor,
  snapshot,
  routes,
});
assert.equal(mids.get(route.routeKey)!.mid, 1);
assert.equal(mids.get(route.routeKey)!.feeBps, 0);
const unavailableSnapshot = defaultCollateralPricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: pricingResults({ backing: SUPPLY + 1n }),
  dependentEvidence: [],
});
assert.equal(unavailableSnapshot.quotes[route.routeKey], undefined);
assert.equal(
  defaultCollateralPricing.current.classifyUnavailable?.({
    descriptor: pricingDescriptor,
    snapshot: unavailableSnapshot,
    routes,
  }).get(route.routeKey),
  "default-collateral backing differs from totalSupply: 1:1 rate not proven",
);
const changedAssetSnapshot = defaultCollateralPricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: pricingResults({ asset: DEFAULT_COLLATERAL_SHARE_VAULT }),
  dependentEvidence: [],
});
assert.match(
  changedAssetSnapshot.unavailable[route.routeKey]!,
  /asset\(\) changed/,
);

// ---------------------------------------------------------------------------
// 8. exact request program: same-state amount quote, no off-chain fallback
// ---------------------------------------------------------------------------
const exactMethods = defaultCollateralExact.methods({
  descriptor,
  route,
  amountIn: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
  source: SOURCE,
  executor: PROBE_ACTOR,
  runtimeEvidence: [],
});
assert.equal(exactMethods.length, 2);
const requestMethod = exactMethods[1]!;
assert.equal(requestMethod.kind, "request-program");
if (requestMethod.kind !== "request-program") throw new Error("unreachable");
const exactRequests = requestMethod.program.buildRequests({
  descriptor,
  route,
  amountIn: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
  source: SOURCE,
  executor: PROBE_ACTOR,
  runtimeEvidence: [],
});
assert.deepEqual(exactRequests.map((request) => request.id), [
  "exact-asset",
  "exact-total-supply",
  "exact-backing",
]);
const exactQuote = requestMethod.program.decode({
  programInput: {
    descriptor,
    route,
    amountIn: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
    source: SOURCE,
    executor: PROBE_ACTOR,
    runtimeEvidence: [],
  },
  initialResults: Object.freeze([
    returned(
      "exact-asset",
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("asset", [
        DEFAULT_COLLATERAL_ASSET,
      ]),
    ),
    returned(
      "exact-total-supply",
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("totalSupply", [SUPPLY]),
    ),
    returned(
      "exact-backing",
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("balanceOf", [SUPPLY]),
    ),
  ]),
  dependentEvidence: [],
});
assert.equal(exactQuote.amountOut, DEFAULT_COLLATERAL_OBSERVED_WITHDRAW);
assert.equal(exactQuote.evidence.kind, "default-collateral-one-to-one");
assert.equal(exactQuote.evidence.amountIn, DEFAULT_COLLATERAL_OBSERVED_WITHDRAW);
assert.equal(exactQuote.evidence.amountOut, DEFAULT_COLLATERAL_OBSERVED_WITHDRAW);
assert.equal(exactQuote.evidence.totalSupply, SUPPLY);
assert.equal(exactQuote.evidence.backing, SUPPLY);
assert.equal(exactQuote.evidence.feeBps, 0n);
assert.throws(() => requestMethod.program.decode({
  programInput: {
    descriptor,
    route,
    amountIn: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
    source: SOURCE,
    executor: PROBE_ACTOR,
    runtimeEvidence: [],
  },
  initialResults: Object.freeze([
    returned(
      "exact-asset",
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("asset", [
        DEFAULT_COLLATERAL_ASSET,
      ]),
    ),
    returned(
      "exact-total-supply",
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("totalSupply", [SUPPLY]),
    ),
    returned(
      "exact-backing",
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("balanceOf", [SUPPLY - 1n]),
    ),
  ]),
  dependentEvidence: [],
}), /1:1 rate not proven/);

// ---------------------------------------------------------------------------
// 9. runtime leg + quoted fragment + Family action encoding
// ---------------------------------------------------------------------------
const runtimeLeg = defaultCollateralExecution.buildRuntimeLeg({
  descriptor,
  route,
  executor: PROBE_ACTOR,
  runtimeEvidence: [],
  source: SOURCE,
});
assert.notEqual(runtimeLeg, null);
assert.equal(runtimeLeg!.actionAdapterId, DEFAULT_COLLATERAL_ACTION_ID);
assert.match(runtimeLeg!.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
assert.equal(runtimeLeg!.settlement?.directOutput, true);
const directRuntimeLeg = defaultCollateralExecution.buildRuntimeLeg({
  descriptor,
  route,
  executor: PROBE_ACTOR,
  runtimeEvidence: [],
  source: SOURCE,
  settlement: { kind: "direct-output", recipient: DEFAULT_COLLATERAL_PROBE_RECEIVER },
});
assert.notEqual(directRuntimeLeg, null);
assert.equal(directRuntimeLeg!.settlement?.directOutput, true);
assert.equal(
  defaultCollateralExecution.buildRuntimeLeg({
    descriptor,
    route,
    executor: PROBE_ACTOR,
    runtimeEvidence: [],
    source: SOURCE,
    settlement: { kind: "callback", recipient: DEFAULT_COLLATERAL_PROBE_RECEIVER } as never,
  }),
  null,
);

const fragment = defaultCollateralExecution.buildFragment({
  descriptor,
  route,
  amountIn: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
  quotedAmountOut: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
  minAmountOut: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
  exactEvidence: exactQuote.evidence,
  executor: PROBE_ACTOR,
  runtimeEvidence: [],
});
assert.deepEqual(fragment.requirements, []);
assert.equal(fragment.nodes.length, 1);
assert.equal(fragment.nodes[0]!.tokenIn.toLowerCase(), DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase());
assert.equal(fragment.nodes[0]!.tokenOut.toLowerCase(), DEFAULT_COLLATERAL_ASSET.toLowerCase());
assert.equal(fragment.nodes[0]!.amount, DEFAULT_COLLATERAL_OBSERVED_WITHDRAW);

const encoded = defaultCollateralFamilyOwnedAction.encode({
  adapterId: DEFAULT_COLLATERAL_ACTION_ID,
  target: DEFAULT_COLLATERAL_SHARE_VAULT,
  tokenIn: DEFAULT_COLLATERAL_SHARE_VAULT,
  tokenOut: DEFAULT_COLLATERAL_ASSET,
  amount: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
  params: { minAmountOut: 0n },
  children: [],
}, PROBE_ACTOR, new Uint8Array());
const encodedBytes = ethers.getBytes(encoded);
// Family action envelope: [0x00][target:20][payload_len:3][payload]
assert.equal(encodedBytes[0], 0x00);
assert.equal(
  ethers.getAddress(ethers.hexlify(encodedBytes.slice(1, 21))),
  ethers.getAddress(DEFAULT_COLLATERAL_SHARE_VAULT),
);
const payloadLength = (encodedBytes[21]! << 16) | (encodedBytes[22]! << 8) |
  encodedBytes[23]!;
const encodedHex = ethers.hexlify(encodedBytes.slice(24, 24 + payloadLength));
assert.equal(encodedHex.slice(0, 10), DEFAULT_COLLATERAL_WITHDRAW_SELECTOR);
const encodedArgs = DEFAULT_COLLATERAL_INTERFACE.decodeFunctionData(
  "withdraw",
  encodedHex,
);
assert.equal(ethers.getAddress(encodedArgs[0]), ethers.getAddress(PROBE_ACTOR));
assert.equal(BigInt(encodedArgs[1]), DEFAULT_COLLATERAL_OBSERVED_WITHDRAW);
assert.equal(
  defaultCollateralFamilyOwnedAction.matchTrace(
    DEFAULT_COLLATERAL_SHARE_VAULT,
    DEFAULT_COLLATERAL_WITHDRAW_SELECTOR,
  ),
  true,
);
assert.throws(() => defaultCollateralFamilyOwnedAction.encode({
  adapterId: DEFAULT_COLLATERAL_ACTION_ID,
  target: DEFAULT_COLLATERAL_SHARE_VAULT,
  tokenIn: DEFAULT_COLLATERAL_SHARE_VAULT,
  tokenOut: DEFAULT_COLLATERAL_SHARE_VAULT,
  amount: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
  params: { minAmountOut: 0n },
  children: [],
}, PROBE_ACTOR, new Uint8Array()), /invalid withdraw action/);
assert.deepEqual(defaultCollateralExecution.expectedEffects({
  descriptor,
  route,
  amountIn: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
  quotedAmountOut: DEFAULT_COLLATERAL_OBSERVED_WITHDRAW,
}), [
  { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
  { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
]);

// ---------------------------------------------------------------------------
// 10. discovery from the real observed call and the vault's custom event
// ---------------------------------------------------------------------------
const observedCallData = DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData(
  "withdraw",
  ["0xE08D97e151473A848C3d9CA3f323Cb720472D015", DEFAULT_COLLATERAL_OBSERVED_WITHDRAW],
);
const callObservation: UnifiedObservation = Object.freeze({
  kind: "call" as const,
  source: SOURCE,
  target: DEFAULT_COLLATERAL_SHARE_VAULT,
  data: observedCallData,
  transactionHash:
    "0xad88c7f614ac27fa1707e224a2276d1f1b12f8cffe9a4443f1fa3fa2cf209833",
});
const callCandidate = defaultCollateralDiscovery.decodeCandidate({
  observation: callObservation,
  matchedPatternId: "default-collateral-withdraw-call",
});
assert.notEqual(callCandidate, null);
assert.equal(callCandidate!.vault.toLowerCase(), DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase());
assert.equal(
  defaultCollateralDiscovery.candidateKey(callCandidate!),
  DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase(),
);
const logObservation: UnifiedObservation = Object.freeze({
  kind: "log" as const,
  source: SOURCE,
  address: DEFAULT_COLLATERAL_SHARE_VAULT,
  topics: Object.freeze([
    DEFAULT_COLLATERAL_WITHDRAW_TOPIC,
    padded("0xE08D97e151473A848C3d9CA3f323Cb720472D015"),
    padded("0xE08D97e151473A848C3d9CA3f323Cb720472D015"),
  ]),
  data: word(DEFAULT_COLLATERAL_OBSERVED_WITHDRAW),
});
const logCandidate = defaultCollateralDiscovery.decodeCandidate({
  observation: logObservation,
  matchedPatternId: "default-collateral-withdraw-log",
});
assert.notEqual(logCandidate, null);
assert.equal(logCandidate!.vault.toLowerCase(), DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase());
assert.equal(defaultCollateralDiscovery.decodeCandidate({
  observation: {
    ...callObservation,
    data: DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("withdraw", [
      DEFAULT_COLLATERAL_PROBE_RECEIVER,
      0n,
    ]),
  },
  matchedPatternId: "default-collateral-withdraw-call",
}), null);
assert.equal(defaultCollateralDiscovery.decodeCandidate({
  observation: {
    ...callObservation,
    data: "0x12345678",
  },
  matchedPatternId: "default-collateral-withdraw-call",
}), null);
assert.notEqual(
  defaultCollateralCapture.materialize,
  undefined,
);

// ---------------------------------------------------------------------------
// 11. plugin declaration + activation default
// ---------------------------------------------------------------------------
assert.equal(plugin.manifest.familyId, DEFAULT_COLLATERAL_FAMILY_ID);
assert.deepEqual(plugin.manifest.allowedTaxonomy, [
  { slotKind: "protocol", protocolAction: "convert" },
]);
assert.deepEqual(plugin.manifest.ownedActionAdapterIds, [
  DEFAULT_COLLATERAL_ACTION_ID,
]);
assert.deepEqual(plugin.manifest.requiredInfraActionAdapterIds, []);
// Live default is untouched: the production entry declares disabled and only
// the explicit env key enables it.
assert.equal(activation.defaultEnabled, false);
assert.equal(activation.envKey, "SEARCHER_FAMILY_DEFAULT_COLLATERAL_ENABLED");
assert.equal(
  activation.enabled,
  process.env.SEARCHER_FAMILY_DEFAULT_COLLATERAL_ENABLED === "1",
);
console.log("default-collateral family contract PASS (offline)");

// ---------------------------------------------------------------------------
// 12. chain section: real strict identity at N (opt-in, production wiring)
// ---------------------------------------------------------------------------
if (
  process.env.MAINNET_RPC_URL === undefined ||
  process.env.SEARCHER_REVM_SIM_BIN === undefined ||
  process.env.BOTVM_ADDRESS === undefined ||
  process.env.BOTVM_OWNER === undefined ||
  process.env.SEARCHER_FAMILY_DEFAULT_COLLATERAL_ENABLED !== "1"
) {
  console.log(
    "default-collateral chain section SKIP (needs MAINNET_RPC_URL, " +
    "SEARCHER_REVM_SIM_BIN, BOTVM_ADDRESS, BOTVM_OWNER, " +
    "SEARCHER_FAMILY_DEFAULT_COLLATERAL_ENABLED=1)",
  );
} else {
  const { createProbeWiring } = await import(
    "../../../../universe-rebuild-production.js"
  );
  const wiring = createProbeWiring({
    rpcUrl: process.env.MAINNET_RPC_URL,
    familyIds: [DEFAULT_COLLATERAL_FAMILY_ID],
    executionIdentity: {
      executor: process.env.BOTVM_ADDRESS,
      transactionOrigin: process.env.BOTVM_OWNER,
    },
  });
  const vaultProbe = await wiring.attestFamilyInstanceOnce({
    candidate: {
      adapter: "default-collateral",
      address: DEFAULT_COLLATERAL_SHARE_VAULT,
      vault: DEFAULT_COLLATERAL_SHARE_VAULT,
      familyId: DEFAULT_COLLATERAL_FAMILY_ID,
      candidateKind: "default-collateral-share-vault",
    },
    cutoff: SOURCE,
  });
  assert.equal(vaultProbe.status, "verified");
  const vaultPublication = (vaultProbe as { result: { publication: {
    instances: readonly { readonly routes: readonly { readonly tokenIn: string;
      readonly tokenOut: string; readonly taxonomy: unknown }[] }[];
  } | null } }).result.publication;
  assert.notEqual(vaultPublication, null);
  assert.equal(vaultPublication!.instances[0]!.routes.length, 1);
  assert.equal(
    vaultPublication!.instances[0]!.routes[0]!.tokenIn.toLowerCase(),
    DEFAULT_COLLATERAL_SHARE_VAULT.toLowerCase(),
  );
  assert.equal(
    vaultPublication!.instances[0]!.routes[0]!.tokenOut.toLowerCase(),
    DEFAULT_COLLATERAL_ASSET.toLowerCase(),
  );

  const nonCloneProbe = await wiring.attestFamilyInstanceOnce({
    candidate: {
      adapter: "default-collateral",
      address: DEFAULT_COLLATERAL_ASSET,
      vault: DEFAULT_COLLATERAL_ASSET,
      familyId: DEFAULT_COLLATERAL_FAMILY_ID,
      candidateKind: "default-collateral-share-vault",
    },
    cutoff: SOURCE,
  });
  assert.equal(nonCloneProbe.status, "terminal-rejected");
  assert.match(
    (nonCloneProbe as { reasonCode: string }).reasonCode,
    /default_collateral_not_eip1167_clone/,
  );
  console.log("default-collateral chain identity at N PASS");
}

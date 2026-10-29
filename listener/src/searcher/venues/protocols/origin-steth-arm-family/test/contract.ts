import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import type { ExactQuoteInput } from "../../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { originStethArmFamilyOwnedAction } from "../action.js";
import {
  ORIGIN_STETH_ARM,
  ORIGIN_STETH_ARM_IMPLEMENTATION,
  ORIGIN_STETH_ARM_IMPLEMENTATION_CODE_HASH,
  ORIGIN_STETH_ARM_INTERFACE,
  ORIGIN_STETH_ARM_PRICE_SCALE,
  ORIGIN_STETH_ARM_PROXY_CODE_HASH,
  ORIGIN_STETH_ARM_STETH,
  ORIGIN_STETH_ARM_STETH_CODE_HASH,
  ORIGIN_STETH_ARM_SWAP_SELECTOR,
  ORIGIN_STETH_ARM_TRADERATE0_SLOT,
  ORIGIN_STETH_ARM_TRADERATE1_SLOT,
  ORIGIN_STETH_ARM_WETH,
  ORIGIN_STETH_ARM_WETH_CODE_HASH,
  originStethArmQuote,
} from "../codec.js";
import { originStethArmDiscovery } from "../discovery.js";
import { originStethArmExact } from "../exact.js";
import { originStethArmExecution } from "../execution.js";
import { originStethArmIdentity } from "../identity.js";
import { originStethArmInstance } from "../instance.js";
import {
  ORIGIN_STETH_ARM_ACTION_ID,
  ORIGIN_STETH_ARM_FAMILY_ID,
  ORIGIN_STETH_ARM_LINEAGE_ID,
  originStethArmFamilyManifest,
} from "../manifest.js";
import { originStethArmPricing } from "../pricing.js";
import { originStethArmRoutes } from "../routes.js";
import type {
  OriginStethArmDescriptor,
  OriginStethArmExactEvidence,
  OriginStethArmRoute,
} from "../types.js";

const EXECUTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const OTHER_RECIPIENT = "0x1000000000000000000000000000000000000002";
const SOURCE: CanonicalSource = Object.freeze({
  number: 26244681,
  hash: `0x${"11".repeat(32)}`,
  generation: 26244681,
});
/** Off-chain fixture, not chain evidence: values observed at N=26244681. */
const TRADERATE0 = 1000020000400008000160003200064001280n;
const TRADERATE1 = 999863865309614123000000000000000000n;
const SAMPLE_AMOUNT_IN = 8589306883606n;
const SAMPLE_AMOUNT_OUT = 8588137580972n;

function descriptor(): OriginStethArmDescriptor {
  return Object.freeze({
    familyId: ORIGIN_STETH_ARM_FAMILY_ID,
    lineageId: ORIGIN_STETH_ARM_LINEAGE_ID,
    instanceKey: instanceKey(ORIGIN_STETH_ARM.toLowerCase()),
    provenance: Object.freeze([]),
    runtimeRequirements: Object.freeze([{
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    }]),
    target: ethers.getAddress(ORIGIN_STETH_ARM),
    weth: ethers.getAddress(ORIGIN_STETH_ARM_WETH),
    steth: ethers.getAddress(ORIGIN_STETH_ARM_STETH),
    implementation: ethers.getAddress(ORIGIN_STETH_ARM_IMPLEMENTATION),
    proxyCodeHash: ORIGIN_STETH_ARM_PROXY_CODE_HASH,
    implementationCodeHash: ORIGIN_STETH_ARM_IMPLEMENTATION_CODE_HASH,
    stethCodeHash: ORIGIN_STETH_ARM_STETH_CODE_HASH,
    wethCodeHash: ORIGIN_STETH_ARM_WETH_CODE_HASH,
  });
}

function routesFor(d: OriginStethArmDescriptor): OriginStethArmRoute[] {
  const routes = originStethArmRoutes.project({ descriptor: d });
  assert.equal(routes.length, 2);
  return routes as OriginStethArmRoute[];
}

function routeFor(
  d: OriginStethArmDescriptor,
  direction: OriginStethArmRoute["direction"],
): OriginStethArmRoute {
  const route = routesFor(d).find((item) => item.direction === direction);
  assert.ok(route);
  return route;
}

function inputFor(
  d: OriginStethArmDescriptor,
  route: OriginStethArmRoute,
  amountIn: bigint,
): ExactQuoteInput<OriginStethArmDescriptor, OriginStethArmRoute> {
  return {
    descriptor: d,
    route,
    amountIn,
    executor: ethers.getAddress(EXECUTOR),
    source: SOURCE,
    runtimeEvidence: [],
  };
}

function storageResult(
  id: string,
  value: bigint,
  source: CanonicalSource = SOURCE,
) {
  return Object.freeze({
    id,
    ok: true as const,
    source,
    provenance: Object.freeze({ kind: "test-fixture", fingerprint: "fixture" }),
    completion: "returned" as const,
    data: ethers.zeroPadValue(ethers.toBeHex(value), 32),
  });
}

test("manifest declares the origin-stETH ARM lineage and one owned convert action", () => {
  assert.equal(String(originStethArmFamilyManifest.familyId), "protocol:origin-steth-arm");
  assert.deepEqual(
    originStethArmFamilyManifest.supportedLineages.map(String),
    ["origin-steth-arm-lido"],
  );
  assert.deepEqual(
    originStethArmFamilyManifest.ownedActionAdapterIds,
    [ORIGIN_STETH_ARM_ACTION_ID],
  );
  assert.deepEqual(
    originStethArmFamilyManifest.edgeAdapterIds,
    [ORIGIN_STETH_ARM_ACTION_ID],
  );
  assert.deepEqual(originStethArmFamilyManifest.allowedTaxonomy, [
    { slotKind: "protocol", protocolAction: "convert" },
  ]);
  assert.equal(originStethArmFamilyManifest.requiresProtocolEdgesFlag, false);
});

test("linear price math reproduces the observed tx output exactly", () => {
  assert.equal(originStethArmQuote(SAMPLE_AMOUNT_IN, TRADERATE1), SAMPLE_AMOUNT_OUT);
  assert.equal(
    originStethArmQuote(10n ** 18n, TRADERATE1),
    999863865309614123n,
  );
  assert.equal(
    originStethArmQuote(10n ** 18n, TRADERATE0),
    1000020000400008000n,
  );
  assert.equal(originStethArmQuote(0n, TRADERATE1), 0n);
  assert.throws(() => originStethArmQuote(-1n, TRADERATE1), /cannot be negative/);
  assert.throws(() => originStethArmQuote(1n, 0n), /outside the supported range/);
  assert.throws(
    () => originStethArmQuote(1n, 3n * ORIGIN_STETH_ARM_PRICE_SCALE),
    /outside the supported range/,
  );
  assert.throws(
    () => originStethArmQuote(ethers.MaxUint256, TRADERATE1),
    /overflows uint256/,
  );
});

test("routes project both verified directions as protocol converts", () => {
  const d = descriptor();
  const [forward, reverse] = routesFor(d);
  assert.equal(forward.direction, "steth-to-weth");
  assert.equal(forward.tokenIn.toLowerCase(), ORIGIN_STETH_ARM_STETH.toLowerCase());
  assert.equal(forward.tokenOut.toLowerCase(), ORIGIN_STETH_ARM_WETH.toLowerCase());
  assert.equal(reverse.direction, "weth-to-steth");
  assert.equal(reverse.tokenIn.toLowerCase(), ORIGIN_STETH_ARM_WETH.toLowerCase());
  assert.equal(reverse.tokenOut.toLowerCase(), ORIGIN_STETH_ARM_STETH.toLowerCase());
  for (const route of [forward, reverse]) {
    assert.equal(route.adapterId, ORIGIN_STETH_ARM_ACTION_ID);
    assert.equal(route.instanceKey, d.instanceKey);
    assert.deepEqual(route.taxonomy, {
      slotKind: "protocol",
      protocolAction: "convert",
    });
    assert.equal(route.bindingRef.bindingKey, ORIGIN_STETH_ARM.toLowerCase());
    assert.equal(route.target, d.target);
  }
  assert.notEqual(forward.routeKey, reverse.routeKey);
  const graph = originStethArmRoutes.projectGraph({
    descriptor: d,
    route: forward,
  });
  assert.equal(graph.routeActionAdapterId, ORIGIN_STETH_ARM_ACTION_ID);
  assert.equal(graph.executionTarget, d.target);
});

test("instance compileDraft keeps the verified code-bound tokens", () => {
  const d = descriptor();
  const identity = {
    familyId: d.familyId,
    lineageId: d.lineageId,
    subject: d.target,
    provenance: Object.freeze([]),
    weth: d.weth,
    steth: d.steth,
    implementation: d.implementation,
    proxyCodeHash: d.proxyCodeHash,
    implementationCodeHash: d.implementationCodeHash,
    stethCodeHash: d.stethCodeHash,
    wethCodeHash: d.wethCodeHash,
  };
  const draft = originStethArmInstance.compileDraft(identity);
  assert.equal(draft.target, d.target);
  assert.equal(draft.weth, d.weth);
  assert.equal(draft.steth, d.steth);
  assert.equal(draft.instanceKey, d.instanceKey);
  assert.throws(
    () => originStethArmInstance.compileDraft({
      ...identity,
      steth: ethers.getAddress(ORIGIN_STETH_ARM_WETH),
    }),
    /not stETH\/WETH/,
  );
});

test("pricing reads both price words and derives direction mids", () => {
  const d = descriptor();
  const routes = routesFor(d);
  const draft = originStethArmPricing.compileDraft({
    descriptor: d,
    stateKey: d.instanceKey,
    routes,
  });
  const requests = originStethArmPricing.current.buildRequests({
    descriptor: draft,
    routes,
    source: SOURCE,
  });
  assert.deepEqual(requests.map((request) => request.id), [
    "current-traderate0",
    "current-traderate1",
  ]);
  for (const request of requests) {
    assert.equal(request.kind, "get-storage");
    if (request.kind === "get-storage") {
      assert.equal(request.address, d.target);
    }
  }
  const snapshot = originStethArmPricing.current.decodeSnapshot({
    descriptor: draft,
    initialResults: [
      storageResult("current-traderate0", TRADERATE0),
      storageResult("current-traderate1", TRADERATE1),
    ],
    dependentEvidence: [],
  });
  assert.equal(snapshot.rates["steth-to-weth"], TRADERATE1);
  assert.equal(snapshot.rates["weth-to-steth"], TRADERATE0);
  const mids = originStethArmPricing.current.deriveMids({
    descriptor: draft,
    snapshot,
    routes,
  });
  const forward = mids.get(routeFor(d, "steth-to-weth").routeKey);
  const reverse = mids.get(routeFor(d, "weth-to-steth").routeKey);
  assert.ok(forward);
  assert.ok(reverse);
  assert.equal(forward.mid, 0.9998638653096141);
  assert.equal(reverse.mid, 1.000020000400008);
  assert.equal(forward.feeBps, 0);
  assert.equal(forward.edges[0].slotKind, "protocol");
  assert.equal(
    (forward.edges[0] as { protocolAction?: string }).protocolAction,
    "convert",
  );
});

test("pricing marks a direction unavailable when its price word is unusable", () => {
  const d = descriptor();
  const routes = routesFor(d);
  const draft = originStethArmPricing.compileDraft({
    descriptor: d,
    stateKey: d.instanceKey,
    routes,
  });
  const snapshot = originStethArmPricing.current.decodeSnapshot({
    descriptor: draft,
    initialResults: [
      storageResult("current-traderate0", TRADERATE0),
      storageResult("current-traderate1", 0n),
    ],
    dependentEvidence: [],
  });
  const forward = routeFor(d, "steth-to-weth");
  const unavailable = originStethArmPricing.current.classifyUnavailable!({
    descriptor: draft,
    snapshot,
    routes,
  });
  assert.deepEqual([...unavailable.keys()], [forward.routeKey]);
  const mids = originStethArmPricing.current.deriveMids({
    descriptor: draft,
    snapshot,
    routes,
  });
  assert.equal(mids.has(forward.routeKey), false);
  assert.equal(mids.size, 1);
});

test("exact program reads the direction price word and reproduces the tx ratio", () => {
  const d = descriptor();
  const route = routeFor(d, "steth-to-weth");
  const input = inputFor(d, route, SAMPLE_AMOUNT_IN);
  const method = originStethArmExact.methods()
    .find((candidate) => candidate.kind === "request-program");
  assert.ok(method && method.kind === "request-program");
  assert.deepEqual(method.program.requirements(input), {
    transports: ["get-storage"],
  });
  const requests = method.program.buildRequests(input);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, "get-storage");
  if (requests[0].kind === "get-storage") {
    assert.equal(requests[0].slot, ORIGIN_STETH_ARM_TRADERATE1_SLOT);
    assert.equal(requests[0].address, d.target);
  }
  const quoted = method.program.decode({
    programInput: input,
    initialResults: [storageResult("exact-traderate", TRADERATE1)],
    dependentEvidence: [],
  });
  assert.equal(quoted.amountOut, SAMPLE_AMOUNT_OUT);
  const evidence = quoted.evidence as OriginStethArmExactEvidence;
  assert.equal(evidence.kind, "origin-steth-arm-linear-price");
  assert.equal(evidence.rate, TRADERATE1);
  assert.equal(evidence.rateSlot, ORIGIN_STETH_ARM_TRADERATE1_SLOT);
  assert.equal(evidence.amountIn, SAMPLE_AMOUNT_IN);
  assert.equal(evidence.bindingFingerprint, route.bindingRef.fingerprint);
  assert.throws(
    () => method.program.decode({
      programInput: input,
      initialResults: [storageResult("exact-traderate", TRADERATE1, {
        ...SOURCE,
        number: SOURCE.number + 1,
      })],
      dependentEvidence: [],
    }),
    /foreign source/,
  );
});

test("exact zero input is the local identity and reads no state", () => {
  const d = descriptor();
  const route = routeFor(d, "weth-to-steth");
  const input = inputFor(d, route, 0n);
  const methods = originStethArmExact.methods();
  const zero = methods.find((method) => method.id === "local-zero");
  assert.ok(zero && zero.kind === "local");
  const quoted = zero.quote(input);
  assert.equal(quoted.status, "quoted");
  if (quoted.status !== "quoted") return;
  assert.equal(quoted.result.amountOut, 0n);
  const positive = methods.find((method) => method.kind === "request-program");
  assert.ok(positive && positive.kind === "request-program");
  assert.deepEqual(positive.program.requirements(input), { transports: [] });
  assert.deepEqual(positive.program.buildRequests(input), []);
});

test("execution fragment uses an exact approve and the verified swap call", () => {
  const d = descriptor();
  const route = routeFor(d, "steth-to-weth");
  const amountIn = SAMPLE_AMOUNT_IN;
  const amountOut = originStethArmQuote(amountIn, TRADERATE1);
  const evidence: OriginStethArmExactEvidence = Object.freeze({
    kind: "origin-steth-arm-linear-price",
    source: SOURCE,
    target: d.target,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    direction: route.direction,
    amountIn,
    amountOut,
    rate: TRADERATE1,
    rateSlot: ORIGIN_STETH_ARM_TRADERATE1_SLOT,
    bindingFingerprint: route.bindingRef.fingerprint,
  });
  const fragment = originStethArmExecution.buildFragment({
    descriptor: d,
    route,
    amountIn,
    quotedAmountOut: amountOut,
    minAmountOut: 0n,
    exactEvidence: evidence,
    executor: EXECUTOR,
    runtimeEvidence: [],
  });
  assert.equal(fragment.requirements.length, 1);
  assert.equal(fragment.requirements[0].kind, "approve");
  if (fragment.requirements[0].kind === "approve") {
    assert.equal(fragment.requirements[0].token, route.tokenIn);
    assert.equal(fragment.requirements[0].spender, d.target);
    assert.equal(fragment.requirements[0].amount, amountIn);
  }
  assert.equal(fragment.nodes.length, 1);
  assert.equal(fragment.nodes[0].adapterId, ORIGIN_STETH_ARM_ACTION_ID);
  assert.equal(fragment.nodes[0].target, d.target);
  assert.equal(fragment.nodes[0].amount, amountIn);
  assert.equal(fragment.nodes[0].params.minAmountOut, 0n);
  assert.throws(
    () => originStethArmExecution.buildFragment({
      descriptor: d,
      route,
      amountIn,
      quotedAmountOut: amountOut + 1n,
      minAmountOut: 0n,
      exactEvidence: evidence,
      executor: EXECUTOR,
      runtimeEvidence: [],
    }),
    /incompatible exact evidence/,
  );
  assert.throws(
    () => originStethArmExecution.buildFragment({
      descriptor: d,
      route,
      amountIn,
      quotedAmountOut: amountOut,
      minAmountOut: amountOut + 1n,
      exactEvidence: evidence,
      executor: EXECUTOR,
      runtimeEvidence: [],
    }),
    /incompatible exact evidence/,
  );
});

test("runtime leg approves the received amount, calls swap and pays a chosen recipient", () => {
  const d = descriptor();
  const route = routeFor(d, "steth-to-weth");
  const leg = originStethArmExecution.buildRuntimeLeg({
    descriptor: d,
    route,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
  });
  assert.ok(leg);
  assert.match(leg.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
  assert.equal(leg.actionAdapterId, ORIGIN_STETH_ARM_ACTION_ID);
  assert.equal(leg.settlement?.directOutput, true);
  const withRecipient = originStethArmExecution.buildRuntimeLeg({
    descriptor: d,
    route,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    settlement: { kind: "direct-output", recipient: OTHER_RECIPIENT },
  });
  assert.ok(withRecipient);
  assert.deepEqual(withRecipient.settlementRequest, {
    kind: "direct-output",
    recipient: OTHER_RECIPIENT,
  });
  // The verified implementation pulls its input before sending output, so a
  // deferred-input callback is not a capability of this swap.
  assert.equal(originStethArmExecution.buildRuntimeLeg({
    descriptor: d,
    route,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    settlement: {
      kind: "deferred-input",
      paymentProgram: "0x01",
      paymentAmount: 1n,
    },
  }), null);
});

test("action encodes swapExactTokensForTokens(in,out,amount,minOut,executor)", () => {
  const d = descriptor();
  const node = {
    adapterId: ORIGIN_STETH_ARM_ACTION_ID,
    target: d.target,
    tokenIn: d.steth,
    tokenOut: d.weth,
    amount: SAMPLE_AMOUNT_IN,
    params: { minAmountOut: 7n },
    children: [],
  };
  const encoded = originStethArmFamilyOwnedAction.encode(
    node,
    EXECUTOR,
    new Uint8Array(),
  );
  const expected = ORIGIN_STETH_ARM_INTERFACE.encodeFunctionData(
    "swapExactTokensForTokens",
    [d.steth, d.weth, SAMPLE_AMOUNT_IN, 7n, ethers.getAddress(EXECUTOR)],
  );
  const expectedBytes = ethers.getBytes(expected);
  assert.equal(
    Buffer.from(encoded.slice(-expectedBytes.length)).toString("hex"),
    Buffer.from(expectedBytes).toString("hex"),
  );
  assert.equal(ORIGIN_STETH_ARM_SWAP_SELECTOR, "0x6c08c57e");
  assert.equal(
    originStethArmFamilyOwnedAction.matchTrace(d.target, "0x6c08c57e"),
    true,
  );
  assert.equal(
    originStethArmFamilyOwnedAction.matchTrace(d.target, "0xa0712d68"),
    false,
  );
  assert.throws(
    () => originStethArmFamilyOwnedAction.encode({
      ...node,
      tokenOut: d.steth,
    }, EXECUTOR, new Uint8Array()),
    /not stETH\/WETH/,
  );
});

test("discovery nominates swap call targets and ignores zero amounts", () => {
  const d = descriptor();
  const observation = {
    kind: "call" as const,
    source: SOURCE,
    target: d.target,
    data: ORIGIN_STETH_ARM_INTERFACE.encodeFunctionData(
      "swapExactTokensForTokens",
      [d.steth, d.weth, SAMPLE_AMOUNT_IN, 0n, EXECUTOR],
    ),
  };
  const candidate = originStethArmDiscovery.decodeCandidate({
    observation: observation as never,
    matchedPatternId: "origin-steth-arm-swap-call",
  });
  assert.ok(candidate);
  assert.equal(candidate.candidateKind, "origin-steth-arm");
  assert.equal(candidate.target, d.target);
  assert.equal(originStethArmDiscovery.decodeCandidate({
    observation: {
      ...observation,
      data: ORIGIN_STETH_ARM_INTERFACE.encodeFunctionData(
        "swapExactTokensForTokens",
        [d.steth, d.weth, 0n, 0n, EXECUTOR],
      ),
    } as never,
    matchedPatternId: "origin-steth-arm-swap-call",
  }), null);
  assert.equal(originStethArmDiscovery.decodeCandidate({
    observation: { ...observation, kind: "log" } as never,
    matchedPatternId: "origin-steth-arm-swap-call",
  }), null);
});

test("identity rejects wrong code hashes and unproven swap behavior", () => {
  const variant = originStethArmIdentity.variants[0];
  const candidate = {
    candidateKind: "origin-steth-arm" as const,
    target: ethers.getAddress(ORIGIN_STETH_ARM),
  };
  const decide = (evidence: unknown) =>
    variant.decide({ candidate, step: 0, evidence });
  const proxyProof = {
    phase: "proxy" as const,
    source: SOURCE,
    proxyCodeHash: ORIGIN_STETH_ARM_PROXY_CODE_HASH,
    implementation: ethers.getAddress(ORIGIN_STETH_ARM_IMPLEMENTATION),
    stethCodeHash: ORIGIN_STETH_ARM_STETH_CODE_HASH,
    wethCodeHash: ORIGIN_STETH_ARM_WETH_CODE_HASH,
  };
  assert.equal(decide(proxyProof).status, "continue");
  const badProxy = decide({
    ...proxyProof,
    proxyCodeHash: `0x${"00".repeat(32)}`,
  });
  assert.equal(badProxy.status, "chain-proven-rejected");
  const badToken = decide({
    ...proxyProof,
    stethCodeHash: `0x${"22".repeat(32)}`,
  });
  assert.equal(badToken.status, "chain-proven-rejected");

  const bindingProof = {
    ...proxyProof,
    phase: "binding" as const,
    implementationCodeHash: ORIGIN_STETH_ARM_IMPLEMENTATION_CODE_HASH,
    traderate0: TRADERATE0,
    traderate1: TRADERATE1,
  };
  assert.equal(decide(bindingProof).status, "continue");
  const badImplementation = decide({
    ...bindingProof,
    implementationCodeHash: `0x${"33".repeat(32)}`,
  });
  assert.equal(badImplementation.status, "chain-proven-rejected");

  const verifiedProof = {
    ...bindingProof,
    phase: "verified" as const,
    behaviorValid: true,
    behaviorProofHash: `0x${"44".repeat(32)}`,
  };
  const verified = decide(verifiedProof);
  assert.equal(verified.status, "verified");
  if (verified.status !== "verified") return;
  assert.equal(verified.identity.subject, candidate.target);
  assert.equal(
    verified.identity.implementation.toLowerCase(),
    ORIGIN_STETH_ARM_IMPLEMENTATION.toLowerCase(),
  );
  assert.equal(verified.identity.steth, ethers.getAddress(ORIGIN_STETH_ARM_STETH));
  assert.equal(verified.identity.weth, ethers.getAddress(ORIGIN_STETH_ARM_WETH));
  assert.equal(
    decide({ ...verifiedProof, behaviorValid: false }).status,
    "retryable",
  );
});

test("invocation rejects a route bound to a different descriptor", () => {
  const d = descriptor();
  const route = routeFor(d, "steth-to-weth");
  const other = {
    ...d,
    instanceKey: instanceKey("0x1111111111111111111111111111111111111111"),
  };
  const fragment = () => originStethArmExecution.buildFragment({
    descriptor: other,
    route,
    amountIn: SAMPLE_AMOUNT_IN,
    quotedAmountOut: SAMPLE_AMOUNT_OUT,
    minAmountOut: 0n,
    exactEvidence: {
      kind: "origin-steth-arm-linear-price",
      source: SOURCE,
      target: other.target,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      direction: route.direction,
      amountIn: SAMPLE_AMOUNT_IN,
      amountOut: SAMPLE_AMOUNT_OUT,
      rate: TRADERATE1,
      rateSlot: ORIGIN_STETH_ARM_TRADERATE1_SLOT,
      bindingFingerprint: route.bindingRef.fingerprint,
    } as OriginStethArmExactEvidence,
    executor: EXECUTOR,
    runtimeEvidence: [],
  });
  assert.throws(fragment, /not bound|incompatible/);
  assert.equal(
    ORIGIN_STETH_ARM_TRADERATE0_SLOT,
    "0x0000000000000000000000000000000000000000000000000000000000000032",
  );
});

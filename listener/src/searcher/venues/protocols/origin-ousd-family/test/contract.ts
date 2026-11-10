import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import type { ExactQuoteInput } from "../../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { originOusdFamilyOwnedAction } from "../action.js";
import {
  ORIGIN_OUSD_ASSET,
  ORIGIN_OUSD_DECIMAL_SCALE,
  ORIGIN_OUSD_IMPLEMENTATION_CODE_HASH,
  ORIGIN_OUSD_PROXY_CODE_HASH,
  ORIGIN_OUSD_TOKEN,
  ORIGIN_OUSD_TOKEN_CODE_HASH,
  ORIGIN_OUSD_VAULT,
  ORIGIN_OUSD_VAULT_INTERFACE,
  originOusdMintQuote,
} from "../codec.js";
import { originOusdDiscovery } from "../discovery.js";
import { originOusdExact } from "../exact.js";
import { originOusdExecution } from "../execution.js";
import {
  ORIGIN_OUSD_FAMILY_ID,
  ORIGIN_OUSD_LINEAGE_ID,
  originOusdFamilyManifest,
} from "../manifest.js";
import { originOusdPricing } from "../pricing.js";
import { originOusdRoutes } from "../routes.js";
import type {
  OriginOusdDescriptor,
  OriginOusdExactEvidence,
  OriginOusdRoute,
} from "../types.js";

const EXECUTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const SOURCE: CanonicalSource = Object.freeze({
  number: 26185253,
  hash: `0x${"11".repeat(32)}`,
  generation: 26185253,
});
const IMPLEMENTATION = "0x82948060c4B72684bEdEdec342350AB344975145";

function descriptor(): OriginOusdDescriptor {
  return Object.freeze({
    familyId: ORIGIN_OUSD_FAMILY_ID,
    lineageId: ORIGIN_OUSD_LINEAGE_ID,
    instanceKey: instanceKey(ORIGIN_OUSD_VAULT.toLowerCase()),
    provenance: Object.freeze([]),
    runtimeRequirements: Object.freeze([{
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    }]),
    target: ethers.getAddress(ORIGIN_OUSD_VAULT),
    asset: ethers.getAddress(ORIGIN_OUSD_ASSET),
    token: ethers.getAddress(ORIGIN_OUSD_TOKEN),
    decimalScale: ORIGIN_OUSD_DECIMAL_SCALE,
    implementation: ethers.getAddress(IMPLEMENTATION),
    proxyCodeHash: ORIGIN_OUSD_PROXY_CODE_HASH,
    implementationCodeHash: ORIGIN_OUSD_IMPLEMENTATION_CODE_HASH,
    tokenCodeHash: ORIGIN_OUSD_TOKEN_CODE_HASH,
  });
}

function routeFor(d: OriginOusdDescriptor): OriginOusdRoute {
  const routes = originOusdRoutes.project({ descriptor: d, routes: [] });
  assert.equal(routes.length, 1);
  return routes[0] as OriginOusdRoute;
}

function inputFor(
  d: OriginOusdDescriptor,
  route: OriginOusdRoute,
  amountIn: bigint,
): ExactQuoteInput<OriginOusdDescriptor, OriginOusdRoute> {
  return {
    descriptor: d,
    route,
    amountIn,
    executor: ethers.getAddress(EXECUTOR),
    source: SOURCE,
    runtimeEvidence: [],
  };
}

function assetResult(d: OriginOusdDescriptor) {
  return Object.freeze({
    id: "current-asset",
    ok: true as const,
    source: SOURCE,
    provenance: Object.freeze({ kind: "test-fixture", fingerprint: "fixture" }),
    completion: "returned" as const,
    data: ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionResult(
      "asset",
      [d.asset],
    ),
  });
}

test("manifest declares the origin-ousd lineage and one owned action", () => {
  assert.equal(String(originOusdFamilyManifest.familyId), "protocol:origin-ousd");
  assert.deepEqual(originOusdFamilyManifest.supportedLineages.map(String), ["origin-ousd-vault"]);
  assert.deepEqual(originOusdFamilyManifest.ownedActionAdapterIds, ["origin-ousd-mint"]);
  assert.deepEqual(originOusdFamilyManifest.edgeAdapterIds, ["origin-ousd-mint"]);
  assert.equal(originOusdFamilyManifest.requiresProtocolEdgesFlag, false);
});

test("1:1 mint math is USDC 6 -> OUSD 18 at 1e12, with overflow guards", () => {
  assert.equal(originOusdMintQuote(0n), 0n);
  assert.equal(originOusdMintQuote(1_000_000n), 10n ** 18n);
  assert.equal(originOusdMintQuote(394_088_756n), 394_088_756n * 10n ** 12n);
  assert.throws(() => originOusdMintQuote(-1n), /cannot be negative/);
  assert.throws(
    () => originOusdMintQuote((1n << 256n) - 1n),
    /scaling overflow/,
  );
});

test("route projects USDC -> OUSD as a protocol convert bound to the vault", () => {
  const d = descriptor();
  const route = routeFor(d);
  assert.equal(route.adapterId, "origin-ousd-mint");
  assert.equal(route.direction, "mint-usdc-to-ousd");
  assert.equal(route.tokenIn.toLowerCase(), ORIGIN_OUSD_ASSET.toLowerCase());
  assert.equal(route.tokenOut.toLowerCase(), ORIGIN_OUSD_TOKEN.toLowerCase());
  assert.deepEqual(route.taxonomy, { slotKind: "protocol", protocolAction: "convert" });
  assert.equal(route.bindingRef.bindingKey, ORIGIN_OUSD_VAULT.toLowerCase());
  assert.equal(route.instanceKey, d.instanceKey);
});

test("pricing reads vault.asset() and derives a 1e12 protocol mid", () => {
  const d = descriptor();
  const route = routeFor(d);
  const draft = originOusdPricing.compileDraft({
    descriptor: d,
    stateKey: d.instanceKey,
    routes: [route],
  });
  assert.deepEqual(
    originOusdPricing.current.buildRequests({ descriptor: draft, routes: [route] })
      .map(request => request.id),
    ["current-asset"],
  );
  const snapshot = originOusdPricing.current.decodeSnapshot({
    descriptor: draft,
    initialResults: [assetResult(d)],
    dependentEvidence: [],
  });
  const mids = originOusdPricing.current.deriveMids({
    descriptor: draft,
    snapshot,
    routes: [route],
  });
  const mid = mids.get(route.routeKey);
  assert.ok(mid);
  assert.equal(mid.mid, 1e12);
  assert.equal(mid.feeBps, 0);
  assert.equal(mid.edges[0].tokenIn.toLowerCase(), ORIGIN_OUSD_ASSET.toLowerCase());
  assert.equal(mid.edges[0].tokenOut.toLowerCase(), ORIGIN_OUSD_TOKEN.toLowerCase());
});

test("pricing marks the route unavailable when the vault asset changes", () => {
  const d = descriptor();
  const route = routeFor(d);
  const draft = originOusdPricing.compileDraft({
    descriptor: d,
    stateKey: d.instanceKey,
    routes: [route],
  });
  const snapshot = originOusdPricing.current.decodeSnapshot({
    descriptor: draft,
    initialResults: [Object.freeze({
      ...assetResult(d),
      data: ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionResult("asset", [
        "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      ]),
    })],
    dependentEvidence: [],
  });
  assert.deepEqual(
    [...originOusdPricing.current.classifyUnavailable!({
      descriptor: draft,
      snapshot,
      routes: [route],
    }).keys()],
    [route.routeKey],
  );
  assert.equal(
    originOusdPricing.current.deriveMids({ descriptor: draft, snapshot, routes: [route] }).size,
    0,
  );
});

test("exact quotes the deterministic ratio without chain reads", () => {
  const d = descriptor();
  const route = routeFor(d);
  const amountIn = 1_234_567n;
  const methods = originOusdExact.methods(inputFor(d, route, amountIn));
  const localZero = methods.find(method => method.id === "local-zero");
  assert.ok(localZero && localZero.kind === "local");
  const zero = localZero.quote(inputFor(d, route, 0n));
  assert.equal(zero.status, "quoted");
  if (zero.status !== "quoted") return;
  assert.equal(zero.result.amountOut, 0n);

  const ratio = methods.find(method => method.kind === "request-program");
  assert.ok(ratio && ratio.kind === "request-program");
  assert.deepEqual(ratio.program.requirements(inputFor(d, route, amountIn)), {
    transports: [],
  });
  const quoted = ratio.program.decode({
    programInput: inputFor(d, route, amountIn),
    initialResults: [],
    dependentEvidence: [],
  });
  assert.equal(quoted.amountOut, amountIn * ORIGIN_OUSD_DECIMAL_SCALE);
  assert.equal(
    (quoted.evidence as OriginOusdExactEvidence).bindingFingerprint,
    route.bindingRef.fingerprint,
  );
  assert.equal(
    (quoted.evidence as OriginOusdExactEvidence).kind,
    "origin-ousd-1to1-mint",
  );
});

test("execution fragment uses an exact approve and the mint action", () => {
  const d = descriptor();
  const route = routeFor(d);
  const amountIn = 5_000_000n;
  const amountOut = originOusdMintQuote(amountIn);
  const evidence: OriginOusdExactEvidence = Object.freeze({
    kind: "origin-ousd-1to1-mint",
    source: SOURCE,
    target: d.target,
    asset: d.asset,
    token: d.token,
    amountIn,
    amountOut,
    decimalScale: d.decimalScale,
    bindingFingerprint: route.bindingRef.fingerprint,
  });
  const fragment = originOusdExecution.buildFragment({
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
  assert.equal(fragment.requirements[0].amount, amountIn);
  assert.equal(fragment.nodes[0].adapterId, "origin-ousd-mint");
  assert.equal(fragment.nodes[0].target, d.target);
  assert.equal(fragment.nodes[0].amount, amountIn);
  assert.throws(
    () => originOusdExecution.buildFragment({
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
});

test("runtime leg builds an exact approval + mint program and refuses foreign recipients", () => {
  const d = descriptor();
  const route = routeFor(d);
  const leg = originOusdExecution.buildRuntimeLeg({
    descriptor: d,
    route,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
  });
  assert.ok(leg);
  assert.match(leg.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
  assert.equal(leg.actionAdapterId, "origin-ousd-mint");
  assert.equal(leg.settlement?.directOutput, true);
  // The mint credits msg.sender only, so a different direct recipient is not
  // silently supported by this single-call leg.
  assert.equal(originOusdExecution.buildRuntimeLeg({
    descriptor: d,
    route,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    settlement: { kind: "direct-output", recipient: "0x1000000000000000000000000000000000000002" },
  }), null);
  assert.equal(originOusdExecution.buildRuntimeLeg({
    descriptor: d,
    route,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    settlement: { kind: "deferred-input", paymentProgram: "0x01", paymentAmount: 1n },
  }), null);
});

test("action encodes mint(amount) and matches only the mint selector", () => {
  const d = descriptor();
  const encoded = originOusdFamilyOwnedAction.encode({
    adapterId: "origin-ousd-mint",
    target: d.target,
    tokenIn: d.asset,
    tokenOut: d.token,
    amount: 1_000_000n,
    params: {},
    children: [],
  }, EXECUTOR, new Uint8Array());
  const expected = ethers.getBytes(
    ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("mint", [1_000_000n]),
  );
  assert.deepEqual(
    Buffer.from(encoded.slice(-expected.length)).toString("hex"),
    Buffer.from(expected).toString("hex"),
  );
  assert.equal(
    originOusdFamilyOwnedAction.matchTrace(d.target,
      ORIGIN_OUSD_VAULT_INTERFACE.getFunction("mint")!.selector),
    true,
  );
  assert.equal(
    originOusdFamilyOwnedAction.matchTrace(d.target,
      ORIGIN_OUSD_VAULT_INTERFACE.getFunction("redeem")!.selector),
    false,
  );
});

test("discovery nominates mint(uint256) call targets and ignores zero amounts", () => {
  const d = descriptor();
  const observation = {
    kind: "call" as const,
    source: SOURCE,
    target: d.target,
    data: ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("mint", [1_000_000n]),
  };
  const candidate = originOusdDiscovery.decodeCandidate({
    observation: observation as never,
    matchedPatternId: "origin-ousd-mint-call",
  });
  assert.ok(candidate);
  assert.equal(candidate.candidateKind, "origin-ousd-vault");
  assert.equal(candidate.target, d.target);
  assert.equal(originOusdDiscovery.decodeCandidate({
    observation: {
      ...observation,
      data: ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("mint", [0n]),
    } as never,
    matchedPatternId: "origin-ousd-mint-call",
  }), null);
  assert.equal(originOusdDiscovery.decodeCandidate({
    observation: { ...observation, kind: "log" } as never,
    matchedPatternId: "origin-ousd-mint-call",
  }), null);
});

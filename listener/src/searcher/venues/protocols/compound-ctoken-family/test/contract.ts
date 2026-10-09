import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from
  "../../../production-families/compound-ctoken.production.js";
import type { AdapterRequest } from "../../../adapter-request-program.js";
import { CTOKEN_INTERFACE } from "../abi.js";
import {
  CTOKEN_FAMILY_ID,
  CTOKEN_REDEEM_ACTION,
} from "../manifest.js";
import {
  answerFor,
  CANDIDATE,
  COMPTROLLER,
  decisionWith,
  descriptor,
  EXCHANGE_RATE,
  EXECUTOR,
  FOREIGN,
  MARKET,
  SOURCE,
  UNDERLYING,
} from "./fixtures.js";

const REDEEM_SELECTOR = CTOKEN_INTERFACE.getFunction("redeem")!.selector;
const UNDERLYING_SELECTOR = CTOKEN_INTERFACE.getFunction("redeemUnderlying")!
  .selector;

const routesFor = (d: ReturnType<typeof descriptor>) =>
  plugin.routes.project({ descriptor: d });

const inputFor = (
  d: ReturnType<typeof descriptor>,
  route: ReturnType<typeof routesFor>[number],
  amountIn: bigint,
) => ({
  descriptor: d,
  route,
  amountIn,
  source: SOURCE,
  executor: EXECUTOR,
  runtimeEvidence: [],
});

function quote(amountIn: bigint, reply = answerFor()) {
  const d = descriptor(reply);
  const route = routesFor(d)[0]!;
  const input = inputFor(d, route, amountIn);
  const method = plugin.exact.methods(input as never)[1]!;
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") {
    throw new Error("compound cToken is missing its amount request program");
  }
  const requested = method.program.buildRequests(input as never);
  const quoted = method.program.decode({
    programInput: input as never,
    initialResults: requested.map(reply),
    dependentEvidence: [],
  } as never);
  return { input, method, requested, quoted };
}

test("manifest declares the registry-admitted cToken redemption family", () => {
  assert.equal(String(plugin.manifest.familyId), String(CTOKEN_FAMILY_ID));
  assert.equal(plugin.manifest.domain, "protocol");
  assert.deepEqual(
    [...plugin.manifest.ownedActionAdapterIds],
    [CTOKEN_REDEEM_ACTION],
  );
  assert.deepEqual(
    plugin.manifest.allowedTaxonomy.map((slot) => slot.protocolAction),
    ["redeem"],
  );
  assert.equal(plugin.protocol.activeBehaviorProof, "required");
  const actionIds = plugin.actionAdapters.map((entry) => entry.id);
  assert.deepEqual(actionIds, [CTOKEN_REDEEM_ACTION]);
});

test("identity verifies through the comptroller registry plus a live exchange-rate path", () => {
  const identity = descriptor();
  assert.equal(identity.market, ethers.getAddress(MARKET));
  assert.equal(identity.comptroller, ethers.getAddress(COMPTROLLER));
  assert.equal(identity.underlying, ethers.getAddress(UNDERLYING));
  assert.equal(identity.decimals, 8);
  assert.equal(identity.redemptionPathVerified, true);
  assert.ok(identity.provenance.length > 0);
});

test("identity rejects a market the comptroller does not list", () => {
  const decision = decisionWith(answerFor({ listed: false }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "compound_ctoken_not_listed_by_comptroller",
  );
});

test("identity rejects a listed market missing from getAllMarkets() enumeration", () => {
  const decision = decisionWith(answerFor({ enumerated: [FOREIGN] }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "compound_ctoken_not_enumerated_by_comptroller",
  );
});

test("identity rejects a market whose stored exchange rate is zero", () => {
  const decision = decisionWith(answerFor({ exchangeRate: 0n }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "compound_ctoken_surfaces_failed",
  );
});

test("identity rejects an inactive redemption path", () => {
  const decision = decisionWith(answerFor({ probeReplies: false }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "compound_ctoken_redemption_path_inactive",
  );
});

test("routes project exactly one share-to-underlying redeem direction", () => {
  const d = descriptor();
  const routes = routesFor(d);
  assert.equal(routes.length, 1);
  const route = routes[0]!;
  assert.equal(route.direction, "redeem");
  assert.equal(route.adapterId, CTOKEN_REDEEM_ACTION);
  assert.equal(route.tokenIn.toLowerCase(), d.share.toLowerCase());
  assert.equal(route.tokenOut.toLowerCase(), d.underlying.toLowerCase());
  assert.equal(route.taxonomy.slotKind, "protocol");
  assert.equal(route.taxonomy.protocolAction, "redeem");
  assert.equal(route.bindingRef.bindingKey, MARKET.toLowerCase());
  const graph = plugin.routes.projectGraph({ descriptor: d, route } as never);
  assert.equal(graph.routeActionAdapterId, CTOKEN_REDEEM_ACTION);
  assert.equal(graph.executionTarget, d.market);
});

test("redeemUnderlying is never routed: its argument is an underlying OUTPUT amount", () => {
  const d = descriptor();
  const routes = routesFor(d);
  assert.equal(routes.length, 1);
  // The exact-out entry point is discovery evidence only; no route consumes it,
  // so the runtime-actual path can never be fed a preset output amount.
  assert.ok(
    !routes.some((route) => route.adapterId.includes("redeem-underlying")),
  );
  const manifestActions = [...plugin.manifest.ownedActionAdapterIds];
  assert.ok(!manifestActions.some((id) => id.includes("redeem-underlying")));
});

test("exact quote honours the caller's specified share amount", () => {
  for (const amountIn of [10n ** 6n, 10n ** 9n, 10n ** 13n]) {
    const { quoted } = quote(amountIn);
    const expected = (amountIn * EXCHANGE_RATE) / 10n ** 18n;
    assert.equal(quoted.amountOut, expected, `amountIn=${amountIn}`);
    assert.ok(quoted.amountOut > 0n);
    assert.equal(quoted.evidence.amountIn, amountIn);
    assert.equal(quoted.evidence.amountOut, quoted.amountOut);
    assert.equal(quoted.evidence.direction, "redeem");
    assert.equal(quoted.evidence.exchangeRate, EXCHANGE_RATE);
  }
});

test("exact quote is not a point-price sample: larger inputs quote proportionally larger outputs", () => {
  const small = quote(10n ** 6n).quoted.amountOut;
  const large = quote(10n ** 9n).quoted.amountOut;
  assert.notEqual(small, large);
  assert.equal(large, (10n ** 9n * EXCHANGE_RATE) / 10n ** 18n);
  assert.ok(large > small);
});

test("exact quote refuses an amount the market cash cannot cover without shrinking it", () => {
  // cash is 3,167,359,223,290 underlying units at this block; this share amount
  // redeems ~5.06e12, so a correct quote must surface the capacity failure
  // instead of silently reducing the amount.
  assert.throws(
    () => quote(2n * 10n ** 16n),
    /cannot cover/,
  );
});

test("exact quote exposes a local-zero method for a zero amount", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const methods = plugin.exact.methods(inputFor(d, route, 0n) as never);
  const zero = methods[0]!;
  assert.equal(zero.id, "local-zero");
  assert.ok(methods.length >= 2);
});

test("explicit-amount quote capability stays available for any positive amount", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const methods = plugin.exact.methods(
    inputFor(d, route, 123456789n) as never,
  );
  assert.ok(methods.length > 0);
});

test("buildRuntimeLeg patches the working amount into redeem's first argument and needs no approval", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const leg = plugin.execution.buildRuntimeLeg(
    inputFor(d, route, 10n ** 12n) as never,
  );
  assert.ok(leg, "a supported route must construct a runtime leg");
  assert.equal(leg.actionAdapterId, CTOKEN_REDEEM_ACTION);
  assert.match(leg.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
  assert.ok(
    leg.program.includes(REDEEM_SELECTOR.slice(2)),
    "the runtime leg must call redeem(uint256)",
  );
  assert.ok(
    !leg.program.includes(UNDERLYING_SELECTOR.slice(2)),
    "the runtime leg must never call the exact-out entry point",
  );
});

test("buildRuntimeLeg constructs without reading any quoted amount field", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const input = inputFor(d, route, 10n ** 12n) as Record<string, unknown>;
  for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"]) {
    Object.defineProperty(input, key, {
      get() {
        throw new Error(`runtime construction accessed ${key}`);
      },
    });
  }
  const leg = plugin.execution.buildRuntimeLeg(input as never);
  assert.ok(leg);
});

test("buildRuntimeLeg rejects a foreign tokenOut", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  assert.throws(() => plugin.execution.buildRuntimeLeg(
    inputFor(d, { ...route, tokenOut: FOREIGN } as never, 10n ** 12n) as never,
  ));
});

test("buildFragment requires no approve and rejects incompatible exact evidence", () => {
  const { input, quoted } = quote(10n ** 9n);
  const fragment = plugin.execution.buildFragment({
    ...input,
    quotedAmountOut: quoted.amountOut,
    minAmountOut: quoted.amountOut,
    exactEvidence: quoted.evidence,
  } as never);
  assert.deepEqual([...fragment.requirements], []);
  assert.equal(fragment.nodes.length, 1);
  assert.equal(fragment.nodes[0]!.adapterId, CTOKEN_REDEEM_ACTION);
  assert.equal(fragment.nodes[0]!.amount, input.amountIn);
  assert.throws(() => plugin.execution.buildFragment({
    ...input,
    quotedAmountOut: quoted.amountOut + 1n,
    minAmountOut: quoted.amountOut,
    exactEvidence: quoted.evidence,
  } as never));
  assert.throws(() => plugin.execution.buildFragment({
    ...input,
    quotedAmountOut: quoted.amountOut,
    minAmountOut: quoted.amountOut + 1n,
    exactEvidence: quoted.evidence,
  } as never));
});

test("expected effects describe a conserving share burn for underlying", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const effects = plugin.execution.expectedEffects({
    descriptor: d,
    route,
  } as never);
  const kinds = effects.map((effect) => effect.kind);
  assert.deepEqual(kinds, [
    "token-delta",
    "token-delta",
    "total-supply-delta",
  ]);
  assert.equal(
    (effects[0] as { token: string }).token.toLowerCase(),
    d.share.toLowerCase(),
  );
  assert.equal(
    (effects[1] as { token: string }).token.toLowerCase(),
    d.underlying.toLowerCase(),
  );
});

test("discovery nominates markets from both observed redemption entry points", () => {
  const patternIds = plugin.discovery.callPatterns.map((pattern) => pattern.id);
  assert.ok(patternIds.includes("compound-ctoken-redeem-call"));
  assert.ok(patternIds.includes("compound-ctoken-redeem-underlying-call"));
  assert.equal(plugin.discovery.evidenceChannel, "nominate");
  // Transaction-seeded nomination is what lets a brand-new family materialize a
  // real observation from an observed transaction instead of needing an
  // opaque-label address inventory.
  assert.equal(
    (plugin.discovery as { readonly txSeedNominations?: boolean })
      .txSeedNominations,
    true,
  );
  const candidate = plugin.discovery.decodeCandidate({
    observation: {
      kind: "call",
      target: MARKET,
      data: CTOKEN_INTERFACE.encodeFunctionData("redeem", [123n]),
    },
    matchedPatternId: "compound-ctoken-redeem-call",
  } as never);
  assert.deepEqual(candidate, {
    candidateKind: "compound-ctoken-market",
    market: ethers.getAddress(MARKET),
  });
  // A truncated or foreign payload must be rejected, not silently admitted.
  assert.equal(plugin.discovery.decodeCandidate({
    observation: { kind: "call", target: MARKET, data: `0x${REDEEM_SELECTOR.slice(2)}` },
    matchedPatternId: "compound-ctoken-redeem-call",
  } as never), null);
  assert.equal(
    plugin.discovery.candidateKey(CANDIDATE),
    MARKET.toLowerCase(),
  );
});

test("identity is not satisfied by a hardcoded market list", () => {
  // Same candidate, different comptroller answers: the decision flips purely on
  // chain evidence, which is what forbids an allowlist-based admission.
  const listed = decisionWith(answerFor({ listed: true }));
  assert.notEqual(listed.status, "chain-proven-rejected");
  const unlisted = decisionWith(answerFor({ listed: false }));
  assert.equal(unlisted.status, "chain-proven-rejected");
});

test("foreign candidates are rejected as invalid programs", () => {
  const variant = plugin.identity.variants[0]!;
  const decision = variant.decide({
    candidate: { candidateKind: "compound-ctoken-market", market: FOREIGN },
    evidence: undefined,
    step: 0,
  } as never);
  assert.equal(decision.status, "continue");
});

test("fixture answers cover every declared request id", () => {
  const reply = answerFor();
  const ids: string[] = [];
  const d = descriptor((request: AdapterRequest) => {
    ids.push(request.id);
    return reply(request);
  });
  assert.ok(d.market.length > 0);
  assert.ok(ids.length >= 6, `expected several evidence rounds, saw ${ids.join(",")}`);
});

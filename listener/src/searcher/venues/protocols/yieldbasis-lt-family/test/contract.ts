import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from
  "../../../production-families/yieldbasis-lt.production.js";
import type { AdapterRequest } from "../../../adapter-request-program.js";
import {
  CRYPTOPOOL_INTERFACE,
  LT_DEPOSIT_SELECTOR,
  LT_EMERGENCY_WITHDRAW_SELECTOR,
  LT_INTERFACE,
  LT_WITHDRAW_RECEIVER_SELECTOR,
  LT_WITHDRAW_SELECTOR,
} from "../abi.js";
import {
  YIELDBASIS_FAMILY_ID,
  YIELDBASIS_WITHDRAW_ACTION,
} from "../manifest.js";
import {
  answerFor,
  AMM,
  ASSET,
  CANDIDATE,
  CRYPTOPOOL,
  decisionWith,
  descriptor,
  EXECUTOR,
  FOREIGN,
  identityWith,
  LIQUIDITY_TOTAL,
  LIVE_SUPPLY_TOKENS,
  LT,
  POOL_ASSET_BALANCE,
  PREVIEW_PER_SHARE,
  result,
  SOURCE,
  STABLECOIN,
  STAKER,
  word,
} from "./fixtures.js";

const MIRRORED_SELECTOR = LT_INTERFACE
  .getFunction("withdraw(uint256,uint256)")!.selector;

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

function quote(
  amountIn: bigint,
  reply = answerFor(),
  actor: { readonly executor?: string; readonly transactionOrigin?: string } = {},
) {
  const d = descriptor(reply);
  const route = routesFor(d)[0]!;
  const input = { ...inputFor(d, route, amountIn), ...actor };
  const method = plugin.exact.methods(input as never)[1]!;
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") {
    throw new Error("yield basis LT is missing its amount request program");
  }
  const requested = method.program.buildRequests(input as never);
  const quoted = method.program.decode({
    programInput: input as never,
    initialResults: requested.map(reply),
    dependentEvidence: [],
  } as never);
  return { input, method, requested, quoted };
}

test("manifest declares the reverse-proven single-asset redemption family", () => {
  assert.equal(String(plugin.manifest.familyId), String(YIELDBASIS_FAMILY_ID));
  assert.equal(plugin.manifest.domain, "protocol");
  assert.deepEqual(
    [...plugin.manifest.ownedActionAdapterIds],
    [YIELDBASIS_WITHDRAW_ACTION],
  );
  assert.deepEqual(
    plugin.manifest.allowedTaxonomy.map((slot) => slot.protocolAction),
    ["redeem"],
  );
  assert.equal(plugin.protocol.activeBehaviorProof, "required");
  const actionIds = plugin.actionAdapters.map((entry) => entry.id);
  assert.deepEqual(actionIds, [YIELDBASIS_WITHDRAW_ACTION]);
});

test("identity verifies through the LevAMM mutual reference plus a live withdraw preview", () => {
  const identity = identityWith();
  // `subject` is the framework-canonical lowercase identity key.
  assert.equal(identity.subject, LT);
  assert.equal(ethers.getAddress(identity.subject), ethers.getAddress(LT));
  assert.equal(identity.asset, ethers.getAddress(ASSET));
  assert.equal(identity.stablecoin, ethers.getAddress(STABLECOIN));
  assert.equal(identity.cryptopool, ethers.getAddress(CRYPTOPOOL));
  assert.equal(identity.amm, ethers.getAddress(AMM));
  assert.equal(identity.decimals, 18);
  assert.equal(identity.assetDecimals, 18);
  assert.equal(identity.assetCoinIndex, 1);
  assert.equal(identity.redemptionPathVerified, true);
  assert.ok(identity.provenance.length > 0);
});

test("identity rejects an AMM that does not name this LT back", () => {
  const decision = decisionWith(answerFor({ ammLtContract: FOREIGN }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "yieldbasis_lt_amm_lt_contract_mismatch",
  );
});

test("identity rejects an AMM whose COLLATERAL is not the LT's own cryptopool", () => {
  const decision = decisionWith(answerFor({ ammCollateral: FOREIGN }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "yieldbasis_lt_amm_lt_contract_mismatch",
  );
});

test("identity rejects a cryptopool that does not hold [STABLECOIN, ASSET_TOKEN]", () => {
  const decision = decisionWith(answerFor({ poolCoin1: FOREIGN }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "yieldbasis_lt_cryptopool_coin_binding_failed",
  );
});

test("identity rejects a killed LT", () => {
  const decision = decisionWith(answerFor({ killed: true }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "yieldbasis_lt_killed",
  );
});

test("identity rejects a dead redemption surface", () => {
  const decision = decisionWith(answerFor({ probeReplies: false }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "yieldbasis_lt_redemption_path_inactive",
  );
});

test("identity is not satisfied by a hardcoded instance list", () => {
  // Same candidate, one different chain answer: the decision flips purely on
  // reverse-proven evidence, which is what forbids an allowlist admission.
  const accepted = decisionWith(answerFor({ ammLtContract: LT }));
  assert.notEqual(accepted.status, "chain-proven-rejected");
  const rejected = decisionWith(answerFor({ ammLtContract: FOREIGN }));
  assert.equal(rejected.status, "chain-proven-rejected");
});

test("routes project exactly one share-to-crypto withdraw direction", () => {
  const d = descriptor();
  const routes = routesFor(d);
  assert.equal(routes.length, 1);
  const route = routes[0]!;
  assert.equal(route.direction, "withdraw");
  assert.equal(route.adapterId, YIELDBASIS_WITHDRAW_ACTION);
  assert.equal(route.tokenIn.toLowerCase(), d.share.toLowerCase());
  assert.equal(route.tokenOut.toLowerCase(), d.asset.toLowerCase());
  assert.equal(route.target.toLowerCase(), d.lt.toLowerCase());
  assert.equal(route.taxonomy.slotKind, "protocol");
  assert.equal(route.taxonomy.protocolAction, "redeem");
  assert.equal(route.bindingRef.bindingKey, LT.toLowerCase());
  const graph = plugin.routes.projectGraph({ descriptor: d, route } as never);
  assert.equal(graph.routeActionAdapterId, YIELDBASIS_WITHDRAW_ACTION);
  assert.equal(graph.executionTarget, d.lt);
});

test("deposit and emergency_withdraw are excluded before route projection", () => {
  const patternSelectors = plugin.discovery.callPatterns
    .map((pattern) => String(pattern.selector).toLowerCase());
  const action = plugin.actionAdapters[0]!;
  for (const excluded of [LT_DEPOSIT_SELECTOR, LT_EMERGENCY_WITHDRAW_SELECTOR]) {
    assert.ok(
      !patternSelectors.includes(excluded.toLowerCase()),
      `${excluded} must not be a discovery pattern`,
    );
    assert.equal(
      action.matchTrace(LT, excluded),
      false,
      `${excluded} must never match this family's action`,
    );
    assert.ok(
      ![...plugin.manifest.ownedActionAdapterIds].some((id) =>
        id.toLowerCase().includes(excluded.slice(2, 8))),
      "no owned action may derive from an unsupported entry point",
    );
  }
  // deposit(uint256,uint256,uint256,address) and
  // emergency_withdraw(uint256,address[,address]) are equally unsupported.
  assert.equal(
    action.matchTrace(
      LT,
      LT_INTERFACE.getFunction("deposit(uint256,uint256,uint256,address)")!
        .selector,
    ),
    false,
  );
  assert.equal(
    action.matchTrace(
      LT,
      LT_INTERFACE.getFunction("emergency_withdraw(uint256,address)")!.selector,
    ),
    false,
  );
  // The two-argument withdraw overload IS routed; the three-argument form (same
  // call with an explicit receiver) is observed evidence and never routed.
  assert.equal(action.matchTrace(LT, LT_WITHDRAW_SELECTOR), true);
  assert.equal(action.matchTrace(LT, LT_WITHDRAW_RECEIVER_SELECTOR), false);
  const routes = routesFor(descriptor());
  assert.equal(routes.length, 1);
  assert.equal(plugin.discovery.callPatterns.length, 2);
});

test("exact quote honours the caller's specified share amount", () => {
  for (const amountIn of [10n ** 18n, 10n ** 20n, 3n * 10n ** 21n]) {
    const { requested, quoted } = quote(amountIn);
    const previewRequest = requested.find((request) =>
      request.id === "quote-preview-withdraw")!;
    const encodedAmount = BigInt(
      LT_INTERFACE.decodeFunctionData(
        "preview_withdraw",
        (previewRequest as { readonly data: string }).data,
      )[0],
    );
    assert.equal(encodedAmount, amountIn, `amountIn=${amountIn} must reach the LT`);
    assert.equal(quoted.amountOut, (amountIn * PREVIEW_PER_SHARE) / 10n ** 18n);
    assert.equal(quoted.evidence.amountIn, amountIn);
    assert.equal(quoted.evidence.amountOut, quoted.amountOut);
    assert.equal(quoted.evidence.direction, "withdraw");
    assert.equal(quoted.evidence.liveSupplyTokens, LIVE_SUPPLY_TOKENS);
    assert.equal(quoted.evidence.liquidityTotal, LIQUIDITY_TOTAL);
    assert.equal(quoted.evidence.poolAssetBalance, POOL_ASSET_BALANCE);
    assert.equal(quoted.evidence.assetCoinIndex, 1);
  }
});

test("exact quote is not a point-price sample: larger inputs quote proportionally larger outputs", () => {
  const small = quote(10n ** 18n).quoted.amountOut;
  const large = quote(10n ** 20n).quoted.amountOut;
  assert.notEqual(small, large);
  assert.equal(large, (10n ** 20n * PREVIEW_PER_SHARE) / 10n ** 18n);
  assert.ok(large > small);
});

test("exact reads the current staker in the same six-request amount round", () => {
  const { input, method, requested } = quote(10n ** 18n);
  assert.equal(method.chainAmountQuote, true);
  assert.equal(requested.length, 6);
  assert.equal(new Set(requested.map((request) => request.id)).size, 6);
  assert.equal(method.program.buildDependentProgram, undefined);
  const staker = requested.find((request) => request.id === "quote-staker")!;
  assert(staker.kind === "eth-call");
  assert.equal(staker.to.toLowerCase(), input.descriptor.lt.toLowerCase());
  assert.equal(staker.data, LT_INTERFACE.encodeFunctionData("staker"));
});

test("exact refuses the current staker executor despite a different Ready staker", () => {
  const reply = answerFor({ currentStaker: EXECUTOR });
  assert.equal(descriptor(reply).staker, ethers.getAddress(STAKER));
  assert.throws(() => quote(10n ** 18n, reply), /withdraw to\/from staker/);
});

test("exact permits zero or unrelated current staker, including a staker tx.origin", () => {
  for (const currentStaker of [ethers.ZeroAddress, FOREIGN, STAKER]) {
    assert(quote(10n ** 18n, answerFor({ currentStaker }), {
      executor: EXECUTOR,
      transactionOrigin: currentStaker === ethers.ZeroAddress ? FOREIGN : currentStaker,
    }).quoted.amountOut > 0n);
  }
  // The old Ready staker may now execute after the live restriction moves.
  assert(quote(10n ** 18n, answerFor({ currentStaker: FOREIGN }), {
    executor: STAKER.toLowerCase(),
  }).quoted.amountOut > 0n);
  assert.throws(() => quote(10n ** 18n, answerFor(), {
    executor: STAKER.toLowerCase(),
  }), /withdraw to\/from staker/);
});

test("exact refuses an invalid executor", () => {
  for (const executor of [ethers.ZeroAddress, "not-an-address", LT, ASSET]) {
    assert.throws(() => quote(10n ** 18n, answerFor(), { executor }));
  }
});

test("exact refuses missing, failed, malformed or differently sourced staker evidence", () => {
  const { input, method, requested } = quote(10n ** 18n);
  const answers = requested.map(answerFor());
  const decode = (initialResults: typeof answers) => method.program.decode({
    programInput: input as never, initialResults, dependentEvidence: [],
  } as never);
  assert.throws(() => decode(answers.filter((answer) => answer.id !== "quote-staker")));
  for (const invalid of [
    { id: "quote-staker", source: SOURCE, ok: false as const, failure: "rpc" as const },
    result("quote-staker", "0x"),
    result("quote-staker", word(STAKER), { ...SOURCE, number: SOURCE.number + 1 }),
    result("quote-staker", word(STAKER), { ...SOURCE, hash: "0x" + "ab".repeat(32) }),
    result("quote-staker", word(STAKER), { ...SOURCE, generation: SOURCE.generation + 1 }),
  ]) {
    assert.throws(() => decode(answers.map((answer) =>
      answer.id === "quote-staker" ? invalid : answer)));
  }
});

test("exact quote refuses a redemption above the cryptopool's crypto capacity without shrinking it", () => {
  // The pool holds POOL_ASSET_BALANCE wei of the crypto leg at this block; a
  // share amount whose preview exceeds it must surface the capacity failure
  // instead of silently reducing the amount.
  const huge = POOL_ASSET_BALANCE + 1n;
  assert.throws(
    () => quote(10n ** 18n, answerFor({ previewAmountFor: () => huge })),
    /cannot cover/,
  );
  // Exactly at the ceiling is still quotable: the refusal is a real bound, not
  // an arbitrary haircut.
  const atCeiling = quote(
    10n ** 18n,
    answerFor({ previewAmountFor: () => POOL_ASSET_BALANCE }),
  );
  assert.equal(atCeiling.quoted.amountOut, POOL_ASSET_BALANCE);
});

test("exact quote refuses a killed LT", () => {
  assert.throws(
    () => quote(10n ** 18n, answerFor({ killed: true })),
    /killed/,
  );
});

test("exact quote refuses a share amount the live supply cannot cover", () => {
  assert.throws(
    () => quote(10n ** 18n, answerFor({ liveSupply: 10n ** 17n })),
    /cannot cover/,
  );
});

test("exact quote refuses an amount that would leave less than the minimum share remainder", () => {
  // LT.vy asserts `supply >= MIN_SHARE_REMAINDER + shares or supply == shares`.
  const supply = 10n ** 18n + 10n ** 5n;
  assert.throws(
    () => quote(10n ** 18n, answerFor({ liveSupply: supply })),
    /minimum share remainder/,
  );
});

test("exact quote refuses an LT that reports zero withdrawable liquidity", () => {
  assert.throws(
    () => quote(10n ** 18n, answerFor({ liquidityTotal: 0n })),
    /zero withdrawable liquidity/,
  );
});

test("exact quote surfaces a reverting preview_withdraw as a refusal, never a fallback", () => {
  assert.throws(() => quote(10n ** 18n, answerFor({ previewReplies: false })));
});

test("exact quote exposes a local-zero method for a zero amount", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const methods = plugin.exact.methods(inputFor(d, route, 0n) as never);
  const zero = methods[0]!;
  assert.equal(zero.id, "local-zero");
  assert.ok(methods.length >= 2);
});

test("exact quote capability stays available for any positive amount", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const methods = plugin.exact.methods(
    inputFor(d, route, 123456789n) as never,
  );
  assert.ok(methods.length > 0);
});

test("buildRuntimeLeg patches the working amount into withdraw's shares argument", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const leg = plugin.execution.buildRuntimeLeg(
    inputFor(d, route, 10n ** 20n) as never,
  );
  assert.ok(leg, "a supported route must construct a runtime leg");
  assert.equal(leg.actionAdapterId, YIELDBASIS_WITHDRAW_ACTION);
  assert.match(leg.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
  assert.ok(
    leg.program.includes(MIRRORED_SELECTOR.slice(2).toLowerCase()) ||
      leg.program.includes(MIRRORED_SELECTOR.slice(2)),
    "the runtime leg must call withdraw(uint256,uint256)",
  );
  for (const forbidden of [
    LT_WITHDRAW_RECEIVER_SELECTOR,
    LT_DEPOSIT_SELECTOR,
    LT_EMERGENCY_WITHDRAW_SELECTOR,
  ]) {
    assert.ok(
      !leg.program.toLowerCase().includes(forbidden.slice(2).toLowerCase()),
      `the runtime leg must never call ${forbidden}`,
    );
  }
});

test("buildRuntimeLeg constructs without reading any quoted amount field", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const input = inputFor(d, route, 10n ** 20n) as Record<string, unknown>;
  for (
    const key of [
      "amountIn",
      "quotedAmountOut",
      "exactEvidence",
      "minAmountOut",
    ]
  ) {
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
    inputFor(d, { ...route, tokenOut: FOREIGN } as never, 10n ** 20n) as never,
  ));
});

test("buildFragment needs no approve, encodes the quoted floor and rejects incompatible evidence", () => {
  const { input, quoted } = quote(10n ** 20n);
  const fragment = plugin.execution.buildFragment({
    ...input,
    quotedAmountOut: quoted.amountOut,
    minAmountOut: quoted.amountOut,
    exactEvidence: quoted.evidence,
  } as never);
  assert.deepEqual([...fragment.requirements], []);
  assert.equal(fragment.nodes.length, 1);
  assert.equal(fragment.nodes[0]!.adapterId, YIELDBASIS_WITHDRAW_ACTION);
  assert.equal(fragment.nodes[0]!.amount, input.amountIn);
  assert.equal(
    (fragment.nodes[0]!.params as { readonly minAssetsOut: bigint })
      .minAssetsOut,
    quoted.amountOut,
  );
  // The family-owned encoder must produce exactly withdraw(shares,min_assets)
  // carrying both the amount and the floor, and no unsupported selector.
  const encoded = plugin.actionAdapters[0]!.encode(
    { ...fragment.nodes[0]! } as never,
    EXECUTOR,
    new Uint8Array(),
  );
  const hex = ethers.hexlify(encoded);
  assert.ok(hex.includes(MIRRORED_SELECTOR.slice(2)));
  assert.ok(hex.includes(word(input.amountIn).slice(2)));
  assert.ok(hex.includes(word(quoted.amountOut).slice(2)));
  assert.ok(!hex.includes(LT_EMERGENCY_WITHDRAW_SELECTOR.slice(2)));
  assert.ok(!hex.includes(LT_DEPOSIT_SELECTOR.slice(2)));
  // Missing or zero floor, an extra param, or a mismatched amount must throw.
  assert.throws(() => plugin.actionAdapters[0]!.encode(
    {
      ...fragment.nodes[0]!,
      params: { minAssetsOut: 0n },
    } as never,
    EXECUTOR,
    new Uint8Array(),
  ));
  assert.throws(() => plugin.actionAdapters[0]!.encode(
    {
      ...fragment.nodes[0]!,
      params: { minAssetsOut: quoted.amountOut, extra: 1n },
    } as never,
    EXECUTOR,
    new Uint8Array(),
  ));
  assert.throws(() => plugin.actionAdapters[0]!.encode(
    { ...fragment.nodes[0]! } as never,
    fragment.nodes[0]!.target as string,
    new Uint8Array(),
  ));
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
  assert.throws(() => plugin.execution.buildFragment({
    ...input,
    quotedAmountOut: quoted.amountOut,
    minAmountOut: quoted.amountOut,
    exactEvidence: { ...quoted.evidence, asset: FOREIGN },
  } as never));
});

test("expected effects describe a conserving share burn for the LT's own asset", () => {
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
    d.asset.toLowerCase(),
  );
});

test("discovery nominates LTs from the supported withdraw entry points only", () => {
  const patternIds = plugin.discovery.callPatterns.map((pattern) => pattern.id);
  assert.ok(patternIds.includes("yieldbasis-lt-withdraw-call"));
  assert.ok(patternIds.includes("yieldbasis-lt-withdraw-receiver-call"));
  assert.equal(plugin.discovery.evidenceChannel, "nominate");
  assert.equal(
    (plugin.discovery as { readonly txSeedNominations?: boolean })
      .txSeedNominations,
    true,
  );
  const candidate = plugin.discovery.decodeCandidate({
    observation: {
      kind: "call",
      target: LT,
      data: LT_INTERFACE.encodeFunctionData("withdraw(uint256,uint256)", [
        10n ** 20n,
        1n,
      ]),
    },
    matchedPatternId: "yieldbasis-lt-withdraw-call",
  } as never);
  assert.deepEqual(candidate, {
    candidateKind: "yieldbasis-lt",
    lt: ethers.getAddress(LT),
  });
  // A truncated or foreign payload must be rejected, not silently admitted.
  assert.equal(plugin.discovery.decodeCandidate({
    observation: {
      kind: "call",
      target: LT,
      data: `0x${MIRRORED_SELECTOR.slice(2)}`,
    },
    matchedPatternId: "yieldbasis-lt-withdraw-call",
  } as never), null);
  assert.equal(plugin.discovery.decodeCandidate({
    observation: {
      kind: "call",
      target: LT,
      data: LT_INTERFACE.encodeFunctionData("emergency_withdraw(uint256)", [
        10n ** 20n,
      ]),
    },
    matchedPatternId: "yieldbasis-lt-withdraw-call",
  } as never), null);
  assert.equal(
    plugin.discovery.candidateKey(CANDIDATE),
    LT.toLowerCase(),
  );
});

test("the LT's own Withdraw log nominates the emitting LT", () => {
  const log = LT_INTERFACE.encodeEventLog("Withdraw", [
    ethers.getAddress(EXECUTOR),
    ethers.getAddress(EXECUTOR),
    ethers.getAddress(EXECUTOR),
    10n ** 18n,
    10n ** 20n,
  ]);
  const candidate = plugin.discovery.decodeCandidate({
    observation: {
      kind: "log",
      address: LT,
      topics: log.topics,
      data: log.data,
    },
    matchedPatternId: "yieldbasis-lt-withdraw-log",
  } as never);
  assert.deepEqual(candidate, {
    candidateKind: "yieldbasis-lt",
    lt: ethers.getAddress(LT),
  });
});

test("the cryptopool binding the quote relies on is the coin ordering the LT uses", () => {
  const d = descriptor();
  assert.equal(d.assetCoinIndex, 1);
  assert.equal(
    CRYPTOPOOL_INTERFACE.getFunction("coins")!.selector.length,
    10,
  );
  assert.equal(d.stablecoin.toLowerCase(), STABLECOIN.toLowerCase());
  assert.equal(d.asset.toLowerCase(), ASSET.toLowerCase());
});

test("fixture answers cover every declared request id", () => {
  const reply = answerFor();
  const ids: string[] = [];
  const d = descriptor((request: AdapterRequest) => {
    ids.push(request.id);
    return reply(request);
  });
  assert.ok(d.lt.length > 0);
  assert.ok(
    ids.length >= 12,
    `expected several evidence rounds, saw ${ids.join(",")}`,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from
  "../../../production-families/kyberswap-elastic.production.js";
import type { AdapterRequest } from "../../../adapter-request-program.js";
import {
  KYSWAP_CALLBACK_INTERFACE,
  KYSWAP_FEE_UNITS,
  KYSWAP_FACTORY_INTERFACE,
  KYSWAP_POOL_INTERFACE,
  KYSWAP_SWAP_DATA_OFFSET,
  KYSWAP_SWAP_QTY_OFFSET,
  KYSWAP_SWAP_SELECTOR,
  KYSWAP_SWAP_TOPIC,
} from "../abi.js";
import { decodeSwapLog, tokenInFor, tokenOutFor } from "../codec.js";
import {
  KYSWAP_FAMILY_ID,
  KYSWAP_SWAP_ACTION,
} from "../manifest.js";
import {
  quoteExactInputStep,
  spotQuoteExactInput,
  virtualReserves,
} from "../math.js";
import type { KyberSwapDirection, KyberSwapRoute } from "../types.js";
import { getSqrtRatioAtTick } from "../../../../solver/v3-math.js";
import {
  answerFor,
  BASE_L,
  CANDIDATE,
  CURRENT_TICK,
  descriptor,
  decisionWith,
  EXECUTOR,
  identityWith,
  FACTORY,
  FOREIGN,
  NEXT_TICK,
  NEAREST_CURRENT_TICK,
  POOL,
  POOL_FEE_UNITS,
  PREVIOUS_TICK,
  SOURCE,
  SQRT_P,
  swapLogEvent,
  USDT,
  WETH,
} from "./fixtures.js";

const routesFor = (d: ReturnType<typeof descriptor>) =>
  plugin.routes.project({ descriptor: d }) as readonly KyberSwapRoute[];

const inputFor = (
  d: ReturnType<typeof descriptor>,
  route: KyberSwapRoute,
  amountIn: bigint,
) => ({
  descriptor: d,
  route,
  amountIn,
  source: SOURCE,
  executor: EXECUTOR,
  transactionOrigin: EXECUTOR,
  runtimeEvidence: [],
});

function quote(
  amountIn: bigint,
  options: Parameters<typeof answerFor>[0] = {},
  direction: KyberSwapDirection = "token0-in",
) {
  const d = descriptor(answerFor(options));
  const route = routesFor(d).find((r) => r.direction === direction)!;
  const input = inputFor(d, route, amountIn);
  const method = (plugin.exact.methods(input as never) as readonly {
    readonly id: string;
    readonly kind: string;
    readonly program?: {
      buildRequests(input: unknown): readonly AdapterRequest[];
      buildDependentProgram?(input: unknown): {
        requests: readonly AdapterRequest[];
        decode(results: readonly unknown[]): unknown;
      } | null;
      decode(input: unknown): { amountOut: bigint; evidence: Record<string, unknown> };
    };
  }[])[1]!;
  assert.equal(method.kind, "request-program");
  const program = method.program!;
  const requested = program.buildRequests(input as never);
  const initialResults = requested.map(answerFor(options));
  let dependentEvidence: unknown[] = [];
  if (program.buildDependentProgram !== undefined) {
    const round = program.buildDependentProgram({
      programInput: input as never,
      initialResults,
      completedRound: 0,
      priorEvidence: [],
    } as never);
    if (round !== null && round !== undefined) {
      dependentEvidence = [
        round.decode(round.requests.map(answerFor(options))),
      ];
      assert.equal(program.buildDependentProgram({
        programInput: input as never, initialResults,
        completedRound: 1, priorEvidence: dependentEvidence,
      } as never), null, "the completed neighbour read must terminate");
    }
  }
  const quoted = program.decode({
    programInput: input as never,
    initialResults,
    dependentEvidence,
  } as never);
  return { descriptor: d, route, input, requested, quoted };
}

test("manifest declares the factory-child Elastic swap family", () => {
  assert.equal(String(plugin.manifest.familyId), String(KYSWAP_FAMILY_ID));
  assert.equal(plugin.manifest.domain, "swap");
  assert.deepEqual(
    [...plugin.manifest.ownedActionAdapterIds],
    [KYSWAP_SWAP_ACTION],
  );
  assert.deepEqual(
    [...plugin.manifest.allowedTaxonomy],
    [{ slotKind: "swap" }],
  );
  assert.deepEqual(
    plugin.actionAdapters.map((entry) => entry.id),
    [KYSWAP_SWAP_ACTION],
  );
});

test("declared ABI surfaces match the measured on-chain identities", () => {
  // Topics and the callback selector were read off chain for these pools.
  assert.equal(
    KYSWAP_SWAP_TOPIC,
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  );
  assert.equal(
    KYSWAP_POOL_INTERFACE.getEvent("Mint")!.topicHash.toLowerCase(),
    "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde",
  );
  assert.equal(
    KYSWAP_POOL_INTERFACE.getEvent("Burn")!.topicHash.toLowerCase(),
    "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c",
  );
  assert.equal(
    KYSWAP_POOL_INTERFACE.getEvent("BurnRTokens")!.topicHash.toLowerCase(),
    "0x324487c99a1f7f0e3127499a548452d3a198e78ccd07add913cb93d59f0f039b",
  );
  assert.equal(
    KYSWAP_CALLBACK_INTERFACE.getFunction("swapCallback")!.selector,
    "0xfa483e72",
  );
  // The pool exposes swapFeeUnits()/tickDistance()/getPoolState(); there is no
  // fee()/tickSpacing()/slot0() on these contracts.
  assert.ok(KYSWAP_POOL_INTERFACE.getFunction("swapFeeUnits"));
  assert.ok(KYSWAP_POOL_INTERFACE.getFunction("tickDistance"));
  assert.ok(KYSWAP_POOL_INTERFACE.getFunction("getPoolState"));
  assert.ok(KYSWAP_POOL_INTERFACE.getFunction("getLiquidityState"));
  assert.equal(KYSWAP_POOL_INTERFACE.getFunction("fee"), null);
  assert.equal(KYSWAP_POOL_INTERFACE.getFunction("slot0"), null);
  assert.equal(
    KYSWAP_SWAP_SELECTOR,
    ethers.id("swap(address,int256,bool,uint160,bytes)").slice(0, 10),
  );
});

test("identity verifies through the pool's factory reverse binding", () => {
  const identity = identityWith();
  assert.equal(identity.subject, ethers.getAddress(POOL));
  assert.equal(identity.facts.factoryBinding.factory, ethers.getAddress(FACTORY));
  assert.equal(identity.facts.factoryBinding.reversePool, ethers.getAddress(POOL));
  assert.equal(identity.facts.token0, ethers.getAddress(WETH));
  assert.equal(identity.facts.token1, ethers.getAddress(USDT));
  assert.equal(identity.facts.feeUnits, POOL_FEE_UNITS);
  assert.ok(identity.provenance.length > 0);
  assert.equal(
    (identity.provenance[0] as { kind: string }).kind,
    "factory-reverse-binding",
  );
});

test("identity rejects a pool the factory does not reverse-resolve", () => {
  const decision = decisionWith(answerFor({ reversePool: FOREIGN }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_factory_reverse_binding_failed",
  );
});

test("identity rejects a pinned getPool revert as a failed reverse binding", () => {
  const decision = decisionWith(answerFor({ reverseReverts: true }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_factory_reverse_binding_failed",
  );
});

test("identity rejects a pool whose fee units cannot support the swap math", () => {
  for (const feeUnits of [0n, KYSWAP_FEE_UNITS, KYSWAP_FEE_UNITS + 1n]) {
    const decision = decisionWith(answerFor({ feeUnits }));
    assert.equal(decision.status, "chain-proven-rejected", `fee=${feeUnits}`);
    assert.equal(
      (decision as { reasonCode: string }).reasonCode,
      "kyberswap_elastic_pool_surfaces_failed",
    );
  }
});

test("identity rejects a pool whose tick distance is not positive", () => {
  const decision = decisionWith(answerFor({ tickDistance: 0 }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_pool_surfaces_failed",
  );
});

test("identity rejects a state whose sqrt price or tick relation is not swapable", () => {
  // nearestCurrentTick > currentTick can never be a swapable Elastic state.
  const inverted = decisionWith(answerFor({
    nearestCurrentTick: CURRENT_TICK + 1,
  }));
  assert.equal(inverted.status, "chain-proven-rejected");
  assert.equal(
    (inverted as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_pool_surfaces_failed",
  );
  // A locked pool cannot execute a swap at this state.
  const locked = decisionWith(answerFor({ locked: true }));
  assert.equal(locked.status, "chain-proven-rejected");
});

test("identity rejects a candidate whose factory hint contradicts chain truth", () => {
  const variant = plugin.identity.variants[0]!;
  const decision = variant.decide({
    candidate: { ...CANDIDATE, hintedFactory: FOREIGN },
    evidence: {
      phase: "reverse-binding",
      pool: POOL,
      poolCodeHash: `0x${"11".repeat(32)}`,
      factory: FACTORY,
      token0: WETH,
      token1: USDT,
      feeUnits: POOL_FEE_UNITS,
      tickDistance: 10,
      sqrtP: SQRT_P,
      currentTick: CURRENT_TICK,
      nearestCurrentTick: NEAREST_CURRENT_TICK,
      locked: false,
      baseL: BASE_L,
      reinvestL: 0n,
      staticValid: true,
      evidenceRequestIds: [],
      reversePool: POOL,
      bindingValid: true,
    },
    step: 1,
  } as never);
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_factory_hint_mismatch",
  );
});

test("identity is not satisfied by a hardcoded pool list", () => {
  // The same candidate flips purely on chain evidence: the factory either
  // reverse-resolves it or it does not.
  const accepted = decisionWith(answerFor());
  assert.equal(accepted.status, "verified");
  const rejected = decisionWith(answerFor({ reversePool: FOREIGN }));
  assert.equal(rejected.status, "chain-proven-rejected");
});

test("routes project exactly two exact-input directions with measured flags", () => {
  const d = descriptor();
  const routes = routesFor(d);
  assert.deepEqual(
    routes.map((route) => route.direction),
    ["token0-in", "token1-in"],
  );
  for (const route of routes) {
    assert.equal(route.isToken0, route.direction === "token0-in");
    assert.equal(route.tokenIn, tokenInFor(d, route.direction));
    assert.equal(route.tokenOut, tokenOutFor(d, route.direction));
    assert.equal(route.taxonomy.slotKind, "swap");
    assert.equal(route.taxonomy.protocolAction, undefined);
    assert.equal(route.feeUnits, POOL_FEE_UNITS);
    assert.equal(route.bindingRef.bindingKey, POOL.toLowerCase());
  }
  const graph = plugin.routes.projectGraph({
    descriptor: d,
    route: routes[1]!,
  } as never);
  assert.equal((graph as { routeActionAdapterId: string }).routeActionAdapterId, KYSWAP_SWAP_ACTION);
  assert.equal(graph.executionTarget, d.pool);
});

test("an exact-output variant has no route, no direction and no runtime leg", () => {
  const routes = routesFor(descriptor());
  // `isToken0` only names an input token for `swapQty > 0`; nothing in this
  // family projects a negative swapQty direction.
  assert.equal(routes.length, 2);
  assert.ok(routes.every((route) => route.isToken0 === (route.direction === "token0-in")));
  assert.ok(!routes.some((route) =>
    String(route.direction).includes("exact-output")));
  // The observation decoder refuses a negative (exact-output) swap call instead
  // of inventing a direction for it.
  const exactOutputCall = KYSWAP_POOL_INTERFACE.encodeFunctionData("swap", [
    EXECUTOR,
    -1838763n,
    false,
    0n,
    "0x",
  ]);
  assert.deepEqual(
    plugin.swap.observation.decode({
      observation: {
        kind: "call",
        target: POOL,
        data: exactOutputCall,
      },
    } as never),
    [],
  );
});

test("exact quote honours the caller's specified amount in both directions", () => {
  const cases = [
    { direction: "token0-in" as const, amounts: [10n ** 12n, 10n ** 13n, 10n ** 14n] },
    { direction: "token1-in" as const, amounts: [10n ** 6n, 5n * 10n ** 6n, 10n ** 7n] },
  ];
  for (const probe of cases) {
    for (const amountIn of probe.amounts) {
      const { quoted, route } = quote(amountIn, {}, probe.direction);
      assert.equal(quoted.evidence.amountIn, amountIn);
      assert.equal(quoted.evidence.amountOut, quoted.amountOut);
      assert.equal(quoted.evidence.refusal, null,
        `${probe.direction} amountIn=${amountIn}`);
      assert.equal(quoted.evidence.isToken0, route.isToken0);
      assert.ok(quoted.amountOut > 0n,
        `${probe.direction} amountIn=${amountIn}`);
    }
  }
});

test("exact quote is a function of the amount, not a point-price sample", () => {
  const small = quote(10n ** 12n).quoted.amountOut;
  const large = quote(10n ** 14n).quoted.amountOut;
  assert.ok(small > 0n && large > small, `${small} -> ${large}`);
  assert.notEqual(small, large);
  // Same state, same amount, opposite direction: the quote is directional.
  assert.notEqual(
    small,
    quote(10n ** 12n, {}, "token1-in").quoted.amountOut,
  );
});

test("exact quote for token1-in reads the initialized-tick neighbour round", () => {
  const up = quote(10n ** 6n, {}, "token1-in");
  assert.ok(up.quoted.amountOut > 0n);
  assert.equal(up.quoted.evidence.direction, "token1-in");
  assert.equal(up.quoted.evidence.isToken0, false);
  // The up-tick step target comes from `initializedTicks(nearest).next`, capped
  // by MAX_TICK_DISTANCE (480 ticks) exactly as the pool caps it.
  assert.equal(
    up.quoted.evidence.targetTick,
    Math.min(NEXT_TICK, CURRENT_TICK + 480),
  );
  const down = quote(10n ** 12n, {}, "token0-in");
  // The down-tick step target is `nearestCurrentTick` itself.
  assert.equal(down.quoted.evidence.targetTick, NEAREST_CURRENT_TICK);
  // Same pool, opposite directions: the outputs differ.
  assert.notEqual(up.quoted.amountOut, down.quoted.amountOut);
});

test("exact quote is refused, not extrapolated, when the input reaches the next initialized tick", () => {
  // The price sits exactly on the next initialized tick, so the step target is
  // not movable and nothing may be quoted for it.
  const { quoted } = quote(10n ** 15n, {
    sqrtP: getSqrtRatioAtTick(CURRENT_TICK),
    nearestCurrentTick: CURRENT_TICK,
    previousTick: CURRENT_TICK,
    nextTick: CURRENT_TICK,
  });
  assert.equal(quoted.amountOut, 0n);
  assert.equal(quoted.evidence.refusal, "price-limit-not-movable");
  assert.equal(quoted.evidence.amountIn, 10n ** 15n);
});

test("exact quote fails closed on a pool with no active liquidity", () => {
  const { quoted } = quote(1_000n, { baseL: 0n, reinvestL: 0n });
  assert.equal(quoted.amountOut, 0n);
  assert.equal(quoted.evidence.refusal, "no-active-liquidity");
});

test("a locked pool is refused by identity and by the step quote", () => {
  const decision = decisionWith(answerFor({ locked: true }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_pool_surfaces_failed",
  );
  const outcome = quoteExactInputStep({
    state: {
      source: SOURCE,
      sqrtP: SQRT_P,
      currentTick: CURRENT_TICK,
      nearestCurrentTick: NEAREST_CURRENT_TICK,
      locked: true,
      baseL: BASE_L,
      reinvestL: 0n,
      feeUnits: POOL_FEE_UNITS,
      previousTick: PREVIOUS_TICK,
      nextTick: NEXT_TICK,
    },
    isToken0: true,
    amountIn: 10n ** 12n,
  });
  assert.equal(outcome.ok, false);
  assert.equal(
    (outcome as { refusal: string }).refusal,
    "no-active-liquidity",
  );
});

test("the pool fee reduces the quoted output at the same state", () => {
  const cheap = quote(10n ** 6n, { feeUnits: 100n }, "token1-in").quoted.amountOut;
  const dear = quote(10n ** 6n, { feeUnits: 10_000n }, "token1-in").quoted.amountOut;
  assert.ok(cheap > dear, `${cheap} should exceed ${dear}`);
});

test("the mid sample is the pool price with the fee, not its reciprocal", () => {
  // The raw marginal price is (sqrtP / 2^96)^2, so a token0-in mid sample and
  // the exact step quote for the same amount must agree to within the step's
  // own price impact. An inverted mid would differ by a factor of price^2.
  const state = {
    source: SOURCE,
    sqrtP: SQRT_P,
    currentTick: CURRENT_TICK,
    nearestCurrentTick: NEAREST_CURRENT_TICK,
    locked: false,
    baseL: BASE_L,
    reinvestL: 0n,
    feeUnits: POOL_FEE_UNITS,
    previousTick: PREVIOUS_TICK,
    nextTick: NEXT_TICK,
  };
  const reserves = virtualReserves(state);
  // token1 reserve / token0 reserve is the raw price of token0 in token1.
  const impliedPrice = (reserves.token1 * 10n ** 18n) / reserves.token0;
  for (const isToken0 of [true, false]) {
    const amountIn = isToken0 ? 10n ** 12n : 10n ** 6n;
    const mid = spotQuoteExactInput(state, isToken0, amountIn);
    const step = quoteExactInputStep({ state, isToken0, amountIn });
    assert.equal(step.ok, true);
    const quoted = (step as { quote: { amountOut: bigint } }).quote.amountOut;
    // Within 1% of the amount-accurate single-range quote.
    assert.ok(
      mid * 100n <= quoted * 101n && quoted * 100n <= mid * 101n,
      `isToken0=${isToken0}: mid ${mid} vs step ${quoted}`,
    );
  }
  // A round trip through the mid must return the input minus both fees; an
  // inverted mid would be off by price^4.
  const forward = spotQuoteExactInput(state, true, 10n ** 12n);
  const backward = spotQuoteExactInput(state, false, forward);
  const net = KYSWAP_FEE_UNITS - POOL_FEE_UNITS;
  const expected = (10n ** 12n) * net * net /
    (KYSWAP_FEE_UNITS * KYSWAP_FEE_UNITS);
  assert.ok(
    backward * 100n <= expected * 101n && expected * 100n <= backward * 101n,
    `mid round trip ${backward} vs expected ${expected}`,
  );
  assert.ok(impliedPrice > 0n);
});

test("pricing projects one mid per routed direction from the same state read", () => {
  const d = descriptor();
  const draft = plugin.pricing.compileDraft({
    descriptor: d,
    stateKey: d.instanceKey,
    routes: routesFor(d),
  } as never);
  const pricingDescriptor = plugin.pricing.finalizePricingDescriptor({
    draft,
    sharedBindings: [],
  } as never);
  const requests = plugin.pricing.current.buildRequests({
    descriptor: pricingDescriptor,
    routes: routesFor(d),
  } as never);
  const snapshot = plugin.pricing.current.decodeSnapshot({
    descriptor: pricingDescriptor,
    routes: routesFor(d),
    initialResults: requests.map(answerFor()),
    dependentEvidence: [],
  } as never);
  const mids = plugin.pricing.current.deriveMids({
    descriptor: pricingDescriptor,
    routes: routesFor(d),
    snapshot,
  } as never) as ReadonlyMap<string, unknown>;
  assert.equal(mids.size, 2);
  for (const route of routesFor(d)) {
    assert.ok(mids.has(route.routeKey), route.direction);
  }
  assert.deepEqual(
    [...plugin.pricing.dependencies({ descriptor: pricingDescriptor } as never)],
    [d.pool],
  );
});

test("exact quote exposes a local-zero method without reading chain state", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const methods = plugin.exact.methods(inputFor(d, route, 0n) as never);
  assert.equal(methods[0]!.id, "local-zero");
  assert.equal(methods.length, 2);
});

test("step math refuses a non-movable price target instead of guessing", () => {
  const state = {
    source: SOURCE,
    sqrtP: getSqrtRatioAtTick(CURRENT_TICK),
    currentTick: CURRENT_TICK,
    nearestCurrentTick: CURRENT_TICK,
    locked: false,
    baseL: BASE_L,
    reinvestL: 0n,
    feeUnits: POOL_FEE_UNITS,
    previousTick: CURRENT_TICK,
    nextTick: CURRENT_TICK,
  };
  const outcome = quoteExactInputStep({
    state,
    isToken0: true,
    amountIn: 10n ** 12n,
  });
  assert.equal(outcome.ok, false);
  assert.equal(
    (outcome as { refusal: string }).refusal,
    "price-limit-not-movable",
  );
});

test("buildRuntimeLeg patches the working amount into swapQty and needs no approval", () => {
  const d = descriptor();
  for (const route of routesFor(d)) {
    const leg = plugin.execution.buildRuntimeLeg(
      inputFor(d, route, 10n ** 12n) as never,
    );
    assert.ok(leg, "a supported route must construct a runtime leg");
    assert.equal(leg.actionAdapterId, KYSWAP_SWAP_ACTION);
    assert.match(leg.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
    assert.ok(
      leg.program.includes(KYSWAP_SWAP_SELECTOR.slice(2)),
      "the runtime leg must call swap(address,int256,bool,uint160,bytes)",
    );
    // The exact-input guard plus the patched amount/script registers.
    assert.equal(KYSWAP_SWAP_QTY_OFFSET, 36);
    assert.equal(KYSWAP_SWAP_DATA_OFFSET, 196);
  }
});

test("buildRuntimeLeg constructs without reading any quoted amount field", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const input = inputFor(d, route, 10n ** 12n) as Record<string, unknown>;
  for (
    const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"]
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

test("buildRuntimeLeg rejects a foreign token and a self-recipient pool", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  assert.throws(() => plugin.execution.buildRuntimeLeg(
    inputFor(d, { ...route, tokenOut: FOREIGN } as never, 10n ** 12n) as never,
  ));
  assert.throws(() => plugin.execution.buildRuntimeLeg({
    ...inputFor(d, route, 10n ** 12n),
    executor: d.pool,
  } as never));
});

test("buildFragment needs no approve and rejects incompatible exact evidence", () => {
  const { input, quoted } = quote(10n ** 7n, {}, "token1-in");
  const fragment = plugin.execution.buildFragment({
    ...input,
    quotedAmountOut: quoted.amountOut,
    minAmountOut: quoted.amountOut,
    exactEvidence: quoted.evidence,
  } as never);
  assert.deepEqual([...fragment.requirements], []);
  assert.equal(fragment.nodes.length, 1);
  assert.equal(fragment.nodes[0]!.adapterId, KYSWAP_SWAP_ACTION);
  assert.equal(fragment.nodes[0]!.amount, input.amountIn);
  assert.equal(
    typeof (fragment.nodes[0]!.params as { runtimeAmountProgram?: string })
      .runtimeAmountProgram,
    "string",
  );
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
  // A refused quote can never become an execution fragment.
  const refused = quote(10n ** 15n, {
    sqrtP: getSqrtRatioAtTick(CURRENT_TICK),
    nearestCurrentTick: CURRENT_TICK,
    previousTick: CURRENT_TICK,
    nextTick: CURRENT_TICK,
  });
  assert.throws(() => plugin.execution.buildFragment({
    ...refused.input,
    quotedAmountOut: 1n,
    minAmountOut: 1n,
    exactEvidence: refused.quoted.evidence,
  } as never));
});

test("the action encodes a positive exact-input swap with a callback payment", () => {
  const d = descriptor();
  const route = routesFor(d)[1]!;
  const data = plugin.actionAdapters[0]!.encode({
    adapterId: KYSWAP_SWAP_ACTION,
    target: d.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    amount: 1_000_000n,
    params: { isToken0: route.isToken0 },
    children: [],
  } as never, EXECUTOR, new Uint8Array());
  const hex = ethers.hexlify(data as Uint8Array);
  assert.ok(hex.includes(KYSWAP_SWAP_SELECTOR.slice(2)));
  // ERC20 transfer(address,uint256) = 0xa9059cbb inside the callback script.
  assert.ok(hex.includes("a9059cbb"));
  assert.throws(() => plugin.actionAdapters[0]!.encode({
    adapterId: KYSWAP_SWAP_ACTION,
    target: d.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    amount: 0n,
    params: { isToken0: route.isToken0 },
    children: [],
  } as never, EXECUTOR, new Uint8Array()));
});

test("landed events classify swaps and liquidity mutations, and the decoder recovers the measured swap", () => {
  const log = swapLogEvent();
  assert.equal(
    plugin.swap.landedEvents.classify({ observation: { kind: "log", ...log } } as never),
    "swap",
  );
  const decimals = KYSWAP_POOL_INTERFACE.encodeEventLog("Mint", [
    EXECUTOR,
    EXECUTOR,
    -198260,
    -198250,
    1n,
    1n,
    1n,
  ]);
  assert.equal(
    plugin.swap.landedEvents.classify({
      observation: {
        kind: "log",
        address: POOL,
        topics: decimals.topics,
        data: decimals.data,
      },
    } as never),
    "mutation",
  );
  const decoded = decodeSwapLog(log)!;
  assert.equal(decoded.deltaQty0, -743921665931488n);
  assert.equal(decoded.deltaQty1, 1838763n);
  assert.equal(decoded.isToken0, false);
  assert.equal(decoded.amountIn, 1838763n);
  assert.equal(decoded.amountOut, 743921665931488n);
  assert.equal(decoded.sqrtP, SQRT_P);
  assert.equal(decoded.liquidity, BASE_L);
  assert.equal(decoded.tick, CURRENT_TICK);
  assert.equal(decoded.sender, ethers.getAddress(EXECUTOR));
});

test("expected effects describe a conserving executor swap", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const effects = plugin.execution.expectedEffects({
    descriptor: d,
    route,
  } as never);
  assert.deepEqual(
    effects.map((effect) => `${effect.kind}:${effect.account}:${effect.direction}`),
    [
      "token-delta:executor:decrease",
      "token-delta:route-target:increase",
      "token-delta:route-target:decrease",
      "token-delta:executor:increase",
    ],
  );
  assert.equal(
    (effects[0] as { token: string }).token.toLowerCase(),
    d.token0.toLowerCase(),
  );
  assert.equal(
    (effects[3] as { token: string }).token.toLowerCase(),
    d.token1.toLowerCase(),
  );
});

test("runtime projection declares no standing allowance for a callback pull", () => {
  const projection = plugin.execution.runtimeProjection() as {
    readonly allowanceSpender: string | null;
    readonly prewarmQuoteCalls: readonly unknown[];
  };
  assert.equal(projection.allowanceSpender, null);
  assert.deepEqual([...projection.prewarmQuoteCalls], []);
});

test("discovery nominates pools from calls, swaps and the interface surface", () => {
  assert.equal(plugin.discovery.evidenceChannel, "nominate");
  const candidate = plugin.discovery.decodeCandidate({
    observation: {
      kind: "call",
      target: POOL,
      data: KYSWAP_POOL_INTERFACE.encodeFunctionData("swap", [
        EXECUTOR,
        1n,
        false,
        0n,
        "0x",
      ]),
    },
    matchedPatternId: "kyberswap-elastic-swap-call",
  } as never);
  assert.deepEqual(candidate, {
    candidateKind: "kyberswap-elastic-pool",
    pool: ethers.getAddress(POOL),
    sourceKind: "pool-call",
    hintedFactory: null,
  });
  assert.equal(plugin.discovery.candidateKey(CANDIDATE), POOL.toLowerCase());
  const fromLog = plugin.discovery.decodeCandidate({
    observation: { kind: "log", ...swapLogEvent() },
    matchedPatternId: "kyberswap-elastic-swap-log",
  } as never);
  assert.equal((fromLog as { pool: string }).pool, ethers.getAddress(POOL));
  // A log that is not an Elastic swap nominate nothing.
  assert.equal(plugin.discovery.decodeCandidate({
    observation: {
      kind: "log",
      address: POOL,
      topics: [ethers.ZeroHash],
      data: "0x",
    },
    matchedPatternId: "kyberswap-elastic-swap-log",
  } as never), null);
});

test("fixture answers cover every declared request id of both rounds", () => {
  const reply = answerFor();
  const ids: string[] = [];
  const d = descriptor((request: AdapterRequest) => {
    ids.push(request.id);
    return reply(request);
  });
  assert.ok(d.pool.length > 0);
  assert.ok(ids.includes("pool-state"));
  assert.ok(ids.includes("pool-liquidity-state"));
  assert.ok(ids.includes("factory-get-pool"));
  assert.ok(ids.length >= 9, `expected several evidence rounds, saw ${ids.join(",")}`);
  assert.equal(PREVIOUS_TICK <= NEAREST_CURRENT_TICK, true);
});
